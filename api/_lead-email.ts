import { generateLeadReplyDraft } from './_lead-reply-draft';
import { notifyDraftReady } from './_draft-notify';

// Shared email-notification helpers for SWL lead-capture endpoints.
//
// 4th sink (info@swl):     sendLeadEmail()       — formatted lead summary
//                                                  to the SWL inbox.
// 5th sink (customer):     sendCustomerEmail()   — quote/lead summary TO
//                                                  the customer themselves.
// 6th sink (Workmate CRM): syncWorkmateCrm()     — Supabase REST insert/
//                                                  update on wm_contacts.
//
// All sinks use the same best-effort contract: any failure is caught,
// logged, and returned as `false` from the helper. Never raises.
//
// Underscore-prefixed filename keeps Vercel from registering this file as
// a public route.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Synthetic-traffic local-part prefixes. Our own smoke tests and monitors
// probe the LIVE prod endpoints, so they have to be filtered at the writer
// — by the time a probe reaches S3/Telegram/CRM it has already fired a
// fake-lead DM and created a junk CRM contact. (2026-07-22: a
// `qa-crm-<ts>@steelwheellogistics.com` curl probe did exactly that on the
// transload directory; the old guard only covered @anthropic.com.)
const SYNTHETIC_PREFIXES = ['qa-', 'smoke-', 'test-', 'monitor-', 'probe-', 'healthcheck-'];
// Matched against the plus-tag only (the part after `+`), never the whole
// local part — so a real `testa@…` or `qatar.shipping@…` is untouched while
// Jacob's own aliases (`+tldsmoke1`, `+transload-email-test`, `+swl-pdfcrm-test`)
// are caught.
const SYNTHETIC_TAG_WORDS = ['test', 'smoke', 'qa', 'probe', 'monitor', 'healthcheck'];

// Our own automation box. A submission whose origin IP is this host is by
// definition ours — no customer's browser ever egresses from our EC2 server.
// This is the only rule that survives an attacker-shaped probe: on 2026-07-22
// two `diagnostic.check*@prairiegrain-example.com` probes spoofed a Chrome
// user-agent AND used a local part outside SYNTHETIC_PREFIXES, so both the
// email rule and the UA rule missed them. The origin IP did not.
//
// 2026-07-23: this is now an ELASTIC IP (allocated after the box was stopped
// and started overnight, which silently moved it 54.211.122.167 -> 3.83.205.91
// and left this rule matching nothing). Because it is elastic it survives
// stop/start, so it will not drift again on its own. Only ever list addresses
// we CURRENTLY hold — a released IP goes back into the AWS pool and can be
// reassigned to a stranger, and keeping it here would flag their traffic as
// ours and silently bin a real lead.
const OWN_EGRESS_IPS = new Set(
  (process.env.SWL_OWN_EGRESS_IPS || '100.28.61.227')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

/** Pull the true client IP from proxy headers, matching what we log on the record. */
export function clientIpFrom(req: { headers: Record<string, unknown> }): string {
  return String(
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    ''
  );
}

/**
 * True when this submission is our own test traffic rather than a real lead.
 * Deliberately conservative on the domain check: `jacob@steelwheellogistics.com`
 * is a real address, so we only treat OWN-DOMAIN mail as synthetic when the
 * local part carries a probe prefix — never the bare domain.
 */
export function isSyntheticLead(email: string, userAgent = '', ip = ''): boolean {
  const addr = email.trim().toLowerCase();
  if (addr.endsWith('@anthropic.com')) return true;

  // Checked first: independent of anything the caller controls, so it holds
  // even when the email and user-agent are dressed up to look human.
  if (ip && OWN_EGRESS_IPS.has(ip.trim())) return true;

  const local = addr.split('@')[0] || '';
  if (SYNTHETIC_PREFIXES.some((p) => local.startsWith(p))) return true;
  const plusTag = local.includes('+') ? local.slice(local.indexOf('+') + 1) : '';
  if (plusTag && SYNTHETIC_TAG_WORDS.some((w) => plusTag.includes(w))) return true;

  // No human submits a lead form with curl/wget. Anything scripted hitting
  // these endpoints is ours (or a scanner) — neither is a lead.
  if (/^(curl|wget|python-requests|go-http-client|node-fetch|axios)\//i.test(userAgent.trim())) {
    return true;
  }
  return false;
}

export interface LeadEmailRow {
  label: string;
  value: string;
  emphasize?: boolean;
}

/** 4th sink: email Jacob's info@swl inbox with the formatted lead summary. */
export async function sendLeadEmail(opts: {
  subject: string;
  heading: string;
  rows: LeadEmailRow[];
  customerEmail: string;
  toolName: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY || '';
  if (!apiKey) {
    console.warn('lead-email: RESEND_API_KEY not set — skipping email sink');
    return false;
  }
  const to = process.env.LEAD_NOTIFY_EMAIL || 'info@steelwheellogistics.com';
  const from = process.env.LEAD_NOTIFY_FROM ||
    'Steel Wheel Leads <notifications@ezbizservices.com>';

  const tableRows = opts.rows.map(r => {
    const valHtml = r.emphasize ? `<strong>${escape(r.value)}</strong>` : escape(r.value);
    return `<tr>` +
      `<td style="background:#f4f6f8;font-weight:600;width:160px">${escape(r.label)}</td>` +
      `<td>${valHtml}</td>` +
      `</tr>`;
  }).join('');

  const html =
    `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#222">` +
    `<h2 style="margin:0 0 12px;color:#1a3a5c">${escape(opts.heading)}</h2>` +
    `<table cellpadding="6" cellspacing="0" border="0" ` +
    `style="border-collapse:collapse;border:1px solid #ddd">` +
    tableRows +
    `</table>` +
    `<p style="margin-top:16px;color:#555;font-size:12px">` +
    `Captured by the ${escape(opts.toolName)} at steelwheellogistics.com. ` +
    `Reply directly to follow up — the customer’s email is ` +
    `<a href="mailto:${escape(opts.customerEmail)}">${escape(opts.customerEmail)}</a>.` +
    `</p></div>`;

  const text = opts.rows.map(r => `${r.label}: ${r.value}`).join('\n') +
    `\n\nCustomer email: ${opts.customerEmail}\n` +
    `Tool: ${opts.toolName}\n`;

  const sent = await postResend({
    apiKey,
    payload: { from, to: [to], subject: opts.subject, html, text },
    label: 'lead-email',
  });

  // Draft a suggested reply and Telegram it for review. Wired here rather than
  // in each handler because all nine lead endpoints funnel through this
  // function, and it already has the details a draft needs. Fully opt-in: with
  // ANTHROPIC_API_KEY unset, generateLeadReplyDraft returns null and this is a
  // no-op. Nothing is ever sent to the customer — Jacob approves and sends.
  //
  // Deliberately non-fatal: the lead is already recorded by the time we get
  // here, so a drafting or notification failure must never surface as a failed
  // lead submission.
  try {
    const draft = await generateLeadReplyDraft({
      customerEmail: opts.customerEmail,
      leadSource: opts.toolName,
      leadDetails: opts.rows.map(r => `${r.label}: ${r.value}`).join('\n'),
    });
    if (draft) {
      await notifyDraftReady({ draft, toolName: opts.toolName });
    }
  } catch (e) {
    console.error('lead-reply-draft pipeline error:', (e as Error)?.message || e);
  }

  return sent;
}

/** 5th sink: send the customer their own copy of the quote/lead summary. */
export async function sendCustomerEmail(opts: {
  customerEmail: string;
  customerName?: string;
  subject: string;
  intro: string;       // first paragraph customised per-tool
  rows: LeadEmailRow[];
  outroFootnote?: string;  // optional disclaimer/footnote per-tool
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY || '';
  if (!apiKey) {
    console.warn('customer-email: RESEND_API_KEY not set — skipping');
    return false;
  }
  if (!opts.customerEmail) return false;
  const from = process.env.CUSTOMER_EMAIL_FROM ||
    'Steel Wheel Logistics <quotes@ezbizservices.com>';
  const replyTo = process.env.CUSTOMER_EMAIL_REPLY_TO ||
    'info@steelwheellogistics.com';

  const firstName = (opts.customerName || '').trim().split(/\s+/)[0] || '';
  const greeting = firstName ? `Hi ${escape(firstName)},` : 'Hi,';

  const tableRows = opts.rows.map(r => {
    const valHtml = r.emphasize ? `<strong>${escape(r.value)}</strong>` : escape(r.value);
    return `<tr>` +
      `<td style="background:#f4f6f8;font-weight:600;width:160px">${escape(r.label)}</td>` +
      `<td>${valHtml}</td>` +
      `</tr>`;
  }).join('');

  const html =
    `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#222">` +
    `<p style="margin:0 0 12px">${greeting}</p>` +
    `<p style="margin:0 0 14px">${escape(opts.intro)}</p>` +
    `<table cellpadding="6" cellspacing="0" border="0" ` +
    `style="border-collapse:collapse;border:1px solid #ddd">` +
    tableRows +
    `</table>` +
    (opts.outroFootnote
      ? `<p style="margin-top:16px;color:#555;font-size:13px">${escape(opts.outroFootnote)}</p>`
      : '') +
    `<p style="margin-top:18px;color:#222;font-size:13px">` +
    `Want to talk through the lane? Just reply — your message routes to ` +
    `<a href="mailto:info@steelwheellogistics.com">info@steelwheellogistics.com</a>, ` +
    `monitored daily.` +
    `</p>` +
    `<p style="margin-top:14px;color:#888;font-size:12px">` +
    `Steel Wheel Logistics | (601) 821-2199 | ` +
    `<a href="https://steelwheellogistics.com">steelwheellogistics.com</a>` +
    `</p></div>`;

  const text =
    `${firstName ? 'Hi ' + firstName + ',' : 'Hi,'}\n\n` +
    `${opts.intro}\n\n` +
    opts.rows.map(r => `${r.label}: ${r.value}`).join('\n') +
    (opts.outroFootnote ? `\n\n${opts.outroFootnote}` : '') +
    `\n\nReply to this email or call (601) 821-2199 to talk through the lane.\n\n` +
    `Steel Wheel Logistics\nsteelwheellogistics.com\n`;

  return await postResend({
    apiKey,
    payload: {
      from,
      to: [opts.customerEmail],
      reply_to: replyTo,
      subject: opts.subject,
      html,
      text,
    },
    label: 'customer-email',
  });
}

/** 6th sink: insert/update a Workmate CRM contact via Supabase REST. */
export async function syncWorkmateCrm(opts: {
  email: string;
  name?: string;
  phone?: string;
  source: 'swl-rate-quote' | 'swl-demurrage' | 'swl-transload' | 'swl-rail-vs-truck' | 'swl-rail-served-businesses' | 'swl-commodity-flow' | 'swl-course-signup';
  tags?: string[];
  noteHeader: string;     // e.g. "swl-demurrage 12:34PM CST 4/30"
  noteLines: string[];    // bullet lines, blank ones get filtered
}): Promise<boolean> {
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const workspaceId = process.env.WM_WORKSPACE_ID_SWL ||
    '873f17ad-f33c-4154-96ae-ce58ecb950fa';
  if (!supabaseUrl || !serviceKey) {
    console.warn('workmate-crm: SUPABASE_URL/SERVICE_ROLE_KEY not set — skipping CRM sink');
    return false;
  }
  if (!opts.email) return false;

  const email = opts.email.toLowerCase().trim();
  const contactName = (opts.name || '').trim() || nameFromEmail(email) || email;
  const phone = (opts.phone || '').trim() || null;
  const company = inferCompany(email);
  const baseTags = ['rate-quote', 'demurrage', 'transload', 'rail-vs-truck', 'rail-served-businesses']
    .filter(t => opts.source === `swl-${t}`);
  const tags = [...baseTags];
  for (const t of (opts.tags || [])) {
    if (t && !tags.includes(t)) tags.push(t);
  }
  const noteBody = [opts.noteHeader, ...opts.noteLines]
    .filter(l => l && l.trim())
    .join('\n');

  const headers: Record<string, string> = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  const nowIso = new Date().toISOString();

  try {
    // Look up existing row first (no unique index on workspace_id+email).
    const lookupUrl = `${supabaseUrl}/rest/v1/wm_contacts?` +
      `select=id,notes,tags,name,phone,company` +
      `&workspace_id=eq.${encodeURIComponent(workspaceId)}` +
      `&email=eq.${encodeURIComponent(email)}` +
      `&limit=1`;
    const lookupRes = await fetch(lookupUrl, { method: 'GET', headers });
    if (!lookupRes.ok) {
      const body = await lookupRes.text().catch(() => '');
      console.error('workmate-crm lookup non-2xx', lookupRes.status, body.slice(0, 300));
      return false;
    }
    const existing = await lookupRes.json().catch(() => []) as any[];

    if (Array.isArray(existing) && existing.length > 0) {
      const row = existing[0];
      const existingNotes = (row.notes || '').trim();
      const mergedNotes = existingNotes
        ? `${existingNotes}\n\n${noteBody}`
        : noteBody;
      const existingTags: string[] = Array.isArray(row.tags) ? row.tags : [];
      const mergedTags = [...existingTags];
      for (const t of tags) {
        if (t && !mergedTags.includes(t)) mergedTags.push(t);
      }
      const update: Record<string, unknown> = {
        notes: mergedNotes,
        tags: mergedTags,
        last_contact_at: nowIso,
      };
      if (opts.name && opts.name.trim()) update.name = contactName;
      if (phone) update.phone = phone;
      if (company) update.company = company;

      const patchUrl = `${supabaseUrl}/rest/v1/wm_contacts?` +
        `workspace_id=eq.${encodeURIComponent(workspaceId)}` +
        `&id=eq.${encodeURIComponent(row.id)}`;
      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify(update),
      });
      if (!patchRes.ok) {
        const body = await patchRes.text().catch(() => '');
        console.error('workmate-crm patch non-2xx', patchRes.status, body.slice(0, 300));
        return false;
      }
      return true;
    }

    // No existing row — INSERT.
    const insertBody = {
      workspace_id: workspaceId,
      name: contactName,
      email,
      phone,
      company,
      source: opts.source,
      status: 'new',
      tags,
      notes: noteBody,
      last_contact_at: nowIso,
    };
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/wm_contacts`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=minimal' },
      body: JSON.stringify(insertBody),
    });
    if (!insertRes.ok) {
      const body = await insertRes.text().catch(() => '');
      console.error('workmate-crm insert non-2xx', insertRes.status, body.slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('workmate-crm sync error:', err);
    return false;
  }
}

/** Best-effort name from the local part of an email — "matt.jameson@..." ->
 *  "Matt Jameson". Only fires on the reliable pattern (2+ alphabetic
 *  segments joined by ./_/-); a single glued token ("ppotluri") is NOT
 *  split further, since guessing a first/last boundary inside an unbroken
 *  string is a coin flip and a wrong-looking invented name is worse than
 *  none. Mirrors _name_from_email in lead_capture.py — kept in sync,
 *  fixed here 2026-08-23 (was "Prospect — email", Jacob flagged it as
 *  "no reason to say prospect... we have the person's name"). */
function nameFromEmail(email: string): string | null {
  if (!email || !email.includes('@')) return null;
  const local = email.split('@')[0];
  const parts = local.split(/[._-]+/).filter((p) => /^[a-zA-Z]+$/.test(p));
  if (parts.length >= 2) {
    return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ');
  }
  return null;
}

/** Helper: best-effort company name from an email domain. Mirrors
 *  _company_from_email in lead_capture.py — fixed here 2026-08-23 (was
 *  guessing wrong-looking names like "Auroramaterialsolutions" for any
 *  domain regardless of length). */
function inferCompany(email: string): string | null {
  if (!email || !email.includes('@')) return null;
  const domain = email.split('@')[1].toLowerCase().trim();
  const freeMail = new Set([
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
    'aol.com', 'icloud.com', 'me.com', 'msn.com', 'live.com',
    'proton.me', 'protonmail.com', 'mailfence.com',
  ]);
  if (freeMail.has(domain) || !domain) return null;
  const parts = domain.split('.');
  const sld = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  if (sld.includes('-')) return capitalize(sld.replace(/-/g, ' '));
  if (sld.length <= 4) return sld.toUpperCase();
  if (sld.length <= 10) return capitalize(sld);
  return null;
}

function capitalize(s: string): string {
  return s.split(/\s+/).map(w => w ? (w[0].toUpperCase() + w.slice(1)) : '').join(' ');
}

/** "Now in CST" formatted as "12:34PM CST 4/30" — matches the lead_capture.py output. */
export function nowCstShort(): string {
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

async function postResend(opts: {
  apiKey: string;
  payload: Record<string, unknown>;
  label: string;
}): Promise<boolean> {
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        // Cloudflare in front of api.resend.com 403's some default UAs
        // (error 1010); set an explicit one to be safe.
        'User-Agent': 'swl-lead-capture/1.0 (+https://steelwheellogistics.com)',
        'Accept': 'application/json',
      },
      body: JSON.stringify(opts.payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`${opts.label} Resend non-2xx ${res.status}:`, body.slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error(`${opts.label} Resend fetch failed:`, err);
    return false;
  }
}

function escape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
