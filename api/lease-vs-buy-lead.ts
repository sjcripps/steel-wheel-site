import type { VercelRequest, VercelResponse } from '@vercel/node';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { isSyntheticLead, clientIpFrom, sendLeadEmail, sendCustomerEmail, syncWorkmateCrm } from './_lead-email';

// Lease-vs-Buy calculator lead capture. Mirrors demurrage-lead.ts: math is
// pure-client, this endpoint is lead capture + the emailed full breakdown
// (the actual lead magnet — teaser on page, line items by email).
//
// Sinks (best-effort, isolated): S3 jsonl, Telegram DM, internal lead
// email, customer breakdown email, Workmate CRM contact.

const S3_BUCKET = 'openclawbucket';
const S3_KEY = 'jakecbot/swl-leads/lease-vs-buy.jsonl';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || '';

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'tempmail.com',
  'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'sharklasers.com',
  'maildrop.cc', 'getnada.com', 'trashmail.com', 'mintemail.com',
  'fakeinbox.com', 'tempinbox.com', 'dispostable.com',
]);

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)+$/;

const CAR_LABELS: Record<string, string> = {
  covered_hopper: 'Covered Hopper (grain service)',
  tank_car: 'Tank Car',
  boxcar: 'Boxcar',
  gondola: 'Gondola',
  open_hopper: 'Open-Top Hopper',
  flat_car: 'Flat Car',
};

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '$—';
  return '$' + Math.round(n).toLocaleString('en-US');
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

async function appendS3(record: Record<string, unknown>): Promise<boolean> {
  try {
    const s3 = new S3Client({ region: AWS_REGION });
    let existing = '';
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: S3_KEY }));
      existing = (await obj.Body?.transformToString()) || '';
    } catch (err: any) {
      if (err?.name !== 'NoSuchKey' && err?.$metadata?.httpStatusCode !== 404) throw err;
    }
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: S3_KEY,
      Body: existing + JSON.stringify(record) + '\n',
      ContentType: 'application/x-ndjson',
    }));
    return true;
  } catch (err) {
    console.error('lease-vs-buy S3 write failed:', err);
    return false;
  }
}

async function sendTelegram(message: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_USER_ID) {
    console.warn('lease-vs-buy: Telegram env vars missing, skipping DM');
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_USER_ID, text: message, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      console.error('lease-vs-buy Telegram non-200:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('lease-vs-buy Telegram fetch failed:', err);
    return false;
  }
}

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
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const email = String(body.email ?? '').trim().toLowerCase();
  const leadName = String(body.name ?? '').trim().slice(0, 200);
  const leadPhone = String(body.phone ?? '').trim().slice(0, 60);

  if (!email) return res.status(400).json({ ok: false, error: 'Email is required.', code: 'email_format' });
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid email address.', code: 'email_format' });
  }
  const domain = email.split('@')[1] || '';
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return res.status(400).json({ ok: false, error: 'Please use your work email.', code: 'email_disposable' });
  }
  if (isSyntheticLead(email, String(req.headers['user-agent'] || ''), clientIpFrom(req))) {
    return res.status(200).json({ ok: true, synthetic: true });
  }

  // Page sends hyphenated slugs (covered-hopper); normalize for the lookup.
  const carType = String(body.car_type ?? '').trim().replace(/-/g, '_');
  const carLabel = CAR_LABELS[carType] || String(body.car_label ?? '').slice(0, 60) || 'Railcar';
  const condition = String(body.condition ?? '').trim() === 'used' ? 'used' : 'new';
  const numCars = Math.max(1, Math.min(500, Number(body.num_cars) || 1));
  const termYears = Math.max(1, Math.min(10, Number(body.term_years) || 5));
  const leaseMonthly = Number(body.lease_monthly);
  const purchasePrice = Number(body.purchase_price);
  const resalePct = Number(body.resale_pct);
  const capitalRatePct = Number(body.capital_rate_pct);
  const maintenanceYr = Number(body.maintenance_yr);
  const taxYr = Number(body.tax_yr);
  const leaseTotal = Number(body.lease_total);
  const buyTotal = Number(body.buy_total);
  const leaseMoEquiv = Number(body.lease_monthly_equiv);
  const buyMoEquiv = Number(body.buy_monthly_equiv);
  const verdict = String(body.verdict ?? '').slice(0, 20);

  const clientIp = String(
    req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || ''
  );
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);
  const landingReferrer = String(body.landing_referrer ?? '').trim().slice(0, 500);
  const referrerKind = String(body.referrer_kind ?? '').trim().slice(0, 20);
  const entryQuery = String(body.entry_query ?? '').trim().slice(0, 300);
  const attribution = attributionLabel(referrerKind, landingReferrer, entryQuery);
  const referrer = String(req.headers['referer'] || '').slice(0, 500);

  const record = {
    ts: nowIsoUtc(),
    tool: 'lease-vs-buy',
    email, name: leadName || null, phone: leadPhone || null,
    car_type: carType, car_label: carLabel, condition,
    num_cars: numCars, term_years: termYears,
    lease_monthly: Number.isFinite(leaseMonthly) ? leaseMonthly : null,
    purchase_price: Number.isFinite(purchasePrice) ? purchasePrice : null,
    resale_pct: Number.isFinite(resalePct) ? resalePct : null,
    capital_rate_pct: Number.isFinite(capitalRatePct) ? capitalRatePct : null,
    maintenance_yr: Number.isFinite(maintenanceYr) ? maintenanceYr : null,
    tax_yr: Number.isFinite(taxYr) ? taxYr : null,
    lease_total: Number.isFinite(leaseTotal) ? leaseTotal : null,
    buy_total: Number.isFinite(buyTotal) ? buyTotal : null,
    lease_monthly_equiv: Number.isFinite(leaseMoEquiv) ? leaseMoEquiv : null,
    buy_monthly_equiv: Number.isFinite(buyMoEquiv) ? buyMoEquiv : null,
    verdict: verdict || null,
    ip: clientIp, user_agent: userAgent,
    landing_referrer: landingReferrer || null,
    referrer_kind: referrerKind || null,
    entry_query: entryQuery || null,
    referrer: referrer || null,
  };

  const verdictStr = verdict === 'lease' ? 'LEASE wins' : verdict === 'buy' ? 'BUY wins' : 'near even';
  const message =
    `\u{1F682} SWL lease-vs-buy lead: ${email} — ${carLabel} (${condition}), ` +
    `${numCars} car${numCars === 1 ? '' : 's'} × ${termYears}yr. ` +
    `${verdictStr}: lease ${fmtMoney(leaseMoEquiv)}/mo vs buy ${fmtMoney(buyMoEquiv)}/mo per car. ${nowCstShort()}`;

  const summaryRows = [
    { label: 'Email', value: email, emphasize: true },
    ...(leadName ? [{ label: 'Name', value: leadName }] : []),
    ...(leadPhone ? [{ label: 'Phone', value: leadPhone }] : []),
    { label: 'Car Type', value: `${carLabel} (${condition})` },
    { label: 'Fleet / Term', value: `${numCars} cars × ${termYears} years` },
    { label: 'Lease Rate Used', value: `${fmtMoney(leaseMonthly)}/car/mo` },
    { label: 'Purchase Price Used', value: `${fmtMoney(purchasePrice)}/car` },
    { label: 'Lease Monthly-Equiv', value: `${fmtMoney(leaseMoEquiv)}/car/mo` },
    { label: 'Buy Monthly-Equiv', value: `${fmtMoney(buyMoEquiv)}/car/mo` },
    { label: 'Verdict', value: verdictStr, emphasize: true },
    { label: 'Submitted', value: nowCstShort() },
    { label: 'Came from', value: attribution },
    { label: 'IP / UA', value: `${clientIp} / ${userAgent}` },
  ];

  const emailPromise = sendLeadEmail({
    toolName: 'lease-vs-buy calculator',
    customerEmail: email,
    subject: `SWL Lease-vs-Buy Lead — ${email} — ${carLabel} ${numCars}×${termYears}yr (${verdictStr})`,
    heading: 'New Lease-vs-Buy Calculator Lead',
    rows: summaryRows,
  });

  // The emailed full breakdown IS the lead magnet.
  const customerEmailPromise = sendCustomerEmail({
    customerEmail: email,
    customerName: leadName,
    subject: `Your Railcar Lease vs. Buy Analysis — ${carLabel}, ${numCars} car${numCars === 1 ? '' : 's'} over ${termYears} years`,
    intro:
      `Thanks for using the Steel Wheel Logistics lease-vs-buy calculator. ` +
      `Below is your full line-item comparison based on the assumptions you entered. ` +
      `These are indicative planning figures built from published ranges — not offers or quotes; ` +
      `actual lease rates and purchase prices depend on car age, spec, term, mileage, and market timing.`,
    rows: [
      { label: 'Car Type', value: `${carLabel} (${condition})` },
      { label: 'Fleet Size', value: `${numCars} car${numCars === 1 ? '' : 's'}` },
      { label: 'Term', value: `${termYears} years` },
      { label: 'Full-Service Lease Rate', value: `${fmtMoney(leaseMonthly)}/car/mo` },
      { label: 'Lease Total (fleet, term)', value: fmtMoney(leaseTotal) },
      { label: 'Purchase Price', value: `${fmtMoney(purchasePrice)}/car` },
      { label: 'Resale Assumption', value: `${Number.isFinite(resalePct) ? resalePct : '—'}% of purchase at end of term` },
      { label: 'Cost of Capital', value: `${Number.isFinite(capitalRatePct) ? capitalRatePct : '—'}%/yr` },
      { label: 'Owner Maintenance + Compliance', value: `${fmtMoney(maintenanceYr)}/car/yr` },
      { label: 'Taxes + Registration', value: `${fmtMoney(taxYr)}/car/yr` },
      { label: 'Buy Total (fleet, term)', value: fmtMoney(buyTotal) },
      { label: 'Lease Monthly-Equivalent', value: `${fmtMoney(leaseMoEquiv)}/car/mo` },
      { label: 'Buy Monthly-Equivalent', value: `${fmtMoney(buyMoEquiv)}/car/mo` },
      { label: 'Verdict (on these assumptions)', value: verdictStr, emphasize: true },
    ],
    outroFootnote:
      `Indicative planning analysis only — not an offer, quote, or financial advice. ` +
      `Steel Wheel Logistics runs rail operations for shippers without a rail department: ` +
      `car sourcing, lease negotiation support, routing, and rate work. ` +
      `Reply to this email or call (601) 821-2199 to talk through your acquisition.`,
  });

  const crmPromise = syncWorkmateCrm({
    email,
    name: leadName,
    phone: leadPhone,
    source: 'swl-lease-vs-buy',
    tags: ['lease-vs-buy', carLabel],
    noteHeader: `[${nowCstShort()}] swl-lease-vs-buy`,
    noteLines: [
      `  Car: ${carLabel} (${condition}) × ${numCars}, ${termYears}yr term`,
      `  Lease ${fmtMoney(leaseMoEquiv)}/mo vs Buy ${fmtMoney(buyMoEquiv)}/mo per car — ${verdictStr}`,
      `  Assumptions: lease ${fmtMoney(leaseMonthly)}/mo, price ${fmtMoney(purchasePrice)}, resale ${resalePct}%, capital ${capitalRatePct}%`,
      leadPhone ? `  Phone: ${leadPhone}` : '',
      `  Came from: ${attribution}`,
    ],
  });

  const [s3Ok, tgOk, emailOk, customerOk, crmOk] = await Promise.all([
    appendS3(record),
    sendTelegram(message),
    emailPromise,
    customerEmailPromise,
    crmPromise,
  ]);

  return res.status(200).json({
    ok: true,
    sinks: { s3: s3Ok, telegram: tgOk, email: emailOk, customer_email: customerOk, crm: crmOk },
  });
}
