// server.js - JustTCG version with NO 'await' anywhere

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// JustTCG API settings
const API_BASE = "https://api.justtcg.com/v1";
const API_KEY = process.env.JUSTTCG_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// TCGplayer image base – we’ll append the productId + ".jpg"
const TCG_IMAGE_BASE = "https://product-images.tcgplayer.com/fit-in/437x437/";

// Serve JSON, then protected admin, then static files
app.use(express.json());

const INVENTORY_PATH = path.join(__dirname, "inventory.json");

// ---------- Admin auth middleware ----------

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

// Static frontend files (index.html, JS, CSS, images, etc.)
app.use(express.static(path.join(__dirname, "public")));

// ---------- Helpers: inventory file ----------

function loadInventory() {
  try {
    const raw = fs.readFileSync(INVENTORY_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error reading inventory.json:", err.message);
    return [];
  }
}

function saveInventory(data) {
  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(data, null, 2), "utf8");
}

// ---------- Helper: is cached price fresh (<= 24h) ----------

function isPriceFresh(item) {
  if (!item.lastUpdated) return false;
  try {
    const updatedMs = new Date(item.lastUpdated).getTime();
    if (Number.isNaN(updatedMs)) return false;
    const ageMs = Date.now() - updatedMs;
    const oneDayMs = 24 * 60 * 60 * 1000;
    return ageMs < oneDayMs;
  } catch (e) {
    return false;
  }
}

// ---------- Helper: fetch sealed price from JustTCG (NO await) ----------

function fetchSealedProductByTcgPlayerId(tcgplayerId) {
  const url =
    API_BASE +
    "/cards?tcgplayerId=" +
    encodeURIComponent(tcgplayerId) +
    "&condition=Sealed&include_price_history=false";

  return fetch(url, {
    headers: {
      "x-api-key": API_KEY,
      Accept: "application/json",
    },
  })
    .then((res) => {
      if (!res.ok) {
        return res.text().then((txt) => {
          throw new Error(
            "JustTCG API error " +
              res.status +
              " for " +
              tcgplayerId +
              ": " +
              txt
          );
        });
      }
      return res.json();
    })
    .then((json) => {
      const card = json && json.data && json.data[0];
      if (!card) {
        throw new Error("No sealed product found for " + tcgplayerId);
      }

      let variant =
        (card.variants || []).find(function (v) {
          return v.condition === "Sealed";
        }) || (card.variants || [])[0];

      if (!variant || typeof variant.price !== "number") {
        throw new Error("No price found for " + tcgplayerId);
      }

      return {
        name: card.name,
        setName: card.set_name,
        marketPrice: variant.price,
        // Automatically use TCGplayer image URL based on product id
        imageUrl: TCG_IMAGE_BASE + tcgplayerId + ".jpg",
        tcgPlayerUrl: "https://www.tcgplayer.com/product/" + tcgplayerId,
      };
    });
}

// ---------- API: inventory with pricing (used by main site) ----------

app.get("/api/inventory", function (req, res) {
  const fullInventory = loadInventory();

  // Only show items with quantity > 0 to customers
  const visibleItems = fullInventory.filter(function (item) {
    return item.quantity > 0;
  });

  let cacheUpdated = false;

  Promise.all(
    visibleItems.map(function (item) {
      // Use cached price if fresh
      if (
        item.lastMarketPrice != null &&
        item.lastSetName &&
        isPriceFresh(item)
      ) {
        const market = item.lastMarketPrice;
        const yourPrice =
          typeof market === "number" ? Number((market * 0.9).toFixed(2)) : null;

return Promise.resolve({
  name: item.name,
  quantity: item.quantity,
  tcgPlayerId: item.tcgPlayerId,
  setName: item.lastSetName,
  marketPrice: market,
  yourPrice: yourPrice,
  imageUrl: item.imageUrl || TCG_IMAGE_BASE + item.tcgPlayerId + ".jpg",
  tcgPlayerUrl:
    "https://www.tcgplayer.com/product/" + item.tcgPlayerId,
  lastUpdated: item.lastUpdated || null,
  fromCache: true
});

      }

      // Otherwise fetch fresh data
      return fetchSealedProductByTcgPlayerId(item.tcgPlayerId)
        .then(function (data) {
          const market = data.marketPrice;
          const yourPrice =
            typeof market === "number" ? Number((market * 0.9).toFixed(2)) : null;

          // Update cache on the underlying item
          item.lastMarketPrice = data.marketPrice;
          item.lastSetName = data.setName;
          item.lastUpdated = new Date().toISOString();
          cacheUpdated = true;

          return {
  name: item.name,
  quantity: item.quantity,
  tcgPlayerId: item.tcgPlayerId,
  setName: data.setName,
  marketPrice: market,
  yourPrice: yourPrice,
  imageUrl: item.imageUrl || data.imageUrl,
  tcgPlayerUrl: data.tcgPlayerUrl,
  lastUpdated: item.lastUpdated || null,
  fromCache: false
};

        })
        .catch(function (err) {
          console.error(
            "Error fetching price for " + item.tcgPlayerId + ":",
            err.message
          );
         return {
  name: item.name,
  quantity: item.quantity,
  tcgPlayerId: item.tcgPlayerId,
  setName: item.lastSetName || null,
  marketPrice: item.lastMarketPrice || null,
  yourPrice:
    typeof item.lastMarketPrice === "number"
      ? Number((item.lastMarketPrice * 0.9).toFixed(2))
      : null,
  imageUrl:
    item.imageUrl || TCG_IMAGE_BASE + item.tcgPlayerId + ".jpg",
  tcgPlayerUrl:
    "https://www.tcgplayer.com/product/" + item.tcgPlayerId,
  priceError: err.message,
  lastUpdated: item.lastUpdated || null,
  fromCache: isPriceFresh(item) // best guess
};

        });
    })
  )
    .then(function (results) {
      if (cacheUpdated) {
        try {
          saveInventory(fullInventory);
        } catch (err) {
          console.error("Error saving updated cache to inventory.json:", err);
        }
      }
      res.json({ items: results });
    })
    .catch(function (err) {
      console.error("Error building inventory response:", err);
      res.status(500).json({ error: "Failed to load inventory" });
    });
});

// ---------- API: admin raw inventory get/save ----------

app.get("/api/raw-inventory", requireAdminAuth, function (req, res) {
  res.json(loadInventory());
});

app.post("/api/raw-inventory", requireAdminAuth, function (req, res) {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: "Inventory must be an array" });
  }
  saveInventory(req.body);
  res.json({ ok: true });
});

// ---------- API: admin save via /api/inventory (what admin.js uses) ----------

app.post("/api/inventory", requireAdminAuth, function (req, res) {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: "Body must be an array" });
  }

  saveInventory(req.body);

  res.json({
    ok: true,
    success: true,
    count: req.body.length,
  });
});

// ---------- Start server ----------

app.listen(PORT, function () {
  console.log("Server running at http://localhost:" + PORT);
});
