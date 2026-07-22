import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isSyntheticLead } from './_lead-email';

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'temp-mail.org',
  'throwaway.email', 'yopmail.com', 'fakeinbox.com', 'maildrop.cc', 'tempmail.net'
]);

async function validateEmail(email: string): Promise<{ valid: boolean; error?: string }> {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { valid: false, error: 'Invalid email format' };
  }

  const domain = email.split('@')[1].toLowerCase();
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { valid: false, error: 'Disposable email addresses not accepted' };
  }

  if (domain === 'anthropic.com') {
    return { valid: true };
  }

  try {
    const dnsResponse = await fetch(`https://dns.google/resolve?name=${domain}&type=MX`, {
      headers: { 'Accept': 'application/dns-json' }
    }).then(r => r.json());

    if (!dnsResponse.Answer || dnsResponse.Answer.length === 0) {
      return { valid: false, error: 'Email domain has no MX records' };
    }
  } catch (err) {
    console.warn('MX check failed (fail-open):', err);
  }

  return { valid: true };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const email = body.email?.trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const validation = await validateEmail(email);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const clientIp = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').toString();
    const userAgent = (req.headers['user-agent'] || 'unknown').toString();

    const leadRecord = {
      timestamp: new Date().toISOString(),
      email: email,
      tool: 'fleet-calculator',
      calculator_inputs: body.calculator_inputs || {},
      client_ip: clientIp,
      user_agent: userAgent,
      is_synthetic: isSyntheticLead(email, userAgent)
    };

    if (leadRecord.is_synthetic) {
      return res.status(200).json({ ok: true, synthetic: true });
    }

    const sinks = { s3: false, telegram: false };

    try {
      const s3Response = await fetch(`${process.env.S3_API_URL || 'http://localhost:3001'}/api/s3-put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucket: 'openclawbucket',
          key: 'jakecbot/swl-leads/fleet-calculator.jsonl',
          data: JSON.stringify(leadRecord)
        })
      });
      sinks.s3 = s3Response.ok;
    } catch (err) {
      console.error('S3 write failed:', err);
    }

    try {
      const tgUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const inputs = leadRecord.calculator_inputs as any;
      const message = `📊 Fleet Calculator Lead\n${email}\nTonnage: ${inputs.annualTonnage}t/yr\nBaseline Fleet: ${inputs.baselineFleet} cars\nPeak Fleet: ${inputs.peakFleet} cars`;
      
      const tgResponse = await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_USER_ID,
          text: message,
          parse_mode: 'HTML'
        })
      });
      sinks.telegram = tgResponse.ok;
    } catch (err) {
      console.error('Telegram send failed:', err);
    }

    return res.status(200).json({
      ok: true,
      sinks: sinks,
      message: 'Lead captured successfully'
    });
  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
