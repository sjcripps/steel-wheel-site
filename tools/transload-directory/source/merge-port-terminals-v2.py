#!/usr/bin/env python3
"""Upsert PORT TERMINALS into data/transload-v2.json from source/port-terminals-v2.csv.

Why a separate merge instead of build-data-v2.py: the v2 builder regenerates the
whole dataset from the refresh CSVs and would drop the enrichment layers added
since (facility_type, addresses, rail proximity...). This script edits the live
JSON in place, the way the census/ftype merges did, and is idempotent:

  * keyed on name + city + state. A row may name the EXISTING record it upgrades
    (`existing_name` / `existing_city`) so a terminal already in the directory
    under a slightly different name is updated, never duplicated. Once renamed,
    the second run matches on the new name.
  * a row with no alias that fuzzy-matches a same-city record (token containment
    or SequenceMatcher >= 0.72, the v2 builder's own dedupe rule) is SKIPPED with
    a warning rather than inserted -- add `existing_name` to the row to resolve.
  * facility_type is set to "port-terminal" (slug style, like the existing
    transload-terminal / third-party-warehouse / private-plant values; the UI
    shows it as "Port terminal"). Every record already carrying the census-merge
    marker (note starts "Port terminal" or capability "vessel-rail transload")
    is retagged too, so the new filter covers the whole class, not just this CSV.
  * tier only ever moves UP (listed -> verified when the operator site was
    fetched and named the terminal). Coordinates are overwritten only when the
    record has none, or sits on a shared city centroid and the CSV row carries an
    address-precision point (same rule as scripts/transload-geocode.py).
  * commodity_options / capability_options are NOT extended. The extra tags
    (Fertilizer, Forest Products, Aluminum, Cement; dry bulk, liquid bulk,
    breakbulk...) render as pills but a checkbox for them would hide the hundreds
    of inland transloads recorded under the broader vocab (Minerals, Chemicals),
    so each row also carries the closest existing vocab term for filtering.

Brand guard: the three brand-negative keywords (see the brand-voice-rules skill;
SWL is bulk carload) must not appear in anything this script writes; it aborts if
a CSV row contains one. The pattern is assembled from fragments so a grep of this
repo for the words themselves stays clean.

Run:  python3 merge-port-terminals-v2.py [--dry-run]
"""
import csv, json, re, shutil, sys
from collections import Counter
from datetime import date, datetime
from difflib import SequenceMatcher
from pathlib import Path

HERE = Path(__file__).resolve().parent
CSV_IN = HERE / "port-terminals-v2.csv"
JSON_PATH = HERE.parent / "data" / "transload-v2.json"
TODAY = str(date.today())
DRY = "--dry-run" in sys.argv
FTYPE = "port-terminal"
FTYPE_SRC = f"port-terminals-v2 {TODAY}"
BRAND_BLOCK = re.compile("|".join(a + b for a, b in (("inter", "modal"), ("con", "tainer"), ("dray", "age"))), re.I)

def norm_key(name):
    n = re.sub(r"[^A-Z0-9 ]", " ", name.upper())
    drop = {"INC", "LLC", "LTD", "LP", "CO", "CORP", "COMPANY", "CORPORATION", "INCORPORATED", "THE", "OF"}
    return " ".join(t for t in n.split() if t not in drop)

def split_list(s):
    return [x.strip() for x in (s or "").split(";") if x.strip()]

def union(a, b):
    out = list(a or [])
    for x in b:
        if x not in out: out.append(x)
    return out

rows = list(csv.DictReader(CSV_IN.open(newline="", encoding="utf-8")))
for r in rows:
    blob = " ".join(v for v in r.values() if v)
    if BRAND_BLOCK.search(blob):
        sys.exit(f"FATAL: brand-blocked word in CSV row {r['name']!r}: {BRAND_BLOCK.search(blob).group(0)}")

raw = JSON_PATH.read_text(encoding="utf-8")
PRETTY = "\n" in raw.strip()   # the committed file is indent=1; keep whatever style it arrived in
doc = json.loads(raw)
facs = doc["facilities"]
before = len(facs)
coord_count = Counter((f.get("lat"), f.get("lng")) for f in facs if f.get("lat") is not None)

def key(name, city, state):
    return (name.strip().upper(), city.strip().upper(), state.strip().upper())
index = {key(f["name"], f["city"], f["state"]): f for f in facs}
pre_dupes = {k for k, c in Counter(key(f["name"], f["city"], f["state"]) for f in facs).items() if c > 1}
by_city = {}
for f in facs:
    by_city.setdefault((f["city"].upper(), f["state"].upper()), []).append(f)

def fuzzy_hits(name, city, state):
    nk = norm_key(name); toks = set(nk.split()); hits = []
    for f in by_city.get((city.upper(), state.upper()), []):
        ok = norm_key(f["name"]); otoks = set(ok.split())
        if (toks and otoks and (toks <= otoks or otoks <= toks)) or SequenceMatcher(None, nk, ok).ratio() >= 0.72:
            hits.append(f["name"])
    return hits

def rail_note(rr):
    return f"rail: {', '.join(rr)}" if rr else ""

def apply_row(f, r, is_new):
    """Mutate facility f from CSV row r. Returns True when anything changed."""
    snap = json.dumps(f, sort_keys=True)
    rr = split_list(r["railroads"]); cms = split_list(r["commodities"]); caps = split_list(r["capabilities"])
    f["name"] = r["name"].strip(); f["city"] = r["city"].strip(); f["state"] = r["state"].strip().upper()
    if f.get("facility_type") != FTYPE:
        f["facility_type"] = FTYPE; f["facility_type_source"] = FTYPE_SRC
    if r["tier"] == "verified" and f.get("tier") != "verified":
        f["tier"] = "verified"
        f["tier_source"] = f"operator site fetched {r['web_verified']}"
    if is_new and "tier" not in f:
        f["tier"] = r["tier"] or "listed"
    if cms:
        new_cms = union(f.get("commodities"), cms)
        if new_cms != f.get("commodities"):
            f["commodities"] = new_cms
            f.setdefault("commodities_source", f"operator site / port research {TODAY}")
    f["capabilities"] = union(f.get("capabilities"), caps)
    if r["website"] and f.get("website") != r["website"]:
        f["website"] = r["website"]
    if r["phone"] and not f.get("phone"):
        f["phone"] = r["phone"]
    if r["address"] and not f.get("address"):
        f["address"] = f"{r['address']}, {r['city']}, {r['state']}"
    # coordinates: fill when missing; replace a shared city centroid with an address point
    lat, lon = float(r["lat"]), float(r["lon"])
    have = f.get("lat") is not None and f.get("lng") is not None
    on_centroid = have and coord_count[(f["lat"], f["lng"])] > 1
    if not have or (on_centroid and r["geocode_precision"] == "address"):
        if not have or (f["lat"], f["lng"]) != (lat, lon):
            f["lat"], f["lng"] = lat, lon
            f["geocode_precision"] = r["geocode_precision"]
            f["location_source"] = (f"operator-site+census {TODAY}" if r["geocode_precision"] == "address"
                                    else f"census-port-centroid {TODAY}")
    if r["port"]: f["port"] = r["port"]
    if rr: f["railroads"] = rr
    if r["operator"]: f["operator"] = r["operator"]
    if r["source_url"]: f["source_url"] = r["source_url"]
    if r["web_verified"]: f["web_verified"] = r["web_verified"]
    # note: keep the existing provenance trail, make sure it says Port terminal + rail
    note = (f.get("note") or "").strip()
    parts = [p.strip() for p in re.split(r"\s+—\s+", note) if p.strip()] if note else []
    if not parts or not parts[0].lower().startswith("port terminal"):
        parts.insert(0, "Port terminal")
    desc = (r["note"] or "").strip()
    if desc and desc not in parts:
        parts.insert(1, desc)
    rn = rail_note(rr)
    if rn and not any(p.lower().startswith("rail:") for p in parts):
        parts.append(rn)
    f["note"] = " — ".join(parts)
    return json.dumps(f, sort_keys=True) != snap

stats = Counter(); skipped = []
for r in rows:
    name, city, state = r["name"].strip(), r["city"].strip(), r["state"].strip().upper()
    target = index.get(key(name, city, state))
    if target is None and r["existing_name"]:
        target = index.get(key(r["existing_name"], r["existing_city"] or city, state))
        if target is None:
            sys.exit(f"FATAL: alias not found for {name!r}: {r['existing_name']!r} in {r['existing_city'] or city}, {state}")
    if target is None:
        hits = fuzzy_hits(name, city, state)
        if hits:
            skipped.append(f"{name} | {city}, {state} -> looks like existing {hits} (add existing_name to upgrade it)")
            stats["skipped_fuzzy"] += 1
            continue
        target = {"name": name, "note": "", "email": "", "phone": "", "city": city, "state": state,
                  "source": f"port-terminals-v2 ({r['source_url']})", "commodities": [], "capabilities": [],
                  "caps_known": False, "storage": "unknown", "website": "", "lat": None, "lng": None}
        apply_row(target, r, True)
        facs.append(target); index[key(name, city, state)] = target
        by_city.setdefault((city.upper(), state), []).append(target)
        stats["new"] += 1
    else:
        old_key = key(target["name"], target["city"], target["state"])
        if apply_row(target, r, False):
            stats["updated"] += 1
        else:
            stats["unchanged"] += 1
        if old_key != key(target["name"], target["city"], target["state"]):
            index.pop(old_key, None); index[key(target["name"], target["city"], target["state"])] = target

# retag the census-merge port records so the filter covers the whole class
for f in facs:
    if f.get("facility_type") != FTYPE and (
        str(f.get("note", "")).lower().startswith("port terminal") or "vessel-rail transload" in (f.get("capabilities") or [])):
        f["facility_type"] = FTYPE; f["facility_type_source"] = FTYPE_SRC
        stats["retagged"] += 1

# validate: the dataset already carries a handful of same-name rows (BWC Terminals
# Harvey, Palmetto Railways...) from earlier merges; only a NEW duplicate is fatal.
keys = [key(f["name"], f["city"], f["state"]) for f in facs]
dupes = {k for k, c in Counter(keys).items() if c > 1} - pre_dupes
if dupes:
    sys.exit(f"FATAL: merge introduced duplicate name+city+state rows: {sorted(dupes)[:5]}")
for f in facs:
    if f.get("facility_type") == FTYPE and f.get("facility_type_source") == FTYPE_SRC:
        if BRAND_BLOCK.search(f.get("note", "") + " " + " ".join(f.get("capabilities", []) + f.get("commodities", []))):
            sys.exit(f"FATAL: brand-blocked word written into {f['name']!r}")

doc["tier_counts"] = dict(Counter(f["tier"] for f in facs))
doc["unmapped_count"] = sum(1 for f in facs if f.get("lat") is None or f.get("lng") is None)
doc["facility_type_counts"] = dict(Counter(f.get("facility_type") or "unclassified" for f in facs))
if stats["new"] or stats["updated"] or stats["retagged"]:
    doc["last_manual_edit"] = (f"{TODAY} (port terminals: +{stats['new']} new, {stats['updated']} upgraded, "
                               f"{stats['retagged']} retagged from source/port-terminals-v2.csv)")

pt = sum(1 for f in facs if f.get("facility_type") == FTYPE)
print(f"rows: {len(rows)}  new: {stats['new']}  updated: {stats['updated']}  unchanged: {stats['unchanged']}  "
      f"retagged: {stats['retagged']}  skipped(fuzzy): {stats['skipped_fuzzy']}")
print(f"facilities: {before} -> {len(facs)}   port-terminal records: {pt}   tiers: {doc['tier_counts']}")
for s in skipped: print("  SKIP", s)
if DRY:
    print("dry run — nothing written"); sys.exit(0)
if stats["new"] or stats["updated"] or stats["retagged"]:
    bak = JSON_PATH.with_name(f"transload-v2.json.bak-ports-{datetime.now().strftime('%Y%m%d%H%M%S')}")
    shutil.copy2(JSON_PATH, bak)
    print(f"backup: {bak.name}")
    JSON_PATH.write_text(json.dumps(doc, indent=1) if PRETTY else json.dumps(doc, separators=(",", ":"), ensure_ascii=False),
                         encoding="utf-8")
    print(f"wrote {JSON_PATH} ({JSON_PATH.stat().st_size} bytes)")
else:
    print("no changes — JSON untouched")
