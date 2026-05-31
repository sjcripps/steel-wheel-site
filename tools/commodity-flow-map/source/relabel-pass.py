#!/usr/bin/env python3
"""
Provenance upgrade pass — relabel SOME industry_knowledge_* commodity-hub
records in-place, ONLY where a real public-source scrape was successfully
saved to disk under tools/commodity-flow-map/source/scraped/ and the
record's identity (city/state/commodity) cross-matches the scraped content.

This script is idempotent: running it twice produces the same output. It only
flips records that are currently labeled `industry_knowledge_*`. It never
touches `commodity_flow_map` (original 29) or already-upgraded records.

Sources used (all confirmed 200 OK + parseable + cross-matched):
  - aapa_member_archive    -> AAPA press-release archive (PRMemberList.aspx)
                              confirms member ports by name + state.
  - usgs_mcs_iron_ore      -> USGS Mineral Commodity Summaries 2025 — iron ore
                              chapter, confirms Minnesota as one of three
                              iron-ore-producing states (98% of US output).

Sources tried but discarded honestly:
  - EIA Coal Annual Tables 1/2/6/9 (200 OK, parsed) — DID confirm top US coal
    mines, but Powder River Basin and Appalachian Coal Country are in the
    untouchable original-29 set. None of the 37 candidate records are
    coal-mine origins, so EIA tables don't drive any upgrade in this pass.
    Files retained on disk for future-pass audit / expansion-pass use.
  - USDA AMS grain inspection — 503 Akamai-blocked on every variant tried.
    Grain-terminal candidates (Wichita, Sioux Falls, Twin Cities, Spokane,
    Topeka) stay industry_knowledge_grain_terminals + low.
  - AISI — known-blocked, skipped per spec.
  - USGS MYB iron ore (richer than MCS) — 403 on S3 endpoints.

Usage:
    python3 relabel-pass.py
"""
import json
import sys
from pathlib import Path

ROOT = Path("/home/ubuntu/projects/steel-wheel-site")
BUSINESSES = ROOT / "tools/rail-served-businesses/data/businesses.json"
SCRAPED = ROOT / "tools/commodity-flow-map/source/scraped"

# Each entry maps a company_name (exact match in businesses.json) to the
# real-source upgrade payload. We never invent a scraped_url — every URL
# below corresponds to a file actually saved under SCRAPED/.
UPGRADES = [
    {
        "company_name": "Toledo (Lake Erie Coal & Iron Ore Port)",
        "scraped_file": "aapa-press-release-archive.html",
        "scraped_url": "http://www.ports.org/unifying/PRMemberList.aspx?navItemNumber=20784",
        "new_source": "aapa_member_archive",
        "new_confidence": "medium",
        "match_evidence": (
            "AAPA member-press-release archive (PRMemberList.aspx) returns 200 OK "
            "and lists 'Toledo-Lucas County Port Authority Celebrates 60th "
            "Anniversary' — confirms Toledo-Lucas County Port Authority is "
            "an AAPA member, matching the hub's port category and Lake Erie "
            "geographic identity."
        ),
    },
    {
        "company_name": "Duluth-Superior (Great Lakes Port — Iron Ore & Grain)",
        "scraped_file": "aapa-press-release-archive.html",
        "scraped_url": "http://www.ports.org/unifying/PRMemberList.aspx?navItemNumber=20784",
        "new_source": "aapa_member_archive",
        "new_confidence": "medium",
        "match_evidence": (
            "AAPA member-press-release archive returns 200 OK with 13+ "
            "'Duluth, Minnesota' references including 'Port of "
            "Duluth-Superior' branded items — confirms AAPA member status "
            "for the Duluth-Superior port complex."
        ),
    },
    {
        "company_name": "Mesabi Range (US Iron Ore Origin)",
        "scraped_file": "usgs-mcs2025-iron-ore.pdf",
        "scraped_url": "https://pubs.usgs.gov/periodicals/mcs2025/mcs2025-iron-ore.pdf",
        "new_source": "usgs_mcs_iron_ore",
        "new_confidence": "medium",
        "match_evidence": (
            "USGS Mineral Commodity Summaries 2025 — Iron Ore chapter "
            "(scraped 200 OK, 697KB PDF) states: 'eight open pit iron ore "
            "mines in Michigan, Minnesota, and Utah shipped 98% of "
            "domestic usable iron ore products'. Mesabi Range is the "
            "Minnesota iron-ore producing region — Hibbing Taconite, "
            "Minntac, United Taconite, Northshore are in this range. The "
            "USGS source confirms state-level iron-ore origin identity; "
            "the specific mine names within the Mesabi Range come from "
            "industry knowledge, not the USGS PDF text."
        ),
    },
]


def main():
    # Validate every upgrade's scraped_file actually exists on disk before
    # touching businesses.json — refuse to label as scraped if the file is
    # missing.
    missing = []
    for u in UPGRADES:
        path = SCRAPED / u["scraped_file"]
        if not path.is_file() or path.stat().st_size == 0:
            missing.append(u["scraped_file"])
    if missing:
        sys.exit(f"FATAL: scraped files missing — refusing to label as scraped: {missing}")

    with open(BUSINESSES) as f:
        data = json.load(f)
    rows = data["businesses"]

    by_name = {r["company_name"]: r for r in rows}

    # Pre-pass invariants
    pre_total_hubs = sum(1 for r in rows if r.get("is_commodity_hub"))
    pre_cfm = sum(1 for r in rows if r.get("is_commodity_hub") and r.get("source") == "commodity_flow_map")
    pre_ik = sum(1 for r in rows if r.get("is_commodity_hub") and (r.get("source") or "").startswith("industry_knowledge_"))
    print(f"BEFORE: hubs={pre_total_hubs}, commodity_flow_map={pre_cfm}, industry_knowledge_*={pre_ik}")

    upgraded = []
    for u in UPGRADES:
        rec = by_name.get(u["company_name"])
        if rec is None:
            sys.exit(f"FATAL: target record not found: {u['company_name']!r}")
        cur_source = rec.get("source", "")
        if not cur_source.startswith("industry_knowledge_"):
            # Already upgraded or never was a candidate — skip silently for idempotency.
            print(f"  [skip] {u['company_name']!r} already source={cur_source}")
            continue
        if not rec.get("is_commodity_hub"):
            sys.exit(f"FATAL: target record is not is_commodity_hub: {u['company_name']!r}")

        old_source = rec["source"]
        old_note = rec.get("source_note", "")

        rec["source"] = u["new_source"]
        rec["source_confidence"] = u["new_confidence"]
        rec["scraped_url"] = u["scraped_url"]
        rec["source_note"] = u["match_evidence"]
        # Keep last_verified_at fresh so audit trail is honest.
        rec["last_verified_at"] = "2026-05-07"

        upgraded.append({
            "id": rec["id"],
            "company_name": rec["company_name"],
            "from": old_source,
            "to": u["new_source"],
            "scraped_url": u["scraped_url"],
        })

    # Post-pass invariants
    post_total_hubs = sum(1 for r in rows if r.get("is_commodity_hub"))
    post_cfm = sum(1 for r in rows if r.get("is_commodity_hub") and r.get("source") == "commodity_flow_map")
    post_ik = sum(1 for r in rows if r.get("is_commodity_hub") and (r.get("source") or "").startswith("industry_knowledge_"))

    if post_total_hubs != pre_total_hubs:
        sys.exit(f"FATAL: hub count drifted {pre_total_hubs} -> {post_total_hubs}")
    if post_cfm != pre_cfm:
        sys.exit(f"FATAL: commodity_flow_map count drifted {pre_cfm} -> {post_cfm}")
    if post_ik != pre_ik - len(upgraded):
        sys.exit(f"FATAL: industry_knowledge_* count drifted unexpectedly {pre_ik} -> {post_ik} (expected {pre_ik - len(upgraded)})")

    print(f"AFTER:  hubs={post_total_hubs}, commodity_flow_map={post_cfm}, industry_knowledge_*={post_ik}")
    print(f"Upgraded {len(upgraded)} records:")
    for u in upgraded:
        print(f"  [{u['id']}] {u['company_name']!r}: {u['from']} -> {u['to']}")
        print(f"           scraped_url: {u['scraped_url']}")

    # Write back atomically.
    tmp = BUSINESSES.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    tmp.replace(BUSINESSES)
    print(f"Wrote {BUSINESSES}")


if __name__ == "__main__":
    main()
