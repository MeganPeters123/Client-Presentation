/* Chart.js rendering for the AUM trend and asset allocation cards. */
"use strict";

/* One colour language across every card: SA-linked exposure in greens, offshore in blues,
 * cash in amber, fixed income in orange, property in purple. The allocation donut used to
 * run on a separate navy/grey palette, so "JSE-listed Equity" there and "SA Equity" on the
 * look-through bar — the same money — came out two unrelated colours on the same page. */
const ASSET_SEGMENT_COLORS = {
  "jselistedequity": "#00560a", "globallistedequity": "#2a78d6",
  "sacash": "#eda100", "globalcash": "#8FAADC",
  "safixedincome": "#eb6834", "globalfixedincome": "#4a3aa7",
  "saproperty": "#7cc351", "globalproperty": "#9085e9"
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
/* Green for the SA block, blue for global, amber for cash, orange for fixed income — the same
   language the allocation donut and the look-through bars both speak. The Quasi-Offshore and
   Offshore Equity keys are kept because the engine still computes them; the charts fold both
   into Global Equity, so they carry its colour. */
/* Aylett's own presentation palette, sampled from the deck's allocation chart rather than
 * matched by eye: navy SA equity, grey global equity, steel-blue SA cash, teal SA fixed
 * income, amber global cash, lilac SA property.
 *
 * The deck shows six. The four here it does not are the look-through counterparts and the
 * global halves of property and fixed income, so each takes its SA partner's slot or a
 * clear step of the same hue: SA Inc is the SA equity navy and Global Equity the global
 * grey, because the colour marks the block and the two bars show how it redistributes.
 *
 * These are house colours, so they are used as given. Two pairs sit closer than the chart
 * standard wants - grey global equity against steel-blue SA cash (deltaE 6.4) and lilac
 * property against the same cash (9.2). In the deck the navy block separates them; here the
 * stacking order puts them together. Every segment is directly labelled and the table
 * repeats the figures, and the stacked bars carry a 2px surface gap between segments, so
 * identity never rests on the colour alone. */
const LOOKTHROUGH_COLORS = {
  "JSE-listed Equity": "#1b3864",
  "SA Equity": "#1b3864",
  "SA Inc": "#1b3864",
  "Global Equity": "#b6b6b8",
  "Global-listed Equity": "#b6b6b8",
  "Quasi-Offshore": "#b6b6b8",
  "Offshore Equity": "#b6b6b8",
  "JSE-listed Property": "#c9b7ec",
  "SA Property": "#c9b7ec",
  "Global-listed Property": "#8e74c4",
  "Offshore Property": "#8e74c4",
  "SA Cash": "#92aecd",
  "Global Cash": "#ffc469",
  "Offshore Cash": "#ffc469",
  "SA Fixed Income": "#177fa6",
  "Global Fixed Income": "#7cc4dc",
  "Offshore Fixed Income": "#7cc4dc"
};

let lookThroughChartInstance = null;

/** Two stacked bars — listed vs looked-through — so the reallocation is the story.
 *  bars: [{ label, buckets }]; order: the stacking order across both bars. */
/** Figures on the segments of a stacked bar.
 *
 *  Unlike a pie there is nowhere outside a segment to put a label, so each one takes what
 *  it has room for: the category and the figure where both fit, the figure alone where only
 *  that does, and nothing where even that would spill into its neighbour. The legend stays
 *  for exactly that reason — a 3% segment can carry a number but never a name. */
const barSegmentLabels = {
  id: "barSegmentLabels",
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = opts.font || "600 10.5px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      meta.data.forEach((el, i) => {
        const value = ds.data[i] || 0;
        if (value <= 0.05) return;
        // upright bars: the segment runs from base up to y, and its width is the bar's
        const { x, base, y, width } = el.getProps(["x", "base", "y", "width"], true);
        if (Math.abs(base - y) < 14) return;
        const full = `${ds.label} ${value.toFixed(1)}%`;
        const figure = `${value.toFixed(1)}%`;
        const text = ctx.measureText(full).width + 12 <= width ? full
                   : (ctx.measureText(figure).width + 8 <= width ? figure : null);
        if (!text) return;
        ctx.fillStyle = onDark(ds.backgroundColor) ? "#ffffff" : "#1f1e1b";
        ctx.fillText(text, x, (y + base) / 2);
      });
    });
    ctx.restore();
  }
};

function renderLookThroughChart(bars, order) {
  const ctx = document.getElementById("lookThroughChart").getContext("2d");
  if (lookThroughChartInstance) lookThroughChartInstance.destroy();
  const ink2 = cssVar("--ink-2"), grid = cssVar("--grid");

  const datasets = order.map((key, i) => ({
    label: key,
    data: bars.map(b => b.buckets[key] || 0),
    backgroundColor: LOOKTHROUGH_COLORS[key] || PALETTE[i % PALETTE.length],
    // the gap is what keeps two close house colours apart where they touch
    borderColor: cssVar("--surface"),
    borderWidth: { top: 2, bottom: 2, left: 0, right: 0 },
    borderSkipped: false
  })).filter(d => d.data.some(v => v > 0.005));

  lookThroughChartInstance = new Chart(ctx, {
    type: "bar",
    data: { labels: bars.map(b => b.label), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      // two columns side by side, as on the client slide — wide enough to carry their labels
      datasets: { bar: { maxBarThickness: 170, categoryPercentage: 0.7, barPercentage: 0.9 } },
      plugins: {
        legend: { position: "right", labels: { color: ink2, boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` } },
        barSegmentLabels: {}
      },
      scales: {
        x: { stacked: true, ticks: { color: ink2, font: { size: 12 } }, grid: { color: "transparent" } },
        y: { stacked: true, max: 100, ticks: { color: ink2, callback: v => v + "%" }, grid: { color: grid } }
      }
    },
    plugins: [barSegmentLabels]
  });
}

/* Rand exposure is the number Megan's audience looks for first, so ZAR keeps the SA green
   wherever it appears; everything else takes the standard palette in weight order. */
/* The exposure pies in the same house colours as the allocation charts, so rand reads as
 * the same navy on both tabs and the two views speak one language.
 *
 * Assigned in a fixed order by hue family rather than by size, so a currency keeps its
 * colour as the book changes - a filter that drops a currency must not repaint the rest. */
const CURRENCY_COLORS = {
  ZAR: "#1b3864",   // the house navy, as SA equity on the allocation tab
  GBP: "#177fa6",   // teal
  EUR: "#c9b7ec",   // lilac
  USD: "#92aecd",   // steel blue
  HKD: "#ffc469",   // amber
  MXN: "#8e74c4",   // deep lilac
  SGD: "#7cc4dc",   // light teal
  JPY: "#ad721c",   // deep amber
  CHF: "#b6b6b8"    // grey
};

/* Sectors and any currency beyond the list above. Built from the house hue families -
 * blue, purple, amber, grey - at steps far enough apart to stay separable, rather than
 * reusing the deck's six fills, which sit too close to one another to carry eight slices.
 *
 * A donut sorts by size, so any two slices can end up neighbours. No eight-colour set
 * passes that test; this one's worst pair is 8.7, against 7.1 for the brighter palette it
 * replaces, so it reads slightly better as well as matching the deck. The 2px gap between
 * slices and the table beside the chart are what carry identity where colour alone cannot. */
const HOUSE_PALETTE = ["#143b76", "#19799d", "#85afdc", "#644395",
                       "#c6b1f0", "#ad721c", "#f4c677", "#b7b7b9"];
const BREAKDOWN_MUTED = { "Not classified": "#c3c2b7", "Cash & Fixed Income": "#898781", Unknown: "#c3c2b7",
                          Cash: "#898781", "Fixed Income": "#b4b1a6", "Not itemised in the export": "#dedbd2" };

let breakdownChartInstance = null;
let breakdownSplitInstance = null;

/** Slice labels for a donut with only a handful of slices.
 *
 *  Chart.js draws no labels of its own and the datalabels plugin is a dependency this page
 *  does not otherwise need, so this is the small amount of it that is actually wanted: the
 *  name and the percentage on the slice where there is room, and outside on a leader line
 *  where there is not — which is how the Excel chart this copies handles a thin slice.
 *
 *  Measured rather than assumed: a label goes inside only if the text fits within the arc's
 *  own width at that radius, so a long name on a narrow slice steps out instead of spilling
 *  over its neighbours. */
/** Whether white text reads better than black on this fill. Relative luminance, so a mid
 *  green and a mid amber are judged on what the eye does with them rather than on hue. */
function onDark(colour) {
  const m = String(colour || "").trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
  return L < 0.42;
}

const donutSliceLabels = {
  id: "donutSliceLabels",
  afterDatasetsDraw(chart, _args, opts) {
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data || !meta.data.length) return;
    const { ctx } = chart;
    const data = chart.data.datasets[0].data;
    // The slices of a secondary pie are a share of the whole, not of themselves: the
    // currency donut holds only the equity, so left to sum its own data it called GBP 39.1%
    // of the equity where the table beside it says 35.3% of the fund.
    const total = opts.total || data.reduce((s, v) => s + (v || 0), 0);
    if (!total) return;
    const ink = opts.color || "#2b2a26";

    ctx.save();
    ctx.font = opts.font || "600 11px system-ui, sans-serif";
    ctx.textBaseline = "middle";

    // outside labels are placed in order down each side, so two thin neighbours do not
    // print on top of each other — MXN and SGD sit next to each other on the currency pie
    const taken = { left: [], right: [] };
    const clear = (side, y, away) => {
      // nudged away from the donut rather than always downwards — a label above the chart
      // pushed down walks onto the ring it is pointing at, which is what HKD, SGD and MXN
      // did to the currency pie
      let out = y;
      for (let n = 0; n < 40; n++) {
        if (!taken[side].some(v => Math.abs(v - out) < 13)) break;
        out += away * 13;
      }
      taken[side].push(out);
      return out;
    };

    meta.data.forEach((arc, i) => {
      const value = data[i] || 0;
      const pct = (value / total) * 100;
      if (pct < 1.5) return;                       // too thin to point at usefully
      const label = chart.data.labels[i];
      const text = `${label} ${pct.toFixed(1)}%`;
      const mid = (arc.startAngle + arc.endAngle) / 2;
      const cos = Math.cos(mid), sin = Math.sin(mid);
      const rOut = arc.outerRadius;

      // Every label sits outside on a leader, none on the ring. A slice wide enough to hold
      // its text still only just holds it, and the ones that did looked wedged in — GBP ran
      // off the edge of its own slice. Outside they all read the same way and the colour
      // under them stops mattering.
      const width = ctx.measureText(text).width;
      const cx = arc.x, cy = arc.y;
      const right = cos >= 0;
      const x1 = cx + cos * (rOut + 2), y1 = cy + sin * (rOut + 2);
      const x2 = cx + cos * (rOut + 10), y2raw = cy + sin * (rOut + 10);
      const y2 = clear(right ? "right" : "left", y2raw, sin < 0 ? -1 : 1);
      const x3 = x2 + (right ? 8 : -8);
      const edge = right ? chart.width - 2 : 2;
      // nothing is drawn where it would leave the canvas — the nudge that clears a
      // neighbour can otherwise walk a label straight off the top
      if (right ? x3 + width + 3 > edge : x3 - width - 3 < edge) return;
      if (y2 < 8 || y2 > chart.height - 8) return;
      ctx.strokeStyle = opts.leader || "#b4b1a6";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y2); ctx.stroke();
      ctx.fillStyle = ink;
      ctx.textAlign = right ? "left" : "right";
      ctx.fillText(text, x3 + (right ? 3 : -3), y2);
    });
    ctx.restore();
  }
};

/** The small donut of a pie of a pie: cash against everything else, with the equity slice
 *  deliberately plain because the chart beside it is what breaks that slice open. Hidden
 *  when there is no cash to separate, so the layout does not keep a seat for nothing. */
function renderBreakdownSplit(lead, equity, enabled) {
  const wrap = document.getElementById("breakdownSplitWrap");
  const link = document.getElementById("breakdownSplitLink");
  const show = enabled && (lead || []).length > 0 && equity > 0.005;
  wrap.style.display = show ? "" : "none";
  link.style.display = show ? "" : "none";
  if (breakdownSplitInstance) { breakdownSplitInstance.destroy(); breakdownSplitInstance = null; }
  if (!show) return;

  const SHADE = { Cash: "#898781", "Fixed Income": "#b4b1a6", "Not itemised in the export": "#dedbd2" };
  // Short labels on the chart; the table beside it carries the full wording.
  const SHORT = { "Not itemised in the export": "Not itemised" };
  breakdownSplitInstance = new Chart(document.getElementById("breakdownSplitChart").getContext("2d"), {
    type: "doughnut",
    data: {
      labels: [...lead.map(r => SHORT[r.key] || r.key), "Equity"],
      datasets: [{
        data: [...lead.map(r => r.weight), equity],
        backgroundColor: [...lead.map(r => SHADE[r.key] || "#b4b1a6"), "#cfcdc4"],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "45%", radius: "58%",
      // room for the labels that step outside a thin slice, as a share of the width rather
      // than a fixed figure — 62px either side of a 154px canvas left a 30px chart
      layout: { padding: { top: 12, bottom: 12, left: 0, right: 0 } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${c.label}: ${c.parsed.toFixed(1)}%` } },
        donutSliceLabels: { color: cssVar("--ink"), leader: cssVar("--border") }
      }
    },
    plugins: [donutSliceLabels]
  });
}

/** rows: [{ key, weight }] as percentages, already sorted. */
function renderBreakdownChart(rows, by, labelTotal) {
  const ctx = document.getElementById("breakdownChart").getContext("2d");
  if (breakdownChartInstance) breakdownChartInstance.destroy();

  breakdownChartInstance = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: rows.map(r => r.key),
      datasets: [{
        data: rows.map(r => r.weight),
        backgroundColor: rows.map((r, i) =>
          BREAKDOWN_MUTED[r.key] || (by === "ccy" ? CURRENCY_COLORS[r.key] : null) ||
          LOOKTHROUGH_COLORS[r.key] || HOUSE_PALETTE[i % HOUSE_PALETTE.length]),
        borderWidth: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "58%", radius: "60%",
      layout: { padding: { top: 12, bottom: 12 } },
      plugins: {
        // the slices carry their own names now, and the table beside the chart lists every
        // one of them with the same swatch — a legend as well was the third telling
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${c.label}: ${c.parsed.toFixed(1)}%` } },
        donutSliceLabels: { color: cssVar("--ink"), leader: cssVar("--border"), total: labelTotal }
      }
    },
    plugins: [donutSliceLabels]
  });
}

let activeShareChartInstance = null;

/** points: [{ month, value }] oldest first. */
function renderActiveShareChart(points) {
  const ctx = document.getElementById("activeShareChart").getContext("2d");
  if (activeShareChartInstance) activeShareChartInstance.destroy();
  const ink2 = cssVar("--ink-2"), grid = cssVar("--grid"), accent = cssVar("--accent");

  activeShareChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: points.map(p => monthLabelFromKey(p.month)),
      datasets: [{
        label: "Active share",
        data: points.map(p => p.value),
        borderColor: accent,
        backgroundColor: accent,
        pointRadius: 4,
        tension: 0.25,
        fill: false
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${c.parsed.y.toFixed(1)}%` } }
      },
      scales: {
        x: { ticks: { color: ink2, maxRotation: 0, autoSkip: true }, grid: { color: "transparent" } },
        y: { ticks: { color: ink2, callback: v => v + "%" }, grid: { color: grid } }
      }
    }
  });
}

const pieInstances = {};

/** One donut, plus a legend carrying the numbers — a pie without values on a client slide
 *  makes people guess. rows: [{ key, weight }] as percentages, already ordered.
 *  Slices under half a percent are grouped, or the legend becomes a wall of slivers. */
function renderPie(canvasId, legendId, rows, colorFor, { minSlice = 0.5 } = {}) {
  const canvas = document.getElementById(canvasId);
  const legend = document.getElementById(legendId);
  if (!canvas) return;
  if (pieInstances[canvasId]) pieInstances[canvasId].destroy();

  const big = rows.filter(r => r.weight >= minSlice);
  const small = rows.filter(r => r.weight < minSlice && r.weight > 0);
  const shown = small.length > 1
    ? [...big, { key: `Other (${small.length})`, weight: small.reduce((s, r) => s + r.weight, 0) }]
    : rows.filter(r => r.weight > 0);
  const colors = shown.map((r, i) => (r.key.startsWith("Other (") ? cssVar("--ink-muted") : colorFor(r.key, i)));

  pieInstances[canvasId] = new Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: { labels: shown.map(r => r.key),
            // a surface-coloured gap between slices, so two close colours meeting on the
            // ring still read as two slices
            datasets: [{ data: shown.map(r => r.weight), backgroundColor: colors,
                         borderColor: cssVar("--surface"), borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "56%",
      plugins: {
        legend: { display: false },          // the list below carries the values instead
        tooltip: { callbacks: { label: c => `${c.label}: ${c.parsed.toFixed(1)}%` } }
      }
    }
  });

  if (legend) {
    legend.innerHTML = shown.map((r, i) => `
      <div class="legend-item">
        <span class="legend-swatch" style="background:${colors[i]}"></span>
        <span class="name">${r.key}</span>
        <span class="legend-val">${r.weight.toFixed(1)}%</span>
      </div>`).join("");
  }
}

function destroyCharts() {
  if (aumChartInstance) { aumChartInstance.destroy(); aumChartInstance = null; }
  if (allocationChartInstance) { allocationChartInstance.destroy(); allocationChartInstance = null; }
  if (fundTrendChartInstance) { fundTrendChartInstance.destroy(); fundTrendChartInstance = null; }
  if (tradeActivityChartInstance) { tradeActivityChartInstance.destroy(); tradeActivityChartInstance = null; }
  if (lookThroughChartInstance) { lookThroughChartInstance.destroy(); lookThroughChartInstance = null; }
  if (breakdownChartInstance) { breakdownChartInstance.destroy(); breakdownChartInstance = null; }
  if (activeShareChartInstance) { activeShareChartInstance.destroy(); activeShareChartInstance = null; }
  Object.keys(pieInstances).forEach(k => { pieInstances[k].destroy(); delete pieInstances[k]; });
}

let topTradesChartInstance = null;

/** Buys and sells on one axis.
 *
 *  Both sides are drawn from the same rows the tables use, sells carried negative so the
 *  bars run either side of zero. Reading two tables means holding one column in your head
 *  while you scan the other; a diverging bar puts the comparison in front of you — the
 *  share bought most and the share sold most are the two ends of the same line.
 *
 *  Values stay in the fund's own currency. Nothing here converts anything. */
function renderTopTradesChart(buys, sells, ccy, netMode) {
  const wrap = document.getElementById("topTradesChartWrap");
  const ctx = document.getElementById("topTradesChart");
  if (!ctx) return;
  if (topTradesChartInstance) { topTradesChartInstance.destroy(); topTradesChartInstance = null; }

  // sells arrive positive in gross mode and already negative in net mode
  const rows = [
    ...buys.map(r => ({ name: r.security, value: Math.abs(r.value) })),
    ...sells.map(r => ({ name: r.security, value: -Math.abs(r.value) }))
  ].sort((a, b) => b.value - a.value);

  if (!rows.length) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";
  // a row needs room to be read; the wrapper grows rather than the bars being squeezed
  wrap.style.height = Math.max(180, 26 * rows.length + 54) + "px";

  const ink2 = cssVar("--ink-2"), grid = cssVar("--grid");
  const good = cssVar("--good"), bad = cssVar("--bad");

  topTradesChartInstance = new Chart(ctx.getContext("2d"), {
    type: "bar",
    data: {
      labels: rows.map(r => r.name),
      datasets: [{
        data: rows.map(r => r.value),
        backgroundColor: rows.map(r => (r.value >= 0 ? good : bad)),
        borderWidth: 0
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c =>
          `${netMode ? (c.parsed.x >= 0 ? "Up weight" : "Down weight") : (c.parsed.x >= 0 ? "Bought" : "Sold")}: `
          + fmtTradeValue(Math.abs(c.parsed.x), ccy) } }
      },
      scales: {
        x: { ticks: { color: ink2, callback: v => fmtTradeValue(Math.abs(v), ccy) },
             grid: { color: grid, zeroLineColor: ink2 } },
        y: { ticks: { color: ink2, font: { size: 11 }, autoSkip: false },
             grid: { color: "transparent" } }
      }
    }
  });
}
