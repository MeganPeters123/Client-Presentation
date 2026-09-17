"""Build the dashboard's Fund Holdings history from the monthly valuation exports.

Finds the month-end valuation file for each fund across the configured source folders,
parses it, and writes a single history .json that the dashboard imports directly
(Data panel -> "Import history"). Backfills many months in one run.

Usage:
    python build_history.py --from 2025-07 --to 2026-08
    python build_history.py --from 2026-08 --to 2026-08 --dry-run
    python build_history.py --from 2025-07 --to 2026-08 --archive

Config lives in scripts/config.json (gitignored — it holds internal network paths).
Copy config.example.json to config.json and edit the paths.
"""

import argparse
import calendar
import json
import re
import shutil
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from holdings_parsers import parse_holdings_file  # noqa: E402

CONFIG_PATH = Path(__file__).parent / "config.json"

FILENAME_DATE_PATTERNS = [
    re.compile(r"(\d{4})\.(\d{2})\.(\d{2})"),          # 2026.08.31 - Balanced.XLS
    re.compile(r"_(\d{4})(\d{2})(\d{2})(?:[._]|$)"),   # ADMIN_D_00000_IPD_Daily_20260831.xls
]


def load_config():
    if not CONFIG_PATH.exists():
        sys.exit(f"Missing {CONFIG_PATH}.\nCopy config.example.json to config.json and set your paths.")
    with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def month_key(d):
    return f"{d.year:04d}-{d.month:02d}"


def month_range(from_key, to_key):
    y, m = (int(x) for x in from_key.split("-"))
    ty, tm = (int(x) for x in to_key.split("-"))
    out = []
    while (y, m) <= (ty, tm):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def last_day_of_month(key):
    y, m = (int(x) for x in key.split("-"))
    return date(y, m, calendar.monthrange(y, m)[1])


def last_weekday_of_month(key):
    d = last_day_of_month(key)
    while d.weekday() >= 5:  # Sat=5, Sun=6
        d = date.fromordinal(d.toordinal() - 1)
    return d


def filename_date(name):
    for pattern in FILENAME_DATE_PATTERNS:
        m = pattern.search(name)
        if m:
            try:
                return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                continue
    return None


def discover_candidates(config, months, lookback_days, lookahead_days):
    """Collect files worth parsing: those dated near a target month-end, plus any
    file we can't date from its name (few, and cheap to just try).

    The window runs both ways around month-end. Some exports are written on the next
    business day (e.g. '2026.09.01 - Equity Valuation.CSV' holds the 31 Aug valuation),
    so filtering on the filename's month alone would silently drop them."""
    windows = []
    for key in months:
        end = last_day_of_month(key)
        windows.append((date.fromordinal(end.toordinal() - lookback_days),
                        date.fromordinal(end.toordinal() + lookahead_days)))

    excludes = [e.lower() for e in config.get("exclude_name_contains", [])]
    seen, candidates = set(), []

    for source in config["sources"]:
        root = Path(source["root"])
        if not root.exists():
            print(f"  ! source folder not found, skipping: {root}")
            continue
        pattern = source.get("glob", "*")
        for path in root.glob(pattern):
            if not path.is_file() or path.resolve() in seen:
                continue
            if any(x in path.name.lower() for x in excludes):
                continue
            fdate = filename_date(path.name)
            if fdate is not None and not any(lo <= fdate <= hi for lo, hi in windows):
                continue
            seen.add(path.resolve())
            candidates.append(path)

    return candidates


SERIES_KEY_PATTERNS = [
    re.compile(r"^\d{4}\.\d{2}\.\d{2}\s*-\s*(.+?)\.[A-Za-z]+$"),   # 2026.08.31 - Balanced.XLS -> Balanced
    re.compile(r"^(.*?)_\d{8}(?:[._].*)?$", re.I),                  # ADMIN_D_00000_IPD_Daily_20260831.xls
]


def series_key(name):
    """Group files that are the same daily report repeated over time, so we only need to
    open the newest one in each month rather than every day's copy."""
    for pattern in SERIES_KEY_PATTERNS:
        m = pattern.match(name)
        if m:
            return m.group(1).strip().lower()
    return Path(name).stem.lower()


def build(config, months, lookback_days, lookahead_days, verbose):
    candidates = discover_candidates(config, months, lookback_days, lookahead_days)

    series, undated = {}, []
    for path in candidates:
        fdate = filename_date(path.name)
        if fdate is None:
            undated.append(path)
        else:
            series.setdefault(series_key(path.name), []).append((fdate, path))
    for files in series.values():
        files.sort(key=lambda t: t[0], reverse=True)

    print(f"{len(candidates)} candidate file(s) across {len(series)} report series "
          f"(+{len(undated)} undated) — opening only the newest per fund per month.\n")

    wanted = set(months)
    best = {}      # (fund, month) -> snapshot
    problems = []
    parsed_count = 0

    overrides = config.get("fund_name_overrides", {})
    skip_funds = {f.lower() for f in config.get("exclude_funds", [])}
    cat_map = {k.lower(): v for k, v in config.get("category_overrides", {}).items()}
    seen_categories = set()

    def read(path):
        """Parse a file into usable snapshots, recording anything that errored."""
        usable = []
        for snap in parse_holdings_file(path):
            if "error" in snap:
                problems.append(f"{snap['source']}: {snap['error']}")
                continue
            if not (snap.get("asOf") and snap.get("total")):
                continue
            # some sources only carry a portfolio code — give it the name you present under
            snap["fund"] = overrides.get(snap["fund"], snap["fund"])
            if snap["fund"].lower() in skip_funds:
                continue
            # Different source systems name the same exposure differently ("SA Bonds" vs
            # "SA Fixed Income"). Fold them onto one house label, then merge duplicates.
            merged = {}
            for seg in snap["segments"]:
                seen_categories.add(seg["category"])
                label = cat_map.get(seg["category"].lower(), seg["category"])
                merged[label] = merged.get(label, 0.0) + seg["value"]
            snap["segments"] = [{"category": c, "value": v} for c, v in merged.items()]
            usable.append(snap)
        return usable

    def absorb(snap, path, restrict_to=None):
        """Record a snapshot if it lands in a month we want. Returns True if it did."""
        key = month_key(snap["asOf"])
        if key not in wanted or (restrict_to and key != restrict_to):
            return False
        snap["path"] = str(path)
        slot = (snap["fund"], key)
        if slot not in best or snap["asOf"] > best[slot]["asOf"]:
            best[slot] = snap
            if verbose:
                print(f"  {snap['fund']:38} {key}  {snap['asOf']}  {path.name}")
        return True

    for key, files in series.items():
        # Give up on a series only when its files don't parse as holdings at all (prices,
        # settlements, cash...). A file landing in a different month is normal, not a failure.
        unparseable, productive = 0, False
        for month in months:
            if not productive and unparseable >= 3:
                break
            end = last_day_of_month(month)
            lo = date.fromordinal(end.toordinal() - lookback_days)
            hi = date.fromordinal(end.toordinal() + lookahead_days)
            for fdate, path in files:                     # newest first
                if not (lo <= fdate <= hi):
                    continue
                parsed_count += 1
                snaps = read(path)
                if not snaps:
                    unparseable += 1
                    if not productive and unparseable >= 3:
                        break
                    continue
                productive = True
                if any(absorb(s, path, restrict_to=month) for s in snaps):
                    break                                  # newest match for this month wins

    for path in undated:                                   # few; just try them all
        parsed_count += 1
        for snap in read(path):
            absorb(snap, path)

    print(f"\nOpened {parsed_count} file(s).")
    unmapped = sorted(c for c in seen_categories if c.lower() not in cat_map)
    return best, problems, unmapped


def report(best, months):
    funds = sorted({fund for fund, _ in best})
    print("\n" + "=" * 78)
    print("RESOLVED MONTH-END PER FUND")
    print("=" * 78)
    if not funds:
        print("No snapshots resolved — check source paths and the month range.")
        return

    flagged = []
    for fund in funds:
        print(f"\n{fund}")
        for key in months:
            snap = best.get((fund, key))
            if not snap:
                print(f"   {key}   —  (no file found)")
                continue
            # Some funds strike NAV on the last calendar day even when it's a weekend, others
            # on the last business day — both are fine. Only flag falling short of both.
            expected = last_weekday_of_month(key)
            stale = snap["asOf"] < expected
            mark = f"  <-- expected {expected}" if stale else ""
            if stale:
                flagged.append((fund, key, snap["asOf"], expected))
            print(f"   {key}   {snap['asOf']}   R {snap['total']:>18,.2f}   {snap['source']}{mark}")

    if flagged:
        print("\n" + "-" * 78)
        print("CHECK THESE — resolved date is earlier than the last business day of the month.")
        print("Either the month-end file is missing from the archive, or it was a public holiday.")
        for fund, key, got, expected in flagged:
            print(f"   {fund:38} {key}  used {got}, expected {expected}")


def report_categories(best, unmapped):
    """Show what each asset-class label is worth, so mis-bucketed or duplicate categories
    are obvious before the numbers reach a client deck."""
    totals = {}
    for snap in best.values():
        for seg in snap["segments"]:
            totals[seg["category"]] = totals.get(seg["category"], 0.0) + seg["value"]
    if not totals:
        return
    print("\n" + "=" * 78)
    print("ASSET CATEGORIES IN THE OUTPUT (after mapping)")
    print("=" * 78)
    for cat, value in sorted(totals.items(), key=lambda kv: -kv[1]):
        print(f"   {cat:52} R {value:>18,.2f}")
    if unmapped:
        print("\nPassing through as-is (no category_overrides entry). Fine if these are the labels")
        print("you want on a slide — add them to config.json if any should fold into another:")
        for cat in unmapped:
            print(f"   {cat}")


def write_history(best, out_path):
    periods = {}
    for (fund, key), snap in best.items():
        periods[f"{fund}|{key}"] = {
            "fund": fund,
            "fundCode": snap.get("fundCode"),
            "period": key,
            # local noon keeps the month stable regardless of the reader's timezone
            "asOf": snap["asOf"].strftime("%Y-%m-%dT12:00:00"),
            "total": round(snap["total"], 2),
            "segments": [{"category": s["category"], "value": round(s["value"], 2)} for s in snap["segments"]],
            # position level, for Top 10 Holdings and Portfolio Changes. Kept lean — this is
            # ~60 rows per fund per month and would otherwise dominate the file.
            "holdings": [{
                "name": h["name"], "ticker": h.get("ticker", ""), "category": h.get("category", ""),
                # currency decides JSE-listed vs offshore for the look-through split
                "ccy": h.get("ccy", ""),
                "pct": round(h.get("pct") or 0.0, 4), "value": round(h.get("value") or 0.0, 2),
            } for h in snap.get("holdings", [])],
            "source": snap["source"],
            "format": snap["format"],
            "savedAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"periods": periods}, fh, indent=2)
    return len(periods)


def archive_files(best, archive_dir):
    """Copy each source file used into archive/<YYYY-MM>/ — a durable record of exactly
    what each month's numbers were built from."""
    copied = 0
    for (_, key), snap in best.items():
        src = snap.get("path")
        if not src:
            continue
        dest_dir = Path(archive_dir) / key
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / Path(src).name
        if not dest.exists():
            shutil.copy2(src, dest)
            copied += 1
    return copied


def main():
    ap = argparse.ArgumentParser(description="Build Fund Holdings history from monthly valuation exports.")
    ap.add_argument("--from", dest="from_month", required=True, help="First month, YYYY-MM")
    ap.add_argument("--to", dest="to_month", required=True, help="Last month, YYYY-MM")
    ap.add_argument("--lookback-days", type=int, default=8,
                    help="How many days before month-end to consider (default 8, covers long weekends)")
    ap.add_argument("--lookahead-days", type=int, default=5,
                    help="How many days after month-end to consider (default 5 — some exports are written the next business day)")
    ap.add_argument("--dry-run", action="store_true", help="Report only, don't write the history file")
    ap.add_argument("--archive", action="store_true", help="Also copy the source files used into the archive folder")
    ap.add_argument("--quiet", action="store_true", help="Don't list every file as it's parsed")
    args = ap.parse_args()

    config = load_config()
    months = month_range(args.from_month, args.to_month)
    print(f"Building history for {len(months)} month(s): {months[0]} .. {months[-1]}\n")

    best, problems, unmapped = build(config, months, args.lookback_days, args.lookahead_days, verbose=not args.quiet)
    report(best, months)
    report_categories(best, unmapped)

    if problems:
        print("\n" + "-" * 78)
        print(f"{len(problems)} file(s) could not be used:")
        for p in problems[:25]:
            print(f"   {p}")
        if len(problems) > 25:
            print(f"   ... and {len(problems) - 25} more")

    if args.dry_run:
        print(f"\nDry run — nothing written. Would have written {len(best)} snapshot(s).")
        return

    out_path = Path(config["output"])
    count = write_history(best, out_path)
    print(f"\nWrote {count} snapshot(s) to {out_path}")
    print('Import it in the dashboard: Data panel -> "Import history".')

    if args.archive and config.get("archive_dir"):
        copied = archive_files(best, config["archive_dir"])
        print(f"Archived {copied} source file(s) to {config['archive_dir']}")


if __name__ == "__main__":
    main()
