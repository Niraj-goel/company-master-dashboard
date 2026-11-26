// Users, roles and the access matrix for the Company Master Dashboard, plus signed session cookies.
// Saved in access.json (ACCESS_FILE). Passwords are stored only as scrypt hashes.
// The owner account from DASHBOARD_USER / DASHBOARD_PASSWORD is always an admin and is never stored,
// so the admin can't be locked out by a bad edit.
require("./env.js");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Every switch in the access matrix. "fixed" rows are on for every role.
const PERMS = [
  {key: "tab.register", group: "Tabs", label: "Entity register", fixed: true},
  {key: "tab.dirreg", group: "Tabs", label: "Director register", note: "Also loads the ROC workbooks and MCA director lists"},
  {key: "tab.capital", group: "Tabs", label: "Capital", note: "Share count, shareholders and shareholding"},
  {key: "tab.fin", group: "Tabs", label: "Group financials", note: "Financial statement figures and borrowings"},
  {key: "tab.loans", group: "Tabs", label: "Inter-group loans", note: "Needs financial statement figures, so it loads them too"},
  {key: "tab.xh", group: "Tabs", label: "Cross holding"},
  {key: "tab.obs", group: "Tabs", label: "Observations", note: "Shows only observations from the data the role can see"},
  {key: "doc.roc", group: "Document downloads", label: "ROC record (click CIN)"},
  {key: "doc.pan", group: "Document downloads", label: "PAN card (click PAN)"},
  {key: "doc.gst", group: "Document downloads", label: "GST certificate (click GSTIN)"},
  {key: "act.export", group: "Actions", label: "Download CSV / export view"},
  {key: "act.refresh", group: "Actions", label: "Refresh data from Google now"},
  {key: "act.links", group: "Actions", label: "Open data sheet / Drive folder buttons"},
  {key: "act.mca", group: "Actions", label: "Load MCA workbooks from own computer"},
  {key: "act.doclinks", group: "Actions", label: "Document links setup"},
];
const PERM_KEYS = new Set(PERMS.map(p => p.key));

const DEFAULT_ROLES = {
  admin: {name: "Admin", perms: {}},        // admin always has everything; perms here are ignored
  general: {name: "General", perms: {
    "tab.dirreg": true, "tab.capital": true, "tab.obs": true,
    "doc.roc": true, "doc.pan": true, "doc.gst": true, "act.export": true,
  }},
};

const FILE = process.env.ACCESS_FILE || path.join(__dirname, "access.json");
const OWNER = {user: (process.env.DASHBOARD_USER || "alcove").trim(), password: process.env.DASHBOARD_PASSWORD || ""};
const SESSION_HOURS = +process.env.SESSION_HOURS || 12;

let state = null;

function load() {
  if (state) return state;
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) { if (e.code !== "ENOENT") console.error(`Could not read ${FILE}: ${e.message}`); }
  state = {
    secret: s.secret || crypto.randomBytes(32).toString("hex"),
    roles: Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_ROLES)), s.roles || {}),
    users: Array.isArray(s.users) ? s.users : [],
  };
  state.roles.admin = {name: "Admin", perms: {}};
  if (!s.secret) save();
  return state;
}

function save() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), {mode: 0o600});
  fs.renameSync(tmp, FILE);
}

const secret = () => process.env.SESSION_SECRET || load().secret;
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString("hex");
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const norm = u => String(u || "").trim().toLowerCase();

// Anyone signs in with the owner account, or a stored account that is active.
function findUser(name) {
  const u = norm(name);
  if (OWNER.password && u === norm(OWNER.user))
    return {user: OWNER.user, name: "Owner", role: "admin", owner: true, active: true,
      stamp: crypto.createHash("sha256").update(OWNER.password).digest("hex")};
  const s = load().users.find(x => norm(x.user) === u);
  return s ? {...s, stamp: s.hash} : null;
}

function verify(name, pw) {
  const u = findUser(name);
  if (!u || !u.active) { hashPw(pw, "x"); return null; }       // same work either way, so timing doesn't reveal users
  const ok = u.owner ? same(pw, OWNER.password) : same(hashPw(pw, u.salt), u.hash);
  return ok ? u : null;
}

function permsFor(u) {
  const out = {};
  const role = load().roles[u.role] || load().roles.general;
  for (const p of PERMS) out[p.key] = u.role === "admin" || !!p.fixed || !!(role && role.perms[p.key]);
  return out;
}

// Session cookie: user|expiry|signature. The signature covers the password hash, so a password change
// or reset ends that user's other sessions.
const b64 = s => Buffer.from(s).toString("base64url");
function issue(u) {
  const body = `${b64(u.user)}|${Date.now() + SESSION_HOURS * 3600e3}`;
  return `${body}|${crypto.createHmac("sha256", secret()).update(body + "|" + u.stamp).digest("base64url")}`;
}
function check(token) {
  const [user, exp, sig] = String(token || "").split("|");
  if (!sig || !(+exp > Date.now())) return null;
  const u = findUser(Buffer.from(user, "base64url").toString());
  if (!u || !u.active) return null;
  const want = crypto.createHmac("sha256", secret()).update(`${user}|${exp}|${u.stamp}`).digest("base64url");
  return same(sig, want) ? u : null;
}

// Failed sign-ins: 5 within 15 minutes locks that name (and that address) for 15 minutes.
const fails = new Map();
function throttled(keys) {
  const now = Date.now();
  return keys.some(k => { const f = fails.get(k); return f && f.n >= 5 && now - f.at < 15 * 60e3; });
}
function failed(keys) {
  const now = Date.now();
  for (const k of keys) { const f = fails.get(k); fails.set(k, f && now - f.at < 15 * 60e3 ? {n: f.n + 1, at: now} : {n: 1, at: now}); }
}
const cleared = keys => keys.forEach(k => fails.delete(k));

// ---- Admin view ----
const publicUser = u => ({user: u.user, name: u.name || "", role: u.role, active: u.active !== false, updated: u.updated || ""});
function adminView() {
  const s = load();
  return {perms: PERMS, roles: s.roles, users: s.users.map(publicUser), owner: OWNER.password ? OWNER.user : null,
    file: FILE, persistentWarning: !!process.env.RENDER && !process.env.ACCESS_FILE};
}

function bad(msg) { return Object.assign(new Error(msg), {status: 400}); }

function saveRoles(roles) {
  const s = load();
  if (!roles || typeof roles !== "object") throw bad("No roles sent");
  const next = {admin: {name: "Admin", perms: {}}};
  for (const [id, r] of Object.entries(roles)) {
    if (id === "admin") continue;
    if (!/^[a-z0-9_-]{2,30}$/.test(id)) throw bad(`Role id "${id}" must be 2-30 lower-case letters, digits, - or _`);
    const name = String(r.name || "").trim().slice(0, 40);
    if (!name) throw bad("Every role needs a name");
    next[id] = {name, perms: Object.fromEntries(Object.entries(r.perms || {}).filter(([k, v]) => PERM_KEYS.has(k) && v === true))};
  }
  if (!next.general) throw bad("The General role can't be removed");
  const orphan = s.users.find(u => !next[u.role]);
  if (orphan) throw bad(`Role "${s.roles[orphan.role]?.name || orphan.role}" still has users (${orphan.user}). Move them first.`);
  s.roles = next; save();
}

function saveUser(b, actor) {
  const s = load();
  const user = String(b.user || "").trim();
  if (!/^[A-Za-z0-9._@-]{3,60}$/.test(user)) throw bad("User name: 3-60 letters, digits, . _ @ or -");
  if (OWNER.password && norm(user) === norm(OWNER.user)) throw bad("That is the owner account; change it in the server settings");
  if (!s.roles[b.role]) throw bad("Pick a role");
  let u = s.users.find(x => norm(x.user) === norm(user));
  if (!u && !b.password) throw bad("Set a password for the new user");
  if (b.password && String(b.password).length < 8) throw bad("Password must be at least 8 characters");
  if (u && norm(u.user) === norm(actor.user) && (b.role !== "admin" || b.active === false)) throw bad("You can't remove your own admin access");
  if (!u) { u = {user, created: new Date().toISOString()}; s.users.push(u); }
  u.name = String(b.name || "").trim().slice(0, 80);
  u.role = b.role;
  u.active = b.active !== false;
  if (b.password) { u.salt = crypto.randomBytes(16).toString("hex"); u.hash = hashPw(b.password, u.salt); }
  u.updated = new Date().toISOString();
  save();
}

function deleteUser(name, actor) {
  const s = load();
  if (norm(name) === norm(actor.user)) throw bad("You can't delete yourself");
  const i = s.users.findIndex(x => norm(x.user) === norm(name));
  if (i < 0) throw bad("No such user");
  s.users.splice(i, 1); save();
}

function changeOwnPassword(actor, current, next) {
  if (actor.owner) throw bad("The owner password is set in the server settings (DASHBOARD_PASSWORD)");
  if (!verify(actor.user, current)) throw bad("Current password is wrong");
  if (String(next || "").length < 8) throw bad("New password must be at least 8 characters");
  const u = load().users.find(x => norm(x.user) === norm(actor.user));
  u.salt = crypto.randomBytes(16).toString("hex"); u.hash = hashPw(next, u.salt); u.updated = new Date().toISOString();
  save();
  return findUser(u.user);
}

const roleName = id => (load().roles[id] || {}).name || id;
const anyAccounts = () => !!OWNER.password || load().users.some(u => u.active !== false);

module.exports = {PERMS, verify, permsFor, issue, check, throttled, failed, cleared, adminView, saveRoles, saveUser,
  deleteUser, changeOwnPassword, anyAccounts, roleName, SESSION_HOURS};
