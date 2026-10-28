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

const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

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
  const charts = Array.from(block.querySelectorAll("canvas"))
    .map(c => (typeof Chart !== "undefined" ? Chart.getChart(c) : null))
    .filter(Boolean);
  const previous = charts.map(c => c.options.devicePixelRatio);

  charts.forEach(c => { c.options.devicePixelRatio = EXPORT_SCALE; c.resize(); });
  await nextFrame();
  try {
    return await html2canvas(block, {
      scale: EXPORT_SCALE,
      backgroundColor: cssVar("--surface") || "#ffffff",
      logging: false,
      // the buttons that started the export have no business being in the picture
      ignoreElements: el => el.classList && el.classList.contains("export-controls")
    });
  } finally {
    charts.forEach((c, i) => { c.options.devicePixelRatio = previous[i]; c.resize(); });
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
async function copyBlock(block) {
  const canvas = await withLightTheme(() => blockToCanvas(block));
  const blob = await canvasBlob(canvas);
  if (navigator.clipboard && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return { canvas, how: "clipboard" };
    } catch (err) {
      console.warn("Clipboard refused the image, saving it instead:", err);
    }
  }
  saveBlob(blob, `${slug(blockName(block))}.png`);
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

async function downloadBlock(block) {
  const canvas = await withLightTheme(() => blockToCanvas(block));
  saveBlob(await canvasBlob(canvas), `${slug(blockName(block))}.png`);
  return { canvas, how: "file" };
}

/** Copy and PNG on every exportable block, put into the heading it belongs to. */
function wireExportControls() {
  exportableBlocks().forEach(block => {
    const head = block.querySelector(".step-head, .card-head");
    if (!head || head.querySelector(".export-controls")) return;

    const wrap = document.createElement("div");
    wrap.className = "export-controls";

    const run = async (btn, fn) => {
      if (btn.disabled) return;
      const was = btn.textContent;
      btn.disabled = true;
      btn.textContent = "…";
      try {
        const { canvas, how } = await fn(block);
        const size = `${canvas.width} × ${canvas.height}px`;
        showToast(how === "clipboard"
          ? `Copied, ${size} — paste into PowerPoint`
          : `Saved ${slug(blockName(block))}.png, ${size}`);
      } catch (err) {
        console.error(err);
        showToast("Could not export that: " + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = was;
      }
    };

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
