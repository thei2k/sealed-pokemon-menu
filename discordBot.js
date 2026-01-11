// discordBot.js
// Discord portfolio tracker bot (Railway).
// - Users track tcgplayerIds
// - Daily DM at 10 AM
// - On-demand check via !inventorynow (2h cooldown, admins bypass)
//
// Portfolio item schema (canonical):
//   { tcgplayerId: "543843", label: "Booster Box" }
// Backwards compatible with older:
//   { id: "543843", label: "Booster Box" }

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
} = require("discord.js");
const cron = require("node-cron");

// ---- ENV ----
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const JUSTTCG_API_KEY = process.env.JUSTTCG_API_KEY;

// Optional allowlists
const ALLOWED_GUILD_IDS = process.env.ALLOWED_GUILD_IDS
  ? process.env.ALLOWED_GUILD_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

// Optional persistent storage path (Railway Volume mount recommended)
const PORTFOLIO_PATH = process.env.PORTFOLIO_PATH
  ? path.resolve(process.env.PORTFOLIO_PATH)
  : path.join(__dirname, "userPortfolios.json");

const DEBUG_JUSTTCG = process.env.DEBUG_JUSTTCG === "1";

if (!DISCORD_BOT_TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN");
  process.exit(1);
}
if (!JUSTTCG_API_KEY) {
  console.error("Missing JUSTTCG_API_KEY");
  process.exit(1);
}
if (typeof fetch !== "function") {
  console.error("Node 18+ required (fetch built-in).");
  process.exit(1);
}

// ---- CONST ----
const CMD_PREFIX = "!";
const BATCH_SIZE = 20;
const ON_DEMAND_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const lastOnDemandRun = {}; // userId -> ts

// ---- DISCORD ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// ---- ACCESS ----
function isUserAllowed(message) {
  const userId = message.author.id;

  // No allowlists configured => allow all (backwards compatible)
  if (ALLOWED_GUILD_IDS.length === 0 && ALLOWED_USER_IDS.length === 0) return true;

  if (ALLOWED_USER_IDS.includes(userId)) return true;

  if (message.guild) {
    return ALLOWED_GUILD_IDS.includes(message.guild.id);
  }

  return false;
}

// ---- STORAGE ----
function ensureDirForFile(fp) {
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getItemId(item) {
  return String(item?.tcgplayerId ?? item?.id ?? "").trim();
}

function normalizePortfolios(portfolios) {
  const out = {};
  for (const [userId, items] of Object.entries(portfolios || {})) {
    const map = new Map();
    for (const raw of items || []) {
      const tcgplayerId = getItemId(raw);
      if (!tcgplayerId) continue;
      const label = raw?.label != null ? String(raw.label).trim() : "";
      map.set(tcgplayerId, { tcgplayerId, label });
    }
    out[userId] = Array.from(map.values());
  }
  return out;
}

function loadPortfolios() {
  try {
    ensureDirForFile(PORTFOLIO_PATH);
    if (!fs.existsSync(PORTFOLIO_PATH)) {
      fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify({}, null, 2), "utf8");
      return {};
    }
    const raw = fs.readFileSync(PORTFOLIO_PATH, "utf8");
    if (!raw.trim()) return {};
    return normalizePortfolios(JSON.parse(raw));
  } catch (err) {
    console.error("Failed to load portfolios:", err);
    return {};
  }
}

function savePortfolios(portfolios) {
  try {
    ensureDirForFile(PORTFOLIO_PATH);
    const normalized = normalizePortfolios(portfolios);
    const tmp = `${PORTFOLIO_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf8");
    fs.renameSync(tmp, PORTFOLIO_PATH);
  } catch (err) {
    console.error("Failed to save portfolios:", err);
  }
}

// ---- JUSTTCG (sealed-first logic, matches updater behavior) ----
async function fetchCardPrices(tcgplayerIds) {
  const uniqueIds = Array.from(
    new Set(
      (tcgplayerIds || [])
        .map((id) => String(id).trim())
        .filter((id) => id.length > 0)
    )
  );

  const idToPrice = {}; // id -> { marketPrice, setName, name }

  if (!uniqueIds.length) return idToPrice;

  for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + BATCH_SIZE);

    try {
      const res = await fetch("https://api.justtcg.com/v1/cards", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": JUSTTCG_API_KEY,
        },
        // KEY CHANGE: send raw array, not { tcgplayerIds: [...] }
        body: JSON.stringify(batch),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(
          `JustTCG batch request failed: ${res.status} ${res.statusText} ${text}`
        );
        continue;
      }

      const result = await res.json();
      const cards = Array.isArray(result) ? result : result.data || [];

      if (DEBUG_JUSTTCG) {
        console.log(
          `[JustTCG] Batch ${Math.floor(i / BATCH_SIZE) + 1}: requested=${batch.length} returned=${cards.length}`
        );
      }

      for (const card of cards) {
        if (!card) continue;

        // Be defensive about id naming across responses
        const rawId =
          card.tcgplayerId ??
          card.tcgplayer_id ??
          card.tcgPlayerId ??
          card.tcgPlayerID ??
          null;

        if (!rawId) continue;

        const id = String(rawId);
        const variants = card.variants || [];

        // IMPORTANT: sealed-first
        const variant =
          variants.find((v) => v && v.condition === "Sealed") || variants[0];

        if (!variant || variant.price == null) {
          idToPrice[id] = {
            marketPrice: null,
            setName: card.set_name || card.setName || null,
            name: card.name || null,
          };
          continue;
        }

        const price = Number(variant.price);
        if (!Number.isFinite(price) || price <= 0 || price > 10000) {
          idToPrice[id] = {
            marketPrice: null,
            setName: card.set_name || card.setName || null,
            name: card.name || null,
          };
          continue;
        }

        idToPrice[id] = {
          marketPrice: price,
          setName: card.set_name || card.setName || null,
          name: card.name || null,
        };
      }
    } catch (err) {
      console.error("Error during JustTCG request:", err);
    }
  }

  return idToPrice;
}

// ---- COMMANDS ----
async function handleInventoryAdd(message, argsStr) {
  if (!argsStr) {
    return message.reply(
      'Usage: `!inventoryadd <tcgplayerId> "Label" [<tcgplayerId> "Label" ...]`'
    );
  }

  const pairs = [];
  const regex = /(\d+)\s+"([^"]+)"/g;
  let match;
  while ((match = regex.exec(argsStr)) !== null) {
    const tcgplayerId = match[1];
    const label = match[2].trim();
    if (tcgplayerId && label) pairs.push({ tcgplayerId, label });
  }

  if (!pairs.length) {
    return message.reply(
      "I couldn't parse any `<id> \"Label\"` pairs.\nExample:\n" +
        '`!inventoryadd 543843 "Booster Box" 543844 "Booster Bundle"`'
    );
  }

  const userId = message.author.id;
  const portfolios = loadPortfolios();
  const current = portfolios[userId] || [];

  const map = new Map();
  for (const item of current) map.set(item.tcgplayerId, item);
  for (const p of pairs) map.set(p.tcgplayerId, { tcgplayerId: p.tcgplayerId, label: p.label });

  portfolios[userId] = Array.from(map.values());
  savePortfolios(portfolios);

  await message.reply(
    `✅ Updated your watchlist.\nYou now track ${portfolios[userId].length} item(s).`
  );
}

async function handleInventoryRemove(message, argsStr) {
  const id = argsStr.trim();
  if (!id) return message.reply("Usage: `!inventoryremove <tcgplayerId>`");

  const userId = message.author.id;
  const portfolios = loadPortfolios();
  const current = portfolios[userId] || [];
  const next = current.filter((item) => item.tcgplayerId !== id);

  portfolios[userId] = next;
  savePortfolios(portfolios);

  await message.reply(`🗑 Removed \`${id}\`. You now track ${next.length} item(s).`);
}

async function handleInventoryList(message) {
  const userId = message.author.id;
  const portfolios = loadPortfolios();
  const list = portfolios[userId] || [];

  if (!list.length) return message.reply("Your watchlist is empty.");

  const ids = list.map((i) => i.tcgplayerId);
  const prices = await fetchCardPrices(ids);

  const lines = list.map((item) => {
    const p = prices[item.tcgplayerId] || {};
    const name = p.name || item.label || "(unknown)";
    const setName = p.setName ? ` [${p.setName}]` : "";
    const priceText = p.marketPrice != null ? `$${p.marketPrice.toFixed(2)}` : "N/A";
    return `• ${name}${setName}\n  ID: ${item.tcgplayerId} – ${item.label} – Market: ${priceText}`;
  });

  try {
    await message.author.send(`📊 Your tracked items:\n\n${lines.join("\n\n")}`);
    if (message.guild) await message.reply("✅ Sent you a DM with your watchlist.");
  } catch (err) {
    console.error("Failed to DM list:", err);
    await message.reply("I couldn't DM you — check your DM privacy settings.");
  }
}

async function handleInventoryNow(message) {
  const userId = message.author.id;
  const now = Date.now();

  let isAdmin = false;
  if (message.guild && message.member) {
    try {
      isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);
    } catch (_) {
      isAdmin = false;
    }
  }

  if (!isAdmin) {
    const last = lastOnDemandRun[userId] || 0;
    const elapsed = now - last;
    if (elapsed < ON_DEMAND_COOLDOWN_MS) {
      const mins = Math.ceil((ON_DEMAND_COOLDOWN_MS - elapsed) / 60000);
      return message.reply(`⏳ Cooldown: try again in ~${mins} minute(s).`);
    }
    lastOnDemandRun[userId] = now;
  }

  const portfolios = loadPortfolios();
  const list = portfolios[userId] || [];
  if (!list.length) {
    return message.reply("Your watchlist is empty. Use `!inventoryadd` first.");
  }

  const ids = list.map((i) => i.tcgplayerId);
  const prices = await fetchCardPrices(ids);

  const lines = list.map((item) => {
    const p = prices[item.tcgplayerId] || {};
    const name = p.name || item.label || "(unknown)";
    const setName = p.setName ? ` [${p.setName}]` : "";
    const priceText = p.marketPrice != null ? `$${p.marketPrice.toFixed(2)}` : "N/A";
    return `• ${name}${setName}\n  ID: ${item.tcgplayerId} – ${item.label} – Market: ${priceText}`;
  });

  try {
    await message.author.send(`⚡ On-demand price check:\n\n${lines.join("\n\n")}`);
    if (message.guild) await message.reply("✅ Sent you a DM with your on-demand prices.");
  } catch (err) {
    console.error("Failed to DM now:", err);
    await message.reply("I couldn't DM you — check your DM privacy settings.");
  }
}

// ---- DAILY JOB ----
cron.schedule("0 10 * * *", async () => {
  console.log("[Cron] Daily portfolio price DM starting...");

  const portfolios = loadPortfolios();
  const entries = Object.entries(portfolios);
  if (!entries.length) return;

  const allIds = Array.from(
    new Set(entries.flatMap(([, items]) => (items || []).map((it) => it.tcgplayerId)).filter(Boolean))
  );

  const prices = await fetchCardPrices(allIds);

  for (const [userId, items] of entries) {
    if (!items || !items.length) continue;

    const lines = items.map((item) => {
      const p = prices[item.tcgplayerId] || {};
      const name = p.name || item.label || "(unknown)";
      const setName = p.setName ? ` [${p.setName}]` : "";
      const priceText = p.marketPrice != null ? `$${p.marketPrice.toFixed(2)}` : "N/A";
      return `• ${name}${setName}\n  ID: ${item.tcgplayerId} – ${item.label} – Market: ${priceText}`;
    });

    try {
      const user = await client.users.fetch(userId);
      await user.send(`📅 Daily price update:\n\n${lines.join("\n\n")}`);
    } catch (err) {
      console.error(`Failed daily DM to ${userId}:`, err);
    }
  }
});

// ---- HANDLER ----
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(CMD_PREFIX)) return;

  if (!isUserAllowed(message)) {
    try {
      await message.reply("This bot is currently restricted; you are not authorized.");
    } catch (_) {}
    return;
  }

  const withoutPrefix = message.content.slice(CMD_PREFIX.length).trim();
  const firstSpace = withoutPrefix.indexOf(" ");
  const cmd =
    firstSpace === -1
      ? withoutPrefix.toLowerCase()
      : withoutPrefix.slice(0, firstSpace).toLowerCase();
  const argsStr = firstSpace === -1 ? "" : withoutPrefix.slice(firstSpace + 1).trim();

  try {
    if (cmd === "inventoryadd") return await handleInventoryAdd(message, argsStr);
    if (cmd === "inventoryremove") return await handleInventoryRemove(message, argsStr);
    if (cmd === "inventorylist") return await handleInventoryList(message);
    if (cmd === "inventorynow") return await handleInventoryNow(message);
  } catch (err) {
    console.error("Command error:", err);
    try {
      await message.reply("Something went wrong. Try again later.");
    } catch (_) {}
  }
});

client.once("ready", () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  console.log(`Portfolio path: ${PORTFOLIO_PATH}`);
  console.log("Daily cron: 0 10 * * *");
});

client.login(DISCORD_BOT_TOKEN);
