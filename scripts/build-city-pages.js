#!/usr/bin/env bun
/**
 * Build script for Steel Wheel Logistics programmatic city SEO pages.
 * Reads cities.json and generates:
 *   - /rail-freight/{slug}.html for each city
 *   - /rail-freight/index.html listing all cities
 *
 * Usage: bun run scripts/build-city-pages.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const CITIES_FILE = join(ROOT, "cities.json");
const OUTPUT_DIR = join(ROOT, "rail-freight");
const POSTS_FILE = join(ROOT, "blog", "posts.json");

const cities = JSON.parse(readFileSync(CITIES_FILE, "utf-8"));
const posts = JSON.parse(readFileSync(POSTS_FILE, "utf-8"));

mkdirSync(OUTPUT_DIR, { recursive: true });

const today = new Date().toISOString().split("T")[0];

// Blog post relevance matching
function findRelatedPosts(city) {
  const relevant = [];
  const cityLower = city.city.toLowerCase();
  const commoditiesLower = city.commodities.map(c => c.toLowerCase());

  for (const post of posts) {
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

function formatDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonStrEscape(s) {
  return JSON.stringify(String(s)).slice(1, -1);
}

function generateCityPage(city) {
  const relatedPosts = findRelatedPosts(city);
  const nearbyCities = findNearbyCities(city);
  const fullLocation = `${city.city}, ${city.stateAbbr}`;
  const metaDesc = `Rail freight shipping services in ${city.city}, ${city.state}. ${city.railroads.slice(0, 3).join(", ")} railroad access, transload terminals, and bulk commodity logistics. Steel Wheel Logistics.`;
  const canonicalUrl = `https://steelwheellogistics.com/rail-freight/${city.slug}`;

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

  const terminalsList = city.terminals.map(t => `            <li>${t}</li>`).join("\n");
  const commoditiesList = city.commodities.map(c => `            <li>${c}</li>`).join("\n");

  const portSection = city.portAccess ? `
      <!-- Port Connections -->
      <section class="city-section">
        <h2>Multimodal &amp; Port Connections</h2>
        <p>${city.portAccess}</p>
        <p>Port access gives ${city.city} shippers the advantage of rail-to-vessel transloading for international trade. Whether you are exporting or importing bulk commodities, the combination of rail and port infrastructure creates efficient multimodal supply chain options.</p>
        <p>Learn more about how transloading works in our guide: <a href="/blog/what-is-transloading">What Is Transloading?</a></p>
      </section>` : `
      <!-- Multimodal Connections -->
      <section class="city-section">
        <h2>Multimodal Connections</h2>
        <p>${city.city}'s rail infrastructure connects to the broader national network, providing access to ports, distribution centers, and production facilities across the country. ${city.railroads.length > 1 ? "Multiple Class I railroad connections give shippers routing flexibility and competitive rate options." : "The Class I railroad connection provides direct access to the national rail network."}</p>
      </section>`;

  const relatedPostsHtml = relatedPosts.length > 0 ? relatedPosts.map(p =>
    `            <li><a href="/blog/${p.slug}">${p.title}</a></li>`
  ).join("\n") : '            <li><a href="/blog/how-rail-freight-shipping-works">How Rail Freight Shipping Works</a></li>';

  const nearbyCitiesHtml = nearbyCities.map(c =>
    `            <li><a href="/rail-freight/${c.slug}">Rail Freight in ${c.city}, ${c.stateAbbr}</a></li>`
  ).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${htmlEscape(metaDesc)}">
  <meta name="keywords" content="rail freight ${htmlEscape(city.city)}, ${htmlEscape(city.city)} rail shipping, ${htmlEscape(city.city)} railroad, ${htmlEscape(city.city)} transload, bulk freight ${htmlEscape(city.city)} ${htmlEscape(city.stateAbbr)}">
  <link rel="canonical" href="${canonicalUrl}">
  <meta property="og:title" content="Rail Freight Shipping in ${htmlEscape(fullLocation)} | Steel Wheel Logistics">
  <meta property="og:description" content="${htmlEscape(metaDesc)}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Steel Wheel Logistics">
  <meta property="og:image" content="https://steelwheellogistics.com/images/logo-192.png">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="Rail Freight Shipping in ${htmlEscape(fullLocation)} | Steel Wheel Logistics">
  <meta name="twitter:description" content="${htmlEscape(metaDesc)}">
  <meta name="twitter:image" content="https://steelwheellogistics.com/images/logo-192.png">
  <title>Rail Freight Shipping in ${htmlEscape(fullLocation)} | Steel Wheel Logistics</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/png" sizes="192x192" href="/images/logo-192.png">
  <link rel="stylesheet" href="/style.css?v=5">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Service",
    "name": "Rail Freight Shipping in ${jsonStrEscape(fullLocation)}",
    "description": "${jsonStrEscape(metaDesc)}",
    "url": "${canonicalUrl}",
    "provider": {
      "@type": "Organization",
      "name": "Steel Wheel Logistics",
      "url": "https://steelwheellogistics.com"
    },
    "areaServed": {
      "@type": "City",
      "name": "${jsonStrEscape(city.city)}",
      "containedInPlace": {
        "@type": "State",
        "name": "${jsonStrEscape(city.state)}"
      }
    },
    "serviceType": "Rail Freight Logistics"
  }
  </script>
</head>
<body>

  <!-- Header -->
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

  <!-- Breadcrumb + Hero -->
  <section class="blog-hero">
    <div class="blog-breadcrumb">
      <a href="/">Home</a><span class="separator">/</span><a href="/rail-freight">Rail Freight by City</a><span class="separator">/</span><span>${fullLocation}</span>
    </div>
    <h1>Rail Freight Shipping in ${fullLocation}</h1>
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
        <p>${city.description}</p>
      </div>

      <!-- Railroads -->
      <section class="city-section">
        <h2>Railroads Serving ${city.city}</h2>
        <p>${city.city} is served by ${city.railroads.length === 1 ? city.railroads[0] : city.railroads.slice(0, -1).join(", ") + " and " + city.railroads[city.railroads.length - 1]}, providing ${city.railroads.length > 2 ? "extensive" : "solid"} Class I railroad coverage for freight shippers in the ${city.city} metro area.</p>
        <div class="railroads-grid">
${railroadSections}
        </div>
        <p>Understanding how Class I and short line railroads work together is key to efficient rail shipping. Read our guide: <a href="/blog/short-line-vs-class-i-railroads">Short Line vs Class I Railroads</a>.</p>
      </section>

      <!-- Terminals -->
      <section class="city-section">
        <h2>Key Rail Terminals &amp; Yards</h2>
        <p>Major rail facilities in and around ${city.city} include:</p>
        <ul class="city-list">
${terminalsList}
        </ul>
        <p>These facilities handle car classification, transload, and bulk commodity loading and unloading operations. Learn how classification yards sort and route freight in our article: <a href="/blog/how-railroad-classification-yards-work">How Railroad Classification Yards Work</a>.</p>
      </section>

      <!-- Commodities -->
      <section class="city-section">
        <h2>Commodities Shipped by Rail</h2>
        <p>Key commodities moving by rail through ${city.city} include:</p>
        <ul class="city-list">
${commoditiesList}
        </ul>
        <p>Rail is the most cost-effective way to move bulk commodities over long distances. See our <a href="/blog/rail-vs-truck-freight-cost-comparison">rail vs truck cost comparison</a> to understand when rail makes sense for your freight.</p>
      </section>
${portSection}

      <!-- CTA -->
      <section class="city-cta">
        <h2>Ready to Ship by Rail from ${city.city}?</h2>
        <p>Steel Wheel Logistics specializes in bulk commodity rail freight. Whether you are shipping ${city.commodities.slice(0, 3).join(", ").toLowerCase()}, or other goods by rail from ${fullLocation}, we can help coordinate competitive rates, car supply, and logistics with the Class I railroads serving your area.</p>
        <a href="/contact" class="btn btn-primary">Get a Rail Freight Quote</a>
      </section>

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

  <!-- Header -->
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

for (const city of cities) {
  const html = generateCityPage(city);
  const outPath = join(OUTPUT_DIR, `${city.slug}.html`);
  writeFileSync(outPath, html, "utf-8");
  count++;
}

const indexHtml = generateIndexPage();
writeFileSync(join(OUTPUT_DIR, "index.html"), indexHtml, "utf-8");
count++;

console.log(`Generated ${count} pages (${cities.length} city pages + 1 index page) in /rail-freight/`);
