// Draft email generation for SWL lead replies.
//
// Generates a personalized reply using Claude and hands it to _draft-notify for
// review. Nothing is ever sent to the customer from here — Jacob approves and
// sends. The whole path is opt-in: with ANTHROPIC_API_KEY unset this returns
// null and the lead flow is untouched.

import Anthropic from '@anthropic-ai/sdk';

export interface LeadReplyDraft {
  toEmail: string;
  toName?: string;
  subject: string;
  body: string;
  html: string;
  generatedAt: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generate a personalized email reply draft for a lead using Claude.
 * Returns draft content without sending — Jacob reviews & approves before sending.
 */
export async function generateLeadReplyDraft(opts: {
  customerEmail: string;
  customerName?: string;
  leadSource: string;      // e.g. "Rail Rate Quote Tool"
  leadDetails: string;     // key details from the lead (ship type, volume, etc)
  requiresFollowUp?: string; // specific follow-up needed (e.g. "confirm weight")
}): Promise<LeadReplyDraft | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    console.warn('lead-reply-draft: ANTHROPIC_API_KEY not set — skipping draft generation');
    return null;
  }

  const firstName = (opts.customerName || '').trim().split(/\s+/)[0] || '';
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

  // Brand rules are load-bearing here, not decoration: SWL quotes are
  // INDICATIVE, never binding, and "intermodal" is a negative keyword for this
  // brand (bulk carload/unit-train/transload is the business). A draft that
  // promises a binding rate is worse than no draft at all.
  const prompt = `You are a rail logistics sales expert at Steel Wheel Logistics (SWL), a bulk-commodity rail brokerage.

A prospective customer just used the ${opts.leadSource} on our website. Here's what they requested:

${opts.leadDetails}
${opts.requiresFollowUp ? `\nSpecific follow-up needed: ${opts.requiresFollowUp}\n` : ''}
Write a brief, personalized email reply (2-3 paragraphs max) that:
1. Thanks them for using the tool
2. Acknowledges their specific request with confidence
3. Proposes next steps (brief call, ask one clarifying question, etc)
4. Includes contact info for info@steelwheellogistics.com or (601) 821-2199

HARD RULES — a draft that breaks these is unusable:
- Do not claim we produced anything we didn't. Most of these tools capture interest; they do NOT generate a price. Only the rate quote and rail-vs-truck tools return an estimate. Unless the lead details above actually contain a price or estimate, never write "we pulled an estimate", "we ran your numbers", or anything implying we've already priced the lane.
- Where a price IS involved, it is an INDICATIVE estimate. Never write "binding quote", "binding rate", "guaranteed rate", or anything implying we've committed to a price.
- Never use the words "intermodal", "container", or "drayage". We move bulk commodities: carload, unit train, transload, multimodal.
- Do not state transit times, service days, or capacity commitments. Nothing we haven't verified.
- Do not invent details the customer didn't give us.

Tone: operator-to-operator. Professional, direct, low-fluff — the reader is a shipper or traffic manager and will smell filler instantly. Use "we" for SWL.
Do not include a greeting line or a sign-off — those are added automatically. Return only the body paragraphs.
Response format: plain text, no markdown or HTML tags.`;

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      // Thinking left off (the default on Opus 4.8 when the field is omitted):
      // this is a short, well-specified email, and every lead pays this cost.
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: prompt }],
    });

    if (response.stop_reason === 'refusal') {
      console.warn('lead-reply-draft: model declined to draft this reply');
      return null;
    }

    const bodyPlain = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    if (!bodyPlain) {
      console.warn('lead-reply-draft: Claude returned empty reply');
      return null;
    }

    const html =
      `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#222">` +
      `<p style="margin:0 0 12px">${greeting}</p>` +
      bodyPlain.split('\n').map((para: string) => {
        if (!para.trim()) return '';
        return `<p style="margin:0 0 12px">${escapeHtml(para)}</p>`;
      }).join('') +
      `<p style="margin-top:18px;color:#222">Steel Wheel Logistics</p>` +
      `<p style="color:#555;font-size:12px">` +
      `<a href="mailto:info@steelwheellogistics.com">info@steelwheellogistics.com</a> | ` +
      `(601) 821-2199 | ` +
      `<a href="https://steelwheellogistics.com">steelwheellogistics.com</a>` +
      `</p></div>`;

    return {
      toEmail: opts.customerEmail.toLowerCase().trim(),
      toName: opts.customerName,
      subject: 'Re: Your Steel Wheel Logistics inquiry',
      body: `${greeting}\n\n${bodyPlain}`,
      html,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('generateLeadReplyDraft error:', (err as Error)?.message || err);
    return null;
  }
}
