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
const FUND_CATEGORY = /collective investment|unit trust|fund of fund/i;

/** Cash and fixed income are taken from the segments, so the position rows behind them must
 *  be skipped or they land in the total twice. The three source formats word these categories
 *  quite differently — "Cash" and "Bonds" from the custodian HTML, "SA Fixed Income" from the
 *  flat CSV, "Domestic (South African rand MMA)" from the IPD extract — so matching only one
 *  format's wording double-counts every fund on the others. */
const NON_EQUITY_CATEGORY = /cash|bond|money market|fixed income|\bMMA\b|deposit|liquidity/i;

function isNonEquityHolding(h) {
  const c = h.category || "";
  return NON_EQUITY_CATEGORY.test(c) || Object.prototype.hasOwnProperty.call(SEGMENT_TO_BUCKET, c);
}

/** Cash as against fixed income, for listing what a cash figure is made of. Decided on the
 *  category alone: a bill filed under Money Market is cash and its value sits in the cash
 *  segment, while the same bill filed under SA Fixed Income is not and does not. The
 *  instrument test that portfolio changes uses would disagree with the segment it has to
 *  add up to. */
const CASH_ONLY_CATEGORY = /cash|money market|\bMMA\b|deposit|liquidity|call/i;

function isCashCategory(h) {
  const c = h.category || "";
  return CASH_ONLY_CATEGORY.test(c) && !/bond|fixed income/i.test(c);
}

/** A holding's trading currency, falling back to what its category already implies.
 *
 *  The IPD extracts carry no currency column at all, and SA/offshore is decided on currency,
 *  so every position in them defaulted to offshore — a fund of JSE blue chips reported as
 *  91% offshore equity while its own custodian called it 91% JSE-listed. The category is the
 *  custodian's own local/foreign call, so it answers the question when the currency cannot.
 *  A foreign category still yields nothing, which is honest: it says offshore, not which
 *  currency, and that is all the file knows. */
const SA_CATEGORY = /^(jse|sa\b|domestic|local)/i;

function holdingCcy(h) {
  const ccy = String(h.ccy || "").trim().toUpperCase();
  if (ccy) return ccy;
  return SA_CATEGORY.test(h.category || "") ? "ZAR" : "";
}

const LOOKTHROUGH_BUCKETS = [
  "SA Inc", "Quasi-Offshore", "Offshore Equity",
  "SA Cash", "Offshore Cash", "SA Fixed Income", "Offshore Fixed Income"
];
const LISTED_BUCKETS = [
  "SA Equity", "Offshore Equity", "SA Property", "Offshore Property",
  "SA Cash", "Offshore Cash", "SA Fixed Income", "Offshore Fixed Income"
];

/** Listed property, shown on the listed bar as its own slice rather than inside equity.
 *
 *  No file we receive marks it: Stor-age arrives as "Equities" from the custodian and
 *  "JSE-listed Equity" from the flat CSV, so the call is made here from the name. It is the
 *  only property holding in the archive, which is why a pattern is enough — if the firm ever
 *  buys a REIT whose name says neither (Redefine, NEPI Rockcastle), add it to PROPERTY_NAMES
 *  rather than widening the pattern and catching an operating company by accident.
 *
 *  This splits the listed bar only. On the look-through bar a REIT still divides by its SA
 *  revenue share like any other share, because the question that bar answers is where the
 *  earnings come from, not what the instrument is. */
const PROPERTY_PATTERN = /\bREITS?\b|propert/i;
const PROPERTY_NAMES = [];   // exact names or tickers the pattern cannot see

function isProperty(h) {
  const name = h.name || "", ticker = rawTicker(h.ticker) || "";
  if (PROPERTY_NAMES.some(p => p.toUpperCase() === name.toUpperCase() ||
                               p.toUpperCase() === ticker.toUpperCase())) return true;
  return PROPERTY_PATTERN.test(name);
}
/** How the buckets are presented, as distinct from how they are computed.
 *
 *  The engine keeps Quasi-Offshore apart from Offshore Equity, because the difference — the
 *  offshore earnings of a JSE-listed company versus a share listed offshore — is the whole
 *  point of the revenue research, and the per-position table still shows it. The deck adds
 *  them together and calls the result Global Equity, so that is what the charts show.
 *  "Offshore" reads as "Global" throughout, matching the rest of the house wording. */
const BUCKET_DISPLAY = {
  "Quasi-Offshore": "Global Equity",
  "Offshore Equity": "Global Equity",
  "Offshore Cash": "Global Cash",
  "Offshore Fixed Income": "Global Fixed Income"
};

/** The listed side is the custodian's own numbers, so it carries the custodian's own names.
 *  It read "SA Equity" while the allocation pie and the period comparison — the same figures
 *  from the same segments — read "JSE-listed Equity", which made a row that ties exactly look
 *  like a row that does not. */
const LISTED_DISPLAY = {
  "SA Equity": "JSE-listed Equity",
  "Offshore Equity": "Global-listed Equity",
  "SA Property": "JSE-listed Property",
  "Offshore Property": "Global-listed Property",
  "Offshore Cash": "Global Cash",
  "Offshore Fixed Income": "Global Fixed Income"
};

/** Stacking and row order across both views — SA-linked first, so the equity block a bar
 *  starts with is the one it splits into on the other bar. */
const ALLOCATION_ORDER = [
  "JSE-listed Equity", "SA Inc", "Global Equity", "Global-listed Equity",
  "JSE-listed Property", "Global-listed Property",
  "SA Cash", "Global Cash", "SA Fixed Income", "Global Fixed Income"
];

/** Computed buckets folded into the names and groupings the deck uses. Pass LISTED_DISPLAY
 *  for the custodian side, which keeps the custodian's own wording. */
function displayBuckets(buckets, map = BUCKET_DISPLAY) {
  const out = {};
  Object.entries(buckets || {}).forEach(([k, v]) => {
    const key = map[k] || k;
    out[key] = (out[key] || 0) + v;
  });
  return out;
}

/** The eleven GICS sectors. No holdings file we receive carries GICS — the IPD extracts
 *  carry ICB ("Basic Materials", "Travel and Leisure"), which is a different scheme, and the
 *  custodian HTML exports carry no sector at all. So the mapping is the firm's own: a Sector
 *  column on the research tab if there is one, otherwise set per holding here. */
const GICS_SECTORS = [
  "Energy", "Materials", "Industrials", "Consumer Discretionary", "Consumer Staples",
  "Health Care", "Financials", "Information Technology", "Communication Services",
  "Utilities", "Real Estate"
];

/* ---------- the SA-revenue map ---------- */

function loadSaIncStore() {
  const empty = { source: {}, manual: {}, funds: {}, listing: {}, sector: {}, sectorSource: {},
                  fileName: "", sheetName: "", loadedAt: null };
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

/** Sector for a ticker: what you set here first, then a Sector column off the research tab. */
function lookupSector(ticker) {
  const keys = [rawTicker(ticker), normTicker(ticker)];
  for (const k of keys) if (k && saIncStore.sector[k]) return { sector: saIncStore.sector[k], origin: "manual" };
  for (const k of keys) if (k && saIncStore.sectorSource[k]) return { sector: saIncStore.sectorSource[k], origin: "source" };
  return { sector: null, origin: null };
}

function setManualSector(ticker, sector) {
  const k = rawTicker(ticker);
  if (!k) return;
  if (sector) saIncStore.sector[k] = sector; else delete saIncStore.sector[k];
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
  // optional: add a Sector column to the same tab and the sector split fills itself in
  const sectorCol = header.findIndex(h => h.includes("sector") || h.includes("gics"));
  if (tickerCol < 0 || pctCol < 0) {
    throw new Error(`could not find a ticker and a "% SA Inc" column on the "${sheet}" tab`);
  }

  const source = {};
  const sectorSource = {};
  const suspicious = [];
  rows.slice(1).forEach(r => {
    const key = rawTicker(r[tickerCol]);
    if (!key) return;
    if (sectorCol >= 0 && r[sectorCol]) {
      const s = String(r[sectorCol]).trim();
      // accept any spelling the sheet uses, but snap to a GICS name where it matches
      sectorSource[key] = GICS_SECTORS.find(g => g.toLowerCase() === s.toLowerCase()) || s;
    }
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
  saIncStore.sectorSource = sectorSource;
  saIncStore.fileName = file.name;
  saIncStore.sheetName = sheet;
  saIncStore.loadedAt = new Date().toISOString();
  persistSaIncStore();
  return { ...saIncCounts(), sheet, suspicious, sectors: Object.keys(sectorSource).length };
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
  // the ticker is the reliable identifier — names are abbreviated differently per source
  const byTicker = fundFromTicker(h.ticker);
  if (byTicker) return byTicker;
  const name = String(h.name || "").trim().toLowerCase();
  if (!name) return null;
  const exact = funds.find(f => f.toLowerCase() === name);
  if (exact) return exact;
  const starts = funds.filter(f => name.startsWith(f.toLowerCase()));
  if (starts.length) return starts.sort((a, b) => b.length - a.length)[0];
  return null;
}

/** Tickers by which the firm's own funds appear inside other funds' holdings.
 *
 *  The category alone does not find them. Only the custodian HTML files these as "Collective
 *  Investment Schemes"; the IPD extract puts the same holding under "Foreign (non-South
 *  African rand MMA)" and the flat CSV under "Global-listed Equity", so a category test
 *  misses both and the look-through quietly does nothing — one of them an 11% position.
 *  Names do not rescue it either: one file writes "AYLETT GBL EQY FD-BUSDACC".
 *
 *  The share class suffix varies (A2, B3, B, BID), so these match on the stem. */
const IN_HOUSE_FUND_TICKERS = [
  [/^PGAGEF/i, "Aylett Global Equity Fund"],
  [/^AGFF/i, "Aylett Global EQ Prescient FF"]
];

/** The in-house fund a ticker names, if that fund is one we actually hold holdings for. */
function fundFromTicker(ticker) {
  const t = rawTicker(ticker);
  if (!t) return null;
  const hit = IN_HOUSE_FUND_TICKERS.find(([re]) => re.test(t));
  if (!hit) return null;
  return listFundsWithHoldings().includes(hit[1]) ? hit[1] : null;
}

function isFundHolding(h) {
  return FUND_CATEGORY.test(h.category || "") || !!fundFromTicker(h.ticker);
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
  const futuresApplied = [];
  const futuresUnsized = [];
  const propertyHeld = [];
  const cashLines = [];
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
      // An index future sits in the file at a value of zero, so without this it is simply
      // absent from the allocation. It is equity exposure bought with cash: the notional
      // goes into the index's own constituents, and the same amount comes off cash, so the
      // fund still totals its own NAV. A short future runs the other way and reduces equity.
      const fut = typeof futuresExposure === "function" ? futuresExposure(h) : null;
      if (fut) {
        if (fut.notional == null) {
          futuresUnsized.push({ name: h.name, code: fut.code });
          return;
        }
        const wFut = scale * (fut.notional / snap.total) * 100;
        const spread = spreadFutureAcrossIndex(fut.code, fut.notional, month);
        if (!spread.length) {
          futuresUnsized.push({ name: h.name, code: fut.code, noWeights: true });
          return;
        }
        spread.forEach(([share, rand]) => {
          const wi = scale * (rand / snap.total) * 100;
          const look = lookupSaInc(share);
          // ALSI and CTOP are JSE indices, so their constituents are SA-listed lines
          const listing = lookupListing(share, "ZAR");
          equityWeight += wi;
          if (look.origin === "source" || look.origin === "manual") mappedWeight += wi;
          buckets["SA Inc"] += wi * look.pct;
          buckets[listing.listing === "SA" ? "Quasi-Offshore" : "Offshore Equity"] += wi * (1 - look.pct);
          listed[listing.listing === "SA" ? "SA Equity" : "Offshore Equity"] += wi;
        });
        buckets["SA Cash"] -= wFut;
        listed["SA Cash"] -= wFut;
        futuresApplied.push({ name: h.name, code: fut.code, contracts: fut.contracts, weight: wFut });
        return;
      }
      if (isNonEquityHolding(h)) {
        // Cash is taken from the segments, not from these rows, so they are still skipped —
        // but the rows are what the segment is made of, and that is worth being able to see.
        // Bills and bonds are left out: they belong to fixed income, wherever filed.
        if (isCashCategory(h)) {
          const w = scale * (h.pct || 0);
          if (w) cashLines.push({ name: displayName(h), ccy: holdingCcy(h), weight: w,
                                  side: holdingCcy(h) === "ZAR" ? "SA" : "Global" });
        }
        return;   // counted via segments above
      }
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

      // reaching here for a fund holding means it is being held as a single line, either by
      // choice or because we have no saved holdings for it
      const heldAsLine = isFundHolding(h);
      const look = lookupSaInc(h.ticker);
      const listing = lookupListing(h.ticker, holdingCcy(h));
      equityWeight += w;
      if (look.origin === "source" || look.origin === "manual") mappedWeight += w;

      const key = rawTicker(h.ticker) || h.name;
      const prev = positions.get(key);
      if (prev) prev.weight += w;
      else positions.set(key, {
        name: displayName(h), ticker: h.ticker, ccy: holdingCcy(h), weight: w, isFund: heldAsLine,
        saInc: look.pct, origin: look.origin,
        listing: listing.listing, listingOverridden: listing.overridden
      });

      // the SA revenue share applies wherever the share is listed; only the *remainder's*
      // home differs — offshore for an offshore line, quasi-offshore for a JSE one
      buckets["SA Inc"] += w * look.pct;
      buckets[listing.listing === "SA" ? "Quasi-Offshore" : "Offshore Equity"] += w * (1 - look.pct);

      // the listed bar names the instrument, so a REIT comes out of equity into its own
      // slice; the look-through bar above has already split it on revenue like any share
      const prop = isProperty(h);
      if (prop) propertyHeld.push({ name: displayName(h), ticker: h.ticker, weight: w });
      listed[prop ? (listing.listing === "SA" ? "SA Property" : "Offshore Property")
                  : (listing.listing === "SA" ? "SA Equity" : "Offshore Equity")] += w;
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
    futuresApplied,
    futuresUnsized,
    propertyHeld,
    cashLines,
    coverage: equityWeight ? (mappedWeight / equityWeight) * 100 : 0
  };
}

/* ---------- other ways of cutting the same holdings ---------- */

/** Currency and sector splits over *every* position, cash included — unlike the asset
 *  allocation, where cash comes from the segments. Cash is where most of the rand exposure
 *  sits, so leaving it out would understate ZAR by roughly a tenth of the fund.
 *
 *  `by` is "ccy" or "sector". Returns { rows, unclassified, total } with rows as percentages
 *  of the fund, plus the positions behind any unclassified weight so they can be set. */
function computeBreakdown(fund, monthKey, { by = "ccy", expandFunds = true } = {}) {
  const groups = new Map();
  const cashByKey = new Map();
  const bondByKey = new Map();
  const unclassified = new Map();
  const fundsWithHoldings = listFundsWithHoldings();

  function walk(fundName, month, scale, visited) {
    const snap = getFundSnapshotAtOrBefore(fundName, month, null);
    if (!snap || !snap.total) return false;
    const stamp = `${fundName}|${snap.period}`;
    if (visited.has(stamp)) return false;
    visited.add(stamp);

    (snap.holdings || []).forEach(h => {
      const w = scale * (h.pct || 0);
      if (!w) return;
      if (isFundHolding(h) && expandFunds) {
        const target = resolveFundForHolding(h, fundsWithHoldings);
        if (target && walk(target, month, scale * (h.pct || 0) / 100, visited)) return;
      }
      let key;
      if (by === "sector") {
        // cash and bonds have no sector; calling them "unclassified" would hide the fact
        // that they are simply not equity, so they get their own row
        if (isNonEquityHolding(h)) key = "Cash & Fixed Income";
        else {
          key = lookupSector(h.ticker).sector;
          if (!key) {
            const uk = rawTicker(h.ticker) || h.name;
            const prev = unclassified.get(uk);
            if (prev) prev.weight += w;
            else unclassified.set(uk, { name: displayName(h), ticker: h.ticker, weight: w });
            key = "Not classified";
          }
        }
      } else {
        key = holdingCcy(h) || "Unknown";
        // Tracked alongside, not instead: the currency total is still the whole exposure,
        // and knowing what within it is not equity lets the chart show a pie of a pie.
        // Cash and fixed income are kept apart, because calling a bond cash would have had
        // Balanced reporting 31.5% cash against the 13.3% it actually holds.
        if (isNonEquityHolding(h)) {
          const m = isCashCategory(h) ? cashByKey : bondByKey;
          m.set(key, (m.get(key) || 0) + w);
        }
      }
      groups.set(key, (groups.get(key) || 0) + w);
    });
    return true;
  }

  walk(fund, monthKey, 1, new Set());
  const rows = [...groups.entries()]
    .map(([key, weight]) => ({ key, weight }))
    .sort((a, b) => b.weight - a.weight);
  return {
    rows,
    // what each currency's exposure is made of, so a caller can show the equity apart from
    // the cash without walking the holdings a second time
    cashByKey: Object.fromEntries(cashByKey),
    bondByKey: Object.fromEntries(bondByKey),
    cash: [...cashByKey.values()].reduce((s, v) => s + v, 0),
    bonds: [...bondByKey.values()].reduce((s, v) => s + v, 0),
    unclassified: [...unclassified.values()].sort((a, b) => b.weight - a.weight),
    total: rows.reduce((s, r) => s + r.weight, 0)
  };
}


/* ---------- consolidated across funds ---------- */

/** The look-through buckets for every fund at a month, weighted by each fund's own AUM.
 *
 *  computeLookThrough works in percentages of one fund, so summing those directly would
 *  give every fund an equal vote regardless of size. Each fund's buckets are re-weighted by
 *  its share of total AUM before being added. Funds with no saved snapshot at that month are
 *  simply absent, exactly as they are from the consolidated total itself. */
function computeLookThroughConsolidated(monthKey, opts = {}) {
  const buckets = emptyBuckets(LOOKTHROUGH_BUCKETS);
  const listed = emptyBuckets(LISTED_BUCKETS);
  const positions = new Map();
  const futuresApplied = [], futuresUnsized = [], expanded = [], unresolvedFunds = [];
  let total = 0, equityWeight = 0, mappedWeight = 0;
  const funds = [];

  listFundsWithHoldings().forEach(fund => {
    const snap = getFundSnapshotAtOrBefore(fund, monthKey);
    if (!snap) return;
    const lt = computeLookThrough(fund, snap.period, opts);
    if (!lt) return;
    total += snap.total;
    funds.push(fund);
    Object.entries(lt.buckets).forEach(([k, v]) => { buckets[k] += v * snap.total / 100; });
    Object.entries(lt.listed).forEach(([k, v]) => { listed[k] += v * snap.total / 100; });
    equityWeight += snap.total;
    mappedWeight += (lt.coverage || 0) / 100 * snap.total;
    // positions too, in rand, so a firm-wide view can show which holdings still need a split
    lt.positions.forEach(p => {
      const key = rawTicker(p.ticker) || p.name;
      const prev = positions.get(key);
      const rand = (p.weight / 100) * snap.total;
      if (prev) prev.rand += rand;
      else positions.set(key, { ...p, rand });
    });
    lt.futuresApplied.forEach(f => futuresApplied.push({ ...f, fund }));
    lt.futuresUnsized.forEach(f => futuresUnsized.push({ ...f, fund }));
    lt.expanded.forEach(e => expanded.push({ ...e, fund: e.fund }));
    lt.unresolvedFunds.forEach(e => unresolvedFunds.push(e));
  });

  if (!total) return null;
  const pct = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, (v / total) * 100]));
  return {
    buckets: pct(buckets), listed: pct(listed), total, funds,
    positions: [...positions.values()]
      .map(p => ({ ...p, weight: (p.rand / total) * 100 }))
      .sort((a, b) => b.weight - a.weight),
    futuresApplied, futuresUnsized, expanded, unresolvedFunds,
    coverage: equityWeight ? (mappedWeight / equityWeight) * 100 : 0
  };
}

/** The same idea for the currency and sector cuts. */
function computeBreakdownConsolidated(monthKey, opts = {}) {
  const groups = new Map();
  const cashRand = new Map();
  const bondRand = new Map();
  let total = 0;
  listFundsWithHoldings().forEach(fund => {
    const snap = getFundSnapshotAtOrBefore(fund, monthKey);
    if (!snap) return;
    const bd = computeBreakdown(fund, snap.period, opts);
    if (!bd || !bd.rows.length) return;
    total += snap.total;
    bd.rows.forEach(r => groups.set(r.key, (groups.get(r.key) || 0) + r.weight * snap.total / 100));
    // carried through in rand like everything else here, so a big fund's cash weighs what
    // it should rather than counting equally with a small one's
    Object.entries(bd.cashByKey || {}).forEach(([k, w]) =>
      cashRand.set(k, (cashRand.get(k) || 0) + w * snap.total / 100));
    Object.entries(bd.bondByKey || {}).forEach(([k, w]) =>
      bondRand.set(k, (bondRand.get(k) || 0) + w * snap.total / 100));
  });
  if (!total) return null;
  const pct = m => Object.fromEntries([...m].map(([k, rand]) => [k, (rand / total) * 100]));
  const cashByKey = pct(cashRand), bondByKey = pct(bondRand);
  return {
    rows: [...groups.entries()]
      .map(([key, rand]) => ({ key, weight: (rand / total) * 100 }))
      .sort((a, b) => b.weight - a.weight),
    cashByKey, bondByKey,
    cash: Object.values(cashByKey).reduce((s, v) => s + v, 0),
    bonds: Object.values(bondByKey).reduce((s, v) => s + v, 0),
    total
  };
}
