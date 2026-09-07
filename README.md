# AUM Dashboard

A static, client-side dashboard for preparing AUM, asset allocation and trade record graphics/tables for PowerPoint. No backend, no login — everything runs in the browser and nothing is ever uploaded anywhere.

## Using it

1. Open `index.html` (locally, or via the hosted link once deployed).
2. Upload three files under **Data**:
   - **AUM History** — one row per period, with a date column and a total AUM column.
   - **Asset Allocation** — one row per asset class, with a category column and a value (or weight) column.
   - **Trade Records** — one row per trade, with date, security, buy/sell type, and value (quantity/price optional). You can upload **more than one trade file** — e.g. one export per broker/platform — each gets its own column mapping and they're merged into a single trade table (with a "Source" column and filter once 2+ files are loaded). Re-uploading a file with the same name replaces just that file's rows.
   - `.csv` or `.xlsx` both work. Sample files are linked under the upload panel.
3. After each upload, confirm the column mapping (it's auto-guessed from your headers).
4. The dashboard builds itself: KPIs, an AUM trend chart, an asset allocation breakdown, and a filterable/sortable trade table.
5. Click **Export to PowerPoint** to download a `.pptx` with native, editable PowerPoint charts and tables built from the same data — not screenshots.

## Notes

- Nothing is persisted between sessions except your light/dark theme preference (`localStorage`) and, per-file, remembered column mappings are not currently cached — you'll map columns again each time you re-upload a file with a different shape.
- Re-uploading a file for a slot replaces that dataset.
- Built with vanilla HTML/CSS/JS + [SheetJS](https://sheetjs.com/), [Chart.js](https://www.chartjs.org/), and [PptxGenJS](https://gitbrent.github.io/PptxGenJS/) — no build step, deployable as-is to GitHub Pages or any static host.
