// Finds each entity's documents in Drive: ROC (CIN), PAN card and GST certificate.
// A file matches an entity when its name contains the entity's CIN, PAN or GSTIN, or names the same company.
const g = require("./google.js");

const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Same rule as the dashboard's coKey, plus file-name clean-up (extension, underscores, "photocopy").
const coKey = s => norm(String(s).toLowerCase().replace(/\.[a-z0-9]{2,4}$/, "").replace(/_/g, " ").replace(/\bphoto ?copy\b/g, "")
  .replace(/\(.*?\)/g, "").replace(/\b(private|pvt|limited|ltd|llp|the)\b\.?/g, ""));
const full = s => norm(String(s).toLowerCase().replace(/\.[a-z0-9]{2,4}$/, "").replace(/\bprivate\b/g, "pvt").replace(/\blimited\b/g, "ltd"));

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

async function walk(folderId, depth = 2) {
  const out = [];
  for (const f of await g.listFolder(folderId)) {
    if (f.mimeType === "application/vnd.google-apps.folder") { if (depth > 0) out.push(...await walk(f.id, depth - 1)); }
    else out.push(f);
  }
  return out;
}

// files: Drive files; entity: {name, cin, pan, gst}; prefer: extensions in order of preference
function pick(files, entity, prefer) {
  const ids = [entity.cin, entity.pan, entity.gst].filter(v => v && v.length >= 10).map(v => v.toUpperCase());
  const key = coKey(entity.name);
  let hits = files.filter(f => ids.some(id => f.name.toUpperCase().includes(id)));
  if (!hits.length && key) hits = files.filter(f => coKey(f.name) === key);
  if (!hits.length && key.length >= 8) hits = files.filter(f => distance(coKey(f.name), key) <= 2);
  if (!hits.length) return null;
  const rank = f => {
    const ext = (f.name.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
    const p = prefer.indexOf(ext);
    return (p < 0 ? 9 : p) * 100 + distance(full(f.name), full(entity.name));
  };
  const f = hits.sort((a, b) => rank(a) - rank(b))[0];
  return {id: f.id, name: f.name, mimeType: f.mimeType};
}

// entities: [{name, cin, pan, gst}] -> {entity name: {roc, pan, gst}}, plus the set of file ids that may be downloaded
async function findDocuments(entities, folders) {
  const [roc, pan, gst] = await Promise.all([walk(folders.roc, 0), walk(folders.pan), walk(folders.gst)]);
  const docs = {}, allowed = new Map();
  for (const e of entities) {
    const d = {
      roc: pick(roc, e, ["pdf", "xlsx", "xls"]),
      pan: pick(pan.filter(f => !/\.xlsx?$/i.test(f.name)), e, ["pdf", "jpg", "jpeg", "png"]),
      gst: pick(gst, e, ["pdf", "jpg", "jpeg", "png"]),
    };
    for (const k in d) if (d[k]) allowed.set(d[k].id, d[k]); else delete d[k];
    docs[String(e.name).trim()] = d;
  }
  return {docs, allowed};
}

module.exports = {findDocuments, coKey};
