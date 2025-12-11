// updatePrices.js - BATCH VERSION with Discord alerts
// - Uses POST /v1/cards with up to 100 tcgplayerIds per request
// - Only updates items you actually own (quantity > 0)
// - Skips items updated in the last 24 hours (unless --force)
// - Sends a summary Discord message when prices update

require("dotenv").config();
const fs = require("fs");
const path = require("path");

if (typeof fetch !== "function") {
  console.error("Node 18+ required (fetch built-in).");
  process.exit(1);
}

const API_KEY = process.env.JUSTTCG_API_KEY;
const API_URL = "https://api.justtcg.com/v1/cards";
const INVENTORY_PATH = path.join(__dirname, "inventory.json");
const TCG_IMAGE_BASE = "https://product-images.tcgplayer.com/fit-in/437x437/";

const DISCORD_PRICE_WEBHOOK = process.env.DISCORD_PRICE_WEBHOOK;

if (!API_KEY) {
  console.error("Missing JUSTTCG_API_KEY in .env");
  process.exit(1);
}

const BATCH_SIZE = 20; // your plan allows 100 IDs/request
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Conservative rate limit: 40 batch calls/minute (4000 IDs/min effective)
const MAX_BATCH_CALLS_PER_MIN = 10;
const PRICE_MULTIPLIER = 0.9;

let batchCallTimestamps = [];

function sendDiscordMessage(webhookUrl, content) {
  if (!webhookUrl || !content) return;
  if (typeof fetch !== "function") return;

  fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  })
    .then((res) => {
      if (!res.ok) {
        console.error("Discord webhook failed with status", res.status);
      }
    })
    .catch((err) => {
      console.error("Discord webhook error:", err.message || err);
    });
}

function loadInventory() {
  try {
    const raw = fs.readFileSync(INVENTORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
    return [];
  } catch (err) {
    console.error("Error reading inventory.json:", err.message || err);
    return [];
  }
}

function saveInventory(inv) {
  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(inv, null, 2), "utf8");
}

// Rate limit wrapper for POST batch requests
async function rateLimitedBatchFetch(body) {
  const now = Date.now();

  // Keep only last 60 seconds of timestamps
  batchCallTimestamps = batchCallTimestamps.filter((t) => now - t < 60_000);

  if (batchCallTimestamps.length >= MAX_BATCH_CALLS_PER_MIN) {
    const oldest = Math.min(...batchCallTimestamps);
    const waitMs = 60_000 - (now - oldest);
    console.log(
      `Rate limit hit (${batchCallTimestamps.length}/${MAX_BATCH_CALLS_PER_MIN} calls in last minute). Waiting ${Math.ceil(
        waitMs / 1000
      )}s...`
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  batchCallTimestamps.push(Date.now());

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "X-Api-Key": API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`JustTCG batch error ${res.status}: ${txt}`);
  }

  // Could be { data: [...] } or just [...]
  return res.json();
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function main() {
  const force = process.argv.includes("--force");
  const inventory = loadInventory();
  const now = Date.now();

  let skippedNoId = 0;
  let skippedQty = 0;
  let skippedRecent = 0;

  const candidates = inventory.filter((item) => {
    if (!item) return false;

    if (!item.tcgPlayerId) {
      skippedNoId++;
      return false;
    }

    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      skippedQty++;
      return false;
    }

    if (!force && item.lastUpdated) {
      const t = Date.parse(item.lastUpdated);
      if (!Number.isNaN(t) && now - t < ONE_DAY_MS) {
        skippedRecent++;
        return false;
      }
    }

    return true;
  });

  console.log(
    `Total inventory: ${inventory.length}\n→ Candidates: ${candidates.length} (qty>0${
      force ? "" : " & >24h old"
    })`
  );
  console.log(
    `Skipped: no id=${skippedNoId}, qty<=0=${skippedQty}${
      force ? "" : `, recent(<24h)=${skippedRecent}`
    }`
  );

  if (candidates.length === 0) {
    console.log("Nothing to update.");
    return;
  }

  // Map tcgplayerId -> list of items
  const idToItems = new Map();
  for (const item of candidates) {
    const id = String(item.tcgPlayerId).trim();
    if (!id) continue;
    const list = idToItems.get(id) || [];
    list.push(item);
    idToItems.set(id, list);
  }

  const idList = Array.from(idToItems.keys()).map((id) => ({
    tcgplayerId: id,
  }));

  const batches = chunkArray(idList, BATCH_SIZE);
  console.log(`Sending ${batches.length} batch requests...`);

  let updated = 0;
  let apiCalls = 0;
  const priceUpdateLines = [];

  for (let b = 0; b < batches.length; b++) {
    console.log(
      `\n[Batch ${b + 1}/${batches.length}] fetching ${batches[b].length} items...`
    );

    let result;
    try {
      result = await rateLimitedBatchFetch(batches[b]);
      apiCalls++;
    } catch (err) {
      console.error("Batch fetch failed:", err.message || err);
      continue;
    }

    // Handle both array and { data: [...] }
    let cards;
    if (Array.isArray(result)) {
      cards = result;
    } else if (result && Array.isArray(result.data)) {
      cards = result.data;
    } else {
      console.error(
        "Unexpected API response format, expected array or { data: [...] }."
      );
      console.error("Raw response shape keys:", result && Object.keys(result));
      continue;
    }

    for (const card of cards) {
      if (!card || !card.tcgplayerId) continue;

      const id = String(card.tcgplayerId);
      const itemsForId = idToItems.get(id);
      if (!itemsForId || itemsForId.length === 0) continue;

      let variant =
        (card.variants || []).find((v) => v.condition === "Sealed") ||
        (card.variants || [])[0];

      if (!variant || variant.price == null) {
        for (const item of itemsForId) {
          item.priceError = "No sealed price returned";
        }
        continue;
      }

      const price = Number(variant.price);
      if (!Number.isFinite(price) || price <= 0 || price > 10000) {
        for (const item of itemsForId) {
          item.priceError = "Unreasonable price returned";
        }
        continue;
      }

      for (const item of itemsForId) {
        delete item.priceError;

        item.marketPrice = price;
        item.yourPrice = Number((price * PRICE_MULTIPLIER).toFixed(2));
        item.setName = card.set_name || item.setName || null;
        item.lastUpdated = new Date().toISOString();

        if (!item.imageUrl && item.tcgPlayerId) {
          item.imageUrl = TCG_IMAGE_BASE + item.tcgPlayerId + ".jpg";
        }

        updated++;
        const line = `• ${item.name} → $${item.yourPrice.toFixed(
          2
        )} (market $${item.marketPrice.toFixed(2)}) qty:${item.quantity ?? 0}`;
        console.log("  " + line);
        priceUpdateLines.push(line);
      }
    }
  }

  saveInventory(inventory);

  console.log(`\nDone.`);
  console.log(`Updated items: ${updated}`);
  console.log(`Batch API calls made: ${apiCalls}`);
  console.log(
    `Effective items/request: ${(updated / Math.max(apiCalls, 1)).toFixed(1)}`
  );

  // Discord alert for price updates
  if (updated > 0 && DISCORD_PRICE_WEBHOOK) {
    let header = `📈 Price update completed.\nUpdated items: ${updated}\n\n`;
    let body = priceUpdateLines.join("\n");
    if (body.length > 1800) {
      body = body.slice(0, 1800) + "\n… (truncated)";
    }
    sendDiscordMessage(DISCORD_PRICE_WEBHOOK, header + body);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
