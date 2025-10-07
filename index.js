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
  TEMP_IMAGE_PATH: path.join("cache", "Temp.png"),
  TEMP_VIDEO_PATH: path.join("cache", "Temp.mp4"),
  HASH_FILE: "last_stock_hash.txt",
  DEFAULT_CHECK_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
  UPDATE_DAY: 6, // Saturday
  UPDATE_HOUR: 22, // 10 PM
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

function getUpdateCountdownMessage() {
  const now = new Date(getPHDate());
  const day = now.getDay();
  const hour = now.getHours();
  const targetUpdate = new Date(now);
  targetUpdate.setHours(CONFIG.UPDATE_HOUR, 0, 0, 0);

  if (day === CONFIG.UPDATE_DAY) {
    if (hour >= CONFIG.UPDATE_HOUR) {
      const nextUpdate = new Date(now);
      nextUpdate.setDate(now.getDate() + 7 - now.getDay() + CONFIG.UPDATE_DAY);
      nextUpdate.setHours(CONFIG.UPDATE_HOUR, 0, 0, 0);
      return `⏳ ${stylizeBoldSerif("Next update in")} ${formatTimeDifference(nextUpdate - now)}`;
    } else if (hour >= 20) {
      return stylizeBoldSerif("⚠️ Admins are now playing... Watch out 👀");
    } else {
      return `⏳ ${stylizeBoldSerif("Update in")} ${formatTimeDifference(targetUpdate - now)}`;
    }
  }
  const nextUpdate = new Date(now);
  nextUpdate.setDate(now.getDate() + 7 - now.getDay() + CONFIG.UPDATE_DAY);
  nextUpdate.setHours(CONFIG.UPDATE_HOUR, 0, 0, 0);
  return `⏳ ${stylizeBoldSerif("Next update in")} ${formatTimeDifference(nextUpdate - now)}`;
}

/* ------------------ API FETCH ------------------ */
async function fetchWeather() {
  try {
    const res = await axios.get(CONFIG.WEATHER_API, { timeout: 8000 });
    return res.data;
  } catch (err) {
    console.error("⚠️ Weather API failed:", err.message);
    return null;
  }
}

async function fetchPvBStock() {
  try {
    const res = await axios.get(CONFIG.PVB_API, { timeout: 8000 });
    const items = res.data.items || [];
    const seed = items.filter(i => i.category === "seed");
    const gear = items.filter(i => i.category === "gear");
    return { seed, gear, updatedAt: res.data.updatedAt };
  } catch (err) {
    console.error("⚠️ PvB Stock API failed:", err.message);
    return { seed: [], gear: [] };
  }
}

function hashData(data) {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
function loadHash(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}
function saveHash(file, hash) {
  fs.writeFileSync(file, hash, "utf8");
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
    ws.on("close", () => console.log("🔌 WebSocket closed."));
  });
}

/* ------------------ STYLERS ------------------ */
function stylizeSection(title, emoji, group) {
  if (!group?.items?.length) return "";
  const header = `╭───── ${stylizeBoldSerif(title.toUpperCase())} ─────╮`;
  const lines = group.items.map(x => `${x.emoji || emoji} ${x.name} [${x.quantity}]`).join("\n");
  const footer = `╰──────────────────────╯`;
  return `${header}\n${lines}${group.countdown ? `\n⏳ ${group.countdown}` : ""}\n${footer}`;
}

function stylizePvBCategory(title, emoji, list) {
  if (!list.length) return "";
  const header = `╭───── ${stylizeBoldSerif("PLANTS VS BRAINROTS")} ─────╮`;
  const sub = `【${title.toUpperCase()}】`;
  const lines = list.map(i => `${emoji} ${i.name} [${i.currentStock}]`).join("\n");
  const footer = `╰────────────────────────────╯`;
  return `${header}\n${sub}\n${lines}\n${footer}`;
}

function stylizeMerchant(merchant) {
  if (!merchant) return "";
  const header = `╭──── ${stylizeBoldSerif("MERCHANT")} ────╮`;
  if (merchant.status === "leaved") return `${header}\n🛒 Not Available\n╰────────────────╯`;
  const items = merchant.items.map(x => `🛒 ${x.name} [${x.quantity}]`).join("\n");
  const footer = `⌛ Leaves in: ${merchant.countdown}\n╰────────────────╯`;
  return `${header}\n${items}\n${footer}`;
}

function stylizeWeather(weather) {
  if (!weather?.description) return "";
  return `╭───── ${stylizeBoldSerif("WEATHER")} ─────╮
☁️ Weather: ${weather.description}
🌽 Bonus Crop: ${weather.cropBonuses || "None"}
╰───────────────────╯`;
}

function stylizeTip(tip) {
  if (!tip) return "";
  return `╭───── ${stylizeBoldSerif("DAILY TIP")} ─────╮
${tip}
╰──────────────────────╯`;
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
        fb_exchange_token: CONFIG.PAGE_ACCESS_TOKEN,
      }
    });
    return res.data.access_token;
  } catch (err) {
    console.error("❌ FB token exchange failed:", err.message);
    return null;
  }
}

async function postToFacebook(message) {
  const token = await getOrExchangeLongLivedToken();
  if (!token) return;

  const hasImg = fs.existsSync(CONFIG.TEMP_IMAGE_PATH);
  const hasVid = fs.existsSync(CONFIG.TEMP_VIDEO_PATH);
  if (!hasImg && !hasVid) {
    console.log("⚠️ No Temp.png/mp4 to upload.");
    return;
  }

  try {
    let res;
    if (hasVid) {
      const form = new FormData();
      form.append("description", message);
      form.append("access_token", token);
      form.append("source", fs.createReadStream(CONFIG.TEMP_VIDEO_PATH));
      res = await axios.post(`https://graph.facebook.com/${CONFIG.PAGE_ID}/videos`, form, { headers: form.getHeaders() });
    } else {
      const form = new FormData();
      form.append("message", message);
      form.append("access_token", token);
      form.append("published", "true");
      form.append("source", fs.createReadStream(CONFIG.TEMP_IMAGE_PATH));
      res = await axios.post(`https://graph.facebook.com/${CONFIG.PAGE_ID}/photos`, form, { headers: form.getHeaders() });
    }
    console.log(`✅ Posted ${formatPHTime()} → https://facebook.com/${res.data.post_id || res.data.id}`);
  } catch (err) {
    console.error("❌ FB post failed:", err.response?.data?.error?.message || err.message);
  }
}

/* ------------------ MAIN ------------------ */
async function checkAndPost() {
  try {
    const lastHash = loadHash(CONFIG.HASH_FILE);
    const [stock, weather, pvb] = await Promise.all([
      getStockData(),
      fetchWeather(),
      fetchPvBStock()
    ]);
    const newHash = hashData({ stock, weather, pvb });

    if (newHash === lastHash) {
      console.log("No new stock, skipping.");
      return;
    }

    const message = [
      `🌿✨ ${stylizeBoldSerif("Grow-a-Garden Report")} ✨🌿`,
      `🕓 ${formatPHTime()} PH Time`,
      stylizeSection("GEAR", "🛠️", stock.gear),
      stylizeSection("SEEDS", "🌱", stock.seed),
      stylizeSection("EGGS", "🥚", stock.egg),
      stylizeSection("EVENT SHOP", "🍯", stock.honey),
      stylizeSection("COSMETICS", "🎀", stock.cosmetics),
      stylizeMerchant(stock.travelingmerchant),
      stylizeWeather(weather),
      stylizeTip(getDailyTip()),
      `╭──── ${stylizeBoldSerif("GAG UPDATE CHECK")} ────╮\n${getUpdateCountdownMessage()}\n╰────────────────╯`,
      stylizePvBCategory("Seed", "🌱", pvb.seed),
      stylizePvBCategory("Gear", "⚙️", pvb.gear)
    ].filter(Boolean).join("\n\n");

    await postToFacebook(message);
    saveHash(CONFIG.HASH_FILE, newHash);
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

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
    await checkAndPost();
    setInterval(checkAndPost, CONFIG.DEFAULT_CHECK_INTERVAL_MS);
  }, delay);
}

/* ------------------ EXPRESS ------------------ */
app.use("/doc", express.static(path.join(__dirname, "public"), { index: "doc.html" }));
app.get("/", (req, res) => res.redirect("/doc"));
app.listen(PORT, () => {
  console.log(`🌐 Running on port ${PORT}`);
  startAutoPosterEvery5Min();
});