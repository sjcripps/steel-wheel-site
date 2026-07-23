#!/usr/bin/env python3
# STAGED v2 pipeline — merges the refreshed/validated original dataset with new
# "listed" candidates from railroad network directories. Writes NEW files only:
#
#   source/transload-locations-v2.csv   merged dataset (tiered)
#   source/closures-v2.csv              archived CLOSED_PERMANENTLY rows
#   data/transload-v2.json              payload for index-v2.html
#
# v1 files (transload-locations.csv, transload.json, build-data.py, index.html)
# are NOT touched. Inputs beyond this folder:
#
#   REFRESH_DIR/validated.csv        827 original rows + maps/website validation
#   REFRESH_DIR/new-candidates.csv   1,723 discovery candidates
#   source/lat-long.csv              v1 city geocodes
#   source/lat-long-v2-supplement.csv  Census-gazetteer geocodes for new cities
#   source/pending-rows-v2.csv       tier=pending-verification rows (EXCLUDED
#                                    from output until their tier is flipped —
#                                    Casco Bay Rail Holdings lives here)
#
# Re-run:  python3 build-data-v2.py
import csv, html, json, os, re, sys
from datetime import date
from difflib import SequenceMatcher
from pathlib import Path

HERE = Path(__file__).resolve().parent
REFRESH_DIR = Path(os.environ.get(
    "REFRESH_DIR",
    "/home/ubuntu/bots/assistant/businesses/steel-wheel/data/transload-refresh"))

V1_CSV = HERE / "transload-locations.csv"
VALIDATED = REFRESH_DIR / "validated.csv"
CANDIDATES = REFRESH_DIR / "new-candidates.csv"
LL_CSV = HERE / "lat-long.csv"
LL_SUP = HERE / "lat-long-v2-supplement.csv"
PENDING = HERE / "pending-rows-v2.csv"
OUT_CSV = HERE / "transload-locations-v2.csv"
OUT_CLOSURES = HERE / "closures-v2.csv"
OUT_JSON = HERE.parent / "data" / "transload-v2.json"

COMMODITY_COLS = [
    "Acids", "Asphalt", "Chemicals (Dry)", "Chemicals (Liq)",
    "Foods (Dry)", "Foods (Liq)", "Frac Sand", "Lumber", "Minerals",
    "Petroleum Products", "Plastics (Dry)", "Steel",
]
CAPABILITY_COLS = [
    "Air Compressor", "Auger", "Blending Meters", "Blower", "Bulk Conveyor",
    "Gravity (Trestle)", "Hot Water Heating", "Liquid Pumps",
    "Liquid Storage Tanks", "Portable Vacuum", "Sampling Services", "Scale",
    "Steam Heating", "Tank Trailer Cleaning",
]

VALID_STATES = set("""AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME
MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT
VA WA WV WI WY DC
AB BC MB NB NL NS NT NU ON PE QC SK YT
AGU BCN BCS CAM CHH CHP COA COL DUR GRO GUA HID JAL MEX MIC MOR NAY NLE OAX
PUE QUE ROO SIN SLP SON TAB TAM TLA VER YUC ZAC CMX MX
BJ DF EM GJ HG JA MH PQ QA SL SO TM VL""".split())
# last line: legacy codes carried over from v1 (old Mexican-state abbreviations
# + PQ for Quebec) — they key the lat-long.csv geocode join, so left as-is.

ACRONYMS = {"LLC", "TBT", "RSI", "USA", "CN", "CSX", "BNSF", "CPKC", "KCS",
            "NS", "UP", "ADM", "GATX", "TTX", "IMS", "CT", "NW", "SW", "SE",
            "NE.", "II", "III", "IV", "CSXT", "TLC", "JIT", "DBT", "PBF",
            "IMTT", "NACC", "SDI", "CHS", "AGP", "AG", "BP"}

def smart_title(name: str) -> str:
    """Title-case an ALL-CAPS name, preserving known acronyms and &/. groups."""
    def cap(m):
        w = m.group(0)
        return w if w.upper() in ACRONYMS else w.capitalize()
    t = re.sub(r"[A-Za-z][A-Za-z']*", cap, name)
    # restore whitelisted acronyms that capitalize() lowercased (e.g. Llc)
    for a in ACRONYMS:
        t = re.sub(r"\b" + re.escape(a.capitalize()) + r"\b", a, t)
    return t

def norm_key(name: str) -> str:
    """Aggressive normalization for dedupe matching only (never displayed)."""
    n = html.unescape(name).upper()
    n = re.sub(r"[^A-Z0-9 ]", " ", n)
    drop = {"INC", "LLC", "LTD", "LP", "CO", "CORP", "COMPANY", "CORPORATION",
            "INCORPORATED", "THE", "OF"}
    toks = [t for t in n.split() if t not in drop]
    return " ".join(toks)

LOCATION_WORDS = re.compile(
    r"\b(yard|terminal|hub|avenue|ave|street|st|road|rd|blvd|boulevard|drive|"
    r"station|facility|reload|port|dock|site|plant|spur|track|transload|"
    r"north|south|east|west)\b", re.I)

def split_candidate_name(raw: str, city: str, state: str):
    """Normalize a candidate name; peel location-y ' - suffix' / '(...)' parts
    into a note. Returns (name, note)."""
    name = html.unescape(raw).strip()
    name = re.sub(r"\.\.+", ".", name)          # "Inc.." -> "Inc."
    name = re.sub(r"\s+", " ", name)
    note_parts = []
    city_u = city.strip().upper()

    # trailing parenthetical -> note
    m = re.match(r"^(.*\S)\s*\(([^)]+)\)$", name)
    if m and len(m.group(1)) >= 3:
        name, par = m.group(1).strip(), m.group(2).strip()
        note_parts.append(par)

    # " - suffix" where suffix is location-ish (city, state code, or place words)
    m = re.match(r"^(.+?)\s+[-–—]\s+(.+)$", name)
    if m:
        base, suf = m.group(1).strip(), m.group(2).strip()
        suf_u = suf.upper().rstrip(".")
        looks_loc = (city_u and city_u in suf_u) or \
            re.search(r",\s*[A-Z]{2}$", suf_u) or LOCATION_WORDS.search(suf)
        if looks_loc and len(base) >= 3:
            name = base
            note_parts.insert(0, suf)

    # clean notes: drop parts that are just the city (± state); strip city token
    cleaned = []
    for p in note_parts:
        p2 = re.sub(r"\s+", " ", p).strip(" ,")
        pu = p2.upper().rstrip(".")
        if pu in (city_u, f"{city_u}, {state}", f"{city_u} {state}", state):
            continue
        if city_u:
            p2 = re.sub(re.escape(city_u) + r"\s*[, ]*", "", p2, flags=re.I).strip(" ,-")
        if p2:
            cleaned.append(p2)
    if name.isupper():
        name = smart_title(name)
    return name, "; ".join(dict.fromkeys(cleaned))

STORAGE_RE = re.compile(r"rail\s*-?\s*car\s*storage|railcarstorage", re.I)

def detect_storage(*fields) -> str:
    return "yes" if STORAGE_RE.search(" ".join(f or "" for f in fields)) else "unknown"

# ── geocode lookup ──────────────────────────────────────────────────────────
ll_lookup, ll_display_city = {}, {}
with LL_CSV.open(newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        cu = (row.get("City") or "").strip()
        ct = (row.get("City.1") or "").strip()
        st = (row.get("State/Province") or "").strip()
        try:
            lat, lng = float(row.get("Latitude")), float(row.get("Longitude"))
        except (TypeError, ValueError):
            continue
        if cu and st:
            key = (cu.upper(), st.upper())
            ll_lookup[key] = (lat, lng)
            if ct:
                ll_display_city[key] = ct
if LL_SUP.exists():
    with LL_SUP.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            key = (row["City"].strip().upper(), row["State"].strip().upper())
            try:
                ll_lookup.setdefault(key, (float(row["Latitude"]), float(row["Longitude"])))
            except (TypeError, ValueError):
                continue

def geocode(city, state):
    return ll_lookup.get((city.strip().upper(), state.strip().upper()), (None, None))

def display_city(city, state):
    return ll_display_city.get((city.strip().upper(), state.strip().upper())) or city.strip().title()

# ── load v1 commodities/capabilities (keyed Name|City|ST) ───────────────────
v1_extra = {}
with V1_CSV.open(newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        key = (row["Name"].strip().upper(), row["City"].strip().upper(), row["ST"].strip().upper())
        v1_extra[key] = row

# ── originals: tier + refresh from validated.csv ────────────────────────────
records, closures = [], []
stats = {"verified": 0, "review": 0, "listed": 0, "closures": 0,
         "phone_adopted": 0, "website_adopted": 0, "dead_link_fixed": 0,
         "dead_link_flagged": 0, "dupes_dropped": 0, "cand_skipped_incomplete": 0}

orig_keys = set()          # (norm_name, CITY, ST) incl. maps rename candidates
with VALIDATED.open(newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        name = row["Name"].strip()
        city = row["City"].strip()
        state = row["ST"].strip().upper()
        status = row["maps_status"].strip()
        website_cat = row["website_category"].strip()
        rebulk = row["in_rebulk_directory"].strip() == "yes"

        if status == "CLOSED_PERMANENTLY":
            closures.append({**row, "closed_reason": "google_maps_permanently_closed",
                             "archived_on": str(date.today())})
            stats["closures"] += 1
            continue

        # tier
        if status == "OPERATIONAL":
            tier = "verified"
        elif status == "CLOSED_TEMPORARILY":
            tier = "review"
        elif status == "NOT_FOUND" and website_cat in ("dead_link", "dead_domain") and not rebulk:
            tier = "review"        # dead website + no corroboration
        else:
            tier = "verified"      # verified-legacy (incl. NOT_FOUND w/ corroboration)
        stats[tier if tier in ("verified", "review") else "verified"] += 1

        # refresh phone/website — adopt Maps values only on confident matches
        phone, website_flag = "", ""
        website = row["Website"].strip()
        if status == "OPERATIONAL":
            if row["maps_phone"].strip():
                phone = row["maps_phone"].strip()
                stats["phone_adopted"] += 1
            mw = row["maps_website"].strip()
            if mw and mw.rstrip("/") != website.rstrip("/"):
                if website_cat == "dead_link":
                    stats["dead_link_fixed"] += 1
                website = mw
                stats["website_adopted"] += 1
            elif website_cat in ("dead_link", "dead_domain"):
                website_flag = website_cat
                stats["dead_link_flagged"] += 1
        elif website_cat in ("dead_link", "dead_domain"):
            website_flag = website_cat
            stats["dead_link_flagged"] += 1

        extra = v1_extra.get((name.upper(), city.upper(), state)) or {}
        commodities = {c: (extra.get(c, "") or "NO").strip().upper() for c in COMMODITY_COLS}
        capabilities = {c: (extra.get(c, "") or "NO").strip().upper() for c in CAPABILITY_COLS}

        orig_keys.add((norm_key(name), city.upper(), state))
        mm = row["maps_matched_name"].strip()
        if mm:
            orig_keys.add((norm_key(mm), city.upper(), state))

        records.append({
            "Name": smart_title(name) if name.isupper() else name,
            "Location Note": "",
            "Email": (row["Email"] or "").strip().lower(),
            "Phone": phone,
            "City": city.upper(),
            "ST": state,
            **commodities, **capabilities,
            "Railcar Storage": detect_storage(name),
            "Website": website,
            "Website Flag": website_flag,
            "Tier": tier,
            "Source": "swl-internal",
            "Maps Status": status,
            "Confidence": row["confidence"].strip(),
        })

# ── merge v1-internal duplicates (same Name+City+ST split across rows, e.g.
#    Watco capability splits / Arrow Reload multi-yard rows): union YES columns,
#    prefer the Maps-OPERATIONAL row's contact data ────────────────────────────
merged, order = {}, []
TIER_RANK = {"verified": 0, "review": 1}
for r in records:
    key = (r["Name"].upper(), r["City"], r["ST"])
    if key not in merged:
        merged[key] = r
        order.append(key)
        continue
    m = merged[key]
    stats["v1_dup_rows_merged"] = stats.get("v1_dup_rows_merged", 0) + 1
    for c in COMMODITY_COLS + CAPABILITY_COLS:
        if r.get(c, "").strip().upper() == "YES":
            m[c] = "YES"
    if TIER_RANK.get(r["Tier"], 9) < TIER_RANK.get(m["Tier"], 9):
        m["Tier"] = r["Tier"]
    prefer_r = r["Maps Status"] == "OPERATIONAL" and m["Maps Status"] != "OPERATIONAL"
    for fld in ("Email", "Phone", "Website"):
        if (prefer_r and r[fld]) or not m[fld]:
            m[fld] = m[fld] if (m[fld] and not prefer_r) else (r[fld] or m[fld])
    if prefer_r:
        m["Maps Status"], m["Confidence"], m["Website Flag"] = r["Maps Status"], r["Confidence"], r["Website Flag"]
    if r["Railcar Storage"] == "yes":
        m["Railcar Storage"] = "yes"
records = [merged[k] for k in order]
stats["verified"] = sum(1 for r in records if r["Tier"] == "verified")
stats["review"] = sum(1 for r in records if r["Tier"] == "review")

# ── new candidates: normalize, dedupe (strict), tier=listed ─────────────────
orig_by_citystate = {}
for nk, c, s in orig_keys:
    orig_by_citystate.setdefault((c, s), []).append(nk)

seen_cand = set()
dropped = []
with CANDIDATES.open(newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        raw_name = (row["name"] or "").strip()
        city = (row["city"] or "").strip()
        state = (row["state"] or "").strip().upper()
        if not raw_name or not city or not state:
            stats["cand_skipped_incomplete"] += 1
            continue
        name, note = split_candidate_name(raw_name, city, state)
        nk = norm_key(name)
        if not nk:
            stats["cand_skipped_incomplete"] += 1
            continue

        # strict dedupe vs originals: exact norm-key, fuzzy ratio, or token containment
        dup = False
        if (nk, city.upper(), state) in orig_keys:
            dup = True
        else:
            toks = set(nk.split())
            for onk in orig_by_citystate.get((city.upper(), state), []):
                otoks = set(onk.split())
                if toks and otoks and (toks <= otoks or otoks <= toks):
                    dup = True
                    break
                if SequenceMatcher(None, nk, onk).ratio() >= 0.72:
                    dup = True
                    break
        if dup:
            dropped.append(f"{raw_name} | {city}, {state} (matches original)")
            stats["dupes_dropped"] += 1
            continue

        # dedupe within candidates (post-normalization key incl. note)
        ck = (nk, city.upper(), state, note.upper())
        if ck in seen_cand:
            dropped.append(f"{raw_name} | {city}, {state} (duplicate candidate)")
            stats["dupes_dropped"] += 1
            continue
        seen_cand.add(ck)

        source = (row["source"] or "").strip().replace("CSX territor)", "CSX)")
        website = (row["website"] or "").strip()
        records.append({
            "Name": name,
            "Location Note": note,
            "Email": "",
            "Phone": (row["phone"] or "").strip(),
            "City": city.upper(),
            "ST": state,
            **{c: "UNKNOWN" for c in COMMODITY_COLS},
            **{c: "UNKNOWN" for c in CAPABILITY_COLS},
            "Railcar Storage": detect_storage(raw_name, website),
            "Website": website,
            "Website Flag": "",
            "Tier": "listed",
            "Source": source or "network-directory",
            "Maps Status": "",
            "Confidence": "",
        })
        stats["listed"] += 1

# ── pending rows (Casco Bay etc.) — carried in CSV, EXCLUDED from JSON ──────
pending_skipped = 0
if PENDING.exists():
    with PENDING.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if (row.get("Tier") or "").strip() == "pending-verification":
                pending_skipped += 1
                continue
            records.append(row)   # a flipped pending row joins the dataset

# ── validate ────────────────────────────────────────────────────────────────
bad_states = sorted({r["ST"] for r in records if r["ST"] not in VALID_STATES})
if bad_states:
    sys.exit(f"FATAL: invalid state codes in merged dataset: {bad_states}")
final_keys = [(r["Name"].upper(), r["City"], r["ST"], r["Location Note"].upper()) for r in records]
dupes = {k for k in final_keys if final_keys.count(k) > 1}
if dupes:
    sys.exit(f"FATAL: duplicate name+city rows survived merge: {sorted(dupes)[:5]}")

# ── write v2 CSV + closures archive ─────────────────────────────────────────
fieldnames = ["Name", "Location Note", "Email", "Phone", "City", "ST",
              *COMMODITY_COLS, *CAPABILITY_COLS, "Railcar Storage",
              "Website", "Website Flag", "Tier", "Source", "Maps Status", "Confidence"]
with OUT_CSV.open("w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=fieldnames)
    w.writeheader()
    for r in sorted(records, key=lambda x: (x["Name"].upper(), x["ST"], x["City"])):
        w.writerow({k: r.get(k, "") for k in fieldnames})

if closures:
    with OUT_CLOSURES.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(closures[0].keys()))
        w.writeheader()
        w.writerows(closures)

# ── build JSON ──────────────────────────────────────────────────────────────
facilities, mapped = [], 0
for r in sorted(records, key=lambda x: (x["Name"].upper(), x["ST"], x["City"])):
    lat, lng = geocode(r["City"], r["ST"])
    if lat is not None:
        mapped += 1
    caps_known = r["Tier"] != "listed" and r.get(COMMODITY_COLS[0], "UNKNOWN") != "UNKNOWN"
    facilities.append({
        "name": r["Name"],
        "note": r["Location Note"],
        "email": r["Email"],
        "phone": r["Phone"],
        "city": display_city(r["City"], r["ST"]),
        "state": r["ST"],
        "tier": r["Tier"],
        "source": r["Source"],
        "commodities": [c for c in COMMODITY_COLS if r.get(c, "").strip().upper() == "YES"],
        "capabilities": [c for c in CAPABILITY_COLS if r.get(c, "").strip().upper() == "YES"],
        "caps_known": caps_known,
        "storage": r["Railcar Storage"],
        "website": r["Website"],
        "lat": lat,
        "lng": lng,
    })

tier_counts = {}
for fac in facilities:
    tier_counts[fac["tier"]] = tier_counts.get(fac["tier"], 0) + 1

out = {
    "version": 2,
    "generated_at": str(date.today()),
    "source": "Steel Wheel Logistics — transload directory v2 (verified + listed tiers)",
    "commodity_options": COMMODITY_COLS,
    "capability_options": CAPABILITY_COLS,
    "tier_counts": tier_counts,
    "facilities": facilities,
    "unmapped_count": len(facilities) - mapped,
}
OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
with OUT_JSON.open("w", encoding="utf-8") as f:
    json.dump(out, f, separators=(",", ":"), ensure_ascii=False)

with (REFRESH_DIR / "dropped-duplicates.log").open("w", encoding="utf-8") as f:
    f.write("\n".join(dropped) + "\n")

print(f"total facilities: {len(facilities)} (mapped {mapped}, unmapped {len(facilities)-mapped})")
print(f"tiers: {tier_counts}")
print(f"closures archived: {stats['closures']}  pending-verification skipped: {pending_skipped}")
print(f"candidate dupes dropped: {stats['dupes_dropped']}  incomplete skipped: {stats['cand_skipped_incomplete']}")
print(f"phones adopted: {stats['phone_adopted']}  websites adopted: {stats['website_adopted']} "
      f"(rotted links fixed: {stats['dead_link_fixed']}, still flagged: {stats['dead_link_flagged']})")
print(f"csv: {OUT_CSV}\njson: {OUT_JSON} ({OUT_JSON.stat().st_size} bytes)")
