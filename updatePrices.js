// updatePrices.js - BATCH VERSION with Discord alerts
// - Uses POST /v1/cards with up to 100 tcgplayerIds per request
// - Only updates items you actually own (quantity > 0)
// - Skips items updated in the last 24 hours (unless --force)
// - Sends a summary Discord message when prices update
//
// IMPORTANT: JustTCG auth uses `x-api-key` header (NOT Authorization: Bearer).

require("dotenv").config();
const path = require("path");

const { loadInventoryItems, saveInventoryItems } = require("./inventoryStore");

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

const MAX_BATCH_CALLS_PER_MIN = 25;
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
      if (!res.ok) console.error("Discord webhook failed with status", res.status);
    })
    .catch((err) => console.error("Discord webhook error:", err.message || err));
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
      "Content-Type": "application/json",
      "x-api-key": API_KEY, // ✅ correct JustTCG auth header
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `JustTCG batch request failed: ${res.status} ${res.statusText} ${text}`
    );
  }

  return res.json();
}

function shouldSkipByCooldown(item, cooldownMs) {
  if (!item || !item.lastUpdated) return false;
  const t = Date.parse(item.lastUpdated);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < cooldownMs;
}

async function main() {
  const force = process.argv.includes("--force");

  const inventory = loadInventoryItems(INVENTORY_PATH);

  // Only update items you own and have tcgPlayerId
  const owned = inventory.filter((i) => (i.quantity ?? 0) > 0 && i.tcgPlayerId);

  const cooldownMs = 24 * 60 * 60 * 1000;
  const toUpdate = force ? owned : owned.filter((i) => !shouldSkipByCooldown(i, cooldownMs));

  console.log(
    `Inventory loaded: ${inventory.length} items. Owned w/ID: ${owned.length}. Updating: ${toUpdate.length}. (force=${force})`
  );

  // Batch into chunks of 100 tcgplayerIds
  const ids = toUpdate.map((i) => String(i.tcgPlayerId));
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));

  let updated = 0;
  const priceUpdateLines = [];

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    console.log(`\nBatch ${c + 1}/${chunks.length} (${chunk.length} ids)`);

    let result;
    try {
      result = await rateLimitedBatchFetch({ tcgplayerIds: chunk });
    } catch (err) {
      console.error("Batch failed:", err.message || err);
      continue;
    }

    let cards = [];
    if (Array.isArray(result)) cards = result;
    else if (result && Array.isArray(result.data)) cards = result.data;
    else {
      console.error("Unexpected API response format. Expected array or { data: [...] }.");
      console.error("Raw response keys:", result && Object.keys(result));
      continue;
    }

    // Map by tcgplayerId for fast lookup
    const byId = new Map();
    for (const card of cards) {
      if (!card || !card.tcgplayerId) continue;
      byId.set(String(card.tcgplayerId), card);
    }

    for (const item of toUpdate) {
      if (!item || !item.tcgPlayerId) continue;
      const card = byId.get(String(item.tcgPlayerId));
      if (!card) continue;

      const market = Number(card?.marketPrice);
      if (!Number.isFinite(market) || market <= 0) continue;

      // Your price = 90% of market (your existing logic)
      const your = Math.round(market * 0.9 * 100) / 100;

      const changed =
        item.marketPrice !== market || item.yourPrice !== your || !item.lastUpdated;

      if (changed) {
        item.marketPrice = Math.round(market * 100) / 100;
        item.yourPrice = your;
        item.lastUpdated = new Date().toISOString();

        if (!item.imageUrl && item.tcgPlayerId) {
          item.imageUrl = TCG_IMAGE_BASE + item.tcgPlayerId + ".jpg";
        }

        updated++;
        const line = `• ${item.name} → $${item.yourPrice.toFixed(2)} (market $${item.marketPrice.toFixed(
          2
        )}) qty:${item.quantity ?? 0}`;
        console.log("  " + line);
        priceUpdateLines.push(line);
      }
    }
  }

  // Save inventory (schema + atomic + backup)
  saveInventoryItems(INVENTORY_PATH, inventory);

  console.log(`\n✅ Updated ${updated} items.`);

  // Discord alert for price updates
  if (updated > 0 && DISCORD_PRICE_WEBHOOK) {
    let header = `📈 Price update completed.\nUpdated items: ${updated}\n\n`;
    let body = priceUpdateLines.join("\n");
    if (body.length > 1800) body = body.slice(0, 1800) + "\n… (truncated)";
    sendDiscordMessage(DISCORD_PRICE_WEBHOOK, header + body);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
