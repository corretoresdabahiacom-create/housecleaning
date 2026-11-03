// Test harness: runs the real Worker API against an in-memory SQLite database (same engine as D1),
// applying the real migration file. A D1-compatible adapter wraps node:sqlite.
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
type DatabaseSync = any;
import { readFileSync, readdirSync } from 'node:fs';
import { handleApi } from '../worker/src/index';
import type { D1Like, Env, R2Like } from '../worker/src/lib/core';

export function makeDb(): D1Like & { raw: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    sql, args,
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => (db.prepare(sql).get(...(args as any[])) as any) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }),
    run: async () => { const r = db.prepare(sql).run(...(args as any[])); return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    raw: db,
    prepare: (sql: string) => stmt(sql),
    // D1 batches are transactional: emulate with BEGIN/COMMIT/ROLLBACK.
    batch: async (stmts: any[]) => {
      db.exec('BEGIN');
      try { const out = stmts.map((s) => db.prepare(s.sql).run(...s.args)); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

export function makeR2(): R2Like & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    put: async (k, v) => { store.set(k, v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer)); },
    get: async (k) => { const v = store.get(k); return v ? { body: new Blob([v as any]).stream(), arrayBuffer: async () => v.buffer as ArrayBuffer } : null; },
    delete: async (k) => { for (const x of Array.isArray(k) ? k : [k]) store.delete(x); },
  };
}

export function makeEnv(): Env & { DB: ReturnType<typeof makeDb>; FILES: ReturnType<typeof makeR2> } {
  return { DB: makeDb(), FILES: makeR2(), ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), APP_ENV: 'development' } as any;
}

export class Client {
  cookie = '';
  constructor(public env: Env) {}
  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { 'x-requested-with': 'hcm', ...extra };
    if (this.cookie) headers.cookie = this.cookie;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await handleApi(new Request('https://app.test' + path, { method, headers, body: payload }), this.env);
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data: data as any, headers: res.headers };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  put = (p: string, b?: unknown) => this.req('PUT', p, b ?? {});
  del = (p: string) => this.req('DELETE', p);
}

let n = 0;
export async function registerCompany(env: Env, name = 'Acme Cleaning') {
  const c = new Client(env);
  n++;
  const r = await c.post('/api/auth/register', {
    full_name: 'Owner ' + n, company_name: name, email: `owner${n}_${Date.now()}@example.com`, password: 'Sup3rSecret!pw',
    state: 'GA', city: 'Atlanta', language: 'en', accept_terms: true,
  });
  if (r.status !== 201) throw new Error('register failed ' + JSON.stringify(r.data));
  return { client: c, companyId: r.data.company_id as string, userId: r.data.user_id as string, devToken: r.data.dev_token as string };
}

export const isoDay = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

/** Creates customer + property + two helpers (Maria $70, Ana $70) — the spec's Johnson Residence example. */
export async function johnson(c: Client, opts: { price?: string } = {}) {
  const cu = await c.post('/api/customers', { full_name: 'Robert Johnson', phone: '+14045550100', email: 'rj@example.com' });
  const p = await c.post('/api/properties', { customer_id: cu.data.id, name: 'Johnson Residence', street: '12 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303', price: opts.price ?? '180.00', frequency: 'weekly', estimated_minutes: 180 });
  const maria = await c.post('/api/helpers', { full_name: 'Maria Silva', state: 'GA', city: 'Atlanta', whatsapp: '+14045550101', phone: '+14045550101', main_function: 'Cleaner', default_pay_basis: 'fixed', default_rate: '70.00' });
  const ana = await c.post('/api/helpers', { full_name: 'Ana Souza', state: 'GA', city: 'Atlanta', whatsapp: '+14045550102', phone: '+14045550102', main_function: 'Cleaner', default_pay_basis: 'fixed', default_rate: '70.00' });
  await c.put(`/api/properties/${p.data.id}/team`, { helpers: [{ helper_id: maria.data.id }, { helper_id: ana.data.id }] });
  return { customerId: cu.data.id, propertyId: p.data.id, mariaId: maria.data.id, anaId: ana.data.id };
}
