/* Persists fund snapshots across sessions (localStorage), keyed by fund + month, so past
   periods can be browsed/compared/trended without re-uploading source files every time.
   Also supports exporting/importing the whole store as a single portable .json file. */
"use strict";

const HISTORY_STORAGE_KEY = "aum-dashboard-history-v1";

function monthKeyFromDate(date) {
  if (!(date instanceof Date) || isNaN(date)) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabelFromKey(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

function loadHistoryStore() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return { periods: {}, trades: {} };
    const parsed = JSON.parse(raw);
    const periods = {};
    Object.entries(parsed.periods || {}).forEach(([key, snap]) => {
      periods[key] = { ...snap, asOf: snap.asOf ? new Date(snap.asOf) : null, savedAt: snap.savedAt ? new Date(snap.savedAt) : null };
    });
    return { periods, trades: parsed.trades || {} };
  } catch (e) {
    console.error("Could not read saved history", e);
    return { periods: {}, trades: {} };
  }
}

function serializeHistoryStore() {
  const out = { periods: {}, trades: historyStore.trades || {} };
  Object.entries(historyStore.periods).forEach(([key, snap]) => {
    out.periods[key] = { ...snap, asOf: snap.asOf ? snap.asOf.toISOString() : null, savedAt: snap.savedAt ? snap.savedAt.toISOString() : null };
  });
  return out;
}

function persistHistoryStore() {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(serializeHistoryStore()));
    return true;
  } catch (e) {
    console.error("Could not save history locally", e);
    return false;
  }
}

let historyStore = loadHistoryStore();

/** Saves the given fund snapshots (state.holdingsSnapshots shape) into history, one entry per
 *  fund keyed by that snapshot's as-of month. Re-saving the same fund+month overwrites it. */
function saveSnapshotsToHistory(snapshots) {
  let saved = 0;
  snapshots.forEach(snap => {
    const monthKey = monthKeyFromDate(snap.asOf);
    if (!monthKey) return;
    const key = `${snap.fund}|${monthKey}`;
    historyStore.periods[key] = {
      fund: snap.fund, fundCode: snap.fundCode, period: monthKey, asOf: snap.asOf,
      total: snap.total, segments: snap.segments, source: snap.source, format: snap.format,
      savedAt: new Date()
    };
    saved++;
  });
  if (saved) persistHistoryStore();
  return saved;
}

function deleteHistoryPeriod(fund, monthKey) {
  delete historyStore.periods[`${fund}|${monthKey}`];
  persistHistoryStore();
}

function listAllFundsInHistory() {
  return [...new Set(Object.values(historyStore.periods).map(s => s.fund))].sort();
}

function listAllPeriodMonths() {
  return [...new Set(Object.values(historyStore.periods).map(s => s.period))].sort().reverse();
}

/** All saved periods for one fund, newest first. */
function listPeriodsForFund(fund) {
  return Object.values(historyStore.periods)
    .filter(s => s.fund === fund)
    .sort((a, b) => b.period.localeCompare(a.period));
}

/** How many months a fund's last snapshot may be carried forward when it's missing for a
 *  month. Covers the odd late/missing file, but stops a closed mandate from propping up the
 *  consolidated total forever — that would silently overstate AUM on a client slide. */
const MAX_CARRY_FORWARD_MONTHS = 2;

function monthsBetween(fromKey, toKey) {
  const [fy, fm] = fromKey.split("-").map(Number);
  const [ty, tm] = toKey.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/** That fund's most recent saved snapshot at or before the given month (handles funds not
 *  updated every single month) — or null if nothing saved for it, or it's gone stale. */
function getFundSnapshotAtOrBefore(fund, monthKey, maxAgeMonths = MAX_CARRY_FORWARD_MONTHS) {
  const candidates = listPeriodsForFund(fund).filter(s => s.period <= monthKey);
  if (!candidates.length) return null;
  const snap = candidates[0];
  if (maxAgeMonths != null && monthsBetween(snap.period, monthKey) > maxAgeMonths) return null;
  return snap;
}

/** Sums every fund's latest-known snapshot at or before the given month, ignoring funds whose
 *  last snapshot is too old to still count as current (see MAX_CARRY_FORWARD_MONTHS). */
function getConsolidatedAtPeriod(monthKey) {
  const funds = listAllFundsInHistory();
  const included = funds.map(f => getFundSnapshotAtOrBefore(f, monthKey)).filter(Boolean);
  const total = included.reduce((s, snap) => s + snap.total, 0);
  const byCategory = new Map();
  included.forEach(snap => snap.segments.forEach(seg => byCategory.set(seg.category, (byCategory.get(seg.category) || 0) + seg.value)));
  const segments = [...byCategory.entries()]
    .map(([category, value]) => ({ category, value, pct: total ? (value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
  return { total, segments, funds: included };
}

function exportHistoryToFile() {
  const blob = new Blob([JSON.stringify(serializeHistoryStore(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `aum-dashboard-history-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importHistoryFromFile(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  let imported = 0, tradeMonths = 0;
  Object.entries(parsed.periods || {}).forEach(([key, snap]) => {
    historyStore.periods[key] = { ...snap, asOf: snap.asOf ? new Date(snap.asOf) : null, savedAt: snap.savedAt ? new Date(snap.savedAt) : null };
    imported++;
  });
  historyStore.trades = historyStore.trades || {};
  Object.entries(parsed.trades || {}).forEach(([month, entry]) => {
    historyStore.trades[month] = entry;
    tradeMonths++;
  });
  if (imported || tradeMonths) persistHistoryStore();
  return { snapshots: imported, tradeMonths };
}

/* ---------- position-level holdings ---------- */

function listFundsWithHoldings() {
  return [...new Set(Object.values(historyStore.periods)
    .filter(s => (s.holdings || []).length)
    .map(s => s.fund))].sort();
}

function getHoldings(fund, monthKey) {
  const snap = historyStore.periods[`${fund}|${monthKey}`];
  return (snap && snap.holdings) || [];
}

function listHoldingMonthsForFund(fund) {
  return Object.values(historyStore.periods)
    .filter(s => s.fund === fund && (s.holdings || []).length)
    .map(s => s.period)
    .sort()
    .reverse();
}

/** Tickers are more stable than names across periods, so key on ticker where present. */
/** What counts as one position.
 *
 *  Both legs of a dual listing key under the issuer, so holding Ninety One Plc and Ninety
 *  One Ltd is one holding at their combined weight, and switching from one leg to the other
 *  is not a portfolio change. Across the archive that is 14 month-to-month steps where the
 *  issuer was held throughout but the legs moved — each one a false exit, a false entry or
 *  both. Active share already compared on this basis; the holdings lists now agree with it.
 *
 *  resolveIssuer lives in activeshare.js, which loads after this file. */
function holdingKey(h) {
  const issuer = typeof resolveIssuer === "function" ? resolveIssuer(h.ticker) : null;
  if (issuer) return issuer;
  return (h.ticker || h.name || "").trim().toUpperCase();
}

/** What a holding is called on screen, where the export's own name is out of date.
 *
 *  The custodian files still say "Reed Elsevier PLC" for a company that has been RELX since
 *  2015. Renaming here rather than in the source keeps the exports untouched and survives
 *  every rebuild.
 *
 *  Keyed on the ticker, exact spelling first and then the stem. A stem key must be checked
 *  against the archive before it is added: AMS is Anglo American Platinum on the JSE and
 *  Amadeus in Madrid, so a stem is only safe where one company answers to it. REL is. */
const SECURITY_NAMES = {
  "REL": "RELX PLC",     // renamed from Reed Elsevier in 2015
  "PRX": "Prosus"        // the files disagree — "PROSUS" from one, "Prosus NV" from another
};

function displayName(h) {
  const raw = String(h.ticker == null ? "" : h.ticker).trim().toUpperCase();
  const stem = typeof normTicker === "function" ? normTicker(raw) : raw;
  return SECURITY_NAMES[raw] || SECURITY_NAMES[stem] || h.name || "";
}

/** True for the secondary leg of a dual listing — the one that keys under another code. */
function isSecondaryLeg(h) {
  return typeof resolveIssuer === "function" && !!resolveIssuer(h.ticker);
}

/** Cash, call accounts, money-market funds and fee accruals aren't "holdings" for a
 *  top-10 or a portfolio-changes list — they're the residual the portfolio sits in. */
/** Cash and the instruments the firm treats as cash.
 *
 *  Treasury bills and NCDs are cash management, not positions: they are bought to mature and
 *  replaced when they do, so a list of portfolio changes fills with them. One fund showed 63
 *  entries and exits over a year of which 47 were bills and NCDs rolling.
 *
 *  They cannot be caught by category, because the same instrument is filed under "Money
 *  Market" in one fund and "SA Fixed Income" in another — 44 bills and 71 NCDs sit under the
 *  latter. So the name decides. Real bonds are untouched by this: an R2032 is a position and
 *  still shows, unless "Equities only" is on. */
const CASH_CATEGORY = /cash|money market|\bMMA\b/i;
// The trade files name the same instruments by internal code — AYTB0014, AYNCD072 — where
// the holdings files spell them out ("Republic Of South Africa TB 7.576% 28012026"), so the
// codes need their own alternative: there is no word boundary inside AYTB to match on.
const CASH_INSTRUMENT = /\bTB\b|\bNCD\b|treasury bill|negotiable certificate|\bAY(TB|NCD)\d/i;

function isCashLike(h) {
  return CASH_CATEGORY.test(h.category || "") || CASH_INSTRUMENT.test(h.name || "");
}

/** Bonds and bills. A fund holding one R2032 line at 12.9% has it sitting above every share
 *  it owns, which is right for the fund and wrong for a slide about stock picking — hence
 *  the toggle rather than a fixed rule. The three source formats word this differently:
 *  "Bonds" from the custodian, "SA Fixed Income" from the flat CSV. */
function isBondLike(h) {
  return /bond|fixed income|treasury|gilt|\bbill\b/i.test(h.category || "");
}

/** Futures, options and the like are never a holding for these lists. A derivative's market
 *  value is its unrealised profit rather than its exposure, so a contract opened in the
 *  period arrives as an entry at 0.0000% and a contract rolled to the next quarter reads as
 *  one position closed and another opened — neither of which is a stock pick.
 *
 *  The exposure is not lost by dropping it here: active share still takes the notional from
 *  nominal x price and spreads it across the index, and the allocation still counts it as
 *  equity with the cash offset against it. Only the holdings lists ignore it.
 *
 *  Category catches the usual wording, and the contract name carries a dated code
 *  ("17SEP26 CTOP") for any format that files a derivative somewhere unexpected. */
const DERIVATIVE_CATEGORY = /derivativ|future|option|swap|forward/i;
const CONTRACT_NAME = /^\s*\d{1,2}[A-Z]{3}\d{2}\b/i;

function isDerivative(h) {
  return DERIVATIVE_CATEGORY.test(h.category || "") || CONTRACT_NAME.test(h.name || "");
}

/** The same judgement for a trade record, which carries no category — only the security
 *  description and the transaction wording, so both have to be read.
 *
 *  Matching a bare word against a security name is the risk here: "Futuregrowth" is a real
 *  manager whose money-market funds these portfolios hold, and /future/ would take its
 *  trades out with the contracts. Hence word boundaries, and hence SAFEX is absent — the
 *  SAFEX ZAR call account is cash, not a derivative.
 *
 *  Margin and variation calls are the cash leg of a futures position rather than a trade in
 *  anything, and the ledger format writes them as a description with no quantity.
 *
 *  "Forward" is read in the description but not in a security name: Forward Air and Forward
 *  Industries are both listed companies, and losing a real equity trade is the worse error
 *  of the two. An FX forward named as a security stays in the blotter, where it can be seen. */
const DERIVATIVE_NAME = /\bfutures?\b|\boptions?\b|\bswaps?\b|\b(ALSI|CTOP|DCAP|DTOP)\b/i;
const DERIVATIVE_DESC = /\bfutures?\b|\boptions?\b|\bswaps?\b|\bforwards?\b|margin|variation call/i;

function isDerivativeTrade(t) {
  return CONTRACT_NAME.test(t.security || "") || DERIVATIVE_NAME.test(t.security || "")
      || DERIVATIVE_DESC.test(t.type || "");
}

/** Whether a row in the blotter is a trade at all.
 *
 *  Most of what these reports contain is not. Across the three sources, 6,817 of 19,124
 *  rows move no position: expense adjustments, accruals, dividends, coupons, interest,
 *  revaluations and corporate actions. Apex is the extreme — 50 distinct transaction codes,
 *  of which only a third of rows are buys or sells, and its 2,312 EXADJ+ rows outnumber
 *  every purchase and sale in the file combined.
 *
 *  Matched on the verb rather than a list of codes, because the list is open-ended and each
 *  system spells it differently: Prescient says BUY, Apex says BUY, RBUY, CBUY, RBBUY and
 *  BUYIK for in specie, Curo says "Share purchase". A verb test picks up a variant nobody
 *  has seen yet; an enumeration would quietly drop it. FUT is in the list because opening
 *  and closing a future is a trade (Apex writes those OPLFUT and CLLFUT) — but MTM is not,
 *  being a daily revaluation rather than anything transacted.
 *
 *  A code carrying no verb is treated as not a trade, so anything genuinely new shows up as
 *  a fall in the count rather than as a row silently asserted to be a trade. */
const TRADE_VERB = /BUY|SELL|PURCH|\bSALE\b|FUT/i;

function isTradeRow(t) {
  // Bills and NCDs are cash management on the way in as much as on the way out. Their
  // maturities were already out, being no transaction at all, and leaving the purchases in
  // showed the buy while hiding the roll-off. The instrument decides, not the code: Curo
  // files an R2032 and an AYNCD under the same "Fixed Interest Purchase", so a code test
  // would take real bond trades with them.
  return TRADE_VERB.test(t.type || "") && !CASH_INSTRUMENT.test(t.security || "");
}

/** SA or global, by the same rule the allocation uses: the trading currency, falling back to
 *  what the category implies for the formats that carry no currency. Applies to bonds as
 *  much as shares, so "SA only" is the whole South African book. */
function holdingSide(h) {
  const ccy = typeof holdingCcy === "function"
    ? holdingCcy(h) : String(h.ccy || "").trim().toUpperCase();
  return ccy === "ZAR" ? "sa" : "global";
}

function holdingsByKey(fund, monthKey,
                       { excludeCash = true, excludeBonds = false, expandFunds = false,
                         region = "all" } = {}) {
  const map = new Map();

  function add(h, scale) {
    // tested here rather than in the walk: a fund wrapper carries its own currency, so
    // filtering before expansion would drop a USD-denominated fund and take its JSE
    // holdings with it. Leaves are what get judged.
    if (region !== "all" && holdingSide(h) !== region) return;
    const k = holdingKey(h);
    if (!k) return;
    const pct = (h.pct || 0) * scale, value = (h.value || 0) * scale;
    // a security can appear more than once — different classes, different accounts, or the
    // same share held directly and again inside a fund we looked through — so combine
    const prev = map.get(k);
    if (prev) {
      prev.pct += pct; prev.value += value;
      // the issuer's own line names the merged row, rather than whichever leg the file
      // happened to list first — "Ninety One Ltd", not "Ninety One Plc"
      if (isSecondaryLeg(prev) && !isSecondaryLeg(h)) {
        prev.name = displayName(h); prev.ticker = h.ticker; prev.ccy = h.ccy; prev.category = h.category;
      }
    }
    // the top ten and the changes list both read this map, so the name is settled once here
    else map.set(k, { ...h, name: displayName(h), pct, value });
  }

  function walk(holdings, scale, visited) {
    holdings.forEach(h => {
      if (isDerivative(h)) return;
      if (excludeCash && isCashLike(h)) return;
      if (excludeBonds && isBondLike(h)) return;
      // A holding in one of the firm's own funds is not a stock pick; looked through, its
      // shares join the list and merge with any held directly, which is what the fund
      // actually owns. resolveFundForHolding lives in lookthrough.js, loaded after this.
      if (expandFunds && typeof isFundHolding === "function" && isFundHolding(h)) {
        const target = resolveFundForHolding(h, listFundsWithHoldings());
        const sub = target && !visited.has(target) && getFundSnapshotAtOrBefore(target, monthKey, null);
        if (sub && (sub.holdings || []).length) {
          visited.add(target);
          walk(sub.holdings, scale * (h.pct || 0) / 100, visited);
          return;
        }
      }
      add(h, scale);
    });
  }

  walk(getHoldings(fund, monthKey), 1, new Set([fund]));
  return map;
}

/** Top N by current weight, with the comparison period's weight alongside. */
function computeTopHoldings(fund, currentMonth, priorMonth, n = 10, opts = {}) {
  const now = holdingsByKey(fund, currentMonth, opts);
  const before = holdingsByKey(fund, priorMonth, opts);
  return [...now.values()]
    .sort((a, b) => b.pct - a.pct)
    .slice(0, n)
    .map(h => {
      const prior = before.get(holdingKey(h));
      const priorPct = prior ? prior.pct : 0;
      return { name: h.name, ticker: h.ticker, current: h.pct, prior: priorPct, change: h.pct - priorPct };
    });
}

/** Positions opened since the comparison period, and those closed out of it.
 *  minPct of 0 returns everything, including moves that round to 0.0%. */
function computePortfolioChanges(fund, currentMonth, priorMonth, minPct = 0, opts = {}) {
  const now = holdingsByKey(fund, currentMonth, opts);
  const before = holdingsByKey(fund, priorMonth, opts);

  const entries = [...now.values()]
    .filter(h => !before.has(holdingKey(h)) && h.pct >= minPct)
    .map(h => ({ name: h.name, ticker: h.ticker, change: h.pct }))
    .sort((a, b) => b.change - a.change);

  const exits = [...before.values()]
    .filter(h => !now.has(holdingKey(h)) && h.pct >= minPct)
    .map(h => ({ name: h.name, ticker: h.ticker, change: -h.pct }))
    .sort((a, b) => a.change - b.change);

  return { entries, exits };
}

/* ---------- trading activity ---------- */

function listTradeMonths() {
  return Object.keys(historyStore.trades || {}).sort();
}

/** [{ month, label, byClass }] oldest first, for the chart and table. */
function listTradeActivity() {
  return listTradeMonths().map(month => ({
    month,
    label: monthLabelFromKey(month),
    byClass: (historyStore.trades[month] || {}).byClass || {}
  }));
}

function tradeValue(month, assetClass, action) {
  const byClass = (historyStore.trades[month] || {}).byClass || {};
  return ((byClass[assetClass] || {})[action] || {}).value || 0;
}

/** Every asset class present across the loaded trade months. */
function listTradeAssetClasses() {
  const seen = new Set();
  Object.values(historyStore.trades || {}).forEach(entry => {
    Object.keys(entry.byClass || {}).forEach(c => seen.add(c));
  });
  return [...seen];
}
