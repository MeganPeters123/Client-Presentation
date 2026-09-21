/* Active share.
 *
 *     Active Share = 1/2 * sum |w_fund,i - w_index,i|
 *
 * Three things decide what the number means, and each one moves it, so none of them is
 * buried:
 *
 *   cash      excluded, and the equity side rescaled to 100%. A fund sitting on 13% cash
 *             would otherwise score 13% "active" for holding no shares at all.
 *
 *   futures   an index future carries full index exposure at a market value of zero,
 *             because it is marked to market daily and the profit sits in variation margin.
 *             Taken at face value a 26-contract ALSI position counts for nothing. Here the
 *             notional (contracts x index level x R10 a point) is spread across that index
 *             at index weight, which is what the position actually is.
 *
 *   offshore  no SA index contains offshore shares, so the Global Equity Fund holding has
 *             nothing to difference against. Either measure the SA sleeve alone, or count
 *             offshore as fully active — a toggle, because both are defensible.
 *
 * The index weights are loaded in the browser like every other file here, never committed.
 */
"use strict";

const INDEX_WEIGHTS_KEY = "aum-dashboard-index-weights-v1";

/* JSE equity index futures are quoted in index points and settle at R10 a point. Checked
 * against initial margin: R102,240 per ALSI contract in two funds independently, 9.3% of
 * notional at this multiplier. */
const RAND_PER_INDEX_POINT = 10;

/* Which index each contract tracks. DCAP is the capped-SWIX top 40, which is the index the
 * J430 block carries — and is what the older Balanced positions were written against before
 * they rolled into CTOP. DTOP is deliberately absent: no index code in the weights export
 * corresponds to it, so a DTOP contract should report as unsized rather than be quietly
 * charged to the wrong index. */
const FUTURE_INDEX = [[/ALSI/i, "J200"], [/CTOP/i, "J300"], [/DCAP/i, "J430"]];

function loadIndexWeights() {
  const empty = { months: {}, fileName: "", loadedAt: null };
  try {
    const raw = localStorage.getItem(INDEX_WEIGHTS_KEY);
    return raw ? { ...empty, ...JSON.parse(raw) } : empty;
  } catch (e) {
    console.error("Could not read the saved index weights", e);
    return empty;
  }
}

let indexWeightsStore = loadIndexWeights();

function persistIndexWeights() {
  try {
    localStorage.setItem(INDEX_WEIGHTS_KEY, JSON.stringify(indexWeightsStore));
    return true;
  } catch (e) {
    console.error("Could not save the index weights locally", e);
    return false;
  }
}

/** Reads the month-end index weights export: Month End, Source Date, Index Code,
 *  Portfolio, Index, Source Sheet, Share, Name, Weight. */
/** YYYY-MM-DD from whatever a date arrives as: a Date, an ISO string, or an Excel serial
 *  (which is what a CSV date column becomes once the sheet reader has had it). */
function isoDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  if (typeof v === "number" && v > 20000 && v < 80000) {
    return isoDate(new Date(Date.UTC(1899, 11, 30 + Math.round(v))));
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const d = new Date(s);
  return isNaN(d) ? null : isoDate(d);
}

async function importIndexWeightsFromFile(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
  if (!rows.length) throw new Error("that file has no rows");

  const pick = (r, ...names) => {
    for (const n of names) {
      const k = Object.keys(r).find(x => x.toLowerCase().replace(/[^a-z]/g, "") === n);
      if (k) return r[k];
    }
    return null;
  };
  if (pick(rows[0], "share") == null || pick(rows[0], "weight") == null) {
    throw new Error("expected Share and Weight columns");
  }

  const months = {};
  rows.forEach(r => {
    const me = isoDate(pick(r, "monthend"));
    const share = String(pick(r, "share") || "").trim().toUpperCase();
    const code = String(pick(r, "indexcode") || "").trim().toUpperCase();
    const weight = Number(pick(r, "weight"));
    if (!me || !share || !code || !isFinite(weight)) return;
    const month = me.slice(0, 7);
    const m = (months[month] = months[month] || { monthEnd: null, sourceDate: null, indices: {} });
    // Two dates, and only one of them means anything. RMB sends a weekly file each Friday
    // and one monthly file per month; the monthly file is that month's cut whether it
    // arrives on the last day or a few days later. So the month-end is the as-at date, and
    // the source date is just when the file happened to land — kept for reference, never
    // treated as a mismatch. (April 2026 reads 1 May for exactly this reason: the JSE was
    // shut for Workers' Day, so those are 30 April closes.)
    m.monthEnd = me;
    m.sourceDate = isoDate(pick(r, "sourcedate")) || me;
    const idx = (m.indices[code] = m.indices[code] || {
      label: [code, pick(r, "portfolio")].filter(Boolean).join(" "),
      sourceSheet: pick(r, "sourcesheet") || "",
      weights: {}
    });
    // the file carries decimals; percentages are what everything else here speaks
    idx.weights[share] = weight * 100;
  });

  indexWeightsStore = { months, fileName: file.name, loadedAt: new Date().toISOString() };
  persistIndexWeights();
  return {
    months: Object.keys(months).length,
    indices: [...new Set(Object.values(months).flatMap(m => Object.keys(m.indices)))]
  };
}

function clearIndexWeights() {
  indexWeightsStore = { months: {}, fileName: "", loadedAt: null };
  persistIndexWeights();
}

function listIndexMonths() {
  return Object.keys(indexWeightsStore.months).sort().reverse();
}

function listIndexCodes(month) {
  const m = indexWeightsStore.months[month];
  return m ? Object.keys(m.indices).sort() : [];
}

function indexInfo(month, code) {
  const m = indexWeightsStore.months[month];
  return (m && m.indices[code]) || null;
}

/** Which index a futures line tracks, from its contract name. */
function futureIndexCode(h) {
  const s = `${h.name || ""} ${h.ticker || ""}`;
  const hit = FUTURE_INDEX.find(([re]) => re.test(s));
  return hit ? hit[1] : null;
}

/** A futures line as economic exposure: contracts x the live index price on the file x R10
 *  a point. Returns null for anything that is not an index future.
 *
 *  `notional` is null when the saved history predates the contract count being kept, which
 *  is worth telling apart from a fund holding no futures at all. */
function futuresExposure(h) {
  if (!/derivative/i.test(h.category || "")) return null;
  const code = futureIndexCode(h);
  if (!code) return null;
  const contracts = h.nominal, price = h.price;
  if (!contracts || !price) return { code, contracts: null, price: null, notional: null };
  return { code, contracts, price, notional: contracts * price * RAND_PER_INDEX_POINT };
}

/** The index constituents a future's notional resolves into: [[share, rand], ...].
 *  A long future is equity exposure bought with cash, so whatever this adds to equity has
 *  to come off cash or the fund totals more than its own NAV. The caller does that part. */
function spreadFutureAcrossIndex(code, notional, month) {
  const info = indexInfo(month, code);
  if (!info || !notional) return [];
  return Object.entries(info.weights).map(([share, pct]) => [share, (notional * pct) / 100]);
}

/** Equity exposure in rand, by JSE code, with offshore and futures kept separate so each
 *  can be reported and toggled rather than silently folded in. */
function fundEquityExposure(fund, month) {
  const snap = historyStore.periods[`${fund}|${month}`];
  if (!snap) return null;
  const sa = new Map();
  let offshore = 0;
  const futures = [];
  const total = snap.total;

  function walk(holdings, scale) {
    holdings.forEach(h => {
      // value and pct are zero on a futures line; nominal x price is the only record
      const fut = futuresExposure(h);
      if (fut) {
        futures.push({
          name: h.name, code: fut.code, contracts: fut.contracts,
          notional: fut.notional == null ? null : fut.notional * scale
        });
        return;
      }
      if (isNonEquityHolding(h)) return;
      const rand = ((h.pct || 0) / 100) * total * scale;
      if (!rand) return;
      if (isFundHolding(h)) {
        const target = resolveFundForHolding(h, listFundsWithHoldings());
        const sub = target && getFundSnapshotAtOrBefore(target, month, null);
        if (sub && sub.holdings) { walk(sub.holdings, scale * (h.pct || 0) / 100); return; }
      }
      if (String(h.ccy || "").trim().toUpperCase() === "ZAR") {
        const k = rawTicker(h.ticker) || (h.name || "").toUpperCase();
        sa.set(k, (sa.get(k) || 0) + rand);
      } else {
        offshore += rand;
      }
    });
  }
  walk(snap.holdings || [], 1);
  return { sa, offshore, futures, total, asOf: isoDate(snap.asOf) };
}

/** Active share for one fund, month and index.
 *
 *  Returns null when there is nothing to compare. Both sides are that month's cut: the
 *  lookup is keyed on the month, and the monthly index file is the month's data whenever
 *  it happens to arrive. */
function computeActiveShare(fund, month, { indexCode, includeOffshore = false } = {}) {
  const exp = fundEquityExposure(fund, month);
  const info = indexInfo(month, indexCode);
  if (!exp || !info) return null;

  const sa = new Map(exp.sa);
  const applied = [];
  exp.futures.forEach(f => {
    const spread = spreadFutureAcrossIndex(f.code, f.notional, month);
    if (!spread.length) { applied.push({ ...f, applied: false }); return; }
    spread.forEach(([share, rand]) => sa.set(share, (sa.get(share) || 0) + rand));
    applied.push({ ...f, applied: true });
  });

  const saTotal = [...sa.values()].reduce((s, v) => s + v, 0);
  if (!saTotal) return null;
  const base = includeOffshore ? saTotal + exp.offshore : saTotal;
  const fw = new Map([...sa].map(([k, v]) => [k, (v / base) * 100]));
  const offshoreWeight = includeOffshore ? (exp.offshore / base) * 100 : 0;

  const rows = [];
  new Set([...fw.keys(), ...Object.keys(info.weights)]).forEach(k => {
    const f = fw.get(k) || 0, b = info.weights[k] || 0;
    rows.push({ share: k, fund: f, bench: b, active: f - b });
  });
  rows.sort((a, b) => Math.abs(b.active) - Math.abs(a.active));

  // offshore has no benchmark counterpart, so its whole weight is active
  const value = 0.5 * (rows.reduce((s, r) => s + Math.abs(r.active), 0) + offshoreWeight);
  const mrec = indexWeightsStore.months[month] || {};

  return {
    value, rows, futures: applied,
    offshorePct: (exp.offshore / exp.total) * 100,
    offshoreWeight,
    // both sides are that month's cut by construction — the lookup is keyed on the month
    fundAsOf: exp.asOf, indexMonthEnd: mrec.monthEnd || null, indexSourceDate: mrec.sourceDate || null,
    sourceSheet: info.sourceSheet, label: info.label
  };
}

/** The same figure across every month both sides cover, for the trend chart. */
function activeShareSeries(fund, indexCode, opts = {}) {
  return listIndexMonths().slice().sort()
    .map(month => {
      const r = computeActiveShare(fund, month, { ...opts, indexCode });
      return r && { month, ...r };
    })
    .filter(Boolean);
}
