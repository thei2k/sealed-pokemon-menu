// discordBot.js (FULL OVERWRITE)
// Access model:
// - In guild channels: only allowed guilds in ALLOWED_GUILD_IDS (when set)
// - In DMs: allowed if user shares ANY allowed guild with the bot (when ALLOWED_GUILD_IDS set)
// - Optional: ALLOWED_USER_IDS always allowed (override)
// If no allowlists are set, bot is open everywhere.

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

// ---- ENV ----
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const JUSTTCG_API_KEY = process.env.JUSTTCG_API_KEY;

const ALLOWED_GUILD_IDS = process.env.ALLOWED_GUILD_IDS
  ? process.env.ALLOWED_GUILD_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const DEBUG_JUSTTCG = process.env.DEBUG_JUSTTCG === "1";

const PORTFOLIO_PATH = process.env.PORTFOLIO_PATH
  ? path.resolve(process.env.PORTFOLIO_PATH)
  : path.join(__dirname, "userPortfolios.json");

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
const lastOnDemandRun = {}; // userId -> timestamp

// ---- DISCORD ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, // needed to see guild membership list for shared-guild DM access
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// ---- ACCESS RULES ----
function isGuildAllowed(guildId) {
  if (!guildId) return false;
  if (ALLOWED_GUILD_IDS.length === 0) return true; // no restriction
  return ALLOWED_GUILD_IDS.includes(guildId);
}

function isUserOverrideAllowed(userId) {
  if (!userId) return false;
  return ALLOWED_USER_IDS.includes(userId);
}

// DM access rule: user shares at least one allowed guild with the bot.
// This does NOT require privileged intents; we only check the bot's cached guild list.
async function isDmUserAllowedBySharedGuild(userId) {
  if (ALLOWED_GUILD_IDS.length === 0) return true; // no restriction => DMs allowed
  try {
    // For each allowed guild the bot is in, try to fetch this member.
    // If fetch succeeds in ANY allowed guild, user is allowed in DM.
    for (const gid of ALLOWED_GUILD_IDS) {
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue; // bot not in that guild (or cache not ready)
      try {
        await guild.members.fetch(userId);
        return true;
      } catch (_) {
        // not a member (or permissions issue) -> keep checking
      }
    }
    return false;
  } catch (err) {
    console.error("DM shared-guild check failed:", err);
    return false;
  }
}

async function isMessageAllowed(message) {
  const userId = message.author?.id;

  // If no restrictions configured at all, allow everything.
  if (ALLOWED_GUILD_IDS.length === 0 && ALLOWED_USER_IDS.length === 0) return true;

  // Always allow explicitly allowed users (works in DM and guild).
  if (isUserOverrideAllowed(userId)) return true;

  // In a guild: allow if guild is allowlisted.
  if (message.guild) return isGuildAllowed(message.guild.id);

  // In a DM: allow if user shares any allowed guild with the bot.
  return await isDmUserAllowedBySharedGuild(userId);
}

// ---- STORAGE ----
function ensureDirForFile(fp) {
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizePortfolios(portfolios) {
  const out = {};
  for (const [userId, items] of Object.entries(portfolios || {})) {
    const map = new Map();
    for (const raw of items || []) {
      const tcgplayerId = String(raw?.tcgplayerId ?? raw?.id ?? "").trim();
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

// ---- PARSING HELPERS ----
// Parses: !inventoryadd 543843 "Booster Box" 543844 "Booster Bundle"
function parseAddPairs(input) {
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(input)) !== null) tokens.push(m[1] != null ? m[1] : m[2]);

  const pairs = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const id = (tokens[i] || "").trim();
    const label = (tokens[i + 1] || "").trim();
    if (!id) continue;
    pairs.push({ tcgplayerId: id, label: label || "" });
  }
  return pairs;
}

// ---- JUSTTCG ----
async function fetchCardPrices(tcgplayerIds) {
  const uniqueIds = Array.from(
    new Set((tcgplayerIds || []).map((id) => String(id).trim()).filter(Boolean))
  );
  const idToPrice = {};
  if (!uniqueIds.length) return idToPrice;

  const lookups = uniqueIds.map((id) => ({ tcgplayerId: id }));

  for (let i = 0; i < lookups.length; i += BATCH_SIZE) {
    const batch = lookups.slice(i, i + BATCH_SIZE);

    let res;
    try {
      res = await fetch("https://api.justtcg.com/v1/cards", {
        method: "POST",
        headers: {
          "X-Api-Key": JUSTTCG_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
      });
    } catch (err) {
      console.error("JustTCG REQUEST ERROR:", err);
      continue;
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error(`JustTCG FAILED: ${res.status} ${res.statusText} ${txt}`);
      continue;
    }

    let result;
    try {
      result = await res.json();
    } catch (err) {
      const txt = await res.text().catch(() => "");
      console.error("JustTCG JSON PARSE ERROR:", err, "RAW:", txt);
      continue;
    }

    const cards = Array.isArray(result) ? result : result?.data || [];

    if (DEBUG_JUSTTCG) {
      console.log(
        `[JustTCG] batch=${Math.floor(i / BATCH_SIZE) + 1} requested=${batch.length} returned=${cards.length}`
      );
    }

    for (const card of cards) {
      const rawId = card?.tcgplayerId ?? card?.tcgplayer_id ?? card?.tcgPlayerId ?? null;
      if (!rawId) continue;

      const id = String(rawId);
      const variants = Array.isArray(card?.variants) ? card.variants : [];
      const chosen = variants.find((v) => v && v.condition === "Sealed") || variants[0];

      const price = chosen?.price != null ? Number(chosen.price) : null;
      if (!Number.isFinite(price) || price <= 0 || price > 10000) {
        idToPrice[id] = { marketPrice: null, setName: card?.set_name || card?.setName || null, name: card?.name || null };
      } else {
        idToPrice[id] = { marketPrice: price, setName: card?.set_name || card?.setName || null, name: card?.name || null };
      }
    }
  }

  return idToPrice;
}

// ---- COMMAND HANDLERS ----
async function handleInventoryAdd(message, argsText) {
  const pairs = parseAddPairs(argsText);
  if (!pairs.length) {
    return message.reply(
      `Usage: !inventoryadd <id> "Label" [<id> "Label" ...]\nExample: !inventoryadd 543843 "Booster Box"`
    );
  }

  const portfolios = loadPortfolios();
  const userId = message.author.id;
  const current = portfolios[userId] || [];

  const map = new Map(current.map((it) => [it.tcgplayerId, it]));
  for (const p of pairs) map.set(p.tcgplayerId, { tcgplayerId: p.tcgplayerId, label: p.label });

  portfolios[userId] = Array.from(map.values());
  savePortfolios(portfolios);

  return message.reply(`✅ Added/updated ${pairs.length} item(s). Use !inventorylist to view.`);
}

async function handleInventoryList(message) {
  const portfolios = loadPortfolios();
  const userId = message.author.id;
  const items = portfolios[userId] || [];

  if (!items.length) return message.reply("Your watchlist is empty. Use `!inventoryadd` first.");

  const lines = items
    .slice()
    .sort((a, b) => a.tcgplayerId.localeCompare(b.tcgplayerId))
    .map((it) => `• ${it.label || "(no label)"} — ID: ${it.tcgplayerId}`);

  // Prefer DM, fallback to channel
  try {
    await message.author.send(`📦 Your watchlist:\n\n${lines.join("\n")}`);
    if (message.guild) await message.reply("✅ I DM’d you your watchlist.");
  } catch (_) {
    await message.reply(`📦 Your watchlist:\n\n${lines.join("\n")}`);
  }
}

async function handleInventoryRemove(message, argsText) {
  const id = String(argsText || "").trim();
  if (!id) return message.reply("Usage: !inventoryremove <id>");

  const portfolios = loadPortfolios();
  const userId = message.author.id;
  const items = portfolios[userId] || [];

  portfolios[userId] = items.filter((it) => it.tcgplayerId !== id);
  savePortfolios(portfolios);

  return message.reply(`🗑️ Removed ID ${id}. Use !inventorylist to confirm.`);
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
  if (!list.length) return message.reply("Your watchlist is empty. Use `!inventoryadd` first.");

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

// ---- DAILY CRON ----
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

// ---- MESSAGE ROUTER ----
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(CMD_PREFIX)) return;

  if (!(await isMessageAllowed(message))) {
    try { await message.reply("This bot is restricted; you are not authorized."); } catch (_) {}
    return;
  }

  const content = message.content.slice(1).trim();
  const [cmdRaw, ...rest] = content.split(" ");
  const cmd = (cmdRaw || "").toLowerCase();
  const argsText = rest.join(" ").trim();

  try {
    if (cmd === "inventoryadd") return await handleInventoryAdd(message, argsText);
    if (cmd === "inventorylist") return await handleInventoryList(message);
    if (cmd === "inventoryremove") return await handleInventoryRemove(message, argsText);
    if (cmd === "inventorynow") return await handleInventoryNow(message);
  } catch (err) {
    console.error("Command error:", err);
    try { await message.reply("Something went wrong. Try again later."); } catch (_) {}
  }
});

client.once(Events.ClientReady, () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  console.log(`Portfolio path: ${PORTFOLIO_PATH}`);
  console.log(`ALLOWED_GUILD_IDS=${ALLOWED_GUILD_IDS.join(",") || "(none)"}`);
  console.log(`ALLOWED_USER_IDS=${ALLOWED_USER_IDS.join(",") || "(none)"}`);
});

client.login(DISCORD_BOT_TOKEN);
