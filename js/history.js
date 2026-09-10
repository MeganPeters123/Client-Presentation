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
    if (!raw) return { periods: {} };
    const parsed = JSON.parse(raw);
    const periods = {};
    Object.entries(parsed.periods || {}).forEach(([key, snap]) => {
      periods[key] = { ...snap, asOf: snap.asOf ? new Date(snap.asOf) : null, savedAt: snap.savedAt ? new Date(snap.savedAt) : null };
    });
    return { periods };
  } catch (e) {
    console.error("Could not read saved history", e);
    return { periods: {} };
  }
}

function persistHistoryStore() {
  try {
    const serializable = { periods: {} };
    Object.entries(historyStore.periods).forEach(([key, snap]) => {
      serializable.periods[key] = { ...snap, asOf: snap.asOf ? snap.asOf.toISOString() : null, savedAt: snap.savedAt ? snap.savedAt.toISOString() : null };
    });
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(serializable));
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

/** That fund's most recent saved snapshot at or before the given month (handles funds not
 *  updated every single month) — or null if nothing saved for it yet. */
function getFundSnapshotAtOrBefore(fund, monthKey) {
  const candidates = listPeriodsForFund(fund).filter(s => s.period <= monthKey);
  return candidates.length ? candidates[0] : null;
}

/** Sums every fund's latest-known snapshot at or before the given month. */
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
  const serializable = { periods: {} };
  Object.entries(historyStore.periods).forEach(([key, snap]) => {
    serializable.periods[key] = { ...snap, asOf: snap.asOf ? snap.asOf.toISOString() : null, savedAt: snap.savedAt ? snap.savedAt.toISOString() : null };
  });
  const blob = new Blob([JSON.stringify(serializable, null, 2)], { type: "application/json" });
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
  let imported = 0;
  Object.entries(parsed.periods || {}).forEach(([key, snap]) => {
    historyStore.periods[key] = { ...snap, asOf: snap.asOf ? new Date(snap.asOf) : null, savedAt: snap.savedAt ? new Date(snap.savedAt) : null };
    imported++;
  });
  if (imported) persistHistoryStore();
  return imported;
}
