import type { VercelRequest, VercelResponse } from '@vercel/node';

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
