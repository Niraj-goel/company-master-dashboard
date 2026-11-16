// Company Master Dashboard server.
// Serves public/index.html and /api/data, which reads the Company Master Data sheet and the ROC folder
// with the service-account key kept on this server. The key never reaches the browser.
// Settings and the key are read from .env (see .env.example).
require("./env.js");
const http = require("http");
const fs = require("fs");
const path = require("path");
const g = require("./google.js");
const {findDocuments} = require("./docs.js");

const CONFIG = {
  port: +process.env.PORT || 3000,
  sheetId: process.env.SHEET_ID || "1nK-tKjoSH2Y84YE-0rOIgQgvBA238mCUBp0fK5igdRg",
  rocFolder: process.env.ROC_FOLDER_ID || "128CihawD0mDOwpsd2m1EIo5N40jzwAp0",
  panFolder: process.env.PAN_FOLDER_ID || "1l4Y_WnaUfaFSeElUvKBxXA-XLJd5UfQV",   // Statutory/PAN
  gstFolder: process.env.GST_FOLDER_ID || "1W7kXNNf7X6vyuhiE-SlQrSSD_Fc22jSY",   // Statutory/GST (searched with its subfolders)
  tabs: ["Entities", "Share count", "Shareholders", "Shareholding", "Cross holdings", "Financials",
    "Borrowings by lender", "Loans given", "FS holders", "MCA master", "MCA directors", "MCA charges"],
  cacheMs: 2 * 60 * 1000,                     // reuse a read for 2 minutes unless ?refresh=1
  user: process.env.DASHBOARD_USER || "alcove",
  password: process.env.DASHBOARD_PASSWORD || "", // set this before sharing the server with anyone
};

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
async function sendDoc(res, id) {
  if (!allowedDocs.size) await data(false);
  const f = allowedDocs.get(id);
  if (!f) return send(res, 404, "text/plain", "Document not found. Refresh the dashboard and try again.");
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

function authorised(req) {
  if (!CONFIG.password) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  const [u, ...p] = Buffer.from(m[1], "base64").toString().split(":");
  return u === CONFIG.user && p.join(":") === CONFIG.password;
}

const send = (res, code, type, body) => {
  res.writeHead(code, {"content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff"});
  res.end(body);
};

http.createServer(async (req, res) => {
  if (!authorised(req)) { res.writeHead(401, {"www-authenticate": 'Basic realm="Company Master"'}); return res.end("Sign in required"); }
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/" || url.pathname === "/index.html")
      return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(__dirname, "public", "index.html")));
    if (url.pathname === "/api/data")
      return send(res, 200, "application/json", JSON.stringify(await data(url.searchParams.has("refresh"))));
    const doc = /^\/api\/doc\/([A-Za-z0-9_-]{10,})$/.exec(url.pathname);
    if (doc) return await sendDoc(res, doc[1]);
    send(res, 404, "text/plain", "Not found");
  } catch (e) {
    const hint = e.status === 403 && /has not been used|disabled/.test(e.message)
      ? "Enable the Google Sheets API and Google Drive API for the service account's Cloud project."
      : e.status === 403 || e.status === 404
        ? `Share the Company Master Data sheet and the Drive folder with ${g.clientEmail()} (Viewer).`
        : "";
    send(res, 502, "application/json", JSON.stringify({error: e.message, hint}));
  }
}).listen(CONFIG.port, () => {
  console.log(`Company Master Dashboard: http://localhost:${CONFIG.port}`);
  if (!CONFIG.password) console.log("No DASHBOARD_PASSWORD set: anyone who can reach this port can see the data.");
});
