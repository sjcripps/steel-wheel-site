#!/usr/bin/env python3
"""
Classify multi-location OPERATORS by company type — one crawl per company.

Why this is a separate script from transload-facility-type.py, and why it is
allowed to do what that one refuses to:

  transload-facility-type.py excludes multi-domain records, because a corporate
  page cannot tell you whether ONE of six buildings has a rail siding. That is a
  LOCATION-level fact and the guard is right.

  "Does this company sell warehousing services to other companies?" is a
  COMPANY-level fact. A public-warehousing business says so on its own site, and
  it is true of the company, not just one address. So the same corporate page
  that is useless for rail is authoritative for type.

1,628 facilities sit on shared domains — 60% of the unclassified pool — and they
are unreachable any other way. Crawling per DOMAIN makes it ~350 crawls, not
1,628.

THE TRAP: a manufacturer that also runs distribution centres. Weyerhaeuser has
DCs; they are captive. So the prompt asks specifically whether the company
SELLS storage to outside companies, and treats "they have warehouses" as
insufficient. Every claim still needs a verbatim evidence span verified against
the fetched text.

Confidence is recorded as company-level, not location-level, so the merge can
treat it as weaker than a per-facility crawl and the UI can say so.

Writes data/operator-type.jsonl. Touches no dataset.

Usage:
  ANTHROPIC_API_KEY=... python3 scripts/transload-operator-type.py --limit 50
  ANTHROPIC_API_KEY=... python3 scripts/transload-operator-type.py --all
"""
import argparse, json, os, re, ssl, sys, time, urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urljoin, urlparse

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "tools" / "transload-directory" / "data" / "transload-v2.json"
OUT = ROOT / "tools" / "transload-directory" / "data" / "operator-type.jsonl"
API = "https://api.anthropic.com/v1/messages"
MODEL = "claude-haiku-4-5-20251001"
UA = "Mozilla/5.0 (compatible; SteelWheelLogistics-directory/1.0; +https://steelwheellogistics.com)"
SLEEP, MAX_TEXT, EVIDENCE_MIN = 1.5, 15000, 4
TYPES = ["third-party-warehouse", "transload-terminal", "private-plant", "unknown"]

ap = argparse.ArgumentParser()
ap.add_argument("--limit", type=int, default=50)
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

# Railroad-owned networks: their facilities are transload terminals by
# definition, and their corporate sites are the ones behind bot walls.
RAILROAD = re.compile(r"(gwrr|nscorp|norfolksouthern|watco|transflo|^cn\.ca|cpkc|csx|"
                      r"up\.com|unionpacific|bnsf|omnitrax|patriotrail|rjcorman|genesee)", re.I)

targets = []
for d, rows in by_dom.items():
    if len(rows) < 2: continue                      # singles are the other script's job
    if RAILROAD.search(d): continue
    unclassified = [r for r in rows if not r.get("facility_type")]
    if not unclassified: continue
    targets.append((d, rows, unclassified))
targets.sort(key=lambda t: -len(t[2]))
if not a.all: targets = targets[: a.limit]
print(f"multi-location operators with unclassified facilities: {len(targets)}"
      f"  covering {sum(len(u) for _, _, u in targets)} facilities")

TAG = re.compile(r"<(script|style|noscript)[^>]*>.*?</\1>", re.S | re.I)
def fetch(url):
    ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
        raw = r.read(800_000).decode("utf-8", "replace")
    t = re.sub(r"<[^>]+>", " ", TAG.sub(" ", raw))
    for x, y in (("&nbsp;", " "), ("&amp;", "&"), ("&#39;", "'"), ("&quot;", '"')):
        t = t.replace(x, y)
    return raw, re.sub(r"\s+", " ", t).strip()

HINT = re.compile(r"(servic|about|warehous|storage|solution|what-we|capab|3pl)", re.I)
def subpages(base, raw, limit=2):
    host = urlparse(base).netloc.lower(); out = {}
    for m in re.finditer(r'<a[^>]+href=["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', raw, re.S | re.I):
        href, label = m.group(1), re.sub(r"<[^>]+>", " ", m.group(2))
        try: full = urljoin(base, href.split("?")[0])
        except Exception: continue
        p = urlparse(full)
        if p.scheme not in ("http", "https") or p.netloc.lower() != host: continue
        if full.rstrip("/") == base.rstrip("/"): continue
        if re.search(r"\.(pdf|jpg|png|zip|docx?)$", full, re.I): continue
        s = (2 if HINT.search(href) else 0) + (1 if HINT.search(label) else 0)
        if s: out[full] = max(out.get(full, 0), s)
    return [u for u, _ in sorted(out.items(), key=lambda kv: -kv[1])[:limit]]

PROMPT = """You are reading a freight company's website to decide what KIND OF BUSINESS it is.

The decisive question: does this company SELL storage or warehousing services TO OTHER \
COMPANIES?

That is not the same as "it has warehouses". A manufacturer, mill or retailer may operate \
large distribution centres purely for its own goods — a shipper cannot rent space there, so \
that is "private-plant" no matter how much warehousing the company does internally. Say \
"third-party-warehouse" ONLY if the company offers warehousing/storage as a SERVICE to \
customers.

Choose exactly one company_type:
  "third-party-warehouse" — sells warehousing/storage/3PL/public or contract warehousing to \
other companies.
  "transload-terminal" — moves freight between rail and truck for others, but storage is not \
the offering.
  "private-plant" — a manufacturer, producer, mill, refinery or retailer operating its own \
facilities for its own goods.
  "unknown" — the site does not make it clear. A NORMAL answer; use it freely.

You MUST supply "evidence": a VERBATIM span copied exactly from the page text, character for \
character, that supports the choice. No paraphrase. If you cannot copy an exact supporting \
span, answer "unknown".

CRITICAL — SCOPE OF THE CLAIM. Companies often do different things at different sites. A bulk \
trucking company may run 50 terminals and warehouses at only two of them. So also report:

  "scope": "company-wide"  if the evidence describes the whole company or its whole network \
(e.g. "one of the largest 3PL companies", "our network of cold storage facilities").
  "scope": "specific-locations" if the evidence ties the activity to named places \
(e.g. "Our US Warehouses, located in Chicago Heights and Paris Illinois").
  "locations": [] — when scope is "specific-locations", list ONLY the city names the evidence \
actually names. Copy them as written. Empty list otherwise.

Getting this wrong is worse than answering "unknown": a warehouse claim applied to 50 \
terminals puts facilities in a directory they do not belong in.

JSON only:
{{"company_type":"<one of the four>","evidence":"<verbatim span or empty>",
  "scope":"company-wide|specific-locations","locations":["<city>", ...]}}

COMPANY SITE TEXT:
{text}
"""

def norm(s): return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()

def ask(text):
    body = json.dumps({"model": MODEL, "max_tokens": 500,
        "messages": [{"role": "user", "content": PROMPT.format(text=text[:MAX_TEXT])}]}).encode()
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

st = Counter(); types = Counter(); tok = [0, 0]
with OUT.open("a") as fh:
    for i, (d, rows, unclassified) in enumerate(targets, 1):
        if d in done: continue
        st["operators"] += 1
        base = rows[0].get("website")
        try:
            raw, text = fetch(base)
            for sub in subpages(base, raw):
                time.sleep(SLEEP)
                try:
                    _r, t = fetch(sub)
                    if t: text += " " + t
                except Exception: pass
        except Exception as e:
            st["dead_site"] += 1
            fh.write(json.dumps({"domain": d, "ok": False, "error": str(e)[:90],
                                 "facilities": len(unclassified)}) + "\n"); fh.flush()
            print(f"  [{i:3}] DEAD {d}"); time.sleep(SLEEP); continue
        try:
            res, usage = ask(text)
            tok[0] += usage.get("input_tokens", 0); tok[1] += usage.get("output_tokens", 0)
        except Exception:
            st["model_fail"] += 1; time.sleep(SLEEP); continue

        ct = res.get("company_type") if res.get("company_type") in TYPES else "unknown"
        ev = str(res.get("evidence") or "")
        if ct != "unknown" and (len(norm(ev)) < EVIDENCE_MIN or norm(ev) not in norm(text)):
            st["evidence_rejected"] += 1; ct = "unknown"

        scope = res.get("scope") if res.get("scope") in ("company-wide", "specific-locations") else "company-wide"
        named = [str(x) for x in (res.get("locations") or []) if str(x).strip()]
        # A named city is only usable if the evidence REALLY contains it — the same
        # verbatim discipline as the claim itself.
        named = [n for n in named if norm(n) and norm(n) in norm(ev)]

        if scope == "specific-locations" and not named:
            # The model said the claim is location-specific but named no city we
            # could verify against the evidence. Falling through to "apply to all"
            # would turn an ADMISSION of narrow scope into the broadest possible
            # claim - exactly backwards. Drop it.
            st["scoped_but_unverifiable"] += 1
            ct = "unknown"; applies = []
        elif scope == "specific-locations" and named:
            # Apply ONLY to our records in those cities. Bulkmatic names Chicago
            # Heights and Paris; without this the claim would reach all 51 sites.
            applies = [r for r in unclassified
                       if any(norm(n) == norm(r.get("city")) or norm(n) in norm(r.get("city"))
                              for n in named)]
            st["scoped_claims"] += 1
            st["facilities_saved_from_overreach"] += len(unclassified) - len(applies)
        else:
            applies = unclassified

        types[ct] += 1
        fh.write(json.dumps({"domain": d, "ok": True, "company_type": ct,
                             "evidence": ev[:220], "scope": scope, "named_locations": named,
                             "facilities_on_domain": len(unclassified),
                             "applies_to": [f"{r.get('name')}, {r.get('city')}, {r.get('state')}"
                                            for r in applies]}) + "\n"); fh.flush()
        tag = f"{len(applies)}/{len(unclassified)}" if scope == "specific-locations" else f"all {len(unclassified)}"
        print(f"  [{i:3}] {ct:22} {tag:>10} {'SCOPED' if scope=='specific-locations' else '':6} {d}")
        time.sleep(SLEEP)

print("\n" + "=" * 60 + "\nOPERATOR TYPE RESULT\n" + "=" * 60)
print(f"  operators crawled {st['operators']}   dead {st['dead_site']}   model-fail {st['model_fail']}")
for t in TYPES: print(f"  {t:24} {types[t]:4} operators")
print(f"  evidence rejected (claim dropped to unknown): {st['evidence_rejected']}")
print(f"  location-scoped claims: {st['scoped_claims']}")
print(f"  facilities SPARED a wrong company-wide label: {st['facilities_saved_from_overreach']}")
print(f"  scoped-but-unverifiable (dropped to unknown): {st['scoped_but_unverifiable']}")
cost = tok[0] / 1e6 + tok[1] / 1e6 * 5
print(f"  tokens {tok[0]:,}/{tok[1]:,}  cost ~${cost:.2f}")
print(f"  results: {OUT}")
