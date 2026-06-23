#!/usr/bin/env python3
"""
Add BreadcrumbList JSON-LD to SWL blog posts (Home > Blog > Post Title).

All 67 posts render visible breadcrumbs but none carry BreadcrumbList schema, so
they miss breadcrumb display in Google results. This injects the schema, derived
from each post's <title> and canonical URL. Idempotent (skips posts that already
have it). HTML/visible content is untouched — schema only.

Usage:
  python3 add-breadcrumb-schema.py --dry-run [file ...]   # preview, no writes
  python3 add-breadcrumb-schema.py --apply   [file ...]   # write the schema in
Defaults to all blog/*.html (excluding drafts) when no files are given.
"""
import json, re, sys, glob, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRY = "--dry-run" in sys.argv
APPLY = "--apply" in sys.argv
files = [a for a in sys.argv[1:] if not a.startswith("--")]
if not files:
    files = sorted(glob.glob(os.path.join(ROOT, "blog", "*.html")))


def build_schema(title, url):
    return {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home",
             "item": "https://steelwheellogistics.com/"},
            {"@type": "ListItem", "position": 2, "name": "Blog",
             "item": "https://steelwheellogistics.com/blog"},
            {"@type": "ListItem", "position": 3, "name": title, "item": url},
        ],
    }


def process(path):
    html = open(path, encoding="utf-8").read()
    if "BreadcrumbList" in html:
        return ("skip", "already has BreadcrumbList")
    mt = re.search(r"<title>(.*?)</title>", html, re.S)
    mc = re.search(r'rel="canonical"\s+href="([^"]+)"', html)
    if not mt or not mc:
        return ("skip", "no title/canonical")
    title = re.sub(r"\s*\|\s*Steel Wheel Logistics\s*$", "", mt.group(1)).strip()
    url = mc.group(1)
    schema = build_schema(title, url)
    # JSON-LD is safe to embed as-is (json.dumps escapes <, >, & via ensure_ascii not needed,
    # but we escape '<' defensively to avoid any premature </script>).
    block = ('  <script type="application/ld+json">\n  '
             + json.dumps(schema, indent=2).replace("\n", "\n  ").replace("<", "\\u003c")
             + "\n  </script>\n</head>")
    if "</head>" not in html:
        return ("skip", "no </head>")
    new = html.replace("</head>", block, 1)
    if APPLY:
        open(path, "w", encoding="utf-8").write(new)
    return ("ok", json.dumps(schema["itemListElement"][2], ensure_ascii=False))


def main():
    if not DRY and not APPLY:
        print("Specify --dry-run or --apply"); sys.exit(1)
    ok = skip = 0
    for f in files:
        if "draft" in os.path.basename(f).lower():
            continue
        status, note = process(f)
        if status == "ok":
            ok += 1
            if DRY or len(files) == 1:
                print(f"+ {os.path.basename(f)}\n    crumb3: {note}")
        else:
            skip += 1
    print(f"\n{'DRY-RUN' if DRY else 'APPLIED'}: {ok} posts get BreadcrumbList, {skip} skipped.")


if __name__ == "__main__":
    main()
