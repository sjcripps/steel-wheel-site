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

  return await postResend({
    apiKey,
    payload: { from, to: [to], subject: opts.subject, html, text },
    label: 'lead-email',
  });
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
  source: 'swl-rate-quote' | 'swl-demurrage' | 'swl-transload' | 'swl-rail-vs-truck' | 'swl-rail-served-businesses' | 'swl-commodity-flow';
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
  const contactName = (opts.name || '').trim() || `Prospect — ${email}`;
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

/** Helper: best-effort company name from an email domain. */
function inferCompany(email: string): string | null {
  if (!email || !email.includes('@')) return null;
  const domain = email.split('@')[1].toLowerCase().trim();
  const freeMail = new Set([
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
    'aol.com', 'icloud.com', 'me.com', 'msn.com', 'live.com',
    'proton.me', 'protonmail.com',
  ]);
  if (freeMail.has(domain) || !domain) return null;
  const parts = domain.split('.');
  if (parts.length < 2) return capitalize(parts[0]);
  // "acme.com" → "acme"; "shipping.acme.co.uk" → "acme".
  return capitalize(parts[parts.length - 2].replace(/-/g, ' '));
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
