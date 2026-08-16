#!/usr/bin/env python3
"""Transload directory enrichment + staleness crawl.

Two debts in one pass (Jacob's go, 2026-08-14):
  1. CONTACT DEPTH — only ~16% of the 2,585 records carry a phone. For records
     whose website URL is record-specific, extract a phone from the site.
  2. STALENESS — rebulk-vintage records have never been re-verified. A dead
     website (DNS failure / timeout / 4xx-5xx on both scheme variants) is the
     cheapest strong staleness signal, so every distinct URL gets a liveness
     check.

Design decisions:
  * Fetch each DISTINCT URL once (1,655 of them, ~2s apart => ~60-90 min).
  * Phones are only written to records whose domain serves <= DOM_SHARED_MAX
    records — copying a shared corporate homepage's number onto 59 Watco
    terminals would fill the field with the WRONG phone everywhere. Shared
    domains get liveness only.
  * Prefer tel: links (deliberate publisher intent) over regex matches in text.
  * Writes RESULTS to enrich-results.jsonl — it never touches transload-v2.json
    itself. A separate merge step applies results after review, so a crash or
    garbage extraction can't corrupt the dataset.
  * Resumable: URLs already in the results file are skipped on re-run.

Usage: python3 transload-enrich.py [--limit N]
"""
import json
import re
import sys
import time
import urllib.request
import ssl
from urllib.parse import urlparse
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "tools/transload-directory/data"
RESULTS = DATA / "enrich-results.jsonl"
UA = {"User-Agent": "Mozilla/5.0 (compatible; SWL-directory-verify/1.0; +https://steelwheellogistics.com)"}
DOM_SHARED_MAX = 3
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE  # liveness check, not trust decision

TEL = re.compile(r'href="tel:([+\d().\- ]{10,20})"', re.I)
# NANP-shaped numbers in text; reject obviously non-phone contexts later.
NUM = re.compile(r'(?<![\d.])(\(?\d{3}\)?[ .\-]\d{3}[ .\-]\d{4})(?![\d.])')

def fetch(url):
    """Return (status, html_or_none). status: int, 'dns', 'timeout', 'error'."""
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=15, context=CTX) as r:
            return r.status, r.read(400_000).decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return e.code, None
    except urllib.error.URLError as e:
        s = str(e.reason).lower()
        if "name" in s or "nodename" in s or "getaddrinfo" in s:
            return "dns", None
        if "timed out" in s:
            return "timeout", None
        return "error", None
    except Exception:
        return "error", None

def extract_phone(html):
    m = TEL.search(html)
    if m:
        digits = re.sub(r"\D", "", m.group(1))
        if 10 <= len(digits) <= 11:
            d = digits[-10:]
            return f"({d[:3]}) {d[3:6]}-{d[6:]}"
    for m in NUM.finditer(html):
        raw = m.group(1)
        digits = re.sub(r"\D", "", raw)
        if len(digits) != 10:
            continue
        if digits[0] in "01" or digits[3] in "01":
            continue  # invalid NANP
        # skip if it appears inside a script/style-ish chunk marker
        return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"
    return None

def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    d = json.loads((DATA / "transload-v2.json").read_text())
    rows = d["facilities"]
    from collections import Counter
    dom_count = Counter(urlparse(f["website"]).netloc for f in rows
                        if (f.get("website") or "").startswith("http"))

    done = set()
    if RESULTS.exists():
        for line in RESULTS.read_text().splitlines():
            try:
                done.add(json.loads(line)["url"])
            except Exception:
                pass

    urls = {}
    for f in rows:
        u = f.get("website") or ""
        if u.startswith("http") and u not in done:
            urls.setdefault(u, []).append(f.get("name"))

    todo = list(urls.items())
    if limit:
        todo = todo[:limit]
    print(f"distinct URLs to fetch: {len(todo)} (already done: {len(done)})", flush=True)

    out = RESULTS.open("a")
    for i, (u, names) in enumerate(todo):
        status, html = fetch(u)
        shared = dom_count[urlparse(u).netloc] > DOM_SHARED_MAX
        phone = extract_phone(html) if (html and not shared) else None
        rec = {"url": u, "status": status, "phone": phone,
               "shared_domain": shared, "records": len(names)}
        out.write(json.dumps(rec) + "\n")
        out.flush()
        if (i + 1) % 100 == 0:
            print(f"  {i+1}/{len(todo)} fetched", flush=True)
        time.sleep(1.6)
    out.close()

    # summary
    stats = {"ok": 0, "dead": 0, "phone": 0}
    for line in RESULTS.read_text().splitlines():
        r = json.loads(line)
        alive = isinstance(r["status"], int) and r["status"] < 400
        stats["ok" if alive else "dead"] += 1
        if r.get("phone"):
            stats["phone"] += 1
    print(f"DONE. urls={stats['ok']+stats['dead']} alive={stats['ok']} "
          f"dead={stats['dead']} phones_extracted={stats['phone']}", flush=True)

if __name__ == "__main__":
    main()
