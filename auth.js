/**
 * AUTH — user registry, password hashing, signed session tokens
 * =================================================================
 * Zero external dependencies (Node's built-in `crypto` only), matching
 * the rest of this backend. Passwords are hashed with scrypt (salted).
 * Tokens are hand-rolled HMAC-signed tokens (same idea as a JWT) so no
 * server-side session storage is needed — any restart is safe.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const USERS_PATH = path.join(__dirname, "data", "users.json");
const TOKEN_SECRET = process.env.TOKEN_SECRET || "calkyx-dev-secret-change-in-production";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// ---------------------------------------------------------------------
// User storage
// ---------------------------------------------------------------------
function loadUsers() {
  if (!fs.existsSync(USERS_PATH)) {
    const seeded = {};
    // Seed one ops/admin account so the ops console has a way in.
    // CHANGE THIS PASSWORD after first login — there's no self-registration for ops on purpose.
    const adminId = "ops_admin";
    seeded[adminId] = createUserRecord(adminId, "admin@calkyx.com", "CalkyxAdmin2026!", "ops", "Ops Admin");
    fs.writeFileSync(USERS_PATH, JSON.stringify(seeded, null, 2));
  }
  return JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function createUserRecord(id, email, password, role, name) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    id, email: email.toLowerCase(), role, name,
    salt, hash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  };
}

function findUserByEmail(users, email) {
  return Object.values(users).find(u => u.email === email.toLowerCase());
}

// ---------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------
function register({ email, password, name, role }) {
  if (!email || !password || !role) throw new Error("email, password, and role are required");
  if (!["investor", "trader"].includes(role)) throw new Error("role must be investor or trader"); // ops is seeded only, never self-registered
  if (password.length < 8) throw new Error("password must be at least 8 characters");

  const users = loadUsers();
  if (findUserByEmail(users, email)) throw new Error("an account with this email already exists");

  const id = `${role}_${crypto.randomBytes(6).toString("hex")}`;
  const user = createUserRecord(id, email, password, role, name || email.split("@")[0]);
  users[id] = user;
  saveUsers(users);

  return publicUser(user);
}

function login({ email, password }) {
  const users = loadUsers();
  const user = findUserByEmail(users, email);
  if (!user) throw new Error("invalid email or password");
  const hash = hashPassword(password, user.salt);
  if (hash !== user.hash) throw new Error("invalid email or password");

  const token = signToken({ userId: user.id, role: user.role });
  return { token, user: publicUser(user) };
}

function publicUser(user) {
  return { id: user.id, email: user.email, role: user.role, name: user.name };
}

// ---------------------------------------------------------------------
// Token signing / verification (hand-rolled, JWT-like)
// ---------------------------------------------------------------------
function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(input) {
  input = input.replace(/-/g, "+").replace(/_/g, "/");
  while (input.length % 4) input += "=";
  return Buffer.from(input, "base64").toString();
}

function signToken(payload) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS };
  const encoded = base64url(JSON.stringify(body));
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(encoded).digest("hex");
  return `${encoded}.${sig}`;
}

function verifyToken(token) {
  if (!token) throw new Error("no token provided");
  const [encoded, sig] = token.split(".");
  if (!encoded || !sig) throw new Error("malformed token");
  const expectedSig = crypto.createHmac("sha256", TOKEN_SECRET).update(encoded).digest("hex");
  if (sig !== expectedSig) throw new Error("invalid token signature");
  const payload = JSON.parse(base64urlDecode(encoded));
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error("token expired");
  return payload; // { userId, role, exp }
}

function getUserById(userId) {
  const users = loadUsers();
  const user = users[userId];
  return user ? publicUser(user) : null;
}

// Extract + verify the bearer token from a request's Authorization header.
// Throws if missing/invalid — callers should catch and respond 401.
function requireAuth(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = verifyToken(token);
  const user = getUserById(payload.userId);
  if (!user) throw new Error("user no longer exists");
  return user;
}

module.exports = { register, login, requireAuth, getUserById, verifyToken };
