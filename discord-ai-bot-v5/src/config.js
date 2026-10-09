"use strict";

const fs = require("fs");
const path = require("path");
const { normAr } = require("./text");

// قارئ .env بسيط بدون مكتبات
function loadEnvFile(file = path.join(process.cwd(), ".env")) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const has = (v) => v !== undefined && String(v).trim() !== "";
const num = (v, d) => (has(v) && Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v, d) => (has(v) ? /^(1|true|yes|on)$/i.test(String(v).trim()) : d);
const list = (v) => (has(v) ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
const range = (v, d) => {
  const m = String(v ?? "").match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  return m ? [Number(m[1]), Number(m[2])] : d;
};

// "15-25" أو "60" بالثواني -> [min,max] بالملي ثانية
const rangeSec = (v, d) => {
  const m = String(v ?? "").match(/^\s*(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*$/);
  if (!m) return d;
  const a = Number(m[1]) * 1000;
  const b = (m[2] !== undefined ? Number(m[2]) : Number(m[1])) * 1000;
  return [Math.min(a, b), Math.max(a, b)];
};

function loadAliases(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[normAr(k)] = String(v);
    return out;
  } catch {
    return {};
  }
}

const DEFAULT_MODEL = "gemini-2.5-flash";

function loadConfig(env = process.env) {
  const prefix = has(env.GAME_PREFIX) ? env.GAME_PREFIX.trim() : ".";
  const gameName = has(env.GAME_NAME) ? env.GAME_NAME.trim() : "اعلام";

  const cfg = {
    token: (env.DISCORD_TOKEN || "").trim(),
    tokenType: /^bot$/i.test(env.DISCORD_TOKEN_TYPE || "") ? "bot" : "user",
    channelId: (env.CHANNEL_ID || "").trim(),
    aiKey: (env.AI_API_KEY || "").trim(),

    discordApiBase: (env.DISCORD_API_BASE || "https://discord.com/api/v10").replace(/\/$/, ""),
    aiApiBase: (env.AI_API_BASE || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, ""),
    // موديل واحد للأعلام والدردشة (gemini-2.5-flash يشوف الصور ويفهم عامية). VISION_MODELS / CHAT_MODELS اختيارية لو تبي سلسلة احتياط
    visionModels: has(env.VISION_MODELS) ? list(env.VISION_MODELS) : [has(env.AI_MODEL) ? env.AI_MODEL.trim() : DEFAULT_MODEL],
    chatModels: has(env.CHAT_MODELS) ? list(env.CHAT_MODELS) : [has(env.AI_MODEL) ? env.AI_MODEL.trim() : DEFAULT_MODEL],
    // true = ينزّل الصورة ويرسلها base64 دايماً (لو الـ API ما يقدر يجيب روابط ديسكورد). غير كذا يجرب الرابط أول ثم يتحول لو فشل
    imageAsBase64: bool(env.IMAGE_AS_BASE64, /generativelanguage\.googleapis\.com/.test(env.AI_API_BASE || "https://generativelanguage.googleapis.com")),
    aiTimeoutMs: num(env.AI_TIMEOUT_MS, 12000),
    aiMaxWaitMs: num(env.AI_MAX_WAIT_MS, 4000),
    allowPrivateImageHosts: bool(env.ALLOW_PRIVATE_IMAGE_HOSTS, false),

    personality: has(env.PERSONALITY) ? env.PERSONALITY : "أنا لاعب محترف وسريع، دمي خفيف وأحب الفرفشة والتحدي، أتكلم عامية مصرية",

    prefix,
    gameName,
    startCommand: has(env.GAME_START_COMMAND) ? env.GAME_START_COMMAND.trim() : `${prefix}${gameName}`,
    gameBotIds: list(env.GAME_BOT_IDS),
    autoStart: bool(env.AUTO_START, true),
    autoStartInterval: rangeSec(env.AUTO_START_INTERVAL_SEC, [60000, 60000]),
    gameIdleMs: num(env.GAME_IDLE_SEC, 45) * 1000,

    chatEnabled: bool(env.CHAT_ENABLED, true),
    chatReplyChance: Math.min(1, Math.max(0, num(env.CHAT_REPLY_CHANCE, 0.6))),
    chatCooldownMs: num(env.CHAT_COOLDOWN_SEC, 6) * 1000,
    historySize: num(env.HISTORY_SIZE, 16),
    // لما حصة الـ AI تخلص يكمل بردود جاهزة (بدون توكنات). OFFLINE_ONLY=true يخليه ما يستخدم AI للدردشة نهائياً
    offlineChat: bool(env.OFFLINE_CHAT, true),
    offlineOnly: bool(env.OFFLINE_ONLY, false),
    // أقصى طلبات AI للدردشة بالساعة (بعدها ردود جاهزة، 0 = بدون سقف). يحمي رصيد الأعلام
    aiChatPerHour: num(env.AI_CHAT_PER_HOUR, 120),
    // فتح حوارات: لو الروم هادي مدة عشوائية من القيمة هذي يرمي سؤال/تحدي
    starterEnabled: bool(env.STARTER_ENABLED, true),
    starterQuiet: rangeSec(env.STARTER_QUIET_SEC, [90000, 240000]),
    starterMaxUnanswered: num(env.STARTER_MAX_UNANSWERED, 2),

    pollMs: num(env.POLL_INTERVAL_MS, 1500),
    pollFastMs: num(env.POLL_FAST_MS, 1000),
    maxMessageAgeMs: num(env.MAX_MESSAGE_AGE_SEC, 20) * 1000,
    flagDelay: range(env.FLAG_DELAY_MS, [300, 700]),
    // أقل مدة بين إجابة علم والعلم اللي بعده (عشوائية كل مرة). 0 = بدون فاصل
    flagGap: rangeSec(env.FLAG_GAP_SEC, [15000, 20000]),
    wordDelay: range(env.WORD_DELAY_MS, [200, 500]),
    chatDelay: range(env.CHAT_DELAY_MS, [1000, 3000]),
    maxSendsPerMin: num(env.MAX_SENDS_PER_MIN, 40),

    controlPrefix: has(env.CONTROL_PREFIX) ? env.CONTROL_PREFIX.trim() : "!bot",
    dryRun: bool(env.DRY_RUN, false),
    port: num(env.PORT, 0),
    logLevel: has(env.LOG_LEVEL) ? env.LOG_LEVEL : "info",
    aliases: loadAliases(path.join(__dirname, "..", "data", "aliases.json")),
  };
  return cfg;
}

function validateConfig(cfg) {
  const problems = [];
  if (!cfg.token) problems.push("DISCORD_TOKEN ناقص");
  if (!/^\d{5,25}$/.test(cfg.channelId)) problems.push("CHANNEL_ID ناقص أو غلط (لازم أرقام فقط)");
  if (!cfg.aiKey) problems.push("AI_API_KEY ناقص (مفتاح Gemini من aistudio.google.com/apikey)");
  return problems;
}

module.exports = { loadEnvFile, loadConfig, validateConfig };
