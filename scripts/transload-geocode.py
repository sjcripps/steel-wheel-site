#!/usr/bin/env python3
"""
Give facilities real coordinates instead of city centroids.

Jacob spot-checked the warehouse shortlist and said several did not look
rail-served. Chasing that down found the underlying problem: 1,375 of 2,490
facilities share an EXACT coordinate with another facility — 20 sitting on
New Orleans city centre, 19 on Stockton, 16 on Tacoma. They are city centroids,
not buildings. Any rail-proximity check against them measures how close the city
centre is to track, which says nothing about the facility, and it was quietly
producing a pass rate that looked like validation.

Pipeline, all free — no paid geocoder, no Outscraper:
  1. fetch the operator site (92% of the directory has one)
  2. pull a street address CONSTRAINED to the facility's own city + state, so a
     multi-location operator's HQ cannot be mistaken for this site
  3. geocode with the US Census geocoder (free, keyless, and measurably more
     precise than Nominatim, which matched "Old Cornelia Highway" 3 mi from the
     right road on the calibration address)

Writes data/geocoded.jsonl. Touches no dataset. Records both the extracted
address and how far the new point moved from the old one, so a bad extraction
is visible rather than silently overwriting a coordinate.

Usage:
  python3 scripts/transload-geocode.py --warehouses-first --limit 40
  python3 scripts/transload-geocode.py --all
"""
import argparse, json, math, re, ssl, time, urllib.parse, urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "tools" / "transload-directory" / "data" / "transload-v2.json"
OUT = ROOT / "tools" / "transload-directory" / "data" / "geocoded.jsonl"
# --out lets a retry write to a fresh file so previously-attempted rows
# are re-tried after an extractor change, instead of being skipped as done.
CENSUS = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
UA = "Mozilla/5.0 (compatible; SteelWheelLogistics-directory/1.0; +https://steelwheellogistics.com)"

ap = argparse.ArgumentParser()
ap.add_argument("--limit", type=int, default=40)
ap.add_argument("--all", action="store_true")
ap.add_argument("--warehouses-first", action="store_true")
ap.add_argument("--out", default=None)
a = ap.parse_args()

if a.out: OUT = DATA.parent / a.out
doc = json.loads(DATA.read_text()); recs = doc["facilities"]
coords = Counter((r.get("lat"), r.get("lng")) for r in recs if r.get("lat"))

def is_centroid(r):
    return r.get("lat") and coords[(r["lat"], r["lng"])] > 1

pool = [r for r in recs if r.get("website") and (is_centroid(r) or not r.get("lat"))]
if a.warehouses_first:
    pool.sort(key=lambda r: (r.get("facility_type") != "third-party-warehouse",
                             r.get("state") or "", r.get("name") or ""))
targets = pool if a.all else pool[: a.limit]
print(f"needing a real coordinate: {len(pool)}  ->  attempting {len(targets)}")

TAG = re.compile(r"<(script|style|noscript)[^>]*>.*?</\1>", re.S | re.I)
def page_text(url):
    ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
        raw = r.read(700_000).decode("utf-8", "replace")
    t = re.sub(r"<[^>]+>", " ", TAG.sub(" ", raw))
    for x, y in (("&nbsp;", " "), ("&amp;", "&"), ("&#39;", "'"), ("&quot;", '"')):
        t = t.replace(x, y)
    return re.sub(r"[ \t]+", " ", t)

CONTACT_HINT = re.compile(r"(contact|location|about|find-us|our-facilit|directions)", re.I)
def contact_pages(base, raw_text, limit=2):
    """Cheap: guess the usual contact paths rather than re-parsing anchors."""
    from urllib.parse import urljoin
    return [urljoin(base, p) for p in ("/contact", "/contact-us", "/locations")][:limit]

STREET = (r"\d{1,6}\s+[A-Za-z0-9.\-' ]{2,44}?"
          r"(?:street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|way|parkway|pkwy|"
          r"highway|hwy|route|rte|court|ct|circle|cir|place|pl|terrace|trail|industrial|park)\b\.?")
def find_address(text, city, state):
    """Anchor on THIS facility's city+state, then look BACKWARD for the street.

    Forward matching (street immediately followed by city) only found 40%,
    because sites lay the address out as separate lines — street on one, then
    "City, ST ZIP" on the next — often with markup noise between them. Anchoring
    on the city and scanning back over a short window catches those.

    The city anchor is the safety rail and must not be relaxed: it is the only
    thing stopping a multi-site operator's head-office address being geocoded as
    this facility.
    """
    c = re.escape(str(city or "").strip())
    stt = re.escape(str(state or "").strip())
    if not c or not stt: return None
    anchor = re.compile(rf"{c}\s*,?\s*{stt}\b\.?\s*,?\s*(\d{{5}})?", re.I)
    street_rx = re.compile(STREET, re.I)
    for m in anchor.finditer(text):
        window = text[max(0, m.start() - 150): m.start()]
        hits = list(street_rx.finditer(window))
        if not hits:
            continue
        street = re.sub(r"\s+", " ", hits[-1].group(0)).strip(" ,")
        zip5 = m.group(1) or ""
        return f"{street}, {city}, {state} {zip5}".strip()
    return None

def census(addr):
    q = urllib.parse.urlencode({"address": addr, "benchmark": "Public_AR_Current", "format": "json"})
    with urllib.request.urlopen(f"{CENSUS}?{q}", timeout=30) as r:
        d = json.loads(r.read().decode())
    m = d.get("result", {}).get("addressMatches") or []
    if not m: return None
    c = m[0]["coordinates"]
    return {"lat": c["y"], "lon": c["x"], "matched": m[0]["matchedAddress"]}

def miles(a1, b1, a2, b2):
    R = 3958.8; p1, p2 = math.radians(a1), math.radians(a2)
    x = math.sin((p2-p1)/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(math.radians(b2-b1)/2)**2
    return 2*R*math.asin(math.sqrt(x))

done = set()
if OUT.exists():
    for ln in OUT.read_text().splitlines():
        try: done.add(json.loads(ln)["website"])
        except Exception: pass

st = Counter()
with OUT.open("a") as fh:
    for i, r in enumerate(targets, 1):
        if r["website"] in done: continue
        st["attempted"] += 1
        rec = {"name": r["name"], "city": r["city"], "state": r["state"], "website": r["website"]}
        try:
            text = page_text(r["website"])
            if not find_address(text, r["city"], r["state"]):
                for sub in contact_pages(r["website"], text):
                    try:
                        time.sleep(0.8); text += " " + page_text(sub)
                    except Exception: pass
                    if find_address(text, r["city"], r["state"]): break
        except Exception as e:
            st["fetch_fail"] += 1
            fh.write(json.dumps({**rec, "ok": False, "stage": "fetch", "error": str(e)[:90]}) + "\n"); fh.flush()
            print(f"  [{i:3}] fetch-fail  {r['name'][:34]}"); time.sleep(1.0); continue
        addr = find_address(text, r["city"], r["state"])
        if not addr:
            st["no_address"] += 1
            fh.write(json.dumps({**rec, "ok": True, "address": None}) + "\n"); fh.flush()
            print(f"  [{i:3}] no address  {r['name'][:34]}"); time.sleep(1.0); continue
        try:
            g = census(addr)
        except Exception as e:
            st["geocode_err"] += 1
            fh.write(json.dumps({**rec, "ok": False, "stage": "census", "address": addr,
                                 "error": str(e)[:90]}) + "\n"); fh.flush()
            print(f"  [{i:3}] census-err  {r['name'][:34]}"); time.sleep(1.0); continue
        if not g:
            st["geocode_nomatch"] += 1
            fh.write(json.dumps({**rec, "ok": True, "address": addr, "coords": None}) + "\n"); fh.flush()
            print(f"  [{i:3}] no match    {addr[:48]}"); time.sleep(1.0); continue
        moved = round(miles(r["lat"], r["lng"], g["lat"], g["lon"]), 2) if r.get("lat") else None
        st["geocoded"] += 1
        fh.write(json.dumps({**rec, "ok": True, "address": addr, "coords": g,
                             "moved_mi": moved}) + "\n"); fh.flush()
        print(f"  [{i:3}] OK {g['lat']:.4f},{g['lon']:.4f}  moved {moved} mi  {r['name'][:30]}")
        time.sleep(1.0)

n = max(1, st["attempted"])
print("\n" + "="*58 + "\nGEOCODE RESULT\n" + "="*58)
for k in ("attempted", "geocoded", "no_address", "geocode_nomatch", "fetch_fail", "geocode_err"):
    if st[k]: print(f"  {k:18} {st[k]:5}")
print(f"  success rate {st['geocoded']/n*100:.0f}%")
print(f"  results: {OUT}")
