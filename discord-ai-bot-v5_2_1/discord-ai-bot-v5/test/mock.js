"use strict";
// سيرفر وهمي يقلّد Discord REST و AgentRouter، عشان نختبر البوت بدون شبكة ولا حسابات حقيقية

const http = require("http");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readBody = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });

async function startMock(opts = {}) {
  const state = {
    me: { id: "111", username: "tester" },
    messages: [],
    sent: [],
    sentRaw: [],
    aiRequests: [],
    reactions: [],
    messageGets: 0,
    rateLimitHits: 0,
    nextId: 1_000_000_000_000_000_000n,
    failSends: opts.failSends || 0,
    retryAfter: opts.retryAfter ?? 0.4,
    knownModels: opts.models || ["claude-opus-5", "claude-opus-4-8"],
    deadModels: new Set(opts.deadModels || []),
    visionAnswer: opts.visionAnswer ?? "المجر",
    chatAnswer: opts.chatAnswer ?? "هلا والله",
    rejectUrlImages: !!opts.rejectUrlImages,
    rejectTemperature: !!opts.rejectTemperature,
    aiDelayMs: opts.aiDelayMs ?? 50,
    port: 0,
    base: "",
  };

  state.addMessage = (m) => {
    state.nextId += 1000n;
    const msg = { id: String(state.nextId), type: 0, content: "", embeds: [], attachments: [], mentions: [], timestamp: new Date().toISOString(), ...m };
    state.messages.push(msg);
    return msg;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const body = await readBody(req);
    const json = (code, obj, headers = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };

    if (url.pathname === "/api/v10/users/@me") return json(200, state.me);

    if (/^\/api\/v10\/channels\/\d+\/messages$/.test(url.pathname)) {
      if (req.method === "GET") {
        state.messageGets++;
        const after = url.searchParams.get("after");
        const limit = Number(url.searchParams.get("limit") || 50);
        let list = state.messages.slice();
        if (after) list = list.filter((x) => BigInt(x.id) > BigInt(after));
        return json(200, list.slice(-limit).reverse()); // الأحدث أول مثل ديسكورد
      }
      if (req.method === "POST") {
        if (state.failSends > 0) {
          state.failSends--;
          state.rateLimitHits++;
          return json(429, { message: "You are being rate limited.", retry_after: state.retryAfter, global: false }, { "Retry-After": String(state.retryAfter) });
        }
        const b = JSON.parse(body);
        state.sentRaw.push(b);
        state.sent.push({ content: b.content, at: Date.now(), replyTo: b.message_reference?.message_id });
        return json(200, state.addMessage({ author: { id: state.me.id, username: state.me.username }, content: b.content }));
      }
    }
    if (req.method === "PUT" && /\/reactions\//.test(url.pathname)) {
      state.reactions.push(decodeURIComponent(url.pathname.split("/reactions/")[1].split("/")[0]));
      res.writeHead(204); return res.end();
    }

    if (url.pathname === "/openai/v1/models") return json(200, { data: state.knownModels.map((id) => ({ id })) });

    if (url.pathname === "/openai/v1/chat/completions" && req.method === "POST") {
      const r = JSON.parse(body);
      state.aiRequests.push(r);
      await sleep(state.aiDelayMs);
      const err = (code, message, type = "invalid_request_error", c) => json(code, { error: { message, type, code: c } });
      if (!state.knownModels.includes(r.model) || state.deadModels.has(r.model))
        return err(404, `The model \`${r.model}\` does not exist or you do not have access to it.`, "invalid_request_error", "model_not_found");
      // موديل claude الجديد يرفض temperature (نقلّد هذا عشان نتأكد إن الكود يعيد الطلب بدونه)
      if (state.rejectTemperature && r.temperature !== undefined) return err(400, "`temperature` is deprecated for this model");
      const parts = r.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
      const img = parts.find((p) => p.type === "image_url");
      if (img) {
        if (!/claude|gpt-6|llama-4-scout/.test(r.model)) return err(400, "model does not support image input");
        if (state.rejectUrlImages && /^https?:/.test(img.image_url.url)) return err(400, "failed to fetch image from URL");
        const ans = typeof state.visionAnswer === "function" ? state.visionAnswer(r) : state.visionAnswer;
        return json(200, { choices: [{ message: { role: "assistant", content: ans } }] });
      }
      const ans = typeof state.chatAnswer === "function" ? state.chatAnswer(r) : state.chatAnswer;
      return json(200, { choices: [{ message: { role: "assistant", content: ans } }] });
    }

    if (url.pathname.startsWith("/img/")) { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(PNG); }
    json(404, { message: "not found" });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.port = server.address().port;
  state.base = `http://127.0.0.1:${state.port}`;
  state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  // رسالة قديمة موجودة قبل تشغيل البوت
  state.addMessage({ author: { id: "5", username: "someone" }, content: "رسالة قديمة", timestamp: new Date(Date.now() - 600000).toISOString() });
  return state;
}

module.exports = { startMock, sleep };
