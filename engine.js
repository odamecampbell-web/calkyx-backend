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
      if (pos && s) {
        if (ev.unitsWithdrawn !== undefined) {
          // Fee-aware format (Stage 3 §3.5, Option A) — numbers computed once
          // at withdraw() call time and stored, so replay never recomputes
          // (and can never drift from what was actually charged).
          pos.hwm -= pos.hwm * (ev.hwmFractionReduced || 0);
          pos.units -= ev.unitsWithdrawn;
          s.units -= ev.unitsWithdrawn;
          s.nav -= ev.amount;
          wallets[ev.investorId] = (wallets[ev.investorId] || 0) + ev.netProceeds;
        } else {
          // Legacy format — events recorded before the fee-on-withdrawal fix.
          // Kept so historical ledger entries still replay correctly.
          const price = unitPrice(s);
          const grossAmount = ev.units * price;
          const fraction = ev.units / pos.units;
          pos.hwm -= pos.hwm * fraction;
          pos.units -= ev.units;
          s.units -= ev.units;
          s.nav -= grossAmount;
          wallets[ev.investorId] = (wallets[ev.investorId] || 0) + grossAmount;
        }
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

// Computes what a withdrawal WOULD cost, without recording anything — powers
// the live "you'll receive $X" preview shown before the investor confirms
// (Stage 3 §3.5 worked example, shown transparently at the point of decision).
function previewWithdrawal(investorId, strategyId, amount) {
  validatePositiveNumber(amount, "amount");
  const { strategies, positions, posKey, unitPrice } = rebuildState();
  const s = strategies[strategyId];
  const pos = positions[posKey(investorId, strategyId)];
  if (!s || !pos || pos.units === 0) throw new Error("no position in this strategy");

  const price = unitPrice(s);
  const currentValue = pos.units * price;
  if (amount > currentValue + 1e-6) throw new Error(`you only have $${currentValue.toFixed(2)} in this position`);

  const fraction = amount / currentValue;
  const unrealizedGain = Math.max(0, currentValue - pos.hwm);
  const gainRealized = fraction * unrealizedGain;
  const fee = gainRealized * 0.20;
  const netProceeds = amount - fee;

  return { currentValue, amount, gainRealized, fee, netProceeds, remainingValue: currentValue - amount };
}

// Withdraws a DOLLAR AMOUNT (not a unit count) from a position. Per Stage 3
// §3.5, Option A: crystallizes a proportional performance fee on the
// withdrawn portion's unrealized gain immediately — this is what closes the
// "withdraw right before crystallization to dodge the fee" loophole the
// blueprint explicitly flags as the reason NOT to defer fee charging to the
// next scheduled period.
function withdraw(investorId, strategyId, amount) {
  const preview = previewWithdrawal(investorId, strategyId, amount);
  const { strategies } = rebuildState();
  const s = strategies[strategyId];
  const price = s.units === 0 ? 100 : s.nav / s.units;
  const unitsWithdrawn = amount / price;
  const hwmFractionReduced = amount / preview.currentValue;

  const tier = tierFor(s.nav);
  const traderShare = preview.fee * tier.share;
  const platformShare = preview.fee - traderShare;

  return appendEvent({
    type: "withdrawal", investorId, strategyId,
    amount, unitsWithdrawn, hwmFractionReduced,
    gainRealized: preview.gainRealized, fee: preview.fee, netProceeds: preview.netProceeds,
    traderShare, platformShare, traderTier: tier.name,
  });
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
  const events = readAllEvents().filter(e => (e.type === "fee_crystallization" || (e.type === "withdrawal" && e.traderShare !== undefined)));
  const { strategies } = rebuildState();
  const myStrategyIds = Object.values(strategies).filter(s => s.traderId === traderId).map(s => s.id);
  const relevant = events.filter(e => myStrategyIds.includes(e.strategyId));
  const totalEarned = relevant.reduce((sum, e) => sum + e.traderShare, 0);
  return { events: relevant, totalEarned };
}

// =====================================================================
// SUITABILITY — risk profile questionnaire (Stage 1: Conservative/
// Balanced/Growth/Advanced). Answers determine a profile that's shown
// as GUIDANCE, never a guarantee — per the platform's own locked rule.
// =====================================================================
const SUITABILITY_QUESTIONS = [
  { id: "horizon", text: "How long do you plan to keep this money invested?",
    options: [
      { value: "short", label: "Less than 1 year", points: 0 },
      { value: "medium", label: "1–3 years", points: 1 },
      { value: "long", label: "3+ years", points: 2 },
    ] },
  { id: "loss_tolerance", text: "If your portfolio dropped 15% in a month, what would you do?",
    options: [
      { value: "sell", label: "Withdraw immediately", points: 0 },
      { value: "wait", label: "Wait and see", points: 1 },
      { value: "add", label: "See it as a buying opportunity", points: 2 },
    ] },
  { id: "experience", text: "How would you describe your investing experience?",
    options: [
      { value: "none", label: "New to investing", points: 0 },
      { value: "some", label: "Some experience", points: 1 },
      { value: "experienced", label: "Experienced", points: 2 },
    ] },
  { id: "objective", text: "What's your main objective?",
    options: [
      { value: "preserve", label: "Preserve capital", points: 0 },
      { value: "grow", label: "Grow steadily", points: 1 },
      { value: "maximize", label: "Maximize returns", points: 2 },
    ] },
];

function computeRiskProfile(totalPoints) {
  if (totalPoints <= 2) return "Conservative";
  if (totalPoints <= 4) return "Balanced";
  if (totalPoints <= 6) return "Growth";
  return "Advanced";
}

function submitSuitability(investorId, answers) {
  if (!answers || typeof answers !== "object") throw new Error("answers required");
  let totalPoints = 0;
  for (const q of SUITABILITY_QUESTIONS) {
    const chosen = answers[q.id];
    const opt = q.options.find(o => o.value === chosen);
    if (!opt) throw new Error(`missing or invalid answer for "${q.id}"`);
    totalPoints += opt.points;
  }
  const riskProfile = computeRiskProfile(totalPoints);
  return appendEvent({ type: "suitability_submitted", investorId, answers, riskProfile });
}

function getSuitability(investorId) {
  const events = readAllEvents().filter(e => e.type === "suitability_submitted" && e.investorId === investorId);
  return events.length ? events[events.length - 1] : null; // most recent submission wins
}

// =====================================================================
// DISCLOSURES — Risk Disclosure Statement acceptance (Stage 4, §4.7).
// Versioned so a future disclosure update can require re-acceptance.
// =====================================================================
const CURRENT_DISCLOSURE_VERSION = "2026-08-v1";
const DISCLOSURE_TEXT = "Capital is at risk. Past performance does not guarantee future results. Strategies can lose money, including the possibility of loss of principal. Platform fees (1% annual + 20% performance fee, high-water-mark basis) apply regardless of performance. CALKYX is not currently licensed to operate with real investor funds in any jurisdiction — this platform is operating in demonstration/sandbox mode.";

function acceptDisclosure(investorId, version) {
  if (version !== CURRENT_DISCLOSURE_VERSION) throw new Error("disclosure version mismatch — please reload and re-read the current disclosure");
  return appendEvent({ type: "disclosure_accepted", investorId, version });
}

function getDisclosureStatus(investorId) {
  const events = readAllEvents().filter(e => e.type === "disclosure_accepted" && e.investorId === investorId);
  const latest = events.length ? events[events.length - 1] : null;
  return {
    currentVersion: CURRENT_DISCLOSURE_VERSION,
    text: DISCLOSURE_TEXT,
    accepted: !!latest && latest.version === CURRENT_DISCLOSURE_VERSION,
    acceptedAt: latest ? latest.timestamp : null,
  };
}

// =====================================================================
// COMPLAINTS — Stage 4, §4.9. SLA: acknowledge within 2 business days,
// substantive response within 10 (tracked here as target metadata, not
// enforced by a scheduler in this demo — that's an operational process,
// not a code gap).
// =====================================================================
function submitComplaint(investorId, subject, message) {
  if (!subject || !message) throw new Error("subject and message are required");
  const id = "complaint-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  return appendEvent({ type: "complaint_submitted", complaintId: id, investorId, subject, message, status: "open" });
}

function updateComplaintStatus(complaintId, status, note) {
  if (!["open", "acknowledged", "resolved"].includes(status)) throw new Error("invalid status");
  const events = readAllEvents().filter(e => e.type === "complaint_submitted" && e.complaintId === complaintId);
  if (!events.length) throw new Error("complaint not found");
  return appendEvent({ type: "complaint_status_updated", complaintId, status, note: note || "" });
}

function getComplaints(investorId) {
  const events = readAllEvents();
  const submitted = events.filter(e => e.type === "complaint_submitted" && (!investorId || e.investorId === investorId));
  return submitted.map(c => {
    const updates = events.filter(e => e.type === "complaint_status_updated" && e.complaintId === c.complaintId);
    const latest = updates.length ? updates[updates.length - 1] : null;
    return { ...c, status: latest ? latest.status : c.status, lastUpdatedAt: latest ? latest.timestamp : c.timestamp };
  });
}

// =====================================================================
// STATEMENT — Stage 3, §3.10 format: per-strategy monthly-style summary,
// computed on demand from the same event log (not a separately stored
// report — always reflects the true current ledger).
// =====================================================================
function getStatement(investorId) {
  const events = readAllEvents();
  const { strategies, unitPrice } = rebuildState();
  const portfolio = getPortfolio(investorId);

  const lines = portfolio.map(pos => {
    const relevantEvents = events.filter(e =>
      (e.type === "deposit" || e.type === "withdrawal" || e.type === "fee_crystallization") &&
      e.investorId === investorId && e.strategyId === pos.strategyId
    );
    const deposits = relevantEvents.filter(e => e.type === "deposit").reduce((s, e) => s + e.amount, 0);
    const performanceFees = relevantEvents.filter(e => e.type === "fee_crystallization").reduce((s, e) => s + e.performanceFee, 0);
    return {
      strategyName: pos.strategyName,
      deposited: deposits,
      grossPL: pos.gain + performanceFees, // add back fees already deducted, to show gross
      performanceFee: performanceFees,
      endingValue: pos.value,
      hwm: pos.hwm,
    };
  });

  const netPortfolioResult = portfolio.reduce((sum, p) => sum + p.gain, 0); // Stage 3 §3.0: netting is a REPORTING concept only
  return { generatedAt: new Date().toISOString(), lines, netPortfolioResult };
}

// =====================================================================
// ACCOUNT CLOSURE — withdraws every open position back to the wallet.
// Actual wallet cash-out to a "bank" is a separate, already-existing
// step (withdrawWallet) — closure just empties every strategy position.
// =====================================================================
function closeAccount(investorId) {
  const portfolio = getPortfolio(investorId);
  const results = [];
  for (const pos of portfolio) {
    if (pos.value > 0) {
      withdraw(investorId, pos.strategyId, pos.value); // withdraw() now takes a dollar amount, not units
      results.push({ strategyId: pos.strategyId, amountWithdrawn: pos.value });
    }
  }
  appendEvent({ type: "account_closure_requested", investorId, positionsClosed: results.length });
  return { closedPositions: results };
}

module.exports = {
  rebuildState, deposit, withdraw, marketReturn, crystallizeFees,
  getPortfolio, getStrategies, getTraderCompensation, tierFor, TIERS,
  submitStrategy, decideStrategy, getRegistry,
  fundWallet, withdrawWallet, getWalletBalance,
  SUITABILITY_QUESTIONS, submitSuitability, getSuitability,
  CURRENT_DISCLOSURE_VERSION, acceptDisclosure, getDisclosureStatus,
  submitComplaint, updateComplaintStatus, getComplaints,
  getStatement, closeAccount, previewWithdrawal,
};
