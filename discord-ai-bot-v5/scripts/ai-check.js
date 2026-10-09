"use strict";
// تشغيل: npm run aicheck   — يجرب AgentRouter بطلبات حقيقية صغيرة ويطبع الرد الخام (بدون ديسكورد)
const { loadEnvFile, loadConfig } = require("../src/config");
loadEnvFile();
const cfg = loadConfig();
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const H = { Authorization: `Bearer ${cfg.aiKey}`, "Content-Type": "application/json" };
const show = async (name, res) => {
  const t = await res.text();
  console.log(`\n── ${name}: HTTP ${res.status}\n${t.slice(0, 500)}`);
};
(async () => {
  console.log(`القاعدة: ${cfg.aiApiBase}\nالموديل: ${cfg.chatModels[0]}\nطول المفتاح: ${cfg.aiKey.length} (يبدأ بـ ${cfg.aiKey.slice(0, 3)}...)`);
  if (/\s|["']/.test(cfg.aiKey)) console.log("⚠️ المفتاح فيه مسافة أو علامة تنصيص!");
  await show("GET /models", await fetch(`${cfg.aiApiBase}/models`, { headers: H }));
  const body = (content) => JSON.stringify({ model: cfg.chatModels[0], ...(/gemini-2\.5-flash/.test(cfg.chatModels[0]) ? { reasoning_effort: "none" } : {}), max_tokens: 300, messages: [{ role: "user", content }] });
  await show("دردشة", await fetch(`${cfg.aiApiBase}/chat/completions`, { method: "POST", headers: H, body: body("قول مرحبا") }));
  await show("صورة (vision)", await fetch(`${cfg.aiApiBase}/chat/completions`, { method: "POST", headers: H,
    body: body([{ type: "text", text: "ما لون هذه الصورة؟" }, { type: "image_url", image_url: { url: PNG } }]) }));
})().catch((e) => console.log("فشل الاتصال:", e.message));
