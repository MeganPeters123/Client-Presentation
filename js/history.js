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
