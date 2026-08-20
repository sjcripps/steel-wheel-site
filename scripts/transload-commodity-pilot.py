#!/usr/bin/env python3
"""
Pilot: can we extract commodity/capability data from transload operator websites?

Measures YIELD before we commit to a full run over ~1,258 sites. See
businesses/steel-wheel/docs/TRANSLOAD-COMMODITY-ENRICHMENT-SCOPE.md.

The question is NOT "can an LLM produce commodity labels" — it always can, which
is the danger. The question is "how often does an operator's website actually
STATE what they handle." So every claim must carry a verbatim evidence snippet
that we then verify is literally present in the fetched page text. A claim whose
evidence we cannot find is dropped and counted as a fabrication, because that is
what it is.

Writes results to data/commodity-pilot.jsonl. NEVER touches transload-v2.json.

Usage:
  ANTHROPIC_API_KEY=... python3 scripts/transload-commodity-pilot.py [--limit 50] [--tier1-only]
"""
import argparse, json, os, re, sys, time, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "tools" / "transload-directory" / "data" / "transload-v2.json"
OUT = ROOT / "tools" / "transload-directory" / "data" / "commodity-pilot.jsonl"

# Demand-weighted from 90-day GSC impressions on the transload pages.
TIER1 = {"OK","TX","GA","CA","IN","OH","CO","FL","TN","KS","LA","WA","IA","MN","IL","VA"}

MODEL = "claude-haiku-4-5-20251001"   # what a production run would use; measuring
                                      # yield on a stronger model would flatter it
API = "https://api.anthropic.com/v1/messages"
UA = "Mozilla/5.0 (compatible; SteelWheelLogistics-directory/1.0; +https://steelwheellogistics.com)"
MAX_TEXT = 14000        # chars of page text handed to the model
SLEEP = 1.6             # same courtesy delay as the existing enrich crawler

# v1 used 8 and rejected legitimate one-word evidence ("Grains", "Steel"),
# reporting 2 of its 3 "fabrications" against itself. A bullet list reading
# "Grains, Fertilizer, Feed" is exactly how these pages state it. The
# containment check is the guard that actually works; this floor only needs to
# stop a claim being "supported" by a single letter.
EVIDENCE_MIN_CHARS = 4

ap = argparse.ArgumentParser()
ap.add_argument("--limit", type=int, default=50)
ap.add_argument("--tier1-only", action="store_true", default=True)
ap.add_argument("--all-states", dest="tier1_only", action="store_false")
ap.add_argument("--follow-links", action="store_true",
                help="also fetch up to 2 services/locations subpages per site")
ap.add_argument("--out", default=None, help="results jsonl (default data/commodity-pilot.jsonl)")
ap.add_argument("--all", action="store_true",
                help="full run: every eligible facility, not a sample")
a = ap.parse_args()
if a.out:
    OUT = Path(a.out) if Path(a.out).is_absolute() else (DATA.parent / a.out)

KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
if not KEY:
    sys.exit("ANTHROPIC_API_KEY not set")

doc = json.loads(DATA.read_text())
COMMODITIES = doc["commodity_options"]
CAPABILITIES = doc["capability_options"]
recs = doc["facilities"]

# ── Build the sample ────────────────────────────────────────────────────────
# One facility per DISTINCT domain. 1,604 listed facilities sit on 1,258 domains,
# and a corporate page cannot be evidence for a specific terminal, so multi-site
# domains are excluded from the pilot entirely rather than measured unfairly.
dom_count = {}
def domain(u):
    m = re.match(r"https?://([^/]+)", str(u or ""), re.I)
    return (m.group(1).lower().replace("www.", "") if m else None)

for r in recs:
    d = domain(r.get("website"))
    if d: dom_count[d] = dom_count.get(d, 0) + 1

pool = []
for r in recs:
    if r.get("tier") != "listed": continue
    w = r.get("website")
    if not w: continue
    d = domain(w)
    if not d or dom_count[d] > 1: continue          # shared-domain guard
    n = str(r.get("note") or "")
    if re.search(r"website unreachable|dead domain link removed", n, re.I): continue
    if a.tier1_only and r.get("state") not in TIER1: continue
    pool.append(r)

pool.sort(key=lambda r: (r.get("state") or "", r.get("name") or ""))
if a.all:
    sample = pool
    print(f"eligible single-domain listed facilities: {len(pool)}  ->  FULL RUN")
else:
    step = max(1, len(pool) // a.limit)
    sample = pool[::step][: a.limit]
    print(f"eligible single-domain listed facilities: {len(pool)}  ->  sampling {len(sample)}")

# ── Fetch ───────────────────────────────────────────────────────────────────
TAG = re.compile(r"<(script|style|noscript)[^>]*>.*?</\1>", re.S | re.I)
def fetch(url):
    """Returns (status, raw_html, visible_text)."""
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept": "text/html,*/*"})
    import ssl
    ctx = ssl.create_default_context(); ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE          # liveness/text only, no secrets exchanged
    with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
        raw = r.read(900_000).decode("utf-8", "replace")
        code = r.getcode()
    body = TAG.sub(" ", raw)
    body = re.sub(r"<[^>]+>", " ", body)
    body = (body.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&#39;", "'")
                .replace("&quot;", '"'))
    return code, raw, re.sub(r"\s+", " ", body).strip()

# v1's central finding: 26 of 43 fetched pages were corporate HOMEPAGES that
# market the company without ever saying what the terminal handles. That list
# lives one click away on /services, /locations, /terminals or /capabilities.
# Same-host only, and never off-site.
LINK_HINT = re.compile(
    r"(servic|location|terminal|capab|commodit|product|facilit|transload|bulk|"
    r"operation|what-we|handling|storage)", re.I)

def find_subpages(base_url, raw_html, limit=2):
    from urllib.parse import urljoin, urlparse
    host = urlparse(base_url).netloc.lower()
    base_norm = base_url.rstrip("/")
    scored = {}
    for m in re.finditer(r'<a[^>]+href=["\']([^"\'#]+)["\'][^>]*>(.*?)</a>',
                         raw_html, re.S | re.I):
        href, label = m.group(1), re.sub(r"<[^>]+>", " ", m.group(2))
        try: full = urljoin(base_url, href.split("?")[0])
        except Exception: continue
        p = urlparse(full)
        if p.scheme not in ("http", "https") or p.netloc.lower() != host: continue
        if full.rstrip("/") == base_norm: continue
        if re.search(r"\.(pdf|jpg|png|zip|docx?|xlsx?)$", full, re.I): continue
        score = (2 if LINK_HINT.search(href) else 0) + (2 if LINK_HINT.search(label) else 0)
        # a page literally about commodities beats a generic "services" nav item
        if re.search(r"(commodit|product|handling)", href + " " + label, re.I): score += 1
        if score: scored[full] = max(scored.get(full, 0), score)
    return [u for u, _ in sorted(scored.items(), key=lambda kv: -kv[1])[:limit]]

def gather(url, follow):
    """Homepage text, plus the best services/locations subpages when following."""
    code, raw, text = fetch(url)
    pages = [url]
    if follow:
        for sub in find_subpages(url, raw):
            time.sleep(SLEEP)
            try:
                _c, _r, t2 = fetch(sub)
                if t2:
                    text += "\n\n--- " + sub + " ---\n" + t2
                    pages.append(sub)
            except Exception:
                pass                      # a dead subpage is not a failed site
    return code, text, pages

PROMPT = """You are reading the website of a freight TRANSLOAD facility to record which \
commodities it handles and which transfer capabilities it has.

Return ONLY commodities and capabilities the page EXPLICITLY states this facility handles \
or offers. This is a data-recording task, not an inference task. Do NOT infer from the \
industry, the company name, photographs, or what such a facility usually does. If the page \
does not say, the correct answer is an empty list — that is a normal and expected outcome \
and you will not be penalised for it.

For EVERY item you return you must supply "evidence": a VERBATIM span copied exactly from \
the page text below, character for character. Do not paraphrase, reword, correct spelling, \
or join text from different places. If you cannot copy an exact span that supports the item, \
do not return the item.

Choose values ONLY from these closed vocabularies.
COMMODITIES: {commodities}
CAPABILITIES: {capabilities}

Respond as JSON only, no prose:
{{"commodities":[{{"value":"<from list>","evidence":"<verbatim span>"}}],
  "capabilities":[{{"value":"<from list>","evidence":"<verbatim span>"}}],
  "is_transload_page": true/false}}

Set is_transload_page false if this does not look like a bulk transload/terminal operator \
page at all (parked domain, unrelated business, pure holding page).

PAGE TEXT:
{text}
"""

def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()

def classify(text):
    body = json.dumps({
        "model": MODEL, "max_tokens": 1200,
        "messages": [{"role": "user", "content": PROMPT.format(
            commodities=", ".join(COMMODITIES),
            capabilities=", ".join(CAPABILITIES),
            text=text[:MAX_TEXT])}],
    }).encode()
    req = urllib.request.Request(API, data=body, headers={
        "x-api-key": KEY, "anthropic-version": "2023-06-01",
        "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        out = json.loads(r.read().decode())
    txt = "".join(b.get("text", "") for b in out.get("content", []))
    usage = out.get("usage", {})
    m = re.search(r"\{.*\}", txt, re.S)
    if not m: raise ValueError("no JSON in model output")
    return json.loads(m.group(0)), usage

# ── Run ─────────────────────────────────────────────────────────────────────
stats = dict(attempted=0, fetch_ok=0, fetch_fail=0, model_ok=0, model_fail=0,
             yielded=0, not_stated=0, not_transload=0,
             claims=0, claims_verified=0, claims_rejected=0, subpages=0,
             in_tokens=0, out_tokens=0)
seen = set()
if OUT.exists():
    for ln in OUT.read_text().splitlines():
        try: seen.add(json.loads(ln)["website"])
        except Exception: pass

with OUT.open("a") as fh:
    for i, r in enumerate(sample, 1):
        url = r["website"]
        if url in seen:
            continue
        stats["attempted"] += 1
        rec = {"name": r["name"], "city": r["city"], "state": r["state"], "website": url}
        try:
            code, text, pages = gather(url, a.follow_links)
            stats["fetch_ok"] += 1
            stats["subpages"] += len(pages) - 1
        except Exception as e:
            stats["fetch_fail"] += 1
            rec.update(ok=False, stage="fetch", error=str(e)[:120])
            fh.write(json.dumps(rec) + "\n"); fh.flush()
            print(f"  [{i:2}/{len(sample)}] FETCH-FAIL {r['name'][:34]:34} {str(e)[:40]}")
            time.sleep(SLEEP); continue

        try:
            res, usage = classify(text)
            stats["model_ok"] += 1
            stats["in_tokens"] += usage.get("input_tokens", 0)
            stats["out_tokens"] += usage.get("output_tokens", 0)
        except Exception as e:
            stats["model_fail"] += 1
            rec.update(ok=False, stage="model", error=str(e)[:120])
            fh.write(json.dumps(rec) + "\n"); fh.flush()
            print(f"  [{i:2}/{len(sample)}] MODEL-FAIL {r['name'][:34]:34} {str(e)[:40]}")
            time.sleep(SLEEP); continue

        # ── the guard: every claim's evidence must literally exist in the page ──
        hay = norm(text)
        kept = {"commodities": [], "capabilities": []}
        rejected = []
        for field, vocab in (("commodities", COMMODITIES), ("capabilities", CAPABILITIES)):
            for item in (res.get(field) or []):
                val, ev = item.get("value"), item.get("evidence", "")
                stats["claims"] += 1
                if val not in vocab:
                    rejected.append({"field": field, "value": val, "why": "not in vocabulary"})
                    stats["claims_rejected"] += 1; continue
                ev_n = norm(ev)
                if len(ev_n) < EVIDENCE_MIN_CHARS or ev_n not in hay:
                    rejected.append({"field": field, "value": val, "why": "evidence not found in page",
                                     "claimed_evidence": str(ev)[:120]})
                    stats["claims_rejected"] += 1; continue
                kept[field].append({"value": val, "evidence": ev[:200]})
                stats["claims_verified"] += 1

        got = bool(kept["commodities"] or kept["capabilities"])
        if not res.get("is_transload_page", True):
            stats["not_transload"] += 1
        elif got:
            stats["yielded"] += 1
        else:
            stats["not_stated"] += 1

        rec.update(ok=True, http=code, text_chars=len(text), pages=pages,
                   is_transload_page=res.get("is_transload_page", True),
                   commodities=kept["commodities"], capabilities=kept["capabilities"],
                   rejected=rejected)
        fh.write(json.dumps(rec) + "\n"); fh.flush()
        flag = "YIELD" if got else ("NOT-TL" if not res.get("is_transload_page", True) else "none ")
        print(f"  [{i:2}/{len(sample)}] {flag} {r['name'][:32]:32} "
              f"c={len(kept['commodities'])} k={len(kept['capabilities'])} rej={len(rejected)}")
        time.sleep(SLEEP)

# ── Report ──────────────────────────────────────────────────────────────────
n = max(1, stats["attempted"])
fo = max(1, stats["fetch_ok"])
print("\n" + "=" * 62)
print("PILOT RESULT")
print("=" * 62)
print(f"  attempted            {stats['attempted']}")
print(f"  fetched ok           {stats['fetch_ok']}  ({stats['fetch_ok']/n*100:.0f}%)   failed {stats['fetch_fail']}")
print(f"  model ok             {stats['model_ok']}   failed {stats['model_fail']}")
print(f"  -- of fetched pages --")
print(f"  YIELDED data         {stats['yielded']}  ({stats['yielded']/fo*100:.0f}%)   <- the number that decides this")
print(f"  stated nothing       {stats['not_stated']}  ({stats['not_stated']/fo*100:.0f}%)")
print(f"  not a transload page {stats['not_transload']}")
print(f"  -- claim integrity --")
print(f"  claims made          {stats['claims']}")
print(f"  evidence verified    {stats['claims_verified']}")
print(f"  REJECTED (fabricated/unsupported) {stats['claims_rejected']}"
      + (f"  ({stats['claims_rejected']/max(1,stats['claims'])*100:.0f}% of claims)" if stats['claims'] else ""))
print(f"  -- cost --")
cost = stats["in_tokens"] / 1e6 * 1.00 + stats["out_tokens"] / 1e6 * 5.00
print(f"  tokens in/out        {stats['in_tokens']:,} / {stats['out_tokens']:,}")
print(f"  pilot cost           ~${cost:.3f}  ->  full 1,258-site run ~${cost/n*1258:.2f}")
print(f"\n  results: {OUT}")
