#!/usr/bin/env python3
"""Merge facility_type / indoor_storage into transload-v2.json.

Same discipline as the commodity merges: exact (name, city, state) join,
single-candidate only, never overwrites, provenance stamped so the batch stays
identifiable and purgeable. `tier` is never touched.

Usage: python3 scripts/transload-facility-type-merge.py <results.jsonl> [--write]
"""
import argparse, json, shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "tools" / "transload-directory" / "data" / "transload-v2.json"

ap = argparse.ArgumentParser()
ap.add_argument("results"); ap.add_argument("--write", action="store_true")
a = ap.parse_args()

today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
doc = json.loads(DATA.read_text()); recs = doc["facilities"]
idx = {}
for r in recs:
    idx.setdefault((r.get("name"), r.get("city"), r.get("state")), []).append(r)

st = Counter(); types = Counter()
for line in Path(a.results).read_text().splitlines():
    if not line.strip(): continue
    try: row = json.loads(line)
    except Exception: continue
    if not row.get("ok"): st["skipped_fetch_fail"] += 1; continue
    ft = row.get("facility_type")
    if ft in (None, "unknown") and not row.get("indoor_storage"):
        st["nothing_to_record"] += 1; continue
    m = idx.get((row.get("name"), row.get("city"), row.get("state")) ) or []
    if len(m) != 1: st["no_single_match"] += 1; continue
    rec = m[0]
    if rec.get("facility_type"): st["already_set"] += 1; continue
    if ft and ft != "unknown":
        rec["facility_type"] = ft; types[ft] += 1
    if row.get("indoor_storage"):
        rec["indoor_storage"] = True
    rec["facility_type_source"] = f"web-extracted {today}"
    st["enriched"] += 1

print(f"results rows processed")
for k, v in st.most_common(): print(f"  {k:22} {v}")
print("  types:", dict(types))
print(f"  indoor_storage set: {sum(1 for r in recs if r.get('indoor_storage'))}")

if a.write:
    bak = DATA.with_suffix(f".json.bak-ftype-{datetime.now(timezone.utc):%Y%m%d%H%M}")
    shutil.copy2(DATA, bak); DATA.write_text(json.dumps(doc, indent=1))
    print(f"\nWROTE {DATA.name}  (backup {bak.name})")
else:
    print("\ndry run — pass --write to apply")

