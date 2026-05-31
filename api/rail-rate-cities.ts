import type { VercelRequest, VercelResponse } from '@vercel/node';

// Predictive-text city search for the rate-quote tool's origin/destination
// inputs. Thin proxy to the EC2 Python service via the Cloudflare tunnel.
const UPSTREAM = process.env.RAIL_RATE_UPSTREAM || 'https://tools.steelwheellogistics.com';
const UPSTREAM_TIMEOUT_MS = 8000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const q = String(req.query.q ?? '').trim();
  const limit = Math.max(1, Math.min(20, Number(req.query.limit ?? 10) || 10));
  if (q.length < 2) return res.status(200).json({ query: q, results: [] });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const url = `${UPSTREAM}/api/rail-rate-cities?q=${encodeURIComponent(q)}&limit=${limit}`;
    const upstream = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://steelwheellogistics.com',
        'Referer': 'https://steelwheellogistics.com/tools/rail-rate-quote',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 SteelWheelRateProxy/1.0',
      },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    // Light client-side caching keeps the typeahead snappy on repeat prefixes.
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(text);
  } catch (err: any) {
    clearTimeout(timer);
    return res.status(502).json({ query: q, results: [], error: 'cities lookup failed' });
  }
}
