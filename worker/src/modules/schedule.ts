import { Env, HttpError, Router, Session, hourlyAmount, json, nowIso, todayIso, uid, validate } from '../lib/core';
import { occurrences, overlaps } from '../lib/recurrence';
import { audit, owned, requirePerm } from '../lib/security';
import { helperLaborCategory } from './seed';

const FREQ = ['once', 'daily', 'weekly', 'twice_weekly', 'biweekly', 'triweekly', 'monthly', 'bimonthly', 'custom'] as const;
const STATUSES = ['scheduled', 'confirmed', 'in_progress', 'completed', 'canceled', 'rescheduled', 'customer_unavailable', 'pending_confirmation'] as const;
const OPEN = ['scheduled', 'confirmed', 'pending_confirmation'];
export const HORIZON_DAYS = 90;

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/** Negotiated property/service price wins; a service default price never overrides it. */
export async function resolvePrice(env: Env, companyId: string, property: any, serviceId: string | null) {
  if (serviceId) {
    const p = await env.DB.prepare('SELECT price_cents FROM property_service_prices WHERE property_id=? AND service_id=? AND company_id=?').bind(property.id, serviceId, companyId).first<any>();
    if (p) return p.price_cents as number;
  }
  return property.price_cents as number;
}

/** Rate precedence: helper×property negotiated rate → default team row → helper default. */
async function resolveRate(env: Env, companyId: string, helperId: string, propertyId: string) {
  const r = await env.DB.prepare('SELECT pay_basis, rate_cents FROM helper_payment_rates WHERE helper_id=? AND property_id=? AND company_id=?').bind(helperId, propertyId, companyId).first<any>();
  if (r) return r;
  const d = await env.DB.prepare('SELECT pay_basis, rate_cents FROM property_default_helpers WHERE helper_id=? AND property_id=? AND company_id=?').bind(helperId, propertyId, companyId).first<any>();
  if (d) return d;
  const h = await env.DB.prepare('SELECT default_pay_basis AS pay_basis, default_rate_cents AS rate_cents FROM helper_records WHERE id=? AND company_id=?').bind(helperId, companyId).first<any>();
  return h;
}

interface HelperIn { helper_id: string; pay_basis?: string; rate?: number }
async function normalizeHelpers(env: Env, s: Session, propertyId: string, input: unknown): Promise<{ helper_id: string; pay_basis: string; rate_cents: number }[]> {
  let list: HelperIn[];
  if (input === undefined || input === null) {
    list = (await env.DB.prepare('SELECT helper_id FROM property_default_helpers WHERE property_id=? AND company_id=?').bind(propertyId, s.companyId).all<any>()).results;
  } else {
    if (!Array.isArray(input)) throw new HttpError(422, 'validation_error', { helpers: 'array' });
    list = input.map((h: any) => validate(h, { helper_id: { type: 'string', required: true }, pay_basis: { type: 'enum', values: ['fixed', 'daily', 'hourly', 'other'] }, rate: { type: 'money' } }) as any);
  }
  const seen = new Set<string>(); const out: { helper_id: string; pay_basis: string; rate_cents: number }[] = [];
  for (const h of list) {
    if (seen.has(h.helper_id)) continue; seen.add(h.helper_id);
    await owned(env, 'helper_records', h.helper_id, s.companyId);
    const base = await resolveRate(env, s.companyId, h.helper_id, propertyId);
    out.push({ helper_id: h.helper_id, pay_basis: h.pay_basis || base.pay_basis, rate_cents: h.rate ?? base.rate_cents });
  }
  return out;
}

/** Returns overlapping assignments for the given helpers (warnings; caller may override with force=true). */
export async function findConflicts(env: Env, companyId: string, helperIds: string[], date: string, start: string, dur: number, excludeId?: string) {
  if (!helperIds.length) return [];
  const { results } = await env.DB.prepare(`SELECT a.id, a.start_time, a.duration_minutes, ah.helper_id, h.full_name, p.name AS property_name
      FROM appointment_helpers ah JOIN cleaning_appointments a ON a.id=ah.appointment_id
      JOIN helper_records h ON h.id=ah.helper_id JOIN residential_properties p ON p.id=a.property_id
     WHERE ah.company_id=? AND a.date=? AND a.status NOT IN ('canceled','rescheduled') AND ah.attendance<>'canceled'
       AND ah.helper_id IN (${helperIds.map(() => '?').join(',')})`).bind(companyId, date, ...helperIds).all<any>();
  return results.filter((r) => r.id !== excludeId && overlaps(start, dur, r.start_time, r.duration_minutes))
    .map((r) => ({ helper_id: r.helper_id, helper_name: r.full_name, appointment_id: r.id, property_name: r.property_name, start_time: r.start_time }));
}

async function insertAppointment(env: Env, s: Session, a: any, helpers: { helper_id: string; pay_basis: string; rate_cents: number }[], ignoreDup = false) {
  const now = nowIso();
  const res = await env.DB.prepare(`INSERT INTO cleaning_appointments (id,company_id,property_id,customer_id,service_id,rule_id,occurrence_date,detached,date,start_time,duration_minutes,base_price_cents,currency,status,internal_instructions,customer_instructions,notes,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ${ignoreDup ? 'ON CONFLICT(rule_id, occurrence_date) DO NOTHING' : ''}`)
    .bind(a.id, s.companyId, a.property_id, a.customer_id, a.service_id ?? null, a.rule_id ?? null, a.occurrence_date ?? null, a.detached ?? 0, a.date, a.start_time,
      a.duration_minutes, a.base_price_cents, s.currency, a.status || 'scheduled', a.internal_instructions ?? null, a.customer_instructions ?? null, a.notes ?? null, now, now).run();
  if (!res.meta.changes) return false;
  const stmts = helpers.map((h) => env.DB.prepare('INSERT INTO appointment_helpers (company_id,appointment_id,helper_id,pay_basis,rate_cents) VALUES (?,?,?,?,?)').bind(s.companyId, a.id, h.helper_id, h.pay_basis, h.rate_cents));
  stmts.push(env.DB.prepare('INSERT INTO appointment_status_history (id,company_id,appointment_id,from_status,to_status,changed_by,changed_at) VALUES (?,?,?,?,?,?,?)').bind(uid(), s.companyId, a.id, null, a.status || 'scheduled', s.userId, now));
  await env.DB.batch(stmts);
  return true;
}

/** Generates appointments for a rule within [from, to]. Idempotent: UNIQUE(rule_id, occurrence_date). */
export async function generateForRule(env: Env, s: Session, rule: any, from: string, to: string) {
  if (!rule.active) return 0;
  const property: any = await owned(env, 'residential_properties', rule.property_id, s.companyId);
  if (property.status !== 'active') return 0;
  const price = await resolvePrice(env, s.companyId, property, rule.service_id);
  const helpers = await normalizeHelpers(env, s, property.id, null);
  let created = 0;
  for (const d of occurrences(rule, from, to)) {
    const ok = await insertAppointment(env, s, {
      id: uid(), property_id: property.id, customer_id: property.customer_id, service_id: rule.service_id, rule_id: rule.id, occurrence_date: d,
      date: d, start_time: rule.start_time, duration_minutes: rule.duration_minutes, base_price_cents: price,
    }, helpers, true);
    if (ok) created++;
  }
  return created;
}

/** Removes future, still-open, non-detached generated appointments of a rule (history is untouched). */
async function purgeFutureGenerated(env: Env, companyId: string, ruleId: string, fromDate: string) {
  const cond = `company_id=? AND rule_id=? AND detached=0 AND date>=? AND status IN ('scheduled','pending_confirmation')
                AND NOT EXISTS (SELECT 1 FROM accounts_receivable ar WHERE ar.appointment_id=cleaning_appointments.id)`;
  const sub = `SELECT id FROM cleaning_appointments WHERE ${cond}`;
  const args = [companyId, ruleId, fromDate];
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM appointment_helpers WHERE appointment_id IN (${sub})`).bind(...args),
    env.DB.prepare(`DELETE FROM appointment_price_items WHERE appointment_id IN (${sub})`).bind(...args),
    env.DB.prepare(`DELETE FROM appointment_status_history WHERE appointment_id IN (${sub})`).bind(...args),
    env.DB.prepare(`DELETE FROM cleaning_appointments WHERE ${cond}`).bind(...args),
  ]);
}

async function loadAppointment(env: Env, companyId: string, id: string) {
  const a: any = await owned(env, 'cleaning_appointments', id, companyId);
  const helpers = (await env.DB.prepare('SELECT ah.*, h.full_name, h.whatsapp FROM appointment_helpers ah JOIN helper_records h ON h.id=ah.helper_id WHERE ah.appointment_id=? AND ah.company_id=?').bind(id, companyId).all()).results;
  const items = (await env.DB.prepare('SELECT * FROM appointment_price_items WHERE appointment_id=? AND company_id=?').bind(id, companyId).all<any>()).results;
  const addons = items.filter((i) => i.kind === 'addon').reduce((t, i) => t + i.amount_cents, 0);
  const discounts = items.filter((i) => i.kind === 'discount').reduce((t, i) => t + i.amount_cents, 0);
  return { ...a, helpers, items, addons_cents: addons, discounts_cents: discounts, total_cents: a.base_price_cents + addons - discounts };
}

function assertEditable(a: any) {
  if (a.status === 'completed') throw new HttpError(409, 'completed_is_immutable');
  if (a.status === 'canceled' || a.status === 'rescheduled') throw new HttpError(409, 'appointment_closed');
}

/** Completion: creates the receivable and helper payables atomically. Duplicate-proof via UNIQUE constraints. */
async function completeAppointment(env: Env, s: Session, a: any, attendanceIn: any[] | undefined) {
  const att = new Map<string, { attendance: string; worked_minutes?: number }>();
  for (const x of attendanceIn || []) {
    const v = validate(x, { helper_id: { type: 'string', required: true }, attendance: { type: 'enum', values: ['completed', 'absent'], required: true }, worked_minutes: { type: 'int', min: 1, max: 1440 } });
    att.set(v.helper_id, v);
  }
  const full = await loadAppointment(env, s.companyId, a.id);
  const service: any = full.service_id ? await env.DB.prepare('SELECT category FROM cleaning_services WHERE id=? AND company_id=?').bind(full.service_id, s.companyId).first() : null;
  const property: any = await env.DB.prepare('SELECT name FROM residential_properties WHERE id=?').bind(full.property_id).first();
  const cat = await helperLaborCategory(env, s.companyId);
  const now = nowIso();
  const stmts = [
    env.DB.prepare(`UPDATE cleaning_appointments SET status='completed', completed_at=?, updated_at=? WHERE id=? AND company_id=? AND status<>'completed'`).bind(now, now, a.id, s.companyId),
    env.DB.prepare(`INSERT INTO accounts_receivable (id,company_id,customer_id,property_id,appointment_id,description,revenue_class,gross_cents,discount_cents,amount_cents,currency,issue_date,due_date,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(uid(), s.companyId, full.customer_id, full.property_id, full.id, `Cleaning ${full.date} — ${property?.name ?? ''}`,
      service?.category === 'additional' ? 'additional' : service?.category || 'residential', full.base_price_cents + full.addons_cents, full.discounts_cents, full.total_cents, full.currency, full.date, full.date, now),
  ];
  for (const h of full.helpers as any[]) {
    const x = att.get(h.helper_id);
    const attendance = x?.attendance || 'completed';
    const minutes = x?.worked_minutes ?? h.worked_minutes ?? full.duration_minutes;
    stmts.push(env.DB.prepare('UPDATE appointment_helpers SET attendance=?, worked_minutes=? WHERE appointment_id=? AND helper_id=? AND company_id=?').bind(attendance, minutes, full.id, h.helper_id, s.companyId));
    if (attendance !== 'completed') continue; // absent helpers are never payable
    const amount = h.pay_basis === 'hourly' ? hourlyAmount(h.rate_cents, minutes) : h.rate_cents;
    if (amount <= 0) continue;
    stmts.push(env.DB.prepare(`INSERT INTO accounts_payable (id,company_id,kind,category_id,payee,description,amount_cents,currency,issue_date,due_date,property_id,appointment_id,helper_id,created_at)
      VALUES (?,?,'helper',?,?,?,?,?,?,?,?,?,?,?)`).bind(uid(), s.companyId, cat, h.full_name, `Cleaning ${full.date} — ${property?.name ?? ''} (${h.pay_basis})`, amount, full.currency, full.date, full.date, full.property_id, full.id, h.helper_id, now));
  }
  stmts.push(env.DB.prepare('INSERT INTO appointment_status_history (id,company_id,appointment_id,from_status,to_status,changed_by,changed_at) VALUES (?,?,?,?,?,?,?)').bind(uid(), s.companyId, full.id, a.status, 'completed', s.userId, now));
  await env.DB.batch(stmts); // atomic: all-or-nothing
}

export function scheduleRoutes(r: Router) {
  r.get('/api/appointments', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.read');
    const from = c.query.get('from') || todayIso(); const to = c.query.get('to') || addDays(from, 7);
    if (Date.parse(to) - Date.parse(from) > 400 * 864e5) throw new HttpError(422, 'range_too_large');
    const where = ['a.company_id=?', 'a.date>=?', 'a.date<=?']; const args: any[] = [s.companyId, from, to];
    for (const [q, col] of [['customer_id', 'a.customer_id'], ['property_id', 'a.property_id'], ['service_id', 'a.service_id'], ['status', 'a.status'], ['city', 'p.city'], ['state', 'p.state']] as const) {
      const v = c.query.get(q); if (v) { where.push(`${col}=?`); args.push(v); }
    }
    const helper = c.query.get('helper_id');
    if (helper) { where.push('EXISTS (SELECT 1 FROM appointment_helpers x WHERE x.appointment_id=a.id AND x.helper_id=?)'); args.push(helper); }
    const team = c.query.get('team_id');
    if (team) { where.push('EXISTS (SELECT 1 FROM appointment_helpers x JOIN team_members tm ON tm.helper_id=x.helper_id WHERE x.appointment_id=a.id AND tm.team_id=? AND tm.company_id=a.company_id)'); args.push(team); }
    const { results } = await c.env.DB.prepare(`SELECT a.id,a.date,a.start_time,a.duration_minutes,a.status,a.base_price_cents,a.property_id,a.customer_id,a.service_id,a.rule_id,
        p.name AS property_name, p.street, p.unit, p.city, p.state, p.zip, cu.full_name AS customer_name, sv.name AS service_name,
        (SELECT GROUP_CONCAT(h.full_name, ', ') FROM appointment_helpers ah JOIN helper_records h ON h.id=ah.helper_id WHERE ah.appointment_id=a.id) AS helpers
       FROM cleaning_appointments a JOIN residential_properties p ON p.id=a.property_id JOIN customers cu ON cu.id=a.customer_id LEFT JOIN cleaning_services sv ON sv.id=a.service_id
      WHERE ${where.join(' AND ')} ORDER BY a.date, a.start_time LIMIT 2000`).bind(...args).all();
    return json({ items: results, from, to });
  });

  r.get('/api/appointments/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.read');
    const a = await loadAppointment(c.env, s.companyId, c.params.id);
    const history = (await c.env.DB.prepare('SELECT from_status,to_status,changed_at FROM appointment_status_history WHERE appointment_id=? AND company_id=? ORDER BY changed_at').bind(a.id, s.companyId).all()).results;
    const property = await c.env.DB.prepare('SELECT id,name,street,unit,city,state,zip FROM residential_properties WHERE id=? AND company_id=?').bind(a.property_id, s.companyId).first();
    return json({ appointment: a, history, property });
  });

  r.post('/api/appointments', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.write');
    const b = await c.body();
    const v = validate(b, {
      property_id: { type: 'string', required: true }, service_id: { type: 'string' }, date: { type: 'date', required: true }, start_time: { type: 'time', required: true },
      duration_minutes: { type: 'int', min: 15, max: 1440 }, price: { type: 'money' }, status: { type: 'enum', values: ['scheduled', 'confirmed', 'pending_confirmation'] },
      internal_instructions: { type: 'string', max: 4000 }, customer_instructions: { type: 'string', max: 4000 }, notes: { type: 'string', max: 4000 }, force: { type: 'bool' },
    });
    const p: any = await owned(c.env, 'residential_properties', v.property_id, s.companyId);
    let serviceMinutes: number | null = null;
    if (v.service_id) serviceMinutes = ((await owned(c.env, 'cleaning_services', v.service_id, s.companyId)) as any).estimated_minutes;
    const helpers = await normalizeHelpers(c.env, s, p.id, b.helpers);
    const dur = v.duration_minutes || p.estimated_minutes || serviceMinutes || 180;
    const conflicts = await findConflicts(c.env, s.companyId, helpers.map((h) => h.helper_id), v.date, v.start_time, dur);
    if (conflicts.length && !v.force) throw new HttpError(409, 'schedule_conflict', conflicts);
    const id = uid();
    await insertAppointment(c.env, s, { ...v, id, customer_id: p.customer_id, duration_minutes: dur, base_price_cents: v.price ?? (await resolvePrice(c.env, s.companyId, p, v.service_id)), detached: 1 }, helpers);
    await audit(c.env, s, 'create', 'appointment', id, conflicts.length ? { conflicts_overridden: conflicts.length } : undefined);
    return json({ id, warnings: conflicts }, 201);
  });

  r.put('/api/appointments/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.write');
    const a: any = await owned(c.env, 'cleaning_appointments', c.params.id, s.companyId);
    const v: any = validate(await c.body(), {
      service_id: { type: 'string' }, start_time: { type: 'time' }, duration_minutes: { type: 'int', min: 15, max: 1440 }, price: { type: 'money' },
      internal_instructions: { type: 'string', max: 4000 }, customer_instructions: { type: 'string', max: 4000 }, notes: { type: 'string', max: 4000 },
    }, true);
    const onlyNotes = Object.keys(v).every((k) => k === 'notes');
    if (!onlyNotes) assertEditable(a); // completed history is immutable except free-text notes
    if (v.service_id) await owned(c.env, 'cleaning_services', v.service_id, s.companyId);
    const map: Record<string, string> = { price: 'base_price_cents' };
    const cols = Object.keys(v).map((k) => map[k] ?? k);
    if (!cols.length) throw new HttpError(422, 'nothing_to_update');
    await c.env.DB.prepare(`UPDATE cleaning_appointments SET ${cols.map((x) => `${x}=?`).join(',')}, detached=CASE WHEN ? THEN detached ELSE 1 END, updated_at=? WHERE id=? AND company_id=?`)
      .bind(...Object.values(v), onlyNotes ? 1 : 0, nowIso(), a.id, s.companyId).run();
    return json({ ok: true });
  });

  r.put('/api/appointments/:id/helpers', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.write');
    const a: any = await owned(c.env, 'cleaning_appointments', c.params.id, s.companyId);
    assertEditable(a);
    const b = await c.body();
    const helpers = await normalizeHelpers(c.env, s, a.property_id, b?.helpers ?? []);
    const conflicts = await findConflicts(c.env, s.companyId, helpers.map((h) => h.helper_id), a.date, a.start_time, a.duration_minutes, a.id);
    if (conflicts.length && !b.force) throw new HttpError(409, 'schedule_conflict', conflicts);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM appointment_helpers WHERE appointment_id=? AND company_id=?').bind(a.id, s.companyId),
      ...helpers.map((h) => c.env.DB.prepare('INSERT INTO appointment_helpers (company_id,appointment_id,helper_id,pay_basis,rate_cents) VALUES (?,?,?,?,?)').bind(s.companyId, a.id, h.helper_id, h.pay_basis, h.rate_cents)),
      c.env.DB.prepare('UPDATE cleaning_appointments SET detached=1, updated_at=? WHERE id=?').bind(nowIso(), a.id),
    ]);
    return json({ ok: true, warnings: conflicts });
  });

  r.post('/api/appointments/:id/items', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.write');
    const a: any = await owned(c.env, 'cleaning_appointments', c.params.id, s.companyId);
    assertEditable(a);
    const v = validate(await c.body(), { kind: { type: 'enum', values: ['addon', 'discount'], required: true }, description: { type: 'string', required: true, max: 200 }, amount: { type: 'money', required: true, min: 1 } });
    const full = await loadAppointment(c.env, s.companyId, a.id);
    if (v.kind === 'discount' && full.total_cents - v.amount < 0) throw new HttpError(422, 'discount_exceeds_total');
    const id = uid();
    await c.env.DB.prepare('INSERT INTO appointment_price_items (id,company_id,appointment_id,kind,description,amount_cents) VALUES (?,?,?,?,?,?)').bind(id, s.companyId, a.id, v.kind, v.description, v.amount).run();
    return json({ id }, 201);
  });
  r.del('/api/appointments/:id/items/:itemId', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.write');
    const a: any = await owned(c.env, 'cleaning_appointments', c.params.id, s.companyId);
    assertEditable(a);
    await c.env.DB.prepare('DELETE FROM appointment_price_items WHERE id=? AND appointment_id=? AND company_id=?').bind(c.params.itemId, a.id, s.companyId).run();
    return json({ ok: true });
  });

  r.post('/api/appointments/:id/status', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.write');
    const a: any = await owned(c.env, 'cleaning_appointments', c.params.id, s.companyId);
    const b = await c.body();
    const v = validate(b, { status: { type: 'enum', values: STATUSES.filter((x) => x !== 'rescheduled'), required: true } });
    if (a.status === 'completed') throw new HttpError(409, 'completed_is_final');
    if (a.status === 'canceled' || a.status === 'rescheduled') throw new HttpError(409, 'appointment_closed');
    if (v.status === a.status) return json({ ok: true });
    if (v.status === 'completed') {
      await completeAppointment(c.env, s, a, b.attendance);
    } else {
      const now = nowIso();
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE cleaning_appointments SET status=?, detached=1, updated_at=? WHERE id=? AND company_id=?').bind(v.status, now, a.id, s.companyId),
        ...(v.status === 'canceled' ? [c.env.DB.prepare("UPDATE appointment_helpers SET attendance='canceled' WHERE appointment_id=? AND company_id=?").bind(a.id, s.companyId)] : []),
        c.env.DB.prepare('INSERT INTO appointment_status_history (id,company_id,appointment_id,from_status,to_status,changed_by,changed_at) VALUES (?,?,?,?,?,?,?)').bind(uid(), s.companyId, a.id, a.status, v.status, s.userId, now),
      ]);
    }
    await audit(c.env, s, 'status', 'appointment', a.id, { from: a.status, to: v.status });
    return json({ ok: true });
  });

  // Reschedule: keeps the original as 'rescheduled' (history) and creates a new linked appointment.
  r.post('/api/appointments/:id/reschedule', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.write');
    const b = await c.body();
    const v = validate(b, { date: { type: 'date', required: true }, start_time: { type: 'time', required: true }, force: { type: 'bool' } });
    const a = await loadAppointment(c.env, s.companyId, c.params.id);
    assertEditable(a);
    const helpers = (a.helpers as any[]).map((h) => ({ helper_id: h.helper_id, pay_basis: h.pay_basis, rate_cents: h.rate_cents }));
    const conflicts = await findConflicts(c.env, s.companyId, helpers.map((h) => h.helper_id), v.date, v.start_time, a.duration_minutes, a.id);
    if (conflicts.length && !v.force) throw new HttpError(409, 'schedule_conflict', conflicts);
    const id = uid(), now = nowIso();
    await insertAppointment(c.env, s, { ...a, id, rule_id: null, occurrence_date: null, detached: 1, date: v.date, start_time: v.start_time, status: 'scheduled',
      notes: [a.notes, `Rescheduled from ${a.date} ${a.start_time}`].filter(Boolean).join('\n') }, helpers);
    await c.env.DB.batch([
      ...(a.items as any[]).map((i) => c.env.DB.prepare('INSERT INTO appointment_price_items (id,company_id,appointment_id,kind,description,amount_cents) VALUES (?,?,?,?,?,?)').bind(uid(), s.companyId, id, i.kind, i.description, i.amount_cents)),
      c.env.DB.prepare("UPDATE cleaning_appointments SET status='rescheduled', detached=1, updated_at=? WHERE id=?").bind(now, a.id),
      c.env.DB.prepare('INSERT INTO appointment_status_history (id,company_id,appointment_id,from_status,to_status,changed_by,changed_at) VALUES (?,?,?,?,?,?,?)').bind(uid(), s.companyId, a.id, a.status, 'rescheduled', s.userId, now),
    ]);
    return json({ id, warnings: conflicts }, 201);
  });

  // ───────── Recurring rules ─────────
  const ruleSchema = {
    property_id: { type: 'string', required: true }, service_id: { type: 'string' }, frequency: { type: 'enum', values: FREQ, required: true },
    interval_days: { type: 'int', min: 1, max: 365 }, weekdays: { type: 'array' }, start_date: { type: 'date', required: true }, end_date: { type: 'date' },
    start_time: { type: 'time', required: true }, duration_minutes: { type: 'int', min: 15, max: 1440, required: true },
    paused_from: { type: 'date' }, paused_until: { type: 'date' }, exceptions: { type: 'array' }, active: { type: 'bool' },
  } as const;
  const norm = (v: any) => {
    if (v.weekdays) { if (!v.weekdays.every((x: any) => Number.isInteger(x) && x >= 0 && x <= 6)) throw new HttpError(422, 'validation_error', { weekdays: 'enum' }); v.weekdays = v.weekdays.join(','); }
    if (v.exceptions) { if (!v.exceptions.every((x: any) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x))) throw new HttpError(422, 'validation_error', { exceptions: 'date' }); v.exceptions = v.exceptions.join(','); }
    if (v.frequency === 'twice_weekly' && v.weekdays && v.weekdays.split(',').length !== 2) throw new HttpError(422, 'validation_error', { weekdays: 'two_required' });
    if (v.frequency === 'custom' && !v.interval_days) throw new HttpError(422, 'validation_error', { interval_days: 'required' });
    if (v.end_date && v.start_date && v.end_date < v.start_date) throw new HttpError(422, 'validation_error', { end_date: 'before_start' });
    return v;
  };

  r.get('/api/rules', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.read');
    const pid = c.query.get('property_id');
    const { results } = await c.env.DB.prepare(`SELECT r.*, p.name AS property_name FROM recurring_service_rules r JOIN residential_properties p ON p.id=r.property_id WHERE r.company_id=? ${pid ? 'AND r.property_id=?' : ''} ORDER BY p.name`)
      .bind(...(pid ? [s.companyId, pid] : [s.companyId])).all();
    return json({ items: results });
  });

  r.post('/api/rules', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.write');
    const v: any = norm(validate(await c.body(), ruleSchema));
    await owned(c.env, 'residential_properties', v.property_id, s.companyId);
    if (v.service_id) await owned(c.env, 'cleaning_services', v.service_id, s.companyId);
    const id = uid(), now = nowIso();
    await c.env.DB.prepare(`INSERT INTO recurring_service_rules (id,company_id,property_id,service_id,frequency,interval_days,weekdays,start_date,end_date,start_time,duration_minutes,paused_from,paused_until,exceptions,active,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, s.companyId, v.property_id, v.service_id ?? null, v.frequency, v.interval_days ?? null, v.weekdays ?? null, v.start_date, v.end_date ?? null,
      v.start_time, v.duration_minutes, v.paused_from ?? null, v.paused_until ?? null, v.exceptions ?? null, v.active ?? 1, now, now).run();
    const rule = await owned(c.env, 'recurring_service_rules', id, s.companyId);
    const from = v.start_date > todayIso() ? v.start_date : todayIso();
    const created = await generateForRule(c.env, s, rule, from, addDays(todayIso(), HORIZON_DAYS));
    await audit(c.env, s, 'create', 'recurring_rule', id, { created });
    return json({ id, generated: created }, 201);
  });

  // Modifying a rule affects only FUTURE open, non-manually-edited appointments. Completed/past history is never touched.
  r.put('/api/rules/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.write');
    const old: any = await owned(c.env, 'recurring_service_rules', c.params.id, s.companyId);
    const v: any = norm(validate(await c.body(), ruleSchema, true));
    delete v.property_id;
    if (v.service_id) await owned(c.env, 'cleaning_services', v.service_id, s.companyId);
    const cols = Object.keys(v);
    if (!cols.length) throw new HttpError(422, 'nothing_to_update');
    await c.env.DB.prepare(`UPDATE recurring_service_rules SET ${cols.map((x) => `${x}=?`).join(',')}, version=version+1, updated_at=? WHERE id=? AND company_id=?`).bind(...Object.values(v), nowIso(), old.id, s.companyId).run();
    const from = c.query.get('effective_from') && /^\d{4}-\d{2}-\d{2}$/.test(c.query.get('effective_from')!) && c.query.get('effective_from')! > todayIso() ? c.query.get('effective_from')! : todayIso();
    await purgeFutureGenerated(c.env, s.companyId, old.id, from);
    const rule = await owned(c.env, 'recurring_service_rules', old.id, s.companyId);
    const created = await generateForRule(c.env, s, rule, from, addDays(todayIso(), HORIZON_DAYS));
    await audit(c.env, s, 'update', 'recurring_rule', old.id, { fields: cols, regenerated: created });
    return json({ ok: true, regenerated: created });
  });

  r.post('/api/rules/:id/generate', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.write');
    const rule = await owned(c.env, 'recurring_service_rules', c.params.id, s.companyId);
    const created = await generateForRule(c.env, s, rule, todayIso(), addDays(todayIso(), HORIZON_DAYS));
    return json({ generated: created });
  });
}

/** Cron: extend horizon for all active rules of active companies (idempotent). */
export async function extendAllRules(env: Env) {
  const { results } = await env.DB.prepare(`SELECT r.*, c.currency FROM recurring_service_rules r JOIN companies c ON c.id=r.company_id WHERE r.active=1 AND c.status='active'`).all<any>();
  let total = 0;
  for (const rule of results) {
    const s = { userId: 'system', companyId: rule.company_id, currency: rule.currency } as Session;
    total += await generateForRule(env, s, rule, todayIso(), addDays(todayIso(), HORIZON_DAYS));
  }
  return total;
}
export { OPEN };
