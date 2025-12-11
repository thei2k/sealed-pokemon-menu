const fs = require("fs");

const url = "https://sealed-pokemon-menu.onrender.com/api/inventory";

async function pull() {
  console.log("⏳ Downloading live inventory from Render...");

  const res = await fetch(url); // native fetch in Node 18+
  if (!res.ok) {
    throw new Error(`Failed to download inventory. Status: ${res.status}`);
  }

  const json = await res.json();

  // Support either raw array or { items: [...] }
  let items;
  if (Array.isArray(json)) {
    items = json;
  } else if (json && Array.isArray(json.items)) {
    items = json.items;
  } else {
    throw new Error("Unexpected inventory format from API");
  }

  fs.writeFileSync("./inventory.json", JSON.stringify(items, null, 2), "utf8");

  console.log(
    `✔ inventory.json updated locally with ${items.length} items from server`
  );
}

pull().catch((err) => {
  console.error("❌ Error pulling inventory:", err.message || err);
  process.exit(1);
});
