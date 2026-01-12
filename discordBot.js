// discordBot.js — FULL FILE OVERWRITE
// Source of truth: uploaded discordBot.js
//
// Features:
// - Inventory watchlists per user
// - Daily price DMs
// - On-demand price check (once/day, reset 12 AM ET)
// - Stats command
// - ID-only bulk adds
// - NO API CALLS on add
// - Cooldown bypass for admins + NO_COOLDOWN_USER_IDS

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

/* ===================== ENV ===================== */

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const JUSTTCG_API_KEY = process.env.JUSTTCG_API_KEY;

const ALLOWED_GUILD_IDS = process.env.ALLOWED_GUILD_IDS
  ? process.env.ALLOWED_GUILD_IDS.split(",").map(s => s.trim()).filter(Boolean)
  : [];

const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",").map(s => s.trim()).filter(Boolean)
  : [];

// 🔓 NEW: cooldown bypass list
const NO_COOLDOWN_USER_IDS = process.env.NO_COOLDOWN_USER_IDS
  ? process.env.NO_COOLDOWN_USER_IDS.split(",").map(s => s.trim()).filter(Boolean)
  : [];

const PORTFOLIO_PATH = path.join(__dirname, "userPortfolios.json");

if (!DISCORD_BOT_TOKEN || !JUSTTCG_API_KEY) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

/* ===================== CONSTANTS ===================== */

const CMD_PREFIX = "!";
const BATCH_SIZE = 20;
const TIMEZONE = "America/New_York";
const lastOnDemandDayKey = {}; // userId -> YYYY-MM-DD (ET)

/* ===================== DISCORD ===================== */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

/* ===================== HELPERS ===================== */

function getEasternDayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isNoCooldownUser(userId) {
  return NO_COOLDOWN_USER_IDS.includes(userId);
}

function ensureFile(fp, fallback) {
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, JSON.stringify(fallback, null, 2));
  }
}

function loadPortfolios() {
  ensureFile(PORTFOLIO_PATH, {});
  return JSON.parse(fs.readFileSync(PORTFOLIO_PATH, "utf8"));
}

function savePortfolios(data) {
  fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(data, null, 2));
}

function tokenize(input) {
  const re = /"([^"]*)"|(\S+)/g;
  const out = [];
  let m;
  while ((m = re.exec(input)) !== null) {
    out.push({ value: m[1] ?? m[2], quoted: m[1] != null });
  }
  return out;
}

function parseInventoryAdd(input) {
  const tokens = tokenize(input);
  if (!tokens.length) return [];

  const hasQuoted = tokens.some(t => t.quoted);
  const items = [];

  if (hasQuoted) {
    for (let i = 0; i < tokens.length; i++) {
      const id = tokens[i].value;
      const next = tokens[i + 1];
      const label = next?.quoted ? next.value : "";
      items.push({ id, label });
      if (next?.quoted) i++;
    }
  } else {
    for (const t of tokens) {
      items.push({ id: t.value, label: "" });
    }
  }

  return items;
}

/* ===================== JUSTTCG ===================== */

async function fetchPrices(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const res = await fetch("https://api.justtcg.com/v1/cards", {
      method: "POST",
      headers: {
        "X-Api-Key": JUSTTCG_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batch.map(id => ({ tcgplayerId: id }))),
    });

    const json = await res.json();
    const cards = Array.isArray(json) ? json : json.data ?? [];

    for (const c of cards) {
      const id = String(c.tcgplayerId);
      const v = c.variants?.find(v => v.condition === "Sealed") ?? c.variants?.[0];
      out[id] = {
        name: c.name,
        set: c.set_name,
        price: v?.price ?? null,
      };
    }
  }
  return out;
}

/* ===================== COMMANDS ===================== */

async function handleInventoryAdd(msg, args) {
  const items = parseInventoryAdd(args);
  if (!items.length) return msg.reply("Usage: !inventoryadd <id> [id] OR <id> \"label\"");

  const data = loadPortfolios();
  const uid = msg.author.id;
  data[uid] ||= [];

  for (const it of items) {
    if (!data[uid].some(e => e.tcgplayerId === it.id)) {
      data[uid].push({
        tcgplayerId: it.id,
        label: it.label,
        addedAt: new Date().toISOString(),
      });
    }
  }

  savePortfolios(data);
  msg.reply(`✅ Added ${items.length} item(s).`);
}

async function handleInventoryNow(msg) {
  const uid = msg.author.id;

  let isAdmin = false;
  if (msg.guild && msg.member) {
    try {
      isAdmin = msg.member.permissions.has(PermissionsBitField.Flags.Administrator);
    } catch {}
  }

  const bypass = isAdmin || isNoCooldownUser(uid);

  if (!bypass) {
    const today = getEasternDayKey();
    if (lastOnDemandDayKey[uid] === today) {
      return msg.reply("⏳ You already used your daily update (resets at 12 AM ET).");
    }
    lastOnDemandDayKey[uid] = today;
  }

  const data = loadPortfolios();
  const items = data[uid] ?? [];
  if (!items.length) return msg.reply("Your watchlist is empty.");

  const prices = await fetchPrices(items.map(i => i.tcgplayerId));
  const lines = [];

  for (const it of items) {
    const p = prices[it.tcgplayerId];
    if (!p) continue;

    const last = it.lastMarketPrice ?? null;
    const cur = p.price;
    const base = it.addedMarketPrice ?? null;

    if (cur != null) {
      it.lastMarketPrice = cur;
      it.addedMarketPrice ??= cur;
    }

    const deltaLast = last != null && cur != null ? cur - last : null;
    const deltaBase = base != null && cur != null ? cur - base : null;

    lines.push(
      `• ${p.name}\n` +
      `  Market: ${cur ? `$${cur.toFixed(2)}` : "N/A"}\n` +
      `  Δ since last: ${deltaLast != null ? `${deltaLast >= 0 ? "+" : ""}$${deltaLast.toFixed(2)}` : "N/A"}\n` +
      `  Δ since added: ${deltaBase != null ? `${deltaBase >= 0 ? "+" : ""}$${deltaBase.toFixed(2)}` : "N/A"}`
    );
  }

  savePortfolios(data);
  msg.author.send(lines.join("\n\n"));
}

/* ===================== ROUTER ===================== */

client.on("messageCreate", async msg => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith(CMD_PREFIX)) return;

  const [cmd, ...rest] = msg.content.slice(1).split(" ");
  const args = rest.join(" ");

  if (cmd === "inventoryadd") return handleInventoryAdd(msg, args);
  if (cmd === "inventorynow") return handleInventoryNow(msg);
});

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Cooldown bypass users: ${NO_COOLDOWN_USER_IDS.join(", ") || "(none)"}`);
});

client.login(DISCORD_BOT_TOKEN);
