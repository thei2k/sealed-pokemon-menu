// admin.js – table UI with name / id / quantity / game

const bodyEl = document.getElementById("inventoryBody");
const statusEl = document.getElementById("adminStatus");
const loadBtn = document.getElementById("loadCurrentBtn");
const addRowBtn = document.getElementById("addRowBtn");
const saveBtn = document.getElementById("saveBtn");

function setStatus(message, type) {
  if (!statusEl) return;
  statusEl.textContent = message || "";
  statusEl.className = "status-message" + (type ? " " + type : "");
}

// Create a table row for one item
function createRow(item = {}) {
  const tr = document.createElement("tr");

  // Name
  const nameTd = document.createElement("td");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Product name";
  nameInput.value = item.name || "";
  nameTd.appendChild(nameInput);

  // TCGplayer ID
  const idTd = document.createElement("td");
  const idInput = document.createElement("input");
  idInput.type = "text";
  idInput.placeholder = "TCGplayer ID (e.g. 624679)";
  idInput.value = item.tcgPlayerId || "";
  idTd.appendChild(idInput);

  // Quantity
  const qtyTd = document.createElement("td");
  const qtyInput = document.createElement("input");
  qtyInput.type = "number";
  qtyInput.min = "0";
  qtyInput.step = "1";
  if (
    typeof item.quantity === "number" &&
    !Number.isNaN(item.quantity) &&
    item.quantity > 0
  ) {
    qtyInput.value = item.quantity;
  } else {
    qtyInput.value = "";
  }
  qtyTd.appendChild(qtyInput);

  // Game select
  const gameTd = document.createElement("td");
  const gameSelect = document.createElement("select");

  const options = [
    { value: "", label: "Auto-detect" },
    { value: "pokemon", label: "Pokémon" },
    { value: "mtg", label: "Magic: The Gathering" },
    { value: "other", label: "Other" },
  ];

  options.forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    gameSelect.appendChild(o);
  });

  const currentGame = (item.game || "").toLowerCase();
  if (currentGame === "pokemon") {
    gameSelect.value = "pokemon";
  } else if (currentGame === "mtg" || currentGame === "magic") {
    gameSelect.value = "mtg";
  } else if (currentGame === "other") {
    gameSelect.value = "other";
  } else {
    gameSelect.value = "";
  }

  gameTd.appendChild(gameSelect);

  // Actions
  const actionsTd = document.createElement("td");
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => {
    tr.remove();
  });
  actionsTd.appendChild(removeBtn);

  tr.appendChild(nameTd);
  tr.appendChild(idTd);
  tr.appendChild(qtyTd);
  tr.appendChild(gameTd);
  tr.appendChild(actionsTd);

  return tr;
}

async function loadCurrentInventory() {
  if (!bodyEl) return;

  setStatus("Loading current inventory...", "");
  bodyEl.innerHTML = "";

  try {
    const res = await fetch("/api/raw-inventory");
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const items = Array.isArray(data) ? data : data.items || [];

    if (!items.length) {
      setStatus("No items yet – start adding some.", "");
      bodyEl.appendChild(createRow());
      return;
    }

    items.forEach((item) => {
      bodyEl.appendChild(createRow(item));
    });

    setStatus(`Loaded ${items.length} items.`, "success");
  } catch (err) {
    console.error(err);
    setStatus("Failed to load inventory. Check server logs.", "error");
  }
}

function addEmptyRow() {
  if (!bodyEl) return;
  bodyEl.appendChild(createRow());
}

async function saveInventory() {
  if (!bodyEl) return;

  const rows = bodyEl.querySelectorAll("tr");
  const payload = [];

  rows.forEach((row) => {
    const inputs = row.querySelectorAll("input");
    const select = row.querySelector("select");
    if (inputs.length < 3) return;

    const name = inputs[0].value.trim();
    const tcgPlayerId = inputs[1].value.trim();
    const qtyRaw = inputs[2].value.trim();
    const game = select ? select.value.trim() : "";

    // Skip completely empty rows
    if (!name && !tcgPlayerId && !qtyRaw && !game) {
      return;
    }

    // TCGplayer ID is required to be useful
    if (!tcgPlayerId) {
      return;
    }

    let quantity = Number.parseInt(qtyRaw || "0", 10);
    if (!Number.isFinite(quantity) || quantity < 0) {
      quantity = 0;
    }

    payload.push({
      name: name || "Unnamed product",
      tcgPlayerId,
      quantity,
      game: game || null,
    });
  });

  if (payload.length === 0) {
    setStatus("Nothing to save (no valid rows).", "error");
    return;
  }

  setStatus("Saving inventory...", "");

  try {
    const res = await fetch("/api/inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let json = {};
    try {
      json = await res.json();
    } catch {
      json = {};
    }

    if (!res.ok) {
      throw new Error(json.error || `Save failed (HTTP ${res.status})`);
    }

    const total = json.totalItems ?? payload.length;
    const newCount = (json.newItems && json.newItems.length) || 0;

    setStatus(
      `Save complete. Total items: ${total}${
        newCount ? ` (new: ${newCount})` : ""
      }`,
      "success"
    );
  } catch (err) {
    console.error(err);
    setStatus(`Save failed: ${err.message || err}`, "error");
  }
}

// Wire up buttons
if (loadBtn) {
  loadBtn.addEventListener("click", (e) => {
    e.preventDefault();
    loadCurrentInventory();
  });
}

if (addRowBtn) {
  addRowBtn.addEventListener("click", (e) => {
    e.preventDefault();
    addEmptyRow();
  });
}

if (saveBtn) {
  saveBtn.addEventListener("click", (e) => {
    e.preventDefault();
    saveInventory();
  });
}

// Auto-load on page open
document.addEventListener("DOMContentLoaded", () => {
  if (bodyEl) {
    loadCurrentInventory();
  }
});
