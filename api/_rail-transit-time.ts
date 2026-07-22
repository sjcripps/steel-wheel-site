import type { VercelRequest, VercelResponse } from '@vercel/node';

// Transit-time estimate proxy. Routed through the api/tool-lead dispatcher
// (see ROUTES there + the vercel.json rewrite) because the Hobby plan caps a
// deployment at 12 Serverless Functions and we are already at 12 — a
// standalone api/rail-transit-time.ts would fail the whole deploy at
// patchBuild with exceeded_serverless_functions_per_deployment.
//
// Unlike the other dispatcher routes this one captures NO lead. The transit
// estimate is a public, ungated lookup: it is the SEO asset, and gating it
// would defeat the point.

const UPSTREAM = process.env.RAIL_RATE_UPSTREAM || 'https://tools.steelwheellogistics.com';
const UPSTREAM_TIMEOUT_MS = 55000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const origin = String(body.origin ?? '').trim();
  const destination = String(body.destination ?? '').trim();
  const commodity = String(body.commodity ?? 'grain').trim();

  if (!origin || !destination) {
    return res.status(400).json({ error: 'origin and destination are required' });
  }

  let numCars = 1;
  if (body.num_cars !== undefined && body.num_cars !== null && String(body.num_cars).trim() !== '') {
    const n = Number(body.num_cars);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 200) {
      return res.status(400).json({
        error: 'Car count must be a whole number between 1 and 200.',
        code: 'num_cars_range',
      });
    }
    numCars = n;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    // Browser-mimicking headers: the EC2 origin sits behind Cloudflare Bot
    // Fight Mode, which 403s a bare serverless fetch. Same pattern as
    // rail-rate-quote.ts.
    const upstream = await fetch(`${UPSTREAM}/api/rail-rate-transit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Origin': 'https://steelwheellogistics.com',
        'Referer': 'https://steelwheellogistics.com/tools/rail-transit-time',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 SteelWheelTransitProxy/1.0',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
      },
      body: JSON.stringify({ origin, destination, commodity, num_cars: numCars }),
      signal: ctl.signal,
    });
    clearTimeout(timer);

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    const trimmed = text.trimStart();
    if (trimmed.startsWith('<') || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
      return res.send(JSON.stringify({
        error: 'transit engine returned a non-JSON response. Please try again — if it keeps happening, call (601) 821-2199.',
        code: 'upstream_non_json',
        upstream_status: upstream.status,
      }));
    }
    return res.send(text);
  } catch (err: any) {
    clearTimeout(timer);
    const isAbort = err?.name === 'AbortError';
    console.error('rail-transit-time upstream error:', err);
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort ? 'transit engine timed out' : 'transit engine unreachable',
      detail: String(err?.message ?? err),
    });
  }
}
