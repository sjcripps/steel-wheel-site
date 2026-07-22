import type { VercelRequest, VercelResponse } from '@vercel/node';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { isSyntheticLead, clientIpFrom, sendLeadEmail, syncWorkmateCrm } from './_lead-email';

// Commodity-flow-map lead capture. Pure email-gate (no compute payload):
// user submits email to unlock the map, we capture the lead. Mirrors the
// transload-lead pattern.
//
// Sinks (best-effort, isolated try/catch on each):
//   1. S3 append at s3://openclawbucket/jakecbot/swl-leads/commodity-flow.jsonl
//   2. Telegram DM to Jacob via Bot API
//   3. Lead email to ops + sync to Workmate CRM
//
// Synthetic test traffic (@anthropic.com) is short-circuited.

const S3_BUCKET = 'openclawbucket';
const S3_KEY = 'jakecbot/swl-leads/commodity-flow.jsonl';

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
    console.error('commodity-flow-lead S3 write failed:', err);
    return false;
  }
}

async function sendTelegram(message: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_USER_ID) {
    console.warn('commodity-flow-lead: Telegram env vars missing, skipping DM');
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
      console.error('commodity-flow-lead Telegram non-200:', res.status, body);
      return false;
    }
    return true;
  } catch (err) {
    console.error('commodity-flow-lead Telegram fetch failed:', err);
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
  const company = String(body.company ?? '').trim().slice(0, 200);
  const leadName = String(body.name ?? '').trim().slice(0, 200);
  const leadPhone = String(body.phone ?? '').trim().slice(0, 60);

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

  const record = {
    ts: nowIsoUtc(),
    tool: 'commodity-flow-map',
    email,
    name: leadName || null,
    phone: leadPhone || null,
    company: company || null,
    ip: clientIp,
    user_agent: userAgent,
  };

  const companyStr = company ? ` (${company})` : '';
  const message =
    `\u{1F5FA}️ SWL commodity-flow-map lead: ${email}${companyStr}. ${nowCstShort()}`;

  const emailPromise = sendLeadEmail({
    toolName: 'commodity flow map',
    customerEmail: email,
    subject: `SWL Commodity Flow Map Lead — ${email}${company ? ' (' + company + ')' : ''}`,
    heading: 'New Commodity Flow Map Lead',
    rows: [
      { label: 'Email', value: email, emphasize: true },
      ...(leadName ? [{ label: 'Name', value: leadName }] : []),
      ...(leadPhone ? [{ label: 'Phone', value: leadPhone }] : []),
      { label: 'Company', value: company || '(not provided)' },
      { label: 'Submitted', value: nowCstShort() },
      { label: 'IP / UA', value: `${clientIp} / ${userAgent}` },
    ],
  });

  // Workmate CRM sink — commodity-flow tier-zero leads (unlock-only gate,
  // no quote payload to render back to the customer).
  const crmPromise = syncWorkmateCrm({
    email,
    name: leadName,
    phone: leadPhone,
    source: 'swl-commodity-flow',
    tags: ['commodity-flow-map'],
    noteHeader: `[${nowCstShort()}] swl-commodity-flow`,
    noteLines: [
      `  Tool: commodity flow map`,
      company ? `  Company: ${company}` : '',
      leadPhone ? `  Phone: ${leadPhone}` : '',
      `  IP/UA: ${clientIp} / ${userAgent.slice(0, 120)}`,
    ],
  });

  const [s3Ok, tgOk, emailOk, crmOk] = await Promise.all([
    appendS3(record),
    sendTelegram(message),
    emailPromise,
    crmPromise,
  ]);

  return res.status(200).json({
    ok: true,
    sinks: {
      s3: s3Ok,
      telegram: tgOk,
      email: emailOk,
      crm: crmOk,
    },
  });
}
