import type { VercelRequest, VercelResponse } from '@vercel/node';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { isSyntheticLead, clientIpFrom, sendLeadEmail, sendCustomerEmail, syncWorkmateCrm, nowCstShort as _nowCstShortShared } from './_lead-email';

// Demurrage-tool lead capture. Mirrors the rail-rate-quote pattern but
// runs the whole stack (validation + S3 + Telegram) inside this Vercel
// function so we don't need to stand up a Flask backend just for the
// calculator. Math is pure-client; this endpoint is lead-capture only.
//
// Sinks (best-effort, isolated try/catch on each):
//   1. S3 append at s3://openclawbucket/jakecbot/swl-leads/demurrage-tool.jsonl
//   2. Telegram DM to Jacob via Bot API
//
// Synthetic test traffic (@anthropic.com) is short-circuited so smoke
// tests don't pollute either sink.

const S3_BUCKET = 'openclawbucket';
const S3_KEY = 'jakecbot/swl-leads/demurrage-tool.jsonl';

// AWS region — Vercel functions have no IAM role, so credentials come
// from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars (same names
// the SDK reads automatically). Region defaults to us-east-1 for the
// openclawbucket bucket.
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || '';

// Common disposable / throwaway domains we don't want polluting the lead
// store. Not exhaustive but catches the obvious ones; full MX validation
// would be done server-side if we ever stand a Python backend up.
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

const EQUIP_LABELS: Record<string, string> = {
  rail_controlled: 'Rail-Controlled',
  reefer: 'Reefer',
  private: 'Private-Controlled',
  other_purposes: 'Held for Other Purposes',
};

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '$—';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function nowIsoUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nowCstShort(): string {
  // Render a short "h:mma CST mm/dd" string for the Telegram DM. We use
  // toLocaleString with the Chicago tz so daylight-saving handling is
  // correct without us tracking it.
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    month: 'numeric',
    day: 'numeric',
  });
  // Output like "12:34 PM, 4/28" — coalesce into "12:34PM CST 4/28".
  const parts = fmt.formatToParts(d);
  const part = (t: string) => parts.find(p => p.type === t)?.value || '';
  const h = part('hour');
  const m = part('minute');
  const dp = part('dayPeriod').replace(/\s/g, '');
  const mo = part('month');
  const dd = part('day');
  return `${h}:${m}${dp} CST ${mo}/${dd}`;
}

async function appendS3(record: Record<string, unknown>): Promise<boolean> {
  // S3 has no native append, so we read-modify-write. For low-volume
  // lead traffic this is fine. If ever hot enough to matter we'd switch
  // to per-record keys.
  try {
    const s3 = new S3Client({ region: AWS_REGION });
    let existing = '';
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: S3_KEY }));
      existing = (await obj.Body?.transformToString()) || '';
    } catch (err: any) {
      // NoSuchKey on first run is expected.
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
    console.error('demurrage-lead S3 write failed:', err);
    return false;
  }
}

async function sendTelegram(message: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_USER_ID) {
    console.warn('demurrage-lead: Telegram env vars missing, skipping DM');
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
      console.error('demurrage-lead Telegram non-200:', res.status, body);
      return false;
    }
    return true;
  } catch (err) {
    console.error('demurrage-lead Telegram fetch failed:', err);
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
  const equipmentType = String(body.equipment_type ?? '').trim();
  const numCars = Number(body.num_cars);
  const daysHeld = Number(body.days_held);
  const hazmat = !!body.hazmat;
  const holdForInstr = !!body.hold_for_instructions;
  const perCarEstimate = Number(body.per_car_estimate);
  const totalEstimate = Number(body.total_estimate);
  // Optional contact fields (added 2026-04-30).
  const leadName = String(body.name ?? '').trim().slice(0, 200);
  const leadPhone = String(body.phone ?? '').trim().slice(0, 60);

  // Email validation — format + disposable blocklist. We don't do MX
  // checks here (would need DNS, more latency); the Python service has
  // those if we ever re-route. Format is the 90% catch.
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
  if (!EQUIP_LABELS[equipmentType]) {
    return res.status(400).json({ ok: false, error: 'Unknown equipment type' });
  }
  if (!Number.isFinite(numCars) || numCars < 1 || numCars > 500) {
    return res.status(400).json({ ok: false, error: 'num_cars must be between 1 and 500' });
  }
  if (!Number.isFinite(daysHeld) || daysHeld < 1 || daysHeld > 120) {
    return res.status(400).json({ ok: false, error: 'days_held must be between 1 and 120' });
  }

  // Synthetic regression traffic — short-circuit both sinks so smoke
  // tests don't pollute the lead store or DM Jacob. Mirrors the
  // lead_capture.py:152 short-circuit.
  if (isSyntheticLead(email, String(req.headers['user-agent'] || ''), clientIpFrom(req))) {
    return res.status(200).json({ ok: true, synthetic: true });
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

  const record = {
    ts: nowIsoUtc(),
    tool: 'demurrage-calculator',
    email,
    name: leadName || null,
    phone: leadPhone || null,
    equipment_type: equipmentType,
    equipment_label: EQUIP_LABELS[equipmentType],
    num_cars: numCars,
    days_held: daysHeld,
    hazmat,
    hold_for_instructions: holdForInstr,
    per_car_estimate: Number.isFinite(perCarEstimate) ? perCarEstimate : null,
    total_estimate: Number.isFinite(totalEstimate) ? totalEstimate : null,
    rate_book: 'BNSF 6004-C eff. 2025-07-01',
    ip: clientIp,
    user_agent: userAgent,
    landing_referrer: landingReferrer || null,
    referrer_kind: referrerKind || null,
    entry_query: entryQuery || null,
  };

  // Fire both sinks in parallel; failure in one doesn't kill the other.
  const surcharges: string[] = [];
  if (hazmat) surcharges.push('hazmat');
  if (holdForInstr) surcharges.push('hold-for-instr');
  const surchargeStr = surcharges.length ? ` [${surcharges.join('+')}]` : '';
  const totalStr = Number.isFinite(totalEstimate) ? fmtMoney(totalEstimate) : '(no total)';
  const perCarStr = Number.isFinite(perCarEstimate) ? fmtMoney(perCarEstimate) : '—';
  const message =
    `\u{1F682} SWL demurrage-tool lead: ${email} — ` +
    `${EQUIP_LABELS[equipmentType]}, ${numCars} car${numCars === 1 ? '' : 's'} × ${daysHeld}d${surchargeStr}. ` +
    `Per-car ${perCarStr}, total ${totalStr}. ${nowCstShort()}`;

  const surchargeRow = surcharges.length ? surcharges.join(' + ') : 'None';
  const summaryRows = [
    { label: 'Email', value: email },
    ...(leadName ? [{ label: 'Name', value: leadName }] : []),
    ...(leadPhone ? [{ label: 'Phone', value: leadPhone }] : []),
    { label: 'Equipment', value: EQUIP_LABELS[equipmentType] },
    { label: 'Cars', value: String(numCars) },
    { label: 'Days Held', value: String(daysHeld) },
    { label: 'Surcharges', value: surchargeRow },
    { label: 'Per-Car Estimate', value: perCarStr },
    { label: 'Total Estimate', value: totalStr, emphasize: true },
    { label: 'Rate Book', value: 'BNSF 6004-C eff. 2025-07-01' },
    { label: 'Submitted', value: nowCstShort() },
    { label: 'Came from', value: attribution },
    { label: 'IP / UA', value: `${clientIp} / ${userAgent}` },
  ];
  const emailPromise = sendLeadEmail({
    toolName: 'demurrage calculator',
    customerEmail: email,
    subject: `SWL Demurrage Lead — ${email} — ${EQUIP_LABELS[equipmentType]} ${numCars}×${daysHeld}d (${totalStr})`,
    heading: 'New Demurrage Calculator Lead',
    rows: summaryRows,
  });

  // 5th sink — customer-email copy. Skip synthetic, skip if customer didn't
  // even submit an email-validated lead (impossible at this point, but defensive).
  const customerEmailPromise = sendCustomerEmail({
    customerEmail: email,
    customerName: leadName,
    subject: `Your Steel Wheel Demurrage Estimate — ${EQUIP_LABELS[equipmentType]}, ${numCars} car${numCars === 1 ? '' : 's'} × ${daysHeld}d`,
    intro: `Thanks for using the Steel Wheel Logistics demurrage calculator. ` +
      `Below is an indicative estimate based on the BNSF 6004-C rate book ` +
      `effective 2025-07-01 — actual demurrage is billed by the line-haul ` +
      `railroad and depends on car ownership, holiday calendar, and ` +
      `customer-specific tariff agreements.`,
    rows: [
      { label: 'Equipment', value: EQUIP_LABELS[equipmentType] },
      { label: 'Cars', value: String(numCars) },
      { label: 'Days Held', value: String(daysHeld) },
      { label: 'Surcharges', value: surchargeRow },
      { label: 'Per-Car Estimate', value: perCarStr },
      { label: 'Total Estimate', value: totalStr, emphasize: true },
      { label: 'Rate Book', value: 'BNSF 6004-C eff. 2025-07-01' },
    ],
    outroFootnote:
      `This is an estimate only. Steel Wheel Logistics is informational ` +
      `only — the line-haul railroad bills demurrage. For account-specific ` +
      `numbers, reply to this email or call (601) 821-2199.`,
  });

  // 6th sink — Workmate CRM.
  const tags: string[] = [EQUIP_LABELS[equipmentType]];
  if (hazmat) tags.push('hazmat');
  if (holdForInstr) tags.push('hold-for-instr');
  const crmPromise = syncWorkmateCrm({
    email,
    name: leadName,
    phone: leadPhone,
    source: 'swl-demurrage',
    tags,
    noteHeader: `[${nowCstShort()}] swl-demurrage`,
    noteLines: [
      `  Equipment: ${EQUIP_LABELS[equipmentType]}`,
      `  Cars × Days: ${numCars} × ${daysHeld}`,
      `  Surcharges: ${surchargeRow}`,
      `  Per-car / Total: ${perCarStr} / ${totalStr}`,
      `  Rate book: BNSF 6004-C eff. 2025-07-01`,
      leadPhone ? `  Phone: ${leadPhone}` : '',
      `  IP/UA: ${clientIp} / ${userAgent.slice(0, 120)}`,
    ],
  });

  const [s3Ok, tgOk, emailOk, customerEmailOk, crmOk] = await Promise.all([
    appendS3(record),
    sendTelegram(message),
    emailPromise,
    customerEmailPromise,
    crmPromise,
  ]);

  return res.status(200).json({
    ok: true,
    sinks: {
      s3: s3Ok,
      telegram: tgOk,
      email: emailOk,
      email_customer: customerEmailOk,
      crm: crmOk,
    },
  });
}
