/* Asset allocation look-through.
 *
 * A listed allocation says where a share is *quoted*. Aylett presents where the underlying
 * revenue is *earned*: a JSE-listed counter that earns most of its money offshore is not
 * really SA exposure. So each equity position is split by that company's SA-derived revenue
 * percentage — SA Inc gets `weight x saInc`, and the remainder goes offshore, landing in
 * "Offshore Equity" for a share held offshore or "Quasi-Offshore" for an SA-listed one.
 *
 * The revenue percentages are firm research (the "SA Income Categories" tab of the analyst
 * workbook). They are loaded in the browser like every other file here — never committed.
 *
 * Holdings in the firm's own funds are expanded into that fund's own positions, recursively,
 * so a feeder fund holding the Global Equity Fund resolves all the way down to the shares. */
"use strict";

const SAINC_STORAGE_KEY = "aum-dashboard-sa-income-v1";
const SAINC_SHEET_HINT = "sa income";

/* Cash and fixed income are taken from the snapshot's own segments rather than from the
 * position rows — the segments already carry the SA/global split the custodian applied. */
const SEGMENT_TO_BUCKET = {
  "SA Cash": "SA Cash",
  "Global Cash": "Offshore Cash",
  "SA Fixed Income": "SA Fixed Income",
  "Global Fixed Income": "Offshore Fixed Income"
};
const NON_EQUITY_CATEGORY = /^(cash|bond|money)/i;
const FUND_CATEGORY = /collective investment|unit trust|fund of fund/i;

const LOOKTHROUGH_BUCKETS = [
  "SA Inc", "Quasi-Offshore", "Offshore Equity",
  "SA Cash", "Offshore Cash", "SA Fixed Income", "Offshore Fixed Income"
];
const LISTED_BUCKETS = [
  "SA Equity", "Offshore Equity",
  "SA Cash", "Offshore Cash", "SA Fixed Income", "Offshore Fixed Income"
];
/** Stacking and row order across both views — SA-linked first, so the equity block a bar
 *  starts with is the one it splits into on the other bar. */
const ALLOCATION_ORDER = [
  "SA Equity", "SA Inc", "Quasi-Offshore", "Offshore Equity",
  "SA Cash", "Offshore Cash", "SA Fixed Income", "Offshore Fixed Income"
];

/* ---------- the SA-revenue map ---------- */

function loadSaIncStore() {
  const empty = { source: {}, manual: {}, funds: {}, listing: {}, fileName: "", sheetName: "", loadedAt: null };
  try {
    const raw = localStorage.getItem(SAINC_STORAGE_KEY);
    if (!raw) return empty;
    return { ...empty, ...JSON.parse(raw) };
  } catch (e) {
    console.error("Could not read the saved SA income map", e);
    return empty;
  }
}

let saIncStore = loadSaIncStore();

function persistSaIncStore() {
  try {
    localStorage.setItem(SAINC_STORAGE_KEY, JSON.stringify(saIncStore));
    return true;
  } catch (e) {
    console.error("Could not save the SA income map locally", e);
    return false;
  }
}

/** Bloomberg-style tickers carry an exchange suffix ("BATS LN", "700 HK") and JSE class
 *  suffixes ("PGAGEFB3"); the research tab keys on the bare code. Stripping them is only ever
 *  a *fallback* — see lookupSaInc — because some dual listings ("N91" vs "N91 LN") are
 *  deliberately held apart and must not be collapsed into one another. */
function normTicker(t) {
  let s = String(t == null ? "" : t).trim().toUpperCase().replace(/\*/g, "");
  const m = s.match(/^(\S+)\s+([A-Z]{2})$/);
  if (m) s = m[2] === "HK" ? "HK" + m[1] : m[1];
  return s.replace(/(B\d|A\d)$/, "");
}

function rawTicker(t) {
  return String(t == null ? "" : t).trim().toUpperCase().replace(/\*/g, "");
}

/** Returns { pct, origin } where pct is a fraction 0..1 and origin is one of
 *  "manual" (set by hand here), "source" (from the research file), "blank" (listed in the
 *  research file but with no value yet) or null (not in the file at all). */
function lookupSaInc(ticker) {
  const keys = [rawTicker(ticker), normTicker(ticker)];
  for (const k of keys) {
    if (k && Object.prototype.hasOwnProperty.call(saIncStore.manual, k)) {
      return { pct: saIncStore.manual[k], origin: "manual" };
    }
  }
  for (const k of keys) {
    if (k && Object.prototype.hasOwnProperty.call(saIncStore.source, k)) {
      const v = saIncStore.source[k];
      return typeof v === "number" ? { pct: v, origin: "source" } : { pct: 0, origin: "blank" };
    }
  }
  return { pct: 0, origin: null };
}

function setManualSaInc(ticker, pct) {
  const k = rawTicker(ticker);
  if (!k) return;
  saIncStore.manual[k] = Math.max(0, Math.min(1, pct));
  persistSaIncStore();
}

function clearManualSaInc(ticker) {
  delete saIncStore.manual[rawTicker(ticker)];
  persistSaIncStore();
}

/** Where a position counts as *listed*, which decides where its non-SA revenue lands.
 *
 *  The default is the trading currency, and that is not a guess: for every fund checked it
 *  reproduces the custodian's own JSE-listed/Global-listed split to the third decimal. But a
 *  few lines are held as SA exposure despite quoting offshore — an ADR like BUD UN, or the
 *  offshore leg of a dual listing — which is what the exceptions list in the sample workbook
 *  is for. Those are a house call, so they are set here by hand and kept. */
function lookupListing(ticker, ccy) {
  const override = saIncStore.listing[rawTicker(ticker)];
  if (override === "SA" || override === "Offshore") return { listing: override, overridden: true };
  return { listing: String(ccy || "").trim().toUpperCase() === "ZAR" ? "SA" : "Offshore", overridden: false };
}

function setListingOverride(ticker, listing) {
  const k = rawTicker(ticker);
  if (!k) return;
  if (listing === "SA" || listing === "Offshore") saIncStore.listing[k] = listing;
  else delete saIncStore.listing[k];
  persistSaIncStore();
}

function setFundLookThrough(ticker, fundName) {
  const k = rawTicker(ticker);
  if (!k) return;
  if (fundName) saIncStore.funds[k] = fundName; else delete saIncStore.funds[k];
  persistSaIncStore();
}

function saIncCounts() {
  const src = Object.values(saIncStore.source);
  return {
    tickers: src.length,
    valued: src.filter(v => typeof v === "number").length,
    manual: Object.keys(saIncStore.manual).length,
    listing: Object.keys(saIncStore.listing).length
  };
}

/** Reads the "SA Income Categories" tab: a Ticker column and a "% SA Inc" column. */
async function importSaIncFromFile(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = wb.SheetNames.find(n => n.toLowerCase().includes(SAINC_SHEET_HINT)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: null });
  if (!rows.length) throw new Error("that sheet is empty");

  const header = (rows[0] || []).map(h => String(h == null ? "" : h).toLowerCase().replace(/[^a-z0-9]/g, ""));
  const tickerCol = header.findIndex(h => h.includes("ticker") || h === "code" || h === "share");
  const pctCol = header.findIndex(h => h.includes("sainc") || h.includes("sarevenue") || h.includes("sa"));
  if (tickerCol < 0 || pctCol < 0) {
    throw new Error(`could not find a ticker and a "% SA Inc" column on the "${sheet}" tab`);
  }

  const source = {};
  const suspicious = [];
  rows.slice(1).forEach(r => {
    const key = rawTicker(r[tickerCol]);
    if (!key) return;
    const v = r[pctCol];
    if (typeof v === "number") {
      // the tab holds fractions (0.9 = 90% SA-derived); anything above 1 is a data-entry slip
      // and would overstate SA exposure many times over, so it is flagged, not silently used
      if (v > 1) { suspicious.push({ ticker: key, value: v }); return; }
      source[key] = v;
    } else {
      source[key] = null;   // listed, but not yet researched
    }
  });

  saIncStore.source = source;
  saIncStore.fileName = file.name;
  saIncStore.sheetName = sheet;
  saIncStore.loadedAt = new Date().toISOString();
  persistSaIncStore();
  return { ...saIncCounts(), sheet, suspicious };
}

function clearSaIncSource() {
  saIncStore.source = {};
  saIncStore.fileName = "";
  saIncStore.loadedAt = null;
  persistSaIncStore();
}

/* ---------- looking a fund holding through to its own positions ---------- */

/** The fund in saved history that a "Collective Investment Schemes" row refers to, or null.
 *  A manual mapping wins; otherwise the holding name is matched against the fund names we
 *  hold, longest first, so "Aylett Global Equity Fund B3" resolves past the class suffix. */
function resolveFundForHolding(h, funds) {
  const manual = saIncStore.funds[rawTicker(h.ticker)];
  if (manual) return manual;
  const name = String(h.name || "").trim().toLowerCase();
  if (!name) return null;
  const exact = funds.find(f => f.toLowerCase() === name);
  if (exact) return exact;
  const starts = funds.filter(f => name.startsWith(f.toLowerCase()));
  if (starts.length) return starts.sort((a, b) => b.length - a.length)[0];
  return null;
}

function isFundHolding(h) {
  return FUND_CATEGORY.test(h.category || "");
}

function emptyBuckets(keys) {
  const o = {};
  keys.forEach(k => { o[k] = 0; });
  return o;
}

/** The listed allocation exactly as the custodian classified it — the reported starting point,
 *  before any of the firm's own revenue research or listing calls are applied. */
function computeCustodianAllocation(fund, monthKey) {
  const snap = historyStore.periods[`${fund}|${monthKey}`];
  const buckets = emptyBuckets(LISTED_BUCKETS);
  if (!snap || !snap.total) return buckets;
  const map = { ...SEGMENT_TO_BUCKET, "JSE-listed Equity": "SA Equity", "Global-listed Equity": "Offshore Equity" };
  (snap.segments || []).forEach(s => {
    const bucket = map[s.category];
    if (bucket) buckets[bucket] += (s.value / snap.total) * 100;
  });
  return buckets;
}

/** Look-through allocation for one fund and month, as percentages of that fund.
 *
 *  Returns { buckets, positions, expanded, unresolvedFunds, coverage }. `positions` is every
 *  equity line after expansion, carrying the two inputs that decide its split — the SA revenue
 *  share and where it counts as listed — so both can be seen and overridden. A position with
 *  no researched split currently counts as 0% SA, which is an assumption, not a neutral. */
function computeLookThrough(fund, monthKey, { expandFunds = true } = {}) {
  const buckets = emptyBuckets(LOOKTHROUGH_BUCKETS);
  // the same positions without the revenue split, so the only thing that differs between the
  // two bars is the look-through itself rather than which positions each one happens to see
  const listed = emptyBuckets(LISTED_BUCKETS);
  const positions = new Map();
  const expanded = [];
  const unresolvedFunds = [];
  const fundsWithHoldings = listFundsWithHoldings();
  let equityWeight = 0, mappedWeight = 0;

  function walk(fundName, month, scale, visited) {
    const snap = getFundSnapshotAtOrBefore(fundName, month, null);
    if (!snap || !snap.total) return false;
    const stamp = `${fundName}|${snap.period}`;
    if (visited.has(stamp)) return false;   // a fund holding itself would otherwise loop forever
    visited.add(stamp);

    (snap.segments || []).forEach(s => {
      const bucket = SEGMENT_TO_BUCKET[s.category];
      if (!bucket) return;
      const v = scale * (s.value / snap.total) * 100;
      buckets[bucket] += v;
      listed[bucket] += v;
    });

    (snap.holdings || []).forEach(h => {
      if (NON_EQUITY_CATEGORY.test(h.category || "")) return;   // counted via segments above
      const w = scale * (h.pct || 0);
      if (!w) return;

      if (isFundHolding(h)) {
        const target = expandFunds ? resolveFundForHolding(h, fundsWithHoldings) : null;
        if (target && walk(target, month, scale * (h.pct || 0) / 100, visited)) {
          expanded.push({ name: h.name, ticker: h.ticker, weight: w, fund: target });
          return;
        }
        if (expandFunds) unresolvedFunds.push({ name: h.name, ticker: h.ticker, weight: w });
      }

      const look = lookupSaInc(h.ticker);
      const listing = lookupListing(h.ticker, h.ccy);
      equityWeight += w;
      if (look.origin === "source" || look.origin === "manual") mappedWeight += w;

      const key = rawTicker(h.ticker) || h.name;
      const prev = positions.get(key);
      if (prev) prev.weight += w;
      else positions.set(key, {
        name: h.name, ticker: h.ticker, ccy: h.ccy, weight: w,
        saInc: look.pct, origin: look.origin,
        listing: listing.listing, listingOverridden: listing.overridden
      });

      // the SA revenue share applies wherever the share is listed; only the *remainder's*
      // home differs — offshore for an offshore line, quasi-offshore for a JSE one
      buckets["SA Inc"] += w * look.pct;
      buckets[listing.listing === "SA" ? "Quasi-Offshore" : "Offshore Equity"] += w * (1 - look.pct);
      listed[listing.listing === "SA" ? "SA Equity" : "Offshore Equity"] += w;
    });
    return true;
  }

  walk(fund, monthKey, 1, new Set());
  return {
    buckets,
    listed,
    positions: [...positions.values()].sort((a, b) => b.weight - a.weight),
    expanded,
    unresolvedFunds,
    coverage: equityWeight ? (mappedWeight / equityWeight) * 100 : 0
  };
}
