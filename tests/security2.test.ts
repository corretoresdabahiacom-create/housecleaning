import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, isoDay, johnson, makeEnv, registerCompany } from './harness';
import { totp, base32Decode, base32Encode, rotateEncryptedData } from '../worker/src/lib/security';
import { purgeDeletedCompanies } from '../worker/src/modules/maintenance';

afterEach(() => vi.unstubAllGlobals());

describe('TOTP', () => {
  it('matches RFC 6238 SHA-1 test vectors', async () => {
    const secret = base32Encode(new TextEncoder().encode('12345678901234567890'));
    expect(await totp(secret, Math.floor(59 / 30))).toBe('287082');          // RFC: 94287082
    expect(await totp(secret, Math.floor(1111111109 / 30))).toBe('081804');  // RFC: 07081804
    expect(await totp(secret, Math.floor(20000000000 / 30))).toBe('353130'); // RFC: 65353130
    expect(new TextDecoder().decode(base32Decode(secret))).toBe('12345678901234567890');
  });
});

describe('MFA login flow', () => {
  it('setup → enable → login requires TOTP; replay rejected; recovery code works once; disable', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const email = (env.DB.raw.prepare('SELECT email FROM users').get() as any).email;
    const setup = await c.post('/api/auth/mfa/setup');
    expect(setup.data.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
    const raw: any = env.DB.raw.prepare('SELECT mfa_secret_enc FROM users').get();
    expect(raw.mfa_secret_enc).not.toContain(setup.data.secret); // encrypted at rest
    expect((await c.post('/api/auth/mfa/enable', { code: '000000' })).status).toBe(401);
    const step = Math.floor(Date.now() / 30000);
    const en = await c.post('/api/auth/mfa/enable', { code: await totp(setup.data.secret, step) });
    expect(en.data.recovery_codes).toHaveLength(8);
    expect((await c.get('/api/auth/me')).data.user.mfa_enabled).toBe(1);

    const d = new Client(env);
    const l1 = await d.post('/api/auth/login', { email, password: 'Sup3rSecret!pw' });
    expect(l1.data.mfa_required).toBe(true);
    expect((await d.get('/api/auth/me')).status).toBe(401); // no session yet
    // same step as enable → replay rejected
    expect((await d.post('/api/auth/mfa/verify', { mfa_token: l1.data.mfa_token, code: await totp(setup.data.secret, step) })).status).toBe(401);
    const ok = await d.post('/api/auth/mfa/verify', { mfa_token: l1.data.mfa_token, code: await totp(setup.data.secret, step + 1) });
    expect(ok.status).toBe(200);
    expect((await d.get('/api/auth/me')).status).toBe(200);
    // challenge token is single-use
    expect((await new Client(env).post('/api/auth/mfa/verify', { mfa_token: l1.data.mfa_token, code: '123456' })).status).toBe(400);

    const e = new Client(env);
    const l2 = await e.post('/api/auth/login', { email, password: 'Sup3rSecret!pw' });
    const rc = en.data.recovery_codes[0];
    expect((await e.post('/api/auth/mfa/verify', { mfa_token: l2.data.mfa_token, code: rc })).status).toBe(200);
    const f = new Client(env);
    const l3 = await f.post('/api/auth/login', { email, password: 'Sup3rSecret!pw' });
    expect((await f.post('/api/auth/mfa/verify', { mfa_token: l3.data.mfa_token, code: rc })).status).toBe(401); // used
    // brute force capped at 5 attempts per challenge
    for (let i = 0; i < 5; i++) await f.post('/api/auth/mfa/verify', { mfa_token: l3.data.mfa_token, code: '111111' });
    expect((await f.post('/api/auth/mfa/verify', { mfa_token: l3.data.mfa_token, code: await totp(setup.data.secret, step + 2) })).status).toBe(400);

    expect((await c.post('/api/auth/mfa/disable', { password: 'wrong-password-1' })).status).toBe(401);
    expect((await c.post('/api/auth/mfa/disable', { password: 'Sup3rSecret!pw' })).status).toBe(200);
    expect((await new Client(env).post('/api/auth/login', { email, password: 'Sup3rSecret!pw' })).data.ok).toBe(true);
  });
});

describe('Turnstile', () => {
  it('is enforced on login and register only when configured', async () => {
    const env = makeEnv();
    await registerCompany(env);
    const email = (env.DB.raw.prepare('SELECT email FROM users').get() as any).email;
    (env as any).TURNSTILE_SECRET = 'test-secret';
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: any) => { calls.push({ url, token: init.body.get('response') }); return new Response(JSON.stringify({ success: init.body.get('response') === 'good' })); });
    const c = new Client(env);
    expect((await c.post('/api/auth/login', { email, password: 'Sup3rSecret!pw' })).data.error).toBe('captcha_required');
    expect((await c.post('/api/auth/login', { email, password: 'Sup3rSecret!pw', turnstile_token: 'bad' })).data.error).toBe('captcha_failed');
    expect((await c.post('/api/auth/login', { email, password: 'Sup3rSecret!pw', turnstile_token: 'good' })).status).toBe(200);
    expect(calls[0].url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect((await new Client(env).post('/api/auth/register', { full_name: 'X', company_name: 'Y', email: 'n@x.com', password: 'L0ngEnoughPass', state: 'GA', city: 'A', accept_terms: true })).data.error).toBe('captcha_required');
  });
});

describe('company deletion purge', () => {
  it('keeps data during retention, then purges everything including files; other tenants untouched', async () => {
    const env = makeEnv();
    const A = await registerCompany(env, 'Going away');
    const B = await registerCompany(env, 'Staying');
    const j = await johnson(A.client);
    await johnson(B.client);
    await A.client.put(`/api/properties/${j.propertyId}/access`, { instructions: 'gate 1' });
    const a = await A.client.post('/api/appointments', { property_id: j.propertyId, date: isoDay(-1), start_time: '09:00' });
    await A.client.post(`/api/appointments/${a.data.id}/status`, { status: 'completed' });
    const conv = await A.client.post('/api/conversations', { helper_id: j.mariaId });
    const fd = new FormData(); fd.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])], 'a.png'));
    await A.client.req('POST', `/api/conversations/${conv.data.id}/messages`, fd);
    const pf = new FormData(); pf.set('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 1])], 'p.jpg'));
    await A.client.req('POST', `/api/properties/${j.propertyId}/photos`, pf);
    expect(env.FILES.store.size).toBe(2);

    expect((await A.client.post('/api/company/delete', { password: 'Sup3rSecret!pw' })).data.purge_after_days).toBe(30);
    expect((await A.client.get('/api/auth/me')).status).toBe(401);
    expect(await purgeDeletedCompanies(env)).toBe(0); // within retention
    const count = (t: string, id: string) => (env.DB.raw.prepare(`SELECT COUNT(*) n FROM ${t} WHERE company_id=?`).get(id) as any).n;
    expect(count('customers', A.companyId)).toBe(1);

    expect(await purgeDeletedCompanies(env, Date.now() + 31 * 864e5)).toBe(1);
    for (const t of ['customers', 'residential_properties', 'helper_records', 'cleaning_appointments', 'accounts_receivable', 'accounts_payable', 'messages', 'property_access_instructions', 'property_photos', 'company_members', 'user_sessions'])
      expect(count(t, A.companyId)).toBe(0);
    expect(env.FILES.store.size).toBe(0);
    expect((env.DB.raw.prepare('SELECT COUNT(*) n FROM users WHERE id=?').get(A.userId) as any).n).toBe(0);
    expect((env.DB.raw.prepare('SELECT name, purged_at FROM companies WHERE id=?').get(A.companyId) as any).name).toBe('[purged]');
    expect(count('customers', B.companyId)).toBe(1);
    expect((await B.client.get('/api/customers')).data.total).toBe(1);
    expect(await purgeDeletedCompanies(env, Date.now() + 40 * 864e5)).toBe(0); // idempotent
  });
});

describe('encryption key rotation', () => {
  it('reads old data with the previous key and re-encrypts everything to the new version', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const j = await johnson(c);
    await c.put(`/api/properties/${j.propertyId}/access`, { instructions: 'Key under the mat' });
    await c.post('/api/auth/mfa/setup');
    const oldKey = env.ENCRYPTION_KEY;
    // deploy new key v2, keep v1 as previous
    Object.assign(env, { ENCRYPTION_KEY_PREVIOUS: oldKey, ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), ENCRYPTION_KEY_VERSION: '2' });
    expect((await c.get(`/api/properties/${j.propertyId}/access`)).data.instructions).toBe('Key under the mat');
    expect(await rotateEncryptedData(env)).toBe(2);
    expect((env.DB.raw.prepare('SELECT key_version FROM property_access_instructions').get() as any).key_version).toBe(2);
    expect(await rotateEncryptedData(env)).toBe(0);
    delete (env as any).ENCRYPTION_KEY_PREVIOUS; // old key retired
    expect((await c.get(`/api/properties/${j.propertyId}/access`)).data.instructions).toBe('Key under the mat');
  });
});

describe('company time zone', () => {
  it('validates and stores the IANA time zone (owner only)', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    expect((await c.put('/api/company', { timezone: 'Mars/Olympus' })).status).toBe(422);
    expect((await c.put('/api/company', { timezone: 'America/Los_Angeles' })).status).toBe(200);
    expect((await c.get('/api/auth/me')).data.company.timezone).toBe('America/Los_Angeles');
    await c.post('/api/members', { email: 's@x.com', full_name: 'S', role: 'scheduler', temporary_password: 'Sched123!pw' });
    const s = new Client(env); await s.post('/api/auth/login', { email: 's@x.com', password: 'Sched123!pw' });
    expect((await s.put('/api/company', { timezone: 'America/Chicago' })).status).toBe(403);
  });
});
