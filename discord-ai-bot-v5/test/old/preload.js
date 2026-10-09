// يسرّع المؤقتات (الكود القديم فيه انتظار 60 ثانية ثابت) ويثبّت العشوائية عشان النتائج تتكرر
const SCALE = Number(process.env.TIME_SCALE || 20);
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, (ms || 0) / SCALE, ...args);
Math.random = () => 0.1;

// يحوّل طلبات الكود القديم (اللي عناوينه مكتوبة ثابتة) إلى السيرفر الوهمي
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const base = process.env.MOCK_BASE;
  let u = String(url);
  if (base) u = u.replace("https://discord.com", base).replace("https://api.groq.com", base);
  return realFetch(u, opts);
};
