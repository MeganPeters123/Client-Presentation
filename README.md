# AUM Dashboard

A static, client-side dashboard that turns the monthly fund exports into the AUM, asset allocation and trade figures and charts used to build the client presentation. No backend, no login — everything runs in the browser and nothing is ever uploaded anywhere.

## Using it

1. Open `index.html` (locally, or via the hosted link once deployed).
2. Upload files under **Data**:
   - **AUM History** — one row per period, with a date column and a total AUM column.
   - **Asset Allocation** — one row per asset class, with a category column and a value (or weight) column. Only used when no Fund Holdings are loaded (see below) — Fund Holdings takes priority once present.
   - **Trade Records** — one row per trade, with date, security, buy/sell type, and value (quantity/price optional). You can upload **more than one trade file** — e.g. one export per broker/platform — each gets its own column mapping and they're merged into a single trade table (with a "Source" column and filter once 2+ files are loaded). Re-uploading a file with the same name replaces just that file's rows.
   - **Fund Holdings** — position-level valuation exports, one file per fund (or one file covering several funds). **No column mapping needed** — the format is auto-detected. Currently recognises three raw formats: the custodian's HTML "Daily Pres" valuation export, a flat CSV export with a `Pfolio` column, and the "Investment Portfolio Detail" binary `.xls` report. Upload one file per fund/mandate; they merge into a "Funds Under Management" view with a consolidated total, a per-fund breakdown table, and a fund selector that drives the Asset Allocation card (pick "All Funds" for a firm-wide blend, or a single fund to drill in). Re-uploading a file for the same fund replaces that fund's snapshot.
   - `.csv` or `.xlsx` both work for the first three; Fund Holdings additionally accepts `.xls`/`.html`. Sample files are linked under the upload panel.
3. After each AUM/Allocation/Trade upload, confirm the column mapping (it's auto-guessed from your headers). If the file mixes real trades with other entries (e.g. a general ledger export with margin calls, dividends, maturities alongside actual buys/sells), open **"Exclude some rows"**, pick the column that distinguishes them, and tick the values that aren't real trades — those rows are dropped before the rest of the mapping is applied. Fund Holdings files skip this step entirely (parsed automatically).
4. The dashboard builds itself: KPIs, an AUM trend chart, a funds-under-management breakdown, an asset allocation breakdown, a trading-activity view, and a filterable/sortable trade table — ready to read off or copy into the deck.

## Tracking history across months

Fund Holdings snapshots aren't just for "right now" — you can save each month and browse/compare across up to however many months you keep:

- **Save this period**, in the Funds Under Management card, saves everything currently loaded in Fund Holdings into a local history, keyed by fund + month (taken from each file's own as-of date). Re-saving the same fund for the same month overwrites it.
- The **Period selector** next to the fund selector switches between "Current Upload" (what you've just loaded) and any saved month — this drives the funds table and the Asset Allocation card.
- Once 2+ months are saved for the selected fund (or consolidated), a **trend chart** appears automatically.
- The **Compare Periods** card lets you pick any two saved months (for one fund, or consolidated) and see the AUM and per-category change between them.
- The **Trading Activity** card charts monthly buys and sells by asset class, including equities received via corporate action. Cash and money-market flows are off the chart by default (they dwarf everything else) but always present in the table.
- History is saved automatically to this browser's local storage, so it survives closing the tab — but it's tied to this one browser on this one computer. Use **Export history (.json)** to download a portable backup (keep it on the shared drive alongside your source files) and **Import history** to load it into another browser/computer, or restore after clearing browser data. Importing merges in (doesn't wipe existing local history) — matching fund+month entries get overwritten by the imported ones.
- Nothing else (AUM History, Asset Allocation, Trade Records) is saved across sessions — only Fund Holdings history.

## Adding a new Fund Holdings format

If a custodian/administrator export doesn't match one of the three known formats, `js/holdings.js` is where to add it — `parseHoldingsFile()` dispatches by raw file signature (zip / OLE2 binary / HTML text / other), each format has its own parser function, and every parser returns the same shape: `[{ fund, fundCode, asOf, total, segments: [{category, value}], source, format }]`. Category labels should go through `normalizeAssetClassLabel()` or the `localForeignLabel()` local/foreign convention so they consolidate cleanly with the other formats.

## Notes

- Nothing is persisted between sessions except your light/dark theme preference, saved Fund Holdings history (see above — both via `localStorage`), and, per-file, remembered column mappings are not currently cached — you'll map columns again each time you re-upload a file with a different shape.
- Re-uploading a file for a slot replaces that dataset (Fund Holdings and Trade Records replace per fund/file rather than the whole slot).
- Built with vanilla HTML/CSS/JS + [SheetJS](https://sheetjs.com/) and [Chart.js](https://www.chartjs.org/) — no build step, deployable as-is to GitHub Pages or any static host.
