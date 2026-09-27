#!/usr/bin/env bun
/**
 * Build script for Steel Wheel Logistics programmatic city SEO pages.
 * Reads cities.json and generates:
 *   - /rail-freight/{slug}.html for each city
 *   - /rail-freight/index.html listing all cities
 *
 * 2026-09-27 rebuild (GSC: 18.2k impressions / 64 clicks over 90 days, the
 * family ranks pos 10-19 for "rail logistics consultants in <city>" and
 * "rail freight shipping <city>" but earns almost no clicks). Each page now
 * carries, in addition to the original railroads / terminals / commodities
 * sections:
 *   - a title + answer-first meta description targeting both query families
 *   - "Rail logistics services in <City>" (outsourced-rail-department pitch
 *     built from the page's own railroads + commodities, so no two read alike)
 *   - "Priced lanes from / into <City>" tables from rates/lanes.json
 *   - "Rail transload and terminals near <City>" from the transload directory
 *     (haversine <= 40 mi of the city's coordinates from cities.csv)
 *   - one conversion CTA (cal.com concierge booking + rate tool + phone) with
 *     the GA4 rail_concierge_cta_click event
 *   - visible FAQ + FAQPage and BreadcrumbList JSON-LD
 *
 * BRAND RULES (positioning, non-negotiable): Steel Wheel is a rail logistics
 * company / outsourced rail department. Never "freight broker", "brokerage"
 * unqualified, "3PL", "intermodal", "container", "drayage", "binding",
 * "guaranteed"; no transit-time promises; estimates are "indicative"; national
 * company based in Petal MS serving cities remotely -- never claim a local
 * office. scrub() enforces the vocabulary on data-sourced prose.
 *
 * Usage: bun run scripts/build-city-pages.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { siteHeader } from "./lib/site-nav.js";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const CITIES_FILE = join(ROOT, "cities.json");
const OUTPUT_DIR = join(ROOT, "rail-freight");
const POSTS_FILE = join(ROOT, "blog", "posts.json");
const LANES_FILE = join(ROOT, "rates", "lanes.json");
const TRANSLOAD_FILE = join(ROOT, "tools", "transload-directory", "data", "transload-v2.json");
const TRANSLOAD_PAGES_FILE = join(ROOT, "transload", "pages.json");
// City coordinates live in the assistant's gazetteer (cities.json has none).
const CITIES_CSV = "/home/ubuntu/bots/assistant/businesses/steel-wheel/data/cities.csv";

const SITE = "https://steelwheellogistics.com";
const GTAG_ID = "G-RSWDYHVY7Z";
const PHONE_DISPLAY = "(601) 821-2199";
const PHONE_TEL = "+16018212199";
const BOOKING_BASE = "https://cal.com/sj-services/30min";
const LANE_ROWS_CAP = 8;
const TRANSLOAD_CAP = 6;
const TRANSLOAD_RADIUS_MI = 40;

const cities = JSON.parse(readFileSync(CITIES_FILE, "utf-8"));
const posts = JSON.parse(readFileSync(POSTS_FILE, "utf-8"));

let LANES = [];
try { LANES = JSON.parse(readFileSync(LANES_FILE, "utf-8")); }
catch (e) { console.warn("build-city-pages: rates/lanes.json missing; no priced-lanes tables"); }

let FACILITIES = [];
try { FACILITIES = JSON.parse(readFileSync(TRANSLOAD_FILE, "utf-8")).facilities || []; }
catch (e) { console.warn("build-city-pages: transload-v2.json missing; no transload sections"); }

let TRANSLOAD_PAGES = new Set();
try { TRANSLOAD_PAGES = new Set((JSON.parse(readFileSync(TRANSLOAD_PAGES_FILE, "utf-8")).pages || []).map(p => p.loc)); }
catch (e) { console.warn("build-city-pages: transload/pages.json missing; facility links fall back to the directory"); }

// (ascii_name, state) -> {lat, lon}; highest-population US row wins so
// "Memphis, TN" is the city and not a hamlet that shares the name.
const COORDS = new Map();
try {
  const lines = readFileSync(CITIES_CSV, "utf-8").split("\n");
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 7 || cols[3] !== "US") continue;
    const key = `${cols[0]}|${cols[2]}`;
    const pop = Number(cols[6]) || 0;
    const prev = COORDS.get(key);
    if (!prev || pop > prev.pop) COORDS.set(key, { lat: Number(cols[4]), lon: Number(cols[5]), pop });
  }
} catch (e) { console.warn("build-city-pages: cities.csv missing; no transload sections"); }

mkdirSync(OUTPUT_DIR, { recursive: true });

const today = new Date().toISOString().split("T")[0];

/* ------------------------------------------------------------------ *
 * Reference tables
 * ------------------------------------------------------------------ */

const RAILROAD_SHORT = {
  "BNSF": "BNSF", "Union Pacific": "UP", "Norfolk Southern": "NS", "CSX": "CSX",
  "Canadian National": "CN", "Canadian Pacific Kansas City": "CPKC",
};

const COMMODITY_LABEL = {
  steel: "Steel", plastic: "Plastic pellets", chemicals: "Chemicals", fertilizer: "Fertilizer",
  paper: "Paper", lumber: "Lumber", grain: "Grain", cement: "Cement", sugar: "Sugar", coal: "Coal",
};

// Commodity keyword -> railcar type used in the services paragraph.
const CAR_TYPE_BY_KEYWORD = [
  [/petroleum|crude|refined|ethanol|fuel/i, "tank cars"],
  [/chemical/i, "tank cars"],
  [/plastic|resin|pellet/i, "covered hoppers"],
  [/grain|corn|soybean|wheat|rice|feed|oilseed/i, "covered hoppers"],
  [/fertilizer|potash|urea/i, "covered hoppers"],
  [/cement|clinker/i, "covered hoppers"],
  [/coal|coke/i, "open-top hoppers"],
  [/aggregate|sand|gravel|stone|ore|salt/i, "open-top hoppers"],
  [/steel|metal|scrap|coil|aluminum|pipe/i, "gondolas and coil cars"],
  [/lumber|wood|timber|panel/i, "centerbeam flatcars"],
  [/paper|pulp|forest/i, "boxcars"],
  [/auto|vehicle/i, "autoracks"],
  [/food|sugar|consumer|beverage/i, "boxcars"],
];

const FACILITY_TYPE_LABEL = {
  "transload-terminal": "Transload terminal",
  "port-terminal": "Port terminal",
  "third-party-warehouse": "Third-party warehouse (rail-served)",
};
const CONFIDENCE_RANK = { high: 3, probable: 2, possible: 1 };

// Region names for /transload/<region> links (mirror of build-transload-pages.js).
const REGIONS = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", NS: "Nova Scotia", ON: "Ontario",
  PQ: "Quebec", SK: "Saskatchewan",
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function htmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const slugify = (s) => String(s ?? "").toLowerCase().normalize("NFKD")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Brand vocabulary scrubber for the prose that comes out of cities.json.
// The port descriptions were written with "container port" language; the
// site never says container / intermodal / drayage, and never promises a
// transit time.
function scrub(s) {
  return String(s ?? "")
    .replace(/intermodal/gi, "multimodal")
    .replace(/container port complex/gi, "port complex")
    .replace(/container ports/gi, "ports")
    .replace(/container port/gi, "port")
    .replace(/container operations/gi, "marine terminal operations")
    .replace(/container volumes/gi, "cargo volumes")
    .replace(/container trade/gi, "import and export trade")
    .replace(/container facility/gi, "marine terminal")
    .replace(/containeri[sz]ed freight/gi, "boxed freight")
    .replace(/moving containers inland/gi, "moving that cargo inland")
    .replace(/containers?/gi, "cargo")
    .replace(/drayage/gi, "local truck transfer")
    .replace(/competitive transit times/gi, "a direct routing")
    .replace(/transit times?/gi, "routing");
}

function listWords(items) {
  const a = items.filter(Boolean);
  if (a.length === 0) return "";
  if (a.length === 1) return a[0];
  return a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
}

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8, p = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * p) / 2) ** 2 +
    Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(((lon2 - lon1) * p) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function carTypesFor(commodities) {
  const out = [];
  for (const c of commodities) {
    for (const [re, car] of CAR_TYPE_BY_KEYWORD) {
      if (re.test(c)) { if (!out.includes(car)) out.push(car); break; }
    }
    if (out.length >= 3) break;
  }
  return out;
}

// Blog post relevance matching
function findRelatedPosts(city) {
  const relevant = [];
  const commoditiesLower = city.commodities.map(c => c.toLowerCase());

  for (const post of posts) {
    // Weekly news digests are not evergreen guidance for a city landing page.
    if (/^rail-pulse-/.test(post.slug)) continue;
    let score = 0;
    const titleLower = post.title.toLowerCase();
    const descLower = post.description.toLowerCase();
    const tagsLower = post.tags.map(t => t.toLowerCase());

    // Check commodity matches
    for (const commodity of commoditiesLower) {
      const words = commodity.split(/\s+/);
      for (const word of words) {
        if (word.length < 4) continue;
        if (titleLower.includes(word) || descLower.includes(word) || tagsLower.some(t => t.includes(word))) {
          score += 2;
        }
      }
    }

    // General rail freight posts are always somewhat relevant
    if (tagsLower.includes("fundamentals") || tagsLower.includes("getting started")) {
      score += 1;
    }

    // Transloading relevant if port access
    if (city.portAccess && (titleLower.includes("transload") || tagsLower.some(t => t.includes("transload")))) {
      score += 3;
    }

    // Cost/rate posts always relevant
    if (tagsLower.some(t => t.includes("cost") || t.includes("rate") || t.includes("pricing"))) {
      score += 1;
    }

    if (score > 0) {
      relevant.push({ ...post, score });
    }
  }

  return relevant.sort((a, b) => b.score - a.score).slice(0, 5);
}

// Find nearby cities for internal linking
function findNearbyCities(city) {
  const stateMatches = cities.filter(c => c.stateAbbr === city.stateAbbr && c.slug !== city.slug);
  const railroadMatches = cities.filter(c =>
    c.slug !== city.slug &&
    c.stateAbbr !== city.stateAbbr &&
    c.railroads.some(r => city.railroads.includes(r))
  );

  // Prefer same-state, then same-railroad
  const nearby = [...stateMatches];
  for (const match of railroadMatches) {
    if (!nearby.find(n => n.slug === match.slug)) {
      nearby.push(match);
    }
    if (nearby.length >= 6) break;
  }
  return nearby.slice(0, 6);
}

function lanesFrom(city) {
  return LANES.filter(l => l.origin_city === city.city && l.origin_state === city.stateAbbr)
    .sort((a, b) => b.rate - a.rate).slice(0, LANE_ROWS_CAP);
}
function lanesInto(city) {
  return LANES.filter(l => l.dest_city === city.city && l.dest_state === city.stateAbbr)
    .sort((a, b) => b.rate - a.rate).slice(0, LANE_ROWS_CAP);
}

// Up to TRANSLOAD_CAP rail-served facilities within TRANSLOAD_RADIUS_MI.
// Private plants are somebody else's spur, not a place a shipper can transload,
// and "unlikely" rail confidence is not something to send a prospect to.
function nearbyFacilities(city) {
  const co = COORDS.get(`${city.city}|${city.stateAbbr}`);
  if (!co) return [];
  const out = [];
  for (const f of FACILITIES) {
    if (typeof f.lat !== "number" || typeof f.lng !== "number") continue;
    if (f.facility_type === "private-plant") continue;
    if (f.rail_proximity === "not-rail-served") continue;
    // A facility whose own name is "3PL" / "Intermodal" would put a banned
    // word on the page; there are always neighbours without one.
    if (BANNED.test(f.name || "")) continue;
    const rank = CONFIDENCE_RANK[f.rail_confidence] || 0;
    if (!rank) continue;
    const d = haversineMi(co.lat, co.lon, f.lat, f.lng);
    if (d > TRANSLOAD_RADIUS_MI) continue;
    out.push({ f, d, rank, typed: f.facility_type ? 1 : 0, verified: f.tier === "verified" ? 1 : 0 });
  }
  out.sort((a, b) => (b.typed - a.typed) || (b.rank - a.rank) || (b.verified - a.verified) || (a.d - b.d));
  return out.slice(0, TRANSLOAD_CAP);
}

function facilityHref(f) {
  const cityPage = `/transload/${slugify(f.city)}-${String(f.state || "").toLowerCase()}`;
  if (TRANSLOAD_PAGES.has(cityPage)) return cityPage;
  const region = REGIONS[f.state];
  if (region) {
    const regionPage = `/transload/${slugify(region)}`;
    if (TRANSLOAD_PAGES.has(regionPage)) return regionPage;
  }
  return "/tools/transload-directory";
}

/* ------------------------------------------------------------------ *
 * Copy builders
 * ------------------------------------------------------------------ */

// 5-6 sentences, every one of them parameterised on the city's own data.
function servicesParagraph(city) {
  const n = city.railroads.length;
  const rrs = city.railroads;
  const comms = city.commodities.map(c => c.toLowerCase());
  const cars = carTypesFor(city.commodities);
  const s = [];

  if (n === 1) {
    s.push(`A ${city.city} shipper moving ${listWords(comms.slice(0, 3))} by rail works with a single Class I, ${rrs[0]}, so the routing question is which interchange and which short line or switching carrier get the car to the far end at the best rate.`);
  } else if (n === 2) {
    s.push(`A ${city.city} shipper moving ${listWords(comms.slice(0, 3))} by rail can route on ${rrs[0]} or ${rrs[1]}, and the two carriers rarely price the same lane the same way.`);
  } else {
    s.push(`A ${city.city} shipper moving ${listWords(comms.slice(0, 3))} by rail has ${n} Class I railroads to choose from: ${listWords(rrs)}. Which one prices a given lane best depends on the destination, the interchange and the commodity.`);
  }

  s.push(`Steel Wheel Logistics is that shipper's outsourced rail department: we price the lane, choose the routing${n > 1 ? ` between ${listWords(rrs.map(r => RAILROAD_SHORT[r] || r))}` : ` on ${RAILROAD_SHORT[rrs[0]] || rrs[0]}`} and handle the railroad coordination that most plants no longer staff in-house.`);

  if (cars.length) {
    s.push(`For ${listWords(comms.slice(0, 4))} that means sourcing ${listWords(cars)}, managing car ordering and supply, and watching demurrage before it accrues.`);
  } else {
    s.push(`That means sourcing the right railcars for ${listWords(comms.slice(0, 4))}, managing car ordering and supply, and watching demurrage before it accrues.`);
  }

  if (city.portAccess) {
    s.push(`${city.city}'s port access adds a rail-to-vessel option for export and import cargo; we arrange the transload leg and the terminal handoff so the rail move and the vessel schedule line up.`);
  } else if (nearbyFacilities(city).length) {
    s.push(`Plants without their own rail spur can still ship by rail through a transload site near ${city.city} (see the facilities below), riding rail for the long haul and truck for the last few miles.`);
  } else {
    s.push(`Plants without their own rail spur can still ship by rail through the nearest transload site in the region, riding rail for the long haul and truck for the last few miles; we find and vet that site.`);
  }

  s.push(`We are a national company based in Petal, Mississippi, and work ${city.city} lanes remotely, by phone and email, the same way shippers work with the railroads themselves. Rate estimates are indicative until the serving railroad confirms them.`);

  return s.join(" ");
}

function faqEntries(city) {
  const rrList = listWords(city.railroads);
  const yards = city.terminals.slice(0, 2).map(t => t.replace(/\s*\([^)]*\)\s*$/, ""));
  return [
    {
      q: `Which railroads serve ${city.city}?`,
      a: `${city.city}, ${city.stateAbbr} is served by ${rrList}${yards.length ? `, with major facilities including ${listWords(yards)}` : ""}. Short lines and switching carriers connect individual plants and transload sites to ${city.railroads.length > 1 ? "those Class I networks" : "the Class I network"}.`,
    },
    {
      q: `Does Steel Wheel Logistics handle rail freight in ${city.city}?`,
      a: `Yes. Steel Wheel Logistics is a national rail logistics company based in Petal, Mississippi, and works ${city.city} lanes remotely as an outsourced rail department: routing, pricing, railroad coordination, transload, demurrage management and railcar sourcing. There is no walk-in location; the work is done by phone, email and the railroads' own systems.`,
    },
    {
      q: `How do I get a rail freight rate from ${city.city}?`,
      a: `Run the Steel Wheel rail rate quote tool with ${city.city}, ${city.stateAbbr} as the origin, plus your destination and commodity; it returns an indicative single-car estimate in about 60 seconds. Estimates are indicative, not a quote: we confirm the number with the serving railroad before you commit freight. You can also call ${PHONE_DISPLAY}.`,
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Section renderers
 * ------------------------------------------------------------------ */

function laneTable(rows, direction, city) {
  if (!rows.length) return "";
  const heading = direction === "from" ? `Priced lanes from ${city.city}` : `Priced lanes into ${city.city}`;
  const colHead = direction === "from" ? "Destination" : "Origin";
  const intro = direction === "from"
    ? `Indicative single-car estimates from our rate model for lanes we have already priced out of ${city.city}, highest rate first. Not a quote; the serving railroad confirms the rate.`
    : `Indicative single-car estimates for lanes we have already priced into ${city.city}, highest rate first. Not a quote; the serving railroad confirms the rate.`;
  const trs = rows.map(l => {
    const other = direction === "from" ? `${l.dest_city}, ${l.dest_state}` : `${l.origin_city}, ${l.origin_state}`;
    const href = String(l.url || "").replace(/\/$/, "");
    return `            <tr><td><a href="${htmlEscape(href)}">${htmlEscape(other)}</a></td><td>${htmlEscape(COMMODITY_LABEL[l.commodity_id] || l.commodity_id)}</td><td class="num">${Math.round(l.miles).toLocaleString("en-US")}</td><td class="num">$${Math.round(l.rate).toLocaleString("en-US")}</td></tr>`;
  }).join("\n");
  return `
      <!-- Priced lanes ${direction} -->
      <section class="city-section">
        <h2>${htmlEscape(heading)}</h2>
        <p>${intro}</p>
        <table class="lane-table">
          <thead><tr><th>${colHead}</th><th>Commodity</th><th class="num">Rail miles</th><th class="num">Indicative rate / car</th></tr></thead>
          <tbody>
${trs}
          </tbody>
        </table>
      </section>`;
}

function transloadSection(city) {
  const near = nearbyFacilities(city);
  if (!near.length) return "";
  const lis = near.map(({ f, d }) => {
    const label = FACILITY_TYPE_LABEL[f.facility_type] || "Rail-served facility";
    return `            <li><strong>${htmlEscape(scrub(f.name))}</strong> &mdash; ${htmlEscape(f.city)}, ${htmlEscape(f.state)} &middot; ${label} &middot; ${Math.round(d)} mi &middot; <a href="${htmlEscape(facilityHref(f))}">Details</a></li>`;
  }).join("\n");
  return `
      <!-- Transload -->
      <section class="city-section">
        <h2>Rail transload and terminals near ${htmlEscape(city.city)}</h2>
        <p>Rail-served transload and terminal sites within ${TRANSLOAD_RADIUS_MI} miles of ${htmlEscape(city.city)} from the Steel Wheel <a href="/tools/transload-directory">Transload Directory</a>. If your plant has no rail spur, one of these is usually where the truck leg meets the railcar.</p>
        <ul class="city-list">
${lis}
        </ul>
        <p class="fineprint">Distances are straight-line from the city center. Capabilities are as listed by the operator; we confirm before routing.</p>
      </section>`;
}

function ctaSection(city) {
  const utm = `?utm_source=site&utm_campaign=rail_concierge&utm_content=rail-freight-${city.slug}`;
  const booking = `${BOOKING_BASE}${utm}`;
  const rateTool = `/tools/rail-rate-quote?origin_city=${encodeURIComponent(city.city)}&amp;origin_state=${encodeURIComponent(city.stateAbbr)}`;
  const onclick = `if(typeof gtag==='function'){gtag('event','rail_concierge_cta_click',{event_category:'concierge',event_label:'rail-freight-${city.slug}'});}`;
  return `
      <!-- CTA -->
      <section class="city-cta">
        <h2>Get an indicative rail rate from ${htmlEscape(city.city)}</h2>
        <p>Tell us the destination and the commodity. We price the lane on ${htmlEscape(listWords(city.railroads.map(r => RAILROAD_SHORT[r] || r)))}, confirm it with the serving railroad, and run the move as your outsourced rail department. Indicative rates in 60 seconds; a 30-minute call if you want a human on the lane.</p>
        <p class="cta-buttons">
          <a href="${htmlEscape(booking)}" class="btn btn-primary" onclick="${onclick.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" target="_blank" rel="noopener">Book a 30-minute rail concierge call</a>
          <a href="${rateTool}" class="btn btn-outline">Run an indicative rate</a>
        </p>
        <p class="cta-phone">Or call <a href="tel:${PHONE_TEL}">${PHONE_DISPLAY}</a></p>
      </section>`;
}

function faqSection(city, faqs) {
  const items = faqs.map(f => `          <div class="faq-item">
            <h3>${htmlEscape(f.q)}</h3>
            <p>${htmlEscape(f.a)}</p>
          </div>`).join("\n");
  return `
      <!-- FAQ -->
      <section class="city-section">
        <h2>Common questions about rail freight in ${htmlEscape(city.city)}</h2>
${items}
      </section>`;
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

const PAGE_CSS = `
    .lane-table { width: 100%; border-collapse: collapse; margin: 16px 0 8px; font-size: 15px; }
    .lane-table th, .lane-table td { padding: 10px 12px; border-bottom: 1px solid var(--border-grey, #e2e6ea); text-align: left; vertical-align: top; }
    .lane-table th { font-weight: 600; background: var(--light-grey, #f4f6f8); }
    .lane-table .num { text-align: right; white-space: nowrap; }
    .fineprint { font-size: 0.9em; color: #666; }
    .faq-item { margin: 18px 0; }
    .faq-item h3 { margin-bottom: 6px; }
    .faq-item p { margin: 0; line-height: 1.7; }
    .city-cta .cta-buttons { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin-bottom: 16px; }
    .city-cta .btn-outline { border: 2px solid rgba(255,255,255,0.7); color: #fff; }
    .city-cta .cta-phone { margin: 0; font-size: 15px; }
    .city-cta .cta-phone a { color: #fff; font-weight: 600; text-decoration: underline; }
    @media (max-width: 640px) { .lane-table { font-size: 13px; } .lane-table th, .lane-table td { padding: 8px 6px; } }`;

function generateCityPage(city) {
  const relatedPosts = findRelatedPosts(city);
  const nearbyCities = findNearbyCities(city);
  const fullLocation = `${city.city}, ${city.stateAbbr}`;
  const canonicalUrl = `${SITE}/rail-freight/${city.slug}`;
  const rrShort = listWords(city.railroads.map(r => RAILROAD_SHORT[r] || r));
  const faqs = faqEntries(city);

  // Title targets "rail logistics services/consultants in <city>" and
  // "rail freight shipping <city>" (rates / railroads / transload). The bare
  // form is already ~65 chars, so the brand suffix is dropped.
  const title = `Rail Logistics Services in ${fullLocation}: Rates, Railroads, Transload`;
  // Answer-first, ~160 chars: railroads, what we do here, the 60-second hook.
  const metaDesc = `${fullLocation} rail: ${rrShort}. Steel Wheel prices and coordinates carload moves, transload and railcars for ${city.city} shippers. Indicative rates in 60 seconds.`;

  const railroadSections = city.railroads.map(rr => {
    const descriptions = {
      "BNSF": "BNSF Railway operates one of the largest rail networks in North America, covering the western two-thirds of the United States. BNSF is a major carrier for coal, grain, and industrial products.",
      "Union Pacific": "Union Pacific Railroad operates the largest rail network in the U.S., spanning 23 states across the western two-thirds of the country. UP handles diverse freight including industrial, coal, and agricultural products.",
      "Norfolk Southern": "Norfolk Southern Railway operates a major rail network in the eastern United States, serving 22 states. NS is a leading carrier for coal, automotive, and merchandise freight.",
      "CSX": "CSX Transportation operates a rail network across 23 eastern states, connecting major ports, production centers, and population hubs. CSX handles coal, chemicals, automotive, and agricultural freight.",
      "Canadian National": "Canadian National Railway operates a transcontinental network spanning Canada and the central U.S. from the Gulf Coast to the Great Lakes. CN handles petroleum, forest products, and grain.",
      "Canadian Pacific Kansas City": "Canadian Pacific Kansas City (CPKC) is the only single-line railroad connecting Canada, the United States, and Mexico. CPKC handles grain, potash, and automotive freight across its tri-national network."
    };
    return `          <div class="railroad-item">
            <h3>${rr}</h3>
            <p>${descriptions[rr] || rr + " serves this region with freight rail service."}</p>
          </div>`;
  }).join("\n");

  const terminalsList = city.terminals.map(t => `            <li>${htmlEscape(t)}</li>`).join("\n");
  const commoditiesList = city.commodities.map(c => `            <li>${htmlEscape(c)}</li>`).join("\n");

  const portSection = city.portAccess ? `
      <!-- Port Connections -->
      <section class="city-section">
        <h2>Multimodal &amp; Port Connections</h2>
        <p>${htmlEscape(scrub(city.portAccess))}</p>
        <p>Port access gives ${htmlEscape(city.city)} shippers the advantage of rail-to-vessel transloading for international trade. Whether you are exporting or importing bulk commodities, the combination of rail and port infrastructure creates efficient multimodal supply chain options.</p>
        <p>Learn more about how transloading works in our guide: <a href="/blog/what-is-transloading">What Is Transloading?</a></p>
      </section>` : `
      <!-- Multimodal Connections -->
      <section class="city-section">
        <h2>Multimodal Connections</h2>
        <p>${htmlEscape(city.city)}'s rail infrastructure connects to the broader national network, providing access to ports, distribution centers, and production facilities across the country. ${city.railroads.length > 1 ? "Multiple Class I railroad connections give shippers routing flexibility and competitive rate options." : "The Class I railroad connection provides direct access to the national rail network."}</p>
      </section>`;

  const relatedPostsHtml = relatedPosts.length > 0 ? relatedPosts.map(p =>
    `            <li><a href="/blog/${p.slug}">${htmlEscape(p.title)}</a></li>`
  ).join("\n") : '            <li><a href="/blog/how-rail-freight-shipping-works">How Rail Freight Shipping Works</a></li>';

  const nearbyCitiesHtml = nearbyCities.map(c =>
    `            <li><a href="/rail-freight/${c.slug}">Rail Freight in ${htmlEscape(c.city)}, ${c.stateAbbr}</a></li>`
  ).join("\n");

  const fromRows = lanesFrom(city);
  const intoRows = lanesInto(city);

  const ldService = {
    "@context": "https://schema.org",
    "@type": "Service",
    "name": `Rail Logistics Services in ${fullLocation}`,
    "description": metaDesc,
    "url": canonicalUrl,
    "provider": {
      "@type": "Organization",
      "name": "Steel Wheel Logistics",
      "url": SITE,
      "telephone": PHONE_TEL,
      "address": { "@type": "PostalAddress", "addressLocality": "Petal", "addressRegion": "MS", "addressCountry": "US" },
    },
    "areaServed": {
      "@type": "City",
      "name": city.city,
      "containedInPlace": { "@type": "State", "name": city.state },
    },
    "serviceType": "Rail Freight Logistics",
  };
  const ldBreadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": `${SITE}/` },
      { "@type": "ListItem", "position": 2, "name": "Rail Freight by City", "item": `${SITE}/rail-freight` },
      { "@type": "ListItem", "position": 3, "name": fullLocation, "item": canonicalUrl },
    ],
  };
  const ldFaq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqs.map(f => ({
      "@type": "Question",
      "name": f.q,
      "acceptedAnswer": { "@type": "Answer", "text": f.a },
    })),
  };
  const ld = (o) => JSON.stringify(o, null, 2).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${htmlEscape(metaDesc)}">
  <meta name="keywords" content="rail logistics ${htmlEscape(city.city)}, rail freight ${htmlEscape(city.city)}, ${htmlEscape(city.city)} rail shipping, ${htmlEscape(city.city)} railroad, ${htmlEscape(city.city)} transload, bulk freight ${htmlEscape(city.city)} ${htmlEscape(city.stateAbbr)}">
  <link rel="canonical" href="${canonicalUrl}">
  <meta property="og:title" content="${htmlEscape(title)}">
  <meta property="og:description" content="${htmlEscape(metaDesc)}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Steel Wheel Logistics">
  <meta property="og:image" content="${SITE}/images/logo-192.png">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${htmlEscape(title)}">
  <meta name="twitter:description" content="${htmlEscape(metaDesc)}">
  <meta name="twitter:image" content="${SITE}/images/logo-192.png">
  <title>${htmlEscape(title)}</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/png" sizes="192x192" href="/images/logo-192.png">
  <link rel="stylesheet" href="/style.css?v=5">
  <style>${PAGE_CSS}
  </style>
  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=${GTAG_ID}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${GTAG_ID}');
  </script>
  <script type="application/ld+json">
${ld(ldService)}
  </script>
  <script type="application/ld+json">
${ld(ldBreadcrumb)}
  </script>
  <script type="application/ld+json">
${ld(ldFaq)}
  </script>
</head>
<body>

  <!-- Header -->${siteHeader()}
  <!-- Breadcrumb + Hero -->
  <section class="blog-hero">
    <div class="blog-breadcrumb">
      <a href="/">Home</a><span class="separator">/</span><a href="/rail-freight">Rail Freight by City</a><span class="separator">/</span><span>${fullLocation}</span>
    </div>
    <h1>Rail Logistics Services in ${fullLocation}</h1>
    <div class="blog-hero-meta">
      <span>${city.railroads.length} Class I Railroad${city.railroads.length !== 1 ? "s" : ""}</span>
      <span class="dot">&middot;</span>
      <span>${city.terminals.length} Major Terminal${city.terminals.length !== 1 ? "s" : ""}</span>
      ${city.portAccess ? '<span class="dot">&middot;</span><span class="blog-tag">Port Access</span>' : ""}
    </div>
  </section>

  <!-- Content -->
  <article class="blog-post">
    <div class="blog-post-content">

      <!-- Intro -->
      <div class="blog-highlight">
        <p>${htmlEscape(scrub(city.description))}</p>
      </div>

      <!-- Services -->
      <section class="city-section">
        <h2>Rail logistics services in ${htmlEscape(city.city)}</h2>
        <p>${htmlEscape(servicesParagraph(city))}</p>
        <p>See what the engagement looks like on our <a href="/outsourced-rail-department">outsourced rail department</a> page, or the individual <a href="/services">services</a>.</p>
      </section>

      <!-- Railroads -->
      <section class="city-section">
        <h2>Railroads Serving ${htmlEscape(city.city)}</h2>
        <p>${htmlEscape(city.city)} is served by ${htmlEscape(listWords(city.railroads))}, providing ${city.railroads.length > 2 ? "extensive" : "solid"} Class I railroad coverage for freight shippers in the ${htmlEscape(city.city)} metro area.</p>
        <div class="railroads-grid">
${railroadSections}
        </div>
        <p>Understanding how Class I and short line railroads work together is key to efficient rail shipping. Read our guide: <a href="/blog/short-line-vs-class-i-railroads">Short Line vs Class I Railroads</a>.</p>
      </section>

      <!-- Terminals -->
      <section class="city-section">
        <h2>Key Rail Terminals &amp; Yards</h2>
        <p>Major rail facilities in and around ${htmlEscape(city.city)} include:</p>
        <ul class="city-list">
${terminalsList}
        </ul>
        <p>These facilities handle car classification, transload, and bulk commodity loading and unloading operations. Learn how classification yards sort and route freight in our article: <a href="/blog/how-railroad-classification-yards-work">How Railroad Classification Yards Work</a>.</p>
      </section>

      <!-- Commodities -->
      <section class="city-section">
        <h2>Commodities Shipped by Rail</h2>
        <p>Key commodities moving by rail through ${htmlEscape(city.city)} include:</p>
        <ul class="city-list">
${commoditiesList}
        </ul>
        <p>Rail is the most cost-effective way to move bulk commodities over long distances. See our <a href="/blog/rail-vs-truck-freight-cost-comparison">rail vs truck cost comparison</a> to understand when rail makes sense for your freight.</p>
      </section>
${laneTable(fromRows, "from", city)}${laneTable(intoRows, "into", city)}${transloadSection(city)}${portSection}
${ctaSection(city)}
${faqSection(city, faqs)}

      <!-- Related Resources -->
      <section class="city-section">
        <h2>Related Resources</h2>
        <div class="related-links-grid">
          <div>
            <h3>Guides &amp; Articles</h3>
            <ul class="city-list">
${relatedPostsHtml}
            </ul>
          </div>
          <div>
            <h3>Rail Freight in Nearby Cities</h3>
            <ul class="city-list">
${nearbyCitiesHtml}
            </ul>
          </div>
        </div>
      </section>

    </div>
  </article>

  <!-- Footer -->
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
</html>`;
}

function generateIndexPage() {
  // Group cities by state
  const byState = {};
  for (const city of cities) {
    if (!byState[city.state]) byState[city.state] = [];
    byState[city.state].push(city);
  }
  const sortedStates = Object.keys(byState).sort();

  const stateBlocks = sortedStates.map(state => {
    const stateCities = byState[state].sort((a, b) => a.city.localeCompare(b.city));
    const cityCards = stateCities.map(c => `
            <div class="city-card">
              <a href="/rail-freight/${c.slug}">
                <h3>${c.city}, ${c.stateAbbr}</h3>
                <p>${c.railroads.join(", ")}</p>
                <span class="city-card-meta">${c.terminals.length} terminal${c.terminals.length !== 1 ? "s" : ""}${c.portAccess ? " &middot; Port access" : ""}</span>
              </a>
            </div>`).join("\n");

    return `
        <div class="state-group">
          <h2>${state}</h2>
          <div class="city-card-grid">
${cityCards}
          </div>
        </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Rail freight shipping services across 50 major U.S. cities. Find railroad access, transload terminals, and bulk commodity logistics in your area. Steel Wheel Logistics.">
  <meta name="keywords" content="rail freight by city, rail shipping locations, railroad terminals, transload facilities, bulk freight shipping, rail logistics">
  <link rel="canonical" href="https://steelwheellogistics.com/rail-freight">
  <meta property="og:title" content="Rail Freight Shipping by City | Steel Wheel Logistics">
  <meta property="og:description" content="Rail freight shipping services across 50 major U.S. cities. Find railroad access, transload terminals, and bulk commodity logistics in your area.">
  <meta property="og:url" content="https://steelwheellogistics.com/rail-freight">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Steel Wheel Logistics">
  <meta property="og:image" content="https://steelwheellogistics.com/images/logo-192.png">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="Rail Freight Shipping by City | Steel Wheel Logistics">
  <meta name="twitter:description" content="Rail freight shipping services across 50 major U.S. cities. Find railroad access, transload terminals, and bulk commodity logistics in your area.">
  <meta name="twitter:image" content="https://steelwheellogistics.com/images/logo-192.png">
  <title>Rail Freight Shipping by City | Steel Wheel Logistics</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/png" sizes="192x192" href="/images/logo-192.png">
  <link rel="stylesheet" href="/style.css?v=5">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": "Rail Freight Shipping by City",
    "description": "Rail freight shipping services across 50 major U.S. cities.",
    "url": "https://steelwheellogistics.com/rail-freight",
    "publisher": {
      "@type": "Organization",
      "name": "Steel Wheel Logistics",
      "url": "https://steelwheellogistics.com"
    }
  }
  </script>
</head>
<body>

  <!-- Header -->${siteHeader()}
  <!-- Hero -->
  <section class="blog-hero">
    <div class="blog-breadcrumb">
      <a href="/">Home</a><span class="separator">/</span><span>Rail Freight by City</span>
    </div>
    <h1>Rail Freight Shipping by City</h1>
    <div class="blog-hero-meta">
      <span>${cities.length} Cities</span>
      <span class="dot">&middot;</span>
      <span>${sortedStates.length} States</span>
      <span class="dot">&middot;</span>
      <span>All 6 Class I Railroads</span>
    </div>
  </section>

  <!-- Content -->
  <section class="section">
    <div class="container">
      <div class="section-header">
        <p class="section-label">Service Areas</p>
        <h2>Find Rail Freight Services in Your City</h2>
        <p>Steel Wheel Logistics coordinates bulk commodity rail freight across major rail hubs nationwide. Select your city below to see which railroads, terminals, and commodities we handle in your area.</p>
      </div>
${stateBlocks}
    </div>
  </section>

  <!-- CTA -->
  <section class="cta-banner">
    <div class="container">
      <h2>Don't See Your City?</h2>
      <p>We coordinate rail freight across the entire U.S. rail network. Contact us for a quote — even if your city isn't listed here, we can likely help.</p>
      <a href="/contact" class="btn btn-primary">Contact Us</a>
    </div>
  </section>

  <!-- Footer -->
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
</html>`;
}

// Generate all pages
let count = 0;
let withLanesFrom = 0, withLanesInto = 0, withTransload = 0;

const BANNED = /freight broker|brokerage|3PL|intermodal|container|drayage|binding|guaranteed|local office/i;

for (const city of cities) {
  const html = generateCityPage(city);
  const outPath = join(OUTPUT_DIR, `${city.slug}.html`);
  writeFileSync(outPath, html, "utf-8");
  count++;
  if (lanesFrom(city).length) withLanesFrom++;
  if (lanesInto(city).length) withLanesInto++;
  if (nearbyFacilities(city).length) withTransload++;
  // Brand-rule tripwire: the CSS class name "container" is not prose, so the
  // check runs on the text between tags only.
  const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
  const hit = text.match(BANNED);
  if (hit) console.warn(`build-city-pages: BANNED WORD "${hit[0]}" in ${city.slug}`);
}

const indexHtml = generateIndexPage();
writeFileSync(join(OUTPUT_DIR, "index.html"), indexHtml, "utf-8");
count++;

console.log(`Generated ${count} pages (${cities.length} city pages + 1 index page) in /rail-freight/`);
console.log(`  lanes-from tables: ${withLanesFrom}  lanes-into tables: ${withLanesInto}  transload sections: ${withTransload}`);
