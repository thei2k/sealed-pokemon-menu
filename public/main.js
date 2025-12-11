// ---- Data fetching & caching ----

const CACHE_KEY = "sealedInventoryCache";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function fetchInventoryFromServer() {
  const res = await fetch("/api/inventory");
  if (!res.ok) {
    throw new Error("Failed to fetch inventory");
  }
  const data = await res.json();

  let items;
  if (Array.isArray(data)) {
    items = data;
  } else if (data && Array.isArray(data.items)) {
    items = data.items;
  } else {
    items = [];
  }

  // Save to cache
  try {
    const payload = {
      timestamp: Date.now(),
      items,
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore cache errors
  }

  return items;
}

function loadInventoryFromCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (
      !payload ||
      !Array.isArray(payload.items) ||
      typeof payload.timestamp !== "number"
    ) {
      return null;
    }
    const age = Date.now() - payload.timestamp;
    if (age > CACHE_TTL_MS) {
      return null;
    }
    return payload.items;
  } catch {
    return null;
  }
}

// ---- Formatting helpers ----

function formatCurrency(value) {
  if (value === null || typeof value !== "number" || Number.isNaN(value)) {
    return "N/A";
  }
  return `$${value.toFixed(2)}`;
}

// ---- Game detection (Pokémon vs Magic) ----

function detectGame(item) {
  const rawGame = (item.game || item.category || "").toLowerCase();
  const text =
    (item.name || "").toLowerCase() + " " + (item.setName || "").toLowerCase();

  // 1) Explicit game field wins, including 'other'
  if (rawGame === "pokemon" || rawGame === "pokémon" || rawGame === "poke") {
    return "pokemon";
  }
  if (rawGame === "mtg" || rawGame === "magic" || rawGame === "magic: the gathering") {
    return "mtg";
  }
  if (rawGame === "other") {
    return "other";
  }

  // 2) Strong Pokémon tells (checked FIRST so bundles don't get mis-classed)
  const strongPokemonKeywords = [
    "pokémon",
    "pokemon",
    "elite trainer box",
    "etb",
    "booster bundle",
    "booster pack bundle",
    "collection box",
    "ex box",
    "v box",
    "vmax box",
    "v-union",
    "mewtwo",
    "charizard",
    "pikachu",
    "paldea",
    "scarlet & violet",
    "scarlet and violet",
    "sv base",
    "paradox rift",
    "obsidian flames",
    "paldea evolved",
    "surging sparks",
    "twilight masquerade",
    "temporal forces",
    "shrouded fable",
    "phantasmal flames",
    "sv ",
  ];

  for (const kw of strongPokemonKeywords) {
    if (text.includes(kw)) {
      return "pokemon";
    }
  }

  // 3) Strong Magic tells (NO generic "bundle" here anymore)
  const strongMtgKeywords = [
    "magic: the gathering",
    " mtg",
    "modern horizons",
    "mh3",
    "commander deck",
    "commander masters",
    "play booster",
    "collector booster",
    "draft booster",
    "set booster",
    "prelease",
    "prerelease",
  ];

  for (const kw of strongMtgKeywords) {
    if (text.includes(kw)) {
      return "mtg";
    }
  }

  // 4) Fallbacks
  if (text.includes(" magic")) return "mtg";

  // 5) Default: assume Pokémon (your main catalog)
  return "pokemon";
}

// ---- Rendering ----

function createProductCard(item) {
  const card = document.createElement("article");
  card.className = "product-card";

  const name = item.name || "Unnamed product";
  const setName = item.setName || "";
  const game = detectGame(item);

  card.dataset.name = name.toLowerCase();
  card.dataset.set = setName.toLowerCase();
  card.dataset.game = game;

  const img = document.createElement("img");
  img.className = "product-image";
  img.alt = name;
  img.loading = "lazy";
  if (item.imageUrl) {
    img.src = item.imageUrl;
  }

  const nameEl = document.createElement("h2");
  nameEl.className = "product-name";
  nameEl.textContent = name;

  const setChip = document.createElement("span");
  setChip.className = "set-chip";
  setChip.textContent = setName || "Unknown set";

  const setEl = document.createElement("p");
  setEl.className = "product-set";
  setEl.textContent = setName;

  const priceRow = document.createElement("p");
  priceRow.className = "product-price-row";
  const yourPrice = formatCurrency(item.yourPrice);
  const marketPrice = formatCurrency(item.marketPrice);
  priceRow.textContent = `Your price: ${yourPrice} · Market: ${marketPrice}`;

  const metaEl = document.createElement("p");
  metaEl.className = "product-meta";
  if (item.lastUpdated) {
    const d = new Date(item.lastUpdated);
    if (!Number.isNaN(d.getTime())) {
      metaEl.textContent =
        "Updated " + d.toLocaleDateString() + " " + d.toLocaleTimeString();
    }
  }

  const elements = [img, nameEl, setChip, setEl, priceRow, metaEl];

  if (item.tcgPlayerUrl) {
    const link = document.createElement("a");
    link.href = item.tcgPlayerUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "product-link";
    link.textContent = "View on TCGplayer";
    elements.push(link);
  }

  elements.forEach((el) => card.appendChild(el));
  return card;
}

function renderInventory(items, state) {
  const grid = document.getElementById("productsGrid");
  const emptyState = document.getElementById("emptyState");

  if (!grid || !emptyState) return;

  grid.innerHTML = "";

  if (!items || items.length === 0) {
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");

  // Group items by inferred game
  const groups = {
    pokemon: [],
    mtg: [],
    other: [],
  };

  items.forEach((item) => {
    const game = detectGame(item);
    if (game === "pokemon") groups.pokemon.push(item);
    else if (game === "mtg") groups.mtg.push(item);
    else groups.other.push(item);
  });

  // Helper: apply sorting to a group
  function sortGroup(list) {
    const sortKey = state.sort;
    const copy = [...list];

    const getSet = (i) => (i.setName || "").toLowerCase();
    const getName = (i) => (i.name || "").toLowerCase();
    const getYourPrice = (i) =>
      typeof i.yourPrice === "number" ? i.yourPrice : null;
    const getUpdated = (i) => {
      const t = Date.parse(i.lastUpdated);
      return Number.isNaN(t) ? null : t;
    };

    copy.sort((a, b) => {
      switch (sortKey) {
        case "name-az": {
          const an = getName(a);
          const bn = getName(b);
          if (an < bn) return -1;
          if (an > bn) return 1;
          return 0;
        }
        case "price-low-high": {
          const ap = getYourPrice(a);
          const bp = getYourPrice(b);
          if (ap === null && bp === null) return 0;
          if (ap === null) return 1;
          if (bp === null) return -1;
          return ap - bp;
        }
        case "price-high-low": {
          const ap2 = getYourPrice(a);
          const bp2 = getYourPrice(b);
          if (ap2 === null && bp2 === null) return 0;
          if (ap2 === null) return 1;
          if (bp2 === null) return -1;
          return bp2 - ap2;
        }
        case "updated-newest": {
          const au = getUpdated(a);
          const bu = getUpdated(b);
          if (au === null && bu === null) return 0;
          if (au === null) return 1;
          if (bu === null) return -1;
          return bu - au;
        }
        case "set-az":
        default: {
          const as = getSet(a);
          const bs = getSet(b);
          if (as < bs) return -1;
          if (as > bs) return 1;

          const an2 = getName(a);
          const bn2 = getName(b);
          if (an2 < bn2) return -1;
          if (an2 > bn2) return 1;
          return 0;
        }
      }
    });

    return copy;
  }

  // Helper to render one group with a title
  function renderGroup(title, list) {
    if (!list.length) return;

    const heading = document.createElement("h2");
    heading.className = "products-group-title";
    heading.textContent = title;
    grid.appendChild(heading);

    const subgrid = document.createElement("div");
    subgrid.className = "products-subgrid";

    const sortedList = sortGroup(list);
    sortedList.forEach((item) => {
      const card = createProductCard(item);
      subgrid.appendChild(card);
    });

    grid.appendChild(subgrid);
  }

  // Order: Pokémon first, then MTG, then other
  if (state.gameFilter === "all" || state.gameFilter === "pokemon") {
    renderGroup("Pokémon Sealed Product", groups.pokemon);
  }
  if (state.gameFilter === "all" || state.gameFilter === "mtg") {
    renderGroup("Magic: The Gathering Sealed Product", groups.mtg);
  }
  if (state.gameFilter === "all" && groups.other.length) {
    renderGroup("Other", groups.other);
  }
}

function computeLastUpdatedText(items) {
  if (!items || items.length === 0) {
    return "Prices last refreshed: N/A";
  }

  const timestamps = items
    .map((i) => Date.parse(i.lastUpdated))
    .filter((t) => !Number.isNaN(t));

  if (!timestamps.length) {
    return "Prices last refreshed: N/A";
  }

  const latest = Math.max(...timestamps);
  const d = new Date(latest);
  return "Prices last refreshed: " + d.toLocaleString();
}

// ---- State & wiring ----

const state = {
  allItems: [],
  gameFilter: "all", // 'all' | 'pokemon' | 'mtg'
  sort: "set-az",
  searchQuery: "",
};

function applyStateAndRender() {
  const { allItems, gameFilter, searchQuery } = state;

  // Filter before grouping
  let items = allItems;

  if (gameFilter !== "all") {
    items = items.filter((item) => detectGame(item) === gameFilter);
  }

  const q = searchQuery.trim().toLowerCase();
  if (q) {
    items = items.filter((item) => {
      const name = (item.name || "").toLowerCase();
      const setName = (item.setName || "").toLowerCase();
      return name.includes(q) || setName.includes(q);
    });
  }

  renderInventory(items, state);

  const lastUpdatedEl = document.getElementById("lastUpdated");
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = computeLastUpdatedText(allItems);
  }
}

async function init() {
  const searchInput = document.getElementById("searchInput");
  const sortSelect = document.getElementById("sortSelect");
  const gameToggle = document.getElementById("gameToggle");
  const lastUpdatedEl = document.getElementById("lastUpdated");

  // 1) Try cache first for instant display
  const cachedItems = loadInventoryFromCache();
  if (cachedItems && cachedItems.length) {
    state.allItems = cachedItems;
    applyStateAndRender();
  }

  // 2) Then fetch fresh data
  try {
    const freshItems = await fetchInventoryFromServer();
    state.allItems = freshItems;
    applyStateAndRender();
  } catch (err) {
    console.error(err);
    if (!cachedItems || !cachedItems.length) {
      if (lastUpdatedEl) {
        lastUpdatedEl.textContent =
          "Error fetching inventory – check server logs.";
      }
    }
  }

  // Search
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      state.searchQuery = e.target.value || "";
      applyStateAndRender();
    });
  }

  // Sort
  if (sortSelect) {
    sortSelect.addEventListener("change", (e) => {
      state.sort = e.target.value;
      applyStateAndRender();
    });
  }

  // Game filter toggles
  if (gameToggle) {
    gameToggle.addEventListener("click", (e) => {
      const btn = e.target.closest(".toggle-btn");
      if (!btn) return;
      const game = btn.getAttribute("data-game");
      if (!game) return;

      state.gameFilter = game;

      // Update active style
      const buttons = gameToggle.querySelectorAll(".toggle-btn");
      buttons.forEach((b) => {
        if (b === btn) {
          b.classList.add("toggle-active");
        } else {
          b.classList.remove("toggle-active");
        }
      });

      applyStateAndRender();
    });
  }
}

document.addEventListener("DOMContentLoaded", init);
