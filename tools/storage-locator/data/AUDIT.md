# Storage-yard dataset audit — 2026-09-24

Main file `storage-yards.json`/`.csv`: **400 yards** (capped at 400 per task brief). Overflow `storage-yards-full.json`: **876 records** (main + 476 lower-ranked, same schema). Every record has `source_url` and `verified_at=2026-09-24`; no field was invented — null means the source did not state it.

## Counts by source

| source | main | all |
|---|---|---|
| csx_shortline_directory_2025 | 93 | 93 |
| commtrex | 205 | 681 |
| operator_page | 102 | 102 |

## Counts by state/province (main / all)

TX: 23/110, PA: 12/50, IN: 42/48, OH: 14/44, IL: 37/43, GA: 28/35, AL: 28/31, NY: 12/27, WA: 4/25, MI: 23/23, MS: 18/23, NC: 12/23, TN: 10/23, OK: 4/22, KS: 17/20, MN: 13/20, LA: 18/19, CO: 2/18, NE: 2/17, CA: 2/15, AR: 8/14, FL: 14/14, VA: 2/14, WV: 4/13, OR: 0/13, MO: 8/12, ON: 0/12, NJ: 5/11, IA: 7/10, KY: 9/10, SC: 4/10, WI: 0/9, NM: 1/8, SK: 2/8, AZ: 1/7, ID: 0/7, SD: 0/7, MA: 3/6, MB: 1/6, MT: 1/6, UT: 3/6, ND: 0/6, CT: 2/4, AB: 0/4, QC: 0/4, WY: 0/4, MD: 1/3, NV: 1/3, VT: 1/2, DE: 0/2, RI: 1/1, BC: 0/1, ME: 0/1, NS: 0/1, TAMPS: 0/1

## Field coverage

| field | main (n=400) | all (n=876) |
|---|---|---|
| capacity_cars | 345 (86%) | 771 (88%) |
| phone or email | 375 (94%) | 721 (82%) |
| phone | 373 (93%) | 719 (82%) |
| lat/lng | 300 (75%) | 776 (89%) |
| city | 300 (75%) | 776 (89%) |
| railroads_served | 368 (92%) | 844 (96%) |
| hazmat stated | 347 (87%) | 823 (94%) |
| tih stated | 146 (36%) | 173 (20%) |
| services | 307 (77%) | 500 (57%) |
| website | 274 (68%) | 594 (68%) |

## How records were built

1. **Commtrex** — `commtrex.com/storage` is a Next.js shell; the page's own public JSON API (`commtrex-api-…run.app/api/v1/storage/locations`, no auth) was paginated (734 listings) and every `/storage/locations/{id}` detail fetched at 1 req/s. Fields taken as-is: name, company, city, state, lat/lng (Commtrex's own coordinates, `geocode_precision="source"`), total_capacity, hazmat flag, phone, website, notes, services, street address. `source_url` is the public page `https://www.commtrex.com/railcar-storage/location/{id}` (308-redirects to the slug URL). Only 31 listings carry Commtrex's own "verified" badge — those are flagged in `notes`.
2. **CSX 2025 Short Line Car Storage Directory** — csx.com serves a Cloudflare JS challenge to curl *and* headless Chromium (403 "Just a moment…"). Parsed instead from the Wayback Machine capture of the same URL (2025-06-11, PDF dated 2025-03-27, 5 pages, 170 rows) with `pdftotext -layout`; all 170 email-bearing rows parsed (3 needed regex fixes: `L&C`, the SCAC-less Marion Industrial Rail Park row, and the two-SCAC IERR/OSCR row). Rows are **railroad-level** (short line, holding company, contact, e-mail, phone, max car spots, hazmat loads/residue, TIH/PIH loads/residue, restrictions) — no city, so `lat/lng` are null. Brave's index shows the live page now advertises an "as of September 11, 2025" revision that is not archived; the March 2025 rows are what is here.
3. **Operator pages** — 102 hand-entered records from operator/short-line pages (Patriot Rail table of 30 railroads with location + Class I interchange; R. J. Corman sites table with per-site spot counts; USA Rail Terminals' four terminal pages; MSE, TGS Cedar Port, 225 Rail, Rail Logix, TNW/TXNW, EACH, Gadsden, Riverport, Madison, St. Marys, SMW, Rail Enterprise Group, V&S/Affiliated, Pinsly, Transtar, NOGC, and others). Capacity/phone/contact only when printed on the cited page; `notes` says where a city was inferred (e.g. Mission Rail Park geocoded to San Antonio, "30 minutes from downtown").

## Dedup / merge rules

* **Exact dedup key** = normalized name + normalized city + state (lower-case, punctuation stripped, stop-words like railroad/railway/co/inc/llc removed). Duplicates merged, later source's non-null fields fill nulls, and the merged-away `source_url` is appended to `notes`.
* **CSX directory rows vs. yards**: a CSX row is matched to existing yards by exact normalized operator/name equality (or a ≥3-token subset) within the same state. If exactly **one** yard matched, the CSX row was merged into it (fills capacity/contact/hazmat/TIH if null; CSX URL + row data appended to `notes`) — 77 merges. If two or more yards matched (a railroad with several Commtrex yards), the CSX row was **kept as a separate railroad-level record** and its contact/URL appended to each yard's `notes` — this avoids applying a system-wide spot count to one yard. Unmatched rows kept as-is. Result: 93 of 170 CSX rows are standalone records.
* Ranking for the 400 cap: operator-page > CSX-directory > Commtrex; then Commtrex-verified, has capacity, has contact, SWL focus states (Southeast/Gulf/Midwest), has city, has coords. Ties by state/name. Nothing was dropped — the remainder is in `storage-yards-full.json`.

## Geocoding

Nominatim (`nominatim.openstreetmap.org`, UA `SteelWheelLogistics-research/1.0`, 1 req/s, cached) at **city + state** level only for records that had a city but no coordinates. `geocode_precision` records which: `source` (Commtrex-supplied point) vs `city` (Nominatim centroid) vs null (no city — never geocoded; state-only records are not plotted).

## What could NOT be obtained, and why

* **CSX live page (Sept 2025 revision)** — Cloudflare bot challenge blocks curl and headless Chromium; only the March 2025 PDF is archived. Re-fetch manually from a browser and re-run `parse_csx.py` to refresh.
* **Viper Rail Car Storage** — site shows a "Confirm you are human" wall to curl (429) and headless Chromium (403). Its Wayback copy of `/locations/` is region-level only (7 regions, no yard names): Viper is a broker network, so no per-yard records. Not included.
* **Watco GeoConnect** — an ArcGIS web map; the feature layers (`services6.arcgis.com/757QLSA7X6Cs1sWk/...System_Map_WFL2`) return `499 Token Required`. Watco lines that connect to CSX are covered by the CSX directory rows (Ann Arbor, Birmingham Terminal, DREI, JXPT, SVHO, ABS…); no other Watco yards.
* **G&W** — `gwrr.com/railcar-storage/` has no yard list (single contact, Michael Yuen 971-701-3840); G&W railroads appear via CSX directory rows (contact Kevin Phillips) and Commtrex.
* **OmniTRAX / Jaguar / Regional Rail / MB Rail / RTEX / CRMS / PFL** — pages list services or railroad names only, no yard-level data; covered where they appear in the CSX directory or Commtrex. Brokers (RTEX, CRMS, PFL, Viper) excluded by design.
* **Iowa Interstate** `iaisrr.com/storage/` — listings are a JS "Compare Listings" widget that rendered empty; IAIS is present via the CSX row (1,554 spots). **Iowa Northern** page rendered empty; **Cathcart Rail**, **FGA (fgarr.com)**, **Contrack (Hattiesburg MS)** — DNS/TLS failures and no Wayback copy. **Progress Rail** storage page 404. **Iowa Pacific** domain is now a spam site. **Gulf Coast Rail Gateway (clrail.com)** is a proposed/undeveloped site — excluded.

* **Commtrex detail pages — PARTIAL**: the list endpoint (734/734 listings: name, company, city, state, lat/lng, capacity, hazmat, phone, website) is complete, but the per-location detail fetch (street address, notes, services list) was cut off at the coordinator's request after **601 of 734**. Records without a detail fetch simply lack `street:` / free-text `notes` / `services`; nothing else is affected. Re-running `commtrex_pull.py` resumes from the saved cache.
* **Per-yard capacity for Rail Logix, Pinsly, Patriot, W&LE, Buckingham Branch** — pages give network totals or none; recorded in `notes`, `capacity_cars` left null.

## Random spot-check sample (10 rows from the main file, seed 20260924)

* **SY0008 Pegasus National, Inc. Universal Railway, Inc.** — Birmingham, AL; operator Universal Railway Terminal; capacity 160; hazmat True; phone (205) 907-8007; source `commtrex` → https://www.commtrex.com/railcar-storage/location/119
* **SY0339 Union Railroad (URR) railcar storage** — (no city), PA; operator Union Railroad; capacity 900; hazmat True; phone 412 584-6169; source `csx_shortline_directory_2025` → https://www.csx.com/index.cfm/customers/short-line-and-partner-railroads/short-line-railcar-storage-locations/
* **SY0280 Clarksdale MS** — Swan Lake, MS; operator American Services, LLC; capacity 5000; hazmat True; phone 901-833-0414; source `commtrex` → https://www.commtrex.com/railcar-storage/location/767
* **SY0324 Burning River Railyard** — Kent, OH; operator Burning River Railyard; capacity None; hazmat None; phone (330) 877-9982; source `operator_page` → https://burningriverrail.com/
* **SY0360 West Tennessee Railroad (WTNN) railcar storage** — (no city), TN; operator West Tennessee Railroad; capacity 400; hazmat True; phone 732 842-0912; source `csx_shortline_directory_2025` → https://www.csx.com/index.cfm/customers/short-line-and-partner-railroads/short-line-railcar-storage-locations/
* **SY0075 Georgia Northeastern Railroad (GNRR) railcar storage** — Marietta, GA; operator Georgia Northeastern Railroad; capacity None; hazmat True; phone (904) 626-7880; source `operator_page` → https://patriotrail.com/services/railcar-storage/
* **SY0287 RJ Corman Southern (RJCS) railcar storage** — (no city), NC; operator RJ Corman Southern; capacity 250; hazmat True; phone 859 314-0891; source `csx_shortline_directory_2025` → https://www.csx.com/index.cfm/customers/short-line-and-partner-railroads/short-line-railcar-storage-locations/
* **SY0292 Kinston Railroad, LLC** — Cove City, NC; operator Jaguar Transport Holdings, LLC; capacity 300; hazmat True; phone 920-209-0118; source `commtrex` → https://www.commtrex.com/railcar-storage/location/778
* **SY0373 TXGN Railway railcar storage** — Gonzales, TX; operator TXGN Railway; capacity None; hazmat None; phone 877-813-9838; source `operator_page` → https://www.tnwcorporation.com/
* **SY0030 DeQueen & Eastern Railroad (DQE) railcar storage** — DeQueen, AR; operator DeQueen & Eastern Railroad; capacity None; hazmat True; phone (904) 626-7880; source `operator_page` → https://patriotrail.com/services/railcar-storage/

## Files

* `storage-yards.json` — `{version:2, generated_at, sources[], yards[]}` (400 rows)
* `storage-yards.csv` — same rows, lists joined with `; `
* `storage-yards-full.json` — all records including overflow
* `AUDIT.md` — this file

Rebuild scripts lived in the session scratchpad (`commtrex_pull.py`, `parse_csx.py`, `operator_records.py`, `build.py`, `audit.py`); they are not committed to the repo per the task's write-scope.