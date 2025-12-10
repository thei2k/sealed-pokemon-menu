// updatePrices.js - run locally to refresh prices into inventory.json

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

function loadInventory() {
  try {
    const raw = fs.readFileSync(INVENTORY_PATH, "utf8");
    return JSON.parse(raw);
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
      Accept: "application/json"
    }
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

  if (!variant || typeof variant.price !== "number") {
    throw new Error("No price found for " + tcgPlayerId);
  }

  return {
    name: card.name,
    setName: card.set_name,
    marketPrice: variant.price
  };
}
const MAX_CALLS_PER_MINUTE = 10;
let apiCallTimestamps = [];

// Wrap JustTCG calls so we never exceed 10 requests per rolling 60 seconds
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

  console.log(
    "Updating prices for",
    inventory.length,
    "items using JustTCG (offline)..."
  );

  for (let i = 0; i < inventory.length; i++) {
    const item = inventory[i];

    if (!item.tcgPlayerId) {
      console.log(
        `[${i + 1}/${inventory.length}] Skipping "${item.name}" (no tcgPlayerId)`
      );
      continue;
    }

    try {
      console.log(
  `[${i + 1}/${inventory.length}] Fetching price for "${item.name}" (TCGplayer ${item.tcgPlayerId})...`
);

const data = await rateLimitedFetchSealedPrice(item.tcgPlayerId);

item.setName = data.setName;
item.marketPrice = data.marketPrice;
// You can override/keep custom images; here we just set a default
if (!item.imageUrl) {
  item.imageUrl = TCG_IMAGE_BASE + item.tcgPlayerId + ".jpg";
}

console.log(
  `  -> Updated: marketPrice = ${data.marketPrice.toFixed(2)}, setName = ${data.setName}`
);

// ❌ REMOVE this; the rate limiter now controls pacing
// await new Promise((resolve) => setTimeout(resolve, 300));

    } catch (err) {
      console.error(
        `[${i + 1}/${inventory.length}] Error updating "${item.name}":`,
        err.message
      );
      // Keep old price if any; just log the problem
    }
  }

  saveInventory(inventory);
  console.log("Done. inventory.json updated with latest prices.");
}

main().catch((err) => {
  console.error("Fatal error in updatePrices.js:", err);
  process.exit(1);
});
