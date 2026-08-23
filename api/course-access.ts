import type { VercelRequest, VercelResponse } from '@vercel/node';
import { syncWorkmateCrm, nowCstShort } from './_lead-email';

// Domains that never make it into the CRM as a course signup — not because
// the person isn't real, but because they're not a freight-buying signal.
// Free-mail gives zero company context; .gov/.edu reads as research/
// curiosity (confirmed once already: an Argonne National Lab scientist
// signed up, not a shipper); producthound.com is a product-discovery site
// that has sent duplicate signups minutes apart — reads as competitive/
// content research, not a lead. Set by Jacob 2026-08-23.
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'aol.com', 'icloud.com', 'me.com', 'msn.com', 'live.com',
  'proton.me', 'protonmail.com', 'mailfence.com',
]);
const EXCLUDED_EXACT_DOMAINS = new Set(['producthound.com']);

function isLowQualityCourseSignup(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase().trim() || '';
  if (!domain) return true;
  if (FREE_MAIL_DOMAINS.has(domain)) return true;
  if (EXCLUDED_EXACT_DOMAINS.has(domain)) return true;
  if (domain.endsWith('.gov') || domain.endsWith('.edu')) return true;
  return false;
}

const FLOWTRACK_BASE = process.env.FLOWTRACK_BASE_URL || "https://app.closegpt.ai";
const FLOWTRACK_PUB = process.env.FLOWTRACK_PUBLIC_KEY || "";
const FLOWTRACK_PRIV = process.env.FLOWTRACK_PRIVATE_KEY || "";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_USER_ID = process.env.TELEGRAM_USER_ID || "";
const FLOWS_WEBHOOK_SECRET = process.env.FLOWS_WEBHOOK_SECRET || "";
const FLOWS_BASE_URL = process.env.FLOWS_BASE_URL || "https://webhooks.ezbizservices.com";

async function notifyTelegram(chatId: string, text: string) {
  if (!TG_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error("Telegram notify failed:", err);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const email = req.body?.email?.trim()?.toLowerCase();
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email required" });
    }

    // Create contact in FlowTrack CRM (if configured)
    if (FLOWTRACK_PUB && FLOWTRACK_PRIV) {
      const ftUrl = `${FLOWTRACK_BASE}/api/contact?public_key=${FLOWTRACK_PUB}&private_key=${FLOWTRACK_PRIV}`;
      await fetch(ftUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          tags: ["Steel Wheel Logistics Course"],
          source: "Steel Wheel Courses Page",
        }),
      }).catch(() => {});
    }

    // Trigger drip email sequence via flows server
    if (FLOWS_WEBHOOK_SECRET) {
      fetch(`${FLOWS_BASE_URL}/webhooks/steel-wheel/signup?secret=${FLOWS_WEBHOOK_SECRET}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }).catch((err) => console.error("Drip webhook failed:", err));
    }

    // Sync to Workmate CRM — course signups were never reaching wm_contacts
    // at all before this (they only went to FlowTrack, which is dead, and
    // the drip-sequence table, which nobody reviews). Skip low-quality
    // domains so this doesn't fill the CRM with free-mail/research/
    // competitor-research noise.
    if (!isLowQualityCourseSignup(email)) {
      await syncWorkmateCrm({
        email,
        source: 'swl-course-signup',
        tags: ['course-signup'],
        noteHeader: `[${nowCstShort()}] swl-course-signup`,
        noteLines: [`  Tool: rail logistics course sign-up (steelwheellogistics.com/courses)`],
      }).catch((err) => console.error('Course CRM sync failed:', err));
    }

    // Notify via Telegram
    const now = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
    const msg = `📚 COURSE ACCESS REQUEST\n\nEmail: ${email}\nTime: ${now}\n\nSomeone wants to learn about rail logistics!`;
    await notifyTelegram(TG_USER_ID, msg);

    return res.status(200).json({ success: true, message: "Access granted" });
  } catch (err) {
    console.error("Course access API error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
