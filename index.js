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

const EMOJIS = {
  "Common Egg": "🥚", "Uncommon Egg": "🐣", "Rare Egg": "🍳", "Legendary Egg": "🪺", "Mythical Egg": "🔮", "Bug Egg": "🪲",
  "Watering Can": "🚿", "Trowel": "🛠️", "Recall Wrench": "🔧", "Basic Sprinkler": "💧", "Advanced Sprinkler": "💦",
  "Godly Sprinkler": "⛲", "Lightning Rod": "⚡", "Master Sprinkler": "🌊", "Favorite Tool": "❤️", "Harvest Tool": "🌾", "Cleaning Spray": "🧴",
  "Carrot": "🥕", "Strawberry": "🍓", "Blueberry": "🫐", "Tomato": "🍅", "Corn": "🌽", "Watermelon": "🍉", "Pumpkin": "🎃",
  "Apple": "🍎", "Bamboo": "🎍", "Coconut": "🥥", "Cactus": "🌵", "Dragon Fruit": "🍈", "Mango": "🥭", "Grape": "🍇",
  "Mushroom": "🍄", "Pepper": "🌶️", "Cacao": "🍫", "Beanstalk": "🌱", "Ember Lily": "🏵️", "Daffodil": "🌼", "Orange Tulip": "🌷",
  "Flower Seed Pack": "🌸", "Lavender": "💜", "Nectarshade": "🧪", "Pollen Radar": "📡", "Bee Crate": "📦", "Honey Comb": "🍯",
  "Stone Lantern": "🏮", "Small Circle Tile": "🔘", "Sign Crate": "📦", "Compost Bin": "🗑️", "Torch": "🔥", "Red Pottery": "🏺",
  "Curved Canopy": "🏕️", "Medium Wood Flooring": "🪵", "Small Wood Arbour": "🛖",
};

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

function formatCountdown(countdown) {
  const ms = parseCountdown(countdown);
  if (ms <= 0) return "Restock imminent";
  const hours = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const minutes = String(Math.floor(ms / 60000) % 60).padStart(2, "0");
  const seconds = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
  return `${hours}h ${minutes}m ${seconds}s`;
}

function summarizeSection(title, icon, section) {
  const counts = section.items.reduce((acc, { name, quantity }) => {
    acc[name] = (acc[name] || 0) + quantity;
    return acc;
  }, {});
  const lines = Object.entries(counts)
    .map(([name, qty]) => `- ${EMOJIS[name] || "🔹"} ${name}: x${qty}`)
    .join("\n");
  return `\n\n${icon} ${title} (⏱ ${formatCountdown(section.countdown)})\n${lines}`;
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
      `🌱 Grow-a-Garden Stock Update\n` +
      summarizeSection("Gear", "🛠️", stock.gear) +
      summarizeSection("Seeds", "🌱", stock.seed) +
      summarizeSection("Eggs", "🥚", stock.egg) +
      summarizeSection("Cosmetics", "🎨", stock.cosmetics) +
      summarizeSection("Honey", "🍯", stock.honey) +
      `\n\n📅 Updated: ${formatPHTime()}`;

    await postToFacebook(message);
    saveHash(CONFIG.HASH_FILE, stockHash);

    return nextCheckInterval;
  } catch (err) {
    console.error(`❌ Error during check/post at ${formatPHTime()}:`, err.message);
    return nextCheckInterval;
  }
}

let isRunning = false;

function startAutoPoster() {
  if (isRunning) return;
  isRunning = true;
  console.log(`🚀 Auto-poster started at ${formatPHTime()}.`);
  async function runCheck() {
    const nextInterval = await checkAndPost();
    setTimeout(runCheck, nextInterval);
  }
  runCheck();
}

app.get("/", (req, res) => {
  res.send(`🚀 Grow-a-Garden Auto Poster is running. Updated: ${formatPHTime()}`);
});

app.listen(PORT, () => {
  console.log(`🌐 Server is listening on port ${PORT}`);
  startAutoPoster();
});