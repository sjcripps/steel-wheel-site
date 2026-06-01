import type { VercelRequest, VercelResponse } from '@vercel/node';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export default function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const postsPath = join(process.cwd(), 'blog', 'posts.json');
    const posts = JSON.parse(readFileSync(postsPath, 'utf-8'));
    const citiesPath = join(process.cwd(), 'cities.json');
    const cities = JSON.parse(readFileSync(citiesPath, 'utf-8'));
    // Programmatic lane pages (added 2026-05-05). Only loaded if the
    // generator has run and produced /rates/lanes.json. Sitemap stays valid
    // even when the file is absent.
    const lanesPath = join(process.cwd(), 'rates', 'lanes.json');
    const lanes: Array<{ url: string; lastmod: string }> = existsSync(lanesPath)
      ? JSON.parse(readFileSync(lanesPath, 'utf-8'))
      : [];
    const today = new Date().toISOString().split("T")[0];

    const staticPages = [
      { loc: "/", priority: "1.0", changefreq: "weekly" },
      { loc: "/services", priority: "0.9", changefreq: "monthly" },
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

    for (const lane of lanes) {
      // Strip trailing slash: cleanUrls/trailingSlash:false makes the site
      // 308-redirect /rates/.../  ->  /rates/...  so the slash form is non-canonical.
      // Listing the redirecting URL in the sitemap left ~270 rate pages un-indexed
      // ("Discovered/unknown — currently not indexed"). Emit the canonical URL.
      const canonical = lane.url.replace(/\/$/, '');
      xml += `  <url>\n    <loc>https://steelwheellogistics.com${canonical}</loc>\n    <lastmod>${lane.lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
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
