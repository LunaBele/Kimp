require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");
const crypto = require("crypto");
const FormData = require("form-data");

const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG = {
  APP_ID: process.env.APP_ID,
  APP_SECRET: process.env.APP_SECRET,
  PAGE_ID: process.env.PAGE_ID,
  PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN,
  LONG_PAGE_ACCESS_TOKEN: process.env.LONG_PAGE_ACCESS_TOKEN,
  TEMP_IMAGE_PATH: path.join("cache", "Temp.png"),
  DEFAULT_CHECK_INTERVAL_MS: 5 * 60 * 1000,
  MERCHANT_API: "https://gagstock.gleeze.com/grow-a-garden",
  HASH_FILE: "last_stock_hash.txt",
};

const EMOJIS = JSON.parse(fs.readFileSync("emoji.json", "utf8"));

function stylizeBoldSerif(str) {
  const offset = {
    upper: 0x1d5d4 - 65,
    lower: 0x1d5ee - 97,
    digit: 0x1d7ec - 48,
  };
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

function parseCountdown(countdown) {
  const match = countdown?.match(/(\d+)h\s+(\d+)m\s+(\d+)s/);
  if (!match) return 0;
  const [, h, m, s] = match.map(Number);
  return (h * 3600 + m * 60 + s) * 1000;
}

function formatCountdownFancy(str) {
  const ms = parseCountdown(str);
  if (ms <= 0) return stylizeBoldSerif("Restock Imminent");
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${stylizeBoldSerif(h)}ʜ ${stylizeBoldSerif(m)}ᴍ ${stylizeBoldSerif(s)}ꜱ`;
}

function formatItemLine(name, qty) {
  return `╰┈☆ ${stylizeBoldSerif(name)} [${stylizeBoldSerif(qty.toString())}] ☆┈╯`;
}

function summarizeSection(title, icon, dataArr) {
  const heading = `\n\n${icon} ${stylizeBoldSerif(title)}`;
  if (!dataArr?.length) return `${heading}\n${stylizeBoldSerif("Out of stock")}`;
  const counts = {};
  dataArr.forEach(item => {
    const match = item.match(/^(.*?)\s+\*\*x(\d+)\*\*$/);
    if (match) {
      const [, name, qty] = match;
      counts[name] = (counts[name] || 0) + parseInt(qty, 10);
    }
  });
  const lines = Object.entries(counts)
    .map(([name, qty]) => formatItemLine(name, qty))
    .join("\n");
  return `${heading}\n${lines}`;
}

function summarizeMerchant(merchant) {
  const heading = `\n\n🛒 ${stylizeBoldSerif("Traveling Merchant")}`;
  if (!merchant || merchant.status === "leaved") {
    if (!merchant?.appearIn) return `${heading}\n${stylizeBoldSerif("Not Available")}`;
    const eta = new Date(Date.now() + parseCountdown(merchant.appearIn)).toLocaleTimeString("en-PH", {
      timeZone: "Asia/Manila",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    return `${heading}\n📦 ${stylizeBoldSerif("Coming back in")} ${stylizeBoldSerif(merchant.appearIn)} (~${eta})`;
  }
  const lines = merchant.items.map(({ name, quantity }) =>
    formatItemLine(name, quantity)
  ).join("\n");
  return `${heading}\n⏳ ${formatCountdownFancy(merchant.countdown)}\n${lines}`;
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
  const [gearRes, seedRes, eggRes, merchantRes] = await Promise.all([
    axios.get("https://growagardenstock.com/api/stock?type=gear"),
    axios.get("https://growagardenstock.com/api/stock?type=seeds"),
    axios.get("https://growagardenstock.com/api/stock?type=egg"),
    axios.get(CONFIG.MERCHANT_API),
  ]);

  return {
    gear: gearRes.data.gear,
    seed: seedRes.data.seeds,
    egg: eggRes.data.egg,
    merchant: merchantRes.data.data.travelingmerchant,
  };
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

async function postToFacebook(message) {
  const token = await getOrExchangeLongLivedToken();
  if (!token || !fs.existsSync(CONFIG.TEMP_IMAGE_PATH)) return;
  const form = new FormData();
  form.append("message", message);
  form.append("access_token", token);
  form.append("published", "true");
  form.append("source", fs.createReadStream(CONFIG.TEMP_IMAGE_PATH));
  const res = await axios.post(`https://graph.facebook.com/${CONFIG.PAGE_ID}/photos`, form, {
    headers: form.getHeaders()
  });
  console.log("✅ Posted to Facebook. Post ID:", res.data.post_id || res.data.id);
}

async function checkAndPost() {
  let nextCheck = CONFIG.DEFAULT_CHECK_INTERVAL_MS;
  try {
    const stock = await getStockData();
    const hash = hashData(stock);
    const lastHash = loadHash(CONFIG.HASH_FILE);
    if (hash === lastHash) return nextCheck;

    const message =
      `${stylizeBoldSerif("🌿✨ Grow-a-Garden Stock Update ✨🌿")}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      summarizeSection("Gear Shop", "🛠️", stock.gear) +
      `\n━━━━━━━━━━━━━━━━━━━━\n` +
      summarizeSection("Seed Store", "🌱", stock.seed) +
      `\n━━━━━━━━━━━━━━━━━━━━\n` +
      summarizeSection("Egg Collection", "🥚", stock.egg) +
      `\n━━━━━━━━━━━━━━━━━━━━\n` +
      summarizeMerchant(stock.merchant) +
      `\n━━━━━━━━━━━━━━━━━━━━\n` +
      `📅 ${stylizeBoldSerif("Last Update")}: ${stylizeBoldSerif(formatPHTime())}`;

    await postToFacebook(message);
    saveHash(CONFIG.HASH_FILE, hash);
  } catch (err) {
    console.error("❌ Error in checkAndPost:", err.message);
  }
  return nextCheck;
}

function getDelayToNext5MinutePH() {
  const now = new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" });
  const current = new Date(now);
  const seconds = current.getSeconds();
  const ms = current.getMilliseconds();
  const minutes = current.getMinutes();
  const next = 5 - (minutes % 5);
  return (next * 60 - seconds) * 1000 - ms;
}

function startAutoPosterEvery5Min() {
  const delay = getDelayToNext5MinutePH();
  console.log(`🕐 First post scheduled in ${Math.ceil(delay / 1000)} seconds.`);
  setTimeout(async () => {
    await checkAndPost();
    setInterval(checkAndPost, 5 * 60 * 1000);
  }, delay);
}

app.use('/doc', express.static(path.join(__dirname, 'public'), { index: 'doc.html' }));
app.get('/', (req, res) => res.redirect('/doc'));
app.listen(PORT, () => {
  console.log(`🌐 Server is listening on port ${PORT}`);
  startAutoPosterEvery5Min();
});