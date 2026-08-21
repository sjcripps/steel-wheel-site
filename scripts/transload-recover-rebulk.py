#!/usr/bin/env python3
"""
Recover facilities the August pipeline scraped from rebulk and then lost.

Jacob asked why RS Warehousing / R&S Logistics — a rail-served warehouse he
knows handles pulp near Knoxville — was not in the directory. It was in the
rebulk scrape all along (Loudon TN, NS, Forest Products) and never made it into
transload-v2.json. Tracing that found 512 records in the same position.

Where they died:
  402  killed by the DEDUPE step — wrongly matched as duplicates of records we
       did not actually have. R&S is one of these.
  110  survived dedupe into new-candidates.csv and were dropped at BUILD.

Third time this project that the answer was already on disk: the rebulk
commodity column, the state-rail-plan descriptors, and now whole records.

Import is split by duplicate risk, using WEBSITE DOMAIN as the discriminator:
  no domain overlap with us            -> genuinely new, safe to import
  same domain + DIFFERENT city         -> a real second location of a known
                                          operator; import, but flag for the
                                          rail-proximity check before it is
                                          ever called rail-served
  same domain + SAME city              -> almost certainly the same facility
                                          under another name. NEVER imported.

Usage: python3 scripts/transload-recover-rebulk.py [--include-second-locations] [--write]
"""
import argparse, html, json, re, shutil
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "tools" / "transload-directory" / "data" / "transload-v2.json"
REBULK = Path("/home/ubuntu/bots/assistant/businesses/steel-wheel/data/"
              "transload-refresh/work/rebulk-facilities.json")

ap = argparse.ArgumentParser()
ap.add_argument("--write", action="store_true")
ap.add_argument("--include-second-locations", action="store_true",
                help="also import same-domain/different-city records")
a = ap.parse_args()

today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
doc = json.loads(DATA.read_text())
recs = doc["facilities"]
reb = json.loads(REBULK.read_text())
VOCAB = set(doc["commodity_options"])

# The scrape never unescaped HTML entities, so "Meador Warehousing &amp;
# Distribution" reads as a different name from ours and shows up as a phantom
# absence. Unescape both sides before comparing.
def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", html.unescape(str(s or "")).lower()).strip()

def dom(u):
    m = re.match(r"https?://([^/]+)", str(u or ""), re.I)
    return m.group(1).lower().replace("www.", "") if m else None

def split_city(c):
    m = re.match(r"^(.*?)\s*,\s*([A-Za-z]{2})\s*$", str(c or "").strip())
    return (m.group(1).strip(), m.group(2).upper()) if m else (str(c or "").strip(), None)

# rebulk's broad categories -> our 12-value vocabulary. Only the four that land
# in exactly one bucket; "Dry Bulk" spans four of ours and stays out.
CLEAN = {"plastics": "Plastics (Dry)", "forest products": "Lumber",
         "metals": "Steel", "aggregates": "Minerals"}

by_citystate = defaultdict(list)
by_domain = defaultdict(list)
for r in recs:
    by_citystate[(norm(r.get("city")), str(r.get("state") or "").upper())].append(norm(r.get("name")))
    d = dom(r.get("website"))
    if d:
        by_domain[d].append(r)

st = Counter(); added = []
for r in reb:
    city, state = split_city(r.get("city"))
    if not state:
        st["no_state"] += 1; continue
    nm = norm(r.get("name"))
    peers = by_citystate.get((norm(city), state), [])
    if nm in peers:
        st["already_present_exact"] += 1; continue
    if any(nm in p or p in nm for p in peers if len(nm) > 6 and len(p) > 6):
        st["already_present_fuzzy"] += 1; continue

    d = dom(r.get("website"))
    same_dom = by_domain.get(d) if d else None
    if same_dom:
        if any(norm(x.get("city")) == norm(city) and x.get("state") == state for x in same_dom):
            st["skipped_same_domain_same_city"] += 1; continue   # same facility, other name
        kind = "second-location"
        if not a.include_second_locations:
            st["deferred_second_location"] += 1; continue
    else:
        kind = "new"

    cats = [c.strip() for c in str(r.get("commodities") or "").split(",") if c.strip()]
    mapped = sorted({CLEAN[c.lower()] for c in cats if c.lower() in CLEAN})
    rec = {
        "name": html.unescape(str(r.get("name") or "")).strip(),
        "city": city, "state": state,
        "website": r.get("website") or "",
        "phone": "", "email": "",
        "commodities": mapped,
        "capabilities": [], "caps_known": False,
        "storage": "unknown",
        "tier": "listed",
        "source": f"rebulk-directory (recovered {today})",
        "note": "",
        "lat": None, "lng": None,
        # Recovered records have no coordinates, so they cannot be distance-checked.
        # Explicitly NOT rail-verified until geocoded — the directory must never
        # imply rail service it has not measured.
        "rail_proximity": "no-coordinates",
        "recovery_kind": kind,
    }
    if cats:
        rec["commodity_categories"] = cats
        if mapped:
            rec["commodities_source"] = f"rebulk-category {today}"
    recs.append(rec)
    added.append(rec)
    st[f"imported_{kind}"] += 1

print(f"rebulk records: {len(reb)}   dataset before: {len(recs) - len(added)}")
for k, v in st.most_common():
    print(f"  {k:32} {v}")
print(f"\n  IMPORTED: {len(added)}   dataset now: {len(recs)}")
withc = sum(1 for r in added if r["commodities"])
print(f"  of those, with mapped commodity data: {withc}")

rs = [r for r in added if "logistics" in norm(r["name"]) and norm(r["name"]).startswith("r s")]
print(f"\n  R&S Logistics recovered: {'YES — ' + rs[0]['city'] + ', ' + rs[0]['state'] if rs else 'no'}")
print("\n  sample:")
for r in added[:12]:
    print(f"    [{r['recovery_kind']:15}] {r['name'][:34]:34} {r['city'][:16]:16} {r['state']}  {','.join(r['commodities'])[:26]}")

if a.write:
    bak = DATA.with_suffix(f".json.bak-recover-{datetime.now(timezone.utc):%Y%m%d%H%M}")
    shutil.copy2(DATA, bak)
    doc["facilities"] = recs
    DATA.write_text(json.dumps(doc, indent=1))
    print(f"\nWROTE {DATA.name}  (backup {bak.name})")
    print("Next: recompute counts, geocode the new rows, then rebuild pages.")
else:
    print("\ndry run — pass --write to apply")
