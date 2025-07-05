require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const crypto = require("crypto");
const FormData = require("form-data");
const path = require("path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG = {
  APP_ID: process.env.APP_ID,
  APP_SECRET: process.env.APP_SECRET,
  PAGE_ID: process.env.PAGE_ID,
  PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN,
  LONG_PAGE_ACCESS_TOKEN: process.env.LONG_PAGE_ACCESS_TOKEN,
  TEMP_IMAGE_PATH: path.join("cache", "Temp.png"),
  DEFAULT_CHECK_INTERVAL_MS: 30 * 1000,
  STOCK_URL: "https://gagstock.gleeze.com/grow-a-garden",
  HASH_FILE: "last_stock_hash.txt",
};

if (!CONFIG.APP_ID || !CONFIG.APP_SECRET || !CONFIG.PAGE_ID) {
  console.error("❌ APP_ID, APP_SECRET, and PAGE_ID must be set in .env");
  process.exit(1);
}

const EMOJIS = JSON.parse(fs.readFileSync(path.resolve("emoji.json"), "utf8"));

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
  if (!countdown) return 0;
  const match = countdown.match(/(\d+)h\s+(\d+)m\s+(\d+)s/);
  if (!match) return 0;
  const [, h, m, s] = match.map(Number);
  return (h * 3600 + m * 60 + s) * 1000;
}

function formatCountdown(countdown) {
  const ms = parseCountdown(countdown);
  if (ms <= 0) return "Restock imminent";
  const hours = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const minutes = String(Math.floor(ms / 60000) % 60).padStart(2, "0");
  const seconds = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
  return `${hours}h ${minutes}m ${seconds}s`;
}

function summarizeSection(title, icon, section) {
  if (!section?.items?.length) return `\n\n${icon} ${title} — ❌ Out of Stock`;
  const counts = section.items.reduce((acc, { name, quantity }) => {
    acc[name] = (acc[name] || 0) + quantity;
    return acc;
  }, {});
  const lines = Object.entries(counts)
    .map(([name, qty]) => `• ${EMOJIS[name] || "🔹"} ${name} ×${qty}`)
    .join("\n");
  return `\n\n${title}\n⏳ Restock In: ${formatCountdown(section.countdown)}\n${lines}`;
}

function summarizeMerchant(merchant) {
  if (merchant.status === "leaved" && merchant.appearIn) {
    const ms = parseCountdown(merchant.appearIn);
    const now = new Date();
    const appearTime = new Date(now.getTime() + ms);
    const timeStr = appearTime.toLocaleTimeString("en-PH", {
      timeZone: "Asia/Manila",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
    return (
      `\n\n🧳 Traveling Merchant\n` +
      `📤 Status: Left the garden\n` +
      `⏳ Returns In: ${merchant.appearIn}\n` +
      `🕒 Will Return At: ${timeStr}`
    );
  } else if (merchant.status === "arrived") {
    const lines = merchant.items.map(
      item => `• ${item.emoji || "📦"} ${item.name} ×${item.quantity}`
    ).join("\n");
    return `\n\n🧳 Traveling Merchant\n⏳ Leaves In: ${formatCountdown(merchant.countdown)}\n${lines}`;
  }
  return "";
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

function cleanStockForHashing(stock) {
  const clone = JSON.parse(JSON.stringify(stock));
  delete clone.updated_at;
  for (const key of Object.keys(clone)) delete clone[key]?.updated_at;
  return clone;
}

function updateEnvToken(newToken) {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) {
    console.warn("⚠️ Skipping .env update — not supported in Render.");
    console.log(`📌 Long-lived token:\n${newToken}\n\nPaste it manually into your Render Dashboard.`);
    return;
  }

  let envContent = fs.readFileSync(envPath, "utf8");
  envContent = envContent
    .replace(/^PAGE_ACCESS_TOKEN=.*$/m, "PAGE_ACCESS_TOKEN=//exchange for only")
    .replace(/^LONG_PAGE_ACCESS_TOKEN=.*$/m, `LONG_PAGE_ACCESS_TOKEN=${newToken}`);
  fs.writeFileSync(envPath, envContent, "utf8");
  console.log("✅ .env updated with long-lived token.");
}

async function getOrExchangeLongLivedToken() {
  if (CONFIG.LONG_PAGE_ACCESS_TOKEN) {
    return CONFIG.LONG_PAGE_ACCESS_TOKEN;
  }

  try {
    const url = `https://graph.facebook.com/oauth/access_token`;
    const params = {
      grant_type: "fb_exchange_token",
      client_id: CONFIG.APP_ID,
      client_secret: CONFIG.APP_SECRET,
      fb_exchange_token: CONFIG.PAGE_ACCESS_TOKEN,
    };

    const res = await axios.get(url, { params });
    const longToken = res.data.access_token;
    updateEnvToken(longToken);
    return longToken;
  } catch (err) {
    console.error("❌ Failed to exchange for long-lived token:", err.response?.data || err.message);
    return CONFIG.LONG_PAGE_ACCESS_TOKEN || null;
  }
}

async function postToFacebook(message) {
  const token = await getOrExchangeLongLivedToken();
  if (!token) {
    console.error("❌ No valid access token available.");
    return;
  }

  try {
    if (!fs.existsSync(CONFIG.TEMP_IMAGE_PATH)) throw new Error("Image not found.");

    const form = new FormData();
    form.append("message", message);
    form.append("access_token", token);
    form.append("published", "true");
    form.append("source", fs.createReadStream(CONFIG.TEMP_IMAGE_PATH));

    const res = await axios.post(
      `https://graph.facebook.com/${CONFIG.PAGE_ID}/photos`,
      form,
      { headers: form.getHeaders() }
    );

    console.log("✅ Posted to Facebook. Post ID:", res.data.post_id || res.data.id);
  } catch (error) {
    console.error("❌ Failed to post to Facebook:", error.response?.data?.error?.message || error.message);
  }
}

async function checkAndPost() {
  let nextCheckInterval = CONFIG.DEFAULT_CHECK_INTERVAL_MS;

  try {
    const stockRes = await axios.get(CONFIG.STOCK_URL);
    const stock = stockRes.data.data || stockRes.data;

    const countdowns = [
      parseCountdown(stock.egg?.countdown),
      parseCountdown(stock.gear?.countdown),
      parseCountdown(stock.seed?.countdown),
      parseCountdown(stock.honey?.countdown),
      parseCountdown(stock.cosmetics?.countdown),
    ].filter(ms => ms > 0);

    if (countdowns.length === 0) return 1000;
    nextCheckInterval = Math.min(...countdowns) + 1000;

    const stockHash = hashData(cleanStockForHashing(stock));
    const prevStockHash = loadHash(CONFIG.HASH_FILE);

    if (stockHash === prevStockHash) {
      console.log(`ℹ️ No changes detected as of ${formatPHTime()}.`);
      return nextCheckInterval;
    }

    const message =
      `🌿✨ 𝗚𝗿𝗼𝘄-𝗮-𝗚𝗮𝗿𝗱𝗲𝗻 𝗦𝘁𝗼𝗰𝗸 𝗨𝗽𝗱𝗮𝘁𝗲 ✨🌿\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      summarizeSection("🛠️ Gear", "🛠️", stock.gear) +
      `\n━━━━━━━━━━━━━━━━━━━━\n` +
      summarizeSection("🌱 Seeds", "🌱", stock.seed) +
      `\n━━━━━━━━━━━━━━━━━━━━\n` +
      summarizeSection("🥚 Eggs", "🥚", stock.egg) +
      `\n━━━━━━━━━━━━━━━━━━━━\n` +
      summarizeSection("🎨 Cosmetics", "🎨", stock.cosmetics) +
      `\n━━━━━━━━━━━━━━━━━━━━\n` +
      summarizeSection("🍯 Honey", "🍯", stock.honey) +
      `\n━━━━━━━━━━━━━━━━━━━━\n` +
      summarizeMerchant(stock.travelingmerchant) +
      `\n━━━━━━━━━━━━━━━━━━━━\n` +
      `📆 𝗟𝗮𝘀𝘁 𝗨𝗽𝗱𝗮𝘁𝗲: ${formatPHTime()}`;

    await postToFacebook(message);
    saveHash(CONFIG.HASH_FILE, stockHash);

    return nextCheckInterval;
  } catch (err) {
    console.error(`❌ Error during check/post at ${formatPHTime()}:`, err.message);
    return nextCheckInterval;
  }
}

function getDelayToNext5MinutePH() {
  const now = new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" });
  const current = new Date(now);
  const ms = current.getMilliseconds();
  const seconds = current.getSeconds();
  const minutes = current.getMinutes();

  const minutesToNext = 5 - (minutes % 5);
  const delay = (minutesToNext * 60 - seconds) * 1000 - ms;
  return delay;
}

function startAutoPosterEvery5Min() {
  const delay = getDelayToNext5MinutePH();
  console.log(`🕐 First post scheduled in ${Math.ceil(delay / 1000)} seconds.`);

  setTimeout(async () => {
    await checkAndPost();
    setInterval(checkAndPost, 5 * 60 * 1000); // Every 5 minutes
  }, delay);
}

// Serve /doc from public/doc.html
app.use('/doc', express.static(path.join(__dirname, 'public'), { index: 'doc.html' }));

// Redirect root / to /doc
app.get('/', (req, res) => {
  res.redirect('/doc');
});

app.listen(PORT, () => {
  console.log(`🌐 Server is listening on port ${PORT}`);
  startAutoPosterEvery5Min();
});