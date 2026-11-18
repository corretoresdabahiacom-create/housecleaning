import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { Client, isoDay, johnson, makeEnv, registerCompany } from './harness';
import { _resetFirebaseKeyCache } from '../worker/src/lib/firebase';
import { b64uDecode, b64uEncode, encryptPayload } from '../worker/src/lib/webpush';
import { verifyStripeSignature } from '../worker/src/lib/stripe';
import { sendDueReminders, toE164, localStamp } from '../worker/src/lib/reminders';
import { renderMail } from '../worker/src/lib/email';

afterEach(() => { vi.unstubAllGlobals(); _resetFirebaseKeyCache(); });

// Fake provider values are generated per run (nothing credential-like is committed to the repository).
const fake = (prefix: string) => prefix + randomBytes(12).toString('hex');
const PLATFORM_KEY = fake('sk_test_'), PLATFORM_SIG = fake('whsec_');
const COMPANY_KEY = fake('sk_test_'), COMPANY_SIG = fake('whsec_');
const OTHER_KEY = fake('sk_test_'), WRONG_SIG = fake('whsec_');
const RESEND_KEY = fake('re_test_');

const localToday = (tz = 'America/New_York') => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

type Call = { url: string; init: RequestInit; body: string };
/** Records outgoing requests and answers with `handler`. */
function stubFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? init.body : init.body instanceof Uint8Array ? '[binary]' : '';
    const call = { url: String(url), init, body };
    calls.push(call);
    return handler(call);
  });
  return calls;
}
const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// ─────────────────────────── 1. Email ───────────────────────────
describe('Transactional email (Resend)', () => {
  const mailEnv = () => Object.assign(makeEnv(), { APP_ENV: 'production', RESEND_API_KEY: RESEND_KEY, MAIL_FROM: 'House Cleaning <no-reply@example.com>' });

  it('sends the verification email on registration and the reset email only for real accounts, never leaking tokens', async () => {
    const calls = stubFetch(() => ok({ id: 'em_1' }));
    const env = mailEnv();
    await registerCompany(env, 'Mail Co');
    const verify = calls.find((c) => c.url === 'https://api.resend.com/emails')!;
    const sent = JSON.parse(verify.body);
    expect((verify.init.headers as any).authorization).toBe(`Bearer ${RESEND_KEY}`);
    expect(sent.from).toContain('no-reply@example.com');
    expect(sent.to).toHaveLength(1);
    expect(sent.text).toMatch(/https:\/\/app\.test\/#\/\?verify=[\w-]{20,}/);
    const email = sent.to[0];

    calls.length = 0;
    const known = await new Client(env).post('/api/auth/forgot-password', { email });
    const unknown = await new Client(env).post('/api/auth/forgot-password', { email: 'nobody@example.com' });
    expect(known.status).toBe(200); expect(unknown.status).toBe(200);
    expect(known.data).toEqual(unknown.data);                 // identical response: no account enumeration
    expect(known.data.dev_token).toBeUndefined();             // tokens are never in responses outside development
    expect(calls).toHaveLength(1);                            // only the real account received mail
    const reset = JSON.parse(calls[0].body);
    expect(reset.text).toMatch(/#\/\?reset=[\w-]{20,}/);
    const token = /reset=([\w-]+)/.exec(reset.text)![1];
    // The emailed token really resets the password.
    expect((await new Client(env).post('/api/auth/reset-password', { token, password: 'Another$ecret99' })).status).toBe(200);
    expect((await new Client(env).post('/api/auth/login', { email, password: 'Another$ecret99' })).status).toBe(200);

    // Delivery log keeps outcomes only — never links or tokens.
    const log = env.DB.raw.prepare('SELECT * FROM email_log').all();
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(log)).not.toContain(token);
    expect(log.every((r: any) => r.status === 'sent')).toBe(true);
  });

  it('keeps every flow working when no provider is configured, and survives provider failures', async () => {
    const env = makeEnv();                                    // no provider key
    const { client } = await registerCompany(env, 'No Mail');
    const r = await client.post('/api/auth/resend-verification');
    expect(r.status).toBe(200); expect(r.data.email).toBe('disabled');
    const calls = stubFetch(() => ok({ message: 'invalid' }, 422));
    const env2 = mailEnv();
    const { client: c2 } = await registerCompany(env2, 'Failing Mail');   // registration must not fail when email fails
    expect(calls.length).toBeGreaterThan(0);
    expect(env2.DB.raw.prepare("SELECT COUNT(*) n FROM email_log WHERE status='failed'").get().n).toBeGreaterThan(0);
    expect((await c2.get('/api/auth/me')).status).toBe(200);
  });

  it('renders localized templates and escapes HTML', () => {
    const m = renderMail('invitation', 'pt', 'https://x.test/#/?invite=abc', { company: '<b>Casa</b>', inviter: 'Ana', role: 'scheduler' });
    expect(m.html).not.toContain('<b>Casa</b>');
    expect(m.html).toContain('&lt;b&gt;Casa&lt;/b&gt;');
    expect(m.text).toContain('Aceitar convite');
  });
});

// ─────────────────────────── 2. Invitations ───────────────────────────
const PROJECT = 'housecleaning-b528b';
let rsaPriv: CryptoKey, rsaJwk: JsonWebKey;
beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  rsaPriv = kp.privateKey; rsaJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
});
async function googleToken(email: string, sub = 'g-uid-1') {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const p = enc({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub, auth_time: now, iat: now, exp: now + 3600, email, email_verified: true, name: 'Invited Person' });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', rsaPriv, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`;
}
const stubJwks = () => stubFetch(() => new Response(JSON.stringify({ keys: [{ ...rsaJwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }), { headers: { 'cache-control': 'public, max-age=3600' } }));
const tokenOf = (link: string) => /invite=([\w-]+)/.exec(link)![1];

describe('Invitations by link', () => {
  it('invites with a role, accepts once with a password, and grants exactly that role', async () => {
    const env = makeEnv();
    const { client: owner } = await registerCompany(env, 'Invite Co');
    const inv = await owner.post('/api/invitations', { email: 'sched@example.com', full_name: 'Sam Scheduler', role: 'scheduler' });
    expect(inv.status).toBe(201);
    expect(inv.data.link).toMatch(/^https:\/\/app\.test\/#\/\?invite=/);
    const token = tokenOf(inv.data.link);
    // The raw token is never stored; listing never exposes it.
    expect(JSON.stringify(env.DB.raw.prepare('SELECT * FROM invitations').all())).not.toContain(token);
    expect(JSON.stringify((await owner.get('/api/invitations')).data)).not.toContain(token);

    const pre = await new Client(env).post('/api/invitations/preview', { token });
    expect(pre.data).toMatchObject({ company_name: 'Invite Co', role: 'scheduler', email: 'sched@example.com', existing_account: false });

    const guest = new Client(env);
    expect((await guest.post('/api/invitations/accept', { token, password: 'short' })).status).toBe(422);        // password policy applies
    const acc = await guest.post('/api/invitations/accept', { token, password: 'Welcome2Team!x' });
    expect(acc.status).toBe(200);
    const me = (await guest.get('/api/auth/me')).data;
    expect(me.role).toBe('scheduler'); expect(me.company.name).toBe('Invite Co'); expect(me.user.email_verified_at).toBeTruthy();
    expect((await guest.get('/api/finance/receivables')).status).toBe(403);   // scheduler: no finances
    expect((await guest.post('/api/invitations', { email: 'x@example.com', full_name: 'X', role: 'scheduler' })).status).toBe(403);   // cannot invite others

    // single use
    expect((await new Client(env).post('/api/invitations/accept', { token, password: 'Welcome2Team!x' })).status).toBe(400);
    expect((await new Client(env).post('/api/invitations/preview', { token })).status).toBe(400);
    // already a member → cannot invite again
    expect((await owner.post('/api/invitations', { email: 'sched@example.com', full_name: 'Sam', role: 'finance' })).status).toBe(409);
  });

  it('enforces who can invite whom, revocation, expiry, tenant isolation and plan limits', async () => {
    const env = makeEnv();
    const { client: owner } = await registerCompany(env, 'Rules Co');
    const { client: other } = await registerCompany(env, 'Other Co');
    // only the owner can create admins
    const adminInv = await owner.post('/api/invitations', { email: 'admin@example.com', full_name: 'Ad Min', role: 'admin' });
    const adm = new Client(env);
    await adm.post('/api/invitations/accept', { token: tokenOf(adminInv.data.link), password: 'Welcome2Team!x' });
    expect((await adm.post('/api/invitations', { email: 'a2@example.com', full_name: 'A2', role: 'admin' })).status).toBe(403);
    expect((await adm.post('/api/invitations', { email: 'f@example.com', full_name: 'Fin', role: 'finance' })).status).toBe(201);
    // helper role requires a real helper of THIS company
    expect((await owner.post('/api/invitations', { email: 'h@example.com', full_name: 'H', role: 'helper' })).status).toBe(422);
    const j = await johnson(other);
    expect((await owner.post('/api/invitations', { email: 'h@example.com', full_name: 'H', role: 'helper', helper_id: j.mariaId })).status).toBe(422);
    // revoke; another tenant cannot revoke ours
    const inv = await owner.post('/api/invitations', { email: 'rev@example.com', full_name: 'Rev', role: 'manager' });
    expect((await other.del(`/api/invitations/${inv.data.id}`)).status).toBe(404);
    expect((await owner.del(`/api/invitations/${inv.data.id}`)).status).toBe(200);
    expect((await new Client(env).post('/api/invitations/accept', { token: tokenOf(inv.data.link), password: 'Welcome2Team!x' })).status).toBe(400);
    // expired
    const inv2 = await owner.post('/api/invitations', { email: 'old@example.com', full_name: 'Old', role: 'manager' });
    env.DB.raw.prepare("UPDATE invitations SET expires_at='2020-01-01T00:00:00.000Z' WHERE email='old@example.com'").run();
    expect((await new Client(env).post('/api/invitations/accept', { token: tokenOf(inv2.data.link), password: 'Welcome2Team!x' })).status).toBe(400);
    // re-inviting replaces the previous pending invitation
    const a = await owner.post('/api/invitations', { email: 'again@example.com', full_name: 'Again', role: 'manager' });
    const b = await owner.post('/api/invitations', { email: 'again@example.com', full_name: 'Again', role: 'finance' });
    expect((await new Client(env).post('/api/invitations/accept', { token: tokenOf(a.data.link), password: 'Welcome2Team!x' })).status).toBe(400);
    expect((await new Client(env).post('/api/invitations/accept', { token: tokenOf(b.data.link), password: 'Welcome2Team!x' })).status).toBe(200);
    // plan limit
    env.DB.raw.prepare("INSERT INTO subscription_plans (id,name,price_cents,max_users,created_at) VALUES ('p1','Tiny',1000,1,'2026-01-01')").run();
    env.DB.raw.prepare("UPDATE companies SET plan_id='p1' WHERE name='Rules Co'").run();
    expect((await owner.post('/api/invitations', { email: 'limit@example.com', full_name: 'L', role: 'manager' })).status).toBe(402);
  });

  it('accepts with Google only when the verified Google email equals the invited email; existing accounts must prove ownership', async () => {
    stubJwks();
    const env = Object.assign(makeEnv(), { FIREBASE_PROJECT_ID: PROJECT });
    const { client: owner } = await registerCompany(env, 'Google Invite Co');
    const inv = await owner.post('/api/invitations', { email: 'maria@gmail.com', full_name: 'Maria', role: 'finance' });
    const token = tokenOf(inv.data.link);
    const wrong = await new Client(env).post('/api/invitations/accept', { token, google_id_token: await googleToken('someone.else@gmail.com') });
    expect(wrong.status).toBe(422);
    expect((await new Client(env).post('/api/invitations/preview', { token })).status).toBe(200);   // still valid after a failed attempt
    const g = new Client(env);
    expect((await g.post('/api/invitations/accept', { token, google_id_token: await googleToken('maria@gmail.com') })).status).toBe(200);
    expect((await g.get('/api/auth/me')).data.role).toBe('finance');
    // Later, Google sign-in finds her by uid.
    expect((await new Client(env).post('/api/auth/google', { id_token: await googleToken('maria@gmail.com') })).status).toBe(200);

    // existing password account invited to another company: must authenticate with its password
    const { client: o2 } = await registerCompany(env, 'Second Co');
    const email = (await owner.get('/api/members')).data.members[0].email as string;
    const inv2 = await o2.post('/api/invitations', { email, full_name: 'Owner One', role: 'manager' });
    const t2 = tokenOf(inv2.data.link);
    expect((await new Client(env).post('/api/invitations/preview', { token: t2 })).data.existing_account).toBe(true);
    expect((await new Client(env).post('/api/invitations/accept', { token: t2, password: 'wrong-password-1' })).status).toBe(401);
    const ok1 = new Client(env);
    expect((await ok1.post('/api/invitations/accept', { token: t2, password: 'Sup3rSecret!pw' })).status).toBe(200);
    expect((await ok1.get('/api/auth/me')).data.company.name).toBe('Second Co');   // lands in the invited company
  });
});

// ─────────────────────────── 3. Helper "My day" ───────────────────────────
async function helperSetup(env = makeEnv()) {
  const { client: owner } = await registerCompany(env, 'Day Co');
  const j = await johnson(owner);
  const invite = async (helperId: string, email: string) => {
    const inv = await owner.post('/api/invitations', { email, full_name: 'Helper', role: 'helper', helper_id: helperId });
    const c = new Client(env);
    expect((await c.post('/api/invitations/accept', { token: tokenOf(inv.data.link), password: 'Welcome2Team!x' })).status).toBe(200);
    return c;
  };
  const maria = await invite(j.mariaId, 'maria@example.com');
  const ana = await invite(j.anaId, 'ana@example.com');
  return { env, owner, j, maria, ana };
}

describe('Helper "My day"', () => {
  it('shows only the helper\'s own appointments; access codes only for today/tomorrow and audited', async () => {
    const { owner, j, maria, ana } = await helperSetup();
    await owner.put(`/api/properties/${j.propertyId}/access`, { instructions: 'Gate code 4321' });
    const today = localToday();
    const mine = await owner.post('/api/appointments', { property_id: j.propertyId, date: today, start_time: '09:00', helpers: [{ helper_id: j.mariaId }] });
    const hers = await owner.post('/api/appointments', { property_id: j.propertyId, date: today, start_time: '14:00', helpers: [{ helper_id: j.anaId }] });
    const far = await owner.post('/api/appointments', { property_id: j.propertyId, date: addDays(today, 5), start_time: '09:00', helpers: [{ helper_id: j.mariaId }] });
    expect([mine, hers, far].map((x) => x.status)).toEqual([201, 201, 201]);

    const day = (await maria.get('/api/my-day')).data;
    expect(day.items.map((i: any) => i.id)).toEqual([mine.data.id]);
    expect(day.items[0]).toMatchObject({ property_name: 'Johnson Residence', street: '12 Peachtree St', access_instructions: 'Gate code 4321' });
    expect(day.items[0].customer_name).toBe('Robert Johnson');
    expect(JSON.stringify(day)).not.toContain('+14045550100');          // customer phone is not exposed to helpers
    expect((await ana.get('/api/my-day')).data.items.map((i: any) => i.id)).toEqual([hers.data.id]);
    const later = (await maria.get(`/api/my-day?date=${addDays(today, 5)}`)).data;
    expect(later.items).toHaveLength(1); expect(later.items[0].access_instructions).toBeNull();   // too far ahead for door codes
    expect(JSON.stringify((await owner.get('/api/audit')).data)).toContain('property_access');
    // staff accounts are not helpers
    expect((await owner.get('/api/my-day')).status).toBe(403);
    // a helper cannot act on another helper's appointment, nor on a future one
    expect((await maria.post(`/api/my-day/${hers.data.id}/finish`, {})).status).toBe(404);
    expect((await maria.post(`/api/my-day/${far.data.id}/start`, {})).status).toBe(409);
  });

  it('records completion for staff to confirm by default; finalizes automatically only when the company allows and all helpers reported', async () => {
    const { env, owner, j, maria, ana } = await helperSetup();
    const today = localToday();
    const a = await owner.post('/api/appointments', { property_id: j.propertyId, date: today, start_time: '09:00', helpers: [{ helper_id: j.mariaId }, { helper_id: j.anaId }] });
    expect((await maria.post(`/api/my-day/${a.data.id}/start`, {})).status).toBe(200);
    expect(env.DB.raw.prepare('SELECT status FROM cleaning_appointments WHERE id=?').get(a.data.id).status).toBe('in_progress');
    const f1 = await maria.post(`/api/my-day/${a.data.id}/finish`, { worked_minutes: 200 });
    expect(f1.data).toMatchObject({ ok: true, completed: false, waiting_for_helpers: 1 });
    await ana.post(`/api/my-day/${a.data.id}/finish`, {});
    // default company setting: helpers cannot finalize → still in progress, no money records yet
    expect(env.DB.raw.prepare('SELECT status FROM cleaning_appointments WHERE id=?').get(a.data.id).status).toBe('in_progress');
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM accounts_receivable').get().n).toBe(0);

    expect((await owner.put('/api/company', { helpers_can_complete: true })).status).toBe(200);
    const b = await owner.post('/api/appointments', { property_id: j.propertyId, date: today, start_time: '14:00', helpers: [{ helper_id: j.mariaId }, { helper_id: j.anaId }] });
    expect((await maria.post(`/api/my-day/${b.data.id}/finish`, { worked_minutes: 180 })).data.completed).toBe(false);   // Ana has not reported yet
    const last = await ana.post(`/api/my-day/${b.data.id}/finish`, {});
    expect(last.data.completed).toBe(true);
    expect(env.DB.raw.prepare('SELECT status FROM cleaning_appointments WHERE id=?').get(b.data.id).status).toBe('completed');
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM accounts_receivable WHERE appointment_id=?').get(b.data.id).n).toBe(1);
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM accounts_payable WHERE appointment_id=?').get(b.data.id).n).toBe(2);
    expect((await maria.post(`/api/my-day/${b.data.id}/finish`, {})).status).toBe(409);   // completed is final
  });
});

// ─────────────────────────── 4. Web Push ───────────────────────────
const b64 = (s: string) => Buffer.from(s, 'base64url');
/** Independent RFC 8291 decryptor written with node:crypto (not sharing code with the Worker). */
function decryptAes128gcm(body: Buffer, uaPrivRaw: Buffer, uaPubRaw: Buffer, authSecret: Buffer) {
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(uaPrivRaw);
  const secret = ecdh.computeSecret(asPub);
  const hk = (s: Buffer, ikm: Buffer, info: Buffer, len: number) => { const prk = createHmac('sha256', s).update(ikm).digest(); return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len); };
  const ikm = hk(authSecret, secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPubRaw, asPub]), 32);
  const cek = hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce = hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString('utf8');
}
function makeUa() {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = randomBytes(16);
  return { priv: ecdh.getPrivateKey(), pub: ecdh.getPublicKey(), auth, sub: (endpoint: string) => ({ endpoint, keys: { p256dh: b64uEncode(ecdh.getPublicKey()), auth: b64uEncode(auth) } }) };
}
async function vapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { VAPID_PUBLIC_KEY: b64uEncode(pub), VAPID_PRIVATE_KEY: jwk.d!, VAPID_SUBJECT: 'mailto:ops@example.com', pubKey: kp.publicKey };
}

describe('Web Push', () => {
  it('matches the RFC 8291 Appendix A test vector byte for byte', async () => {
    const asPub = b64uDecode('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    const jwk = { kty: 'EC', crv: 'P-256', d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', x: b64uEncode(asPub.slice(1, 33)), y: b64uEncode(asPub.slice(33, 65)), ext: true };
    const eph: CryptoKeyPair = {
      privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
    };
    const body = await encryptPayload(
      { endpoint: 'https://push.example/x', p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      new TextEncoder().encode('When I grow up, I want to be a watermelon'), { ephemeral: eph, salt: b64uDecode('DGv6ra1nlYgDCS1FRnbzlw') });
    expect(b64uEncode(body)).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });

  it('subscribes, notifies the assigned helper with a localized notice that holds no private data, and prunes dead subscriptions', async () => {
    const vapid = await vapidKeys();
    const env = Object.assign(makeEnv(), { VAPID_PUBLIC_KEY: vapid.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: vapid.VAPID_PRIVATE_KEY, VAPID_SUBJECT: vapid.VAPID_SUBJECT });
    const { owner, j, maria } = await helperSetup(env);
    expect((await maria.get('/api/push/config')).data.public_key).toBe(vapid.VAPID_PUBLIC_KEY);
    expect((await maria.post('/api/push/subscribe', { endpoint: 'http://insecure.example/x', keys: { p256dh: 'a', auth: 'b' } })).status).toBe(422);
    const ua = makeUa();
    const endpoint = 'https://push.example/send/abc123';
    expect((await maria.post('/api/push/subscribe', ua.sub(endpoint))).status).toBe(201);
    expect((await maria.post('/api/push/subscribe', ua.sub(endpoint))).status).toBe(201);   // idempotent per endpoint
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n).toBe(1);
    await maria.put('/api/auth/language', { language: 'pt' });

    const calls = stubFetch(() => new Response(null, { status: 201 }));
    const created = await owner.post('/api/appointments', { property_id: j.propertyId, date: addDays(localToday(), 2), start_time: '10:30', helpers: [{ helper_id: j.mariaId }] });
    expect(created.status).toBe(201);
    const push = calls.find((c) => c.url === endpoint)!;
    expect(push).toBeTruthy();
    const h = push.init.headers as Record<string, string>;
    expect(h['content-encoding']).toBe('aes128gcm');
    const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h.authorization)!;
    expect(k).toBe(vapid.VAPID_PUBLIC_KEY);
    const [jh, jp, js] = t.split('.');
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vapid.pubKey, b64uDecode(js), new TextEncoder().encode(`${jh}.${jp}`))).toBe(true);
    expect(JSON.parse(Buffer.from(jp, 'base64url').toString())).toMatchObject({ aud: 'https://push.example', sub: 'mailto:ops@example.com' });
    const text = decryptAes128gcm(push.init.body as unknown as Buffer, ua.priv, ua.pub, ua.auth);
    const msg = JSON.parse(text);
    expect(msg.title).toBe('Novo serviço agendado');            // helper's language
    expect(text).not.toMatch(/Peachtree|Johnson|4321|Robert/);   // no address, customer or access data in the payload
    expect(calls.filter((c) => c.url === endpoint)).toHaveLength(1);

    // expired subscription (410) is removed
    stubFetch(() => new Response(null, { status: 410 }));
    await owner.post('/api/appointments', { property_id: j.propertyId, date: addDays(localToday(), 3), start_time: '10:30', helpers: [{ helper_id: j.mariaId }] });
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n).toBe(0);
    // a push failure never breaks scheduling
    expect((await owner.post('/api/appointments', { property_id: j.propertyId, date: addDays(localToday(), 4), start_time: '10:30', helpers: [{ helper_id: j.mariaId }] })).status).toBe(201);
  });

  it('is simply off when VAPID keys are missing', async () => {
    const { maria } = await helperSetup();
    expect((await maria.get('/api/push/config')).data.public_key).toBeNull();
    expect((await maria.post('/api/push/test', {})).status).toBe(503);
  });
});

// ─────────────────────────── 5. Stripe ───────────────────────────
async function stripeSig(body: string, secret: string, t = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`))).toString('hex');
  return `t=${t},v1=${mac}`;
}
async function webhook(env: any, path: string, event: unknown, secret: string) {
  const body = JSON.stringify(event);
  const { handleApi } = await import('../worker/src/index');
  // Note: no x-requested-with header — webhooks are server-to-server and authenticated by signature.
  const res = await handleApi(new Request('https://app.test' + path, { method: 'POST', headers: { 'stripe-signature': await stripeSig(body, secret), 'content-type': 'application/json' }, body }), env);
  return { status: res.status, data: await res.json() as any };
}

describe('Stripe', () => {
  it('verifies webhook signatures (valid, tampered, stale, missing)', async () => {
    const body = '{"id":"evt_1"}';
    const good = await stripeSig(body, PLATFORM_SIG);
    expect(await verifyStripeSignature(body, good, PLATFORM_SIG)).toBe(true);
    expect(await verifyStripeSignature(body + ' ', good, PLATFORM_SIG)).toBe(false);
    expect(await verifyStripeSignature(body, good, WRONG_SIG)).toBe(false);
    expect(await verifyStripeSignature(body, await stripeSig(body, PLATFORM_SIG, Math.floor(Date.now() / 1000) - 3600), PLATFORM_SIG)).toBe(false);
    expect(await verifyStripeSignature(body, null, PLATFORM_SIG)).toBe(false);
    expect(await verifyStripeSignature(body, 't=abc,v1=00', PLATFORM_SIG)).toBe(false);
  });

  it('plan checkout: only owner/admin, creates the Stripe price once, and the signed webhook activates the plan idempotently', async () => {
    const env: any = makeEnv();
    env.STRIPE_SECRET_KEY = PLATFORM_KEY; env.STRIPE_WEBHOOK_SECRET = PLATFORM_SIG;
    const { owner } = await helperSetup(env);
    const sched = new Client(env);
    const inv = await owner.post('/api/invitations', { email: 's@example.com', full_name: 'S', role: 'scheduler' });
    await sched.post('/api/invitations/accept', { token: tokenOf(inv.data.link), password: 'Welcome2Team!x' });
    env.DB.raw.prepare("INSERT INTO subscription_plans (id,name,price_cents,max_users,created_at) VALUES ('pro','Pro',4900,10,'2026-01-01')").run();

    const calls = stubFetch((c) => c.url.endsWith('/products') ? ok({ id: 'prod_1' }) : c.url.endsWith('/prices') ? ok({ id: 'price_1' }) : ok({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }));
    expect((await sched.post('/api/billing/checkout', { plan_id: 'pro' })).status).toBe(403);
    const r1 = await owner.post('/api/billing/checkout', { plan_id: 'pro' });
    expect(r1.data.url).toBe('https://checkout.stripe.com/c/pay/cs_1');
    const price = new URLSearchParams(calls.find((c) => c.url.endsWith('/prices'))!.body);
    expect(price.get('unit_amount')).toBe('4900'); expect(price.get('currency')).toBe('usd'); expect(price.get('recurring[interval]')).toBe('month');
    const cs = new URLSearchParams(calls.find((c) => c.url.endsWith('/checkout/sessions'))!.body);
    const companyId = env.DB.raw.prepare("SELECT id FROM companies WHERE name='Day Co'").get().id;
    expect(cs.get('mode')).toBe('subscription'); expect(cs.get('line_items[0][price]')).toBe('price_1'); expect(cs.get('metadata[company_id]')).toBe(companyId);
    expect((calls[0].init.headers as any).authorization).toBe(`Bearer ${PLATFORM_KEY}`);
    calls.length = 0;
    await owner.post('/api/billing/checkout', { plan_id: 'pro' });
    expect(calls.filter((c) => c.url.endsWith('/prices'))).toHaveLength(0);   // price is reused

    const ev = { id: 'evt_a', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: companyId, customer: 'cus_1', subscription: 'sub_1', metadata: { company_id: companyId, plan_id: 'pro' } } } };
    expect((await webhook(env, '/api/stripe/webhook', ev, WRONG_SIG)).status).toBe(400);
    expect(env.DB.raw.prepare('SELECT subscription_status s FROM companies WHERE id=?').get(companyId).s).toBe('trial');
    expect((await webhook(env, '/api/stripe/webhook', ev, PLATFORM_SIG)).status).toBe(200);
    expect(env.DB.raw.prepare('SELECT subscription_status s, plan_id p, stripe_subscription_id sub FROM companies WHERE id=?').get(companyId)).toMatchObject({ s: 'active', p: 'pro', sub: 'sub_1' });
    expect((await webhook(env, '/api/stripe/webhook', ev, PLATFORM_SIG)).data.duplicate).toBe(true);
    await webhook(env, '/api/stripe/webhook', { id: 'evt_b', type: 'invoice.payment_failed', data: { object: { subscription: 'sub_1' } } }, PLATFORM_SIG);
    expect(env.DB.raw.prepare('SELECT subscription_status s FROM companies WHERE id=?').get(companyId).s).toBe('past_due');
    await webhook(env, '/api/stripe/webhook', { id: 'evt_c', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled' } } }, PLATFORM_SIG);
    expect(env.DB.raw.prepare('SELECT subscription_status s FROM companies WHERE id=?').get(companyId).s).toBe('canceled');
  });

  it('customer payment link uses the company\'s own encrypted key and records the receipt once, from a signed webhook', async () => {
    const env: any = makeEnv();
    const { owner, j } = await helperSetup(env);
    const companyId = env.DB.raw.prepare("SELECT id FROM companies WHERE name='Day Co'").get().id;
    expect((await owner.put('/api/payments/settings', { stripe_secret_key: 'not-a-key' })).status).toBe(422);
    expect((await owner.put('/api/payments/settings', { stripe_secret_key: COMPANY_KEY, stripe_webhook_secret: COMPANY_SIG })).status).toBe(200);
    const settings = (await owner.get('/api/payments/settings')).data;
    expect(settings).toMatchObject({ stripe_configured: true, webhook_secret_configured: true, webhook_url: `https://app.test/api/stripe/webhook/${companyId}` });
    expect(JSON.stringify(settings)).not.toContain(COMPANY_KEY);
    expect(JSON.stringify(env.DB.raw.prepare('SELECT * FROM company_payment_settings').all())).not.toContain(COMPANY_KEY);   // encrypted at rest
    expect(JSON.stringify((await owner.get('/api/audit')).data)).not.toContain(COMPANY_KEY);

    // a completed appointment creates the receivable
    const a = await owner.post('/api/appointments', { property_id: j.propertyId, date: localToday(), start_time: '09:00', helpers: [{ helper_id: j.mariaId }] });
    expect((await owner.post(`/api/appointments/${a.data.id}/status`, { status: 'completed' })).status).toBe(200);
    const ar = env.DB.raw.prepare('SELECT * FROM accounts_receivable').get();
    const calls = stubFetch(() => ok({ id: 'cs_live_1', url: 'https://checkout.stripe.com/c/pay/cs_live_1' }));
    const link = await owner.post(`/api/finance/receivables/${ar.id}/payment-link`, {});
    expect(link.status).toBe(201); expect(link.data.amount_cents).toBe(ar.amount_cents);
    const q = new URLSearchParams(calls[0].body);
    expect((calls[0].init.headers as any).authorization).toBe(`Bearer ${COMPANY_KEY}`);   // company's key, not the platform's
    expect(q.get('mode')).toBe('payment'); expect(q.get('line_items[0][price_data][unit_amount]')).toBe(String(ar.amount_cents));
    expect(q.get('metadata[receivable_id]')).toBe(ar.id); expect(q.get('customer_email')).toBe('rj@example.com');
    expect(calls[0].body).not.toMatch(/Peachtree/);   // no street address sent to Stripe

    const ev = { id: 'evt_pay1', type: 'checkout.session.completed', data: { object: { id: 'cs_live_1', payment_status: 'paid', amount_total: ar.amount_cents, metadata: { company_id: companyId, receivable_id: ar.id } } } };
    const path = `/api/stripe/webhook/${companyId}`;
    expect((await webhook(env, path, ev, PLATFORM_SIG)).status).toBe(400);   // not the company's secret
    expect((await webhook(env, '/api/stripe/webhook/00000000-no-such-company', ev, COMPANY_SIG)).status).toBe(400);
    expect((await webhook(env, path, { ...ev, id: 'evt_x', data: { object: { ...ev.data.object, metadata: { company_id: 'someone-else', receivable_id: ar.id } } } }, COMPANY_SIG)).status).toBe(400);
    expect(env.DB.raw.prepare('SELECT COUNT(*) n FROM receipts').get().n).toBe(0);
    expect((await webhook(env, path, ev, COMPANY_SIG)).status).toBe(200);
    // same payment delivered again (new event id, same session) must not double-count
    await webhook(env, path, { ...ev, id: 'evt_pay1_retry' }, COMPANY_SIG);
    expect((await webhook(env, path, ev, COMPANY_SIG)).data.duplicate).toBe(true);
    const receipts = env.DB.raw.prepare('SELECT * FROM receipts').all();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ amount_cents: ar.amount_cents, kind: 'receipt', method: 'credit_card_manual', receivable_id: ar.id });
    expect(env.DB.raw.prepare('SELECT status FROM accounts_receivable WHERE id=?').get(ar.id).status).toBe('paid');
    expect(env.DB.raw.prepare('SELECT status FROM payment_links').get().status).toBe('paid');
    // nothing left to collect
    expect((await owner.post(`/api/finance/receivables/${ar.id}/payment-link`, {})).status).toBe(409);
  });

  it('refuses payment links when the company has no Stripe key, and other tenants cannot use another company\'s receivable', async () => {
    const env: any = makeEnv();
    const { owner, j } = await helperSetup(env);
    const { client: other } = await registerCompany(env, 'Other Co');
    const a = await owner.post('/api/appointments', { property_id: j.propertyId, date: localToday(), start_time: '09:00', helpers: [{ helper_id: j.mariaId }] });
    await owner.post(`/api/appointments/${a.data.id}/status`, { status: 'completed' });
    const ar = env.DB.raw.prepare('SELECT id FROM accounts_receivable').get();
    expect((await owner.post(`/api/finance/receivables/${ar.id}/payment-link`, {})).status).toBe(503);
    await other.put('/api/payments/settings', { stripe_secret_key: OTHER_KEY });
    expect((await other.post(`/api/finance/receivables/${ar.id}/payment-link`, {})).status).toBe(404);
  });
});

// ─────────────────────────── 6. Reminders ───────────────────────────
describe('24-hour reminders', () => {
  const NOW_IN_WINDOW = new Date('2030-06-14T14:00:00Z');     // 10:00 New York, appointment is 2030-06-15 09:00 → inside 24 h
  async function reminderSetup(envExtra: Record<string, string> = {}) {
    const env: any = Object.assign(makeEnv(), envExtra);
    const { client: owner } = await registerCompany(env, 'Remind Co');
    const j = await johnson(owner);
    const appt = await owner.post('/api/appointments', { property_id: j.propertyId, date: '2030-06-15', start_time: '09:00', helpers: [{ helper_id: j.mariaId }] });
    return { env, owner, j, appt };
  }
  const smsEnv = { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: fake('tw_'), TWILIO_FROM: '+15005550006' };

  it('computes the local window and phone normalization correctly', () => {
    expect(localStamp('America/New_York', NOW_IN_WINDOW)).toBe('2030-06-14 10:00');
    expect(toE164('(404) 555-0100')).toBe('+14045550100'); expect(toE164('1-404-555-0100')).toBe('+14045550100');
    expect(toE164('+55 11 91234-5678')).toBe('+5511912345678'); expect(toE164('12345')).toBeNull(); expect(toE164(null)).toBeNull();
  });

  it('sends one SMS to opted-in customers inside the 24 h window, never twice, never outside it, and without private details', async () => {
    const { env, owner, j, appt } = await reminderSetup(smsEnv);
    const calls = stubFetch(() => ok({ sid: 'SM1' }, 201));
    expect(await sendDueReminders(env, NOW_IN_WINDOW)).toEqual({ sent: 0, failed: 0 });   // channel is off by default
    await owner.put('/api/company', { reminder_channel: 'sms' });
    expect(await sendDueReminders(env, NOW_IN_WINDOW)).toEqual({ sent: 0, failed: 0 });   // customer has not opted in
    await owner.put(`/api/customers/${j.customerId}`, { reminder_opt_in: true });
    expect(await sendDueReminders(env, new Date('2030-06-14T12:00:00Z'))).toEqual({ sent: 0, failed: 0 });   // 08:00 local: too early
    expect(await sendDueReminders(env, new Date('2030-06-15T14:00:00Z'))).toEqual({ sent: 0, failed: 0 });   // after the start: too late
    expect(calls).toHaveLength(0);

    expect(await sendDueReminders(env, NOW_IN_WINDOW)).toEqual({ sent: 1, failed: 0 });
    expect(await sendDueReminders(env, NOW_IN_WINDOW)).toEqual({ sent: 0, failed: 0 });        // idempotent
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect((calls[0].init.headers as any).authorization).toBe('Basic ' + Buffer.from(`AC123:${smsEnv.TWILIO_AUTH_TOKEN}`).toString('base64'));
    const form = new URLSearchParams(calls[0].body);
    expect(form.get('To')).toBe('+14045550100'); expect(form.get('From')).toBe('+15005550006');
    expect(form.get('Body')).toContain('Remind Co'); expect(form.get('Body')).toContain('2030-06-15'); expect(form.get('Body')).toContain('STOP');
    expect(form.get('Body')).not.toMatch(/Peachtree|Johnson|4321/);

    // canceled appointments are never reminded
    const appt2 = await owner.post('/api/appointments', { property_id: j.propertyId, date: '2030-06-15', start_time: '11:00', helpers: [] });
    await owner.post(`/api/appointments/${appt2.data.id}/status`, { status: 'canceled' });
    expect(await sendDueReminders(env, NOW_IN_WINDOW)).toEqual({ sent: 0, failed: 0 });
    expect(appt.status).toBe(201);
  });

  it('retries failures up to 3 times and gives up on invalid phone numbers', async () => {
    const { env, owner, j } = await reminderSetup(smsEnv);
    await owner.put('/api/company', { reminder_channel: 'sms' });
    await owner.put(`/api/customers/${j.customerId}`, { reminder_opt_in: true });
    const calls = stubFetch(() => ok({ code: 21211, message: 'Invalid To number' }, 400));
    const results: { sent: number; failed: number }[] = [];
    for (let i = 0; i < 5; i++) results.push(await sendDueReminders(env, NOW_IN_WINDOW));
    expect(results.map((r) => r.failed)).toEqual([1, 1, 1, 0, 0]);
    expect(calls).toHaveLength(3);
    expect(env.DB.raw.prepare('SELECT status, attempts FROM appointment_reminders').get()).toMatchObject({ status: 'failed', attempts: 3 });

    const { env: env2, owner: o2, j: j2 } = await reminderSetup(smsEnv);
    await o2.put('/api/company', { reminder_channel: 'sms' });
    await o2.put(`/api/customers/${j2.customerId}`, { reminder_opt_in: true, phone: '12345', whatsapp: null });
    const calls2 = stubFetch(() => ok({ sid: 'x' }, 201));
    expect(await sendDueReminders(env2, NOW_IN_WINDOW)).toEqual({ sent: 0, failed: 1 });
    expect(await sendDueReminders(env2, NOW_IN_WINDOW)).toEqual({ sent: 0, failed: 0 });
    expect(calls2).toHaveLength(0);
  });

  it('WhatsApp reminders use the approved template in the customer\'s language and need company opt-in', async () => {
    const { env, owner, j } = await reminderSetup({ WHATSAPP_TOKEN: fake('wa_'), WHATSAPP_PHONE_NUMBER_ID: '999', WHATSAPP_REMINDER_TEMPLATE: 'appointment_reminder_24h' });
    await owner.put('/api/company', { reminder_channel: 'whatsapp' });
    await owner.put(`/api/customers/${j.customerId}`, { reminder_opt_in: true, language: 'pt' });
    const calls = stubFetch(() => ok({ messages: [{ id: 'wamid.1' }] }));
    expect(await sendDueReminders(env, NOW_IN_WINDOW)).toEqual({ sent: 0, failed: 0 });   // company has not enabled WhatsApp
    await owner.put('/api/company', { whatsapp_enabled: true });
    expect(await sendDueReminders(env, NOW_IN_WINDOW)).toEqual({ sent: 1, failed: 0 });
    const b = JSON.parse(calls[0].body);
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/999/messages');
    expect(b).toMatchObject({ type: 'template', to: '14045550100', template: { name: 'appointment_reminder_24h', language: { code: 'pt_BR' } } });
    expect(b.template.components[0].parameters.map((p: any) => p.text)).toEqual(['Robert', '2030-06-15', '09:00', 'Remind Co']);
  });
});

describe('Round 4 housekeeping', () => {
  it('exposes feature availability to the UI', async () => {
    const env: any = makeEnv();
    env.RESEND_API_KEY = RESEND_KEY; env.MAIL_FROM = 'a@b.c'; env.STRIPE_SECRET_KEY = PLATFORM_KEY;
    const { client } = await registerCompany(env, 'Flags Co');
    const cfg = (await client.get('/api/auth/me')).data.config;
    expect(cfg).toMatchObject({ email_available: true, billing_available: true, push_available: false, sms_available: false, whatsapp_reminders_available: false });
    expect(isoDay(0)).toMatch(/^\d{4}/);
  });
});
