// inventoryStore.js
// Phase 1 hardening:
//  1) Inventory schema + normalization (SCHEMA_VERSION)
//  2) Atomic writes (temp + rename)
//  3) Automatic backups (keeps latest MAX_BACKUPS snapshots)
//
// This module is used by server.js and local scripts (updatePrices.js, pullInventory.js, etc.)

const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;

// If you want more/less backups, change this:
const MAX_BACKUPS = 30;

// Allowed item keys for schema lock.
// If you want to add new fields later, add them here intentionally.
const ALLOWED_ITEM_KEYS = new Set([
  "name",
  "setName",
  "quantity",
  "marketPrice",
  "yourPrice",
  "lastUpdated",
  "tcgPlayerId",
  "tcgPlayerUrl",
  "imageUrl",
  "game",
]);

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function toSafeString(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function toInt(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}

function toMoney(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // round to 2 decimals
  return Math.round(n * 100) / 100;
}

function toIsoOrNull(v) {
  if (!isNonEmptyString(v)) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normalizeGame(v) {
  if (!isNonEmptyString(v)) return null;
  const g = v.trim().toLowerCase();
  if (g === "pokémon" || g === "poke") return "pokemon";
  if (g === "magic: the gathering") return "mtg";
  return g;
}

function normalizeItem(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};

  // Lock schema: only keep keys in ALLOWED_ITEM_KEYS
  // (If you want to allow extra keys later, add them to ALLOWED_ITEM_KEYS.)
  const name = toSafeString(src.name);
  const setName = toSafeString(src.setName);
  const tcgPlayerId = toSafeString(src.tcgPlayerId);
  const tcgPlayerUrl = toSafeString(src.tcgPlayerUrl);
  const imageUrl = toSafeString(src.imageUrl);

  out.name = name || "";
  if (setName) out.setName = setName;

  out.quantity = toInt(src.quantity, 0);

  const marketPrice = toMoney(src.marketPrice);
  const yourPrice = toMoney(src.yourPrice);

  if (marketPrice !== null) out.marketPrice = marketPrice;
  if (yourPrice !== null) out.yourPrice = yourPrice;

  const lastUpdated = toIsoOrNull(src.lastUpdated);
  if (lastUpdated) out.lastUpdated = lastUpdated;

  if (tcgPlayerId) out.tcgPlayerId = tcgPlayerId;
  if (tcgPlayerUrl) out.tcgPlayerUrl = tcgPlayerUrl;
  if (imageUrl) out.imageUrl = imageUrl;

  const game = normalizeGame(src.game);
  if (game) out.game = game;

  // Ensure we didn't accidentally include other keys
  for (const k of Object.keys(out)) {
    if (!ALLOWED_ITEM_KEYS.has(k)) delete out[k];
  }

  return out;
}

function normalizeItems(items) {
  const arr = Array.isArray(items) ? items : [];
  const normalized = arr
    .map((it) => normalizeItem(it))
    // Drop truly empty rows (no name and no tcgPlayerId)
    .filter((it) => isNonEmptyString(it.name) || isNonEmptyString(it.tcgPlayerId));
  return normalized;
}

function readInventoryFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);

    // Accept either:
    //  - [ ...items ]
    //  - { schemaVersion, updatedAt, items: [ ... ] }
    if (Array.isArray(parsed)) {
      return { meta: { schemaVersion: 0, updatedAt: null }, items: normalizeItems(parsed) };
    }

    if (parsed && Array.isArray(parsed.items)) {
      const meta = {
        schemaVersion: Number(parsed.schemaVersion) || 0,
        updatedAt: isNonEmptyString(parsed.updatedAt) ? parsed.updatedAt : null,
      };
      return { meta, items: normalizeItems(parsed.items) };
    }

    return { meta: { schemaVersion: 0, updatedAt: null }, items: [] };
  } catch (err) {
    // File missing is not fatal; return empty
    if (err && err.code === "ENOENT") {
      return { meta: { schemaVersion: 0, updatedAt: null }, items: [] };
    }
    console.error("Error reading inventory file:", err.message || err);
    return { meta: { schemaVersion: 0, updatedAt: null }, items: [] };
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function timestampForFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function listBackups(backupsDir) {
  if (!fs.existsSync(backupsDir)) return [];
  return fs
    .readdirSync(backupsDir)
    .filter((f) => f.startsWith("inventory-") && f.endsWith(".json"))
    .map((f) => {
      const full = path.join(backupsDir, f);
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        stat = null;
      }
      return { file: f, full, mtimeMs: stat ? stat.mtimeMs : 0 };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function pruneBackups(backupsDir, maxKeep = MAX_BACKUPS) {
  const backups = listBackups(backupsDir);
  if (backups.length <= maxKeep) return;

  for (const b of backups.slice(maxKeep)) {
    try {
      fs.unlinkSync(b.full);
    } catch (err) {
      console.warn("Failed to delete old backup:", b.full, err.message || err);
    }
  }
}

function makeBackupIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;

    const backupsDir = path.join(path.dirname(filePath), "backups");
    ensureDir(backupsDir);

    const stamp = timestampForFilename(new Date());
    const backupPath = path.join(backupsDir, `inventory-${stamp}.json`);
    fs.copyFileSync(filePath, backupPath);

    pruneBackups(backupsDir);
  } catch (err) {
    console.warn("Backup failed (continuing anyway):", err.message || err);
  }
}

function atomicWriteFileSync(filePath, dataUtf8) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `${base}.tmp-${process.pid}-${Date.now()}`);

  // Write temp then rename over target (atomic on same filesystem)
  fs.writeFileSync(tmp, dataUtf8, "utf8");
  fs.renameSync(tmp, filePath);
}

function writeInventoryFile(filePath, items) {
  const normalizedItems = normalizeItems(items);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    totalItems: normalizedItems.length,
    items: normalizedItems,
  };

  // Backup current file before overwriting
  makeBackupIfExists(filePath);

  // Atomic write
  atomicWriteFileSync(filePath, JSON.stringify(payload, null, 2));
  return payload;
}

// Convenience wrappers (most callers just want the items array)
function loadInventoryItems(filePath) {
  return readInventoryFile(filePath).items;
}

function saveInventoryItems(filePath, items) {
  return writeInventoryFile(filePath, items);
}

module.exports = {
  SCHEMA_VERSION,
  loadInventoryItems,
  saveInventoryItems,
  readInventoryFile,
  writeInventoryFile,
  normalizeItems,
  normalizeItem,
};
