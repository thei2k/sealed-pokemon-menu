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

// TCGplayer image base – we’ll append the productId + ".jpg"
const TCG_IMAGE_BASE = "https://product-images.tcgplayer.com/fit-in/437x437/";

// Serve static frontend files from /public
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const INVENTORY_PATH = path.join(__dirname, "inventory.json");

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
  // Only send items with quantity > 0 to customers
  const inventory = loadInventory().filter(function (item) {
    return item.quantity > 0;
  });

  Promise.all(
    inventory.map(function (item) {
      return fetchSealedProductByTcgPlayerId(item.tcgPlayerId)
        .then(function (data) {
          const market = data.marketPrice;
          const yourPrice =
            typeof market === "number"
              ? Number((market * 0.9).toFixed(2))
              : null;

          return {
            name: item.name,
            quantity: item.quantity,
            tcgPlayerId: item.tcgPlayerId,
            setName: data.setName,
            marketPrice: market,
            yourPrice: yourPrice,
            // If you ever add imageUrl in inventory.json, it wins;
            // otherwise use the auto-built TCGplayer URL.
            imageUrl: item.imageUrl || data.imageUrl,
            tcgPlayerUrl: data.tcgPlayerUrl,
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
            setName: null,
            marketPrice: null,
            yourPrice: null,
            imageUrl: null,
            tcgPlayerUrl:
              "https://www.tcgplayer.com/product/" + item.tcgPlayerId,
            priceError: err.message,
          };
        });
    })
  )
    .then(function (results) {
      // Keep same shape the frontend expects: { items: [...] }
      res.json({ items: results });
    })
    .catch(function (err) {
      console.error("Error building inventory response:", err);
      res.status(500).json({ error: "Failed to load inventory" });
    });
});

// ---------- API: admin raw inventory get/save ----------

app.get("/api/raw-inventory", function (req, res) {
  res.json(loadInventory());
});

app.post("/api/raw-inventory", function (req, res) {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: "Inventory must be an array" });
  }
  saveInventory(req.body);
  res.json({ ok: true });
});

// ---------- API: admin save via /api/inventory (what admin.js uses) ----------

app.post("/api/inventory", function (req, res) {
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
