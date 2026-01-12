// discordBot.js (FULL OVERWRITE)
// Access model:
// - In guild channels: only allowed guilds in ALLOWED_GUILD_IDS (when set)
// - In DMs: allowed if user shares ANY allowed guild with the bot (when ALLOWED_GUILD_IDS set)
// - Optional: ALLOWED_USER_IDS always allowed (override)
// If no allowlists are set, bot is open everywhere.
//
// DM output enhancements:
// - Shows Market price
// - Shows change since last check ($ + %)
// - Shows change since added/baseline ($ + %)
//
// Adds: !inventorystats

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

// Optional alert config (not required for your ask, but left ready if you want later)
const PRICE_ALERT_PCT = Number(process.env.PRICE_ALERT_PCT ?? 0); // 0 disables
const ALERT_COOLDOWN_HOURS = Number(process.env.ALERT_COOLDOWN_HOURS ?? 12);

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
async function isDmUserAllowedBySharedGuild(userId) {
  if (ALLOWED_GUILD_IDS.length === 0) return true; // no restriction => DMs allowed
  try {
    for (const gid of ALLOWED_GUILD_IDS) {
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;
      try {
        await guild.members.fetch(userId);
        return true;
      } catch (_) {
        // not a member -> keep checking
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

      // Merge duplicates by tcgplayerId (preserve baselines if they exist)
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

// ---- DM SENDER (splits long messages safely) ----
async function safeSendDM(user, text) {
  const MAX = 1900; // keep below Discord 2000 limit
  const chunks = [];

  let remaining = String(text || "");
  while (remaining.length > MAX) {
    // Try splitting on double newline first
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

// ---- PRICE MATH HELPERS ----
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

// ---- PORTFOLIO UPDATE HELPERS ----
function upsertUserItems(userId, updaterFn) {
  const portfolios = loadPortfolios();
  const items = portfolios[userId] || [];
  const next = updaterFn(items) || items;
  portfolios[userId] = next;
  savePortfolios(portfolios);
  return next;
}

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

        // If baseline missing, lock it now
        if (existing.addedMarketPrice == null || !Number.isFinite(Number(existing.addedMarketPrice))) {
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

function buildPriceLines(items, prices) {
  return (items || []).map((item) => {
    const p = prices[item.tcgplayerId] || {};
    const name = p.name || item.label || "(unknown)";
    const setName = p.setName ? ` [${p.setName}]` : "";

    const cur = p.marketPrice != null ? Number(p.marketPrice) : null;
    const last = Number.isFinite(Number(item.lastMarketPrice)) ? Number(item.lastMarketPrice) : null;
    const added = Number.isFinite(Number(item.addedMarketPrice)) ? Number(item.addedMarketPrice) : null;

    const priceText = cur != null ? fmtMoney(cur) : "N/A";

    // since last check
    let sinceLastText = "Δ since last: N/A";
    const d1 = calcDelta(cur, last);
    if (d1 && d1.pct != null) {
      sinceLastText = `Δ since last: ${fmtSignedMoney(d1.delta)} (${fmtSignedPct(d1.pct)})`;
    } else if (d1) {
      // last was 0 (unlikely), still show dollars
      sinceLastText = `Δ since last: ${fmtSignedMoney(d1.delta)} (N/A%)`;
    }

    // since added baseline
    let sinceAddedText = "Δ since added: N/A";
    const d0 = calcDelta(cur, added);
    if (d0 && d0.pct != null) {
      sinceAddedText = `Δ since added: ${fmtSignedMoney(d0.delta)} (${fmtSignedPct(d0.pct)})`;
    } else if (d0) {
      sinceAddedText = `Δ since added: ${fmtSignedMoney(d0.delta)} (N/A%)`;
    }

    return `• ${name}${setName}\n  ID: ${item.tcgplayerId} – ${item.label || "(no label)"} – Market: ${priceText}\n  ${sinceLastText}\n  ${sinceAddedText}`;
  });
}

// ---- COMMAND HANDLERS ----
async function handleInventoryAdd(message, argsText) {
  const pairs = parseAddPairs(argsText);
  if (!pairs.length) {
    return message.reply(
      `Usage: !inventoryadd <id> "Label" [<id> "Label" ...]\nExample: !inventoryadd 543843 "Booster Box"`
    );
  }

  const userId = message.author.id;
  const nowIso = new Date().toISOString();

  // Upsert items, preserve existing baselines
  upsertUserItems(userId, (current) => {
    const map = new Map((current || []).map((it) => [it.tcgplayerId, it]));
    for (const p of pairs) {
      const existing = map.get(p.tcgplayerId);
      map.set(p.tcgplayerId, {
        ...(existing || {}),
        tcgplayerId: p.tcgplayerId,
        label: p.label,
        addedAt: (existing && existing.addedAt) || nowIso,
      });
    }
    return Array.from(map.values());
  });

  // Try to fetch prices immediately so "since added" baseline is set ASAP
  try {
    const idsToFetch = Array.from(new Set(pairs.map((p) => p.tcgplayerId)));
    const prices = await fetchCardPrices(idsToFetch);

    const portfolios = loadPortfolios();
    const items = portfolios[userId] || [];
    const byId = new Map(items.map((it) => [it.tcgplayerId, it]));

    for (const id of idsToFetch) {
      const it = byId.get(id);
      if (!it) continue;

      const cur = prices[id]?.marketPrice;
      const mp = cur != null ? Number(cur) : null;

      it.lastCheckedAt = nowIso;
      if (mp != null) {
        it.lastMarketPrice = mp;
        if (it.addedMarketPrice == null || !Number.isFinite(Number(it.addedMarketPrice))) {
          it.addedMarketPrice = mp;
          it.addedAt = it.addedAt || nowIso;
        }
      }

      byId.set(id, it);
    }

    portfolios[userId] = Array.from(byId.values());
    savePortfolios(portfolios);
  } catch (err) {
    console.error("Baseline fetch failed on add:", err);
  }

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
    .map((it) => {
      const added = Number.isFinite(Number(it.addedMarketPrice)) ? fmtMoney(Number(it.addedMarketPrice)) : "N/A";
      return `• ${it.label || "(no label)"} — ID: ${it.tcgplayerId} — Baseline: ${added}`;
    });

  try {
    await safeSendDM(message.author, `📦 Your watchlist:\n\n${lines.join("\n")}`);
    if (message.guild) await message.reply("✅ I DM’d you your watchlist.");
  } catch (_) {
    await message.reply(`📦 Your watchlist:\n\n${lines.join("\n")}`);
  }
}

async function handleInventoryRemove(message, argsText) {
  const id = String(argsText || "").trim();
  if (!id) return message.reply("Usage: !inventoryremove <id>");

  const userId = message.author.id;

  const portfolios = loadPortfolios();
  const items = portfolios[userId] || [];
  const before = items.length;

  portfolios[userId] = items.filter((it) => it.tcgplayerId !== id);
  savePortfolios(portfolios);

  const removed = before !== portfolios[userId].length;
  return message.reply(removed ? `🗑️ Removed ID ${id}. Use !inventorylist to confirm.` : `⚠️ ID ${id} was not in your watchlist.`);
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

  const checkedIso = new Date().toISOString();
  const lines = buildPriceLines(list, prices);

  // Persist last/baseline values so the next check shows deltas
  persistPricesForUser(userId, list, prices, checkedIso);

  try {
    await safeSendDM(message.author, `⚡ On-demand price check:\n\n${lines.join("\n\n")}`);
    if (message.guild) await message.reply("✅ Sent you a DM with your on-demand prices.");
  } catch (err) {
    console.error("Failed to DM now:", err);
    await message.reply("I couldn't DM you — check your DM privacy settings.");
  }
}

async function handleInventoryStats(message) {
  const userId = message.author.id;
  const portfolios = loadPortfolios();
  const list = portfolios[userId] || [];
  if (!list.length) return message.reply("Your watchlist is empty. Use `!inventoryadd` first.");

  const ids = list.map((i) => i.tcgplayerId);
  const prices = await fetchCardPrices(ids);
  const checkedIso = new Date().toISOString();

  // Build per-item stats
  const rows = list.map((item) => {
    const p = prices[item.tcgplayerId] || {};
    const cur = p.marketPrice != null ? Number(p.marketPrice) : null;
    const base = Number.isFinite(Number(item.addedMarketPrice)) ? Number(item.addedMarketPrice) : null;

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

  // Winners/losers by % since added
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

  // Persist baseline/last if missing (so stats helps “train” baselines too)
  persistPricesForUser(userId, list, prices, checkedIso);

  try {
    await safeSendDM(message.author, lines.join("\n"));
    if (message.guild) await message.reply("✅ I DM’d you your stats.");
  } catch (err) {
    console.error("Failed to DM stats:", err);
    await message.reply("I couldn't DM you — check your DM privacy settings.");
  }
}

// ---- DAILY CRON ----
cron.schedule("0 16 * * *", async () => {
  console.log("[Cron] Daily portfolio price DM starting...");
  const portfolios = loadPortfolios();
  const entries = Object.entries(portfolios);
  if (!entries.length) return;

  const allIds = Array.from(
    new Set(entries.flatMap(([, items]) => (items || []).map((it) => it.tcgplayerId)).filter(Boolean))
  );

  const prices = await fetchCardPrices(allIds);
  const checkedIso = new Date().toISOString();

  const alertCooldownMs = ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;

  for (const [userId, items] of entries) {
    if (!items || !items.length) continue;

    // Optional alerts (disabled unless PRICE_ALERT_PCT > 0)
    if (PRICE_ALERT_PCT > 0) {
      for (const item of items) {
        const p = prices[item.tcgplayerId] || {};
        const cur = p.marketPrice != null ? Number(p.marketPrice) : null;
        const last = Number.isFinite(Number(item.lastMarketPrice)) ? Number(item.lastMarketPrice) : null;

        const d1 = calcDelta(cur, last);
        const lastAlertedAt = item.lastAlertedAt ? new Date(item.lastAlertedAt).getTime() : 0;
        const canAlert = Date.now() - lastAlertedAt >= alertCooldownMs;

        if (
          d1 &&
          d1.pct != null &&
          Math.abs(d1.pct) >= PRICE_ALERT_PCT &&
          canAlert
        ) {
          item.__shouldAlert = true;
        }
      }
    }

    // Build lines with deltas
    const lines = buildPriceLines(items, prices);

    // Persist last/baseline values (and alert timestamps if enabled)
    persistPricesForUser(userId, items, prices, checkedIso, { allowAlertUpdate: PRICE_ALERT_PCT > 0 });

    try {
      const user = await client.users.fetch(userId);
      await safeSendDM(user, `📅 Daily price update:\n\n${lines.join("\n\n")}`);
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
    if (cmd === "inventoryadd") return await handleInventoryAdd(message, argsText);
    if (cmd === "inventorylist") return await handleInventoryList(message);
    if (cmd === "inventoryremove") return await handleInventoryRemove(message, argsText);
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
});

client.login(DISCORD_BOT_TOKEN);
