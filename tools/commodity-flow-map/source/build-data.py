#!/usr/bin/env python3
"""
Build the slim hubs.json file consumed by the commodity-flow-map tool.

Filters the rail-served-businesses dataset for `is_commodity_hub == True`,
maps every record to a layer key matching the 8 toggleable category layers in
the UI, and emits only the fields the front-end needs.

Three classes of input record carry is_commodity_hub: true:
  - The original 29 records sourced from Jacob's Sunday source doc
    (source == "commodity_flow_map", source_confidence == "high")
  - Real-scrape records (e.g. source == "usda_grain_inspection") with a
    real scraped_url — confidence "medium"
  - Curated training-data records (source == "industry_knowledge_<segment>")
    with a source_note — confidence "low"
The visualization picks them all up uniformly. Provenance stays honest in the
underlying dataset.

Mapping rules (every is_commodity_hub record must land in some layer; never
silently drop):

  layer = "origin_coal"           ⛏️   category=origin   primary_commodity in [coal, iron_ore] (mining/extraction)
  layer = "origin_grain"          🌾   category=origin   primary_commodity in [grain, crude_oil]
  layer = "origin_chemicals"      ⚗️   category=origin   primary_commodity in [chemicals, steel, auto, ...] (industrial origin / catch-all)
  layer = "origin_forest"         🌲   category=origin   primary_commodity=forest_products
  layer = "port"                  ⚓   category in [port, break_bulk_port]
  layer = "rail_hub"              🚂   category in [inland_port, rail_hub]
  layer = "barge_hub"             ⛵   category=barge_hub
  layer = "border"                🛤️   category=border (or border_crossing)

Run:
    python3 build-data.py
Outputs:
    /home/ubuntu/projects/steel-wheel-site/tools/commodity-flow-map/data/hubs.json
"""
import json
import os
import sys

SOURCE = "/home/ubuntu/projects/steel-wheel-site/tools/rail-served-businesses/data/businesses.json"
DEST   = "/home/ubuntu/projects/steel-wheel-site/tools/commodity-flow-map/data/hubs.json"

# Layer metadata mirrors the legend in the UI. The order here is the legend order.
LAYERS = [
    {"key": "origin_coal",      "emoji": "⛏️",  "label": "Origin (coal / iron ore)",     "color": "#3a3a3a"},
    {"key": "origin_grain",     "emoji": "🌾",  "label": "Origin (grain / crude)",       "color": "#d4a017"},
    {"key": "origin_chemicals", "emoji": "⚗️",  "label": "Origin (industrial / chems)",  "color": "#7b3ff2"},
    {"key": "origin_forest",    "emoji": "🌲",  "label": "Origin (forest products)",     "color": "#2e7d32"},
    {"key": "port",             "emoji": "⚓",   "label": "Port / break-bulk",        "color": "#005f73"},
    {"key": "rail_hub",         "emoji": "🚂",  "label": "Rail hub / inland port",   "color": "#c1121f"},
    {"key": "barge_hub",        "emoji": "⛵",  "label": "Barge hub",                "color": "#0096c7"},
    {"key": "border",           "emoji": "🛤️",  "label": "Border crossing",          "color": "#ff6b00"},
]


def assign_layer(rec: dict) -> str | None:
    cat = (rec.get("category") or "").strip()
    pc  = (rec.get("primary_commodity") or "").strip()
    if cat == "origin":
        if pc in ("coal", "iron_ore"):
            return "origin_coal"
        if pc in ("grain", "crude_oil"):
            return "origin_grain"
        if pc == "chemicals":
            return "origin_chemicals"
        if pc == "forest_products":
            return "origin_forest"
        # Origin records with an industrial-output commodity (steel, auto,
        # cement, etc.) land in the "industrial / chems" bucket — that layer
        # is the catch-all for non-mining, non-grain, non-forest origins so
        # we never drop a record. (Spec rule: every record must land in a layer.)
        return "origin_chemicals"
    if cat in ("port", "break_bulk_port"):
        return "port"
    if cat in ("inland_port", "rail_hub"):
        return "rail_hub"
    if cat == "barge_hub":
        return "barge_hub"
    if cat in ("border", "border_crossing"):
        return "border"
    return None


def slugify(s: str) -> str:
    out = []
    for ch in (s or "").lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-")


def main():
    with open(SOURCE, "r") as f:
        raw = json.load(f)
    rows = raw.get("businesses") if isinstance(raw, dict) else raw
    if not isinstance(rows, list):
        sys.exit("Unexpected source schema; expected list under 'businesses' key")

    hubs = []
    layer_counts = {layer["key"]: 0 for layer in LAYERS}
    for rec in rows:
        if not rec.get("is_commodity_hub"):
            continue
        layer = assign_layer(rec)
        if not layer:
            sys.exit(f"FATAL: record {rec.get('id')} did not match any layer "
                     f"(category={rec.get('category')!r}, primary_commodity={rec.get('primary_commodity')!r}). "
                     f"Refusing to silently drop a record.")
        layer_counts[layer] += 1

        hub_id = rec.get("id") or slugify(rec.get("company_name") or "")
        hubs.append({
            "id": hub_id,
            "slug": slugify(rec.get("company_name") or hub_id),
            "name": rec.get("company_name") or "(unnamed hub)",
            "city": rec.get("city") or "",
            "state": rec.get("state") or "",
            "lat": rec.get("lat"),
            "lon": rec.get("lon"),
            "category": rec.get("category") or "",
            "primary_commodity": rec.get("primary_commodity") or "",
            "nearest_class_i": rec.get("nearest_class_i") or "",
            "description": rec.get("description") or "",
            "layer": layer,
        })

    # Sanity gates — fail loudly if the contract slips.
    # Floor of 55 protects against an accidental schema regression that drops
    # records; ceiling of 75 protects against runaway additions.
    if not (55 <= len(hubs) <= 75):
        sys.exit(f"FATAL: expected 55-75 is_commodity_hub records, got {len(hubs)}. "
                 f"Source dataset may have drifted; investigate before deploying.")
    for h in hubs:
        if not isinstance(h["lat"], (int, float)) or not isinstance(h["lon"], (int, float)):
            sys.exit(f"FATAL: hub {h['id']} ({h['name']}) is missing lat/lon — refusing to ship a hub that won't render.")

    out = {
        "version": 2,
        "generated_from": "rail-served-businesses/data/businesses.json (is_commodity_hub==True)",
        "hub_count": len(hubs),
        "layers": LAYERS,
        "hubs": hubs,
    }

    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    with open(DEST, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"Wrote {len(hubs)} hubs to {DEST}")
    for layer in LAYERS:
        print(f"  {layer['emoji']}  {layer['label']:38} {layer_counts[layer['key']]}")


if __name__ == "__main__":
    main()
