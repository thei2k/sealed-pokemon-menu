// discordBot.js
// Discord bot that lets users track TCGplayer IDs and get daily + on-demand DM price updates.

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

if (!DISCORD_BOT_TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN in .env");
  process.exit(1);
}

if (!JUSTTCG_API_KEY) {
  console.error("Missing JUSTTCG_API_KEY in .env");
  process.exit(1);
}

// ---- CONSTANTS ----

const PORTFOLIO_PATH = path.join(__dirname, "userPortfolios.json");
const CMD_PREFIX = "!";
const BATCH_SIZE = 20; // your JustTCG plan limit

// ---- Cooldown Settings ----

// 2 hours for normal users
const ON_DEMAND_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
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

// ---- STORAGE HELPERS ----

function loadPortfolios() {
  try {
    const raw = fs.readFileSync(PORTFOLIO_PATH, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function savePortfolios(portfolios) {
  fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(portfolios, null, 2), "utf8");
}

// Ensure file exists
if (!fs.existsSync(PORTFOLIO_PATH)) {
  savePortfolios({});
}

// ---- JUSTTCG HELPER ----

async function fetchCardPrices(tcgplayerIds) {
  if (!tcgplayerIds.length) return {};

  const uniqueIds = Array.from(new Set(tcgplayerIds.map(String)));
  const idToPrice = {};

  for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
    const chunk = uniqueIds.slice(i, i + BATCH_SIZE);
    console.log(
      `Fetching prices for batch ${i / BATCH_SIZE + 1}: ${chunk.length} IDs`
    );

    try {
      const res = await fetch("https://api.justtcg.com/v1/cards", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${JUSTTCG_API_KEY}`,
        },
        body: JSON.stringify(chunk.map((id) => ({ tcgplayerId: id }))),
      });

      if (!res.ok) {
        console.error("JustTCG batch failed:", res.status, await res.text());
        continue;
      }

      const data = await res.json();
      if (!Array.isArray(data)) {
        console.error("Unexpected JustTCG response format (expected array)");
        continue;
      }

      for (const entry of data) {
        if (!entry || !entry.tcgplayerId || !Array.isArray(entry.variants))
          continue;

        const sealedVariant = entry.variants.find(
          (v) =>
            v &&
            typeof v.condition === "string" &&
            v.condition.toLowerCase() === "sealed"
        );

        const marketPrice =
          sealedVariant && typeof sealedVariant.price === "number"
            ? sealedVariant.price
            : null;

        idToPrice[String(entry.tcgplayerId)] = {
          marketPrice,
          setName: entry.set_name || null,
          name: entry.name || null,
        };
      }
    } catch (err) {
      console.error("Error calling JustTCG:", err.message || err);
    }
  }

  return idToPrice;
}

// ---- COMMAND HANDLERS ----

// !inventoryadd 123456 "Booster Box" 123123 "Booster Bundle"
async function handleInventoryAdd(message, argsStr) {
  const userId = message.author.id;
  const portfolios = loadPortfolios();

  // Parse pairs: number "label"
  const regex = /(\d+)\s+"([^"]+)"/g;
  let match;
  const entries = [];

  while ((match = regex.exec(argsStr)) !== null) {
    const id = match[1];
    const label = match[2].trim();
    if (id && label) {
      entries.push({ tcgplayerId: id, label });
    }
  }

  if (!entries.length) {
    return message.reply(
      'Usage: `!inventoryadd 543843 "Phantasmal Flames Booster Box" 543844 "Booster Bundle"`'
    );
  }

  if (!portfolios[userId]) {
    portfolios[userId] = [];
  }

  const current = portfolios[userId];

  for (const entry of entries) {
    const existingIndex = current.findIndex(
      (e) => String(e.tcgplayerId) === String(entry.tcgplayerId)
    );
    if (existingIndex >= 0) {
      current[existingIndex].label = entry.label;
    } else {
      current.push(entry);
    }
  }

  savePortfolios(portfolios);

  const summary = entries
    .map((e) => `${e.label} (${e.tcgplayerId})`)
    .join(", ");

  await message.reply(
    `✅ Added/updated the following in your watchlist: ${summary}`
  );
}

async function handleInventoryList(message) {
  const userId = message.author.id;
  const portfolios = loadPortfolios();
  const list = portfolios[userId] || [];

  if (!list.length) {
    return message.reply(
      "📭 You don't have anything in your watchlist yet. Add items with `!inventoryadd`."
    );
  }

  const lines = list.map(
    (e, idx) => `${idx + 1}. ${e.label || "No label"} (${e.tcgplayerId})`
  );

  const chunks = [];
  let current = "";
  for (const line of lines) {
    if ((current + line + "\n").length > 1800) {
      chunks.push(current);
      current = "";
    }
    current += line + "\n";
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await message.author.send(`📋 Your watchlist:\n\n${chunk}`);
  }

  if (chunks.length === 1) {
    await message.reply("✅ I've sent your current watchlist via DM.");
  } else {
    await message.reply(
      `✅ I've sent your current watchlist in ${chunks.length} DMs.`
    );
  }
}

// !inventoryremove 123456
async function handleInventoryRemove(message, argsStr) {
  const userId = message.author.id;
  const portfolios = loadPortfolios();
  const list = portfolios[userId] || [];

  const id = (argsStr || "").trim();
  if (!id) {
    return message.reply('Usage: `!inventoryremove 543843`');
  }

  const next = list.filter((e) => String(e.tcgplayerId) !== id);
  portfolios[userId] = next;
  savePortfolios(portfolios);

  await message.reply(
    `🗑 If that ID was in your watchlist, it's been removed. You now have ${next.length} item(s).`
  );
}

// !inventorynow – on-demand price fetch for this user
async function handleInventoryNow(message) {
  const userId = message.author.id;
  const now = Date.now();

  // Determine if user is admin (server admin only)
  const isAdmin =
    message.member &&
    message.member.permissions &&
    message.member.permissions.has(PermissionsBitField.Flags.Administrator);

  // Cooldown check (only applies to non-admins)
  if (!isAdmin) {
    const last = lastOnDemandRun[userId] || 0;
    const diff = now - last;

    if (diff < ON_DEMAND_COOLDOWN_MS) {
      const remainingMs = ON_DEMAND_COOLDOWN_MS - diff;
      const remainingMin = Math.ceil(remainingMs / 60000);
      return message.reply(
        `⏳ You can only use \`!inventorynow\` every 2 hours. Please try again in ~${remainingMin} minute(s).`
      );
    }

    // Update normal-user cooldown
    lastOnDemandRun[userId] = now;
  }

  // Load user's watchlist
  const portfolios = loadPortfolios();
  const list = portfolios[userId] || [];

  if (!list.length) {
    return message.reply(
      "📭 Your watchlist is empty. Add items first with `!inventoryadd`."
    );
  }

  await message.reply("📡 Fetching the latest live prices…");

  const ids = list.map((e) => String(e.tcgplayerId));
  const idToPrice = await fetchCardPrices(ids);

  const lines = list.map((entry) => {
    const info = idToPrice[String(entry.tcgplayerId)] || {};
    const price = info.marketPrice;
    const setName = info.setName || "";
    const name = info.name || "";
    const label = entry.label || name || entry.tcgplayerId;

    const priceText =
      typeof price === "number" ? `$${price.toFixed(2)}` : "N/A";

    return `• **${label}** (${entry.tcgplayerId}) — ${priceText}${
      setName ? ` [${setName}]` : ""
    }`;
  });

  try {
    const user = await client.users.fetch(userId);

    let header = "📊 **Your latest TCG price updates:**\n\n";
    let messageText = header;

    for (const line of lines) {
      if ((messageText + line + "\n").length > 1800) {
        await user.send(messageText);
        messageText = header;
      }
      messageText += line + "\n";
    }

    if (messageText !== header) {
      await user.send(messageText);
    }

    if (isAdmin) {
      await message.reply("✅ Admin override used. Latest prices sent via DM.");
    } else {
      await message.reply("📬 I’ve sent you your updated prices in DM!");
    }
  } catch (err) {
    console.error("Failed to DM user for inventorynow:", err.message || err);
    await message.reply(
      "⚠ I couldn't DM you. Make sure your DMs are open so I can send updates."
    );
  }
}

// ---- DAILY JOB ----

async function sendDailyUpdates() {
  console.log("Running daily price update job...");

  const portfolios = loadPortfolios();
  const userIds = Object.keys(portfolios).filter(
    (id) => Array.isArray(portfolios[id]) && portfolios[id].length > 0
  );

  if (!userIds.length) {
    console.log("No users with portfolios, skipping.");
    return;
  }

  // Flatten all entries
  const allEntries = [];
  for (const userId of userIds) {
    for (const entry of portfolios[userId]) {
      allEntries.push({
        userId,
        tcgplayerId: String(entry.tcgplayerId),
        label: entry.label || "",
      });
    }
  }

  const allIds = allEntries.map((e) => e.tcgplayerId);
  const idToPrice = await fetchCardPrices(allIds);

  // Build per-user messages
  const perUserLines = {};
  for (const entry of allEntries) {
    const info = idToPrice[entry.tcgplayerId] || {};
    const price = info.marketPrice;
    const setName = info.setName || "";
    const name = info.name || "";
    const label = entry.label || name || entry.tcgplayerId;

    const priceText =
      typeof price === "number" ? `$${price.toFixed(2)}` : "N/A";

    const line = `• ${label} (${entry.tcgplayerId}) — ${priceText}${
      setName ? ` [${setName}]` : ""
    }`;

    if (!perUserLines[entry.userId]) perUserLines[entry.userId] = [];
    perUserLines[entry.userId].push(line);
  }

  // Send DMs
  for (const userId of Object.keys(perUserLines)) {
    try {
      const user = await client.users.fetch(userId);
      const lines = perUserLines[userId];

      let header = "📊 **Today's price updates for your watchlist:**\n\n";
      let messageText = header;

      for (const line of lines) {
        if ((messageText + line + "\n").length > 1900) {
          await user.send(messageText);
          messageText = header;
        }
        messageText += line + "\n";
      }

      if (messageText !== header) {
        await user.send(messageText);
      }

      console.log("Sent daily update to user", userId);
    } catch (err) {
      console.error("Failed to DM user", userId, err.message || err);
    }
  }

  console.log("Daily price update job done.");
}

// Schedule: once per day at 10:00 AM server time
cron.schedule("0 10 * * *", () => {
  sendDailyUpdates().catch((err) =>
    console.error("Daily job error:", err.message || err)
  );
});

// ---- MESSAGE HANDLER ----

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(CMD_PREFIX)) return;

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
    console.error("Command error:", err.message || err);
    message.reply("❌ Something went wrong handling that command.");
  }
});

// ---- LOGIN ----

// Use clientReady to avoid the deprecation warning about "ready"
client.once("clientReady", () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  console.log("Daily job scheduled at 10:00.");
});

client.login(DISCORD_BOT_TOKEN);
