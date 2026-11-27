// Company Master Dashboard server.
// Serves the sign-in page, public/index.html and /api/data. Data is read from the Company Master Data sheet and
// the ROC folder with the service-account key kept on this server; the key never reaches the browser.
// Each user sees only what is ticked for them in the access matrix (access.js); the server strips everything else before sending.
// Settings and the key are read from .env (see .env.example).
require("./env.js");
const http = require("http");
const fs = require("fs");
const path = require("path");
const g = require("./google.js");
const {findDocuments} = require("./docs.js");
const access = require("./access.js");

const CONFIG = {
  port: +process.env.PORT || 3000,
  sheetId: process.env.SHEET_ID || "1nK-tKjoSH2Y84YE-0rOIgQgvBA238mCUBp0fK5igdRg",
  rocFolder: process.env.ROC_FOLDER_ID || "128CihawD0mDOwpsd2m1EIo5N40jzwAp0",
  panFolder: process.env.PAN_FOLDER_ID || "1l4Y_WnaUfaFSeElUvKBxXA-XLJd5UfQV",   // Statutory/PAN
  gstFolder: process.env.GST_FOLDER_ID || "1W7kXNNf7X6vyuhiE-SlQrSSD_Fc22jSY",   // Statutory/GST (searched with its subfolders)
  tabs: ["Entities", "Share count", "Shareholders", "Shareholding", "Cross holdings", "Financials",
    "Borrowings by lender", "Loans given", "FS holders", "MCA master", "MCA directors", "MCA charges"],
  cacheMs: 2 * 60 * 1000,                     // reuse a read for 2 minutes unless ?refresh=1
};

// Statutory compliance tracker (Management dashboard). Every save appends a row to the "Compliance" tab, so the
// tab is also the audit trail; the latest row for a period + company + compliance is the current value.
const COMPLIANCE = {tab: "Compliance", heads: ["TDS", "GST", "PF", "ESI", "P.Tax", "Gratuity", "Pension"],
  status: ["Pending", "On time", "Late", "N/A"],
  header: ["Period", "Company", "Compliance", "Status", "Amount (₹)", "Remark", "Updated by", "Updated at"]};
let cmpCache = null, cmpAt = 0;
async function complianceRows(fresh) {
  if (!fresh && cmpCache && Date.now() - cmpAt < 30_000) return cmpCache;
  let rows = [];
  try { rows = ((await g.sheetValues(CONFIG.sheetId, [`'${COMPLIANCE.tab}'`])).valueRanges[0].values || []).slice(1); }
  catch (e) { if (!/Unable to parse range/i.test(e.message)) throw e; }   // tab not created yet
  const latest = new Map();
  for (const r of rows) { const [period, company, head] = r.map(v => String(v ?? "").trim()); if (period && company && head) latest.set(`${period}|${company}|${head}`, r); }
  cmpCache = [...latest.values()].map(r => ({period: String(r[0]), company: String(r[1]), head: String(r[2]), status: String(r[3] || "Pending"),
    amount: r[4] === "" || r[4] == null ? null : +r[4], remark: String(r[5] || ""), by: String(r[6] || ""), at: String(r[7] || "")}));
  cmpAt = Date.now();
  return cmpCache;
}
async function saveCompliance(u, b) {
  const items = Array.isArray(b.items) ? b.items.slice(0, 500) : [];
  const rows = items.map(x => {
    const period = String(x.period || ""), company = String(x.company || "").trim(), head = String(x.head || "");
    if (!/^d{4}-(0[1-9]|1[0-2])$/.test(period)) throw Object.assign(new Error("Bad period"), {status: 400});
    if (!company || company.length > 200) throw Object.assign(new Error("Bad company"), {status: 400});
    if (!COMPLIANCE.heads.includes(head)) throw Object.assign(new Error("Bad compliance"), {status: 400});
    const status = COMPLIANCE.status.includes(x.status) ? x.status : "Pending";
    const amount = x.amount === "" || x.amount == null ? "" : Number(x.amount);
    if (amount !== "" && !(isFinite(amount) && amount >= 0)) throw Object.assign(new Error("Amount must be a number"), {status: 400});
    return [period, company, head, status, amount, String(x.remark || "").slice(0, 300), u.user, new Date().toISOString()];
  });
  if (rows.length) await g.appendRows(CONFIG.sheetId, COMPLIANCE.tab, COMPLIANCE.header, rows);
  cmpCache = null;
}

// Which sheet tabs each access-matrix switch needs. A tab is sent only if one of the user's switches needs it.
const ALWAYS = ["Entities", "MCA master", "MCA charges", "Financials"];
const TAB_TABLES = {
  "tab.dirreg": ["MCA directors"],
  "tab.capital": ["Share count", "Shareholders", "Shareholding", "FS holders"],
  "tab.fin": ["Borrowings by lender", "Loans given", "FS holders"],
  "tab.loans": ["Borrowings by lender", "Loans given", "FS holders"],
  "tab.xh": ["Cross holdings", "Shareholding", "Shareholders", "Share count"],
};
// Without Group financials or Inter-group loans, Financials keeps only these columns (used by the register and capital).
const FIN_LIGHT = ["Company", "Kind", "Unit", "Face value (₹)", "Preference capital", "Directors / partners (FS)"];

let cache = null, cacheAt = 0, inflight = null;
const rocBytes = new Map();                    // fileId -> {modifiedTime, b64}
let allowedDocs = new Map();                   // fileId -> {name, mimeType}: the only files /api/doc will serve

async function readAll() {
  const sheet = g.sheetValues(CONFIG.sheetId, CONFIG.tabs.map(t => `'${t}'`));
  const roc = (async () => {
    try {
      const files = (await g.listFolder(CONFIG.rocFolder)).filter(f => /\.xlsx?$/i.test(f.name));
      const out = [], errors = [];
      let i = 0;
      await Promise.all(Array.from({length: 6}, async () => {
        while (i < files.length) {
          const f = files[i++];
          try {
            let hit = rocBytes.get(f.id);
            if (!hit || hit.modifiedTime !== f.modifiedTime) {
              hit = {modifiedTime: f.modifiedTime, b64: (await g.download(f.id)).toString("base64")};
              rocBytes.set(f.id, hit);
            }
            out.push({name: f.name, modifiedTime: f.modifiedTime, b64: hit.b64});
          } catch (e) { errors.push(`${f.name}: ${e.message}`); }
        }
      }));
      return {files: out, errors, total: files.length};
    } catch (e) { return {files: [], errors: [e.message], total: 0, failed: true}; }
  })();
  const tables = {};
  const docs = sheet.then(async s => {
    s.valueRanges.forEach((vr, i) => { tables[CONFIG.tabs[i]] = vr.values || []; });
    try {
      const [head = [], ...rows] = tables.Entities || [];
      const col = h => head.indexOf(h);
      const entities = rows.filter(r => r[col("Company")]).map(r => ({
        name: r[col("Company")], cin: String(r[col("CIN / LLPIN")] || ""), pan: String(r[col("PAN")] || ""), gst: String(r[col("GSTIN")] || "")}));
      return await findDocuments(entities, {roc: CONFIG.rocFolder, pan: CONFIG.panFolder, gst: CONFIG.gstFolder});
    } catch (e) { return {docs: {}, allowed: new Map(), error: e.message}; }
  });
  const [r, d] = await Promise.all([roc, docs]);
  allowedDocs = d.allowed;
  return {readAt: new Date().toISOString(), tables, roc: r, docs: d.docs, docsError: d.error};
}

// Streams one matched document (PAN card, GST certificate or ROC file) as a download.
async function sendDoc(res, id, perms) {
  if (!allowedDocs.size) await data(false);
  const f = allowedDocs.get(id);
  if (!f || !perms["doc." + f.kind]) return send(res, 404, "text/plain", "Document not found. Refresh the dashboard and try again.");
  const bytes = await g.download(id);
  const ascii = f.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  res.writeHead(200, {"content-type": f.mimeType || "application/octet-stream", "content-length": bytes.length,
    "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    "cache-control": "private, no-store", "x-content-type-options": "nosniff"});
  res.end(bytes);
}

async function data(refresh) {
  if (!refresh && cache && Date.now() - cacheAt < CONFIG.cacheMs) return cache;
  if (!inflight) inflight = readAll().then(d => { cache = d; cacheAt = Date.now(); return d; }).finally(() => { inflight = null; });
  return inflight;
}


// The data one user may see: only the sheet tabs, ROC workbooks and document links they are allowed.
function forUser(d, perms) {
  const want = new Set(ALWAYS);
  for (const [k, tabs] of Object.entries(TAB_TABLES)) if (perms[k]) tabs.forEach(t => want.add(t));
  const tables = {};
  for (const [t, rows] of Object.entries(d.tables)) if (want.has(t)) tables[t] = rows;
  if (!perms["tab.fin"] && !perms["tab.loans"] && tables.Financials && tables.Financials.length) {
    const head = tables.Financials[0].map(String), keep = FIN_LIGHT.map(h => head.indexOf(h)).filter(i => i >= 0);
    tables.Financials = tables.Financials.map(r => keep.map(i => r[i] ?? ""));
  }
  const docs = {};
  for (const [name, kinds] of Object.entries(d.docs || {})) {
    const k = Object.fromEntries(Object.entries(kinds).filter(([kind]) => perms["doc." + kind]));
    if (Object.keys(k).length) docs[name] = k;
  }
  const roc = perms["tab.dirreg"] ? d.roc : {files: [], errors: [], total: 0, withheld: true};
  return {readAt: d.readAt, tables, roc, docs, docsError: d.docsError, withheld: CONFIG.tabs.filter(t => !want.has(t))};
}

const send = (res, code, type, body, extra = {}) => {
  res.writeHead(code, {"content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer", "x-frame-options": "SAMEORIGIN", ...extra});
  res.end(body);
};
const json = (res, code, obj, extra) => send(res, code, "application/json; charset=utf-8", JSON.stringify(obj), extra);

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/.test(req.headers["content-type"] || ""))   // other sites' forms can't send JSON, so this blocks CSRF
      return reject(Object.assign(new Error("Expected JSON"), {status: 415}));
    let body = "";
    req.on("data", c => { body += c; if (body.length > 200_000) { reject(Object.assign(new Error("Too large"), {status: 413})); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(Object.assign(new Error("Bad JSON"), {status: 400})); } });
    req.on("error", reject);
  });
}

const cookieOf = req => (/(?:^|;\s*)cm_session=([^;]+)/.exec(req.headers.cookie || "") || [])[1];
const isHttps = req => req.socket.encrypted || /^https/i.test(req.headers["x-forwarded-proto"] || "");
// No Path attribute: the browser scopes the cookie to this app's folder, which also works behind a /p/... proxy prefix.
const setCookie = (req, value, maxAge) =>
  `cm_session=${value}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
const clientIp = req => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
const isLoopback = req => !req.headers["x-forwarded-for"] && /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || "");

function who(req) {
  if (!access.anyAccounts()) return isLoopback(req) ? {user: "local", name: "Local", admin: true, owner: true} : null;
  return access.check(cookieOf(req));
}

const me = u => ({user: u.user, name: u.name || u.user, admin: !!u.admin, owner: !!u.owner,
  perms: access.permsFor(u), noLogin: !access.anyAccounts()});

const BUILD = require("./buildinfo.js")(__dirname);   // when the code was last updated, shown in the page header

const page = name => fs.readFileSync(path.join(__dirname, "public", name));

http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname, q = new URL(req.url, "http://x").searchParams;
  try {
    if (p === "/healthz") return send(res, 200, "text/plain", "ok");
    if (p === "/version") return json(res, 200, BUILD);

    if (p === "/login" && req.method === "POST") {
      const b = await readJson(req);
      const keys = [`u:${String(b.user || "").trim().toLowerCase()}`, `ip:${clientIp(req)}`];
      if (access.throttled(keys)) return json(res, 429, {error: "Too many attempts. Try again in 15 minutes."});
      const u = access.verify(b.user, b.password);
      if (!u) { access.failed(keys); return json(res, 401, {error: "Wrong user name or password"}); }
      access.cleared(keys);
      return json(res, 200, {ok: true}, {"set-cookie": setCookie(req, access.issue(u), access.SESSION_HOURS * 3600)});
    }
    if (p === "/logout" && req.method === "POST")
      return json(res, 200, {ok: true}, {"set-cookie": setCookie(req, "", 0)});

    const u = who(req);
    if (!u) {
      if (!access.anyAccounts())
        return send(res, 503, "text/plain", "Set DASHBOARD_PASSWORD in the server settings (environment or .env) and restart, then sign in with DASHBOARD_USER and that password.");
      if (p === "/" || p === "/index.html") return send(res, 200, "text/html; charset=utf-8", page("login.html"));
      return json(res, 401, {error: "Sign in required", signin: true});
    }
    const perms = access.permsFor(u);

    if (p === "/" || p === "/index.html") return send(res, 200, "text/html; charset=utf-8", page("index.html"));
    if (p === "/api/me") return json(res, 200, me(u));
    if (p === "/api/data") return json(res, 200, forUser(await data(q.has("refresh") && perms["act.refresh"]), perms));
    const doc = /^\/api\/doc\/([A-Za-z0-9_-]{10,})$/.exec(p);
    if (doc) return await sendDoc(res, doc[1], perms);

    if (p === "/api/compliance" && req.method === "GET") {
      if (!perms["tab.mgmt"]) return json(res, 403, {error: "No access to the Management dashboard"});
      return json(res, 200, {heads: COMPLIANCE.heads, status: COMPLIANCE.status, canEdit: !!perms["act.compliance"], rows: await complianceRows(q.has("refresh"))});
    }
    if (p === "/api/compliance" && req.method === "POST") {
      if (!perms["tab.mgmt"] || !perms["act.compliance"]) return json(res, 403, {error: "You can view but not update compliance"});
      await saveCompliance(u, await readJson(req));
      return json(res, 200, {ok: true, rows: await complianceRows(true)});
    }

    if (p === "/api/password" && req.method === "POST") {
      const b = await readJson(req);
      const fresh = access.changeOwnPassword(u, b.current, b.next);
      return json(res, 200, {ok: true}, {"set-cookie": setCookie(req, access.issue(fresh), access.SESSION_HOURS * 3600)});
    }

    if (p.startsWith("/api/admin/")) {
      if (!u.admin) return json(res, 403, {error: "Admins only"});
      if (p === "/api/admin/access" && req.method === "GET") return json(res, 200, access.adminView());
      if (req.method !== "POST") return json(res, 405, {error: "Use POST"});
      const b = await readJson(req);
      if (p === "/api/admin/users") access.saveUsers(b.users, u);
      else if (p === "/api/admin/user") access.addUser(b, u);
      else if (p === "/api/admin/user/delete") access.deleteUser(b.user, u);
      else return json(res, 404, {error: "Not found"});
      return json(res, 200, access.adminView());
    }
    send(res, 404, "text/plain", "Not found");
  } catch (e) {
    if (e.status && e.status < 500 && !e.google) return json(res, e.status, {error: e.message});
    const hint = e.status === 403 && /has not been used|disabled/.test(e.message)
      ? "Enable the Google Sheets API and Google Drive API for the service account's Cloud project."
      : e.status === 403 || e.status === 404
        ? `Share the Company Master Data sheet and the Drive folder with ${g.clientEmail()} (Viewer).`
        : "";
    json(res, 502, {error: e.message, hint});
  }
}).listen(CONFIG.port, () => {
  console.log(`Company Master Dashboard: http://localhost:${CONFIG.port}`);
  if (!access.anyAccounts()) console.log("No DASHBOARD_PASSWORD set: only this computer (localhost) can open the dashboard, as admin.");
});
