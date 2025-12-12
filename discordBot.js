// discordBot.js
// Discord bot that lets users track TCGplayer IDs and get daily + on-demand DM price updates,
// with server/user-based access control.

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

// ---- ENVIRONMENT ----

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const JUSTTCG_API_KEY = process.env.JUSTTCG_API_KEY;

const ALLOWED_GUILD_IDS = process.env.ALLOWED_GUILD_IDS
  ? process.env.ALLOWED_GUILD_IDS.split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  : [];

const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  : [];

if (typeof fetch !== "function") {
  console.error("Node 18+ required (fetch built-in).");
  process.exit(1);
}

if (!DISCORD_BOT_TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN in environment.");
  process.exit(1);
}

if (!JUSTTCG_API_KEY) {
  console.error("Missing JUSTTCG_API_KEY in environment.");
  process.exit(1);
}

// ---- CONSTANTS ----

const PORTFOLIO_PATH = path.join(__dirname, "userPortfolios.json");
const CMD_PREFIX = "!";
const BATCH_SIZE = 20; // JustTCG plan limit

// Cooldown: 2 hours for normal users (server admins bypass)
const ON_DEMAND_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const lastOnDemandRun = {}; // { userId: timestamp }

// ---- DISCORD CLIENT ----

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// ---- ACCESS CONTROL HELPERS ----
//
// By default (no ALLOWED_GUILD_IDS / ALLOWED_USER_IDS set), the bot
// behaves as before and is usable anywhere. Once you configure either
// env var, only those guilds/users will be allowed.

function isUserAllowed(message) {
  const userId = message.author.id;

  // If no allow lists are configured, allow everyone (backwards compatible).
  if (ALLOWED_GUILD_IDS.length === 0 && ALLOWED_USER_IDS.length === 0) {
    return true;
  }

  // Explicit per-user allow list (works for DMs and guilds).
  if (ALLOWED_USER_IDS.includes(userId)) {
    return true;
  }

  // Guild messages: only allow if guild is whitelisted.
  if (message.guild) {
    const guildId = message.guild.id;
    return ALLOWED_GUILD_IDS.includes(guildId);
  }

  // DM from non-allowed user: blocked.
  return false;
}

// ---- STORAGE HELPERS ----

function loadPortfolios() {
  try {
    if (!fs.existsSync(PORTFOLIO_PATH)) {
      fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify({}, null, 2), "utf8");
      return {};
    }
    const raw = fs.readFileSync(PORTFOLIO_PATH, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    console.error("Failed to load portfolios:", err);
    return {};
  }
}

function savePortfolios(portfolios) {
  try {
    fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(portfolios, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save portfolios:", err);
  }
}

// ---- JUSTTCG HELPER (mirrors updatePrices.js logic) ----

async function fetchCardPrices(tcgplayerIds) {
  // Deduplicate IDs and normalize to strings
  const uniqueIds = Array.from(
    new Set(
      (tcgplayerIds || [])
        .map((id) => String(id).trim())
        .filter((id) => id.length > 0)
    )
  );

  const idToPrice = {}; // id -> { marketPrice, setName, name }

  if (!uniqueIds.length) {
    return idToPrice;
  }

  // Chunk into batches of BATCH_SIZE
  for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + BATCH_SIZE);

    try {
      const res = await fetch("https://api.justtcg.com/v1/cards", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": JUSTTCG_API_KEY,
        },
        body: JSON.stringify({ tcgplayerIds: batch }),
      });

      if (!res.ok) {
        console.error(
          `JustTCG batch request failed: ${res.status} ${res.statusText}`
        );
        continue;
      }

      const result = await res.json();
      const cards = Array.isArray(result) ? result : result.data || [];

      for (const card of cards) {
        if (!card || !card.tcgplayer_id) continue;

        const id = String(card.tcgplayer_id);
        const variants = card.variants || [];

        let variant =
          variants.find((v) => v && v.condition === "Sealed") || variants[0];

        if (!variant || variant.price == null) {
          idToPrice[id] = {
            marketPrice: null,
            setName: card.set_name || null,
            name: card.name || null,
          };
          continue;
        }

        const price = Number(variant.price);
        if (!Number.isFinite(price) || price <= 0 || price > 10000) {
          idToPrice[id] = {
            marketPrice: null,
            setName: card.set_name || null,
            name: card.name || null,
          };
          continue;
        }

        idToPrice[id] = {
          marketPrice: price,
          setName: card.set_name || null,
          name: card.name || null,
        };
      }
    } catch (err) {
      console.error("Error during JustTCG request:", err);
    }
  }

  return idToPrice;
}

// ---- COMMAND HANDLERS ----

// !inventoryadd <id> "Label" [<id> "Label"...]
async function handleInventoryAdd(message, argsStr) {
  if (!argsStr) {
    return message.reply(
      "Usage: `!inventoryadd <tcgplayerId> \"Label\" [<tcgplayerId> \"Label\" ...]`"
    );
  }

  const pairs = [];
  const regex = /(\d+)\s+"([^"]+)"/g;
  let match;
  while ((match = regex.exec(argsStr)) !== null) {
    const id = match[1];
    const label = match[2].trim();
    if (id && label) {
      pairs.push({ id, label });
    }
  }

  if (!pairs.length) {
    return message.reply(
      "I couldn't parse any `<id> \"Label\"` pairs. Example:\n" +
        "`!inventoryadd 543843 \"Booster Box\" 543844 \"Booster Bundle\"`"
    );
  }

  const userId = message.author.id;
  const portfolios = loadPortfolios();
  const current = portfolios[userId] || [];

  for (const { id, label } of pairs) {
    const existingIndex = current.findIndex((item) => item.id === id);
    if (existingIndex !== -1) {
      current[existingIndex].label = label;
    } else {
      current.push({ id, label });
    }
  }

  portfolios[userId] = current;
  savePortfolios(portfolios);

  const addedList = pairs.map((p) => `${p.id} – "${p.label}"`).join("\n");
  await message.reply(
    `✅ Updated your watchlist with:\n${addedList}\n\nYou now have ${current.length} item(s) tracked.`
  );
}

// !inventorylist – DM the user their current list (with latest prices)
async function handleInventoryList(message) {
  const userId = message.author.id;
  const portfolios = loadPortfolios();
  const list = portfolios[userId] || [];

  if (!list.length) {
    return message.reply("You don't have any items in your watchlist yet.");
  }

  const ids = list.map((item) => item.id);
  const prices = await fetchCardPrices(ids);

  let lines = [];
  for (const item of list) {
    const p = prices[item.id] || {};
    const name = p.name || item.label || "(unknown)";
    const setName = p.setName ? ` [${p.setName}]` : "";
    const priceText =
      p.marketPrice != null ? `$${p.marketPrice.toFixed(2)}` : "N/A";

    lines.push(
      `• ${name}${setName}\n  ID: ${item.id} – ${item.label} – Market: ${priceText}`
    );
  }

  try {
    await message.author.send(
      `📊 Your tracked items:\n\n` + lines.join("\n\n")
    );
    if (message.channel.type !== 1) {
      // If not already DM, acknowledge in-channel.
      await message.reply("I've sent you a DM with your watchlist.");
    }
  } catch (err) {
    console.error("Failed to DM user list:", err);
    await message.reply(
      "I couldn't DM you. Please make sure your DMs are open and try again."
    );
  }
}

// !inventoryremove <id>
async function handleInventoryRemove(message, argsStr) {
  const userId = message.author.id;
  const id = argsStr.trim();

  if (!id) {
    return message.reply("Usage: `!inventoryremove <tcgplayerId>`");
  }

  const portfolios = loadPortfolios();
  const current = portfolios[userId] || [];
  const next = current.filter((item) => item.id !== id);
  const removedCount = current.length - next.length;

  portfolios[userId] = next;
  savePortfolios(portfolios);

  if (!removedCount) {
    return message.reply(
      `I didn't find ID \`${id}\` in your watchlist. You currently have ${next.length} item(s).`
    );
  }

  await message.reply(
    `🗑 Removed ID \`${id}\` from your watchlist. You now have ${next.length} item(s).`
  );
}

// !inventorynow – on-demand price fetch for this user (2h cooldown, server admin override)
async function handleInventoryNow(message) {
  const userId = message.author.id;
  const now = Date.now();

  // Determine if user is admin (server admin only)
  let isAdmin = false;
  if (message.guild && message.member) {
    try {
      isAdmin = message.member.permissions.has(
        PermissionsBitField.Flags.Administrator
      );
    } catch (err) {
      isAdmin = false;
    }
  }

  if (!isAdmin) {
    const lastRun = lastOnDemandRun[userId] || 0;
    const elapsed = now - lastRun;
    if (elapsed < ON_DEMAND_COOLDOWN_MS) {
      const remainingMs = ON_DEMAND_COOLDOWN_MS - elapsed;
      const remainingMin = Math.ceil(remainingMs / 60000);
      return message.reply(
        `⏳ You can only use \`!inventorynow\` every 2 hours. Please try again in ~${remainingMin} minute(s).`
      );
    }

    lastOnDemandRun[userId] = now;
  }

  const portfolios = loadPortfolios();
  const list = portfolios[userId] || [];

  if (!list.length) {
    return message.reply(
      "You don't have any items in your watchlist yet. Use `!inventoryadd` first."
    );
  }

  const ids = list.map((item) => item.id);
  const prices = await fetchCardPrices(ids);

  let lines = [];
  for (const item of list) {
    const p = prices[item.id] || {};
    const name = p.name || item.label || "(unknown)";
    const setName = p.setName ? ` [${p.setName}]` : "";
    const priceText =
      p.marketPrice != null ? `$${p.marketPrice.toFixed(2)}` : "N/A";

    lines.push(
      `• ${name}${setName}\n  ID: ${item.id} – ${item.label} – Market: ${priceText}`
    );
  }

  try {
    await message.author.send(
      `⚡ On-demand price check:\n\n` + lines.join("\n\n")
    );
    if (message.channel.type !== 1) {
      await message.reply("I've sent you a DM with your latest prices.");
    }
  } catch (err) {
    console.error("Failed to DM user now-prices:", err);
    await message.reply(
      "I couldn't DM you. Please make sure your DMs are open and try again."
    );
  }
}

// ---- DAILY CRON JOB (10:00) ----

cron.schedule("0 10 * * *", async () => {
  console.log("[Cron] Running daily price updates for all users...");
  const portfolios = loadPortfolios();
  const entries = Object.entries(portfolios);

  if (!entries.length) {
    console.log("[Cron] No users in portfolios, skipping.");
    return;
  }

  const allIds = Array.from(
    new Set(
      entries
        .flatMap(([userId, items]) => (items || []).map((item) => item.id))
        .filter(Boolean)
        .map((id) => String(id))
    )
  );

  const prices = await fetchCardPrices(allIds);

  for (const [userId, items] of entries) {
    if (!items || !items.length) continue;

    const userItems = items;
    let lines = [];

    for (const item of userItems) {
      const p = prices[item.id] || {};
      const name = p.name || item.label || "(unknown)";
      const setName = p.setName ? ` [${p.setName}]` : "";
      const priceText =
        p.marketPrice != null ? `$${p.marketPrice.toFixed(2)}` : "N/A";

      lines.push(
        `• ${name}${setName}\n  ID: ${item.id} – ${item.label} – Market: ${priceText}`
      );
    }

    try {
      const user = await client.users.fetch(userId);
      await user.send(
        `📅 Daily price update:\n\n` + lines.join("\n\n")
      );
    } catch (err) {
      console.error(`Failed to DM daily update to user ${userId}:`, err);
    }
  }
});

// ---- MESSAGE HANDLER ----

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(CMD_PREFIX)) return;

  // Access control: block unauthorized users/servers.
  if (!isUserAllowed(message)) {
    // If you prefer total silence for blocked users, comment this out.
    try {
      await message.reply(
        "Sorry, this bot is currently restricted and you are not authorized to use it."
      );
    } catch (err) {
      console.error("Failed to send unauthorized message:", err);
    }
    return;
  }

  const withoutPrefix = message.content.slice(CMD_PREFIX.length).trim();
  const firstSpace = withoutPrefix.indexOf(" ");
  const cmd =
    firstSpace === -1
      ? withoutPrefix.toLowerCase()
      : withoutPrefix.slice(0, firstSpace).toLowerCase();
  const argsStr =
    firstSpace === -1 ? "" : withoutPrefix.slice(firstSpace + 1).trim();

  try {
    if (cmd === "inventoryadd") {
      await handleInventoryAdd(message, argsStr);
    } else if (cmd === "inventorylist") {
      await handleInventoryList(message);
    } else if (cmd === "inventoryremove") {
      await handleInventoryRemove(message, argsStr);
    } else if (cmd === "inventorynow") {
      await handleInventoryNow(message);
    }
  } catch (err) {
    console.error("Error handling command:", err);
    try {
      await message.reply(
        "Something went wrong while processing that command. Please try again later."
      );
    } catch (_) {
      // ignore
    }
  }
});

// ---- READY / LOGIN ----

client.once("ready", () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  console.log("Daily job scheduled at 10:00.");
});

client.login(DISCORD_BOT_TOKEN);
