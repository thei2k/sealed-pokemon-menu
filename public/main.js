async function fetchInventory() {
  const res = await fetch("/api/inventory");
  if (!res.ok) {
    throw new Error("Failed to fetch inventory");
  }
  const data = await res.json();

  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

function formatCurrency(value) {
  if (value === null || typeof value !== "number" || Number.isNaN(value)) {
    return "N/A";
  }
  return `$${value.toFixed(2)}`;
}

// Try to determine whether an item is Pokémon or Magic
function detectGame(item) {
  const rawGame =
    (item.game || item.category || item.productType || "").toLowerCase();
  const name = (item.name || "").toLowerCase();
  const setName = (item.setName || "").toLowerCase();

  // If we ever start storing it explicitly
  if (rawGame.includes("magic")) return "mtg";
  if (rawGame.includes("pok")) return "pokemon";

  // Heuristics based on naming
  if (
    name.includes("magic: the gathering") ||
    name.includes("mtg") ||
    setName.includes("magic: the gathering")
  ) {
    return "mtg";
  }

  // Default to Pokémon for now (since that's most of your inventory)
  return "pokemon";
}

// Create a single product card DOM element
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

  const elements = [img, nameEl, setEl, priceRow, metaEl];

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

function renderInventory(items) {
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

  // Helper to render one group with a title
  function renderGroup(title, list) {
    if (!list.length) return;

    const heading = document.createElement("h2");
    heading.className = "products-group-title";
    heading.textContent = title;
    grid.appendChild(heading);

    const subgrid = document.createElement("div");
    subgrid.className = "products-subgrid";

    list.forEach((item) => {
      const card = createProductCard(item);
      subgrid.appendChild(card);
    });

    grid.appendChild(subgrid);
  }

  // Order: Pokémon first, then MTG, then any uncategorized stuff
  renderGroup("Pokémon Sealed Product", groups.pokemon);
  renderGroup("Magic: The Gathering Sealed Product", groups.mtg);
  renderGroup("Other", groups.other);
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

function applySearchFilter() {
  const input = document.getElementById("searchInput");
  const query = (input && input.value ? input.value : "").toLowerCase();

  const cards = document.querySelectorAll(".product-card");
  cards.forEach((card) => {
    const name = (card.dataset.name || "").toLowerCase();
    const set = (card.dataset.set || "").toLowerCase();

    if (!query || name.includes(query) || set.includes(query)) {
      card.style.display = "";
    } else {
      card.style.display = "none";
    }
  });
}

async function init() {
  const lastUpdatedEl = document.getElementById("lastUpdated");

  try {
    const items = await fetchInventory();
    renderInventory(items);
    if (lastUpdatedEl) {
      lastUpdatedEl.textContent = computeLastUpdatedText(items);
    }
  } catch (err) {
    console.error(err);
    if (lastUpdatedEl) {
      lastUpdatedEl.textContent =
        "Error fetching inventory – check server logs.";
    }
  }

  const input = document.getElementById("searchInput");
  if (input) {
    input.addEventListener("input", applySearchFilter);
  }
}

document.addEventListener("DOMContentLoaded", init);
