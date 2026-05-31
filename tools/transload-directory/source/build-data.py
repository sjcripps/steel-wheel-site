#!/usr/bin/env python3
# Joins transload-locations.csv (facilities with commodities/capabilities) +
# lat-long.csv (city/state → lat/long) → transload.json. Run once at build
# time; output is served as a static asset.
#
# Re-run when the source sheets are refreshed:
#   python3 build-data.py
import csv, json, os, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOC_CSV = HERE / "transload-locations.csv"
LL_CSV = HERE / "lat-long.csv"
OUT = HERE.parent / "data" / "transload.json"

COMMODITY_COLS = [
    "Acids", "Asphalt", "Chemicals (Dry)", "Chemicals (Liq)",
    "Foods (Dry)", "Foods (Liq)", "Frac Sand", "Lumber", "Minerals",
    "Petroleum Products", "Plastics (Dry)", "Steel",
]
CAPABILITY_COLS = [
    "Air Compressor", "Auger", "Blending Meters", "Blower", "Bulk Conveyor",
    "Gravity (Trestle)", "Hot Water Heating", "Liquid Pumps",
    "Liquid Storage Tanks", "Portable Vacuum", "Sampling Services", "Scale",
    "Steam Heating", "Tank Trailer Cleaning",
]

def norm_key(city, state):
    return (city.strip().upper(), state.strip().upper())

# Build (city, st) → (lat, lng) lookup. Sheet 2 has both UPPER and Title-cased
# city columns; we key off the UPPER one for join, then prefer Title for display.
ll_lookup = {}
ll_display_city = {}
with LL_CSV.open(newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    for row in reader:
        city_upper = (row.get("City", "") or "").strip()
        city_title = (row.get("City.1", "") or "").strip()
        state = (row.get("State/Province", "") or "").strip()
        try:
            lat = float(row.get("Latitude", "") or "nan")
            lng = float(row.get("Longitude", "") or "nan")
        except ValueError:
            continue
        if city_upper and state and lat == lat and lng == lng:
            key = (city_upper, state.upper())
            ll_lookup[key] = (lat, lng)
            if city_title:
                ll_display_city[key] = city_title

facilities = []
missing_latlng = 0
with LOC_CSV.open(newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    for row in reader:
        name = (row.get("Name", "") or "").strip()
        email = (row.get("Email", "") or "").strip().lower()
        city = (row.get("City", "") or "").strip()
        state = (row.get("ST", "") or "").strip()
        website = (row.get("Website", "") or "").strip()

        if not name or not city or not state:
            continue

        commodities = [c for c in COMMODITY_COLS if (row.get(c, "") or "").strip().upper() == "YES"]
        capabilities = [c for c in CAPABILITY_COLS if (row.get(c, "") or "").strip().upper() == "YES"]

        key = norm_key(city, state)
        ll = ll_lookup.get(key)
        if ll:
            lat, lng = ll
        else:
            missing_latlng += 1
            lat, lng = None, None

        # Prefer the Title-cased city from sheet 2 if available; else title-case
        # the upper-case city from sheet 1.
        display_city = ll_display_city.get(key) or city.title()

        facilities.append({
            "name": name,
            "email": email,
            "city": display_city,
            "state": state.upper(),
            "commodities": commodities,
            "capabilities": capabilities,
            "website": website,
            "lat": lat,
            "lng": lng,
        })

# Drop facilities without lat/long for the v1 — they can't be mapped. Keep
# them in a sidecar list so we don't lose data, but the UI works off the
# mappable subset.
mappable = [f for f in facilities if f["lat"] is not None and f["lng"] is not None]
unmapped = [{"name": f["name"], "city": f["city"], "state": f["state"]}
            for f in facilities if f["lat"] is None]

out = {
    "version": 1,
    "generated_at": "2026-04-29",
    "source": "Steel Wheel Logistics — internal transload directory",
    "commodity_options": COMMODITY_COLS,
    "capability_options": CAPABILITY_COLS,
    "facilities": mappable,
    "unmapped_count": len(unmapped),
}

OUT.parent.mkdir(parents=True, exist_ok=True)
with OUT.open("w", encoding="utf-8") as f:
    json.dump(out, f, separators=(",", ":"), ensure_ascii=False)

print(f"facilities (with lat/lng): {len(mappable)}")
print(f"facilities missing lat/lng: {missing_latlng}")
print(f"output: {OUT} ({OUT.stat().st_size} bytes)")
