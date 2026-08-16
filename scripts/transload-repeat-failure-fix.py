#!/usr/bin/env python3
"""Repeat-failure fix pass (Jacob approved 2026-08-15).

Input: transload-repeat-failures.json (88 URLs dead in BOTH the 08-14 plain
crawl and the 08-15 headless retry), covering 219 records.

Tiers:
  1. 404s — domain alive, page moved. Probe the domain ROOT: any HTTP response
     (200/3xx/403/429) proves the domain is alive → repoint record website to
     the root, clear the ⚠ flag, provenance-note the change.
  2. dns — domain gone. Strip the dead website link; KEEP the record, phone,
     and ⚠ flag; provenance-note.
  3. everything else (5xx/timeout/error) — untouched here; re-probe scheduled
     2026-08-29 (brain.md/goals dated item).

Never deletes a record. Idempotent (already-fixed records are skipped because
their URL no longer matches the failure list).
"""
import json
import re
import ssl
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

DATA = Path(__file__).resolve().parent.parent / "tools/transload-directory/data"
STAMP = "2026-08-15"
FLAG_RE = re.compile(r"( — )?⚠ website unreachable 2026-08-14 \([^)]*\)")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"}
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

failures = json.load(open(DATA / "transload-repeat-failures.json"))
tier1 = [f for f in failures if str(f["headless"]) == "404"]
tier2 = [f for f in failures if f["headless"] == "dns"]
tier3 = [f for f in failures if f not in tier1 and f not in tier2]


def root_of(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}/"


def root_alive(url: str) -> bool:
    """Any HTTP response at all (incl. 403/404-at-root edge) = domain alive.
    Only network-level failure (dns/timeout/conn refused) = not alive."""
    root = root_of(url)
    try:
        req = urllib.request.Request(root, headers=UA)
        urllib.request.urlopen(req, timeout=15, context=CTX)
        return True
    except urllib.error.HTTPError:
        return True  # server answered — domain alive
    except Exception:
        return False


print(f"tiers: 404={len(tier1)} dns={len(tier2)} transient={len(tier3)}")
with ThreadPoolExecutor(max_workers=8) as ex:
    alive = dict(zip([f["url"] for f in tier1],
                     ex.map(root_alive, [f["url"] for f in tier1])))
print(f"tier-1 roots alive: {sum(alive.values())}/{len(tier1)}")

repoint = {f["url"]: root_of(f["url"]) for f in tier1 if alive.get(f["url"])}
demote = {f["url"] for f in tier1 if not alive.get(f["url"])}  # root dead too → tier-2 treatment
strip = {f["url"] for f in tier2} | demote

d = json.loads((DATA / "transload-v2.json").read_text())
repointed = stripped = flags_cleared = 0
for rec in d["facilities"]:
    u = (rec.get("website") or "").strip()
    if not u:
        continue
    note = rec.get("note") or ""
    if u in repoint:
        rec["website"] = repoint[u]
        new_note = FLAG_RE.sub("", note).strip(" —")
        if new_note != note:
            flags_cleared += 1
        rec["note"] = (new_note + f" — website repointed to homepage {STAMP} (old page removed)").strip(" —")
        repointed += 1
    elif u in strip:
        rec["website"] = ""
        rec["note"] = (note + f" — dead domain link removed {STAMP}").strip(" —")
        stripped += 1

json.dump(d, (DATA / "transload-v2.json").open("w"), indent=1)
print(f"records repointed: {repointed} (flags cleared: {flags_cleared}) | "
      f"dead links stripped: {stripped} | transient untouched: {len(tier3)} URLs")
json.dump(tier3, (DATA / "transload-reprobe-2026-08-29.json").open("w"), indent=1)
print(f"tier-3 re-probe list -> transload-reprobe-2026-08-29.json")
