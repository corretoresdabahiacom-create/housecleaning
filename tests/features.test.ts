import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Client, isoDay, johnson, makeEnv, registerCompany } from './harness';
import { RealtimeHub } from '../worker/src/realtime';
import { crc32 } from '../worker/src/lib/exporters';
import { haversineMiles, nearestNeighbor } from '../worker/src/modules/routes';

afterEach(() => vi.unstubAllGlobals());
const OUT = new URL('../.test-output/', import.meta.url);

async function binary(c: Client, path: string) {
  const { handleApi } = await import('../worker/src/index');
  const res = await handleApi(new Request('https://app.test' + path, { headers: { cookie: c.cookie } }), c.env);
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
}

describe('PDF and XLSX exports', () => {
  it('produces valid files with exact money values', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const j = await johnson(c);
    const a = await c.post('/api/appointments', { property_id: j.propertyId, date: isoDay(-1), start_time: '09:00' });
    await c.post(`/api/appointments/${a.data.id}/status`, { status: 'completed' });
    const q = `from=${isoDay(-5)}&to=${isoDay(0)}`;
    const x = await binary(c, `/api/reports/revenue-by-property?${q}&format=xlsx`);
    expect(x.res.headers.get('content-type')).toContain('spreadsheetml');
    expect([...x.bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder('latin1').decode(x.bytes);
    expect(text).toContain('<v>180.00</v>');           // money as exact decimal number
    expect(text).toContain('Johnson Residence');
    const p = await binary(c, `/api/reports/dre?${q}&format=pdf`);
    const pdf = new TextDecoder('latin1').decode(p.bytes);
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('Net result');
    expect(pdf).toContain('not a GAAP');
    // Big report paginates
    for (let i = 0; i < 60; i++) await c.post('/api/customers', { full_name: `Customer ${i} =cmd` });
    const big = new TextDecoder('latin1').decode((await binary(c, '/api/reports/customers?format=pdf')).bytes);
    expect((big.match(/\/Type \/Page /g) || []).length).toBeGreaterThan(1);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(new URL('revenue.xlsx', OUT), x.bytes); writeFileSync(new URL('dre.pdf', OUT), p.bytes);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926); // CRC-32 check value
  });
});

describe('realtime hub (Durable Object)', () => {
  it('routes notifications to staff and only the matching helper; payload has no content', async () => {
    const sockets: { tags: string[]; sent: string[] }[] = [];
    const mk = (tags: string[]) => { const s = { tags, sent: [] as string[], send(m: string) { s.sent.push(m); } }; sockets.push(s); return s as any; };
    const staff = mk(['staff']), maria = mk(['helper:m']), ana = mk(['helper:a']);
    const hub = new RealtimeHub({ acceptWebSocket() {}, getWebSockets: (tag?: string) => sockets.filter((s) => !tag || s.tags.includes(tag)) as any });
    const r = await hub.fetch(new Request('https://x/notify', { method: 'POST', body: JSON.stringify({ conversation_id: 'c1', helper_id: 'm' }) }));
    expect((await r.json() as any).delivered).toBe(2);
    expect(staff.sent).toEqual(['{"type":"message","conversation_id":"c1"}']);
    expect(maria.sent).toHaveLength(1); expect(ana.sent).toHaveLength(0);
  });
  it('API notifies the company hub on new messages and requires auth for the socket', async () => {
    const env = makeEnv();
    const { client: c, companyId } = await registerCompany(env);
    const j = await johnson(c);
    const seen: any[] = [];
    (env as any).REALTIME = { idFromName: (n: string) => n, get: (id: string) => ({ fetch: async (req: Request) => { seen.push({ id, url: req.url, body: req.method === 'POST' ? await req.json() : null, role: req.headers.get('x-hcm-role') }); return new Response('{}'); } }) };
    const conv = await c.post('/api/conversations', { helper_id: j.mariaId });
    await c.post(`/api/conversations/${conv.data.id}/messages`, { body: 'hi' });
    expect(seen[0]).toMatchObject({ id: companyId, url: 'https://realtime/notify', body: { conversation_id: conv.data.id, helper_id: j.mariaId } });
    expect((await new Client(env).get('/api/realtime')).status).toBe(401);
    await c.req('GET', '/api/realtime', undefined, { upgrade: 'websocket', 'x-hcm-role': 'helper' });
    expect(seen[1].role).toBe('owner'); // role comes from the session, client header is overwritten
  });
});

describe('translation', () => {
  it('translates on demand via Workers AI without altering the stored message', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const j = await johnson(c);
    const conv = await c.post('/api/conversations', { helper_id: j.mariaId });
    const m = await c.post(`/api/conversations/${conv.data.id}/messages`, { body: 'Please clean the oven' });
    expect((await c.post(`/api/messages/${m.data.id}/translate`, { target: 'pt' })).status).toBe(503);
    const calls: any[] = [];
    (env as any).AI = { run: async (model: string, input: any) => { calls.push({ model, input }); return { translated_text: 'Por favor, limpe o forno' }; } };
    const t = await c.post(`/api/messages/${m.data.id}/translate`, { target: 'pt' });
    expect(t.data).toMatchObject({ translated_text: 'Por favor, limpe o forno', machine_translated: true });
    expect(calls[0]).toEqual({ model: '@cf/meta/m2m100-1.2b', input: { text: 'Please clean the oven', target_lang: 'pt' } });
    expect((await c.get(`/api/conversations/${conv.data.id}/messages`)).data.items[0].body).toBe('Please clean the oven');
    const other = await registerCompany(env, 'Other');
    expect((await other.client.post(`/api/messages/${m.data.id}/translate`, { target: 'pt' })).status).toBe(404);
  });
});

describe('WhatsApp Cloud API', () => {
  it('sends only when configured AND enabled by the company, logs result, never blocks in-app delivery', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const j = await johnson(c);
    const conv = await c.post('/api/conversations', { helper_id: j.mariaId });
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: any) => { calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
      return calls.length === 1 ? new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] })) : new Response(JSON.stringify({ error: { code: 131047, message: 'Re-engagement message' } }), { status: 400 }); });
    // not configured
    expect((await c.post(`/api/conversations/${conv.data.id}/messages`, { body: 'x', send_whatsapp: true })).data.whatsapp.status).toBe('disabled');
    Object.assign(env, { WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '123' });
    // configured but company has not enabled it
    expect((await c.post(`/api/conversations/${conv.data.id}/messages`, { body: 'x', send_whatsapp: true })).data.whatsapp.status).toBe('disabled');
    await c.put('/api/company', { whatsapp_enabled: true });
    const r = await c.post(`/api/conversations/${conv.data.id}/messages`, { body: 'Schedule changed', send_whatsapp: true });
    expect(r.status).toBe(201); expect(r.data.whatsapp.status).toBe('sent');
    expect(calls[0]).toMatchObject({ url: 'https://graph.facebook.com/v21.0/123/messages', auth: 'Bearer tok', body: { messaging_product: 'whatsapp', to: '14045550101', type: 'text', text: { body: 'Schedule changed' } } });
    const fail = await c.post('/api/messages/bulk', { helper_ids: [j.anaId], body: 'Hi', send_whatsapp: true });
    expect(fail.status).toBe(201); expect(fail.data).toMatchObject({ delivered: 1, whatsapp: { sent: 0, failed: 1 } });
    const ev = env.DB.raw.prepare('SELECT status, provider_id, error FROM message_delivery_events ORDER BY created_at').all() as any[];
    expect(ev.map((e) => e.status)).toEqual(['sent', 'failed']); expect(ev[1].error).toContain('131047');
  });
});

describe('property photos', () => {
  it('uploads images only, serves them to the owning company only, deletes from storage', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const j = await johnson(c);
    const fd = new FormData(); fd.set('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2])], 'kitchen.jpg')); fd.set('caption', 'Kitchen');
    const up = await c.req('POST', `/api/properties/${j.propertyId}/photos`, fd);
    expect(up.status).toBe(201);
    const pdf = new FormData(); pdf.set('file', new File([new TextEncoder().encode('%PDF-1.4')], 'x.jpg'));
    expect((await c.req('POST', `/api/properties/${j.propertyId}/photos`, pdf)).status).toBe(415);
    expect((await c.get(`/api/properties/${j.propertyId}/photos`)).data.items[0].caption).toBe('Kitchen');
    expect((await c.get(`/api/photos/${up.data.id}`)).status).toBe(200);
    const other = await registerCompany(env, 'Other');
    expect((await other.client.get(`/api/photos/${up.data.id}`)).status).toBe(404);
    expect((await other.client.req('POST', `/api/properties/${j.propertyId}/photos`, fd)).status).toBe(404);
    await c.del(`/api/photos/${up.data.id}`);
    expect(env.FILES.store.size).toBe(0);
  });
});

describe('geocoding and route ordering', () => {
  it('haversine and nearest-neighbor are correct', () => {
    const d = haversineMiles({ lat: 33.749, lon: -84.388 }, { lat: 25.7617, lon: -80.1918 }); expect(d).toBeGreaterThan(600); expect(d).toBeLessThan(612); // Atlanta → Miami ≈ 606 mi
    const order = nearestNeighbor([{ id: 'a', lat: 0, lon: 0 }, { id: 'far', lat: 0, lon: 3 }, { id: 'near', lat: 0, lon: 1 }, { id: 'mid', lat: 0, lon: 2 }]).map((x) => x.id);
    expect(order).toEqual(['a', 'near', 'mid', 'far']);
  });
  it('geocodes with the Census geocoder and suggests a shorter straight-line order', async () => {
    const env = makeEnv();
    const { client: c } = await registerCompany(env);
    const cu = await c.post('/api/customers', { full_name: 'Route Test' });
    const mk = async (name: string, lat: string, lon: string, time: string) => {
      const p = await c.post('/api/properties', { customer_id: cu.data.id, name, street: '1 St', city: 'Atlanta', state: 'GA', zip: '30303', price: '100', frequency: 'once', latitude: lat, longitude: lon });
      const a = await c.post('/api/appointments', { property_id: p.data.id, date: isoDay(1), start_time: time, helpers: [] });
      return { p: p.data.id, a: a.data.id };
    };
    const A = await mk('A', '33.70', '-84.40', '08:00'), FAR = await mk('Far', '33.70', '-84.10', '10:00'), NEAR = await mk('Near', '33.70', '-84.39', '12:00');
    expect((await c.post('/api/properties', { customer_id: cu.data.id, name: 'Bad', street: '1', city: 'X', state: 'GA', zip: '30303', price: '1', frequency: 'once', latitude: '200' })).status).toBe(422);
    const route = (await c.get(`/api/routes/day?date=${isoDay(1)}`)).data;
    expect(route.scheduled_order).toEqual([A.a, FAR.a, NEAR.a]);
    expect(route.suggested_order).toEqual([A.a, NEAR.a, FAR.a]);
    expect(route.straight_line_miles.suggested).toBeLessThan(route.straight_line_miles.scheduled);
    expect(route.method).toMatch(/straight-line/);
    expect(route.google_maps_directions).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1/);
    vi.stubGlobal('fetch', async (url: string) => { expect(url).toContain('geocoding.geo.census.gov'); return new Response(JSON.stringify({ result: { addressMatches: [{ matchedAddress: '1 ST, ATLANTA, GA, 30303', coordinates: { x: -84.39, y: 33.75 } }] } })); });
    const g = await c.post(`/api/properties/${A.p}/geocode`);
    expect(g.data).toMatchObject({ latitude: 33.75, longitude: -84.39, source: 'US Census Bureau Geocoder' });
  });
});

describe('subscription plans', () => {
  it('admin manages plans; limits enforced; non-admins blocked', async () => {
    const env = makeEnv();
    const A = await registerCompany(env, 'Admin Co');
    env.DB.raw.prepare('UPDATE users SET is_platform_admin=1 WHERE id=?').run(A.userId);
    const B = await registerCompany(env, 'Customer Co');
    expect((await B.client.get('/api/admin/plans')).status).toBe(404);
    const plan = await A.client.post('/api/admin/plans', { name: 'Starter', price: '29.00', max_properties: 2, max_users: 2 });
    expect(plan.status).toBe(201);
    expect((await A.client.post(`/api/admin/companies/${B.companyId}/subscription`, { plan_id: plan.data.id, subscription_status: 'active' })).status).toBe(200);
    const cu = await B.client.post('/api/customers', { full_name: 'X' });
    const prop = { customer_id: cu.data.id, name: 'P', street: '1', city: 'A', state: 'GA', zip: '30303', price: '1', frequency: 'once' };
    expect((await B.client.post('/api/properties', prop)).status).toBe(201);
    expect((await B.client.post('/api/properties', prop)).status).toBe(201);
    const third = await B.client.post('/api/properties', prop);
    expect(third.status).toBe(402); expect(third.data.error).toBe('plan_limit_reached');
    expect((await B.client.post('/api/members', { email: 'u2@x.com', full_name: 'U2', role: 'manager', temporary_password: 'Manager123!' })).status).toBe(201);
    expect((await B.client.post('/api/members', { email: 'u3@x.com', full_name: 'U3', role: 'manager', temporary_password: 'Manager123!' })).status).toBe(402);
    const list = (await A.client.get('/api/admin/plans')).data.items;
    expect(list[0]).toMatchObject({ name: 'Starter', price_cents: 2900, companies: 1 });
    expect((await B.client.get('/api/auth/me')).data.company.subscription_status).toBe('active');
  });
});
