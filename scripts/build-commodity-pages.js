#!/usr/bin/env bun
/**
 * Commodity + rail-hub page generator — the crawlable layer for the
 * commodity-flow map.
 *
 * WHY: /tools/commodity-flow-map is one client-rendered page — 66 hubs in a
 * JSON file Google never sees. Same disease the transload directory had before
 * build-transload-pages.js. This generates:
 *   - /commodities/index.html          hub page, links every commodity
 *   - /commodities/{slug}.html         one per commodity (~24)
 *   - /rail-hubs/{slug}.html           one per map hub (66)
 *   - commodities/pages.json           read by api/sitemap.ts (same pattern as
 *                                      transload/pages.json)
 *
 * Page content answers the query families autocomplete + our own GSC proved
 * people actually type (2026-08-14 research, brain.md):
 *   "how many tons of X in a railcar" / "what railcar does X use" /
 *   "bulk density of X" / "is X shipped by rail" / "rail vs truck".
 * Bare commodity heads (soda ash = pools, barite = crystals) are consumer-owned
 * — every page here targets the commodity x LOGISTICS intersection only.
 *
 * BRAND RULES (see build-transload-pages.js): the words intermodal / container
 * / drayage NEVER appear — negative keywords for this brand. Map data contains
 * "intermodal" in 27 hubs, so emitted text passes through deIntermodal().
 * Numbers are TYPICAL ranges, labelled as such; never a promise. No transit
 * times. Estimator links say indicative, never binding.
 *
 * Usage: bun run scripts/build-commodity-pages.js
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { statsForCommodity } from "./lib-plan-flows.js";
import { siteHeader } from "./lib/site-nav.js";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const BASE = "https://steelwheellogistics.com";
const HUBS = JSON.parse(
  readFileSync(join(ROOT, "tools", "commodity-flow-map", "data", "hubs.json"), "utf-8")
).hubs;

/* ------------------------------------------------------------------ *
 * Commodity dataset. Figures are standard AAR/industry practice —
 * typical net loads for 263k/286k GRL cars, engineering-handbook bulk
 * densities. Ranges, not guarantees.
 * ------------------------------------------------------------------ */
const COMMODITIES = [
  {
    slug: "corn", name: "Corn", stcc: "01132", est: "grain",
    cars: "Covered hopper (4,750–5,200 cu ft)", tons: "100–110",
    density: "44–46", constraint: "weight",
    what: "The highest-volume grain on North American rails. Feed corn moves from the Corn Belt to feedlots, ethanol plants, and Gulf/PNW export elevators.",
    uses: "Animal feed, ethanol production, corn syrup and starch milling, export.",
    moves: "Shuttle and unit trains of 75–110 cars dominate the export and ethanol lanes; single cars and 5–25 car blocks serve feed mills off short lines. Peak movement follows harvest (Oct–Dec).",
    hubkey: "grain",
  },
  {
    slug: "wheat", name: "Wheat", stcc: "01137", est: "grain",
    cars: "Covered hopper (4,750–5,200 cu ft)", tons: "100–112",
    density: "48–50", constraint: "weight",
    what: "Hard red winter and spring wheat move off the Plains to flour mills and export terminals — some of the longest grain hauls on the network.",
    uses: "Flour milling, export, animal feed (off-grade).",
    moves: "Shuttle trains to the Gulf and PNW; single-car and small blocks to inland flour mills. Kansas, Oklahoma and the Dakotas originate most tonnage.",
    hubkey: "grain",
  },
  {
    slug: "soybeans", name: "Soybeans", stcc: "01144", est: "grain",
    cars: "Covered hopper (4,750–5,200 cu ft)", tons: "100–110",
    density: "46–48", constraint: "weight",
    what: "The premier export grain. Soybeans move in dense harvest surges from the Midwest to Gulf and Pacific Northwest export elevators and to domestic crush plants.",
    uses: "Crushing into soybean meal and oil, direct export, food products.",
    moves: "Heavily unit-train and shuttle; the PNW export lane is one of the busiest grain corridors in the world Oct–Feb.",
    hubkey: "grain",
  },
  {
    slug: "ddgs", name: "DDGS (Distillers Dried Grains)", stcc: "20421", est: "ddgs",
    cars: "Covered hopper (5,200+ cu ft)", tons: "95–105",
    density: "28–34", constraint: "cube",
    what: "The co-product of ethanol production — what's left of the corn after fermentation. A protein feed that moves from ethanol plants to feedlots, dairies and export.",
    uses: "Cattle, dairy, poultry and swine feed rations; export (Mexico is the largest buyer).",
    moves: "Lighter than whole grain, so it wants the larger-cube hopper. Steady year-round flow from Corn Belt ethanol plants; Mexico-bound unit trains are common.",
    hubkey: "grain",
  },
  {
    slug: "soybean-meal", name: "Soybean Meal", stcc: "20923", est: "ddgs",
    cars: "Covered hopper (5,200+ cu ft)", tons: "95–105",
    density: "38–42", constraint: "balanced",
    what: "The protein half of the soybean crush, moving from Midwest crush plants to feed mills and export terminals.",
    uses: "Poultry, swine, dairy and aquaculture feed — the backbone protein of animal rations.",
    moves: "Single cars and blocks to feed mills; unit trains to export. New crush capacity built for renewable diesel has added meal tonnage across the network.",
    hubkey: "grain",
  },
  {
    slug: "fertilizer", name: "Dry Fertilizer (Urea, DAP, MAP)", stcc: "28712", est: "fertilizer",
    cars: "Covered hopper (3,000–4,750 cu ft)", tons: "100–110",
    density: "45–62", constraint: "weight",
    what: "Urea, DAP and MAP move from Gulf import terminals and domestic plants to inland distribution warehouses ahead of planting seasons.",
    uses: "Row-crop nutrition — nitrogen (urea) and phosphate (DAP/MAP) applications.",
    moves: "Strongly seasonal: heavy flows Jan–Apr and a fall run. Import tonnage rails north from New Orleans-area terminals; potash rails south from Saskatchewan.",
    hubkey: "chemicals",
  },
  {
    slug: "potash", name: "Potash", stcc: "14713", est: "fertilizer",
    cars: "Covered hopper (3,000–3,500 cu ft, small cube)", tons: "100–112",
    density: "64–72", constraint: "weight",
    what: "Canada is the world's largest potash producer, and nearly all of it starts on rail in Saskatchewan — dense pink granules that fill barely a third of a grain car's cube before hitting the weight limit.",
    uses: "Potassium fertilizer for row crops; industrial potassium compounds.",
    moves: "Unit trains from Saskatchewan mines to US corn-belt warehouses and to Vancouver/Portland export terminals. One of CPKC's and CN's anchor franchises.",
    hubkey: "chemicals",
  },
  {
    slug: "cement", name: "Cement", stcc: "32411", est: "cement",
    cars: "Pressure-differential covered hopper (small cube)", tons: "100–115",
    density: "75–95", constraint: "weight",
    what: "Portland cement moves as a fine, dense, dry powder from kilns to distribution terminals — it cannot get wet and will not gravity-flow, so it rides in sealed pressure-differential cars unloaded pneumatically.",
    uses: "Ready-mix concrete, precast, construction.",
    moves: "Short-to-medium hauls from plants to metro terminals; construction-season peaks. Imports add flows inland from port terminals.",
    hubkey: "chemicals",
  },
  {
    slug: "frac-sand", name: "Frac Sand", stcc: "14413", est: "sand-frac",
    cars: "Covered hopper (3,000–3,250 cu ft, small cube)", tons: "100–112",
    density: "95–105", constraint: "weight",
    what: "Northern White sand from Wisconsin/Minnesota rails to oil and gas basins — so dense it uses the smallest-cube covered hoppers on the network.",
    uses: "Proppant for hydraulic fracturing in shale oil and gas wells.",
    moves: "Unit trains to basin terminals in Texas, New Mexico and the Bakken; volume tracks drilling activity closely. In-basin local sand has taken share, making rail lanes longer but fewer.",
    hubkey: "chemicals",
  },
  {
    slug: "aggregates", name: "Aggregates & Crushed Stone", stcc: "14212", est: "aggregates",
    cars: "Open-top hopper or gondola", tons: "100–115",
    density: "90–105", constraint: "weight",
    what: "Crushed stone, gravel and construction sand — the heaviest, cheapest tonnage on rail. It only moves where a quarry, a market and a rail line happen to align.",
    uses: "Road base, concrete and asphalt aggregate, ballast, riprap.",
    moves: "Short-haul unit trains from quarry to metro distribution yards; Texas and the Gulf coast host the classic lanes. Freight cost dominates delivered price, so lanes are ruthlessly economic.",
    hubkey: "aggregates",
  },
  {
    slug: "coal", name: "Coal", stcc: "11212", est: "coal",
    cars: "Open-top hopper or rotary-dump gondola", tons: "110–121",
    density: "45–55", constraint: "weight",
    what: "Still one of the largest single commodities on US rails. Powder River Basin thermal coal and Appalachian met coal move in dedicated unit trains from mine to plant or port.",
    uses: "Electric generation (thermal), steelmaking coke (metallurgical), export.",
    moves: "100–150 car unit trains in captive cycles; rotary couplers let gondolas dump without uncoupling. Met coal rails east to Baltimore/Hampton Roads for export.",
    hubkey: "coal",
  },
  {
    slug: "iron-ore", name: "Iron Ore", stcc: "10112", est: "iron-ore",
    cars: "Ore cars (short) or open-top hopper", tons: "95–110",
    density: "130–150", constraint: "weight",
    what: "Taconite pellets from Minnesota's Iron Range — so dense that purpose-built ore cars are barely half the length of a grain hopper and still hit the axle limit.",
    uses: "Blast-furnace and DRI steelmaking.",
    moves: "Captive unit trains from the Mesabi Range to Great Lakes ore docks, then lakers to lower-lakes steel mills; some all-rail moves to mills.",
    hubkey: "iron_ore",
  },
  {
    slug: "steel", name: "Steel (Coils, Plate, Bar)", stcc: "33122", est: "steel",
    cars: "Coil car, gondola, bulkhead flat", tons: "90–100",
    density: "—", constraint: "weight",
    what: "Finished and semi-finished steel — coils ride in purpose-built covered coil cars, plate and structural in gondolas and flats.",
    uses: "Automotive, construction, appliances, pipe and tube, service centers.",
    moves: "Mill-to-service-center and mill-to-stamper lanes around the Great Lakes, the Southeast's new EAF capacity, and cross-border Mexico flows.",
    hubkey: "steel",
  },
  {
    slug: "scrap-metal", name: "Scrap Metal", stcc: "40211", est: "scrap-metal",
    cars: "Gondola (mill gon)", tons: "80–100",
    density: "20–70 (shredded vs. bales)", constraint: "varies",
    what: "Ferrous scrap flows from shredders and dealers to electric-arc furnace mills — the feedstock for most new US steel.",
    uses: "EAF steelmaking; foundry melt.",
    moves: "Single cars and small blocks on repeating dealer-to-mill lanes; density swings widely with grade, so loads range from cube-limited shredded to weight-limited busheling.",
    hubkey: "steel",
  },
  {
    slug: "lumber", name: "Lumber & Wood Products", stcc: "24211", est: "lumber",
    cars: "Centerbeam flat (73 ft)", tons: "75–95",
    density: "—", constraint: "cube",
    what: "Dimensional lumber, panels and engineered wood ride centerbeam flats from Canadian and Southern mills to distribution yards near housing markets.",
    uses: "Homebuilding, remodeling, industrial packaging.",
    moves: "BC and Alberta mills feed the US Midwest and Northeast; Southern Yellow Pine serves the Southeast. Volume tracks housing starts. Loads are strapped in wrapped packages either side of the center beam.",
    hubkey: "forest_products",
  },
  {
    slug: "paper", name: "Paper & Pulp", stcc: "26211", est: "paper",
    cars: "High-cube boxcar (60 ft, cushioned)", tons: "70–90",
    density: "—", constraint: "cube",
    what: "Rolls of containerboard, printing paper and market pulp move in clean, cushioned high-cube boxcars from Southern and Canadian mills.",
    uses: "Corrugated boxes, tissue, printing, export pulp.",
    moves: "Mill-to-converter lanes across the Southeast and cross-border from Eastern Canada; the boxcar fleet serving this traffic is aging, which keeps car supply tight.",
    hubkey: "forest_products",
  },
  {
    slug: "plastic-pellets", name: "Plastic Pellets (Resin)", stcc: "28211", est: "plastic",
    cars: "Jumbo covered hopper (6,000+ cu ft)", tons: "85–95",
    density: "32–38", constraint: "cube",
    what: "Polyethylene and polypropylene pellets from Gulf Coast crackers — light, free-flowing, and shipped in the biggest covered hoppers on the railroad.",
    uses: "Injection molding, film, pipe, packaging — the feedstock of the plastics industry.",
    moves: "Gulf Coast petrochemical belt to converters nationwide; cars stage in massive storage-in-transit yards near Houston. Export resin transloads to the ports.",
    hubkey: "chemicals",
  },
  {
    slug: "crude-oil", name: "Crude Oil", stcc: "13111", est: "crude-oil",
    cars: "DOT-117 tank car (~28,000–30,000 gal)", tons: "90–100",
    density: "—", constraint: "weight",
    what: "Crude by rail connects production basins to refineries the pipelines don't reach — primarily Bakken and Western Canadian barrels to coastal refineries.",
    uses: "Refinery feedstock.",
    moves: "Unit trains of DOT-117s; volume swings with the pipeline-vs-rail price spread. Canadian heavy crude to the Gulf is the persistent lane.",
    hubkey: "crude_oil",
  },
  {
    slug: "ethanol", name: "Ethanol", stcc: "28184", est: "ethanol",
    cars: "DOT-117 tank car (~28,500–30,000 gal)", tons: "85–95",
    density: "—", constraint: "weight",
    what: "Fuel ethanol cannot move in product pipelines (it absorbs water), so nearly all of it rails from Corn Belt plants to blending terminals.",
    uses: "Gasoline blending (E10/E15/E85), industrial alcohol.",
    moves: "Unit trains from Iowa/Nebraska/Illinois plants to coastal and metro blending racks — one of the steadiest tank-car franchises on the network.",
    hubkey: "grain",
  },
  {
    slug: "chemicals", name: "Industrial Chemicals (Liquid)", stcc: "28199", est: "chemicals",
    cars: "General-service or specialized tank car", tons: "80–100",
    density: "varies", constraint: "weight",
    what: "Caustic soda, sulfuric acid, alcohols, solvents — the general tank-car franchise from Gulf Coast chemistry to plants everywhere.",
    uses: "Feedstocks and process chemicals for nearly every manufacturing industry.",
    moves: "Mostly single cars and small blocks in manifest service; car type, lining and fittings are matched to each product. Hazmat rules govern routing and handling.",
    hubkey: "chemicals",
  },
  {
    slug: "lpg-propane", name: "Propane / LPG", stcc: "29121", est: "lpg",
    cars: "Pressure tank car (DOT-112, ~33,500 gal)", tons: "60–70",
    density: "—", constraint: "volume",
    what: "Liquefied petroleum gas rides in thick-shelled pressure cars from fractionators to regional storage ahead of heating season.",
    uses: "Home heating, crop drying, petrochemical feedstock.",
    moves: "Strong fall/winter seasonality; Canadian LPG also rails to the West Coast for export.",
    hubkey: "chemicals",
  },
  {
    slug: "vehicles", name: "Finished Vehicles", stcc: "37112", est: "automotive",
    cars: "Autorack (bi-level or tri-level)", tons: "15–25",
    density: "—", constraint: "cube",
    what: "New cars and trucks move in enclosed autoracks from assembly plants and ports to distribution ramps — about 8–20 vehicles per rack depending on deck count and model size.",
    uses: "New vehicle distribution to dealer networks.",
    moves: "Dedicated networks connect every assembly plant in North America; Mexico-built vehicles northbound are among the busiest cross-border flows.",
    hubkey: "auto",
  },
  {
    slug: "barite", name: "Barite", stcc: "14711", est: "barite",
    cars: "Open-top or covered hopper", tons: "100–110",
    density: "130–160 (crude lump)", constraint: "weight",
    what: "Barium sulfate — the weighting agent in oil-well drilling mud. API drilling grade requires specific gravity of 4.2+, so a car hits its weight limit at roughly a quarter of its cube.",
    uses: "Drilling-mud weighting (the overwhelming majority), plus fillers and radiation shielding.",
    moves: "Crude ore rails from mines and import terminals to grinding plants near the oil patch (west Texas, Gulf Coast, Oklahoma); ground API barite then trucks or rails to mud plants. Ground product must stay dry — covered equipment.",
    hubkey: "chemicals",
  },
  {
    slug: "soda-ash", name: "Soda Ash", stcc: "28123", est: null,
    cars: "Covered hopper (~3,500 cu ft)", tons: "100–112",
    density: "58–65", constraint: "weight",
    what: "Natural sodium carbonate from the world's largest trona deposit at Green River, Wyoming — a one-origin commodity that rails everywhere glass is made.",
    uses: "Glassmaking (the largest use), detergents, chemicals, lithium processing.",
    moves: "Unit and manifest trains from Green River to domestic glass plants and to West Coast ports — one of the largest US rail export commodities by tonnage.",
    hubkey: "chemicals",
  },
  {
    slug: "silica", name: "Synthetic Amorphous Silica", stcc: "2819956", est: null,
    cars: "Pressure-differential covered hopper (high cube)", tons: "10–37 (grade-dependent)",
    density: "2–20 (fumed vs. precipitated)", constraint: "cube",
    what: "Fumed and precipitated silica — ultra-light engineered powders. The car cubes out at a small fraction of its weight limit: precipitated grades load ~30–37 tons, fumed grades as little as 10–15.",
    uses: "Tire and rubber reinforcement, coatings, toothpaste and food anti-caking, adhesives.",
    moves: "Producers ship in high-cube pressure-differential cars unloaded pneumatically into silos; bagged product moves in boxcars. Even lightly loaded, one car replaces two to three trucks.",
    hubkey: "chemicals",
  },
  {
    slug: "wood-pellets", name: "Wood Pellets", stcc: "24291", est: null,
    cars: "Covered hopper", tons: "90–100",
    density: "40–45", constraint: "balanced",
    what: "Densified sawmill residuals, mostly bound for European power plants — the US Southeast is the world's largest exporter.",
    uses: "Utility-scale renewable generation (export), home heating pellets (domestic).",
    moves: "Southeast pellet plants rail to dedicated export terminals at Savannah, Mobile and the Mississippi River; moisture control matters, so covered equipment throughout.",
    hubkey: "forest_products",
  },
  {
    slug: "petroleum-coke", name: "Petroleum Coke", stcc: "29914", est: "coal",
    cars: "Open-top hopper or rotary gondola", tons: "100–115",
    density: "45–55", constraint: "weight",
    what: "The bottom-of-the-barrel refinery byproduct — fuel-grade petcoke moves like coal, anode-grade feeds aluminum smelters.",
    uses: "Cement kilns and power generation (fuel grade), aluminum anodes (calcined grade), export.",
    moves: "Gulf Coast refineries to cement plants, export docks and calciners; handled with coal-style rotary dump equipment.",
    hubkey: "coal",
  },
  {
    slug: "salt", name: "Salt", stcc: "28991", est: null,
    cars: "Covered or open-top hopper", tons: "100–112",
    density: "72–80", constraint: "weight",
    what: "Rock salt from Midwest and Gulf dome mines — the road-deicing supply chain runs on rail and barge positioning done months before the first storm.",
    uses: "Road deicing (the big tonnage), water softening, chlor-alkali feedstock, food.",
    moves: "Mines to municipal and DOT stockpiles across the snow belt, mostly staged in summer and fall. Deicing salt can ride open-tops; evaporated and food grades need covered cars.",
    hubkey: "aggregates",
  },
];

/* Which hub layers map to a commodity's "where it flows" section. */
const HUBKEY_MATCH = {
  grain: (h) => h.primary_commodity === "grain",
  coal: (h) => h.primary_commodity === "coal",
  steel: (h) => h.primary_commodity === "steel",
  iron_ore: (h) => h.primary_commodity === "iron_ore",
  forest_products: (h) => h.primary_commodity === "forest_products",
  chemicals: (h) => h.primary_commodity === "chemicals",
  crude_oil: (h) => h.primary_commodity === "crude_oil",
  auto: (h) => h.primary_commodity === "auto",
  aggregates: (h) => ["ports", "multi_modal"].includes(h.primary_commodity),
};

/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Brand rule: the word never appears on an SWL page. Map data uses it in 27
// hub records, so every emitted string passes through here.
function deIntermodal(s) {
  return String(s ?? "")
    .replace(/intermodal\s+(hub|terminal|yard|facility|traffic|freight)/gi, "multimodal $1")
    .replace(/intermodal/gi, "multimodal");
}

function head({ title, description, canonical, jsonLd }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Steel Wheel Logistics">
  <meta property="og:image" content="${BASE}/images/logo-192.png">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <title>${esc(title)}</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/png" sizes="192x192" href="/images/logo-192.png">
  <link rel="stylesheet" href="/style.css?v=5">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-RSWDYHVY7Z"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-RSWDYHVY7Z');
  </script>
  <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
  </script>
</head>
<body>
${siteHeader()}`;
}

const FOOTER = `
  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-copy">&copy; 2026 Steel Wheel Logistics. All rights reserved.</div>
      <div class="footer-links">
        <a href="/privacy-policy">Privacy Policy</a>
        <a href="/terms-of-service">Terms of Service</a>
        <a href="/contact">Contact Us</a>
      </div>
    </div>
  </footer>

</body>
</html>
`;

const DISCLAIMER = `
    <p style="font-size:0.85em;color:#666;margin-top:28px">
      Figures on this page are typical industry ranges for reference — actual
      loads depend on the specific car, commodity grade and railroad rules.
      Rate estimates are indicative only; Steel Wheel Logistics does not issue
      binding quotes from this page.
    </p>`;

function estimatorCta(c) {
  const link = c.est
    ? `/tools/rail-rate-quote?commodity=${c.est}`
    : `/tools/rail-rate-quote`;
  return `
    <section class="cta-section" style="margin-top:32px;padding:20px;background:#f4f6f8;border-radius:6px">
      <h2 style="margin-top:0">Shipping ${esc(c.name.toLowerCase())} by rail?</h2>
      <p>
        Run your lane through the <a href="${link}">Rail Rate Quote tool</a> for an
        indicative estimate${c.est ? " (the commodity is pre-selected for you)" : ""},
        compare modes with <a href="/tools/rail-vs-truck">Rail vs Truck</a>, or find
        transfer points in the <a href="/tools/transload-directory">Transload Directory</a>.
        We do not guarantee rates &mdash; we will talk through your lane before quoting.
      </p>
    </section>`;
}

function faq(c) {
  const carShort = c.cars.split("(")[0].trim().toLowerCase();
  return [
    {
      q: `Can ${c.name.toLowerCase()} be shipped by rail?`,
      a: `Yes. ${c.name} moves regularly on the North American rail network in ${carShort}s. ${c.moves.split(". ")[0]}.`,
    },
    {
      q: `How many tons of ${c.name.toLowerCase()} fit in a railcar?`,
      a: `A typical load is ${c.tons} net tons per car${c.constraint === "cube"
        ? " — the car fills up (cubes out) before it reaches its weight limit"
        : c.constraint === "weight"
          ? " — the car reaches its weight limit well before its cubic capacity"
          : ""}.`,
    },
    {
      q: `What railcar does ${c.name.toLowerCase()} move in?`,
      a: `${c.cars}. ${c.constraint === "cube" ? "Because the commodity is light for its volume, shippers prefer the largest cubic capacity available." : c.constraint === "weight" ? "Because the commodity is dense, smaller-cube cars are common — the weight limit governs." : "Car choice varies with grade and lane."}`,
    },
    ...(c.density !== "—" && c.density !== "varies" ? [{
      q: `What is the bulk density of ${c.name.toLowerCase()}?`,
      a: `Roughly ${c.density} lb per cubic foot, depending on grade and condition.`,
    }] : []),
  ];
}

/* "By the numbers" — page-cited tonnage figures from all 48 lower-48 state
 * rail plans (scripts/plan-flows.json via lib-plan-flows.js). Each line
 * renders exactly ONE plan row with its own citation; FAF- and Waybill-
 * sourced figures are never combined in a stat (see lib-plan-flows.js).
 * Statewide totals and single-direction figures render as SEPARATE lists —
 * they measure different things and must not share a ranking.
 * Copy rules: figure labeled with its data year, commodity named as the plan
 * prints it, no claims beyond the row. Renders only when >=1 stat exists. */
function byTheNumbers(c) {
  const { totals, directional } = statsForCommodity(c.slug, 5);
  if (!totals.length && !directional.length) return "";
  const list = (rows) =>
    `    <ul>\n${rows.map((s) => `      <li>${esc(deIntermodal(s.text))}</li>`).join("\n")}\n    </ul>`;
  const blocks = [];
  if (totals.length) {
    blocks.push(`    <h3>Statewide rail tonnage</h3>\n${list(totals)}`);
  }
  if (directional.length) {
    blocks.push(
      `    <h3>Single-direction figures</h3>\n` +
      `    <p>These count movement in one direction only &mdash; originated, inbound or\n` +
      `      outbound as each plan defines it &mdash; so they are not comparable with the\n` +
      `      statewide totals above.</p>\n${list(directional)}`);
  }
  return `
    <h2>By the numbers: state rail plan figures</h2>
    <p>How much of this commodity group moves by rail, as published in the
      states' own federally mandated rail plans:</p>
${blocks.join("\n")}
    <p style="font-size:0.85em;color:#666">
      Each figure is quoted from the cited state rail plan and reflects that
      plan's own data year, commodity grouping and methodology &mdash; figures
      from different plans are not directly comparable with each other. Some
      plans count traffic passing through the state and others exclude it; each
      line says which.
    </p>`;
}

function commodityPage(c) {
  const url = `${BASE}/commodities/${c.slug}`;
  const title = `${c.name} by Rail — Railcar Type, Tons per Car & How It Moves | Steel Wheel Logistics`;
  const description = deIntermodal(
    `How ${c.name.toLowerCase()} ships by rail: ${c.cars.split("(")[0].trim()}, ` +
    `${c.tons} tons per car, STCC ${c.stcc}. Uses, flows and freight guidance from Steel Wheel Logistics.`
  );
  const faqs = faq(c);
  const hubs = (HUBKEY_MATCH[c.hubkey] ? HUBS.filter(HUBKEY_MATCH[c.hubkey]) : []).slice(0, 8);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: deIntermodal(f.a) },
    })),
  };

  const body = `
  <main class="page-main" style="max-width:900px;margin:0 auto;padding:24px 16px">
    <nav style="font-size:0.85em;color:#666;margin-bottom:12px">
      <a href="/">Home</a> &rsaquo; <a href="/commodities/">Commodities</a> &rsaquo; ${esc(c.name)}
    </nav>
    <h1>${esc(c.name)} by Rail</h1>
    <p style="font-size:1.05em">${esc(deIntermodal(c.what))}</p>

    <div class="railroad-item" style="margin:20px 0;padding:16px;background:#f9fafb;border-radius:6px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:6px 8px;font-weight:600;width:40%">Railcar</td><td style="padding:6px 8px">${esc(c.cars)}</td></tr>
        <tr><td style="padding:6px 8px;font-weight:600">Typical net load</td><td style="padding:6px 8px">${esc(c.tons)} tons per car</td></tr>
        ${c.density !== "—" ? `<tr><td style="padding:6px 8px;font-weight:600">Bulk density</td><td style="padding:6px 8px">~${esc(c.density)} lb/cu ft</td></tr>` : ""}
        <tr><td style="padding:6px 8px;font-weight:600">Loading constraint</td><td style="padding:6px 8px">${c.constraint === "cube" ? "Cubes out (volume-limited)" : c.constraint === "weight" ? "Weighs out (weight-limited)" : "Varies by grade"}</td></tr>
        <tr><td style="padding:6px 8px;font-weight:600">STCC</td><td style="padding:6px 8px">${esc(c.stcc)} &mdash; look up related codes in the <a href="/tools/stcc-finder">STCC Finder</a></td></tr>
      </table>
    </div>

    <h2>What it's used for</h2>
    <p>${esc(deIntermodal(c.uses))}</p>

    <h2>How it moves</h2>
    <p>${esc(deIntermodal(c.moves))}</p>
${byTheNumbers(c)}
    ${hubs.length ? `
    <h2>Where it flows</h2>
    <p>Key origins and gateways for ${esc(c.name.toLowerCase())} on the
      <a href="/tools/commodity-flow-map">Commodity Flow Map</a>:</p>
    <ul>
${hubs.map((h) => `      <li><a href="/rail-hubs/${esc(h.slug.replace(/intermodal/g, "multimodal"))}">${esc(deIntermodal(h.name))}</a> &mdash; ${esc(h.city)}, ${esc(h.state)} (${esc(h.nearest_class_i)})</li>`).join("\n")}
    </ul>` : ""}

    <h2>Common questions</h2>
${faqs.map((f) => `    <h3 style="margin-bottom:4px">${esc(f.q)}</h3>\n    <p style="margin-top:0">${esc(deIntermodal(f.a))}</p>`).join("\n")}

    <h2>Related tools</h2>
    <ul>
      <li><a href="/tools/railcar-capacity">Railcar Capacity Guide</a> &mdash; loads and cubic capacities by car type</li>
      <li><a href="/tools/railcar-selector">Railcar Selector</a> &mdash; match a commodity to the right equipment</li>
      <li><a href="/tools/rail-vs-truck">Rail vs Truck Calculator</a> &mdash; where rail wins on your lane</li>
      <li><a href="/tools/transload-directory">Transload Directory</a> &mdash; 2,400+ transfer facilities</li>
    </ul>
${estimatorCta(c)}
${DISCLAIMER}
  </main>`;

  return { url, html: head({ title, description, canonical: url, jsonLd }) + body + FOOTER };
}

function hubPage(h) {
  // Two map slugs contain the banned word; the PAGE slug (URL + filename)
  // rewrites it. The map's own JSON is untouched.
  const pageSlug = h.slug.replace(/intermodal/g, "multimodal");
  const url = `${BASE}/rail-hubs/${pageSlug}`;
  const name = deIntermodal(h.name);
  const catLabel = {
    origin: "Origin region", port: "Port / break-bulk gateway",
    rail_hub: "Major rail hub / inland gateway", barge_hub: "Rail-barge hub",
    border: "Border crossing",
  }[h.category] || "Rail hub";
  const title = `${name} — Rail Freight Hub Profile | Steel Wheel Logistics`;
  const description = deIntermodal(
    `${name} (${h.city}, ${h.state}): ${catLabel.toLowerCase()} served by ${h.nearest_class_i}. Role, commodities and connections on the North American rail network.`
  );
  const related = COMMODITIES.filter(
    (c) => HUBKEY_MATCH[c.hubkey] && HUBKEY_MATCH[c.hubkey](h)
  ).slice(0, 6);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Place",
    name,
    description,
    address: { "@type": "PostalAddress", addressLocality: h.city, addressRegion: h.state },
    geo: { "@type": "GeoCoordinates", latitude: h.lat, longitude: h.lon },
  };

  const body = `
  <main class="page-main" style="max-width:900px;margin:0 auto;padding:24px 16px">
    <nav style="font-size:0.85em;color:#666;margin-bottom:12px">
      <a href="/">Home</a> &rsaquo; <a href="/tools/commodity-flow-map">Commodity Flow Map</a> &rsaquo; ${esc(name)}
    </nav>
    <h1>${esc(name)}</h1>
    <p style="color:#555">${esc(catLabel)} &middot; ${esc(h.city)}, ${esc(h.state)} &middot; Class I service: ${esc(h.nearest_class_i)}</p>
    <p style="font-size:1.05em">${esc(deIntermodal(h.description || ""))}</p>

    ${related.length ? `
    <h2>Commodities through this hub</h2>
    <ul>
${related.map((c) => `      <li><a href="/commodities/${c.slug}">${esc(c.name)} by rail</a> &mdash; ${esc(c.cars.split("(")[0].trim())}, ${esc(c.tons)} tons/car</li>`).join("\n")}
    </ul>` : ""}

    <h2>See it on the map</h2>
    <p>This hub is one of ${HUBS.length} plotted on the interactive
      <a href="/tools/commodity-flow-map">North American Commodity Flow Map</a> —
      origins, ports, gateways and border crossings with their serving railroads.</p>

    <section class="cta-section" style="margin-top:32px;padding:20px;background:#f4f6f8;border-radius:6px">
      <h2 style="margin-top:0">Moving freight through ${esc(h.city)}?</h2>
      <p>
        Find transfer points in the <a href="/tools/transload-directory">Transload Directory</a>
        or run an indicative estimate with the <a href="/tools/rail-rate-quote">Rail Rate Quote tool</a>.
        We do not guarantee rates &mdash; the estimator is indicative only.
      </p>
    </section>
${DISCLAIMER}
  </main>`;

  return { url, html: head({ title, description, canonical: url, jsonLd }) + body + FOOTER };
}

function indexPage() {
  const url = `${BASE}/commodities`;  // no trailing slash — Vercel cleanUrls 308s the slashed form
  const title = "Commodities by Rail — Railcar Types, Loads & Flows | Steel Wheel Logistics";
  const description =
    "How North American commodities move by rail: the right railcar, typical tons per car, bulk density, and where each one flows. A working reference from Steel Wheel Logistics.";
  const groups = [
    ["Grain & Feed", ["corn", "wheat", "soybeans", "ddgs", "soybean-meal"]],
    ["Energy", ["coal", "crude-oil", "ethanol", "lpg-propane", "petroleum-coke"]],
    ["Minerals & Construction", ["aggregates", "cement", "frac-sand", "iron-ore", "barite", "soda-ash", "salt", "potash"]],
    ["Metals", ["steel", "scrap-metal"]],
    ["Forest Products", ["lumber", "paper", "wood-pellets"]],
    ["Chemicals & Manufactured", ["chemicals", "fertilizer", "plastic-pellets", "silica", "vehicles"]],
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: title, url,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: COMMODITIES.length,
      itemListElement: COMMODITIES.map((c, i) => ({
        "@type": "ListItem", position: i + 1,
        url: `${BASE}/commodities/${c.slug}`, name: c.name,
      })),
    },
  };
  const body = `
  <main class="page-main" style="max-width:900px;margin:0 auto;padding:24px 16px">
    <h1>Commodities by Rail</h1>
    <p style="font-size:1.05em">
      What each commodity is, which railcar it rides in, how many tons fit in a car,
      and where it flows across North America. Every entry links the interactive
      <a href="/tools/commodity-flow-map">Commodity Flow Map</a>, the
      <a href="/tools/railcar-capacity">Railcar Capacity Guide</a> and the
      <a href="/tools/rail-rate-quote">Rail Rate Quote tool</a>.
    </p>
${groups.map(([g, slugs]) => `
    <h2>${esc(g)}</h2>
    <ul>
${slugs.map((s) => {
      const c = COMMODITIES.find((x) => x.slug === s);
      if (!c) return "";
      return `      <li><a href="/commodities/${c.slug}">${esc(c.name)}</a> &mdash; ${esc(c.cars.split("(")[0].trim())}, ${esc(c.tons)} tons/car</li>`;
    }).join("\n")}
    </ul>`).join("\n")}

    <h2>Rail hubs</h2>
    <p>Browse ${HUBS.length} origins, ports, gateways and border crossings as
      individual profiles from the <a href="/tools/commodity-flow-map">Commodity Flow Map</a>.</p>
${DISCLAIMER}
  </main>`;
  return { url, html: head({ title, description, canonical: url, jsonLd }) + body + FOOTER };
}

/* ------------------------------ build ------------------------------ */

mkdirSync(join(ROOT, "commodities"), { recursive: true });
mkdirSync(join(ROOT, "rail-hubs"), { recursive: true });

const pages = [];

const idx = indexPage();
writeFileSync(join(ROOT, "commodities", "index.html"), idx.html);
pages.push({ loc: idx.url, priority: "0.8" });

for (const c of COMMODITIES) {
  const p = commodityPage(c);
  writeFileSync(join(ROOT, "commodities", `${c.slug}.html`), p.html);
  pages.push({ loc: p.url, priority: "0.7" });
}

for (const h of HUBS) {
  const p = hubPage(h);
  const pageSlug = h.slug.replace(/intermodal/g, "multimodal");
  writeFileSync(join(ROOT, "rail-hubs", `${pageSlug}.html`), p.html);
  pages.push({ loc: p.url, priority: "0.5" });
}

writeFileSync(
  join(ROOT, "commodities", "pages.json"),
  JSON.stringify({ generated: true, pages }, null, 2)
);

console.log(`Built ${COMMODITIES.length} commodity pages + ${HUBS.length} hub pages + index.`);
console.log(`pages.json: ${pages.length} URLs for the sitemap.`);
const banned = /intermodal|drayage/i;
let bad = 0;
for (const c of COMMODITIES) {
  const html = readFileSync(join(ROOT, "commodities", `${c.slug}.html`), "utf-8");
  if (banned.test(html)) { console.error(`BANNED WORD in commodities/${c.slug}.html`); bad++; }
}
for (const h of HUBS) {
  const pageSlug = h.slug.replace(/intermodal/g, "multimodal");
  const html = readFileSync(join(ROOT, "rail-hubs", `${pageSlug}.html`), "utf-8");
  if (banned.test(html)) { console.error(`BANNED WORD in rail-hubs/${pageSlug}.html`); bad++; }
}
console.log(bad ? `${bad} pages FAILED the brand-word check` : "Brand-word check: clean.");
