import { Ctx, Env, HttpError, Router, json, nowIso, uid, validate } from '../lib/core';
import {
  audit, base32Encode, checkTurnstile, createSession, decrypt, encrypt, hashPassword, verifyTotp, passwordPolicy, randomToken, rateLimit, requirePerm, securityEvent,
  sessionCookie, sha256, verifyPassword, PBKDF2_ITERATIONS,
} from '../lib/security';
import { seedCompanyDefaults } from './seed';
import { checkPlanLimit } from './reports';

const LANGS = ['en', 'pt', 'es'] as const;
const ip = (c: Ctx) => c.req.headers.get('cf-connecting-ip') || 'local';

async function issueToken(env: Env, userId: string, kind: 'verify_email' | 'reset_password', hours: number) {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO user_tokens (id,user_id,kind,expires_at,created_at) VALUES (?,?,?,?,?)')
    .bind(await sha256(token), userId, kind, new Date(Date.now() + hours * 36e5).toISOString(), nowIso()).run();
  return token;
}
// Email delivery requires a configured provider (not included). In development the token is returned
// so flows can be tested end-to-end; in other environments it is never exposed in responses or logs.
const devToken = (env: Env, t: string) => (env.APP_ENV === 'development' ? { dev_token: t } : {});

export function authRoutes(r: Router) {
  r.post('/api/auth/register', async (c) => {
    await rateLimit(c.env, `register:${ip(c)}`, 10, 3600);
    const b = await c.body();
    await checkTurnstile(c.env, c.req, b?.turnstile_token);
    const v = validate(b, {
      full_name: { type: 'string', required: true, max: 120 }, company_name: { type: 'string', required: true, max: 120 },
      email: { type: 'email', required: true }, country: { type: 'string', max: 2 }, state: { type: 'string', required: true, max: 40 },
      city: { type: 'string', required: true, max: 80 }, language: { type: 'enum', values: LANGS }, phone: { type: 'string', max: 30 },
      timezone: { type: 'string', max: 60 }, accept_terms: { type: 'bool', required: true },
    });
    passwordPolicy(b.password);
    if (!v.accept_terms) throw new HttpError(422, 'validation_error', { accept_terms: 'required' });
    const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(v.email).first();
    if (exists) throw new HttpError(409, 'email_in_use');
    const pw = await hashPassword(b.password);
    const userId = uid(), companyId = uid(), now = nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO users (id,email,full_name,password_hash,password_salt,password_iterations,language,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind(userId, v.email, v.full_name, pw.hash, pw.salt, pw.iterations, v.language || 'en', now),
      c.env.DB.prepare('INSERT INTO companies (id,name,country,state,city,phone,timezone,trial_ends_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(companyId, v.company_name, (v.country || 'US').toUpperCase(), v.state, v.city, v.phone ?? null, v.timezone || 'America/New_York', new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), now),
      c.env.DB.prepare('INSERT INTO company_members (id,company_id,user_id,role,created_at) VALUES (?,?,?,?,?)').bind(uid(), companyId, userId, 'owner', now),
      c.env.DB.prepare('INSERT INTO consent_records (id,user_id,document,version,accepted_at) VALUES (?,?,?,?,?)').bind(uid(), userId, 'terms_privacy', '2026-11', now),
    ]);
    await seedCompanyDefaults(c.env, companyId);
    const token = await issueToken(c.env, userId, 'verify_email', 48);
    const s = await createSession(c.env, userId, companyId, c.req.headers.get('user-agent'));
    await audit(c.env, { userId, companyId } as any, 'register', 'company', companyId);
    return json({ ok: true, user_id: userId, company_id: companyId, ...devToken(c.env, token) }, 201, { 'set-cookie': sessionCookie(s.token, c.env) });
  }, false);

  r.post('/api/auth/login', async (c) => {
    const b = await c.body();
    const v = validate(b, { email: { type: 'email', required: true } });
    await rateLimit(c.env, `login:ip:${ip(c)}`, 30, 900);
    await rateLimit(c.env, `login:email:${v.email}`, 8, 900);
    await checkTurnstile(c.env, c.req, b.turnstile_token);
    const u = await c.env.DB.prepare('SELECT * FROM users WHERE email=? AND deleted_at IS NULL').bind(v.email).first<any>();
    const ok = u && typeof b.password === 'string' && (await verifyPassword(b.password, u.password_hash, u.password_salt, u.password_iterations));
    if (!ok) {
      await securityEvent(c.env, 'login_failed', c.req, u?.id);
      throw new HttpError(401, 'invalid_credentials');
    }
    const m = await c.env.DB.prepare(
      `SELECT m.company_id FROM company_members m JOIN companies co ON co.id=m.company_id
        WHERE m.user_id=? AND m.status='active' AND (co.status='active' OR ?=1) ORDER BY m.created_at LIMIT 1`)
      .bind(u.id, u.is_platform_admin).first<any>();
    if (!m) throw new HttpError(403, 'no_active_company');
    if (u.mfa_enabled) {
      // Password OK → issue a short-lived MFA challenge; the session is created only after the TOTP step.
      const token = randomToken();
      await c.env.DB.prepare('INSERT INTO mfa_challenges (id,user_id,company_id,expires_at) VALUES (?,?,?,?)')
        .bind(await sha256(token), u.id, m.company_id, new Date(Date.now() + 5 * 60e3).toISOString()).run();
      return json({ mfa_required: true, mfa_token: token });
    }
    const s = await createSession(c.env, u.id, m.company_id, c.req.headers.get('user-agent'));
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(s.token, c.env) });
  }, false);

  r.post('/api/auth/mfa/verify', async (c) => {
    const b = await c.body();
    if (typeof b?.mfa_token !== 'string') throw new HttpError(400, 'invalid_token');
    const id = await sha256(b.mfa_token);
    const ch = await c.env.DB.prepare('SELECT * FROM mfa_challenges WHERE id=?').bind(id).first<any>();
    if (!ch || ch.expires_at < nowIso() || ch.attempts >= 5) throw new HttpError(400, 'invalid_token');
    await c.env.DB.prepare('UPDATE mfa_challenges SET attempts=attempts+1 WHERE id=?').bind(id).run();
    const u = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(ch.user_id).first<any>();
    let ok = false;
    const code = String(b.code || '').replace(/\s/g, '');
    if (/^\d{6}$/.test(code)) {
      const secret = await decrypt(c.env, u.mfa_secret_enc, u.mfa_secret_iv, `mfa:${u.id}`, u.mfa_key_version);
      const step = await verifyTotp(secret, code);
      if (step !== null && (u.mfa_last_step === null || step > u.mfa_last_step)) { // reject replays
        ok = true;
        await c.env.DB.prepare('UPDATE users SET mfa_last_step=? WHERE id=?').bind(step, u.id).run();
      }
    } else if (code) {
      const res = await c.env.DB.prepare('UPDATE mfa_recovery_codes SET used_at=? WHERE id=? AND user_id=? AND used_at IS NULL').bind(nowIso(), await sha256(code.toUpperCase()), u.id).run();
      ok = res.meta.changes === 1;
      if (ok) await securityEvent(c.env, 'mfa_recovery_code_used', c.req, u.id);
    }
    if (!ok) { await securityEvent(c.env, 'mfa_failed', c.req, u.id); throw new HttpError(401, 'invalid_mfa_code'); }
    await c.env.DB.prepare('DELETE FROM mfa_challenges WHERE id=?').bind(id).run();
    const s = await createSession(c.env, u.id, ch.company_id, c.req.headers.get('user-agent'));
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(s.token, c.env) });
  }, false);

  // MFA enrollment: setup returns a secret (pending), enable confirms with a valid code and returns one-time recovery codes.
  r.post('/api/auth/mfa/setup', async (c) => {
    const s = c.session!;
    const u = await c.env.DB.prepare('SELECT email, mfa_enabled FROM users WHERE id=?').bind(s.userId).first<any>();
    if (u.mfa_enabled) throw new HttpError(409, 'mfa_already_enabled');
    const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
    const e = await encrypt(c.env, secret, `mfa:${s.userId}`);
    await c.env.DB.prepare('UPDATE users SET mfa_secret_enc=?, mfa_secret_iv=?, mfa_key_version=?, mfa_last_step=NULL WHERE id=?').bind(e.ciphertext, e.iv, e.version, s.userId).run();
    const uri = `otpauth://totp/${encodeURIComponent('House Cleaning:' + u.email)}?secret=${secret}&issuer=${encodeURIComponent('House Cleaning Management')}&algorithm=SHA1&digits=6&period=30`;
    return json({ secret, otpauth_uri: uri });
  });
  r.post('/api/auth/mfa/enable', async (c) => {
    const s = c.session!;
    const b = await c.body();
    const u = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(s.userId).first<any>();
    if (u.mfa_enabled) throw new HttpError(409, 'mfa_already_enabled');
    if (!u.mfa_secret_enc) throw new HttpError(409, 'mfa_setup_required');
    const step = await verifyTotp(await decrypt(c.env, u.mfa_secret_enc, u.mfa_secret_iv, `mfa:${u.id}`, u.mfa_key_version), String(b?.code || ''));
    if (step === null) throw new HttpError(401, 'invalid_mfa_code');
    const codes = Array.from({ length: 8 }, () => base32Encode(crypto.getRandomValues(new Uint8Array(5))));
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM mfa_recovery_codes WHERE user_id=?').bind(u.id),
      ...await Promise.all(codes.map(async (x) => c.env.DB.prepare('INSERT INTO mfa_recovery_codes (id,user_id) VALUES (?,?)').bind(await sha256(x), u.id))),
      c.env.DB.prepare('UPDATE users SET mfa_enabled=1, mfa_last_step=? WHERE id=?').bind(step, u.id),
    ]);
    await securityEvent(c.env, 'mfa_enabled', c.req, u.id);
    return json({ ok: true, recovery_codes: codes });
  });
  r.post('/api/auth/mfa/disable', async (c) => {
    const s = c.session!;
    const b = await c.body();
    const u = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(s.userId).first<any>();
    if (!(await verifyPassword(String(b?.password || ''), u.password_hash, u.password_salt, u.password_iterations))) throw new HttpError(401, 'invalid_credentials');
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE users SET mfa_enabled=0, mfa_secret_enc=NULL, mfa_secret_iv=NULL, mfa_key_version=NULL, mfa_last_step=NULL WHERE id=?').bind(u.id),
      c.env.DB.prepare('DELETE FROM mfa_recovery_codes WHERE user_id=?').bind(u.id),
    ]);
    await securityEvent(c.env, 'mfa_disabled', c.req, u.id);
    return json({ ok: true });
  });

  r.get('/api/auth/config', async (c) => json({ turnstile_site_key: c.env.TURNSTILE_SITE_KEY || null }), false);

  r.post('/api/auth/logout', async (c) => {
    if (c.session) await c.env.DB.prepare('UPDATE user_sessions SET revoked_at=? WHERE id=?').bind(nowIso(), c.session.sessionId).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', c.env, 0) });
  }, false);

  r.get('/api/auth/me', async (c) => {
    const s = c.session!;
    const u = await c.env.DB.prepare('SELECT id,email,full_name,language,email_verified_at,is_platform_admin,mfa_enabled FROM users WHERE id=?').bind(s.userId).first();
    const co = await c.env.DB.prepare('SELECT id,name,state,city,phone,currency,timezone,status,whatsapp_enabled,subscription_status,plan_id FROM companies WHERE id=?').bind(s.companyId).first();
    return json({ user: u, company: co, role: s.role, helper_id: s.helperId, config: { turnstile_site_key: c.env.TURNSTILE_SITE_KEY || null, whatsapp_available: !!(c.env.WHATSAPP_TOKEN && c.env.WHATSAPP_PHONE_NUMBER_ID), translation_available: !!c.env.AI } });
  });

  r.put('/api/auth/language', async (c) => {
    const v = validate(await c.body(), { language: { type: 'enum', values: LANGS, required: true } });
    await c.env.DB.prepare('UPDATE users SET language=? WHERE id=?').bind(v.language, c.session!.userId).run();
    return json({ ok: true });
  });

  r.post('/api/auth/verify-email', async (c) => {
    const b = await c.body();
    const row = await useToken(c.env, b?.token, 'verify_email');
    await c.env.DB.prepare('UPDATE users SET email_verified_at=? WHERE id=?').bind(nowIso(), row.user_id).run();
    return json({ ok: true });
  }, false);

  r.post('/api/auth/resend-verification', async (c) => {
    await rateLimit(c.env, `verify:${c.session!.userId}`, 5, 3600);
    const t = await issueToken(c.env, c.session!.userId, 'verify_email', 48);
    return json({ ok: true, ...devToken(c.env, t) });
  });

  r.post('/api/auth/forgot-password', async (c) => {
    const v = validate(await c.body(), { email: { type: 'email', required: true } });
    await rateLimit(c.env, `forgot:${ip(c)}`, 5, 3600);
    const u = await c.env.DB.prepare('SELECT id FROM users WHERE email=? AND deleted_at IS NULL').bind(v.email).first<any>();
    let extra = {};
    if (u) extra = devToken(c.env, await issueToken(c.env, u.id, 'reset_password', 1));
    return json({ ok: true, ...extra }); // same response whether or not the account exists
  }, false);

  r.post('/api/auth/reset-password', async (c) => {
    const b = await c.body();
    passwordPolicy(b?.password);
    const row = await useToken(c.env, b?.token, 'reset_password');
    const pw = await hashPassword(b.password);
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE users SET password_hash=?, password_salt=?, password_iterations=? WHERE id=?').bind(pw.hash, pw.salt, PBKDF2_ITERATIONS, row.user_id),
      c.env.DB.prepare('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(nowIso(), row.user_id),
    ]);
    await securityEvent(c.env, 'password_reset', c.req, row.user_id);
    return json({ ok: true });
  }, false);

  r.get('/api/auth/sessions', async (c) => {
    const { results } = await c.env.DB.prepare(
      'SELECT id, created_at, expires_at, user_agent FROM user_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC')
      .bind(c.session!.userId, nowIso()).all<any>();
    return json({ sessions: results.map((x) => ({ ...x, id: x.id.slice(0, 12), current: x.id === c.session!.sessionId })) });
  });
  r.post('/api/auth/sessions/revoke-others', async (c) => {
    await c.env.DB.prepare('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL')
      .bind(nowIso(), c.session!.userId, c.session!.sessionId).run();
    return json({ ok: true });
  });

  // ── Company members (multi-user) ──
  r.get('/api/members', async (c) => {
    const s = await requirePerm(c.env, c.session, 'members.manage');
    const { results } = await c.env.DB.prepare(
      'SELECT m.id, m.role, m.status, m.helper_id, u.full_name, u.email FROM company_members m JOIN users u ON u.id=m.user_id WHERE m.company_id=? ORDER BY m.created_at')
      .bind(s.companyId).all();
    return json({ members: results });
  });
  r.post('/api/members', async (c) => {
    const s = await requirePerm(c.env, c.session, 'members.manage');
    const b = await c.body();
    const v = validate(b, {
      email: { type: 'email', required: true }, full_name: { type: 'string', required: true, max: 120 },
      role: { type: 'enum', values: ['admin', 'manager', 'scheduler', 'finance', 'helper'], required: true }, helper_id: { type: 'string' },
    });
    if (v.role === 'admin' && s.role !== 'owner') throw new HttpError(403, 'forbidden');
    await checkPlanLimit(c.env, s.companyId, 'users');
    if (v.role === 'helper') {
      const h = await c.env.DB.prepare('SELECT id FROM helper_records WHERE id=? AND company_id=?').bind(v.helper_id, s.companyId).first();
      if (!h) throw new HttpError(422, 'validation_error', { helper_id: 'required' });
    }
    passwordPolicy(b.temporary_password);
    let u = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(v.email).first<any>();
    const now = nowIso();
    if (!u) {
      const pw = await hashPassword(b.temporary_password);
      u = { id: uid() };
      await c.env.DB.prepare('INSERT INTO users (id,email,full_name,password_hash,password_salt,password_iterations,created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(u.id, v.email, v.full_name, pw.hash, pw.salt, pw.iterations, now).run();
    }
    const dup = await c.env.DB.prepare('SELECT id FROM company_members WHERE company_id=? AND user_id=?').bind(s.companyId, u.id).first();
    if (dup) throw new HttpError(409, 'already_member');
    const id = uid();
    await c.env.DB.prepare('INSERT INTO company_members (id,company_id,user_id,role,helper_id,created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, s.companyId, u.id, v.role, v.role === 'helper' ? v.helper_id : null, now).run();
    await audit(c.env, s, 'create', 'member', id, { role: v.role });
    return json({ id }, 201);
  });
  r.put('/api/members/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'members.manage');
    const v = validate(await c.body(), { role: { type: 'enum', values: ['admin', 'manager', 'scheduler', 'finance', 'helper'] }, status: { type: 'enum', values: ['active', 'disabled'] } }, true);
    const m = await c.env.DB.prepare('SELECT * FROM company_members WHERE id=? AND company_id=?').bind(c.params.id, s.companyId).first<any>();
    if (!m) throw new HttpError(404, 'not_found');
    if (m.role === 'owner') throw new HttpError(403, 'cannot_modify_owner');
    await c.env.DB.prepare('UPDATE company_members SET role=COALESCE(?,role), status=COALESCE(?,status) WHERE id=?').bind(v.role ?? null, v.status ?? null, m.id).run();
    if (v.status === 'disabled') await c.env.DB.prepare('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND company_id=?').bind(nowIso(), m.user_id, s.companyId).run();
    await audit(c.env, s, 'update', 'member', m.id, v);
    return json({ ok: true });
  });
  r.put('/api/roles/permissions', async (c) => {
    const s = await requirePerm(c.env, c.session, 'company.manage');
    const v = validate(await c.body(), { role: { type: 'enum', values: ['manager', 'scheduler', 'finance', 'helper'], required: true }, permission: { type: 'string', required: true }, allowed: { type: 'bool', required: true } });
    const { PERMISSIONS } = await import('../lib/security');
    if (!(PERMISSIONS as readonly string[]).includes(v.permission)) throw new HttpError(422, 'validation_error', { permission: 'enum' });
    await c.env.DB.prepare('INSERT INTO company_roles (company_id,role,permission,allowed) VALUES (?,?,?,?) ON CONFLICT(company_id,role,permission) DO UPDATE SET allowed=excluded.allowed')
      .bind(s.companyId, v.role, v.permission, v.allowed).run();
    await audit(c.env, s, 'update', 'permission', null, v);
    return json({ ok: true });
  });

  // ── Company settings (name, phone, time zone, WhatsApp opt-in) ──
  r.put('/api/company', async (c) => {
    const s = await requirePerm(c.env, c.session, 'company.manage');
    const v: any = validate(await c.body(), { name: { type: 'string', max: 120 }, phone: { type: 'string', max: 30 }, timezone: { type: 'string', max: 60 }, whatsapp_enabled: { type: 'bool' } }, true);
    if (v.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: v.timezone }); } catch { throw new HttpError(422, 'validation_error', { timezone: 'invalid' }); } }
    const cols = Object.keys(v);
    if (!cols.length) throw new HttpError(422, 'nothing_to_update');
    await c.env.DB.prepare(`UPDATE companies SET ${cols.map((k) => `${k}=?`).join(',')} WHERE id=?`).bind(...Object.values(v), s.companyId).run();
    await audit(c.env, s, 'update', 'company', s.companyId, cols);
    return json({ ok: true });
  });

  // ── Account deletion (owner): suspends company, revokes sessions, schedules data purge ──
  r.post('/api/company/delete', async (c) => {
    const s = c.session!;
    if (s.role !== 'owner') throw new HttpError(403, 'forbidden');
    const b = await c.body();
    const u = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(s.userId).first<any>();
    if (!(await verifyPassword(String(b?.password || ''), u.password_hash, u.password_salt, u.password_iterations))) throw new HttpError(401, 'invalid_credentials');
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE companies SET status='deleted', deleted_at=? WHERE id=?").bind(nowIso(), s.companyId),
      c.env.DB.prepare('UPDATE user_sessions SET revoked_at=? WHERE company_id=?').bind(nowIso(), s.companyId),
    ]);
    await audit(c.env, s, 'delete_requested', 'company', s.companyId);
    return json({ ok: true, purge_after_days: parseInt(c.env.PURGE_AFTER_DAYS || '30', 10) });
  });
}

async function useToken(env: Env, token: unknown, kind: string) {
  if (typeof token !== 'string' || !token) throw new HttpError(400, 'invalid_token');
  const id = await sha256(token);
  const row = await env.DB.prepare('SELECT * FROM user_tokens WHERE id=? AND kind=?').bind(id, kind).first<any>();
  if (!row || row.used_at || row.expires_at < nowIso()) throw new HttpError(400, 'invalid_token');
  await env.DB.prepare('UPDATE user_tokens SET used_at=? WHERE id=?').bind(nowIso(), id).run();
  return row;
}
