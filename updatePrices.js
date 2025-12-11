// updatePrices.js - BATCH VERSION with Discord alerts
// - Uses POST /v1/cards with up to 100 tcgplayerIds per request
// - Only updates items you actually own (quantity > 0)
// - Skips items updated in the last 24 hours
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

const BATCH_SIZE = 100; // your plan allows 100 IDs/request
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Conservative rate limit: 40 batch calls/minute (4000 IDs/min effective)
const MAX_BATCH_CALLS_PER_MIN = 40;
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
    console.error("Error reading inventory.json:", err.message);
    process.exit(1);
  }
}

function saveInventory(inv) {
  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(inv, null, 2), "utf8");
}

// Rate limit wrapper for POST batch requests
async function rateLimitedBatchFetch(body) {
  const now = Date.now();

  batchCallTimestamps = batchCallTimestamps.filter((t) => now - t < 60_000);

  if (batchCallTimestamps.length >= MAX_BATCH_CALLS_PER_MIN) {
    const earliest = batchCallTimestamps[0];
    const waitMs = 60_000 - (now - earliest) + 50;
    const waitSec = Math.ceil(waitMs / 1000);

    console.log(`Rate-limit: waiting ${waitSec}s before next batch...`);
    await new Promise((r) => setTimeout(r, waitMs));
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
  const inventory = loadInventory();
  const now = Date.now();

  // Only update:
  // - items with tcgPlayerId
  // - quantity > 0 (you own it)
  // - lastUpdated is >24h old (or missing)
  const itemsToUpdate = inventory.filter((item) => {
    if (!item || !item.tcgPlayerId) return false;
    if (typeof item.quantity !== "number" || item.quantity <= 0) return false;

    if (item.lastUpdated) {
      const t = Date.parse(item.lastUpdated);
      if (!Number.isNaN(t) && now - t < ONE_DAY_MS) {
        return false;
      }
    }

    return true;
  });

  console.log(
    `Total inventory: ${inventory.length}, items to update (qty>0 & >24h old): ${itemsToUpdate.length}`
  );

  if (itemsToUpdate.length === 0) {
    console.log("Nothing to update (all items refreshed within last 24h).");
    return;
  }

  const idList = itemsToUpdate.map((i) => ({
    tcgplayerId: i.tcgPlayerId.toString(),
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

    let data;
    try {
      data = await rateLimitedBatchFetch(batches[b]);
      apiCalls++;
    } catch (err) {
      console.error("Batch failed:", err.message || err);
      continue;
    }

    const results = data && Array.isArray(data.data) ? data.data : [];

    for (const card of results) {
      const item = inventory.find(
        (i) =>
          i &&
          i.tcgPlayerId &&
          i.tcgPlayerId.toString() === String(card.tcgplayerId)
      );
      if (!item) continue;

      let variant =
        (card.variants || []).find((v) => v.condition === "Sealed") ||
        (card.variants || [])[0];

      if (!variant || variant.price == null) continue;

      const price = Number(variant.price);
      if (!Number.isFinite(price)) continue;

      item.marketPrice = price;
      item.yourPrice = Number((price * 0.9).toFixed(2));
      item.setName = card.set_name || item.setName || null;
      item.lastUpdated = new Date().toISOString();

      if (!item.imageUrl) {
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
