/* Reading the saved history from Supabase instead of importing a file.
 *
 * Everything here is additive. The Import history button still works, the .json file is
 * still what the build writes first, and a browser that never signs in behaves exactly as
 * it did before. This is a second way in, not a replacement.
 *
 * The key below is Supabase's publishable key and is meant to be public — it identifies the
 * project, it does not grant anything. What protects the data is row-level security on the
 * two tables: a signed-in user may select, nobody may write, and signed out sees nothing at
 * all. That is verified rather than assumed; see scripts/supabase_schema.sql.
 */

const CLOUD = {
  url: "https://udwrfydqexzxmyodcbdx.supabase.co",
  key: "sb_publishable_je1a_y38cKwFMggIT11sCg_DPzfVHNc"
};

let cloudClient = null;

function cloudAvailable() {
  return typeof supabase !== "undefined" && !!CLOUD.url && !!CLOUD.key;
}

function getCloudClient() {
  if (!cloudAvailable()) return null;
  if (!cloudClient) {
    // the session is kept in this browser, so signing in is a once-per-machine thing
    cloudClient = supabase.createClient(CLOUD.url, CLOUD.key, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  }
  return cloudClient;
}

async function cloudSession() {
  const c = getCloudClient();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  return (data && data.session) || null;
}

async function cloudSignIn(email, password) {
  const c = getCloudClient();
  if (!c) throw new Error("the Supabase library did not load — check the connection");
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data.session;
}

async function cloudSignOut() {
  const c = getCloudClient();
  if (c) await c.auth.signOut();
}

/** Pull the whole history down and put it where the dashboard already looks for it.
 *
 *  PostgREST answers a thousand rows at a time, so this pages rather than trusting one
 *  request to carry everything — there are 380 snapshots today and nothing stops that
 *  growing past the limit without anyone noticing it had. */
/** When the saved history was last written centrally, or null if that cannot be told.
 *
 *  One row, not the history: the dashboard reads its figures from this browser's own copy
 *  and only goes to Supabase when asked, so a rebuild upstream leaves that copy quietly out
 *  of date — which is exactly how a day went by with the right figures in the table and the
 *  old ones on screen. This is cheap enough to ask on every load.
 */
async function cloudHistoryUpdatedAt() {
  const c = getCloudClient();
  if (!c) return null;
  const { data, error } = await c.from("snapshots")
    .select("saved_at").order("saved_at", { ascending: false }).limit(1);
  if (error || !data || !data.length || !data[0].saved_at) return null;
  return new Date(data[0].saved_at);
}

async function cloudLoadHistory() {
  const c = getCloudClient();
  if (!c) throw new Error("not connected");

  const page = 1000;
  const snapshots = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await c.from("snapshots").select("*").range(from, from + page - 1);
    if (error) throw new Error(error.message);
    snapshots.push(...data);
    if (data.length < page) break;
  }

  const { data: trades, error: tErr } = await c.from("trade_activity").select("*");
  if (tErr) throw new Error(tErr.message);

  // the same shape importHistoryFromFile builds, so every reader downstream is unchanged
  historyStore.periods = {};
  snapshots.forEach(r => {
    // a mandate renamed in the custodian's files is still one mandate: the rows saved under
    // each name are keyed to the one the dashboard shows (see FUND_NAME_ALIASES)
    const fund = canonicalFundName(r.fund);
    historyStore.periods[`${fund}|${r.period}`] = {
      fund,
      fundCode: r.fund_code,
      period: r.period,
      asOf: r.as_of ? new Date(`${r.as_of}T12:00:00`) : null,
      total: Number(r.total),
      segments: r.segments || [],
      holdings: r.holdings || [],
      // The currency the fund is reported in and the rand rate for it. This row is built
      // field by field, so a field not named here is one the dashboard never sees however
      // faithfully the ETL wrote it — these two were missing, and every consolidated figure
      // read as though every fund were rand. Absent until supabase_currency.sql has been run.
      // left undefined where the column is not there yet, never defaulted to rand: the
      // dashboard tells "no currency recorded" from "recorded as rand" by this field alone,
      // and defaulting it would have it take the dollar fund's total for rand while also
      // taking out the funds' holdings of one another — a worse figure than before, quietly.
      baseCcy: r.base_ccy == null ? undefined : r.base_ccy,
      zarRate: r.zar_rate == null ? null : Number(r.zar_rate),
      source: r.source,
      format: r.format,
      savedAt: r.saved_at ? new Date(r.saved_at) : null
    };
  });

  historyStore.trades = {};
  (trades || []).forEach(r => {
    historyStore.trades[r.period] = {
      period: r.period,
      byClass: r.by_class || {},
      bySource: r.by_source || {},
      // absent until scripts/supabase_trade_securities.sql has been run
      bySecurity: r.by_security || []
    };
  });

  persistHistoryStore();
  return { snapshots: snapshots.length, tradeMonths: (trades || []).length };
}

/* ---------- the two reference uploads, and the calls made on top of them ---------- */

/** Saving is debounced: the revenue-split table writes on every keystroke that lands, and
 *  each of those would otherwise be a round trip. */
const cloudSaveTimers = {};

// Hydrating calls the same persist functions that push upwards, so without this a load
// would immediately save back what it had just read — harmless with one user, and still
// a round trip for nothing.
let cloudHydrating = false;

/* ---------- not overwriting each other ----------
 *
 * Saving used to be an upsert of the whole value, which always won. With one person that is
 * the same thing as saving. With two it is a silent overwrite of whoever did not press save
 * last — not of whoever was wrong — and it is worse than it sounds: the sign-in session
 * persists, while app_state is re-read only when somebody signs in or presses Load latest.
 * A browser can therefore sit on a week-old copy and write it back over everything that has
 * arrived since. Nothing on screen would say so, and there is no history here to recover
 * from.
 *
 * So a save is conditional on the row still being the one we read. Postgres settles who got
 * there first; a write that matches nothing means it moved, and then we read it, merge
 * against what we started from, and try again rather than insisting.
 */

/** What we last saw centrally per key: the row's updated_at, and the value as a baseline.
 *
 *  The baseline is what makes a merge possible at all. Without it a save can only say
 *  "write all of this"; with it, it can say "these are the parts I changed", and whatever
 *  else moved in the meantime survives. */
const cloudStateMeta = {};

const CLOUD_SEEN_KEY = "aum-dashboard-cloud-seen";

/** Only the timestamps are kept across reloads, never the baselines — the attribution store
 *  alone runs to well over a hundred kilobytes, and localStorage is not the place for a
 *  second copy of it. A reload therefore starts with no baseline, which the merge below
 *  reads as "I have changed nothing of theirs": the conservative answer, and the one that
 *  cannot delete somebody else's work. */
function loadCloudSeen() {
  try { return JSON.parse(localStorage.getItem(CLOUD_SEEN_KEY) || "{}"); }
  catch (e) { return {}; }
}

function rememberCloudSeen(key, updatedAt) {
  const seen = loadCloudSeen();
  seen[key] = updatedAt;
  try { localStorage.setItem(CLOUD_SEEN_KEY, JSON.stringify(seen)); }
  catch (e) { /* a full or blocked localStorage costs us the bar, not the save */ }
}

/** A baseline has to be a copy, never the store itself.
 *
 *  This was a real bug, and a quiet one: migrateAttributionStore hands back the very object
 *  it was given when the shape is already current, so `baseline = row.value` and the live
 *  store were one object. Every edit then updated the baseline too, the merge concluded
 *  that nothing had been changed here, and it took the other copy wholesale — throwing away
 *  the import that triggered the save. The merge was right; what it was being asked to
 *  compare was not.
 *
 *  JSON rather than structuredClone, because JSON is exactly what gets written: a baseline
 *  that keeps something the wire would drop would compare unequal to itself a moment later. */
function cloneJson(v) {
  try { return JSON.parse(JSON.stringify(v)); }
  catch (e) { return v; }
}

function cloudStateLabel(key) {
  return { attribution: "the attribution", index_weights: "the index weights",
           sa_income: "the revenue split" }[key] || key;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function sameJson(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k]));
}

/** Three-way merge: what I started from, what I have now, what is there now.
 *
 *  Decided key by key down the tree. A key I have not touched takes theirs, their removal of
 *  it included; a key they have not touched takes mine, my removal included. Only a key we
 *  both changed has to be judged, and there mine wins — but the path is recorded, so "we
 *  both edited that" gets reported rather than settled in silence.
 *
 *  Arrays are leaves. Every array in these stores — the file names, a fund's holding rows —
 *  is rewritten whole, so merging them item by item would produce a state neither of us
 *  ever had. */
function threeWayMerge(base, mine, theirs, clashes, path) {
  if (!isPlainObject(mine) || !isPlainObject(theirs)) {
    if (sameJson(mine, base)) return theirs;
    if (!sameJson(theirs, base) && path) clashes.push(path);
    return mine;
  }
  const out = {};
  const b = isPlainObject(base) ? base : {};
  new Set([...Object.keys(b), ...Object.keys(mine), ...Object.keys(theirs)]).forEach(k => {
    const mv = mine[k], tv = theirs[k], bv = b[k];
    const here = path ? `${path}.${k}` : k;
    const iMoved = !sameJson(mv, bv);
    const theyMoved = !sameJson(tv, bv);
    if (!iMoved) { if (tv !== undefined) out[k] = tv; return; }
    if (!theyMoved) { if (mv !== undefined) out[k] = mv; return; }
    // both of us moved it, and a removal on either side cannot be merged any further, so it
    // is a clash and mine stands
    if (mv === undefined || tv === undefined) {
      clashes.push(here);
      if (mv !== undefined) out[k] = mv;
      return;
    }
    out[k] = threeWayMerge(bv, mv, tv, clashes, here);
  });
  return out;
}

function cloudSaveState(key, value, delay = 1500) {
  if (!getCloudClient() || cloudHydrating) return;
  clearTimeout(cloudSaveTimers[key]);
  cloudSaveTimers[key] = setTimeout(() => cloudWriteState(key, value), delay);
}

async function cloudWriteState(key, value, attempt = 0) {
  const c = getCloudClient();
  if (!c) return;
  try {
    const session = await cloudSession();
    if (!session) return;                    // signed out: localStorage still has it

    const meta = cloudStateMeta[key];
    const stamp = new Date().toISOString();

    // nothing read this session, so there is no row we can honestly claim to be updating:
    // go the long way round and merge onto whatever is there
    if (!meta || !meta.updatedAt) return await cloudMergeAndWrite(key, value, stamp, attempt);

    const { data, error } = await c.from("app_state")
      .update({ value, updated_at: stamp })
      .eq("key", key).eq("updated_at", meta.updatedAt)
      .select("key,updated_at");
    if (error) throw new Error(error.message);
    if (data && data.length) {
      cloudStateMeta[key] = { updatedAt: data[0].updated_at, baseline: cloneJson(value) };
      rememberCloudSeen(key, data[0].updated_at);
      return;
    }
    // matched nothing: the row moved under us, or there is no row yet
    await cloudMergeAndWrite(key, value, stamp, attempt);
  } catch (e) {
    console.error(`Could not save ${key} centrally`, e.message || e);
    if (typeof showToast === "function") {
      showToast(`Could not save ${cloudStateLabel(key)} centrally. It is still in this browser.`);
    }
  }
}

async function cloudMergeAndWrite(key, mine, stamp, attempt) {
  const c = getCloudClient();
  const { data, error } = await c.from("app_state").select("key,value,updated_at").eq("key", key);
  if (error) throw new Error(error.message);
  const row = (data || [])[0];

  if (!row) {
    const { error: insErr } = await c.from("app_state").insert({ key, value: mine, updated_at: stamp });
    if (insErr) {
      // somebody inserted it between our read and our insert: round again
      if (attempt < 2) return cloudWriteState(key, mine, attempt + 1);
      throw new Error(insErr.message);
    }
    cloudStateMeta[key] = { updatedAt: stamp, baseline: cloneJson(mine) };
    rememberCloudSeen(key, stamp);
    return;
  }

  const clashes = [];
  const baseline = (cloudStateMeta[key] || {}).baseline || {};
  const merged = threeWayMerge(baseline, mine, row.value, clashes, "");

  // Before the write, not after: whatever goes up is what everybody else will read. A
  // window's file list is derived from the funds in it, so a merge cannot leave it
  // recording one of the two files that went into it.
  if (key === "attribution" && typeof reconcileAttributionFiles === "function") {
    reconcileAttributionFiles(merged);
  }

  const { data: wrote, error: upErr } = await c.from("app_state")
    .update({ value: merged, updated_at: stamp })
    .eq("key", key).eq("updated_at", row.updated_at)
    .select("key,updated_at");
  if (upErr) throw new Error(upErr.message);
  if (!wrote || !wrote.length) {
    if (attempt < 2) return cloudWriteState(key, mine, attempt + 1);
    throw new Error("the shared copy kept changing while this was saving");
  }

  // merged shares its subtrees with the live store, so this is copied for the same reason
  cloudStateMeta[key] = { updatedAt: wrote[0].updated_at, baseline: cloneJson(merged) };
  rememberCloudSeen(key, wrote[0].updated_at);
  applyMergedState(key, merged, clashes);
}

/** Put a value where the dashboard reads it, and redraw what shows it.
 *
 *  Two callers want this and want opposite things from the save that follows. A merge has
 *  already been written, so its persist must not bounce straight back up — hence `save`
 *  false, which borrows the hydrating flag. A restore has been written nowhere yet, so its
 *  persist is the whole point. */
function adoptStateValue(key, value, { save }) {
  const quiet = !save;
  if (quiet) cloudHydrating = true;
  try {
    if (key === "attribution" && typeof attributionStore !== "undefined") {
      attributionStore = typeof migrateAttributionStore === "function"
        ? migrateAttributionStore(value) : value;
      // each window's file list is derived from its funds, so neither a merge nor a restore
      // of an older shape can leave it recording the wrong files
      if (typeof reconcileAttributionFiles === "function") reconcileAttributionFiles(attributionStore);
      persistAttribution();
      if (typeof renderAttributionSourceList === "function") renderAttributionSourceList();
      if (typeof renderAttributionSection === "function") renderAttributionSection();
    } else if (key === "index_weights" && typeof indexWeightsStore !== "undefined") {
      indexWeightsStore = value;
      persistIndexWeights();
      if (typeof renderIndexWeightsSourceList === "function") renderIndexWeightsSourceList();
      if (typeof renderActiveShareSection === "function") renderActiveShareSection();
    } else if (key === "sa_income" && typeof saIncStore !== "undefined") {
      saIncStore = value;
      persistSaIncStore();
      if (typeof renderSaIncomeSourceList === "function") renderSaIncomeSourceList();
      if (typeof renderGicsSourceList === "function") renderGicsSourceList();
      if (typeof renderLookThroughSection === "function") renderLookThroughSection();
      if (typeof renderBreakdownSection === "function") renderBreakdownSection();
    } else {
      return false;
    }
  } finally {
    if (quiet) cloudHydrating = false;
  }
  return true;
}

/** Put the merge back where the dashboard reads it, and say that it happened.
 *
 *  Two reasons, and the second is the one that bites: the screen would otherwise show this
 *  browser's version while the shared copy holds the merge, and the next save would then be
 *  computed against a baseline that was never written anywhere. */
function applyMergedState(key, merged, clashes) {
  adoptStateValue(key, merged, { save: false });
  if (typeof showToast !== "function") return;
  const label = cloudStateLabel(key);
  showToast(clashes.length
    ? `Somebody else had changed ${label} too. Both sets were kept, and yours was used `
      + `where the two overlapped.`
    : `Somebody else had changed ${label} too. Both sets were kept.`);
}

/* ---------- earlier versions ----------
 *
 * Every value replaced in app_state is kept by a trigger; see
 * scripts/supabase_app_state_history.sql. Restoring is not a special operation on the
 * database — it is an ordinary save of a value that was read from there, so it goes through
 * the same conditional write as any other change and merges the same way if somebody else
 * has moved in the meantime.
 */

/** The versions kept for a key, newest first, without their values.
 *
 *  Without, deliberately: twenty versions of the index weights is several megabytes, and a
 *  list only has to say when, how large and by whom. A value is fetched one at a time, when
 *  somebody actually asks for one. */
async function cloudStateVersions(key) {
  const c = getCloudClient();
  if (!c) return [];
  const { data, error } = await c.from("app_state_history")
    .select("id,key,live_from,replaced_at,bytes,replaced_by_email")
    .eq("key", key)
    .order("replaced_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

async function cloudStateVersionValue(id) {
  const c = getCloudClient();
  if (!c) throw new Error("not signed in");
  const { data, error } = await c.from("app_state_history").select("value").eq("id", id);
  if (error) throw new Error(error.message);
  if (!data || !data.length) throw new Error("that version is no longer kept");
  return data[0].value;
}

/** Whether the history table is there at all, so the dashboard can say "run the script"
 *  rather than "something went wrong" on a project where it has not been run yet. */
async function cloudHistoryAvailable() {
  const c = getCloudClient();
  if (!c) return false;
  const { error } = await c.from("app_state_history").select("id").limit(1);
  return !error;
}

/** When each shared upload was last written centrally. Three rows, no values. */
async function cloudStateUpdatedAt() {
  const c = getCloudClient();
  if (!c) return {};
  const { data, error } = await c.from("app_state").select("key,updated_at");
  if (error) return {};
  const out = {};
  (data || []).forEach(r => { out[r.key] = r.updated_at; });
  return out;
}

/** Pull both back down. Returns what it found, so the caller can say so rather than
 *  leaving someone wondering whether an empty look-through means it failed. */
async function cloudLoadState() {
  const c = getCloudClient();
  if (!c) return { saIncome: false, indexWeights: false, attribution: false };
  const { data, error } = await c.from("app_state").select("key,value,updated_at");
  if (error) throw new Error(error.message);

  const found = { saIncome: false, indexWeights: false, attribution: false };
  cloudHydrating = true;
  (data || []).forEach(row => {
    // what was read and when: the two things a later save needs in order to write without
    // overwriting anybody, and the timestamp the stale bar compares against
    cloudStateMeta[row.key] = { updatedAt: row.updated_at, baseline: cloneJson(row.value) };
    rememberCloudSeen(row.key, row.updated_at);
    if (row.key === "sa_income" && row.value && typeof saIncStore !== "undefined") {
      saIncStore = { ...saIncStore, ...row.value };
      persistSaIncStore();
      found.saIncome = true;
    }
    if (row.key === "index_weights" && row.value && typeof indexWeightsStore !== "undefined") {
      indexWeightsStore = { ...indexWeightsStore, ...row.value };
      persistIndexWeights();
      found.indexWeights = true;
    }
    // Replaced outright rather than merged. The store holds every window keyed by window,
    // so a shallow merge would keep windows this browser had and the central copy no longer
    // does — resurrecting whatever someone deleted there, on every sign-in.
    if (row.key === "attribution" && row.value && typeof attributionStore !== "undefined") {
      // through the migration, not straight in: a value saved before the store held several
      // windows has no `periods` at all, and assigning it raw leaves every reader looking at
      // a shape that is simply empty — the whole saved set gone without a word.
      attributionStore = typeof migrateAttributionStore === "function"
        ? migrateAttributionStore(row.value) : row.value;
      persistAttribution();
      found.attribution = true;
    }
  });
  cloudHydrating = false;
  return found;
}
