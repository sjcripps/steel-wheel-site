#!/usr/bin/env bun
/**
 * Build script for Steel Wheel Logistics programmatic transload SEO pages.
 *
 * The transload directory holds 2,469 facilities but loads them client-side
 * from data/transload-v2.json, so none of it is crawlable — one indexable URL
 * for the whole dataset. This generates static pages so the data can actually
 * rank:
 *   - /transload/index.html            hub, links every region page
 *   - /transload/{state-slug}.html     one per region (e.g. /transload/texas)
 *   - /transload/{city}-{st}.html      one per city with >= MIN_CITY_FACILITIES
 *
 * It also writes transload/pages.json, which api/sitemap.ts reads to emit the
 * URLs — same arrangement as cities.json driving the /rail-freight pages.
 *
 * These are THIRD-PARTY facilities. The copy says "directory" throughout and
 * never implies SWL owns, operates, or has commercial terms at any of them.
 *
 * Brand rules (see the brand-voice-rules skill): SWL is bulk carload. The words
 * intermodal / container / drayage never appear here — they are negative
 * keywords for this brand and pull exactly the wrong traffic. Use carload,
 * unit train, transload, multimodal.
 *
 * Usage: bun run scripts/build-transload-pages.js
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DATA_FILE = join(ROOT, "tools", "transload-directory", "data", "transload-v2.json");
const OUTPUT_DIR = join(ROOT, "transload");

// A city needs at least this many facilities to earn its own page. Below it the
// page is thin content, which costs more in quality signal than the extra URL
// gains. Those facilities still appear on their region page.
const MIN_CITY_FACILITIES = 3;

const GTAG_ID = "G-RSWDYHVY7Z";
const BASE = "https://steelwheellogistics.com";

// Only regions with a verified name get a page. Anything outside this map is
// reported at the end rather than silently dropped — a page titled
// "Transload Facilities in BJ" is worse than no page.
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
  // Canadian provinces — SWL quotes cross-border carload, so these belong.
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", NS: "Nova Scotia", ON: "Ontario",
  PQ: "Quebec", SK: "Saskatchewan",
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

const titleCase = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());

// ── Load + group ────────────────────────────────────────────────────────────
const data = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
const facilities = data.facilities || [];
const today = new Date().toISOString().split("T")[0];

const skipped = new Map(); // region code -> count, for the report at the end
const byRegion = new Map();

for (const f of facilities) {
  const code = String(f.state || "").trim().toUpperCase();
  const name = String(f.name || "").trim();
  const city = String(f.city || "").trim();
  if (!name || !city || !code) continue;
  if (!REGIONS[code]) {
    skipped.set(code, (skipped.get(code) || 0) + 1);
    continue;
  }
  if (!byRegion.has(code)) byRegion.set(code, []);
  byRegion.get(code).push({ ...f, name, city, state: code });
}

// ── Shared chrome ───────────────────────────────────────────────────────────
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
// facilities pulled from published sources — saying otherwise would be a
// fabricated commercial relationship.
const DISCLAIMER = `
    <p style="font-size:0.85em;color:#666;margin-top:28px">
      Listings are compiled from published and public sources and are provided
      for reference. Steel Wheel Logistics does not own or operate these
      facilities, and a listing does not imply a commercial relationship.
      Confirm capabilities and availability directly with the operator.
    </p>`;

function cta(context) {
  return `
    <section class="cta-section" style="margin-top:32px;padding:20px;background:#f4f6f8;border-radius:6px">
      <h2 style="margin-top:0">Planning a move ${esc(context)}?</h2>
      <p>
        Filter the full directory by commodity and capability in the
        <a href="/tools/transload-directory">Transload Directory</a>, or run an
        indicative estimate for your lane with the
        <a href="/tools/rail-rate-quote">Rail Rate Quote tool</a>. We do not
        guarantee rates &mdash; the estimator is indicative, and we will talk
        through your lane before quoting.
      </p>
    </section>`;
}

function facilityCard(f) {
  const bits = [];
  if (Array.isArray(f.commodities) && f.commodities.length) {
    bits.push(`<div><strong>Commodities:</strong> ${esc(f.commodities.map(titleCase).join(", "))}</div>`);
  }
  if (Array.isArray(f.capabilities) && f.capabilities.length) {
    bits.push(`<div><strong>Capabilities:</strong> ${esc(f.capabilities.map(titleCase).join(", "))}</div>`);
  }
  if (f.phone) bits.push(`<div><strong>Phone:</strong> ${esc(f.phone)}</div>`);
  if (f.website) {
    bits.push(`<div><a href="${esc(f.website)}" target="_blank" rel="noopener nofollow">Operator website</a></div>`);
  }
  if (f.note) bits.push(`<div>${esc(f.note)}</div>`);

  return `      <div class="railroad-item" style="margin-bottom:14px">
        <h3 style="margin:0 0 4px;font-size:1.05em">${esc(f.name)}</h3>
        <div style="color:#555;font-size:0.9em">${esc(f.city)}, ${esc(f.state)}</div>
${bits.map((b) => `        ${b}`).join("\n")}
      </div>`;
}

function itemListLd(list, name, url) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name,
    url,
    about: "Rail transload facilities",
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: list.length,
      itemListElement: list.slice(0, 100).map((f, i) => ({
        "@type": "ListItem",
        position: i + 1,
        item: {
          "@type": "LocalBusiness",
          name: f.name,
          address: {
            "@type": "PostalAddress",
            addressLocality: f.city,
            addressRegion: f.state,
          },
          ...(f.phone ? { telephone: f.phone } : {}),
          ...(f.website ? { url: f.website } : {}),
        },
      })),
    },
  };
}

// ── Plan the page set ───────────────────────────────────────────────────────
const cityPages = []; // {code, city, slug, list}
const regionPages = []; // {code, name, slug, list, cities}

for (const [code, list] of [...byRegion.entries()].sort()) {
  const regionName = REGIONS[code];
  const byCity = new Map();
  for (const f of list) {
    const key = f.city.toLowerCase();
    if (!byCity.has(key)) byCity.set(key, []);
    byCity.get(key).push(f);
  }
  const cities = [...byCity.entries()]
    .map(([, fs]) => ({ city: fs[0].city, list: fs, slug: `${slug(fs[0].city)}-${code.toLowerCase()}` }))
    .sort((a, b) => b.list.length - a.list.length || a.city.localeCompare(b.city));

  for (const c of cities) {
    if (c.list.length >= MIN_CITY_FACILITIES) cityPages.push({ code, regionName, ...c });
  }
  regionPages.push({ code, name: regionName, slug: slug(regionName), list, cities });
}

// ── Render ──────────────────────────────────────────────────────────────────
if (existsSync(OUTPUT_DIR)) rmSync(OUTPUT_DIR, { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

const written = [];

// Region pages
for (const r of regionPages) {
  const url = `${BASE}/transload/${r.slug}`;
  const title = `Transload Facilities in ${r.name} | Steel Wheel Logistics`;
  const description =
    `Directory of ${r.list.length} rail transload facilities in ${r.name}, ` +
    `searchable by commodity and capability. Bulk carload transfer, storage and ` +
    `rail-to-truck handoff from Steel Wheel Logistics.`;

  const ownPage = new Set(cityPages.filter((c) => c.code === r.code).map((c) => c.slug));
  const cityLinks = r.cities
    .map((c) =>
      ownPage.has(c.slug)
        ? `<a href="/transload/${c.slug}">${esc(c.city)} (${c.list.length})</a>`
        : `<span>${esc(c.city)} (${c.list.length})</span>`
    )
    .join(" &middot; ");

  const siblings = regionPages
    .filter((x) => x.code !== r.code)
    .slice(0, 12)
    .map((x) => `<a href="/transload/${x.slug}">${esc(x.name)}</a>`)
    .join(" &middot; ");

  const body = `
  <main class="city-page">
    <section>
      <h1>Transload Facilities in ${esc(r.name)}</h1>
      <p>
        ${r.list.length} transload ${r.list.length === 1 ? "facility" : "facilities"}
        across ${r.cities.length} ${r.cities.length === 1 ? "city" : "cities"} in
        ${esc(r.name)}. Transload sites move bulk freight between railcar and
        truck, which is what lets a shipper reach a customer with no rail siding
        of their own.
      </p>
    </section>

    <section>
      <h2>Cities in ${esc(r.name)}</h2>
      <p>${cityLinks}</p>
    </section>

    <section>
      <h2>Facilities</h2>
      <div class="railroads-grid">
${r.list
  .slice()
  .sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name))
  .map(facilityCard)
  .join("\n")}
      </div>${DISCLAIMER}
    </section>
${cta(`through ${r.name}`)}
    <section>
      <h2>Other regions</h2>
      <p>${siblings} &middot; <a href="/transload/">All regions</a></p>
    </section>
  </main>
`;

  writeFileSync(
    join(OUTPUT_DIR, `${r.slug}.html`),
    head({ title, description, canonical: url, jsonLd: itemListLd(r.list, title, url) }) + body + FOOTER
  );
  written.push({ loc: `/transload/${r.slug}`, priority: "0.6" });
}

// City pages
for (const c of cityPages) {
  const url = `${BASE}/transload/${c.slug}`;
  const title = `Transload Facilities in ${c.city}, ${c.code} | Steel Wheel Logistics`;
  const description =
    `${c.list.length} rail transload ${c.list.length === 1 ? "facility" : "facilities"} in ` +
    `${c.city}, ${c.code} — bulk carload transfer, storage and rail-to-truck handoff. ` +
    `Directory from Steel Wheel Logistics.`;

  const siblings = cityPages
    .filter((x) => x.code === c.code && x.slug !== c.slug)
    .slice(0, 10)
    .map((x) => `<a href="/transload/${x.slug}">${esc(x.city)}</a>`)
    .join(" &middot; ");

  const body = `
  <main class="city-page">
    <section>
      <h1>Transload Facilities in ${esc(c.city)}, ${esc(c.code)}</h1>
      <p>
        ${c.list.length} transload ${c.list.length === 1 ? "facility" : "facilities"}
        in ${esc(c.city)}. Each one transfers bulk freight between railcar and
        truck &mdash; the practical way to serve a consignee without a private
        siding.
      </p>
    </section>

    <section>
      <h2>Facilities in ${esc(c.city)}</h2>
      <div class="railroads-grid">
${c.list.slice().sort((a, b) => a.name.localeCompare(b.name)).map(facilityCard).join("\n")}
      </div>${DISCLAIMER}
    </section>
${cta(`in and out of ${c.city}`)}
    <section>
      <h2>Nearby</h2>
      <p>
        <a href="/transload/${slug(c.regionName)}">All ${esc(c.regionName)} facilities</a>${siblings ? " &middot; " + siblings : ""}
      </p>
    </section>
  </main>
`;

  writeFileSync(
    join(OUTPUT_DIR, `${c.slug}.html`),
    head({ title, description, canonical: url, jsonLd: itemListLd(c.list, title, url) }) + body + FOOTER
  );
  written.push({ loc: `/transload/${c.slug}`, priority: "0.5" });
}

// Hub
{
  const url = `${BASE}/transload/`;
  const title = "Transload Facility Directory by State | Steel Wheel Logistics";
  const total = [...byRegion.values()].reduce((n, l) => n + l.length, 0);
  const description =
    `Directory of ${total} rail transload facilities across ${regionPages.length} states and provinces. ` +
    `Browse by region, or filter by commodity and capability in the full directory tool.`;

  const body = `
  <main class="city-page">
    <section>
      <h1>Transload Facility Directory</h1>
      <p>
        ${total} transload facilities across ${regionPages.length} states and
        provinces. Transload sites move bulk freight between railcar and truck,
        opening rail economics to shippers and receivers with no siding of their
        own. Browse by region below, or use the
        <a href="/tools/transload-directory">full directory tool</a> to filter by
        commodity and capability.
      </p>
    </section>

    <section>
      <h2>Browse by region</h2>
      <div class="related-links-grid">
${regionPages
  .map(
    (r) =>
      `        <div><a href="/transload/${r.slug}">${esc(r.name)}</a> &mdash; ${r.list.length}</div>`
  )
  .join("\n")}
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
  written.unshift({ loc: "/transload", priority: "0.8" });
}

// Manifest consumed by api/sitemap.ts
writeFileSync(
  join(OUTPUT_DIR, "pages.json"),
  JSON.stringify({ generated_at: today, pages: written }, null, 2) + "\n"
);

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`transload pages built:`);
console.log(`  regions:     ${regionPages.length}`);
console.log(`  cities:      ${cityPages.length}  (>= ${MIN_CITY_FACILITIES} facilities)`);
console.log(`  hub:         1`);
console.log(`  total URLs:  ${written.length}`);
const placed = [...byRegion.values()].reduce((n, l) => n + l.length, 0);
console.log(`  facilities placed on a page: ${placed} of ${facilities.length}`);
if (skipped.size) {
  const totalSkipped = [...skipped.values()].reduce((a, b) => a + b, 0);
  console.log(
    `  SKIPPED ${totalSkipped} facilities in ${skipped.size} unmapped regions ` +
      `(no verified region name): ${[...skipped.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ")}`
  );
  console.log(`  -> they remain searchable in the directory tool; add them to REGIONS to give them pages.`);
}
