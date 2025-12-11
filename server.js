// server.js - Strategy A: no live JustTCG calls in production, with Discord alerts

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Admin password (for /admin.html and admin APIs)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Discord webhooks (set these in your .env)
const DISCORD_STOCK_WEBHOOK = process.env.DISCORD_STOCK_WEBHOOK; // for new products
const DISCORD_PRICE_WEBHOOK = process.env.DISCORD_PRICE_WEBHOOK; // used in updatePrices.js

// TCGplayer image base – we’ll append the productId + ".jpg"
const TCG_IMAGE_BASE = "https://product-images.tcgplayer.com/fit-in/437x437/";

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
      if (!res.ok) {
        console.error("Discord webhook failed with status", res.status);
      }
    })
    .catch((err) => {
      console.error("Discord webhook error:", err.message || err);
    });
}

/**
 * Admin auth middleware using Basic Auth.
 * Username: admin
 * Password: ADMIN_PASSWORD env var
 */
function requireAdminAuth(req, res, next) {
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
  const parts = decoded.split(":");
  const user = parts[0];
  const pass = parts.slice(1).join(":");

  if (user === "admin" && pass === ADMIN_PASSWORD) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Admin Area"');
  return res.status(401).send("Invalid credentials.");
}

// Protect the admin HTML
app.get("/admin.html", requireAdminAuth, function (req, res) {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Serve static frontend files (index.html, JS, CSS, etc.)
app.use(express.static(path.join(__dirname, "public")));

// ---------- Helpers: inventory file ----------

function loadInventory() {
  try {
    const raw = fs.readFileSync(INVENTORY_PATH, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.items)) return data.items;
    return [];
  } catch (err) {
    console.error("Error reading inventory.json:", err.message);
    return [];
  }
}

function saveInventory(data) {
  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(data, null, 2), "utf8");
}

// ---------- API: inventory with pricing (NO JustTCG; uses inventory.json only) ----------

app.get("/api/inventory", function (req, res) {
  const fullInventory = loadInventory();

  // Only show items with quantity > 0
  const visibleItems = fullInventory.filter(function (item) {
    return item && typeof item.quantity === "number" && item.quantity > 0;
  });

  // 🔹 NEW: sort by setName (A–Z), then by name (A–Z)
  const sortedItems = visibleItems.slice().sort(function (a, b) {
    const setA = (a.setName || "").toLowerCase();
    const setB = (b.setName || "").toLowerCase();
    if (setA !== setB) {
      return setA.localeCompare(setB);
    }

    const nameA = (a.name || "").toLowerCase();
    const nameB = (b.name || "").toLowerCase();
    return nameA.localeCompare(nameB);
  });

  const items = sortedItems.map(function (item) {
    const market =
      typeof item.marketPrice === "number" ? item.marketPrice : null;

    // Prefer stored yourPrice if numeric; otherwise derive from market
    const yourPrice =
      typeof item.yourPrice === "number"
        ? item.yourPrice
        : typeof market === "number"
        ? Number((market * 0.9).toFixed(2))
        : null;

    return {
      name: item.name,
      quantity: item.quantity,
      tcgPlayerId: item.tcgPlayerId,
      setName: item.setName || null,
      marketPrice: market,
      yourPrice: yourPrice,
      imageUrl:
        item.imageUrl ||
        (item.tcgPlayerId
          ? TCG_IMAGE_BASE + item.tcgPlayerId + ".jpg"
          : null),
      tcgPlayerUrl: item.tcgPlayerId
        ? "https://www.tcgplayer.com/product/" + item.tcgPlayerId
        : null,
      // lets frontend compute “Prices last refreshed”
      lastUpdated: item.lastUpdated || null,
    };
  });

  res.json({ items });
});


// ---------- API: admin raw inventory get/save ----------

// Raw inventory for admin UI table (no filtering, full objects)
app.get("/api/raw-inventory", requireAdminAuth, function (req, res) {
  res.json(loadInventory());
});

/**
 * Admin JSON save from /admin.html.
 * We MERGE admin-edited items into existing inventory so we preserve
 * setName / marketPrice / yourPrice / imageUrl / lastUpdated until you refresh via updatePrices.js.
 * Also detects NEW products and sends a Discord alert to the stock channel.
 */
app.post("/api/inventory", requireAdminAuth, function (req, res) {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: "Body must be an array" });
  }

  const existing = loadInventory();
  const byKey = new Map();

  // Use tcgPlayerId as key; fallback to name
  for (const item of existing) {
    if (!item) continue;
    const key = item.tcgPlayerId || item.name;
    if (key) {
      byKey.set(key, item);
    }
  }

  const newItems = [];

  const merged = req.body.map(function (incoming) {
    const key = incoming.tcgPlayerId || incoming.name;
    const old = key ? byKey.get(key) : null;

    const base = {
      name: incoming.name,
      tcgPlayerId: incoming.tcgPlayerId,
      quantity:
        typeof incoming.quantity === "number"
          ? incoming.quantity
          : Number(incoming.quantity) || 0,
    };

    if (old) {
      base.setName = old.setName;
      base.marketPrice = old.marketPrice;
      base.imageUrl = old.imageUrl;
      base.yourPrice = old.yourPrice;
      base.lastUpdated = old.lastUpdated;
    } else {
      newItems.push(base);
    }

    return base;
  });

  saveInventory(merged);
  res.json({ ok: true, count: merged.length });

  // Discord alert for NEW products
  if (newItems.length > 0 && DISCORD_STOCK_WEBHOOK) {
    let header = `🆕 New products added to inventory: ${newItems.length}\n\n`;
    const lines = newItems.map((item) => {
      const idText = item.tcgPlayerId ? ` (TCGplayer ${item.tcgPlayerId})` : "";
      return `• ${item.name}${idText} qty:${item.quantity}`;
    });
    let body = lines.join("\n");
    if (body.length > 1800) {
      body = body.slice(0, 1800) + "\n… (truncated)";
    }
    sendDiscordMessage(DISCORD_STOCK_WEBHOOK, header + body);
  }
});

// ---------- Start server ----------

app.listen(PORT, function () {
  console.log("Server running at http://localhost:" + PORT);
});
