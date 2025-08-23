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
  WS_URL: process.env.WS_URL,
  WEATHER_API: "https://growagardenstock.com/api/stock/weather",
  TEMP_IMAGE_PATH: path.join("cache", "Temp.png"),
  TEMP_VIDEO_PATH: path.join("cache", "Temp.mp4"),
  HASH_FILE: "last_stock_hash.txt",
  DEFAULT_CHECK_INTERVAL_MS: 5 * 60 * 1000 // 5 minutes
};

const TIPS_PATH = "tips.json";
const TIPS_CACHE_PATH = "shown_tips.json";

/* ------------------ UTIL FUNCTIONS ------------------ */
function stylizeBoldSerif(str) {
  const offset = { upper: 0x1d5d4 - 65, lower: 0x1d5ee - 97, digit: 0x1d7ec - 48 };
  return str.split("").map(char => {
    if (/[A-Z]/.test(char)) return String.fromCodePoint(char.charCodeAt(0) + offset.upper);
    if (/[a-z]/.test(char)) return String.fromCodePoint(char.charCodeAt(0) + offset.lower);
    if (/[0-9]/.test(char)) return String.fromCodePoint(char.charCodeAt(0) + offset.digit);
    return char;
  }).join("");
}

function formatPHTime() {
  return new Date().toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    hour12: true,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTimeOnlyPH() {
  return new Date().toLocaleTimeString("en-PH", {
    timeZone: "Asia/Manila",
    hour12: true,
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getPHDate() {
  return new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" });
}

function getTodayPH() {
  return new Date().toLocaleDateString("en-PH", { timeZone: "Asia/Manila" });
}

function getDailyTip() {
  const tips = JSON.parse(fs.readFileSync(TIPS_PATH, "utf8"));
  let shown = {};
  if (fs.existsSync(TIPS_CACHE_PATH)) {
    shown = JSON.parse(fs.readFileSync(TIPS_CACHE_PATH, "utf8"));
  }

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

function getUpdateCountdownMessage() {
  const now = new Date(getPHDate());
  const day = now.getDay();
  const hour = now.getHours();

  const targetUpdate = new Date(now);
  targetUpdate.setHours(22, 0, 0, 0);

  if (day === 6 && hour >= 22) {
    return stylizeBoldSerif("✅ Update has arrived! Check out what's new!");
  }

  if (day === 6 && hour >= 20) {
    return stylizeBoldSerif("⚠️ Admins are now playing on the server... Be alert for admin abuse 👀");
  }

  if (day === 6 && hour < 22) {
    const diff = targetUpdate - now;
    const h = String(Math.floor(diff / 3600000)).padStart(2, "0");
    const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, "0");
    return `⏳ ${stylizeBoldSerif("Update in")} ${stylizeBoldSerif(h)}h ${stylizeBoldSerif(m)}m ${stylizeBoldSerif(s)}s`;
  }

  return "";
}

function shouldShowUpdateCountdown() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  const day = now.getDay();
  const hour = now.getHours();
  return (day === 5 && hour >= 12) || (day === 6 && hour < 22);
}

function resetCountdownIfSundayMorning() {
  const now = new Date(getPHDate());
  if (now.getDay() === 0 && now.getHours() === 0 && now.getMinutes() < 5) {
    fs.writeFileSync(CONFIG.HASH_FILE, "", "utf8");
  }
}

async function fetchWeather() {
  try {
    const res = await axios.get(CONFIG.WEATHER_API);
    return res.data;
  } catch (err) {
    console.error("⚠️ Weather API failed:", err.message);
    return null;
  }
}

async function fetchPredictions() {
  try {
    const res = await axios.get("https://gagstock.gleeze.com/predict", { params: { q: "seed|gear|egg" } });
    if (res.data.status === "success" && res.data.data) return res.data.data;
  } catch (err) {
    console.error("⚠️ Predictions API failed:", err.message);
  }
  return null;
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
        resolve(json?.data || {});
        ws.close();
      } catch (e) {
        reject(e);
      }
    });
    ws.on("error", reject);
  });
}

function getEmojiForCat(cat) {
  if (cat === "seed") return "🌱";
  if (cat === "gear") return "🛠️";
  if (cat === "egg") return "🥚";
  return "";
}

function summarizeSection(title, emoji, group) {
  if (!group?.items?.length) return "";
  const label = `╭───── CURRENT ${title.toUpperCase()} STOCK ─────╮`;
  const lines = group.items.map(x => `${x.emoji || emoji} ${x.name} [${x.quantity}]`).join("\n");
  return `${label}\n${lines}${group.countdown ? `\n⏳ ${group.countdown}` : ""}\n╰────────────────╯`;
}

function summarizeMerchant(merchant) {
  if (!merchant) return "";
  if (merchant.status === "leaved") return "╭──── MERCHANT ────╮\n🛒 Not Available\n╰────────────────╯";
  const items = merchant.items.map(x => `🛒 ${x.name} [${x.quantity}]`).join("\n");
  return `╭──── MERCHANT ────╮\n${items}\n⌛ Leaves in: ${merchant.countdown}\n╰────────────────╯`;
}

function summarizeWeather(weather) {
  if (!weather?.description) return "";
  return `☁️ Weather: ${weather.description}\n🌽 Bonus Crop: ${weather.cropBonuses || "None"}`;
}

function summarizePredictions(predictions) {
  if (!predictions) return "";
  const warning = `⚠️ ${stylizeBoldSerif("Predictions are in BETA and not fully tested. Use with caution!")}\n`;
  const cats = ["seed", "gear", "egg"];
  const lines = [];
  for (const cat of cats) {
    if (!predictions[cat] || !Array.isArray(predictions[cat]) || predictions[cat].length === 0) continue;
    const label = `╭───── UPCOMING ${cat.toUpperCase()} ─────╮`;
    const items = predictions[cat].map(item => `${getEmojiForCat(cat)} ${item.name}: ${item.showTime || "Unknown"}`).join("\n");
    lines.push(`${label}\n${items}\n╰────────────────╯`);
  }
  if (lines.length === 0) return "";
  return `${warning}${lines.join("\n")}`;
}

async function getOrExchangeLongLivedToken() {
  if (CONFIG.LONG_PAGE_ACCESS_TOKEN) return CONFIG.LONG_PAGE_ACCESS_TOKEN;
  const url = `https://graph.facebook.com/oauth/access_token`;
  const params = {
    grant_type: "fb_exchange_token",
    client_id: CONFIG.APP_ID,
    client_secret: CONFIG.APP_SECRET,
    fb_exchange_token: CONFIG.PAGE_ACCESS_TOKEN,
  };
  const res = await axios.get(url, { params });
  return res.data.access_token;
}

/* ✅ Updated: Supports Temp.png & Temp.mp4 */
async function postToFacebook(message) {
  const token = await getOrExchangeLongLivedToken();
  if (!token) return;

  const hasImage = fs.existsSync(CONFIG.TEMP_IMAGE_PATH);
  const hasVideo = fs.existsSync(CONFIG.TEMP_VIDEO_PATH);

  if (!hasImage && !hasVideo) {
    console.log("⚠️ No Temp.png or Temp.mp4 found, skipping post.");
    return;
  }

  let res;
  if (hasVideo) {
    const form = new FormData();
    form.append("description", message);
    form.append("access_token", token);
    form.append("source", fs.createReadStream(CONFIG.TEMP_VIDEO_PATH));

    res = await axios.post(`https://graph.facebook.com/${CONFIG.PAGE_ID}/videos`, form, {
      headers: form.getHeaders()
    });
  } else if (hasImage) {
    const form = new FormData();
    form.append("message", message);
    form.append("access_token", token);
    form.append("published", "true");
    form.append("source", fs.createReadStream(CONFIG.TEMP_IMAGE_PATH));

    res = await axios.post(`https://graph.facebook.com/${CONFIG.PAGE_ID}/photos`, form, {
      headers: form.getHeaders()
    });
  }

  const now = formatPHTime();
  const url = `https://facebook.com/${res.data.post_id || res.data.id}`;
  console.log(`✅ Posted at ${now}, ${url}`);
}

function getRecommendations(stock) {
  const wantedItems = [
    "Master Sprinkler",
    "Godly Sprinkler",
    "Medium Treat",
    "Medium Toy",
    "Ember Lily",
    "Giant Pinecone",
    "Burning Bud",
    "Magnifying Glass",
    "Godly Sprinkler",
    "Mythical Egg",
    "Paradise Egg",
    "Trading Ticket",
    "Bug Egg",
    "Bee Egg",
    "Grand Master Sprinkler",
    "Level Up Lollipop",
    "Friendship Pot",
    "Sprout Egg"
  ];

  const allItems = [
    ...(stock.gear?.items || []),
    ...(stock.seed?.items || []),
    ...(stock.egg?.items || []),
    ...(stock.honey?.items || []),
    ...(stock.cosmetics?.items || []),
    ...(stock.travelingmerchant?.items || [])
  ];

  const inStock = wantedItems.filter(wanted =>
    allItems.some(item => item.name.toLowerCase() === wanted.toLowerCase())
  );

  if (!inStock.length) return "";
  const lines = inStock.map(name => `✅ ${name}`);
  return `💡 ${stylizeBoldSerif("Recommended Buys Today")}:\n` + lines.join("\n");
}

async function checkAndPost() {
  try {
    resetCountdownIfSundayMorning();
    const [stock, weather, predictions] = await Promise.all([getStockData(), fetchWeather(), fetchPredictions()]);
    const hash = hashData({ stock, weather, predictions });
    const lastHash = loadHash(CONFIG.HASH_FILE);
    if (hash === lastHash) return;

    const message = [  
      `🌿✨ ${stylizeBoldSerif("Grow-a-Garden Report")} ✨🌿`,  
      `📦 ${stylizeBoldSerif("Version: 1.0.1")} //`,  
      `🕓 ${formatPHTime()} PH Time`,  
      summarizeSection("GEAR", "🛠️", stock.gear),  
      summarizeSection("SEEDS", "🌱", stock.seed),  
      summarizeSection("EGGS", "🥚", stock.egg),  
      summarizePredictions(predictions),
      summarizeSection("EVENT SHOP", "🍯", stock.honey),  
      summarizeSection("COSMETICS", "🎀", stock.cosmetics),  
      summarizeMerchant(stock.travelingmerchant),  
      summarizeWeather(weather),  
      shouldShowUpdateCountdown()  
        ? `╭──── ${stylizeBoldSerif("GAG NEXT UPDATE AT")} ────╮\n${getUpdateCountdownMessage()}\n╰────────────────╯`  
        : null,  
      getDailyTip(),  
      getRecommendations(stock)  
    ].filter(Boolean).join("\n\n");  

    await postToFacebook(message);  
    saveHash(CONFIG.HASH_FILE, hash);
  } catch (err) {
    console.error("❌ Error during post:", err.message);
  }
}

function getDelayToNext5MinutePH() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  const ms = now.getMilliseconds();
  const seconds = now.getSeconds();
  const minutes = now.getMinutes();
  const next = 5 - (minutes % 5);
  const delayMs = next * 60 * 1000 - seconds * 1000 - ms;
  return delayMs === 0 ? 5 * 60 * 1000 : delayMs;
}

function startAutoPosterEvery5Min() {
  const delay = getDelayToNext5MinutePH();
  const mm = Math.floor(delay / 60000);
  const ss = Math.floor((delay % 60000) / 1000);
  console.log(`⏭️ Next post in ${mm}m ${ss}s`);

  setTimeout(async () => {
    await checkAndPost();
    setInterval(checkAndPost, CONFIG.DEFAULT_CHECK_INTERVAL_MS);
  }, delay);
}

/* ------------------ EXPRESS ------------------ */
app.use("/doc", express.static(path.join(__dirname, "public"), { index: "doc.html" }));
app.get("/", (req, res) => res.redirect("/doc"));
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  startAutoPosterEvery5Min();
});