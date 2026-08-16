#!/usr/bin/env python3
"""Merge enrich-results.jsonl into transload-v2.json. Jacob approved 2026-08-14.

Rules (agreed before the crawl ran):
  * Phones: written ONLY into records whose phone field is empty, and only from
    non-shared-domain results (the crawler already withheld phones on shared
    domains). Provenance appended to the note.
  * Staleness: dns / timeout / 404 / 5xx  -> "⚠ website unreachable <date>"
    appended to the record note. 403/429 are BOT-BLOCKS, not death — recorded
    as nothing (inconclusive). 3xx should not appear (urllib follows them).
  * Never deletes a record, never overwrites an existing phone.

Prints a summary; idempotent (re-running adds nothing twice).
"""
import json
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "tools/transload-directory/data"
STAMP = "2026-08-14"

results = {}
for line in (DATA / "enrich-results.jsonl").read_text().splitlines():
    try:
        r = json.loads(line)
        results[r["url"]] = r
    except Exception:
        pass

d = json.loads((DATA / "transload-v2.json").read_text())
phones = stale = blocked = 0
for f in d["facilities"]:
    u = f.get("website") or ""
    r = results.get(u)
    if not r:
        continue
    s = r["status"]
    dead = s in ("dns", "timeout", "error") or (isinstance(s, int) and (s == 404 or s >= 500))
    if isinstance(s, int) and s in (403, 429):
        blocked += 1
    if r.get("phone") and not f.get("phone"):
        f["phone"] = r["phone"]
        f["note"] = ((f.get("note") or "") + f" — phone from operator website {STAMP}").strip(" —")
        phones += 1
    marker = f"⚠ website unreachable {STAMP}"
    if dead and marker not in (f.get("note") or ""):
        f["note"] = ((f.get("note") or "") + f" — {marker} ({s})").strip(" —")
        stale += 1

json.dump(d, (DATA / "transload-v2.json").open("w"), indent=1)
have_phone = sum(1 for f in d["facilities"] if f.get("phone"))
print(f"phones written: {phones} | stale-flagged: {stale} | bot-blocked (untouched): {blocked}")
print(f"records with phone now: {have_phone}/{len(d['facilities'])} "
      f"({have_phone*100//len(d['facilities'])}%)")
