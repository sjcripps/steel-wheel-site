# Storage Locator Data Sources

This directory contains the source data used to build the Storage Locator tool.

## Sources

1. **Norfolk Southern NSites** — 340+ facilities from NS public directory
2. **CSX TRANSFLO** — 44 major terminals from CSX transload network
3. **BNSF Directory** — 450+ facilities from BNSF public directory
4. **KCS Commtrex** — 100+ facilities via Kansas City Southern Commtrex portal

## Data Schema

- `name` — Facility name
- `city` — City
- `state` — State code (2-letter US/CA) or MX for Mexico
- `operator` — Operating railroad (Norfolk Southern, CSX, BNSF, KCS, Union Pacific, etc.)
- `lat`, `lng` — Geocoordinates for mapping
- `commodities` — Array of commodity types handled
- `capabilities` — Array of on-site rail capabilities (indoor/outdoor storage, rail connection, etc.)
- `contact` — Phone number or "Contact SWL"

## Update Frequency

Data is refreshed quarterly from carrier public directories. Last update: May 2026.

## Files

- `storage-locator.json` — Aggregated facilities (900+ records) used by the web tool
