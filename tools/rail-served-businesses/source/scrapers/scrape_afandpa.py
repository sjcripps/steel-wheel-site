#!/usr/bin/env python3
"""
v3 AF&PA membership verifier.

Hits the live AF&PA "/our-members" page (HTTP 200, static HTML, no login wall)
and parses the Company Members list. Returns a set of canonical AF&PA member
company names actually present on the live page TODAY.

This is used by build-data.py to:
  1. Stamp `scraped_url: https://www.afandpa.org/our-members` onto AF&PA mill
     records whose parent company is verified-on-page (REAL provenance).
  2. Demote mill records whose parent isn't on the live page to
     `source: industry_knowledge_forest_products` (so post-acquisition or
     non-AF&PA forest-products operators are honestly labeled).

Smoke target: at least Georgia-Pacific, International Paper, Smurfit Westrock,
Sappi must appear (these are big-3 paper companies; their absence = scrape broke).
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

URL = "https://www.afandpa.org/our-members"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0 Safari/537.36"

# Smoke targets — if these aren't on the page, our parser broke or AF&PA changed
# their members list. Treat as a hard failure.
SMOKE_TARGETS = {
    'georgia-pacific',
    'international paper',
    'smurfit westrock',
    'sappi',
}

OUT = Path(__file__).resolve().parent.parent / 'cache' / 'scraped_afandpa_members.json'


def fetch():
    req = urllib.request.Request(URL, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode('utf-8', errors='replace')


def parse_members(html):
    """Pull the 'Company Members' chunk between the 'View AF&PA Company
    Members' button and the 'View AF&PA Association Members' button.

    Returns a list of canonical member-company strings as they appear on the
    page TODAY. Strategy: substring-match a known list of paper/forest-products
    operators against the page's company-member chunk. Each match means the
    operator is a verified AF&PA member as of scrape time. Robust to
    whitespace/markup changes since we don't rely on perfect tokenization.
    """
    # Use a regex that's tolerant of whitespace/HTML between markers
    m = re.search(
        r'View AF&amp;PA Company Members.*?Close\s*Company Members(.*?)View AF&amp;PA Association Members',
        html, re.DOTALL)
    if not m:
        m = re.search(
            r'View AF&PA Company Members.*?Close\s*Company Members(.*?)View AF&PA Association Members',
            html, re.DOTALL)
    if not m:
        return []
    chunk = m.group(1)
    chunk = re.sub(r'<[^>]+>', ' ', chunk)
    chunk = (chunk.replace('&amp;', '&')
                  .replace('&nbsp;', ' ')
                  .replace('&#039;', "'"))
    text = re.sub(r'\s+', ' ', chunk).strip().lower()

    # Canonical AF&PA company-member list (substring-match against page text).
    # If a name is in this list AND appears in the live page chunk, it's a
    # verified AF&PA member as of scrape time.
    CANONICAL = [
        'Ahlstrom',
        'Billerud North America',
        'BiOrigin Specialty Products',
        'Clearwater Paper Corporation',
        'Crown Paper Group',
        'Domtar',
        'Essity',
        'Georgia-Pacific',
        'Graphic Packaging',
        'Green Bay Packaging',
        'Greif',
        'Hollingsworth & Vose',
        'Hood Container',
        'International Paper',
        'Johnson Timber',
        'Kimberly-Clark',
        'The Kraft Group',
        'K.T.G.',
        'Liberty Diversified',
        'Marcal Paper',
        'Masonite Corporation',
        'Monadnock Paper',
        'New-Indy Containerboard',
        'Nippon Dynawave',
        'North Pacific Paper',
        'Ox Industries',
        'Packaging Corporation of America',
        'PaperWorks Industries',
        'Pratt Industries',
        'The Price Companies',
        'Procter & Gamble',
        'Sappi North America',
        'Seaman Paper',
        'Simpson Lumber',
        'Smurfit Westrock',
        'Sonoco Products',
        'Sustana',
        'Suzano Packaging',
        'Sylvamo Corporation',
    ]
    found = []
    for name in CANONICAL:
        if name.lower() in text:
            found.append(name)
    return found


def smoke_check(members):
    found = set()
    member_lower = ' | '.join(m.lower() for m in members)
    for tgt in SMOKE_TARGETS:
        if tgt in member_lower:
            found.add(tgt)
    missing = SMOKE_TARGETS - found
    return found, missing


def main():
    print('AF&PA scraper: fetching', URL)
    try:
        html = fetch()
    except Exception as e:
        print(f'  FAIL fetch: {e}', file=sys.stderr)
        sys.exit(2)
    members = parse_members(html)
    print(f'  parsed {len(members)} company members')
    found, missing = smoke_check(members)
    if missing:
        print(f'  SMOKE FAIL — missing: {missing}', file=sys.stderr)
        # Don't exit non-zero — let build-data still produce honest results,
        # but flag in output.
        passed = False
    else:
        print(f'  SMOKE PASS — all {len(found)} smoke targets found')
        passed = True
    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        'scraped_url': URL,
        'scraped_at': datetime.now(timezone.utc).isoformat(),
        'smoke_passed': passed,
        'smoke_targets_missing': sorted(missing),
        'members': sorted(members),
    }
    OUT.write_text(json.dumps(payload, indent=1))
    print(f'  wrote {OUT}')
    return payload


if __name__ == '__main__':
    main()
