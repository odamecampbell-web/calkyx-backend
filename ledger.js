/**
 * LEDGER — append-only Cash Flow Log
 * ====================================
 * Per Stage 3, §3.3: this file is the single source of truth. Nothing is
 * ever edited or deleted, only appended. All derived state (positions,
 * NAV, balances) is rebuilt FROM this log — which is exactly what makes
 * it independently reconcilable and audit-safe (Stage 5, §5.0).
 */
const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "data", "cashflow-log.jsonl");

function ensureLogExists() {
  if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, "");
}

// Append one immutable event. Never modifies prior lines.
function appendEvent(event) {
  ensureLogExists();
  const record = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(LOG_PATH, JSON.stringify(record) + "\n");
  return record;
}

// Read every event ever recorded, in order.
function readAllEvents() {
  ensureLogExists();
  const raw = fs.readFileSync(LOG_PATH, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map(line => JSON.parse(line));
}

module.exports = { appendEvent, readAllEvents, LOG_PATH };
