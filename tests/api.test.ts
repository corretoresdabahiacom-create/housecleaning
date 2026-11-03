import { describe, expect, it } from 'vitest';
import { Client, isoDay, johnson, makeEnv, registerCompany } from './harness';
import { purgeExpiredMessages } from '../worker/src/modules/messages';

describe('auth & sessions', () => {
  it('registers, rejects weak passwords and duplicate email, logs in/out, verifies email, resets password', async () => {
    const env = makeEnv();
    const c = new Client(env);
    const weak = await c.post('/api/auth/register', { full_name: 'A', company_name: 'B', email: 'a@x.com', password: 'short', state: 'GA', city: 'X', accept_terms: true });
    expect(weak.status).toBe(422);
    const ok = await c.post('/api/auth/register', { full_name: 'A', company_name: 'B', email: 'a@x.com', password: 'L0ngEnoughPass', state: 'GA', city: 'X', accept_terms: true });
    expect(ok.status).toBe(201);
    const row: any = env.DB.raw.prepare('SELECT password_hash FROM users WHERE email=?').get('a@x.com');
    expect(row.password_hash).not.toContain('L0ngEnoughPass');
    expect((await new Client(env).post('/api/auth/register', { full_name: 'A', company_name: 'B', email: 'A@X.com', password: 'L0ngEnoughPass', state: 'GA', city: 'X', accept_terms: true })).status).toBe(409);
    expect((await c.get('/api/auth/me')).data.user.email_verified_at).toBeNull();
    expect((await c.post('/api/auth/verify-email', { token: ok.data.dev_token })).status).toBe(200);
    expect((await c.post('/api/auth/verify-email', { token: ok.data.dev_token })).status).toBe(400); // single use
    expect((await c.get('/api/auth/me')).data.user.email_verified_at).not.toBeNull();
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).status).toBe(401);
    const bad = new Client(env);
    expect((await bad.post('/api/auth/login', { email: 'a@x.com', password: 'wrongpass123' })).status).toBe(401);
    const forgot = await bad.post('/api/auth/forgot-password', { email: 'a@x.com' });
    expect((await bad.post('/api/auth/reset-password', { token: forgot.data.dev_token, password: 'N3wPassword!!' })).status).toBe(200);
    expect((await bad.post('/api/auth/login', { email: 'a@x.com', password: 'N3wPassword!!' })).status).toBe(200);
    expect((await bad.get('/api/auth/me')).status).toBe(200);
  });

  it('rate-limits login attempts per email', async () => {
    const env = makeEnv();
    await registerCompany(env);
    const email = (env.DB.raw.prepare('SELECT email FROM users').get() as any).email;
    const c = new Client(env);
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await c.post('/api/auth/login', { email, password: 'nope-nope-1' })).status);
    expect(codes).toContain(429);
  });

  it('requires CSRF header on mutations and session for private routes', async () => {
    const env = makeEnv();
    const { client } = await registerCompany(env);
    const noHeader = await client.req('POST', '/api/customers', { full_name: 'X' }, { 'x-requested-with': '' });
    expect(noHeader.status).toBe(403);
    expect((await new Client(env).get('/api/customers')).status).toBe(401);
  });

  it('revokes other sessions', async () => {
    const env = makeEnv();
    const { client } = await registerCompany(env);
    const email = (env.DB.raw.prepare('SELECT email FROM users').get() as any).email;
    const second = new Client(env);
    await second.post('/api/auth/login', { email, password: 'Sup3rSecret!pw' });
    expect((await second.get('/api/auth/me')).status).toBe(200);
    await client.post('/api/auth/sessions/revoke-others');
    expect((await second.get('/api/auth/me')).status).toBe(401);
    expect((await client.get('/api/auth/me')).status).toBe(200);
  });
});

describe('customers & properties', () => {
  it('registers a customer with multiple properties, validates address, searches, edits and archives', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const cu = await c.post('/api/customers', { full_name: 'Linda Park', phone: '555-0101' });
    const base = { customer_id: cu.data.id, street: '1 Main St', city: 'Miami', state: 'FL', zip: '33101', price: '150', frequency: 'biweekly' };
    expect((await c.post('/api/properties', { ...base, name: 'Primary', zip: 'ABCDE' })).status).toBe(422);
    expect((await c.post('/api/properties', { ...base, name: 'Primary', street: '' })).status).toBe(422);
    const p1 = await c.post('/api/properties', { ...base, name: 'Primary' });
    const p2 = await c.post('/api/properties', { ...base, name: 'Vacation Home', street: '9 Ocean Dr', city: 'Key West', zip: '33040', price: '220' });
    expect(p1.status).toBe(201); expect(p2.status).toBe(201);
    expect((await c.get(`/api/customers/${cu.data.id}`)).data.properties).toHaveLength(2);
    expect((await c.get('/api/properties?q=Linda')).data.total).toBe(2);
    expect((await c.get('/api/properties?q=Ocean')).data.items[0].name).toBe('Vacation Home');
    expect((await c.get('/api/properties?city=Key%20West')).data.total).toBe(1);
    expect((await c.get('/api/properties?q=%25')).data.total).toBe(0); // wildcard escaped
    expect((await c.put(`/api/properties/${p1.data.id}`, { price: '160.00', bedrooms: 3 })).status).toBe(200);
    expect((await c.put(`/api/properties/${p1.data.id}`, { status: 'archived' })).status).toBe(200);
    expect((await c.get('/api/properties?status=archived')).data.items[0].id).toBe(p1.data.id);
  });

  it('encrypts access instructions and restricts them by permission; never returned in lists', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const { propertyId } = await johnson(c);
    await c.put(`/api/properties/${propertyId}/access`, { instructions: 'Gate code 4321, key under mat' });
    const raw: any = env.DB.raw.prepare('SELECT ciphertext FROM property_access_instructions').get();
    expect(raw.ciphertext).not.toContain('4321');
    expect((await c.get(`/api/properties/${propertyId}/access`)).data.instructions).toContain('4321');
    expect(JSON.stringify((await c.get('/api/properties')).data)).not.toContain('4321');
    expect(JSON.stringify((await c.get(`/api/properties/${propertyId}`)).data)).not.toContain('4321');
    // scheduler role cannot read access info
    await c.post('/api/members', { email: 'sched@example.com', full_name: 'Sched', role: 'scheduler', temporary_password: 'Temp0rary!!pw' });
    const sch = new Client(env); await sch.post('/api/auth/login', { email: 'sched@example.com', password: 'Temp0rary!!pw' });
    expect((await sch.get(`/api/properties/${propertyId}/access`)).status).toBe(403);
    expect((await sch.get('/api/finance/receivables')).status).toBe(403);
    expect((await sch.get('/api/appointments')).status).toBe(200);
    const audit = env.DB.raw.prepare("SELECT details FROM audit_logs WHERE entity='property_access'").all() as any[];
    expect(JSON.stringify(audit)).not.toContain('4321');
  });

  it('default service price never overwrites negotiated property price', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const { propertyId } = await johnson(c);
    const svc = (await c.get('/api/services')).data.items.find((s: any) => s.name === 'Deep Cleaning');
    await c.put(`/api/properties/${propertyId}/service-prices`, { service_id: svc.id, price: '260' });
    await c.put(`/api/services/${svc.id}`, { default_price: '999' });
    const a = await c.post('/api/appointments', { property_id: propertyId, service_id: svc.id, date: isoDay(3), start_time: '09:00', helpers: [] });
    expect((await c.get(`/api/appointments/${a.data.id}`)).data.appointment.base_price_cents).toBe(26000);
  });
});

describe('tenant isolation (two independent companies)', () => {
  it('company B cannot read or modify any of company A data', async () => {
    const env = makeEnv();
    const A = await registerCompany(env, 'A Clean');
    const B = await registerCompany(env, 'B Clean');
    const a = A.client;
    const { propertyId, customerId, mariaId } = await johnson(a);
    await a.put(`/api/properties/${propertyId}/access`, { instructions: 'alarm 9999' });
    const appt = await a.post('/api/appointments', { property_id: propertyId, date: isoDay(1), start_time: '09:00' });
    await a.post(`/api/appointments/${appt.data.id}/status`, { status: 'completed' });
    const ar = (await a.get('/api/finance/receivables')).data.items[0];
    const ap = (await a.get('/api/finance/payables')).data.items[0];
    const cat = (await a.get('/api/finance/categories')).data.items[0];
    await a.post('/api/finance/expenses', { description: 'Supplies', category_id: cat.id, amount: '10', expense_date: isoDay(0) });
    const conv = await a.post('/api/conversations', { helper_id: mariaId });
    await a.post(`/api/conversations/${conv.data.id}/messages`, { body: 'private hello' });
    const b = B.client;
    const probes = [
      b.get(`/api/customers/${customerId}`), b.put(`/api/customers/${customerId}`, { full_name: 'hack' }),
      b.get(`/api/properties/${propertyId}`), b.get(`/api/properties/${propertyId}/access`), b.get(`/api/properties/${propertyId}/history`),
      b.put(`/api/properties/${propertyId}`, { price: '1' }), b.get(`/api/helpers/${mariaId}`), b.get(`/api/helpers/${mariaId}/notes`),
      b.get(`/api/appointments/${appt.data.id}`), b.post(`/api/appointments/${appt.data.id}/status`, { status: 'canceled' }),
      b.get(`/api/finance/receivables/${ar.id}`), b.post(`/api/finance/receivables/${ar.id}/receipts`, { amount: '1', date: isoDay(0), method: 'cash' }),
      b.post(`/api/finance/payables/${ap.id}/payments`, { amount: '1', date: isoDay(0), method: 'cash' }),
      b.get(`/api/conversations/${conv.data.id}/messages`), b.post(`/api/conversations/${conv.data.id}/messages`, { body: 'x' }), b.get(`/api/conversations/${conv.data.id}/export`),
      b.post('/api/properties', { customer_id: customerId, name: 'x', street: 'x', city: 'x', state: 'GA', zip: '30303', price: '1', frequency: 'once' }),
      b.post('/api/appointments', { property_id: propertyId, date: isoDay(2), start_time: '10:00' }),
      b.post('/api/conversations', { helper_id: mariaId }),
    ];
    for (const r of await Promise.all(probes)) expect([403, 404]).toContain(r.status);
    // Lists and reports for B are empty of A's data
    const lists = await Promise.all(['/api/customers', '/api/properties', '/api/helpers', `/api/appointments?from=${isoDay(-5)}&to=${isoDay(5)}`, '/api/finance/receivables', '/api/finance/payables', '/api/conversations'].map((p) => b.get(p)));
    for (const l of lists) expect(JSON.stringify(l.data)).not.toMatch(/Johnson|Maria|private hello|Supplies/);
    const reports = await Promise.all(['customers', 'properties', 'receivables', 'payables', 'helper-payments', 'profitability', 'dre', 'cashflow'].map((n) => b.get(`/api/reports/${n}?format=csv&from=${isoDay(-30)}&to=${isoDay(30)}`)));
    for (const r of reports) expect(String(r.data)).not.toMatch(/Johnson|Maria|9999/);
    const dre = await b.get(`/api/finance/dre?from=${isoDay(-30)}&to=${isoDay(30)}`);
    expect(dre.data.gross_revenue.total).toBe(0);
    // A's data unchanged
    expect((await a.get(`/api/customers/${customerId}`)).data.customer.full_name).toBe('Robert Johnson');
  });
});

describe('scheduling', () => {
  it('creates recurring appointments without duplicates; modifying the rule preserves history and manual edits', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const { propertyId, mariaId, anaId } = await johnson(c);
    const rule = await c.post('/api/rules', { property_id: propertyId, frequency: 'weekly', weekdays: [1], start_date: isoDay(-14), start_time: '09:00', duration_minutes: 180 });
    expect(rule.status).toBe(201);
    const n1 = rule.data.generated;
    expect(n1).toBeGreaterThanOrEqual(12);
    expect((await c.post(`/api/rules/${rule.data.id}/generate`)).data.generated).toBe(0); // idempotent
    const list = (await c.get(`/api/appointments?from=${isoDay(0)}&to=${isoDay(100)}`)).data.items;
    expect(list).toHaveLength(n1);
    expect(list[0].helpers).toContain('Maria');
    // complete the first one (history), manually edit the second one
    const [first, second] = list;
    await c.post(`/api/appointments/${first.id}/status`, { status: 'completed' });
    await c.put(`/api/appointments/${second.id}`, { start_time: '13:00' });
    // change default team and price → must not rewrite existing appointments
    await c.put(`/api/properties/${propertyId}/team`, { helpers: [{ helper_id: anaId }] });
    await c.put(`/api/properties/${propertyId}`, { price: '200' });
    // modify the rule (move to Wednesdays)
    const upd = await c.put(`/api/rules/${rule.data.id}`, { weekdays: [3], start_time: '10:00' });
    expect(upd.status).toBe(200);
    const after = (await c.get(`/api/appointments?from=${isoDay(0)}&to=${isoDay(100)}`)).data.items;
    const f = after.find((x: any) => x.id === first.id), s = after.find((x: any) => x.id === second.id);
    expect(f.status).toBe('completed'); expect(f.base_price_cents).toBe(18000); expect(f.helpers).toContain('Maria');
    expect(s.start_time).toBe('13:00'); expect(s.helpers).toContain('Maria'); // manual edit & actual assignment preserved
    const regenerated = after.filter((x: any) => x.id !== first.id && x.id !== second.id);
    expect(regenerated.length).toBeGreaterThan(0);
    for (const x of regenerated) { expect(new Date(x.date + 'T00:00:00Z').getUTCDay()).toBe(3); expect(x.base_price_cents).toBe(20000); expect(x.helpers).toBe('Ana Souza'); }
    const keys = after.map((x: any) => x.date + x.start_time + x.id);
    expect(new Set(keys).size).toBe(keys.length);
    // Completed history row keeps the actual helpers' payment snapshot (Maria + Ana at $70)
    const detail = (await c.get(`/api/appointments/${first.id}`)).data.appointment;
    expect(detail.helpers.map((h: any) => h.helper_id).sort()).toEqual([mariaId, anaId].sort());
  });

  it('detects overlapping helper schedules (warning, override with force)', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const j = await johnson(c);
    const d = isoDay(5);
    await c.post('/api/appointments', { property_id: j.propertyId, date: d, start_time: '09:00', duration_minutes: 180 });
    const clash = await c.post('/api/appointments', { property_id: j.propertyId, date: d, start_time: '11:00', duration_minutes: 60 });
    expect(clash.status).toBe(409);
    expect(clash.data.details[0].helper_name).toBeTruthy();
    const ok = await c.post('/api/appointments', { property_id: j.propertyId, date: d, start_time: '12:00', duration_minutes: 60 });
    expect(ok.status).toBe(201);
    const forced = await c.post('/api/appointments', { property_id: j.propertyId, date: d, start_time: '10:00', duration_minutes: 60, force: true });
    expect(forced.status).toBe(201); expect(forced.data.warnings.length).toBeGreaterThan(0);
  });

  it('cancels and reschedules preserving history; completed is immutable', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const j = await johnson(c);
    const a = await c.post('/api/appointments', { property_id: j.propertyId, date: isoDay(2), start_time: '09:00' });
    const rs = await c.post(`/api/appointments/${a.data.id}/reschedule`, { date: isoDay(4), start_time: '14:00' });
    expect(rs.status).toBe(201);
    expect((await c.get(`/api/appointments/${a.data.id}`)).data.appointment.status).toBe('rescheduled');
    const moved = (await c.get(`/api/appointments/${rs.data.id}`)).data.appointment;
    expect(moved.date).toBe(isoDay(4)); expect(moved.helpers).toHaveLength(2);
    await c.post(`/api/appointments/${rs.data.id}/status`, { status: 'canceled' });
    expect((await c.post(`/api/appointments/${rs.data.id}/status`, { status: 'confirmed' })).status).toBe(409);
    const b = await c.post('/api/appointments', { property_id: j.propertyId, date: isoDay(6), start_time: '09:00' });
    await c.post(`/api/appointments/${b.data.id}/status`, { status: 'completed' });
    expect((await c.put(`/api/appointments/${b.data.id}`, { price: '1' })).status).toBe(409);
    expect((await c.put(`/api/appointments/${b.data.id}/helpers`, { helpers: [] })).status).toBe(409);
    expect((await c.put(`/api/appointments/${b.data.id}`, { notes: 'great job' })).status).toBe(200);
  });
});

describe('helper payments', () => {
  it('fixed, daily and hourly rates; property-specific rates; absences; no duplicates; partial/full payment; period report', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const j = await johnson(c);
    const carla = await c.post('/api/helpers', { full_name: 'Carla Diaz', state: 'GA', city: 'Atlanta', whatsapp: '1', phone: '1', main_function: 'Cleaner', default_pay_basis: 'hourly', default_rate: '25.00' });
    const dina = await c.post('/api/helpers', { full_name: 'Dina Lee', state: 'GA', city: 'Atlanta', whatsapp: '2', phone: '2', main_function: 'Cleaner', default_pay_basis: 'daily', default_rate: '120.00' });
    await c.put(`/api/helpers/${j.anaId}/rates`, { property_id: j.propertyId, pay_basis: 'fixed', rate: '75.00' }); // Ana earns more at Johnson
    const a = await c.post('/api/appointments', { property_id: j.propertyId, date: isoDay(-1), start_time: '09:00', duration_minutes: 150,
      helpers: [{ helper_id: j.mariaId }, { helper_id: j.anaId }, { helper_id: carla.data.id }, { helper_id: dina.data.id }] });
    // scheduled appointments are NOT payable
    expect((await c.get(`/api/finance/payables?kind=helper`)).data.items).toHaveLength(0);
    await c.post(`/api/appointments/${a.data.id}/status`, { status: 'completed', attendance: [{ helper_id: dina.data.id, attendance: 'absent' }, { helper_id: carla.data.id, attendance: 'completed', worked_minutes: 150 }] });
    const pays = (await c.get(`/api/finance/payables?kind=helper`)).data.items;
    const by = Object.fromEntries(pays.map((p: any) => [p.payee, p.amount_cents]));
    expect(by).toEqual({ 'Maria Silva': 7000, 'Ana Souza': 7500, 'Carla Diaz': 6250 }); // Dina absent → nothing
    // duplicate completion impossible
    expect((await c.post(`/api/appointments/${a.data.id}/status`, { status: 'completed' })).status).toBe(409);
    const dup = env.DB.raw.prepare("SELECT COUNT(*) n FROM accounts_payable WHERE kind='helper'").get() as any;
    expect(dup.n).toBe(3);
    // partial then full payment with idempotency
    const maria = pays.find((p: any) => p.payee === 'Maria Silva');
    const p1 = await c.post(`/api/finance/payables/${maria.id}/payments`, { amount: '30.00', date: isoDay(0), method: 'zelle', idempotency_key: 'k1' });
    expect(p1.data.payable.status).toBe('partially_paid');
    expect((await c.post(`/api/finance/payables/${maria.id}/payments`, { amount: '30.00', date: isoDay(0), method: 'zelle', idempotency_key: 'k1' })).data.duplicate).toBe(true);
    expect((await c.post(`/api/finance/payables/${maria.id}/payments`, { amount: '50.00', date: isoDay(0), method: 'zelle' })).status).toBe(422); // exceeds
    expect((await c.post(`/api/finance/payables/${maria.id}/payments`, { amount: '40.00', date: isoDay(0), method: 'zelle' })).data.payable.status).toBe('paid');
    // batch pay (re-run is a no-op)
    const ids = pays.map((p: any) => p.id);
    const b1 = await c.post('/api/finance/helper-payments/pay', { payable_ids: ids, date: isoDay(0), method: 'cash', batch_key: 'wk1' });
    expect(b1.data.paid).toHaveLength(2);
    expect((await c.post('/api/finance/helper-payments/pay', { payable_ids: ids, date: isoDay(0), method: 'cash', batch_key: 'wk1' })).data.paid).toHaveLength(0);
    // report
    const rep = await c.get(`/api/finance/helper-payments?from=${isoDay(-7)}&to=${isoDay(0)}`);
    expect(rep.data.totals).toEqual({ due_cents: 20750, paid_cents: 20750 });
    const ind = await c.get(`/api/finance/helper-payments?from=${isoDay(-7)}&to=${isoDay(0)}&helper_id=${carla.data.id}`);
    expect(ind.data.summary[0]).toMatchObject({ cleanings: 1, due_cents: 6250, balance_cents: 0, hours: '2:30' });
    expect((await c.get(`/api/finance/helper-payments?from=${isoDay(-30)}&to=${isoDay(-8)}`)).data.items).toHaveLength(0); // period boundary
  });
});

describe('financial integrity', () => {
  it('Johnson example: revenue, add-ons, discounts, partial receipts, refunds, AR, AP, DRE (accrual vs cash), cash flow, profitability', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const j = await johnson(c);
    const day = isoDay(-2);
    const a = await c.post('/api/appointments', { property_id: j.propertyId, date: day, start_time: '09:00' });
    await c.post(`/api/appointments/${a.data.id}/items`, { kind: 'addon', description: 'Oven cleaning', amount: '30.00' });
    await c.post(`/api/appointments/${a.data.id}/items`, { kind: 'discount', description: 'Loyalty', amount: '10.00' });
    expect((await c.post(`/api/appointments/${a.data.id}/items`, { kind: 'discount', description: 'too much', amount: '500' })).status).toBe(422);
    await c.post(`/api/appointments/${a.data.id}/status`, { status: 'completed' });
    const cats = (await c.get('/api/finance/categories')).data.items;
    const supplies = cats.find((x: any) => x.name === 'Cleaning supplies');
    const fuel = cats.find((x: any) => x.name === 'Fuel');
    await c.post('/api/finance/expenses', { description: 'Supplies Johnson', category_id: supplies.id, amount: '10.00', expense_date: day, property_id: j.propertyId, paid_date: day, payment_method: 'cash' });
    await c.post('/api/finance/expenses', { description: 'Gas', category_id: fuel.id, amount: '25.50', expense_date: day }); // unpaid
    await c.post('/api/finance/opening-balances', { date: isoDay(-10), amount: '1000.00' });

    const ar = (await c.get('/api/finance/receivables')).data;
    expect(ar.items[0].amount_cents).toBe(20000); // 180 + 30 − 10
    expect(ar.summary.total_outstanding).toBe(20000);
    // partial receipt then full
    const r1 = await c.post(`/api/finance/receivables/${ar.items[0].id}/receipts`, { amount: '50.00', date: day, method: 'zelle', idempotency_key: 'rcpt-1' });
    expect(r1.data.receivable.status).toBe('partially_paid');
    expect((await c.post(`/api/finance/receivables/${ar.items[0].id}/receipts`, { amount: '50.00', date: day, method: 'zelle', idempotency_key: 'rcpt-1' })).data.duplicate).toBe(true);
    expect((await c.post(`/api/finance/receivables/${ar.items[0].id}/receipts`, { amount: '150.01', date: day, method: 'cash' })).status).toBe(422);
    expect((await c.post(`/api/finance/receivables/${ar.items[0].id}/receipts`, { amount: '100.00', currency: 'EUR', date: day, method: 'cash' })).status).toBe(422); // no mixed currencies

    const P = `from=${isoDay(-7)}&to=${isoDay(0)}`;
    // Accrual DRE: revenue recognized once even though only partially paid
    let dre = (await c.get(`/api/finance/dre?${P}&basis=accrual`)).data;
    expect(dre.basis).toBe('accrual');
    expect(dre.gross_revenue.total).toBe(21000);
    expect(dre.deductions.discounts).toBe(1000);
    expect(dre.net_revenue).toBe(20000);
    expect(dre.direct_costs.helper_labor).toBe(14000);
    expect(dre.direct_costs.total).toBe(15000);
    expect(dre.gross_profit).toBe(5000);
    expect(dre.operating_expenses.total).toBe(2550);
    expect(dre.net_result).toBe(2450);
    expect(dre.disclaimer).toMatch(/Not a GAAP/);
    // Cash DRE: only actual receipts / payments
    let cash = (await c.get(`/api/finance/dre?${P}&basis=cash`)).data;
    expect(cash.gross_revenue.total).toBe(5000);
    expect(cash.direct_costs.total).toBe(1000); // helpers unpaid → not cash
    // Cash flow
    let cf = (await c.get(`/api/finance/cashflow?${P}`)).data;
    expect(cf).toMatchObject({ opening_balance: 100000, receipts: 5000, payments: 1000, net_movement: 4000, closing_balance: 104000 });
    // pay rest + refund 20
    await c.post(`/api/finance/receivables/${ar.items[0].id}/receipts`, { amount: '150.00', date: day, method: 'check' });
    expect((await c.get(`/api/finance/receivables/${ar.items[0].id}`)).data.receivable.status).toBe('paid');
    expect((await c.post(`/api/finance/receivables/${ar.items[0].id}/receipts`, { kind: 'refund', amount: '300.00', date: day, method: 'check' })).status).toBe(422);
    await c.post(`/api/finance/receivables/${ar.items[0].id}/receipts`, { kind: 'refund', amount: '20.00', date: day, method: 'check' });
    expect((await c.get(`/api/finance/receivables/${ar.items[0].id}`)).data.receivable.status).toBe('partially_paid');
    dre = (await c.get(`/api/finance/dre?${P}`)).data;
    expect(dre.deductions.refunds).toBe(2000);
    expect(dre.net_revenue).toBe(18000);
    cf = (await c.get(`/api/finance/cashflow?${P}`)).data;
    expect(cf).toMatchObject({ receipts: 20000, payments: 3000, closing_balance: 117000 });
    // cash flow prior-period roll forward
    const cf2 = (await c.get(`/api/finance/cashflow?from=${isoDay(-1)}&to=${isoDay(0)}`)).data;
    expect(cf2.opening_balance).toBe(117000);
    // reconciliation
    const rec = (await c.get(`/api/finance/reconcile?${P}&statement_balance=1170.00`)).data;
    expect(rec.reconciled).toBe(true);
    // Property profitability: 200 − 20 refund − 140 labor − 10 supplies = 30 contribution
    const prof = (await c.get(`/api/finance/profitability?${P}`)).data.items[0];
    expect(prof).toMatchObject({ gross: 21000, discounts: 1000, refunds: 2000, net_revenue: 18000, helper_labor: 14000, direct_supplies: 1000, gross_contribution: 3000 });
    expect(prof.contribution_bps).toBe(1667);
    // AP summary: helpers 140 + fuel 25.50 outstanding
    const ap = (await c.get('/api/finance/payables')).data;
    expect(ap.summary.total_outstanding).toBe(16550);
    // overview consistency with DRE
    const ov = (await c.get(`/api/finance/overview?${P}`)).data;
    expect(ov.net_result).toBe(dre.net_result);
    expect(ov.cash_receipts).toBe(cf.receipts);
    expect(ov.pending_helper_payments).toBe(14000);
  });

  it('installments split exactly, write-offs, cancellation rules, recurring expenses', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const j = await johnson(c);
    const inv = await c.post('/api/finance/receivables', { customer_id: j.customerId, description: 'Move-out', amount: '100.00', issue_date: isoDay(0), due_date: isoDay(0), installments: 3, revenue_class: 'move' });
    expect(inv.data.ids).toHaveLength(3);
    const rows = env.DB.raw.prepare('SELECT amount_cents FROM accounts_receivable ORDER BY due_date').all() as any[];
    expect(rows.map((r) => r.amount_cents)).toEqual([3334, 3333, 3333]);
    await c.post(`/api/finance/receivables/${inv.data.ids[1]}/receipts`, { amount: '10', date: isoDay(0), method: 'cash' });
    expect((await c.post(`/api/finance/receivables/${inv.data.ids[1]}/status`, { status: 'canceled' })).status).toBe(409);
    expect((await c.post(`/api/finance/receivables/${inv.data.ids[1]}/status`, { status: 'written_off' })).status).toBe(200);
    const dre = (await c.get(`/api/finance/dre?from=${isoDay(-1)}&to=${isoDay(1)}`)).data;
    expect(dre.gross_revenue.move).toBe(10000); // invoice recognized once at issue date (installments only split collection)
    expect(dre.deductions.write_offs).toBe(2333); // 3333 written off minus 10 already received
    const cat = (await c.get('/api/finance/categories')).data.items.find((x: any) => x.name === 'Rent');
    const prev = new Date(); prev.setUTCMonth(prev.getUTCMonth() - 1);
    await c.post('/api/finance/expenses', { description: 'Office rent', category_id: cat.id, amount: '900', expense_date: prev.toISOString().slice(0, 10), recurring_monthly: true });
    const { generateRecurringExpenses } = await import('../worker/src/modules/finance');
    expect(await generateRecurringExpenses(env)).toBe(1);
    expect(await generateRecurringExpenses(env)).toBe(0); // idempotent
  });
});

describe('messaging', () => {
  it('individual + bulk private conversations, helper isolation, attachments authorization, 24h expiry purge', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const j = await johnson(c);
    const bulk = await c.post('/api/messages/bulk', { helper_ids: [j.mariaId, j.anaId], body: 'Holiday schedule update' });
    expect(bulk.data.delivered).toBe(2);
    const convs = (await c.get('/api/conversations')).data.items;
    expect(convs).toHaveLength(2); // two private conversations, no group
    const parts = env.DB.raw.prepare('SELECT COUNT(DISTINCT helper_id) n, COUNT(*) c FROM conversations').get() as any;
    expect(parts).toEqual({ n: 2, c: 2 });
    // helper accounts: Maria sees only her conversation
    await c.post('/api/members', { email: 'maria@example.com', full_name: 'Maria', role: 'helper', helper_id: j.mariaId, temporary_password: 'Helper123!' });
    const m = new Client(env); await m.post('/api/auth/login', { email: 'maria@example.com', password: 'Helper123!' });
    const mine = (await m.get('/api/conversations')).data.items;
    expect(mine).toHaveLength(1); expect(mine[0].helper_id).toBe(j.mariaId);
    const anaConv = convs.find((x: any) => x.helper_id === j.anaId);
    expect((await m.get(`/api/conversations/${anaConv.id}/messages`)).status).toBe(404);
    expect((await m.get('/api/customers')).status).toBe(403);
    expect((await m.get('/api/finance/receivables')).status).toBe(403);
    expect((await m.get(`/api/helpers/${j.mariaId}/notes`)).status).toBe(403);
    expect((await m.post(`/api/conversations/${mine[0].id}/messages`, { body: 'Ok, thanks!' })).status).toBe(201);
    // attachment: valid PNG accepted, spoofed type rejected; Ana cannot fetch Maria's attachment
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const fd = new FormData(); fd.set('body', 'photo'); fd.set('file', new File([png], 'room.png', { type: 'image/png' }));
    const up = await c.req('POST', `/api/conversations/${mine[0].id}/messages`, fd);
    expect(up.status).toBe(201);
    const fake = new FormData(); fake.set('file', new File([new TextEncoder().encode('<script>')], 'x.png', { type: 'image/png' }));
    expect((await c.req('POST', `/api/conversations/${mine[0].id}/messages`, fake)).status).toBe(415);
    await c.post('/api/members', { email: 'ana@example.com', full_name: 'Ana', role: 'helper', helper_id: j.anaId, temporary_password: 'Helper123!' });
    const an = new Client(env); await an.post('/api/auth/login', { email: 'ana@example.com', password: 'Helper123!' });
    expect((await an.get(`/api/messages/${up.data.id}/attachment`)).status).toBe(404);
    expect((await m.get(`/api/messages/${up.data.id}/attachment`)).status).toBe(200);
    // stored verbatim
    expect((await m.get(`/api/conversations/${mine[0].id}/messages`)).data.items.map((x: any) => x.body)).toContain('Holiday schedule update');
    // expiry: age messages past 24h → hidden immediately, then purged with attachments
    env.DB.raw.prepare("UPDATE messages SET expires_at='2000-01-01T00:00:00Z'").run();
    expect((await m.get(`/api/conversations/${mine[0].id}/messages`)).data.items).toHaveLength(0);
    expect((await m.get(`/api/messages/${up.data.id}/attachment`)).status).toBe(404);
    expect(env.FILES.store.size).toBe(1);
    expect(await purgeExpiredMessages(env)).toBeGreaterThan(0);
    expect(env.FILES.store.size).toBe(0);
    expect((env.DB.raw.prepare('SELECT COUNT(*) n FROM messages').get() as any).n).toBe(0);
    expect(await (await import('../worker/src/modules/messages')).purgeExpiredMessages(env)).toBe(0); // retry-safe
    // expiry timestamp is per message: created + 24h
    await c.post(`/api/conversations/${mine[0].id}/messages`, { body: 'new' });
    const msg = env.DB.raw.prepare('SELECT created_at, expires_at FROM messages').get() as any;
    expect(Date.parse(msg.expires_at) - Date.parse(msg.created_at)).toBe(24 * 3600 * 1000);
  });
});

describe('security', () => {
  it('SQL injection payloads are inert; XSS payloads stored as data; IDOR blocked; oversized body rejected', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const inj = "x' OR 1=1; DROP TABLE customers; --";
    expect((await c.post('/api/customers', { full_name: inj })).status).toBe(201);
    expect((await c.get('/api/customers?q=' + encodeURIComponent("' OR '1'='1"))).data.total).toBe(0);
    expect((await c.get('/api/customers?q=' + encodeURIComponent(inj))).data.total).toBe(1);
    const xss = await c.post('/api/customers', { full_name: '<img src=x onerror=alert(1)>' });
    const got = await c.get(`/api/customers/${xss.data.id}`);
    expect(got.headers.get('content-type')).toContain('application/json');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await c.get('/api/customers/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    const big = await c.post('/api/customers', { full_name: 'a'.repeat(1_100_000) });
    expect(big.status).toBe(413);
    // mass-assignment: company_id in body is ignored
    const other = await registerCompany(env, 'Other');
    const mal = await c.post('/api/customers', { full_name: 'Sneaky', company_id: other.companyId });
    const row: any = env.DB.raw.prepare('SELECT company_id FROM customers WHERE id=?').get(mal.data.id);
    expect(row.company_id).not.toBe(other.companyId);
  });

  it('platform admin sees aggregates only and actions are audited; non-admins get 404', async () => {
    const env = makeEnv();
    const A = await registerCompany(env, 'Tenant A');
    await johnson(A.client);
    expect((await A.client.get('/api/admin/companies')).status).toBe(404);
    env.DB.raw.prepare('UPDATE users SET is_platform_admin=1 WHERE id=?').run(A.userId);
    const list = await A.client.get('/api/admin/companies');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.data)).not.toMatch(/Johnson|Peachtree|Maria/);
    const B = await registerCompany(env, 'Tenant B');
    expect((await A.client.post(`/api/admin/companies/${B.companyId}/status`, { status: 'suspended', reason: 'test' })).status).toBe(200);
    expect((await B.client.get('/api/auth/me')).status).toBe(401); // sessions revoked
    expect((env.DB.raw.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='admin_suspended'").get() as any).n).toBe(1);
  });

  it('permission overrides are enforced on the backend', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    await c.post('/api/members', { email: 'fin@example.com', full_name: 'Fin', role: 'finance', temporary_password: 'Financ3!pass' });
    const f = new Client(env); await f.post('/api/auth/login', { email: 'fin@example.com', password: 'Financ3!pass' });
    expect((await f.get('/api/finance/receivables')).status).toBe(200);
    expect((await f.put('/api/roles/permissions', { role: 'manager', permission: 'finance.read', allowed: true })).status).toBe(403);
    await c.put('/api/roles/permissions', { role: 'finance', permission: 'finance.read', allowed: false });
    expect((await f.get('/api/finance/receivables')).status).toBe(403);
  });
});
