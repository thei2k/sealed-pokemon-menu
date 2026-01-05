// admin.js – table UI with name / id / quantity / game / pricingPercent
// + Export Collectr CSV (TCGplayer import format)

const bodyEl = document.getElementById("inventoryBody");
const statusEl = document.getElementById("adminStatus");
const loadBtn = document.getElementById("loadCurrentBtn");
const addRowBtn = document.getElementById("addRowBtn");
const saveBtn = document.getElementById("saveBtn");
const exportBtn = document.getElementById("exportCollectrBtn");

const DEFAULT_PRICING_PERCENT = 90;

function setStatus(message, type) {
  if (!statusEl) return;
  statusEl.textContent = message || "";
  statusEl.className = "status-message" + (type ? " " + type : "");
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function createRow(item = {}) {
  const tr = document.createElement("tr");
  tr.dataset.setName = item.setName || "";

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
  qtyInput.value =
    typeof item.quantity === "number" && Number.isFinite(item.quantity) && item.quantity > 0
      ? item.quantity
      : "";
  qtyTd.appendChild(qtyInput);

  // Game
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
  if (currentGame === "pokemon") gameSelect.value = "pokemon";
  else if (currentGame === "mtg" || currentGame === "magic") gameSelect.value = "mtg";
  else if (currentGame === "other") gameSelect.value = "other";
  else gameSelect.value = "";

  gameTd.appendChild(gameSelect);

  // Pricing %
  const pricingTd = document.createElement("td");
  const pricingInput = document.createElement("input");
  pricingInput.type = "number";
  pricingInput.min = "1";
  pricingInput.max = "200";
  pricingInput.step = "0.1";
  pricingInput.placeholder = `${DEFAULT_PRICING_PERCENT} (default)`;
  pricingInput.value =
    item.pricingPercent !== null && item.pricingPercent !== undefined && item.pricingPercent !== ""
      ? item.pricingPercent
      : "";
  pricingTd.appendChild(pricingInput);

  // Actions
  const actionsTd = document.createElement("td");
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => tr.remove());
  actionsTd.appendChild(removeBtn);

  tr.appendChild(nameTd);
  tr.appendChild(idTd);
  tr.appendChild(qtyTd);
  tr.appendChild(gameTd);
  tr.appendChild(pricingTd);
  tr.appendChild(actionsTd);

  return tr;
}

async function loadCurrentInventory() {
  if (!bodyEl) return;
  setStatus("Loading current inventory...", "");
  bodyEl.innerHTML = "";

  try {
    const res = await fetch("/api/raw-inventory");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = Array.isArray(data) ? data : data.items || [];

    if (!items.length) {
      setStatus("No items yet – start adding some.", "");
      bodyEl.appendChild(createRow());
      return;
    }

    items.forEach((item) => bodyEl.appendChild(createRow(item)));
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
    if (inputs.length < 4) return;

    const name = inputs[0].value.trim();
    const tcgPlayerId = inputs[1].value.trim();
    const qtyRaw = inputs[2].value.trim();
    const pricingRaw = inputs[3].value.trim();
    const game = select ? select.value.trim() : "";

    if (!name && !tcgPlayerId && !qtyRaw && !game && !pricingRaw) return;
    if (!tcgPlayerId) return;

    let quantity = Number.parseInt(qtyRaw || "0", 10);
    if (!Number.isFinite(quantity) || quantity < 0) quantity = 0;

    let pricingPercent = null;
    if (pricingRaw !== "") {
      const n = Number(pricingRaw);
      if (Number.isFinite(n)) pricingPercent = n;
    }

    payload.push({
      name: name || "Unnamed product",
      tcgPlayerId,
      quantity,
      game: game || null,
      pricingPercent, // null means "use default"
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

    if (!res.ok) throw new Error(json.error || `Save failed (HTTP ${res.status})`);

    const total = json.totalItems ?? payload.length;
    setStatus(`Save complete. Total items: ${total}`, "success");
  } catch (err) {
    console.error(err);
    setStatus(`Save failed: ${err.message || err}`, "error");
  }
}

function getRowsForExport() {
  const rows = bodyEl.querySelectorAll("tr");
  const out = [];

  rows.forEach((row) => {
    const inputs = row.querySelectorAll("input");
    if (inputs.length < 4) return;

    const name = inputs[0].value.trim();
    const tcgPlayerId = inputs[1].value.trim();
    const qtyRaw = inputs[2].value.trim();

    if (!name && !tcgPlayerId && !qtyRaw) return;
    if (!tcgPlayerId) return;

    let quantity = Number.parseInt(qtyRaw || "0", 10);
    if (!Number.isFinite(quantity) || quantity < 0) quantity = 0;
    if (quantity <= 0) return;

    out.push({
      name: name || "Unnamed product",
      tcgPlayerId,
      quantity,
      setName: row.dataset.setName || "",
    });
  });

  return out;
}

function downloadTextFile(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportCollectrCsv() {
  if (!bodyEl) return;

  const items = getRowsForExport();
  if (items.length === 0) {
    setStatus("Nothing to export (need qty > 0 and TCGplayer ID).", "error");
    return;
  }

  const headers = [
    "Quantity",
    "Name",
    "Simple Name",
    "Set",
    "Card Number",
    "Set Code",
    "Printing",
    "Condition",
    "Language",
    "Rarity",
    "Product ID",
  ];

  const lines = [];
  lines.push(headers.map(csvEscape).join(","));

  for (const it of items) {
    const row = {
      Quantity: it.quantity,
      Name: it.name,
      "Simple Name": it.name,
      Set: it.setName || "",
      "Card Number": "",
      "Set Code": "",
      Printing: "Normal",
      Condition: "Sealed",
      Language: "English",
      Rarity: "",
      "Product ID": it.tcgPlayerId,
    };
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }

  const csv = lines.join("\n");
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  downloadTextFile(`collectr-import-${stamp}.csv`, csv, "text/csv");
  setStatus(`Exported Collectr CSV (${items.length} rows).`, "success");
}

if (loadBtn) loadBtn.addEventListener("click", (e) => (e.preventDefault(), loadCurrentInventory()));
if (addRowBtn) addRowBtn.addEventListener("click", (e) => (e.preventDefault(), addEmptyRow()));
if (saveBtn) saveBtn.addEventListener("click", (e) => (e.preventDefault(), saveInventory()));
if (exportBtn) exportBtn.addEventListener("click", (e) => (e.preventDefault(), exportCollectrCsv()));

document.addEventListener("DOMContentLoaded", () => {
  if (bodyEl) loadCurrentInventory();
});
