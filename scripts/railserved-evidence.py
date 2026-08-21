#!/usr/bin/env python3
"""
Collect OPERATOR-STATED evidence of rail service for warehouses we currently
publish as rail-served on proximity alone.

Why this exists: the rail_confidence bands were calibrated against OSM-spur
POSITIVE controls, which measures how close a rail-served facility is to the
network -- never how close a NOT-rail-served facility can also be. Roane
Transportation (Rockwood TN) measured 0.13 mi, inside the "high" band, and is
confirmed by Jacob as not rail-served: the line passes near the site, no siding.
Proximity cannot separate those two cases. Operator language can.

No LLM: this is keyword presence, and matching the operator's own text makes the
evidence verbatim by construction. Negative-signal patterns ("near the rail
line", "close to rail") are captured separately so "mentions rail" is never
mistaken for "is rail served".

Writes data/rail-evidence.jsonl. NEVER touches transload-v2.json.
"""
import json, re, ssl, sys, time, urllib.request
from pathlib import Path
from urllib.parse import urljoin, urlparse

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "tools" / "transload-directory" / "data" / "transload-v2.json"
OUT  = ROOT / "tools" / "transload-directory" / "data" / "rail-evidence.jsonl"
UA = "Mozilla/5.0 (compatible; SteelWheelLogistics-directory/1.0; +https://steelwheellogistics.com)"
SLEEP = 1.2

# Affirmative: the operator says freight moves by rail AT their facility.
POS = re.compile(r"""(
   rail[\s-]?served | rail[\s-]?serviced | rail\s?siding | rail\s?spur
 | direct\s+rail(\s+(access|service|connection))? | on[\s-]the[\s-]rail
 | served\s+by\s+(the\s+)?(NS|CSX|UP|BNSF|CN|CPKC|CP|Norfolk\s+Southern|Union\s+Pacific|
   Burlington\s+Northern|Canadian\s+National|Canadian\s+Pacific)
 | (rail|track)\s?car\s+(spots?|capacity|storage) | transload(ing)?\s+from\s+rail
 | (inbound|outbound)\s+rail | rail\s+(access|dock|unloading|receiving)
)""", re.I | re.X)

# Proximity-only language -- explicitly NOT proof of service.
NEG = re.compile(r"(near(by)?\s+(the\s+)?rail|close\s+to\s+(the\s+)?rail|adjacent\s+to\s+(the\s+)?rail\s+line|minutes\s+from\s+.{0,20}rail)", re.I)

HINT = re.compile(r"(servic|about|facilit|warehous|storage|location|capab|solution|rail|transload)", re.I)
TAG  = re.compile(r"<(script|style|noscript)[^>]*>.*?</\1>", re.S | re.I)

def fetch(url):
    ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*"})
    with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
        raw = r.read(900_000).decode("utf-8", "replace")
    body = re.sub(r"<[^>]+>", " ", TAG.sub(" ", raw))
    for a, b in (("&nbsp;"," "),("&amp;","&"),("&#39;","'"),("&quot;",'"')):
        body = body.replace(a, b)
    return raw, re.sub(r"\s+", " ", body).strip()

def subpages(base, raw, limit=3):
    host = urlparse(base).netloc.lower(); out = {}
    for m in re.finditer(r'<a[^>]+href=["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', raw, re.S|re.I):
        href, label = m.group(1), re.sub(r"<[^>]+>", " ", m.group(2))
        try: full = urljoin(base, href.split("?")[0])
        except Exception: continue
        p = urlparse(full)
        if p.scheme not in ("http","https") or p.netloc.lower() != host: continue
        if full.rstrip("/") == base.rstrip("/"): continue
        if re.search(r"\.(pdf|jpg|png|zip|docx?|xlsx?)$", full, re.I): continue
        s = (3 if re.search(r"rail|transload", href, re.I) else 0) + (2 if HINT.search(href) else 0) + (2 if HINT.search(label) else 0)
        if s: out[full] = max(out.get(full, 0), s)
    return [u for u,_ in sorted(out.items(), key=lambda kv: -kv[1])[:limit]]

def spans(text, rx, limit=3):
    hits = []
    for m in rx.finditer(text):
        s = max(0, m.start()-90); e = min(len(text), m.end()+90)
        hits.append(text[s:e].strip())
        if len(hits) >= limit: break
    return hits

recs = json.loads(DATA.read_text())["facilities"]
pool = [r for r in recs
        if r.get("facility_type") == "third-party-warehouse"
        and r.get("rail_confidence") in ("high","probable")
        and r.get("website") and not r.get("rail_evidence")]
done = set()
if OUT.exists():
    for ln in OUT.read_text().splitlines():
        try: done.add(json.loads(ln)["website"])
        except Exception: pass
pool = [r for r in pool if r["website"] not in done]
print(f"pool {len(pool)}  (already done {len(done)})", flush=True)

st = dict(ok=0, fail=0, confirmed=0, proximity_only=0, silent=0)
with OUT.open("a") as fh:
    for i, r in enumerate(pool, 1):
        url = r["website"]
        rec = {"name": r["name"], "city": r.get("city"), "state": r.get("state"),
               "website": url, "rail_distance_mi": r.get("rail_distance_mi"),
               "rail_confidence": r.get("rail_confidence")}
        try:
            raw, text = fetch(url); pages = [url]
            for sub in subpages(url, raw):
                time.sleep(SLEEP)
                try:
                    _r, t = fetch(sub)
                    if t: text += " --- " + t; pages.append(sub)
                except Exception: pass
            st["ok"] += 1
        except Exception as e:
            st["fail"] += 1
            fh.write(json.dumps({**rec, "ok": False, "error": str(e)[:110]})+"\n"); fh.flush()
            print(f"[{i}/{len(pool)}] FETCH-FAIL {r['name'][:34]}", flush=True); time.sleep(SLEEP); continue

        pos, neg = spans(text, POS), spans(text, NEG)
        verdict = "confirmed-by-operator" if pos else ("proximity-language-only" if neg else "site-silent-on-rail")
        st[{"confirmed-by-operator":"confirmed","proximity-language-only":"proximity_only","site-silent-on-rail":"silent"}[verdict]] += 1
        fh.write(json.dumps({**rec, "ok": True, "pages": pages, "verdict": verdict,
                             "rail_evidence": pos[:3], "proximity_language": neg[:2]})+"\n"); fh.flush()
        print(f"[{i}/{len(pool)}] {verdict:24} {r['name'][:34]}", flush=True)
        time.sleep(SLEEP)

print("\n" + "="*58)
print(f"fetched {st['ok']}  failed {st['fail']}")
print(f"  confirmed by operator text : {st['confirmed']}")
print(f"  proximity language only    : {st['proximity_only']}")
print(f"  site silent on rail        : {st['silent']}")
print(f"  -> {OUT}")
