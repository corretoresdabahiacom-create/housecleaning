// Mobile features: Web Push subscriptions and the helper "My day" view.
import { Ctx, HttpError, Router, json, nowIso, todayIn, uid, validate } from '../lib/core';
import { audit, decrypt, rateLimit } from '../lib/security';
import { notifyUsers, pushConfigured, pushText, staffUserIds } from '../lib/webpush';
import { completeAppointment } from './schedule';

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

export function mobileRoutes(r: Router) {
  // ── Web Push ──
  r.get('/api/push/config', async (c) => json({ public_key: pushConfigured(c.env) ? c.env.VAPID_PUBLIC_KEY : null }));
  r.post('/api/push/subscribe', async (c) => {
    const s = c.session!;
    await rateLimit(c.env, `push:${s.userId}`, 30, 3600);
    const b = await c.body();
    const endpoint = String(b?.endpoint || ''), p256dh = String(b?.keys?.p256dh || ''), auth = String(b?.keys?.auth || '');
    let ok = false;
    try { ok = new URL(endpoint).protocol === 'https:' && endpoint.length <= 1000; } catch { /* invalid */ }
    if (!ok || p256dh.length < 80 || p256dh.length > 100 || auth.length < 16 || auth.length > 40) throw new HttpError(422, 'validation_error', { subscription: 'invalid' });
    // An endpoint belongs to one browser profile; re-subscribing (e.g. after another user signed in) moves it to the current user.
    await c.env.DB.prepare(`INSERT INTO push_subscriptions (id,user_id,company_id,endpoint,p256dh,auth,user_agent,created_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, company_id=excluded.company_id, p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent`)
      .bind(uid(), s.userId, s.companyId, endpoint, p256dh, auth, (c.req.headers.get('user-agent') || '').slice(0, 200), nowIso()).run();
    return json({ ok: true }, 201);
  });
  r.post('/api/push/unsubscribe', async (c) => {
    const b = await c.body();
    await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').bind(String(b?.endpoint || ''), c.session!.userId).run();
    return json({ ok: true });
  });
  r.post('/api/push/test', async (c) => {
    const s = c.session!;
    await rateLimit(c.env, `push_test:${s.userId}`, 5, 3600);
    if (!pushConfigured(c.env)) throw new HttpError(503, 'push_not_configured');
    const res = await notifyUsers(c.env, s.companyId, [s.userId], { title: 'House Cleaning', body: '✓', url: '/', tag: 'test' });
    return json(res);
  });

  // ── Helper "My day" ──
  const helperOnly = (s: { helperId: string | null }) => { if (!s.helperId) throw new HttpError(403, 'not_a_helper'); return s.helperId; };

  r.get('/api/my-day', async (c) => {
    const s = c.session!; const helperId = helperOnly(s);
    const today = todayIn(s.timezone);
    const date = c.query.get('date') || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(422, 'validation_error', { date: 'date' });
    if (Math.abs(Date.parse(date) - Date.parse(today)) > 60 * 864e5) throw new HttpError(422, 'range_too_large');
    const { results } = await c.env.DB.prepare(`SELECT a.id, a.date, a.start_time, a.duration_minutes, a.status, a.customer_instructions, a.internal_instructions, a.property_id,
        p.name AS property_name, p.street, p.unit, p.city, p.state, p.zip, p.special_instructions, p.pets, p.parking, p.bedrooms, p.bathrooms,
        cu.full_name AS customer_name, sv.name AS service_name, ah.done_at, ah.done_minutes,
        (SELECT GROUP_CONCAT(h.full_name, ', ') FROM appointment_helpers x JOIN helper_records h ON h.id=x.helper_id WHERE x.appointment_id=a.id AND x.helper_id<>ah.helper_id AND x.attendance<>'canceled') AS teammates
      FROM appointment_helpers ah JOIN cleaning_appointments a ON a.id=ah.appointment_id
      JOIN residential_properties p ON p.id=a.property_id JOIN customers cu ON cu.id=a.customer_id LEFT JOIN cleaning_services sv ON sv.id=a.service_id
     WHERE ah.company_id=? AND ah.helper_id=? AND a.date=? AND ah.attendance<>'canceled' AND a.status NOT IN ('canceled','rescheduled')
     ORDER BY a.start_time`).bind(s.companyId, helperId, date).all<any>();
    // Access instructions (door codes, keys) are shown only for today and tomorrow, only to an assigned helper, and each read is audited.
    const showAccess = date >= today && date <= addDays(today, 1);
    const items: any[] = [];
    for (const a of results) {
      let access: string | null = null;
      if (showAccess) {
        const row = await c.env.DB.prepare('SELECT * FROM property_access_instructions WHERE property_id=? AND company_id=?').bind(a.property_id, s.companyId).first<any>();
        if (row) { access = await decrypt(c.env, row.ciphertext, row.iv, `${s.companyId}:${a.property_id}`, row.key_version); await audit(c.env, s, 'read', 'property_access', a.property_id, { via: 'my_day' }); }
      }
      const { property_id: _p, ...rest } = a;
      items.push({ ...rest, access_instructions: access });
    }
    const co = await c.env.DB.prepare('SELECT helpers_can_complete FROM companies WHERE id=?').bind(s.companyId).first<any>();
    return json({ date, today, items, helpers_can_complete: !!co?.helpers_can_complete });
  });

  async function myAppointment(c: Ctx) {
    const s = c.session!; const helperId = helperOnly(s);
    const a: any = await c.env.DB.prepare(`SELECT a.*, ah.done_at FROM cleaning_appointments a JOIN appointment_helpers ah ON ah.appointment_id=a.id AND ah.helper_id=? AND ah.company_id=a.company_id
      WHERE a.id=? AND a.company_id=? AND ah.attendance<>'canceled'`).bind(helperId, c.params.id, s.companyId).first();
    if (!a) throw new HttpError(404, 'not_found');
    if (['completed', 'canceled', 'rescheduled'].includes(a.status)) throw new HttpError(409, 'appointment_closed');
    if (a.date > todayIn(s.timezone)) throw new HttpError(409, 'not_today');
    return { s, helperId, a };
  }

  r.post('/api/my-day/:id/start', async (c) => {
    const { s, a } = await myAppointment(c);
    if (a.status !== 'in_progress') {
      const now = nowIso();
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE cleaning_appointments SET status='in_progress', updated_at=? WHERE id=? AND company_id=?").bind(now, a.id, s.companyId),
        c.env.DB.prepare('INSERT INTO appointment_status_history (id,company_id,appointment_id,from_status,to_status,changed_by,changed_at) VALUES (?,?,?,?,?,?,?)').bind(uid(), s.companyId, a.id, a.status, 'in_progress', s.userId, now),
      ]);
    }
    return json({ ok: true });
  });

  // The helper reports "done". The appointment is finalized (receivable + helper payables) only if the company enabled
  // "helpers can complete" AND every assigned helper has reported; otherwise staff are notified to confirm.
  r.post('/api/my-day/:id/finish', async (c) => {
    const { s, helperId, a } = await myAppointment(c);
    const v = validate(await c.body(), { worked_minutes: { type: 'int', min: 1, max: 1440 } });
    const minutes = v.worked_minutes ?? a.duration_minutes;
    await c.env.DB.prepare('UPDATE appointment_helpers SET done_at=COALESCE(done_at, ?), done_minutes=? WHERE appointment_id=? AND helper_id=? AND company_id=?').bind(nowIso(), minutes, a.id, helperId, s.companyId).run();
    await audit(c.env, s, 'helper_done', 'appointment', a.id, { minutes });
    const pending = await c.env.DB.prepare("SELECT COUNT(*) n FROM appointment_helpers WHERE appointment_id=? AND company_id=? AND attendance<>'canceled' AND done_at IS NULL").bind(a.id, s.companyId).first<any>();
    const co = await c.env.DB.prepare('SELECT helpers_can_complete FROM companies WHERE id=?').bind(s.companyId).first<any>();
    let completed = false;
    if (co?.helpers_can_complete && pending.n === 0) {
      const rows = (await c.env.DB.prepare("SELECT helper_id, done_minutes FROM appointment_helpers WHERE appointment_id=? AND company_id=? AND attendance<>'canceled'").bind(a.id, s.companyId).all<any>()).results;
      await completeAppointment(c.env, s, a, rows.map((x) => ({ helper_id: x.helper_id, attendance: 'completed', worked_minutes: x.done_minutes ?? a.duration_minutes })));
      await audit(c.env, s, 'status', 'appointment', a.id, { from: a.status, to: 'completed', by: 'helper' });
      completed = true;
    } else {
      const staff = await staffUserIds(c.env, s.companyId);
      await notifyUsers(c.env, s.companyId, staff, (lang) => ({ title: pushText('service_finished', lang), body: `${a.date} ${a.start_time}`, url: '/#/schedule', tag: `done-${a.id}` }));
    }
    return json({ ok: true, completed, waiting_for_helpers: pending.n });
  });
}
