// server.js - No live JustTCG calls.
// Serves inventory + admin with Discord stock alerts.

require("dotenv").config();
const express = require("express");
const path = require("path");

const {
  loadInventoryItems,
  saveInventoryItems,
  normalizeItems,
} = require("./inventoryStore");

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DISCORD_STOCK_WEBHOOK = process.env.DISCORD_STOCK_WEBHOOK;

const INVENTORY_PATH = path.join(__dirname, "inventory.json");

app.use(express.json());

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

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    console.warn("ADMIN_PASSWORD not set; blocking admin access.");
    return res.status(500).send("Admin not configured.");
  }

  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin Area"');
    return res.status(401).send("Authentication required.");
  }

  const base64Part = authHeader.split(" ")[1];
  const decoded = Buffer.from(base64Part, "base64").toString("utf8"); // "user:pass"
  const idx = decoded.indexOf(":");
  const pass = idx >= 0 ? decoded.slice(idx + 1) : "";

  if (pass !== ADMIN_PASSWORD) return res.status(403).send("Forbidden");
  next();
}

app.get("/admin.html", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/inventory", (req, res) => {
  const inv = loadInventoryItems(INVENTORY_PATH);
  const filtered = inv.filter((i) => (i.quantity ?? 0) > 0);

  filtered.sort((a, b) => {
    const setA = (a.setName || "").toLowerCase();
    const setB = (b.setName || "").toLowerCase();
    if (setA < setB) return -1;
    if (setA > setB) return 1;

    const nameA = (a.name || "").toLowerCase();
    const nameB = (b.name || "").toLowerCase();
    if (nameA < nameB) return -1;
    if (nameA > nameB) return 1;
    return 0;
  });

  res.json(filtered);
});

app.get("/api/raw-inventory", requireAdmin, (req, res) => {
  const inv = loadInventoryItems(INVENTORY_PATH);
  res.json(inv);
});

app.post("/api/inventory", requireAdmin, (req, res) => {
  const payload = req.body;

  if (!Array.isArray(payload)) {
    return res.status(400).json({ error: "Expected an array of items" });
  }

  const oldInventory = loadInventoryItems(INVENTORY_PATH);

  const existingById = new Map();
  const existingByName = new Map();

  for (const item of oldInventory) {
    if (!item) continue;
    if (item.tcgPlayerId) existingById.set(String(item.tcgPlayerId), item);
    if (item.name) existingByName.set(String(item.name).toLowerCase(), item);
  }

  const nextInventory = [];
  const newItems = [];

  for (const row of payload) {
    if (!row) continue;

    const name = String(row.name || "").trim();
    const tcgId = String(row.tcgPlayerId || "").trim();

    // allow pricingPercent from admin (optional)
    const pricingRaw = row.pricingPercent;
    let pricingPercent = null;
    if (pricingRaw !== null && pricingRaw !== undefined && pricingRaw !== "") {
      const n = Number(pricingRaw);
      if (Number.isFinite(n)) {
        pricingPercent = Math.max(1, Math.min(200, Math.round(n * 100) / 100));
      }
    }

    let quantity = 0;
    const qtyRaw = row.quantity;
    if (qtyRaw === "" || qtyRaw === null || qtyRaw === undefined) {
      quantity = 0;
    } else {
      const n = Number(qtyRaw);
      quantity = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
    }

    const gameRaw = String(row.game || "").trim().toLowerCase();
    let game = null;
    if (gameRaw === "pokemon" || gameRaw === "pokémon" || gameRaw === "poke") game = "pokemon";
    else if (gameRaw === "magic" || gameRaw === "mtg" || gameRaw === "magic: the gathering") game = "mtg";
    else if (gameRaw === "other" || gameRaw === "misc") game = "other";
    else if (gameRaw) game = gameRaw;

    if (!name && !tcgId) continue;

    let existing =
      (tcgId && existingById.get(tcgId)) ||
      (name && existingByName.get(name.toLowerCase())) ||
      null;

    if (existing) {
      const updated = {
        ...existing,
        name: name || existing.name,
        tcgPlayerId: tcgId || existing.tcgPlayerId,
        quantity,
        game: game !== null ? game : existing.game || null,
      };

      // Only set pricingPercent if provided; otherwise keep whatever existing had
      if (pricingPercent !== null) updated.pricingPercent = pricingPercent;
      if (pricingPercent === null && "pricingPercent" in updated) {
        // leave as-is (do nothing)
      }

      nextInventory.push(updated);

      const wasQty = Number(existing.quantity || 0);
      if (wasQty <= 0 && quantity > 0) newItems.push(updated);
    } else {
      const created = {
        name: name || "Unnamed product",
        tcgPlayerId: tcgId || null,
        quantity,
        game: game || null,
        pricingPercent: pricingPercent !== null ? pricingPercent : null,

        marketPrice: null,
        yourPrice: null,
        lastUpdated: null,
        tcgPlayerUrl: tcgId ? `https://www.tcgplayer.com/product/${tcgId}` : null,
        imageUrl: tcgId ? `https://product-images.tcgplayer.com/fit-in/437x437/${tcgId}.jpg` : null,
      };

      nextInventory.push(created);
      if (quantity > 0) newItems.push(created);
    }
  }

  const normalizedNext = normalizeItems(nextInventory);

  try {
    saveInventoryItems(INVENTORY_PATH, normalizedNext);
  } catch (err) {
    console.error("Failed to save inventory:", err.message || err);
    return res.status(500).json({ error: "Failed to save inventory" });
  }

  if (newItems.length > 0 && DISCORD_STOCK_WEBHOOK) {
    const header = `📦 New stock added! Items: ${newItems.length}\n\n`;
    const lines = newItems.map((item) => {
      const base = item.name || "Unnamed product";
      const idPart = item.tcgPlayerId ? ` [${item.tcgPlayerId}]` : "";
      const qtyPart = ` x${item.quantity ?? 0}`;
      const gamePart = item.game ? ` (${item.game})` : "";
      return `• ${base}${idPart}${qtyPart}${gamePart}`;
    });

    let body = lines.join("\n");
    if (body.length > 1800) body = body.slice(0, 1800) + "\n… (truncated)";
    sendDiscordMessage(DISCORD_STOCK_WEBHOOK, header + body);
  }

  res.json({
    ok: true,
    totalItems: normalizedNext.length,
    newItems: newItems.map((i) => ({
      name: i.name,
      tcgPlayerId: i.tcgPlayerId,
      quantity: i.quantity,
      game: i.game || null,
      pricingPercent: i.pricingPercent ?? null,
    })),
  });
});

app.listen(PORT, function () {
  console.log("Server running at http://localhost:" + PORT);
});
