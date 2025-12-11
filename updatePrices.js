// updatePrices.js - BATCH VERSION (100 IDs per JustTCG request)
// MASSIVE efficiency upgrade: updates 100 items per API call

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

if (!API_KEY) {
  console.error("Missing JUSTTCG_API_KEY in .env");
  process.exit(1);
}

const BATCH_SIZE = 100; // new plan allows 100 IDs/request
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Conservative rate limit: 20 batch calls/min (2,000 IDs/min effective)
const MAX_BATCH_CALLS_PER_MIN = 20;
let batchCallTimestamps = [];

function loadInventory() {
  const raw = fs.readFileSync(INVENTORY_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed.items) return parsed.items;
  return [];
}

function saveInventory(inv) {
  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(inv, null, 2), "utf8");
}

// Rate limit wrapper for POST batch requests
async function rateLimitedBatchFetch(body) {
  const now = Date.now();

  batchCallTimestamps = batchCallTimestamps.filter(
    (t) => now - t < 60_000
  );

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

  // Filter only items we need to update
  const itemsToUpdate = inventory.filter((item) => {
    if (!item.tcgPlayerId) return false;
    if (!item.quantity || item.quantity <= 0) return false;

    if (item.lastUpdated) {
      const t = Date.parse(item.lastUpdated);
      if (!Number.isNaN(t) && now - t < ONE_DAY_MS) {
        return false; // updated <24h ago → skip
      }
    }

    return true;
  });

  console.log(
    `Total inventory: ${inventory.length}, need updates: ${itemsToUpdate.length}`
  );

  const idList = itemsToUpdate.map((i) => ({
    tcgplayerId: i.tcgPlayerId.toString(),
  }));

  const batches = chunkArray(idList, BATCH_SIZE);
  console.log(`Sending ${batches.length} batch requests...`);

  let updated = 0;
  let apiCalls = 0;

  for (let b = 0; b < batches.length; b++) {
    console.log(
      `\n[Batch ${b + 1}/${batches.length}] fetching ${batches[b].length} items...`
    );

    let data;
    try {
      data = await rateLimitedBatchFetch(batches[b]);
      apiCalls++;
    } catch (err) {
      console.error("Batch failed:", err.message);
      continue;
    }

    const results = data.data || [];

    for (const card of results) {
      const item = inventory.find(
        (i) => i.tcgPlayerId && i.tcgPlayerId.toString() === card.tcgplayerId
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
      console.log(
        `  ✓ Updated ${item.name} → $${item.marketPrice.toFixed(
          2
        )} (${item.yourPrice})`
      );
    }
  }

  saveInventory(inventory);

  console.log(`\nDone.`);
  console.log(`Updated items: ${updated}`);
  console.log(`Batch API calls made: ${apiCalls}`);
  console.log(
    `Effective items/request: ${(updated / Math.max(apiCalls, 1)).toFixed(1)}`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
