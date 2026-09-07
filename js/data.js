/* Parsing, column-mapping guesses, and value coercion for uploaded CSV/XLSX files. */
"use strict";

const FIELD_DEFS = {
  aum: [
    { key: "date", label: "Date", type: "date", synonyms: ["date", "asofdate", "valuationdate", "period", "month", "monthend"] },
    { key: "aum", label: "AUM value", type: "number", synonyms: ["aum", "totalvalue", "fundvalue", "netassetvalue", "nav", "marketvalue", "totalaum", "value"] }
  ],
  allocation: [
    { key: "category", label: "Category / Asset class", type: "text", synonyms: ["category", "assetclass", "class", "segment", "allocation", "name"] },
    { key: "value", label: "Value or weight", type: "number", synonyms: ["value", "marketvalue", "amount", "weight", "pct", "percent", "percentage"] }
  ],
  trades: [
    { key: "date", label: "Date", type: "date", synonyms: ["date", "tradedate", "dealdate"] },
    { key: "security", label: "Security", type: "text", synonyms: ["security", "instrument", "name", "ticker", "stock", "counter"] },
    { key: "type", label: "Buy / Sell", type: "text", synonyms: ["type", "buysell", "side", "action", "direction", "transactiontype"] },
    { key: "quantity", label: "Quantity", type: "number", optional: true, synonyms: ["quantity", "qty", "units", "shares", "volume"] },
    { key: "price", label: "Price", type: "number", optional: true, synonyms: ["price", "unitprice", "executionprice", "dealprice"] },
    { key: "value", label: "Value", type: "number", synonyms: ["value", "amount", "consideration", "tradevalue", "marketvalue"] }
  ]
};

function normalizeHeader(h) {
  return String(h == null ? "" : h).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function guessMapping(headers, fieldDefs) {
  const normHeaders = headers.map(h => ({ raw: h, norm: normalizeHeader(h) }));
  const mapping = {};
  for (const def of fieldDefs) {
    let found = normHeaders.find(h => h.norm === def.key);
    if (!found) found = normHeaders.find(h => def.synonyms.includes(h.norm));
    if (!found) found = normHeaders.find(h => def.synonyms.some(s => h.norm.includes(s)));
    mapping[def.key] = found ? found.raw : "";
  }
  return mapping;
}

async function parseFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
  const headerRows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const headers = (headerRows[0] || []).filter(h => h != null && String(h).trim() !== "");
  if (!rows.length || !headers.length) throw new Error("No rows were found in this file — check it has a header row and at least one data row.");
  return { headers, rows };
}

function excelSerialToDate(n) {
  const utcDays = Math.floor(n - 25569);
  const utcValue = utcDays * 86400;
  return new Date(utcValue * 1000);
}

function parseDateValue(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === "number") return excelSerialToDate(v);
  const s = String(v).trim();
  let d = new Date(s);
  if (!isNaN(d)) return d;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = "20" + y;
    d = new Date(`${y}-${b.padStart(2, "0")}-${a.padStart(2, "0")}`);
    if (!isNaN(d)) return d;
  }
  return null;
}

function parseNumberValue(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  let n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  if (negative) n = -Math.abs(n);
  return n;
}

function normalizeTradeType(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (/^b/.test(s) || s.includes("buy") || s.includes("purchase")) return "Buy";
  if (/^s/.test(s) || s.includes("sell")) return "Sell";
  return v == null ? "" : String(v).trim();
}

/** Build clean typed records from raw rows using a confirmed field->header mapping. */
function applyMapping(kind, rows, mapping) {
  const defs = FIELD_DEFS[kind];
  const out = [];
  for (const row of rows) {
    const rec = {};
    let skip = false;
    for (const def of defs) {
      const header = mapping[def.key];
      const raw = header ? row[header] : null;
      let val;
      if (def.type === "date") val = parseDateValue(raw);
      else if (def.type === "number") val = parseNumberValue(raw);
      else if (def.key === "type") val = normalizeTradeType(raw);
      else val = raw == null ? "" : String(raw).trim();
      if (!def.optional && (val == null || val === "") && def.type !== "text") skip = true;
      if (!def.optional && def.type === "text" && val === "") skip = true;
      rec[def.key] = val;
    }
    if (!skip) out.push(rec);
  }
  return out;
}
