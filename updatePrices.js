// updatePrices.js - run locally to refresh prices into inventory.json
// Optimized for low JustTCG usage:
// - Only updates items you actually own (quantity > 0)
// - Skips items updated in the last 24 hours
// - Rate-limited to 10 calls/min by default

require("dotenv").config();
const fs = require("fs");
const path = require("path");

if (typeof fetch !== "function") {
  console.error(
    "Your Node.js version does not have global fetch. Please use Node 18+."
  );
  process.exit(1);
}

const API_BASE = "https://api.justtcg.com/v1";
const API_KEY = process.env.JUSTTCG_API_KEY;
const TCG_IMAGE_BASE = "https://product-images.tcgplayer.com/fit-in/437x437/";

if (!API_KEY) {
  console.error("JUSTTCG_API_KEY is not set in your .env file.");
  process.exit(1);
}

const INVENTORY_PATH = path.join(__dirname, "inventory.json");

// Be conservative on rate limit to avoid 429s.
// If you're 100% sure your plan allows 50/min, you can safely bump this to 20 or 30.
const MAX_CALLS_PER_MINUTE = 10;
let apiCallTimestamps = [];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function loadInventory() {
  try {
    const raw = fs.readFileSync(INVENTORY_PATH, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      return data;
    }
    if (data && Array.isArray(data.items)) {
      return data.items;
    }
    console.warn("inventory.json was not an array; defaulting to []");
    return [];
  } catch (err) {
    console.error("Error reading inventory.json:", err.message);
    process.exit(1);
  }
}

function saveInventory(data) {
  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(data, null, 2), "utf8");
}

async function fetchSealedPrice(tcgPlayerId) {
  const url =
    API_BASE +
    "/cards?tcgplayerId=" +
    encodeURIComponent(tcgPlayerId) +
    "&condition=Sealed&include_price_history=false";

  const res = await fetch(url, {
    headers: {
      "x-api-key": API_KEY,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(
      "JustTCG API error " +
        res.status +
        " for " +
        tcgPlayerId +
        ": " +
        txt
    );
  }

  const json = await res.json();
  const card = json && json.data && json.data[0];
  if (!card) {
    throw new Error("No sealed product found for " + tcgPlayerId);
  }

  let variant =
    (card.variants || []).find(function (v) {
      return v.condition === "Sealed";
    }) || (card.variants || [])[0];

  if (!variant || variant.price == null) {
    throw new Error("No price found for " + tcgPlayerId);
  }

  const price = Number(variant.price);
  if (!Number.isFinite(price)) {
    throw new Error("Invalid numeric price for " + tcgPlayerId);
  }

  return {
    name: card.name,
    setName: card.set_name,
    marketPrice: price,
  };
}

// Wrap JustTCG calls so we never exceed MAX_CALLS_PER_MINUTE per rolling 60 seconds
async function rateLimitedFetchSealedPrice(tcgPlayerId) {
  const now = Date.now();

  // Keep only timestamps from the last 60 seconds
  apiCallTimestamps = apiCallTimestamps.filter((ts) => now - ts < 60_000);

  if (apiCallTimestamps.length >= MAX_CALLS_PER_MINUTE) {
    const earliest = apiCallTimestamps[0];
    const waitMs = 60_000 - (now - earliest) + 50; // +50ms safety buffer
    const waitSeconds = Math.ceil(waitMs / 1000);

    console.log(
      `Rate limiter: waiting ${waitSeconds}s before next JustTCG API call...`
    );

    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  apiCallTimestamps.push(Date.now());
  return fetchSealedPrice(tcgPlayerId);
}

async function main() {
  const inventory = loadInventory();
  const now = Date.now();

  // Decide which items we actually want to hit JustTCG for:
  // - must have a tcgPlayerId
  // - quantity > 0 (you actually own it)
  // - either never updated OR lastUpdated is older than 24 hours
  const itemsToUpdate = inventory.filter((item) => {
    if (!item || !item.tcgPlayerId) return false;
    if (typeof item.quantity !== "number" || item.quantity <= 0) return false;

    if (item.lastUpdated) {
      const t = Date.parse(item.lastUpdated);
      if (!Number.isNaN(t)) {
        const age = now - t;
        if (age < ONE_DAY_MS) {
          // Already updated in the last 24 hours – skip to save API calls
          return false;
        }
      }
    }

    return true;
  });

  console.log(
    "Total items in inventory:",
    inventory.length
  );
  console.log(
    "Items eligible for price update (qty > 0 and not updated in last 24h):",
    itemsToUpdate.length
  );

  let successfulUpdates = 0;
  let apiCallsMade = 0;

  for (let i = 0; i < itemsToUpdate.length; i++) {
    const item = itemsToUpdate[i];

    try {
      console.log(
        `[${i + 1}/${itemsToUpdate.length}] Fetching price for "${item.name}" (TCGplayer ${item.tcgPlayerId})...`
      );

      const data = await rateLimitedFetchSealedPrice(item.tcgPlayerId);
      apiCallsMade++;

      item.setName = data.setName;
      item.marketPrice = data.marketPrice;

      // Explicitly store your 90% price as well
      item.yourPrice = Number((data.marketPrice * 0.9).toFixed(2));

      // Stamp when this item's price was last refreshed
      item.lastUpdated = new Date().toISOString();

      // Default image if missing
      if (!item.imageUrl) {
        item.imageUrl = TCG_IMAGE_BASE + item.tcgPlayerId + ".jpg";
      }

      console.log(
        `  -> Updated: marketPrice = ${item.marketPrice.toFixed(
          2
        )}, yourPrice = ${item.yourPrice.toFixed(
          2
        )}, setName = ${item.setName}, lastUpdated = ${item.lastUpdated}`
      );

      successfulUpdates++;
    } catch (err) {
      console.error(
        `  !! Error updating "${item.name}":`,
        err.message || err
      );
      // Keep old price if any; just log the problem
    }
  }

  saveInventory(inventory);

  console.log(
    `Done. ${successfulUpdates} items updated, ${apiCallsMade} JustTCG calls made.`
  );
  console.log(
    "Remember: running this once per day keeps you within your 10k/month cap as long as:",
  );
  console.log(
    "  (itemsToUpdate_per_day * 30 days) <= 10,000"
  );
}

main().catch((err) => {
  console.error("Fatal error in updatePrices.js:", err);
  process.exit(1);
});
