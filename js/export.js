/* Copying a chart or a table out of the dashboard and into a slide.
 *
 * Two things make this more than canvas.toDataURL():
 *
 * 1. Resolution. A chart on screen is drawn at the window's pixel ratio, which is one or two
 *    device pixels per CSS pixel. Pasted into PowerPoint and stretched across a slide that
 *    is soft. Each chart is redrawn at EXPORT_SCALE before the capture and put back after,
 *    so the bitmap behind it genuinely holds the extra detail rather than being upscaled.
 *
 * 2. Theme. Slides are white. Exporting while the dark theme is on would hand over a block
 *    of near-black with pale text on it, which is not what anyone wants on a client slide —
 *    so an export always switches to the light theme for the capture and switches back.
 */

const EXPORT_SCALE = 3;          // a 700px-wide chart lands as ~2100px, sharp at full width

/** Every block worth exporting on its own: each step of a tab, plus the Overview cards,
 *  which have no steps but do have a chart or a table in them. */
function exportableBlocks() {
  const blocks = Array.from(document.querySelectorAll(".flow-step"));
  document.querySelectorAll(".card").forEach(card => {
    if (card.querySelector(".flow-step")) return;                 // its steps are the blocks
    if (card.querySelector("canvas, table")) blocks.push(card);
  });
  return blocks;
}

/** The nearest element that holds all of these. */
function commonAncestor(nodes) {
  return nodes.reduce((a, b) => {
    if (!a) return b;
    let up = a;
    while (up && !up.contains(b)) up = up.parentElement;
    return up;
  }, null);
}

/** What a block can be exported as.
 *
 *  A step is a heading, the thing itself, and often a note underneath. What goes on a slide
 *  is usually the thing, so the content leads and a plain Copy gives you that: the table
 *  where there is one, otherwise the chart. Megan's calls, 2026-10-28 — the figures for the
 *  allocation step, the bars on their own for the look-through.
 *
 *  Whole step stays on the list for when the heading and the note are the point, which they
 *  are on the look-through bars, where the note carries the property and futures caveats.
 *
 *  The table part is the <table> itself rather than its scrolling wrapper, so a table wider
 *  than the window is captured whole instead of being cut off at the edge of the scroll box. */
function blockParts(block, { visibleOnly = false } = {}) {
  // A step can hold something that is not on screen — the cash breakdown under the
  // positions table only appears for some funds. Counted, it drags the common ancestor up
  // to the whole step and the table can no longer be had on its own; captured, it is a
  // blank. Visibility is only knowable once the tab is showing, so the parts are worked out
  // when a button is pressed rather than when the buttons are built.
  const shown = el => !visibleOnly || el.getClientRects().length > 0;
  const tables = Array.from(block.querySelectorAll("table")).filter(shown);
  const canvases = Array.from(block.querySelectorAll("canvas")).filter(shown);
  const parts = [];

  if (tables.length) {
    const el = tables.length === 1 ? tables[0] : commonAncestor(tables);
    if (el && el !== block) parts.push({ key: "table", label: "Table only", el });
  }
  if (canvases.length) {
    const el = canvases.length === 1
      ? (canvases[0].closest(".chart-wrap") || canvases[0])
      : commonAncestor(canvases);
    if (el && el !== block) parts.push({ key: "chart", label: "Chart only", el });
  }
  parts.push({ key: "step", label: "Whole step", el: block });
  return parts;
}

function blockName(block) {
  const title = block.querySelector(".step-title, .card-title");
  const card = block.closest(".card");
  const cardTitle = card && card.querySelector(".card-title");
  const parts = [cardTitle && cardTitle.textContent, title && title.textContent !== (cardTitle && cardTitle.textContent)
    ? title.textContent : null];
  return parts.filter(Boolean).join(" - ").replace(/\s+/g, " ").trim() || "dashboard";
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
}

/** Wait for the browser to have laid things out again.
 *
 *  requestAnimationFrame is the right signal, but a browser stops firing it for a page it
 *  is not drawing — a background tab, or a window behind another one. Waiting on it alone
 *  would leave an export hanging forever in exactly that case, so a timer races it. */
const nextFrame = () => new Promise(resolve => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(() => requestAnimationFrame(finish));
  setTimeout(finish, 120);
});

/** Run fn with the light theme in force, then put the theme back.
 *
 *  The charts hold their fills and their ink colours from when they were built, so the
 *  theme has to be switched and everything redrawn before the capture — reading the
 *  stylesheet alone is not enough. */
async function withLightTheme(fn) {
  const root = document.documentElement;
  const wasDark = typeof onDarkSurface === "function" && onDarkSurface();
  const previous = root.getAttribute("data-theme");
  if (wasDark) {
    root.setAttribute("data-theme", "light");
    renderAll();
    await nextFrame();
  }
  try {
    return await fn();
  } finally {
    if (wasDark) {
      if (previous === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", previous);
      renderAll();
    }
  }
}

/** The block as a canvas at EXPORT_SCALE, charts redrawn at that scale first. */
async function blockToCanvas(block) {
  // A page the browser is not drawing — the window behind another, or the tab in the
  // background — lays out and resizes as normal but never paints, so a chart can pass every
  // check here and still come out blank. The guard below tests the canvas's dimensions,
  // which are right in that state; only this tells the two apart. Said plainly, because an
  // empty PNG pasted into a deck is worse than a refusal.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    throw new Error("this window was in the background, so the charts had not been drawn — bring it to the front and try again");
  }
  const charts = Array.from(block.querySelectorAll("canvas"))
    .map(c => (typeof Chart !== "undefined" ? Chart.getChart(c) : null))
    .filter(Boolean);
  const previous = charts.map(c => c.options.devicePixelRatio);
  const previousAnimation = charts.map(c => c.options.animation);

  // A donut that sits beside its own table carries no slice labels on screen, because the
  // table is right there. Copied out on its own it has no table beside it, so the labels go
  // on for the capture and come off again after.
  const labelled = charts.filter(c => {
    const o = c.options.plugins && c.options.plugins.donutSliceLabels;
    return o && o.enabled === false;
  });
  const previousPadding = labelled.map(c => c.options.layout && c.options.layout.padding);

  // Animation off first, and that is not a nicety. Chart.js animates a resize, so a capture
  // taken a frame or two later catches bars part-grown.
  //
  // The size is then given explicitly rather than left to be measured. A chart drawn while
  // its tab was hidden has a canvas of 0 x 0, and it only re-measures itself on a later
  // frame — which a browser is in no hurry to deliver for a page it is not drawing. Copying
  // straight after switching to a tab therefore captured nothing at all. Measuring the box
  // here and handing the size over takes that timing out of it.
  charts.forEach(c => {
    c.options.animation = false;
    c.options.devicePixelRatio = EXPORT_SCALE;
    const box = c.canvas.parentElement;
    const rect = box ? box.getBoundingClientRect() : null;
    if (rect && rect.width > 0 && rect.height > 0) c.resize(rect.width, rect.height);
    else c.resize();
  });
  labelled.forEach(c => {
    c.options.plugins.donutSliceLabels.enabled = true;
    c.options.layout = { ...(c.options.layout || {}), padding: { top: 14, bottom: 14 } };
  });

  // Then settle, rather than forcing a draw and hoping. Chart.js lays out and paints over
  // a frame or two, and reaching in with draw() mid-flight produced a different partial
  // picture each time — bars without their labels, a legend without its text. So: ask for
  // the render, wait, and only go on once the canvas has the size it was promised. The loop
  // is what makes it safe to press Copy the instant a tab is opened.
  for (let attempt = 0; attempt < 8; attempt++) {
    charts.forEach(c => c.update("none"));
    await nextFrame();
    const ready = charts.every(c => {
      const want = Math.round((c.canvas.clientWidth || 0) * EXPORT_SCALE);
      return c.canvas.width > 0 && (!want || Math.abs(c.canvas.width - want) <= EXPORT_SCALE);
    });
    if (ready) break;
  }

  // If a chart still has no canvas after all that, the page is not being painted at all —
  // a window behind another one, or a tab the browser has parked. Saying so beats handing
  // over a blank picture that only shows itself up on the slide.
  if (charts.some(c => !c.canvas.width)) {
    throw new Error("the chart had not finished drawing — bring the window to the front and try again");
  }
  try {
    return await html2canvas(block, {
      scale: EXPORT_SCALE,
      backgroundColor: cssVar("--surface") || "#ffffff",
      logging: false,
      // the buttons that started the export have no business being in the picture
      ignoreElements: el => el.classList && el.classList.contains("export-controls")
    });
  } finally {
    labelled.forEach((c, i) => {
      c.options.plugins.donutSliceLabels.enabled = false;
      if (previousPadding[i] === undefined) delete c.options.layout.padding;
      else c.options.layout.padding = previousPadding[i];
    });
    charts.forEach((c, i) => {
      c.options.devicePixelRatio = previous[i];
      c.options.animation = previousAnimation[i];
      c.resize();
      c.update("none");
      c.draw();
    });
  }
}

const canvasBlob = canvas => new Promise(resolve => canvas.toBlob(resolve, "image/png"));

/** Put the block on the clipboard, or save it if the browser will not allow that.
 *
 *  Writing an image to the clipboard needs a secure context and the clipboard-write
 *  permission. Both are normally there - the dashboard is served over https, and a click is
 *  a user gesture - but a browser or a group policy can refuse, and a refusal arrives as a
 *  plain exception at the moment of writing. Rather than leave the button doing nothing,
 *  the image is saved instead and the toast says which of the two happened. */
function exportName(block, part) {
  const suffix = part.key === "step" ? "" : `-${part.key}`;
  return `${slug(blockName(block))}${suffix}.png`;
}

async function copyBlock(block, part) {
  const canvas = await withLightTheme(() => blockToCanvas(part.el));
  const blob = await canvasBlob(canvas);
  if (navigator.clipboard && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return { canvas, how: "clipboard" };
    } catch (err) {
      console.warn("Clipboard refused the image, saving it instead:", err);
    }
  }
  saveBlob(blob, exportName(block, part));
  return { canvas, how: "file" };
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadBlock(block, part) {
  const canvas = await withLightTheme(() => blockToCanvas(part.el));
  saveBlob(await canvasBlob(canvas), exportName(block, part));
  return { canvas, how: "file" };
}

/** Every block's option list, refreshed when a tab is shown. */
const pickers = [];

/** Copy and PNG on every exportable block, put into the heading it belongs to. */
function wireExportControls() {
  exportableBlocks().forEach(block => {
    const head = block.querySelector(".step-head, .card-head");
    if (!head || head.querySelector(".export-controls")) return;

    const wrap = document.createElement("div");
    wrap.className = "export-controls";

    // null means "whatever this block leads with", resolved at the moment of use
    let chosenKey = null;
    const resolvePart = () => {
      const parts = blockParts(block, { visibleOnly: true });
      if (!chosenKey) return parts[0];
      return parts.find(p => p.key === chosenKey) || parts[parts.length - 1];
    };

    const run = async (btn, fn) => {
      if (btn.disabled) return;
      const was = btn.textContent;
      btn.disabled = true;
      btn.textContent = "…";
      try {
        const chosen = resolvePart();
        const { canvas, how } = await fn(block, chosen);
        const size = `${canvas.width} × ${canvas.height}px`;
        showToast(how === "clipboard"
          ? `Copied, ${size} — paste into PowerPoint`
          : `Saved ${exportName(block, chosen)}, ${size}`);
      } catch (err) {
        console.error(err);
        showToast("Could not export that: " + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = was;
      }
    };

    // Filled in when it is opened rather than now: what a step holds depends on the fund
    // and the month, and at the moment these buttons are built the tab is usually hidden.
    const pick = document.createElement("select");
    pick.className = "export-part";
    pick.title = "What the buttons beside this export";
    const fillOptions = () => {
      if (!block.getClientRects().length) return;        // its tab is hidden; nothing to read
      const parts = blockParts(block, { visibleOnly: true });
      const want = chosenKey || parts[0].key;
      pick.innerHTML = parts.map(p =>
        `<option value="${p.key}"${p.key === want ? " selected" : ""}>${p.label}</option>`).join("");
      pick.style.display = parts.length > 1 ? "" : "none";
    };
    pick.addEventListener("mousedown", fillOptions);
    pick.addEventListener("focus", fillOptions);
    pick.addEventListener("change", () => { chosenKey = pick.value; });
    pickers.push(fillOptions);
    fillOptions();
    wrap.appendChild(pick);

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "export-btn";
    copy.textContent = "Copy";
    copy.title = "Copy this as an image, ready to paste straight into a slide";
    copy.addEventListener("click", () => run(copy, copyBlock));

    const png = document.createElement("button");
    png.type = "button";
    png.className = "export-btn";
    png.textContent = "PNG";
    png.title = "Save this as a PNG file";
    png.addEventListener("click", () => run(png, downloadBlock));

    wrap.append(copy, png);
    head.appendChild(wrap);
  });
}

wireExportControls();

/* A block's parts can only be read while it is on screen, and what is on screen changes two
 * ways: the tab being switched, and the data arriving. Both are plain globals that
 * everything else calls by name, so wrapping them catches every route in — the tab bar, the
 * empty-state link, the tab restored at startup, an upload, and a sign-in. */
const refreshPickers = () => pickers.forEach(fill => {
  try { fill(); } catch (e) { console.warn("export controls:", e); }
});

function wrapGlobal(name) {
  const inner = window[name];
  if (typeof inner !== "function") return;
  window[name] = function (...args) {
    const result = inner.apply(this, args);
    refreshPickers();
    return result;
  };
}

wrapGlobal("showTab");
wrapGlobal("renderAll");
refreshPickers();
