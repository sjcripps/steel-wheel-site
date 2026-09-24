import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isSyntheticLead } from './_lead-email';

// Railcar Lease Renewal Desk intake. Same wiring as _storage-locator-lead.ts:
// server-side email validation, synthetic short-circuit, S3 JSONL + Telegram DM,
// each sink in its own try/catch. Sink: jakecbot/swl-leads/railcar-renewal.jsonl

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'temp-mail.org',
  'throwaway.email', 'yopmail.com', 'fakeinbox.com', 'maildrop.cc', 'tempmail.net'
]);

const REQUEST_TYPES = new Set(['renewal', 'sublease', 'sourcing', 'sell']);

async function validateEmail(email: string): Promise<{ valid: boolean; error?: string }> {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return { valid: false, error: 'email_format' };
  const domain = email.split('@')[1].toLowerCase();
  if (DISPOSABLE_DOMAINS.has(domain)) return { valid: false, error: 'email_disposable' };
  if (domain === 'anthropic.com') return { valid: true };
  try {
    const dns = await fetch(`https://dns.google/resolve?name=${domain}&type=MX`, {
      headers: { 'Accept': 'application/dns-json' }
    }).then(r => r.json());
    if (!dns.Answer || dns.Answer.length === 0) return { valid: false, error: 'email_no_mx' };
  } catch (err) {
    console.warn('MX check failed (fail-open):', err);
  }
  return { valid: true };
}

function s(v: unknown, max = 200): string {
  return String(v ?? '').trim().slice(0, max);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const email = s(body.email, 254).toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: 'email_required' });
    const validation = await validateEmail(email);
    if (!validation.valid) return res.status(400).json({ ok: false, error: validation.error });

    const requestType = REQUEST_TYPES.has(s(body.request_type)) ? s(body.request_type) : 'renewal';
    const clientIp = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').toString();
    const userAgent = (req.headers['user-agent'] || 'unknown').toString();

    const lead = {
      timestamp: new Date().toISOString(),
      source: 'railcar-renewal',
      request_type: requestType,
      email,
      name: s(body.name),
      company: s(body.company),
      phone: s(body.phone, 60),
      car_type: s(body.car_type, 80),
      car_count: s(body.car_count, 20),
      marks: s(body.marks, 120),
      lessor: s(body.lessor, 120),
      lease_expiry: s(body.lease_expiry, 40),
      lane_or_location: s(body.lane, 200),
      notes: s(body.notes, 1500),
      landing_referrer: s(body.landing_referrer, 500),
      referrer_kind: s(body.referrer_kind, 20),
      entry_query: s(body.entry_query, 300),
      client_ip: clientIp,
      user_agent: userAgent,
      is_synthetic: isSyntheticLead(email, userAgent, clientIp)
    };

    if (lead.is_synthetic) return res.status(200).json({ ok: true, synthetic: true });

    const sinks = { s3: false, telegram: false };
    try {
      const r = await fetch(`${process.env.S3_API_URL || 'http://localhost:3001'}/api/s3-put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket: 'openclawbucket', key: 'jakecbot/swl-leads/railcar-renewal.jsonl', data: JSON.stringify(lead) })
      });
      sinks.s3 = r.ok;
    } catch (err) { console.error('S3 write failed:', err); }

    try {
      const label: Record<string, string> = { renewal: 'RENEWAL DEFENSE', sublease: 'SUBLEASE IDLE CARS', sourcing: 'NEEDS CARS', sell: 'SELL CARS' };
      const msg = [
        `🚂 Railcar Desk Lead — ${label[requestType] || requestType}`,
        `${lead.name || '(no name)'} — ${lead.company || '(no company)'}`,
        `${email}${lead.phone ? ' · ' + lead.phone : ''}`,
        `Cars: ${lead.car_count || '?'} × ${lead.car_type || '?'}${lead.marks ? ' (' + lead.marks + ')' : ''}`,
        lead.lessor ? `Lessor: ${lead.lessor}` : '',
        lead.lease_expiry ? `Expiry: ${lead.lease_expiry}` : '',
        lead.lane_or_location ? `Lane/location: ${lead.lane_or_location}` : '',
        lead.notes ? `Notes: ${lead.notes.slice(0, 400)}` : '',
        lead.entry_query ? `Query: ${lead.entry_query}` : ''
      ].filter(Boolean).join('\n');
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_USER_ID, text: msg })
      });
      sinks.telegram = r.ok;
    } catch (err) { console.error('Telegram send failed:', err); }

    return res.status(200).json({ ok: true, sinks });
  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}
