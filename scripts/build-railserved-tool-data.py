#!/usr/bin/env python3
"""Generate tools/rail-served-businesses/data/businesses.json from the canonical
confidence-tiered merged rail-served dataset (Rail Data Foundation).

Canonical input (one dataset, faceted — directory doctrine):
  /home/ubuntu/bots/assistant/businesses/steel-wheel/data/railserved-merged-v3.json
  11,319 records {name, state, city, lat, lon, serving_railroads, commodities,
  evidence[], confidence: high|medium|low, category, in_default_view,
  serving_display?, serving_qualifier?, serving_flags?}
  (v2 fallback: railserved-merged-v2.json, 9,777 records, 36-state wave;
  v1 fallback: railserved-merged-v1.json, 2,542 records, SE-7 wave — pass
  either as argv[1] to roll back)

Mapping to the tool's existing field shape (see tools/rail-served-businesses/
index.html — the UI reads company_name, city, state, lat, lon,
primary_commodity, nearest_class_i, website + top-level commodity_options /
classi_options):
  company_name    = name
  rail_served     = 'Y' for high, 'reported' for medium, 'unverified' for low
  nearest_class_i = first serving_railroad (may be a short line; the UI label
                    was changed from "Class I" to "Railroad" to match)
  confidence      = high|medium|low (UI shows a 'reported' pill for medium and
                    an 'unverified' pill for low)

v2 display rules (must hold in the shipped artifact):
  - in_default_view: false (rail-adjacent-utility false positives) → EXCLUDED
    from the tool entirely.
  - serving_display ("freight operator unresolved (passenger-owned track)") →
    carried through; the UI renders that text in the Railroad column, never a
    bare mark (serving_railroads is empty on these by construction).
  - serving_qualifier ("plant/terminal trackage — Class I via interchange" /
    "US Government trackage") → carried through; the UI renders it next to the
    mark so the mark never shows bare.
  - serving_flags "non-freight-owner" → carried through; marks already cleared
    upstream, UI renders the flag text.
  - XXXX/XMDT sentinel and passenger-owner marks are stripped upstream; this
    builder asserts none survive.

Usage: python3 scripts/build-railserved-tool-data.py [path-to-merged-json]
"""

import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# v2 fallback: .../railserved-merged-v2.json (36-state wave, 9,777 records)
# v1 fallback: .../railserved-merged-v1.json (SE-7 wave, 2,542 records)
DEFAULT_INPUT = Path(
    # SOURCE WAS STALE: this said v3 while the LIVE pages were built from v4.
# Rebuilding with the old constant silently dropped 548 records.
"/home/ubuntu/bots/assistant/businesses/steel-wheel/data/railserved-merged-v4.json"
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
    excluded_default_view = 0
    today = date.today().isoformat()

    # Marks that must never ship: XXXX/XMDT sentinels + passenger owners
    # (stripped upstream in the v2/v3 merges; asserted here as a tripwire).
    # v3 additions (western-state passenger/transit/heritage owners):
    # DRTD, RTDC, TRAX, NMRX, NNRX, NSRM.
    # FOURTH copy of this list, and like the other three it was missing SEPA.
    # The pages were fixed on 2026-08-19 while this tool kept serving SEPA 17,
    # IRYM 40, LDL 37, BOTH 5 and LIRR 3 — same defect, different surface, so
    # the fix did not actually reach every place a customer sees it. Merge the
    # shared file; the literal set stays as the floor.
    BANNED_MARKS = {
        "XXXX", "XMDT", "LI", "NJT", "SCAX", "NIRC", "NICD", "VPRA", "MNCW",
        "PATH", "MARC", "MBTA", "SDNR", "JPBX", "SMRT", "MTS",
        "DRTD", "RTDC", "TRAX", "NMRX", "NNRX", "NSRM",
    }
    _excl_file = Path("/home/ubuntu/bots/assistant/businesses/steel-wheel"
                      "/data/reference/excluded-marks.json")
    try:
        _excl = json.loads(_excl_file.read_text())
        for _sec in ("sentinel", "passenger", "non_freight"):
            BANNED_MARKS |= {k for k in (_excl.get(_sec) or {})
                             if k and not k.startswith("_")}
        print(f"  excluded-marks.json merged: {len(BANNED_MARKS)} banned marks")
    except (OSError, ValueError) as _e:
        print(f"  WARNING: {_excl_file} unusable ({_e}); built-in list only")

    for rec in records:
        confidence = rec["confidence"]
        # v2: rail-adjacent-utility false positives are out of the default view
        # and therefore out of the customer-facing tool entirely.
        if rec.get("in_default_view", True) is False:
            excluded_default_view += 1
            continue

        serving = rec.get("serving_railroads") or []
        banned = BANNED_MARKS.intersection(serving)
        assert not banned, f"BANNED MARK {banned} on {rec['name']} ({rec['state']})"
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
            elif tier == "named_spur":
                note_bits.append("named spur in map data (unverified)")

        if confidence == "high":
            rail_served = "Y"
        elif confidence == "medium":
            rail_served = "reported"
        else:
            rail_served = "unverified"

        # v2 serving-display fields, carried through only when present so the
        # UI can render qualifier text instead of (or alongside) a bare mark.
        extra = {}
        if rec.get("serving_display"):
            extra["serving_display"] = rec["serving_display"]
        if rec.get("serving_qualifier"):
            extra["serving_qualifier"] = rec["serving_qualifier"]
        if rec.get("serving_flags"):
            extra["serving_flags"] = rec["serving_flags"]

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
                "rail_served": rail_served,
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
                **extra,
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
        "version": merged.get("version", "railserved-merged-v3"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": (
            "Generated by scripts/build-railserved-tool-data.py from the canonical "
            "confidence-tiered merged dataset (railserved-merged-v3.json): OSM spur "
            "geometry + NARN ownership (spur_verified), OSM named spurs (named_spur, "
            "unverified), state rail plans, and the AF&PA member mill list. "
            "Rail-adjacent-utility false positives (in_default_view: false) excluded."
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
    n_low = sum(1 for b in businesses if b["confidence"] == "low")
    print("rail-served tool data rebuilt:")
    print(f"  input records:        {len(records)}")
    print(f"  included:             {len(businesses)}  (high={n_high}, medium/'reported'={n_med}, low/'unverified'={n_low})")
    print(f"  excluded (in_default_view=false): {excluded_default_view}")
    print(f"  commodity options:    {len(commodity_options)}")
    print(f"  railroad options:     {len(classi_options)}")
    print(f"  states:               {len(state_options)}")
    print(f"  wrote {OUTPUT} ({OUTPUT.stat().st_size:,} bytes)")

    # Default-view count gate: included must equal the dataset's declared count.
    declared = (merged.get("counts") or {}).get("default_view")
    if declared is not None:
        assert len(businesses) == declared, (
            f"GATE FAILED: included {len(businesses)} != counts.default_view {declared}"
        )
        print(f"  default-view gate: {len(businesses)} == counts.default_view OK")

    # Fabrication smoke gates: named records that MUST land in output.
    leaf = [b for b in businesses if "Leaf River" in b["company_name"]]
    assert leaf and "OAR" in leaf[0]["serving_railroads"], "SMOKE GATE FAILED: Leaf River/OAR missing"
    print(f"  smoke gate: {leaf[0]['company_name']} present, railroads={leaf[0]['serving_railroads']} OK")
    nucor = [b for b in businesses if b["company_name"] == "Nucor Steel Berkeley" and b["state"] == "SC"]
    assert nucor and "PR" in nucor[0]["serving_railroads"], "SMOKE GATE FAILED: Nucor Steel Berkeley/PR missing"
    print(f"  smoke gate: {nucor[0]['company_name']} (SC) present, railroads={nucor[0]['serving_railroads']} OK")
    # v3 smoke gate: a western-wave record that MUST land (proves NM shipped).
    intrepid = [
        b for b in businesses
        if b["company_name"].startswith("Intrepid Potash") and b["state"] == "NM"
    ]
    assert intrepid and "BNSF" in intrepid[0]["serving_railroads"], (
        "SMOKE GATE FAILED: Intrepid Potash (NM)/BNSF missing"
    )
    print(f"  smoke gate: {intrepid[0]['company_name']} (NM) present, railroads={intrepid[0]['serving_railroads']} OK")


if __name__ == "__main__":
    main()
