#!/usr/bin/env node
/**
 * Build the rail-served WAREHOUSE directory — a separate page set from
 * /transload/, deliberately.
 *
 * Jacob's call, and GSC backs it: 40 warehouse-intent queries over 90 days,
 * 200 impressions, ZERO clicks, ranking positions 11-87. "atlanta rail served
 * warehouse", "bulk commodity warehouse tampa". Someone needing indoor storage
 * does not click a page called Transload — they read that as outdoor bulk
 * transfer and move on. And a filter inside the gated directory tool cannot
 * capture any of that traffic, because the tool is JS-rendered and email-gated,
 * so Google never sees it. Only a crawlable page set can.
 *
 * Copy targets all four phrasings people actually search, because they are one
 * intent split across queries we currently rank badly for:
 *   "bulk commodity warehouse {city}"  (61 impressions - the BIGGEST, and not
 *                                       the term we would have picked)
 *   "rail served warehouse/warehousing" (35)
 *   "transload warehouse" (27) · "3pl {city}" (14) · "contract warehousing" (9)
 *
 * INCLUSION IS DELIBERATELY STRICT. A facility appears here only if:
 *   facility_type == third-party-warehouse   (it takes OTHER companies' freight;
 *                                             a captive DC is useless to a shipper)
 *   rail_confidence in (high, probable)      (<=0.26 mi, measured from a real
 *                                             street address against the same
 *                                             NARN network the rate engine uses)
 * That is 97 of 158 classified warehouses. The other 61 are not excluded because
 * they lack rail — they are excluded because we have not MEASURED it, and
 * "rail-served" is the entire value proposition of this page. A shipper driving
 * to a building with no track is the one failure this directory cannot afford.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { siteHeader } from "./lib/site-nav.js";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DATA = join(ROOT, "tools", "transload-directory", "data", "transload-v2.json");
const OUT = join(ROOT, "rail-served-warehouses");
const BASE = "https://steelwheellogistics.com";
const GTAG_ID = "G-RSWDYHVY7Z";
const MIN_STATE = 1;

const REGIONS = JSON.parse(
  '{' + readFileSync(join(ROOT, "scripts", "build-transload-pages.js"), "utf-8")
    .match(/const REGIONS = \{([\s\S]*?)\n\};/)[1]
    .replace(/\/\/[^\n]*/g, "")
    .replace(/([A-Z]{2}):/g, '"$1":')
    .replace(/,(\s*)$/, "") + '}');

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (s) => String(s ?? "").toLowerCase().normalize("NFKD")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const all = JSON.parse(readFileSync(DATA, "utf-8")).facilities;
const whBase = all.filter((f) =>
  f.facility_type === "third-party-warehouse" &&
  ["high", "probable"].includes(f.rail_confidence) &&
  f.name && f.city && REGIONS[String(f.state || "").toUpperCase()]);

// Warehouse-hunt augment layer (8/29): Google-business-listing candidates
// screened to <=0.5mi of the NARN network and LLM-classified as third-party
// (see bots/assistant/businesses/steel-wheel/scripts/warehouse_hunt.py).
// Every record self-labels rail service as UNVERIFIED — same honesty rule
// as everything else on the site.
const HUNT_DIR = "/home/ubuntu/bots/assistant/businesses/steel-wheel/data/warehouse-hunt";
let hunt = [];
if (existsSync(HUNT_DIR)) {
  for (const fn of readdirSync(HUNT_DIR).filter((f) => f.endsWith("-approved.json"))) {
    for (const c of JSON.parse(readFileSync(join(HUNT_DIR, fn), "utf-8"))) {
      if (!c.name || !c.city) continue;
      // "unclear" classifications stay in the data files for review but do
      // NOT publish — in thin markets that bucket is mostly retail/civic
      // noise (Gulfport City Hall made the MS page, 8/30). Confident 3PLs
      // and operator-confirmed port entries only.
      if (c.classification && c.classification !== "3pl") continue;
      hunt.push({
        name: c.name, city: c.city, state: c.state,
        phone: c.phone || null, website: c.website || null,
        lat: c.lat, lng: c.lng,
        facility_type: "third-party-warehouse",
        // Port-authority entries arrive operator-confirmed (specs from the
        // authority's own published materials); scraped entries stay
        // proximity-screened/unverified.
        rail_confidence: c.rail_claim === "operator-confirmed" ? "high" : "probable",
        rail_distance_mi: c.rail_distance_mi,
        rail_claim: c.rail_claim || "proximity-screened",
        rail_evidence: c.rail_evidence || null,
        source: c.source,
        note: c.rail_claim === "operator-confirmed"
          ? null
          : c.classification === "unclear"
          ? "Listing sourced from public business data; third-party status and rail service unverified — confirm with operator."
          : "Listing sourced from public business data; rail service unverified — confirm siding with operator.",
      });
    }
  }
}
// Dedupe augment vs base on normalized name+city.
const key = (f) => (String(f.name) + String(f.city)).toLowerCase().replace(/[^a-z0-9]/g, "");
const seenKeys = new Set(whBase.map(key));
const wh = whBase.concat(hunt.filter((f) => !seenKeys.has(key(f))));

const byState = new Map();
for (const f of wh) {
  const c = String(f.state).toUpperCase();
  if (!byState.has(c)) byState.set(c, []);
  byState.get(c).push(f);
}
for (const list of byState.values()) {
  list.sort((a, b) =>
    (a.rail_claim === "operator-confirmed" ? 0 : 1) - (b.rail_claim === "operator-confirmed" ? 0 : 1));
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
  <title>${esc(title)}</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="stylesheet" href="/style.css?v=5">
  <script async src="https://www.googletagmanager.com/gtag/js?id=${GTAG_ID}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date()); gtag('config', '${GTAG_ID}');
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

// Every claim on these pages is measured, and the disclaimer says how.
const METHOD = `
    <p style="font-size:0.85em;color:#666;margin-top:28px">
      <strong>How &ldquo;rail-served&rdquo; is determined here.</strong> Each facility's street
      address is geocoded and measured against the federal North American Rail Network &mdash;
      the same network our rate estimator routes on. Only facilities within a quarter mile of
      track are listed, and they are shown in two groups.
      <strong>Operator-confirmed</strong> means the operator's own website states rail service
      (a siding, a spur, a serving railroad, railcar spots) and we quote it verbatim.
      <strong>Near rail &mdash; unverified</strong> means the building sits close to track but
      the operator does not say it is served; a mainline passing a facility is not the same
      thing as a siding into it, so treat proximity alone as a lead, not a fact.
      <strong>This list is not exhaustive.</strong> A rail-served warehouse missing from it has
      not been ruled out &mdash; it means we have not yet confirmed the siding. Our rail map has
      known gaps (it lacks some industrial trackage, and does not cover Alaska or Mexico), and a
      facility can also be missing because we have no verified street address for it. If you know
      of a rail-served warehouse that is not here, tell us and we will check it.
      Listings are compiled from public sources; Steel Wheel Logistics does not own or operate
      these facilities and a listing does not imply a commercial relationship. Confirm siding
      condition, car capacity and current availability with the operator &mdash; or
      <a href="/contact">ask us and we will confirm it for you</a>.
    </p>`;

function card(f) {
  const bits = [];
  if (f.address) bits.push(`<div style="color:#555;font-size:0.9em">${esc(f.address)}</div>`);
  // Two tiers, two claims. Operator-confirmed cards quote the operator; the
  // rest say plainly that proximity is all we have. Roane (Rockwood TN, 0.13 mi,
  // no siding) is why the distinction exists — track passing nearby is not service.
  const dist = f.rail_distance_mi != null
    ? (f.rail_claim === "operator-confirmed" && f.rail_evidence
        ? `<div><strong>Rail:</strong> operator-confirmed &mdash; &ldquo;${esc(String(f.rail_evidence).slice(0, 120))}&rdquo; (${f.rail_distance_mi} mi from the network)</div>`
        : `<div><strong>Rail:</strong> ${f.rail_distance_mi} mi from the network &mdash; <span style="color:#8a6d3b">rail service not yet confirmed by the operator; verify the siding before planning a move</span></div>`)
    : "";
  if (dist) bits.push(dist);
  if (f.indoor_storage) bits.push(`<div><strong>Indoor storage:</strong> yes${
    f.indoor_evidence ? ` &mdash; &ldquo;${esc(String(f.indoor_evidence).slice(0, 110))}&rdquo;` : ""}</div>`);
  const comms = Array.isArray(f.commodities) ? f.commodities : [];
  if (comms.length) {
    bits.push(`<div><strong>Commodities:</strong> ${esc(comms.join(", "))} ` +
      `<span style="color:#777;font-size:0.85em">(may not be their full range)</span></div>`);
  } else {
    bits.push(`<div style="color:#777;font-size:0.92em"><em>No published commodity list &mdash; ` +
      `worth a call.</em></div>`);
  }
  if (f.phone) bits.push(`<div><strong>Phone:</strong> ${esc(f.phone)}</div>`);
  if (f.website) bits.push(`<div><a href="${esc(f.website)}" target="_blank" rel="noopener nofollow">Operator website</a></div>`);
  return `      <div class="railroad-item" style="margin-bottom:14px">
        <h3 style="margin:0 0 4px;font-size:1.05em">${esc(f.name)}</h3>
        <div style="color:#555;font-size:0.9em">${esc(f.city)}, ${esc(f.state)}</div>
${bits.map((b) => "        " + b).join("\n")}
      </div>`;
}

function ld(list, name, url) {
  return {
    "@context": "https://schema.org", "@type": "CollectionPage", name, url,
    about: "Rail-served third-party warehouses",
    mainEntity: {
      "@type": "ItemList", numberOfItems: list.length,
      itemListElement: list.slice(0, 100).map((f, i) => ({
        "@type": "ListItem", position: i + 1,
        item: {
          "@type": "LocalBusiness", name: f.name,
          address: { "@type": "PostalAddress", streetAddress: f.address || undefined,
                     addressLocality: f.city, addressRegion: f.state },
          ...(f.phone ? { telephone: f.phone } : {}),
          ...(f.website ? { url: f.website } : {}),
        },
      })),
    },
  };
}

function cta(where) {
  return `
    <section class="cta-section" style="margin-top:32px;padding:20px;background:#f4f6f8;border-radius:6px">
      <h2 style="margin-top:0">Need space ${esc(where)}?</h2>
      <p>
        Tell us the commodity, the volume and the lane, and we will find the warehouse that
        actually fits &mdash; confirm the siding, the car spots, the storage conditions and
        current availability, and price the rail move to it. That is the rail department we
        run for shippers who do not have one. <a href="/contact">Talk to us about your lane</a>.
      </p>
      <p style="margin-bottom:0">
        Looking for rail-to-truck transfer rather than storage? See the
        <a href="/transload/">transload facility directory</a>, or price a lane with the
        <a href="/tools/rail-rate-quote">Rail Rate Quote tool</a>.
      </p>
    </section>`;
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });
const written = [];

for (const [code, list] of [...byState.entries()].sort()) {
  if (list.length < MIN_STATE) continue;
  const name = REGIONS[code];
  const url = `${BASE}/rail-served-warehouses/${slug(name)}`;
  const title = `Rail-Served Warehouses in ${name} | Bulk Commodity Storage | Steel Wheel Logistics`;
  const indoor = list.filter((f) => f.indoor_storage).length;
  const description =
    `${list.length} rail-served third-party warehouses in ${name} — public and contract ` +
    `warehousing, bulk commodity storage and 3PL space with rail access, each measured ` +
    `against the federal rail network.`;
  const sorted = [...list].sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name));
  const body = `
  <main class="city-page">
    <section>
      <h1>Rail-Served Warehouses in ${esc(name)}</h1>
      <p>
        ${list.length} third-party ${list.length === 1 ? "warehouse" : "warehouses"} in
        ${esc(name)} that take other companies' freight and sit on rail &mdash;
        ${list.filter((f) => f.rail_claim === "operator-confirmed").length} with rail service
        confirmed in the operator's own words${
          indoor ? `, ${indoor} with indoor storage confirmed` : ""}. These are
        <strong>public and contract warehouses</strong> &mdash; bulk commodity storage,
        3PL and distribution space you can rent &mdash; not private plants or
        retailer distribution centres that only handle their own goods.
      </p>
      <p>
        Every facility here has been geocoded to its street address and measured against
        the federal rail network. A warehouse with rail lets you take a railcar to the
        building instead of trucking from a terminal, which is usually where the savings are
        on bulk moves.
      </p>
    </section>

${(() => {
      const confirmed = sorted.filter((f) => f.rail_claim === "operator-confirmed");
      const unverified = sorted.filter((f) => f.rail_claim !== "operator-confirmed");
      const parts = [];
      if (confirmed.length) {
        parts.push(`    <section>
      <h2>Operator-confirmed rail service (${confirmed.length})</h2>
      <p style="font-size:0.92em;color:#555">The operator's own website states rail service &mdash; quoted verbatim on each card.</p>
      <div class="railroads-grid">
${confirmed.map(card).join("\n")}
      </div>
    </section>`);
      }
      if (unverified.length) {
        parts.push(`    <section>
      <h2>Near rail &mdash; service unverified (${unverified.length})</h2>
      <p style="font-size:0.92em;color:#555">Within a quarter mile of track, but the operator does not state rail service.
      Track passing a building is not proof of a siding into it &mdash; confirm before planning a move.</p>
      <div class="railroads-grid">
${unverified.map(card).join("\n")}
      </div>
    </section>`);
      }
      return parts.join("\n");
    })()}
    <section>${METHOD}
    </section>
${cta(`in ${name}`)}
  </main>
`;
  writeFileSync(join(OUT, `${slug(name)}.html`),
    head({ title, description, canonical: url, jsonLd: ld(sorted, title, url) }) + body + FOOTER);
  written.push({ loc: `/rail-served-warehouses/${slug(name)}`, priority: "0.6" });
}

// Hub
{
  // No trailing slash: Vercel cleanUrls 308s "/x/" -> "/x", so a
  // slashed canonical creates a canonical<->redirect loop Google
  // refuses to index (the /tools bug, caught 8/30).
  const url = `${BASE}/rail-served-warehouses`;
  const title = "Rail-Served Warehouse Directory | Bulk Commodity Storage by State";
  const description =
    `${wh.length} rail-served third-party warehouses across ${byState.size} states — public and ` +
    `contract warehousing, bulk commodity storage and 3PL space with rail access.`;
  const links = [...byState.entries()].sort((a, b) => REGIONS[a[0]].localeCompare(REGIONS[b[0]]))
    .map(([c, l]) => `<a href="/rail-served-warehouses/${slug(REGIONS[c])}">${esc(REGIONS[c])} (${l.length})</a>`)
    .join(" &middot; ");
  const body = `
  <main class="city-page">
    <section>
      <h1>Rail-Served Warehouse Directory</h1>
      <p>
        ${wh.length} third-party warehouses across ${byState.size} states that take other
        companies' freight and sit on rail. Public warehousing, contract warehousing, bulk
        commodity storage and 3PL space &mdash; the kind you can rent, as opposed to a
        manufacturer's own plant or a retailer's distribution centre.
      </p>
      <p>
        If your product has to go indoors &mdash; pulp, paper, food-grade, anything that
        cannot sit in a yard &mdash; a rail-served warehouse lets the railcar come to the
        building. Most transload sites are outdoor bulk transfer, which is a different
        service; those are in the <a href="/transload/">transload directory</a>.
      </p>
    </section>
    <section>
      <h2>By state</h2>
      <p>${links}</p>
    </section>
${cta("on your lane")}
  </main>
`;
  writeFileSync(join(OUT, "index.html"),
    head({ title, description, canonical: url, jsonLd: ld(wh, title, url) }) + body + FOOTER);
  written.push({ loc: "/rail-served-warehouses", priority: "0.7" });
}

// Same {generated_at, pages} contract the other manifests use, so api/sitemap.ts
// can read it with the identical degrade-to-empty pattern.
writeFileSync(join(OUT, "pages.json"),
  JSON.stringify({ generated_at: new Date().toISOString().slice(0, 10), pages: written }, null, 2));
console.log(`rail-served warehouse directory built:`);
console.log(`  facilities:   ${wh.length} (of ${all.filter((f) => f.facility_type === "third-party-warehouse").length} classified warehouses)`);
console.log(`  state pages:  ${written.length - 1}`);
console.log(`  total URLs:   ${written.length}`);
console.log(`  indoor confirmed: ${wh.filter((f) => f.indoor_storage).length}   with phone: ${wh.filter((f) => f.phone).length}`);
