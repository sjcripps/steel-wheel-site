// Telegram notification helper for lead reply drafts.
//
// Calls the Telegram Bot API over HTTPS. The previous version shelled out to
// /home/ubuntu/bots/assistant/send-telegram.sh via execSync — that path exists
// on the EC2 box, not inside a Vercel function, so it could never have worked
// here. TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID are already set in this
// project's Vercel env (they power the other lead notifications).

import type { LeadReplyDraft } from './_lead-reply-draft';

// Telegram hard-caps a sendMessage payload at 4096 chars. A long draft would
// otherwise 400 and the notification would vanish silently.
const TELEGRAM_MAX = 4096;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Notify Jacob via Telegram that a lead reply draft is ready for review.
 * Includes the draft body so he can approve/edit before sending.
 * Returns false (never throws) so a notification failure can't fail a lead.
 */
export async function notifyDraftReady(opts: {
  draft: LeadReplyDraft;
  toolName: string;
  leadSource?: string;
}): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_USER_ID || '';

  if (!token || !chatId) {
    console.warn('draft-notify: TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID not set — cannot notify');
    return false;
  }

  const to = opts.draft.toName
    ? `${opts.draft.toName} <${opts.draft.toEmail}>`
    : opts.draft.toEmail;

  // Plain text only — no HTML/markdown parse_mode. Draft bodies contain
  // apostrophes, ampersands and underscores that break Telegram's parsers, and
  // a parse failure means the message is dropped rather than degraded.
  const header =
    `SWL Lead Draft Ready\n\n` +
    `Tool: ${opts.toolName}\n` +
    (opts.leadSource ? `Source: ${opts.leadSource}\n` : '') +
    `To: ${to}\n` +
    `Subject: ${opts.draft.subject}\n\n` +
    `---\n\n`;
  const footer = `\n\n---\n\nReview and send from your email client. Nothing has been sent to the customer.`;

  const room = TELEGRAM_MAX - header.length - footer.length;
  const message = header + truncate(opts.draft.body, Math.max(room, 0)) + footer;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      console.error('draft-notify telegram error:', res.status, (await res.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('draft-notify telegram error:', (err as Error)?.message || err);
    return false;
  }
}
