// Invitations by link: an owner/admin invites a person by email with a role; the person opens the link, signs in with
// Google (or sets a password) and lands in the company with exactly that role. Tokens are random, stored only as SHA-256,
// single-use, expire in 7 days and are shown once (at creation) to the inviter.
import { Env, HttpError, Router, json, nowIso, uid, validate } from '../lib/core';
import {
  audit, hashPassword, passwordPolicy, randomToken, rateLimit, requirePerm, sha256, securityEvent, verifyPassword,
} from '../lib/security';
import { verifyFirebaseIdToken } from '../lib/firebase';
import { appOrigin, sendMail } from '../lib/email';
import { checkPlanLimit } from './reports';
import { finishLogin } from './auth';

const ROLES = ['admin', 'manager', 'scheduler', 'finance', 'helper'] as const;
const INVITE_DAYS = 7;
const ip = (req: Request) => req.headers.get('cf-connecting-ip') || 'local';

async function loadInvite(env: Env, token: unknown) {
  if (typeof token !== 'string' || token.length < 20) throw new HttpError(400, 'invalid_token');
  const inv = await env.DB.prepare('SELECT * FROM invitations WHERE id=?').bind(await sha256(token)).first<any>();
  if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at < nowIso()) throw new HttpError(400, 'invalid_token');
  const co = await env.DB.prepare("SELECT id, name, status FROM companies WHERE id=?").bind(inv.company_id).first<any>();
  if (!co || co.status !== 'active') throw new HttpError(400, 'invalid_token');
  return { inv, co };
}

export function invitationRoutes(r: Router) {
  r.post('/api/invitations', async (c) => {
    const s = await requirePerm(c.env, c.session, 'members.manage');
    await rateLimit(c.env, `invite:${s.companyId}`, 60, 3600);
    const v = validate(await c.body(), {
      email: { type: 'email', required: true }, full_name: { type: 'string', required: true, max: 120 },
      role: { type: 'enum', values: ROLES, required: true }, helper_id: { type: 'string' }, language: { type: 'enum', values: ['en', 'pt', 'es'] },
    });
    if (v.role === 'admin' && s.role !== 'owner') throw new HttpError(403, 'forbidden');
    await checkPlanLimit(c.env, s.companyId, 'users');
    if (v.role === 'helper') {
      if (!v.helper_id) throw new HttpError(422, 'validation_error', { helper_id: 'required' });
      const h = await c.env.DB.prepare("SELECT id FROM helper_records WHERE id=? AND company_id=? AND status='active'").bind(v.helper_id, s.companyId).first();
      if (!h) throw new HttpError(422, 'validation_error', { helper_id: 'required' });
      const linked = await c.env.DB.prepare('SELECT 1 FROM company_members WHERE company_id=? AND helper_id=?').bind(s.companyId, v.helper_id).first();
      if (linked) throw new HttpError(409, 'helper_already_linked');
    }
    const member = await c.env.DB.prepare('SELECT 1 FROM company_members m JOIN users u ON u.id=m.user_id WHERE m.company_id=? AND u.email=?').bind(s.companyId, v.email).first();
    if (member) throw new HttpError(409, 'already_member');
    // A new invitation to the same email replaces the previous pending one.
    await c.env.DB.prepare('UPDATE invitations SET revoked_at=? WHERE company_id=? AND email=? AND accepted_at IS NULL AND revoked_at IS NULL').bind(nowIso(), s.companyId, v.email).run();
    const token = randomToken();
    const id = await sha256(token);
    await c.env.DB.prepare('INSERT INTO invitations (id,company_id,email,full_name,role,helper_id,language,invited_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(id, s.companyId, v.email, v.full_name, v.role, v.role === 'helper' ? v.helper_id : null, v.language || 'en', s.userId, new Date(Date.now() + INVITE_DAYS * 864e5).toISOString(), nowIso()).run();
    const link = `${appOrigin(c.env, c.req)}/#/?invite=${token}`;
    const inviter = await c.env.DB.prepare('SELECT u.full_name, co.name company FROM users u, companies co WHERE u.id=? AND co.id=?').bind(s.userId, s.companyId).first<any>();
    const mail = await sendMail(c.env, { to: v.email, kind: 'invitation', lang: v.language || 'en', link, companyId: s.companyId, vars: { company: inviter.company, inviter: inviter.full_name, role: v.role } });
    await audit(c.env, s, 'create', 'invitation', id.slice(0, 12), { role: v.role });
    return json({ id: id.slice(0, 12), link, email: mail.status, expires_in_days: INVITE_DAYS }, 201);
  });

  r.get('/api/invitations', async (c) => {
    const s = await requirePerm(c.env, c.session, 'members.manage');
    const { results } = await c.env.DB.prepare(
      `SELECT substr(id,1,12) AS id, email, full_name, role, helper_id, expires_at, created_at FROM invitations
        WHERE company_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 100`).bind(s.companyId, nowIso()).all();
    return json({ items: results });
  });

  r.del('/api/invitations/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'members.manage');
    if (!/^[0-9a-f]{12}$/.test(c.params.id)) throw new HttpError(404, 'not_found');
    const res = await c.env.DB.prepare('UPDATE invitations SET revoked_at=? WHERE company_id=? AND substr(id,1,12)=? AND accepted_at IS NULL AND revoked_at IS NULL').bind(nowIso(), s.companyId, c.params.id).run();
    if (!res.meta.changes) throw new HttpError(404, 'not_found');
    await audit(c.env, s, 'revoke', 'invitation', c.params.id);
    return json({ ok: true });
  });

  // Public: what the invitee sees before accepting (no sensitive data).
  r.post('/api/invitations/preview', async (c) => {
    await rateLimit(c.env, `invite_preview:${ip(c.req)}`, 60, 900);
    const { inv, co } = await loadInvite(c.env, (await c.body())?.token);
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email=? AND deleted_at IS NULL').bind(inv.email).first();
    return json({ company_name: co.name, role: inv.role, email: inv.email, full_name: inv.full_name, language: inv.language, existing_account: !!existing });
  }, false);

  // Public: accept with Google (preferred) or password. The invited email is the identity; Google must return the same verified email.
  r.post('/api/invitations/accept', async (c) => {
    await rateLimit(c.env, `invite_accept:${ip(c.req)}`, 20, 900);
    const b = await c.body();
    const { inv, co } = await loadInvite(c.env, b?.token);
    let u = await c.env.DB.prepare('SELECT * FROM users WHERE email=? AND deleted_at IS NULL').bind(inv.email).first<any>();
    const now = nowIso();
    if (b.google_id_token) {
      const g = await verifyFirebaseIdToken(b.google_id_token, c.env.FIREBASE_PROJECT_ID);
      if (g.email !== inv.email) throw new HttpError(422, 'validation_error', { email: 'google_email_mismatch' });
      if (u) {
        if (u.google_uid && u.google_uid !== g.uid) throw new HttpError(409, 'google_account_mismatch');
        await c.env.DB.prepare('UPDATE users SET google_uid=?, email_verified_at=COALESCE(email_verified_at, ?) WHERE id=?').bind(g.uid, now, u.id).run();
      } else {
        const pw = await hashPassword(randomToken() + randomToken());
        const id = uid();
        await c.env.DB.prepare('INSERT INTO users (id,email,full_name,password_hash,password_salt,password_iterations,language,email_verified_at,google_uid,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .bind(id, inv.email, inv.full_name, pw.hash, pw.salt, pw.iterations, inv.language, now, g.uid, now).run();
        u = { id, mfa_enabled: 0, is_platform_admin: 0 };
      }
    } else if (u) {
      // Existing account without Google: must prove ownership with its current password.
      if (!(await verifyPassword(String(b.password || ''), u.password_hash, u.password_salt, u.password_iterations))) {
        await securityEvent(c.env, 'invite_login_failed', c.req, u.id);
        throw new HttpError(401, 'invalid_credentials');
      }
    } else {
      passwordPolicy(b.password);
      const pw = await hashPassword(b.password);
      const id = uid();
      // Opening the emailed link proves control of the invited address.
      await c.env.DB.prepare('INSERT INTO users (id,email,full_name,password_hash,password_salt,password_iterations,language,email_verified_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(id, inv.email, inv.full_name, pw.hash, pw.salt, pw.iterations, inv.language, now, now).run();
      u = { id, mfa_enabled: 0, is_platform_admin: 0 };
    }
    await checkPlanLimit(c.env, inv.company_id, 'users');
    // Claim the invitation atomically (single use), then add the membership.
    const claim = await c.env.DB.prepare('UPDATE invitations SET accepted_at=? WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL').bind(now, inv.id).run();
    if (!claim.meta.changes) throw new HttpError(400, 'invalid_token');
    const dup = await c.env.DB.prepare('SELECT id FROM company_members WHERE company_id=? AND user_id=?').bind(inv.company_id, u.id).first();
    if (!dup) {
      await c.env.DB.prepare('INSERT INTO company_members (id,company_id,user_id,role,helper_id,created_at) VALUES (?,?,?,?,?,?)').bind(uid(), inv.company_id, u.id, inv.role, inv.helper_id, now).run();
    }
    await audit(c.env, { userId: u.id, companyId: inv.company_id } as any, 'accept', 'invitation', inv.id.slice(0, 12), { role: inv.role });
    const full = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(u.id).first<any>();
    return finishLogin(c, full, inv.company_id);
  }, false);
}
