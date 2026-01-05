// pullInventory.js
// Downloads live inventory from your deployed server and saves it locally.
//
// Phase 1 hardening note:
// We save using inventoryStore.js so the local inventory.json is always:
//  - schemaVersion'd
//  - normalized
//  - written atomically
//  - backed up automatically

const path = require("path");
const { saveInventoryItems } = require("./inventoryStore");

const url = "https://sealed-pokemon-menu.onrender.com/api/inventory";
const INVENTORY_PATH = path.join(__dirname, "inventory.json");

async function pull() {
  console.log("⏳ Downloading live inventory from Render...");

  const res = await fetch(url); // native fetch in Node 18+
  if (!res.ok) {
    throw new Error(`Failed to download inventory. Status: ${res.status}`);
  }

  const json = await res.json();

  // Support either raw array or { items: [...] }
  let items = null;
  if (Array.isArray(json)) {
    items = json;
  } else if (json && Array.isArray(json.items)) {
    items = json.items;
  } else {
    throw new Error("Unexpected inventory format from API");
  }

  saveInventoryItems(INVENTORY_PATH, items);

  console.log(
    `✔ inventory.json updated locally with ${items.length} items from server`
  );
}

pull().catch((err) => {
  console.error("❌ Error pulling inventory:", err.message || err);
  process.exit(1);
});
