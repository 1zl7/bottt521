"use strict";
// اختبارات الميزات الجديدة: حد الحصة اليومية، الردود الجاهزة، فتح الحوارات، المدة العشوائية
const { loadConfig } = require("../src/config");
const { AI } = require("../src/ai");
const { Bot } = require("../src/bot");
const { Persona } = require("../src/persona");

const log = { debug() {}, info() {}, warn() {}, ok() {}, error() {}, game() {}, chat() {}, sent() {} };
let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log("✅", name); } catch (e) { failed++; console.log("❌", name, "-", e.message); } };
const assert = (c, m) => { if (!c) throw new Error(m || "assert"); };

const TPD = (m) => ({ error: { message: `Rate limit reached for model \`${m}\` ... tokens per day (TPD): Limit 200000, Used 199900. Please try again in 14m3.456s.`, code: "rate_limit_exceeded" } });

function fakeFetch(handler) { global.fetch = async (url, opts) => handler(url, opts && opts.body ? JSON.parse(opts.body) : {}); }
const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
const ok = (text) => json(200, { choices: [{ message: { content: text } }] });

(async () => {
  await t("config: AUTO_START_INTERVAL_SEC=15-25 يقرأ مدى", () => {
    const c = loadConfig({ AUTO_START_INTERVAL_SEC: "15-25" });
    assert(c.autoStartInterval[0] === 15000 && c.autoStartInterval[1] === 25000, JSON.stringify(c.autoStartInterval));
    assert(loadConfig({ AUTO_START_INTERVAL_SEC: "60" }).autoStartInterval.join() === "60000,60000");
    assert(loadConfig({}).autoStartInterval.join() === "60000,60000");
  });

  await t("حد اليوم: يوقف الموديل ويكمل للموديل التالي في السلسلة", async () => {
    const cfg = loadConfig({ CHAT_MODELS: "claude-opus-5,claude-opus-4-8", AGENTROUTER_API_KEY: "k" });
    const ai = new AI(cfg, log);
    const seen = [];
    fakeFetch((u, b) => { seen.push(b.model); return b.model === "claude-opus-5" ? json(429, TPD(b.model)) : ok("هلا"); });
    const r = await ai.chat({ system: "x", history: [{ role: "user", content: "a" }] });
    assert(r === "هلا", r);
    assert(ai.isBlocked("claude-opus-5"), "لازم ينحظر");
    seen.length = 0;
    await ai.chat({ system: "x", history: [] });
    assert(seen.length === 1 && seen[0] === "claude-opus-4-8", `ما لازم يضرب qwen مرة ثانية: ${seen}`);
    const ms = ai.blockedUntil.get("claude-opus-5") - Date.now();
    assert(ms > 13 * 60000 && ms < 15 * 60000, `المدة غلط ${ms}`);
  });

  await t("vision: لو الحصة خلصت يرمي quota بدون ما يكرر الطلبات", async () => {
    const ai = new AI(loadConfig({ AGENTROUTER_API_KEY: "k" }), log);
    let calls = 0;
    fakeFetch((u, b) => { calls++; return json(429, TPD(b.model)); });
    for (let i = 0; i < 3; i++) {
      try { await ai.identifyFlag("https://x/y.png"); assert(false, "لازم يفشل"); } catch (e) { assert(e.quota, "quota flag"); }
    }
    assert(calls === 1, `طلب واحد فقط للـ API، صار ${calls}`);
    assert(!ai.available("vision"), "available لازم false");
  });

  await t("chat: الحصة خلصت → رد جاهز بدون أي طلب AI", async () => {
    const cfg = loadConfig({ AGENTROUTER_API_KEY: "k", CHANNEL_ID: "12345", DISCORD_TOKEN: "t", CHAT_REPLY_CHANCE: "1", CHAT_DELAY_MS: "1-2" });
    const bot = new Bot(cfg, log);
    bot.state.myId = "1";
    const sent = [];
    bot.send = async (c) => { sent.push(c); };
    for (const m of cfg.chatModels) bot.ai.blockModel(m, 600000);
    let aiCalls = 0; global.fetch = async () => { aiCalls++; return json(500, {}); };
    await bot.handleHuman({ id: "9", author: { id: "7", username: "x" }, mentions: [{ id: "1" }] }, "هاي يا بوت ازيك");
    assert(aiCalls === 0, "ما لازم يتصل بالـ AI");
    assert(sent.length === 1 && sent[0].length > 0, "لازم يرد: " + JSON.stringify(sent));
  });

  await t("سقف الساعة: بعد AI_CHAT_PER_HOUR يرد جاهز ولا يضرب الـ API", async () => {
    const cfg = loadConfig({ AGENTROUTER_API_KEY: "k", CHANNEL_ID: "12345", DISCORD_TOKEN: "t", CHAT_REPLY_CHANCE: "1", CHAT_DELAY_MS: "1-2", CHAT_COOLDOWN_SEC: "0", AI_CHAT_PER_HOUR: "2" });
    const bot = new Bot(cfg, log);
    bot.state.myId = "1";
    const sent = []; bot.send = async (c) => { sent.push(c); };
    let aiCalls = 0; global.fetch = async () => { aiCalls++; return ok("هلا والله"); };
    for (let i = 0; i < 4; i++) { bot.state.lastChatAt = 0; await bot.handleHuman({ id: String(9 + i), author: { id: "7", username: "x" }, mentions: [{ id: "1" }] }, "هاي يا بوت ازيك"); }
    assert(aiCalls === 2, `لازم طلبين AI بس، صار ${aiCalls}`);
    assert(sent.length === 4, `لازم يرد 4 مرات (2 AI + 2 جاهز): ${sent.length}`);
  });

  await t("chat: رسالة عادية مو موجهة وما تطابق شي → ما يرد", () => {
    assert(new Persona().reply("xyzxyz qwe", { direct: false }) === null);
    assert(new Persona().reply("xyzxyz qwe", { direct: true }));
  });

  await t("فتح حوار: يرسل opener ويتوقف بعد حوارين بدون رد", async () => {
    const cfg = loadConfig({ AGENTROUTER_API_KEY: "k", CHANNEL_ID: "12345", DISCORD_TOKEN: "t", OFFLINE_ONLY: "1", STARTER_QUIET_SEC: "0-0", STARTER_MAX_UNANSWERED: "2" });
    const bot = new Bot(cfg, log);
    const sent = [];
    bot.send = async (c) => { sent.push(c); };
    bot.running = true; const id = bot.runId = 1;
    const p = bot.starterLoop(id);
    await new Promise((r) => setTimeout(r, 7000));
    bot.running = false; await p;
    assert(sent.length === 2, `المتوقع 2 صار ${sent.length}`);
    assert(new Set(sent).size === 2, "لا تكرر نفس الجملة");
    bot.state.unansweredStarters = 0; // أحد رد
  });

  await t("random auto-start: كل مرة يعيد سحب المدة", async () => {
    const cfg = loadConfig({ AGENTROUTER_API_KEY: "k", CHANNEL_ID: "12345", DISCORD_TOKEN: "t", AUTO_START_INTERVAL_SEC: "1-2", AUTO_START: "1", GAME_IDLE_SEC: "0" });
    const bot = new Bot(cfg, log);
    const times = [];
    bot.send = async () => { times.push(Date.now()); };
    bot.running = true; const id = bot.runId = 1;
    bot.state.nextAutoStartAt = Date.now();
    const p = bot.autoStartLoop(id);
    await new Promise((r) => setTimeout(r, 7500));
    bot.running = false; await p;
    assert(times.length >= 3, `لازم يبدأ مرات كثيرة، صار ${times.length}`);
    const gaps = times.slice(1).map((x, i) => x - times[i]);
    assert(gaps.every((g) => g >= 900 && g <= 2400), `المدد خارج المدى: ${gaps}`);
  });

  console.log(failed ? `\n${failed} فشل` : "\nكل الاختبارات الجديدة نجحت");
  process.exit(failed ? 1 : 0);
})();
