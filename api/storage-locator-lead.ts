import { NextRequest, NextResponse } from 'next/server';

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'temp-mail.org',
  'throwaway.email', 'yopmail.com', 'fakeinbox.com', 'maildrop.cc', 'tempmail.net'
]);

async function validateEmail(email: string): Promise<{ valid: boolean; error?: string }> {
  // Basic format check
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { valid: false, error: 'Invalid email format' };
  }

  // Disposable domain check
  const domain = email.split('@')[1].toLowerCase();
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { valid: false, error: 'Disposable email addresses not accepted' };
  }

  // @anthropic.com is synthetic — short-circuit to pass-through
  if (domain === 'anthropic.com') {
    return { valid: true };
  }

  // MX record check via DNS-over-HTTPS (optional, can fail-open)
  try {
    const dnsResponse = await fetch(`https://dns.google/resolve?name=${domain}&type=MX`, {
      headers: { 'Accept': 'application/dns-json' }
    }).then(r => r.json());

    if (!dnsResponse.Answer || dnsResponse.Answer.length === 0) {
      return { valid: false, error: 'Email domain has no MX records' };
    }
  } catch (err) {
    // DNS lookup failed — fail open (don't block the user)
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

    // Validate email
    const validation = await validateEmail(email);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Prepare lead record
    const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    const userAgent = req.headers.get('user-agent') || 'unknown';

    const leadRecord = {
      timestamp: new Date().toISOString(),
      email: email,
      facility_count: body.facility_count || 0,
      filters: body.filters_applied || {},
      source: 'storage-locator',
      client_ip: clientIp,
      user_agent: userAgent,
      is_synthetic: email.endsWith('@anthropic.com')
    };

    // Synthetic leads pass through without writing to sinks
    if (leadRecord.is_synthetic) {
      return NextResponse.json({ ok: true, synthetic: true });
    }

    // Triple-redundant capture: S3 + Telegram
    const sinks = { s3: false, telegram: false };

    // S3 write (isolated try/catch)
    try {
      const s3Response = await fetch(`${process.env.S3_API_URL || 'http://localhost:3001'}/api/s3-put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucket: 'openclawbucket',
          key: 'jakecbot/swl-leads/storage-locator.jsonl',
          data: JSON.stringify(leadRecord)
        })
      });
      sinks.s3 = s3Response.ok;
    } catch (err) {
      console.error('S3 write failed:', err);
    }

    // Telegram DM (isolated try/catch)
    try {
      const tgUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const message = `📍 Storage Locator Lead\n${email}\nFacilities: ${leadRecord.facility_count}\nFilters: ${JSON.stringify(leadRecord.filters)}`;
      
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
