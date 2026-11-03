import { Env, HttpError, Router, Session, formatMoney, json, nowIso, todayIn, todayIso, uid, validate } from '../lib/core';
import { audit, requirePerm, can } from '../lib/security';
import { toPdf, toXlsx } from '../lib/exporters';
import { computeCashFlow, computeDre, computeProfitability, helperPaymentsReport } from './finance';

/** CSV with formula-injection protection (cells starting with = + - @ are prefixed with '). */
export function toCsv(rows: Record<string, unknown>[], moneyCols: string[] = []) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (k: string, v: unknown) => {
    let s = v === null || v === undefined ? '' : moneyCols.includes(k) && typeof v === 'number' ? formatMoney(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !(moneyCols.includes(k) && /^-?\d/.test(s))) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((k) => cell(k, r[k])).join(','))].join('\n');
}

const FINANCIAL = new Set(['revenue-by-property', 'revenue-by-customer', 'revenue-by-service', 'expenses-by-category', 'receivables', 'payables', 'helper-payments', 'profitability', 'dre', 'cashflow', 'revenue-by-period', 'expenses-by-period']);

async function build(env: Env, s: Session, name: string, q: URLSearchParams): Promise<{ rows: any[]; money: string[] }> {
  const from = q.get('from') || '0000-01-01', to = q.get('to') || '9999-12-31';
  const all = async (sql: string, ...a: any[]) => (await env.DB.prepare(sql).bind(...a).all<any>()).results;
  const C = s.companyId;
  switch (name) {
    case 'customers': return { rows: await all('SELECT full_name,phone,email,language,status,created_at FROM customers WHERE company_id=? ORDER BY full_name', C), money: [] };
    case 'properties': return { rows: await all(`SELECT p.name,cu.full_name customer,p.street,p.unit,p.city,p.state,p.zip,p.frequency,p.price_cents price,p.status FROM residential_properties p JOIN customers cu ON cu.id=p.customer_id WHERE p.company_id=? ORDER BY p.state,p.city,p.name`, C), money: ['price'] };
    case 'properties-by-city': return { rows: await all(`SELECT state,city,COUNT(*) properties,SUM(status='active') active FROM residential_properties WHERE company_id=? GROUP BY state,city ORDER BY state,city`, C), money: [] };
    case 'properties-by-state': return { rows: await all(`SELECT state,COUNT(*) properties,SUM(status='active') active FROM residential_properties WHERE company_id=? GROUP BY state ORDER BY state`, C), money: [] };
    case 'recurring-customers': return { rows: await all(`SELECT DISTINCT cu.full_name customer,p.name property,r.frequency,r.start_time FROM recurring_service_rules r JOIN residential_properties p ON p.id=r.property_id JOIN customers cu ON cu.id=p.customer_id WHERE r.company_id=? AND r.active=1 AND r.frequency<>'once' ORDER BY cu.full_name`, C), money: [] };
    case 'appointments': case 'completed-cleanings': case 'canceled-appointments': {
      const st = name === 'completed-cleanings' ? "AND a.status='completed'" : name === 'canceled-appointments' ? "AND a.status='canceled'" : '';
      return { rows: await all(`SELECT a.date,a.start_time,a.status,p.name property,cu.full_name customer,sv.name service,a.base_price_cents price,
          (SELECT GROUP_CONCAT(h.full_name,'; ') FROM appointment_helpers ah JOIN helper_records h ON h.id=ah.helper_id WHERE ah.appointment_id=a.id) helpers
        FROM cleaning_appointments a JOIN residential_properties p ON p.id=a.property_id JOIN customers cu ON cu.id=a.customer_id LEFT JOIN cleaning_services sv ON sv.id=a.service_id
        WHERE a.company_id=? AND a.date BETWEEN ? AND ? ${st} ORDER BY a.date,a.start_time`, C, from, to), money: ['price'] };
    }
    case 'helper-assignments': return { rows: await all(`SELECT h.full_name helper,a.date,a.start_time,p.name property,p.city,ah.attendance,a.status FROM appointment_helpers ah JOIN cleaning_appointments a ON a.id=ah.appointment_id JOIN helper_records h ON h.id=ah.helper_id JOIN residential_properties p ON p.id=a.property_id WHERE ah.company_id=? AND a.date BETWEEN ? AND ? ORDER BY h.full_name,a.date`, C, from, to), money: [] };
    case 'helper-productivity': return { rows: await all(`SELECT h.full_name helper,SUM(ah.attendance='completed') completed,SUM(ah.attendance='absent') absent,COUNT(DISTINCT a.property_id) properties,COALESCE(SUM(CASE WHEN ah.attendance='completed' THEN ah.worked_minutes END),0) minutes FROM appointment_helpers ah JOIN cleaning_appointments a ON a.id=ah.appointment_id JOIN helper_records h ON h.id=ah.helper_id WHERE ah.company_id=? AND a.date BETWEEN ? AND ? GROUP BY h.id ORDER BY completed DESC`, C, from, to), money: [] };
    case 'revenue-by-period': return { rows: await all(`SELECT substr(issue_date,1,7) month,SUM(gross_cents) gross,SUM(discount_cents) discounts,SUM(amount_cents) net FROM accounts_receivable WHERE company_id=? AND status<>'canceled' AND issue_date BETWEEN ? AND ? GROUP BY month ORDER BY month`, C, from, to), money: ['gross', 'discounts', 'net'] };
    case 'revenue-by-property': return { rows: await all(`SELECT COALESCE(p.name,'—') property,COUNT(*) invoices,SUM(ar.amount_cents) net FROM accounts_receivable ar LEFT JOIN residential_properties p ON p.id=ar.property_id WHERE ar.company_id=? AND ar.status<>'canceled' AND ar.issue_date BETWEEN ? AND ? GROUP BY ar.property_id ORDER BY net DESC`, C, from, to), money: ['net'] };
    case 'revenue-by-customer': return { rows: await all(`SELECT cu.full_name customer,COUNT(*) invoices,SUM(ar.amount_cents) net FROM accounts_receivable ar JOIN customers cu ON cu.id=ar.customer_id WHERE ar.company_id=? AND ar.status<>'canceled' AND ar.issue_date BETWEEN ? AND ? GROUP BY ar.customer_id ORDER BY net DESC`, C, from, to), money: ['net'] };
    case 'revenue-by-service': return { rows: await all(`SELECT COALESCE(sv.name,'Other') service,COUNT(*) invoices,SUM(ar.amount_cents) net FROM accounts_receivable ar LEFT JOIN cleaning_appointments a ON a.id=ar.appointment_id LEFT JOIN cleaning_services sv ON sv.id=a.service_id WHERE ar.company_id=? AND ar.status<>'canceled' AND ar.issue_date BETWEEN ? AND ? GROUP BY sv.id ORDER BY net DESC`, C, from, to), money: ['net'] };
    case 'expenses-by-period': return { rows: await all(`SELECT substr(issue_date,1,7) month,kind,SUM(amount_cents) amount FROM accounts_payable WHERE company_id=? AND status<>'canceled' AND issue_date BETWEEN ? AND ? GROUP BY month,kind ORDER BY month`, C, from, to), money: ['amount'] };
    case 'expenses-by-category': return { rows: await all(`SELECT COALESCE(fc.name,'Uncategorized') category,fc.dre_group,SUM(ap.amount_cents) amount FROM accounts_payable ap LEFT JOIN financial_categories fc ON fc.id=ap.category_id WHERE ap.company_id=? AND ap.status<>'canceled' AND ap.issue_date BETWEEN ? AND ? GROUP BY fc.id ORDER BY amount DESC`, C, from, to), money: ['amount'] };
    case 'receivables': return { rows: await all(`SELECT cu.full_name customer,ar.description,ar.issue_date,ar.due_date,ar.amount_cents amount,COALESCE((SELECT SUM(CASE WHEN r.kind='receipt' THEN r.amount_cents ELSE -r.amount_cents END) FROM receipts r WHERE r.receivable_id=ar.id),0) received,ar.status FROM accounts_receivable ar JOIN customers cu ON cu.id=ar.customer_id WHERE ar.company_id=? AND ar.issue_date BETWEEN ? AND ? ORDER BY ar.due_date`, C, from, to), money: ['amount', 'received'] };
    case 'payables': return { rows: await all(`SELECT ap.kind,ap.payee,ap.description,ap.issue_date,ap.due_date,ap.amount_cents amount,COALESCE((SELECT SUM(x.amount_cents) FROM payments x WHERE x.payable_id=ap.id),0) paid,ap.status FROM accounts_payable ap WHERE ap.company_id=? AND ap.issue_date BETWEEN ? AND ? ORDER BY ap.due_date`, C, from, to), money: ['amount', 'paid'] };
    case 'helper-payments': { const r = await helperPaymentsReport(env, C, new URLSearchParams({ ...Object.fromEntries(q), from, to }));
      return { rows: r.summary.map((x: any) => ({ helper: x.helper_name, cleanings: x.cleanings, workdays: x.workdays, hours: x.hours, properties: x.properties.join('; '), due: x.due_cents, paid: x.paid_cents, balance: x.balance_cents })), money: ['due', 'paid', 'balance'] }; }
    case 'profitability': { const r = await computeProfitability(env, C, from, to);
      return { rows: r.items.map((x: any) => ({ property: x.name, customer: x.customer_name, cleanings: x.cleanings, gross: x.gross, discounts: x.discounts, refunds: x.refunds, net_revenue: x.net_revenue, helper_labor: x.helper_labor, direct_supplies: x.direct_supplies, other_allocated: x.other_allocated, gross_contribution: x.gross_contribution, contribution_pct: x.contribution_bps === null ? '' : (x.contribution_bps / 100).toFixed(2) })),
        money: ['gross', 'discounts', 'refunds', 'net_revenue', 'helper_labor', 'direct_supplies', 'other_allocated', 'gross_contribution'] }; }
    case 'dre': { const d: any = await computeDre(env, C, from, to, q.get('basis') === 'cash' ? 'cash' : 'accrual');
      const rows: any[] = [{ line: `BASIS: ${d.basis.toUpperCase()} — ${d.disclaimer}`, amount: '' }];
      const flat = (label: string, o: any) => { for (const [k, v] of Object.entries(o)) if (k !== 'total') rows.push({ line: `  ${label} · ${k}`, amount: v }); };
      rows.push({ line: 'Gross revenue', amount: d.gross_revenue.total }); flat('Gross revenue', d.gross_revenue);
      rows.push({ line: 'Revenue deductions', amount: -d.deductions.total }); flat('Deductions', d.deductions);
      rows.push({ line: 'Net revenue', amount: d.net_revenue });
      rows.push({ line: 'Direct costs', amount: -d.direct_costs.total }); flat('Direct costs', d.direct_costs);
      rows.push({ line: 'Gross profit', amount: d.gross_profit });
      rows.push({ line: 'Operating expenses', amount: -d.operating_expenses.total }); flat('Operating expenses', d.operating_expenses);
      rows.push({ line: 'Operating result', amount: d.operating_result }, { line: 'Financial result', amount: d.financial_result }, { line: 'Net result', amount: d.net_result });
      return { rows, money: ['amount'] }; }
    case 'cashflow': { const cf = await computeCashFlow(env, C, from, to);
      return { rows: [{ line: 'Opening balance', amount: cf.opening_balance }, { line: 'Receipts', amount: cf.receipts }, { line: 'Payments (incl. refunds)', amount: -cf.payments }, { line: 'Net movement', amount: cf.net_movement }, { line: 'Closing balance', amount: cf.closing_balance }], money: ['amount'] }; }
  }
  throw new HttpError(404, 'unknown_report');
}

export function reportRoutes(r: Router) {
  r.get('/api/reports/:name', async (c) => {
    const s = await requirePerm(c.env, c.session, 'reports.read');
    if (FINANCIAL.has(c.params.name) && !(await can(c.env, s, 'finance.read'))) throw new HttpError(403, 'forbidden');
    const { rows, money } = await build(c.env, s, c.params.name, c.query);
    await audit(c.env, s, 'export', 'report', c.params.name, { format: c.query.get('format') || 'json' });
    const fname = `${c.params.name}-${todayIn(s.timezone)}`;
    const fmt = c.query.get('format');
    if (fmt === 'xlsx')
      return new Response(toXlsx(rows, money, c.params.name), { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="${fname}.xlsx"`, 'cache-control': 'no-store' } });
    if (fmt === 'pdf') {
      const co = await c.env.DB.prepare('SELECT name FROM companies WHERE id=?').bind(s.companyId).first<any>();
      const period = c.query.get('from') ? `${c.query.get('from')} to ${c.query.get('to')}` : 'All dates';
      const title = c.params.name === 'dre' ? 'DRE (income statement)' : c.params.name.replace(/-/g, ' ').replace(/^./, (x) => x.toUpperCase());
      return new Response(toPdf(`${co?.name ?? ''} - ${title}`, `${period}   |   generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, rows, money,
        'House Cleaning Management - management report, not a GAAP or tax statement'), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${fname}.pdf"`, 'cache-control': 'no-store' } });
    }
    if (fmt === 'csv')
      return new Response(toCsv(rows, money), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${c.params.name}-${todayIso()}.csv"`, 'cache-control': 'no-store' } });
    return json({ rows, money_columns: money });
  });

  r.get('/api/dashboard', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.read');
    const C = s.companyId, today = todayIn(s.timezone);
    const one = async (sql: string, ...a: any[]) => (await c.env.DB.prepare(sql).bind(...a).first<any>())?.n ?? 0;
    const showMoney = await can(c.env, s, 'finance.read');
    return json({
      total_customers: await one('SELECT COUNT(*) n FROM customers WHERE company_id=?', C),
      active_customers: await one("SELECT COUNT(*) n FROM customers WHERE company_id=? AND status='active'", C),
      total_properties: await one('SELECT COUNT(*) n FROM residential_properties WHERE company_id=?', C),
      active_recurring_properties: await one("SELECT COUNT(DISTINCT property_id) n FROM recurring_service_rules WHERE company_id=? AND active=1 AND frequency<>'once'", C),
      one_time_properties: await one("SELECT COUNT(*) n FROM residential_properties WHERE company_id=? AND frequency='once'", C),
      upcoming_appointments: await one("SELECT COUNT(*) n FROM cleaning_appointments WHERE company_id=? AND date>=? AND status IN ('scheduled','confirmed','pending_confirmation')", C, today),
      completed_cleanings: await one("SELECT COUNT(*) n FROM cleaning_appointments WHERE company_id=? AND status='completed'", C),
      canceled_appointments: await one("SELECT COUNT(*) n FROM cleaning_appointments WHERE company_id=? AND status='canceled'", C),
      outstanding_balances: showMoney ? await one(`SELECT COALESCE(SUM(ar.amount_cents - COALESCE((SELECT SUM(CASE WHEN r.kind='receipt' THEN r.amount_cents ELSE -r.amount_cents END) FROM receipts r WHERE r.receivable_id=ar.id),0)),0) n FROM accounts_receivable ar WHERE ar.company_id=? AND ar.status IN ('pending','partially_paid')`, C) : null,
      recent_payments: showMoney ? (await c.env.DB.prepare(`SELECT r.date,r.amount_cents,r.method,r.kind,cu.full_name customer FROM receipts r JOIN accounts_receivable ar ON ar.id=r.receivable_id JOIN customers cu ON cu.id=ar.customer_id WHERE r.company_id=? ORDER BY r.created_at DESC LIMIT 8`).bind(C).all()).results : null,
      today: (await c.env.DB.prepare(`SELECT a.id,a.start_time,a.status,p.name property_name,p.city FROM cleaning_appointments a JOIN residential_properties p ON p.id=a.property_id WHERE a.company_id=? AND a.date=? AND a.status NOT IN ('canceled','rescheduled') ORDER BY a.start_time`).bind(C, today).all()).results,
    });
  });
}

// ───────── Platform administrator (aggregate-only, audited, no tenant PII) ─────────
export function adminRoutes(r: Router) {
  const admin = (s: Session | null) => { if (!s?.isPlatformAdmin) throw new HttpError(404, 'not_found'); return s; };
  r.get('/api/admin/companies', async (c) => {
    const s = admin(c.session);
    const { results } = await c.env.DB.prepare(`SELECT co.id, co.name, co.state, co.status, co.created_at, co.plan_id, co.subscription_status, co.trial_ends_at,
        (SELECT COUNT(*) FROM company_members m WHERE m.company_id=co.id) members,
        (SELECT COUNT(*) FROM residential_properties p WHERE p.company_id=co.id) properties,
        (SELECT COUNT(*) FROM cleaning_appointments a WHERE a.company_id=co.id) appointments
      FROM companies co ORDER BY co.created_at DESC LIMIT 500`).all();
    await audit(c.env, s, 'admin_list', 'companies', null);
    return json({ items: results });
  });
  r.post('/api/admin/companies/:id/status', async (c) => {
    const s = admin(c.session);
    const v = validate(await c.body(), { status: { type: 'enum', values: ['active', 'suspended'], required: true }, reason: { type: 'string', required: true, max: 500 } });
    const res = await c.env.DB.prepare("UPDATE companies SET status=? WHERE id=? AND status<>'deleted'").bind(v.status, c.params.id).run();
    if (!res.meta.changes) throw new HttpError(404, 'not_found');
    if (v.status === 'suspended') await c.env.DB.prepare('UPDATE user_sessions SET revoked_at=? WHERE company_id=? AND revoked_at IS NULL').bind(nowIso(), c.params.id).run();
    await audit(c.env, s, `admin_${v.status}`, 'company', c.params.id, { reason: v.reason });
    return json({ ok: true });
  });
  // ── Subscription plans (configuration only; billing/payment collection is NOT integrated) ──
  r.get('/api/admin/plans', async (c) => {
    admin(c.session);
    return json({ items: (await c.env.DB.prepare(`SELECT p.*, (SELECT COUNT(*) FROM companies c WHERE c.plan_id=p.id AND c.status<>'deleted') companies FROM subscription_plans p ORDER BY price_cents`).all()).results });
  });
  r.post('/api/admin/plans', async (c) => {
    const s = admin(c.session);
    const v = validate(await c.body(), { name: { type: 'string', required: true, max: 60 }, price: { type: 'money', required: true }, max_properties: { type: 'int', min: 1, max: 1000000 }, max_users: { type: 'int', min: 1, max: 10000 }, active: { type: 'bool' } });
    const id = uid();
    try {
      await c.env.DB.prepare('INSERT INTO subscription_plans (id,name,price_cents,max_properties,max_users,active,created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(id, v.name, v.price, v.max_properties ?? null, v.max_users ?? null, v.active ?? 1, nowIso()).run();
    } catch { throw new HttpError(409, 'plan_exists'); }
    await audit(c.env, s, 'admin_create', 'plan', id, { name: v.name, price: v.price });
    return json({ id }, 201);
  });
  r.put('/api/admin/plans/:id', async (c) => {
    const s = admin(c.session);
    const v: any = validate(await c.body(), { name: { type: 'string', max: 60 }, price: { type: 'money' }, max_properties: { type: 'int', min: 1, max: 1000000 }, max_users: { type: 'int', min: 1, max: 10000 }, active: { type: 'bool' } }, true);
    const cols = Object.keys(v).map((k) => (k === 'price' ? 'price_cents' : k));
    if (!cols.length) throw new HttpError(422, 'nothing_to_update');
    const res = await c.env.DB.prepare(`UPDATE subscription_plans SET ${cols.map((k) => `${k}=?`).join(',')} WHERE id=?`).bind(...Object.values(v), c.params.id).run();
    if (!res.meta.changes) throw new HttpError(404, 'not_found');
    await audit(c.env, s, 'admin_update', 'plan', c.params.id, v);
    return json({ ok: true });
  });
  r.post('/api/admin/companies/:id/subscription', async (c) => {
    const s = admin(c.session);
    const v = validate(await c.body(), { plan_id: { type: 'string' }, subscription_status: { type: 'enum', values: ['trial', 'active', 'past_due', 'canceled'], required: true }, trial_ends_at: { type: 'date' } });
    if (v.plan_id && !(await c.env.DB.prepare('SELECT 1 FROM subscription_plans WHERE id=?').bind(v.plan_id).first())) throw new HttpError(404, 'not_found');
    const res = await c.env.DB.prepare("UPDATE companies SET plan_id=?, subscription_status=?, trial_ends_at=? WHERE id=? AND status<>'deleted'").bind(v.plan_id ?? null, v.subscription_status, v.trial_ends_at ?? null, c.params.id).run();
    if (!res.meta.changes) throw new HttpError(404, 'not_found');
    await audit(c.env, s, 'admin_subscription', 'company', c.params.id, v);
    return json({ ok: true });
  });

  r.get('/api/admin/health', async (c) => {
    admin(c.session);
    const jobs = (await c.env.DB.prepare('SELECT job,status,attempts,details,finished_at FROM background_job_records ORDER BY finished_at DESC LIMIT 50').all()).results;
    const events = (await c.env.DB.prepare('SELECT kind,COUNT(*) n FROM security_events WHERE created_at>? GROUP BY kind').bind(new Date(Date.now() - 7 * 864e5).toISOString()).all()).results;
    const metrics = await c.env.DB.prepare(`SELECT (SELECT COUNT(*) FROM companies WHERE status='active') companies, (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) users,
      (SELECT COUNT(*) FROM cleaning_appointments) appointments, (SELECT COUNT(*) FROM messages) active_messages`).first();
    return json({ db: 'ok', metrics, jobs, security_events_7d: events });
  });
}

export async function recordJob(env: Env, job: string, fn: () => Promise<unknown>, maxAttempts = 3) {
  const started = nowIso();
  let attempt = 0, lastErr: unknown;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const result = await fn();
      await env.DB.prepare('INSERT INTO background_job_records (id,job,status,attempts,details,started_at,finished_at) VALUES (?,?,?,?,?,?,?)').bind(uid(), job, 'ok', attempt, JSON.stringify({ result }), started, nowIso()).run();
      return result;
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 200 * 2 ** attempt)); }
  }
  await env.DB.prepare('INSERT INTO background_job_records (id,job,status,attempts,details,started_at,finished_at) VALUES (?,?,?,?,?,?,?)').bind(uid(), job, 'error', attempt, String((lastErr as Error)?.message || lastErr).slice(0, 500), started, nowIso()).run();
  return null;
}

/** Enforces the company's plan limits (if a plan is assigned). */
export async function checkPlanLimit(env: Env, companyId: string, kind: 'properties' | 'users') {
  const p = await env.DB.prepare('SELECT sp.max_properties, sp.max_users FROM companies c JOIN subscription_plans sp ON sp.id=c.plan_id WHERE c.id=?').bind(companyId).first<any>();
  const max = kind === 'properties' ? p?.max_properties : p?.max_users;
  if (max === null || max === undefined) return;
  const sql = kind === 'properties' ? "SELECT COUNT(*) n FROM residential_properties WHERE company_id=? AND status<>'archived'" : "SELECT COUNT(*) n FROM company_members WHERE company_id=? AND status='active'";
  const n = (await env.DB.prepare(sql).bind(companyId).first<any>()).n;
  if (n >= max) throw new HttpError(402, 'plan_limit_reached', { kind, max });
}
