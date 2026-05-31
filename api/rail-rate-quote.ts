import type { VercelRequest, VercelResponse } from '@vercel/node';

// The actual rate engine runs on Jacob's EC2 box, fronted by a Cloudflare
// tunnel. This Vercel function is a thin validating proxy so the browser only
// talks to *.steelwheellogistics.com.
const UPSTREAM = process.env.RAIL_RATE_UPSTREAM || 'https://tools.steelwheellogistics.com';
// 60s — first request after a server restart can take 30s+ on cold-start
// (NARN graph is loaded but routing-engine path search dominates). Vercel
// caps serverless duration at 60s on the Hobby plan, so this is the practical
// ceiling. If we ever hit it, the right fix is to make the engine faster, not
// to bump again.
const UPSTREAM_TIMEOUT_MS = 55000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS — same-origin in practice but kept loose so we can call it from
  // localhost during dev.
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
  const weightTons = Number(body.weight_tons);
  const year = body.year != null ? Number(body.year) : 2024;
  const email = String(body.email ?? '').trim().toLowerCase();
  // Optional contact fields (added 2026-04-30). Both are optional UX-wise;
  // capped here defensively, also enforced server-side in Flask.
  const leadName = String(body.name ?? '').trim().slice(0, 200);
  const leadPhone = String(body.phone ?? '').trim().slice(0, 60);

  // Edge format check — Python service still does authoritative MX +
  // disposable-domain validation. We just want to short-circuit obvious
  // garbage at the edge so we don't waste an upstream round-trip.
  const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)+$/;
  if (!email) {
    return res.status(400).json({ error: 'Email is required.', code: 'email_format' });
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.', code: 'email_format' });
  }

  if (!origin || !destination) {
    return res.status(400).json({ error: 'origin and destination are required' });
  }
  if (!commodity) {
    return res.status(400).json({ error: 'commodity is required' });
  }
  if (!carType) {
    return res.status(400).json({ error: 'car_type is required' });
  }
  if (!Number.isFinite(weightTons) || weightTons <= 0 || weightTons > 500) {
    return res.status(400).json({ error: 'weight_tons must be a number between 1 and 500' });
  }
  // Defense-in-depth — refuse intermodal at the edge as well as in Python.
  if (commodity === 'intermodal' || carType === 'intermodal-flatcar') {
    return res.status(400).json({
      error: "Intermodal isn't a service Steel Wheel offers. Please pick a different commodity or car type, or call us about your move.",
      code: 'intermodal_not_offered',
    });
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(`${UPSTREAM}/api/rail-rate-quote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Origin': 'https://steelwheellogistics.com',
        'Referer': 'https://steelwheellogistics.com/tools/rail-rate-quote',
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
        weight_tons: weightTons,
        year,
        email,
        name: leadName,
        phone: leadPhone,
        // Forward client metadata so the Python service can record it on the
        // lead. (CF-Connecting-IP is set by Cloudflare; X-Forwarded-For is the
        // Vercel-default chain.)
        client_ip: String(
          req.headers['cf-connecting-ip'] ||
          req.headers['x-real-ip'] ||
          (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
          ''
        ),
        user_agent: String(req.headers['user-agent'] || '').slice(0, 500),
      }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    // If the upstream returned HTML (Flask debug page, Cloudflare error page,
    // a 502 from a tunnel hiccup, etc.) the browser would fail JSON.parse
    // with "Unexpected token '<'". Wrap any non-JSON body so the UI can show
    // a real error message.
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
    console.error('rail-rate-quote upstream error:', err);
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort ? 'rate engine timed out' : 'rate engine unreachable',
      detail: String(err?.message ?? err),
    });
  }
}
