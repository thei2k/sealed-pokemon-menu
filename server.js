// server.js - Strategy A: no live JustTCG calls in production
// All prices are served from inventory.json. You refresh them offline with updatePrices.js.

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Admin password (for /admin.html and admin APIs)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// TCGplayer image base – we’ll append the productId + ".jpg"
const TCG_IMAGE_BASE = "https://product-images.tcgplayer.com/fit-in/437x437/";

const INVENTORY_PATH = path.join(__dirname, "inventory.json");

app.use(express.json());

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

// ---------- Inventory helpers ----------

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

  const items = visibleItems.map(function (item) {
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
      // Expose lastUpdated so the frontend can display “Prices last refreshed”
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

  const merged = req.body.map(function (incoming) {
    const key = incoming.tcgPlayerId || incoming.name;
    const old = key ? byKey.get(key) : null;

    const base = {
      name: incoming.name,
      tcgPlayerId: incoming.tcgPlayerId,
      quantity: incoming.quantity,
    };

    if (old) {
      base.setName = old.setName;
      base.marketPrice = old.marketPrice;
      base.imageUrl = old.imageUrl;
      base.yourPrice = old.yourPrice;
      base.lastUpdated = old.lastUpdated;
    }

    return base;
  });

  saveInventory(merged);
  res.json({ ok: true, count: merged.length });
});

// (Optional: if you ever want to overwrite inventory.json directly)
// app.post("/api/raw-inventory", requireAdminAuth, function (req, res) {
//   if (!Array.isArray(req.body)) {
//     return res.status(400).json({ error: "Inventory must be an array" });
//   }
//   saveInventory(req.body);
//   res.json({ ok: true });
// });

// ---------- Start server ----------

app.listen(PORT, function () {
  console.log("Server running at http://localhost:" + PORT);
});
