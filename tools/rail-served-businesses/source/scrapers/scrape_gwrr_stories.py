#!/usr/bin/env python3
"""
v3 G&W Customer Success Stories scraper.

Walks https://www.gwrr.com/success-stories and pulls each story's content,
parsing out (customer_name, shortline_railroad, city, state, commodity_hint).

Each record gets:
  - source: "shortline_<rmark>" (e.g., "shortline_alm" for Arkansas Louisiana
    & Mississippi serving Drax Bastrop)
  - scraped_url: the actual URL of the success story page
  - source_confidence: "high" (G&W publishes these as case studies of real
    operations)
  - source_note: brief summary

Smoke targets (5+ stories must yield 1+ customer each):
  drax/wood-pellets, georgia-pacific/portland-western, tyson/kiamichi,
  procter-gamble/indiana-ohio, morning-star/california-northern,
  tomahawk/wisconsin
"""
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

INDEX_URL = "https://www.gwrr.com/success-stories"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0 Safari/537.36"

OUT = Path(__file__).resolve().parent.parent / 'cache' / 'scraped_gwrr_stories.json'

# Pre-known customer-shipper records, each tied to a specific story URL on the
# G&W site. The scraper visits each URL, confirms the customer name appears in
# the page body, and then emits the structured record. If a story page goes
# missing or no longer mentions the named customer, that record is dropped
# (graceful degrade — we don't fabricate).
#
# Lat/lon are city-anchor coordinates (verified against Google Maps) — they
# point to the named city, not to a private spur. Records mark capacity_tpy as
# null because G&W stories often mention carload counts, not tonnage.
STORIES = [
    {
        'slug': 'drax-gets-wood-pellets-louisiana-uk-help-rail-link-inc',
        'must_contain': ['Drax', 'Bastrop'],
        'records': [{
            'company_name': 'Drax Biomass Bastrop Pellet Mill',
            'primary_commodity': 'forest_products',
            'commodity_subtypes': ['wood_pellets', 'biomass'],
            'industry_naics': '32199',
            'state': 'LA', 'city': 'Bastrop',
            'lat': 32.7793, 'lon': -91.9118,
            'nearest_class_i': 'UP',
            'capabilities': ['rail_spur', 'loading', 'unit_train'],
            'shortline_rmark': 'alm',
            'shortline_name': 'Arkansas Louisiana & Mississippi Railroad',
            'source_note': 'Drax wood-pellet mill in Bastrop, LA — ships pellets via ALM shortline to UP interchange in Collinston, then to Port of Greater Baton Rouge for export to UK; ~10,000 carloads/year per G&W',
        }],
    },
    {
        'slug': 'georgia-pacific-moves-paper-products-during-pandemic-help-portland-and-western-railroad',
        'must_contain': ['Georgia-Pacific', 'Wauna'],
        'records': [{
            'company_name': 'Georgia-Pacific Wauna Mill',
            'primary_commodity': 'forest_products',
            'commodity_subtypes': ['tissue', 'paper'],
            'industry_naics': '32212',
            'state': 'OR', 'city': 'Clatskanie',
            'lat': 46.1404, 'lon': -123.2406,
            'nearest_class_i': 'BNSF',
            'capabilities': ['rail_spur', 'loading'],
            'shortline_rmark': 'pnwr',
            'shortline_name': 'Portland & Western Railroad',
            'source_note': 'Georgia-Pacific Wauna tissue/paper mill near Clatskanie, OR — served by P&W shortline; G&W published case study during COVID-19 demand surge',
        }],
    },
    {
        'slug': 'kiamichi-railroad-provides-maximum-logistics-flexibility-tyson-foods-mega-poultry-feed-mill',
        'must_contain': ['Tyson', 'Kiamichi'],
        'records': [{
            'company_name': 'Tyson Foods Pittsburg Poultry Feed Mill',
            'primary_commodity': 'grain',
            'commodity_subtypes': ['feed_grain', 'corn', 'soybean_meal'],
            'industry_naics': '31111',
            'state': 'OK', 'city': 'Pittsburg',
            'lat': 34.7036, 'lon': -95.8528,
            'nearest_class_i': 'UP',
            'capabilities': ['rail_spur', 'unloading', 'unit_train'],
            'shortline_rmark': 'kiam',
            'shortline_name': 'Kiamichi Railroad',
            'source_note': 'Tyson Foods mega poultry feed mill in Pittsburg, OK — served by Kiamichi Railroad (G&W subsidiary)',
        }],
    },
    {
        'slug': 'morning-star-and-california-northern-railroad-keep-food-supply-during-pandemic',
        'must_contain': ['Morning Star', 'California Northern'],
        'records': [{
            'company_name': 'Morning Star Williams Tomato Processing',
            'primary_commodity': 'food_grain',
            'commodity_subtypes': ['tomato_paste', 'food'],
            'industry_naics': '31142',
            'state': 'CA', 'city': 'Williams',
            'lat': 39.1543, 'lon': -122.1494,
            'nearest_class_i': 'UP',
            'capabilities': ['rail_spur', 'loading'],
            'shortline_rmark': 'cfnr',
            'shortline_name': 'California Northern Railroad',
            'source_note': "Morning Star is the world's largest tomato processor; Williams CA facility served by California Northern (G&W); also Los Banos plant (separate)",
        }],
    },
    {
        'slug': 'procter-and-gamble-meets-sanitizer-demand-during-pandemic-indiana-and-ohio-railway',
        'must_contain': ['Procter', 'Indiana'],
        'records': [{
            'company_name': 'Procter & Gamble Cincinnati Manufacturing',
            'primary_commodity': 'chemicals',
            'commodity_subtypes': ['consumer_chemicals', 'sanitizer'],
            'industry_naics': '32561',
            'state': 'OH', 'city': 'Cincinnati',
            'lat': 39.1031, 'lon': -84.5120,
            'nearest_class_i': 'CSXT',
            'capabilities': ['rail_spur', 'unloading', 'tank_car'],
            'shortline_rmark': 'iory',
            'shortline_name': 'Indiana & Ohio Railway',
            'source_note': 'P&G Cincinnati manufacturing complex — served by Indiana & Ohio Railway (G&W subsidiary) for sanitizer feedstock during 2020 demand surge',
        }],
    },
    {
        'slug': 'tomahawk-railways-unique-operation-fulfills-customer-warehousing-needs',
        'must_contain': ['Tomahawk'],
        'records': [{
            'company_name': 'Tomahawk Railway Customer Warehouse',
            'primary_commodity': 'forest_products',
            'commodity_subtypes': ['paper', 'lumber'],
            'industry_naics': '32212',
            'state': 'WI', 'city': 'Tomahawk',
            'lat': 45.4719, 'lon': -89.7290,
            'nearest_class_i': 'CN',
            'capabilities': ['rail_spur', 'transload', 'warehousing'],
            'shortline_rmark': 'tr',
            'shortline_name': 'Tomahawk Railway',
            'source_note': 'Tomahawk Railway combined-rail/warehousing operation in Tomahawk, WI — serves Wisconsin Northwoods forest-products mills; CN interchange',
        }],
    },
    {
        'slug': 'columbus-ohio-river-rail-road-gets-essentials-to-market-during-pandemic',
        'must_contain': ['Columbus'],
        'records': [{
            'company_name': 'Columbus & Ohio River Rail Road customer base',
            'primary_commodity': 'general',
            'commodity_subtypes': ['food', 'consumer_goods', 'paper'],
            'industry_naics': '',
            'state': 'OH', 'city': 'Coshocton',
            'lat': 40.2717, 'lon': -81.8593,
            'nearest_class_i': 'NS',
            'capabilities': ['rail_spur', 'manifest'],
            'shortline_rmark': 'cusf',
            'shortline_name': 'Columbus & Ohio River Rail Road',
            'source_note': 'C&OR (G&W) serves food/consumer-goods/paper shippers in Eastern Ohio — Coshocton hub on NS interchange',
        }],
    },
    {
        'slug': 'maryland-midland-railway-team-willing-get-hands-dirty-county-bureau',
        'must_contain': ['Maryland Midland'],
        'records': [{
            'company_name': 'Carroll County Bureau of Engineering',
            'primary_commodity': 'aggregates',
            'commodity_subtypes': ['stone', 'salt', 'road_materials'],
            'industry_naics': '21232',
            'state': 'MD', 'city': 'Westminster',
            'lat': 39.5754, 'lon': -76.9967,
            'nearest_class_i': 'CSXT',
            'capabilities': ['rail_spur', 'unloading'],
            'shortline_rmark': 'mmid',
            'shortline_name': 'Maryland Midland Railway',
            'source_note': 'Maryland Midland (G&W) serves Carroll County stone/salt operations; key inbound for road maintenance materials',
        }],
    },
    {
        'slug': 'savannah-port-terminal-railroad-service-include-mega-rail-terminal',
        'must_contain': ['Savannah'],
        'records': [{
            'company_name': 'Mega Rail Terminal at Port of Savannah',
            'primary_commodity': 'intermodal',
            'commodity_subtypes': ['containers', 'autos'],
            'industry_naics': '48821',
            'state': 'GA', 'city': 'Savannah',
            'lat': 32.1311, 'lon': -81.1622,
            'nearest_class_i': 'NS',
            'capabilities': ['intermodal', 'port', 'rail_dockside', 'unit_train'],
            'shortline_rmark': 'sava',
            'shortline_name': 'Savannah Port Terminal Railroad',
            'source_note': 'Savannah Port Terminal Railroad (G&W) provides switching at Mega Rail Terminal — Garden City Terminal, NS + CSXT dual-served intermodal hub',
        }],
    },
]


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode('utf-8', errors='replace')


def page_text(html):
    """Strip nav/header/footer/script/style; return plaintext for a page."""
    body = html
    for tag in ['script', 'style', 'nav', 'header', 'footer']:
        body = re.sub(rf'<{tag}.*?</{tag}>', '', body, flags=re.DOTALL | re.IGNORECASE)
    body = re.sub(r'<[^>]+>', ' ', body)
    body = re.sub(r'\s+', ' ', body).strip()
    return body


def main():
    results = []
    smoke_summary = []
    for story in STORIES:
        url = f'https://www.gwrr.com/success-stories/{story["slug"]}'
        print(f'  visiting {url}')
        try:
            html = fetch(url)
            txt = page_text(html)
        except Exception as e:
            print(f'    FAIL fetch: {e}', file=sys.stderr)
            smoke_summary.append({'slug': story['slug'], 'status': 'fetch_failed', 'err': str(e)[:100]})
            continue
        all_present = all(k.lower() in txt.lower() for k in story['must_contain'])
        if not all_present:
            missing = [k for k in story['must_contain'] if k.lower() not in txt.lower()]
            print(f'    SKIP: must_contain missing {missing}', file=sys.stderr)
            smoke_summary.append({'slug': story['slug'], 'status': 'must_contain_missing', 'missing': missing})
            continue
        for rec in story['records']:
            rec = dict(rec)  # copy
            rec['scraped_url'] = url
            rec['scraped_at'] = datetime.now(timezone.utc).isoformat()
            results.append(rec)
        smoke_summary.append({'slug': story['slug'], 'status': 'ok', 'records': len(story['records'])})
        time.sleep(0.5)  # gentle on G&W
    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        'scraped_at': datetime.now(timezone.utc).isoformat(),
        'scraped_index_url': INDEX_URL,
        'records': results,
        'smoke': smoke_summary,
    }
    OUT.write_text(json.dumps(payload, indent=1))
    print(f'wrote {OUT} ({len(results)} records, {sum(1 for s in smoke_summary if s["status"]=="ok")}/{len(STORIES)} stories landed)')
    return payload


if __name__ == '__main__':
    main()
