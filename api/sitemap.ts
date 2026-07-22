import type { VercelRequest, VercelResponse } from '@vercel/node';
import { readFileSync } from 'fs';
import { join } from 'path';

export default function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const postsPath = join(process.cwd(), 'blog', 'posts.json');
    const posts = JSON.parse(readFileSync(postsPath, 'utf-8'));
    const citiesPath = join(process.cwd(), 'cities.json');
    const cities = JSON.parse(readFileSync(citiesPath, 'utf-8'));
    // NOTE: the ~359 programmatic /rates lane pages are intentionally EXCLUDED
    // from the sitemap (2026-06-01). GSC showed 27 impressions / 0 clicks across
    // all of them over 90d — no search demand — and they were diluting the
    // domain's quality signal. They're also noindex'd via X-Robots-Tag in
    // vercel.json. Real cost-related search demand is served by the blog + the
    // rate-quote tool instead.
    const today = new Date().toISOString().split("T")[0];

    const staticPages = [
      { loc: "/", priority: "1.0", changefreq: "weekly" },
      { loc: "/services", priority: "0.9", changefreq: "monthly" },
      { loc: "/outsourced-rail-department", priority: "0.9", changefreq: "monthly" },
      { loc: "/contact", priority: "0.8", changefreq: "monthly" },
      { loc: "/blog", priority: "0.9", changefreq: "daily" },
      { loc: "/courses", priority: "0.9", changefreq: "weekly" },
      { loc: "/rail-freight", priority: "0.8", changefreq: "weekly" },
      { loc: "/tools", priority: "0.9", changefreq: "weekly" },
      { loc: "/tools/rail-rate-quote", priority: "0.8", changefreq: "monthly" },
      { loc: "/tools/transload-directory", priority: "0.8", changefreq: "monthly" },
      { loc: "/tools/demurrage-calculator", priority: "0.8", changefreq: "monthly" },
      { loc: "/tools/railcar-selector", priority: "0.8", changefreq: "monthly" },
      { loc: "/tools/rail-bol-builder", priority: "0.8", changefreq: "monthly" },
      // Added 2026-07-22. These six shipped but were never added here, so
      // they had no crawl path from the sitemap — 9 of 11 tools had zero GSC
      // impressions over 90 days. Tool pages convert impressions to clicks at
      // ~2x the position benchmark (vs ~0.16x for informational blog posts),
      // so visibility here is the binding constraint, not page quality.
      { loc: "/tools/rail-vs-truck", priority: "0.8", changefreq: "monthly" },
      { loc: "/tools/rail-fleet-calculator", priority: "0.8", changefreq: "monthly" },
      { loc: "/tools/rail-served-businesses", priority: "0.8", changefreq: "monthly" },
      { loc: "/tools/commodity-flow-map", priority: "0.8", changefreq: "monthly" },
      { loc: "/tools/storage-locator", priority: "0.8", changefreq: "monthly" },
      { loc: "/tools/sublease-board", priority: "0.8", changefreq: "weekly" },
      // Regenerated from data/fsc/current.json on the 1st of each month, so
      // changefreq is monthly and genuinely accurate.
      { loc: "/tools/rail-fuel-surcharge", priority: "0.9", changefreq: "monthly" },
      { loc: "/tools/rail-transit-time", priority: "0.9", changefreq: "weekly" },
      { loc: "/privacy-policy", priority: "0.3", changefreq: "yearly" },
      { loc: "/terms-of-service", priority: "0.3", changefreq: "yearly" },
    ];

    const coursePages = [
      "rail-freight-fundamentals", "working-with-railroads", "railroad-pricing",
      "demurrage", "transloading", "surviving-psr", "bulk-commodity-deep-dives",
      "safety-compliance-regulations", "technology-future-of-rail", "building-your-rail-strategy",
    ];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    for (const page of staticPages) {
      xml += `  <url>\n    <loc>https://steelwheellogistics.com${page.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${page.changefreq}</changefreq>\n    <priority>${page.priority}</priority>\n  </url>\n`;
    }

    for (const slug of coursePages) {
      xml += `  <url>\n    <loc>https://steelwheellogistics.com/courses/${slug}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
    }

    for (const post of posts) {
      xml += `  <url>\n    <loc>https://steelwheellogistics.com/blog/${post.slug}</loc>\n    <lastmod>${post.date}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n`;
    }

    for (const city of cities) {
      xml += `  <url>\n    <loc>https://steelwheellogistics.com/rail-freight/${city.slug}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
    }

    xml += `</urlset>`;

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.status(200).send(xml);
  } catch (err) {
    console.error("Sitemap generation error:", err);
    return res.status(500).send("Sitemap generation failed");
  }
}
