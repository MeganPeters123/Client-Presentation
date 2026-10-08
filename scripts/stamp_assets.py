"""Stamp index.html's own css/js tags with the content hash of each file.

Why this exists: every push ended with "Ctrl+F5 to pick it up". GitHub Pages serves the
HTML fresh but lets the browser and the CDN hold the assets, so a plain refresh kept
running yesterday's app.js against today's page. Telling someone to hard-refresh works
until the once they forget, and then they are looking at stale numbers believing they are
current — which is worse than an obvious error.

A query string that changes only when the file changes fixes it at the source: the browser
treats js/app.js?v=a1b2c3d4 as a different URL, so a changed file is always fetched and an
unchanged one is still served from cache.

Run before committing:

    python scripts/stamp_assets.py

It rewrites index.html in place and reports what moved. Safe to run repeatedly — stamping
an already-stamped file with unchanged contents is a no-op. CDN tags are left alone; they
carry their own version in the path.
"""

import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"

# only our own assets — a tag whose href/src starts with a scheme or // is somebody else's
ASSET = re.compile(r'(?P<attr>(?:src|href))="(?P<path>(?!https?:|//)[^"?]+\.(?:js|css))(?:\?v=[0-9a-f]+)?"')


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:8]


def main() -> int:
    if not INDEX.exists():
        print(f"no index.html at {INDEX}", file=sys.stderr)
        return 1

    html = INDEX.read_text(encoding="utf-8")
    missing, stamped = [], []

    def replace(m: re.Match) -> str:
        rel = m.group("path")
        target = ROOT / rel
        if not target.exists():
            missing.append(rel)
            return m.group(0)
        stamped.append(rel)
        return f'{m.group("attr")}="{rel}?v={digest(target)}"'

    updated = ASSET.sub(replace, html)

    if missing:
        print("referenced but not on disk — left untouched:")
        for rel in missing:
            print(f"   {rel}")

    if updated == html:
        print(f"{len(stamped)} asset(s) already current — nothing to write.")
        return 0

    INDEX.write_text(updated, encoding="utf-8", newline="")
    before = dict(re.findall(r'(?:src|href)="([^"?]+\.(?:js|css))\?v=([0-9a-f]+)"', html))
    after = dict(re.findall(r'(?:src|href)="([^"?]+\.(?:js|css))\?v=([0-9a-f]+)"', updated))
    print(f"stamped {len(stamped)} asset(s) in index.html:")
    for rel in stamped:
        was, now = before.get(rel), after.get(rel)
        print(f"   {rel:24} {was or '(unstamped)'} -> {now}" + ("   CHANGED" if was != now else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
