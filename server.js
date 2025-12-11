// server.js - No live JustTCG calls. Serves inventory + admin with Discord stock alerts.

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DISCORD_STOCK_WEBHOOK = process.env.DISCORD_STOCK_WEBHOOK;

const INVENTORY_PATH = path.join(__dirname, "inventory.json");

// Parse JSON bodies for admin POST
app.use(express.json());

// ---------- Helpers ----------

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

function saveInventory(items) {
  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(items, null, 2), "utf8");
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
  const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
  const pass = idx >= 0 ? decoded.slice(idx + 1) : "";

  // User name is ignored; only password matters
  if (pass !== ADMIN_PASSWORD) {
    return res.status(403).send("Forbidden");
  }

  next();
}

// ---------- Routes ----------

// Protect /admin.html explicitly BEFORE static middleware
app.get("/admin.html", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Static frontend (index.html, JS, CSS, etc.)
app.use(express.static(path.join(__dirname, "public")));

// GET /api/inventory – public view (quantity > 0, sorted)
app.get("/api/inventory", (req, res) => {
  const inv = loadInventory();

  const filtered = inv.filter((item) => {
    if (!item) return false;
    const qty = Number(item.quantity);
    return Number.isFinite(qty) && qty > 0;
  });

  const mapped = filtered.map((item) => ({
    name: item.name || "",
    setName: item.setName || null,
    quantity: Number.isFinite(Number(item.quantity))
      ? Number(item.quantity)
      : 0,
    marketPrice:
      typeof item.marketPrice === "number" ? item.marketPrice : null,
    yourPrice: typeof item.yourPrice === "number" ? item.yourPrice : null,
    lastUpdated: item.lastUpdated || null,
    tcgPlayerId: item.tcgPlayerId || null,
    tcgPlayerUrl: item.tcgPlayerId
      ? `https://www.tcgplayer.com/product/${item.tcgPlayerId}`
      : null,
    imageUrl: item.imageUrl || null,
  }));

  mapped.sort((a, b) => {
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

  res.json(mapped);
});

// GET /api/raw-inventory – full JSON for admin
app.get("/api/raw-inventory", requireAdmin, (req, res) => {
  const inv = loadInventory();
  res.json(inv);
});

// POST /api/inventory – admin save + Discord new-stock alert
app.post("/api/inventory", requireAdmin, (req, res) => {
  const payload = req.body;

  if (!Array.isArray(payload)) {
    return res.status(400).json({ error: "Expected an array of items" });
  }

  const oldInventory = loadInventory();

  const existingById = new Map();
  const existingByName = new Map();

  for (const item of oldInventory) {
    if (!item) continue;
    const id = item.tcgPlayerId ? String(item.tcgPlayerId).trim() : "";
    const nameKey = item.name ? item.name.trim().toLowerCase() : "";

    if (id) {
      existingById.set(id, item);
    } else if (nameKey) {
      existingByName.set(nameKey, item);
    }
  }

  const nextInventory = [];
  const newItems = [];

  for (const row of payload) {
    if (!row) continue;

    const nameRaw = row.name || "";
    const idRaw = row.tcgPlayerId || "";
    const qtyRaw = row.quantity;

    const name = nameRaw.trim();
    const tcgId = String(idRaw).trim();
    let quantity = Number(qtyRaw);
    if (!Number.isFinite(quantity) || quantity < 0) quantity = 0;

    // Skip rows that are effectively empty
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
      };
      nextInventory.push(updated);

      if (tcgId) existingById.delete(tcgId);
      if (name) existingByName.delete(name.toLowerCase());
    } else {
      const fresh = {
        name: name || "Unnamed product",
        tcgPlayerId: tcgId || null,
        quantity,
        setName: null,
        marketPrice: null,
        yourPrice: null,
        imageUrl: null,
        lastUpdated: null,
      };
      nextInventory.push(fresh);
      newItems.push(fresh);
    }
  }

  // Items not present in payload are treated as removed on purpose

  saveInventory(nextInventory);

  if (newItems.length && DISCORD_STOCK_WEBHOOK) {
    let header = `📦 New stock added (${newItems.length} items):\n\n`;
    const lines = newItems.map((item) => {
      const base = item.name || "Unnamed product";
      const idPart = item.tcgPlayerId ? ` [${item.tcgPlayerId}]` : "";
      const qtyPart = ` x${item.quantity ?? 0}`;
      return `• ${base}${idPart}${qtyPart}`;
    });
    let body = lines.join("\n");
    if (body.length > 1800) {
      body = body.slice(0, 1800) + "\n… (truncated)";
    }
    sendDiscordMessage(DISCORD_STOCK_WEBHOOK, header + body);
  }

  res.json({
    ok: true,
    totalItems: nextInventory.length,
    newItems: newItems.map((i) => ({
      name: i.name,
      tcgPlayerId: i.tcgPlayerId,
      quantity: i.quantity,
    })),
  });
});

// ---------- Start server ----------

app.listen(PORT, function () {
  console.log("Server running at http://localhost:" + PORT);
});
