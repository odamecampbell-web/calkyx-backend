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
const auth = require("./auth");
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
    // POST /auth/register  { email, password, name, role: "investor"|"trader" }
    if (p === "/auth/register" && req.method === "POST") {
      const body = await readBody(req);
      const user = auth.register(body);
      return send(res, 200, user);
    }

    // POST /auth/login  { email, password }
    if (p === "/auth/login" && req.method === "POST") {
      const body = await readBody(req);
      const result = auth.login(body);
      return send(res, 200, result);
    }

    // GET /auth/me — restore session from a stored token
    if (p === "/auth/me" && req.method === "GET") {
      const user = auth.requireAuth(req);
      return send(res, 200, user);
    }

    // GET /strategies — marketplace listing (live only, public — no login needed to browse)
    // GET /strategies?traderId=x — a trader's own strategies (any status) — requires that trader's login
    // GET /strategies?status=pending — ops console approval queue — requires ops login
    if (p === "/strategies" && req.method === "GET") {
      const { traderId, status } = parsed.query;
      if (traderId || status) {
        const user = auth.requireAuth(req);
        if (traderId && user.id !== traderId && user.role !== "ops") return send(res, 403, { error: "not your strategies" });
        if (status && user.role !== "ops") return send(res, 403, { error: "ops only" });
        const registry = Object.values(engine.getRegistry());
        let filtered = registry;
        if (traderId) filtered = filtered.filter(s => s.traderId === traderId);
        if (status) filtered = filtered.filter(s => s.status === status);
        return send(res, 200, filtered);
      }
      return send(res, 200, engine.getStrategies());
    }

    // POST /strategies  { name, style, mandate, maxLeverage, maxDrawdown }
    // Trader submits a new strategy — starts as "pending". traderId comes from the token, never the client.
    if (p === "/strategies" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "trader") return send(res, 403, { error: "only traders can submit strategies" });
      const body = await readBody(req);
      if (!body.name) return send(res, 400, { error: "name required" });
      const record = engine.submitStrategy({ ...body, traderId: user.id });
      return send(res, 200, record);
    }

    // POST /strategies/:id/decision  { decision: "approved"|"rejected", riskTier }
    // Ops console approve/reject action — ops role required
    if (/^\/strategies\/[^/]+\/decision$/.test(p) && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "ops") return send(res, 403, { error: "ops only" });
      const id = p.split("/")[2];
      const { decision, riskTier } = await readBody(req);
      if (!["approved", "rejected"].includes(decision)) return send(res, 400, { error: "decision must be approved or rejected" });
      const record = engine.decideStrategy(id, decision, riskTier);
      return send(res, 200, record);
    }

    // GET /portfolio/:investorId — only that investor, or ops, can view it
    if (p.startsWith("/portfolio/") && req.method === "GET") {
      const user = auth.requireAuth(req);
      const investorId = p.split("/")[2];
      if (user.id !== investorId && user.role !== "ops") return send(res, 403, { error: "not your portfolio" });
      return send(res, 200, engine.getPortfolio(investorId));
    }

    // POST /deposit  { strategyId, amount } — investorId comes from the token
    if (p === "/deposit" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "only investors can deposit" });
      const { strategyId, amount } = await readBody(req);
      if (!strategyId || !amount) return send(res, 400, { error: "strategyId, amount required" });
      const record = engine.deposit(user.id, strategyId, amount);
      return send(res, 200, record);
    }

    // POST /withdraw  { strategyId, units } — investorId comes from the token
    if (p === "/withdraw" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "only investors can withdraw" });
      const { strategyId, units } = await readBody(req);
      if (!strategyId || !units) return send(res, 400, { error: "strategyId, units required" });
      const record = engine.withdraw(user.id, strategyId, units);
      return send(res, 200, record);
    }

    // POST /market-tick  { strategyId, pct } — demo-only market simulation, ops role required
    if (p === "/market-tick" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "ops") return send(res, 403, { error: "ops only (demo market simulation)" });
      const { strategyId, pct } = await readBody(req);
      const record = engine.marketReturn(strategyId, pct);
      return send(res, 200, record);
    }

    // POST /crystallize-fees — runs the fee crystallization job, ops role required
    if (p === "/crystallize-fees" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "ops") return send(res, 403, { error: "ops only" });
      const results = engine.crystallizeFees();
      return send(res, 200, results);
    }

    // GET /trader/:traderId/compensation — only that trader, or ops
    if (p.startsWith("/trader/") && p.endsWith("/compensation") && req.method === "GET") {
      const user = auth.requireAuth(req);
      const traderId = p.split("/")[2];
      if (user.id !== traderId && user.role !== "ops") return send(res, 403, { error: "not your compensation" });
      return send(res, 200, engine.getTraderCompensation(traderId));
    }

    // GET /ops/audit-log — ops role required
    if (p === "/ops/audit-log" && req.method === "GET") {
      const user = auth.requireAuth(req);
      if (user.role !== "ops") return send(res, 403, { error: "ops only" });
      return send(res, 200, readAllEvents());
    }

    // GET /health
    if (p === "/health") {
      return send(res, 200, { status: "ok", time: new Date().toISOString() });
    }

    return send(res, 404, { error: "not found", path: p });
  } catch (err) {
    const authErrors = ["no token provided", "malformed token", "invalid token signature", "token expired", "user no longer exists"];
    const status = authErrors.includes(err.message) ? 401 : (err.message.includes("already exists") || err.message.includes("required") || err.message.includes("invalid email") ? 400 : 500);
    return send(res, status, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`CALKYX API server running on http://localhost:${PORT}`);
  console.log(`Try:  curl http://localhost:${PORT}/strategies`);
});

module.exports = server;
