import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, isoDay, johnson, makeEnv, registerCompany } from './harness';
import { kvStorage } from '../worker/src/lib/storage';
import { _resetFirebaseKeyCache } from '../worker/src/lib/firebase';
import { totp } from '../worker/src/lib/security';

const PROJECT = 'housecleaning-b528b';
let priv: CryptoKey, jwk: JsonWebKey;
const b64u = (b: ArrayBuffer | Uint8Array | string) => Buffer.from(typeof b === 'string' ? b : new Uint8Array(b as ArrayBuffer)).toString('base64url');

beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  priv = kp.privateKey; jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
});
afterEach(() => { vi.unstubAllGlobals(); _resetFirebaseKeyCache(); });

async function idToken(claims: Record<string, unknown> = {}, kid = 'k1', key = priv) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'google-uid-1', auth_time: now, iat: now, exp: now + 3600,
    email: 'maria.owner@gmail.com', email_verified: true, name: 'Maria Owner', firebase: { sign_in_provider: 'google.com' }, ...claims }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}
function stubJwks() {
  vi.stubGlobal('fetch', async (url: string) => {
    expect(url).toBe('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }), { headers: { 'cache-control': 'public, max-age=3600' } });
  });
}
const firebaseEnv = () => Object.assign(makeEnv(), { FIREBASE_PROJECT_ID: PROJECT, FIREBASE_API_KEY: 'AIza-test' });

describe('Sign in with Google (Firebase Auth)', () => {
  it('rejects tokens with wrong signature, audience, issuer, expiry or unverified email', async () => {
    stubJwks();
    const env = firebaseEnv();
    const c = new Client(env);
    const other = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair).privateKey;
    const bad = [
      await idToken({}, 'k1', other), await idToken({ aud: 'someone-else' }), await idToken({ iss: 'https://evil.example' }),
      await idToken({ exp: Math.floor(Date.now() / 1000) - 10 }), await idToken({}, 'unknown-kid'), 'not.a.jwt', 'abc',
    ];
    for (const t of bad) expect((await c.post('/api/auth/google', { id_token: t })).data.error).toBe('invalid_google_token');
    expect((await c.post('/api/auth/google', { id_token: await idToken({ email_verified: false }) })).data.error).toBe('google_email_not_verified');
  });

  it('registers with Google (verified, no password), then logs in with Google; links existing email accounts; respects MFA', async () => {
    stubJwks();
    const env = firebaseEnv();
    const c = new Client(env);
    expect((await c.get('/api/auth/config')).data.firebase).toEqual({ apiKey: 'AIza-test', authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT });
    const unknown = await c.post('/api/auth/google', { id_token: await idToken() });
    expect(unknown.status).toBe(404); expect(unknown.data.details).toEqual({ email: 'maria.owner@gmail.com', name: 'Maria Owner' });
    const reg = { full_name: 'Maria Owner', company_name: 'Maria Cleaning', email: 'maria.owner@gmail.com', state: 'FL', city: 'Orlando', accept_terms: true };
    expect((await c.post('/api/auth/register', { ...reg, email: 'other@gmail.com', google_id_token: await idToken() })).status).toBe(422); // email must match token
    const r = await c.post('/api/auth/register', { ...reg, google_id_token: await idToken() });
    expect(r.status).toBe(201); expect(r.data.dev_token).toBeUndefined();
    expect((await c.get('/api/auth/me')).data.user.email_verified_at).not.toBeNull();
    const d = new Client(env);
    expect((await d.post('/api/auth/google', { id_token: await idToken() })).data.ok).toBe(true);
    expect((await d.get('/api/auth/me')).data.company.name).toBe('Maria Cleaning');
    // existing password account is linked by verified email on first Google sign-in
    const A = await registerCompany(env, 'Password Co');
    const email = (env.DB.raw.prepare('SELECT email FROM users WHERE id=?').get(A.userId) as any).email;
    const g2 = new Client(env);
    expect((await g2.post('/api/auth/google', { id_token: await idToken({ sub: 'google-uid-2', email }) })).data.ok).toBe(true);
    expect((env.DB.raw.prepare('SELECT google_uid FROM users WHERE id=?').get(A.userId) as any).google_uid).toBe('google-uid-2');
    // a different Google account cannot take over an already-linked user
    expect((await new Client(env).post('/api/auth/google', { id_token: await idToken({ sub: 'attacker', email }) })).data.error).toBe('google_account_mismatch');
    // MFA still required after Google
    const setup = await A.client.post('/api/auth/mfa/setup');
    await A.client.post('/api/auth/mfa/enable', { code: await totp(setup.data.secret, Math.floor(Date.now() / 30000)) });
    const g3 = new Client(env);
    const res = await g3.post('/api/auth/google', { id_token: await idToken({ sub: 'google-uid-2', email }) });
    expect(res.data.mfa_required).toBe(true); expect((await g3.get('/api/auth/me')).status).toBe(401);
  });

  it('is disabled when Firebase is not configured', async () => {
    const env = makeEnv();
    expect((await new Client(env).post('/api/auth/google', { id_token: 'x.y.z' })).data.error).toBe('google_login_not_configured');
    expect((await new Client(env).get('/api/auth/config')).data.firebase).toBeNull();
  });
});

describe('Workers KV storage fallback (no R2)', () => {
  function fakeKv() {
    const m = new Map<string, { v: Uint8Array; ttl?: number }>();
    return { m, put: async (k: string, v: any, o?: any) => { m.set(k, { v: new Uint8Array(v), ttl: o?.expirationTtl }); }, get: async (k: string) => (m.has(k) ? m.get(k)!.v.slice().buffer : null), delete: async (k: string) => { m.delete(k); } };
  }
  it('adapter stores, reads, deletes; message attachments get a TTL backstop', async () => {
    const kv = fakeKv(); const s = kvStorage(kv as any);
    await s.put('photos/a', new Uint8Array([1, 2, 3])); await s.put('msg/x', new Uint8Array([4]));
    expect(kv.m.get('photos/a')!.ttl).toBeUndefined(); expect(kv.m.get('msg/x')!.ttl).toBe(26 * 3600);
    expect([...new Uint8Array(await (await s.get('photos/a'))!.arrayBuffer())]).toEqual([1, 2, 3]);
    await s.delete(['photos/a', 'msg/x']); expect(kv.m.size).toBe(0);
  });
  it('photos work end-to-end through the API with only FILES_KV bound', async () => {
    const env: any = makeEnv(); const kv = fakeKv(); delete env.FILES; env.FILES_KV = kv;
    const { client: c } = await registerCompany(env);
    const j = await johnson(c);
    const fd = new FormData(); fd.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9])], 'p.png'));
    const up = await c.req('POST', `/api/properties/${j.propertyId}/photos`, fd);
    expect(up.status).toBe(201); expect(kv.m.size).toBe(1);
    expect((await c.get(`/api/photos/${up.data.id}`)).status).toBe(200);
  });
});

describe('expense attachments and audit log', () => {
  it('attaches a receipt to an expense; tenant-scoped; replaced file is deleted; audit log visible to owner only', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const cat = (await c.get('/api/finance/categories')).data.items.find((x: any) => x.name === 'Fuel');
    const ex = await c.post('/api/finance/expenses', { description: 'Gas', category_id: cat.id, amount: '40', expense_date: isoDay(0) });
    const id = ex.data.ids[0];
    const pdf = new FormData(); pdf.set('file', new File([new TextEncoder().encode('%PDF-1.4 receipt')], 'receipt.pdf'));
    expect((await c.req('POST', `/api/finance/payables/${id}/attachment`, pdf)).status).toBe(201);
    const got = await c.get(`/api/finance/payables/${id}/attachment`);
    expect(got.status).toBe(200); expect(got.headers.get('content-type')).toBe('application/pdf');
    const img = new FormData(); img.set('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 1])], 'r.jpg'));
    await c.req('POST', `/api/finance/payables/${id}/attachment`, img);
    expect(env.FILES.store.size).toBe(1); // old file removed
    const txt = new FormData(); txt.set('file', new File([new TextEncoder().encode('hello')], 'x.txt'));
    expect((await c.req('POST', `/api/finance/payables/${id}/attachment`, txt)).status).toBe(415);
    const other = await registerCompany(env, 'Other');
    expect((await other.client.get(`/api/finance/payables/${id}/attachment`)).status).toBe(404);
    const log = (await c.get('/api/audit')).data.items;
    expect(log.map((x: any) => x.action)).toEqual(expect.arrayContaining(['register', 'create', 'attach']));
    expect(log.every((x: any) => !String(x.details || '').includes('PDF'))).toBe(true);
    await c.post('/api/members', { email: 'f@x.com', full_name: 'F', role: 'finance', temporary_password: 'Financ3!pass' });
    const f = new Client(env); await f.post('/api/auth/login', { email: 'f@x.com', password: 'Financ3!pass' });
    expect((await f.get('/api/audit')).status).toBe(403);
    expect((await other.client.get('/api/audit')).data.items.every((x: any) => x.entity_id !== id)).toBe(true);
  });
});

describe('localized exports', () => {
  it('translates column headers and titles in CSV/PDF for PT and ES; values untouched', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    await johnson(c);
    const csv = (await c.get('/api/reports/properties?format=csv&lang=pt')).data as string;
    expect(csv.split('\n')[0]).toBe('Nome,Cliente,Endereço,Unidade,Cidade,Estado,ZIP,Frequência,Preço,Status');
    expect(csv).toContain('Johnson Residence'); expect(csv).toContain('180.00');
    const es = (await c.get('/api/reports/customers?format=csv&lang=es')).data as string;
    expect(es.split('\n')[0]).toBe('Nombre,Teléfono,Correo,Idioma,Estado,Creado');
    expect(((await c.get('/api/reports/customers?format=csv')).data as string).split('\n')[0]).toBe('full_name,phone,email,language,status,created_at');
    const { handleApi } = await import('../worker/src/index');
    const pdf = new TextDecoder('latin1').decode(new Uint8Array(await (await handleApi(new Request('https://app.test/api/reports/dre?format=pdf&lang=pt&from=2026-01-01&to=2026-12-31', { headers: { cookie: c.cookie } }), env)).arrayBuffer()));
    expect(pdf).toContain('demonstra'); expect(pdf).toContain('relat'); // title and footer in Portuguese (WinAnsi)
  });
});
