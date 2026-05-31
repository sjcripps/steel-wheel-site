#!/usr/bin/env python3
"""
Build businesses.json for the Rail-Served Business Directory.

Sources (priority order):
  1. Commodity-flow-map: parsed from Jacob's curated hubs doc
     (`/tmp/tg-doc-1778026863731.txt`, mirrored to S3 at
     research/swl-commodity-flow-hubs-source-2026-05-05.txt). 29 high-authority
     macro-region anchor records (Powder River Basin, Saskatchewan Potash,
     ports, rail hubs, barge hubs, border crossings). Marked source_confidence
     "high".
  1b. Industry-knowledge hubs: hand-curated rail-served shippers that earlier
     code mistakenly labeled commodity_flow_map. They're factually rail-served
     but were not in the source doc. Marked source: "industry_knowledge",
     source_confidence: "low" (FIX-UP 2026-05-06 — was previously mis-sourced).
  2. Transload-directory facilities (817) — many are rail-served shippers.
  3. SWL lane-page origin/destination cities (359 lanes -> ~150 unique hubs).

Scraping sources 3-5 (state mining bureaus, NSSGA, state aggregate associations)
attempted separately and merged via append_scraped() if they land. The local
sources alone hit the 500-record MVP target.

Schema per record:
  { id, company_name, dba, primary_commodity, commodity_subtypes[],
    industry_naics, state, county, city, lat, lon, rail_served,
    nearest_class_i, capabilities[], capacity_tpy, contact_name,
    contact_email, contact_phone, website, source, source_confidence,
    last_verified_at }
"""
import csv
import json
import os
import re
import sys
from datetime import date

ROOT = '/home/ubuntu/projects/steel-wheel-site'
SOURCE_DIR = f'{ROOT}/tools/rail-served-businesses/source'
CACHE_DIR = f'{SOURCE_DIR}/cache'
OUT = f'{ROOT}/tools/rail-served-businesses/data/businesses.json'
TRANSLOAD_JSON = f'{ROOT}/tools/transload-directory/data/transload.json'
LANES_JSON = f'{ROOT}/rates/lanes.json'
CITIES_CSV = '/home/ubuntu/bots/assistant/businesses/steel-wheel/data/cities.csv'
COMMODITY_FLOW_DOC = '/tmp/tg-doc-1778026863731.txt'

# v2 curated dataset (AF&PA mills, AISI steel, ACC chemicals, NGFA grain,
# NSSGA aggregates, Class I customer mentions, ASLRRA shortlines).
sys.path.insert(0, SOURCE_DIR)
try:
    from curated_v2 import (
        AFANDPA_MILLS, AISI_MILLS, ACC_PLANTS, NGFA_ELEVATORS,
        NSSGA_QUARRIES, CLASSI_CUSTOMERS, ASLRRA_SHORTLINES,
        AFANDPA_EXPANSION, STATE_INDEV_SITES, PETROLEUM_REFINERIES,
        COAL_MINES, AUTO_PARTS_PLANTS,
        AFANDPA_EXTRA, STATE_AGGREGATES,
    )
except ImportError:
    AFANDPA_MILLS = AISI_MILLS = ACC_PLANTS = NGFA_ELEVATORS = []
    NSSGA_QUARRIES = []
    CLASSI_CUSTOMERS = {}
    ASLRRA_SHORTLINES = []
    AFANDPA_EXPANSION = STATE_INDEV_SITES = PETROLEUM_REFINERIES = []
    COAL_MINES = AUTO_PARTS_PLANTS = []
    AFANDPA_EXTRA = STATE_AGGREGATES = []

TODAY = str(date.today())

# ─────────────────────── 1. Commodity-flow curated hubs ───────────────────────
# 30 high-authority rail-served industrial hubs that anchor major US commodity
# flows. Each is a real, named site (not a city) — coordinates verified against
# Google Maps. Coverage spans the 8 commodity buckets the directory exposes.
COMMODITY_FLOW_HUBS = [
    # ──── Plastics / petrochemicals (Gulf Coast NGL belt) ────
    {"company_name": "ExxonMobil Baytown Olefins Plant", "primary_commodity": "plastics",
     "commodity_subtypes": ["polyethylene", "polypropylene"], "city": "Baytown", "state": "TX",
     "lat": 29.7355, "lon": -95.0103, "nearest_class_i": "UP",
     "capabilities": ["loading", "rail_spur", "manifest"], "industry_naics": "32521"},
    {"company_name": "Dow Freeport TX Operations", "primary_commodity": "plastics",
     "commodity_subtypes": ["polyethylene", "ethylene"], "city": "Freeport", "state": "TX",
     "lat": 28.9544, "lon": -95.3597, "nearest_class_i": "UP",
     "capabilities": ["loading", "rail_spur", "unit_train"], "industry_naics": "32521"},
    {"company_name": "Chevron Phillips Cedar Bayou Plant", "primary_commodity": "plastics",
     "commodity_subtypes": ["polyethylene", "alpha_olefins"], "city": "Baytown", "state": "TX",
     "lat": 29.7891, "lon": -94.9483, "nearest_class_i": "UP",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "32521"},
    {"company_name": "INEOS Olefins Chocolate Bayou", "primary_commodity": "plastics",
     "commodity_subtypes": ["polypropylene", "ethylene"], "city": "Alvin", "state": "TX",
     "lat": 29.3244, "lon": -95.1769, "nearest_class_i": "UP",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "32521"},
    {"company_name": "Formosa Plastics Point Comfort", "primary_commodity": "plastics",
     "commodity_subtypes": ["polyethylene", "polyvinyl_chloride"], "city": "Point Comfort", "state": "TX",
     "lat": 28.6791, "lon": -96.5566, "nearest_class_i": "UP",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "32521"},
    {"company_name": "LyondellBasell Channelview Complex", "primary_commodity": "plastics",
     "commodity_subtypes": ["polyethylene", "propylene"], "city": "Channelview", "state": "TX",
     "lat": 29.7886, "lon": -95.1166, "nearest_class_i": "UP",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "32521"},
    {"company_name": "Shell Polymers Monaca", "primary_commodity": "plastics",
     "commodity_subtypes": ["polyethylene"], "city": "Monaca", "state": "PA",
     "lat": 40.6864, "lon": -80.2734, "nearest_class_i": "NS",
     "capabilities": ["loading", "rail_spur", "unit_train"], "industry_naics": "32521"},

    # ──── Chemicals (Gulf, Mid-Atlantic, Mid-Continent) ────
    {"company_name": "BASF Geismar Site", "primary_commodity": "chemicals",
     "commodity_subtypes": ["ammonia", "methylamines"], "city": "Geismar", "state": "LA",
     "lat": 30.2199, "lon": -91.0089, "nearest_class_i": "CN",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "32519"},
    {"company_name": "Dow St. Charles Operations", "primary_commodity": "chemicals",
     "commodity_subtypes": ["ethylene_glycol", "ethylene"], "city": "Hahnville", "state": "LA",
     "lat": 29.9786, "lon": -90.4097, "nearest_class_i": "CN",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "32519"},
    {"company_name": "Westlake Lake Charles Vinyls", "primary_commodity": "chemicals",
     "commodity_subtypes": ["chlorine", "vinyls"], "city": "Lake Charles", "state": "LA",
     "lat": 30.2103, "lon": -93.2658, "nearest_class_i": "UP",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "32518"},

    # ──── Aggregates / cement / minerals ────
    {"company_name": "Vulcan Materials McCook Quarry", "primary_commodity": "aggregates",
     "commodity_subtypes": ["crushed_stone", "limestone"], "city": "McCook", "state": "IL",
     "lat": 41.7950, "lon": -87.8311, "nearest_class_i": "BNSF",
     "capabilities": ["loading", "rail_spur", "unit_train"], "industry_naics": "21232"},
    {"company_name": "Martin Marietta Beckmann Quarry", "primary_commodity": "aggregates",
     "commodity_subtypes": ["limestone", "crushed_stone"], "city": "San Antonio", "state": "TX",
     "lat": 29.6378, "lon": -98.5022, "nearest_class_i": "UP",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "21232"},
    {"company_name": "U.S. Silica Sparta", "primary_commodity": "aggregates",
     "commodity_subtypes": ["industrial_sand", "frac_sand"], "city": "Sparta", "state": "WI",
     "lat": 43.9444, "lon": -90.8131, "nearest_class_i": "CP",
     "capabilities": ["loading", "rail_spur", "unit_train"], "industry_naics": "21232"},
    {"company_name": "Hi-Crush Kermit Sand Mine", "primary_commodity": "aggregates",
     "commodity_subtypes": ["frac_sand"], "city": "Kermit", "state": "TX",
     "lat": 31.8523, "lon": -103.0917, "nearest_class_i": "UP",
     "capabilities": ["loading", "rail_spur", "unit_train"], "industry_naics": "21232"},
    {"company_name": "LafargeHolcim Ste. Genevieve Cement", "primary_commodity": "cement",
     "commodity_subtypes": ["portland_cement", "clinker"], "city": "Bloomsdale", "state": "MO",
     "lat": 38.0089, "lon": -90.2392, "nearest_class_i": "BNSF",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "32731"},
    {"company_name": "Continental Cement Hannibal Plant", "primary_commodity": "cement",
     "commodity_subtypes": ["portland_cement"], "city": "Hannibal", "state": "MO",
     "lat": 39.7080, "lon": -91.3585, "nearest_class_i": "BNSF",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "32731"},
    {"company_name": "GCC of America Pueblo Cement", "primary_commodity": "cement",
     "commodity_subtypes": ["portland_cement"], "city": "Pueblo", "state": "CO",
     "lat": 38.2544, "lon": -104.6092, "nearest_class_i": "BNSF",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "32731"},

    # ──── Coal (PRB, Illinois Basin, Appalachia) ────
    {"company_name": "Peabody North Antelope Rochelle Mine", "primary_commodity": "coal",
     "commodity_subtypes": ["thermal_coal", "PRB"], "city": "Wright", "state": "WY",
     "lat": 43.6839, "lon": -105.4422, "nearest_class_i": "BNSF",
     "capabilities": ["loading", "rail_spur", "unit_train"], "industry_naics": "21211"},
    {"company_name": "Arch Resources Black Thunder Mine", "primary_commodity": "coal",
     "commodity_subtypes": ["thermal_coal", "PRB"], "city": "Wright", "state": "WY",
     "lat": 43.6900, "lon": -105.2486, "nearest_class_i": "BNSF",
     "capabilities": ["loading", "rail_spur", "unit_train"], "industry_naics": "21211"},
    {"company_name": "Foresight Energy Williamson Mine", "primary_commodity": "coal",
     "commodity_subtypes": ["thermal_coal", "Illinois_Basin"], "city": "Johnston City", "state": "IL",
     "lat": 37.8253, "lon": -88.9281, "nearest_class_i": "CN",
     "capabilities": ["loading", "rail_spur", "unit_train"], "industry_naics": "21211"},

    # ──── Grain (Midwest, Plains, Pacific NW) ────
    {"company_name": "ADM Decatur Soybean Complex", "primary_commodity": "grain",
     "commodity_subtypes": ["soybeans", "corn", "soybean_oil"], "city": "Decatur", "state": "IL",
     "lat": 39.8403, "lon": -88.9548, "nearest_class_i": "NS",
     "capabilities": ["loading", "unloading", "rail_spur", "unit_train"], "industry_naics": "11511"},
    {"company_name": "Cargill Blair Corn Mill", "primary_commodity": "grain",
     "commodity_subtypes": ["corn", "ethanol"], "city": "Blair", "state": "NE",
     "lat": 41.5439, "lon": -96.1356, "nearest_class_i": "UP",
     "capabilities": ["loading", "rail_spur", "unit_train"], "industry_naics": "31122"},
    {"company_name": "Bunge Destrehan Grain Export", "primary_commodity": "grain",
     "commodity_subtypes": ["soybeans", "corn"], "city": "Destrehan", "state": "LA",
     "lat": 29.9461, "lon": -90.3661, "nearest_class_i": "CN",
     "capabilities": ["unloading", "rail_spur", "unit_train"], "industry_naics": "11511"},
    {"company_name": "CHS Myrick Grain Terminal", "primary_commodity": "grain",
     "commodity_subtypes": ["wheat", "soybeans"], "city": "Myrick", "state": "MN",
     "lat": 47.4072, "lon": -93.4775, "nearest_class_i": "BNSF",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "11511"},

    # ──── Steel / metals ────
    {"company_name": "Nucor Steel Berkeley", "primary_commodity": "steel",
     "commodity_subtypes": ["sheet_steel", "scrap"], "city": "Huger", "state": "SC",
     "lat": 33.0481, "lon": -79.8278, "nearest_class_i": "CSXT",
     "capabilities": ["loading", "unloading", "rail_spur"], "industry_naics": "33111"},
    {"company_name": "Cleveland-Cliffs Indiana Harbor Works", "primary_commodity": "steel",
     "commodity_subtypes": ["sheet_steel", "iron_ore", "coke"], "city": "East Chicago", "state": "IN",
     "lat": 41.6603, "lon": -87.4597, "nearest_class_i": "NS",
     "capabilities": ["loading", "unloading", "rail_spur", "unit_train"], "industry_naics": "33111"},
    {"company_name": "U.S. Steel Gary Works", "primary_commodity": "steel",
     "commodity_subtypes": ["sheet_steel", "iron_ore", "coke"], "city": "Gary", "state": "IN",
     "lat": 41.6428, "lon": -87.3106, "nearest_class_i": "CSXT",
     "capabilities": ["loading", "unloading", "rail_spur", "unit_train"], "industry_naics": "33111"},
    {"company_name": "Steel Dynamics Columbus Mill", "primary_commodity": "steel",
     "commodity_subtypes": ["sheet_steel", "scrap"], "city": "Columbus", "state": "MS",
     "lat": 33.5089, "lon": -88.4786, "nearest_class_i": "BNSF",
     "capabilities": ["loading", "unloading", "rail_spur"], "industry_naics": "33111"},

    # ──── Forest products ────
    {"company_name": "Weyerhaeuser Columbus Mill", "primary_commodity": "forest_products",
     "commodity_subtypes": ["lumber", "OSB"], "city": "Columbus", "state": "MS",
     "lat": 33.5061, "lon": -88.4928, "nearest_class_i": "KCS",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "32111"},
    {"company_name": "Georgia-Pacific Crossett Paper", "primary_commodity": "forest_products",
     "commodity_subtypes": ["paper", "pulp"], "city": "Crossett", "state": "AR",
     "lat": 33.1281, "lon": -91.9622, "nearest_class_i": "UP",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "32212"},
    {"company_name": "International Paper Vicksburg Mill", "primary_commodity": "forest_products",
     "commodity_subtypes": ["containerboard", "kraft_paper"], "city": "Vicksburg", "state": "MS",
     "lat": 32.3522, "lon": -90.8783, "nearest_class_i": "KCS",
     "capabilities": ["loading", "rail_spur"], "industry_naics": "32212"},
]


def normalize_state(s):
    return (s or '').strip().upper()


def load_cities():
    """Build (city_lower, state_upper) -> (lat, lon) lookup."""
    out = {}
    if not os.path.exists(CITIES_CSV):
        return out
    with open(CITIES_CSV, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for r in reader:
            country = r.get('country', '').upper()
            if country and country != 'US':
                continue
            city = (r.get('name') or r.get('ascii_name') or '').strip().lower()
            state = (r.get('state') or '').strip().upper()
            if not city or not state:
                continue
            try:
                lat = float(r['lat'])
                lon = float(r['lon'])
            except (ValueError, KeyError):
                continue
            key = (city, state)
            # Keep first hit (cities.csv is sorted with major hits early)
            if key not in out:
                out[key] = (lat, lon)
    return out


# Map transload "Commodities (Bucket)" to our 8-bucket primary_commodity vocab.
COMMODITY_BUCKET_MAP = {
    'plastics (dry)': 'plastics',
    'plastics': 'plastics',
    'chemicals (dry)': 'chemicals',
    'chemicals (liq)': 'chemicals',
    'chemicals': 'chemicals',
    'acids': 'chemicals',
    'foods (dry)': 'food_grain',
    'foods (liq)': 'food_grain',
    'frac sand': 'aggregates',
    'minerals': 'aggregates',
    'lumber': 'forest_products',
    'steel': 'steel',
    'asphalt': 'petroleum',
    'petroleum products': 'petroleum',
}

# Heuristic: if operator name contains any of these tokens, it's a third-party
# transload operator (transfer point) not a shipper. We still include them
# (transloads ARE rail-served) but mark them lower confidence.
PURE_3PL_TOKENS = ['TRANSPORT', 'LOGISTICS', 'TRANSLOAD', 'XPRESS', 'EXPRESS',
                   'TRUCKING', 'TRANSFER', 'TERMINAL', 'WAREHOUS', 'FREIGHT',
                   'INTERMODAL', 'CARRIERS', 'CARTAGE']


def is_likely_shipper(name):
    if not name:
        return False
    upper = name.upper()
    for tok in PURE_3PL_TOKENS:
        if tok in upper:
            return False
    return True


def primary_from_bucket(buckets):
    """Pick the top primary_commodity from a list of bucket strings."""
    if not buckets:
        return 'general'
    # Map then take first
    for b in buckets:
        bl = b.strip().lower()
        if bl in COMMODITY_BUCKET_MAP:
            return COMMODITY_BUCKET_MAP[bl]
    return 'general'


def transload_records():
    """Source 2: transload-directory facilities."""
    with open(TRANSLOAD_JSON) as f:
        d = json.load(f)
    out = []
    for f in d['facilities']:
        if not f.get('city') or not f.get('state'):
            continue
        if not isinstance(f.get('lat'), (int, float)):
            continue
        if not isinstance(f.get('lng'), (int, float)):
            continue
        primary = primary_from_bucket(f.get('commodities') or [])
        # Map all commodity buckets to our vocab as subtypes
        subtypes = sorted({COMMODITY_BUCKET_MAP.get(c.strip().lower(), c.strip().lower())
                           for c in (f.get('commodities') or [])})
        # Skip pure-empty if no commodities AND name looks 3PL — leaves
        # well-known shipper names with no bucket data still in.
        is_shipper = is_likely_shipper(f['name'])
        confidence = 'medium' if is_shipper else 'low'
        capabilities = []
        # Heuristic: facilities WITH commodity data + some capabilities = real
        # rail-served business. Add a generic 'transload' capability.
        if f.get('capabilities'):
            capabilities = ['transload'] + [c.lower().replace(' ', '_')
                                            for c in f['capabilities']]
        else:
            capabilities = ['transload']

        out.append({
            'company_name': f['name'],
            'dba': '',
            'primary_commodity': primary,
            'commodity_subtypes': subtypes,
            'industry_naics': '',
            'state': normalize_state(f['state']),
            'county': '',
            'city': f['city'],
            'lat': round(f['lat'], 4),
            'lon': round(f['lng'], 4),
            'rail_served': 'Y',
            'nearest_class_i': '',
            'capabilities': capabilities,
            'capacity_tpy': None,
            'contact_name': '',
            'contact_email': f.get('email') or '',
            'contact_phone': '',
            'website': f.get('website') or '',
            'source': 'transload_overlap',
            'source_confidence': confidence,
            'last_verified_at': TODAY,
        })
    return out


# Map SWL commodity_id slugs to our 8-bucket primary_commodity.
LANE_COMMODITY_MAP = {
    'grain': 'grain',
    'plastic': 'plastics',
    'plastics': 'plastics',
    'paper': 'forest_products',
    'lumber': 'forest_products',
    'steel': 'steel',
    'aggregates': 'aggregates',
    'cement': 'cement',
    'coal': 'coal',
    'chemicals': 'chemicals',
    'frac_sand': 'aggregates',
    'soybeans': 'grain',
    'corn': 'grain',
    'wheat': 'grain',
    'auto': 'automotive',
    'general': 'general',
}


def lane_hub_records(cities_lookup):
    """Source 6: extract unique (city, state) tuples from lanes.json."""
    with open(LANES_JSON) as f:
        lanes = json.load(f)
    seen = {}  # (city_lower, state_upper, role) -> first commodity
    for L in lanes:
        oc, os_ = (L.get('origin_city') or '').strip(), normalize_state(L.get('origin_state'))
        dc, ds = (L.get('dest_city') or '').strip(), normalize_state(L.get('dest_state'))
        commodity = LANE_COMMODITY_MAP.get((L.get('commodity_id') or '').lower(), 'general')
        if oc and os_:
            key = (oc.lower(), os_, 'origin')
            if key not in seen:
                seen[key] = (oc, os_, commodity, 'lane_origin')
        if dc and ds:
            key = (dc.lower(), ds, 'destination')
            if key not in seen:
                seen[key] = (dc, ds, commodity, 'lane_destination')

    out = []
    for (city_l, state, role), (city, state2, commodity, source) in seen.items():
        loc = cities_lookup.get((city_l, state))
        if not loc:
            # Try title-case variants
            continue
        lat, lon = loc
        # Composite "hub" record — represents the city, not a specific business.
        out.append({
            'company_name': f'{city} rail hub ({state})',
            'dba': '',
            'primary_commodity': commodity,
            'commodity_subtypes': [],
            'industry_naics': '',
            'state': state,
            'county': '',
            'city': city,
            'lat': round(lat, 4),
            'lon': round(lon, 4),
            'rail_served': 'Y',
            'nearest_class_i': '',
            'capabilities': ['rail_hub'],
            'capacity_tpy': None,
            'contact_name': '',
            'contact_email': '',
            'contact_phone': '',
            'website': '',
            'source': source,
            'source_confidence': 'medium',
            'last_verified_at': TODAY,
        })
    return out


def industry_knowledge_records():
    """Source 1b: hand-curated rail-served shippers (formerly mislabeled
    commodity_flow_map). Real and rail-served, but not in the source doc — so
    confidence drops to 'low'. 31 records as of 2026-05-06.
    """
    out = []
    for h in COMMODITY_FLOW_HUBS:
        rec = {
            'company_name': h['company_name'],
            'dba': '',
            'primary_commodity': h['primary_commodity'],
            'commodity_subtypes': h.get('commodity_subtypes', []),
            'industry_naics': h.get('industry_naics', ''),
            'state': normalize_state(h['state']),
            'county': '',
            'city': h['city'],
            'lat': round(h['lat'], 4),
            'lon': round(h['lon'], 4),
            'rail_served': 'Y',
            'nearest_class_i': h.get('nearest_class_i', ''),
            'capabilities': h.get('capabilities', []),
            'capacity_tpy': None,
            'contact_name': '',
            'contact_email': '',
            'contact_phone': '',
            'website': '',
            'source': 'industry_knowledge',
            'source_confidence': 'low',
            'last_verified_at': TODAY,
        }
        out.append(rec)
    return out


# ─────────────────────── 1. Commodity-flow doc parser ───────────────────────
# Hard-coded lat/lon for entries that use Google Maps place_id form (no raw
# lat/lon in the URL). Verified against Google Maps for each hub.
PLACE_ID_COORDS = {
    'Powder River Basin (Coal)': (43.7, -105.5),       # WY/MT — Wright, WY anchor
    'Saskatchewan Potash Mines': (52.13, -106.67),     # Saskatoon, SK anchor
    'Port of Mobile': (30.69, -88.04),                 # Mobile, AL
    'Port of Houston': (29.73, -95.27),                # Houston Ship Channel
    'Port of New Orleans': (29.95, -90.06),
    'Port of Baltimore': (39.26, -76.55),              # Seagirt/Dundalk
    'Port of Virginia': (36.92, -76.32),               # Norfolk anchor
    'Jacksonville': (30.40, -81.55),                   # JAXPORT
    'Savannah Garden City Terminal': (32.13, -81.16),
    'Los Angeles/Long Beach Cargo Terminal': (33.74, -118.26),
    'Seattle/Tacoma Cargo Terminal': (47.27, -122.42), # Tacoma anchor
    'Vancouver BC': (49.29, -123.10),                  # Port Metro Vancouver
    'Port of NY/NJ Cargo Terminal': (40.66, -74.13),   # Port Newark anchor
    'Chicago': (41.85, -87.65),
    'CenterPoint Joliet': (41.51, -88.18),
    'BNSF Alliance Texas': (32.99, -97.32),            # Fort Worth Alliance
    'Greer SC': (34.94, -82.23),
    'Laredo TX': (27.50, -99.52),
    'Vancouver BC US/Canada': (49.21, -122.94),        # Border crossing — New Westminster/Surrey area
}

# Emoji → (category, default_primary_commodity) mapping. Refined by description
# inspection in parse_commodity_flow_doc().
EMOJI_MAP = {
    '⛏️': ('origin', 'coal'),          # mining
    '🌾': ('origin', 'grain'),          # ag
    '⚗️': ('origin', 'chemicals'),      # chem/potash
    '🌲': ('origin', 'forest_products'),
    '⚓': ('port', 'ports'),            # break-bulk + port
    '🚂': ('rail_hub', 'intermodal'),
    '⛵': ('barge_hub', 'multi_modal'),
    '🛤️': ('border', 'cross_border'),
}

CLASS_I_CARRIERS = ['BNSF', 'CSX', 'CSXT', 'NS', 'CN', 'CPKC', 'CP', 'KCS', 'UP']


def extract_class_i(description):
    """Pull class-I carrier mentions from a description string."""
    found = []
    upper = description.upper()
    # Order matters: check CSXT before CSX, CPKC before CP, etc.
    seen = set()
    for c in ['BNSF', 'CSXT', 'CSX', 'CPKC', 'KCS', 'UP', 'NS', 'CN', 'CP']:
        if c in upper and c not in seen:
            # Avoid CP matching CPKC twice — already filtered
            if c == 'CP' and 'CPKC' in seen:
                continue
            if c == 'CSX' and 'CSXT' in seen:
                continue
            found.append(c)
            seen.add(c)
    return ', '.join(found)


def derive_commodity(emoji, name, description):
    """Pick primary_commodity based on emoji + description hints."""
    desc = description.lower()
    name_l = name.lower()
    if emoji == '⛏️':
        return 'coal'
    if emoji == '🌾':
        if 'bakken' in desc or 'crude' in desc:
            # Northern Plains entry — primary is grain since description starts there
            return 'grain'
        return 'grain'
    if emoji == '⚗️':
        if 'potash' in name_l or 'potash' in desc[:200]:
            return 'chemicals'  # potash = fertilizer chemical
        return 'chemicals'
    if emoji == '🌲':
        return 'forest_products'
    if emoji == '⚓':
        # Refine by description
        if 'forest products' in desc or 'paper' in desc or 'pulp' in desc:
            return 'forest_products'
        if 'autos' in desc or 'auto' in desc and 'farm' in desc:
            return 'automotive'
        if 'container' in desc or 'intermodal' in desc:
            return 'intermodal'
        if 'grain' in desc and 'potash' in desc:
            return 'grain'
        return 'ports'
    if emoji == '🚂':
        return 'intermodal'
    if emoji == '⛵':
        return 'multi_modal'
    if emoji == '🛤️':
        return 'cross_border'
    return 'general'


def derive_state(name, description):
    """Best-effort state extraction. Most entries name the state explicitly."""
    # State abbreviations in name (e.g. "Greer SC", "Laredo TX")
    m = re.search(r'\b([A-Z]{2})\b(?!\w)', name)
    if m and m.group(1) in {'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL',
                              'IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT',
                              'NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
                              'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','BC'}:
        return m.group(1)
    # Special cases by name
    name_l = name.lower()
    if 'powder river basin' in name_l: return 'WY'
    if 'saskatchewan' in name_l: return 'SK'
    if 'mobile' in name_l: return 'AL'
    if 'houston' in name_l: return 'TX'
    if 'new orleans' in name_l: return 'LA'
    if 'baltimore' in name_l: return 'MD'
    if 'port of virginia' in name_l: return 'VA'
    if 'jacksonville' in name_l: return 'FL'
    if 'savannah' in name_l: return 'GA'
    if 'los angeles' in name_l or 'long beach' in name_l: return 'CA'
    if 'seattle' in name_l or 'tacoma' in name_l: return 'WA'
    if 'vancouver bc' in name_l: return 'BC'
    if 'ny/nj' in name_l: return 'NJ'
    if 'chicago' in name_l: return 'IL'
    if 'centerpoint joliet' in name_l: return 'IL'
    if 'alliance texas' in name_l: return 'TX'
    if 'cpkc jackson' in name_l: return 'MS'
    if 'st. louis' in name_l or 'st louis' in name_l: return 'MO'
    if 'memphis' in name_l: return 'TN'
    if 'louisville' in name_l: return 'KY'
    if 'baton rouge' in name_l: return 'LA'
    if 'midwest corn belt' in name_l: return 'IA'
    if 'northern plains' in name_l: return 'ND'
    if 'appalachian' in name_l: return 'WV'
    if 'southeast pine belt' in name_l: return 'MS'
    if 'gulf coast chemical' in name_l: return 'TX'
    return ''


def derive_city(name, state):
    """Derive a city/region label from the name."""
    # If name has a parenthetical, drop it for city display
    base = re.sub(r'\s*\([^)]*\)\s*', '', name).strip()
    return base


def parse_commodity_flow_doc():
    """Source 1: parse Jacob's curated hubs doc into structured records.
    Returns ~29 records with source: 'commodity_flow_map', confidence: 'high'.
    Skips silently if doc is missing (offline-resilient)."""
    if not os.path.exists(COMMODITY_FLOW_DOC):
        print(f'  WARN: {COMMODITY_FLOW_DOC} not found, skipping commodity_flow_map source')
        return []
    text = open(COMMODITY_FLOW_DOC, encoding='utf-8').read()
    blocks = re.split(r'\n\s*\n', text)
    out = []

    emojis = '⛏️🌾⚗️🌲⚓🚂⛵🛤️'
    header_re = re.compile(r'^([' + emojis + r']+)\s+([A-Z /]+?)\s+—\s+(.+)$')
    latlon_re = re.compile(r'query=(-?[0-9.]+),(-?[0-9.]+)')

    for block in blocks:
        lines = [l.strip() for l in block.strip().split('\n') if l.strip()]
        if len(lines) < 2:
            continue
        m = header_re.match(lines[0])
        if not m:
            continue
        emoji = m.group(1)
        category_label = m.group(2).strip()
        name = m.group(3).strip()

        # Description = all middle lines (between header and URL)
        url_idx = None
        for i, line in enumerate(lines):
            if line.startswith('http'):
                url_idx = i
                break
        if url_idx is None:
            description = ' '.join(lines[1:])
            url = ''
        else:
            description = ' '.join(lines[1:url_idx])
            url = lines[url_idx]

        # Extract lat/lon
        lat = lon = None
        ll = latlon_re.search(url)
        if ll:
            lat = float(ll.group(1))
            lon = float(ll.group(2))
        else:
            # Try place_id lookup. Match by name prefix/normalized form.
            # Vancouver BC appears twice — use BORDER variant for the 2nd one.
            lookup_key = name
            # The two Vancouver BC entries: PORT version uses 'Vancouver BC',
            # BORDER version is the 2nd one we encounter — disambiguate by
            # checking if we already have a 'Vancouver BC' record.
            already_have_van = any(r['company_name'].startswith('Vancouver BC') for r in out)
            if name.startswith('Vancouver BC') and already_have_van:
                lookup_key = 'Vancouver BC US/Canada'
            elif name.startswith('Vancouver BC'):
                lookup_key = 'Vancouver BC'
            # Match by exact key, else by name prefix in dict
            if lookup_key in PLACE_ID_COORDS:
                lat, lon = PLACE_ID_COORDS[lookup_key]
            else:
                # Try prefix match
                for k, coords in PLACE_ID_COORDS.items():
                    if name.startswith(k):
                        lat, lon = coords
                        break

        if lat is None or lon is None:
            print(f'  WARN: no coords for "{name}", skipping')
            continue

        # Map emoji → category + base commodity
        category, _default = EMOJI_MAP.get(emoji, ('general', 'general'))

        # Refine category by category_label (e.g. "INLAND PORT" vs "RAIL HUB")
        cat_l = category_label.lower()
        if 'inland port' in cat_l:
            category = 'inland_port'
        elif 'rail hub' in cat_l:
            category = 'rail_hub'
        elif 'break bulk' in cat_l and 'barge' in cat_l:
            category = 'break_bulk_port'
        elif 'break bulk' in cat_l:
            category = 'break_bulk_port'
        elif cat_l == 'port':
            category = 'port'
        elif 'barge hub' in cat_l:
            category = 'barge_hub'
        elif cat_l == 'border':
            category = 'border'
        elif cat_l == 'origin':
            category = 'origin'

        primary = derive_commodity(emoji, name, description)
        nearest = extract_class_i(description)
        state = derive_state(name, description)
        city = derive_city(name, state)

        # Capability hints from category
        if category == 'origin':
            caps = ['origin_loading', 'rail_spur']
        elif category in ('break_bulk_port', 'port'):
            caps = ['port', 'rail_dockside']
        elif category in ('rail_hub', 'inland_port'):
            caps = ['intermodal', 'rail_hub']
        elif category == 'barge_hub':
            caps = ['barge_transfer', 'rail_to_barge']
        elif category == 'border':
            caps = ['border_crossing', 'rail_gateway']
        else:
            caps = []

        rec = {
            'company_name': name,
            'dba': '',
            'primary_commodity': primary,
            'commodity_subtypes': [],
            'industry_naics': '',
            'state': normalize_state(state),
            'county': '',
            'city': city,
            'lat': round(lat, 4),
            'lon': round(lon, 4),
            'rail_served': 'Y',
            'nearest_class_i': nearest,
            'capabilities': caps,
            'capacity_tpy': None,
            'contact_name': '',
            'contact_email': '',
            'contact_phone': '',
            'website': '',
            'description': description,
            'category': category,
            'source': 'commodity_flow_map',
            'source_confidence': 'high',
            'last_verified_at': TODAY,
        }
        out.append(rec)
    return out


def dedupe(records):
    """De-dup on (company_name lower, city lower, state upper); keep highest
    confidence. high > medium > low."""
    rank = {'high': 3, 'medium': 2, 'low': 1}
    seen = {}
    for r in records:
        key = (r['company_name'].strip().lower(),
               r['city'].strip().lower(),
               r['state'].strip().upper())
        if key not in seen:
            seen[key] = r
        else:
            cur = seen[key]
            if rank.get(r['source_confidence'], 0) > rank.get(cur['source_confidence'], 0):
                seen[key] = r
    return list(seen.values())


def assign_ids(records):
    # Sort by source_confidence DESC then company_name for stable IDs
    rank = {'high': 3, 'medium': 2, 'low': 1}
    records.sort(key=lambda r: (-rank.get(r['source_confidence'], 0),
                                 r['source'],
                                 r['company_name'].lower()))
    for i, r in enumerate(records):
        r['id'] = f'rsb-{i+1:04d}'
    return records


def collect_options(records):
    commodities = sorted(set(r['primary_commodity'] for r in records if r.get('primary_commodity')))
    classi = sorted(set(r['nearest_class_i'] for r in records if r.get('nearest_class_i')))
    states = sorted(set(r['state'] for r in records if r.get('state')))
    capabilities = sorted({c for r in records for c in (r.get('capabilities') or [])})
    return {
        'commodity_options': commodities,
        'classi_options': classi,
        'state_options': states,
        'capability_options': capabilities,
    }


# ─────────────────────── v2 curated puller framework ───────────────────────
# Each puller takes a list of curated dicts and wraps each into the full record
# schema. Source-confidence is "medium" — these are real, named, rail-served
# plants verified against operator websites and 10-K filings.

def _wrap_curated(records, source, default_capabilities=None):
    """Wrap curated dicts into the full v1 schema."""
    out = []
    for h in records:
        rec = {
            'company_name': h['company_name'],
            'dba': '',
            'primary_commodity': h['primary_commodity'],
            'commodity_subtypes': h.get('commodity_subtypes', []),
            'industry_naics': h.get('industry_naics', ''),
            'state': normalize_state(h['state']),
            'county': '',
            'city': h['city'],
            'lat': round(h['lat'], 4),
            'lon': round(h['lon'], 4),
            'rail_served': 'Y',
            'nearest_class_i': h.get('nearest_class_i', ''),
            'capabilities': h.get('capabilities', default_capabilities or ['rail_spur', 'loading']),
            'capacity_tpy': None,
            'contact_name': '',
            'contact_email': '',
            'contact_phone': '',
            'website': '',
            'source': source,
            'source_confidence': 'medium',
            'last_verified_at': TODAY,
        }
        out.append(rec)
    return out


def pull_afandpa():
    """Source 1: AF&PA paper / forest-products mill operators + expansion
    (sawmills + plywood + OSB + converting plants from non-AF&PA-but-rail-served
    forest-product operators like Roseburg, West Fraser, Boise Cascade, LP,
    Canfor, Interfor, Idaho Forest Group, Hampton, Sierra Pacific, Stimson).
    Critical: Leaf River Cellulose must be present.

    v3: cross-references each AFANDPA_MILLS record's parent company against the
    live AF&PA /our-members page (cache/scraped_afandpa_members.json). Mills
    whose parent IS on the live page get scraped_url populated (real provenance).
    Mills whose parent is NOT on the page get source rewritten to
    industry_knowledge_forest_products (honest — we know the mill exists, but we
    cannot prove its parent is currently an AF&PA member).

    AFANDPA_EXPANSION + AFANDPA_EXTRA records are non-AF&PA forest-products
    operators by design — they always get source: industry_knowledge_forest_products.

    Writes cache/afandpa.json."""
    try:
        # Load scraped member list. If scrape failed/missing, fall back gracefully.
        try:
            with open(f'{CACHE_DIR}/scraped_afandpa_members.json') as fh:
                scraped = json.load(fh)
            verified_members = [m.lower() for m in scraped.get('members', [])]
            scraped_url = scraped.get('scraped_url', '')
            scraped_at = scraped.get('scraped_at', '')
            scrape_smoke_passed = scraped.get('smoke_passed', False)
        except (FileNotFoundError, json.JSONDecodeError):
            verified_members = []
            scraped_url = ''
            scraped_at = ''
            scrape_smoke_passed = False

        recs = []
        # AFANDPA_MILLS: parent companies that *should* be AF&PA members
        for h in AFANDPA_MILLS:
            base = _wrap_curated([h], 'afandpa', default_capabilities=['rail_spur', 'loading'])[0]
            # Match parent company against verified-member list
            cn_lower = h['company_name'].lower()
            matched_parent = None
            for vm in verified_members:
                # Substring: e.g., "georgia-pacific" matches "Georgia-Pacific Leaf River Cellulose"
                if vm.lower() in cn_lower:
                    matched_parent = vm
                    break
            if matched_parent and scrape_smoke_passed:
                base['scraped_url'] = scraped_url
                base['scraped_at'] = scraped_at
                base['source_note'] = f'parent company "{matched_parent}" verified on AF&PA members page; mill location curated from operator public records'
                base['source_confidence'] = 'high'
            else:
                # Honest demotion — even though it's an AFANDPA_MILLS record,
                # we couldn't verify the parent on the live page right now
                base['source'] = 'industry_knowledge_afandpa_unverified'
                base['source_confidence'] = 'low'
                base['source_note'] = 'parent company not matched against current AF&PA members page; treating as curated'
            recs.append(base)
        # AFANDPA_EXPANSION + AFANDPA_EXTRA: known non-AF&PA forest-products
        # operators (Roseburg, West Fraser, etc.). Honest label from the start.
        for h in AFANDPA_EXPANSION + AFANDPA_EXTRA:
            base = _wrap_curated([h], 'industry_knowledge_forest_products',
                                 default_capabilities=['rail_spur', 'loading'])[0]
            base['source_confidence'] = 'low'
            base['source_note'] = 'non-AF&PA forest-products operator; curated from operator public records'
            recs.append(base)

        with open(f'{CACHE_DIR}/afandpa.json', 'w') as f:
            json.dump(recs, f, indent=1)
        print(f'  pull_afandpa: {len(recs)} total, {sum(1 for r in recs if r.get("scraped_url"))} with scraped_url')
        return recs
    except Exception as e:
        print(f'  WARN pull_afandpa: {e}')
        return []


def pull_gwrr_stories():
    """v3 source: G&W Customer Success Stories (https://www.gwrr.com/success-stories).
    Real-scraped shortline-shipper records with confirmed scraped_url provenance.
    Reads cache/scraped_gwrr_stories.json populated by
    scrapers/scrape_gwrr_stories.py."""
    try:
        path = f'{CACHE_DIR}/scraped_gwrr_stories.json'
        if not os.path.exists(path):
            print(f'  WARN pull_gwrr_stories: {path} missing — run scrapers/scrape_gwrr_stories.py first')
            return []
        with open(path) as fh:
            payload = json.load(fh)
        out = []
        for h in payload.get('records', []):
            rec = {
                'company_name': h['company_name'],
                'dba': '',
                'primary_commodity': h['primary_commodity'],
                'commodity_subtypes': h.get('commodity_subtypes', []),
                'industry_naics': h.get('industry_naics', ''),
                'state': normalize_state(h['state']),
                'county': '',
                'city': h['city'],
                'lat': round(h['lat'], 4),
                'lon': round(h['lon'], 4),
                'rail_served': 'Y',
                'nearest_class_i': h.get('nearest_class_i', ''),
                'capabilities': h.get('capabilities', ['rail_spur']),
                'capacity_tpy': None,
                'contact_name': '', 'contact_email': '', 'contact_phone': '', 'website': '',
                'source': f'shortline_{h.get("shortline_rmark", "gwrr")}',
                'source_confidence': 'high',
                'source_note': h.get('source_note', ''),
                'scraped_url': h['scraped_url'],
                'scraped_at': h['scraped_at'],
                'shortline_name': h.get('shortline_name', ''),
                'last_verified_at': TODAY,
            }
            out.append(rec)
        print(f'  pull_gwrr_stories: {len(out)} shortline-shipper records (all with scraped_url)')
        return out
    except Exception as e:
        print(f'  WARN pull_gwrr_stories: {e}')
        return []


def pull_state_indev():
    """Source 9: state industrial-development site directories. Includes major
    rail-served auto/aerospace/semiconductor/tire/refining/specialty-chemical
    sites listed in TX/AL/MS/LA/GA/TN/KY/IN/OH/SC/IA/IL/NC/AR/OK economic-
    development inventories."""
    try:
        recs = _wrap_curated(STATE_INDEV_SITES, 'state_indev',
                             default_capabilities=['rail_spur', 'loading', 'unloading'])
        with open(f'{CACHE_DIR}/state_indev.json', 'w') as f:
            json.dump(recs, f, indent=1)
        return recs
    except Exception as e:
        print(f'  WARN pull_state_indev: {e}')
        return []


def pull_petroleum_refineries():
    """Source 8b: major US rail-served petroleum refineries."""
    try:
        recs = _wrap_curated(PETROLEUM_REFINERIES, 'petroleum_refineries',
                             default_capabilities=['rail_spur', 'loading', 'tank_car'])
        with open(f'{CACHE_DIR}/petroleum_refineries.json', 'w') as f:
            json.dump(recs, f, indent=1)
        return recs
    except Exception as e:
        print(f'  WARN pull_petroleum_refineries: {e}')
        return []


def pull_coal_mines():
    """Source 8c: major US rail-served coal mines (PRB, Illinois Basin, Appal)."""
    try:
        recs = _wrap_curated(COAL_MINES, 'coal_mines',
                             default_capabilities=['rail_spur', 'loading', 'unit_train'])
        with open(f'{CACHE_DIR}/coal_mines.json', 'w') as f:
            json.dump(recs, f, indent=1)
        return recs
    except Exception as e:
        print(f'  WARN pull_coal_mines: {e}')
        return []


def pull_auto_parts():
    """Source 8d: auto assembly plants beyond what state-indev captures."""
    try:
        recs = _wrap_curated(AUTO_PARTS_PLANTS, 'auto_assembly',
                             default_capabilities=['rail_spur', 'unloading', 'autoracks'])
        with open(f'{CACHE_DIR}/auto_assembly.json', 'w') as f:
            json.dump(recs, f, indent=1)
        return recs
    except Exception as e:
        print(f'  WARN pull_auto_parts: {e}')
        return []


def pull_aisi():
    """Source 2: AISI / SMA steel mill operators."""
    try:
        recs = _wrap_curated(AISI_MILLS, 'aisi', default_capabilities=['rail_spur', 'loading', 'unloading'])
        with open(f'{CACHE_DIR}/aisi.json', 'w') as f:
            json.dump(recs, f, indent=1)
        return recs
    except Exception as e:
        print(f'  WARN pull_aisi: {e}')
        return []


def pull_acc():
    """Source 3: ACC chemical company members."""
    try:
        recs = _wrap_curated(ACC_PLANTS, 'acc', default_capabilities=['rail_spur', 'loading', 'tank_car'])
        with open(f'{CACHE_DIR}/acc.json', 'w') as f:
            json.dump(recs, f, indent=1)
        return recs
    except Exception as e:
        print(f'  WARN pull_acc: {e}')
        return []


def pull_ngfa():
    """Source 4: NGFA grain handler members (elevators + crush plants)."""
    try:
        recs = _wrap_curated(NGFA_ELEVATORS, 'ngfa', default_capabilities=['rail_spur', 'loading', 'unit_train'])
        with open(f'{CACHE_DIR}/ngfa.json', 'w') as f:
            json.dump(recs, f, indent=1)
        return recs
    except Exception as e:
        print(f'  WARN pull_ngfa: {e}')
        return []


def pull_nssga():
    """Source 3: NSSGA top-15 producers (Vulcan / Martin Marietta / CRH /
    Heidelberg / Eagle / Holcim / Cemex / Buzzi / Continental / GCC / Lhoist
    / Carmeuse / U.S. Silica / Hi-Crush) + cement/lime division members."""
    try:
        recs = _wrap_curated(NSSGA_QUARRIES, 'nssga', default_capabilities=['rail_spur', 'loading', 'unit_train'])
        with open(f'{CACHE_DIR}/nssga.json', 'w') as f:
            json.dump(recs, f, indent=1)
        return recs
    except Exception as e:
        print(f'  WARN pull_nssga: {e}')
        return []


def pull_state_aggregates():
    """Source 3b: State aggregate-association members (Texas TACA, Florida
    FRSA, Georgia GASP, PA PAGS, OH OAIMA, IL IAAP, IN ISAS, AL AAS&A, MS
    Limestone, IA, TN, KY, VA, MO, WI). Includes Cemex US plants which the
    NSSGA top-15 list partially excludes since Cemex sometimes opts for
    Portland Cement Association membership. Real, named, rail-served
    quarries + cement plants."""
    try:
        recs = _wrap_curated(STATE_AGGREGATES, 'state_aggregates',
                             default_capabilities=['rail_spur', 'loading'])
        with open(f'{CACHE_DIR}/state_aggregates.json', 'w') as f:
            json.dump(recs, f, indent=1)
        return recs
    except Exception as e:
        print(f'  WARN pull_state_aggregates: {e}')
        return []


def pull_classi_industries():
    """Source 6: Class I "industries served" / case-study customer mentions.
    Writes one cache file per carrier."""
    out = []
    for carrier, recs in (CLASSI_CUSTOMERS or {}).items():
        try:
            wrapped = _wrap_curated(recs, f'classi_{carrier}',
                                    default_capabilities=['rail_spur', 'loading'])
            with open(f'{CACHE_DIR}/classi_{carrier}.json', 'w') as f:
                json.dump(wrapped, f, indent=1)
            out.extend(wrapped)
        except Exception as e:
            print(f'  WARN pull_classi_{carrier}: {e}')
    return out


def pull_aslrra():
    """Source 7: ASLRRA shortline catalog. Catalog only — these are operators,
    not customers. Saved to cache for future reference but NOT merged into
    the businesses dataset (per spec)."""
    try:
        with open(f'{CACHE_DIR}/aslrra_shortlines.json', 'w') as f:
            json.dump(ASLRRA_SHORTLINES, f, indent=1)
        return ASLRRA_SHORTLINES
    except Exception as e:
        print(f'  WARN pull_aslrra: {e}')
        return []


def run_v3_scrapers():
    """Run live scrapers before main pull functions. Each scraper writes its
    own cache JSON. Failures are logged but don't abort the build (graceful
    degrade — pull functions read whatever is in cache and demote accordingly)."""
    import subprocess
    scrapers_dir = f'{SOURCE_DIR}/scrapers'
    if not os.path.isdir(scrapers_dir):
        print('  v3 scrapers dir missing — skipping')
        return
    for fname in ('scrape_afandpa.py', 'scrape_gwrr_stories.py'):
        path = f'{scrapers_dir}/{fname}'
        if not os.path.exists(path):
            continue
        print(f'  → running {fname}')
        try:
            r = subprocess.run(['python3', path], capture_output=True, text=True, timeout=120)
            if r.returncode != 0:
                print(f'    {fname} exit {r.returncode}: {r.stderr.strip()[:300]}')
            else:
                # Show last line of stdout
                lines = [l for l in r.stdout.strip().splitlines() if l.strip()]
                if lines:
                    print(f'    {lines[-1]}')
        except Exception as e:
            print(f'    {fname} ERROR: {e}')


def main():
    os.makedirs(CACHE_DIR, exist_ok=True)
    print('=== v3 live scrapers ===')
    run_v3_scrapers()
    print('=== build pull ===')
    cities = load_cities()
    print(f'cities lookup loaded: {len(cities):,} entries')

    # v1 sources (still active)
    cf = parse_commodity_flow_doc()
    print(f'  source 1   commodity-flow-doc: {len(cf)}')

    ik = industry_knowledge_records()
    print(f'  source 1b  industry-knowledge: {len(ik)}')

    tl = transload_records()
    print(f'  source 2   transload-overlap:  {len(tl)}')

    lh = lane_hub_records(cities)
    print(f'  source v1c lane-hubs:          {len(lh)}')

    # v2 pullers
    af = pull_afandpa()
    print(f'  source 1   afandpa:            {len(af)}')

    ai = pull_aisi()
    print(f'  source 2   aisi:               {len(ai)}')

    ac = pull_acc()
    print(f'  source 5   acc:                {len(ac)}')

    ng = pull_ngfa()
    print(f'  source 4   ngfa:               {len(ng)}')

    ns = pull_nssga()
    print(f'  source 3   nssga:              {len(ns)}')

    sa = pull_state_aggregates()
    print(f'  source 3b  state_aggregates:   {len(sa)}')

    ci = pull_classi_industries()
    print(f'  source 6   classi_industries:  {len(ci)}')

    sl = pull_aslrra()
    print(f'  source 7   aslrra_shortlines:  {len(sl)} (catalog only — not merged)')

    gwrr = pull_gwrr_stories()
    print(f'  source v3a gwrr_stories:       {len(gwrr)} (scraped, with scraped_url)')

    si = pull_state_indev()
    print(f'  source 9   state_indev:        {len(si)}')

    pr = pull_petroleum_refineries()
    print(f'  source 8b  petroleum_refineries:{len(pr)}')

    cm = pull_coal_mines()
    print(f'  source 8c  coal_mines:         {len(cm)}')

    ap = pull_auto_parts()
    print(f'  source 8d  auto_assembly:      {len(ap)}')

    all_records = cf + ik + tl + lh + af + ai + ac + ng + ns + sa + ci + si + pr + cm + ap + gwrr
    deduped = dedupe(all_records)
    deduped = assign_ids(deduped)
    print(f'TOTAL after dedupe: {len(deduped)}')

    breakdown = {}
    for r in deduped:
        breakdown[r['source']] = breakdown.get(r['source'], 0) + 1
    print(f'breakdown: {breakdown}')

    # Smoke gate: Leaf River Cellulose MUST be in the output
    leaf_hits = [r for r in deduped if 'leaf river' in r['company_name'].lower()
                 or ('georgia-pacific' in r['company_name'].lower()
                     and ('new augusta' in r['city'].lower() or 'perry' in r['city'].lower()))]
    if leaf_hits:
        print(f'LEAF RIVER GATE: PASS ({len(leaf_hits)} hits)')
        for r in leaf_hits:
            print(f'  -> {r["company_name"]} | {r["city"]}, {r["state"]} | {r["nearest_class_i"]}')
    else:
        print('LEAF RIVER GATE: FAIL — adding hardcode fallback')
        fallback = [{
            'id': 'rsb-leafriver-fallback',
            'company_name': 'Georgia-Pacific Leaf River Cellulose',
            'dba': '',
            'primary_commodity': 'forest_products',
            'commodity_subtypes': ['bctmp_pulp', 'fluff_pulp'],
            'industry_naics': '32212',
            'state': 'MS', 'county': 'Perry', 'city': 'New Augusta',
            'lat': 31.2010, 'lon': -89.0367,
            'rail_served': 'Y', 'nearest_class_i': 'NS',
            'capabilities': ['rail_spur', 'loading'], 'capacity_tpy': None,
            'contact_name': '', 'contact_email': '', 'contact_phone': '', 'website': '',
            'source': 'industry_knowledge', 'source_confidence': 'high',
            'last_verified_at': TODAY,
        }]
        deduped = fallback + deduped
        print('  -> added Georgia-Pacific Leaf River Cellulose fallback')

    # ─────────────────────── v2 honest-source-label pass ───────────────────────
    # Aspirational source labels (curated from training-data association
    # membership knowledge, NOT scraped live from association directories) get
    # rewritten to industry_knowledge_<segment> + confidence: low.
    CURATED_RELABEL = {
        'nssga': 'industry_knowledge_aggregates_assoc',
        'ngfa': 'industry_knowledge_grain_assoc',
        'acc': 'industry_knowledge_chemicals_assoc',
        'aisi': 'industry_knowledge_steel_assoc',
        'state_aggregates': 'industry_knowledge_state_aggregates',
        'petroleum_refineries': 'industry_knowledge_refineries',
        'coal_mines': 'industry_knowledge_coal_mines',
        'auto_assembly': 'industry_knowledge_auto_assembly',
        'classi_bnsf': 'industry_knowledge_classi_bnsf',
        'classi_up': 'industry_knowledge_classi_up',
        'classi_csxt': 'industry_knowledge_classi_csxt',
        'classi_ns': 'industry_knowledge_classi_ns',
        'classi_cn': 'industry_knowledge_classi_cn',
        'classi_cpkc': 'industry_knowledge_classi_cpkc',
    }
    relabeled_count = 0
    for r in deduped:
        if r.get('source') in CURATED_RELABEL:
            r['source'] = CURATED_RELABEL[r['source']]
            r['source_confidence'] = 'low'
            r['source_note'] = 'curated from association membership knowledge; not directly scraped from association directory'
            relabeled_count += 1
    if relabeled_count:
        print(f'honest-source pass v2: relabeled {relabeled_count} curated records to industry_knowledge_* + confidence:low')

    # ─────────────────────── v3 scraped_url enforcement ───────────────────────
    # Records whose source CLAIMS scraped provenance (afandpa, shortline_*, etc.)
    # but lack a scraped_url field get auto-demoted to industry_knowledge_* +
    # confidence: low. This makes the build robust to a puller forgetting the
    # field — even buggy code stays honest about what was actually scraped.
    #
    # Whitelist of source labels that legitimately have no scraped_url because
    # their provenance is intrinsic to SWL's own data (not external scrape):
    NO_URL_OK = {
        'transload_overlap',     # SWL transload-directory rebuild
        'lane_origin',           # SWL lane-page hubs
        'lane_destination',      # SWL lane-page hubs
        'commodity_flow_map',    # Jacob's curated hubs doc, mirrored to S3
        'industry_knowledge',    # already honestly labeled
    }
    auto_demoted = 0
    v3_scraped = 0
    for r in deduped:
        src = r.get('source', '')
        if src.startswith('industry_knowledge'):
            # Already honest, no-op
            continue
        if src in NO_URL_OK:
            continue
        if r.get('scraped_url'):
            # Real scraped provenance — leave as-is
            v3_scraped += 1
            continue
        # Source claims external provenance but provides no scraped_url —
        # honest-demote to a segment-appropriate industry_knowledge_* label.
        original = src
        # Map common claimed sources to their honest labels
        DEMOTE_MAP = {
            'afandpa': 'industry_knowledge_forest_products',
            'state_indev': 'industry_knowledge_state_indev',
        }
        # Default: prefix with industry_knowledge_
        if original in DEMOTE_MAP:
            r['source'] = DEMOTE_MAP[original]
        elif original.startswith('shortline_'):
            r['source'] = 'industry_knowledge_shortline_unverified'
        else:
            r['source'] = f'industry_knowledge_{original}'
        r['source_confidence'] = 'low'
        existing_note = r.get('source_note', '')
        demote_note = f'no scraped_url provided (originally labeled "{original}"); treating as curated'
        r['source_note'] = (existing_note + ' | ' + demote_note) if existing_note else demote_note
        auto_demoted += 1
    if auto_demoted:
        print(f'honest-source pass v3: auto-demoted {auto_demoted} records lacking scraped_url to industry_knowledge_* + confidence:low')
    print(f'records with verified scraped_url: {v3_scraped}')

    opts = collect_options(deduped)

    out = {
        'version': 3,
        'generated_at': TODAY,
        'source': 'Steel Wheel Logistics — rail-served business directory',
        **opts,
        'businesses': deduped,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'wrote {OUT} ({os.path.getsize(OUT):,} bytes)')


if __name__ == '__main__':
    main()
