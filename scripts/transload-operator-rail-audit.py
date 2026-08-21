#!/usr/bin/env python3
"""
Ask each multi-location operator's own website WHICH of its sites is rail-served.

Jacob: "R&S has multiple locations in that area, but only one appears rail
served ... we should not show them all. It says it on the website."

He is right, and this is the case NARN proximity cannot settle. Distance says
"there is track near this point"; it cannot say which of an operator's four
buildings has the siding. The operator's own site usually can, and states it
plainly: "LD1 is a rail-served warehousing facility in Loudon, Tennessee."

Scale: 271 operators account for 1,619 directory records (59%). Crawling per
DOMAIN rather than per record makes this ~271 crawls, not 1,619.

THE TRAP THIS IS BUILT AROUND — found on R&S itself: their Lenoir City page
displays the LD1 *Loudon* address. Any rule of the form "rail wording appears
somewhere near a city name" would have tagged Lenoir City rail-served. So:

  - evidence must come from a page whose OWN identity is that facility
  - a location page mentioning a DIFFERENT city than the record's is rejected
  - silence is "unknown", never inherited from a sibling location

Also expect dead domains. R&S's listed site (rslogistics.com) returns HTTP 500;
they moved to rswarehousingsolutions.com and rebulk still carries the old one.

Writes data/operator-rail-audit.jsonl. Touches no dataset.

Usage:
  ANTHROPIC_API_KEY=... python3 scripts/transload-operator-rail-audit.py --limit 25
  ANTHROPIC_API_KEY=... python3 scripts/transload-operator-rail-audit.py --all
"""
import argparse, json, os, re, ssl, sys, time, urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urljoin, urlparse

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "tools" / "transload-directory" / "data" / "transload-v2.json"
OUT = ROOT / "tools" / "transload-directory" / "data" / "operator-rail-audit.jsonl"
API = "https://api.anthropic.com/v1/messages"
MODEL = "claude-haiku-4-5-20251001"
UA = "Mozilla/5.0 (compatible; SteelWheelLogistics-directory/1.0; +https://steelwheellogistics.com)"
SLEEP, MAX_TEXT = 1.4, 16000

ap = argparse.ArgumentParser()
ap.add_argument("--limit", type=int, default=25)
ap.add_argument("--all", action="store_true")
ap.add_argument("--out", default=None)
a = ap.parse_args()
if a.out: OUT = DATA.parent / a.out
KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
if not KEY: sys.exit("ANTHROPIC_API_KEY not set")

doc = json.loads(DATA.read_text()); recs = doc["facilities"]
def dom(u):
    m = re.match(r"https?://([^/]+)", str(u or ""), re.I)
    return m.group(1).lower().replace("www.", "") if m else None

by_dom = defaultdict(list)
for r in recs:
    d = dom(r.get("website"))
    if d: by_dom[d].append(r)
# Railroad-owned transload networks are rail-served by definition - auditing
# gwrr.com or nscorp.com asks a railroad to prove its own facilities are on rail.
# They are also the sites with corporate bot walls (5 of the first 12 were 403).
RAILROAD_DOMS = re.compile(
    r"(gwrr|nscorp|norfolksouthern|watco|transflo|^cn\.ca|cpkc|csx|up\.com|unionpacific|"
    r"bnsf|omnitrax|patriotrail|rjcorman|genesee|pioneerlines|anacostia)", re.I)
# The R&S profile: a company with a handful of sites, only some on rail. Below 2
# there is nothing to disambiguate; above ~8 it is a network operator, not a
# company whose individual buildings differ.
multi = {d: rs for d, rs in by_dom.items()
         if 2 <= len(rs) <= 8 and not RAILROAD_DOMS.search(d)}
targets = sorted(multi.items(), key=lambda kv: (-len(kv[1]), kv[0]))
if not a.all: targets = targets[: a.limit]
print(f"multi-location operators: {len(multi)} covering {sum(len(v) for v in multi.values())} records"
      f"  ->  auditing {len(targets)}")

TAG = re.compile(r"<(script|style|noscript)[^>]*>.*?</\1>", re.S | re.I)
def fetch(url):
    ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
        raw = r.read(800_000).decode("utf-8", "replace"); code = r.getcode()
    t = re.sub(r"<[^>]+>", " ", TAG.sub(" ", raw))
    for x, y in (("&nbsp;", " "), ("&amp;", "&"), ("&#39;", "'"), ("&quot;", '"')):
        t = t.replace(x, y)
    return code, raw, re.sub(r"\s+", " ", t).strip()

LOC_HINT = re.compile(r"(location|facilit|warehous|terminal|site|our-|branch)", re.I)
def location_pages(base, raw, limit=6):
    host = urlparse(base).netloc.lower(); out = {}
    for m in re.finditer(r'<a[^>]+href=["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', raw, re.S | re.I):
        href, label = m.group(1), re.sub(r"<[^>]+>", " ", m.group(2))
        try: full = urljoin(base, href.split("?")[0])
        except Exception: continue
        p = urlparse(full)
        if p.scheme not in ("http", "https") or p.netloc.lower() != host: continue
        if re.search(r"\.(pdf|jpg|png|zip|docx?)$", full, re.I): continue
        s = (2 if LOC_HINT.search(href) else 0) + (1 if LOC_HINT.search(label) else 0)
        if s: out[full] = max(out.get(full, 0), s)
    return [u for u, _ in sorted(out.items(), key=lambda kv: -kv[1])[:limit]]

PROMPT = """You are reading ONE page from a freight operator's website to decide whether \
the facility THIS PAGE IS ABOUT is rail-served.

The operator has locations in several cities. Pages often mention sister sites, and a \
location page sometimes prints a DIFFERENT location's address. So:

- Decide which single city this page is primarily about ("page_city"). If the page covers \
many locations equally, or you cannot tell, return page_city "" and rail_served "unknown".
- Answer rail_served "yes" ONLY if the page states THIS facility has rail service, a rail \
siding/spur, is rail-served, or handles railcars on site.
- Answer "no" only if it explicitly says this site has no rail.
- Otherwise "unknown". Unknown is a normal, expected answer — most pages do not say.

Never infer rail service from the company being a logistics or transload company, from \
another location having rail, or from a railroad being named nearby.

If rail_served is "yes" you MUST supply "evidence": a VERBATIM span copied exactly from \
the page text, character for character. No paraphrase. If you cannot copy an exact \
supporting span, answer "unknown".

JSON only:
{{"page_city":"<city or empty>","rail_served":"yes|no|unknown","evidence":"<verbatim or empty>"}}

PAGE URL: {url}
PAGE TEXT:
{text}
"""

def norm(s): return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()

def ask(url, text):
    body = json.dumps({"model": MODEL, "max_tokens": 500,
        "messages": [{"role": "user", "content": PROMPT.format(url=url, text=text[:MAX_TEXT])}]}).encode()
    req = urllib.request.Request(API, data=body, headers={
        "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        o = json.loads(r.read().decode())
    txt = "".join(b.get("text", "") for b in o.get("content", []))
    m = re.search(r"\{.*\}", txt, re.S)
    if not m: raise ValueError("no JSON")
    return json.loads(m.group(0)), o.get("usage", {})

done = set()
if OUT.exists():
    for ln in OUT.read_text().splitlines():
        try: done.add(json.loads(ln)["domain"])
        except Exception: pass

st = Counter(); tok = [0, 0]
with OUT.open("a") as fh:
    for i, (d, rows) in enumerate(targets, 1):
        if d in done: continue
        st["operators"] += 1
        cities = {norm(r.get("city")): r for r in rows}
        base = rows[0].get("website")
        try:
            code, raw, home = fetch(base)
        except Exception as e:
            st["dead_site"] += 1
            fh.write(json.dumps({"domain": d, "ok": False, "error": str(e)[:90],
                                 "records": len(rows)}) + "\n"); fh.flush()
            print(f"  [{i:3}] DEAD {d} ({str(e)[:34]})"); time.sleep(SLEEP); continue

        findings = {}
        pages = location_pages(base, raw)
        for u in pages:
            if not cities: break
            try:
                time.sleep(SLEEP); _c, _r, t = fetch(u)
            except Exception:
                continue
            if len(t) < 200: continue
            try:
                res, usage = ask(u, t)
                tok[0] += usage.get("input_tokens", 0); tok[1] += usage.get("output_tokens", 0)
            except Exception:
                st["model_fail"] += 1; continue
            pc = norm(res.get("page_city"))
            if not pc or res.get("rail_served") != "yes":
                continue
            # The page must be about a city we actually have a record for, and the
            # evidence must literally exist on THAT page.
            if pc not in cities:
                st["evidence_for_unknown_city"] += 1; continue
            ev = str(res.get("evidence") or "")
            if len(norm(ev)) < 8 or norm(ev) not in norm(t):
                st["evidence_unverifiable"] += 1; continue
            findings[pc] = {"url": u, "evidence": ev[:220]}
            st["rail_confirmed"] += 1

        fh.write(json.dumps({"domain": d, "ok": True, "records": len(rows),
                             "pages_checked": len(pages),
                             "cities": sorted(cities.keys()),
                             "rail_served_cities": findings}) + "\n"); fh.flush()
        if findings:
            print(f"  [{i:3}] {d}: {len(findings)}/{len(cities)} location(s) rail-served "
                  f"-> {', '.join(findings)}")
            st["operators_with_a_finding"] += 1
        else:
            print(f"  [{i:3}] {d}: none stated ({len(cities)} locations)")
        time.sleep(SLEEP)

print("\n" + "=" * 60 + "\nOPERATOR RAIL AUDIT\n" + "=" * 60)
for k, v in st.most_common(): print(f"  {k:26} {v}")
cost = tok[0] / 1e6 + tok[1] / 1e6 * 5
print(f"  tokens in/out {tok[0]:,}/{tok[1]:,}   cost ~${cost:.2f}")
print(f"  results: {OUT}")
