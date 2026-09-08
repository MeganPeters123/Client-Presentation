/* Parses position-level "fund holdings" exports into fund snapshots: { fund, fundCode, asOf, total, segments, source }.
   Three known raw formats are auto-detected — no column mapping needed, since each is a fixed report layout:
     A. Custodian "Daily Pres" HTML valuation export (same as Fund Snapshot's format)
     B. Flat CSV valuation export (Pfolio / Security / ... / CatSub, one or more portfolios per file)
     C. "Investment Portfolio Detail" binary .xls (hierarchical: asset class -> sector -> holding) */
"use strict";

const MONTH_ABBR = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const ASSET_CLASS_ALIASES = {
  "jse-listed equity": "JSE-listed Equity", "local equity": "JSE-listed Equity", "sa equity": "JSE-listed Equity", "equities": "JSE-listed Equity",
  "global-listed equity": "Global-listed Equity", "foreign equity": "Global-listed Equity", "global equity": "Global-listed Equity", "offshore equity": "Global-listed Equity",
  "sa cash": "SA Cash", "local cash": "SA Cash", "local money market": "SA Cash", "cash": "SA Cash",
  "global cash": "Global Cash", "foreign cash": "Global Cash", "offshore cash": "Global Cash",
  "sa fixed income": "SA Fixed Income", "local fixed income": "SA Fixed Income", "local bonds": "SA Fixed Income", "local income": "SA Fixed Income", "fixed income": "SA Fixed Income",
  "global fixed income": "Global Fixed Income", "foreign fixed income": "Global Fixed Income", "foreign bonds": "Global Fixed Income", "offshore bonds": "Global Fixed Income",
  "sa property": "SA Property", "local property": "SA Property",
  "global property": "Global Property", "foreign property": "Global Property", "offshore property": "Global Property"
};
function normalizeAssetClassLabel(label) {
  const key = String(label == null ? "" : label).trim().toLowerCase();
  return ASSET_CLASS_ALIASES[key] || String(label == null ? "" : label).trim();
}
function localForeignLabel(category, side) {
  const cat = String(category || "").trim();
  if (/^equit/i.test(cat)) return side === "local" ? "JSE-listed Equity" : "Global-listed Equity";
  return (side === "local" ? "SA " : "Global ") + cat;
}
function isLocalCcy(ccy) {
  return !!ccy && String(ccy).trim().toUpperCase() === "ZAR";
}
function titleCase(s) {
  return String(s || "").replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}

/* ---------- format A: custodian HTML "Daily Pres" export ---------- */
function parseCustodianHtmlHoldings(text, fileName) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;

  const rows = Array.from(table.querySelectorAll("tr"));
  let headerRow = null;
  for (const r of rows) {
    if (r.querySelectorAll("td.tblh").length > 5) { headerRow = r; break; }
  }
  if (!headerRow) return null;
  const headerCells = Array.from(headerRow.querySelectorAll("td"));
  const colIndex = {};
  headerCells.forEach((td, i) => { const name = td.textContent.trim(); if (name) colIndex[name] = i; });

  const need = ["Clean Market Value", "Sum of Market Value Income", "% of Total Market Value", "CCY"];
  for (const n of need) if (!(n in colIndex)) return null;

  const flat = [];
  for (const r of rows) {
    const tds = Array.from(r.querySelectorAll("td"));
    if (tds.length < 10) continue;
    const cls = (tds[0].getAttribute("class") || "").trim();
    if (cls !== "cLink" && cls !== "cIssue") continue;
    const rawLabel = tds[0].textContent || "";
    let nbsp = 0; while (nbsp < rawLabel.length && rawLabel.charCodeAt(nbsp) === 160) nbsp++;
    const level = Math.round(nbsp / 4);
    const label = rawLabel.replace(/ /g, " ").trim();
    const cell = name => { const idx = colIndex[name]; if (idx == null || idx >= tds.length) return ""; return (tds[idx].textContent || "").replace(/ /g, " ").trim(); };
    const num = name => { const n = parseFloat(cell(name)); return isNaN(n) ? null : n; };
    flat.push({ level, rowClass: cls, label, totalValue: num("Sum of Market Value Income"), pct: num("% of Total Market Value"), ccy: cell("CCY") });
  }
  if (!flat.length) return null;

  const rootRow = flat.find(r => r.level === 0) || flat[0];
  const asOfMatch = /as of\s+([\d\/]+)/i.exec(rootRow.label);
  const fundName = rootRow.label.replace(/\s+as of.*$/i, "").trim();
  const fundTotal = rootRow.totalValue;

  let currentL2 = null, currentL2Key = null;
  const localForeignByClass = {};
  for (const r of flat) {
    if (r.level === 2 && r.rowClass === "cLink") {
      currentL2 = r.label.trim(); currentL2Key = currentL2.toUpperCase();
      localForeignByClass[currentL2] = localForeignByClass[currentL2] || { local: 0, foreign: 0 };
      continue;
    }
    if (r.level === 4 && r.rowClass === "cIssue" && currentL2 && localForeignByClass[currentL2]) {
      const bucket = localForeignByClass[currentL2];
      if (isLocalCcy(r.ccy)) bucket.local += (r.pct || 0); else bucket.foreign += (r.pct || 0);
    }
  }
  const segments = [];
  flat.filter(r => r.level === 2 && r.rowClass === "cLink").forEach(r => {
    const split = localForeignByClass[r.label.trim()] || { local: 0, foreign: 0 };
    const label = titleCase(r.label);
    if (split.local > 0.005) segments.push({ category: localForeignLabel(label, "local"), value: (split.local / 100) * fundTotal });
    if (split.foreign > 0.005) segments.push({ category: localForeignLabel(label, "foreign"), value: (split.foreign / 100) * fundTotal });
  });

  let asOf = null;
  if (asOfMatch) { const d = new Date(asOfMatch[1]); if (!isNaN(d)) asOf = d; }
  return [{ fund: fundName, fundCode: null, asOf, total: fundTotal, segments, source: fileName, format: "Custodian HTML" }];
}

/* ---------- format B: flat CSV valuation export ---------- */
function parseFlatCsvHoldings(sheetRows, fileName) {
  let headerIdx = -1, colIndex = null;
  for (let i = 0; i < Math.min(10, sheetRows.length); i++) {
    const row = sheetRows[i] || [];
    const first = String(row[0] == null ? "" : row[0]).trim();
    if (first.toLowerCase() === "pfolio") {
      headerIdx = i;
      colIndex = {};
      row.forEach((c, idx) => { const name = String(c == null ? "" : c).trim(); if (name) colIndex[name] = idx; });
      break;
    }
  }
  const need = ["Pfolio", "SecCur", "Total Value (Pf)", "CatSub"];
  if (headerIdx === -1 || !need.every(n => n in colIndex)) return null;

  let asOf = null;
  for (let i = 0; i < headerIdx; i++) {
    const raw = String((sheetRows[i] || [])[0] == null ? "" : (sheetRows[i] || [])[0]).trim();
    const d = parseDateValue(raw);
    if (d) { asOf = d; break; }
  }

  const CATSUB_BASE = { SHS: "Equities", CALL: "Cash", DS: "Fixed Income", FMT: "Fixed Income" };
  const byFund = new Map();
  for (let i = headerIdx + 1; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (!row || !row.length) continue;
    const pfolio = String(row[colIndex["Pfolio"]] == null ? "" : row[colIndex["Pfolio"]]).trim();
    if (!pfolio) continue;
    const value = parseNumberValue(row[colIndex["Total Value (Pf)"]]);
    if (value == null) continue;
    const ccy = row[colIndex["SecCur"]];
    const catsub = String(row[colIndex["CatSub"]] == null ? "" : row[colIndex["CatSub"]]).trim().toUpperCase();
    const base = CATSUB_BASE[catsub] || "Other";
    const label = localForeignLabel(base, isLocalCcy(ccy) ? "local" : "foreign");

    if (!byFund.has(pfolio)) byFund.set(pfolio, { total: 0, segments: new Map() });
    const entry = byFund.get(pfolio);
    entry.total += value;
    entry.segments.set(label, (entry.segments.get(label) || 0) + value);
  }
  if (!byFund.size) return null;

  const out = [];
  byFund.forEach((entry, fund) => {
    out.push({
      fund, fundCode: null, asOf, total: entry.total,
      segments: [...entry.segments.entries()].map(([category, value]) => ({ category, value })),
      source: fileName, format: "Flat CSV"
    });
  });
  return out;
}

/* ---------- format C: "Investment Portfolio Detail" hierarchical binary .xls ---------- */
function parseIpdXlsHoldings(sheetRows, fileName) {
  let metaRow = null;
  for (let i = 0; i < Math.min(8, sheetRows.length); i++) {
    const row = sheetRows[i] || [];
    if (/^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}\s*-\s*[A-Za-z]{3}$/.test(String(row[0] || "").trim())) { metaRow = row; break; }
  }
  if (!metaRow) return null;

  let headerIdx = -1, isinCol = -1, holdingCol = -1, valueCol = -1, pctCategoryCol = -1;
  for (let i = 0; i < Math.min(10, sheetRows.length); i++) {
    const row = sheetRows[i] || [];
    const idx = row.findIndex(c => /isin/i.test(String(c || "")));
    if (idx !== -1) {
      headerIdx = i; isinCol = idx;
      holdingCol = row.findIndex(c => /holding\s*total/i.test(String(c || "")));
      valueCol = row.findIndex(c => /all\s*in\s*traded\s*market\s*value/i.test(String(c || "")));
      pctCategoryCol = row.findIndex(c => /%\s*of\s*category/i.test(String(c || "")));
      break;
    }
  }
  if (headerIdx === -1 || holdingCol === -1 || valueCol === -1 || pctCategoryCol === -1) return null;

  const dateMatch = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/.exec(String(metaRow[0]).trim());
  let asOf = null;
  if (dateMatch) {
    const mi = MONTH_ABBR[dateMatch[2].slice(0, 3).toLowerCase()];
    if (mi != null) asOf = new Date(Number(dateMatch[3]), mi, Number(dateMatch[1]));
  }
  const fundName = String(metaRow[5] || "").trim() || fileName;
  const fundCodeCell = metaRow.slice(6).find(c => c !== "" && c != null);
  const fundCode = fundCodeCell != null ? String(fundCodeCell).trim() : null;

  const segments = [];
  for (let i = headerIdx + 1; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (!row || !row.length) continue;
    const label = String(row[0] == null ? "" : row[0]).trim();
    if (!label) continue;
    const isin = String(row[isinCol] == null ? "" : row[isinCol]).trim();
    const holdingTotal = row[holdingCol];
    const pctCategory = parseNumberValue(row[pctCategoryCol]);
    if (!isin && (holdingTotal == null || holdingTotal === "") && pctCategory != null && pctCategory >= 99.9) {
      segments.push({ category: normalizeAssetClassLabel(label), value: parseNumberValue(row[valueCol]) || 0 });
    }
  }
  if (!segments.length) return null;
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  return [{ fund: fundName, fundCode, asOf, total, segments, source: fileName, format: "IPD Detail (.xls)" }];
}

/* ---------- dispatcher ---------- */
async function parseHoldingsFile(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf.slice(0, 8));

  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    throw new Error("This looks like a modern .xlsx workbook — Fund Holdings currently recognises the custodian HTML export, the flat valuation CSV, and the \"Investment Portfolio Detail\" .xls report. Let Claude know if this is a new format to support.");
  }

  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    const result = parseIpdXlsHoldings(rows, file.name);
    if (!result) throw new Error("This .xls file doesn't match the \"Investment Portfolio Detail\" layout Fund Holdings knows how to read.");
    return result;
  }

  const text = new TextDecoder("utf-8").decode(buf);
  if (/^\s*<html/i.test(text)) {
    const result = parseCustodianHtmlHoldings(text, file.name);
    if (!result) throw new Error("This HTML export doesn't match the custodian valuation layout Fund Holdings knows how to read.");
    return result;
  }

  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const result = parseFlatCsvHoldings(rows, file.name);
  if (!result) throw new Error("Unrecognised file format — Fund Holdings knows the custodian HTML export, the flat valuation CSV (with a \"Pfolio\" column), and the \"Investment Portfolio Detail\" .xls report.");
  return result;
}
