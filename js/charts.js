/* Chart.js rendering for the AUM trend and asset allocation cards. */
"use strict";

const ASSET_SEGMENT_COLORS = {
  "jselistedequity": "#14315C", "globallistedequity": "#A9A9A9",
  "sacash": "#8FAADC", "globalcash": "#F2B84B",
  "safixedincome": "#1C8299", "globalfixedincome": "#6FC2D6",
  "saproperty": "#C6AEEA", "globalproperty": "#E7B8E0"
};
const PALETTE = ["#2a78d6", "#008300", "#e87ba4", "#eda100", "#1baf7a", "#eb6834", "#4a3aa7", "#e34948"];

function colorForCategory(label, idx) {
  const key = normalizeHeader(label);
  return ASSET_SEGMENT_COLORS[key] || PALETTE[idx % PALETTE.length];
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fmtCurrency(n) {
  if (n == null || isNaN(n)) return "";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "bn";
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "m";
  if (abs >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return Math.round(n).toLocaleString();
}

let aumChartInstance = null;
let allocationChartInstance = null;

function renderAumChart(records) {
  const sorted = records.slice().sort((a, b) => a.date - b.date);
  const labels = sorted.map(r => r.date.toLocaleDateString(undefined, { year: "numeric", month: "short" }));
  const values = sorted.map(r => r.aum);
  const ctx = document.getElementById("aumChart").getContext("2d");
  if (aumChartInstance) aumChartInstance.destroy();
  const ink2 = cssVar("--ink-2"), grid = cssVar("--grid"), accent = cssVar("--accent"), accentWash = cssVar("--accent-wash");
  aumChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "AUM",
        data: values,
        borderColor: accent,
        backgroundColor: accentWash,
        fill: true,
        tension: 0.25,
        pointRadius: 2,
        pointHoverRadius: 5,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => "R " + Math.round(c.parsed.y).toLocaleString() } }
      },
      scales: {
        x: { ticks: { color: ink2, maxRotation: 0, autoSkip: true }, grid: { color: "transparent" } },
        y: { ticks: { color: ink2, callback: v => fmtCurrency(v) }, grid: { color: grid } }
      }
    }
  });
}

function renderAllocationChart(segments) {
  const ctx = document.getElementById("allocationChart").getContext("2d");
  if (allocationChartInstance) allocationChartInstance.destroy();
  const colors = segments.map((s, i) => colorForCategory(s.category, i));
  allocationChartInstance = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: segments.map(s => s.category),
      datasets: [{ data: segments.map(s => s.value), backgroundColor: colors, borderWidth: 0 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "62%",
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${c.label}: ${c.parsed.toFixed(1)}%` } }
      }
    }
  });
}

let fundTrendChartInstance = null;

/** points: [{ label, value }] sorted oldest -> newest */
function renderFundTrendChart(points) {
  const ctx = document.getElementById("fundTrendChart").getContext("2d");
  if (fundTrendChartInstance) fundTrendChartInstance.destroy();
  const ink2 = cssVar("--ink-2"), grid = cssVar("--grid"), accent = cssVar("--accent"), accentWash = cssVar("--accent-wash");
  fundTrendChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: points.map(p => p.label),
      datasets: [{
        label: "AUM", data: points.map(p => p.value),
        borderColor: accent, backgroundColor: accentWash, fill: true, tension: 0.25,
        pointRadius: 3, pointHoverRadius: 5, borderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => "R " + Math.round(c.parsed.y).toLocaleString() } } },
      scales: {
        x: { ticks: { color: ink2 }, grid: { color: "transparent" } },
        y: { ticks: { color: ink2, callback: v => fmtCurrency(v) }, grid: { color: grid } }
      }
    }
  });
}

const TRADE_SERIES_COLORS = {
  "Equity|Buy": "#2a78d6",
  "Equity|Sell": "#8FAADC",
  "Bond|Buy": "#1C8299",
  "Bond|Sell": "#6FC2D6",
  "Equity|Corporate Action": "#eda100",
  "Cash|Buy": "#898781",
  "Cash|Sell": "#c3c2b7",
  "Money Market|Buy": "#4a3aa7",
  "Money Market|Sell": "#9085e9"
};

let tradeActivityChartInstance = null;

/** activity: [{ label, byClass }] oldest first; series: [{ assetClass, action }].
 *  Sells are drawn below the axis so a month reads as net flow at a glance. */
function renderTradeActivityChart(activity, series) {
  const ctx = document.getElementById("tradeActivityChart").getContext("2d");
  if (tradeActivityChartInstance) tradeActivityChartInstance.destroy();
  const ink2 = cssVar("--ink-2"), grid = cssVar("--grid");

  const datasets = series.map(({ assetClass, action }, i) => {
    const key = `${assetClass}|${action}`;
    const sign = action === "Sell" ? -1 : 1;
    return {
      label: `${assetClass} ${action}`,
      data: activity.map(a => sign * (((a.byClass[assetClass] || {})[action] || {}).value || 0)),
      backgroundColor: TRADE_SERIES_COLORS[key] || PALETTE[i % PALETTE.length],
      borderWidth: 0
    };
  });

  tradeActivityChartInstance = new Chart(ctx, {
    type: "bar",
    data: { labels: activity.map(a => a.label), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: ink2, boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: c => `${c.dataset.label}: R ${Math.abs(c.parsed.y).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
          }
        }
      },
      scales: {
        x: { ticks: { color: ink2, maxRotation: 0, autoSkip: true }, grid: { color: "transparent" }, stacked: false },
        y: {
          ticks: { color: ink2, callback: v => fmtCurrency(Math.abs(v)) },
          grid: { color: grid }
        }
      }
    }
  });
}

/* SA-linked buckets in greens, offshore in blues, so the split reads before the legend does. */
const LOOKTHROUGH_COLORS = {
  // one green family for the SA block: the listed SA bar splits into SA Inc plus Quasi-Offshore,
  // so keeping the hue and changing only the shade shows where that block went
  "SA Equity": "#00560a",
  "SA Inc": "#008300",
  "Quasi-Offshore": "#7cc351",
  "Offshore Equity": "#2a78d6",
  "SA Cash": "#eda100",
  "Offshore Cash": "#8FAADC",
  "SA Fixed Income": "#eb6834",
  "Offshore Fixed Income": "#4a3aa7"
};

let lookThroughChartInstance = null;

/** Two stacked bars — listed vs looked-through — so the reallocation is the story.
 *  bars: [{ label, buckets }]; order: the stacking order across both bars. */
function renderLookThroughChart(bars, order) {
  const ctx = document.getElementById("lookThroughChart").getContext("2d");
  if (lookThroughChartInstance) lookThroughChartInstance.destroy();
  const ink2 = cssVar("--ink-2"), grid = cssVar("--grid");

  const datasets = order.map((key, i) => ({
    label: key,
    data: bars.map(b => b.buckets[key] || 0),
    backgroundColor: LOOKTHROUGH_COLORS[key] || PALETTE[i % PALETTE.length],
    borderWidth: 0
  })).filter(d => d.data.some(v => v > 0.005));

  lookThroughChartInstance = new Chart(ctx, {
    type: "bar",
    data: { labels: bars.map(b => b.label), datasets },
    options: {
      indexAxis: "y",
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: ink2, boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.x.toFixed(1)}%` } }
      },
      scales: {
        x: { stacked: true, max: 100, ticks: { color: ink2, callback: v => v + "%" }, grid: { color: grid } },
        y: { stacked: true, ticks: { color: ink2, font: { size: 12 } }, grid: { color: "transparent" } }
      }
    }
  });
}

/* Rand exposure is the number Megan's audience looks for first, so ZAR keeps the SA green
   wherever it appears; everything else takes the standard palette in weight order. */
const CURRENCY_COLORS = { ZAR: "#008300", USD: "#2a78d6", GBP: "#4a3aa7", EUR: "#eda100", HKD: "#eb6834" };
const BREAKDOWN_MUTED = { "Not classified": "#c3c2b7", "Cash & Fixed Income": "#898781", Unknown: "#c3c2b7" };

let breakdownChartInstance = null;

/** rows: [{ key, weight }] as percentages, already sorted. */
function renderBreakdownChart(rows, by) {
  const ctx = document.getElementById("breakdownChart").getContext("2d");
  if (breakdownChartInstance) breakdownChartInstance.destroy();
  const ink2 = cssVar("--ink-2");

  breakdownChartInstance = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: rows.map(r => r.key),
      datasets: [{
        data: rows.map(r => r.weight),
        backgroundColor: rows.map((r, i) =>
          BREAKDOWN_MUTED[r.key] || (by === "ccy" ? CURRENCY_COLORS[r.key] : null) ||
          LOOKTHROUGH_COLORS[r.key] || PALETTE[i % PALETTE.length]),
        borderWidth: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "58%",
      plugins: {
        legend: { position: "right", labels: { color: ink2, boxWidth: 11, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.label}: ${c.parsed.toFixed(1)}%` } }
      }
    }
  });
}

let activeShareChartInstance = null;

/** points: [{ month, value, dateMatch }] oldest first. A month whose portfolio and index
 *  were struck on different days is drawn hollow, so a caveat cannot hide inside a line. */
function renderActiveShareChart(points) {
  const ctx = document.getElementById("activeShareChart").getContext("2d");
  if (activeShareChartInstance) activeShareChartInstance.destroy();
  const ink2 = cssVar("--ink-2"), grid = cssVar("--grid"), accent = cssVar("--accent");
  const surface = cssVar("--surface");

  activeShareChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: points.map(p => monthLabelFromKey(p.month)),
      datasets: [{
        label: "Active share",
        data: points.map(p => p.value),
        borderColor: accent,
        backgroundColor: accent,
        pointBackgroundColor: points.map(p => (p.dateMatch ? accent : surface)),
        pointBorderColor: points.map(p => (p.dateMatch ? accent : cssVar("--bad"))),
        pointBorderWidth: points.map(p => (p.dateMatch ? 1 : 2)),
        pointRadius: 4,
        tension: 0.25,
        fill: false
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => {
              const p = points[c.dataIndex];
              return `${c.parsed.y.toFixed(1)}%` + (p.dateMatch ? "" : "  (dates differ)");
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: ink2, maxRotation: 0, autoSkip: true }, grid: { color: "transparent" } },
        y: { ticks: { color: ink2, callback: v => v + "%" }, grid: { color: grid } }
      }
    }
  });
}

function destroyCharts() {
  if (aumChartInstance) { aumChartInstance.destroy(); aumChartInstance = null; }
  if (allocationChartInstance) { allocationChartInstance.destroy(); allocationChartInstance = null; }
  if (fundTrendChartInstance) { fundTrendChartInstance.destroy(); fundTrendChartInstance = null; }
  if (tradeActivityChartInstance) { tradeActivityChartInstance.destroy(); tradeActivityChartInstance = null; }
  if (lookThroughChartInstance) { lookThroughChartInstance.destroy(); lookThroughChartInstance = null; }
  if (breakdownChartInstance) { breakdownChartInstance.destroy(); breakdownChartInstance = null; }
  if (activeShareChartInstance) { activeShareChartInstance.destroy(); activeShareChartInstance = null; }
}
