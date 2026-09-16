"""Parse the monthly trade reports into one normalised shape, and classify each row.

Every parser returns rows of:
    {"source", "fund", "date", "security", "rawAction", "rawType",
     "quantity", "value"}

Classification (asset class + action) is deliberately config-driven rather than inferred:
these are the firm's own system codes, and a wrong guess would silently misstate trading
activity. Anything unrecognised is reported rather than quietly bucketed.
"""

import re
from datetime import date, datetime

import openpyxl


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


def to_date(raw):
    if raw is None or raw == "":
        return None
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    s = str(raw).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%Y%m%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _sheet_rows(path, header_row):
    wb = openpyxl.load_workbook(str(path), read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(min_row=1, values_only=True))
    if len(rows) < header_row:
        return [], []
    header = [str(h).strip() if h is not None else "" for h in rows[header_row - 1]]
    return header, rows[header_row:]


def _col(header, *names):
    """Index of the first matching column name, or None."""
    for name in names:
        if name in header:
            return header.index(name)
    return None


def _get(row, idx):
    if idx is None or idx >= len(row):
        return None
    return row[idx]


def parse_apex(path, source_label):
    header, data = _sheet_rows(path, 1)
    c = {
        "fund": _col(header, "Account Name"),
        "date": _col(header, "Effective Date"),
        "sec": _col(header, "Security Description (Short)"),
        "code": _col(header, "Security Number (Full)"),
        "action": _col(header, "Tran Code"),
        "qty": _col(header, "Shares/Par"),
        "value": _col(header, "Settle Amount"),
    }
    if c["action"] is None or c["date"] is None:
        return []
    out = []
    for r in data:
        d = to_date(_get(r, c["date"]))
        if d is None:
            continue
        out.append({
            "source": source_label,
            "fund": str(_get(r, c["fund"]) or "").strip(),
            "date": d,
            "security": str(_get(r, c["sec"]) or "").strip(),
            "securityCode": str(_get(r, c["code"]) or "").strip(),
            "rawAction": str(_get(r, c["action"]) or "").strip(),
            "rawType": "",                       # Apex carries no instrument-type column
            "quantity": to_number(_get(r, c["qty"])),
            "value": to_number(_get(r, c["value"])),
        })
    return out


def parse_prescient(path, source_label):
    header, data = _sheet_rows(path, 1)
    c = {
        "fund": _col(header, "Entity Name", "EntityID"),
        "date": _col(header, "Trade Date"),
        "sec": _col(header, "Issue Name"),
        "action": _col(header, "Transaction Type"),
        "invtype": _col(header, "Investment Type"),
        "subtype": _col(header, "Sub Security Type"),
        "qty": _col(header, "Quantity"),
        "value": _col(header, "All in Consideration (Base)", "Clean Consideration (Base)"),
    }
    if c["action"] is None or c["date"] is None:
        return []
    out = []
    for r in data:
        d = to_date(_get(r, c["date"]))
        if d is None:
            continue
        inv = str(_get(r, c["invtype"]) or "").strip()
        sub = str(_get(r, c["subtype"]) or "").strip()
        out.append({
            "source": source_label,
            "fund": str(_get(r, c["fund"]) or "").strip(),
            "date": d,
            "security": str(_get(r, c["sec"]) or "").strip(),
            "rawAction": str(_get(r, c["action"]) or "").strip(),
            # sub-type is the more specific signal (VB/ZCB vs plain FI), fall back to investment type
            "rawType": sub or inv,
            "quantity": to_number(_get(r, c["qty"])),
            "value": to_number(_get(r, c["value"])),
        })
    return out


def parse_curo(path, source_label):
    header, data = _sheet_rows(path, 3)
    c = {
        "fund": _col(header, "PfolioIDCode"),
        "date": _col(header, "TradeDate", "EffectiveDate"),
        "sec": _col(header, "InstrumentCode"),
        "action": _col(header, "TransactionDescription"),
        "qty": _col(header, "Quantity"),
        "value": _col(header, "BaseCleanConsideration", "AssetCleanConsideration"),
    }
    if c["action"] is None or c["date"] is None:
        return []
    out = []
    for r in data:
        d = to_date(_get(r, c["date"]))
        if d is None:
            continue
        action = str(_get(r, c["action"]) or "").strip()
        out.append({
            "source": source_label,
            "fund": str(_get(r, c["fund"]) or "").strip(),
            "date": d,
            "security": str(_get(r, c["sec"]) or "").strip(),
            "rawAction": action,
            "rawType": action,     # for Curo the description carries the instrument type too
            "quantity": to_number(_get(r, c["qty"])),
            "value": to_number(_get(r, c["value"])),
        })
    return out


PARSERS = {"apex": parse_apex, "prescient": parse_prescient, "curo": parse_curo}


def parse_trade_file(path, kind, source_label):
    parser = PARSERS.get(kind)
    if parser is None:
        raise ValueError(f"Unknown trade file kind {kind!r} — expected one of {sorted(PARSERS)}")
    return parser(path, source_label)


# ----------------------------------------------------------------- classification

def classify(row, rules):
    """Map a raw row onto (asset_class, action, used_default) using the config rules.

    asset_class or action may be None, meaning 'not recognised' — the caller reports those
    rather than silently bucketing them. used_default flags rows that only got an asset
    class from the per-source fallback, so a new instrument can't quietly land in the
    wrong bucket just because its source usually trades one thing.
    """
    action_map = {k.lower(): v for k, v in rules.get("actions", {}).items()}
    class_map = {k.lower(): v for k, v in rules.get("asset_classes", {}).items()}
    security_map = {k.lower(): v for k, v in rules.get("securities", {}).items()}
    defaults = {k.lower(): v for k, v in rules.get("source_defaults", {}).items()}

    action = action_map.get(row["rawAction"].lower())

    # most specific signal first: the instrument itself (by code, then by name), then the
    # report's own type column, then a combined description field, then the source default
    asset_class = security_map.get((row.get("securityCode") or "").lower())
    if asset_class is None:
        asset_class = security_map.get((row["security"] or "").lower())
    if asset_class is None and row["rawType"]:
        asset_class = class_map.get(row["rawType"].lower())
    if asset_class is None:
        asset_class = class_map.get(row["rawAction"].lower())

    used_default = False
    if asset_class is None:
        asset_class = defaults.get((row["source"] or "").lower())
        used_default = asset_class is not None

    return asset_class, action, used_default
