#!/usr/bin/env python3
"""
Extract facility type from descriptors already embedded in company_name.

businesses.json was built from state rail plans, and 1,671 of its 13,715 rows
carry a parenthetical describing the facility — "(public/contract warehouse)",
"(outdoor transload)", "(warehouse, truck/rail)", "(ethanol plant)". That is
structured facility-type data sitting in a display field, free and deterministic.
No model, no API call, no crawl.

This was found only after a Firecrawl pilot resolved ~15% of these same records
at real cost. Second time in this project the answer was already on disk (the
first was rebulk's commodity column). Check what you hold before building a
crawler.

TWO outputs, deliberately:
  facility_type      classified from the descriptor
  display_name       the name with the parenthetical stripped, because
                     "Action Warehouse Co., Ltd. (public/contract warehouse)"
                     is not a company name and should never reach a customer

Caveat carried in the data: state rail plans use different vocabularies, so
coverage is geographically uneven. The report prints per-state coverage rather
than hiding it behind a national average.

Usage: python3 scripts/railserved-parse-descriptors.py [--write]
"""
import argparse, json, re, shutil
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "tools" / "rail-served-businesses" / "data" / "businesses.json"

ap = argparse.ArgumentParser()
ap.add_argument("--write", action="store_true")
a = ap.parse_args()

doc = json.loads(DATA.read_text())
recs = doc["businesses"]
today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

PAREN = re.compile(r"\(([^)]{4,})\)")
# Order matters: the most specific commercial signal wins. "public/contract
# warehouse" is an explicit third-party statement and outranks a bare mention
# of a warehouse elsewhere in the same descriptor.
RULES = [
    ("third-party-warehouse", re.compile(r"public\s*/?\s*contract warehouse|public warehouse|contract warehouse|\b3pl\b", re.I)),
    ("private-plant",         re.compile(r"ethanol plant|coal-burning|refinery|\bmill\b|\bplant\b|packaging|manufactur", re.I)),
    ("warehouse-unclear",     re.compile(r"\bwarehouse\b|cold storage|cross-dock|distribution", re.I)),
    ("outdoor-transload",     re.compile(r"outdoor transload|team track|\bbarge\b|grain elevator|ag facility|shuttle elevator", re.I)),
    ("transload",             re.compile(r"transload|truck\s*[-/]\s*rail|carload", re.I)),
]
# Descriptors that say nothing about the facility, only about the plan document.
NOISE = re.compile(r"operator name not printed|not printed in plan|major existing customer", re.I)

stats = Counter(); by_state = defaultdict(Counter); touched = []
for r in recs:
    name = str(r.get("company_name") or "")
    descs = [d for d in PAREN.findall(name) if not NOISE.search(d)]
    if not descs:
        stats["no_descriptor"] += 1; continue
    blob = " ; ".join(descs)
    ftype = next((t for t, rx in RULES if rx.search(blob)), None)
    if not ftype:
        stats["descriptor_unmatched"] += 1; continue
    clean = PAREN.sub("", name)
    clean = re.sub(r"\s{2,}", " ", clean).strip(" ,;-")
    r["facility_type"] = ftype
    r["facility_type_source"] = f"state-rail-plan-descriptor {today}"
    r["facility_descriptor"] = blob[:160]
    if clean and clean != name:
        r["display_name"] = clean
    stats[ftype] += 1
    by_state[r.get("state") or "?"][ftype] += 1
    touched.append((ftype, clean or name, r.get("state"), blob[:52]))

n = len(recs)
print(f"records {n}")
for k in ("third-party-warehouse", "warehouse-unclear", "outdoor-transload", "transload",
          "private-plant", "descriptor_unmatched", "no_descriptor"):
    if stats[k]: print(f"  {k:24} {stats[k]:6}")
classified = sum(stats[k] for k, _ in RULES)
print(f"\n  classified for free: {classified} ({classified/n*100:.1f}% of the dataset)")

print("\nCOVERAGE IS UNEVEN BY STATE — state rail plans use different vocabularies:")
tot = {s: sum(c.values()) for s, c in by_state.items()}
for s, c in sorted(by_state.items(), key=lambda kv: -sum(kv[1].values()))[:12]:
    wh = c["third-party-warehouse"] + c["warehouse-unclear"]
    print(f"  {s:3} {tot[s]:5} classified   warehouse-ish {wh:4}   third-party {c['third-party-warehouse']:3}")
covered = len([s for s in by_state if tot[s] >= 5])
print(f"  states with >=5 classified: {covered} of {len(set(r.get('state') for r in recs))}")

print("\nsample third-party-warehouse (name shown CLEANED):")
for t, nm, st, d in [x for x in touched if x[0] == "third-party-warehouse"][:10]:
    print(f"  {str(nm)[:44]:44} {st}   <- ({d})")

if a.write:
    bak = DATA.with_suffix(f".json.bak-descriptors-{datetime.now(timezone.utc):%Y%m%d%H%M}")
    shutil.copy2(DATA, bak)
    DATA.write_text(json.dumps(doc))
    print(f"\nWROTE {DATA.name}  (backup {bak.name})")
else:
    print("\ndry run — pass --write to apply")
