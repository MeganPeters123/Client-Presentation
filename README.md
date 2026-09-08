# AUM Dashboard

A static, client-side dashboard for preparing AUM, asset allocation and trade record graphics/tables for PowerPoint. No backend, no login — everything runs in the browser and nothing is ever uploaded anywhere.

## Using it

1. Open `index.html` (locally, or via the hosted link once deployed).
2. Upload files under **Data**:
   - **AUM History** — one row per period, with a date column and a total AUM column.
   - **Asset Allocation** — one row per asset class, with a category column and a value (or weight) column. Only used when no Fund Holdings are loaded (see below) — Fund Holdings takes priority once present.
   - **Trade Records** — one row per trade, with date, security, buy/sell type, and value (quantity/price optional). You can upload **more than one trade file** — e.g. one export per broker/platform — each gets its own column mapping and they're merged into a single trade table (with a "Source" column and filter once 2+ files are loaded). Re-uploading a file with the same name replaces just that file's rows.
   - **Fund Holdings** — position-level valuation exports, one file per fund (or one file covering several funds). **No column mapping needed** — the format is auto-detected. Currently recognises three raw formats: the custodian's HTML "Daily Pres" valuation export, a flat CSV export with a `Pfolio` column, and the "Investment Portfolio Detail" binary `.xls` report. Upload one file per fund/mandate; they merge into a "Funds Under Management" view with a consolidated total, a per-fund breakdown table, and a fund selector that drives the Asset Allocation card (pick "All Funds" for a firm-wide blend, or a single fund to drill in). Re-uploading a file for the same fund replaces that fund's snapshot.
   - `.csv` or `.xlsx` both work for the first three; Fund Holdings additionally accepts `.xls`/`.html`. Sample files are linked under the upload panel.
3. After each AUM/Allocation/Trade upload, confirm the column mapping (it's auto-guessed from your headers). If the file mixes real trades with other entries (e.g. a general ledger export with margin calls, dividends, maturities alongside actual buys/sells), open **"Exclude some rows"**, pick the column that distinguishes them, and tick the values that aren't real trades — those rows are dropped before the rest of the mapping is applied. Fund Holdings files skip this step entirely (parsed automatically).
4. The dashboard builds itself: KPIs, an AUM trend chart, a funds-under-management breakdown, an asset allocation breakdown, and a filterable/sortable trade table.
5. Click **Export to PowerPoint** to download a `.pptx` with native, editable PowerPoint charts and tables built from the same data — not screenshots. Includes a funds-under-management slide whenever Fund Holdings are loaded.

## Adding a new Fund Holdings format

If a custodian/administrator export doesn't match one of the three known formats, `js/holdings.js` is where to add it — `parseHoldingsFile()` dispatches by raw file signature (zip / OLE2 binary / HTML text / other), each format has its own parser function, and every parser returns the same shape: `[{ fund, fundCode, asOf, total, segments: [{category, value}], source, format }]`. Category labels should go through `normalizeAssetClassLabel()` or the `localForeignLabel()` local/foreign convention so they consolidate cleanly with the other formats.

## Notes

- Nothing is persisted between sessions except your light/dark theme preference (`localStorage`) and, per-file, remembered column mappings are not currently cached — you'll map columns again each time you re-upload a file with a different shape.
- Re-uploading a file for a slot replaces that dataset (Fund Holdings and Trade Records replace per fund/file rather than the whole slot).
- Built with vanilla HTML/CSS/JS + [SheetJS](https://sheetjs.com/), [Chart.js](https://www.chartjs.org/), and [PptxGenJS](https://gitbrent.github.io/PptxGenJS/) — no build step, deployable as-is to GitHub Pages or any static host.
