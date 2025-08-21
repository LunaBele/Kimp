require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");
const crypto = require("crypto");
const WebSocket = require("ws");
const FormData = require("form-data");
const chalk = require("chalk");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIG ---
const CACHE_DIR = path.join(__dirname, "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

const CONFIG = {
  APP_ID: process.env.APP_ID,
  APP_SECRET: process.env.APP_SECRET,
  PAGE_ID: process.env.PAGE_ID,
  PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN,
  LONG_PAGE_ACCESS_TOKEN: process.env.LONG_PAGE_ACCESS_TOKEN,
  WS_URL: process.env.WS_URL,
  WEATHER_API: "https://growagardenstock.com/api/stock/weather",
  TEMP_IMAGE_PATH: path.join(CACHE_DIR, "Temp.png"),
  HASH_FILE: path.join(CACHE_DIR, "last_stock_hash.txt"),
  DEFAULT_CHECK_INTERVAL_MS: 5 * 60 * 1000 // exactly 5 minutes
};

// --- CONFIG VALIDATION ---
["APP_ID", "APP_SECRET", "PAGE_ID", "PAGE_ACCESS_TOKEN", "WS_URL"].forEach(key => {
  if (!CONFIG[key]) {
    console.error(chalk.red(`❌ Missing config: ${key}`));
    process.exit(1);
  }
});

// --- LOGGING HELPERS ---
function logInfo(msg) { console.log(chalk.green("[INFO]"), msg); }
function logWarn(msg) { console.warn(chalk.yellow("[WARN]"), msg); }
function logErr(msg) { console.error(chalk.red("[ERR]"), msg); }

// --- UTIL FUNCTIONS ---
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

function getPHDate() {
  return new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" });
}

function getTodayPH() {
  return new Date().toLocaleDateString("en-PH", { timeZone: "Asia/Manila" });
}

// --- DAILY TIP ---
const TIPS_PATH = "tips.json";
const TIPS_CACHE_PATH = path.join(CACHE_DIR, "shown_tips.json");

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

// --- STOCK + WEATHER FETCH ---
async function fetchWeather() {
  try {
    const res = await axios.get(CONFIG.WEATHER_API);
    return res.data;
  } catch (err) {
    logWarn("⚠️ Weather API failed: " + err.message);
    return null;
  }
}

async function getStockData(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CONFIG.WS_URL);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("WebSocket request timed out"));
    }, timeoutMs);

    ws.on("open", () => ws.send("getAllStock"));
    ws.on("message", msg => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(msg);
        resolve(json?.data || {});
      } catch (e) {
        reject(e);
      } finally {
        ws.close();
      }
    });
    ws.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// --- HASH HELPERS ---
function hashData(data) {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
function loadHash(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}
function saveHash(file, hash) {
  fs.writeFileSync(file, hash, "utf8");
}

// --- SUMMARIZERS ---
function summarizeSection(title, emoji, group) {
  if (!group?.items?.length) return "";
  const label = `╭───── 𝗖𝗨𝗥𝗥𝗘𝗡𝗧 ${title.toUpperCase()} 𝗦𝗧𝗢𝗖𝗞 ─────╮`;
  const lines = group.items.map(x => `${x.emoji || emoji} ${x.name} [${x.quantity}]`).join("\n");
  return `${label}\n${lines}${group.countdown ? `\n⏳ ${group.countdown}` : ""}\n╰────────────────╯`;
}

function summarizeMerchant(merchant) {
  if (!merchant) return "";
  if (merchant.status === "leaved") return "╭──── 𝗠𝗘𝗥𝗖𝗛𝗔𝗡𝗧 ────╮\n🛒 Not Available\n╰────────────────╯";
  const items = merchant.items.map(x => `🛒 ${x.name} [${x.quantity}]`).join("\n");
  return `╭──── 𝗠𝗘𝗥𝗖𝗛𝗔𝗡𝗧 ────╮\n${items}\n⌛ Leaves in: ${merchant.countdown}\n╰────────────────╯`;
}

function summarizeWeather(weather) {
  if (!weather?.description) return "";
  return `☁️ Weather: ${weather.description}\n🌽 Bonus Crop: ${weather.cropBonuses || "None"}`;
}

// --- FACEBOOK POSTER ---
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

async function postToFacebook(message, retries = 3) {
  const token = await getOrExchangeLongLivedToken();
  if (!token || !fs.existsSync(CONFIG.TEMP_IMAGE_PATH)) return;

  const form = new FormData();
  form.append("message", message);
  form.append("access_token", token);
  form.append("published", "true");
  form.append("source", fs.createReadStream(CONFIG.TEMP_IMAGE_PATH));

  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.post(
        `https://graph.facebook.com/${CONFIG.PAGE_ID}/photos`,
        form,
        { headers: form.getHeaders() }
      );
      logInfo(`✅ Posted at ${formatPHTime()} https://facebook.com/${res.data.post_id || res.data.id}`);
      return;
    } catch (err) {
      logWarn(`⚠️ FB post attempt ${i + 1} failed: ${err.message}`);
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

// --- MAIN POSTING LOGIC ---
async function checkAndPost() {
  try {
    const [stock, weather] = await Promise.all([getStockData(), fetchWeather()]);
    const hash = hashData({ stock, weather });
    const lastHash = loadHash(CONFIG.HASH_FILE);
    if (hash === lastHash) return;

    const message = [
      `🌿✨ ${stylizeBoldSerif("Grow-a-Garden Report")} ✨🌿`,
      `🕓 ${formatPHTime()} PH Time`,
      summarizeSection("GEAR", "🛠️", stock.gear),
      summarizeSection("SEEDS", "🌱", stock.seed),
      summarizeSection("EGGS", "🥚", stock.egg),
      summarizeSection("EVENT SHOP", "🍯", stock.honey),
      summarizeSection("COSMETICS", "🎀", stock.cosmetics),
      summarizeMerchant(stock.travelingmerchant),
      summarizeWeather(weather),
      getDailyTip()
    ].filter(Boolean).join("\n\n");

    await postToFacebook(message);
    saveHash(CONFIG.HASH_FILE, hash);
  } catch (err) {
    logErr("❌ Error during post: " + err.message);
  }
}

// --- CRON JOB (every 5 min) ---
cron.schedule("*/5 * * * *", async () => {
  await checkAndPost();
}, { timezone: "Asia/Manila" });

// --- AUTO RESTART after 7h ---
setTimeout(() => {
  logWarn("♻️ Auto-restarting app after 7h uptime...");
  process.exit(0); // Render will restart
}, 7 * 60 * 60 * 1000);

// --- EXPRESS ROUTES ---
app.use("/doc", express.static(path.join(__dirname, "public"), { index: "doc.html" }));
app.get("/", (req, res) => res.redirect("/doc"));

app.get("/health", (req, res) => res.json({ status: "ok", time: formatPHTime() }));
app.post("/trigger", async (req, res) => {
  try {
    await checkAndPost();
    res.send("✅ Manual post triggered");
  } catch (err) {
    res.status(500).send("❌ Failed: " + err.message);
  }
});

// --- START SERVER ---
app.listen(PORT, () => {
  logInfo(`🌐 Server running on port ${PORT}`);
});