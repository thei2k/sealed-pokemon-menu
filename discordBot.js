// discordBot.js (FULL OVERWRITE)
// Adds JustTCG debug logging so Market:N/A is explainable.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  Events,
} = require("discord.js");
const cron = require("node-cron");

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const JUSTTCG_API_KEY = process.env.JUSTTCG_API_KEY;

const ALLOWED_GUILD_IDS = process.env.ALLOWED_GUILD_IDS
  ? process.env.ALLOWED_GUILD_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

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

const CMD_PREFIX = "!";
const BATCH_SIZE = 20;
const ON_DEMAND_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const lastOnDemandRun = {}; // userId -> ts

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

function isUserAllowed(message) {
  const userId = message.author.id;
  if (ALLOWED_GUILD_IDS.length === 0 && ALLOWED_USER_IDS.length === 0) return true;
  if (ALLOWED_USER_IDS.includes(userId)) return true;
  if (message.guild) return ALLOWED_GUILD_IDS.includes(message.guild.id);
  return false;
}

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

// ---- JUSTTCG ----
async function fetchCardPrices(tcgplayerIds) {
  const uniqueIds = Array.from(
    new Set((tcgplayerIds || []).map((id) => String(id).trim()).filter(Boolean))
  );

  const idToPrice = {};
  if (!uniqueIds.length) return idToPrice;

  // JustTCG expects array of lookup objects:
  const lookups = uniqueIds.map((id) => ({ tcgplayerId: id }));

  for (let i = 0; i < lookups.length; i += BATCH_SIZE) {
    const batch = lookups.slice(i, i + BATCH_SIZE);

    let res;
    let text = "";
    try {
      res = await fetch("https://api.justtcg.com/v1/cards", {
        method: "POST",
        headers: {
          "X-Api-Key": JUSTTCG_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
      });

      if (!res.ok) {
        text = await res.text().catch(() => "");
        console.error(`JustTCG FAILED: ${res.status} ${res.statusText} ${text}`);
        continue;
      }
    } catch (err) {
      console.error("JustTCG REQUEST ERROR:", err);
      continue;
    }

    let result;
    try {
      result = await res.json();
    } catch (err) {
      const fallback = await res.text().catch(() => "");
      console.error("JustTCG JSON PARSE ERROR:", err, "RAW:", fallback);
      continue;
    }

    const cards = Array.isArray(result) ? result : result?.data || [];

    if (DEBUG_JUSTTCG) {
      console.log(
        `[JustTCG] batch=${Math.floor(i / BATCH_SIZE) + 1} requested=${batch.length} returned=${cards.length}`
      );
    }

    for (const card of cards) {
      const rawId =
        card?.tcgplayerId ?? card?.tcgplayer_id ?? card?.tcgPlayerId ?? null;
      if (!rawId) {
        if (DEBUG_JUSTTCG) console.log("[JustTCG] card missing tcgplayerId:", card?.name);
        continue;
      }

      const id = String(rawId);
      const variants = Array.isArray(card?.variants) ? card.variants : [];

      const sealed = variants.find((v) => v && v.condition === "Sealed");
      const chosen = sealed || variants[0];

      if (DEBUG_JUSTTCG) {
        console.log(
          `[JustTCG] id=${id} name=${card?.name || ""} variants=${variants.length} sealed=${sealed ? "yes" : "no"}`
        );
      }

      if (!chosen || chosen.price == null) {
        idToPrice[id] = {
          marketPrice: null,
          setName: card?.set_name || card?.setName || null,
          name: card?.name || null,
          reason: variants.length ? "NO_PRICE_ON_CHOSEN_VARIANT" : "NO_VARIANTS",
        };
        continue;
      }

      const price = Number(chosen.price);
      if (!Number.isFinite(price) || price <= 0 || price > 10000) {
        idToPrice[id] = {
          marketPrice: null,
          setName: card?.set_name || card?.setName || null,
          name: card?.name || null,
          reason: "INVALID_PRICE",
        };
        continue;
      }

      idToPrice[id] = {
        marketPrice: price,
        setName: card?.set_name || card?.setName || null,
        name: card?.name || null,
      };
    }
  }

  return idToPrice;
}

// ---- COMMANDS ----
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
  if (!list.length) return message.reply("Your watchlist is empty. Use `!inventoryadd` first.");

  const ids = list.map((i) => i.tcgplayerId);
  const prices = await fetchCardPrices(ids);

  const lines = list.map((item) => {
    const p = prices[item.tcgplayerId] || {};
    const name = p.name || item.label || "(unknown)";
    const setName = p.setName ? ` [${p.setName}]` : "";
    const priceText = p.marketPrice != null ? `$${p.marketPrice.toFixed(2)}` : "N/A";
    const reason = p.marketPrice == null && p.reason ? ` (debug: ${p.reason})` : "";
    return `• ${name}${setName}\n  ID: ${item.tcgplayerId} – ${item.label} – Market: ${priceText}${reason}`;
  });

  try {
    await message.author.send(`⚡ On-demand price check:\n\n${lines.join("\n\n")}`);
    if (message.guild) await message.reply("✅ Sent you a DM with your on-demand prices.");
  } catch (err) {
    console.error("Failed to DM now:", err);
    await message.reply("I couldn't DM you — check your DM privacy settings.");
  }
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(CMD_PREFIX)) return;

  if (!isUserAllowed(message)) {
    try { await message.reply("This bot is restricted; you are not authorized."); } catch (_) {}
    return;
  }

  const cmd = message.content.slice(1).trim().split(/\s+/)[0].toLowerCase();

  try {
    if (cmd === "inventorynow") return await handleInventoryNow(message);
  } catch (err) {
    console.error("Command error:", err);
    try { await message.reply("Something went wrong. Try again later."); } catch (_) {}
  }
});

// Daily job (kept)
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
      const reason = p.marketPrice == null && p.reason ? ` (debug: ${p.reason})` : "";
      return `• ${name}${setName}\n  ID: ${item.tcgplayerId} – ${item.label} – Market: ${priceText}${reason}`;
    });

    try {
      const user = await client.users.fetch(userId);
      await user.send(`📅 Daily price update:\n\n${lines.join("\n\n")}`);
    } catch (err) {
      console.error(`Failed daily DM to ${userId}:`, err);
    }
  }
});

client.once(Events.ClientReady, () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  console.log(`Portfolio path: ${PORTFOLIO_PATH}`);
  console.log(`DEBUG_JUSTTCG=${DEBUG_JUSTTCG ? "1" : "0"}`);
});

client.login(DISCORD_BOT_TOKEN);
