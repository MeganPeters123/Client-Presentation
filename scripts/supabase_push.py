"""Send the built history to Supabase, where the dashboard can read it signed in.

The JSON file stays the system of record and is still written exactly as before. This runs
after it, so a Supabase that is slow, down, or never set up changes nothing about the file
or the build — it reports and moves on.

The service key lives in scripts/config.json, which is gitignored, and is used only here.
It bypasses row-level security, which is why it never reaches the browser: the page reads
with the publishable key and a login, under policies that allow a signed-in user to select
and nobody at all to write.
"""

import json
import urllib.error
import urllib.request

BATCH = 25          # ~60 holdings a row, so a few hundred KB per request
TIMEOUT = 60


def configured(config) -> bool:
    sb = (config or {}).get("supabase") or {}
    key = sb.get("service_key") or ""
    return bool(sb.get("url")) and bool(key) and "PASTE" not in key


def _post(url, key, path, rows, on_conflict):
    body = json.dumps(rows).encode("utf-8")
    req = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/{path}?on_conflict={on_conflict}",
        data=body, method="POST")
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    # a rebuild rewrites months it has already sent, so rows are merged rather than rejected
    req.add_header("Prefer", "resolution=merge-duplicates,return=minimal")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.status


def _send(url, key, path, rows, on_conflict, label):
    sent = 0
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        try:
            _post(url, key, path, chunk, on_conflict)
            sent += len(chunk)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            print(f"   {label}: stopped after {sent} of {len(rows)} — HTTP {e.code} {detail}")
            return sent, False
        except Exception as e:                                   # network, DNS, timeout
            print(f"   {label}: stopped after {sent} of {len(rows)} — {e}")
            return sent, False
    return sent, True


def push(config, periods=None, trades=None):
    """Upsert whatever is given. Returns True only if everything asked for arrived."""
    if not configured(config):
        return None                                              # not set up; nothing to say
    sb = config["supabase"]
    url, key = sb["url"], sb["service_key"]

    print("\n" + "-" * 78)
    print(f"SUPABASE  {url}")

    ok = True
    if periods:
        rows = []
        for pkey, snap in periods.items():
            fund, period = pkey.split("|", 1)
            rows.append({
                "fund": fund,
                "period": period,
                "fund_code": snap.get("fundCode"),
                "as_of": (snap.get("asOf") or "")[:10] or None,
                "total": snap.get("total"),
                "segments": snap.get("segments") or [],
                "holdings": snap.get("holdings") or [],
                "source": snap.get("source"),
                "format": snap.get("format"),
            })
        sent, good = _send(url, key, "snapshots", rows, "fund,period", "snapshots")
        print(f"   snapshots      {sent} of {len(rows)}")
        ok = ok and good

    if trades:
        rows = [{"period": period,
                 "by_class": entry.get("byClass") or {},
                 "by_source": entry.get("bySource") or {}}
                for period, entry in trades.items()]
        sent, good = _send(url, key, "trade_activity", rows, "period", "trade activity")
        print(f"   trade activity {sent} of {len(rows)}")
        ok = ok and good

    print("   " + ("the dashboard can read this once you sign in"
                   if ok else "NOT fully sent — the .json file is still correct, so import that"))
    return ok
