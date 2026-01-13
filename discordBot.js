// discordBot.js (REFactor, single-file, fully functional)
// Goals:
// - Keep ALL existing behavior/features from your uploaded file
// - Remove duplication (cron + inventorynow share the same pipeline)
// - Reduce API calls in cron by fetching all unique IDs once
// - Add back the missing-but-requested quality-of-life:
//   - !donate + quiet DM footer
//   - !inventoryremove supports multiple IDs
//   - !inventoryremoveall CONFIRM
//   - NO_COOLDOWN_USER_IDS bypass works (header said it; code didn’t fully honor it)

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
  ? process.env.ALLOWED_GUILD_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const NO_COOLDOWN_USER_IDS = process.env.NO_COOLDOWN_USER_IDS
  ? process.env.NO_COOLDOWN_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const PAYPAL_DONATE_URL =
  process.env.PAYPAL_DONATE_URL ||
  "https://www.paypal.com/donate/?hosted_button_id=WW7W5WR7UDDPU";

const DEBUG_JUSTTCG = process.env.DEBUG_JUSTTCG === "1";

const PORTFOLIO_PATH = process.env.PORTFOLIO_PATH
  ? path.resolve(process.env.PORTFOLIO_PATH)
  : path.join(__dirname, "userPortfolios.json");

// Optional alert config (kept from your file; enabled only when PRICE_ALERT_PCT > 0)
const PRICE_ALERT_PCT = Number(process.env.PRICE_ALERT_PCT ?? 0);
const ALERT_COOLDOWN_HOURS = Number(process.env.ALERT_COOLDOWN_HOURS ?? 12);

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

/* ===================== CONSTANTS ===================== */

const CMD_PREFIX = "!";
const BATCH_SIZE = 20;
const ON_DEMAND_TZ = "America/New_York";

// Your uploaded file used 0 16 * * *
const DAILY_CRON_SCHEDULE = process.env.DAILY_CRON_SCHEDULE || "0 16 * * *";

// once/day key reset at midnight ET
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

/* ===================== ACCESS CONTROL ===================== */

function isGuildAllowed(guildId) {
  if (!guildId) return false;
  if (ALLOWED_GUILD_IDS.length === 0) return true;
  return ALLOWED_GUILD_IDS.includes(guildId);
}

function isUserOverrideAllowed(userId) {
  if (!userId) return false;
  return ALLOWED_USER_IDS.includes(userId);
}

function isNoCooldownUser(userId) {
  if (!userId) return false;
  return NO_COOLDOWN_USER_IDS.includes(userId);
}

async function isDmUserAllowedBySharedGuild(userId) {
  if (ALLOWED_GUILD_IDS.length === 0) return true;

  try {
    for (const gid of ALLOWED_GUILD_IDS) {
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;
      try {
        await guild.members.fetch(userId);
        return true;
      } catch (_) {}
    }
    return false;
  } catch (err) {
    console.error("DM shared-guild check failed:", err);
    return false;
  }
}

async function isMessageAllowed(message) {
  const userId = message.author?.id;

  if (ALLOWED_GUILD_IDS.length === 0 && ALLOWED_USER_IDS.length === 0) return true;
  if (isUserOverrideAllowed(userId)) return true;

  if (message.guild) return isGuildAllowed(message.guild.id);
  return await isDmUserAllowedBySharedGuild(userId);
}

/* ===================== STORAGE ===================== */

function ensureDirForFile(fp) {
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function toIsoIfValid(d) {
  if (!d) return undefined;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return undefined;
  return dt.toISOString();
}

function numOrUndef(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function normalizePortfolios(portfolios) {
  const out = {};
  for (const [userId, items] of Object.entries(portfolios || {})) {
    const map = new Map();
    for (const raw of items || []) {
      const tcgplayerId = String(raw?.tcgplayerId ?? raw?.id ?? "").trim();
      if (!tcgplayerId) continue;

      const label = raw?.label != null ? String(raw.label).trim() : "";

      const normalized = {
        tcgplayerId,
        label,
        addedAt: toIsoIfValid(raw?.addedAt),
        addedMarketPrice: numOrUndef(raw?.addedMarketPrice),
        lastCheckedAt: toIsoIfValid(raw?.lastCheckedAt),
        lastMarketPrice: numOrUndef(raw?.lastMarketPrice),
        lastAlertedAt: toIsoIfValid(raw?.lastAlertedAt),
      };

      const existing = map.get(tcgplayerId);
      if (!existing) {
        map.set(tcgplayerId, normalized);
      } else {
        map.set(tcgplayerId, {
          ...existing,
          label: normalized.label || existing.label,
          addedAt: existing.addedAt || normalized.addedAt,
          addedMarketPrice: existing.addedMarketPrice ?? normalized.addedMarketPrice,
          lastCheckedAt: normalized.lastCheckedAt || existing.lastCheckedAt,
          lastMarketPrice: normalized.lastMarketPrice ?? existing.lastMarketPrice,
          lastAlertedAt: normalized.lastAlertedAt || existing.lastAlertedAt,
        });
      }
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

function upsertUserItems(userId, updaterFn) {
  const portfolios = loadPortfolios();
  const items = portfolios[userId] || [];
  const next = updaterFn(items) || items;
  portfolios[userId] = next;
  savePortfolios(portfolios);
  return next;
}

/* ===================== PARSING ===================== */

function tokenizeWithQuotes(input) {
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(input || "")) !== null) {
    if (m[1] != null) tokens.push({ value: m[1], quoted: true });
    else tokens.push({ value: m[2], quoted: false });
  }
  return tokens;
}

function parseAddItems(input) {
  const rawTokens = tokenizeWithQuotes(input || "");
  const tokens = rawTokens
    .map((t) => ({
      value: String(t.value || "").trim().replace(/,+$/g, ""),
      quoted: t.quoted,
    }))
    .filter((t) => t.value.length > 0);

  if (!tokens.length) return [];

  const hasQuoted = tokens.some((t) => t.quoted);

  if (hasQuoted) {
    const items = [];
    for (let i = 0; i < tokens.length; i++) {
      const idTok = tokens[i];
      const id = String(idTok.value).trim();
      if (!id) continue;

      const nextTok = tokens[i + 1];
      const label = nextTok && nextTok.quoted ? String(nextTok.value).trim() : "";
      items.push({ tcgplayerId: id, label });
      if (nextTok && nextTok.quoted) i += 1;
    }
    return items;
  }

  return tokens.map((t) => ({ tcgplayerId: String(t.value).trim(), label: "" }));
}

// supports spaces and commas
function parseRemoveIds(input) {
  const raw = String(input || "").trim();
  if (!raw) return [];
  return raw
    .split(/[\s,]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ===================== TIME HELPERS ===================== */

function getEasternDayKey(date = new Date()) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: ON_DEMAND_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(date); // YYYY-MM-DD
}

/* ===================== DM HELPERS ===================== */

function donateFooter() {
  if (!PAYPAL_DONATE_URL) return "";
  return `\n\n—\nSupport the project (optional): ${PAYPAL_DONATE_URL}`;
}

async function safeSendDM(user, text) {
  const MAX = 1900;
  const footer = donateFooter();

  const chunks = [];
  let remaining = String(text || "") + footer;

  while (remaining.length > MAX) {
    let idx = remaining.lastIndexOf("\n\n", MAX);
    if (idx < 800) idx = remaining.lastIndexOf("\n", MAX);
    if (idx < 800) idx = MAX;

    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  if (remaining.length) chunks.push(remaining);

  for (const c of chunks) {
    await user.send(c);
  }
}

async function sendDMOrReply(message, dmText, channelConfirmText) {
  try {
    await safeSendDM(message.author, dmText);
    if (message.guild && channelConfirmText) await message.reply(channelConfirmText);
  } catch (err) {
    // Fallback: post in channel if DM fails
    if (message.guild) {
      await message.reply(
        "I couldn't DM you — check your DM privacy settings."
      );
    } else {
      // In DM context, just throw upward
      throw err;
    }
  }
}

/* ===================== PRICE MATH ===================== */

function fmtMoney(n) {
  return `$${Number(n).toFixed(2)}`;
}

function fmtSignedMoney(delta) {
  const d = Number(delta);
  const sign = d >= 0 ? "+" : "";
  return `${sign}${fmtMoney(d)}`;
}

function fmtSignedPct(pct) {
  const p = Number(pct);
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(2)}%`;
}

function calcDelta(cur, prev) {
  if (cur == null || prev == null) return null;
  const c = Number(cur);
  const p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p)) return null;

  const delta = c - p;
  let pct = null;
  if (p !== 0) pct = (delta / p) * 100;
  return { delta, pct };
}

/* ===================== JUSTTCG ===================== */

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
      const rawId =
        card?.tcgplayerId ?? card?.tcgplayer_id ?? card?.tcgPlayerId ?? null;
      if (!rawId) continue;

      const id = String(rawId);
      const variants = Array.isArray(card?.variants) ? card.variants : [];
      const chosen =
        variants.find((v) => v && v.condition === "Sealed") || variants[0];

      const price = chosen?.price != null ? Number(chosen.price) : null;
      const setName = card?.set_name || card?.setName || null;
      const name = card?.name || null;

      if (!Number.isFinite(price) || price <= 0 || price > 10000) {
        idToPrice[id] = { marketPrice: null, setName, name };
      } else {
        idToPrice[id] = { marketPrice: price, setName, name };
      }
    }
  }

  return idToPrice;
}

/* ===================== PORTFOLIO PRICE PIPELINE ===================== */

function persistPricesForUser(userId, items, prices, checkedIso, options = {}) {
  const { allowAlertUpdate = false } = options;

  upsertUserItems(userId, (current) => {
    const byId = new Map((current || []).map((it) => [it.tcgplayerId, it]));

    for (const item of items || []) {
      const p = prices[item.tcgplayerId] || {};
      const cur = p.marketPrice != null ? Number(p.marketPrice) : null;

      const existing = byId.get(item.tcgplayerId) || item;

      existing.lastCheckedAt = checkedIso;

      if (cur != null) {
        existing.lastMarketPrice = cur;

        // lock baseline at first successful price fetch
        if (
          existing.addedMarketPrice == null ||
          !Number.isFinite(Number(existing.addedMarketPrice))
        ) {
          existing.addedMarketPrice = cur;
          existing.addedAt = existing.addedAt || checkedIso;
        }
      }

      if (allowAlertUpdate && item.__shouldAlert) {
        existing.lastAlertedAt = checkedIso;
      }

      delete existing.__shouldAlert;
      byId.set(item.tcgplayerId, existing);
    }

    return Array.from(byId.values());
  });
}

function formatPriceLine(item, prices) {
  const p = prices[item.tcgplayerId] || {};
  const name = p.name || item.label || "(unknown)";
  const setName = p.setName ? ` [${p.setName}]` : "";

  const cur = p.marketPrice != null ? Number(p.marketPrice) : null;
  const last = Number.isFinite(Number(item.lastMarketPrice))
    ? Number(item.lastMarketPrice)
    : null;
  const added = Number.isFinite(Number(item.addedMarketPrice))
    ? Number(item.addedMarketPrice)
    : null;

  const priceText = cur != null ? fmtMoney(cur) : "N/A";

  const d1 = calcDelta(cur, last);
  const sinceLastText =
    d1 && d1.pct != null
      ? `Δ since last: ${fmtSignedMoney(d1.delta)} (${fmtSignedPct(d1.pct)})`
      : d1
      ? `Δ since last: ${fmtSignedMoney(d1.delta)} (N/A%)`
      : "Δ since last: N/A";

  const d0 = calcDelta(cur, added);
  const sinceAddedText =
    d0 && d0.pct != null
      ? `Δ since added: ${fmtSignedMoney(d0.delta)} (${fmtSignedPct(d0.pct)})`
      : d0
      ? `Δ since added: ${fmtSignedMoney(d0.delta)} (N/A%)`
      : "Δ since added: N/A";

  return `• ${name}${setName}\n  ID: ${item.tcgplayerId} – ${
    item.label || "(no label)"
  } – Market: ${priceText}\n  ${sinceLastText}\n  ${sinceAddedText}`;
}

function buildPriceLines(items, prices) {
  return (items || []).map((it) => formatPriceLine(it, prices));
}

async function runPriceCheckForUser(userId, reasonLabel, sharedPricesMap = null) {
  const portfolios = loadPortfolios();
  const list = portfolios[userId] || [];
  if (!list.length) return { ok: false, reason: "empty" };

  const ids = list.map((i) => i.tcgplayerId);

  const prices = sharedPricesMap
    ? Object.fromEntries(ids.map((id) => [id, sharedPricesMap[id] || {}]))
    : await fetchCardPrices(ids);

  const checkedIso = new Date().toISOString();
  const lines = buildPriceLines(list, prices);

  persistPricesForUser(userId, list, prices, checkedIso);

  return {
    ok: true,
    text: `${reasonLabel}\n\n${lines.join("\n\n")}`,
  };
}

/* ===================== COMMAND HANDLERS ===================== */

async function handleDonate(message) {
  const msg =
    `Support the project (optional):\n${PAYPAL_DONATE_URL}\n\n` +
    `Thank you for using the bot!`;
  return sendDMOrReply(message, msg, "✅ I DM’d you the donation link.");
}

async function handleInventoryAdd(message, argsText) {
  const itemsToAdd = parseAddItems(argsText);

  if (!itemsToAdd.length) {
    return message.reply(
      `Usage:\n` +
        `• Add with labels: !inventoryadd <id> "Label" [<id> "Label" ...]\n` +
        `• Fast add (IDs only): !inventoryadd <id> <id> <id>\n` +
        `Examples:\n` +
        `!inventoryadd 543843 "Booster Box" 123456 "Umbreon V Alt Art"\n` +
        `!inventoryadd 123456 123457 123458`
    );
  }

  const userId = message.author.id;
  const nowIso = new Date().toISOString();

  // no API calls here
  upsertUserItems(userId, (current) => {
    const map = new Map((current || []).map((it) => [it.tcgplayerId, it]));
    for (const p of itemsToAdd) {
      const existing = map.get(p.tcgplayerId);
      const nextLabel = p.label ? p.label : existing?.label || "";

      map.set(p.tcgplayerId, {
        ...(existing || {}),
        tcgplayerId: p.tcgplayerId,
        label: nextLabel,
        addedAt: (existing && existing.addedAt) || nowIso,
      });
    }
    return Array.from(map.values());
  });

  return message.reply(
    `✅ Added/updated ${itemsToAdd.length} item(s). Baseline price will populate after your next daily update or !inventorynow.`
  );
}

async function handleInventoryList(message) {
  const portfolios = loadPortfolios();
  const userId = message.author.id;
  const items = portfolios[userId] || [];

  if (!items.length)
    return message.reply("Your watchlist is empty. Use `!inventoryadd` first.");

  const lines = items
    .slice()
    .sort((a, b) => a.tcgplayerId.localeCompare(b.tcgplayerId))
    .map((it) => {
      const added = Number.isFinite(Number(it.addedMarketPrice))
        ? fmtMoney(Number(it.addedMarketPrice))
        : "N/A";
      const label = it.label && it.label.trim().length ? it.label : "(no label)";
      return `• ${label} — ID: ${it.tcgplayerId} — Baseline: ${added}`;
    });

  return sendDMOrReply(
    message,
    `📦 Your watchlist:\n\n${lines.join("\n")}`,
    "✅ I DM’d you your watchlist."
  );
}

async function handleInventoryRemove(message, argsText) {
  const ids = parseRemoveIds(argsText);

  if (!ids.length) {
    return message.reply(
      `Usage:\n` +
        `• !inventoryremove <id>\n` +
        `• !inventoryremove <id> <id> <id>\n` +
        `• !inventoryremove <id,id,id>\n` +
        `Example: !inventoryremove 543843 123456 777888`
    );
  }

  const userId = message.author.id;
  const portfolios = loadPortfolios();
  const items = portfolios[userId] || [];

  if (!items.length) {
    return message.reply("Your watchlist is empty. Use `!inventoryadd` first.");
  }

  const idSet = new Set(ids.map((x) => String(x).trim()));
  const before = items.length;
  const remaining = items.filter((it) => !idSet.has(it.tcgplayerId));
  const removedCount = before - remaining.length;

  portfolios[userId] = remaining;
  savePortfolios(portfolios);

  if (removedCount === 0) {
    return message.reply(`⚠️ None of those IDs were in your watchlist.`);
  }

  const existingIds = new Set(items.map((it) => it.tcgplayerId));
  const removedIds = ids.filter((id) => existingIds.has(String(id).trim()));
  const notFoundIds = ids.filter((id) => !existingIds.has(String(id).trim()));

  let reply = `🗑️ Removed ${removedCount} item(s).`;
  if (removedIds.length) reply += `\nRemoved: ${removedIds.join(", ")}`;
  if (notFoundIds.length) reply += `\nNot found: ${notFoundIds.join(", ")}`;

  return message.reply(reply);
}

async function handleInventoryRemoveAll(message, argsText) {
  const confirm = String(argsText || "").trim().toUpperCase();
  if (confirm !== "CONFIRM") {
    return message.reply(
      `⚠️ This will remove *everything* from your watchlist.\n` +
        `To proceed, type:\n` +
        `**!inventoryremoveall CONFIRM**`
    );
  }

  const userId = message.author.id;
  const portfolios = loadPortfolios();
  const count = (portfolios[userId] || []).length;

  portfolios[userId] = [];
  savePortfolios(portfolios);

  return message.reply(`✅ Removed all items (${count}) from your watchlist.`);
}

async function handleInventoryNow(message) {
  const userId = message.author.id;

  // admin bypass (guild admins only)
  let isAdmin = false;
  if (message.guild && message.member) {
    try {
      isAdmin = message.member.permissions.has(
        PermissionsBitField.Flags.Administrator
      );
    } catch (_) {
      isAdmin = false;
    }
  }

  // bypass also supports NO_COOLDOWN_USER_IDS
  const bypass = isAdmin || isNoCooldownUser(userId);

  if (!bypass) {
    const todayKey = getEasternDayKey(new Date());
    const lastKey = lastOnDemandDayKey[userId] || null;

    if (lastKey === todayKey) {
      return message.reply(
        `⏳ You already used your on-demand update for today (resets at 12:00 AM Eastern).`
      );
    }
    lastOnDemandDayKey[userId] = todayKey;
  }

  const result = await runPriceCheckForUser(
    userId,
    "⚡ On-demand price check:"
  );

  if (!result.ok && result.reason === "empty") {
    return message.reply("Your watchlist is empty. Use `!inventoryadd` first.");
  }

  return sendDMOrReply(
    message,
    result.text,
    "✅ Sent you a DM with your on-demand prices."
  );
}

async function handleInventoryStats(message) {
  const userId = message.author.id;
  const portfolios = loadPortfolios();
  const list = portfolios[userId] || [];
  if (!list.length) return message.reply("Your watchlist is empty. Use `!inventoryadd` first.");

  const ids = list.map((i) => i.tcgplayerId);
  const prices = await fetchCardPrices(ids);
  const checkedIso = new Date().toISOString();

  const rows = list.map((item) => {
    const p = prices[item.tcgplayerId] || {};
    const cur = p.marketPrice != null ? Number(p.marketPrice) : null;
    const base = Number.isFinite(Number(item.addedMarketPrice))
      ? Number(item.addedMarketPrice)
      : null;

    const d0 = calcDelta(cur, base);
    const pct0 = d0 && d0.pct != null ? d0.pct : null;

    return {
      id: item.tcgplayerId,
      label: item.label || "(no label)",
      name: p.name || item.label || "(unknown)",
      setName: p.setName || null,
      cur,
      base,
      deltaSinceAdded: d0 ? d0.delta : null,
      pctSinceAdded: pct0,
    };
  });

  const priced = rows.filter((r) => r.cur != null);
  const withBase = rows.filter((r) => r.cur != null && r.base != null);

  const totalMarket = priced.reduce((sum, r) => sum + Number(r.cur), 0);
  const totalBaseline = withBase.reduce((sum, r) => sum + Number(r.base), 0);
  const totalDelta = withBase.reduce((sum, r) => sum + Number(r.deltaSinceAdded), 0);

  const ranked = withBase
    .filter((r) => r.pctSinceAdded != null)
    .slice()
    .sort((a, b) => b.pctSinceAdded - a.pctSinceAdded);

  const topWinners = ranked.slice(0, 3);
  const topLosers = ranked.slice(-3).reverse();

  const lines = [];
  lines.push(`📊 Inventory Stats`);
  lines.push(`As of: ${checkedIso}`);
  lines.push("");
  lines.push(`Tracked items: ${rows.length}`);
  lines.push(`Priced items: ${priced.length}`);
  lines.push(`Items with baseline: ${withBase.length}`);
  lines.push("");
  lines.push(`Total Market (priced): ${fmtMoney(totalMarket)}`);

  if (withBase.length) {
    lines.push(`Total Baseline: ${fmtMoney(totalBaseline)}`);
    const pct = totalBaseline !== 0 ? (totalDelta / totalBaseline) * 100 : null;
    const deltaText = `${fmtSignedMoney(totalDelta)} (${pct != null ? fmtSignedPct(pct) : "N/A%"})`;
    lines.push(`Net Change vs Added: ${deltaText}`);
  } else {
    lines.push(`Net Change vs Added: N/A (no baselines yet)`);
  }

  if (topWinners.length) {
    lines.push("");
    lines.push(`🏆 Top Winners (since added)`);
    for (const r of topWinners) {
      const name = `${r.name}${r.setName ? ` [${r.setName}]` : ""}`;
      const dText =
        r.deltaSinceAdded != null && r.pctSinceAdded != null
          ? `${fmtSignedMoney(r.deltaSinceAdded)} (${fmtSignedPct(r.pctSinceAdded)})`
          : "N/A";
      lines.push(`• ${name} — ${dText}`);
    }
  }

  if (topLosers.length) {
    lines.push("");
    lines.push(`📉 Top Losers (since added)`);
    for (const r of topLosers) {
      const name = `${r.name}${r.setName ? ` [${r.setName}]` : ""}`;
      const dText =
        r.deltaSinceAdded != null && r.pctSinceAdded != null
          ? `${fmtSignedMoney(r.deltaSinceAdded)} (${fmtSignedPct(r.pctSinceAdded)})`
          : "N/A";
      lines.push(`• ${name} — ${dText}`);
    }
  }

  // Persist baselines/last prices so deltas stay consistent after stats too
  persistPricesForUser(userId, list, prices, checkedIso);

  return sendDMOrReply(message, lines.join("\n"), "✅ I DM’d you your stats.");
}

/* ===================== DAILY CRON ===================== */

cron.schedule(DAILY_CRON_SCHEDULE, async () => {
  console.log("[Cron] Daily portfolio price DM starting...");

  const portfolios = loadPortfolios();
  const entries = Object.entries(portfolios);
  if (!entries.length) return;

  // Collect all IDs once -> single API pass
  const allIds = Array.from(
    new Set(
      entries.flatMap(([, items]) => (items || []).map((it) => it.tcgplayerId)).filter(Boolean)
    )
  );

  const prices = await fetchCardPrices(allIds);
  const checkedIso = new Date().toISOString();

  const alertCooldownMs = ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;

  for (const [userId, items] of entries) {
    if (!items || !items.length) continue;

    // Optional alert marking (kept exactly in spirit of your original)
    if (PRICE_ALERT_PCT > 0) {
      for (const item of items) {
        const p = prices[item.tcgplayerId] || {};
        const cur = p.marketPrice != null ? Number(p.marketPrice) : null;
        const last = Number.isFinite(Number(item.lastMarketPrice))
          ? Number(item.lastMarketPrice)
          : null;

        const d1 = calcDelta(cur, last);
        const lastAlertedAt = item.lastAlertedAt
          ? new Date(item.lastAlertedAt).getTime()
          : 0;
        const canAlert = Date.now() - lastAlertedAt >= alertCooldownMs;

        if (d1 && d1.pct != null && Math.abs(d1.pct) >= PRICE_ALERT_PCT && canAlert) {
          item.__shouldAlert = true;
        }
      }
    }

    const userPricesView = prices; // already contains all needed ids
    const lines = buildPriceLines(items, userPricesView);

    // Persist last/baseline values
    persistPricesForUser(userId, items, userPricesView, checkedIso, {
      allowAlertUpdate: PRICE_ALERT_PCT > 0,
    });

    try {
      const user = await client.users.fetch(userId);
      await safeSendDM(user, `📅 Daily price update:\n\n${lines.join("\n\n")}`);
    } catch (err) {
      console.error(`Failed daily DM to ${userId}:`, err);
    }
  }
});

/* ===================== MESSAGE ROUTER ===================== */

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(CMD_PREFIX)) return;

  if (!(await isMessageAllowed(message))) {
    try {
      await message.reply("This bot is restricted; you are not authorized.");
    } catch (_) {}
    return;
  }

  const content = message.content.slice(1).trim();
  const [cmdRaw, ...rest] = content.split(" ");
  const cmd = (cmdRaw || "").toLowerCase();
  const argsText = rest.join(" ").trim();

  try {
    if (cmd === "donate") return await handleDonate(message);

    if (cmd === "inventoryadd") return await handleInventoryAdd(message, argsText);
    if (cmd === "inventorylist") return await handleInventoryList(message);
    if (cmd === "inventoryremove") return await handleInventoryRemove(message, argsText);
    if (cmd === "inventoryremoveall") return await handleInventoryRemoveAll(message, argsText);
    if (cmd === "inventorynow") return await handleInventoryNow(message);
    if (cmd === "inventorystats") return await handleInventoryStats(message);
  } catch (err) {
    console.error("Command error:", err);
    try {
      await message.reply("Something went wrong. Try again later.");
    } catch (_) {}
  }
});

client.once(Events.ClientReady, () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  console.log(`Portfolio path: ${PORTFOLIO_PATH}`);
  console.log(`ALLOWED_GUILD_IDS=${ALLOWED_GUILD_IDS.join(",") || "(none)"}`);
  console.log(`ALLOWED_USER_IDS=${ALLOWED_USER_IDS.join(",") || "(none)"}`);
  console.log(`NO_COOLDOWN_USER_IDS=${NO_COOLDOWN_USER_IDS.join(",") || "(none)"}`);
  console.log(`DAILY_CRON_SCHEDULE=${DAILY_CRON_SCHEDULE}`);
  console.log(`PAYPAL_DONATE_URL=${PAYPAL_DONATE_URL || "(none)"}`);
});

client.login(DISCORD_BOT_TOKEN);
