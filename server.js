/**
 * CALKYX API SERVER
 * ===================
 * Zero external dependencies — runs anywhere with just `node server.js`.
 * This exposes the engine (backed by the append-only ledger) over HTTP
 * so the investor app, trader app, and ops console can all read/write
 * the SAME shared state instead of three separate fake datasets.
 */
const http = require("http");
const url = require("url");
const engine = require("./engine");
const { readAllEvents } = require("./ledger");

const PORT = process.env.PORT || 4000;

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  if (req.method === "OPTIONS") return send(res, 200, {});

  try {
    // GET /strategies — marketplace listing (live only)
    // GET /strategies?traderId=x — a trader's own strategies (any status)
    // GET /strategies?status=pending — ops console approval queue
    if (p === "/strategies" && req.method === "GET") {
      const { traderId, status } = parsed.query;
      if (traderId || status) {
        const registry = Object.values(engine.getRegistry());
        let filtered = registry;
        if (traderId) filtered = filtered.filter(s => s.traderId === traderId);
        if (status) filtered = filtered.filter(s => s.status === status);
        return send(res, 200, filtered);
      }
      return send(res, 200, engine.getStrategies());
    }

    // POST /strategies  { name, traderId, style, mandate, maxLeverage, maxDrawdown }
    // Trader submits a new strategy — starts as "pending"
    if (p === "/strategies" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.name || !body.traderId) return send(res, 400, { error: "name and traderId required" });
      const record = engine.submitStrategy(body);
      return send(res, 200, record);
    }

    // POST /strategies/:id/decision  { decision: "approved"|"rejected", riskTier }
    // Ops console approve/reject action
    if (/^\/strategies\/[^/]+\/decision$/.test(p) && req.method === "POST") {
      const id = p.split("/")[2];
      const { decision, riskTier } = await readBody(req);
      if (!["approved", "rejected"].includes(decision)) return send(res, 400, { error: "decision must be approved or rejected" });
      const record = engine.decideStrategy(id, decision, riskTier);
      return send(res, 200, record);
    }

    // GET /portfolio/:investorId
    if (p.startsWith("/portfolio/") && req.method === "GET") {
      const investorId = p.split("/")[2];
      return send(res, 200, engine.getPortfolio(investorId));
    }

    // POST /deposit  { investorId, strategyId, amount }
    if (p === "/deposit" && req.method === "POST") {
      const { investorId, strategyId, amount } = await readBody(req);
      if (!investorId || !strategyId || !amount) return send(res, 400, { error: "investorId, strategyId, amount required" });
      const record = engine.deposit(investorId, strategyId, amount);
      return send(res, 200, record);
    }

    // POST /withdraw  { investorId, strategyId, units }
    if (p === "/withdraw" && req.method === "POST") {
      const { investorId, strategyId, units } = await readBody(req);
      if (!investorId || !strategyId || !units) return send(res, 400, { error: "investorId, strategyId, units required" });
      const record = engine.withdraw(investorId, strategyId, units);
      return send(res, 200, record);
    }

    // POST /market-tick  { strategyId, pct }  — simulates trading P&L for demo purposes
    if (p === "/market-tick" && req.method === "POST") {
      const { strategyId, pct } = await readBody(req);
      const record = engine.marketReturn(strategyId, pct);
      return send(res, 200, record);
    }

    // POST /crystallize-fees — runs the monthly fee crystallization job on demand
    if (p === "/crystallize-fees" && req.method === "POST") {
      const results = engine.crystallizeFees();
      return send(res, 200, results);
    }

    // GET /trader/:traderId/compensation
    if (p.startsWith("/trader/") && p.endsWith("/compensation") && req.method === "GET") {
      const traderId = p.split("/")[2];
      return send(res, 200, engine.getTraderCompensation(traderId));
    }

    // GET /ops/audit-log — raw event log, for the ops console
    if (p === "/ops/audit-log" && req.method === "GET") {
      return send(res, 200, readAllEvents());
    }

    // GET /health
    if (p === "/health") {
      return send(res, 200, { status: "ok", time: new Date().toISOString() });
    }

    return send(res, 404, { error: "not found", path: p });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`CALKYX API server running on http://localhost:${PORT}`);
  console.log(`Try:  curl http://localhost:${PORT}/strategies`);
});

module.exports = server;
