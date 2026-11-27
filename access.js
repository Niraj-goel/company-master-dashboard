// Users and their access for the Company Master Dashboard, plus signed session cookies.
// Each user has their own ticks in the access matrix: they get exactly what is ticked, nothing more.
// An admin gets everything plus the Access tab. Saved in access.json (ACCESS_FILE); passwords only as scrypt hashes.
// The owner account from DASHBOARD_USER / DASHBOARD_PASSWORD is always an admin and is never stored,
// so the admin can't be locked out by a bad edit.
require("./env.js");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Every column of the access matrix. "fixed" items are on for everyone. "short" is the column heading.
const PERMS = [
  {key: "tab.register", group: "Tabs", label: "Entity register", short: "Entity register", fixed: true},
  {key: "tab.mgmt", group: "Tabs", label: "Management dashboard", short: "Mgmt dashboard", note: "Compliance tracker; MIS reports need their own tick"},
  {key: "mis.creditors", group: "Tabs", label: "Management dashboard – MIS: Creditors", short: "MIS Creditors", note: "Needs Management dashboard too"},
  {key: "tab.dirreg", group: "Tabs", label: "Director register", short: "Director register", note: "Also loads the ROC workbooks and MCA director lists"},
  {key: "tab.capital", group: "Tabs", label: "Capital", short: "Capital", note: "Share count, shareholders and shareholding"},
  {key: "tab.fin", group: "Tabs", label: "Group financials", short: "Group financials", note: "Financial statement figures and borrowings"},
  {key: "tab.loans", group: "Tabs", label: "Inter-group loans", short: "Inter-group loans", note: "Needs financial statement figures, so it loads them too"},
  {key: "tab.xh", group: "Tabs", label: "Cross holding", short: "Cross holding"},
  {key: "tab.obs", group: "Tabs", label: "Observations", short: "Observations", note: "Shows only observations from the data the user can see"},
  {key: "doc.roc", group: "Downloads", label: "ROC record (click CIN)", short: "ROC record"},
  {key: "doc.pan", group: "Downloads", label: "PAN card (click PAN)", short: "PAN card"},
  {key: "doc.gst", group: "Downloads", label: "GST certificate (click GSTIN)", short: "GST cert."},
  {key: "act.export", group: "Actions", label: "Download CSV / export view", short: "CSV export"},
  {key: "act.refresh", group: "Actions", label: "Refresh data from Google now", short: "Refresh data"},
  {key: "act.links", group: "Actions", label: "Open data sheet / Drive folder buttons", short: "Sheet & Drive links"},
  {key: "act.mca", group: "Actions", label: "Load MCA workbooks from own computer", short: "Load MCA files"},
  {key: "act.compliance", group: "Actions", label: "Update compliance ticks and amounts (Management dashboard)", short: "Update compliance"},
  {key: "act.doclinks", group: "Actions", label: "Document links setup", short: "Doc links setup"},
];
const PERM_KEYS = new Set(PERMS.map(p => p.key));
// Ticks a new user starts with (the admin can change them before or after saving).
const NEW_USER_PERMS = {"tab.dirreg": true, "tab.capital": true, "tab.obs": true, "doc.roc": true, "doc.pan": true, "doc.gst": true, "act.export": true};

const FILE = process.env.ACCESS_FILE || path.join(__dirname, "access.json");
const OWNER = {user: (process.env.DASHBOARD_USER || "alcove").trim(), password: process.env.DASHBOARD_PASSWORD || ""};
const SESSION_HOURS = +process.env.SESSION_HOURS || 12;

let state = null;
const cleanPerms = p => Object.fromEntries(Object.entries(p || {}).filter(([k, v]) => PERM_KEYS.has(k) && v === true));

function load() {
  if (state) return state;
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) { if (e.code !== "ENOENT") console.error(`Could not read ${FILE}: ${e.message}`); }
  const users = Array.isArray(s.users) ? s.users : [];
  // Older files kept access per role: give each user their role's ticks as their own.
  for (const u of users) {
    if (!u.perms) u.perms = cleanPerms(((s.roles || {})[u.role] || {}).perms || (u.role === "admin" ? {} : NEW_USER_PERMS));
    u.admin = u.admin === true || u.role === "admin";
    delete u.role;
  }
  state = {secret: s.secret || crypto.randomBytes(32).toString("hex"), users};
  if (!s.secret || s.roles) save();
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
    return {user: OWNER.user, name: "Owner", admin: true, owner: true, active: true,
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

// Exactly what is ticked for this user (admins: everything).
function permsFor(u) {
  const out = {};
  for (const p of PERMS) out[p.key] = !!u.admin || !!p.fixed || !!(u.perms && u.perms[p.key]);
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
const publicUser = u => ({user: u.user, name: u.name || "", admin: !!u.admin, active: u.active !== false, perms: u.perms || {}, updated: u.updated || ""});
function adminView() {
  return {perms: PERMS, newUserPerms: NEW_USER_PERMS, users: load().users.map(publicUser), owner: OWNER.password ? OWNER.user : null,
    file: FILE, persistentWarning: !!process.env.RENDER && !process.env.ACCESS_FILE};
}

const bad = msg => Object.assign(new Error(msg), {status: 400});

// Checks one user's row and applies it to u (a stored user, or a new one).
function applyRow(u, b, actor) {
  if (b.password && String(b.password).length < 8) throw bad(`${u.user}: password must be at least 8 characters`);
  if (norm(u.user) === norm(actor.user) && (b.admin === false || b.active === false)) throw bad("You can't remove your own admin access");
  u.name = String(b.name ?? u.name ?? "").trim().slice(0, 80);
  u.admin = b.admin === true;
  u.active = b.active !== false;
  u.perms = cleanPerms(b.perms);
  if (b.password) { u.salt = crypto.randomBytes(16).toString("hex"); u.hash = hashPw(b.password, u.salt); }
  u.updated = new Date().toISOString();
}

function addUser(b, actor) {
  const s = load();
  const user = String(b.user || "").trim();
  if (!/^[A-Za-z0-9._@-]{3,60}$/.test(user)) throw bad("User name: 3-60 letters, digits, . _ @ or -");
  if (OWNER.password && norm(user) === norm(OWNER.user)) throw bad("That is the owner account; change it in the server settings");
  if (s.users.some(x => norm(x.user) === norm(user))) throw bad(`${user} already exists`);
  if (!b.password) throw bad("Set a password for the new user");
  const u = {user, created: new Date().toISOString()};
  applyRow(u, {perms: NEW_USER_PERMS, ...b}, actor);
  s.users.push(u); save();
}

// Saves the whole matrix at once: [{user, name, admin, active, perms, password?}]
function saveUsers(rows, actor) {
  const s = load();
  if (!Array.isArray(rows)) throw bad("No users sent");
  const next = s.users.map(u => ({...u}));
  for (const b of rows) {
    const u = next.find(x => norm(x.user) === norm(b.user));
    if (!u) throw bad(`No such user: ${b.user}`);
    applyRow(u, b, actor);
  }
  s.users = next; save();
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

const anyAccounts = () => !!OWNER.password || load().users.some(u => u.active !== false);

module.exports = {PERMS, verify, permsFor, issue, check, throttled, failed, cleared, adminView, addUser, saveUsers,
  deleteUser, changeOwnPassword, anyAccounts, SESSION_HOURS};
