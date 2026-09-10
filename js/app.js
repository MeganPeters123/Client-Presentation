/* UI wiring: uploads, column-mapping modal, rendering, filters, theme, export. */
"use strict";

const state = { aum: [], allocation: [], trades: [], tradeSources: [], holdingsSnapshots: [] }; // tradeSources: [{ fileName, count }]; holdingsSnapshots: [{ fund, fundCode, asOf, total, segments, source, format }]
let pendingUpload = null; // { kind, headers, rows }
let pendingExcludedValues = new Set(); // values checked "exclude" in the row-filter panel
let tradeFilter = { type: "all", search: "", from: "", to: "", source: "all" };
let tradeSort = { key: "date", dir: "desc" };
let selectedFund = "all"; // "all" (consolidated) or a fund name (live or saved-to-history)
let selectedPeriod = "current"; // "current" (live upload) or a "YYYY-MM" saved history month
let hasAutoSelectedPeriod = false; // so a fresh page load with saved history (but no live upload yet) opens on the latest saved month instead of an empty "Current"

/* ---------- theme ---------- */
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("aum-dashboard-theme"); } catch (e) {}
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  document.getElementById("themeToggle").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("aum-dashboard-theme", next); } catch (e) {}
    if (state.aum.length) renderAumChart(state.aum);
    if (state.allocation.length) renderAllocationChart(computeAllocationSegments(state.allocation));
  });
})();

/* ---------- data panel collapse ---------- */
document.getElementById("dataPanelHead").addEventListener("click", () => {
  document.getElementById("dataPanel").classList.toggle("collapsed");
});

/* ---------- toast ---------- */
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------- upload wiring ---------- */
["aum", "allocation", "trades", "holdings"].forEach(kind => {
  const slot = document.getElementById("slot-" + kind);
  const input = document.getElementById("file-" + kind);
  slot.addEventListener("click", () => input.click());
  slot.addEventListener("dragover", e => { e.preventDefault(); slot.classList.add("drag"); });
  slot.addEventListener("dragleave", () => slot.classList.remove("drag"));
  slot.addEventListener("drop", e => {
    e.preventDefault(); slot.classList.remove("drag");
    if (e.dataTransfer.files.length) handleUpload(kind, e.dataTransfer.files[0]);
  });
  input.addEventListener("change", () => { if (input.files.length) handleUpload(kind, input.files[0]); });
});

async function handleUpload(kind, file) {
  if (kind === "holdings") { await handleHoldingsUpload(file); return; }
  try {
    const { headers, rows } = await parseFile(file);
    pendingUpload = { kind, headers, rows, fileName: file.name };
    openMappingModal(kind, headers);
  } catch (err) {
    console.error(err);
    showToast("Could not read that file: " + err.message);
  }
}

/* ---------- fund holdings (auto-detected format, no mapping step) ---------- */
async function handleHoldingsUpload(file) {
  try {
    const snapshots = await parseHoldingsFile(file);
    snapshots.forEach(snap => {
      state.holdingsSnapshots = state.holdingsSnapshots.filter(s => s.fund !== snap.fund);
      state.holdingsSnapshots.push(snap);
    });
    renderHoldingsSourceList();
    const names = snapshots.map(s => s.fund).join(", ");
    showToast(`Fund Holdings loaded — ${names} (${snapshots[0].format})`);
    renderAll();
  } catch (err) {
    console.error(err);
    showToast("Could not read that file: " + err.message);
  }
}

function removeFundSnapshot(fundName) {
  state.holdingsSnapshots = state.holdingsSnapshots.filter(s => s.fund !== fundName);
  if (selectedFund === fundName) selectedFund = "all";
  renderHoldingsSourceList();
  renderAll();
}

function renderHoldingsSourceList() {
  const slot = document.getElementById("slot-holdings");
  const list = document.getElementById("holdingsSourceList");
  const status = document.getElementById("status-holdings");
  if (!state.holdingsSnapshots.length) {
    slot.classList.remove("loaded");
    status.textContent = "";
    list.innerHTML = "";
    return;
  }
  slot.classList.add("loaded");
  status.textContent = `${state.holdingsSnapshots.length} fund${state.holdingsSnapshots.length > 1 ? "s" : ""} loaded`;
  list.innerHTML = state.holdingsSnapshots.map(s => `
    <div class="source-chip">
      <span>${s.fund}</span>
      <span class="n">${fmtCurrency(s.total)}</span>
      <span class="rm" data-fund="${s.fund.replace(/"/g, "&quot;")}" title="Remove this fund">✕</span>
    </div>`).join("");
  list.querySelectorAll(".rm").forEach(el => {
    el.addEventListener("click", ev => { ev.stopPropagation(); removeFundSnapshot(el.dataset.fund); });
  });
}

/* ---------- column mapping modal ---------- */
const KIND_LABEL = { aum: "AUM History", allocation: "Asset Allocation", trades: "Trade Records" };

function openMappingModal(kind, headers) {
  const defs = FIELD_DEFS[kind];
  const guess = guessMapping(headers, defs);
  document.getElementById("mapTitle").textContent = "Match your columns — " + KIND_LABEL[kind];
  document.getElementById("mapHint").textContent = `${pendingUpload.fileName} · ${pendingUpload.rows.length} rows detected. Check the mapping below.`;

  const wrap = document.getElementById("mapFields");
  wrap.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "map-grid";
  defs.forEach(def => {
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.textContent = def.label + (def.optional ? " (optional)" : "");
    const select = document.createElement("select");
    select.dataset.fieldKey = def.key;
    if (def.optional) {
      const noneOpt = document.createElement("option");
      noneOpt.value = ""; noneOpt.textContent = "— none —";
      select.appendChild(noneOpt);
    }
    headers.forEach(h => {
      const opt = document.createElement("option");
      opt.value = h; opt.textContent = h;
      if (guess[def.key] === h) opt.selected = true;
      select.appendChild(opt);
    });
    field.appendChild(label);
    field.appendChild(select);
    grid.appendChild(field);
  });
  wrap.appendChild(grid);
  setupFilterSection(headers);
  document.getElementById("mapModal").style.display = "flex";
}

/* ---------- row-exclusion filter (e.g. drop non-trade rows from a mixed ledger export) ---------- */
function setupFilterSection(headers) {
  pendingExcludedValues = new Set();
  const section = document.getElementById("mapFilterSection");
  const toggle = document.getElementById("mapFilterToggle");
  const body = document.getElementById("mapFilterBody");
  const colSelect = document.getElementById("mapFilterColumn");
  const valuesWrap = document.getElementById("mapFilterValues");

  section.style.display = "block";
  body.style.display = "none";
  toggle.classList.remove("open");
  colSelect.innerHTML = '<option value="">— none —</option>' +
    headers.map(h => `<option value="${h.replace(/"/g, "&quot;")}">${h}</option>`).join("");
  valuesWrap.innerHTML = "";

  toggle.onclick = () => {
    const open = body.style.display !== "none";
    body.style.display = open ? "none" : "block";
    toggle.classList.toggle("open", !open);
  };

  colSelect.onchange = () => {
    pendingExcludedValues = new Set();
    renderFilterValues(colSelect.value);
  };
}

function renderFilterValues(column) {
  const valuesWrap = document.getElementById("mapFilterValues");
  if (!column || !pendingUpload) { valuesWrap.innerHTML = ""; return; }
  const counts = new Map();
  for (const row of pendingUpload.rows) {
    const raw = row[column];
    const val = raw == null ? "(blank)" : String(raw).trim() || "(blank)";
    counts.set(val, (counts.get(val) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  valuesWrap.innerHTML = sorted.map(([val, n]) => `
    <div class="filter-value-row">
      <input type="checkbox" data-val="${val.replace(/"/g, "&quot;")}">
      <label>${val}<span class="n">${n}</span></label>
    </div>`).join("") + `<div class="filter-hint" style="padding:6px 10px 8px;">Tick the values to exclude — everything unticked stays in.</div>`;
  valuesWrap.querySelectorAll("input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", () => {
      if (cb.checked) pendingExcludedValues.add(cb.dataset.val);
      else pendingExcludedValues.delete(cb.dataset.val);
    });
  });
}

document.getElementById("mapCancel").addEventListener("click", () => {
  document.getElementById("mapModal").style.display = "none";
  pendingUpload = null;
});

document.getElementById("mapConfirm").addEventListener("click", () => {
  if (!pendingUpload) return;
  const { kind, rows } = pendingUpload;
  const selects = document.querySelectorAll("#mapFields select");
  const mapping = {};
  selects.forEach(s => { mapping[s.dataset.fieldKey] = s.value; });

  const required = FIELD_DEFS[kind].filter(d => !d.optional);
  const missing = required.filter(d => !mapping[d.key]);
  if (missing.length) {
    showToast("Please map: " + missing.map(d => d.label).join(", "));
    return;
  }

  const filterColumn = document.getElementById("mapFilterColumn").value;
  let sourceRows = rows;
  if (filterColumn && pendingExcludedValues.size) {
    sourceRows = rows.filter(row => {
      const raw = row[filterColumn];
      const val = raw == null ? "(blank)" : String(raw).trim() || "(blank)";
      return !pendingExcludedValues.has(val);
    });
    if (!sourceRows.length) {
      showToast("That excludes every row — untick at least one value.");
      return;
    }
  }

  const records = applyMapping(kind, sourceRows, mapping);
  if (!records.length) {
    showToast("None of the rows could be read with that mapping — check the file and try again.");
    return;
  }
  document.getElementById("mapModal").style.display = "none";

  if (kind === "trades") {
    addTradeSource(pendingUpload.fileName, records);
  } else {
    state[kind] = records;
    const slot = document.getElementById("slot-" + kind);
    slot.classList.add("loaded");
    document.getElementById("status-" + kind).textContent = `${records.length} rows loaded`;
  }

  showToast(`${KIND_LABEL[kind]} loaded — ${records.length} rows`);
  pendingUpload = null;
  renderAll();
});

/* ---------- trade sources (multi-file merge) ---------- */
function addTradeSource(fileName, records) {
  records.forEach(r => { r.source = fileName; });
  // re-uploading the same file name replaces just that file's rows
  state.trades = state.trades.filter(t => t.source !== fileName).concat(records);
  const existing = state.tradeSources.find(s => s.fileName === fileName);
  if (existing) existing.count = records.length;
  else state.tradeSources.push({ fileName, count: records.length });
  renderTradeSourceChips();
}

function removeTradeSource(fileName) {
  state.trades = state.trades.filter(t => t.source !== fileName);
  state.tradeSources = state.tradeSources.filter(s => s.fileName !== fileName);
  if (tradeFilter.source === fileName) tradeFilter.source = "all";
  renderTradeSourceChips();
  renderAll();
}

function renderTradeSourceChips() {
  const slot = document.getElementById("slot-trades");
  const list = document.getElementById("tradeSourceList");
  const status = document.getElementById("status-trades");
  if (!state.tradeSources.length) {
    slot.classList.remove("loaded");
    status.textContent = "";
    list.innerHTML = "";
    return;
  }
  slot.classList.add("loaded");
  const total = state.trades.length;
  status.textContent = `${state.tradeSources.length} file${state.tradeSources.length > 1 ? "s" : ""} · ${total} rows loaded`;
  list.innerHTML = state.tradeSources.map(s => `
    <div class="source-chip">
      <span>${s.fileName}</span>
      <span class="n">${s.count}</span>
      <span class="rm" data-file="${s.fileName.replace(/"/g, "&quot;")}" title="Remove this file">✕</span>
    </div>`).join("");
  list.querySelectorAll(".rm").forEach(el => {
    el.addEventListener("click", ev => { ev.stopPropagation(); removeTradeSource(el.dataset.file); });
  });
}

/* ---------- allocation helpers ---------- */
function computeAllocationSegments(records) {
  const total = records.reduce((s, r) => s + (r.value || 0), 0);
  return records
    .map(r => ({ category: r.category, value: r.value, pct: total ? (r.value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

/* ---------- fund holdings: consolidation + the single source of truth for "active" allocation ---------- */
function computeConsolidatedFundSegments() {
  const byCategory = new Map();
  state.holdingsSnapshots.forEach(snap => {
    snap.segments.forEach(seg => byCategory.set(seg.category, (byCategory.get(seg.category) || 0) + seg.value));
  });
  const total = [...byCategory.values()].reduce((s, v) => s + v, 0);
  return [...byCategory.entries()]
    .map(([category, value]) => ({ category, value, pct: total ? (value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

function segmentsFromSnapshot(snap) {
  const total = snap.total;
  return snap.segments
    .map(s => ({ category: s.category, value: s.value, pct: total ? (s.value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

/** Segments feeding both the Asset Allocation card and the PPTX export — Fund Holdings takes
 *  priority over the manually-uploaded Asset Allocation file whenever any holdings are loaded.
 *  Respects both the fund selector and the period selector (live upload vs. a saved month). */
function getActiveAllocationSegments() {
  if (selectedPeriod !== "current") {
    if (selectedFund === "all") {
      const cons = getConsolidatedAtPeriod(selectedPeriod);
      if (cons.total) return { segments: cons.segments, label: `Consolidated, as of ${monthLabelFromKey(selectedPeriod)}` };
    } else {
      const snap = getFundSnapshotAtOrBefore(selectedFund, selectedPeriod);
      if (snap) return { segments: segmentsFromSnapshot(snap), label: `${snap.fund} — ${monthLabelFromKey(snap.period)}` };
    }
    return { segments: [], label: `No saved data for ${monthLabelFromKey(selectedPeriod)}` };
  }
  if (state.holdingsSnapshots.length) {
    if (selectedFund === "all") {
      return { segments: computeConsolidatedFundSegments(), label: `Consolidated across ${state.holdingsSnapshots.length} fund${state.holdingsSnapshots.length > 1 ? "s" : ""}` };
    }
    const snap = state.holdingsSnapshots.find(s => s.fund === selectedFund);
    if (snap) return { segments: segmentsFromSnapshot(snap), label: snap.fund };
  }
  return { segments: computeAllocationSegments(state.allocation), label: "Uploaded allocation file" };
}

/** Trend points (oldest -> newest) for the currently-selected fund (or consolidated across all
 *  funds with any saved history), from saved history plus today's live upload as the latest point. */
function computeFundTrendPoints() {
  const points = [];
  if (selectedFund === "all") {
    listAllPeriodMonths().slice().reverse().forEach(month => {
      const cons = getConsolidatedAtPeriod(month);
      if (cons.total) points.push({ label: monthLabelFromKey(month), value: cons.total });
    });
    if (state.holdingsSnapshots.length) {
      points.push({ label: "Current", value: state.holdingsSnapshots.reduce((s, snap) => s + snap.total, 0) });
    }
  } else {
    listPeriodsForFund(selectedFund).slice().reverse().forEach(snap => {
      points.push({ label: monthLabelFromKey(snap.period), value: snap.total });
    });
    const live = state.holdingsSnapshots.find(s => s.fund === selectedFund);
    if (live) points.push({ label: "Current", value: live.total });
  }
  return points;
}

/* ---------- KPI row ---------- */
function renderKpis() {
  const row = document.getElementById("kpiRow");
  const tiles = [];

  if (state.aum.length) {
    const sorted = state.aum.slice().sort((a, b) => a.date - b.date);
    const latest = sorted[sorted.length - 1];
    const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;
    const delta = prev ? ((latest.aum - prev.aum) / prev.aum) * 100 : null;
    tiles.push({
      label: "Latest AUM", value: "R " + fmtCurrency(latest.aum),
      delta: delta != null ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% vs prior period` : null,
      deltaClass: delta != null ? (delta >= 0 ? "up" : "down") : ""
    });
    const first = sorted[0];
    const totalChange = ((latest.aum - first.aum) / first.aum) * 100;
    tiles.push({
      label: "Change over period", value: `${totalChange >= 0 ? "+" : ""}${totalChange.toFixed(1)}%`,
      delta: `${sorted[0].date.toLocaleDateString()} → ${latest.date.toLocaleDateString()}`, deltaClass: ""
    });
  }

  if (state.holdingsSnapshots.length) {
    const total = state.holdingsSnapshots.reduce((s, snap) => s + snap.total, 0);
    tiles.push({
      label: "Total AUM (Funds)", value: "R " + fmtCurrency(total),
      delta: `across ${state.holdingsSnapshots.length} fund${state.holdingsSnapshots.length > 1 ? "s" : ""}`, deltaClass: ""
    });
  }

  const { segments: activeSegments, label: activeLabel } = getActiveAllocationSegments();
  if (activeSegments.length) {
    const top = activeSegments[0];
    tiles.push({
      label: "Largest Allocation", value: top.category,
      delta: top.pct.toFixed(1) + "% · " + activeLabel, deltaClass: ""
    });
  }

  if (state.trades.length) {
    const buyTotal = state.trades.filter(t => t.type === "Buy").reduce((s, t) => s + (t.value || 0), 0);
    const sellTotal = state.trades.filter(t => t.type === "Sell").reduce((s, t) => s + (t.value || 0), 0);
    const net = buyTotal - sellTotal;
    tiles.push({
      label: "Trades Loaded", value: state.trades.length,
      delta: `R ${fmtCurrency(net)} net flow`, deltaClass: net >= 0 ? "up" : "down"
    });
  }

  if (!tiles.length) { row.style.display = "none"; return; }
  row.style.display = "grid";
  row.innerHTML = tiles.map(t => `
    <div class="kpi">
      <div class="label">${t.label}</div>
      <div class="value">${t.value}</div>
      ${t.delta ? `<div class="delta ${t.deltaClass}">${t.delta}</div>` : ""}
    </div>`).join("");
}

/* ---------- AUM section ---------- */
function renderAumSection() {
  const card = document.getElementById("aumCard");
  if (!state.aum.length) { card.style.display = "none"; return; }
  card.style.display = "block";
  const sorted = state.aum.slice().sort((a, b) => a.date - b.date);
  document.getElementById("aumSubtitle").textContent =
    `${sorted[0].date.toLocaleDateString()} – ${sorted[sorted.length - 1].date.toLocaleDateString()} · ${sorted.length} periods`;
  renderAumChart(state.aum);
}

/* ---------- Funds Under Management (fund holdings + saved history) ---------- */
document.getElementById("fundSelector").addEventListener("change", e => {
  selectedFund = e.target.value;
  renderFundsSection();
  renderAllocationSection();
});
document.getElementById("periodSelector").addEventListener("change", e => {
  selectedPeriod = e.target.value;
  renderFundsSection();
  renderAllocationSection();
});
document.getElementById("saveHistoryBtn").addEventListener("click", () => {
  if (!state.holdingsSnapshots.length) { showToast("Nothing loaded to save — upload Fund Holdings first."); return; }
  const saved = saveSnapshotsToHistory(state.holdingsSnapshots);
  if (!saved) { showToast("Couldn't save — check the loaded files have a valid as-of date."); return; }
  showToast(`Saved ${saved} fund${saved > 1 ? "s" : ""} to history`);
  renderFundsSection();
  renderHistorySummary();
});

function allKnownFunds() {
  return [...new Set([...state.holdingsSnapshots.map(s => s.fund), ...listAllFundsInHistory()])].sort();
}

function renderFundsSection() {
  const card = document.getElementById("fundsCard");
  const known = allKnownFunds();
  if (!known.length) { card.style.display = "none"; return; }
  card.style.display = "block";

  const fundSel = document.getElementById("fundSelector");
  fundSel.innerHTML = `<option value="all">All Funds (Consolidated)</option>` +
    known.map(f => `<option value="${f.replace(/"/g, "&quot;")}">${f}</option>`).join("");
  fundSel.value = known.includes(selectedFund) ? selectedFund : "all";
  selectedFund = fundSel.value;

  const periodSel = document.getElementById("periodSelector");
  const months = selectedFund === "all" ? listAllPeriodMonths() : listPeriodsForFund(selectedFund).map(s => s.period);
  if (!hasAutoSelectedPeriod) {
    hasAutoSelectedPeriod = true;
    if (!state.holdingsSnapshots.length && months.length) selectedPeriod = months[0];
  }
  periodSel.innerHTML = `<option value="current">Current Upload</option>` +
    months.map(m => `<option value="${m}">${monthLabelFromKey(m)}</option>`).join("");
  periodSel.value = months.includes(selectedPeriod) ? selectedPeriod : "current";
  selectedPeriod = periodSel.value;

  // table rows: live upload for "Current", else each fund's saved snapshot at-or-before the selected month
  let rows, total, asOfNote;
  if (selectedPeriod === "current") {
    rows = state.holdingsSnapshots.map(s => ({ fund: s.fund, total: s.total, asOf: s.asOf }));
    total = rows.reduce((s, r) => s + r.total, 0);
    const asOfDates = rows.map(r => r.asOf).filter(Boolean);
    asOfNote = asOfDates.length ? (new Set(asOfDates.map(d => d.toDateString())).size === 1 ? "as of " + asOfDates[0].toLocaleDateString() : "as-of dates vary across funds — check before presenting") : "";
  } else {
    const cons = getConsolidatedAtPeriod(selectedPeriod);
    rows = cons.funds.map(s => ({ fund: s.fund, total: s.total, asOf: s.asOf }));
    total = cons.total;
    asOfNote = `saved period: ${monthLabelFromKey(selectedPeriod)}`;
  }
  rows.sort((a, b) => b.total - a.total);

  document.getElementById("fundsSubtitle").textContent =
    rows.length ? `${selectedPeriod === "current" ? "Consolidated across" : "As saved for"} ${rows.length} fund${rows.length > 1 ? "s" : ""} — R ${fmtCurrency(total)} ${asOfNote}` : "No data for this selection";

  const tbody = document.querySelector("#fundsTable tbody");
  tbody.innerHTML = rows.map(s => `
    <tr>
      <td>${s.fund}</td>
      <td class="num">${fmtCurrency(s.total)}</td>
      <td class="num">${total ? (s.total / total * 100).toFixed(1) : "0.0"}%</td>
      <td>${s.asOf ? s.asOf.toLocaleDateString() : "—"}</td>
    </tr>`).join("");

  const trendPoints = computeFundTrendPoints();
  const trendWrap = document.getElementById("fundTrendWrap");
  if (trendPoints.length >= 2) {
    trendWrap.style.display = "block";
    renderFundTrendChart(trendPoints);
  } else {
    trendWrap.style.display = "none";
  }

  renderCompareSection();
}

function renderHistorySummary() {
  const el = document.getElementById("historySummary");
  const funds = listAllFundsInHistory();
  const months = listAllPeriodMonths();
  el.textContent = funds.length
    ? `${Object.keys(historyStore.periods).length} saved snapshot${Object.keys(historyStore.periods).length > 1 ? "s" : ""} · ${funds.length} fund${funds.length > 1 ? "s" : ""} · ${months.length} month${months.length > 1 ? "s" : ""} (${months.length ? monthLabelFromKey(months[months.length - 1]) + " – " + monthLabelFromKey(months[0]) : ""})`
    : "No history saved yet";
}

document.getElementById("exportHistoryBtn").addEventListener("click", () => {
  if (!Object.keys(historyStore.periods).length) { showToast("No saved history to export yet."); return; }
  exportHistoryToFile();
});
document.getElementById("importHistoryBtn").addEventListener("click", () => {
  document.getElementById("importHistoryFile").click();
});
document.getElementById("importHistoryFile").addEventListener("change", async e => {
  if (!e.target.files.length) return;
  try {
    const n = await importHistoryFromFile(e.target.files[0]);
    showToast(`Imported ${n} saved snapshot${n === 1 ? "" : "s"}`);
    renderHistorySummary();
    renderFundsSection();
  } catch (err) {
    console.error(err);
    showToast("Could not import that file: " + err.message);
  }
  e.target.value = "";
});

/* ---------- Compare Periods ---------- */
["compareFundSelector", "comparePeriodA", "comparePeriodB"].forEach(id => {
  document.getElementById(id).addEventListener("change", renderCompareSection);
});

/** Pure data computation for the current Compare Periods selection — used by both the on-screen
 *  render and the PPTX export, so the two never disagree. Returns null if not fully configured. */
function computeCompareData() {
  const fund = document.getElementById("compareFundSelector").value || "all";
  const periodA = document.getElementById("comparePeriodA").value;
  const periodB = document.getElementById("comparePeriodB").value;
  if (!periodA || !periodB || periodA === periodB) return null;

  const snapA = fund === "all" ? getConsolidatedAtPeriod(periodA) : getFundSnapshotAtOrBefore(fund, periodA);
  const snapB = fund === "all" ? getConsolidatedAtPeriod(periodB) : getFundSnapshotAtOrBefore(fund, periodB);
  if (!snapA || !snapB || !snapA.total || !snapB.total) return null;

  const labelA = monthLabelFromKey(periodA), labelB = monthLabelFromKey(periodB);
  const categories = [...new Set([...snapA.segments.map(s => s.category), ...snapB.segments.map(s => s.category)])];
  const valA = cat => (snapA.segments.find(s => s.category === cat) || {}).value || 0;
  const valB = cat => (snapB.segments.find(s => s.category === cat) || {}).value || 0;
  const rows = categories
    .map(cat => ({ category: cat, a: valA(cat), b: valB(cat), delta: valB(cat) - valA(cat) }))
    .sort((a, b) => Math.max(b.a, b.b) - Math.max(a.a, a.b));

  return { fund, labelA, labelB, totalA: snapA.total, totalB: snapB.total, totalChangePct: ((snapB.total - snapA.total) / snapA.total) * 100, rows };
}

function renderCompareSection() {
  const card = document.getElementById("compareCard");
  const funds = listAllFundsInHistory();
  if (!funds.length) { card.style.display = "none"; return; }
  card.style.display = "block";

  const fundSel = document.getElementById("compareFundSelector");
  const prevFund = fundSel.value || "all";
  fundSel.innerHTML = `<option value="all">All Funds (Consolidated)</option>` + funds.map(f => `<option value="${f.replace(/"/g, "&quot;")}">${f}</option>`).join("");
  fundSel.value = ["all", ...funds].includes(prevFund) ? prevFund : "all";
  const compareFund = fundSel.value;

  const months = compareFund === "all" ? listAllPeriodMonths() : listPeriodsForFund(compareFund).map(s => s.period);
  const selA = document.getElementById("comparePeriodA"), selB = document.getElementById("comparePeriodB");
  const prevA = selA.value, prevB = selB.value;
  const opts = `<option value="">— select —</option>` + months.map(m => `<option value="${m}">${monthLabelFromKey(m)}</option>`).join("");
  selA.innerHTML = opts; selB.innerHTML = opts;
  selA.value = months.includes(prevA) ? prevA : (months[1] || "");
  selB.value = months.includes(prevB) ? prevB : (months[0] || "");

  const empty = document.getElementById("compareEmpty"), body = document.getElementById("compareBody");
  const data = computeCompareData();
  if (!data) {
    empty.textContent = !selA.value || !selB.value
      ? `Pick two saved periods for ${compareFund === "all" ? "the consolidated total" : compareFund} to compare.`
      : selA.value === selB.value ? "Pick two different periods to compare." : "No comparable data for that selection.";
    empty.style.display = "block"; body.style.display = "none";
    return;
  }
  empty.style.display = "none"; body.style.display = "block";

  document.getElementById("compareColA").textContent = data.labelA;
  document.getElementById("compareColB").textContent = data.labelB;
  document.getElementById("compareKpiRow").innerHTML = `
    <div class="kpi"><div class="label">${data.labelA} AUM</div><div class="value">R ${fmtCurrency(data.totalA)}</div></div>
    <div class="kpi"><div class="label">${data.labelB} AUM</div><div class="value">R ${fmtCurrency(data.totalB)}</div></div>
    <div class="kpi"><div class="label">Change</div><div class="value">${(data.totalChangePct >= 0 ? "+" : "") + data.totalChangePct.toFixed(1)}%</div>
      <div class="delta ${data.totalChangePct >= 0 ? "up" : "down"}">R ${fmtCurrency(data.totalB - data.totalA)}</div></div>`;

  document.querySelector("#compareTable tbody").innerHTML = data.rows.map(r => `
    <tr>
      <td>${r.category}</td>
      <td class="num">${fmtCurrency(r.a)}</td>
      <td class="num">${fmtCurrency(r.b)}</td>
      <td class="num ${r.delta > 0 ? "delta-up" : r.delta < 0 ? "delta-down" : ""}">${r.delta > 0 ? "+" : ""}${fmtCurrency(r.delta)}</td>
    </tr>`).join("");
}

/* ---------- Allocation section ---------- */
function renderAllocationSection() {
  const card = document.getElementById("allocationCard");
  const { segments, label } = getActiveAllocationSegments();
  if (!segments.length) { card.style.display = "none"; return; }
  card.style.display = "block";
  document.getElementById("allocationSubtitle").textContent = `% of total fund value by asset class — ${label}`;
  const tbody = document.querySelector("#allocationTable tbody");
  tbody.innerHTML = segments.map((s, i) => `
    <tr>
      <td><span class="legend-swatch" style="display:inline-block;background:${colorForCategory(s.category, i)};margin-right:7px;"></span>${s.category}</td>
      <td class="num">${fmtCurrency(s.value)}</td>
      <td class="num">${s.pct.toFixed(1)}%</td>
    </tr>`).join("");
  renderAllocationChart(segments);
}

/* ---------- Trades section ---------- */
document.getElementById("tradeTypeSeg").addEventListener("click", e => {
  const btn = e.target.closest("button");
  if (!btn) return;
  document.querySelectorAll("#tradeTypeSeg button").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  tradeFilter.type = btn.dataset.val;
  renderTradesTable();
});
document.getElementById("tradeSearch").addEventListener("input", e => { tradeFilter.search = e.target.value.toLowerCase(); renderTradesTable(); });
document.getElementById("tradeFrom").addEventListener("change", e => { tradeFilter.from = e.target.value; renderTradesTable(); });
document.getElementById("tradeTo").addEventListener("change", e => { tradeFilter.to = e.target.value; renderTradesTable(); });
document.getElementById("tradeSourceFilter").addEventListener("change", e => { tradeFilter.source = e.target.value; renderTradesTable(); });

function renderTradeSourceFilterOptions() {
  const sel = document.getElementById("tradeSourceFilter");
  if (state.tradeSources.length < 2) { sel.style.display = "none"; tradeFilter.source = "all"; return; }
  sel.style.display = "";
  const current = tradeFilter.source;
  sel.innerHTML = `<option value="all">All sources</option>` +
    state.tradeSources.map(s => `<option value="${s.fileName.replace(/"/g, "&quot;")}">${s.fileName}</option>`).join("");
  sel.value = state.tradeSources.some(s => s.fileName === current) ? current : "all";
  tradeFilter.source = sel.value;
}

function getTradeColumns() {
  const cols = [{ key: "date", label: "Date" }, { key: "security", label: "Security" }, { key: "type", label: "Type" }];
  if (state.trades.some(t => t.quantity != null)) cols.push({ key: "quantity", label: "Quantity" });
  if (state.trades.some(t => t.price != null)) cols.push({ key: "price", label: "Price" });
  cols.push({ key: "value", label: "Value" });
  if (state.tradeSources.length > 1) cols.push({ key: "source", label: "Source" });
  return cols;
}

function renderTradesSection() {
  const card = document.getElementById("tradesCard");
  if (!state.trades.length) { card.style.display = "none"; return; }
  card.style.display = "block";
  document.getElementById("tradesSubtitle").textContent = state.tradeSources.length > 1
    ? `All buy and sell activity — merged from ${state.tradeSources.length} files`
    : "All buy and sell activity";

  renderTradeSourceFilterOptions();
  const thead = document.querySelector("#tradesTable thead");
  const cols = getTradeColumns();
  thead.innerHTML = "<tr>" + cols.map(c =>
    `<th data-key="${c.key}">${c.label}<span class="sort-ind">${tradeSort.key === c.key ? (tradeSort.dir === "asc" ? "▲" : "▼") : ""}</span></th>`
  ).join("") + "</tr>";
  thead.querySelectorAll("th").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (tradeSort.key === key) tradeSort.dir = tradeSort.dir === "asc" ? "desc" : "asc";
      else { tradeSort.key = key; tradeSort.dir = "desc"; }
      renderTradesTable();
    });
  });
  renderTradesTable();
}

function renderTradesTable() {
  if (!state.trades.length) return;
  const cols = getTradeColumns();
  let rows = state.trades.slice();

  if (tradeFilter.type !== "all") rows = rows.filter(t => t.type.toLowerCase() === tradeFilter.type);
  if (tradeFilter.search) rows = rows.filter(t => t.security.toLowerCase().includes(tradeFilter.search));
  if (tradeFilter.from) { const from = new Date(tradeFilter.from); rows = rows.filter(t => t.date >= from); }
  if (tradeFilter.to) { const to = new Date(tradeFilter.to); to.setHours(23, 59, 59, 999); rows = rows.filter(t => t.date <= to); }
  if (tradeFilter.source && tradeFilter.source !== "all") rows = rows.filter(t => t.source === tradeFilter.source);

  rows.sort((a, b) => {
    let av = a[tradeSort.key], bv = b[tradeSort.key];
    if (av instanceof Date) { av = av.getTime(); bv = bv.getTime(); }
    if (typeof av === "string") { av = av.toLowerCase(); bv = bv.toLowerCase(); }
    if (av < bv) return tradeSort.dir === "asc" ? -1 : 1;
    if (av > bv) return tradeSort.dir === "asc" ? 1 : -1;
    return 0;
  });

  document.getElementById("tradeCount").textContent = `${rows.length} of ${state.trades.length} trades`;

  const tbody = document.querySelector("#tradesTable tbody");
  tbody.innerHTML = rows.map(t => {
    return "<tr>" + cols.map(c => {
      if (c.key === "date") return `<td>${t.date ? t.date.toLocaleDateString() : ""}</td>`;
      if (c.key === "type") return `<td><span class="chip ${t.type.toLowerCase()}">${t.type}</span></td>`;
      if (c.key === "security") return `<td>${t.security}</td>`;
      if (c.key === "source") return `<td>${t.source || ""}</td>`;
      return `<td class="num">${t[c.key] != null ? fmtCurrency(t[c.key]) : ""}</td>`;
    }).join("") + "</tr>";
  }).join("");

  thead_sync_indicators();
}
function thead_sync_indicators() {
  document.querySelectorAll("#tradesTable thead th").forEach(th => {
    const ind = th.querySelector(".sort-ind");
    if (!ind) return;
    ind.textContent = tradeSort.key === th.dataset.key ? (tradeSort.dir === "asc" ? "▲" : "▼") : "";
  });
}

/* ---------- overall render ---------- */
function renderAll() {
  renderHistorySummary();
  renderKpis();
  renderAumSection();
  renderFundsSection();
  renderAllocationSection();
  renderTradesSection();
  const anyData = state.aum.length || state.allocation.length || state.trades.length || state.holdingsSnapshots.length || Object.keys(historyStore.periods).length;
  document.getElementById("emptyHint").style.display = anyData ? "none" : "block";
  document.getElementById("exportBtn").disabled = !anyData;
}

/* ---------- export ---------- */
document.getElementById("exportBtn").addEventListener("click", () => {
  document.getElementById("exportModal").style.display = "flex";
});
document.getElementById("exportCancel").addEventListener("click", () => {
  document.getElementById("exportModal").style.display = "none";
});
document.getElementById("exportConfirm").addEventListener("click", async () => {
  const btn = document.getElementById("exportConfirm");
  const title = document.getElementById("exportTitle").value.trim() || "Aylett & Co";
  const subtitle = document.getElementById("exportSubtitle").value.trim();
  btn.disabled = true; btn.textContent = "Building…";
  try {
    const trendPoints = computeFundTrendPoints();
    const trendLabel = selectedFund === "all" ? "All Funds (Consolidated)" : selectedFund;
    const compare = computeCompareData();
    await exportPptx(state, title, subtitle, { trendPoints, trendLabel, compare });
    document.getElementById("exportModal").style.display = "none";
    showToast("PowerPoint downloaded");
  } catch (err) {
    console.error(err);
    showToast("Export failed: " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = "Download .pptx";
  }
});

renderAll();
