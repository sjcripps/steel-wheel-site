#!/usr/bin/env python3
"""
add-tool-schema.py — inject WebApplication + BreadcrumbList JSON-LD into the
/tools/* pages.

WHY
---
A 2026-07-22 GSC audit found the SEO work done across the blog (Article +
FAQPage + BreadcrumbList on all 67 posts) had never been applied to the tools:
zero structured data on all 11, and 6 of 11 missing from the sitemap. Only 2
of 11 tools registered any impressions over 90 days.

That matters because the tools are the segment that actually converts. Tool
pages click at ~2x their position benchmark; informational blog pages sit at
~0.16x (AI Overviews answer the query in-SERP). Visibility, not page quality,
is the binding constraint — the tool pages already carry 1.2k-8.2k words,
canonical, OG tags and a real H1.

WHAT IT DOES NOT DO
-------------------
It does NOT add FAQPage. No tool page has FAQ content on it, and marking up
Q&A that isn't visible violates Google's structured-data guidelines. If we
want FAQ rich results, write real FAQ sections first, then extend this.

Idempotent: re-running skips pages that already carry the markup.

Usage:
    python3 scripts/add-tool-schema.py --dry-run
    python3 scripts/add-tool-schema.py
"""
from __future__ import annotations

import argparse
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = ROOT / "tools"
SITE = "https://steelwheellogistics.com"
MARKER = '"@type": "WebApplication"'


def extract(pattern: str, text: str) -> str | None:
    m = re.search(pattern, text, re.S | re.I)
    return html.unescape(m.group(1).strip()) if m else None


def build_blocks(slug: str, title: str, desc: str, canonical: str) -> str:
    # Strip the site suffix so the tool name reads as a product name, not a
    # page title: "Rail Rate Quote | Steel Wheel Logistics" -> "Rail Rate Quote"
    #
    # Split on the pipe ONLY. An earlier version also split on en/em dashes and
    # silently truncated "Rail Freight Rates — Instant Estimate by Lane" down to
    # "Rail Freight Rates" — dashes are part of these titles, not separators.
    name = title.split("|")[0].strip()

    webapp = {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": name,
        "url": canonical,
        "description": desc,
        "applicationCategory": "BusinessApplication",
        "operatingSystem": "Any (web browser)",
        "browserRequirements": "Requires JavaScript",
        "isAccessibleForFree": True,
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "provider": {
            "@type": "Organization",
            "name": "Steel Wheel Logistics",
            "url": SITE + "/",
        },
    }
    crumbs = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": SITE + "/"},
            {"@type": "ListItem", "position": 2, "name": "Tools", "item": SITE + "/tools"},
            {"@type": "ListItem", "position": 3, "name": name, "item": canonical},
        ],
    }
    out = []
    for obj in (webapp, crumbs):
        out.append('  <script type="application/ld+json">\n  '
                   + json.dumps(obj, indent=2).replace("\n", "\n  ")
                   + "\n  </script>")
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    changed = skipped = failed = 0
    for d in sorted(TOOLS_DIR.iterdir()):
        f = d / "index.html"
        if not f.is_file():
            continue
        slug = d.name
        text = f.read_text()

        if MARKER in text:
            print(f"  SKIP    {slug} (already has WebApplication)")
            skipped += 1
            continue

        title = extract(r"<title>(.*?)</title>", text)
        desc = extract(r'<meta\s+name="description"\s+content="([^"]*)"', text)
        canon = extract(r'<link\s+rel="canonical"\s+href="([^"]*)"', text)
        if not (title and desc):
            print(f"  FAIL    {slug} (missing title or description)")
            failed += 1
            continue
        canon = canon or f"{SITE}/tools/{slug}"

        blocks = build_blocks(slug, title, desc, canon)
        if "</head>" not in text:
            print(f"  FAIL    {slug} (no </head>)")
            failed += 1
            continue
        new = text.replace("</head>", blocks + "</head>", 1)

        if args.dry_run:
            print(f"  WOULD   {slug}  name={re.split(r'[|]', title)[0].strip()[:40]!r}")
        else:
            f.write_text(new)
            print(f"  OK      {slug}")
        changed += 1

    print(f"\n  changed={changed} skipped={skipped} failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
