require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");
const crypto = require("crypto");
const WebSocket = require("ws");
const FormData = require("form-data");

const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG = {
  APP_ID: process.env.APP_ID,
  APP_SECRET: process.env.APP_SECRET,
  PAGE_ID: process.env.PAGE_ID,
  PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN,
  LONG_PAGE_ACCESS_TOKEN: process.env.LONG_PAGE_ACCESS_TOKEN,
  WS_URL: process.env.WS_URL || "wss://gagstock.gleeze.com",
  WEATHER_API: "https://growagardenstock.com/api/stock/weather",
  PVB_API: "https://plantsvsbrainrotsstocktracker.com/api/stock",
  HASH_FILE_GAG: "last_stock_hash_gag.txt",
  HASH_FILE_PVB: "last_stock_hash_pvb.txt",
  DEFAULT_CHECK_INTERVAL_MS: 5 * 60 * 1000,
  UPDATE_DAY_GAG: 6,
  UPDATE_HOUR_GAG: 22,
  UPDATE_HOUR_PVB: 21
};

const TIPS_PATH = "tips.json";
const TIPS_CACHE_PATH = "shown_tips.json";

/* ------------------ UTIL ------------------ */
function stylizeBoldSerif(str) {
  const offset = { upper: 0x1d5d4 - 65, lower: 0x1d5ee - 97, digit: 0x1d7ec - 48 };
  return str.split("").map(char => {
    if (/[A-Z]/.test(char)) return String.fromCodePoint(char.charCodeAt(0) + offset.upper);
    if (/[a-z]/.test(char)) return String.fromCodePoint(char.charCodeAt(0) + offset.lower);
    if (/[0-9]/.test(char)) return String.fromCodePoint(char.charCodeAt(0) + offset.digit);
    return char;
  }).join("");
}

const formatPHTime = () =>
  new Date().toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    hour12: true,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });

const getPHDate = () => new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" });
const getTodayPH = () => new Date().toLocaleDateString("en-PH", { timeZone: "Asia/Manila" });

function getDailyTip() {
  const tips = JSON.parse(fs.readFileSync(TIPS_PATH, "utf8"));
  let shown = fs.existsSync(TIPS_CACHE_PATH)
    ? JSON.parse(fs.readFileSync(TIPS_CACHE_PATH, "utf8"))
    : {};
  const today = getTodayPH();
  const used = shown[today] || [];
  const available = tips.filter(tip => !used.includes(tip));

  if (available.length === 0) {
    shown[today] = [];
    fs.writeFileSync(TIPS_CACHE_PATH, JSON.stringify(shown, null, 2));
    return getDailyTip();
  }

  const selected = available[Math.floor(Math.random() * available.length)];
  shown[today] = [...used, selected];
  fs.writeFileSync(TIPS_CACHE_PATH, JSON.stringify(shown, null, 2));
  return `📌 ${selected}`;
}

/* ------------------ COUNTDOWN ------------------ */
function formatTimeDifference(ms) {
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}h ${m}m ${s}s`;
}

function getUpdateCountdownMessage_GAG() {
  const now = new Date(getPHDate());
  const day = now.getDay();
  const hour = now.getHours();
  const target = new Date(now);
  target.setHours(CONFIG.UPDATE_HOUR_GAG, 0, 0, 0);
  if (day === CONFIG.UPDATE_DAY_GAG && hour >= CONFIG.UPDATE_HOUR_GAG) target.setDate(target.getDate() + 7);
  const diff = target - now;
  return `⏳ ${stylizeBoldSerif("Next GAG Update")} in ${formatTimeDifference(diff)}`;
}

function getUpdateCountdownMessage_PVB() {
  const now = new Date(getPHDate());
  const target = new Date(now);
  target.setHours(CONFIG.UPDATE_HOUR_PVB, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const diff = target - now;
  return `🧠 ${stylizeBoldSerif("Next PvB Update")} in ${formatTimeDifference(diff)}`;
}

/* ------------------ FETCH ------------------ */
async function fetchWeather() {
  try {
    const res = await axios.get(CONFIG.WEATHER_API, { timeout: 8000 });
    return res.data;
  } catch {
    console.error("⚠️ Weather API failed");
    return null;
  }
}

async function fetchPvBStock() {
  try {
    const res = await axios.get(CONFIG.PVB_API, { timeout: 10000 });
    const items = res.data.items || [];
    const seed = items.filter(i => i.category === "seed");
    const gear = items.filter(i => i.category === "gear");
    return { seed, gear, updatedAt: res.data.updatedAt };
  } catch {
    console.error("⚠️ PvB API failed");
    return { seed: [], gear: [] };
  }
}

async function getStockData() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CONFIG.WS_URL);
    ws.on("open", () => ws.send("getAllStock"));
    ws.on("message", msg => {
      try {
        const json = JSON.parse(msg);
        ws.close();
        resolve(json?.data || {});
      } catch (e) {
        reject(e);
      }
    });
    ws.on("error", reject);
  });
}

/* ------------------ HELPERS ------------------ */
function hashData(data) {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
function loadHash(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}
function saveHash(file, hash) {
  fs.writeFileSync(file, hash, "utf8");
}

/* ------------------ STYLERS ------------------ */
function stylizeSection(title, emoji, group) {
  if (!group?.items?.length) return "";
  const header = `╭───── ${stylizeBoldSerif(title.toUpperCase())} ─────╮`;
  const lines = group.items.map(x => `${emoji} ${x.name} [${x.quantity}]`).join("\n");
  return `${header}\n${lines}\n╰──────────────────────╯`;
}
function stylizeMerchant(merchant) {
  if (!merchant) return "";
  const header = `╭──── ${stylizeBoldSerif("MERCHANT")} ────╮`;
  if (merchant.status === "leaved") return `${header}\n🛒 Not Available\n╰────────────────╯`;
  const items = merchant.items.map(x => `🛒 ${x.name} [${x.quantity}]`).join("\n");
  return `${header}\n${items}\n⌛ Leaves in: ${merchant.countdown}\n╰────────────────╯`;
}
function stylizeWeather(weather) {
  if (!weather?.description) return "";
  return `╭───── ${stylizeBoldSerif("WEATHER")} ─────╮
☁️ ${weather.description}
🌽 Bonus Crop: ${weather.cropBonuses || "None"}
╰───────────────────╯`;
}
function stylizeTip(tip) {
  if (!tip) return "";
  return `╭───── ${stylizeBoldSerif("DAILY TIP")} ─────╮
${tip}
╰──────────────────────╯`;
}
function stylizePvBCategory(title, emoji, list) {
  if (!list.length) return "";
  const header = `╭───── ${stylizeBoldSerif("PLANTS VS BRAINROTS")} ─────╮`;
  const sub = `【${title.toUpperCase()}】`;
  const lines = list.map(i => `${emoji} ${i.name} [${i.currentStock}]`).join("\n");
  return `${header}\n${sub}\n${lines}\n╰────────────────────────────╯`;
}

/* ------------------ FACEBOOK ------------------ */
async function getOrExchangeLongLivedToken() {
  if (CONFIG.LONG_PAGE_ACCESS_TOKEN) return CONFIG.LONG_PAGE_ACCESS_TOKEN;
  try {
    const res = await axios.get("https://graph.facebook.com/oauth/access_token", {
      params: {
        grant_type: "fb_exchange_token",
        client_id: CONFIG.APP_ID,
        client_secret: CONFIG.APP_SECRET,
        fb_exchange_token: CONFIG.PAGE_ACCESS_TOKEN
      }
    });
    return res.data.access_token;
  } catch {
    console.error("❌ FB token exchange failed");
    return null;
  }
}

function findMediaFile(baseName) {
  const exts = [".png", ".jpg", ".jpeg", ".mp4"];
  for (const ext of exts) {
    const file = path.join("cache", baseName + ext);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function postMediaToFacebook(message, mediaFile) {
  const token = await getOrExchangeLongLivedToken();
  if (!token) return;
  try {
    const isVideo = mediaFile.endsWith(".mp4");
    const form = new FormData();
    form.append(isVideo ? "description" : "message", message);
    form.append("access_token", token);
    form.append("source", fs.createReadStream(mediaFile));
    const endpoint = `https://graph.facebook.com/${CONFIG.PAGE_ID}/${isVideo ? "videos" : "photos"}`;
    const res = await axios.post(endpoint, form, { headers: form.getHeaders() });
    console.log(`✅ Posted ${formatPHTime()} → https://facebook.com/${res.data.post_id || res.data.id}`);
  } catch (err) {
    console.error("❌ FB post failed:", err.response?.data?.error?.message || err.message);
  }
}

/* ------------------ POSTING ------------------ */
async function postGrowAGarden() {
  const lastHash = loadHash(CONFIG.HASH_FILE_GAG);
  const [stock, weather] = await Promise.all([getStockData(), fetchWeather()]);
  const newHash = hashData({ stock, weather });
  if (newHash === lastHash) return console.log("No GAG update.");

  const message = [
    `🌿✨ ${stylizeBoldSerif("Grow A Garden Report")} ✨`,
    `🕓 ${formatPHTime()} PH Time`,
    stylizeSection("GEAR", "🛠️", stock.gear),
    stylizeSection("SEEDS", "🌱", stock.seed),
    stylizeSection("EGGS", "🥚", stock.egg),
    stylizeSection("EVENT SHOP", "🍯", stock.honey),
    stylizeMerchant(stock.travelingmerchant),
    stylizeWeather(weather),
    `📅 ${getUpdateCountdownMessage_GAG()}`,
    stylizeTip(getDailyTip())
  ].filter(Boolean).join("\n\n");

  const media = findMediaFile("gag");
  if (!media) console.log("⚠️ No gag media found (png/jpg/mp4)");
  await postMediaToFacebook(message, media);
  saveHash(CONFIG.HASH_FILE_GAG, newHash);
}

async function postPlantsVsBrainrots() {
  const lastHash = loadHash(CONFIG.HASH_FILE_PVB);
  const pvb = await fetchPvBStock();
  const newHash = hashData(pvb);
  if (newHash === lastHash) return console.log("No PvB update.");

  const message = [
    `🧠✨ ${stylizeBoldSerif("Plants vs Brainrots Stock Report")} ✨`,
    `🕓 ${formatPHTime()} PH Time`,
    `⚠️ Note: This post was delayed by 30 seconds to ensure accurate fetch due to slow API.`,
    stylizePvBCategory("Seed", "🌱", pvb.seed),
    stylizePvBCategory("Gear", "⚙️", pvb.gear),
    `📅 ${getUpdateCountdownMessage_PVB()}`
  ].filter(Boolean).join("\n\n");

  const media = findMediaFile("pvzb");
  if (!media) console.log("⚠️ No pvzb media found (png/jpg/mp4)");
  await postMediaToFacebook(message, media);
  saveHash(CONFIG.HASH_FILE_PVB, newHash);
}

/* ------------------ MAIN ------------------ */
async function checkAndPostSeparated() {
  try {
    await postGrowAGarden();
    setTimeout(postPlantsVsBrainrots, 30000);
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

/* ------------------ TIMER ------------------ */
function getDelayToNext5MinutePH() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  const sec = now.getSeconds();
  const ms = now.getMilliseconds();
  const next = 5 - (now.getMinutes() % 5);
  const delay = next * 60 * 1000 - sec * 1000 - ms;
  return delay === 0 ? 5 * 60 * 1000 : delay;
}

function startAutoPosterEvery5Min() {
  const delay = getDelayToNext5MinutePH();
  console.log(`⏭️ Next check in ${Math.floor(delay / 60000)}m ${(delay / 1000) % 60}s`);
  setTimeout(async () => {
    await checkAndPostSeparated();
    setInterval(checkAndPostSeparated, CONFIG.DEFAULT_CHECK_INTERVAL_MS);
  }, delay);
}

/* ------------------ EXPRESS ------------------ */
app.use("/doc", express.static(path.join(__dirname, "public"), { index: "doc.html" }));
app.get("/", (req, res) => res.redirect("/doc"));
app.listen(PORT, () => {
  console.log(`🌐 Running on port ${PORT}`);
  startAutoPosterEvery5Min();
});