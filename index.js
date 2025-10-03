/****************************************************
 * Grow-a-Garden Auto Poster v2.1
 * Author: Mart + GPT
 * Purpose: Fetch GAG Stock & Weather → Post to FB
 ****************************************************/

require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");
const crypto = require("crypto");
const FormData = require("form-data");

/* ------------------ CONFIG ------------------ */
const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG = {
  APP_ID: process.env.APP_ID,
  APP_SECRET: process.env.APP_SECRET,
  PAGE_ID: process.env.PAGE_ID,
  PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN,
  LONG_PAGE_ACCESS_TOKEN: process.env.LONG_PAGE_ACCESS_TOKEN,

  STOCK_API: "https://gagstock.gleeze.com/grow-a-garden",
  WEATHER_API: "https://gagstock.gleeze.com/weather",

  TEMP_IMAGE_PATH: path.join("cache", "Temp.png"),
  TEMP_VIDEO_PATH: path.join("cache", "Temp.mp4"),
  HASH_FILE: "last_stock_hash.txt",

  DEFAULT_CHECK_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
  UPDATE_DAY: 6,  // Saturday
  UPDATE_HOUR: 22 // 10 PM
};

const TIPS_PATH = "tips.json";
const TIPS_CACHE_PATH = "shown_tips.json";

/* ------------------ UTILITIES ------------------ */
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
  new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila", hour12: true,
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });

function getPHNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
}
function getTodayPH() {
  return new Date().toLocaleDateString("en-PH", { timeZone: "Asia/Manila" });
}

/* ------------------ DAILY TIP ------------------ */
function getDailyTip() {
  const tips = JSON.parse(fs.readFileSync(TIPS_PATH, "utf8"));
  let shown = fs.existsSync(TIPS_CACHE_PATH) ? JSON.parse(fs.readFileSync(TIPS_CACHE_PATH, "utf8")) : {};
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
  const now = getPHNow();
  const day = now.getDay(); // 0=Sunday, 5=Friday, 6=Saturday

  // Only show countdown on Friday or Saturday
  if (day !== 5 && day !== CONFIG.UPDATE_DAY) {
    return "";
  }

  const hour = now.getHours();
  const target = new Date(now);
  target.setHours(CONFIG.UPDATE_HOUR, 0, 0, 0);

  if (day === CONFIG.UPDATE_DAY) {
    if (hour >= CONFIG.UPDATE_HOUR) {
      const nextUpdate = new Date(now);
      nextUpdate.setDate(now.getDate() + 7);
      nextUpdate.setHours(CONFIG.UPDATE_HOUR, 0, 0, 0);
      return `⏳ ${stylizeBoldSerif("Next update in")} ${formatTimeDifference(nextUpdate - now)}`;
    } else if (hour >= 20) {
      return stylizeBoldSerif("⚠️ Admins are now online... Watch out 👀");
    }
    return `⏳ ${stylizeBoldSerif("Update in")} ${formatTimeDifference(target - now)}`;
  }

  // If it's Friday, show upcoming Saturday countdown
  const nextUpdate = new Date(now);
  nextUpdate.setDate(now.getDate() + ((7 - day + CONFIG.UPDATE_DAY) % 7));
  nextUpdate.setHours(CONFIG.UPDATE_HOUR, 0, 0, 0);
  return `⏳ ${stylizeBoldSerif("Update in")} ${formatTimeDifference(nextUpdate - now)}`;
}

/* ------------------ API HANDLERS ------------------ */
async function fetchWeather() {
  try {
    const res = await axios.get(CONFIG.WEATHER_API, { timeout: 8000 });
    return res.data;
  } catch (err) {
    console.error("⚠️ Weather API failed:", err.message);
    return null;
  }
}
async function getStockData() {
  try {
    const res = await axios.get(CONFIG.STOCK_API, { timeout: 8000 });
    return res.data;
  } catch (err) {
    console.error("⚠️ Stock API failed:", err.message);
    return {};
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

/* ------------------ MESSAGE UI ------------------ */
function stylizeArraySection(title, emoji, arr) {
  if (!arr?.length) return "";
  const header = `╭───── ${stylizeBoldSerif(title.toUpperCase())} ─────╮`;
  const lines = arr.map(x => `${emoji} ${x}`).join("\n");
  const footer = `╰──────────────────────╯`;
  return `${header}\n${lines}\n${footer}`;
}

function stylizeWeather(weather) {
  if (!weather?.description) return "";
  return `╭───── ${stylizeBoldSerif("WEATHER")} ─────╮
☁️ ${weather.description}
🌱 Bonus Crop: ${weather.cropBonuses || "None"}
╰──────────────────────╯`;
}

function stylizeTip(tip) {
  return tip ? `╭───── ${stylizeBoldSerif("DAILY TIP")} ─────╮\n${tip}\n╰──────────────────────╯` : "";
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
    const form = new FormData();

    if (hasVid) {
      form.append("description", message);
      form.append("access_token", token);
      form.append("source", fs.createReadStream(CONFIG.TEMP_VIDEO_PATH));
      res = await axios.post(`https://graph.facebook.com/${CONFIG.PAGE_ID}/videos`, form, { headers: form.getHeaders() });
    } else {
      form.append("message", message);
      form.append("access_token", token);
      form.append("published", "true");
      form.append("source", fs.createReadStream(CONFIG.TEMP_IMAGE_PATH));
      res = await axios.post(`https://graph.facebook.com/${CONFIG.PAGE_ID}/photos`, form, { headers: form.getHeaders() });
    }

    console.log(`✅ Posted at ${formatPHTime()} → https://facebook.com/${res.data.post_id || res.data.id}`);
  } catch (err) {
    console.error("❌ FB post failed:", err.response?.data?.error?.message || err.message);
  }
}

/* ------------------ MAIN ------------------ */
async function checkAndPost() {
  try {
    const lastHash = loadHash(CONFIG.HASH_FILE);
    const [stock, weather] = await Promise.all([getStockData(), fetchWeather()]);
    const newHash = hashData({ stock, weather });

    if (newHash === lastHash) {
      console.log("⏸️ No new stock. Waiting...");
      return;
    }

    const countdown = getUpdateCountdownMessage();

    const message = [
      `🌿✨ ${stylizeBoldSerif("Grow-a-Garden Report")} ✨🌿`,
      `🕓 ${formatPHTime()} PH Time`,
      stylizeArraySection("GEAR", "🛠️", stock.gear),
      stylizeArraySection("SEEDS", "🌱", stock.seeds),
      stylizeArraySection("EGGS", "🥚", stock.egg),
      stylizeWeather(weather),
      countdown ? `╭──── ${stylizeBoldSerif("GAG UPDATE CHECK")} ────╮\n${countdown}\n╰────────────────╯` : "",
      stylizeTip(getDailyTip())
    ].filter(Boolean).join("\n\n");

    await postToFacebook(message);
    saveHash(CONFIG.HASH_FILE, newHash);
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

/* ------------------ AUTO POST LOOP ------------------ */
function getDelayToNext5MinutePH() {
  const now = getPHNow();
  const sec = now.getSeconds();
  const ms = now.getMilliseconds();
  const next = 5 - (now.getMinutes() % 5);
  const delay = next * 60 * 1000 - sec * 1000 - ms;
  return delay === 0 ? 5 * 60 * 1000 : delay;
}

function startAutoPoster() {
  const delay = getDelayToNext5MinutePH();
  console.log(`⏭️ Next check in ${Math.floor(delay/60000)}m ${(delay/1000)%60}s`);
  setTimeout(async () => {
    await checkAndPost();
    setInterval(checkAndPost, CONFIG.DEFAULT_CHECK_INTERVAL_MS);
  }, delay);
}

/* ------------------ EXPRESS SERVER ------------------ */
app.use("/doc", express.static(path.join(__dirname, "public"), { index: "doc.html" }));
app.get("/", (req, res) => res.redirect("/doc"));

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  startAutoPoster();
});