// Minimal Google API client for a service account. No dependencies (Node 18+).
// Credentials come from .env (GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_TOKEN_URI).
require("./env.js");
const crypto = require("crypto");

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");

let key = null, token = null, tokenExp = 0;
const b64url = b => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function loadKey() {
  if (key) return key;
  const {GOOGLE_CLIENT_EMAIL: email, GOOGLE_PRIVATE_KEY: pk, GOOGLE_TOKEN_URI: uri} = process.env;
  if (!email || !pk) throw new Error("GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY must be set in .env");
  key = {client_email: email, private_key: pk.replace(/\\n/g, "\n"), token_uri: uri || "https://oauth2.googleapis.com/token"};
  return key;
}

async function accessToken() {
  if (token && Date.now() < tokenExp - 60_000) return token;
  const k = loadKey(), now = Math.floor(Date.now() / 1000);
  const unsigned = b64url(JSON.stringify({alg: "RS256", typ: "JWT"})) + "." +
    b64url(JSON.stringify({iss: k.client_email, scope: SCOPES, aud: k.token_uri, iat: now, exp: now + 3600}));
  const sig = b64url(crypto.createSign("RSA-SHA256").update(unsigned).sign(k.private_key));
  const res = await fetch(k.token_uri, {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig})});
  const j = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${j.error_description || j.error || res.status}`);
  token = j.access_token; tokenExp = Date.now() + j.expires_in * 1000;
  return token;
}

async function api(url, {raw = false} = {}) {
  const res = await fetch(url, {headers: {authorization: `Bearer ${await accessToken()}`}});
  if (!res.ok) {
    let msg = res.statusText; try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch {}
    const e = new Error(`${res.status} ${msg}`); e.status = res.status; throw e;
  }
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

const sheetValues = (id, ranges) =>
  api(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?` +
    new URLSearchParams([...ranges.map(r => ["ranges", r]), ["valueRenderOption", "UNFORMATTED_VALUE"], ["dateTimeRenderOption", "FORMATTED_STRING"]]));

async function listFolder(folderId) {
  const files = []; let pageToken;
  do {
    const j = await api("https://www.googleapis.com/drive/v3/files?" + new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`, fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
      pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true", ...(pageToken ? {pageToken} : {})}));
    files.push(...j.files); pageToken = j.nextPageToken;
  } while (pageToken);
  return files;
}

const download = id => api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, {raw: true});

module.exports = {accessToken, sheetValues, listFolder, download, clientEmail: () => loadKey().client_email};
