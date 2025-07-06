require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const crypto = require("crypto");
const FormData = require("form-data");
const path = require("path");

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
  console.error("❌ Required env vars missing: APP_ID, APP_SECRET, PAGE_ID.");
  process.exit(1);
}

// Load emoji and rarity definitions
const EMOJIS = safeJsonLoad("emoji.json");
const RARITY = safeJsonLoad("rarity.json");

function safeJsonLoad(filePath) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch {
    console.warn(`⚠️ Failed to load JSON file: ${filePath}`);
    return {};
  }
}

// ⏰ Format PH time
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

// 🔁 Countdown parsing and formatting
function parseCountdown(str) {
  const match = str?.match(/(\d+)h\s+(\d+)m\s+(\d+)s/);
  if (!match) return 0;
  const [, h, m, s] = match.map(Number);
  return (h * 3600 + m * 60 + s) * 1000;
}

function formatCountdown(str) {
  const ms = parseCountdown(str);
  if (ms <= 0) return "Restock imminent";
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}h ${m}m ${s}s`;
}

// 📦 Summarize item sections
function summarizeSection(title, icon, section) {
  if (!section?.items?.length) return `\n\n${icon} ${title} — ❌ Out of Stock`;

  const counts = section.items.reduce((acc, { name, quantity }) => {
    acc[name] = (acc[name] || 0) + quantity;
    return acc;
  }, {});

  const lines = Object.entries(counts).map(([name, qty]) => {
    return `• ${getEmoji(name)} ${name} ×${qty} "${getRarity(name)}"`;
  });

  return `\n\n${icon} ${title}\n⏳ Restock In: ${formatCountdown(section.countdown)}\n${lines.join("\n")}`;
}

// 🚚 Merchant logic
function summarizeMerchant(merchant) {
  if (!merchant || merchant.status === "leaved") {
    if (!merchant?.appearIn) return "\n\n🛒 Traveling Merchant — Not Available";

    const ms = parseCountdown(merchant.appearIn);
    const eta = new Date(Date.now() + ms).toLocaleTimeString("en-PH", {
      timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hour12: true
    });

    return `\n\n🛒 Traveling Merchant — 📦 Coming back in ${merchant.appearIn} (~${eta})`;
  }

  const items = merchant.items.map(({ name, quantity }) => {
    return `• ${getEmoji(name)} ${name} ×${quantity} "${getRarity(name)}"`;
  });

  return `\n\n🛒 Traveling Merchant\n⏳ Time Left: ${formatCountdown(merchant.countdown)}\n${items.join("\n")}`;
}

// ⭐ Recommended items
function generateRecommendedItems(stock) {
  const preferred = ["Master Sprinkler", "Magnifying Glass", "Beanstalk", "Sugar Apple"];

  const items = [
    ...stock.gear?.items || [],
    ...stock.seed?.items || [],
    ...stock.egg?.items || [],
    ...stock.honey?.items || [],
    ...stock.cosmetics?.items || [],
    ...stock.travelingmerchant?.items || [],
  ];

  const recommended = preferred.map(name => {
    const found = items.find(i => i.name === name);
    return found ? `• ${getEmoji(name)} ${name} ×${found.quantity}` : null;
  }).filter(Boolean);

  return recommended.length ? `\n\n📝 𝗥𝗲𝗰𝗼𝗺𝗺𝗲𝗻𝗱𝗲𝗱 𝘁𝗼 𝗚𝗲𝘁:\n${recommended.join("\n")}` : "";
}

// 🔒 Hash and store stock
function hashData(data) {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function cleanStockForHashing(stock) {
  const clone = structuredClone(stock);
  delete clone.updated_at;
  Object.values(clone).forEach(obj => obj && delete obj.updated_at);
  return clone;
}

function loadHash(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function saveHash(file, hash) {
  fs.writeFileSync(file, hash, "utf8");
}

// 🔑 Facebook access token exchange
async function getOrExchangeLongLivedToken() {
  if (CONFIG.LONG_PAGE_ACCESS_TOKEN) return CONFIG.LONG_PAGE_ACCESS_TOKEN;

  try {
    const { data } = await axios.get("https://graph.facebook.com/oauth/access_token", {
      params: {
        grant_type: "fb_exchange_token",
        client_id: CONFIG.APP_ID,
        client_secret: CONFIG.APP_SECRET,
        fb_exchange_token: CONFIG.PAGE_ACCESS_TOKEN,
      },
    });

    updateEnvToken(data.access_token);
    return data.access_token;
  } catch (err) {
    console.error("❌ Token exchange failed:", err.response?.data || err.message);
    return null;
  }
}

function updateEnvToken(newToken) {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) {
    console.log("📌 Long-lived token:\n" + newToken);
    return;
  }

  let env = fs.readFileSync(envPath, "utf8");
  env = env.replace(/^LONG_PAGE_ACCESS_TOKEN=.*$/m, `LONG_PAGE_ACCESS_TOKEN=${newToken}`);
  env = env.replace(/^PAGE_ACCESS_TOKEN=.*$/m, "PAGE_ACCESS_TOKEN=//exchange for only");
  fs.writeFileSync(envPath, env, "utf8");
  console.log("✅ .env updated with new long-lived token.");
}

// 📤 Post to Facebook
async function postToFacebook(message) {
  const token = await getOrExchangeLongLivedToken();
  if (!token) return;

  try {
    if (!fs.existsSync(CONFIG.TEMP_IMAGE_PATH)) throw new Error("Image not found.");

    const form = new FormData();
    form.append("message", message);
    form.append("access_token", token);
    form.append("published", "true");
    form.append("source", fs.createReadStream(CONFIG.TEMP_IMAGE_PATH));

    const { data } = await axios.post(`https://graph.facebook.com/${CONFIG.PAGE_ID}/photos`, form, {
      headers: form.getHeaders(),
    });

    console.log("✅ Posted to Facebook. ID:", data.post_id || data.id);
  } catch (err) {
    console.error("❌ Facebook post failed:", err.response?.data?.error?.message || err.message);
  }
}

// 🔄 Main logic
async function checkAndPost() {
  let nextInterval = CONFIG.DEFAULT_CHECK_INTERVAL_MS;
  try {
    const { data: raw } = await axios.get(CONFIG.STOCK_URL);
    const stock = raw.data || raw;

    const countdowns = [
      stock.egg, stock.gear, stock.seed, stock.honey, stock.cosmetics
    ].map(s => parseCountdown(s?.countdown)).filter(Boolean);

    if (countdowns.length) nextInterval = Math.min(...countdowns) + 1000;

    const currentHash = hashData(cleanStockForHashing(stock));
    const previousHash = loadHash(CONFIG.HASH_FILE);

    if (currentHash === previousHash) {
      console.log(`ℹ️ No update as of ${formatPHTime()}`);
      return nextInterval;
    }

    const message = [
      `🌿✨ 𝗚𝗿𝗼𝘄-𝗮-𝗚𝗮𝗿𝗱𝗲𝗻 𝗦𝘁𝗼𝗰𝗸 𝗨𝗽𝗱𝗮𝘁𝗲 ✨🌿`,
      `━━━━━━━━━━━━━━━━━━━━`,
      summarizeSection("Gear", "🛠️", stock.gear),
      `━━━━━━━━━━━━━━━━━━━━`,
      summarizeSection("Seeds", "🌱", stock.seed),
      `━━━━━━━━━━━━━━━━━━━━`,
      summarizeSection("Eggs", "🥚", stock.egg),
      `━━━━━━━━━━━━━━━━━━━━`,
      summarizeSection("Cosmetics", "🎨", stock.cosmetics),
      `━━━━━━━━━━━━━━━━━━━━`,
      summarizeSection("Honey", "🍯", stock.honey),
      `━━━━━━━━━━━━━━━━━━━━`,
      summarizeMerchant(stock.travelingmerchant),
      `━━━━━━━━━━━━━━━━━━━━`,
      `📅 𝗟𝗮𝘀𝘁 𝗨𝗽𝗱𝗮𝘁𝗲: ${formatPHTime()}`,
      generateRecommendedItems(stock)
    ].join("\n");

    await postToFacebook(message);
    saveHash(CONFIG.HASH_FILE, currentHash);
  } catch (err) {
    console.error(`❌ Error during update (${formatPHTime()}):`, err.message);
  }
  return nextInterval;
}

// 🕒 Calculate delay to next 5-minute interval
function getDelayToNext5MinutePH() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  const delayMs = ((5 - (now.getMinutes() % 5)) * 60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  return delayMs;
}

function startAutoPosterEvery5Min() {
  const delay = getDelayToNext5MinutePH();
  console.log(`🕐 First post in ${Math.ceil(delay / 1000)} seconds...`);
  setTimeout(async () => {
    await checkAndPost();
    setInterval(checkAndPost, 5 * 60 * 1000);
  }, delay);
}

// 🧠 Utility lookup
const getEmoji = name => EMOJIS[name] || "🔹";
const getRarity = name => RARITY[name] || "Unknown";

// 🌐 Express routes
app.use("/doc", express.static(path.join(__dirname, "public"), { index: "doc.html" }));
app.get("/", (_, res) => res.redirect("/doc"));

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  startAutoPosterEvery5Min();
});