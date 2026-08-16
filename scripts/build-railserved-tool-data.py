#!/usr/bin/env python3
"""Generate tools/rail-served-businesses/data/businesses.json from the canonical
confidence-tiered merged rail-served dataset (Phase A1, Rail Data Foundation).

Canonical input (one dataset, faceted — directory doctrine):
  /home/ubuntu/bots/assistant/businesses/steel-wheel/data/railserved-merged-v1.json
  2,542 records {name, state, city, lat, lon, serving_railroads, commodities,
  evidence[], confidence: high|medium|low}

Mapping to the tool's existing field shape (see tools/rail-served-businesses/
index.html — the UI reads company_name, city, state, lat, lon,
primary_commodity, nearest_class_i, website + top-level commodity_options /
classi_options):
  company_name    = name
  rail_served     = 'Y' for high confidence, 'reported' for medium
  nearest_class_i = first serving_railroad (may be a short line; the UI label
                    was changed from "Class I" to "Railroad" to match)
  confidence      = high|medium (NEW field; UI shows a 'reported' pill for medium)

Low-confidence named-spur records (OSM named spur, no facility polygon) are
EXCLUDED from the tool entirely.

Usage: python3 scripts/build-railserved-tool-data.py [path-to-merged-json]
"""

import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = Path(
    "/home/ubuntu/bots/assistant/businesses/steel-wheel/data/railserved-merged-v1.json"
)
OUTPUT = ROOT / "tools" / "rail-served-businesses" / "data" / "businesses.json"

# Class I roads listed first in the railroad filter; everything else alphabetical.
CLASS_I_ORDER = ["BNSF", "CN", "CPRS", "CSXT", "NS", "UP"]

# A commodity value needs at least this many records to earn a filter checkbox —
# the merged data carries free-text commodities from rail-plan extractions, and
# one-off strings would flood the filter panel with unusable options.
MIN_COMMODITY_OPTION_COUNT = 2


def main() -> None:
    input_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_INPUT
    if not input_path.exists():
        sys.exit(f"FATAL: merged dataset not found at {input_path}")

    merged = json.loads(input_path.read_text())
    records = merged["records"]

    businesses = []
    excluded_low = 0
    today = date.today().isoformat()

    for rec in records:
        confidence = rec["confidence"]
        if confidence == "low":
            excluded_low += 1
            continue

        serving = rec.get("serving_railroads") or []
        commodities = rec.get("commodities") or []
        tiers = sorted({e["tier"] for e in rec.get("evidence", [])})

        note_bits = []
        for ev in rec.get("evidence", []):
            tier = ev["tier"]
            if tier == "spur_verified":
                note_bits.append("spur-verified via map data")
            elif tier == "state_rail_plan":
                page = ev.get("page_or_osm")
                note_bits.append(
                    f"listed in the state rail plan (p.{page})" if page else "listed in the state rail plan"
                )
            elif tier == "afandpa":
                note_bits.append("AF&PA member mill (association-verified)")

        businesses.append(
            {
                "company_name": rec["name"],
                "dba": "",
                "primary_commodity": commodities[0] if commodities else "",
                "commodity_subtypes": commodities[1:],
                "industry_naics": "",
                "state": rec["state"],
                "county": "",
                "city": rec.get("city") or "",
                "lat": rec.get("lat"),
                "lon": rec.get("lon"),
                "rail_served": "Y" if confidence == "high" else "reported",
                "nearest_class_i": serving[0] if serving else "",
                "serving_railroads": serving,
                "capabilities": ["rail_spur"] if "spur_verified" in tiers else [],
                "capacity_tpy": None,
                "contact_name": "",
                "contact_email": "",
                "contact_phone": "",
                "website": "",
                "source": "+".join(tiers),
                "source_confidence": confidence,
                "confidence": confidence,
                "last_verified_at": today,
                "source_note": "; ".join(note_bits),
                "id": f"rsb-{len(businesses) + 1:04d}",
            }
        )

    # Filter options
    commodity_counts = {}
    for b in businesses:
        if b["primary_commodity"]:
            commodity_counts[b["primary_commodity"]] = (
                commodity_counts.get(b["primary_commodity"], 0) + 1
            )
    commodity_options = sorted(
        c for c, n in commodity_counts.items() if n >= MIN_COMMODITY_OPTION_COUNT
    )

    rr_set = {b["nearest_class_i"] for b in businesses if b["nearest_class_i"]}
    classi_options = [r for r in CLASS_I_ORDER if r in rr_set] + sorted(
        r for r in rr_set if r not in CLASS_I_ORDER
    )

    state_options = sorted({b["state"] for b in businesses})

    out = {
        "version": merged.get("version", "railserved-merged-v1"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": (
            "Generated by scripts/build-railserved-tool-data.py from the canonical "
            "confidence-tiered merged dataset (railserved-merged-v1.json): OSM spur "
            "geometry + NARN ownership (spur_verified), state rail plans, and the "
            "AF&PA member mill list. Low-confidence named-spur records excluded."
        ),
        "commodity_options": commodity_options,
        "classi_options": classi_options,
        "state_options": state_options,
        "capability_options": ["rail_spur"],
        "businesses": businesses,
    }

    OUTPUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")

    n_high = sum(1 for b in businesses if b["confidence"] == "high")
    n_med = sum(1 for b in businesses if b["confidence"] == "medium")
    print("rail-served tool data rebuilt:")
    print(f"  input records:        {len(records)}")
    print(f"  included:             {len(businesses)}  (high={n_high}, medium/'reported'={n_med})")
    print(f"  excluded low (named_spur): {excluded_low}")
    print(f"  commodity options:    {len(commodity_options)}")
    print(f"  railroad options:     {len(classi_options)}")
    print(f"  states:               {len(state_options)}")
    print(f"  wrote {OUTPUT} ({OUTPUT.stat().st_size:,} bytes)")

    # Fabrication smoke gate: a named record that MUST land in output.
    leaf = [b for b in businesses if "Leaf River" in b["company_name"]]
    assert leaf and "OAR" in leaf[0]["serving_railroads"], "SMOKE GATE FAILED: Leaf River/OAR missing"
    print(f"  smoke gate: {leaf[0]['company_name']} present, railroads={leaf[0]['serving_railroads']} OK")


if __name__ == "__main__":
    main()
