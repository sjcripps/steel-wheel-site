import type { VercelRequest, VercelResponse } from '@vercel/node';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { sendLeadEmail } from './_lead-email';

// Sublease Board lead capture. Mirrors demurrage-lead.ts pattern.
//
// Sinks (best-effort, isolated try/catch on each):
//   1. S3 append at s3://openclawbucket/jakecbot/swl-leads/sublease-board.jsonl
//   2. Telegram DM to Jacob via Bot API
//
// Synthetic test traffic (@anthropic.com) is short-circuited so smoke
// tests don't pollute either sink.

const S3_BUCKET = 'openclawbucket';
const S3_KEY = 'jakecbot/swl-leads/sublease-board.jsonl';

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

const CAR_TYPES = [
  'boxcar',
  'gondola',
  'flatcar',
  'hopper',
  'tank',
  'reefer',
  'autorack',
  'mixed',
  'other',
];

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
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    month: 'numeric',
    day: 'numeric',
  });
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
    console.error('sublease-lead S3 write failed:', err);
    return false;
  }
}

async function sendTelegram(message: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_USER_ID) {
    console.warn('sublease-lead: Telegram env vars missing, skipping DM');
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
      console.error('sublease-lead Telegram non-200:', res.status, body);
      return false;
    }
    return true;
  } catch (err) {
    console.error('sublease-lead Telegram fetch failed:', err);
    return false;
  }
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
  const listingType = String(body.listing_type ?? '').trim();
  const carType = String(body.car_type ?? '').trim();
  const quantity = Number(body.quantity);
  const origin = String(body.origin ?? '').trim();
  const destination = String(body.destination ?? '').trim();
  const pricing = String(body.pricing ?? '').trim();
  const timeline = String(body.timeline ?? '').trim();
  const leadName = String(body.name ?? '').trim().slice(0, 200);
  const leadPhone = String(body.phone ?? '').trim().slice(0, 60);

  // Email validation
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

  // Validate listing fields
  if (!['offering', 'seeking'].includes(listingType)) {
    return res.status(400).json({ ok: false, error: 'Invalid listing type' });
  }
  if (!CAR_TYPES.includes(carType)) {
    return res.status(400).json({ ok: false, error: 'Invalid car type' });
  }
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 500) {
    return res.status(400).json({ ok: false, error: 'Quantity must be between 1 and 500' });
  }
  if (!origin || origin.length < 2) {
    return res.status(400).json({ ok: false, error: 'Origin is required' });
  }
  if (!destination || destination.length < 2) {
    return res.status(400).json({ ok: false, error: 'Destination is required' });
  }

  // Synthetic regression traffic
  if (email.endsWith('@anthropic.com')) {
    return res.status(200).json({ ok: true, synthetic: true });
  }

  const clientIp = String(
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    ''
  );
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);

  const record = {
    ts: nowIsoUtc(),
    tool: 'sublease-board',
    email,
    name: leadName || null,
    phone: leadPhone || null,
    listing_type: listingType,
    car_type: carType,
    quantity,
    origin,
    destination,
    pricing: pricing || null,
    timeline: timeline || null,
    ip: clientIp,
    user_agent: userAgent,
  };

  const message =
    `🚂 SWL sublease-board lead: ${email} — ` +
    `${listingType === 'offering' ? 'Offering' : 'Seeking'} ${quantity} ${carType} car${quantity === 1 ? '' : 's'} ` +
    `${origin} → ${destination}. ${nowCstShort()}`;

  const summaryRows = [
    { label: 'Email', value: email },
    ...(leadName ? [{ label: 'Name', value: leadName }] : []),
    ...(leadPhone ? [{ label: 'Phone', value: leadPhone }] : []),
    { label: 'Type', value: listingType === 'offering' ? 'Offering' : 'Seeking' },
    { label: 'Equipment', value: carType },
    { label: 'Quantity', value: String(quantity) },
    { label: 'Origin', value: origin },
    { label: 'Destination', value: destination },
    ...(pricing ? [{ label: 'Pricing', value: pricing }] : []),
    ...(timeline ? [{ label: 'Timeline', value: timeline }] : []),
    { label: 'Submitted', value: nowCstShort() },
    { label: 'IP / UA', value: `${clientIp} / ${userAgent}` },
  ];

  const emailPromise = sendLeadEmail({
    toolName: 'sublease board',
    customerEmail: email,
    subject: `SWL Sublease Board Listing — ${listingType === 'offering' ? 'Offering' : 'Seeking'} ${quantity} ${carType} car${quantity === 1 ? '' : 's'} (${origin} → ${destination})`,
    heading: 'New Sublease Board Listing',
    rows: summaryRows,
  });

  const [s3Ok, tgOk, emailOk] = await Promise.all([
    appendS3(record),
    sendTelegram(message),
    emailPromise,
  ]);

  return res.status(200).json({
    ok: true,
    sinks: {
      s3: s3Ok,
      telegram: tgOk,
      email: emailOk,
    },
  });
}
