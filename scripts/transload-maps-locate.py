#!/usr/bin/env python3
"""
Resolve facility street addresses + coordinates via the Apify Google Maps actor.

Why this and not the website scrape: the website pipeline resolved 19% (600 of
1,347 pages simply do not publish a parseable address). The August Apify Maps
run returned an address for 713 of 719 places — 99% — plus phone and Google's
own business category, which is an independent second opinion on facility type.

Why coordinates matter so much here: Jacob spotted that some "rail-served"
warehouses were not near rail. Chasing it found 1,375 facilities sharing an
exact coordinate — city centroids, not buildings. And once real addresses
existed, the proximity threshold could be tightened from 1.0 mi to 0.26 mi,
which correctly separates R&S's rail-served LD1 warehouse (0.08 mi) from their
Knoxville head office (0.31 mi). Street addresses are the load-bearing input for
every rail claim in this dataset.

MONEY GUARDS — this spends real prepaid credit:
  * hard --max-spend, checked against the live balance before starting and
    enforced by capping how many queries are sent
  * NEVER tops up. The x402 top-up MINTS A NEW TOKEN THAT REPLACES THE OLD ONE,
    forfeiting any remaining balance (cost $6.74 to learn, 2026-07-27). Only
    scripts/apify-topup-guarded.sh may ever mint, and only when nearly empty.
  * resumable — a re-run costs nothing for places already fetched

Usage:
  python3 scripts/transload-maps-locate.py --warehouses --max-spend 0.60
  python3 scripts/transload-maps-locate.py --no-coords --max-spend 0.80
"""
import argparse, json, re, subprocess, sys, time, urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "tools" / "transload-directory" / "data" / "transload-v2.json"
OUT = ROOT / "tools" / "transload-directory" / "data" / "maps-located.jsonl"
TOKEN_PATH = "/home/ubuntu/bots/x402-rig/secrets/token.json"
ACTOR = "compass~crawler-google-places"
BAL = "https://agi.apify.com/prepaid-tokens/balance"
COST_PER_PLACE = 0.0040          # measured: 719 places / $2.87 in the August run

ap = argparse.ArgumentParser()
ap.add_argument("--max-spend", type=float, default=0.50)
ap.add_argument("--warehouses", action="store_true", help="unverified third-party warehouses first")
ap.add_argument("--unproven-coords", action="store_true",
                help="excluded warehouses whose coordinate is NOT Maps-sourced — a bad\n                      address, not absent rail, may be why they fail")
ap.add_argument("--no-coords", action="store_true", help="records with no coordinate at all")
ap.add_argument("--ambiguous-first", action="store_true",
                help="only records whose rail verdict a real address would change")
ap.add_argument("--limit", type=int, default=0)
ap.add_argument("--memory", type=int, default=4096,
                help="actor memory MB — Apify reserves against this at run start, so a\n                      smaller box can start on a smaller balance")
ap.add_argument("--refetch", default=None,
                help="re-read a finished run's dataset and re-join (costs nothing)")
a = ap.parse_args()

def token():
    raw = json.loads(Path(TOKEN_PATH).read_text())
    d = raw.get("data", raw)
    for o in (d, d.get("data") if isinstance(d, dict) else None, raw):
        if not isinstance(o, dict): continue
        for k in ("token", "apiToken", "prepaidToken", "value", "accessToken", "id"):
            if o.get(k): return o[k]
    sys.exit("no Apify prepaid token found")

AUTH = {"Authorization": "Bearer " + token()}

def balance():
    req = urllib.request.Request(BAL, headers=AUTH)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode()).get("remainingBalanceUsd")

if a.refetch:
    # Fetching a finished run's dataset is free. Used to re-join results after
    # fixing the matcher, without paying for the same places twice.
    rd = json.load(urllib.request.urlopen(urllib.request.Request(
        f"https://api.apify.com/v2/actor-runs/{a.refetch}", headers=AUTH), timeout=60))["data"]
    its = json.load(urllib.request.urlopen(urllib.request.Request(
        f"https://api.apify.com/v2/datasets/{rd['defaultDatasetId']}/items?format=json&clean=true&limit=1000",
        headers=AUTH), timeout=90))
    Path("/home/ubuntu/maps-raw.json").write_text(json.dumps(its))
    globals()["got"] = its
    print(f"refetched {len(its)} items -> /home/ubuntu/maps-raw.json")
    print("  fields:", sorted(its[0].keys())[:24] if its else "none")
    for k in ("searchString","title","address","city","categoryName","phone"):
        print(f"   {k:14}", repr(its[0].get(k))[:72] if its else "")
    raise SystemExit(0)

bal = balance()
print(f"prepaid balance: ${bal:.2f}   spend cap this run: ${a.max_spend:.2f}")
if bal is None or bal <= 0.05:
    sys.exit("balance too low — NOT topping up (top-up mints-and-replaces; use apify-topup-guarded.sh)")
budget = min(a.max_spend, bal - 0.05)
max_places = int(budget / COST_PER_PLACE)
print(f"  -> at ${COST_PER_PLACE}/place that is {max_places} lookups")

doc = json.loads(DATA.read_text()); recs = doc["facilities"]
coords = Counter((r.get("lat"), r.get("lng")) for r in recs if r.get("lat"))
def centroid(r): return r.get("lat") and coords[(r["lat"], r["lng"])] > 1

pool = []
for r in recs:
    if a.unproven_coords:
        # The decisive group: classified warehouses that FAIL the rail test while
        # sitting on a coordinate we never verified. 120 of them are within a mile
        # of track, so coordinate quality — not rail — is deciding the verdict.
        if r.get("facility_type") != "third-party-warehouse": continue
        if r.get("rail_confidence") in ("high", "probable"): continue
        if str(r.get("location_source") or "").startswith("google-maps"): continue
        if not r.get("name") or not r.get("city") or not r.get("state"): continue
        pool.append(r); continue
    if a.warehouses and r.get("facility_type") != "third-party-warehouse": continue
    if a.no_coords and r.get("lat"): continue
    if not a.no_coords and not (centroid(r) or not r.get("lat")): continue
    if a.ambiguous_first and r.get("rail_confidence") not in ("possible", "unlikely", None): continue
    if not r.get("name") or not r.get("city") or not r.get("state"): continue
    pool.append(r)

done = set()
if OUT.exists():
    for ln in OUT.read_text().splitlines():
        try: done.add(json.loads(ln)["query"])
        except Exception: pass

queries, targets = [], []
for r in pool:
    q = f"{r['name']}, {r['city']}, {r['state']}"
    if q in done: continue
    queries.append(q); targets.append(r)
if a.limit: queries, targets = queries[:a.limit], targets[:a.limit]
queries, targets = queries[:max_places], targets[:max_places]
print(f"eligible: {len(pool)}   querying: {len(queries)}   est spend ${len(queries)*COST_PER_PLACE:.2f}")
if not queries: sys.exit("nothing to do")

def start(inp):
    body = json.dumps(inp).encode()
    req = urllib.request.Request(f"https://api.apify.com/v2/acts/{ACTOR}/runs?memory={a.memory}",
                                 data=body, headers={**AUTH, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())["data"]

def poll(rid, tries=5):
    """Retry transient 5xx. A single 502 once crashed a run that had already
    completed on Apify's side — the data was recoverable via --refetch, but the
    client should not fall over on a blip it can simply wait out."""
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(f"https://api.apify.com/v2/actor-runs/{rid}", headers=AUTH)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode())["data"]
        except Exception as e:
            last = e
            code = getattr(e, "code", None)
            if code and code < 500 and code != 429:
                raise
            print(f"  poll retry {i+1}/{tries} after {type(e).__name__} {code or ''}")
            time.sleep(10 * (i + 1))
    raise last

def items(ds):
    req = urllib.request.Request(
        f"https://api.apify.com/v2/datasets/{ds}/items?format=json&clean=true&limit=1000", headers=AUTH)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())

run = start({"searchStringsArray": queries, "maxCrawledPlacesPerSearch": 1,
             "language": "en", "skipClosedPlaces": False, "maxImages": 0, "maxReviews": 0})
rid = run["id"]
print(f"run {rid} started; polling…")
status = None
for _ in range(120):
    time.sleep(20)
    d = poll(rid); status = d.get("status")
    if status in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"):
        break
    print(f"  … {status}")
print(f"run {status}")
got = items(run["defaultDatasetId"]) if run.get("defaultDatasetId") else []
print(f"places returned: {len(got)}")

norm = lambda s: re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()
# The actor echoes the originating query back on each item as `searchString`,
# which is an exact 1:1 key. Matching on `title` instead lost 84 of 111 —
# Google returns "V. Van Dyke, Inc." for our "V. Van Dyke, Inc. Transload Yard".
by_query = {}
for it in got:
    by_query.setdefault(str(it.get("searchString") or ""), []).append(it)

st = Counter()
with OUT.open("a") as fh:
    for r, q in zip(targets, queries):
        hits = by_query.get(q) or []
        # Still require the city to agree: a search can land on a different
        # branch of the same company in another town.
        pick = next((h for h in hits if norm(h.get("city")) == norm(r["city"])), None) \
               or (hits[0] if len(hits) == 1 and norm(hits[0].get("state") or "") in ("", norm(r["state"])) else None)
        rec = {"query": q, "name": r["name"], "city": r["city"], "state": r["state"]}
        if not pick:
            st["no_match"] += 1
            fh.write(json.dumps({**rec, "ok": False}) + "\n"); continue
        loc = pick.get("location") or {}
        rec.update(ok=True, address=pick.get("address"), street=pick.get("street"),
                   postal=pick.get("postalCode"), phone=pick.get("phone"),
                   category=pick.get("categoryName"), website=pick.get("website"),
                   lat=loc.get("lat"), lng=loc.get("lng"))
        st["located" if loc.get("lat") else "matched_no_coords"] += 1
        fh.write(json.dumps(rec) + "\n")

after = balance()
print("\n" + "=" * 56 + "\nMAPS LOCATE RESULT\n" + "=" * 56)
for k, v in st.most_common(): print(f"  {k:20} {v}")
print(f"  balance ${bal:.2f} -> ${after:.2f}   (spent ${bal - after:.2f})")
print(f"  results: {OUT}")
