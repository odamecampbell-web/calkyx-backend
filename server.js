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
const { runSeed } = require("./seed");

const PORT = process.env.PORT || 4000;

// Safety net: log and keep serving instead of dying outright. Every request
// already re-reads fresh state from the ledger file, so a crash mid-request
// can't leave shared in-memory state corrupted — it's safe to stay up.
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION (server staying up):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION (server staying up):", err);
});

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

    // POST /auth/change-password  { oldPassword, newPassword }
    if (p === "/auth/change-password" && req.method === "POST") {
      const user = auth.requireAuth(req);
      const { oldPassword, newPassword } = await readBody(req);
      const result = auth.changePassword(user.id, oldPassword, newPassword);
      return send(res, 200, result);
    }

    // GET /wallet — current investor's cash balance
    if (p === "/wallet" && req.method === "GET") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      return send(res, 200, { balance: engine.getWalletBalance(user.id) });
    }

    // POST /wallet/fund  { amount } — simulates funds arriving (real version would be a custodian webhook)
    if (p === "/wallet/fund" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      const { amount } = await readBody(req);
      if (typeof amount !== "number" || !Number.isFinite(amount)) return send(res, 400, { error: "amount must be a number" });
      const record = engine.fundWallet(user.id, amount);
      return send(res, 200, record);
    }

    // POST /wallet/withdraw  { amount } — cash out of the wallet (simulates a payout to bank/mobile money)
    if (p === "/wallet/withdraw" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      const { amount } = await readBody(req);
      if (typeof amount !== "number" || !Number.isFinite(amount)) return send(res, 400, { error: "amount must be a number" });
      const record = engine.withdrawWallet(user.id, amount);
      return send(res, 200, record);
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
      if (typeof strategyId !== "string" || !strategyId) return send(res, 400, { error: "strategyId required" });
      if (typeof amount !== "number" || !Number.isFinite(amount)) return send(res, 400, { error: "amount must be a number" });
      const record = engine.deposit(user.id, strategyId, amount);
      return send(res, 200, record);
    }

    // GET /withdraw/preview?strategyId=X&amount=Y — live fee math before confirming
    if (p === "/withdraw/preview" && req.method === "GET") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "only investors can preview a withdrawal" });
      const { strategyId, amount } = parsed.query;
      const numAmount = Number(amount);
      if (!strategyId || !Number.isFinite(numAmount)) return send(res, 400, { error: "strategyId and a numeric amount required" });
      const preview = engine.previewWithdrawal(user.id, strategyId, numAmount);
      return send(res, 200, preview);
    }

    // POST /withdraw  { strategyId, amount } — investorId comes from the token.
    // amount is a DOLLAR AMOUNT (not units) — see engine.js for why (Stage 3 §3.5).
    if (p === "/withdraw" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "only investors can withdraw" });
      const { strategyId, amount } = await readBody(req);
      if (typeof strategyId !== "string" || !strategyId) return send(res, 400, { error: "strategyId required" });
      if (typeof amount !== "number" || !Number.isFinite(amount)) return send(res, 400, { error: "amount must be a number" });
      const record = engine.withdraw(user.id, strategyId, amount);
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

    // ===== SUITABILITY =====
    if (p === "/suitability/questions" && req.method === "GET") {
      return send(res, 200, engine.SUITABILITY_QUESTIONS);
    }
    if (p === "/suitability" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      const { answers } = await readBody(req);
      const record = engine.submitSuitability(user.id, answers);
      return send(res, 200, record);
    }
    if (p === "/suitability" && req.method === "GET") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      return send(res, 200, engine.getSuitability(user.id));
    }

    // ===== DISCLOSURES =====
    if (p === "/disclosures/status" && req.method === "GET") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      return send(res, 200, engine.getDisclosureStatus(user.id));
    }
    if (p === "/disclosures/accept" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      const { version } = await readBody(req);
      const record = engine.acceptDisclosure(user.id, version);
      return send(res, 200, record);
    }

    // ===== COMPLAINTS =====
    if (p === "/complaints" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      const { subject, message } = await readBody(req);
      const record = engine.submitComplaint(user.id, subject, message);
      return send(res, 200, record);
    }
    if (p === "/complaints" && req.method === "GET") {
      const user = auth.requireAuth(req);
      // Investors see only their own; ops sees everyone's — same pattern as strategies.
      const investorFilter = user.role === "ops" ? null : user.id;
      if (user.role !== "ops" && user.role !== "investor") return send(res, 403, { error: "not permitted" });
      return send(res, 200, engine.getComplaints(investorFilter));
    }
    if (/^\/complaints\/[^/]+\/status$/.test(p) && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "ops") return send(res, 403, { error: "ops only" });
      const complaintId = p.split("/")[2];
      const { status, note } = await readBody(req);
      const record = engine.updateComplaintStatus(complaintId, status, note);
      return send(res, 200, record);
    }

    // ===== STATEMENT =====
    if (p === "/statement" && req.method === "GET") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      return send(res, 200, engine.getStatement(user.id));
    }

    // ===== ACCOUNT CLOSURE =====
    if (p === "/account/close" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      const record = engine.closeAccount(user.id);
      return send(res, 200, record);
    }

    // ===== RISK EVENTS =====
    // POST /risk-events  { strategyId, severity, description } — ops only
    if (p === "/risk-events" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "ops") return send(res, 403, { error: "ops only" });
      const { strategyId, severity, description } = await readBody(req);
      const record = engine.submitRiskEvent(strategyId, severity, description);
      return send(res, 200, record);
    }
    // GET /risk-events/mine — investor's unacknowledged Material+ notices
    if (p === "/risk-events/mine" && req.method === "GET") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      return send(res, 200, engine.getRiskNoticesForInvestor(user.id));
    }
    // GET /risk-events/for-strategy/:strategyId — trader sees ALL risk events (any severity) on their own strategy
    if (/^\/risk-events\/for-strategy\/[^/]+$/.test(p) && req.method === "GET") {
      const user = auth.requireAuth(req);
      const strategyId = p.split("/")[3];
      const registry = engine.getRegistry();
      const strategy = registry[strategyId];
      if (!strategy) return send(res, 404, { error: "strategy not found" });
      if (user.role === "trader" && strategy.traderId !== user.id) return send(res, 403, { error: "not your strategy" });
      if (user.role !== "trader" && user.role !== "ops") return send(res, 403, { error: "not permitted" });
      const events = readAllEvents().filter(e => e.type === "risk_event" && e.strategyId === strategyId);
      return send(res, 200, events);
    }
    // POST /risk-events/:id/acknowledge  { action: "dismissed"|"reduced_allocation" }
    if (/^\/risk-events\/[^/]+\/acknowledge$/.test(p) && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      const riskEventId = p.split("/")[2];
      const { action } = await readBody(req);
      const record = engine.acknowledgeRiskEvent(user.id, riskEventId, action);
      return send(res, 200, record);
    }

    // ===== MANDATE CHANGES =====
    // POST /mandate-changes  { strategyId, changes } — trader proposes
    if (p === "/mandate-changes" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "trader") return send(res, 403, { error: "traders only" });
      const { strategyId, changes } = await readBody(req);
      const record = engine.proposeMandateChange(strategyId, user.id, changes);
      return send(res, 200, record);
    }
    // GET /mandate-changes/pending — ops review queue
    if (p === "/mandate-changes/pending" && req.method === "GET") {
      const user = auth.requireAuth(req);
      if (user.role !== "ops") return send(res, 403, { error: "ops only" });
      return send(res, 200, engine.getPendingMandateChanges());
    }
    // GET /mandate-changes/mine-as-trader — trader sees their own proposals, any status
    if (p === "/mandate-changes/mine-as-trader" && req.method === "GET") {
      const user = auth.requireAuth(req);
      if (user.role !== "trader") return send(res, 403, { error: "traders only" });
      const events = readAllEvents();
      const proposed = events.filter(e => e.type === "mandate_change_proposed" && e.traderId === user.id);
      const decisions = events.filter(e => e.type === "mandate_change_decided");
      return send(res, 200, proposed.map(p => {
        const decision = decisions.find(d => d.changeId === p.changeId);
        return { ...p, status: decision ? decision.decision : "pending" };
      }));
    }
    // POST /mandate-changes/:id/decision  { decision } — ops approve/reject
    if (/^\/mandate-changes\/[^/]+\/decision$/.test(p) && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "ops") return send(res, 403, { error: "ops only" });
      const changeId = p.split("/")[2];
      const { decision } = await readBody(req);
      const record = engine.decideMandateChange(changeId, decision);
      return send(res, 200, record);
    }
    // GET /mandate-changes/mine — investor's pending exit-window notices
    if (p === "/mandate-changes/mine" && req.method === "GET") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      return send(res, 200, engine.getMandateNoticesForInvestor(user.id));
    }
    // POST /mandate-changes/:id/respond  { action: "exit"|"stay" }
    if (/^\/mandate-changes\/[^/]+\/respond$/.test(p) && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      const changeId = p.split("/")[2];
      const { action } = await readBody(req);
      const record = engine.respondToMandateChange(user.id, changeId, action);
      return send(res, 200, record);
    }

    // ===== STRATEGY CLOSURE =====
    // POST /strategies/:id/initiate-closure  { targetDate } — ops only
    if (/^\/strategies\/[^/]+\/initiate-closure$/.test(p) && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "ops") return send(res, 403, { error: "ops only" });
      const strategyId = p.split("/")[2];
      const { targetDate } = await readBody(req);
      const record = engine.initiateStrategyClosure(strategyId, targetDate);
      return send(res, 200, record);
    }
    // POST /strategies/:id/finalize-closure — ops only, sweeps every remaining position
    if (/^\/strategies\/[^/]+\/finalize-closure$/.test(p) && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "ops") return send(res, 403, { error: "ops only" });
      const strategyId = p.split("/")[2];
      const record = engine.finalizeStrategyClosure(strategyId);
      return send(res, 200, record);
    }
    // GET /closure-notices/mine — investor's active strategy-closure notices
    if (p === "/closure-notices/mine" && req.method === "GET") {
      const user = auth.requireAuth(req);
      if (user.role !== "investor") return send(res, 403, { error: "investors only" });
      return send(res, 200, engine.getClosureNoticeForInvestor(user.id));
    }

    // GET /ops/audit-log — ops role required
    if (p === "/ops/audit-log" && req.method === "GET") {
      const user = auth.requireAuth(req);
      if (user.role !== "ops") return send(res, 403, { error: "ops only" });
      return send(res, 200, readAllEvents());
    }

    // POST /ops/seed — manually trigger demo data population (ops only).
    // Safe to call anytime — refuses to run if the platform already has strategies.
    if (p === "/ops/seed" && req.method === "POST") {
      const user = auth.requireAuth(req);
      if (user.role !== "ops") return send(res, 403, { error: "ops only" });
      const result = runSeed();
      return send(res, 200, result);
    }

    // GET /health
    if (p === "/health") {
      return send(res, 200, { status: "ok", time: new Date().toISOString() });
    }

    return send(res, 404, { error: "not found", path: p });
  } catch (err) {
    const authErrors = ["no token provided", "malformed token", "invalid token signature", "token expired", "user no longer exists"];
    const isAuthError = authErrors.includes(err.message);
    const isBadRequest = /already exists|required|invalid email|must be a positive number|insufficient|at least 8 characters|incorrect|not found|you only hold|not found or not live|decision must be|missing or invalid answer|version mismatch|invalid status|subject and message|invalid severity|not your strategy|not accepting new allocations|paused new allocations|only live strategies|not in a closing state|action must be|changes required|mandate change not found|strategy is not/i.test(err.message);
    const status = isAuthError ? 401 : (isBadRequest ? 400 : 500);
    return send(res, status, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`CALKYX API server running on http://localhost:${PORT}`);
  console.log(`Try:  curl http://localhost:${PORT}/strategies`);

  // Auto-seed on startup if the RUN_SEED environment variable is set to "true".
  // Safe to leave on permanently — runSeed() is fully idempotent, it only
  // creates what's missing and never duplicates or double-funds anything.
  if (process.env.RUN_SEED === "true") {
    console.log("RUN_SEED is set — checking whether to seed demo data...");
    try {
      runSeed();
    } catch (err) {
      console.error("Seed attempt failed (server continues running normally):", err.message);
    }
  }
});

module.exports = server;
