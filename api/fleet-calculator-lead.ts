import { NextRequest, NextResponse } from 'next/server';

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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = body.email?.trim().toLowerCase();

    if (!email) {
      return NextResponse.json({ error: 'Email required' }, { status: 400 });
    }

    const validation = await validateEmail(email);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    const userAgent = req.headers.get('user-agent') || 'unknown';

    const leadRecord = {
      timestamp: new Date().toISOString(),
      email: email,
      tool: 'fleet-calculator',
      calculator_inputs: body.calculator_inputs || {},
      client_ip: clientIp,
      user_agent: userAgent,
      is_synthetic: email.endsWith('@anthropic.com')
    };

    if (leadRecord.is_synthetic) {
      return NextResponse.json({ ok: true, synthetic: true });
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

    return NextResponse.json({
      ok: true,
      sinks: sinks,
      message: 'Lead captured successfully'
    });
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
