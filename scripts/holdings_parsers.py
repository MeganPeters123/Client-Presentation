"""Python ports of the browser's three Fund Holdings parsers (js/holdings.js).

Each parser returns a list of snapshots in exactly the shape the dashboard's history
store uses, so output can be imported straight into the dashboard:

    {"fund", "fundCode", "asOf" (date), "total", "segments": [{"category", "value"}],
     "source", "format"}

Keep this file in step with js/holdings.js — the two must agree on category labels,
or the same fund will split into duplicate categories when consolidated.
"""

import csv
import io
import re
from datetime import date, datetime

# ---------------------------------------------------------------- shared helpers

ASSET_CLASS_ALIASES = {
    "jse-listed equity": "JSE-listed Equity", "local equity": "JSE-listed Equity",
    "sa equity": "JSE-listed Equity", "equities": "JSE-listed Equity",
    "global-listed equity": "Global-listed Equity", "foreign equity": "Global-listed Equity",
    "global equity": "Global-listed Equity", "offshore equity": "Global-listed Equity",
    "sa cash": "SA Cash", "local cash": "SA Cash", "local money market": "SA Cash", "cash": "SA Cash",
    "global cash": "Global Cash", "foreign cash": "Global Cash", "offshore cash": "Global Cash",
    "sa fixed income": "SA Fixed Income", "local fixed income": "SA Fixed Income",
    "local bonds": "SA Fixed Income", "local income": "SA Fixed Income", "fixed income": "SA Fixed Income",
    "global fixed income": "Global Fixed Income", "foreign fixed income": "Global Fixed Income",
    "foreign bonds": "Global Fixed Income", "offshore bonds": "Global Fixed Income",
    "sa property": "SA Property", "local property": "SA Property",
    "global property": "Global Property", "foreign property": "Global Property",
    "offshore property": "Global Property",
}

CATSUB_BASE_CATEGORY = {"SHS": "Equities", "CALL": "Cash", "DS": "Fixed Income", "FMT": "Fixed Income"}


def normalize_asset_class_label(label):
    key = (label or "").strip().lower()
    return ASSET_CLASS_ALIASES.get(key, (label or "").strip())


def title_case(s):
    return re.sub(r"\w\S*", lambda m: m.group(0)[0].upper() + m.group(0)[1:].lower(), s or "")


def local_foreign_label(category, side):
    cat = (category or "").strip()
    if re.match(r"^equit", cat, re.I):
        return "JSE-listed Equity" if side == "local" else "Global-listed Equity"
    return ("SA " if side == "local" else "Global ") + cat


def is_local_ccy(ccy):
    return bool(ccy) and str(ccy).strip().upper() == "ZAR"


def to_number(raw):
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    s = str(raw).strip()
    if not s:
        return None
    negative = s.startswith("(") and s.endswith(")")
    cleaned = re.sub(r"[^0-9.\-]", "", s)
    if cleaned in ("", "-", "."):
        return None
    try:
        n = float(cleaned)
    except ValueError:
        return None
    return -abs(n) if negative else n


def sniff_format(path):
    """Mirrors the browser dispatcher: classify by file signature, not extension."""
    with open(path, "rb") as fh:
        head = fh.read(8)
    if head[:2] == b"PK":
        return "xlsx"
    if head[:4] == b"\xd0\xcf\x11\xe0":
        return "ole2"
    try:
        text_head = head.decode("utf-8", errors="ignore").lstrip().lower()
    except Exception:
        return "unknown"
    if text_head.startswith("<html"):
        return "html"
    return "text"


# ------------------------------------------------- format A: custodian HTML export

def parse_custodian_html(path):
    from bs4 import BeautifulSoup

    with open(path, "rb") as fh:
        soup = BeautifulSoup(fh.read().decode("utf-8", errors="replace"), "html.parser")

    table = soup.find("table")
    if table is None:
        return []

    rows = table.find_all("tr")
    header_row = next((r for r in rows if len(r.select("td.tblh")) > 5), None)
    if header_row is None:
        return []

    col_index = {}
    for i, td in enumerate(header_row.find_all("td")):
        name = td.get_text().strip()
        if name:
            col_index[name] = i

    required = ["Clean Market Value", "Sum of Market Value Income", "% of Total Market Value", "CCY"]
    if any(name not in col_index for name in required):
        return []

    flat = []
    for r in rows:
        tds = r.find_all("td")
        if len(tds) < 10:
            continue
        cls = " ".join(tds[0].get("class", [])).strip()
        if cls not in ("cLink", "cIssue"):
            continue
        raw_label = tds[0].get_text() or ""
        nbsp = 0
        while nbsp < len(raw_label) and ord(raw_label[nbsp]) == 160:
            nbsp += 1
        level = round(nbsp / 4)

        def cell(name):
            idx = col_index.get(name)
            if idx is None or idx >= len(tds):
                return ""
            return (tds[idx].get_text() or "").replace("\xa0", " ").strip()

        flat.append({
            "level": level,
            "row_class": cls,
            "label": raw_label.replace("\xa0", " ").strip(),
            "total_value": to_number(cell("Sum of Market Value Income")),
            "pct": to_number(cell("% of Total Market Value")),
            "ccy": cell("CCY"),
        })

    if not flat:
        return []

    root = next((r for r in flat if r["level"] == 0), flat[0])
    as_of_match = re.search(r"as of\s+([\d/]+)", root["label"], re.I)
    as_of = None
    if as_of_match:
        try:
            as_of = datetime.strptime(as_of_match.group(1), "%m/%d/%Y").date()
        except ValueError:
            as_of = None
    fund_name = re.sub(r"\s+as of.*$", "", root["label"], flags=re.I).strip()
    fund_total = root["total_value"]
    if fund_total is None:
        return []

    # local/foreign split per level-2 asset class, from its level-4 leaf holdings' currency
    current_l2 = None
    split_by_class = {}
    for r in flat:
        if r["level"] == 2 and r["row_class"] == "cLink":
            current_l2 = r["label"].strip()
            split_by_class.setdefault(current_l2, {"local": 0.0, "foreign": 0.0})
        elif r["level"] == 4 and r["row_class"] == "cIssue" and current_l2:
            bucket = split_by_class[current_l2]
            side = "local" if is_local_ccy(r["ccy"]) else "foreign"
            bucket[side] += r["pct"] or 0.0

    segments = []
    for r in flat:
        if r["level"] != 2 or r["row_class"] != "cLink":
            continue
        split = split_by_class.get(r["label"].strip(), {"local": 0.0, "foreign": 0.0})
        label = title_case(r["label"])
        for side in ("local", "foreign"):
            if split[side] > 0.005:
                segments.append({
                    "category": local_foreign_label(label, side),
                    "value": (split[side] / 100.0) * fund_total,
                })

    if not segments:
        return []

    return [{
        "fund": fund_name, "fundCode": None, "asOf": as_of, "total": fund_total,
        "segments": segments, "source": path.name, "format": "Custodian HTML",
    }]


# ---------------------------------------------------- format B: flat valuation CSV

def parse_flat_csv(path):
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as fh:
        rows = list(csv.reader(fh))

    header_idx, col_index = -1, None
    for i, row in enumerate(rows[:10]):
        if row and row[0].strip().lower() == "pfolio":
            header_idx = i
            col_index = {c.strip(): j for j, c in enumerate(row) if c.strip()}
            break

    required = ["Pfolio", "SecCur", "Total Value (Pf)", "CatSub"]
    if header_idx == -1 or any(name not in col_index for name in required):
        return []

    as_of = None
    for row in rows[:header_idx]:
        if not row:
            continue
        candidate = row[0].strip()
        for fmt in ("%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y"):
            try:
                as_of = datetime.strptime(candidate, fmt).date()
                break
            except ValueError:
                continue
        if as_of:
            break

    by_fund = {}
    for row in rows[header_idx + 1:]:
        if not row or len(row) <= col_index["Total Value (Pf)"]:
            continue
        pfolio = row[col_index["Pfolio"]].strip()
        if not pfolio:
            continue
        value = to_number(row[col_index["Total Value (Pf)"]])
        if value is None:
            continue
        ccy = row[col_index["SecCur"]]
        catsub = row[col_index["CatSub"]].strip().upper()
        base = CATSUB_BASE_CATEGORY.get(catsub, "Other")
        label = local_foreign_label(base, "local" if is_local_ccy(ccy) else "foreign")

        entry = by_fund.setdefault(pfolio, {"total": 0.0, "segments": {}})
        entry["total"] += value
        entry["segments"][label] = entry["segments"].get(label, 0.0) + value

    return [{
        "fund": fund, "fundCode": None, "asOf": as_of, "total": entry["total"],
        "segments": [{"category": c, "value": v} for c, v in entry["segments"].items()],
        "source": path.name, "format": "Flat CSV",
    } for fund, entry in by_fund.items()]


# --------------------------------- format C: "Investment Portfolio Detail" .xls

MONTH_ABBR = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def parse_ipd_xls(path):
    import xlrd

    book = xlrd.open_workbook(str(path))
    sheet = book.sheet_by_index(0)
    grid = [sheet.row_values(r) for r in range(sheet.nrows)]

    meta_row = None
    for row in grid[:8]:
        if row and re.match(r"^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}\s*-\s*[A-Za-z]{3}$", str(row[0]).strip()):
            meta_row = row
            break
    if meta_row is None:
        return []

    header_idx = isin_col = holding_col = value_col = pct_cat_col = -1
    for i, row in enumerate(grid[:10]):
        idx = next((j for j, c in enumerate(row) if re.search(r"isin", str(c or ""), re.I)), -1)
        if idx != -1:
            header_idx, isin_col = i, idx
            holding_col = next((j for j, c in enumerate(row) if re.search(r"holding\s*total", str(c or ""), re.I)), -1)
            value_col = next((j for j, c in enumerate(row) if re.search(r"all\s*in\s*traded\s*market\s*value", str(c or ""), re.I)), -1)
            pct_cat_col = next((j for j, c in enumerate(row) if re.search(r"%\s*of\s*category", str(c or ""), re.I)), -1)
            break
    if -1 in (header_idx, holding_col, value_col, pct_cat_col):
        return []

    as_of = None
    dm = re.match(r"^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})", str(meta_row[0]).strip())
    if dm:
        month = MONTH_ABBR.get(dm.group(2)[:3].lower())
        if month:
            as_of = date(int(dm.group(3)), month, int(dm.group(1)))

    fund_name = str(meta_row[5] or "").strip() or path.stem
    fund_code = next((str(c).strip() for c in meta_row[6:] if c not in ("", None)), None)
    if fund_code and fund_code.endswith(".0"):
        fund_code = fund_code[:-2]

    segments = []
    for row in grid[header_idx + 1:]:
        if not row:
            continue
        label = str(row[0] or "").strip()
        if not label:
            continue
        isin = str(row[isin_col] or "").strip() if isin_col < len(row) else ""
        holding_total = row[holding_col] if holding_col < len(row) else ""
        pct_category = to_number(row[pct_cat_col]) if pct_cat_col < len(row) else None
        # a top-level asset class is 100% of its own category, with no ISIN/holding of its own
        if not isin and holding_total in ("", None) and pct_category is not None and pct_category >= 99.9:
            segments.append({
                "category": normalize_asset_class_label(label),
                "value": to_number(row[value_col]) or 0.0,
            })

    if not segments:
        return []

    return [{
        "fund": fund_name, "fundCode": fund_code, "asOf": as_of,
        "total": sum(s["value"] for s in segments), "segments": segments,
        "source": path.name, "format": "IPD Detail (.xls)",
    }]


# ------------------------------------------------------------------- dispatcher

def parse_holdings_file(path):
    """Parse any recognised holdings export. Returns [] for anything unrecognised."""
    kind = sniff_format(path)
    try:
        if kind == "html":
            return parse_custodian_html(path)
        if kind == "ole2":
            return parse_ipd_xls(path)
        if kind == "text":
            return parse_flat_csv(path)
    except Exception as exc:  # a malformed file shouldn't abort a 15-month run
        return [{"error": f"{type(exc).__name__}: {exc}", "source": path.name}]
    return []
