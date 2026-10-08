"""The month's dashboard refresh, as one run.

Rebuilds the holdings history and the trade activity into the file the dashboard imports,
in that order, after showing what it is about to do and asking.

Why it exists: the two builds have to be run together and in a particular way. The holdings
build takes a month range and writes exactly that range, so asking it for one month replaces
the history with one month — the range below is therefore always the whole span. The trades
build merges into the same file. Getting either of those wrong is quiet rather than loud,
which is the kind of mistake worth taking out of someone's hands.

Double-click "Update Dashboard Data.bat", or:

    python scripts/monthly_update.py                 # asks before writing
    python scripts/monthly_update.py --yes           # no prompt
    python scripts/monthly_update.py --to 2026-08    # rebuild as at an earlier month
"""

import argparse
import json
import subprocess
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
DEFAULT_START = "2024-09"


def month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def last_complete_month(today: date | None = None) -> str:
    """The month before this one. A month still running has no month-end to resolve."""
    today = today or date.today()
    year, month = (today.year - 1, 12) if today.month == 1 else (today.year, today.month - 1)
    return f"{year:04d}-{month:02d}"


def saved_span(output_path: Path) -> tuple[str, str] | None:
    """What the existing history covers, so a rebuild spans everything it already had
    rather than silently shortening the series."""
    if not output_path.exists():
        return None
    try:
        with open(output_path, "r", encoding="utf-8") as fh:
            periods = json.load(fh).get("periods", {})
    except (OSError, ValueError):
        return None
    months = sorted(k.split("|", 1)[1] for k in periods if "|" in k)
    return (months[0], months[-1]) if months else None


def run(script: str, *args: str) -> int:
    cmd = [sys.executable, str(HERE / script), *args]
    print(f"\n$ {script} {' '.join(args)}\n" + "-" * 78)
    # the child writes straight to the console while our own prints sit in Python's buffer,
    # so without this the report appears above the explanation of what it is
    sys.stdout.flush()
    return subprocess.run(cmd, cwd=str(HERE.parent)).returncode


def main() -> int:
    ap = argparse.ArgumentParser(description="Rebuild the dashboard's history and trade activity.")
    ap.add_argument("--from", dest="from_month", help=f"first month (default: the existing history's start, else {DEFAULT_START})")
    ap.add_argument("--to", dest="to_month", help="last month (default: the last complete month)")
    ap.add_argument("--yes", action="store_true", help="don't ask before writing")
    args = ap.parse_args()

    if not CONFIG.exists():
        print("scripts/config.json is missing — copy config.example.json and set the paths.")
        return 1
    with open(CONFIG, "r", encoding="utf-8") as fh:
        output = Path(json.load(fh)["output"])

    span = saved_span(output)
    to_month = args.to_month or last_complete_month()
    from_month = args.from_month or (span[0] if span else None) or DEFAULT_START
    if from_month > to_month:
        print(f"Nothing to do: history already starts at {from_month}, after {to_month}.")
        return 1

    print("=" * 78)
    print("DASHBOARD DATA REFRESH")
    print("=" * 78)
    print(f"  months   {from_month} .. {to_month}")
    print(f"  writes   {output}")
    print("\nThe whole span is rebuilt, not just the newest month — the holdings build writes")
    print("exactly the range it is given, so a shorter range would shorten the history.")

    # which is exactly why asking for an earlier end has to be said out loud
    if span and to_month < span[1]:
        print("\n" + "!" * 78)
        print(f"  The saved history runs to {span[1]}, and this run ends at {to_month}.")
        print(f"  Everything after {to_month} will be dropped from the file.")
        print("!" * 78)

    print("\nChecking what the sources hold. Nothing is written yet.")

    if run("build_history.py", "--from", from_month, "--to", to_month, "--dry-run", "--quiet"):
        print("\nThe check failed. Nothing was written.")
        return 1

    print("\n" + "=" * 78)
    print("Read the report above — especially any CHECK THESE or LOOK AT THESE lines.")
    if not args.yes:
        try:
            if input("\nWrite the history and rebuild the trades? [y/N] ").strip().lower() not in ("y", "yes"):
                print("Nothing written.")
                return 0
        except EOFError:
            print("\nNo answer given, so nothing was written. Re-run with --yes to skip the prompt.")
            return 1

    if run("build_history.py", "--from", from_month, "--to", to_month, "--quiet"):
        print("\nThe holdings build failed. The trades were left alone.")
        return 1

    # must follow the holdings build: that one rewrites the file, this one merges into it
    if run("build_trades.py"):
        print("\nThe holdings are written, but the trade activity failed to rebuild.")
        print("Fix the trade reports and run build_trades.py again — the holdings are fine.")
        return 1

    print("\n" + "=" * 78)
    print("DONE")
    print("=" * 78)
    print(f"  {output}")
    print("\nIn the dashboard: open Data, then Import history, and pick that file.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
