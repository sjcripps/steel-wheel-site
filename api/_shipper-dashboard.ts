import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  hashPassword, verifyPassword, newToken, hashToken,
  sessionCookie, clearCookie, SESSION_TTL_DAYS,
  MAX_FAILED_LOGINS, LOCKOUT_MINUTES, passwordProblem,
  sb, supabaseConfigured, normalizeEmail, validEmail, resolveSession,
} from './_shipper-auth';

// Shipper dashboard API. Rides the api/tool-lead dispatcher because the
// project sits at the 12-function Hobby cap; a 13th function silently fails
// the whole deploy at patchBuild.
//
// Auth model: password is the primary credential, magic link handles first-time
// setup and password reset. Session is server-side and revocable; the cookie
// carries a random token whose SHA-256 is what we store.

const MAGIC_TTL_MIN = 30;
const SITE = 'https://steelwheellogistics.com';

function ok(res: VercelResponse, body: unknown, cookie?: string) {
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(body);
}
function bad(res: VercelResponse, status: number, error: string, code?: string) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ error, code });
}

async function sendMail(to: string, subject: string, html: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Steel Wheel Logistics <info@steelwheellogistics.com>',
        to: [to], subject, html,
      }),
    });
    return r.ok;
  } catch { return false; }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', SITE);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');
  if (!supabaseConfigured()) return bad(res, 503, 'Dashboard is temporarily unavailable.');

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const action = String(body.action ?? '').trim();

  try {
    switch (action) {
      case 'signup':        return await signup(req, res, body);
      case 'login':         return await login(req, res, body);
      case 'logout':        return await logout(req, res);
      case 'magic-request': return await magicRequest(res, body);
      case 'magic-verify':  return await magicVerify(res, body);
      case 'set-password':  return await setPassword(req, res, body);
      case 'me':            return await me(req, res);
      case 'lanes':         return await lanes(req, res);
      case 'add-lane':      return await addLane(req, res, body);
      case 'delete-lane':   return await deleteLane(req, res, body);
      case 'templates':     return await templates(req, res);
      case 'save-template': return await saveTemplate(req, res, body);
      case 'delete-template': return await deleteTemplate(req, res, body);
      default:              return bad(res, 400, 'Unknown action', 'unknown_action');
    }
  } catch (e: any) {
    console.error('shipper-dashboard error:', e?.message || e);
    return bad(res, 500, 'Something went wrong. Please try again.');
  }
}

// ── auth ────────────────────────────────────────────────────────────────────

async function issueSession(res: VercelResponse, shipperId: string, req: VercelRequest) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString();
  await sb('sw_sessions', {
    method: 'POST',
    body: {
      shipper_id: shipperId,
      token_hash: hashToken(token),
      expires_at: expires,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
      ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 60),
    },
    prefer: 'return=minimal',
  });
  return sessionCookie(token, SESSION_TTL_DAYS * 86400);
}

async function signup(req: VercelRequest, res: VercelResponse, body: any) {
  const email = normalizeEmail(body.email);
  if (!validEmail(email)) return bad(res, 400, 'Please enter a valid email address.');
  const pwProblem = passwordProblem(String(body.password ?? ''));
  if (pwProblem) return bad(res, 400, pwProblem, 'weak_password');

  const existing = await sb(`sw_shippers?email=eq.${encodeURIComponent(email)}&select=id,password_hash`);
  if (Array.isArray(existing) && existing[0]?.password_hash) {
    // Do not confirm the address exists. Point at the recovery path instead.
    return bad(res, 409,
      'That email may already have an account. Try signing in, or use "Email me a sign-in link".',
      'maybe_exists');
  }

  const hash = await hashPassword(String(body.password));
  const now = new Date().toISOString();
  const patch = {
    email,
    company: String(body.company ?? '').trim().slice(0, 200) || null,
    name: String(body.name ?? '').trim().slice(0, 200) || null,
    password_hash: hash,
    password_set_at: now,
    failed_login_count: 0,
    locked_until: null,
  };

  let id: string;
  if (Array.isArray(existing) && existing[0]?.id) {
    await sb(`sw_shippers?id=eq.${existing[0].id}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' });
    id = existing[0].id;
  } else {
    const rows = await sb('sw_shippers', { method: 'POST', body: patch });
    id = rows[0].id;
  }
  const cookie = await issueSession(res, id, req);
  return ok(res, { ok: true, email }, cookie);
}

async function login(req: VercelRequest, res: VercelResponse, body: any) {
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? '');
  // One generic message for every failure mode, so the response cannot be used
  // to enumerate which addresses have accounts.
  const GENERIC = 'Email or password is incorrect.';
  if (!validEmail(email) || !password) return bad(res, 401, GENERIC, 'bad_credentials');

  const rows = await sb(
    `sw_shippers?email=eq.${encodeURIComponent(email)}` +
    `&select=id,password_hash,failed_login_count,locked_until`);
  const u = Array.isArray(rows) && rows[0];
  if (!u) return bad(res, 401, GENERIC, 'bad_credentials');

  if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
    return bad(res, 429,
      `Too many attempts. Try again in ${LOCKOUT_MINUTES} minutes, or use "Email me a sign-in link".`,
      'locked');
  }

  const okPw = await verifyPassword(password, u.password_hash);
  if (!okPw) {
    const n = (u.failed_login_count || 0) + 1;
    const patch: any = { failed_login_count: n };
    if (n >= MAX_FAILED_LOGINS) {
      patch.locked_until = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString();
      patch.failed_login_count = 0;
    }
    await sb(`sw_shippers?id=eq.${u.id}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' });
    return bad(res, 401, GENERIC, 'bad_credentials');
  }

  await sb(`sw_shippers?id=eq.${u.id}`, {
    method: 'PATCH',
    body: { failed_login_count: 0, locked_until: null, last_seen_at: new Date().toISOString() },
    prefer: 'return=minimal',
  });
  const cookie = await issueSession(res, u.id, req);
  return ok(res, { ok: true, email }, cookie);
}

async function logout(req: VercelRequest, res: VercelResponse) {
  const s = await resolveSession(req.headers.cookie);
  if (s) {
    await sb(`sw_sessions?id=eq.${s.sessionId}`, {
      method: 'PATCH', body: { revoked_at: new Date().toISOString() }, prefer: 'return=minimal',
    });
  }
  return ok(res, { ok: true }, clearCookie());
}

async function magicRequest(res: VercelResponse, body: any) {
  const email = normalizeEmail(body.email);
  // Always report success — otherwise this endpoint enumerates accounts.
  const SAME = { ok: true, message: 'If that address has an account, a sign-in link is on its way.' };
  if (!validEmail(email)) return ok(res, SAME);

  const rows = await sb(`sw_shippers?email=eq.${encodeURIComponent(email)}&select=id`);
  const u = Array.isArray(rows) && rows[0];
  if (!u) return ok(res, SAME);

  const token = newToken();
  await sb(`sw_shippers?id=eq.${u.id}`, {
    method: 'PATCH',
    body: {
      login_token_hash: hashToken(token),
      login_token_expires_at: new Date(Date.now() + MAGIC_TTL_MIN * 60_000).toISOString(),
    },
    prefer: 'return=minimal',
  });

  const link = `${SITE}/tools/rail-dashboard?t=${encodeURIComponent(token)}`;
  await sendMail(email, 'Your Steel Wheel dashboard sign-in link', `
    <p>Here is your sign-in link for the Steel Wheel shipper dashboard:</p>
    <p><a href="${link}">Sign in</a></p>
    <p>This link works once and expires in ${MAGIC_TTL_MIN} minutes. If you didn't
       request it, you can ignore this email.</p>
    <p>&mdash; Steel Wheel Logistics</p>`);
  return ok(res, SAME);
}

async function magicVerify(res: VercelResponse, body: any) {
  const token = String(body.token ?? '');
  if (!token) return bad(res, 400, 'That sign-in link is not valid.', 'bad_token');
  const rows = await sb(
    `sw_shippers?login_token_hash=eq.${encodeURIComponent(hashToken(token))}` +
    `&select=id,email,login_token_expires_at,password_hash`);
  const u = Array.isArray(rows) && rows[0];
  if (!u || !u.login_token_expires_at ||
      new Date(u.login_token_expires_at).getTime() <= Date.now()) {
    return bad(res, 401, 'That sign-in link has expired. Please request a new one.', 'expired');
  }
  // Single use.
  await sb(`sw_shippers?id=eq.${u.id}`, {
    method: 'PATCH',
    body: {
      login_token_hash: null, login_token_expires_at: null,
      verified_at: new Date().toISOString(), failed_login_count: 0, locked_until: null,
    },
    prefer: 'return=minimal',
  });
  const token2 = newToken();
  await sb('sw_sessions', {
    method: 'POST',
    body: {
      shipper_id: u.id, token_hash: hashToken(token2),
      expires_at: new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString(),
    },
    prefer: 'return=minimal',
  });
  return ok(res, { ok: true, email: u.email, needs_password: !u.password_hash },
    sessionCookie(token2, SESSION_TTL_DAYS * 86400));
}

async function setPassword(req: VercelRequest, res: VercelResponse, body: any) {
  const s = await resolveSession(req.headers.cookie);
  if (!s) return bad(res, 401, 'Please sign in.', 'unauthenticated');
  const problem = passwordProblem(String(body.password ?? ''));
  if (problem) return bad(res, 400, problem, 'weak_password');
  const hash = await hashPassword(String(body.password));
  await sb(`sw_shippers?id=eq.${s.shipperId}`, {
    method: 'PATCH',
    body: { password_hash: hash, password_set_at: new Date().toISOString() },
    prefer: 'return=minimal',
  });
  // Changing a password revokes every OTHER session — the standard expectation
  // after "someone may have had access".
  await sb(`sw_sessions?shipper_id=eq.${s.shipperId}&id=neq.${s.sessionId}&revoked_at=is.null`, {
    method: 'PATCH', body: { revoked_at: new Date().toISOString() }, prefer: 'return=minimal',
  });
  return ok(res, { ok: true });
}

async function me(req: VercelRequest, res: VercelResponse) {
  const s = await resolveSession(req.headers.cookie);
  if (!s) return ok(res, { authenticated: false });
  const rows = await sb(`sw_shippers?id=eq.${s.shipperId}&select=email,company,name,digest_opt_in,password_hash`);
  const u = (Array.isArray(rows) && rows[0]) || {};
  return ok(res, {
    authenticated: true, email: u.email, company: u.company, name: u.name,
    digest_opt_in: u.digest_opt_in, has_password: Boolean(u.password_hash),
  });
}

// ── lanes ───────────────────────────────────────────────────────────────────

async function lanes(req: VercelRequest, res: VercelResponse) {
  const s = await resolveSession(req.headers.cookie);
  if (!s) return bad(res, 401, 'Please sign in.', 'unauthenticated');
  const rows = await sb(
    `sw_lanes?shipper_id=eq.${s.shipperId}&active=eq.true&order=created_at.desc&select=*`);
  const out: any[] = [];
  for (const l of rows || []) {
    const snaps = await sb(
      `sw_lane_snapshots?lane_id=eq.${l.id}&order=captured_at.desc&limit=2` +
      `&select=captured_at,miles,railroads,tariff_total,transit_days_low,transit_days_central,` +
      `transit_days_high,service_condition,service_pct_vs_seasonal`);
    out.push({ ...l, latest: snaps?.[0] || null, previous: snaps?.[1] || null });
  }
  return ok(res, { lanes: out });
}

async function addLane(req: VercelRequest, res: VercelResponse, body: any) {
  const s = await resolveSession(req.headers.cookie);
  if (!s) return bad(res, 401, 'Please sign in.', 'unauthenticated');
  const origin = String(body.origin ?? '').trim();
  const destination = String(body.destination ?? '').trim();
  if (!origin || !destination) return bad(res, 400, 'Origin and destination are required.');
  let numCars = Number(body.num_cars ?? 1);
  if (!Number.isInteger(numCars) || numCars < 1 || numCars > 200) numCars = 1;
  const rows = await sb('sw_lanes', {
    method: 'POST',
    body: {
      shipper_id: s.shipperId,
      label: String(body.label ?? '').trim().slice(0, 160) || `${origin} → ${destination}`,
      origin: origin.slice(0, 160),
      destination: destination.slice(0, 160),
      commodity: String(body.commodity ?? 'grain').trim().slice(0, 60),
      car_type: String(body.car_type ?? 'covered-hopper').trim().slice(0, 60),
      num_cars: numCars,
      weight_tons: Math.min(Math.max(Number(body.weight_tons ?? 100) || 100, 1), 200),
    },
  });
  return ok(res, { ok: true, lane: rows[0] });
}

async function deleteLane(req: VercelRequest, res: VercelResponse, body: any) {
  const s = await resolveSession(req.headers.cookie);
  if (!s) return bad(res, 401, 'Please sign in.', 'unauthenticated');
  const id = String(body.id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return bad(res, 400, 'Bad lane id.');
  // shipper_id in the filter is the ownership check — without it any signed-in
  // user could delete any lane by guessing an id.
  await sb(`sw_lanes?id=eq.${id}&shipper_id=eq.${s.shipperId}`, {
    method: 'PATCH', body: { active: false }, prefer: 'return=minimal',
  });
  return ok(res, { ok: true });
}

// ── BOL templates ───────────────────────────────────────────────────────────

async function templates(req: VercelRequest, res: VercelResponse) {
  const s = await resolveSession(req.headers.cookie);
  if (!s) return bad(res, 401, 'Please sign in.', 'unauthenticated');
  const rows = await sb(
    `sw_bol_templates?shipper_id=eq.${s.shipperId}&order=updated_at.desc&select=id,name,payload,updated_at`);
  return ok(res, { templates: rows || [] });
}

async function saveTemplate(req: VercelRequest, res: VercelResponse, body: any) {
  const s = await resolveSession(req.headers.cookie);
  if (!s) return bad(res, 401, 'Please sign in.', 'unauthenticated');
  const name = String(body.name ?? '').trim().slice(0, 120);
  if (!name) return bad(res, 400, 'Template name is required.');
  if (!body.payload || typeof body.payload !== 'object') {
    return bad(res, 400, 'Template payload is required.');
  }
  const json = JSON.stringify(body.payload);
  if (json.length > 100_000) return bad(res, 413, 'That template is too large.');
  // on_conflict MUST name the unique constraint columns. Without it PostgREST
  // resolves against the primary key, finds no conflict on a fresh uuid, and
  // the write is silently discarded — the row keeps its old payload while the
  // API still reports success. That is silent data loss: a shipper edits a
  // template, is told it saved, and the edit is gone.
  await sb('sw_bol_templates?on_conflict=shipper_id,name', {
    method: 'POST',
    body: {
      shipper_id: s.shipperId, name, payload: body.payload,
      updated_at: new Date().toISOString(),
    },
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
  return ok(res, { ok: true });
}

async function deleteTemplate(req: VercelRequest, res: VercelResponse, body: any) {
  const s = await resolveSession(req.headers.cookie);
  if (!s) return bad(res, 401, 'Please sign in.', 'unauthenticated');
  const id = String(body.id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return bad(res, 400, 'Bad template id.');
  await sb(`sw_bol_templates?id=eq.${id}&shipper_id=eq.${s.shipperId}`, {
    method: 'DELETE', prefer: 'return=minimal',
  });
  return ok(res, { ok: true });
}
