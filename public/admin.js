// admin.js – table UI, no JSON editing

const bodyEl = document.getElementById("inventoryBody");
const statusEl = document.getElementById("adminStatus");
const loadBtn = document.getElementById("loadCurrentBtn");
const addRowBtn = document.getElementById("addRowBtn");
const saveBtn = document.getElementById("saveBtn");

function setStatus(message, type) {
  statusEl.textContent = message || "";
  statusEl.className = "status-message" + (type ? " " + type : "");
}

// Create a table row for one item
function createRow(item = {}) {
  const tr = document.createElement("tr");

  const nameTd = document.createElement("td");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Product name";
  nameInput.value = item.name || "";
  nameTd.appendChild(nameInput);

  const idTd = document.createElement("td");
  const idInput = document.createElement("input");
  idInput.type = "text";
  idInput.placeholder = "TCGplayer ID (e.g. 624679)";
  idInput.value = item.tcgPlayerId || "";
  idTd.appendChild(idInput);

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
      // Add one empty row for convenience
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
    if (inputs.length < 3) return;

    const name = inputs[0].value.trim();
    const tcgPlayerId = inputs[1].value.trim();
    const qtyRaw = inputs[2].value.trim();

    // Skip completely empty rows
    if (!name && !tcgPlayerId && !qtyRaw) {
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
