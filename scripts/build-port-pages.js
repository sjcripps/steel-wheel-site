#!/usr/bin/env bun
/**
 * Port page generator — the crawlable layer for the Census port-import data
 * behind the commodity-flow map's port layer.
 *
 * WHY: tools/commodity-flow-map/data/port-imports.json holds 46 ports x 22 HS
 * chapters of vessel-import value that Google never sees (client-rendered
 * map). This generates:
 *   - /ports/index.html      hub page, table of every port in the file
 *   - /ports/{slug}.html     one per selected port (top 15 by value with a
 *                            railroad, plus the ports the business targets)
 *   - ports/pages.json       read by api/sitemap.ts (same contract as
 *                            commodities/pages.json)
 *
 * Every figure on a page is quoted from port-imports.json (U.S. Census Bureau
 * International Trade API, general imports by port of entry, vessel value, YTD
 * through data_month, US$ millions). Inland-lane bullets describe flows in
 * words only — no rates, tonnages or transit times are ever emitted.
 *
 * BRAND RULES (see build-commodity-pages.js): intermodal / container / drayage
 * never appear. Gazetteer notes contain "Container-dominant" for two ports,
 * so EVERY emitted string passes through scrub(). Estimator links are
 * "indicative"; no rate is ever described as guaranteed.
 *
 * Usage: bun run scripts/build-port-pages.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { siteHeader } from "./lib/site-nav.js";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const BASE = "https://steelwheellogistics.com";

const IMPORTS = JSON.parse(
  readFileSync(join(ROOT, "tools", "commodity-flow-map", "data", "port-imports.json"), "utf-8")
);
const GAZ = JSON.parse(
  readFileSync(
    "/home/ubuntu/bots/assistant/businesses/steel-wheel/data/ports-gazetteer.json",
    "utf-8"
  )
);
const FACILITIES = JSON.parse(
  readFileSync(join(ROOT, "tools", "transload-directory", "data", "transload-v2.json"), "utf-8")
).facilities;
const HUBS = JSON.parse(
  readFileSync(join(ROOT, "tools", "commodity-flow-map", "data", "hubs.json"), "utf-8")
).hubs;
// Port-origin lane pages (generate_lane_pages.py --phase 3). Lane pages are
// noindex by design (June 2026), so this table is how a visitor reaches them.
let LANES = [];
try {
  LANES = JSON.parse(readFileSync(join(ROOT, "rates", "lanes.json"), "utf-8"))
    .filter((l) => l.source === "port" && l.url && l.rate);
} catch (e) { console.warn("build-port-pages: rates/lanes.json missing; no priced-lanes tables"); }
// Census port name -> origin_city used in lanes.json
const LANE_CITY_ALIAS = { "Norfolk-Newport News": "Norfolk", "New York": "New York City" };
function portLanes(port) {
  const city = port.name.split(",")[0].trim();
  const oc = LANE_CITY_ALIAS[city] || city;
  return LANES.filter((l) => l.origin_city === oc && l.origin_state === port.state)
    .sort((a, b) => b.rate - a.rate);
}
const COMMODITY_LABEL = { steel: "Steel", plastic: "Plastic pellets", chemicals: "Chemicals", fertilizer: "Fertilizer", paper: "Paper", lumber: "Lumber", grain: "Grain", cement: "Cement", sugar: "Sugar" };

/* ------------------------------------------------------------------ *
 * Selection: top 15 by total vessel value that have >=1 railroad, plus the
 * ports the business specifically targets (matched on "City, St" prefix and
 * state so Wilmington NC never collides with Wilmington DE).
 * ------------------------------------------------------------------ */
const TOP_N = 15;
const TARGETED = [
  ["Gramercy", "LA"], ["Tampa", "FL"], ["Wilmington", "NC"], ["Mobile", "AL"],
  ["Baltimore", "MD"], ["Philadelphia", "PA"], ["Port Arthur", "TX"],
  ["Beaumont", "TX"], ["Galveston", "TX"],
];

const RAILROAD_FULL = {
  BNSF: "BNSF Railway", UP: "Union Pacific", CN: "CN", CPKC: "CPKC",
  NS: "Norfolk Southern", CSX: "CSX", FEC: "Florida East Coast Railway",
};

/* Inland-lane copy per HS chapter. Words only: destinations and consignee
 * types, national in scope. Nothing here is a rate, a tonnage or a time. */
const LANE_COPY = {
  "72": "Imported steel slab, coil and plate moves inland to mills, pipe makers and service centers in the Ohio Valley, Texas, the Southeast and the Upper Midwest.",
  "73": "Imported line pipe, tubular goods and fabricated steel moves to pipe yards, fabricators and energy basins in Texas, Oklahoma, the Rockies and the Appalachian shale region.",
  "31": "Imported urea, DAP, MAP and potash rails in covered hoppers to inland fertilizer warehouses across the Corn Belt, the Plains and the Mississippi Delta ahead of each planting season.",
  "25": "Imported cement, clinker, salt and sulfur moves to ready-mix terminals, distribution silos and processing plants in growing metro markets and the industrial Midwest.",
  "44": "Imported lumber and panels ride centerbeam flats and boxcars to building-materials yards near housing markets in the Midwest, Northeast and Sun Belt.",
  "39": "Imported resin and polymer moves in covered hoppers and boxcars to compounders and converters across the Midwest, Southeast and Northeast.",
  "26": "Imported ores, concentrates and slag move in open-top and covered hoppers to smelters, refiners, cement plants and steel mills inland.",
  "27": "Imported crude, refined products and petroleum coke move in tank cars and hoppers to refineries, blending terminals, cement kilns and power plants inland.",
  "47": "Imported market pulp moves in boxcars to tissue, paper and packaging mills in the Southeast, Midwest and Northeast.",
  "48": "Imported paper and paperboard moves in boxcars to converters, printers and packaging plants in metro markets nationwide.",
  "28": "Imported caustic soda, acids and other inorganic chemicals move in tank cars to chemical plants, water utilities and manufacturers inland.",
  "29": "Imported alcohols, solvents and chemical intermediates move in tank cars to chemical, pharmaceutical and coatings plants along the Gulf Coast, the Ohio Valley and the Northeast.",
  "76": "Imported aluminum ingot, billet and coil moves in gondolas and boxcars to extruders, rolling mills and automotive suppliers in the Midwest, Southeast and Texas.",
  "10": "Imported grain and rice move in covered hoppers to flour mills, feed mills and food processors inland.",
  "12": "Imported oilseeds move in covered hoppers to crush plants and feed mills in the Midwest and Southeast.",
  "17": "Imported raw sugar moves in covered hoppers to cane refineries and food processors; refined sugar then rails to bakeries and beverage plants nationwide.",
  "09": "Imported green coffee and tea move in boxcars to roasters and distribution centers in the Midwest, Northeast and Texas.",
  "08": "Imported fruit and nuts move in refrigerated boxcars to produce distribution centers serving the Midwest and Northeast.",
  "02": "Imported meat moves in refrigerated boxcars to processors and cold-storage distribution centers inland.",
  "68": "Imported stone, tile and plaster products move in boxcars and gondolas to building-materials distributors in growing metro markets.",
  "40": "Imported natural rubber and rubber goods move in boxcars to tire plants and manufacturers in the Southeast, Ohio Valley and Midwest.",
  "70": "Imported glass and glassware move in boxcars to construction, automotive and packaging supply chains inland.",
};

/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Brand scrubber. Extends build-commodity-pages.js deIntermodal() to the two
// other banned words, because the port gazetteer's notes say
// "Container-dominant" for Los Angeles and Long Beach.
function scrub(s) {
  return String(s ?? "")
    .replace(/intermodal\s+(hub|terminal|yard|facility|traffic|freight)/gi, "multimodal $1")
    .replace(/intermodal/gi, "multimodal")
    .replace(/container-dominant/gi, "boxed-cargo dominant")
    .replace(/containeri[sz]ed/gi, "boxed")
    .replace(/containers?/gi, "boxed cargo")
    .replace(/drayage/gi, "local truck transfer");
}
const BANNED = /intermodal|container|drayage|binding|guaranteed rate/i;

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8, p = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * p) / 2) ** 2 +
    Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(((lon2 - lon1) * p) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function musd(v) {
  const n = Number(v) || 0;
  if (n >= 100) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}M`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
}
function musdWords(v) {
  const n = Number(v) || 0;
  return `about $${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 1 })} million`;
}

function monthLabel(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  const names = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  return `${names[(m || 1) - 1]} ${y}`;
}
const DATA_MONTH = monthLabel(IMPORTS.data_month);
const CHAPTERS = IMPORTS.chapters;
const GAZ_CHAPTERS = GAZ.chapters || {};

function chapterName(hs) {
  return (CHAPTERS[hs] && CHAPTERS[hs].name) || (GAZ_CHAPTERS[hs] && GAZ_CHAPTERS[hs].name) || `HS ${hs}`;
}
// Only link to a commodity page that exists on disk.
function commodityLink(hs) {
  const id = (CHAPTERS[hs] && CHAPTERS[hs].commodity_id) ||
    (GAZ_CHAPTERS[hs] && GAZ_CHAPTERS[hs].commodity_id) || null;
  if (!id) return null;
  if (!existsSync(join(ROOT, "commodities", `${id}.html`))) return null;
  return { href: `/commodities/${id}`, label: `${id.replace(/-/g, " ")} by rail` };
}

function cityOf(name) { return String(name).split(",")[0].trim(); }
function slugOf(city) {
  return city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function railroadsFull(rrs) {
  return rrs.map((r) => (RAILROAD_FULL[r] && RAILROAD_FULL[r] !== r) ? `${RAILROAD_FULL[r]} (${r})` : r);
}
function railroadList(rrs) {
  const names = rrs.map((r) => RAILROAD_FULL[r] || r);
  if (names.length <= 1) return names.join("");
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

function nearbyFacilities(port, maxMi = 30, limit = 8) {
  const rank = (f) =>
    (f.tier === "verified" ? 0 : 2) +
    ({ high: 0, probable: 1, possible: 2 }[f.rail_confidence] ?? 3) +
    (f.capabilities && f.capabilities.length ? 0 : 1);
  return FACILITIES
    .filter((f) => typeof f.lat === "number" && typeof f.lng === "number")
    .filter((f) => f.rail_confidence !== "unlikely" && f.rail_proximity !== "not-rail-served")
    .filter((f) => !BANNED.test(`${f.name} ${f.city} ${(f.capabilities || []).join(" ")}`))
    .map((f) => ({ f, d: haversineMi(port.lat, port.lon, f.lat, f.lng) }))
    .filter((x) => x.d <= maxMi)
    .sort((a, b) => rank(a.f) - rank(b.f) || a.d - b.d)
    .slice(0, limit);
}

function nearbyHub(port, maxMi = 20) {
  let best = null;
  for (const h of HUBS) {
    const d = haversineMi(port.lat, port.lon, h.lat, h.lon);
    if (d <= maxMi && (!best || d < best.d)) best = { h, d };
  }
  if (!best) return null;
  const slug = best.h.slug.replace(/intermodal/g, "multimodal");  // same rule as build-commodity-pages.js
  if (!existsSync(join(ROOT, "rail-hubs", `${slug}.html`))) return null;
  return { slug, name: scrub(best.h.name), href: `/rail-hubs/${slug}` };
}

/* ------------------------------------------------------------------ */

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

const SOURCE_LINE = `Source: U.S. Census Bureau, International Trade API, general imports by port of entry, vessel value, year to date through ${DATA_MONTH}. Steel Wheel Logistics analysis.`;

function breadcrumb(items) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, url], i) => ({
      "@type": "ListItem", position: i + 1, name, item: url,
    })),
  };
}

function trimDescription(s, max = 155) {
  s = scrub(s).replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "") + "…";
}

/* ------------------------------------------------------------------ */

function portPage(port) {
  const city = cityOf(port.name);
  const st = port.state;
  const slug = port.slug;
  const url = `${BASE}/ports/${slug}`;
  const portName = `Port of ${city}`;
  const rrs = port.railroads || [];
  const top = (port.top || []).filter(([hs, v]) => Number(v) > 0);
  const top3 = top.slice(0, 3);
  const note = scrub((GAZ.ports[port.name] && GAZ.ports[port.name].note) || port.note || "");
  const facilities = nearbyFacilities(port);
  const hub = nearbyHub(port);
  const rateLink = `/tools/rail-rate-quote?origin_city=${encodeURIComponent(city)}&origin_state=${encodeURIComponent(st)}`;

  const title = `${portName}, ${st} Rail Freight: Imports and Inland Rail Lanes | Steel Wheel Logistics`;
  const description = trimDescription(
    `${portName}, ${st} vessel imports YTD through ${DATA_MONTH}: ` +
    top3.map(([hs]) => chapterName(hs).toLowerCase()).join(", ") +
    `. Railroads, nearby rail transload and inland rail lanes.`
  );

  // Lead paragraph — facts only from the data files.
  const topSentence = top3.length
    ? `The largest vessel import${top3.length > 1 ? "s" : ""} here, year to date through ${DATA_MONTH}, ${top3.length > 1 ? "are" : "is"} ` +
      top3.map(([hs, v]) => `${chapterName(hs).toLowerCase()} (${musdWords(v)})`).join(", ") +
      ` among the ${IMPORTS.chapter_order.length} commodity chapters Steel Wheel Logistics tracks.`
    : `The Census data shows no vessel imports at this port in the ${IMPORTS.chapter_order.length} commodity chapters Steel Wheel Logistics tracks, year to date through ${DATA_MONTH}.`;
  const rrSentence = rrs.length
    ? `The port district is reached by ${railroadList(rrs)}, which is what makes the ${city} gateway useful for shippers whose plants sit hundreds of miles inland.`
    : `No Class I railroad reaches this port district directly, so inland moves start with a truck leg to the nearest rail-served terminal.`;
  const noteSentence = note ? ` ${note.replace(/\.?$/, ".")}` : "";

  // Inland lanes: one bullet per top chapter (up to 6), padded to 4.
  const laneBullets = top.slice(0, 6)
    .map(([hs]) => LANE_COPY[hs] ? { text: LANE_COPY[hs] } : null)
    .filter(Boolean);
  const pad = [
    `Bulk and break-bulk cargo unloaded at ${city} terminals transfers to railcars at dockside or at a nearby transload facility and moves to inland consignees${rrs.length ? ` on ${railroadList(rrs)} lanes` : ""}.`,
    `Railcars that deliver inland freight into ${city} reposition with outbound export loads, so import lanes are often paired with export moves to keep equipment cycles balanced.`,
    `Shippers consolidating imports from ${city} with domestic production can route both through the same inland terminal, which simplifies car supply and switching.`,
  ];
  for (const p of pad) if (laneBullets.length < 4) laneBullets.push({ text: p });

  // FAQs — answers built only from data-file facts.
  const topHs = top3[0] ? top3[0][0] : null;
  const faqs = [
    {
      q: `Which railroads serve the ${portName}?`,
      a: rrs.length
        ? `${railroadList(rrs)} reach the ${city}, ${st} port district.${note ? ` ${note.replace(/\.?$/, ".")}` : ""}`
        : `No Class I railroad reaches the ${city}, ${st} port district directly; inland rail moves start at the nearest rail-served terminal.`,
    },
    {
      q: `What does the ${portName} import the most?`,
      a: top3.length
        ? `By vessel value, year to date through ${DATA_MONTH}, the largest import${top3.length > 1 ? "s" : ""} at ${city} among the chapters Steel Wheel Logistics tracks ${top3.length > 1 ? "are" : "is"} ` +
          top3.map(([hs, v]) => `${chapterName(hs).toLowerCase()} (${musdWords(v)})`).join(", ") +
          `. Total tracked vessel imports were ${musdWords(port.total_musd)}. Source: U.S. Census Bureau International Trade API.`
        : `The Census port-of-entry data shows no vessel imports at ${city} in the tracked chapters, year to date through ${DATA_MONTH}.`,
    },
    ...(topHs ? [{
      q: `Can I move imported ${chapterName(topHs).toLowerCase()} from ${city} inland by rail?`,
      a: `The largest tracked vessel import group at ${city} is ${chapterName(topHs).toLowerCase()} (${musdWords(top3[0][1])} year to date through ${DATA_MONTH})` +
        (rrs.length ? `, and the port district is reached by ${railroadList(rrs)}. ` : `. `) +
        (facilities.length
          ? `The Steel Wheel transload directory lists ${facilities.length === 8 ? "at least 8" : facilities.length} rail-served transload facilit${facilities.length === 1 ? "y" : "ies"} within 30 miles of the port. `
          : `The Steel Wheel transload directory has no rail-served transload facility within 30 miles of the port, so the transfer point would be at the port itself or farther inland. `) +
        `Use the indicative rail rate tool for a first estimate and a lane audit to confirm routing; estimates are indicative until confirmed with the serving railroad.`,
    }] : []),
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": url,
        url,
        name: title,
        description,
        isPartOf: { "@type": "WebSite", name: "Steel Wheel Logistics", url: BASE },
        about: {
          "@type": "Place",
          name: `${portName}, ${st}`,
          address: { "@type": "PostalAddress", addressLocality: city, addressRegion: st, addressCountry: "US" },
          geo: { "@type": "GeoCoordinates", latitude: port.lat, longitude: port.lon },
        },
        publisher: { "@type": "Organization", name: "Steel Wheel Logistics", url: BASE },
      },
      breadcrumb([["Home", `${BASE}/`], ["Ports", `${BASE}/ports`], [portName, url]]),
      {
        "@type": "FAQPage",
        mainEntity: faqs.map((f) => ({
          "@type": "Question",
          name: scrub(f.q),
          acceptedAnswer: { "@type": "Answer", text: scrub(f.a) },
        })),
      },
    ],
  };

  const body = `
  <main class="page-main" style="max-width:900px;margin:0 auto;padding:24px 16px">
    <nav style="font-size:0.85em;color:#666;margin-bottom:12px">
      <a href="/">Home</a> &rsaquo; <a href="/ports">Ports</a> &rsaquo; ${esc(portName)}
    </nav>
    <h1>${esc(portName)}, ${esc(st)} rail freight: what lands here and where it goes inland</h1>
    <p style="font-size:1.05em">${esc(scrub(topSentence))} ${esc(scrub(rrSentence))}${esc(noteSentence)}
      This page pairs the Census import data behind the
      <a href="/tools/commodity-flow-map">Commodity Flow Map</a> port layer with the
      railroads, transload capacity and inland lanes that turn a vessel arrival into a rail move.</p>

    <h2>Top imports by vessel</h2>
    <p>Vessel imports at ${esc(city)}, ${esc(st)}, year to date through ${esc(DATA_MONTH)}, US$ millions,
      for the commodity chapters Steel Wheel Logistics tracks.</p>
    <div class="railroad-item" style="margin:20px 0;padding:16px;background:#f9fafb;border-radius:6px">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="text-align:left;border-bottom:1px solid #ddd">
            <th style="padding:6px 8px">HS chapter</th>
            <th style="padding:6px 8px">Commodity group</th>
            <th style="padding:6px 8px;text-align:right">Vessel imports YTD</th>
          </tr>
        </thead>
        <tbody>
${top.length ? top.map(([hs, v]) => {
    const link = commodityLink(hs);
    const nm = esc(scrub(chapterName(hs)));
    return `          <tr><td style="padding:6px 8px">${esc(hs)}</td><td style="padding:6px 8px">${nm}${link ? ` <span style="font-size:0.9em;color:#555">&middot; <a href="${esc(link.href)}">${esc(link.label)}</a></span>` : ""}</td><td style="padding:6px 8px;text-align:right">${esc(musd(v))}</td></tr>`;
  }).join("\n") : `          <tr><td colspan="3" style="padding:6px 8px">No vessel imports recorded in the tracked chapters.</td></tr>`}
          <tr style="border-top:1px solid #ddd;font-weight:600"><td style="padding:6px 8px" colspan="2">Total, tracked chapters</td><td style="padding:6px 8px;text-align:right">${esc(musd(port.total_musd))}</td></tr>
        </tbody>
      </table>
    </div>

    <h2>Railroads at the port</h2>
${rrs.length ? `    <ul>
${railroadsFull(rrs).map((r) => `      <li>${esc(r)}</li>`).join("\n")}
    </ul>
    <p>Where more than one Class I reaches a port, the routing choice sets the inland
      rate, the interchange points and which inland terminals are single-line. That is
      the first question a <a href="/tools/lane-audit">lane audit</a> answers.</p>` :
    `    <p>No Class I railroad is listed for this port district. Inland rail moves start with a
      truck leg to the nearest rail-served terminal; the
      <a href="/tools/transload-directory">Transload Directory</a> lists the options.</p>`}

    <h2>Rail transload and terminal capacity nearby</h2>
${facilities.length ? `    <p>Rail-served transload facilities within 30 miles of the port, from the Steel Wheel
      <a href="/tools/transload-directory">Transload Directory</a>:</p>
    <ul>
${facilities.map(({ f, d }) => {
      const caps = (f.capabilities || []).slice(0, 4).map(scrub).join(", ");
      const kind = f.facility_type ? scrub(f.facility_type) : "";
      const detail = [kind, caps].filter(Boolean).join("; ");
      return `      <li><strong>${esc(scrub(f.name))}</strong> &mdash; ${esc(f.city)}, ${esc(f.state)} (${d.toFixed(0)} mi)${detail ? `: ${esc(detail)}` : ""}</li>`;
    }).join("\n")}
    </ul>
    <p style="font-size:0.9em;color:#666">Distances are straight-line from the port's Census coordinates. Capabilities are as listed by the operator; confirm before routing.</p>` :
    `    <p>The Steel Wheel <a href="/tools/transload-directory">Transload Directory</a> lists no rail-served
      transload facility within 30 miles of this port's Census coordinates. The transfer to rail would
      happen at the port terminal itself or at the nearest inland rail-served site; search the directory
      by state to find it.</p>`}

    <h2>Typical inland lanes from this port</h2>
    <p>How the top import groups typically move inland from ${esc(city)}. These describe the flow, not a
      price: run the <a href="${esc(rateLink)}">indicative rail rate from ${esc(city)}</a> for a first number.</p>
    <ul>
${laneBullets.map((b) => `      <li>${esc(scrub(b.text))} <a href="${esc(rateLink)}">Indicative rail rate from ${esc(city)}</a>.</li>`).join("\n")}
    </ul>

${(() => { const ls = portLanes(port); if (!ls.length) return ""; return `
    <h3>Priced lanes from ${esc(city)}</h3>
    <p>Indicative single-car estimates from our rate model for lanes we have already priced out of this port. Not a quote; the serving railroad confirms the rate.</p>
    <table class="data-table" style="width:100%">
      <thead><tr><th>Destination</th><th>Commodity</th><th style="text-align:right">Rail miles</th><th style="text-align:right">Indicative rate / car</th></tr></thead>
      <tbody>
${ls.map((l) => `        <tr><td><a href="${esc(l.url.replace(/\/$/, ""))}">${esc(l.dest_city)}, ${esc(l.dest_state)}</a></td><td>${esc(COMMODITY_LABEL[l.commodity_id] || l.commodity_id)}</td><td style="text-align:right">${Math.round(l.miles).toLocaleString()}</td><td style="text-align:right">$${Math.round(l.rate).toLocaleString()}</td></tr>`).join("\n")}
      </tbody>
    </table>`; })()}

    <h2>Common questions</h2>
${faqs.map((f) => `    <h3 style="margin-bottom:4px">${esc(scrub(f.q))}</h3>\n    <p style="margin-top:0">${esc(scrub(f.a))}</p>`).join("\n")}

    <section class="cta-section" style="margin-top:32px;padding:20px;background:#f4f6f8;border-radius:6px">
      <h2 style="margin-top:0">Moving imports inland from ${esc(city)}?</h2>
      <p>Steel Wheel Logistics is an outsourced rail department: we route, price and manage rail moves
        from the port to your plant. Rate estimates are indicative only until confirmed with the serving railroad.</p>
      <p style="margin:16px 0 8px">
        <a class="btn btn-primary" href="/tools/lane-audit">Run a lane audit</a>
      </p>
      <p style="margin:0">
        <a href="/tools/commodity-flow-map">See the port on the commodity flow map</a>${hub ? ` &middot; <a href="${esc(hub.href)}">${esc(hub.name)} rail hub profile</a>` : ""} &middot; <a href="/ports">All ports</a>
      </p>
    </section>

    <p style="font-size:0.85em;color:#666;margin-top:28px">${esc(SOURCE_LINE)}</p>
  </main>`;

  return { url, html: head({ title, description, canonical: url, jsonLd }) + body + FOOTER };
}

function indexPage(allPorts, built) {
  const url = `${BASE}/ports`;  // no trailing slash — Vercel cleanUrls 308s the slashed form
  const title = "U.S. Ports for Inland Rail Freight: Vessel Imports by Port | Steel Wheel Logistics";
  const description = trimDescription(
    `Vessel imports at ${allPorts.length} U.S. ports of entry, YTD through ${DATA_MONTH}, with the railroads that reach each port and how imports move inland by rail.`
  );
  const sorted = [...allPorts].sort((a, b) => (b.total_musd || 0) - (a.total_musd || 0));
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        "@id": url, url, name: title, description,
        isPartOf: { "@type": "WebSite", name: "Steel Wheel Logistics", url: BASE },
        mainEntity: {
          "@type": "ItemList",
          numberOfItems: built.length,
          itemListElement: built.map((p, i) => ({
            "@type": "ListItem", position: i + 1,
            url: `${BASE}/ports/${p.slug}`, name: `Port of ${cityOf(p.name)}, ${p.state}`,
          })),
        },
      },
      breadcrumb([["Home", `${BASE}/`], ["Ports", url]]),
    ],
  };

  const body = `
  <main class="page-main" style="max-width:900px;margin:0 auto;padding:24px 16px">
    <nav style="font-size:0.85em;color:#666;margin-bottom:12px">
      <a href="/">Home</a> &rsaquo; Ports
    </nav>
    <h1>U.S. ports for inland rail freight</h1>
    <p style="font-size:1.05em">
      A port is where an import shipper's rail lane starts. What lands at each gateway, and
      which Class I railroads reach the docks, decides whether steel, fertilizer, resin or
      pulp can go straight to a railcar or needs a transfer first. This page ranks
      ${allPorts.length} U.S. ports of entry by vessel-import value in the
      ${IMPORTS.chapter_order.length} commodity chapters Steel Wheel Logistics tracks, the same
      data behind the port layer of the <a href="/tools/commodity-flow-map">Commodity Flow Map</a>.
      Ports with a profile page link through to their railroads, nearby rail transload
      capacity and typical inland lanes.
    </p>
    <p style="font-size:0.9em;color:#555">Data basis: U.S. Census Bureau International Trade API, general
      imports by port of entry, vessel value, year to date through ${esc(DATA_MONTH)}, US$ millions.
      Totals cover the tracked chapters only, not all imports at the port.</p>

    <h2>Ports ranked by tracked vessel imports</h2>
    <div class="railroad-item" style="margin:20px 0;padding:16px;background:#f9fafb;border-radius:6px;overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="text-align:left;border-bottom:1px solid #ddd">
            <th style="padding:6px 8px">Port</th>
            <th style="padding:6px 8px">Railroads</th>
            <th style="padding:6px 8px;text-align:right">Vessel imports YTD</th>
            <th style="padding:6px 8px">Top chapter</th>
          </tr>
        </thead>
        <tbody>
${sorted.map((p) => {
    const city = cityOf(p.name);
    const label = `${esc(city)}, ${esc(p.state)}`;
    const cell = p.slug ? `<a href="/ports/${esc(p.slug)}">Port of ${label}</a>` : `Port of ${label}`;
    const topHs = p.top && p.top[0] ? p.top[0][0] : null;
    const topCell = topHs ? `${esc(scrub(chapterName(topHs)))} (${esc(musd(p.top[0][1]))})` : "&mdash;";
    return `          <tr><td style="padding:6px 8px">${cell}</td><td style="padding:6px 8px">${esc((p.railroads || []).join(", ") || "none listed")}</td><td style="padding:6px 8px;text-align:right">${esc(musd(p.total_musd))}</td><td style="padding:6px 8px">${topCell}</td></tr>`;
  }).join("\n")}
        </tbody>
      </table>
    </div>

    <h2>Why ports matter for inland rail</h2>
    <p>Most of what arrives by vessel is not consumed at the coast. Steel coil goes to
      service centers and stampers, fertilizer to warehouses ahead of planting, resin to
      converters, pulp to paper mills, all of them hundreds of miles inland. Whether that
      inland leg is rail or truck depends on three things visible on each port page: which
      railroads reach the docks, whether a rail-served transload terminal sits close to the
      berth, and whether the receiving plant can take a railcar. Steel Wheel Logistics works
      that question for shippers nationwide; start with a
      <a href="/tools/lane-audit">lane audit</a> or an
      <a href="/tools/rail-rate-quote">indicative rail rate</a>.</p>

    <h2>Related</h2>
    <ul>
      <li><a href="/tools/commodity-flow-map">Commodity Flow Map</a> &mdash; the interactive port and hub layer this page is built from</li>
      <li><a href="/commodities">Commodities by rail</a> &mdash; railcar type, tons per car and flows for each commodity</li>
      <li><a href="/tools/transload-directory">Transload Directory</a> &mdash; rail-served transfer facilities near every port</li>
    </ul>

    <p style="font-size:0.85em;color:#666;margin-top:28px">${esc(SOURCE_LINE)}</p>
  </main>`;
  return { url, html: head({ title, description, canonical: url, jsonLd }) + body + FOOTER };
}

/* ------------------------------ build ------------------------------ */

const allPorts = IMPORTS.ports.map((p) => ({ ...p, slug: null }));
const byValue = [...allPorts].sort((a, b) => (b.total_musd || 0) - (a.total_musd || 0));
const selected = new Set(byValue.filter((p) => (p.railroads || []).length).slice(0, TOP_N));
for (const [city, st] of TARGETED) {
  const hit = allPorts.find((p) => cityOf(p.name).toLowerCase() === city.toLowerCase() && p.state === st);
  if (hit) selected.add(hit);
  else console.warn(`targeted port not in port-imports.json: ${city}, ${st}`);
}
// Assign slugs; a collision (same city in two states) gets the state appended.
const slugCount = {};
for (const p of selected) { const s = slugOf(cityOf(p.name)); slugCount[s] = (slugCount[s] || 0) + 1; }
for (const p of selected) {
  const s = slugOf(cityOf(p.name));
  p.slug = slugCount[s] > 1 ? `${s}-${p.state.toLowerCase()}` : s;
}
const built = byValue.filter((p) => p.slug);

mkdirSync(join(ROOT, "ports"), { recursive: true });
const pages = [];

const idx = indexPage(allPorts, built);
writeFileSync(join(ROOT, "ports", "index.html"), idx.html);
pages.push({ loc: idx.url, priority: "0.8" });

for (const p of built) {
  const page = portPage(p);
  writeFileSync(join(ROOT, "ports", `${p.slug}.html`), page.html);
  pages.push({ loc: page.url, priority: "0.7", port: p.name, slug: p.slug });
}

writeFileSync(join(ROOT, "ports", "pages.json"), JSON.stringify({ generated: true, pages }, null, 2));

console.log(`Built ${built.length} port pages + index (${allPorts.length} ports in the table).`);
console.log(`slugs: ${built.map((p) => p.slug).join(", ")}`);
console.log(`pages.json: ${pages.length} URLs for the sitemap.`);
let bad = 0;
for (const f of ["index", ...built.map((p) => p.slug)]) {
  const html = readFileSync(join(ROOT, "ports", `${f}.html`), "utf-8");
  const m = html.match(BANNED);
  if (m) { console.error(`BANNED WORD "${m[0]}" in ports/${f}.html`); bad++; }
}
console.log(bad ? `${bad} pages FAILED the brand-word check` : "Brand-word check: clean.");
if (bad) process.exit(1);
