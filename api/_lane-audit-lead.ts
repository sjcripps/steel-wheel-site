import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isSyntheticLead } from './_lead-email';

// Lane Audit / Rail Desk intake (2026-09-27). Three request types ride one
// endpoint so the Hobby-plan function cap stays untouched:
//   lane_audit    — up to 10 truck lanes to price against rail (free audit)
//   merger_review — UP-NS merger exposure review (STB FD 36873, comments 11/18/26)
//   rail_desk     — outsourced rail desk / demurrage review
// Same wiring as _railcar-renewal-lead.ts: server-side email validation,
// synthetic short-circuit, S3 JSONL + Telegram DM, each sink isolated.
// Sink: jakecbot/swl-leads/lane-audit.jsonl

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'temp-mail.org',
  'throwaway.email', 'yopmail.com', 'fakeinbox.com', 'maildrop.cc', 'tempmail.net'
]);

const REQUEST_TYPES = new Set(['lane_audit', 'merger_review', 'rail_desk']);
const MAX_LANES = 10;

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

type Lane = { origin: string; destination: string; commodity: string; loads_per_month: string; current_cost: string; cost_basis: string };

function cleanLanes(raw: unknown): Lane[] {
  if (!Array.isArray(raw)) return [];
  const out: Lane[] = [];
  for (const l of raw.slice(0, MAX_LANES)) {
    if (!l || typeof l !== 'object') continue;
    const o = l as Record<string, unknown>;
    const origin = s(o.origin, 120), destination = s(o.destination, 120);
    if (!origin && !destination) continue;
    out.push({
      origin, destination,
      commodity: s(o.commodity, 80),
      loads_per_month: s(o.loads_per_month, 20),
      current_cost: s(o.current_cost, 30),
      cost_basis: s(o.cost_basis, 20) || 'per_load'
    });
  }
  return out;
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

    const requestType = REQUEST_TYPES.has(s(body.request_type)) ? s(body.request_type) : 'lane_audit';
    const lanes = cleanLanes(body.lanes);
    if (requestType === 'lane_audit' && lanes.length === 0) {
      return res.status(400).json({ ok: false, error: 'lanes_required' });
    }
    const clientIp = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').toString();
    const userAgent = (req.headers['user-agent'] || 'unknown').toString();

    const lead = {
      timestamp: new Date().toISOString(),
      source: 'lane-audit',
      request_type: requestType,
      email,
      name: s(body.name),
      company: s(body.company),
      phone: s(body.phone, 60),
      role: s(body.role, 80),
      lanes,
      railroads: s(body.railroads, 200),
      cars_per_month: s(body.cars_per_month, 20),
      notes: s(body.notes, 2000),
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
        body: JSON.stringify({ bucket: 'openclawbucket', key: 'jakecbot/swl-leads/lane-audit.jsonl', data: JSON.stringify(lead) })
      });
      sinks.s3 = r.ok;
    } catch (err) { console.error('S3 write failed:', err); }

    try {
      const label: Record<string, string> = { lane_audit: 'LANE AUDIT', merger_review: 'UP-NS MERGER REVIEW', rail_desk: 'RAIL DESK / DEMURRAGE' };
      const laneLines = lanes.slice(0, 5).map((l, i) =>
        `${i + 1}. ${l.origin || '?'} → ${l.destination || '?'} · ${l.commodity || '?'} · ${l.loads_per_month || '?'}/mo` +
        (l.current_cost ? ` · $${l.current_cost} ${l.cost_basis === 'per_mile' ? '/mi' : '/load'}` : ''));
      const msg = [
        `🚂 ${label[requestType] || requestType} — ${lead.company || '(no company)'}`,
        `${lead.name || '(no name)'}${lead.role ? ' · ' + lead.role : ''} · ${email}${lead.phone ? ' · ' + lead.phone : ''}`,
        lanes.length ? `Lanes (${lanes.length}):` : '',
        ...laneLines,
        lanes.length > 5 ? `… +${lanes.length - 5} more` : '',
        lead.railroads ? `Railroads: ${lead.railroads}` : '',
        lead.cars_per_month ? `Cars/month: ${lead.cars_per_month}` : '',
        lead.notes ? `Notes: ${lead.notes.slice(0, 400)}` : '',
        lead.entry_query ? `Query: ${lead.entry_query}` : '',
        `Run: python3 businesses/steel-wheel/scripts/lane_audit.py --latest`
      ].filter(Boolean).join('\n');
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_USER_ID, text: msg })
      });
      sinks.telegram = r.ok;
    } catch (err) { console.error('Telegram send failed:', err); }

    return res.status(200).json({ ok: true, sinks, lanes: lanes.length });
  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}
