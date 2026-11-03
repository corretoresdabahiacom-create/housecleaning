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
            u.is_platform_admin, u.deleted_at, c.status AS company_status, c.currency
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
    isPlatformAdmin: !!row.is_platform_admin, sessionId: row.id, currency: row.currency,
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
async function aesKey(env: Env) {
  if (!env.ENCRYPTION_KEY) throw new HttpError(500, 'encryption_not_configured');
  const raw = unb64(env.ENCRYPTION_KEY);
  if (raw.length !== 32) throw new HttpError(500, 'encryption_not_configured');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(env: Env, plaintext: string, aad: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await aesKey(env), enc.encode(plaintext));
  return { ciphertext: b64(ct), iv: b64(iv) };
}
export async function decrypt(env: Env, ciphertext: string, iv: string, aad: string) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(aad) }, await aesKey(env), unb64(ciphertext));
  return new TextDecoder().decode(pt);
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
