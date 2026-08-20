#!/usr/bin/env python3
"""
Resolve websites for rail-served warehouse candidates that have none.

The rail-served dataset (businesses.json, built from OSM spur geometry) carries
company name + state, but 0% websites and 0% phones. Those ~504 warehouse-signal
records are the ones that never appear in a railroad's transload directory —
indoor storage that doesn't market itself as transload — which is exactly the
gap a caller hit looking for baled-pulp storage near Knoxville.

Uses Firecrawl /v1/search (free tier, 885 credits at time of writing) rather
than Outscraper, which is under a standing do-not-run-without-approval rule.

ONE credit per candidate. The script hard-stops at --budget so a bug cannot
drain the month's quota, and is resumable so a re-run costs nothing for
already-resolved rows.

Writes data/warehouse-sites.jsonl. Touches no dataset.

Usage:
  FIRECRAWL_API_KEY=... python3 scripts/warehouse-resolve-sites.py --limit 25
  FIRECRAWL_API_KEY=... python3 scripts/warehouse-resolve-sites.py --all --budget 520
"""
import argparse, json, os, re, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RS = ROOT / "tools" / "rail-served-businesses" / "data" / "businesses.json"
TL = ROOT / "tools" / "transload-directory" / "data" / "transload-v2.json"
OUT = ROOT / "tools" / "transload-directory" / "data" / "warehouse-sites.jsonl"
API = "https://api.firecrawl.dev/v1/search"

ap = argparse.ArgumentParser()
ap.add_argument("--limit", type=int, default=25)
ap.add_argument("--all", action="store_true")
ap.add_argument("--budget", type=int, default=60, help="hard cap on searches this run")
a = ap.parse_args()

KEY = os.environ.get("FIRECRAWL_API_KEY", "").strip()
if not KEY: sys.exit("FIRECRAWL_API_KEY not set")

norm = lambda s: re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()
WH = re.compile(r"warehous|cold storage|distribution cent|3pl|storage|logistics|fulfil", re.I)

tl = json.loads(TL.read_text())["facilities"]
tl_keys = {(norm(x.get("name")), str(x.get("state") or "").upper()) for x in tl}
b = json.loads(RS.read_text())["businesses"]

pool = []
for x in b:
    nm = str(x.get("company_name") or "")
    if not WH.search(nm): continue
    if (norm(nm), str(x.get("state") or "").upper()) in tl_keys: continue   # already have it
    pool.append(x)
# A candidate with a city resolves far more reliably than name+state alone.
pool.sort(key=lambda x: (0 if x.get("city") else 1, x.get("state") or "", x.get("company_name") or ""))
targets = pool if a.all else pool[:a.limit]
print(f"warehouse candidates without a website: {len(pool)}  ->  attempting {len(targets)} (budget {a.budget})")

done = set()
if OUT.exists():
    for ln in OUT.read_text().splitlines():
        try: done.add(json.loads(ln)["key"])
        except Exception: pass

# Junk hosts a name search will surface instead of the operator's own site.
JUNK = re.compile(r"(indeed|linkedin|facebook|glassdoor|yelp|bbb\.org|zoominfo|dnb\.com|"
                  r"manta|bloomberg|crunchbase|mapquest|yellowpages|buzzfile|apollo\.io|"
                  r"wikipedia|youtube|instagram|twitter|x\.com|trustpilot|ziprecruiter)", re.I)
PHONE = re.compile(r"\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b")

def search(q):
    body = json.dumps({"query": q, "limit": 5}).encode()
    req = urllib.request.Request(API, data=body, headers={
        "Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())

spent = 0
stats = dict(attempted=0, resolved=0, phone=0, none=0, error=0)
with OUT.open("a") as fh:
    for i, x in enumerate(targets, 1):
        if spent >= a.budget:
            print(f"\n  BUDGET STOP at {spent} searches"); break
        nm, city, st = x.get("company_name"), x.get("city"), x.get("state")
        key = f"{norm(nm)}|{norm(city)}|{st}"
        if key in done: continue
        q = " ".join(filter(None, [nm, city, st, "rail served warehouse"]))
        stats["attempted"] += 1; spent += 1
        rec = {"key": key, "name": nm, "city": city, "state": st,
               "rr": ",".join(x.get("serving_railroads") or [])}
        try:
            res = search(q)
        except Exception as e:
            stats["error"] += 1
            fh.write(json.dumps({**rec, "ok": False, "error": str(e)[:110]}) + "\n"); fh.flush()
            print(f"  [{i:3}] ERROR {str(nm)[:34]}"); time.sleep(1.2); continue

        hits = [h for h in (res.get("data") or []) if not JUNK.search(str(h.get("url") or ""))]
        best = hits[0] if hits else None
        phone = None
        for h in hits[:3]:
            m = PHONE.search(str(h.get("description") or ""))
            if m: phone = m.group(0); break
        if best:
            stats["resolved"] += 1
            if phone: stats["phone"] += 1
            rec.update(ok=True, website=best.get("url"), title=best.get("title"),
                       snippet=str(best.get("description") or "")[:300], phone=phone,
                       alts=[h.get("url") for h in hits[1:3]])
            print(f"  [{i:3}] {str(nm)[:30]:30} -> {str(best.get('url'))[:44]}"
                  + (f"  ph {phone}" if phone else ""))
        else:
            stats["none"] += 1
            rec.update(ok=True, website=None)
            print(f"  [{i:3}] {str(nm)[:30]:30} -> (nothing usable)")
        fh.write(json.dumps(rec) + "\n"); fh.flush()
        time.sleep(1.2)

n = max(1, stats["attempted"])
print("\n" + "="*58 + "\nRESOLUTION RESULT\n" + "="*58)
print(f"  attempted        {stats['attempted']}   (credits spent: {spent})")
print(f"  website resolved {stats['resolved']}  ({stats['resolved']/n*100:.0f}%)")
print(f"  phone captured   {stats['phone']}  ({stats['phone']/n*100:.0f}%)")
print(f"  nothing usable   {stats['none']}   errors {stats['error']}")
print(f"  remaining pool   {len(pool) - len(done) - stats['attempted']}")
print(f"  results: {OUT}")
