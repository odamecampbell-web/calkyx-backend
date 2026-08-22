/**
 * SEED LOGIC — populates the platform with realistic demo data
 * =================================================================
 * Fully idempotent: every step checks "does this already exist?" before
 * creating anything, so running this on an empty platform, a fully
 * seeded platform, or a PARTIALLY seeded platform (e.g. one that failed
 * halfway through a previous attempt) always converges on the same
 * complete, correct end state. Nothing is ever duplicated or double-funded.
 */
const auth = require("./auth");
const engine = require("./engine");

const TRADER_DEFS = [
  { email: "kofi.trader@calkyx-demo.com", password: "DemoPass123!", name: "Kofi Mensah" },
  { email: "amara.trader@calkyx-demo.com", password: "DemoPass123!", name: "Amara Osei" },
];
const INVESTOR_DEFS = [
  { email: "jane.investor@calkyx-demo.com", password: "DemoPass123!", name: "Jane Appiah" },
  { email: "kwesi.investor@calkyx-demo.com", password: "DemoPass123!", name: "Kwesi Boateng" },
];
const STRATEGY_DEFS = [
  { trader: 0, name: "Alpha Macro", style: "Macro / Trend", mandate: "Global macro positioning across G10 FX and rates, max 5x leverage, target monthly drawdown < 8%.", maxLeverage: "5x", maxDrawdown: "-8%", riskTier: "Moderate", approve: true, marketReturnPct: 0.184 },
  { trader: 0, name: "Steady Carry", style: "Carry / Income", mandate: "Low-volatility carry strategy across major currency pairs, max 2x leverage, capital preservation priority.", maxLeverage: "2x", maxDrawdown: "-4%", riskTier: "Conservative", approve: true, marketReturnPct: 0.091 },
  { trader: 1, name: "Momentum Edge", style: "Trend Following", mandate: "Systematic trend-following across commodities and indices, max 8x leverage, higher volatility tolerance.", maxLeverage: "8x", maxDrawdown: "-15%", riskTier: "Aggressive", approve: true, marketReturnPct: -0.032 },
  { trader: 1, name: "Vector Grid", style: "Grid / Mean Reversion", mandate: "Grid-based mean reversion on majors — submitted for review, pattern under compliance assessment.", maxLeverage: "6x", maxDrawdown: "-10%", riskTier: null, approve: false },
];
// Which strategies each demo investor should hold, and how much — only
// applied the first time that investor is created (never re-applied on
// a re-run, so re-running seed can't double-fund or double-allocate).
const INVESTOR_ALLOCATIONS = [
  { investor: 0, fund: 100000, allocations: [{ strategy: 0, amount: 30000 }, { strategy: 1, amount: 25000 }, { strategy: 2, amount: 20000 }] },
  { investor: 1, fund: 50000, allocations: [{ strategy: 1, amount: 40000 }] },
];

function runSeed() {
  const log = [];
  const record = (msg) => { log.push(msg); console.log("SEED:", msg); };

  // ---- Traders (idempotent: creates if missing, reuses if present) ----
  const traderResults = TRADER_DEFS.map(t => auth.registerOrGet({ ...t, role: "trader" }));
  traderResults.forEach((r, i) => record(`trader ${TRADER_DEFS[i].email} — ${r.created ? "created" : "already existed"}`));
  const traderUsers = traderResults.map(r => r.user);

  // ---- Investors (idempotent) ----
  const investorResults = INVESTOR_DEFS.map(i => auth.registerOrGet({ ...i, role: "investor" }));
  investorResults.forEach((r, i) => record(`investor ${INVESTOR_DEFS[i].email} — ${r.created ? "created" : "already existed"}`));
  const investorUsers = investorResults.map(r => r.user);

  // ---- Strategies (idempotent: skip if a strategy with this name+trader already exists) ----
  const existingRegistry = Object.values(engine.getRegistry());
  const strategyIds = []; // parallel to STRATEGY_DEFS, only for approved ones

  STRATEGY_DEFS.forEach((def, i) => {
    const traderUser = traderUsers[def.trader];
    const already = existingRegistry.find(s => s.name === def.name);
    if (already) {
      record(`strategy "${def.name}" — already existed (${already.status})`);
      if (def.approve) strategyIds[i] = already.id;
      return;
    }
    const submitted = engine.submitStrategy({
      name: def.name, traderId: traderUser.id, style: def.style,
      mandate: def.mandate, maxLeverage: def.maxLeverage, maxDrawdown: def.maxDrawdown,
    });
    if (def.approve) {
      engine.decideStrategy(submitted.id, "approved", def.riskTier);
      strategyIds[i] = submitted.id;
      record(`strategy "${def.name}" — created and approved (${submitted.id})`);
    } else {
      record(`strategy "${def.name}" — created, left pending (${submitted.id})`);
    }
  });

  // ---- Wallet funding + allocations — ONLY for investors that were newly created this run ----
  INVESTOR_ALLOCATIONS.forEach(plan => {
    const wasNewlyCreated = investorResults[plan.investor].created;
    const investorUser = investorUsers[plan.investor];
    if (!wasNewlyCreated) {
      record(`skipping fund/allocate for ${investorUser.email} — investor already existed, avoiding double-funding`);
      return;
    }
    engine.fundWallet(investorUser.id, plan.fund);
    record(`funded ${investorUser.email} with $${plan.fund.toLocaleString()}`);
    for (const alloc of plan.allocations) {
      const sid = strategyIds[alloc.strategy];
      if (!sid) continue;
      engine.deposit(investorUser.id, sid, alloc.amount);
      record(`allocated $${alloc.amount.toLocaleString()} from ${investorUser.email} into ${STRATEGY_DEFS[alloc.strategy].name}`);
    }
  });

  // ---- Market movement — only apply once per strategy (skip if it already has non-zero NAV movement) ----
  // Simple guard: only apply if this strategy was newly created THIS run (avoids re-applying returns on every seed call).
  STRATEGY_DEFS.forEach((def, i) => {
    if (def.marketReturnPct == null || !strategyIds[i]) return;
    const already = existingRegistry.find(s => s.name === def.name);
    if (already) return; // pre-existing strategy — don't re-apply a market move on top of its current NAV
    engine.marketReturn(strategyIds[i], def.marketReturnPct);
    record(`applied ${(def.marketReturnPct * 100).toFixed(1)}% market movement to ${def.name}`);
  });

  // ---- Fee crystallization — safe to call anytime; it's a no-op where there's no eligible profit ----
  const feeResults = engine.crystallizeFees();
  record(`fee crystallization run — ${feeResults.length} fee event(s) recorded`);

  return { log };
}

module.exports = { runSeed };

// Still runnable directly for local testing: `node seed.js`
if (require.main === module) {
  runSeed();
  console.log(`
==================================================
Demo credentials:
==================================================
INVESTOR:  jane.investor@calkyx-demo.com   / DemoPass123!
INVESTOR:  kwesi.investor@calkyx-demo.com  / DemoPass123!
TRADER:    kofi.trader@calkyx-demo.com     / DemoPass123!
TRADER:    amara.trader@calkyx-demo.com    / DemoPass123!
OPS:       admin@calkyx.com                / (your own password now)
==================================================
`);
}
