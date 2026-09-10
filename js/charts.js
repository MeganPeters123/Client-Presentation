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

function destroyCharts() {
  if (aumChartInstance) { aumChartInstance.destroy(); aumChartInstance = null; }
  if (allocationChartInstance) { allocationChartInstance.destroy(); allocationChartInstance = null; }
  if (fundTrendChartInstance) { fundTrendChartInstance.destroy(); fundTrendChartInstance = null; }
}
