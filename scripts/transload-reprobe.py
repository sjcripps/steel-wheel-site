#!/usr/bin/env python3
"""Transload website-link health job — the runnable version of the 2026-08-29
re-probe that only ever existed as a date in brain.md.

Background: transload-repeat-failure-fix.py (2026-08-15) cleared the 404 and
dns tiers and deferred the "transient" tier (5xx/timeout/error, 30 URLs) to a
re-probe dated 2026-08-29. There was no script and no cron behind that date, so
it lapsed silently. This job replaces the human due-date with a self-scheduling
loop: a due queue is processed, survivors are re-queued with a new due date, and
--sweep re-checks a rolling slice of the live directory so a link that dies
later is caught without anyone writing another date in a markdown file.

Strike discipline (uniform, carried in the queue entry):
  A link must fail 3 separate passes, days apart, before its URL is removed.
  The 08-14 crawl + 08-15 headless retry count as strikes 1 and 2, so the
  08-29 queue is seeded at strikes=2 and this pass is the deciding one.

Per-URL outcome:
  revived   — answers 2xx/3xx            -> keep link, clear the ⚠ flag, reset strikes
  blocked   — answers 403/429 (bot wall) -> keep link, clear the ⚠ flag (host is up)
  repointed — URL dead, domain ROOT answers -> repoint to root, clear the ⚠ flag
  pending   — failed, strikes < 3        -> record UNTOUCHED, re-queued
  dead      — failed, strikes >= 3       -> strip the link, KEEP record + ⚠ flag

Never deletes a record. Idempotent: repointed/stripped URLs no longer match the
queue, so a re-run is a dataset no-op. --dry-run probes without writing.
"""
import argparse
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urlparse

SITE = Path(__file__).resolve().parent.parent
DATA = SITE / "tools/transload-directory/data"
DATASET = DATA / "transload-v2.json"
QUEUE_GLOB = "transload-reprobe-*.json"
RESULTS = DATA / "transload-reprobe-results.jsonl"
SWEEP_LEDGER = DATA / "transload-link-sweep-ledger.json"
RETRY_DAYS = 21          # gap between strikes — long enough that an outage clears
STRIKES_TO_STRIP = 3
SWEEP_DEFAULT = 150      # links per sweep run; whole directory cycles in ~6 months
FLAG_RE = re.compile(r"( — )?⚠ website unreachable \d{4}-\d{2}-\d{2} \([^)]*\)")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"}
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def probe(url, timeout=20):
    """-> (status, answered). answered means the host returned an HTTP response."""
    for attempt in (1, 2):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
                return str(r.status), True
        except urllib.error.HTTPError as e:
            return str(e.code), True
        except Exception as e:
            if attempt == 2:
                return ("timeout" if "timed out" in str(e).lower() else "error"), False
    return "error", False


def root_of(url):
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}/"


def good(status):
    """2xx/3xx — a real page for a real visitor."""
    return status.isdigit() and 200 <= int(status) < 400


def confirm(url):
    """Second opinion before we ever remove a link.

    Back-to-back probes of the same host disagree in practice — capeandson.com
    answered 200 and then errored five minutes apart, obegov.com 200 then 503 —
    so a single failed probe is not evidence a site is gone. Wait out the blip,
    retry url and root with a longer timeout, and take the best answer.
    """
    time.sleep(5)
    best = ("", False)
    for u in (url, root_of(url)):
        st, ans = probe(u, timeout=35)
        if good(st) or st in ("403", "429"):
            return u, st
        if ans and not best[1]:
            best = (st, True)
    return None, best[0]


def classify(item):
    """item needs {url, strikes}. Returns the item plus probe/kind/new_url."""
    url = item["url"]
    strikes = int(item.get("strikes") or 0)
    status, _ = probe(url)
    if good(status):
        return {**item, "probe": status, "kind": "revived", "new_url": url, "strikes": 0}
    if status in ("403", "429"):
        return {**item, "probe": status, "kind": "blocked", "new_url": url, "strikes": 0}

    root = root_of(url)
    if root.rstrip("/") == url.rstrip("/"):
        rstatus = status                      # url IS the root — no second chance to take
    else:
        rstatus, _ = probe(root)
        if good(rstatus) or rstatus in ("403", "429"):
            return {**item, "probe": status, "root_probe": rstatus,
                    "kind": "repointed", "new_url": root, "strikes": 0}

    strikes += 1
    if strikes >= STRIKES_TO_STRIP:
        live_url, cstatus = confirm(url)
        if live_url:
            kind = "repointed" if live_url != url else ("blocked" if cstatus in ("403", "429") else "revived")
            return {**item, "probe": status, "root_probe": rstatus, "confirm_probe": cstatus,
                    "kind": kind, "new_url": live_url, "strikes": 0}
        return {**item, "probe": status, "root_probe": rstatus, "confirm_probe": cstatus,
                "kind": "dead", "new_url": "", "strikes": strikes}
    return {**item, "probe": status, "root_probe": rstatus, "kind": "pending",
            "new_url": "", "strikes": strikes}


def clear_flag(note):
    return FLAG_RE.sub("", note or "").strip(" —")


def due_queues(today, force):
    out = []
    for p in sorted(DATA.glob(QUEUE_GLOB)):
        m = re.search(r"(\d{4}-\d{2}-\d{2})", p.name)
        if not m:
            continue
        d = date.fromisoformat(m.group(1))
        if force or d <= today:
            out.append((p, d))
    return out


def sweep_targets(n, queued_urls):
    """Oldest-unchecked live website links not already in a queue."""
    d = json.loads(DATASET.read_text())
    ledger = json.loads(SWEEP_LEDGER.read_text()) if SWEEP_LEDGER.exists() else {}
    urls = {}
    for rec in d["facilities"]:
        u = (rec.get("website") or "").strip()
        if u and u not in queued_urls:
            urls.setdefault(u, rec.get("name") or "")
    ordered = sorted(urls, key=lambda u: ledger.get(u, ""))
    return [{"url": u, "name": urls[u], "strikes": 0, "source": "sweep"} for u in ordered[:n]], ledger


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="probe only; never write")
    ap.add_argument("--force", action="store_true", help="run queues that are not yet due")
    ap.add_argument("--queue", help="explicit queue file")
    ap.add_argument("--sweep", nargs="?", type=int, const=SWEEP_DEFAULT, default=0,
                    help="also re-check N live links that no queue covers")
    args = ap.parse_args()

    today = date.today()
    stamp = today.isoformat()
    queues = [(Path(args.queue), today)] if args.queue else due_queues(today, args.force)

    items, sources = [], []
    for p, d in queues:
        q = json.loads(p.read_text())
        for it in q:
            it.setdefault("strikes", 2)   # 08-14 crawl + 08-15 headless already failed
        items += q
        sources.append(f"{p.name}(due {d}, {len(q)})")

    ledger = {}
    if args.sweep:
        sw, ledger = sweep_targets(args.sweep, {i["url"] for i in items})
        items += sw
        sources.append(f"sweep({len(sw)})")

    if not items:
        print(f"no re-probe queue due as of {stamp} and no sweep requested — nothing to do")
        return 0
    print(f"queues: {', '.join(sources)} -> {len(items)} urls")

    with ThreadPoolExecutor(max_workers=6) as ex:
        results = list(ex.map(classify, items))

    counts = {}
    for r in results:
        counts[r["kind"]] = counts.get(r["kind"], 0) + 1
    print("probe: " + " ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    for r in sorted(results, key=lambda r: r["kind"]):
        if r["kind"] != "revived" or not args.sweep:
            print(f"  {r['kind']:<9} {r['probe']:>7} strikes={r['strikes']} {r['url']}"
                  + (f" -> {r['new_url']}" if r["kind"] == "repointed" else ""))

    if args.dry_run:
        print("DRY RUN — dataset untouched")
        return 0

    d = json.loads(DATASET.read_text())
    plan = {r["url"]: r for r in results}
    unflagged = repointed = stripped = 0
    for rec in d["facilities"]:
        u = (rec.get("website") or "").strip()
        r = plan.get(u)
        if not r:
            continue
        note = rec.get("note") or ""
        if r["kind"] in ("revived", "blocked"):
            rec["note"] = clear_flag(note)
            unflagged += note != rec["note"]
        elif r["kind"] == "repointed":
            rec["website"] = r["new_url"]
            rec["note"] = (clear_flag(note)
                           + f" — website repointed to homepage {stamp} (old page removed)").strip(" —")
            repointed += 1
            unflagged += "⚠" in note
        elif r["kind"] == "dead":
            rec["website"] = ""
            rec["note"] = (note + f" — dead domain link removed {stamp}").strip(" —")
            stripped += 1
        # pending: record untouched by design
    DATASET.write_text(json.dumps(d, indent=1))
    print(f"records: flags cleared {unflagged} | repointed {repointed} | links stripped {stripped}")

    with RESULTS.open("a") as f:
        for r in results:
            f.write(json.dumps({"run": stamp, **r}) + "\n")

    if args.sweep:
        for r in results:
            if r.get("source") == "sweep":
                ledger[r["url"]] = stamp
        SWEEP_LEDGER.write_text(json.dumps(ledger, indent=0, sort_keys=True))
        print(f"sweep ledger: {len(ledger)} urls checked at least once")

    # --- self-heal: survivors carry their strikes forward on a new due date ---
    for p, _ in queues:
        p.unlink()
        print(f"consumed {p.name}")
    retry = [{k: r.get(k) for k in ("url", "name", "records", "strikes", "source")}
             | {"last_probe": r["probe"], "last_run": stamp}
             for r in results if r["kind"] == "pending"]
    if retry:
        nxt = today + timedelta(days=RETRY_DAYS)
        out = DATA / f"transload-reprobe-{nxt.isoformat()}.json"
        json.dump(retry, out.open("w"), indent=1)
        print(f"re-queued {len(retry)} urls -> {out.name} (due {nxt})")
    else:
        print("no survivors to re-queue")
    return 0


if __name__ == "__main__":
    sys.exit(main())
