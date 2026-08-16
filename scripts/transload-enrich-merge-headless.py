#!/usr/bin/env python3
"""Merge enrich-results-headless.jsonl into transload-v2.json.

Same phone rules as the approved 2026-08-14 merge (transload-enrich-merge.py):
phones only into EMPTY phone fields, only from non-shared-domain results,
provenance appended to the note, never deletes a record.

Two additions specific to the headless retry pass:
  * REVIVE — a record flagged "⚠ website unreachable 2026-08-14 (...)" whose
    URL now serves 2xx/3xx in a real browser gets that flag REMOVED (the first
    pass's verdict was a bot wall or transient failure, not a dead site).
  * REPEAT-FAILURE LIST — URLs dead in BOTH passes are written to
    transload-repeat-failures.json for Jacob's verify-or-remove ruling.
    Records are never removed here.

Idempotent; prints a summary.
"""
import json
import re
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "tools/transload-directory/data"
STAMP = "2026-08-15"
# First-pass flag looks like: " — ⚠ website unreachable 2026-08-14 (404)"
FLAG_RE = re.compile(r"( — )?⚠ website unreachable 2026-08-14 \([^)]*\)")
DEAD = {"404", "500", "503", "523", "530", "dns", "timeout", "error"}

def norm_phone(p):
    """tel: hrefs and page text come back as +18005235020 / 9109442341 /
    303-340-2100 — normalize to the directory's (XXX) XXX-XXXX. Returns None
    for anything that isn't a clean 10-digit NANP number."""
    digits = re.sub(r"\D", "", p or "")
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        return None
    return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"


results = {}
for line in (DATA / "enrich-results-headless.jsonl").read_text().splitlines():
    try:
        r = json.loads(line)
        r["phone"] = norm_phone(r.get("phone"))
        results[r["url"]] = r
    except Exception:
        pass

d = json.loads((DATA / "transload-v2.json").read_text())

phones = revived = 0
repeat_failures = []
seen_urls = set()
for f in d["facilities"]:
    u = f.get("website") or ""
    r = results.get(u)
    if not r:
        continue
    status = str(r["status"])
    ok = status.isdigit() and 200 <= int(status) < 400
    if (ok and r.get("phone") and not r.get("shared_domain")
            and not f.get("phone")):
        f["phone"] = r["phone"]
        f["note"] = ((f.get("note") or "")
                     + f" — phone from operator website (headless) {STAMP}").strip(" —")
        phones += 1
    note = f.get("note") or ""
    if ok and FLAG_RE.search(note):
        f["note"] = FLAG_RE.sub("", note).strip(" —")
        revived += 1
    if status in DEAD and u not in seen_urls:
        seen_urls.add(u)
        repeat_failures.append({"url": u, "first_pass": r.get("prev_status"),
                                "headless": status, "records": r.get("records", 1),
                                "name": f.get("name")})

json.dump(d, (DATA / "transload-v2.json").open("w"), indent=1)
json.dump(repeat_failures, (DATA / "transload-repeat-failures.json").open("w"),
          indent=1)

total = len(d["facilities"])
with_phone = sum(1 for x in d["facilities"] if x.get("phone"))
print(f"headless phones written: {phones} | revived (flag removed): {revived} "
      f"| repeat-failure URLs: {len(repeat_failures)}")
print(f"records with phone now: {with_phone}/{total} ({100*with_phone//total}%)")
