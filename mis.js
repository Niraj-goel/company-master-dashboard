// MIS reports behind the Management dashboard tab. Today: Creditors outstanding.
//
// The report is an Excel file the accounts team saves to a Drive folder (one file per run, e.g.
// "Creditors_Outstanding_All_Companies_27-11-2026.xlsx", built from Highrise "Outstanding Without Ageing").
// The newest file in the folder whose name contains "Creditors" is read; it is downloaded again only when the
// file in Drive changes, or on Refresh. The service account needs Viewer access to the folder.
//
// Workbook layout (as made by the accounts team):
//   Summary          title, "As on DD-Mon-YYYY | ₹ in Lakh | ...", then S.No | Company | Total Payable | Not Due |
//                    Overdue Total | 1-15 | 16-30 | 31-180 | >180 Days | % Overdue | Advances | Net | Open Bills | Parties,
//                    ending with "GRAND TOTAL — GROUP".
//   one per company  "<COMPANY> — Creditors Outstanding ...", section A party-wise (ends at TOTAL),
//                    section B bill-wise overdue (ends at TOTAL OVERDUE). Amounts in rupees.
//   Data             every Highrise row (bill or advance) of every company, with Cost_Centre and helper columns
//                    Payable (Cr) / Advance (Dr) / Days Overdue / Ageing Bucket. Drill-down and its filters use this.
const g = require("./google.js");
const XLSX = require("./lib/xlsx.js");

const CREDITORS_FOLDER = process.env.CREDITORS_FOLDER_ID || "1jiYRYhb4kqQTWoWuCnrWF6q2KtU5PMKu";   // "Alcove - Creditors Outstanding Reports"
const num = v => typeof v === "number" ? v : (v === "" || v == null || /^-+$/.test(String(v).trim())) ? 0
  : +String(v).replace(/[,\s₹%]/g, "").replace(/^\((.*)\)$/, "-$1") || 0;
const str = v => String(v ?? "").trim();
const rows = ws => XLSX.utils.sheet_to_json(ws, {header: 1, raw: true, defval: ""});
const SUM_KEYS = ["total", "notDue", "overdue", "d1_15", "d16_30", "d31_180", "d180", "pctOverdue", "advances", "net", "bills", "parties"];
const PARTY_KEYS = ["party", "group", "msme", "bills", "total", "notDue", "overdue", "d1_15", "d16_30", "d31_180", "d180", "advances", "net", "drcr"];
const BILL_KEYS = ["party", "msme", "vchType", "vchNo", "billNo", "billDate", "dueDate", "days", "bucket", "amount", "costCentre", "narration"];
const ENTRY_FIELDS = ["party", "group", "msme", "cc", "vchType", "vchNo", "billNo", "billDate", "dueDate", "payable", "advance", "days", "bucket", "narration"];
const key = s => str(s).toUpperCase().replace(/PRIVATE LIMITED/g, "PVT LTD").replace(/[^A-Z0-9]/g, "");

function parse(buf) {
  const wb = XLSX.read(buf, {cellDates: false});
  const sum = rows(wb.Sheets.Summary || {});
  const asOn = (sum.slice(0, 4).map(r => str(r[0])).join(" ").match(/As on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/) || [])[1] || "";
  const h = sum.findIndex(r => /^s\.?\s*no/i.test(str(r[0])) && /company/i.test(str(r[1])));
  if (h < 0) throw new Error("The Summary sheet has no S.No | Company header row – has the report layout changed?");
  const companies = [];
  let grand = null;
  for (const r of sum.slice(h + 1)) {
    const name = str(r[1]);
    if (!name) continue;
    const vals = Object.fromEntries(SUM_KEYS.map((k, i) => [k, num(r[2 + i])]));
    if (/grand total/i.test(name)) { grand = {name: "Group total", ...vals}; break; }
    if (/^check/i.test(name)) continue;
    companies.push({name, ...vals});
  }
  // Company sheets: matched to Summary names by their title row.
  const sheets = {};
  for (const n of wb.SheetNames) {
    if (/^(summary|data|controls)$/i.test(n)) continue;
    const a = rows(wb.Sheets[n]);
    const title = str((a[0] || [])[0]).split(/\s+[—-]\s+Creditors/i)[0];
    if (title) sheets[key(title)] = {sheet: n, rows: a};
  }
  companies.forEach(c => { c.sheet = (sheets[key(c.name)] || {}).sheet || ""; });
  // Data sheet: every open bill / advance with its cost centre (cached values of the helper columns).
  const data = {};
  const d = rows(wb.Sheets.Data || {}), hd = d.findIndex(r => str(r[0]) === "Company" && str(r[1]) === "Account_Name");
  if (hd >= 0) {
    const H = d[hd].map(str), c = n => H.indexOf(n);
    const ix = {co: c("Company"), party: c("Account_Name"), group: c("Group_Name"), vchType: c("Voucher_type"), vchNo: c("Voucher_No"), billNo: c("Bill_No"),
      billDate: c("Bill_Date"), due: c("Eff. Due Date"), narr: c("Narration"), cc: c("Cost_Centre"), msme: c("MSME_Category"),
      pay: H.findIndex(h => /^payable/i.test(h)), adv: H.findIndex(h => /^advance/i.test(h)), days: c("Days Overdue"), bucket: c("Ageing Bucket")};
    const day = v => typeof v === "number" ? XLSX.SSF.format("dd-mm-yyyy", v) : str(v);
    for (const r of d.slice(hd + 1)) {
      const co = str(r[ix.co]); if (!co) continue;
      (data[key(co)] ??= []).push([str(r[ix.party]), str(r[ix.group]), /^y/i.test(str(r[ix.msme])) ? "Yes" : "", str(r[ix.cc]) || "(none)", str(r[ix.vchType]), str(r[ix.vchNo]),
        str(r[ix.billNo]), day(r[ix.billDate]), day(r[ix.due]), num(r[ix.pay]), num(r[ix.adv]), num(r[ix.days]), str(r[ix.bucket]), str(r[ix.narr]).slice(0, 160)]);
    }
  }
  return {asOn, unit: "lakh", companies, grand, sheets, data};
}

function detail(sheet) {
  const a = sheet.rows, parties = [], bills = [];
  const ha = a.findIndex(r => /^s\.?\s*no/i.test(str(r[0])) && /party/i.test(str(r[1])) && /ledger/i.test(str(r[2])));
  if (ha >= 0) for (const r of a.slice(ha + 1)) {
    if (/^total/i.test(str(r[1])) || (!str(r[0]) && !str(r[1]))) break;
    const p = Object.fromEntries(PARTY_KEYS.map((k, i) => [k, ["party", "group", "msme", "drcr"].includes(k) ? str(r[1 + i]) : num(r[1 + i])]));
    parties.push(p);
  }
  const hb = a.findIndex(r => /^s\.?\s*no/i.test(str(r[0])) && /party/i.test(str(r[1])) && /msme/i.test(str(r[2])) && /vch/i.test(str(r[3])));
  if (hb >= 0) for (const r of a.slice(hb + 1)) {
    if (/^total/i.test(str(r[1])) || (!str(r[0]) && !str(r[1]))) break;
    bills.push(Object.fromEntries(BILL_KEYS.map((k, i) => [k, ["days", "amount"].includes(k) ? num(r[1 + i]) : str(r[1 + i])])));
  }
  return {parties, bills};
}

let cache = null;   // {file, parsed, at}
async function creditors(refresh) {
  if (cache && !refresh && Date.now() - cache.at < 5 * 60_000) return cache;
  const files = (await g.listFolder(CREDITORS_FOLDER))
    .filter(f => /creditor/i.test(f.name) && /\.xlsx?$/i.test(f.name))
    .sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
  if (!files.length) throw Object.assign(new Error("No Creditors Excel file found in the Creditors Outstanding Reports folder in Drive."), {status: 404});
  const f = files[0];
  if (!cache || cache.file.id !== f.id || cache.file.modifiedTime !== f.modifiedTime)
    cache = {file: f, parsed: parse(await g.download(f.id)), at: Date.now()};
  else cache.at = Date.now();
  return cache;
}

const links = f => ({file: {id: f.id, name: f.name, modifiedTime: f.modifiedTime, url: `https://drive.google.com/file/d/${f.id}/view`},
  folderUrl: `https://drive.google.com/drive/folders/${CREDITORS_FOLDER}`});

async function creditorsSummary(refresh) {
  const c = await creditors(refresh), p = c.parsed;
  return {...links(c.file), readAt: new Date(c.at).toISOString(), asOn: p.asOn, unit: p.unit, companies: p.companies, grand: p.grand};
}
async function creditorsCompany(name) {
  const c = await creditors(false), co = c.parsed.companies.find(x => x.name === name);
  if (!co) throw Object.assign(new Error("Company not in the report"), {status: 404});
  const sh = co.sheet && Object.values(c.parsed.sheets).find(s => s.sheet === co.sheet);
  const entries = c.parsed.data[key(name)];
  if (entries) return {name, asOn: c.parsed.asOn, fields: ENTRY_FIELDS, entries};
  return {name, asOn: c.parsed.asOn, ...(sh ? detail(sh) : {parties: [], bills: []})};   // older files without a Data sheet
}

module.exports = {creditorsSummary, creditorsCompany, parse, detail};
