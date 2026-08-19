/**
 * SEED LOGIC — populates the platform with realistic demo data
 * =================================================================
 * Exposed as a function (not a run-on-load script) so it can be
 * triggered safely from server.js via an environment variable — no
 * terminal/CLI access needed on the hosting platform.
 *
 * Safety: runSeed() refuses to run if any strategies already exist,
 * so it can never silently wipe real data. It only ever populates an
 * empty platform.
 */
const auth = require("./auth");
const engine = require("./engine");

function alreadySeeded() {
  const registry = engine.getRegistry();
  return Object.keys(registry).length > 0;
}

function runSeed() {
  if (alreadySeeded()) {
    console.log("SEED: skipped — strategies already exist, platform is not empty. Nothing was touched.");
    return { skipped: true };
  }

  console.log("SEED: platform is empty, populating demo data...");

  const traders = [
    { email: "kofi.trader@calkyx-demo.com", password: "DemoPass123!", name: "Kofi Mensah" },
    { email: "amara.trader@calkyx-demo.com", password: "DemoPass123!", name: "Amara Osei" },
  ];
  const traderUsers = traders.map(t => auth.register({ ...t, role: "trader" }));
  console.log("SEED: traders created:", traderUsers.map(u => u.email).join(", "));

  const investors = [
    { email: "jane.investor@calkyx-demo.com", password: "DemoPass123!", name: "Jane Appiah" },
    { email: "kwesi.investor@calkyx-demo.com", password: "DemoPass123!", name: "Kwesi Boateng" },
  ];
  const investorUsers = investors.map(i => auth.register({ ...i, role: "investor" }));
  console.log("SEED: investors created:", investorUsers.map(u => u.email).join(", "));

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
      console.log(`SEED: approved ${def.name} (${record.id})`);
    } else {
      console.log(`SEED: left pending ${def.name} (${record.id}) — visible in ops Approvals queue`);
    }
  }

  const jane = investorUsers[0];
  const kwesi = investorUsers[1];

  engine.fundWallet(jane.id, 100000);
  engine.deposit(jane.id, strategyIds[0], 30000);
  engine.deposit(jane.id, strategyIds[1], 25000);
  engine.deposit(jane.id, strategyIds[2], 20000);
  console.log("SEED: Jane funded with $100,000, allocated across 3 strategies");

  engine.fundWallet(kwesi.id, 50000);
  engine.deposit(kwesi.id, strategyIds[1], 40000);
  console.log("SEED: Kwesi funded with $50,000, allocated to Steady Carry");

  engine.marketReturn(strategyIds[0], 0.184);
  engine.marketReturn(strategyIds[1], 0.091);
  engine.marketReturn(strategyIds[2], -0.032);
  console.log("SEED: simulated market movement applied to all 3 live strategies");

  const feeResults = engine.crystallizeFees();
  console.log(`SEED: fee crystallization run — ${feeResults.length} fee event(s) recorded`);
  console.log("SEED: complete.");

  return { skipped: false, traderCount: traderUsers.length, investorCount: investorUsers.length, strategyCount: strategyDefs.length };
}

module.exports = { runSeed, alreadySeeded };

// Still runnable directly for local testing: `node seed.js`
if (require.main === module) {
  const result = runSeed();
  if (!result.skipped) {
    console.log(`
==================================================
Demo credentials:
==================================================
INVESTOR:  jane.investor@calkyx-demo.com   / DemoPass123!
INVESTOR:  kwesi.investor@calkyx-demo.com  / DemoPass123!
TRADER:    kofi.trader@calkyx-demo.com     / DemoPass123!
TRADER:    amara.trader@calkyx-demo.com    / DemoPass123!
OPS:       admin@calkyx.com                / CalkyxAdmin2026! (change this immediately)
==================================================
`);
  }
}
