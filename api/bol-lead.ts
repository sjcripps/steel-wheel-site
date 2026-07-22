import type { VercelRequest, VercelResponse } from '@vercel/node';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { isSyntheticLead, sendLeadEmail, sendCustomerEmail, nowCstShort as _nowCstShortShared } from './_lead-email';

// Rail Bill of Lading Builder — lead capture. Pure-client tool; this
// endpoint exists only to register that a shipper used it. Mirrors
// demurrage-lead.ts down to the synthetic short-circuit + parallel sinks.
//
// Sinks (best-effort, each isolated):
//   1. S3 append at s3://openclawbucket/jakecbot/swl-leads/bol-builder.jsonl
//   2. Telegram DM to Jacob
//   3. info@swl summary email (Resend, via shared helper)
//   4. customer summary email (Resend, via shared helper) — informational copy
//
// We deliberately do NOT push BoL leads into the Workmate CRM — these are
// shippers documenting a move they've already chosen to make rail, not new
// inbound prospects, so the CRM bucket would dilute signal. Revisit if BoL
// volume justifies its own pipeline tag.
//
// Synthetic test traffic (@anthropic.com) short-circuits both sinks so
// smoke tests don't pollute the lead store.

const S3_BUCKET = 'openclawbucket';
const S3_KEY = 'jakecbot/swl-leads/bol-builder.jsonl';

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

const LANE_LABELS: Record<string, string> = {
  domestic: 'Domestic',
  us_mx: 'US to Mexico',
  us_ca: 'US to Canada',
};

function nowIsoUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nowCstShort(): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    month: 'numeric',
    day: 'numeric',
  });
  const parts = fmt.formatToParts(new Date());
  const part = (t: string) => parts.find(p => p.type === t)?.value || '';
  const h = part('hour');
  const m = part('minute');
  const dp = part('dayPeriod').replace(/\s/g, '');
  const mo = part('month');
  const dd = part('day');
  return `${h}:${m}${dp} CST ${mo}/${dd}`;
}

async function appendS3(record: Record<string, unknown>): Promise<boolean> {
  // S3 has no native append, so we read-modify-write. Low-volume leads
  // are fine for this pattern; matches demurrage-lead.ts.
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
    console.error('bol-lead S3 write failed:', err);
    return false;
  }
}

async function sendTelegram(message: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_USER_ID) {
    console.warn('bol-lead: Telegram env vars missing, skipping DM');
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
      console.error('bol-lead Telegram non-200:', res.status, body);
      return false;
    }
    return true;
  } catch (err) {
    console.error('bol-lead Telegram fetch failed:', err);
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
  const leadName = String(body.name ?? '').trim().slice(0, 200);
  const leadPhone = String(body.phone ?? '').trim().slice(0, 60);

  // Tool-specific context fields — all optional. The form can call this
  // endpoint at multiple points (gate-clear, PDF-download, DOCX-download)
  // and we record whatever state the form has at that moment.
  const laneType = String(body.lane_type ?? 'domestic').trim().slice(0, 20);
  const hazmat = !!body.hazmat;
  const erProvider = String(body.er_provider ?? '').trim().slice(0, 40);
  const ruleEleven = !!body.rule_11;
  const equipmentType = String(body.equipment_type ?? '').trim().slice(0, 40);
  const carrier = String(body.carrier ?? '').trim().slice(0, 40);
  const origin = String(body.origin ?? '').trim().slice(0, 200);
  const destination = String(body.destination ?? '').trim().slice(0, 200);
  const bolNumber = String(body.bol_number ?? '').trim().slice(0, 60);
  const action = String(body.action ?? 'submit').trim().slice(0, 40); // gate / pdf / docx / preview

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

  // Synthetic regression traffic — short-circuit so smokes don't pollute prod.
  if (isSyntheticLead(email, String(req.headers['user-agent'] || ''))) {
    return res.status(200).json({ ok: true, synthetic: true });
  }

  const clientIp = String(
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    ''
  );
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);

  const laneLabel = LANE_LABELS[laneType] || laneType;
  const record = {
    ts: nowIsoUtc(),
    tool: 'rail-bol-builder',
    action,
    email,
    name: leadName || null,
    phone: leadPhone || null,
    bol_number: bolNumber || null,
    lane_type: laneType,
    lane_label: laneLabel,
    hazmat,
    er_provider: erProvider || null,
    rule_11: ruleEleven,
    equipment_type: equipmentType || null,
    carrier: carrier || null,
    origin: origin || null,
    destination: destination || null,
    ip: clientIp,
    user_agent: userAgent,
  };

  const hazmatLabel = hazmat
    ? (erProvider ? `Yes (ER: ${erProvider})` : 'Yes')
    : 'No';
  const lanePieces: string[] = [];
  if (origin) lanePieces.push(origin);
  if (destination) lanePieces.push(destination);
  const laneStr = lanePieces.length ? lanePieces.join(' → ') : '(not yet entered)';
  const carrierBits: string[] = [];
  if (carrier) carrierBits.push(carrier);
  if (ruleEleven) carrierBits.push('Rule 11');
  const carrierStr = carrierBits.length ? carrierBits.join(' / ') : 'TBD';

  const message =
    `\u{1F4DC} [Free Rail BoL Builder] new lead\n` +
    `${email}\n` +
    `Lane: ${laneLabel}${laneStr === '(not yet entered)' ? '' : ' — ' + laneStr}\n` +
    `Hazmat: ${hazmatLabel}\n` +
    `Carriers: ${carrierStr}\n` +
    `Action: ${action}\n` +
    nowCstShort();

  // info@swl summary email (4th sink).
  const summaryRows = [
    { label: 'Email', value: email },
    ...(leadName ? [{ label: 'Name', value: leadName }] : []),
    ...(leadPhone ? [{ label: 'Phone', value: leadPhone }] : []),
    { label: 'Lane Type', value: laneLabel },
    { label: 'Origin', value: origin || '—' },
    { label: 'Destination', value: destination || '—' },
    { label: 'Carrier(s)', value: carrierStr },
    { label: 'Equipment', value: equipmentType || '—' },
    { label: 'Hazmat', value: hazmatLabel },
    ...(hazmat && erProvider ? [{ label: 'ER Provider', value: erProvider }] : []),
    { label: 'Rule 11', value: ruleEleven ? 'Yes' : 'No' },
    ...(bolNumber ? [{ label: 'BoL Number', value: bolNumber }] : []),
    { label: 'Action', value: action },
    { label: 'Submitted', value: nowCstShort(), emphasize: true },
    { label: 'IP / UA', value: `${clientIp} / ${userAgent}` },
  ];

  const emailPromise = sendLeadEmail({
    toolName: 'rail bill of lading builder',
    customerEmail: email,
    subject: `SWL BoL Builder Lead — ${email} — ${laneLabel}${hazmat ? ' (hazmat)' : ''}`,
    heading: 'New Rail Bill of Lading Builder Lead',
    rows: summaryRows,
  });

  // Customer-side email — only on terminal actions (PDF/DOCX download or
  // explicit submit). Skip on the bare gate-clear to avoid spamming.
  const customerEmailPromise = (action === 'pdf' || action === 'docx' || action === 'submit')
    ? sendCustomerEmail({
        customerEmail: email,
        customerName: leadName,
        subject: `Your Rail Bill of Lading — Steel Wheel Logistics`,
        intro: `Thanks for using the Steel Wheel Logistics Rail Bill of Lading Builder. ` +
          `This is an informational copy of your build session — the PDF and DOCX files ` +
          `you downloaded locally are the official BoL document. If you'd like Steel ` +
          `Wheel to help you book the lane, broker the move, or review the document ` +
          `before tender, reply to this email or call (601) 821-2199.`,
        rows: [
          { label: 'Lane Type', value: laneLabel },
          { label: 'Origin', value: origin || '—' },
          { label: 'Destination', value: destination || '—' },
          { label: 'Carrier(s)', value: carrierStr },
          { label: 'Equipment', value: equipmentType || '—' },
          { label: 'Hazmat', value: hazmatLabel },
          ...(bolNumber ? [{ label: 'BoL Number', value: bolNumber }] : []),
        ],
        outroFootnote:
          `This builder generates BoL documents for shipper review and tender. ` +
          `Steel Wheel Logistics is informational only — the line-haul railroad accepts ` +
          `or rejects the actual BoL. For hazmat shipments, verify §172.604 emergency-` +
          `response provider contract is active and §172.204 certification is signed by ` +
          `a trained hazmat employee before tender.`,
      })
    : Promise.resolve(false);

  const [s3Ok, tgOk, emailOk, customerEmailOk] = await Promise.all([
    appendS3(record),
    sendTelegram(message),
    emailPromise,
    customerEmailPromise,
  ]);

  return res.status(200).json({
    ok: true,
    sinks: {
      s3: s3Ok,
      telegram: tgOk,
      email: emailOk,
      email_customer: customerEmailOk,
    },
  });
}
