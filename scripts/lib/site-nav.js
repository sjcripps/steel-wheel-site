// Single source of truth for the site header nav used by the page GENERATORS
// (build-transload-pages, build-commodity-pages, build-railserved-pages,
// build-city-pages).
//
// Why this file exists: each generator had its own hand-copied nav block. When
// "Tools" was added to the hand-written pages (index.html, /tools/*, /rates/*)
// it was never propagated to the generators, so 460 generated pages — 42% of
// the site, including all 264 transload pages — silently shipped a nav with no
// Tools link. Nothing failed; the nav was just quietly wrong, and the pages
// most likely to be a visitor's FIRST landing (the SEO surface) were the ones
// hiding the tools we want them to reach.
//
// Keep this in sync with the hand-written pages' nav. If you add a nav item to
// index.html, add it here too — that is now the only other place it lives.
export const NAV_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/services", label: "Services" },
  { href: "/blog", label: "Blog" },
  { href: "/courses", label: "Courses" },
  { href: "/tools", label: "Tools" },
  { href: "/contact", label: "Contact Us" },
];

// `activeHref` optionally marks one item current (matches index.html's
// `class="active"` convention). Generators pass nothing today.
export function siteHeader(activeHref) {
  const links = NAV_ITEMS.map(
    (i) => `        <a href="${i.href}"${i.href === activeHref ? ' class="active"' : ""}>${i.label}</a>`
  ).join("\n");
  return `
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
${links}
      </nav>
    </div>
  </header>
`;
}
