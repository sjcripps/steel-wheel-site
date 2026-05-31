import type { VercelRequest, VercelResponse } from '@vercel/node';

// Rail-vs-Truck mode-shift calculator backend proxy. v2.
//
// Same architecture as api/rail-rate-quote.ts: thin validating proxy from
// Vercel edge → Cloudflare Tunnel → Bun :3001 → Flask :8911 /mode-compare.
// Browser-mimicking headers to bypass CF Bot Fight Mode (see skill
// vercel-cf-bot-bypass — pattern proven on rail-rate-quote.ts).
//
// The math endpoint /mode-compare on the Flask service is intentionally
// lead-capture-free; the Vercel /api/rail-vs-truck-lead endpoint handles
// lead persistence so the math is reusable + cacheable in the future.

const UPSTREAM = process.env.RAIL_RATE_UPSTREAM || 'https://tools.steelwheellogistics.com';
const UPSTREAM_TIMEOUT_MS = 55000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const origin = String(body.origin ?? '').trim();
  const destination = String(body.destination ?? '').trim();
  const commodity = String(body.commodity ?? '').trim();
  const carType = String(body.car_type ?? '').trim();
  const weightPerCarTons = Number(body.weight_per_car_tons);
  const annualCarloads = body.annual_carloads != null ? Number(body.annual_carloads) : null;
  const annualTons = body.annual_tons != null ? Number(body.annual_tons) : null;
  const truckRatePerMile = body.truck_rate_per_mile != null && body.truck_rate_per_mile !== ''
    ? Number(body.truck_rate_per_mile) : null;
  const drayageOriginMiles = body.drayage_origin_miles != null && body.drayage_origin_miles !== ''
    ? Number(body.drayage_origin_miles) : null;
  const drayageDestMiles = body.drayage_dest_miles != null && body.drayage_dest_miles !== ''
    ? Number(body.drayage_dest_miles) : null;

  if (!origin || !destination) {
    return res.status(400).json({ error: 'origin and destination are required' });
  }
  if (!commodity) {
    return res.status(400).json({ error: 'commodity is required' });
  }
  if (commodity === 'intermodal' || carType === 'intermodal-flatcar') {
    return res.status(400).json({
      error: "Intermodal isn't a service Steel Wheel offers. Please pick a different commodity or car type, or call us about your move.",
      code: 'intermodal_not_offered',
    });
  }
  if (Number.isFinite(weightPerCarTons) && (weightPerCarTons <= 0 || weightPerCarTons > 200)) {
    return res.status(400).json({ error: 'weight_per_car_tons must be 1-200' });
  }
  if (annualCarloads == null && annualTons == null) {
    return res.status(400).json({ error: 'annual_carloads or annual_tons is required' });
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    // Browser-mimicking headers — Cloudflare Bot Fight Mode 403's data-center
    // IPs without these. Pattern from feedback_vercel_cf_bot_bypass.md /
    // rail-rate-quote.ts. WAF skip rule on /api/rail-vs-truck-* may also
    // be needed in CF dashboard if Bot Fight Mode reactivates aggressively.
    // Hit upstream under /api/rail-rate-mode-compare so the Cloudflare WAF
    // skip rule that whitelists /api/rail-rate-* applies cleanly. CF's Bot
    // Fight Mode treats new path patterns with extra scrutiny on data-center
    // IPs (Vercel egress) until a baseline is built; reusing the proven
    // prefix sidesteps that.
    const upstream = await fetch(`${UPSTREAM}/api/rail-rate-mode-compare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Origin': 'https://steelwheellogistics.com',
        'Referer': 'https://steelwheellogistics.com/tools/rail-vs-truck',
        // Match the rail-rate-quote.ts UA exactly — it has been allow-listed
        // by Cloudflare's Bot Fight Mode for months. Switching to a different
        // (even more "browser-like") UA triggers fresh scrutiny on data-center
        // IP traffic.
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 SteelWheelRateProxy/1.0',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
      },
      body: JSON.stringify({
        origin,
        destination,
        commodity,
        car_type: carType,
        weight_per_car_tons: weightPerCarTons,
        annual_carloads: annualCarloads,
        annual_tons: annualTons,
        truck_rate_per_mile: truckRatePerMile,
        drayage_origin_miles: drayageOriginMiles,
        drayage_dest_miles: drayageDestMiles,
      }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    const trimmed = text.trimStart();
    if (trimmed.startsWith('<') || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
      return res.send(JSON.stringify({
        error: 'rate engine returned a non-JSON response. Please try again — if it keeps happening, call (601) 821-2199.',
        code: 'upstream_non_json',
        upstream_status: upstream.status,
        upstream_body_preview: text.slice(0, 200),
      }));
    }
    return res.send(text);
  } catch (err: any) {
    clearTimeout(timer);
    const isAbort = err?.name === 'AbortError';
    console.error('rail-vs-truck-quote upstream error:', err);
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort ? 'rate engine timed out' : 'rate engine unreachable',
      detail: String(err?.message ?? err),
    });
  }
}
