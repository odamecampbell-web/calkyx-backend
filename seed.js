/**
 * SEED SCRIPT — populates the platform with realistic demo data
 * =================================================================
 * Run this once against a fresh deployment (or any time you want to
 * reset to a clean, populated demo state) so a reviewer sees a working
 * marketplace immediately instead of empty screens.
 *
 * Usage:  node seed.js
 * (Run it in the same folder as server.js, with the server NOT running,
 *  since it writes directly to the data files.)
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// Wipe existing demo data (keeps the seeded ops admin logic in auth.js intact —
// that gets recreated automatically on next server start if missing).
for (const f of ["cashflow-log.jsonl", "strategy-registry.json", "users.json"]) {
  const p = path.join(DATA_DIR, f);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

const auth = require("./auth");
const engine = require("./engine");

console.log("Seeding CALKYX demo data...\n");

// ---- Traders ----
const traders = [
  { email: "kofi.trader@calkyx-demo.com", password: "DemoPass123!", name: "Kofi Mensah" },
  { email: "amara.trader@calkyx-demo.com", password: "DemoPass123!", name: "Amara Osei" },
];
const traderUsers = traders.map(t => auth.register({ ...t, role: "trader" }));
console.log("Traders created:", traderUsers.map(u => u.email).join(", "));

// ---- Investors ----
const investors = [
  { email: "jane.investor@calkyx-demo.com", password: "DemoPass123!", name: "Jane Appiah" },
  { email: "kwesi.investor@calkyx-demo.com", password: "DemoPass123!", name: "Kwesi Boateng" },
];
const investorUsers = investors.map(i => auth.register({ ...i, role: "investor" }));
console.log("Investors created:", investorUsers.map(u => u.email).join(", "));

// ---- Strategies: submit as each trader, then approve most, leave one pending ----
const strategyDefs = [
  { trader: 0, name: "Alpha Macro", style: "Macro / Trend", mandate: "Global macro positioning across G10 FX and rates, max 5x leverage, target monthly drawdown < 8%.", maxLeverage: "5x", maxDrawdown: "-8%", riskTier: "Moderate", approve: true },
  { trader: 0, name: "Steady Carry", style: "Carry / Income", mandate: "Low-volatility carry strategy across major currency pairs, max 2x leverage, capital preservation priority.", maxLeverage: "2x", maxDrawdown: "-4%", riskTier: "Conservative", approve: true },
  { trader: 1, name: "Momentum Edge", style: "Trend Following", mandate: "Systematic trend-following across commodities and indices, max 8x leverage, higher volatility tolerance.", maxLeverage: "8x", maxDrawdown: "-15%", riskTier: "Aggressive", approve: true },
  { trader: 1, name: "Vector Grid", style: "Grid / Mean Reversion", mandate: "Grid-based mean reversion on majors — submitted for review, pattern under compliance assessment.", maxLeverage: "6x", maxDrawdown: "-10%", riskTier: null, approve: false },
];

const strategyIds = [];
for (const def of strategyDefs) {
  const traderUser = traderUsers[def.trader];
  const record = engine.submitStrategy({
    name: def.name, traderId: traderUser.id, style: def.style,
    mandate: def.mandate, maxLeverage: def.maxLeverage, maxDrawdown: def.maxDrawdown,
  });
  if (def.approve) {
    engine.decideStrategy(record.id, "approved", def.riskTier);
    strategyIds.push(record.id);
    console.log(`Approved: ${def.name} (${record.id})`);
  } else {
    console.log(`Left pending: ${def.name} (${record.id}) — visible in ops Approvals queue`);
  }
}

// ---- Fund investor wallets and allocate, so portfolios aren't empty ----
const jane = investorUsers[0];
const kwesi = investorUsers[1];

engine.fundWallet(jane.id, 100000);
engine.deposit(jane.id, strategyIds[0], 30000); // Alpha Macro
engine.deposit(jane.id, strategyIds[1], 25000); // Steady Carry
engine.deposit(jane.id, strategyIds[2], 20000); // Momentum Edge
console.log(`\nJane funded with $100,000, allocated across 3 strategies`);

engine.fundWallet(kwesi.id, 50000);
engine.deposit(kwesi.id, strategyIds[1], 40000); // Steady Carry
console.log(`Kwesi funded with $50,000, allocated to Steady Carry`);

// ---- Simulate some market movement so there's something to see ----
engine.marketReturn(strategyIds[0], 0.184); // Alpha Macro +18.4%
engine.marketReturn(strategyIds[1], 0.091); // Steady Carry +9.1%
engine.marketReturn(strategyIds[2], -0.032); // Momentum Edge -3.2% (shows a drawdown scenario too)
console.log(`\nSimulated market movement applied to all 3 live strategies`);

// ---- Run one fee crystallization so compensation history isn't empty ----
const feeResults = engine.crystallizeFees();
console.log(`Fee crystallization run: ${feeResults.length} fee event(s) recorded`);

console.log(`
==================================================
SEED COMPLETE. Demo credentials:
==================================================
INVESTOR:  jane.investor@calkyx-demo.com   / DemoPass123!
INVESTOR:  kwesi.investor@calkyx-demo.com  / DemoPass123!
TRADER:    kofi.trader@calkyx-demo.com     / DemoPass123!
TRADER:    amara.trader@calkyx-demo.com    / DemoPass123!
OPS:       admin@calkyx.com                / CalkyxAdmin2026! (change this immediately)

One strategy ("Vector Grid") was left pending — use it to demonstrate
the ops approval workflow live during a review.
==================================================
`);
