#!/usr/bin/env python3
"""
Merge web-extracted commodity/capability data into transload-v2.json.

Follows the conventions of the existing transload-enrich-merge scripts:
crawler writes a .jsonl, this is the only thing that touches the dataset, it
never overwrites existing data, and every touched record carries provenance.

CRITICAL — extracted data is NOT verified data. `tier` is never changed. A
facility enriched here gets `commodities_source: "web-extracted YYYY-MM-DD"`
so the UI can render it as "stated on operator site" rather than "confirmed",
and so the whole batch can be found, re-run, or purged as a unit later.

Usage:
  python3 scripts/transload-commodity-merge.py <results.jsonl> [--write]
"""
import argparse, json, shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "tools" / "transload-directory" / "data" / "transload-v2.json"

ap = argparse.ArgumentParser()
ap.add_argument("results")
ap.add_argument("--write", action="store_true")
a = ap.parse_args()

today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
doc = json.loads(DATA.read_text())
recs = doc["facilities"]
VOCAB_C = set(doc["commodity_options"])
VOCAB_K = set(doc["capability_options"])

# Exact (name, city, state) — the same join the rest of the SWL data scripts use.
# A generic name can legitimately match more than one row, so an ambiguous key
# is skipped rather than guessed at.
index = {}
for r in recs:
    index.setdefault((r.get("name"), r.get("city"), r.get("state")), []).append(r)

rows = []
for line in Path(a.results).read_text().splitlines():
    if line.strip():
        try: rows.append(json.loads(line))
        except Exception: pass

stats = Counter()
touched = []
for row in rows:
    if not row.get("ok"):
        stats["skipped_failed_fetch"] += 1; continue
    cms = [c["value"] for c in (row.get("commodities") or []) if c.get("value") in VOCAB_C]
    kps = [c["value"] for c in (row.get("capabilities") or []) if c.get("value") in VOCAB_K]
    # de-dupe: the model can cite the same value from two different pages
    cms = sorted(set(cms)); kps = sorted(set(kps))
    if not cms and not kps:
        stats["no_data_extracted"] += 1; continue

    key = (row.get("name"), row.get("city"), row.get("state"))
    matches = index.get(key) or []
    if not matches:
        stats["unmatched"] += 1; continue
    if len(matches) > 1:
        stats["ambiguous_key_skipped"] += 1; continue
    rec = matches[0]

    # Never overwrite. Hand-curated data outranks anything scraped, and a
    # re-run must be idempotent.
    if rec.get("commodities") or rec.get("capabilities"):
        stats["already_had_data"] += 1; continue
    if rec.get("tier") == "verified":
        stats["skipped_verified"] += 1; continue

    rec["commodities"] = cms
    rec["capabilities"] = kps
    rec["commodities_source"] = f"web-extracted {today}"
    stats["enriched"] += 1
    touched.append((rec["name"], rec["city"], rec["state"], cms, kps))

print(f"results rows: {len(rows)}")
for k, v in stats.most_common():
    print(f"  {k:24} {v}")
print(f"\nsample of enriched records:")
for n, c, s, cms, kps in touched[:15]:
    print(f"  {n[:34]:34} {c[:16]:16} {s}  {cms}{' +' + str(len(kps)) + ' caps' if kps else ''}")

if a.write:
    if not touched:
        print("\nnothing to write"); raise SystemExit(0)
    bak = DATA.with_suffix(f".json.bak-commodity-{datetime.now(timezone.utc):%Y%m%d%H%M}")
    shutil.copy2(DATA, bak)
    # counts block is baked at build time and goes stale on hand edits
    doc["facilities"] = recs
    DATA.write_text(json.dumps(doc, indent=1))
    print(f"\nWROTE {DATA.name}  (backup {bak.name})")
    print("Next: rebuild the transload pages (node scripts/build-transload-pages.js) and deploy.")
else:
    print("\ndry run — pass --write to apply")
