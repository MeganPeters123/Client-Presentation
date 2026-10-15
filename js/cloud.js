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
    historyStore.periods[`${r.fund}|${r.period}`] = {
      fund: r.fund,
      fundCode: r.fund_code,
      period: r.period,
      asOf: r.as_of ? new Date(`${r.as_of}T12:00:00`) : null,
      total: Number(r.total),
      segments: r.segments || [],
      holdings: r.holdings || [],
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
      bySource: r.by_source || {}
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

function cloudSaveState(key, value, delay = 1500) {
  if (!getCloudClient() || cloudHydrating) return;
  clearTimeout(cloudSaveTimers[key]);
  cloudSaveTimers[key] = setTimeout(async () => {
    try {
      const session = await cloudSession();
      if (!session) return;                    // signed out: localStorage still has it
      const { error } = await getCloudClient()
        .from("app_state")
        .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
      if (error) console.error(`Could not save ${key} centrally`, error.message);
    } catch (e) {
      console.error(`Could not save ${key} centrally`, e);
    }
  }, delay);
}

/** Pull both back down. Returns what it found, so the caller can say so rather than
 *  leaving someone wondering whether an empty look-through means it failed. */
async function cloudLoadState() {
  const c = getCloudClient();
  if (!c) return { saIncome: false, indexWeights: false };
  const { data, error } = await c.from("app_state").select("key,value");
  if (error) throw new Error(error.message);

  const found = { saIncome: false, indexWeights: false };
  cloudHydrating = true;
  (data || []).forEach(row => {
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
  });
  cloudHydrating = false;
  return found;
}
