// Statutory compliance tracker behind the Management dashboard tab.
//
// Returns (what is filed or paid, how often, and when it is due) are defined in RETURNS below. Each company's
// registrations (TAN, GST filing frequency, PF / ESI / P.Tax numbers ...) decide which returns apply to it.
// Two tabs in the Company Master Data sheet hold the data. Every save appends a row, so each tab is also the audit
// trail; the latest row for a key is the current value:
//   "Compliance"        one row per period + company + return (filed date, amount, uploaded, not applicable, remark)
//   "Compliance setup"  one row per company (registrations)
//
// Due dates were checked on 27 Nov 2026 against public guides (CBDT / CBIC / EPFO / ESIC rules as summarised by
// taxguru, cleartax, caclubindia, tallysolutions). They change by notification: correct them here when they do.
// Under the Income-tax Act 2025, FY 2026-27 TDS returns are Form 138 (was 24Q), 140 (was 26Q) and 144 (was 27Q).
const g = require("./google.js");

// old: the form number used for periods up to March 2026 (Income-tax Act 1961).
// due: months after the period's last month, and the day (31 = last day of that month). mar: override when the
// period ends in March. freq: M monthly, Q quarterly (periods end Jun / Sep / Dec / Mar), Y yearly (period = March,
// the financial year end), M2 = first two months of each quarter only. needs: the registration that makes it apply.
const RETURNS = [
  {id: "TDS-PAY", short: "Challan 281", head: "TDS", name: "TDS payment – Challan 281", freq: "M", needs: "tan", due: {m: 1, d: 7}, mar: {m: 1, d: 30}},
  {id: "TDS-138", old: "Form 24Q", short: "Form 138", head: "TDS", name: "TDS return – salary (Form 138, was 24Q)", freq: "Q", needs: "tan", due: {m: 1, d: 31}, mar: {m: 2, d: 31}},
  {id: "TDS-140", old: "Form 26Q", short: "Form 140", head: "TDS", name: "TDS return – non-salary (Form 140, was 26Q)", freq: "Q", needs: "tan", due: {m: 1, d: 31}, mar: {m: 2, d: 31}},
  {id: "TDS-144", old: "Form 27Q", short: "Form 144", head: "TDS", name: "TDS return – non-resident (Form 144, was 27Q)", freq: "Q", needs: "nri", due: {m: 1, d: 31}, mar: {m: 2, d: 31}},
  {id: "GSTR1", short: "GSTR-1", head: "GST", name: "GSTR-1 – monthly", freq: "M", needs: "gst", gst: "Monthly", due: {m: 1, d: 11}},
  {id: "GSTR3B", short: "GSTR-3B", head: "GST", name: "GSTR-3B – monthly", freq: "M", needs: "gst", gst: "Monthly", due: {m: 1, d: 20}},
  {id: "GSTR1-Q", short: "GSTR-1 (Q)", head: "GST", name: "GSTR-1 – quarterly (QRMP)", freq: "Q", needs: "gst", gst: "QRMP", due: {m: 1, d: 13}},
  {id: "PMT06", short: "PMT-06", head: "GST", name: "GST payment – PMT-06 (QRMP)", freq: "M2", needs: "gst", gst: "QRMP", due: {m: 1, d: 25}},
  {id: "GSTR3B-Q", short: "GSTR-3B (Q)", head: "GST", name: "GSTR-3B – quarterly (QRMP, West Bengal)", freq: "Q", needs: "gst", gst: "QRMP", due: {m: 1, d: 24}},
  {id: "GSTR9", short: "GSTR-9", head: "GST", name: "GSTR-9 – annual return", freq: "Y", needs: "gst", due: {m: 9, d: 31}},
  {id: "PF", short: "PF ECR", head: "PF", name: "PF – ECR and payment", freq: "M", needs: "pf", due: {m: 1, d: 15}},
  {id: "ESI", short: "ESI", head: "ESI", name: "ESI – contribution", freq: "M", needs: "esi", due: {m: 1, d: 15}},
  {id: "PTAX", short: "P.Tax", head: "P.Tax", name: "P.Tax – monthly payment (West Bengal)", freq: "M", needs: "ptax", due: {m: 1, d: 21}},
  {id: "PTAX-R", short: "P.Tax return", head: "P.Tax", name: "P.Tax – annual return (West Bengal)", freq: "Y", needs: "ptax", due: {m: 4, d: 31}},
  {id: "GRAT", short: "Gratuity", head: "Gratuity", name: "Gratuity – annual premium / provision", freq: "Y", needs: "grat", due: null},
  {id: "PENS", short: "Pension", head: "Pension", name: "Pension – contribution", freq: "M", needs: "pens", due: null},
];
const HEADS = [...new Set(RETURNS.map(r => r.head))];
const IDS = new Set(RETURNS.map(r => r.id));
const SETUP_FIELDS = ["gstFreq", "tan", "nri", "pf", "esi", "ptax", "grat", "pens"];

const TAB = "Compliance", SETUP_TAB = "Compliance setup";
const HEADER = ["Period", "Company", "Return", "Filed / paid on", "Amount (₹)", "Uploaded in system", "Not applicable", "Remark", "Updated by", "Updated at"];
const SETUP_HEADER = ["Company", "GST filing", "TAN", "Non-resident TDS", "PF code", "ESI code", "P.Tax RC no.", "Gratuity", "Pension", "Updated by", "Updated at"];

const bad = msg => Object.assign(new Error(msg), {status: 400});
const str = v => String(v ?? "").trim();
const yn = v => v === true || /^(y|yes|true|1)$/i.test(str(v)) ? "Y" : "";

let cache = null, cacheAt = 0;
async function readTab(sheetId, tab) {
  try { return ((await g.sheetValues(sheetId, [`'${tab}'`])).valueRanges[0].values || []).slice(1); }
  catch (e) { if (/Unable to parse range/i.test(e.message)) return []; throw e; }   // tab not created yet
}
async function read(sheetId, fresh) {
  if (!fresh && cache && Date.now() - cacheAt < 30_000) return cache;
  const [rows, setupRows] = await Promise.all([readTab(sheetId, TAB), readTab(sheetId, SETUP_TAB)]);
  const latest = new Map();
  for (const r of rows) { const k = [0, 1, 2].map(i => str(r[i])); if (k.every(Boolean)) latest.set(k.join("|"), r); }
  const setup = new Map();
  for (const r of setupRows) if (str(r[0])) setup.set(str(r[0]), r);
  cache = {
    rows: [...latest.values()].map(r => ({period: str(r[0]), company: str(r[1]), ret: str(r[2]), filed: str(r[3]),
      amount: str(r[4]) === "" ? null : +r[4], uploaded: yn(r[5]), na: yn(r[6]), remark: str(r[7]), by: str(r[8]), at: str(r[9])})),
    setup: [...setup.values()].map(r => ({company: str(r[0]), gstFreq: str(r[1]) || "Monthly", tan: str(r[2]), nri: yn(r[3]),
      pf: str(r[4]), esi: str(r[5]), ptax: str(r[6]), grat: yn(r[7]), pens: yn(r[8]), by: str(r[9]), at: str(r[10])})),
  };
  cacheAt = Date.now();
  return cache;
}

function saveReturns(sheetId, user, body) {
  const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
  const rows = items.map(x => {
    const period = str(x.period), company = str(x.company), ret = str(x.ret), filed = str(x.filed);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw bad("Bad period");
    if (!company || company.length > 200) throw bad("Bad company");
    if (!IDS.has(ret)) throw bad("Unknown return");
    if (filed && !/^\d{4}-\d{2}-\d{2}$/.test(filed)) throw bad("Filed date must be a date");
    const amount = str(x.amount) === "" ? "" : Number(x.amount);
    if (amount !== "" && !(isFinite(amount) && amount >= 0)) throw bad("Amount must be a number");
    return [period, company, ret, filed, amount, yn(x.uploaded), yn(x.na), str(x.remark).slice(0, 300), user, new Date().toISOString()];
  });
  cache = null;
  return rows.length ? g.appendRows(sheetId, TAB, HEADER, rows) : null;
}

function saveSetup(sheetId, user, x) {
  const company = str(x.company);
  if (!company || company.length > 200) throw bad("Bad company");
  const tan = str(x.tan).toUpperCase();
  if (tan && !/^[A-Z]{4}\d{5}[A-Z]$/.test(tan)) throw bad("TAN must look like ABCD12345E");
  const gstFreq = x.gstFreq === "QRMP" ? "QRMP" : "Monthly";
  const code = v => str(v).slice(0, 40);
  cache = null;
  return g.appendRows(sheetId, SETUP_TAB, SETUP_HEADER,
    [[company, gstFreq, tan, yn(x.nri), code(x.pf), code(x.esi), code(x.ptax), yn(x.grat), yn(x.pens), user, new Date().toISOString()]]);
}

module.exports = {RETURNS, HEADS, SETUP_FIELDS, read, saveReturns, saveSetup};
