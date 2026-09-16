"""Build monthly trade activity from the saved trade reports.

Reads the Trades History folder (one dated file per source per month), classifies each
row into an asset class (Equity / Bond / ...) and an action (Buy / Sell / Corporate
Action / ...), and writes a per-month summary into the dashboard's history file.

Usage:
    python build_trades.py --report                 # classify and show the breakdown, write nothing
    python build_trades.py --from 2026-08 --to 2026-08
    python build_trades.py --from 2025-06 --to 2026-08

Anything it can't classify is listed with its value and row count rather than being
folded into a bucket — a wrong guess here would silently misstate trading activity.
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from trade_parsers import classify, parse_trade_file  # noqa: E402

CONFIG_PATH = Path(__file__).parent / "config.json"

# Accepts a single month, a range, or no date at all — the month each row belongs to always
# comes from its own trade date, so the filename is only a label and a sanity check:
#   "2026.08 - Trades Report Apex.xlsx"
#   "2025.06-2026.08 - Trades Report Apex.xlsx"
#   "Trades Report Apex.xlsx"
TRADE_FILE_RE = re.compile(
    r"^(?:(\d{4})\.(\d{2})(?:\s*-\s*(\d{4})\.(\d{2}))?\s*-\s*)?Trades Report\s+(.+?)\.xlsx?$", re.I)


def load_config():
    if not CONFIG_PATH.exists():
        sys.exit(f"Missing {CONFIG_PATH}. Copy config.example.json to config.json and set your paths.")
    with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


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


def discover_trade_files(folder):
    """Returns [(source_name, declared_range, path)] for every recognised trade report.

    declared_range is (first_month, last_month) parsed from the filename, or None — it's
    only used to sanity-check that the rows inside land where the name claims.
    """
    found, malformed = [], []
    for path in sorted(Path(folder).glob("*.xls*")):
        if path.name.startswith("~$"):        # Excel lock files
            continue
        m = TRADE_FILE_RE.match(path.name)
        if not m:
            malformed.append(path.name)
            continue
        y1, m1, y2, m2, source = m.groups()
        declared = None
        if y1:
            first = f"{y1}-{m1}"
            declared = (first, f"{y2}-{m2}" if y2 else first)
        found.append((source.strip(), declared, path))
    return found, malformed


def summarise(rows, rules):
    """Fold classified rows into per-(month, source, fund, class, action) value totals."""
    summary = defaultdict(lambda: {"value": 0.0, "count": 0})
    unknown_actions = defaultdict(lambda: {"value": 0.0, "count": 0, "sources": set()})
    unknown_classes = defaultdict(lambda: {"value": 0.0, "count": 0, "sources": set()})
    defaulted = defaultdict(lambda: {"value": 0.0, "count": 0, "sources": set(), "asset_class": ""})

    for row in rows:
        asset_class, action, used_default = classify(row, rules)
        value = abs(row["value"] or 0.0)
        if action is None:
            entry = unknown_actions[row["rawAction"] or "(blank)"]
            entry["value"] += value
            entry["count"] += 1
            entry["sources"].add(row["source"])
            continue
        if action == "Ignore":
            continue
        if asset_class is None:
            entry = unknown_classes[(row["rawType"] or row["rawAction"] or "(blank)")]
            entry["value"] += value
            entry["count"] += 1
            entry["sources"].add(row["source"])
            asset_class = "Unclassified"
        elif used_default:
            entry = defaulted[row["security"] or "(blank)"]
            entry["value"] += value
            entry["count"] += 1
            entry["sources"].add(row["source"])
            entry["asset_class"] = asset_class
        key = (row["month"], row["source"], asset_class, action)
        summary[key]["value"] += value
        summary[key]["count"] += 1

    return summary, unknown_actions, unknown_classes, defaulted


def report(summary, unknown_actions, unknown_classes, defaulted, months):
    print("\n" + "=" * 78)
    print("TRADE ACTIVITY BY MONTH")
    print("=" * 78)

    by_month = defaultdict(lambda: defaultdict(lambda: {"value": 0.0, "count": 0}))
    for (month, _source, asset_class, action), agg in summary.items():
        cell = by_month[month][(asset_class, action)]
        cell["value"] += agg["value"]
        cell["count"] += agg["count"]

    for month in months:
        if month not in by_month:
            continue
        print(f"\n{month}")
        for (asset_class, action), agg in sorted(by_month[month].items(),
                                                 key=lambda kv: (-kv[1]["value"])):
            print(f"   {asset_class:16} {action:18} R {agg['value']:>16,.2f}   ({agg['count']} rows)")

    if unknown_actions:
        print("\n" + "-" * 78)
        print("UNRECOGNISED TRANSACTION CODES — not counted anywhere yet.")
        print("Add each to trade_classification.actions in config.json ('Buy', 'Sell',")
        print("'Corporate Action', or 'Ignore' for non-trade entries like fees and dividends).")
        for code, agg in sorted(unknown_actions.items(), key=lambda kv: -kv[1]["value"]):
            srcs = ",".join(sorted(agg["sources"]))
            print(f"   {code:22} R {agg['value']:>16,.2f}  ({agg['count']} rows, {srcs})")

    if defaulted:
        print("\n" + "-" * 78)
        print("ASSET CLASS FROM THE SOURCE DEFAULT (no explicit rule matched these securities).")
        print("Check none of these belong in another bucket — add any that do to")
        print("trade_classification.securities in config.json:")
        for sec, agg in sorted(defaulted.items(), key=lambda kv: -kv[1]["value"]):
            srcs = ",".join(sorted(agg["sources"]))
            print(f"   {sec:24} -> {agg['asset_class']:14} R {agg['value']:>15,.2f}  ({agg['count']} rows, {srcs})")

    if unknown_classes:
        print("\n" + "-" * 78)
        print("RECOGNISED AS TRADES BUT ASSET CLASS UNKNOWN — counted as 'Unclassified'.")
        print("Add each to trade_classification.asset_classes in config.json.")
        for code, agg in sorted(unknown_classes.items(), key=lambda kv: -kv[1]["value"]):
            srcs = ",".join(sorted(agg["sources"]))
            label = code if code else "(blank)"
            print(f"   {label:22} R {agg['value']:>16,.2f}  ({agg['count']} rows, {srcs})")


def write_into_history(summary, history_path):
    """Merge the trade summary into the dashboard's history file under a 'trades' key,
    leaving the holdings 'periods' untouched."""
    data = {"periods": {}}
    if history_path.exists():
        with open(history_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)

    trades = {}
    for (month, source, asset_class, action), agg in summary.items():
        entry = trades.setdefault(month, {"period": month, "bySource": {}, "byClass": {}})
        src = entry["bySource"].setdefault(source, {})
        src[f"{asset_class}|{action}"] = {"value": round(agg["value"], 2), "count": agg["count"]}
        cls = entry["byClass"].setdefault(asset_class, {})
        bucket = cls.setdefault(action, {"value": 0.0, "count": 0})
        bucket["value"] = round(bucket["value"] + agg["value"], 2)
        bucket["count"] += agg["count"]

    data["trades"] = trades
    data["tradesSavedAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    history_path.parent.mkdir(parents=True, exist_ok=True)
    with open(history_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    return len(trades)


def main():
    ap = argparse.ArgumentParser(description="Build monthly trade activity from the saved trade reports.")
    ap.add_argument("--from", dest="from_month", help="First month, YYYY-MM")
    ap.add_argument("--to", dest="to_month", help="Last month, YYYY-MM")
    ap.add_argument("--report", action="store_true", help="Classify and report only; write nothing")
    args = ap.parse_args()

    config = load_config()
    folder = config.get("trades_folder")
    if not folder:
        sys.exit("Set 'trades_folder' in config.json (the Trades History folder).")

    found, malformed = discover_trade_files(folder)
    if malformed:
        print("Skipped — filename doesn't match 'YYYY.MM - Trades Report <Source>.xlsx':")
        for name in malformed:
            print(f"   {name}")
        print()
    if not found:
        sys.exit(f"No correctly-named trade reports in {folder}")

    kinds = {k.lower(): v for k, v in config.get("trade_source_kinds", {}).items()}
    rules = config.get("trade_classification", {})

    rows, missing_kind, mislabelled = [], set(), []
    for source, declared, path in found:
        kind = kinds.get(source.lower())
        if kind is None:
            missing_kind.add(source)
            continue
        parsed = parse_trade_file(path, kind, source)
        for r in parsed:
            # the row's own trade date decides its month — the filename is just a label,
            # so one multi-month export works exactly like twelve single-month files
            r["month"] = f"{r['date'].year:04d}-{r['date'].month:02d}"
        rows.extend(parsed)
        spread = sorted({r["month"] for r in parsed})
        span = f"{spread[0]} .. {spread[-1]}" if spread else "no dated rows"
        print(f"  {path.name:46} {len(parsed):>6} rows   {span}")

        if declared and spread:
            outside = [m for m in spread if m < declared[0] or m > declared[1]]
            if outside:
                mislabelled.append((path.name, declared, outside))

    if missing_kind:
        print("\nNo parser mapped for these sources — add them to trade_source_kinds in config.json")
        print("(valid kinds: apex, prescient, curo):")
        for s in sorted(missing_kind):
            print(f"   {s}")

    if mislabelled:
        print("\n" + "-" * 78)
        print("FILENAME DOESN'T MATCH THE ROWS INSIDE — the rows are used regardless, but")
        print("check you exported the period you meant to:")
        for name, declared, outside in mislabelled:
            rng = declared[0] if declared[0] == declared[1] else f"{declared[0]}..{declared[1]}"
            print(f"   {name}\n      name says {rng}, also contains {', '.join(outside)}")

    if not rows:
        sys.exit("\nNothing parsed.")

    all_months = sorted({r["month"] for r in rows})
    months = month_range(args.from_month, args.to_month) if args.from_month and args.to_month else all_months
    rows = [r for r in rows if r["month"] in months]
    if not rows:
        sys.exit(f"\nNo rows in {months[0]}..{months[-1]} — the files cover {all_months[0]}..{all_months[-1]}.")

    summary, unknown_actions, unknown_classes, defaulted = summarise(rows, rules)
    report(summary, unknown_actions, unknown_classes, defaulted, months)

    if args.report:
        print("\nReport only — nothing written.")
        return

    count = write_into_history(summary, Path(config["output"]))
    print(f"\nWrote trade activity for {count} month(s) into {config['output']}")


if __name__ == "__main__":
    main()
