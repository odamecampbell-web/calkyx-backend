/**
 * ENGINE — rebuilds current state entirely from the Cash Flow Log
 * ===================================================================
 * This is the "derived/cached table that can always be rebuilt from
 * the log" described in Stage 3 §3.3. Nothing here is a separate
 * mutable source of truth — it's all computed fresh from events.
 */
const { readAllEvents, appendEvent } = require("./ledger");

const TIERS = [
  { name: "Emerging", min: 0, max: 100_000, share: 0.15 },
  { name: "Established", min: 100_000, max: 1_000_000, share: 0.16 },
  { name: "Elite", min: 1_000_000, max: 5_000_000, share: 0.175 },
  { name: "Institutional", min: 5_000_000, max: Infinity, share: 0.18 },
];
function tierFor(aum) {
  return TIERS.find(t => aum >= t.min && aum < t.max) || TIERS[TIERS.length - 1];
}

const fs = require("fs");
const path = require("path");
const REGISTRY_PATH = path.join(__dirname, "data", "strategy-registry.json");
// Demo data is populated via seed.js, not hardcoded here — keeps the marketplace
// clean and avoids duplicate/stale entries across deployments.

function loadRegistry() {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  if (!fs.existsSync(REGISTRY_PATH)) {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify({}, null, 2)); // starts empty — use seed.js to populate demo data
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
}

function saveRegistry(registry) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

function submitStrategy({ name, traderId, style, mandate, maxLeverage, maxDrawdown }) {
  const registry = loadRegistry();
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + Date.now().toString(36);
  registry[id] = {
    id, name, traderId, style, mandate, maxLeverage, maxDrawdown,
    risk: null, status: "pending", capacity: 1_000_000,
    submittedAt: new Date().toISOString(),
  };
  saveRegistry(registry);
  return registry[id];
}

function decideStrategy(id, decision, riskTier) {
  const registry = loadRegistry();
  if (!registry[id]) throw new Error("strategy not found");
  registry[id].status = decision === "approved" ? "live" : "rejected";
  if (riskTier) registry[id].risk = riskTier;
  registry[id].decidedAt = new Date().toISOString();
  saveRegistry(registry);
  return registry[id];
}

function getRegistry() {
  return loadRegistry();
}

// Rebuild the entire world-state from the log, from scratch, every time.
// This is intentionally not optimized — correctness and auditability
// matter far more than speed at this stage (Stage 5 §5.0 principle).
function rebuildState() {
  const events = readAllEvents();
  const registry = loadRegistry();

  const strategies = {}; // id -> { nav, units }
  for (const id of Object.keys(registry)) {
    if (registry[id].status !== "live") continue; // only live strategies are tradable
    strategies[id] = { ...registry[id], nav: 0, units: 0 };
  }

  const positions = {}; // `${investorId}::${strategyId}` -> { units, hwm, deposited }
  const wallets = {}; // investorId -> cash balance (real, server-tracked — not a client-side number)

  function unitPrice(s) { return s.units === 0 ? 100 : s.nav / s.units; }
  function posKey(investorId, strategyId) { return `${investorId}::${strategyId}`; }

  for (const ev of events) {
    if (ev.type === "wallet_deposit") {
      wallets[ev.investorId] = (wallets[ev.investorId] || 0) + ev.amount;
    }

    if (ev.type === "wallet_withdrawal") {
      wallets[ev.investorId] = (wallets[ev.investorId] || 0) - ev.amount;
    }

    if (ev.type === "market_return") {
      const s = strategies[ev.strategyId];
      if (s) s.nav = s.nav * (1 + ev.pct);
    }

    if (ev.type === "deposit") {
      const s = strategies[ev.strategyId];
      if (!s) continue;
      wallets[ev.investorId] = (wallets[ev.investorId] || 0) - ev.amount; // moving cash into a strategy
      const price = unitPrice(s);
      const units = ev.amount / price;
      s.nav += ev.amount;
      s.units += units;
      const key = posKey(ev.investorId, ev.strategyId);
      const pos = positions[key] || { units: 0, hwm: 0, deposited: 0 };
      pos.units += units;
      pos.hwm += ev.amount; // deposits raise HWM at par (Stage 3, §3.2)
      pos.deposited += ev.amount;
      positions[key] = pos;
    }

    if (ev.type === "withdrawal") {
      const s = strategies[ev.strategyId];
      const key = posKey(ev.investorId, ev.strategyId);
      const pos = positions[key];
      if (pos) {
        const price = unitPrice(s);
        const grossAmount = ev.units * price;
        const fraction = ev.units / pos.units;
        pos.hwm -= pos.hwm * fraction;
        pos.units -= ev.units;
        s.units -= ev.units;
        s.nav -= grossAmount;
        wallets[ev.investorId] = (wallets[ev.investorId] || 0) + grossAmount; // proceeds return to the wallet
      }
    }

    if (ev.type === "fee_crystallization") {
      const s = strategies[ev.strategyId];
      const key = posKey(ev.investorId, ev.strategyId);
      const pos = positions[key];
      if (pos) {
        const price = unitPrice(s);
        const feeUnits = ev.performanceFee / price;
        pos.units -= feeUnits;
        s.units -= feeUnits;
        s.nav -= ev.performanceFee;
        pos.hwm = pos.units * unitPrice(s);
      }
    }
  }

  return { strategies, positions, wallets, unitPrice, posKey };
}

// ---- Public operations. Every one of these APPENDS to the log first. ----

// Simulates funding — a real deployment would call this only after a
// custodian/broker confirms funds actually arrived (Stage 4, §4.4).
function fundWallet(investorId, amount) {
  validatePositiveNumber(amount, "amount");
  return appendEvent({ type: "wallet_deposit", investorId, amount });
}

function validatePositiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
}

function withdrawWallet(investorId, amount) {
  validatePositiveNumber(amount, "amount");
  const { wallets } = rebuildState();
  const balance = wallets[investorId] || 0;
  if (amount > balance) throw new Error(`insufficient wallet balance ($${balance.toFixed(2)} available)`);
  return appendEvent({ type: "wallet_withdrawal", investorId, amount });
}

function getWalletBalance(investorId) {
  const { wallets } = rebuildState();
  return wallets[investorId] || 0;
}

function deposit(investorId, strategyId, amount) {
  validatePositiveNumber(amount, "amount");
  const { wallets, strategies } = rebuildState();
  if (!strategies[strategyId]) throw new Error("strategy not found or not live");
  const balance = wallets[investorId] || 0;
  if (amount > balance) throw new Error(`insufficient wallet balance ($${balance.toFixed(2)} available) — fund your wallet first`);
  return appendEvent({ type: "deposit", investorId, strategyId, amount });
}

function withdraw(investorId, strategyId, units) {
  validatePositiveNumber(units, "units");
  const { positions, posKey } = rebuildState();
  const pos = positions[posKey(investorId, strategyId)];
  const held = pos ? pos.units : 0;
  if (units > held) throw new Error(`you only hold ${held.toFixed(4)} units in this strategy`);
  return appendEvent({ type: "withdrawal", investorId, strategyId, units });
}

function marketReturn(strategyId, pct) {
  if (typeof pct !== "number" || !Number.isFinite(pct)) throw new Error("pct must be a valid number");
  const { strategies } = rebuildState();
  if (!strategies[strategyId]) throw new Error("strategy not found or not live");
  return appendEvent({ type: "market_return", strategyId, pct });
}

// Crystallize performance fees for every open position against its own HWM.
// Per Stage 3 §3.0 (locked decision): calculated PER STRATEGY, never netted
// across strategies before billing.
function crystallizeFees() {
  const { strategies, positions, unitPrice } = rebuildState();
  const results = [];

  for (const key of Object.keys(positions)) {
    const [investorId, strategyId] = key.split("::");
    const pos = positions[key];
    const s = strategies[strategyId];
    const value = pos.units * unitPrice(s);
    const eligibleProfit = Math.max(0, value - pos.hwm);
    if (eligibleProfit <= 0) continue;

    const performanceFee = eligibleProfit * 0.20;
    const trader = tierFor(s.nav);
    const traderShare = performanceFee * trader.share;
    const platformShare = performanceFee - traderShare;

    appendEvent({
      type: "fee_crystallization",
      investorId, strategyId,
      eligibleProfit, performanceFee, traderShare, platformShare,
      traderTier: trader.name,
    });

    results.push({ investorId, strategyId, eligibleProfit, performanceFee, traderShare, platformShare });
  }

  return results;
}

function getPortfolio(investorId) {
  const { strategies, positions, unitPrice } = rebuildState();
  const held = Object.keys(positions)
    .filter(k => k.startsWith(investorId + "::"))
    .map(k => {
      const strategyId = k.split("::")[1];
      const pos = positions[k];
      const s = strategies[strategyId];
      const value = pos.units * unitPrice(s);
      return { strategyId, strategyName: s.name, units: pos.units, value, hwm: pos.hwm, deposited: pos.deposited, gain: value - pos.deposited };
    });
  return held;
}

function getStrategies() {
  const { strategies, unitPrice } = rebuildState();
  return Object.values(strategies).map(s => ({ ...s, unitPrice: unitPrice(s), tier: tierFor(s.nav) }));
}

function getTraderCompensation(traderId) {
  const events = readAllEvents().filter(e => e.type === "fee_crystallization");
  const { strategies } = rebuildState();
  const myStrategyIds = Object.values(strategies).filter(s => s.traderId === traderId).map(s => s.id);
  const relevant = events.filter(e => myStrategyIds.includes(e.strategyId));
  const totalEarned = relevant.reduce((sum, e) => sum + e.traderShare, 0);
  return { events: relevant, totalEarned };
}

module.exports = {
  rebuildState, deposit, withdraw, marketReturn, crystallizeFees,
  getPortfolio, getStrategies, getTraderCompensation, tierFor, TIERS,
  submitStrategy, decideStrategy, getRegistry,
  fundWallet, withdrawWallet, getWalletBalance,
};
