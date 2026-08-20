import type { VercelRequest, VercelResponse } from '@vercel/node';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { isSyntheticLead, clientIpFrom, sendLeadEmail, sendCustomerEmail, syncWorkmateCrm } from './_lead-email';

// Rail-vs-Truck Mode-Shift Calculator lead capture (5th SWL tool).
//
// Mirrors api/demurrage-lead.ts pattern:
//   - 3-layer email validation (regex + disposable blocklist + DNS-over-
//     HTTPS MX record check)
//   - @anthropic.com short-circuit for synthetic test traffic
//   - Parallel sinks (each isolated, none can block):
//     1. S3 append at s3://openclawbucket/jakecbot/swl-leads/rail-vs-truck.jsonl
//     2. Telegram DM to Jacob (formatted, [HOT]/[WARM] prefix)
//     3. Lead-notification email to info@steelwheellogistics.com via Resend
//     4. Customer-confirmation email via Resend
//     5. Workmate CRM sync via Supabase REST
//
// Lead-quality signal: [HOT] if user entered their own truck rate (they
// have actual freight data — high-intent procurement); [WARM] if the
// ATRI default was accepted. Drives prioritization in the leads inbox.

const S3_BUCKET = 'openclawbucket';
const S3_KEY = 'jakecbot/swl-leads/rail-vs-truck.jsonl';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || '';

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  '10minutemail.com',
  'guerrillamail.com',
  'tempmail.com',
  'temp-mail.org',
  'throwawaymail.com',
  'yopmail.com',
  'sharklasers.com',
  'maildrop.cc',
  'getnada.com',
  'trashmail.com',
  'mintemail.com',
  'fakeinbox.com',
  'tempinbox.com',
  'dispostable.com',
]);

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)+$/;

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '$—';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function fmtMillions(n: number): string {
  if (!Number.isFinite(n)) return '$—';
  if (Math.abs(n) >= 1_000_000) {
    return '$' + (n / 1_000_000).toFixed(2) + 'M';
  }
  if (Math.abs(n) >= 1_000) {
    return '$' + (n / 1_000).toFixed(0) + 'K';
  }
  return '$' + Math.round(n).toLocaleString('en-US');
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function nowIsoUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nowCstShort(): string {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric', minute: '2-digit', hour12: true,
    month: 'numeric', day: 'numeric',
  });
  const parts = fmt.formatToParts(d);
  const part = (t: string) => parts.find(p => p.type === t)?.value || '';
  return `${part('hour')}:${part('minute')}${part('dayPeriod').replace(/\s/g, '')} CST ${part('month')}/${part('day')}`;
}

// DNS-over-HTTPS MX-record check via Cloudflare 1.1.1.1 — same approach
// as the Python email_validator module. Falls open on errors so a DNS
// hiccup never blocks a legit lead.
async function hasMxRecord(domain: string): Promise<boolean> {
  if (!domain) return false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      {
        headers: { Accept: 'application/dns-json' },
        signal: ctl.signal,
      },
    );
    clearTimeout(timer);
    if (!res.ok) return true; // fall open
    const data: any = await res.json();
    if (Array.isArray(data?.Answer) && data.Answer.length > 0) return true;
    // No MX — try A as a fallback (some domains accept mail at A record).
    const ctl2 = new AbortController();
    const timer2 = setTimeout(() => ctl2.abort(), 4000);
    const res2 = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`,
      {
        headers: { Accept: 'application/dns-json' },
        signal: ctl2.signal,
      },
    );
    clearTimeout(timer2);
    if (!res2.ok) return true;
    const data2: any = await res2.json();
    return Array.isArray(data2?.Answer) && data2.Answer.length > 0;
  } catch (err) {
    console.warn('rail-vs-truck-lead MX check failed (falling open):', err);
    return true;
  }
}

async function appendS3(record: Record<string, unknown>): Promise<boolean> {
  try {
    const s3 = new S3Client({ region: AWS_REGION });
    let existing = '';
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: S3_KEY }));
      existing = (await obj.Body?.transformToString()) || '';
    } catch (err: any) {
      if (err?.name !== 'NoSuchKey' && err?.$metadata?.httpStatusCode !== 404) {
        throw err;
      }
    }
    const line = JSON.stringify(record) + '\n';
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: S3_KEY,
      Body: existing + line,
      ContentType: 'application/x-ndjson',
    }));
    return true;
  } catch (err) {
    console.error('rail-vs-truck-lead S3 write failed:', err);
    return false;
  }
}

async function sendTelegram(message: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_USER_ID) {
    console.warn('rail-vs-truck-lead: Telegram env vars missing, skipping DM');
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_USER_ID,
        text: message,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('rail-vs-truck-lead Telegram non-200:', res.status, body);
      return false;
    }
    return true;
  } catch (err) {
    console.error('rail-vs-truck-lead Telegram fetch failed:', err);
    return false;
  }
}

// Renders the acquisition attribution as one short human-readable line.
// 'external' is the interesting case -- that is a real off-site channel.
function attributionLabel(kind: string, referrer: string, entryQuery: string): string {
  const q = entryQuery ? ` ${entryQuery}` : '';
  if (kind === 'external' && referrer) {
    let host = referrer;
    try { host = new URL(referrer).hostname || referrer; } catch { /* keep raw */ }
    return `external: ${host}${q}`;
  }
  if (kind === 'internal' && referrer) {
    let path = referrer;
    try { path = new URL(referrer).pathname || referrer; } catch { /* keep raw */ }
    return `internal: ${path}${q}`;
  }
  if (kind === 'direct') return `direct / no referrer${q}`;
  return q ? `unknown${q}` : 'unknown (pre-instrumentation client)';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const email = String(body.email ?? '').trim().toLowerCase();
  const origin = String(body.origin ?? '').trim();
  const destination = String(body.destination ?? '').trim();
  const commodity = String(body.commodity ?? '').trim();
  const commodityName = String(body.commodity_name ?? '').trim();
  const carType = String(body.car_type ?? '').trim();
  const carTypeName = String(body.car_type_name ?? '').trim();
  const weightPerCarTons = Number(body.weight_per_car_tons);
  const annualCarloads = Number(body.annual_carloads);
  const truckRateRaw = body.truck_rate_per_mile;
  const truckRateUserEntered =
    truckRateRaw != null && truckRateRaw !== '' && Number.isFinite(Number(truckRateRaw)) && Number(truckRateRaw) > 0;
  const truckRatePerMile = truckRateUserEntered ? Number(truckRateRaw) : 2.27;
  const drayageOriginMiles = Number(body.drayage_origin_miles ?? 25);
  const drayageDestMiles = Number(body.drayage_dest_miles ?? 25);

  // Computed numbers from the /mode-compare response (forwarded by client so
  // the lead row + DM include the headline savings without re-running math).
  const railAnnualTotal = Number(body.rail_annual_total);
  const truckAnnualTotal = Number(body.truck_annual_total);
  const annualSavings = Number(body.annual_savings_dollars);
  const co2eSavedTons = Number(body.co2e_saved_tons_per_year);
  const laneMiles = Number(body.lane_miles);

  const leadName = String(body.name ?? '').trim().slice(0, 200);
  const leadPhone = String(body.phone ?? '').trim().slice(0, 60);

  // 3-layer email validation.
  if (!email) {
    return res.status(400).json({ ok: false, error: 'Email is required.', code: 'email_format' });
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid email address.', code: 'email_format' });
  }
  const domain = email.split('@')[1] || '';
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return res.status(400).json({ ok: false, error: 'Please use your work email.', code: 'email_disposable' });
  }
  // @anthropic.com short-circuit BEFORE MX check — synthetic smokes avoid
  // both the DNS round-trip and any sink writes.
  if (isSyntheticLead(email, String(req.headers['user-agent'] || ''), clientIpFrom(req))) {
    return res.status(200).json({ ok: true, synthetic: true });
  }
  // MX check — falls open on DNS errors so a transient 1.1.1.1 hiccup
  // doesn't block a legit lead.
  const mxOk = await hasMxRecord(domain);
  if (!mxOk) {
    return res.status(400).json({
      ok: false,
      error: 'No mail server found for that domain. Did you mistype it?',
      code: 'email_no_mx',
    });
  }

  if (!origin || !destination) {
    return res.status(400).json({ ok: false, error: 'origin and destination are required' });
  }
  if (!commodity) {
    return res.status(400).json({ ok: false, error: 'commodity is required' });
  }
  if (!Number.isFinite(annualCarloads) || annualCarloads <= 0 || annualCarloads > 200000) {
    return res.status(400).json({ ok: false, error: 'annual_carloads must be 1-200,000' });
  }

  const clientIp = String(
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    ''
  );
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);
  // Acquisition attribution, captured CLIENT-side at page load. The HTTP
  // Referer on this POST is always the tool page itself (same-origin XHR), so
  // it can never identify the channel that produced the lead -- see
  // referrer_kind for what the visitor actually arrived from.
  const landingReferrer = String(body.landing_referrer ?? '').trim().slice(0, 500);
  const referrerKind = String(body.referrer_kind ?? '').trim().slice(0, 20);
  const entryQuery = String(body.entry_query ?? '').trim().slice(0, 300);
  const attribution = attributionLabel(referrerKind, landingReferrer, entryQuery);

  // Lead-quality signal: HOT if user provided their own truck rate, WARM
  // if accepted ATRI default. Plumbed through into the DM prefix and the
  // S3 record so the leads inbox can sort/filter on it.
  const leadQuality = truckRateUserEntered ? 'HOT' : 'WARM';

  const record = {
    ts: nowIsoUtc(),
    tool: 'rail-vs-truck-mode-shift',
    lead_quality: leadQuality,
    email,
    name: leadName || null,
    phone: leadPhone || null,
    origin,
    destination,
    commodity,
    commodity_name: commodityName || commodity,
    car_type: carType || null,
    car_type_name: carTypeName || carType || null,
    weight_per_car_tons: Number.isFinite(weightPerCarTons) ? weightPerCarTons : null,
    annual_carloads: annualCarloads,
    truck_rate_per_mile: truckRatePerMile,
    truck_rate_source: truckRateUserEntered ? 'user_entered' : 'market_dynamic',
    drayage_origin_miles: Number.isFinite(drayageOriginMiles) ? drayageOriginMiles : 25,
    drayage_dest_miles: Number.isFinite(drayageDestMiles) ? drayageDestMiles : 25,
    rail_annual_total: Number.isFinite(railAnnualTotal) ? railAnnualTotal : null,
    truck_annual_total: Number.isFinite(truckAnnualTotal) ? truckAnnualTotal : null,
    annual_savings_dollars: Number.isFinite(annualSavings) ? annualSavings : null,
    co2e_saved_tons_per_year: Number.isFinite(co2eSavedTons) ? co2eSavedTons : null,
    lane_miles: Number.isFinite(laneMiles) ? laneMiles : null,
    ip: clientIp,
    user_agent: userAgent,
    landing_referrer: landingReferrer || null,
    referrer_kind: referrerKind || null,
    entry_query: entryQuery || null,
  };

  // Telegram DM — formatted per spec.
  const truckRateLine = truckRateUserEntered
    ? `Truck rate: $${truckRatePerMile.toFixed(2)}/mi (USER-ENTERED)`
    : `Truck rate: $${truckRatePerMile.toFixed(2)}/mi (ATRI default)`;
  const carDescBits: string[] = [];
  if (carTypeName || carType) carDescBits.push(carTypeName || carType);
  if (Number.isFinite(weightPerCarTons) && weightPerCarTons > 0) {
    carDescBits.push(`${Math.round(weightPerCarTons)}t/car`);
  }
  const commodityLine = `Commodity: ${commodityName || commodity}` +
    (carDescBits.length ? ` · ${carDescBits.join(' · ')}` : '');

  const tgMessage = [
    `[${leadQuality}] Rail-vs-Truck Lead 🚂🚛`,
    `Lane: ${origin} → ${destination}` +
      (Number.isFinite(laneMiles) ? ` (${Math.round(laneMiles)}mi)` : ''),
    commodityLine,
    `Volume: ${fmtNum(annualCarloads)} carloads/year`,
    truckRateLine,
    Number.isFinite(annualSavings)
      ? `Annual savings if shift: ${fmtMoney(annualSavings)}`
      : '',
    Number.isFinite(co2eSavedTons)
      ? `CO2e saved: ${fmtNum(co2eSavedTons)} tons/yr`
      : '',
    `Email: ${email}` + (leadName ? ` (${leadName})` : ''),
    leadPhone ? `Phone: ${leadPhone}` : '',
    nowCstShort(),
  ].filter(Boolean).join('\n');

  // Lead-notification email rows (4th sink — info@swl).
  const summaryRows = [
    { label: 'Lead Quality', value: leadQuality, emphasize: true },
    { label: 'Email', value: email },
    ...(leadName ? [{ label: 'Name', value: leadName }] : []),
    ...(leadPhone ? [{ label: 'Phone', value: leadPhone }] : []),
    { label: 'Lane', value: `${origin} → ${destination}` },
    ...(Number.isFinite(laneMiles)
      ? [{ label: 'Lane Miles', value: `${Math.round(laneMiles).toLocaleString('en-US')} mi` }]
      : []),
    { label: 'Commodity', value: commodityName || commodity },
    ...(carTypeName || carType
      ? [{ label: 'Car Type', value: carTypeName || carType }]
      : []),
    ...(Number.isFinite(weightPerCarTons) && weightPerCarTons > 0
      ? [{ label: 'Weight per Car', value: `${weightPerCarTons.toFixed(0)} tons` }]
      : []),
    { label: 'Annual Carloads', value: fmtNum(annualCarloads) },
    {
      label: 'Truck Rate Used',
      value: `$${truckRatePerMile.toFixed(2)}/mi (${truckRateUserEntered ? 'USER-ENTERED' : 'ATRI default'})`,
    },
    ...(Number.isFinite(railAnnualTotal)
      ? [{ label: 'Rail Annual Total', value: fmtMillions(railAnnualTotal) }]
      : []),
    ...(Number.isFinite(truckAnnualTotal)
      ? [{ label: 'Truck Annual Total', value: fmtMillions(truckAnnualTotal) }]
      : []),
    ...(Number.isFinite(annualSavings)
      ? [{ label: 'Annual Savings', value: fmtMillions(annualSavings), emphasize: true }]
      : []),
    ...(Number.isFinite(co2eSavedTons)
      ? [{ label: 'CO2e Saved (tons/yr)', value: fmtNum(co2eSavedTons) }]
      : []),
    { label: 'Submitted', value: nowCstShort() },
    { label: 'Came from', value: attribution },
    { label: 'IP / UA', value: `${clientIp} / ${userAgent}` },
  ];

  const subject =
    `SWL Rail-vs-Truck Lead [${leadQuality}] — ${email} — ${origin} → ${destination}` +
    (Number.isFinite(annualSavings) ? ` (${fmtMillions(annualSavings)}/yr)` : '');

  const emailPromise = sendLeadEmail({
    toolName: 'rail-vs-truck mode-shift calculator',
    customerEmail: email,
    subject,
    heading: `New Rail-vs-Truck Lead [${leadQuality}]`,
    rows: summaryRows,
  });

  const customerEmailRows = [
    { label: 'Lane', value: `${origin} → ${destination}` },
    ...(Number.isFinite(laneMiles)
      ? [{ label: 'Lane Miles', value: `${Math.round(laneMiles).toLocaleString('en-US')} mi` }]
      : []),
    { label: 'Commodity', value: commodityName || commodity },
    ...(carTypeName || carType
      ? [{ label: 'Car Type', value: carTypeName || carType }]
      : []),
    { label: 'Annual Carloads', value: fmtNum(annualCarloads) },
    { label: 'Truck Rate Used', value: `$${truckRatePerMile.toFixed(2)}/mi` },
    ...(Number.isFinite(railAnnualTotal)
      ? [{ label: 'Rail (estimated)', value: fmtMillions(railAnnualTotal) }]
      : []),
    ...(Number.isFinite(truckAnnualTotal)
      ? [{ label: 'Truck (estimated)', value: fmtMillions(truckAnnualTotal) }]
      : []),
    ...(Number.isFinite(annualSavings)
      ? [{
          label: annualSavings >= 0 ? 'Estimated Annual Savings (Rail)' : 'Truck Lower By',
          value: fmtMillions(Math.abs(annualSavings)),
          emphasize: true,
        }]
      : []),
    ...(Number.isFinite(co2eSavedTons)
      ? [{ label: 'CO2e Avoided (tons/yr)', value: fmtNum(co2eSavedTons) }]
      : []),
  ];

  const customerEmailPromise = sendCustomerEmail({
    customerEmail: email,
    customerName: leadName,
    subject:
      `Your Rail-vs-Truck Mode-Shift Estimate — ${origin} → ${destination}`,
    intro:
      `Thanks for using the Steel Wheel Logistics Rail-vs-Truck Mode-Shift ` +
      `Calculator. Below is the indicative comparison we generated for your ` +
      `lane, using URCS 2024 rail costs, ATRI 2025 trucking averages, and ` +
      `EPA SmartWay 2024 emission factors. These are estimates — actual ` +
      `rail rates depend on equipment, commodity specifics, and routing ` +
      `carriers. To discuss your shipment, reply to this email or call ` +
      `(601) 821-2199.`,
    rows: customerEmailRows,
    outroFootnote:
      `Indicative comparison only. Steel Wheel Logistics does not guarantee ` +
      `rates. Contact us for a binding rate.`,
  });

  // Workmate CRM sync (6th sink).
  const tags: string[] = ['rail-vs-truck', leadQuality.toLowerCase()];
  if (commodityName || commodity) tags.push(commodityName || commodity);
  const noteLines = [
    `  Lane: ${origin} → ${destination}` +
      (Number.isFinite(laneMiles) ? ` (${Math.round(laneMiles)}mi)` : ''),
    `  Commodity: ${commodityName || commodity}` +
      (carTypeName || carType ? ` · ${carTypeName || carType}` : '') +
      (Number.isFinite(weightPerCarTons) ? ` · ${weightPerCarTons.toFixed(0)}t/car` : ''),
    `  Annual Carloads: ${fmtNum(annualCarloads)}`,
    `  Truck Rate: $${truckRatePerMile.toFixed(2)}/mi (${truckRateUserEntered ? 'user-entered' : 'ATRI default'})`,
    Number.isFinite(railAnnualTotal) ? `  Rail Annual: ${fmtMillions(railAnnualTotal)}` : '',
    Number.isFinite(truckAnnualTotal) ? `  Truck Annual: ${fmtMillions(truckAnnualTotal)}` : '',
    Number.isFinite(annualSavings) ? `  Savings: ${fmtMillions(annualSavings)}` : '',
    Number.isFinite(co2eSavedTons) ? `  CO2e saved: ${fmtNum(co2eSavedTons)} tons/yr` : '',
    leadPhone ? `  Phone: ${leadPhone}` : '',
    `  IP/UA: ${clientIp} / ${userAgent.slice(0, 120)}`,
  ];
  const crmPromise = syncWorkmateCrm({
    email,
    name: leadName,
    phone: leadPhone,
    source: 'swl-rail-vs-truck',
    tags,
    noteHeader: `[${nowCstShort()}] swl-rail-vs-truck [${leadQuality}]`,
    noteLines,
  });

  const [s3Ok, tgOk, emailOk, customerEmailOk, crmOk] = await Promise.all([
    appendS3(record),
    sendTelegram(tgMessage),
    emailPromise,
    customerEmailPromise,
    crmPromise,
  ]);

  return res.status(200).json({
    ok: true,
    lead_quality: leadQuality,
    sinks: {
      s3: s3Ok,
      telegram: tgOk,
      email: emailOk,
      email_customer: customerEmailOk,
      crm: crmOk,
    },
  });
}
