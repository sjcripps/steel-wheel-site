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
import { siteHeader } from "./lib/site-nav.js";

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
  // Mexican states (2026-08-14) — 27 facilities (Bulkmatic de Mexico, FR
  // Terminales, Watco SLP, Lazaro Cardenas port ops...) were skipped for lack
  // of region names, invisible to search. Codes verified against the facility
  // cities themselves (Tuxpan->VL=Veracruz, Lazaro Cardenas->MH=Michoacan...).
  SL: "San Luis Potosi", EM: "Estado de Mexico", HG: "Hidalgo",
  GJ: "Guanajuato", JA: "Jalisco", QA: "Queretaro", BJ: "Baja California",
  SO: "Sonora", TM: "Tamaulipas", VL: "Veracruz", DF: "Mexico City",
  MH: "Michoacan",
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

// Every generated page carries the same disclaimer. These are third-party
// facilities pulled from published sources — saying otherwise would be a
// fabricated commercial relationship.
const DISCLAIMER = `
    <p style="font-size:0.85em;color:#666;margin-top:28px">
      Listings are compiled from published and public sources and are provided
      for reference. Steel Wheel Logistics does not own or operate these
      facilities, and a listing does not imply a commercial relationship.
      Confirm capabilities and availability directly with the operator.
      <strong>Commodity lists here are not exhaustive.</strong> Some are drawn from
      railroad network directories that record broad categories, and many
      operators publish nothing at all &mdash; an empty or short list means we have
      no record, not that the facility cannot handle your freight. If your
      commodity is not shown, ask them, or
      <a href="/contact">ask us and we will find out</a>.
    </p>`;

// The old CTA sold "filter the full directory by commodity and capability" —
// which is exactly what the on-page filter bar now does for free, so it read as
// a link to something you'd just finished doing. Sell what this page genuinely
// can't do instead: the service (we shortlist and vet), and the directory's
// real edge (every region on one map, for when the right transload isn't in the
// state you started in).
function cta(context) {
  return `
    <section class="cta-section" style="margin-top:32px;padding:20px;background:#f4f6f8;border-radius:6px">
      <h2 style="margin-top:0">Planning a move ${esc(context)}?</h2>
      <p>
        A listing is a starting point, not a vetted option. Tell us the lane and
        the commodity and we will shortlist the transloads that actually handle
        it, confirm capability and availability with the operator, and price the
        move &mdash; that is the rail department we run for shippers who do not
        have one. <a href="/contact">Talk to us about your lane</a>.
      </p>
      <p style="margin-bottom:0">
        Prefer to keep looking? The
        <a href="/tools/transload-directory">full Transload Directory</a> puts
        every facility we track across all regions on one map, which helps when
        the right site is not in the state you started in. Or run an indicative
        estimate with the
        <a href="/tools/rail-rate-quote">Rail Rate Quote tool</a> &mdash; the
        estimator is indicative and we will talk through your lane before
        quoting.
      </p>
    </section>`;
}

// `note` carries an internal provenance trail — "phone from operator website
// 2026-08-14", "website repointed to homepage 2026-08-15 (old page removed)",
// "⚠ website unreachable ... (dns)". That is real audit value and STAYS in the
// dataset, but it was being printed verbatim on the public card: 781 of the
// 1,199 populated notes read as maintenance chatter to a shipper. Drop any
// dash-delimited clause carrying an ISO date and keep the descriptive ones, so
// "on Northwest Oklahoma Railroad — phone from operator website 2026-08-14"
// becomes "on Northwest Oklahoma Railroad". Checked against all 2,585 records:
// 418 useful notes survive, 781 are fully suppressed, 0 dates leak through.
const NOTE_SPLIT = /\s+[—–]\s+|\s+-\s+/;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
function publicNote(note) {
  const raw = String(note || "").trim();
  if (!raw) return "";
  return raw
    .split(NOTE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s && !ISO_DATE.test(s))
    .join(" — ");
}

function facilityCard(f) {
  const bits = [];
  const comms = Array.isArray(f.commodities) ? f.commodities : [];
  const caps = Array.isArray(f.capabilities) ? f.capabilities : [];
  const note = publicNote(f.note);
  // A commodity list is never the operator's full book. Three different things
  // produce one, with very different confidence, and none of them is complete:
  //   hand-curated   — someone confirmed it
  //   web-extracted  — the operator's own site said it, verbatim
  //   rebulk-category— a railroad directory recorded a broad category (measured
  //                    55-78% precision against verbatim evidence)
  // And plenty of real transloads publish nothing at all — no website means no
  // list, not no capability. Presenting any of these as definitive would be the
  // false precision this whole dataset has been built to avoid.
  const fromDirectory = String(f.commodities_source || "").startsWith("rebulk-category");
  if (comms.length) {
    const note = fromDirectory
      ? "listed by a railroad directory &mdash; may not be their full range"
      : "may not be their full range";
    bits.push(
      `<div><strong>Commodities:</strong> ${esc(comms.map(titleCase).join(", "))}` +
      ` <span style="color:#777;font-size:0.85em">(${note})</span></div>`);
  } else {
    bits.push(
      `<div style="color:#777;font-size:0.92em"><em>No published commodity list &mdash; ` +
      `many transloads handle more than they advertise. Worth a call.</em></div>`);
  }
  if (caps.length) {
    bits.push(`<div><strong>Capabilities:</strong> ${esc(caps.map(titleCase).join(", "))}</div>`);
  }
  if (f.phone) bits.push(`<div><strong>Phone:</strong> ${esc(f.phone)}</div>`);
  if (f.website) {
    bits.push(`<div><a href="${esc(f.website)}" target="_blank" rel="noopener nofollow">Operator website</a></div>`);
  }
  if (note) bits.push(`<div>${esc(note)}</div>`);

  // data-* attributes drive the client-side filter below. Pre-lowercased and
  // pipe-delimited so filtering is a substring/equality test with no parsing.
  const lc = (v) => String(v || "").toLowerCase();
  const blob = [f.name, f.city, note, comms.join(" "), caps.join(" ")].join(" ").toLowerCase();
  const attrs = [
    `data-city="${esc(lc(f.city))}"`,
    `data-tier="${esc(lc(f.tier))}"`,
    `data-phone="${f.phone ? "1" : "0"}"`,
    `data-comm="${esc(comms.map(lc).join("|"))}"`,
    `data-cap="${esc(caps.map(lc).join("|"))}"`,
    `data-text="${esc(blob)}"`,
  ].join(" ");

  return `      <div class="railroad-item tl-card" ${attrs} style="margin-bottom:14px">
        <h3 style="margin:0 0 4px;font-size:1.05em">${esc(f.name)}</h3>
        <div style="color:#555;font-size:0.9em">${esc(f.city)}, ${esc(f.state)}</div>
${bits.map((b) => `        ${b}`).join("\n")}
      </div>`;
}

// ── Client-side filter ──────────────────────────────────────────────────────
// Progressive enhancement, deliberately: the control ships `hidden` and JS
// reveals it, so a crawler (and anyone with JS off) still receives every card
// in the HTML. These pages exist for search visibility first. Nothing is
// fetched — the filter only toggles cards already in the DOM, so a 110-facility
// state page costs no extra request.
const FILTER_ASSETS = `
  <style>
    .tl-filter{margin:14px 0 18px;padding:12px 14px;background:#f4f6f8;border:1px solid #dfe4e9;border-radius:6px}
    .tl-filter-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
    .tl-filter-row+.tl-filter-row{margin-top:8px}
    .tl-filter input[type=search],.tl-filter select{padding:8px 10px;border:1px solid #c9d2da;border-radius:5px;font-size:0.9rem;background:#fff;color:#222}
    .tl-filter input[type=search]{flex:1 1 240px;min-width:0}
    .tl-filter-toggles label{font-size:0.85rem;color:#333;display:inline-flex;align-items:center;gap:5px}
    .tl-filter button{padding:7px 14px;border:1px solid #c9d2da;background:#fff;border-radius:5px;cursor:pointer;font-size:0.85rem}
    .tl-filter button:hover{background:#eef1f4}
    .tl-count{font-size:0.85rem;color:#555;margin-left:auto}
    .tl-sparse{margin:8px 0 0;font-size:0.78rem;color:#666;line-height:1.45}
    .tl-empty{padding:14px;color:#666;font-size:0.9rem}
    /* .railroad-item may carry a display rule in style.css, which would beat
       the [hidden] UA default and leave "hidden" cards visible. */
    .tl-card[hidden]{display:none !important}
    .tl-citylist.is-collapsed .tl-city-extra{display:none}
    .tl-morecities{background:none;border:none;color:#1f4e8c;cursor:pointer;font-size:0.9rem;padding:4px 0;text-decoration:underline}
  </style>`;

const FILTER_JS = `
  <script>
  (function(){
    var box=document.getElementById('tlFilter');
    var cl=document.getElementById('tlCityList'),mb=document.getElementById('tlMoreCities');
    if(cl&&mb){
      mb.addEventListener('click',function(){
        var collapsed=cl.classList.toggle('is-collapsed');
        mb.textContent=collapsed?('Show all '+cl.getAttribute('data-total')+' cities'):'Show fewer cities';
      });
    }
    if(!box) return;
    box.hidden=false;
    var cards=[].slice.call(document.querySelectorAll('.tl-card'));
    var grid=document.querySelector('.railroads-grid');
    var q=document.getElementById('tlSearch'),city=document.getElementById('tlCity'),
        comm=document.getElementById('tlComm'),cap=document.getElementById('tlCap'),
        ver=document.getElementById('tlVerified'),ph=document.getElementById('tlPhone'),
        cnt=document.getElementById('tlCount'),rst=document.getElementById('tlReset');
    var empty=document.createElement('div');
    empty.className='tl-empty'; empty.hidden=true;
    empty.textContent='No facilities match those filters. Try clearing one.';
    if(grid&&grid.parentNode) grid.parentNode.insertBefore(empty,grid.nextSibling);
    function apply(){
      var t=((q&&q.value)||'').trim().toLowerCase(),
          c=(city&&city.value)||'',m=(comm&&comm.value)||'',p=(cap&&cap.value)||'',
          v=!!(ver&&ver.checked),hp=!!(ph&&ph.checked),shown=0;
      for(var i=0;i<cards.length;i++){
        var el=cards[i];
        var ok=(!t||el.getAttribute('data-text').indexOf(t)>-1)&&
               (!c||el.getAttribute('data-city')===c)&&
               (!m||el.getAttribute('data-comm').split('|').indexOf(m)>-1)&&
               (!p||el.getAttribute('data-cap').split('|').indexOf(p)>-1)&&
               (!v||el.getAttribute('data-tier')==='verified')&&
               (!hp||el.getAttribute('data-phone')==='1');
        el.hidden=!ok; if(ok) shown++;
      }
      empty.hidden=shown>0;
      if(cnt) cnt.textContent='Showing '+shown+' of '+cards.length;
    }
    [q,city,comm,cap,ver,ph].forEach(function(el){
      if(!el) return;
      el.addEventListener('input',apply); el.addEventListener('change',apply);
    });
    if(rst) rst.addEventListener('click',function(){
      if(q) q.value='';
      [city,comm,cap].forEach(function(s){ if(s) s.value=''; });
      [ver,ph].forEach(function(x){ if(x) x.checked=false; });
      apply();
    });
    apply();
  })();
  </script>`;

// Below this many facilities the grid is already scannable and a filter bar is
// just chrome. Chicago (13) gets one; a 3-facility city page does not.
const MIN_FACILITIES_FOR_FILTER = 8;

function filterBar(list) {
  if (list.length < MIN_FACILITIES_FOR_FILTER) return "";
  const uniq = (a) => [...new Set(a.filter(Boolean).map((x) => String(x)))].sort();
  const cities = uniq(list.map((f) => f.city));
  const comms = uniq(list.flatMap((f) => (Array.isArray(f.commodities) ? f.commodities : [])));
  const caps = uniq(list.flatMap((f) => (Array.isArray(f.capabilities) ? f.capabilities : [])));
  const withComm = list.filter((f) => (f.commodities || []).length).length;
  const withCap = list.filter((f) => (f.capabilities || []).length).length;
  const verified = list.filter((f) => String(f.tier || "").toLowerCase() === "verified").length;
  const withPhone = list.filter((f) => f.phone).length;
  const opt = (v) => `<option value="${esc(String(v).toLowerCase())}">${esc(titleCase(v))}</option>`;

  // Commodity/capability are populated for roughly a quarter of the dataset, so
  // filtering on them hides sites we simply have not verified yet — NOT sites
  // that lack the capability. Saying so prevents the filter from reading as an
  // authoritative "no such facility here".
  const sparse =
    withComm < list.length || withCap < list.length
      ? `<p class="tl-sparse">Commodity detail is confirmed for ${withComm} of ${list.length} sites and capability detail for ${withCap}. Filtering by either hides sites we have not verified yet rather than sites that lack it &mdash; call us and we will confirm any of them.</p>`
      : "";

  return `
    <div class="tl-filter" id="tlFilter" hidden>
      <div class="tl-filter-row">
        <input type="search" id="tlSearch" placeholder="Search name, city or commodity&hellip;" aria-label="Search facilities">
        <select id="tlCity" aria-label="Filter by city"><option value="">All cities (${cities.length})</option>${cities.map(opt).join("")}</select>
        ${comms.length ? `<select id="tlComm" aria-label="Filter by commodity"><option value="">Any commodity</option>${comms.map(opt).join("")}</select>` : ""}
        ${caps.length ? `<select id="tlCap" aria-label="Filter by capability"><option value="">Any capability</option>${caps.map(opt).join("")}</select>` : ""}
      </div>
      <div class="tl-filter-row tl-filter-toggles">
        ${verified ? `<label><input type="checkbox" id="tlVerified"> Verified only (${verified})</label>` : ""}
        ${withPhone ? `<label><input type="checkbox" id="tlPhone"> Has phone (${withPhone})</label>` : ""}
        <button type="button" id="tlReset">Reset</button>
        <span id="tlCount" class="tl-count"></span>
      </div>${sparse}
    </div>`;
}

// The full city list is worth keeping — the linked ones are internal links to
// city pages. But 71 of them as one undifferentiated run of text is the wall
// Jacob hit, so collapse past CITY_FOLD and let the filter carry the browsing.
const CITY_FOLD = 24;
function cityListHtml(cities, ownPage) {
  const link = (c) =>
    ownPage.has(c.slug)
      ? `<a href="/transload/${c.slug}">${esc(c.city)} (${c.list.length})</a>`
      : `<span>${esc(c.city)} (${c.list.length})</span>`;
  if (cities.length <= CITY_FOLD) return `<p>${cities.map(link).join(" &middot; ")}</p>`;
  const shown = cities.slice(0, CITY_FOLD).map(link).join(" &middot; ");
  // Separator lives INSIDE the hidden span, otherwise collapsing leaves a
  // trail of orphaned middots.
  const extra = cities
    .slice(CITY_FOLD)
    .map((c) => `<span class="tl-city-extra"> &middot; ${link(c)}</span>`)
    .join("");
  return `<div class="tl-citylist is-collapsed" id="tlCityList" data-total="${cities.length}">
        <p>${shown}${extra}</p>
        <button type="button" class="tl-morecities" id="tlMoreCities">Show all ${cities.length} cities</button>
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
  const cityLinks = cityListHtml(r.cities, ownPage);

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
      ${cityLinks}
    </section>

    <section>
      <h2>Facilities</h2>${filterBar(r.list)}
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

  // Only ship the filter CSS/JS to pages that actually render one of the two
  // controls it drives; a 4-facility region needs neither.
  const interactive = r.list.length >= MIN_FACILITIES_FOR_FILTER || r.cities.length > CITY_FOLD;
  writeFileSync(
    join(OUTPUT_DIR, `${r.slug}.html`),
    head({ title, description, canonical: url, jsonLd: itemListLd(r.list, title, url) }) +
      (interactive ? FILTER_ASSETS : "") +
      body +
      (interactive ? FILTER_JS : "") +
      FOOTER
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
      <h2>Facilities in ${esc(c.city)}</h2>${filterBar(c.list)}
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

  const cityInteractive = c.list.length >= MIN_FACILITIES_FOR_FILTER;
  writeFileSync(
    join(OUTPUT_DIR, `${c.slug}.html`),
    head({ title, description, canonical: url, jsonLd: itemListLd(c.list, title, url) }) +
      (cityInteractive ? FILTER_ASSETS : "") +
      body +
      (cityInteractive ? FILTER_JS : "") +
      FOOTER
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
