import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash } from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(_scrypt) as (
  pw: string | Buffer, salt: string | Buffer, keylen: number, opts: any
) => Promise<Buffer>;

// ── Password hashing ────────────────────────────────────────────────────────
// Node's built-in scrypt rather than bcrypt/argon2: no native dependency in a
// serverless function, and scrypt is memory-hard, which is the property that
// matters against GPU cracking. Parameters are stored per-row so they can be
// raised later without invalidating existing hashes.
const SCRYPT_N = 16384;   // CPU/memory cost
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEYLEN = 64;
// scrypt needs maxmem >= 128 * N * r; the default 32MB is too small at N=16384.
const MAXMEM = 128 * SCRYPT_N * SCRYPT_r * 2;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN,
    { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: MAXMEM });
  return ['scrypt', SCRYPT_N, SCRYPT_r, SCRYPT_p,
    salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch { return false; }
  const key = await scrypt(pw, salt, expected.length,
    { N, r, p, maxmem: Math.max(MAXMEM, 128 * N * r * 2) });
  // Constant-time: a length check short-circuits, so guard it separately.
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}

// ── Tokens ──────────────────────────────────────────────────────────────────
// Session and magic-link tokens are random 32-byte values. Only their SHA-256
// is persisted, so a database read cannot be replayed as a credential. SHA-256
// is correct here and scrypt would be wrong: these are already high-entropy
// random values, not user-chosen secrets, so there is nothing to brute-force
// and the cost would buy nothing.
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ── Cookies ─────────────────────────────────────────────────────────────────
export const SESSION_COOKIE = 'swl_sd';
export const SESSION_TTL_DAYS = 30;

export function sessionCookie(token: string, maxAgeSec: number): string {
  // HttpOnly  — JS cannot read it, so an XSS bug cannot exfiltrate the session.
  // Secure    — HTTPS only.
  // SameSite=Lax — blocks CSRF on state-changing POSTs while still allowing a
  //                normal top-level navigation from the emailed magic link.
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  return parts.join('; ');
}

export function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// ── Lockout policy ──────────────────────────────────────────────────────────
// Online guessing only — this is not a substitute for a strong password, it
// just makes credential stuffing expensive. Checked BEFORE any hash comparison
// so a locked account costs an attacker a round trip and no CPU.
export const MAX_FAILED_LOGINS = 8;
export const LOCKOUT_MINUTES = 15;

// ── Password policy ─────────────────────────────────────────────────────────
// Length over composition rules: NIST dropped the character-class requirements
// because they push people toward "Passw0rd!" and nothing else.
export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (pw.length > 200) return 'Password must be under 200 characters.';
  const weak = ['password', 'steelwheel', '1234567890', 'qwertyuiop', 'railroad12'];
  const lower = pw.toLowerCase();
  if (weak.some(w => lower.includes(w))) {
    return 'That password is too easy to guess. Please choose another.';
  }
  return null;
}

// ── Supabase (service role) ─────────────────────────────────────────────────
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export function supabaseConfigured(): boolean {
  return Boolean(SB_URL && SB_KEY);
}

export async function sb(path: string, init: {
  method?: string; body?: unknown; prefer?: string;
} = {}): Promise<any> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: init.method || 'GET',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: init.prefer || 'return=representation',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const json = text.trim() ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`supabase ${res.status}: ${text.slice(0, 200)}`);
    (err as any).status = res.status;
    throw err;
  }
  return json;
}

export function normalizeEmail(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().slice(0, 254);
}

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)+$/;
export function validEmail(v: string): boolean {
  return Boolean(v) && v.length <= 254 && EMAIL_RE.test(v);
}

// ── Session resolution ──────────────────────────────────────────────────────
export type Session = { shipperId: string; sessionId: string; email: string };

export async function resolveSession(cookieHeader: string | undefined): Promise<Session | null> {
  const raw = readCookie(cookieHeader, SESSION_COOKIE);
  if (!raw) return null;
  const rows = await sb(
    `sw_sessions?token_hash=eq.${encodeURIComponent(hashToken(raw))}` +
    `&revoked_at=is.null&select=id,shipper_id,expires_at`);
  const s = Array.isArray(rows) && rows[0];
  if (!s) return null;
  if (new Date(s.expires_at).getTime() <= Date.now()) return null;
  const who = await sb(`sw_shippers?id=eq.${s.shipper_id}&select=email`);
  const email = (Array.isArray(who) && who[0]?.email) || '';
  // Fire-and-forget touch; a failure here must not break the request.
  sb(`sw_sessions?id=eq.${s.id}`, {
    method: 'PATCH', body: { last_seen_at: new Date().toISOString() },
    prefer: 'return=minimal',
  }).catch(() => {});
  return { shipperId: s.shipper_id, sessionId: s.id, email };
}
