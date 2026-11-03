import { HttpError, Router, assertCurrency, todayIn, json, likeParam, nowIso, page, uid, validate } from '../lib/core';
import { audit, decrypt, encrypt, owned, requirePerm } from '../lib/security';
import { sniff } from './messages';
import { checkPlanLimit } from './reports';

const STATUS = ['active', 'inactive', 'archived', 'pending'] as const;
const LANGS = ['en', 'pt', 'es'] as const;
const FREQ = ['once', 'daily', 'weekly', 'twice_weekly', 'biweekly', 'triweekly', 'monthly', 'bimonthly', 'custom'] as const;
const BASIS = ['fixed', 'daily', 'hourly', 'other'] as const;

const customerSchema = {
  full_name: { type: 'string', required: true, max: 120 }, phone: { type: 'string', max: 30 }, whatsapp: { type: 'string', max: 30 },
  email: { type: 'email' }, language: { type: 'enum', values: LANGS }, contact_person: { type: 'string', max: 120 },
  notes: { type: 'string', max: 4000 }, status: { type: 'enum', values: STATUS },
} as const;

const propertySchema = {
  customer_id: { type: 'string', required: true }, name: { type: 'string', required: true, max: 120 },
  street: { type: 'string', required: true, max: 200 }, unit: { type: 'string', max: 40 }, city: { type: 'string', required: true, max: 80 },
  state: { type: 'string', required: true, max: 2 }, zip: { type: 'string', required: true, max: 10 }, phone: { type: 'string', max: 30 },
  price: { type: 'money', required: true }, pricing_model: { type: 'enum', values: ['fixed', 'hourly', 'custom'] }, currency: { type: 'string', max: 3 },
  frequency: { type: 'enum', values: FREQ, required: true }, status: { type: 'enum', values: STATUS },
  property_type: { type: 'enum', values: ['house', 'apartment', 'condo', 'townhouse', 'other'] }, bedrooms: { type: 'int', min: 0, max: 50 },
  bathrooms: { type: 'int', min: 0, max: 50 }, size_sqft: { type: 'int', min: 0, max: 100000 }, floors: { type: 'int', min: 0, max: 20 },
  parking: { type: 'string', max: 500 }, pets: { type: 'string', max: 500 }, special_instructions: { type: 'string', max: 4000 },
  preferred_time: { type: 'time' }, estimated_minutes: { type: 'int', min: 15, max: 1440 }, private_notes: { type: 'string', max: 4000 },
  latitude: { type: 'string', max: 20 }, longitude: { type: 'string', max: 20 },
} as const;

const helperSchema = {
  full_name: { type: 'string', required: true, max: 120 }, state: { type: 'string', required: true, max: 2 }, city: { type: 'string', required: true, max: 80 },
  whatsapp: { type: 'string', required: true, max: 30 }, phone: { type: 'string', required: true, max: 30 }, language: { type: 'enum', values: LANGS },
  main_function: { type: 'string', required: true, max: 80 }, email: { type: 'email' }, experience: { type: 'string', max: 1000 },
  skills: { type: 'string', max: 1000 }, availability: { type: 'string', max: 1000 }, certifications: { type: 'string', max: 1000 },
  description: { type: 'string', max: 2000 }, favorite: { type: 'bool' }, status: { type: 'enum', values: ['active', 'archived'] },
  default_pay_basis: { type: 'enum', values: BASIS }, default_rate: { type: 'money' },
} as const;

/** Coordinates are optional (route ordering). Stored as REAL; they are geographic, not monetary. */
function coords(v: any) {
  for (const [k, lim] of [['latitude', 90], ['longitude', 180]] as const) {
    if (v[k] === undefined || v[k] === null) continue;
    const n = Number(v[k]);
    if (!/^-?\d{1,3}(\.\d{1,8})?$/.test(String(v[k])) || Math.abs(n) > lim) throw new HttpError(422, 'validation_error', { [k]: 'invalid' });
    v[k] = n;
  }
  return v;
}

/** Builds a safe UPDATE from validated fields (column names come from the schema, never from input). */
function updateSql(table: string, v: Record<string, any>, rename: Record<string, string> = {}) {
  const cols = Object.keys(v).map((k) => rename[k] ?? k);
  if (!cols.length) throw new HttpError(422, 'nothing_to_update');
  return { sql: `UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(', ')}, updated_at=? WHERE id=? AND company_id=?`, values: Object.values(v) };
}

export function crmRoutes(r: Router) {
  // ───────── Customers ─────────
  r.get('/api/customers', async (c) => {
    const s = await requirePerm(c.env, c.session, 'customers.read');
    const { limit, offset } = page(c.query);
    const q = c.query.get('q'), status = c.query.get('status');
    const where = ['company_id=?']; const args: any[] = [s.companyId];
    if (q) { where.push("(full_name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')"); args.push(likeParam(q), likeParam(q), likeParam(q)); }
    if (status) { where.push('status=?'); args.push(status); }
    const { results } = await c.env.DB.prepare(`SELECT * FROM customers WHERE ${where.join(' AND ')} ORDER BY full_name LIMIT ? OFFSET ?`).bind(...args, limit, offset).all();
    const total = await c.env.DB.prepare(`SELECT COUNT(*) n FROM customers WHERE ${where.join(' AND ')}`).bind(...args).first<any>();
    return json({ items: results, total: total.n, limit, offset });
  });
  r.post('/api/customers', async (c) => {
    const s = await requirePerm(c.env, c.session, 'customers.write');
    const v = validate(await c.body(), customerSchema);
    const id = uid(), now = nowIso();
    await c.env.DB.prepare(`INSERT INTO customers (id,company_id,full_name,phone,whatsapp,email,language,contact_person,notes,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, s.companyId, v.full_name, v.phone ?? null, v.whatsapp ?? null, v.email ?? null, v.language || 'en', v.contact_person ?? null, v.notes ?? null, v.status || 'active', now, now).run();
    await audit(c.env, s, 'create', 'customer', id);
    return json({ id }, 201);
  });
  r.get('/api/customers/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'customers.read');
    const cu = await owned(c.env, 'customers', c.params.id, s.companyId);
    const { results } = await c.env.DB.prepare('SELECT id,name,street,unit,city,state,zip,price_cents,frequency,status FROM residential_properties WHERE company_id=? AND customer_id=? ORDER BY name').bind(s.companyId, c.params.id).all();
    return json({ customer: cu, properties: results });
  });
  r.put('/api/customers/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'customers.write');
    await owned(c.env, 'customers', c.params.id, s.companyId);
    const v = validate(await c.body(), customerSchema, true);
    const u = updateSql('customers', v);
    await c.env.DB.prepare(u.sql).bind(...u.values, nowIso(), c.params.id, s.companyId).run();
    await audit(c.env, s, 'update', 'customer', c.params.id, Object.keys(v));
    return json({ ok: true });
  });

  // ───────── Properties ─────────
  r.get('/api/properties', async (c) => {
    const s = await requirePerm(c.env, c.session, 'properties.read');
    const { limit, offset } = page(c.query);
    const where = ['p.company_id=?']; const args: any[] = [s.companyId];
    const q = c.query.get('q');
    if (q) {
      where.push("(p.name LIKE ? ESCAPE '\\' OR p.street LIKE ? ESCAPE '\\' OR cu.full_name LIKE ? ESCAPE '\\' OR p.phone LIKE ? ESCAPE '\\' OR cu.phone LIKE ? ESCAPE '\\')");
      args.push(...Array(5).fill(likeParam(q)));
    }
    for (const f of ['city', 'state', 'zip', 'frequency', 'status', 'customer_id'] as const) {
      const val = c.query.get(f); if (val) { where.push(`p.${f}=?`); args.push(val); }
    }
    const helper = c.query.get('helper_id');
    if (helper) { where.push('EXISTS (SELECT 1 FROM property_default_helpers d WHERE d.property_id=p.id AND d.helper_id=? AND d.company_id=p.company_id)'); args.push(helper); }
    // Note: access instructions and private notes are NEVER returned in list endpoints.
    const sql = `SELECT p.id,p.name,p.street,p.unit,p.city,p.state,p.zip,p.price_cents,p.currency,p.frequency,p.status,p.property_type,p.customer_id,cu.full_name AS customer_name
                 FROM residential_properties p JOIN customers cu ON cu.id=p.customer_id AND cu.company_id=p.company_id
                 WHERE ${where.join(' AND ')}`;
    const { results } = await c.env.DB.prepare(`${sql} ORDER BY p.name LIMIT ? OFFSET ?`).bind(...args, limit, offset).all();
    const total = await c.env.DB.prepare(`SELECT COUNT(*) n FROM (${sql})`).bind(...args).first<any>();
    return json({ items: results, total: total.n, limit, offset });
  });
  r.post('/api/properties', async (c) => {
    const s = await requirePerm(c.env, c.session, 'properties.write');
    const v = coords(validate(await c.body(), propertySchema));
    await owned(c.env, 'customers', v.customer_id, s.companyId);
    await checkPlanLimit(c.env, s.companyId, 'properties');
    const currency = assertCurrency(v.currency, s.currency);
    if (!/^\d{5}(-\d{4})?$/.test(v.zip)) throw new HttpError(422, 'validation_error', { zip: 'zip' });
    const id = uid(), now = nowIso();
    const cols = ['unit', 'phone', 'property_type', 'bedrooms', 'bathrooms', 'size_sqft', 'floors', 'parking', 'pets', 'special_instructions', 'preferred_time', 'estimated_minutes', 'private_notes', 'latitude', 'longitude'] as const;
    await c.env.DB.prepare(`INSERT INTO residential_properties (id,company_id,customer_id,name,street,city,state,zip,price_cents,pricing_model,currency,frequency,status,${cols.join(',')},created_at,updated_at)
      VALUES (${Array(13 + cols.length + 2).fill('?').join(',')})`)
      .bind(id, s.companyId, v.customer_id, v.name, v.street, v.city, v.state.toUpperCase(), v.zip, v.price, v.pricing_model || 'fixed', currency, v.frequency, v.status || 'active',
        ...cols.map((k) => (v as any)[k] ?? null), now, now).run();
    await audit(c.env, s, 'create', 'property', id);
    return json({ id }, 201);
  });
  r.get('/api/properties/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'properties.read');
    const p: any = await owned(c.env, 'residential_properties', c.params.id, s.companyId);
    const customer = await c.env.DB.prepare('SELECT id,full_name,phone,whatsapp,email FROM customers WHERE id=? AND company_id=?').bind(p.customer_id, s.companyId).first();
    const team = (await c.env.DB.prepare(`SELECT d.helper_id, d.pay_basis, d.rate_cents, h.full_name FROM property_default_helpers d JOIN helper_records h ON h.id=d.helper_id WHERE d.property_id=? AND d.company_id=?`).bind(p.id, s.companyId).all()).results;
    const prices = (await c.env.DB.prepare(`SELECT ps.service_id, ps.price_cents, sv.name FROM property_service_prices ps JOIN cleaning_services sv ON sv.id=ps.service_id WHERE ps.property_id=? AND ps.company_id=?`).bind(p.id, s.companyId).all()).results;
    const hasAccess = !!(await c.env.DB.prepare('SELECT 1 FROM property_access_instructions WHERE property_id=? AND company_id=?').bind(p.id, s.companyId).first());
    return json({ property: p, customer, default_team: team, service_prices: prices, has_access_instructions: hasAccess });
  });
  r.put('/api/properties/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'properties.write');
    await owned(c.env, 'residential_properties', c.params.id, s.companyId);
    const v: any = coords(validate(await c.body(), propertySchema, true));
    if (v.customer_id) await owned(c.env, 'customers', v.customer_id, s.companyId);
    if (v.currency) assertCurrency(v.currency, s.currency);
    if (v.zip && !/^\d{5}(-\d{4})?$/.test(v.zip)) throw new HttpError(422, 'validation_error', { zip: 'zip' });
    if (v.state) v.state = v.state.toUpperCase();
    // Changing price here never touches existing appointments: they carry their own price snapshot.
    const u = updateSql('residential_properties', v, { price: 'price_cents' });
    await c.env.DB.prepare(u.sql).bind(...u.values, nowIso(), c.params.id, s.companyId).run();
    await audit(c.env, s, 'update', 'property', c.params.id, Object.keys(v));
    return json({ ok: true });
  });

  // Access instructions: encrypted at rest, separate permission, audited reads.
  r.get('/api/properties/:id/access', async (c) => {
    const s = await requirePerm(c.env, c.session, 'properties.access_info');
    await owned(c.env, 'residential_properties', c.params.id, s.companyId);
    const row = await c.env.DB.prepare('SELECT * FROM property_access_instructions WHERE property_id=? AND company_id=?').bind(c.params.id, s.companyId).first<any>();
    await audit(c.env, s, 'read', 'property_access', c.params.id);
    if (!row) return json({ instructions: null });
    return json({ instructions: await decrypt(c.env, row.ciphertext, row.iv, `${s.companyId}:${c.params.id}`, row.key_version), updated_at: row.updated_at });
  });
  r.put('/api/properties/:id/access', async (c) => {
    const s = await requirePerm(c.env, c.session, 'properties.access_info');
    await owned(c.env, 'residential_properties', c.params.id, s.companyId);
    const v = validate(await c.body(), { instructions: { type: 'string', max: 4000 } });
    if (!v.instructions) {
      await c.env.DB.prepare('DELETE FROM property_access_instructions WHERE property_id=? AND company_id=?').bind(c.params.id, s.companyId).run();
    } else {
      const e = await encrypt(c.env, v.instructions, `${s.companyId}:${c.params.id}`);
      await c.env.DB.prepare(`INSERT INTO property_access_instructions (property_id,company_id,ciphertext,iv,updated_at,updated_by,key_version) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(property_id) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv, updated_at=excluded.updated_at, updated_by=excluded.updated_by, key_version=excluded.key_version`)
        .bind(c.params.id, s.companyId, e.ciphertext, e.iv, nowIso(), s.userId, e.version).run();
    }
    await audit(c.env, s, 'update', 'property_access', c.params.id);
    return json({ ok: true });
  });

  // Default property team (does NOT rewrite existing appointments)
  r.put('/api/properties/:id/team', async (c) => {
    const s = await requirePerm(c.env, c.session, 'properties.write');
    await owned(c.env, 'residential_properties', c.params.id, s.companyId);
    const b = await c.body();
    if (!Array.isArray(b?.helpers)) throw new HttpError(422, 'validation_error', { helpers: 'array' });
    const rows: { id: string; basis: string; rate: number }[] = [];
    for (const h of b.helpers) {
      const v = validate(h, { helper_id: { type: 'string', required: true }, pay_basis: { type: 'enum', values: BASIS }, rate: { type: 'money' } });
      const hr: any = await owned(c.env, 'helper_records', v.helper_id, s.companyId);
      rows.push({ id: v.helper_id, basis: v.pay_basis || hr.default_pay_basis, rate: v.rate ?? hr.default_rate_cents });
    }
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM property_default_helpers WHERE property_id=? AND company_id=?').bind(c.params.id, s.companyId),
      ...rows.map((x) => c.env.DB.prepare('INSERT INTO property_default_helpers (company_id,property_id,helper_id,pay_basis,rate_cents) VALUES (?,?,?,?,?)').bind(s.companyId, c.params.id, x.id, x.basis, x.rate)),
    ]);
    await audit(c.env, s, 'update', 'property_team', c.params.id, { helpers: rows.length });
    return json({ ok: true });
  });

  r.put('/api/properties/:id/service-prices', async (c) => {
    const s = await requirePerm(c.env, c.session, 'properties.write');
    await owned(c.env, 'residential_properties', c.params.id, s.companyId);
    const v = validate(await c.body(), { service_id: { type: 'string', required: true }, price: { type: 'money' } });
    await owned(c.env, 'cleaning_services', v.service_id, s.companyId);
    if (v.price === null || v.price === undefined) await c.env.DB.prepare('DELETE FROM property_service_prices WHERE property_id=? AND service_id=? AND company_id=?').bind(c.params.id, v.service_id, s.companyId).run();
    else await c.env.DB.prepare('INSERT INTO property_service_prices (company_id,property_id,service_id,price_cents) VALUES (?,?,?,?) ON CONFLICT(property_id,service_id) DO UPDATE SET price_cents=excluded.price_cents')
      .bind(s.companyId, c.params.id, v.service_id, v.price).run();
    return json({ ok: true });
  });

  // ───────── Property photos (R2; images only, type checked by magic bytes; 8 MB; 20 per property) ─────────
  r.get('/api/properties/:id/photos', async (c) => {
    const s = await requirePerm(c.env, c.session, 'properties.read');
    await owned(c.env, 'residential_properties', c.params.id, s.companyId);
    const { results } = await c.env.DB.prepare('SELECT id, caption, content_type, created_at FROM property_photos WHERE property_id=? AND company_id=? ORDER BY created_at').bind(c.params.id, s.companyId).all();
    return json({ items: results });
  });
  r.post('/api/properties/:id/photos', async (c) => {
    const s = await requirePerm(c.env, c.session, 'properties.write');
    await owned(c.env, 'residential_properties', c.params.id, s.companyId);
    if (!c.env.FILES) throw new HttpError(503, 'storage_not_configured');
    if (!(c.req.headers.get('content-type') || '').startsWith('multipart/form-data')) throw new HttpError(415, 'multipart_required');
    const n = await c.env.DB.prepare('SELECT COUNT(*) n FROM property_photos WHERE property_id=? AND company_id=?').bind(c.params.id, s.companyId).first<any>();
    if (n.n >= 20) throw new HttpError(422, 'photo_limit_reached');
    const form = await c.req.formData();
    const file = form.get('file') as unknown as File | null;
    if (!file || typeof file !== 'object') throw new HttpError(422, 'validation_error', { file: 'required' });
    if (file.size > 8 * 1024 * 1024) throw new HttpError(413, 'attachment_too_large');
    const buf = new Uint8Array(await file.arrayBuffer());
    const type = sniff(buf);
    if (!type || !type.startsWith('image/')) throw new HttpError(415, 'attachment_type_not_allowed');
    const id = uid(), key = `photos/${s.companyId}/${c.params.id}/${id}`;
    await c.env.FILES.put(key, buf, { httpMetadata: { contentType: type } });
    await c.env.DB.prepare('INSERT INTO property_photos (id,company_id,property_id,r2_key,content_type,caption,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(id, s.companyId, c.params.id, key, type, String(form.get('caption') || '').slice(0, 200) || null, nowIso()).run();
    return json({ id }, 201);
  });
  r.get('/api/photos/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'properties.read');
    const ph = await c.env.DB.prepare('SELECT * FROM property_photos WHERE id=? AND company_id=?').bind(c.params.id, s.companyId).first<any>();
    if (!ph) throw new HttpError(404, 'not_found');
    const obj = await c.env.FILES?.get(ph.r2_key);
    if (!obj) throw new HttpError(404, 'not_found');
    return new Response(obj.body, { headers: { 'content-type': ph.content_type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=300', 'content-security-policy': "default-src 'none'" } });
  });
  r.del('/api/photos/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'properties.write');
    const ph = await c.env.DB.prepare('SELECT * FROM property_photos WHERE id=? AND company_id=?').bind(c.params.id, s.companyId).first<any>();
    if (!ph) throw new HttpError(404, 'not_found');
    await c.env.FILES?.delete(ph.r2_key);
    await c.env.DB.prepare('DELETE FROM property_photos WHERE id=?').bind(ph.id).run();
    return json({ ok: true });
  });

  r.get('/api/properties/:id/history', async (c) => {
    const s = await requirePerm(c.env, c.session, 'properties.read');
    await owned(c.env, 'residential_properties', c.params.id, s.companyId);
    const { results } = await c.env.DB.prepare(`
      SELECT a.id,a.date,a.start_time,a.status,a.base_price_cents,a.notes,sv.name AS service_name,
             ar.amount_cents AS invoiced_cents, ar.status AS payment_status,
             (SELECT GROUP_CONCAT(h.full_name, ', ') FROM appointment_helpers ah JOIN helper_records h ON h.id=ah.helper_id WHERE ah.appointment_id=a.id) AS helpers,
             (SELECT COALESCE(SUM(CASE WHEN kind='addon' THEN amount_cents ELSE -amount_cents END),0) FROM appointment_price_items i WHERE i.appointment_id=a.id) AS adjustments_cents
        FROM cleaning_appointments a LEFT JOIN cleaning_services sv ON sv.id=a.service_id
        LEFT JOIN accounts_receivable ar ON ar.appointment_id=a.id
       WHERE a.company_id=? AND a.property_id=? ORDER BY a.date DESC, a.start_time DESC LIMIT 500`).bind(s.companyId, c.params.id).all();
    const next = await c.env.DB.prepare(`SELECT id,date,start_time FROM cleaning_appointments WHERE company_id=? AND property_id=? AND date>=? AND status NOT IN ('completed','canceled') ORDER BY date,start_time LIMIT 1`).bind(s.companyId, c.params.id, todayIn(s.timezone)).first();
    return json({ items: results, next });
  });

  // ───────── Services ─────────
  r.get('/api/services', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.read');
    const { results } = await c.env.DB.prepare('SELECT * FROM cleaning_services WHERE company_id=? ORDER BY active DESC, name').bind(s.companyId).all();
    return json({ items: results });
  });
  const serviceSchema = {
    name: { type: 'string', required: true, max: 120 }, category: { type: 'enum', values: ['residential', 'deep', 'move', 'additional', 'other'] },
    description: { type: 'string', max: 2000 }, estimated_minutes: { type: 'int', min: 15, max: 1440 }, default_price: { type: 'money' },
    currency: { type: 'string', max: 3 }, checklist: { type: 'string', max: 4000 }, active: { type: 'bool' },
  } as const;
  r.post('/api/services', async (c) => {
    const s = await requirePerm(c.env, c.session, 'services.write');
    const v = validate(await c.body(), serviceSchema);
    const id = uid();
    await c.env.DB.prepare('INSERT INTO cleaning_services (id,company_id,name,category,description,estimated_minutes,default_price_cents,currency,checklist,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, s.companyId, v.name, v.category || 'residential', v.description ?? null, v.estimated_minutes ?? null, v.default_price ?? 0, assertCurrency(v.currency, s.currency), v.checklist ?? null, v.active ?? 1, nowIso()).run();
    return json({ id }, 201);
  });
  r.put('/api/services/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'services.write');
    await owned(c.env, 'cleaning_services', c.params.id, s.companyId);
    const v: any = validate(await c.body(), serviceSchema, true);
    if (v.currency) assertCurrency(v.currency, s.currency);
    // Editing a default price NEVER overwrites negotiated property prices (separate table) or appointment snapshots.
    const cols = Object.keys(v).map((k) => (k === 'default_price' ? 'default_price_cents' : k));
    if (!cols.length) throw new HttpError(422, 'nothing_to_update');
    await c.env.DB.prepare(`UPDATE cleaning_services SET ${cols.map((x) => `${x}=?`).join(',')} WHERE id=? AND company_id=?`).bind(...Object.values(v), c.params.id, s.companyId).run();
    return json({ ok: true });
  });

  // ───────── Helpers ─────────
  r.get('/api/helpers', async (c) => {
    const s = await requirePerm(c.env, c.session, 'helpers.read');
    const where = ['company_id=?']; const args: any[] = [s.companyId];
    const q = c.query.get('q'); if (q) { where.push("full_name LIKE ? ESCAPE '\\'"); args.push(likeParam(q)); }
    const st = c.query.get('status') || 'active'; if (st !== 'all') { where.push('status=?'); args.push(st); }
    const { results } = await c.env.DB.prepare(`SELECT * FROM helper_records WHERE ${where.join(' AND ')} ORDER BY favorite DESC, full_name`).bind(...args).all();
    return json({ items: results });
  });
  r.post('/api/helpers', async (c) => {
    const s = await requirePerm(c.env, c.session, 'helpers.write');
    const v = validate(await c.body(), helperSchema);
    const id = uid(), now = nowIso();
    await c.env.DB.prepare(`INSERT INTO helper_records (id,company_id,full_name,state,city,whatsapp,phone,language,main_function,email,experience,skills,availability,certifications,description,favorite,default_pay_basis,default_rate_cents,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, s.companyId, v.full_name, v.state.toUpperCase(), v.city, v.whatsapp, v.phone, v.language || 'en', v.main_function, v.email ?? null, v.experience ?? null, v.skills ?? null,
        v.availability ?? null, v.certifications ?? null, v.description ?? null, v.favorite ?? 0, v.default_pay_basis || 'fixed', v.default_rate ?? 0, now, now).run();
    await audit(c.env, s, 'create', 'helper', id);
    return json({ id }, 201);
  });
  r.get('/api/helpers/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'helpers.read');
    const h = await owned(c.env, 'helper_records', c.params.id, s.companyId);
    const rates = (await c.env.DB.prepare('SELECT r.property_id, r.pay_basis, r.rate_cents, p.name FROM helper_payment_rates r JOIN residential_properties p ON p.id=r.property_id WHERE r.helper_id=? AND r.company_id=?').bind(c.params.id, s.companyId).all()).results;
    const history = (await c.env.DB.prepare(`SELECT a.id,a.date,a.start_time,a.status,ah.attendance,ah.pay_basis,ah.rate_cents,p.name AS property_name FROM appointment_helpers ah
      JOIN cleaning_appointments a ON a.id=ah.appointment_id JOIN residential_properties p ON p.id=a.property_id WHERE ah.helper_id=? AND ah.company_id=? ORDER BY a.date DESC LIMIT 200`).bind(c.params.id, s.companyId).all()).results;
    return json({ helper: h, rates, history });
  });
  r.put('/api/helpers/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'helpers.write');
    await owned(c.env, 'helper_records', c.params.id, s.companyId);
    const v: any = validate(await c.body(), helperSchema, true);
    if (v.state) v.state = v.state.toUpperCase();
    const u = updateSql('helper_records', v, { default_rate: 'default_rate_cents' });
    await c.env.DB.prepare(u.sql).bind(...u.values, nowIso(), c.params.id, s.companyId).run();
    await audit(c.env, s, 'update', 'helper', c.params.id, Object.keys(v));
    return json({ ok: true });
  });
  r.put('/api/helpers/:id/rates', async (c) => {
    const s = await requirePerm(c.env, c.session, 'helpers.write');
    await owned(c.env, 'helper_records', c.params.id, s.companyId);
    const v = validate(await c.body(), { property_id: { type: 'string', required: true }, pay_basis: { type: 'enum', values: BASIS, required: true }, rate: { type: 'money', required: true } });
    await owned(c.env, 'residential_properties', v.property_id, s.companyId);
    await c.env.DB.prepare(`INSERT INTO helper_payment_rates (company_id,helper_id,property_id,pay_basis,rate_cents) VALUES (?,?,?,?,?)
      ON CONFLICT(helper_id,property_id) DO UPDATE SET pay_basis=excluded.pay_basis, rate_cents=excluded.rate_cents`).bind(s.companyId, c.params.id, v.property_id, v.pay_basis, v.rate).run();
    return json({ ok: true });
  });
  r.get('/api/helpers/:id/notes', async (c) => {
    const s = await requirePerm(c.env, c.session, 'helpers.private');
    await owned(c.env, 'helper_records', c.params.id, s.companyId);
    const { results } = await c.env.DB.prepare('SELECT * FROM helper_private_notes WHERE helper_id=? AND company_id=? ORDER BY created_at DESC').bind(c.params.id, s.companyId).all();
    return json({ items: results });
  });
  r.post('/api/helpers/:id/notes', async (c) => {
    const s = await requirePerm(c.env, c.session, 'helpers.private');
    await owned(c.env, 'helper_records', c.params.id, s.companyId);
    const v = validate(await c.body(), { kind: { type: 'enum', values: ['note', 'evaluation'], required: true }, rating: { type: 'int', min: 1, max: 5 }, body: { type: 'string', required: true, max: 4000 } });
    const id = uid();
    await c.env.DB.prepare('INSERT INTO helper_private_notes (id,company_id,helper_id,kind,rating,body,author_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, s.companyId, c.params.id, v.kind, v.kind === 'evaluation' ? v.rating ?? null : null, v.body, s.userId, nowIso()).run();
    return json({ id }, 201);
  });

  // ───────── Teams ─────────
  r.get('/api/teams', async (c) => {
    const s = await requirePerm(c.env, c.session, 'helpers.read');
    const { results } = await c.env.DB.prepare(`SELECT t.id,t.name,(SELECT GROUP_CONCAT(h.id || ':' || h.full_name, '|') FROM team_members m JOIN helper_records h ON h.id=m.helper_id WHERE m.team_id=t.id) AS members
      FROM teams t WHERE t.company_id=? ORDER BY t.name`).bind(s.companyId).all<any>();
    return json({ items: results.map((t) => ({ ...t, members: (t.members || '').split('|').filter(Boolean).map((x: string) => { const [id, ...n] = x.split(':'); return { id, full_name: n.join(':') }; }) })) });
  });
  r.post('/api/teams', async (c) => {
    const s = await requirePerm(c.env, c.session, 'helpers.write');
    const v = validate(await c.body(), { name: { type: 'string', required: true, max: 80 } });
    const id = uid();
    await c.env.DB.prepare('INSERT INTO teams (id,company_id,name,created_at) VALUES (?,?,?,?)').bind(id, s.companyId, v.name, nowIso()).run();
    return json({ id }, 201);
  });
  r.put('/api/teams/:id/members', async (c) => {
    const s = await requirePerm(c.env, c.session, 'helpers.write');
    await owned(c.env, 'teams', c.params.id, s.companyId);
    const b = await c.body();
    if (!Array.isArray(b?.helper_ids)) throw new HttpError(422, 'validation_error', { helper_ids: 'array' });
    for (const h of b.helper_ids) await owned(c.env, 'helper_records', h, s.companyId);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM team_members WHERE team_id=? AND company_id=?').bind(c.params.id, s.companyId),
      ...b.helper_ids.map((h: string) => c.env.DB.prepare('INSERT INTO team_members (team_id,helper_id,company_id) VALUES (?,?,?)').bind(c.params.id, h, s.companyId)),
    ]);
    return json({ ok: true });
  });
  r.del('/api/teams/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'helpers.write');
    await owned(c.env, 'teams', c.params.id, s.companyId);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM team_members WHERE team_id=? AND company_id=?').bind(c.params.id, s.companyId),
      c.env.DB.prepare('DELETE FROM teams WHERE id=? AND company_id=?').bind(c.params.id, s.companyId),
    ]);
    return json({ ok: true });
  });
}
