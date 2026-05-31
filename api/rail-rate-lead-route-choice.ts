import type { VercelRequest, VercelResponse } from '@vercel/node';

// Lightweight follow-up to /api/rail-rate-quote — when the customer taps an
// alternate routing on the rate page, the frontend POSTs the picked route_choice
// here so we record which routing the lead actually engaged with. The Python
// service is still authoritative for the rate; this just persists the choice.
const UPSTREAM = process.env.RAIL_RATE_UPSTREAM || 'https://tools.steelwheellogistics.com';
const UPSTREAM_TIMEOUT_MS = 15000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const email = String(body.email ?? '').trim().toLowerCase();
  const routeChoice = String(body.route_choice ?? 'primary').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  if (routeChoice !== 'primary' && !routeChoice.startsWith('alt-')) {
    return res.status(400).json({ error: 'route_choice must be "primary" or "alt-N"' });
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(`${UPSTREAM}/api/rail-rate-lead-route-choice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://steelwheellogistics.com',
        'Referer': 'https://steelwheellogistics.com/tools/rail-rate-quote',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 SteelWheelRateProxy/1.0',
        'CF-Connecting-IP': String(
          req.headers['cf-connecting-ip'] ||
          req.headers['x-real-ip'] ||
          (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
          ''
        ),
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    return res.send(text);
  } catch (err: any) {
    clearTimeout(timer);
    const isAbort = err?.name === 'AbortError';
    console.error('rail-rate-lead-route-choice upstream error:', err);
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort ? 'rate engine timed out' : 'rate engine unreachable',
      detail: String(err?.message ?? err),
    });
  }
}
