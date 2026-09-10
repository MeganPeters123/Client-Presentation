/* Builds a native, editable .pptx (real PowerPoint charts, not pasted images) from the loaded data. */
"use strict";

const PPTX_ACCENT = "2A78D6";
const PPTX_INK = "0B0B0B";
const PPTX_MUTED = "6B6A66";
const PPTX_PALETTE = ["2A78D6", "008300", "E87BA4", "EDA100", "1BAF7A", "EB6834", "4A3AA7", "E34948"];

function pptxColorForCategory(label, idx) {
  const key = normalizeHeader(label);
  const known = { jselistedequity: "14315C", globallistedequity: "A9A9A9", sacash: "8FAADC", globalcash: "F2B84B",
    safixedincome: "1C8299", globalfixedincome: "6FC2D6", saproperty: "C6AEEA", globalproperty: "E7B8E0" };
  return known[key] || PPTX_PALETTE[idx % PPTX_PALETTE.length];
}

function buildTitleSlide(pptx, title, subtitle, asOf) {
  const slide = pptx.addSlide();
  slide.background = { color: "FFFFFF" };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: PPTX_ACCENT } });
  slide.addText(title, { x: 0.7, y: 2.9, w: 11.5, h: 0.9, fontSize: 32, bold: true, color: PPTX_INK, fontFace: "Arial" });
  slide.addText(subtitle, { x: 0.7, y: 3.7, w: 11.5, h: 0.5, fontSize: 16, color: PPTX_MUTED, fontFace: "Arial" });
  if (asOf) slide.addText(asOf, { x: 0.7, y: 4.2, w: 11.5, h: 0.4, fontSize: 12, color: PPTX_MUTED, fontFace: "Arial" });
  return slide;
}

function buildAumSlide(pptx, records) {
  const sorted = records.slice().sort((a, b) => a.date - b.date);
  const labels = sorted.map(r => r.date.toLocaleDateString(undefined, { year: "numeric", month: "short" }));
  const values = sorted.map(r => Math.round(r.aum));
  const latest = values[values.length - 1];
  const first = values[0];
  const change = first ? ((latest - first) / first) * 100 : null;

  const slide = pptx.addSlide();
  slide.addText("AUM Trend", { x: 0.5, y: 0.35, w: 8, h: 0.5, fontSize: 22, bold: true, color: PPTX_INK, fontFace: "Arial" });
  slide.addText(`Latest: R ${latest.toLocaleString()}` + (change != null ? `   (${change >= 0 ? "+" : ""}${change.toFixed(1)}% over period)` : ""),
    { x: 0.5, y: 0.85, w: 10, h: 0.4, fontSize: 13, color: PPTX_MUTED, fontFace: "Arial" });

  slide.addChart(pptx.ChartType.line, [{ name: "AUM", labels, values }], {
    x: 0.5, y: 1.4, w: 12.3, h: 5.6,
    chartColors: [PPTX_ACCENT],
    lineSize: 2.5, lineSmooth: true,
    showLegend: false,
    valAxisLabelFormatCode: "#,##0,,\"m\"",
    catAxisLabelFontSize: 10, valAxisLabelFontSize: 10,
    dataLabelFormatCode: "#,##0,,\"m\""
  });
  return slide;
}

function buildFundsSlide(pptx, snapshots) {
  const total = snapshots.reduce((s, snap) => s + snap.total, 0);
  const sorted = snapshots.slice().sort((a, b) => b.total - a.total);

  const slide = pptx.addSlide();
  slide.addText("Funds Under Management", { x: 0.5, y: 0.35, w: 10, h: 0.5, fontSize: 22, bold: true, color: PPTX_INK, fontFace: "Arial" });
  slide.addText(`${snapshots.length} funds  ·  Total R ${Math.round(total).toLocaleString()}`,
    { x: 0.5, y: 0.85, w: 10, h: 0.4, fontSize: 13, color: PPTX_MUTED, fontFace: "Arial" });

  const rows = [[
    { text: "Fund", options: { bold: true, color: "FFFFFF", fill: { color: PPTX_ACCENT } } },
    { text: "AUM", options: { bold: true, color: "FFFFFF", fill: { color: PPTX_ACCENT }, align: "right" } },
    { text: "% of Total", options: { bold: true, color: "FFFFFF", fill: { color: PPTX_ACCENT }, align: "right" } }
  ]];
  sorted.forEach(s => {
    rows.push([
      { text: s.fund },
      { text: "R " + Math.round(s.total).toLocaleString(), options: { align: "right" } },
      { text: (total ? (s.total / total * 100) : 0).toFixed(1) + "%", options: { align: "right" } }
    ]);
  });
  slide.addTable(rows, { x: 0.5, y: 1.4, w: 12.3, h: 5.5, fontSize: 12, fontFace: "Arial", border: { type: "solid", color: "E1E0D9", pt: 0.5 }, autoPage: false });
  return slide;
}

function buildAllocationSlide(pptx, segments, sourceLabel) {
  const slide = pptx.addSlide();
  slide.addText("Asset Allocation", { x: 0.5, y: 0.35, w: 8, h: 0.5, fontSize: 22, bold: true, color: PPTX_INK, fontFace: "Arial" });
  slide.addText(`% of total fund value by asset class — ${sourceLabel}`, { x: 0.5, y: 0.85, w: 10, h: 0.4, fontSize: 13, color: PPTX_MUTED, fontFace: "Arial" });

  const colors = segments.map((s, i) => pptxColorForCategory(s.category, i));
  slide.addChart(pptx.ChartType.pie, [{ name: "Allocation", labels: segments.map(s => s.category), values: segments.map(s => s.value) }], {
    x: 0.5, y: 1.4, w: 6.2, h: 5.5,
    chartColors: colors,
    showLegend: true, legendPos: "b", legendFontSize: 10,
    showValue: false, showPercent: true, dataLabelFontSize: 10, dataLabelColor: "FFFFFF"
  });

  const rows = [[
    { text: "Category", options: { bold: true, color: "FFFFFF", fill: { color: PPTX_ACCENT } } },
    { text: "% of Total", options: { bold: true, color: "FFFFFF", fill: { color: PPTX_ACCENT }, align: "right" } }
  ]];
  segments.forEach(s => {
    rows.push([{ text: s.category }, { text: s.pct.toFixed(1) + "%", options: { align: "right" } }]);
  });
  slide.addTable(rows, { x: 7.0, y: 1.4, w: 5.8, h: 5.5, fontSize: 11, fontFace: "Arial", border: { type: "solid", color: "E1E0D9", pt: 0.5 }, autoPage: false });
  return slide;
}

function buildTradesSlide(pptx, trades) {
  const buys = trades.filter(t => t.type === "Buy");
  const sells = trades.filter(t => t.type === "Sell");
  const buyTotal = buys.reduce((s, t) => s + (t.value || 0), 0);
  const sellTotal = sells.reduce((s, t) => s + (t.value || 0), 0);

  const sourceCount = new Set(trades.map(t => t.source).filter(Boolean)).size;
  const sourceNote = sourceCount > 1 ? `  ·  merged from ${sourceCount} files` : "";

  const slide = pptx.addSlide();
  slide.addText("Trade Records", { x: 0.5, y: 0.35, w: 8, h: 0.5, fontSize: 22, bold: true, color: PPTX_INK, fontFace: "Arial" });
  slide.addText(`${trades.length} trades  ·  Buys R ${Math.round(buyTotal).toLocaleString()}  ·  Sells R ${Math.round(sellTotal).toLocaleString()}  ·  Net R ${Math.round(buyTotal - sellTotal).toLocaleString()}${sourceNote}`,
    { x: 0.5, y: 0.85, w: 12, h: 0.4, fontSize: 13, color: PPTX_MUTED, fontFace: "Arial" });

  const top = trades.slice().sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 14);
  const rows = [[
    { text: "Date", options: { bold: true, color: "FFFFFF", fill: { color: PPTX_ACCENT } } },
    { text: "Security", options: { bold: true, color: "FFFFFF", fill: { color: PPTX_ACCENT } } },
    { text: "Type", options: { bold: true, color: "FFFFFF", fill: { color: PPTX_ACCENT } } },
    { text: "Value", options: { bold: true, color: "FFFFFF", fill: { color: PPTX_ACCENT }, align: "right" } }
  ]];
  top.forEach(t => {
    rows.push([
      { text: t.date ? t.date.toLocaleDateString() : "" },
      { text: t.security },
      { text: t.type },
      { text: "R " + Math.round(t.value || 0).toLocaleString(), options: { align: "right" } }
    ]);
  });
  slide.addTable(rows, { x: 0.5, y: 1.4, w: 12.3, h: 5.5, fontSize: 11, fontFace: "Arial", border: { type: "solid", color: "E1E0D9", pt: 0.5 }, autoPage: false });
  return slide;
}

function buildTrendSlide(pptx, points, fundLabel) {
  const slide = pptx.addSlide();
  slide.addText("AUM Over Time", { x: 0.5, y: 0.35, w: 8, h: 0.5, fontSize: 22, bold: true, color: PPTX_INK, fontFace: "Arial" });
  slide.addText(fundLabel, { x: 0.5, y: 0.85, w: 10, h: 0.4, fontSize: 13, color: PPTX_MUTED, fontFace: "Arial" });
  slide.addChart(pptx.ChartType.line, [{ name: "AUM", labels: points.map(p => p.label), values: points.map(p => Math.round(p.value)) }], {
    x: 0.5, y: 1.4, w: 12.3, h: 5.6,
    chartColors: [PPTX_ACCENT], lineSize: 2.5, lineSmooth: true, showLegend: false,
    valAxisLabelFormatCode: "#,##0,,\"m\"", catAxisLabelFontSize: 10, valAxisLabelFontSize: 10
  });
  return slide;
}

function buildCompareSlide(pptx, compare) {
  const slide = pptx.addSlide();
  slide.addText("Period Comparison", { x: 0.5, y: 0.35, w: 10, h: 0.5, fontSize: 22, bold: true, color: PPTX_INK, fontFace: "Arial" });
  const changeStr = (compare.totalChangePct >= 0 ? "+" : "") + compare.totalChangePct.toFixed(1) + "%";
  slide.addText(`${compare.labelA} → ${compare.labelB}  ·  R ${Math.round(compare.totalA).toLocaleString()} → R ${Math.round(compare.totalB).toLocaleString()}  (${changeStr})`,
    { x: 0.5, y: 0.85, w: 12, h: 0.4, fontSize: 13, color: PPTX_MUTED, fontFace: "Arial" });

  const rows = [[
    { text: "Category", options: { bold: true, color: "FFFFFF", fill: { color: PPTX_ACCENT } } },
    { text: compare.labelA, options: { bold: true, color: "FFFFFF", fill: { color: PPTX_ACCENT }, align: "right" } },
    { text: compare.labelB, options: { bold: true, color: "FFFFFF", fill: { color: PPTX_ACCENT }, align: "right" } },
    { text: "Change", options: { bold: true, color: "FFFFFF", fill: { color: PPTX_ACCENT }, align: "right" } }
  ]];
  compare.rows.forEach(r => {
    rows.push([
      { text: r.category },
      { text: "R " + Math.round(r.a).toLocaleString(), options: { align: "right" } },
      { text: "R " + Math.round(r.b).toLocaleString(), options: { align: "right" } },
      { text: (r.delta >= 0 ? "+" : "") + "R " + Math.round(r.delta).toLocaleString(), options: { align: "right", color: r.delta >= 0 ? "008300" : "D03B3B" } }
    ]);
  });
  slide.addTable(rows, { x: 0.5, y: 1.4, w: 12.3, h: 5.5, fontSize: 12, fontFace: "Arial", border: { type: "solid", color: "E1E0D9", pt: 0.5 }, autoPage: false });
  return slide;
}

async function exportPptx(state, title, subtitle, extras) {
  extras = extras || {};
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE";

  const asOf = state.aum.length ? "As of " + state.aum.slice().sort((a, b) => b.date - a.date)[0].date.toLocaleDateString() : "";
  buildTitleSlide(pptx, title, subtitle, asOf);
  if (state.aum.length) buildAumSlide(pptx, state.aum);
  if (state.holdingsSnapshots.length) buildFundsSlide(pptx, state.holdingsSnapshots);
  if (extras.trendPoints && extras.trendPoints.length >= 2) buildTrendSlide(pptx, extras.trendPoints, extras.trendLabel || "");
  const { segments: activeSegments, label: allocationLabel } = getActiveAllocationSegments();
  if (activeSegments.length) buildAllocationSlide(pptx, activeSegments, allocationLabel);
  if (extras.compare) buildCompareSlide(pptx, extras.compare);
  if (state.trades.length) buildTradesSlide(pptx, state.trades);

  const fileName = (title || "AUM-Dashboard").replace(/[^a-z0-9]+/gi, "-") + ".pptx";
  await pptx.writeFile({ fileName });
}
