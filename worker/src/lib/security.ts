import { Env, HttpError, Role, Session, nowIso, uid } from './core';

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// ───────── Passwords: PBKDF2-SHA256 (Workers WebCrypto max 100k iterations) ─────────
export const PBKDF2_ITERATIONS = 100_000;
export async function hashPassword(password: string, saltB64?: string, iterations = PBKDF2_ITERATIONS) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return { hash: b64(bits), salt: b64(salt), iterations };
}
export async function verifyPassword(password: string, hash: string, salt: string, iterations: number) {
  const h = await hashPassword(password, salt, iterations);
  return timingSafeEqual(h.hash, hash);
}
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export function passwordPolicy(pw: unknown) {
  if (typeof pw !== 'string' || pw.length < 10 || pw.length > 200 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw))
    throw new HttpError(422, 'validation_error', { password: 'weak_password' });
}

export const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
export const randomToken = () => b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (m) => ({ '+': '-', '/': '_', '=': '' }[m]!));

// ───────── Sessions ─────────
export const SESSION_COOKIE = 'hcm_session';
const SESSION_DAYS = 14;

export async function createSession(env: Env, userId: string, companyId: string, ua: string | null) {
  const token = randomToken();
  const id = await sha256(token);
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.prepare('INSERT INTO user_sessions (id,user_id,company_id,created_at,expires_at,user_agent) VALUES (?,?,?,?,?,?)')
    .bind(id, userId, companyId, nowIso(), exp, (ua || '').slice(0, 200)).run();
  return { token, expires: exp };
}

export function sessionCookie(token: string, env: Env, maxAgeSec = SESSION_DAYS * 86400) {
  const secure = env.APP_ENV === 'development' ? '' : ' Secure;';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=${maxAgeSec}`;
}

export function readToken(req: Request) {
  const cookie = req.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

export async function loadSession(env: Env, req: Request): Promise<Session | null> {
  const token = readToken(req);
  if (!token) return null;
  const id = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.company_id, s.expires_at, s.revoked_at, m.role, m.helper_id, m.status AS member_status,
            u.is_platform_admin, u.deleted_at, c.status AS company_status, c.currency, c.timezone
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN companies c ON c.id = s.company_id
       JOIN company_members m ON m.user_id = s.user_id AND m.company_id = s.company_id
      WHERE s.id = ?`).bind(id).first<any>();
  if (!row || row.revoked_at || row.deleted_at || row.member_status !== 'active') return null;
  if (row.expires_at < nowIso()) return null;
  if (row.company_status !== 'active' && !row.is_platform_admin) return null;
  return {
    userId: row.user_id, companyId: row.company_id, role: row.role, helperId: row.helper_id,
    isPlatformAdmin: !!row.is_platform_admin, sessionId: row.id, currency: row.currency, timezone: row.timezone,
  };
}

// ───────── Permissions (enforced server-side; overridable per company) ─────────
export const PERMISSIONS = [
  'customers.read', 'customers.write', 'properties.read', 'properties.write', 'properties.access_info',
  'services.write', 'schedule.read', 'schedule.write', 'helpers.read', 'helpers.write', 'helpers.private',
  'finance.read', 'finance.write', 'reports.read', 'messages.use', 'company.manage', 'members.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);
const DEFAULTS: Record<Role, Set<Permission>> = {
  owner: ALL,
  admin: ALL,
  manager: new Set<Permission>(['customers.read', 'customers.write', 'properties.read', 'properties.write', 'properties.access_info', 'services.write', 'schedule.read', 'schedule.write', 'helpers.read', 'helpers.write', 'helpers.private', 'reports.read', 'messages.use', 'finance.read']),
  scheduler: new Set<Permission>(['customers.read', 'properties.read', 'schedule.read', 'schedule.write', 'helpers.read', 'messages.use']),
  finance: new Set<Permission>(['customers.read', 'properties.read', 'schedule.read', 'helpers.read', 'finance.read', 'finance.write', 'reports.read']),
  helper: new Set<Permission>(['messages.use']),
};

export async function can(env: Env, s: Session, p: Permission): Promise<boolean> {
  if (s.role === 'owner') return true; // owner can never be locked out
  const o = await env.DB.prepare('SELECT allowed FROM company_roles WHERE company_id=? AND role=? AND permission=?')
    .bind(s.companyId, s.role, p).first<{ allowed: number }>();
  if (o) return !!o.allowed;
  return DEFAULTS[s.role]?.has(p) ?? false;
}
export async function requirePerm(env: Env, s: Session | null, p: Permission): Promise<Session> {
  if (!s) throw new HttpError(401, 'unauthenticated');
  if (!(await can(env, s, p))) throw new HttpError(403, 'forbidden');
  return s;
}

/** Ensures a referenced row belongs to the caller's company. Returns 404 (not 403) to avoid ID probing. */
const OWNED_TABLES = new Set(['customers', 'residential_properties', 'helper_records', 'cleaning_services', 'cleaning_appointments',
  'recurring_service_rules', 'accounts_receivable', 'accounts_payable', 'financial_categories', 'teams', 'conversations']);
export async function owned<T = any>(env: Env, table: string, id: unknown, companyId: string): Promise<T> {
  if (!OWNED_TABLES.has(table)) throw new Error('table not allowed');
  if (typeof id !== 'string' || !id) throw new HttpError(404, 'not_found');
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id=? AND company_id=?`).bind(id, companyId).first<T>();
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}

// ───────── Rate limiting (fixed window in D1) ─────────
export async function rateLimit(env: Env, key: string, limit: number, windowSec: number) {
  const w = Math.floor(Date.now() / 1000 / windowSec) * windowSec;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?,?,1)
     ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count`).bind(key, w).first<{ count: number }>();
  if (row && row.count > limit) throw new HttpError(429, 'rate_limited');
}

// ───────── Encryption for access instructions (AES-256-GCM) ─────────
// Key rotation: ENCRYPTION_KEY is the current key (version ENCRYPTION_KEY_VERSION, default 1);
// ENCRYPTION_KEY_PREVIOUS (version - 1) stays readable until re-encryption completes. See docs/KEY_ROTATION.md.
export const currentKeyVersion = (env: Env) => parseInt(env.ENCRYPTION_KEY_VERSION || '1', 10);
async function aesKey(env: Env, version?: number) {
  const v = version ?? currentKeyVersion(env);
  const secret = v === currentKeyVersion(env) ? env.ENCRYPTION_KEY : v === currentKeyVersion(env) - 1 ? env.ENCRYPTION_KEY_PREVIOUS : undefined;
  if (!secret) throw new HttpError(500, 'encryption_key_unavailable');
  const raw = unb64(secret);
  if (raw.length !== 32) throw new HttpError(500, 'encryption_not_configured');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(env: Env, plaintext: string, aad: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await aesKey(env), enc.encode(plaintext));
  return { ciphertext: b64(ct), iv: b64(iv), version: currentKeyVersion(env) };
}
export async function decrypt(env: Env, ciphertext: string, iv: string, aad: string, version?: number) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(aad) }, await aesKey(env, version), unb64(ciphertext));
  return new TextDecoder().decode(pt);
}

/** Re-encrypts every secret stored with an older key version. Idempotent; run after deploying a new key. */
export async function rotateEncryptedData(env: Env) {
  const cur = currentKeyVersion(env);
  let n = 0;
  const { results } = await env.DB.prepare('SELECT * FROM property_access_instructions WHERE key_version<>?').bind(cur).all<any>();
  for (const r of results) {
    const aad = `${r.company_id}:${r.property_id}`;
    const e = await encrypt(env, await decrypt(env, r.ciphertext, r.iv, aad, r.key_version), aad);
    await env.DB.prepare('UPDATE property_access_instructions SET ciphertext=?, iv=?, key_version=? WHERE property_id=? AND key_version=?').bind(e.ciphertext, e.iv, e.version, r.property_id, r.key_version).run();
    n++;
  }
  const { results: mfa } = await env.DB.prepare('SELECT id, mfa_secret_enc, mfa_secret_iv, mfa_key_version FROM users WHERE mfa_secret_enc IS NOT NULL AND mfa_key_version<>?').bind(cur).all<any>();
  for (const u of mfa) {
    const aad = `mfa:${u.id}`;
    const e = await encrypt(env, await decrypt(env, u.mfa_secret_enc, u.mfa_secret_iv, aad, u.mfa_key_version), aad);
    await env.DB.prepare('UPDATE users SET mfa_secret_enc=?, mfa_secret_iv=?, mfa_key_version=? WHERE id=?').bind(e.ciphertext, e.iv, e.version, u.id).run();
    n++;
  }
  return n;
}

// ───────── TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ─────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(bytes: Uint8Array) {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string) {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, val = 0; const out: number[] = [];
  for (const ch of clean) { const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32'); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}
export async function totp(secretB32: string, step: number) {
  const key = await crypto.subtle.importKey('raw', base32Decode(secretB32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8); let x = step;
  for (let i = 7; i >= 0; i--) { msg[i] = x & 255; x = Math.floor(x / 256); }
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[19] & 15;
  const code = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}
/** Returns the matched time step (±1 window) or null. */
export async function verifyTotp(secretB32: string, code: string, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) if (timingSafeEqual(await totp(secretB32, s), code)) return s;
  return null;
}

// ───────── Turnstile (bot protection) ─────────
export async function checkTurnstile(env: Env, req: Request, token: unknown) {
  if (!env.TURNSTILE_SECRET) return; // disabled unless configured
  if (typeof token !== 'string' || !token) throw new HttpError(400, 'captcha_required');
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET); form.set('response', token);
  const ip = req.headers.get('cf-connecting-ip'); if (ip) form.set('remoteip', ip);
  let ok = false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    ok = !!((await r.json()) as any)?.success;
  } catch { ok = false; }
  if (!ok) throw new HttpError(400, 'captcha_failed');
}

// ───────── Audit (never pass secrets in details) ─────────
export async function audit(env: Env, s: Session | null, action: string, entity: string, entityId: string | null, details?: unknown) {
  await env.DB.prepare('INSERT INTO audit_logs (id,company_id,user_id,action,entity,entity_id,details,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(uid(), s?.companyId ?? null, s?.userId ?? null, action, entity, entityId, details ? JSON.stringify(details).slice(0, 2000) : null, nowIso()).run();
}
export async function securityEvent(env: Env, kind: string, req: Request | null, userId?: string | null, details?: unknown) {
  const ip = req?.headers.get('cf-connecting-ip') || '';
  await env.DB.prepare('INSERT INTO security_events (id,kind,user_id,ip_hash,details,created_at) VALUES (?,?,?,?,?,?)')
    .bind(uid(), kind, userId ?? null, ip ? (await sha256(ip)).slice(0, 16) : null, details ? JSON.stringify(details) : null, nowIso()).run();
}
