#!/usr/bin/env python3
"""
Recover the commodity data we already scraped from rebulk and then dropped.

The August refresh scraped 2,299 rebulk listings INCLUDING a commodity column
(work/rebulk-scrape.py:45 captures it, and rebulk-facilities.json carries it on
1,997 of 2,299 records). build-data-v2.py then set every candidate row's
commodity fields to UNKNOWN, so it never reached the dataset. This re-joins it.

Two vocabularies, deliberately kept apart:

  commodities           our fixed 12-value vocabulary — powers the directory filter.
                        ONLY populated from rebulk categories that map without
                        ambiguity.
  commodity_categories  rebulk's own coarse category string, stored verbatim for
                        every match. "Dry Bulk" spans Minerals / Frac Sand /
                        Chemicals (Dry) / Plastics (Dry); picking one would be a
                        guess dressed as data, so those stay OUT of `commodities`
                        but are preserved here rather than thrown away.

Usage:
  python3 scripts/transload-rebulk-category-merge.py [--write]
"""
import argparse, json, re, shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "tools" / "transload-directory" / "data" / "transload-v2.json"
REBULK = Path("/home/ubuntu/bots/assistant/businesses/steel-wheel/data/"
              "transload-refresh/work/rebulk-facilities.json")

# Only mappings where rebulk's category sits inside exactly one of our buckets.
# Deliberately excluded: Dry Bulk, Liquid Bulk, Agriculture, Building Materials,
# Machinery & Dimensional — each spans several of ours or none.
CLEAN = {
    "plastics":        "Plastics (Dry)",
    "forest products": "Lumber",   # our vocabulary has no Paper bucket; slightly lossy
    "metals":          "Steel",    # rebulk does not split ferrous/non-ferrous
    "aggregates":      "Minerals",
}

ap = argparse.ArgumentParser()
ap.add_argument("--write", action="store_true")
a = ap.parse_args()

today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
doc = json.loads(DATA.read_text())
recs = doc["facilities"]
reb = json.loads(REBULK.read_text())

norm = lambda s: re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()

def split_city(c):
    """rebulk stores city as 'Birmingham , AL' and state as 'alabama'."""
    m = re.match(r"^(.*?)\s*,\s*([A-Za-z]{2})\s*$", str(c or "").strip())
    return (m.group(1), m.group(2).upper()) if m else (str(c or "").strip(), None)

idx = {}
for r in reb:
    city, st = split_city(r.get("city"))
    if st:
        idx.setdefault((norm(city), st), []).append(r)

stats = Counter()
gained = Counter()
touched = []
for rec in recs:
    if rec.get("commodities"):
        stats["already_had_commodities"] += 1; continue
    cands = idx.get((norm(rec.get("city")), str(rec.get("state") or "").upper()), [])
    hit = [c for c in cands if norm(c.get("name")) == norm(rec.get("name"))]
    if len(hit) != 1:
        stats["no_single_exact_match"] += 1; continue
    raw = str(hit[0].get("commodities") or "").strip()
    if not raw:
        stats["match_had_no_commodity"] += 1; continue

    cats = [c.strip() for c in raw.split(",") if c.strip()]
    mapped = sorted({CLEAN[c.lower()] for c in cats if c.lower() in CLEAN})
    rec["commodity_categories"] = cats          # always preserved
    if mapped:
        rec["commodities"] = mapped
        rec["commodities_source"] = f"rebulk-category {today}"
        stats["enriched"] += 1
        for v in mapped: gained[v] += 1
        touched.append((rec["name"], rec["city"], rec["state"], mapped, cats))
    else:
        stats["categories_only_too_coarse"] += 1

print(f"rebulk records: {len(reb)}   dataset records: {len(recs)}")
for k, v in stats.most_common():
    print(f"  {k:28} {v}")
print(f"\nvalues gained: {dict(gained.most_common())}")
have = sum(1 for r in recs if r.get("commodities"))
print(f"commodity coverage would be: {have}/{len(recs)} ({have/len(recs)*100:.1f}%)")

print("\nsample (ours <- rebulk raw):")
for n, c, s, m, cats in touched[:12]:
    print(f"  {n[:30]:30} {c[:14]:14} {s}  {m}  <- {', '.join(cats)[:44]}")

if a.write:
    bak = DATA.with_suffix(f".json.bak-rebulkcat-{datetime.now(timezone.utc):%Y%m%d%H%M}")
    shutil.copy2(DATA, bak)
    DATA.write_text(json.dumps(doc, indent=1))
    print(f"\nWROTE {DATA.name}  (backup {bak.name})")
else:
    print("\ndry run — pass --write to apply")
