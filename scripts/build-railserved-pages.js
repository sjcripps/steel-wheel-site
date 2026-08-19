#!/usr/bin/env bun
/**
 * Build script for Steel Wheel Logistics rail-served business SEO pages.
 *
 * Cloned from scripts/build-transload-pages.js conventions (same chrome,
 * disclaimer pattern, esc/slug helpers, ItemList JSON-LD, pages.json manifest).
 *
 * Source of truth: the canonical confidence-tiered merged dataset built in
 * the Rail Data Foundation —
 *   /home/ubuntu/bots/assistant/businesses/steel-wheel/data/railserved-merged-v3.json
 * (11,319 records; evidence tiers: spur_verified = OSM spur geometry + NARN
 * ownership, state_rail_plan = page-cited shipper listings, afandpa = AF&PA
 * member mill list, named_spur = low confidence, never published here).
 * v2 fallback: railserved-merged-v2.json (36-state wave, 9,777 records);
 * v1 fallback: railserved-merged-v1.json (SE-7 wave, 2,542 records) — pass
 * either as argv[2] to roll back.
 *
 * v2 display rules enforced here:
 *   - in_default_view: false (rail-adjacent-utility) records are dropped at load.
 *   - serving_display ("freight operator unresolved (passenger-owned track)")
 *     renders as that text — never a bare mark (marks are empty on these).
 *   - serving_qualifier ("plant/terminal trackage — Class I via interchange" /
 *     "US Government trackage") renders next to the mark, never a bare mark.
 *   - serving_flags "non-freight-owner" renders as its flag text (marks cleared
 *     upstream).
 *   - XXXX/XMDT sentinels + passenger-owner marks are stripped upstream and
 *     asserted absent here.
 *
 * Pages emitted to /rail-served/:
 *   - index.html                     hub, links every state page
 *   - {state}.html                   one per geometry state (48 states in v3),
 *                                    HIGH-confidence records only, grouped by
 *                                    serving railroad, each entry with an
 *                                    evidence note
 *   - paper-mills.html               AF&PA-verified member mills across all
 *                                    states (medium confidence, labeled as
 *                                    association-verified)
 * Plus rail-served/pages.json, read by api/sitemap.ts (degrade-to-empty).
 *
 * These are THIRD-PARTY facilities. The copy never implies SWL owns, operates,
 * or has commercial terms at any of them.
 *
 * Brand rules (see the brand-voice-rules skill): SWL is bulk carload. The words
 * intermodal / container / drayage never appear in OUR COPY — negative keywords
 * for this brand. Some facility proper names contain "Container" (packaging
 * plants, e.g. Dart Container Corp) — those are data, not copy, and are kept
 * verbatim; the self-check masks exact dataset names before scanning so any
 * banned word in copy still fails the build.
 *
 * Usage: bun run scripts/build-railserved-pages.js
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
// v2 fallback: .../railserved-merged-v2.json (36-state wave)
// v1 fallback: .../railserved-merged-v1.json (SE-7 wave)
const DATA_FILE =
  process.argv[2] ||
  // SOURCE WAS STALE: this said v3 while the LIVE pages were built from v4.
// Rebuilding with the old constant silently dropped 548 records and the
// ports[] data — caught 2026-08-19 when a rebuilt Alabama page lost six
// carriers and a state-plan citation off Kimberly Clark Mobile.
"/home/ubuntu/bots/assistant/businesses/steel-wheel/data/railserved-merged-v4.json";
const OUTPUT_DIR = join(ROOT, "rail-served");

const GTAG_ID = "G-RSWDYHVY7Z";
const BASE = "https://steelwheellogistics.com";

// v3 geometry-state wave (48 states, matches merged.states_geometry —
// the full lower 48). Slugs double as /transload/{slug} sibling links —
// all 48 exist there.
const STATES = {
  AL: "Alabama", AR: "Arkansas", AZ: "Arizona", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida",
  GA: "Georgia", IA: "Iowa", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  MA: "Massachusetts", MD: "Maryland", ME: "Maine", MI: "Michigan",
  MN: "Minnesota", MO: "Missouri", MS: "Mississippi", MT: "Montana",
  NC: "North Carolina", ND: "North Dakota", NE: "Nebraska", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NV: "Nevada", NY: "New York",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VA: "Virginia", VT: "Vermont",
  WA: "Washington", WI: "Wisconsin", WV: "West Virginia", WY: "Wyoming",
};

// Full names for grouping headers on the national paper-mills page. Only
// codes verified present in the AF&PA tier need to appear here; anything
// unmapped falls back to the code and is reported at the end.
const STATE_NAMES = {
  AL: "Alabama", AR: "Arkansas", CT: "Connecticut", FL: "Florida", GA: "Georgia",
  IN: "Indiana", KY: "Kentucky", LA: "Louisiana", MA: "Massachusetts",
  MI: "Michigan", MO: "Missouri", MS: "Mississippi", NC: "North Carolina",
  NH: "New Hampshire", NY: "New York", OH: "Ohio", OR: "Oregon",
  PA: "Pennsylvania", SC: "South Carolina", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VA: "Virginia", WA: "Washington", WI: "Wisconsin",
};

// Reporting-mark expansions for the Class I roads (short lines and regionals
// keep their FRA reporting mark — expanding those from a code table would risk
// fabricated names).
const CLASS_I_NAMES = {
  BNSF: "BNSF Railway", CN: "CN (Canadian National)", CPRS: "CPKC (Canadian Pacific Kansas City)",
  CSXT: "CSX Transportation", NS: "Norfolk Southern", UP: "Union Pacific",
};

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const slug = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// ── Load + partition ────────────────────────────────────────────────────────
const merged = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
// v2: rail-adjacent-utility false positives (in_default_view: false) never
// reach any customer-facing surface.
const records = (merged.records || []).filter((r) => r.in_default_view !== false);
const today = new Date().toISOString().split("T")[0];

// Geometry-state drift gate: the merge's declared geometry wave must equal
// the STATES table above, or pages silently go missing.
if (Array.isArray(merged.states_geometry)) {
  const declared = [...merged.states_geometry].sort().join(",");
  const ours = Object.keys(STATES).sort().join(",");
  if (declared !== ours) {
    console.error(`FATAL: STATES table != merged.states_geometry\n  ours:     ${ours}\n  declared: ${declared}`);
    process.exit(1);
  }
}

// Sentinel + passenger-owner marks are stripped upstream in the v2/v3 merges;
// tripwire here so a regression can never render one as a serving railroad.
// v3 additions (western-state passenger/transit/heritage owners):
// DRTD, RTDC, TRAX, NMRX, NNRX, NSRM.
// This list is now MERGED from the same file the Python builders read, because
// maintaining it here as a third copy is what let SEPA through: SEPTA is a
// commuter authority, and "Served by SEPA (7)" was live on the Pennsylvania
// page until 2026-08-19. The literal set below stays as the floor — an
// unreadable file can only fail to ADD marks, never silently drop one.
const EXCLUDED_MARKS_FILE =
  "/home/ubuntu/bots/assistant/businesses/steel-wheel/data/reference/excluded-marks.json";
const BANNED_MARKS = new Set([
  "XXXX", "XMDT", "LI", "NJT", "SCAX", "NIRC", "NICD", "VPRA", "MNCW",
  "PATH", "MARC", "MBTA", "SDNR", "JPBX", "SMRT", "MTS",
  "DRTD", "RTDC", "TRAX", "NMRX", "NNRX", "NSRM",
]);
try {
  const excl = JSON.parse(readFileSync(EXCLUDED_MARKS_FILE, "utf8"));
  for (const section of ["sentinel", "passenger", "non_freight"]) {
    for (const mark of Object.keys(excl[section] || {})) {
      if (mark && !mark.startsWith("_")) BANNED_MARKS.add(mark);
    }
  }
  console.log(`excluded-marks.json merged: ${BANNED_MARKS.size} banned marks`);
} catch (e) {
  console.error(`WARNING: ${EXCLUDED_MARKS_FILE} unusable (${e.message}); ` +
                `using the built-in list only`);
}
for (const r of records) {
  const bad = (r.serving_railroads || []).filter((m) => BANNED_MARKS.has(m));
  if (bad.length) {
    console.error(`FATAL: banned mark(s) ${bad.join(",")} on ${r.name} (${r.state})`);
    process.exit(1);
  }
}

const high = records.filter((r) => r.confidence === "high");
const highSE = high.filter((r) => STATES[r.state]);
const highNonSE = high.filter((r) => !STATES[r.state]);
if (highNonSE.length) {
  // Contract: high confidence requires spur geometry, which only exists for the
  // geometry-state wave. A high record outside it means the merge changed under us.
  console.error(
    `FATAL: ${highNonSE.length} high-confidence records outside the geometry-state wave: ` +
      highNonSE.map((r) => `${r.name} (${r.state})`).join(", ")
  );
  process.exit(1);
}

// AF&PA-verified mills that are NOT already placed on a state page as
// high-confidence — i.e. the medium-confidence association-verified tier,
// national coverage.
const afandpaMills = records.filter(
  (r) => r.confidence === "medium" && r.evidence.some((e) => e.tier === "afandpa")
);

const byState = new Map();
for (const r of highSE) {
  if (!byState.has(r.state)) byState.set(r.state, []);
  byState.get(r.state).push(r);
}

// ── Evidence notes ──────────────────────────────────────────────────────────
function evidenceNote(r, stateName) {
  const bits = [];
  for (const ev of r.evidence) {
    if (ev.tier === "spur_verified") {
      bits.push("spur-verified via map data");
    } else if (ev.tier === "state_rail_plan") {
      const page = typeof ev.page_or_osm === "number" ? ` (p.${ev.page_or_osm})` : "";
      bits.push(`listed in the ${stateName} State Rail Plan${page}`);
    } else if (ev.tier === "afandpa") {
      bits.push("AF&amp;PA member mill (association-verified)");
    } else if (ev.tier === "named_spur") {
      bits.push("named spur in map data (unverified)");
    }
  }
  return bits.join(" &middot; ");
}

// ── v2 serving-railroad display (never a bare mark on flagged records) ──────
// serving_display and the non-freight-owner flag come with marks already
// cleared upstream; serving_qualifier accompanies a real mark and must render
// with it.
const NO_RR_KEY = "—";
const NON_FREIGHT_KEY = "non-freight owner";

function servingGroupKey(r) {
  if (r.serving_display) return r.serving_display;
  const first = (r.serving_railroads || [])[0];
  if (first) return first;
  if ((r.serving_flags || []).includes("non-freight-owner")) return NON_FREIGHT_KEY;
  return NO_RR_KEY;
}

function servingLineHtml(r) {
  if (r.serving_display) return esc(r.serving_display);
  const marks = r.serving_railroads || [];
  if (!marks.length) {
    return (r.serving_flags || []).includes("non-freight-owner")
      ? NON_FREIGHT_KEY
      : "not identified from map data";
  }
  const names = marks.map((m) => esc(CLASS_I_NAMES[m] || m)).join(", ");
  return r.serving_qualifier
    ? `${names} <span style="color:#666;font-size:0.9em">(${esc(r.serving_qualifier)})</span>`
    : names;
}

function nearestClassIFromAfandpa(r) {
  for (const ev of r.evidence) {
    if (ev.tier === "afandpa") {
      const m = /nearest Class I \(NOT serving-road claim\):\s*([A-Z]+)/.exec(ev.source_detail || "");
      if (m) return m[1];
    }
  }
  return "";
}

// ── Shared chrome (cloned from build-transload-pages.js) ────────────────────
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
  <script async src="https://www.googletagmanager.com/gtag/js?id=${GTAG_ID}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${GTAG_ID}');
  </script>
  <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
  </script>
</head>
<body>

  <header class="site-header">
    <div class="header-inner">
      <a href="/" class="logo">
        <div class="logo-icon">
          <img src="/images/logo.png" alt="Steel Wheel Logistics" width="40" height="40">
        </div>
        <div class="logo-text">
          <span class="logo-name">Steel Wheel Logistics</span>
          <span class="logo-tagline">Rail Freight Simplified</span>
        </div>
      </a>
      <button class="nav-toggle" onclick="document.querySelector('.main-nav').classList.toggle('open')" aria-label="Toggle navigation">
        <span></span><span></span><span></span>
      </button>
      <nav class="main-nav">
        <a href="/">Home</a>
        <a href="/services">Services</a>
        <a href="/blog">Blog</a>
        <a href="/courses">Courses</a>
        <a href="/contact">Contact Us</a>
      </nav>
    </div>
  </header>
`;
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

// Every generated page carries the same disclaimer. These are third-party
// facilities identified from published and public evidence — saying otherwise
// would be a fabricated commercial relationship.
const DISCLAIMER = `
    <p style="font-size:0.85em;color:#666;margin-top:28px">
      Listings are compiled from public map data (OpenStreetMap spur geometry
      cross-referenced with FRA rail-network ownership), published state rail
      plans, and industry association member lists, and are provided for
      reference. Steel Wheel Logistics does not own or operate these facilities,
      and a listing does not imply a commercial relationship. Rail-service
      status changes &mdash; confirm capabilities and active service directly
      with the operator and serving railroad.
    </p>`;

function cta(context) {
  return `
    <section class="cta-section" style="margin-top:32px;padding:20px;background:#f4f6f8;border-radius:6px">
      <h2 style="margin-top:0">Planning a move ${esc(context)}?</h2>
      <p>
        Search and map every listing in the
        <a href="/tools/rail-served-businesses">Rail-Served Business Directory</a>,
        or run an indicative estimate for your lane with the
        <a href="/tools/rail-rate-quote">Rail Rate Quote tool</a>. We do not
        guarantee rates &mdash; the estimator is indicative, and we will talk
        through your lane before quoting.
      </p>
    </section>`;
}

function entryCard(r, stateName) {
  return `      <div class="railroad-item" style="margin-bottom:14px">
        <h3 style="margin:0 0 4px;font-size:1.05em">${esc(r.name)}</h3>
        <div style="color:#555;font-size:0.9em">${r.city ? esc(r.city) + ", " : ""}${esc(r.state)}</div>
        <div><strong>Serving railroad${(r.serving_railroads || []).length > 1 ? "s" : ""}:</strong> ${servingLineHtml(r)}</div>
        <div style="color:#666;font-size:0.85em;font-style:italic">Evidence: ${evidenceNote(r, stateName)}</div>
      </div>`;
}

function itemListLd(list, name, url) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name,
    url,
    about: "Rail-served businesses and industrial sites",
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: list.length,
      itemListElement: list.slice(0, 100).map((r, i) => ({
        "@type": "ListItem",
        position: i + 1,
        item: {
          "@type": "LocalBusiness",
          name: r.name,
          address: {
            "@type": "PostalAddress",
            ...(r.city ? { addressLocality: r.city } : {}),
            addressRegion: r.state,
          },
        },
      })),
    },
  };
}

// ── Render ──────────────────────────────────────────────────────────────────
if (existsSync(OUTPUT_DIR)) rmSync(OUTPUT_DIR, { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

const written = [];
let placedHigh = 0;

// State pages
for (const [code, stateName] of Object.entries(STATES)) {
  const list = (byState.get(code) || []).slice();
  const stSlug = slug(stateName);
  const url = `${BASE}/rail-served/${stSlug}`;
  const title = `Rail-Served Businesses in ${stateName} | Steel Wheel Logistics`;
  const description =
    `${list.length} verified rail-served businesses and industrial sites in ${stateName}, ` +
    `grouped by serving railroad. Every listing is spur-verified from map data or ` +
    `cited to the ${stateName} State Rail Plan. Steel Wheel Logistics.`;

  // Group by serving-display key (first mark, or the v2 qualifier text for
  // flagged records); order groups by size, then key.
  const byRR = new Map();
  for (const r of list) {
    const key = servingGroupKey(r);
    if (!byRR.has(key)) byRR.set(key, []);
    byRR.get(key).push(r);
  }
  const groups = [...byRR.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])
  );
  // Qualifier-text groups render after real marks; "not identified" last.
  const SPECIAL_KEYS = new Set([
    NO_RR_KEY, NON_FREIGHT_KEY,
    "freight operator unresolved (passenger-owned track)",
  ]);
  groups.sort(
    (a, b) =>
      SPECIAL_KEYS.has(a[0]) - SPECIAL_KEYS.has(b[0]) ||
      (a[0] === NO_RR_KEY) - (b[0] === NO_RR_KEY)
  );

  const groupHtml = groups
    .map(([mark, rs]) => {
      const label =
        mark === NO_RR_KEY
          ? "Serving railroad not identified from map data"
          : mark === NON_FREIGHT_KEY
          ? "Non-freight owner trackage"
          : SPECIAL_KEYS.has(mark)
          ? esc(mark.charAt(0).toUpperCase() + mark.slice(1))
          : `Served by ${esc(CLASS_I_NAMES[mark] || mark)}`;
      return `    <section>
      <h2>${label} (${rs.length})</h2>
      <div class="railroads-grid">
${rs
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((r) => entryCard(r, stateName))
  .join("\n")}
      </div>
    </section>`;
    })
    .join("\n");

  const siblings = Object.entries(STATES)
    .filter(([c]) => c !== code)
    .map(([, n]) => `<a href="/rail-served/${slug(n)}">${esc(n)}</a>`)
    .join(" &middot; ");

  const body = `
  <main class="city-page">
    <section>
      <h1>Rail-Served Businesses in ${esc(stateName)}</h1>
      <p>
        ${list.length} rail-served ${list.length === 1 ? "business" : "businesses"}
        and industrial sites in ${esc(stateName)}, grouped by serving railroad.
        Every listing here is high-confidence: either spur-verified from public
        map data (OpenStreetMap spur geometry cross-referenced with FRA
        rail-network ownership) or listed as a rail shipper in the
        ${esc(stateName)} State Rail Plan &mdash; each entry carries its evidence.
        A rail-served neighbor is the strongest signal that rail economics can
        work at a location near you.
      </p>
      <p>
        Moving freight to or from ${esc(stateName)}?
        <a href="/transload/${stSlug}">Transload facilities in ${esc(stateName)}</a>
        move bulk freight between railcar and truck when a site has no siding of
        its own, and the
        <a href="/tools/rail-rate-quote">Rail Rate Quote tool</a> gives an
        indicative estimate for your lane.
      </p>
    </section>

${groupHtml}${DISCLAIMER}
${cta(`through ${stateName}`)}
    <section>
      <h2>Other states</h2>
      <p>${siblings} &middot; <a href="/rail-served/paper-mills">AF&amp;PA paper &amp; pulp mills</a> &middot; <a href="/rail-served/">All states</a></p>
    </section>
  </main>
`;

  writeFileSync(
    join(OUTPUT_DIR, `${stSlug}.html`),
    head({ title, description, canonical: url, jsonLd: itemListLd(list, title, url) }) + body + FOOTER
  );
  written.push({ loc: `/rail-served/${stSlug}`, priority: "0.6" });
  placedHigh += list.length;
}

// Paper mills page (AF&PA association-verified, national, medium confidence)
{
  const url = `${BASE}/rail-served/paper-mills`;
  const title = "AF&PA Member Paper & Pulp Mills with Rail Access | Steel Wheel Logistics";
  const description =
    `${afandpaMills.length} paper and pulp mills from the AF&PA member mill list, ` +
    `across ${new Set(afandpaMills.map((r) => r.state)).size} states — association-verified ` +
    `rail users in the forest products supply chain. Steel Wheel Logistics.`;

  const byMillState = new Map();
  for (const r of afandpaMills) {
    if (!byMillState.has(r.state)) byMillState.set(r.state, []);
    byMillState.get(r.state).push(r);
  }
  const unmapped = [...byMillState.keys()].filter((st) => !STATE_NAMES[st]);
  if (unmapped.length) {
    console.warn(`  WARNING: paper-mills states with no verified name (code shown raw): ${unmapped.join(", ")}`);
  }

  const millCard = (r) => {
    const nearest = nearestClassIFromAfandpa(r);
    return `      <div class="railroad-item" style="margin-bottom:14px">
        <h3 style="margin:0 0 4px;font-size:1.05em">${esc(r.name)}</h3>
        <div style="color:#555;font-size:0.9em">${r.city ? esc(r.city) + ", " : ""}${esc(r.state)}</div>
${nearest ? `        <div><strong>Nearest Class I:</strong> ${esc(CLASS_I_NAMES[nearest] || nearest)} <span style="color:#666;font-size:0.85em">(proximity only, not a serving-road claim)</span></div>\n` : ""}        <div style="color:#666;font-size:0.85em;font-style:italic">Evidence: AF&amp;PA member mill list (association-verified)</div>
      </div>`;
  };

  const sections = [...byMillState.entries()]
    .sort()
    .map(
      ([st, rs]) => `    <section>
      <h2>${esc(STATE_NAMES[st] || st)} (${rs.length})</h2>
      <div class="railroads-grid">
${rs.slice().sort((a, b) => a.name.localeCompare(b.name)).map(millCard).join("\n")}
      </div>
    </section>`
    )
    .join("\n");

  const body = `
  <main class="city-page">
    <section>
      <h1>AF&amp;PA Member Paper &amp; Pulp Mills</h1>
      <p>
        ${afandpaMills.length} paper and pulp mills verified against the American
        Forest &amp; Paper Association member mill list, across
        ${new Set(afandpaMills.map((r) => r.state)).size} states. Forest products
        &mdash; pulp, paper, packaging board, lumber &mdash; are one of the
        heaviest rail-using commodity groups, and mills are classic carload
        shippers. These listings are association-verified (medium confidence):
        the mill and parent company are confirmed on the AF&amp;PA member list,
        and the nearest Class I railroad is noted for orientation only &mdash;
        it is not a claim about which road serves the plant. Mills whose rail
        spur is additionally verified from map data appear on their
        <a href="/rail-served/">state page</a> instead.
      </p>
    </section>

${sections}${DISCLAIMER}
${cta("of pulp, paper or packaging board")}
    <section>
      <h2>Browse by state</h2>
      <p>${Object.values(STATES)
        .map((n) => `<a href="/rail-served/${slug(n)}">${esc(n)}</a>`)
        .join(" &middot; ")} &middot; <a href="/rail-served/">All states</a></p>
    </section>
  </main>
`;

  writeFileSync(
    join(OUTPUT_DIR, "paper-mills.html"),
    head({ title, description, canonical: url, jsonLd: itemListLd(afandpaMills, title, url) }) + body + FOOTER
  );
  written.push({ loc: "/rail-served/paper-mills", priority: "0.5" });
}

// Hub
{
  const url = `${BASE}/rail-served/`;
  const title = "Rail-Served Businesses by State | Steel Wheel Logistics";
  const description =
    `${placedHigh} verified rail-served businesses and industrial sites across ` +
    `${Object.keys(STATES).length} states, grouped by serving railroad ` +
    `with published evidence for every listing. Steel Wheel Logistics.`;

  const body = `
  <main class="city-page">
    <section>
      <h1>Rail-Served Businesses by State</h1>
      <p>
        ${placedHigh} verified rail-served businesses and industrial sites across
        ${Object.keys(STATES).length} states. Every listing is
        high-confidence &mdash; spur-verified from public map data (OpenStreetMap
        spur geometry cross-referenced with FRA rail-network ownership), listed
        as a rail shipper in a state rail plan, or both &mdash; and each entry
        shows its evidence. Browse by state below, search the full dataset in the
        <a href="/tools/rail-served-businesses">Rail-Served Business Directory</a>,
        or get an indicative estimate with the
        <a href="/tools/rail-rate-quote">Rail Rate Quote tool</a>.
      </p>
    </section>

    <section>
      <h2>Browse by state</h2>
      <div class="related-links-grid">
${Object.entries(STATES)
  .map(
    ([code, n]) =>
      `        <div><a href="/rail-served/${slug(n)}">${esc(n)}</a> &mdash; ${(byState.get(code) || []).length}</div>`
  )
  .join("\n")}
        <div><a href="/rail-served/paper-mills">AF&amp;PA paper &amp; pulp mills</a> &mdash; ${afandpaMills.length}</div>
      </div>${DISCLAIMER}
    </section>
${cta("by rail")}
  </main>
`;

  writeFileSync(
    join(OUTPUT_DIR, "index.html"),
    head({
      title,
      description,
      canonical: url,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: title,
        url,
        description,
      },
    }) + body + FOOTER
  );
  written.unshift({ loc: "/rail-served", priority: "0.8" });
}

// Manifest consumed by api/sitemap.ts
writeFileSync(
  join(OUTPUT_DIR, "pages.json"),
  JSON.stringify({ generated_at: today, pages: written }, null, 2) + "\n"
);

// ── Gates ───────────────────────────────────────────────────────────────────
let failures = 0;

// 1. Placed-count gate: every high-confidence record must land on a state page.
console.log(`rail-served pages built:`);
console.log(`  state pages: ${Object.keys(STATES).length}`);
console.log(`  paper-mills: 1  (${afandpaMills.length} AF&PA mills)`);
console.log(`  hub:         1`);
console.log(`  total URLs:  ${written.length}`);
console.log(`  high-confidence in dataset: ${high.length}`);
console.log(`  high-confidence placed:     ${placedHigh}`);
if (placedHigh !== high.length) {
  console.error(`  GATE FAILED: placed ${placedHigh} != dataset high count ${high.length}`);
  failures++;
}

// 2. Named-record gates: Leaf River/OAR on Mississippi, Nucor Berkeley/PR on
// South Carolina (a v2 wave state — proves the new states really rendered).
const msHtml = readFileSync(join(OUTPUT_DIR, "mississippi.html"), "utf-8");
if (!(msHtml.includes("Georgia Pacific Leaf River Mill") && /Leaf River[\s\S]{0,400}OAR/.test(msHtml))) {
  console.error("  GATE FAILED: Leaf River / OAR missing from mississippi.html");
  failures++;
} else {
  console.log("  named-record gate: Leaf River + OAR on mississippi.html OK");
}
const scHtml = readFileSync(join(OUTPUT_DIR, "south-carolina.html"), "utf-8");
if (!(scHtml.includes("Nucor Steel Berkeley") && /Nucor Steel Berkeley[\s\S]{0,400}\bPR\b/.test(scHtml))) {
  console.error("  GATE FAILED: Nucor Steel Berkeley / PR missing from south-carolina.html");
  failures++;
} else {
  console.log("  named-record gate: Nucor Steel Berkeley + PR on south-carolina.html OK");
}
// v3 named-record gate: Intrepid Potash/BNSF on New Mexico (a western-wave
// state — proves the 12 new states really rendered).
const nmHtml = readFileSync(join(OUTPUT_DIR, "new-mexico.html"), "utf-8");
if (!(nmHtml.includes("Intrepid Potash") && /Intrepid Potash[\s\S]{0,400}BNSF/.test(nmHtml))) {
  console.error("  GATE FAILED: Intrepid Potash / BNSF missing from new-mexico.html");
  failures++;
} else {
  console.log("  named-record gate: Intrepid Potash + BNSF on new-mexico.html OK");
}

// 3. Banned-word gate (brand rules): intermodal / drayage / container never in
// our copy. Facility proper names from the dataset are data, not copy — mask
// exact names before scanning so a banned word we WROTE still fails.
// Mask both the HTML-escaped form (body copy) and the raw form (JSON-LD embeds
// names unescaped — an "&" in a proper name defeats an esc()-only mask).
const properNames = new Set(
  records
    .filter((r) => /intermodal|drayage|container/i.test(r.name))
    .flatMap((r) => [esc(r.name), r.name])
);
let bad = 0;
for (const p of written) {
  const file = p.loc === "/rail-served" ? "index.html" : `${p.loc.replace("/rail-served/", "")}.html`;
  let html = readFileSync(join(OUTPUT_DIR, file), "utf-8");
  for (const n of properNames) html = html.split(n).join("[facility-name]");
  if (/intermodal|drayage|\bcontainer\b/i.test(html)) {
    console.error(`  BANNED WORD in rail-served/${file}`);
    bad++;
  }
}
if (bad) failures++;
console.log(bad ? `  ${bad} pages FAILED the brand-word check` : "  brand-word check: clean (facility proper names masked as data).");

// 4. Non-empty gate: every manifest URL has a non-empty file on disk.
let missing = 0;
for (const p of written) {
  const file = p.loc === "/rail-served" ? "index.html" : `${p.loc.replace("/rail-served/", "")}.html`;
  const full = join(OUTPUT_DIR, file);
  if (!existsSync(full) || readFileSync(full, "utf-8").length < 2000) {
    console.error(`  GATE FAILED: missing/empty ${full}`);
    missing++;
  }
}
if (missing) failures++;
else console.log(`  file gate: all ${written.length} pages exist and are non-empty.`);

if (failures) {
  console.error(`${failures} GATE(S) FAILED`);
  process.exit(1);
}
console.log("all gates passed.");
