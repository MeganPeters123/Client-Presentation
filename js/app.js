/* UI wiring: uploads, column-mapping modal, rendering, filters, theme, export. */
"use strict";

const state = { aum: [], allocation: [], trades: [] };
let pendingUpload = null; // { kind, headers, rows }
let tradeFilter = { type: "all", search: "", from: "", to: "" };
let tradeSort = { key: "date", dir: "desc" };

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
["aum", "allocation", "trades"].forEach(kind => {
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
  try {
    const { headers, rows } = await parseFile(file);
    pendingUpload = { kind, headers, rows, fileName: file.name };
    openMappingModal(kind, headers);
  } catch (err) {
    console.error(err);
    showToast("Could not read that file: " + err.message);
  }
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
  document.getElementById("mapModal").style.display = "flex";
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

  const records = applyMapping(kind, rows, mapping);
  if (!records.length) {
    showToast("None of the rows could be read with that mapping — check the file and try again.");
    return;
  }
  state[kind] = records;
  document.getElementById("mapModal").style.display = "none";

  const slot = document.getElementById("slot-" + kind);
  slot.classList.add("loaded");
  document.getElementById("status-" + kind).textContent = `${records.length} rows loaded`;

  showToast(`${KIND_LABEL[kind]} loaded — ${records.length} rows`);
  pendingUpload = null;
  renderAll();
});

/* ---------- allocation helpers ---------- */
function computeAllocationSegments(records) {
  const total = records.reduce((s, r) => s + (r.value || 0), 0);
  return records
    .map(r => ({ category: r.category, value: r.value, pct: total ? (r.value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
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

  if (state.allocation.length) {
    const segments = computeAllocationSegments(state.allocation);
    const top = segments[0];
    tiles.push({
      label: "Largest Allocation", value: top.category,
      delta: top.pct.toFixed(1) + "% of fund", deltaClass: ""
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

/* ---------- Allocation section ---------- */
function renderAllocationSection() {
  const card = document.getElementById("allocationCard");
  if (!state.allocation.length) { card.style.display = "none"; return; }
  card.style.display = "block";
  const segments = computeAllocationSegments(state.allocation);
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

function getTradeColumns() {
  const cols = [{ key: "date", label: "Date" }, { key: "security", label: "Security" }, { key: "type", label: "Type" }];
  if (state.trades.some(t => t.quantity != null)) cols.push({ key: "quantity", label: "Quantity" });
  if (state.trades.some(t => t.price != null)) cols.push({ key: "price", label: "Price" });
  cols.push({ key: "value", label: "Value" });
  return cols;
}

function renderTradesSection() {
  const card = document.getElementById("tradesCard");
  if (!state.trades.length) { card.style.display = "none"; return; }
  card.style.display = "block";

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
  renderKpis();
  renderAumSection();
  renderAllocationSection();
  renderTradesSection();
  const anyData = state.aum.length || state.allocation.length || state.trades.length;
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
    await exportPptx(state, title, subtitle);
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
