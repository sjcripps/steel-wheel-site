import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isSyntheticLead } from './_lead-email';

// Railcar Lease Activity Tracker — unlock + weekly brief signup.
// Same wiring as _railcar-renewal-lead.ts. Sink: jakecbot/swl-leads/lease-activity.jsonl
// The four qualifying answers (side, car type, count, expiry) are the product.

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'temp-mail.org',
  'throwaway.email', 'yopmail.com', 'fakeinbox.com', 'maildrop.cc', 'tempmail.net'
]);
const SIDES = new Set(['have_cars', 'need_cars', 'lease_expiring', 'lessor_dealer', 'other']);

async function validateEmail(email: string): Promise<{ valid: boolean; error?: string }> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { valid: false, error: 'email_format' };
  const domain = email.split('@')[1].toLowerCase();
  if (DISPOSABLE_DOMAINS.has(domain)) return { valid: false, error: 'email_disposable' };
  if (domain === 'anthropic.com') return { valid: true };
  try {
    const dns = await fetch(`https://dns.google/resolve?name=${domain}&type=MX`, { headers: { 'Accept': 'application/dns-json' } }).then(r => r.json());
    if (!dns.Answer || dns.Answer.length === 0) return { valid: false, error: 'email_no_mx' };
  } catch (err) { console.warn('MX check failed (fail-open):', err); }
  return { valid: true };
}
const s = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);

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
    const v = await validateEmail(email);
    if (!v.valid) return res.status(400).json({ ok: false, error: v.error });
    const side = SIDES.has(s(body.side)) ? s(body.side) : 'other';
    const clientIp = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').toString();
    const userAgent = (req.headers['user-agent'] || 'unknown').toString();
    const lead = {
      timestamp: new Date().toISOString(), source: 'lease-activity', email,
      side, name: s(body.name), company: s(body.company), car_type: s(body.car_type, 80), car_count: s(body.car_count, 20),
      lease_expiry: s(body.lease_expiry, 40), weekly_brief: body.weekly_brief !== false && body.weekly_brief !== 'false',
      watch_marks: s(body.watch_marks, 200), landing_referrer: s(body.landing_referrer, 500), referrer_kind: s(body.referrer_kind, 20), entry_query: s(body.entry_query, 300),
      client_ip: clientIp, user_agent: userAgent, is_synthetic: isSyntheticLead(email, userAgent, clientIp)
    };
    if (lead.is_synthetic) return res.status(200).json({ ok: true, synthetic: true });
    const sinks = { s3: false, telegram: false };
    try {
      const r = await fetch(`${process.env.S3_API_URL || 'http://localhost:3001'}/api/s3-put`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket: 'openclawbucket', key: 'jakecbot/swl-leads/lease-activity.jsonl', data: JSON.stringify(lead) }) });
      sinks.s3 = r.ok;
    } catch (err) { console.error('S3 write failed:', err); }
    try {
      const label: Record<string, string> = { have_cars: 'HAS CARS', need_cars: 'NEEDS CARS', lease_expiring: 'LEASE EXPIRING', lessor_dealer: 'LESSOR/DEALER', other: 'other' };
      const msg = [`📊 Lease Activity signup — ${label[side]}`, `${lead.name || '(no name)'} — ${lead.company || '(no company)'}`, email,
        `Cars: ${lead.car_count || '?'} × ${lead.car_type || '?'}`, lead.lease_expiry ? `Expiry: ${lead.lease_expiry}` : '', lead.watch_marks ? `Watching: ${lead.watch_marks}` : '',
        `Weekly brief: ${lead.weekly_brief ? 'yes' : 'no'}`, lead.entry_query ? `Query: ${lead.entry_query}` : ''].filter(Boolean).join('\n');
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_USER_ID, text: msg }) });
      sinks.telegram = r.ok;
    } catch (err) { console.error('Telegram send failed:', err); }
    return res.status(200).json({ ok: true, sinks });
  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}
