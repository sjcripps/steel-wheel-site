#!/usr/bin/env bun
/**
 * Build script for Steel Wheel Logistics rail-served business SEO pages.
 *
 * Cloned from scripts/build-transload-pages.js conventions (same chrome,
 * disclaimer pattern, esc/slug helpers, ItemList JSON-LD, pages.json manifest).
 *
 * Source of truth: the canonical confidence-tiered merged dataset built in
 * Phase A1 of the Rail Data Foundation —
 *   /home/ubuntu/bots/assistant/businesses/steel-wheel/data/railserved-merged-v1.json
 * (2,542 records; evidence tiers: spur_verified = OSM spur geometry + NARN
 * ownership, state_rail_plan = page-cited shipper listings, afandpa = AF&PA
 * member mill list, named_spur = low confidence, never published here).
 *
 * Pages emitted to /rail-served/:
 *   - index.html                     hub, links every state page
 *   - {state}.html                   one per SE-7 state (AL AR FL GA LA MS TN),
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
const DATA_FILE =
  process.argv[2] ||
  "/home/ubuntu/bots/assistant/businesses/steel-wheel/data/railserved-merged-v1.json";
const OUTPUT_DIR = join(ROOT, "rail-served");

const GTAG_ID = "G-RSWDYHVY7Z";
const BASE = "https://steelwheellogistics.com";

// SE-7 wave. Slugs double as /transload/{slug} sibling links.
const STATES = {
  AL: "Alabama", AR: "Arkansas", FL: "Florida", GA: "Georgia",
  LA: "Louisiana", MS: "Mississippi", TN: "Tennessee",
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
const records = merged.records || [];
const today = new Date().toISOString().split("T")[0];

const high = records.filter((r) => r.confidence === "high");
const highSE = high.filter((r) => STATES[r.state]);
const highNonSE = high.filter((r) => !STATES[r.state]);
if (highNonSE.length) {
  // Contract: high confidence requires spur geometry, which only exists for the
  // SE-7 wave. A high record outside it means the merge changed under us.
  console.error(
    `FATAL: ${highNonSE.length} high-confidence records outside SE-7: ` +
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
    }
  }
  return bits.join(" &middot; ");
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
  const rrs = (r.serving_railroads || []).length
    ? (r.serving_railroads || [])
        .map((m) => (CLASS_I_NAMES[m] ? `${esc(CLASS_I_NAMES[m])}` : esc(m)))
        .join(", ")
    : "not identified from map data";
  return `      <div class="railroad-item" style="margin-bottom:14px">
        <h3 style="margin:0 0 4px;font-size:1.05em">${esc(r.name)}</h3>
        <div style="color:#555;font-size:0.9em">${r.city ? esc(r.city) + ", " : ""}${esc(r.state)}</div>
        <div><strong>Serving railroad${(r.serving_railroads || []).length > 1 ? "s" : ""}:</strong> ${rrs}</div>
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

  // Group by first serving railroad; order groups by size, then mark.
  const byRR = new Map();
  for (const r of list) {
    const key = (r.serving_railroads || [])[0] || "—";
    if (!byRR.has(key)) byRR.set(key, []);
    byRR.get(key).push(r);
  }
  const groups = [...byRR.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])
  );
  // "Not identified" group renders last regardless of size.
  groups.sort((a, b) => (a[0] === "—") - (b[0] === "—"));

  const groupHtml = groups
    .map(([mark, rs]) => {
      const label =
        mark === "—"
          ? "Serving railroad not identified from map data"
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
    `${Object.keys(STATES).length} Southeastern states, grouped by serving railroad ` +
    `with published evidence for every listing. Steel Wheel Logistics.`;

  const body = `
  <main class="city-page">
    <section>
      <h1>Rail-Served Businesses by State</h1>
      <p>
        ${placedHigh} verified rail-served businesses and industrial sites across
        ${Object.keys(STATES).length} Southeastern states. Every listing is
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

// 2. Named-record gate: Leaf River with OAR attribution on the Mississippi page.
const msHtml = readFileSync(join(OUTPUT_DIR, "mississippi.html"), "utf-8");
if (!(msHtml.includes("Georgia Pacific Leaf River Mill") && /Leaf River[\s\S]{0,400}OAR/.test(msHtml))) {
  console.error("  GATE FAILED: Leaf River / OAR missing from mississippi.html");
  failures++;
} else {
  console.log("  named-record gate: Leaf River + OAR on mississippi.html OK");
}

// 3. Banned-word gate (brand rules): intermodal / drayage / container never in
// our copy. Facility proper names from the dataset are data, not copy — mask
// exact names before scanning so a banned word we WROTE still fails.
const properNames = new Set(
  records.filter((r) => /intermodal|drayage|container/i.test(r.name)).map((r) => esc(r.name))
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
