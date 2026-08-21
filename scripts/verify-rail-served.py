#!/usr/bin/env python3
"""
Verify that facilities we call "rail-served" are actually near rail.

Jacob spot-checked the warehouse shortlist and flagged that several did not look
rail-served. He is right to: the transload directory's addresses come from
railroad directories and operator sites, and an operator's listed address is
often a corporate office or a multi-site company's HQ, not the building with the
siding. Publishing "rail-served warehouse" for a facility with no track is the
kind of error that ends a customer relationship on the first site visit.

Measures each facility against the SAME NARN network the rate engine routes on,
so the directory and the rate quote cannot disagree about what is on rail.

Method + honest limits:
  - Distance is to the nearest NARN *node*, not to track centreline. Nodes are
    dense (~250k over the US network) but a facility beside a long tangent with
    no nearby node will read further out than it is. This is therefore a
    CONSERVATIVE screen: it can flag a genuinely rail-served site, so its output
    is "unverified", never "not rail-served".
  - The threshold is calibrated against positive controls rather than guessed —
    the rail-served-businesses set is built from OSM spur geometry, so those
    records are on rail by construction.

Usage: python3 scripts/verify-rail-served.py [--write]
"""
import argparse, json, shutil, sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/home/ubuntu/bots/assistant/businesses/steel-wheel/scripts")

ROOT = Path(__file__).resolve().parent.parent
TL = ROOT / "tools" / "transload-directory" / "data" / "transload-v2.json"
RS = ROOT / "tools" / "rail-served-businesses" / "data" / "businesses.json"

ap = argparse.ArgumentParser()
ap.add_argument("--write", action="store_true")
ap.add_argument("--sample-controls", type=int, default=400)
a = ap.parse_args()

print("loading NARN graph (the one the rate engine routes on)...")
import rail_distance as rd
graph = rd.build_graph()          # loads the cached pickle; same graph the rate engine uses
idx = rd._get_nearest_index(graph)
print(f"  graph: {graph.number_of_nodes():,} nodes / {graph.number_of_edges():,} edges")

def dist_mi(lat, lon):
    _node, d = idx.nearest(lat, lon)
    return d

# ── Calibrate on positive controls ──────────────────────────────────────────
rs = json.loads(RS.read_text())["businesses"]
ctrl = [x for x in rs if x.get("lat") and x.get("lon")][: a.sample_controls]
cd = sorted(dist_mi(x["lat"], x["lon"]) for x in ctrl)
def pct(p): return cd[min(len(cd) - 1, int(len(cd) * p))]
print(f"\nPOSITIVE CONTROLS (n={len(cd)}, OSM-spur-derived, on rail by construction)")
print(f"  median {pct(0.50):.2f} mi | p75 {pct(0.75):.2f} | p90 {pct(0.90):.2f} | p95 {pct(0.95):.2f} | max {cd[-1]:.2f}")
# A single cutoff was wrong. Calibrated against facilities that ARE rail-served,
# p95 sits at 1.17 mi - so a 1 mi threshold passed R&S's Knoxville HEAD OFFICE
# (0.31 mi) which has no siding, while their actual rail-served LD1 warehouse
# measures 0.08 mi. Rail runs through cities, so in a built-up area almost any
# address scores well against a loose cutoff. Grade it instead:
#   high     <= p50  - closer than the median true rail-served facility
#   probable <= p75
#   possible <= p95  - the real distribution has a long tail; a genuine siding
#                      CAN read far out where NARN nodes are sparse
#   unlikely  > p95
BANDS = [("high", pct(0.50)), ("probable", pct(0.75)), ("possible", pct(0.95))]
THRESH = round(pct(0.75), 2)          # what we are willing to CALL rail-served
def band(d):
    for name, lim in BANDS:
        if d <= lim: return name
    return "unlikely"
print(f"  -> bands: high<={BANDS[0][1]:.2f}  probable<={BANDS[1][1]:.2f}  "
      f"possible<={BANDS[2][1]:.2f}  (claim rail-served only at <= {THRESH})")

# ── Screen the transload directory ──────────────────────────────────────────
doc = json.loads(TL.read_text()); recs = doc["facilities"]
today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
MX = {"SL","EM","HG","GJ","JA","QA","BJ","SO","TM","VL","DF","MH"}
OUT_OF_GRAPH = {"AK"} | MX
near = far = nocoord = skipped = 0
flagged = []
for r in recs:
    if r.get("state") in OUT_OF_GRAPH:
        # Alaska Railroad and the Mexican roads are real, but this NARN extract
        # does not carry their geometry - the check would report 700+ mi and be
        # measuring our own coverage gap, not the facility. Never flag them.
        r["rail_proximity"] = "not-checked-no-network-coverage"
        skipped += 1; continue
    if not (isinstance(r.get("lat"), (int, float)) and isinstance(r.get("lng"), (int, float))):
        nocoord += 1; r["rail_proximity"] = "no-coordinates"; continue
    d = dist_mi(r["lat"], r["lng"])
    r["rail_distance_mi"] = round(d, 2)
    r["rail_confidence"] = band(d)
    if d <= THRESH:
        r["rail_proximity"] = "on-network"; near += 1
    else:
        r["rail_proximity"] = "unverified"; far += 1
        flagged.append((round(d, 1), r.get("name"), r.get("city"), r.get("state"),
                        r.get("facility_type") or "-"))
    r["rail_proximity_checked"] = today

n = len(recs)
print(f"\nTRANSLOAD DIRECTORY ({n} records)")
print(f"  on-network (<= {THRESH} mi)  {near:5} ({near/n*100:.1f}%)")
print(f"  UNVERIFIED (> {THRESH} mi)   {far:5} ({far/n*100:.1f}%)")
print(f"  no coordinates             {nocoord:5}")
print(f"  skipped, no NARN coverage  {skipped:5}  (AK + Mexico)")

wh = [r for r in recs if r.get("facility_type") == "third-party-warehouse"]
whbad = [r for r in wh if r.get("rail_proximity") == "unverified"]
print(f"\n  of the {len(wh)} third-party warehouses: {len(whbad)} are UNVERIFIED "
      f"({len(whbad)/max(1,len(wh))*100:.0f}%)  <- Jacob's catch, quantified")

flagged.sort(reverse=True)
print("\n  furthest from rail (these must not be called rail-served):")
for d, nm, c, s, ft in flagged[:15]:
    print(f"   {d:7.1f} mi  {str(nm)[:38]:38} {str(c)[:15]:15} {s}  {ft}")

if a.write:
    bak = TL.with_suffix(f".json.bak-railcheck-{datetime.now(timezone.utc):%Y%m%d%H%M}")
    shutil.copy2(TL, bak); TL.write_text(json.dumps(doc, indent=1))
    print(f"\nWROTE {TL.name}  (backup {bak.name})")
else:
    print("\ndry run — pass --write to apply")
