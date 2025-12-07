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
function createRow(item) {
  const tr = document.createElement("tr");

  const nameTd = document.createElement("td");
  const idTd = document.createElement("td");
  const qtyTd = document.createElement("td");
  const actionsTd = document.createElement("td");

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "admin-input";
  nameInput.placeholder = "e.g. Temporal Forces Booster Box";
  nameInput.value = item?.name || "";

  const idInput = document.createElement("input");
  idInput.type = "text";
  idInput.className = "admin-input";
  idInput.placeholder = "e.g. 624679";
  idInput.value = item?.tcgPlayerId || "";

  const qtyInput = document.createElement("input");
  qtyInput.type = "number";
  qtyInput.className = "admin-input";
  qtyInput.min = "0";
  qtyInput.step = "1";
  qtyInput.placeholder = "0";
  qtyInput.value =
    typeof item?.quantity === "number" ? String(item.quantity) : "";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => {
    tr.remove();
  });

  nameTd.appendChild(nameInput);
  idTd.appendChild(idInput);
  qtyTd.appendChild(qtyInput);
  actionsTd.appendChild(removeBtn);

  tr.appendChild(nameTd);
  tr.appendChild(idTd);
  tr.appendChild(qtyTd);
  tr.appendChild(actionsTd);

  bodyEl.appendChild(tr);
}

// Load existing inventory from server
function loadCurrentInventory() {
  setStatus("Loading current inventory...", "");

  fetch("/api/raw-inventory")
    .then((res) => {
      if (!res.ok) throw new Error("Failed to load inventory");
      return res.json();
    })
    .then((items) => {
      bodyEl.innerHTML = "";
      if (!Array.isArray(items) || items.length === 0) {
        // Start with one empty row if nothing yet
        createRow({});
      } else {
        items.forEach((item) => createRow(item));
      }
      setStatus("Loaded current inventory.", "success");
    })
    .catch((err) => {
      console.error(err);
      setStatus("Error loading inventory.", "error");
    });
}

// Collect data from table and send to server
function saveInventory() {
  const rows = Array.from(bodyEl.querySelectorAll("tr"));
  const payload = [];

  rows.forEach((row) => {
    const inputs = row.querySelectorAll("input");
    const name = inputs[0].value.trim();
    const tcgPlayerId = inputs[1].value.trim();
    const qtyRaw = inputs[2].value.trim();

    // Skip completely empty rows
    if (!name && !tcgPlayerId && !qtyRaw) {
      return;
    }

    if (!tcgPlayerId) {
      // TCGplayer ID is required to be useful
      return;
    }

    const quantity = Number.parseInt(qtyRaw || "0", 10);
    payload.push({
      name: name || "Unnamed product",
      tcgPlayerId,
      quantity: Number.isNaN(quantity) ? 0 : quantity,
    });
  });

  if (payload.length === 0) {
    setStatus("Nothing to save (no valid rows).", "error");
    return;
  }

  setStatus("Saving inventory...", "");

  fetch("/api/inventory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((res) => res.json().then((json) => ({ ok: res.ok, json })))
    .then(({ ok, json }) => {
      if (!ok) {
        throw new Error(json.error || "Save failed");
      }
      setStatus(`Saved ${payload.length} items.`, "success");
    })
    .catch((err) => {
      console.error(err);
      setStatus("Error saving inventory.", "error");
    });
}

// Add an empty row
function addRow() {
  createRow({});
}

// Wire up buttons
loadBtn.addEventListener("click", loadCurrentInventory);
addRowBtn.addEventListener("click", addRow);
saveBtn.addEventListener("click", saveInventory);

// On first load, start with one blank row
document.addEventListener("DOMContentLoaded", () => {
  createRow({});
});
