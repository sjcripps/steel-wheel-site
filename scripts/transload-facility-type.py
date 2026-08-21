#!/usr/bin/env python3
"""
Classify transload facilities by TYPE, and specifically by whether they will
handle third-party freight.

See businesses/steel-wheel/docs/RAIL-SERVED-WAREHOUSE-SCOPE.md. Triggered by a
caller wanting a rail-served warehouse for baled pulp: the directory could not
distinguish "we store other people's product" from "this is our own plant that
happens to have a siding".

The commercially useful axis is THIRD-PARTY vs CAPTIVE, not warehouse vs
terminal. A Sam's Club DC and an Amazon FC are warehouses in every physical
sense and useless to a shipper looking for space. Getting warehouse-vs-terminal
right while getting third-party wrong would be worse than useless, because it
looks authoritative.

Same discipline as the commodity extractor: every field carries a verbatim
evidence span that is verified to exist in the fetched page text, and
"unknown" is a normal, tracked outcome.

Writes to data/facility-type.jsonl. NEVER touches transload-v2.json.

Usage:
  ANTHROPIC_API_KEY=... python3 scripts/transload-facility-type.py --limit 50
  ANTHROPIC_API_KEY=... python3 scripts/transload-facility-type.py --all
"""
import argparse, json, os, re, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "tools" / "transload-directory" / "data" / "transload-v2.json"
OUT = ROOT / "tools" / "transload-directory" / "data" / "facility-type.jsonl"

MODEL = "claude-haiku-4-5-20251001"
API = "https://api.anthropic.com/v1/messages"
UA = "Mozilla/5.0 (compatible; SteelWheelLogistics-directory/1.0; +https://steelwheellogistics.com)"
MAX_TEXT, SLEEP, EVIDENCE_MIN = 14000, 1.6, 4

TYPES = ["third-party-warehouse", "transload-terminal", "private-plant", "unknown"]

ap = argparse.ArgumentParser()
ap.add_argument("--limit", type=int, default=50)
ap.add_argument("--all", action="store_true")
ap.add_argument("--out", default=None)
a = ap.parse_args()
if a.out:
    OUT = DATA.parent / a.out

KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
if not KEY: sys.exit("ANTHROPIC_API_KEY not set")

doc = json.loads(DATA.read_text())
recs = doc["facilities"]

def domain(u):
    m = re.match(r"https?://([^/]+)", str(u or ""), re.I)
    return m.group(1).lower().replace("www.", "") if m else None

dom_count = {}
for r in recs:
    d = domain(r.get("website"))
    if d: dom_count[d] = dom_count.get(d, 0) + 1

pool = []
for r in recs:
    if r.get("facility_type") or not r.get("website"): continue
    d = domain(r["website"])
    if not d or dom_count[d] > 1: continue          # shared-domain guard
    if re.search(r"website unreachable|dead domain link removed",
                 str(r.get("note") or ""), re.I): continue
    pool.append(r)
pool.sort(key=lambda r: (r.get("state") or "", r.get("name") or ""))
sample = pool if a.all else pool[::max(1, len(pool)//a.limit)][:a.limit]
print(f"eligible: {len(pool)}  ->  {'FULL RUN' if a.all else f'sampling {len(sample)}'}")

TAG = re.compile(r"<(script|style|noscript)[^>]*>.*?</\1>", re.S | re.I)
def fetch(url):
    import ssl
    ctx = ssl.create_default_context(); ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*"})
    with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
        raw = r.read(900_000).decode("utf-8", "replace"); code = r.getcode()
    body = re.sub(r"<[^>]+>", " ", TAG.sub(" ", raw))
    for a_, b_ in (("&nbsp;"," "),("&amp;","&"),("&lt;","<"),("&gt;",">"),("&#39;","'"),("&quot;",'"')):
        body = body.replace(a_, b_)
    return code, raw, re.sub(r"\s+", " ", body).strip()

HINT = re.compile(r"(servic|about|facilit|warehous|storage|location|capab|solution|what-we)", re.I)
def subpages(base, raw, limit=2):
    from urllib.parse import urljoin, urlparse
    host = urlparse(base).netloc.lower(); out = {}
    for m in re.finditer(r'<a[^>]+href=["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', raw, re.S|re.I):
        href, label = m.group(1), re.sub(r"<[^>]+>", " ", m.group(2))
        try: full = urljoin(base, href.split("?")[0])
        except Exception: continue
        p = urlparse(full)
        if p.scheme not in ("http","https") or p.netloc.lower() != host: continue
        if full.rstrip("/") == base.rstrip("/"): continue
        if re.search(r"\.(pdf|jpg|png|zip|docx?|xlsx?)$", full, re.I): continue
        s = (2 if HINT.search(href) else 0) + (2 if HINT.search(label) else 0)
        if s: out[full] = max(out.get(full, 0), s)
    return [u for u,_ in sorted(out.items(), key=lambda kv: -kv[1])[:limit]]

def gather(url):
    code, raw, text = fetch(url); pages = [url]
    for sub in subpages(url, raw):
        time.sleep(SLEEP)
        try:
            _c,_r,t = fetch(sub)
            if t: text += "\n\n--- " + sub + " ---\n" + t; pages.append(sub)
        except Exception: pass
    return code, text, pages

PROMPT = """You are reading a freight facility's website to record what KIND of operation it is.

The decisive question is whether this facility handles freight for OTHER COMPANIES, or only \
its own. A distribution centre belonging to a retailer or manufacturer is NOT a third-party \
warehouse, however large it is — a shipper cannot rent space there.

Choose exactly one facility_type:
  "third-party-warehouse" — offers storage / warehousing / 3PL / public warehousing SERVICES \
to other companies. Look for: public warehousing, contract warehousing, 3PL, "we store", \
"space available", offering storage to customers.
  "transload-terminal" — transfers freight between rail and truck for others, but is not \
primarily offering storage space.
  "private-plant" — a manufacturer, mill, refinery, retailer DC or similar operating its own \
facility for its own goods. Not available to outside shippers.
  "unknown" — the page does not make it clear. This is a NORMAL answer. Use it freely.

Also record:
  indoor_storage — true ONLY if the page states enclosed/indoor warehouse space (sq ft of \
warehouse, "under roof", climate controlled, dry storage). Outdoor yard or tank storage is NOT \
indoor storage.

For EVERY non-unknown answer supply "evidence": a VERBATIM span copied exactly from the page \
text, character for character. Do not paraphrase. If you cannot copy an exact supporting span, \
answer "unknown" / false.

Respond as JSON only:
{{"facility_type":"<one of the four>","type_evidence":"<verbatim span or empty>",
  "indoor_storage":true/false,"indoor_evidence":"<verbatim span or empty>"}}

PAGE TEXT:
{text}
"""

def norm(s): return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()

def classify(text):
    body = json.dumps({"model": MODEL, "max_tokens": 700,
        "messages":[{"role":"user","content":PROMPT.format(text=text[:MAX_TEXT])}]}).encode()
    req = urllib.request.Request(API, data=body, headers={
        "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        out = json.loads(r.read().decode())
    txt = "".join(b.get("text","") for b in out.get("content", []))
    m = re.search(r"\{.*\}", txt, re.S)
    if not m: raise ValueError("no JSON")
    return json.loads(m.group(0)), out.get("usage", {})

st = dict(attempted=0, fetch_ok=0, fetch_fail=0, model_fail=0, indoor=0,
          rejected=0, in_tok=0, out_tok=0)
types = {t: 0 for t in TYPES}
seen = set()
if OUT.exists():
    for ln in OUT.read_text().splitlines():
        try: seen.add(json.loads(ln)["website"])
        except Exception: pass

with OUT.open("a") as fh:
    for i, r in enumerate(sample, 1):
        url = r["website"]
        if url in seen: continue
        st["attempted"] += 1
        rec = {"name": r["name"], "city": r["city"], "state": r["state"], "website": url}
        try:
            code, text, pages = gather(url); st["fetch_ok"] += 1
        except Exception as e:
            st["fetch_fail"] += 1
            fh.write(json.dumps({**rec, "ok": False, "error": str(e)[:110]}) + "\n"); fh.flush()
            print(f"  [{i:3}/{len(sample)}] FETCH-FAIL {r['name'][:32]}"); time.sleep(SLEEP); continue
        try:
            res, usage = classify(text)
            st["in_tok"] += usage.get("input_tokens", 0); st["out_tok"] += usage.get("output_tokens", 0)
        except Exception as e:
            st["model_fail"] += 1
            fh.write(json.dumps({**rec, "ok": False, "error": str(e)[:110]}) + "\n"); fh.flush()
            print(f"  [{i:3}/{len(sample)}] MODEL-FAIL {r['name'][:32]}"); time.sleep(SLEEP); continue

        hay = norm(text)
        ftype = res.get("facility_type") if res.get("facility_type") in TYPES else "unknown"
        tev = str(res.get("type_evidence") or "")
        if ftype != "unknown" and (len(norm(tev)) < EVIDENCE_MIN or norm(tev) not in hay):
            st["rejected"] += 1; ftype = "unknown"          # unsupported -> unknown, never kept
        indoor = bool(res.get("indoor_storage"))
        iev = str(res.get("indoor_evidence") or "")
        if indoor and (len(norm(iev)) < EVIDENCE_MIN or norm(iev) not in hay):
            st["rejected"] += 1; indoor = False
        types[ftype] += 1
        if indoor: st["indoor"] += 1
        fh.write(json.dumps({**rec, "ok": True, "pages": pages, "facility_type": ftype,
                             "type_evidence": tev[:200], "indoor_storage": indoor,
                             "indoor_evidence": iev[:200]}) + "\n"); fh.flush()
        print(f"  [{i:3}/{len(sample)}] {ftype:22} indoor={str(indoor):5} {r['name'][:30]}")
        time.sleep(SLEEP)

n = max(1, st["fetch_ok"])
print("\n" + "="*60 + "\nFACILITY TYPE RESULT\n" + "="*60)
print(f"  attempted {st['attempted']}   fetched {st['fetch_ok']}   fetch-fail {st['fetch_fail']}   model-fail {st['model_fail']}")
for t in TYPES:
    print(f"  {t:24} {types[t]:5}  ({types[t]/n*100:4.0f}% of fetched)")
print(f"  indoor storage stated    {st['indoor']:5}  ({st['indoor']/n*100:4.0f}%)")
print(f"  claims rejected (evidence not found) {st['rejected']}")
cost = st["in_tok"]/1e6*1.0 + st["out_tok"]/1e6*5.0
print(f"  cost ~${cost:.3f}   ->  full {len(pool)}-site run ~${cost/max(1,st['attempted'])*len(pool):.2f}")
print(f"  results: {OUT}")
