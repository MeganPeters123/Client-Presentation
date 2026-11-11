/* Contribution and attribution, read from Bloomberg PORT exports.
 *
 * One file per fund. PORT writes two different layouts depending on what was asked for:
 * eight columns when only the portfolio was exported, twenty when the benchmark columns came
 * with it. Both are read here; which one arrived decides whether a fund can show an
 * against-the-index view at all, and that is read off the columns rather than assumed per
 * fund, because the same fund can be exported either way.
 *
 * What the numbers mean:
 *   Avg % Wgt   the average weight held over the period
 *   CTR         contribution to return — weight times return, in percentage points of the
 *               fund's own return. These add up: every holding's CTR plus a small residual
 *               is the fund return, and that identity is checked on import.
 *   Tot Attr    the effect of the position relative to the benchmark.
 *
 * Index futures arrive as a pair of lines: the contract, which carries the whole return, and
 * an "_EconomicCash" leg carrying the exact offsetting weight and no return at all. Showing
 * both puts a -1.53% weight with nothing beside it next to its +1.53% twin, which reads like
 * an error. The cash leg is dropped and the contract kept, and because the cash leg's
 * contribution is zero the totals are untouched — checked on import rather than assumed.
 *
 * That pairing is also the only reliable way to name the contracts. PORT writes them as
 * codes (AIZ5, DKH6, DCPZ5, KLZ6) that say nothing on a client page, but each one's cash leg
 * spells out the index and the expiry. Reading the name off the twin means the label comes
 * from the file rather than from a table of guesses that would rot the first time Safex
 * issued a code nobody here had seen.
 */

const ATTRIBUTION_KEY = "aum-dashboard-attribution";

/* Bloomberg's universe codes are its own; the dashboard's funds are named by the custodian.
 * Nothing in either file links them, so the mapping is written out. An unknown code is kept
 * under its own name rather than dropped, so a new mandate shows up as itself and can be
 * added here, instead of silently not appearing. */
const ATTRIBUTION_FUNDS = {
  AYLBAL: "Aylett Balanced Pres Fund",
  AYLEQT: "Aylett Equity Prescient Fund",
  ASAEPF: "Aylett SA Equity Prescient",
  AYLNBW: "NGI Bravata WW Flex - Aylett",
  PGAGEF: "Aylett Global Equity Fund",
  AYHF01_R: "Aylett Prescient QI Hedge Fund"
};

let attributionStore = loadAttributionStore();

function loadAttributionStore() {
  try {
    const raw = localStorage.getItem(ATTRIBUTION_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error("Could not read the saved attribution", e);
  }
  return { period: null, funds: {}, files: [], loadedAt: null };
}

function persistAttribution() {
  try {
    localStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(attributionStore));
    if (typeof cloudSaveState === "function") cloudSaveState("attribution", attributionStore);
    return true;
  } catch (e) {
    console.error("Could not save the attribution locally", e);
    return false;
  }
}

function clearAttribution() {
  attributionStore = { period: null, funds: {}, files: [], loadedAt: null };
  persistAttribution();
}

function listAttributionFunds() {
  return Object.keys(attributionStore.funds || {}).sort();
}

function attributionFor(fund) {
  return (attributionStore.funds || {})[fund] || null;
}

/* ---------- naming ---------- */

/* The exchange code differs between the two sources for the same share — the custodian
 * writes Nestle as NESN SE and Bloomberg as NESN SW, Adidas as ADS GY against ADS GR — so a
 * name is looked for under the full ticker first and then under the root. The root is only
 * taken when there is a space before a known exchange code: a futures code like AIM6 has no
 * space, and splitting it would find "AIM" and label a Top 40 contract as Aimia Inc. */
const ATTRIBUTION_EXCHANGES = new Set([
  "SJ", "US", "UN", "UW", "UQ", "UR", "LN", "GR", "GY", "HK", "CN", "CT", "SM", "SQ",
  "NA", "SW", "SE", "FP", "BB", "GA", "SP", "MM", "MF", "ID", "AT", "AU", "JP", "SS",
  "IM", "PL", "NO", "DC"
]);

function attributionTickerForms(raw) {
  const t = String(raw == null ? "" : raw).replace(/\*/g, "").trim().toUpperCase();
  if (!t) return [];
  const parts = t.split(/\s+/);
  if (parts.length === 2 && ATTRIBUTION_EXCHANGES.has(parts[1])) return [t, parts[0]];
  return [t];
}

/** Every name the dashboard already holds, from the saved history and the index weights.
 *  Built per import rather than kept, so a history loaded after the attribution still
 *  names it on the next render. */
function attributionNameIndex() {
  const full = {}, root = {};
  const add = (ticker, name) => {
    const forms = attributionTickerForms(ticker);
    if (!forms.length || !name) return;
    if (!(forms[0] in full)) full[forms[0]] = name;
    if (forms.length > 1 && !(forms[1] in root)) root[forms[1]] = name;
  };
  Object.values((typeof historyStore !== "undefined" && historyStore.periods) || {})
    .forEach(snap => (snap.holdings || []).forEach(h => add(h.ticker, h.name)));
  // the index weights carry a name per constituent, which covers the Top 40 names a fund
  // does not hold and so has no holding row for
  const months = (typeof indexWeightsStore !== "undefined" && indexWeightsStore.months) || {};
  Object.values(months).forEach(m => Object.values(m.indices || {}).forEach(idx => {
    Object.keys(idx.weights || {}).forEach(share => {
      if (idx.names && idx.names[share]) add(share, idx.names[share]);
    });
  }));
  return { full, root };
}

function attributionLookupName(id, index) {
  const forms = attributionTickerForms(id);
  if (!forms.length) return null;
  if (index.full[forms[0]]) return index.full[forms[0]];
  if (forms.length > 1) return index.full[forms[1]] || index.root[forms[1]] || null;
  return null;
}

const ATTR_CASH_LEG = /_EconomicCash\s*$/i;
const ATTR_CONTRACT = /^[A-Z]{2,4}[FGHJKMNQUVXZ]\d$/;
const ATTR_SAGB = /^SAGB\s+(.+?)\s*#(\S+)$/i;
const ATTR_FRACTION = { "¼": ".25", "½": ".5", "¾": ".75" };
const ATTR_CURRENCIES = {
  ZAR: "South African Rand", USD: "US Dollar", EUR: "Euro", GBP: "British Pound Sterling",
  HKD: "Hong Kong Dollar", MXN: "Mexican Peso", CAD: "Canadian Dollar",
  CHF: "Swiss Franc", SGD: "Singapore Dollar", AUD: "Australian Dollar", JPY: "Japanese Yen",
  TWD: "Taiwan Dollar", CNY: "Chinese Yuan", CNH: "Chinese Yuan (offshore)",
  SEK: "Swedish Krona", NOK: "Norwegian Krone", DKK: "Danish Krone", NZD: "New Zealand Dollar",
  KRW: "South Korean Won", INR: "Indian Rupee", BRL: "Brazilian Real", PLN: "Polish Zloty"
};
const ATTR_INDEX_LABELS = [
  [/FTSE\/JSE\s*TOP\s*40/i, "FTSE/JSE Top 40"],
  [/CTOP\s*INDEX\s*FUTURE/i, "Capped Top 40"],
  [/DCAP\s*INDEX\s*FUT/i, "DCAP"],
  [/FTSE\/JSE\s*15/i, "FTSE/JSE Financial 15"]
];

/** "FTSE/JSE TOP 40   Dec25_EconomicCash" -> { name: "FTSE/JSE Top 40 future", expiry: "Dec 2025" } */
function attributionFuturesLabel(cashLegId) {
  const base = String(cashLegId).replace(ATTR_CASH_LEG, "").trim();
  const hit = ATTR_INDEX_LABELS.find(([re]) => re.test(base));
  const expiry = base.match(/([A-Za-z]{3})\s*(\d{2})\s*$/);
  return {
    name: (hit ? hit[1] : base.replace(/\s{2,}/g, " ")) + " future",
    expiry: expiry ? `${expiry[1]} 20${expiry[2]}` : null
  };
}

function attributionBondLabel(id) {
  const m = ATTR_SAGB.exec(id);
  if (!m) return null;
  const bits = m[1].trim().split(/\s+/);
  const coupon = bits[0] + (bits.length > 1 && ATTR_FRACTION[bits[1]] ? ATTR_FRACTION[bits[1]] : "");
  return `RSA ${m[2]} ${coupon}% ${bits[bits.length - 1]}`;
}

/* ---------- the import ---------- */

function attributionNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Reads one PORT export. Returns what was found so the caller can say so. */
async function importAttributionFromFile(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("that workbook has no sheets");
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: true });
  if (grid.length < 7) throw new Error("that file has too few rows to be a PORT export");

  const meta = {};
  (grid[0] || []).forEach((h, i) => {
    if (h) meta[String(h).trim()] = (grid[1] || [])[i];
  });
  const universe = String(meta["Universe Name"] || "").trim();
  if (!universe) {
    throw new Error('expected a "Universe Name" — is this the PORT attribution export?');
  }

  // rows 4 and 5 are a two-level header: a group that spans columns, then Port/Bmrk/Active
  const groups = grid[3] || [], subs = grid[4] || [];
  const colOf = {};
  let group = "";
  for (let c = 0; c < Math.max(groups.length, subs.length); c++) {
    if (groups[c]) group = String(groups[c]).trim();
    const sub = subs[c] ? String(subs[c]).trim() : null;
    if (c === 0 || !sub) continue;
    colOf[`${group}|${sub}`] = c;
  }
  const col = key => (key in colOf ? colOf[key] : -1);
  const cell = (row, key) => {
    const c = col(key);
    return c >= 0 && c < row.length ? attributionNumber(row[c]) : null;
  };
  if (col("Avg % Wgt|Port") < 0 || col("CTR|Port") < 0) {
    throw new Error("expected Avg % Wgt and CTR columns — is this a PORT attribution export?");
  }
  const hasBenchmark = col("Avg % Wgt|Bmrk") >= 0 && col("CTR|Bmrk") >= 0;

  // The identifier column is indented to show the tree, but a reader that trims is one
  // upstream change away from flattening it, so the three special rows are found by name.
  let fundRow = null, residualRow = null, holdingsRow = null;
  const securities = [];
  for (let r = 5; r < grid.length; r++) {
    const row = grid[r] || [];
    if (row[0] === null || row[0] === undefined || row[0] === "") continue;
    const id = String(row[0]).trim();
    if (!id) continue;
    if (!fundRow && id === universe) { fundRow = row; continue; }
    if (/^residuals?$/i.test(id)) { residualRow = row; continue; }
    if (/^holdings$/i.test(id)) { holdingsRow = row; continue; }
    securities.push({ id, row });
  }
  if (!fundRow || !holdingsRow) throw new Error("could not find the fund and Holdings rows");

  // Pair each futures contract with its offsetting cash leg by weight, then drop the legs.
  const byWeight = new Map();
  securities.forEach(s => {
    const w = cell(s.row, "Avg % Wgt|Port");
    if (w === null) return;
    const k = w.toFixed(9);
    if (!byWeight.has(k)) byWeight.set(k, []);
    byWeight.get(k).push(s);
  });
  const names = attributionNameIndex();
  const rows = [];
  let droppedLegs = 0, legContribution = 0;
  securities.forEach(s => {
    if (ATTR_CASH_LEG.test(s.id)) {
      droppedLegs++;
      legContribution += cell(s.row, "CTR|Port") || 0;
      return;
    }
    const wgt = cell(s.row, "Avg % Wgt|Port");
    let name = attributionLookupName(s.id, names);
    let kind = "Equity", expiry = null;
    if (!name) {
      const upper = s.id.toUpperCase();
      if (ATTR_CURRENCIES[upper]) { name = ATTR_CURRENCIES[upper]; kind = "Cash"; }
      else if (/^future margin/i.test(s.id)) { name = "Futures margin"; kind = "Futures"; }
      else if (ATTR_SAGB.test(s.id)) { name = attributionBondLabel(s.id); kind = "Bonds"; }
      else if (ATTR_CONTRACT.test(s.id) && wgt !== null) {
        const twin = (byWeight.get((-wgt).toFixed(9)) || []).find(t => ATTR_CASH_LEG.test(t.id));
        if (twin) {
          const lab = attributionFuturesLabel(twin.id);
          name = lab.name; expiry = lab.expiry; kind = "Futures";
        }
      }
    }
    rows.push({
      id: s.id,
      name: name || s.id,
      named: !!name,
      expiry, kind,
      wgt,
      ctr: cell(s.row, "CTR|Port"),
      ret: cell(s.row, "Tot Rtn|Port"),
      attr: cell(s.row, "Tot Rtn|Tot Attr"),
      bWgt: cell(s.row, "Avg % Wgt|Bmrk"),
      aWgt: cell(s.row, "Avg % Wgt|Active"),
      bRet: cell(s.row, "Tot Rtn|Bmrk")
    });
  });

  const fundReturn = cell(fundRow, "Tot Rtn|Port");
  const residual = residualRow ? cell(residualRow, "Tot Rtn|Port") : 0;
  const holdingsCtr = cell(holdingsRow, "CTR|Port");

  // The identity the whole page rests on. If the parts do not add to the total something was
  // read from the wrong column, and a contribution table that does not add up is worse than
  // none at all — so it is checked here rather than left to be noticed on a client's copy.
  const shown = rows.reduce((a, r) => a + (r.ctr || 0), 0);
  const gap = Math.abs(shown + (residual || 0) - (fundReturn || 0));
  if (fundReturn !== null && gap > 0.0005) {
    throw new Error(`the contributions do not add up to the fund return `
      + `(${shown.toFixed(4)}% + ${(residual || 0).toFixed(4)}% vs ${fundReturn.toFixed(4)}%)`);
  }
  if (Math.abs(legContribution) > 0.0005) {
    throw new Error("a futures cash leg carried a return, so dropping it would change the total");
  }

  const period = String(meta["As Of Date"] || "").trim();
  const fund = ATTRIBUTION_FUNDS[universe.toUpperCase()] || universe;
  // One period at a time, by choice: a file from a different window replaces what is held
  // rather than sitting beside it, so the tab can never show two funds over two periods and
  // look like it is comparing them.
  const replaced = attributionStore.period && period && attributionStore.period !== period;
  if (replaced) attributionStore = { period: null, funds: {}, files: [], loadedAt: null };
  attributionStore.period = period || attributionStore.period;
  attributionStore.funds[fund] = {
    universe, fund,
    benchmark: String(meta["Benchmark Name"] || "").trim() || null,
    hasBenchmark,
    fundReturn,
    bmrkReturn: cell(fundRow, "Tot Rtn|Bmrk"),
    activeReturn: cell(fundRow, "Tot Rtn|Active"),
    residual, holdingsCtr,
    holdingsAttr: cell(holdingsRow, "Tot Rtn|Tot Attr"),
    rows,
    fileName: file.name
  };
  attributionStore.files = [...new Set([...(attributionStore.files || []), file.name])];
  attributionStore.loadedAt = new Date().toISOString();
  persistAttribution();
  return {
    fund, universe, hasBenchmark, replaced,
    holdings: rows.length, droppedLegs,
    unnamed: rows.filter(r => !r.named).length
  };
}

/** The window the figures cover, as a person would say it.
 *  PORT writes "From Fri Oct 31 2025 00:00:00 GMT+0200 to Sat Oct 31 2026 00:00:00 GMT+0200". */
function attributionPeriodLabel() {
  const raw = attributionStore.period || "";
  const m = raw.match(/from\s+(.+?)\s+to\s+(.+)$/i);
  const tidy = s => {
    const d = new Date(String(s).replace(/\s*GMT.*$/, ""));
    return isNaN(d) ? String(s).trim()
      : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  };
  if (!m) return raw;
  return `${tidy(m[1])} – ${tidy(m[2])}`;
}
