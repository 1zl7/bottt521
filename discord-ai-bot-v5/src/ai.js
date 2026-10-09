"use strict";

const { fetchWithTimeout, sleep, backoff } = require("./http");

class AIError extends Error {
  constructor(status, body, model) {
    super(`AI ${status} (${model}): ${String(body).slice(0, 300)}`);
    this.status = status;
    this.body = String(body);
    this.model = model;
    this.fatal = status === 401;
    // حد اليوم (TPD) مو حد الدقيقة: الانتظار فيه يطول، ما يفيد نعيد المحاولة
    // حصة خلصت: حد يومي (429) أو رصيد/كوتا الحساب أو التوكن خلص (402/403 عند AgentRouter)
    this.quota =
      (status === 429 && /per day|perday|TPD|daily|insufficient|balance/i.test(this.body)) ||
      ([402, 403].includes(status) && /insufficient|quota|balance|credit|额度|余额/i.test(this.body));
    // الحساب نفسه مرفوض (مو مشكلة حصة): ما يفيد نعيد المحاولة
    this.fatal = this.fatal || (status === 403 && !this.quota && /unauthorized client|disabled|banned|forbidden/i.test(this.body));
    this.modelGone =
      status === 404 || /model_not_found|decommission|does not exist|no longer supported|model.*deprecated/i.test(this.body);
  }
}

// Claude / GPT / DeepSeek عبر AgentRouter: ما نرسل أي باراميتر تفكير (الافتراضي أسرع وأرخص).
// لو المزود رفض باراميتر (temperature مثلاً) post() يشيله ويعيد الطلب تلقائياً.
// Gemini 2.5 Flash يفكر افتراضياً والتفكير ياكل من max_tokens فيطلع الرد فاضي، فنقفله
function extraParams(model) {
  if (/gemini-2\.5-flash/i.test(model)) return { reasoning_effort: "none" };
  return {};
}

function parseRetryMs(res, text) {
  const h = Number(res.headers.get("retry-after"));
  if (Number.isFinite(h) && h > 0) return Math.ceil(h * 1000);
  // يدعم: 250ms / 1.5s / 14m3.4s / 1h2m
  const g = String(text).match(/retry in\s+(\d+(?:\.\d+)?)s|"retryDelay":\s*"(\d+(?:\.\d+)?)s"/i);
  if (g) return Math.ceil(Number(g[1] ?? g[2]) * 1000);
  const m = String(text).match(/try again in\s+((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+)/i);
  if (m) {
    let total = 0;
    for (const [, n, u] of m[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi)) {
      total += Number(n) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[u.toLowerCase()];
    }
    if (total > 0) return Math.ceil(total);
  }
  return 1000;
}

function isPrivateHost(host) {
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$)/i.test(host);
}

const FLAG_PROMPT =
  "ما اسم الدولة صاحبة هذا العلم؟ اكتب اسم الدولة بالعربي فقط، كلمة واحدة أو كلمتين، بدون أي شرح أو تشكيل أو نقطة. مثال: المجر أو السعودية أو الولايات المتحدة";
const FLAG_PROMPT_STRICT =
  "انظر للعلم في الصورة. أجب باسم الدولة بالحروف العربية فقط (مثل: المجر). لا تكتب إنجليزي ولا أي كلمة زيادة.";

class AI {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.chains = { vision: [...cfg.visionModels], chat: [...cfg.chatModels] };
    this.blockedUntil = new Map(); // model -> وقت رجوع الحصة
    this.preferBase64 = !!cfg.imageAsBase64; // يتحول لـ true لو الـ API فشل يجيب رابط الصورة
  }

  isBlocked(model) { return (this.blockedUntil.get(model) || 0) > Date.now(); }

  // فيه موديل واحد على الأقل مو واصل حد اليوم؟
  available(kind) {
    const chain = this.chains[kind].length ? this.chains[kind] : kind === "vision" ? this.cfg.visionModels : this.cfg.chatModels;
    return chain.some((m) => !this.isBlocked(m));
  }

  blockModel(model, waitMs) {
    const ms = Math.max(waitMs, 60_000);
    if (!this.isBlocked(model)) this.log.warn(`الموديل ${model} وصل حد اليوم، أوقفه ${Math.round(ms / 60000)} دقيقة تقريباً`);
    this.blockedUntil.set(model, Date.now() + ms);
  }

  headers() {
    return { Authorization: `Bearer ${this.cfg.aiKey}`, "Content-Type": "application/json" };
  }

  // يتأكد إن الموديلات المضبوطة لسا موجودة عند المزود (المزودين يسحبون موديلات)
  async verify() {
    try {
      const res = await fetchWithTimeout(`${this.cfg.aiApiBase}/models`, { headers: this.headers() }, 10000);
      // /models اختياري: بعض المزودين يرفضه حتى مع مفتاح صحيح، فما نوقف البوت عليه. لو المفتاح فعلاً غلط راح يظهر عند أول طلب حقيقي
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        return this.log.warn(`ما قدرت أتحقق من الموديلات (HTTP ${res.status}) ${body} — أكمل بدون تحقق`);
      }
      const ids = new Set(((await res.json()).data || []).map((m) => String(m.id).replace(/^models\//, "")));
      for (const kind of ["vision", "chat"]) {
        const missing = this.chains[kind].filter((m) => !ids.has(m));
        if (missing.length) this.log.warn(`موديلات ${kind} مو موجودة عند المزود: ${missing.join(", ")}`);
        const alive = this.chains[kind].filter((m) => ids.has(m));
        if (alive.length) this.chains[kind] = alive;
        else this.log.error(`ما فيه ولا موديل ${kind} شغال! عدّل VISION_MODELS / CHAT_MODELS في .env`);
      }
    } catch (e) {
      if (e.fatal) throw e;
      this.log.warn(`ما قدرت أتحقق من الموديلات: ${e.message}`);
    }
  }

  async complete(kind, payload) {
    if (!this.chains[kind].length) this.chains[kind] = [...(kind === "vision" ? this.cfg.visionModels : this.cfg.chatModels)];
    let lastErr;
    for (const model of [...this.chains[kind]]) {
      if (this.isBlocked(model)) {
        lastErr = lastErr ?? new AIError(429, "tokens per day: الموديل متوقف لين تتجدد الحصة", model);
        continue;
      }
      try {
        return await this.post(model, payload);
      } catch (e) {
        lastErr = e;
        if (e.quota) { this.blockModel(model, e.retryMs || 15 * 60_000); continue; }
        if (e.modelGone) {
          this.log.warn(`الموديل ${model} ما عاد متاح، أجرب اللي بعده`);
          this.chains[kind] = this.chains[kind].filter((m) => m !== model);
          continue;
        }
        throw e;
      }
    }
    throw lastErr ?? new AIError(0, "ما فيه موديلات مضبوطة", kind);
  }

  async post(model, payload) {
    const body = { model, ...payload, ...extraParams(model) };
    if (/gemini/i.test(model) && body.max_tokens) body.max_tokens = Math.max(body.max_tokens, 300); // احتياط لو التفكير ما انقفل
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetchWithTimeout(`${this.cfg.aiApiBase}/chat/completions`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }, this.cfg.aiTimeoutMs);
      } catch (e) {
        if (attempt === 3) throw new AIError(0, e.message, model);
        await sleep(backoff(attempt, 300));
        continue;
      }
      if (res.ok) return res.json();
      const text = await res.text().catch(() => "");
      // لو المزود رفض باراميتر التفكير، نعيد بدونه
      if (res.status === 400 && /reasoning|thinking/i.test(text) && ("reasoning_effort" in body || "include_reasoning" in body)) {
        delete body.reasoning_effort;
        delete body.include_reasoning;
        delete body.reasoning_format;
        continue;
      }
      // بعض موديلات Claude الجديدة ترفض temperature/top_p
      if (res.status === 400 && /temperature|top_p|sampling/i.test(text) && ("temperature" in body || "top_p" in body)) {
        delete body.temperature;
        delete body.top_p;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const waitMs = res.status === 429 ? parseRetryMs(res, text) : backoff(attempt, 300);
        if (waitMs <= this.cfg.aiMaxWaitMs) {
          await sleep(waitMs);
          continue;
        }
      }
      const err = new AIError(res.status, text, model);
      if (res.status === 401) this.log.error(`AgentRouter رد 401 على طلب حقيقي: ${text.slice(0, 300)}`);
      if (err.quota) err.retryMs = res.status === 429 ? parseRetryMs(res, text) : 30 * 60_000; // رصيد خلص: نوقفه 30 دقيقة قبل نجرب مرة ثانية
      throw err;
    }
    throw new AIError(0, "انتهت المحاولات", model);
  }

  async downloadAsDataUrl(url) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error("رابط صورة غير مدعوم");
    if (!this.cfg.allowPrivateImageHosts && isPrivateHost(u.hostname)) throw new Error("رابط صورة داخلي ممنوع");
    const res = await fetchWithTimeout(url, {}, 8000);
    if (!res.ok) throw new Error(`تحميل الصورة فشل (${res.status})`);
    const type = (res.headers.get("content-type") || "").split(";")[0];
    if (!type.startsWith("image/")) throw new Error("الرابط مو صورة");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 3.5 * 1024 * 1024) throw new Error("الصورة كبيرة");
    return `data:${type};base64,${buf.toString("base64")}`;
  }

  async identifyFlag(url, { strict = false } = {}) {
    const text = strict ? FLAG_PROMPT_STRICT : FLAG_PROMPT;
    const build = (u) => ({
      max_tokens: 64,
      temperature: 0,
      messages: [{ role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: u } }] }],
    });
    let data;
    const isData = String(url).startsWith("data:");
    try {
      data = await this.complete("vision", build(this.preferBase64 && !isData ? await this.downloadAsDataUrl(url) : url));
    } catch (e) {
      // ممكن الـ API ما قدر يجيب رابط الصورة: ننزّلها ونرسلها base64، ونتذكر عشان الطلبات الجاية ما تفشل أول
      if (!isData && !this.preferBase64 && [400, 422].includes(e.status) && /image|url|retriev|fetch|download|media/i.test(e.body)) {
        this.log.debug("الـ API ما قدر يجيب الصورة، أنزّلها وأرسلها base64");
        data = await this.complete("vision", build(await this.downloadAsDataUrl(url)));
        this.preferBase64 = true;
      } else throw e;
    }
    return data.choices?.[0]?.message?.content ?? "";
  }

  async chat({ system, history }) {
    const data = await this.complete("chat", {
      max_tokens: 120,
      temperature: 0.7,
      messages: [{ role: "system", content: system }, ...history],
    });
    return data.choices?.[0]?.message?.content ?? "";
  }
}

module.exports = { AI, AIError };
