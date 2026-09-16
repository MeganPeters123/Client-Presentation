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

function destroyCharts() {
  if (aumChartInstance) { aumChartInstance.destroy(); aumChartInstance = null; }
  if (allocationChartInstance) { allocationChartInstance.destroy(); allocationChartInstance = null; }
  if (fundTrendChartInstance) { fundTrendChartInstance.destroy(); fundTrendChartInstance = null; }
  if (tradeActivityChartInstance) { tradeActivityChartInstance.destroy(); tradeActivityChartInstance = null; }
}
