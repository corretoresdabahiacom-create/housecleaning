import { Env, HttpError, Router, Session, assertCurrency, divRound, json, nowIso, ratioBps, todayIso, uid, validate } from '../lib/core';
import { audit, owned, requirePerm } from '../lib/security';
import { sniff } from './messages';

const METHODS = ['cash', 'check', 'bank_transfer', 'zelle', 'credit_card_manual', 'other'] as const;
type Basis = 'accrual' | 'cash';

function period(q: URLSearchParams) {
  const from = q.get('from'), to = q.get('to');
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !re.test(from) || !re.test(to) || from > to) throw new HttpError(422, 'validation_error', { period: 'from_to_required' });
  return { from, to };
}
const sum = async (env: Env, sql: string, ...args: any[]) => ((await env.DB.prepare(sql).bind(...args).first<any>())?.v ?? 0) as number;

// ───────── Status recomputation (derived from actual cash records only) ─────────
export async function refreshReceivable(env: Env, companyId: string, id: string) {
  const ar: any = await owned(env, 'accounts_receivable', id, companyId);
  const received = await sum(env, "SELECT COALESCE(SUM(CASE WHEN kind='receipt' THEN amount_cents ELSE -amount_cents END),0) v FROM receipts WHERE receivable_id=? AND company_id=?", id, companyId);
  let status = ar.status;
  if (!['canceled', 'written_off'].includes(ar.status)) status = received >= ar.amount_cents && ar.amount_cents > 0 ? 'paid' : received > 0 ? 'partially_paid' : ar.amount_cents === 0 ? 'paid' : 'pending';
  await env.DB.prepare('UPDATE accounts_receivable SET status=? WHERE id=?').bind(status, id).run();
  return { ...ar, status, received_cents: received, outstanding_cents: ['canceled', 'written_off'].includes(status) ? 0 : ar.amount_cents - received };
}
export async function refreshPayable(env: Env, companyId: string, id: string) {
  const ap: any = await owned(env, 'accounts_payable', id, companyId);
  const paid = await sum(env, 'SELECT COALESCE(SUM(amount_cents),0) v FROM payments WHERE payable_id=? AND company_id=?', id, companyId);
  let status = ap.status;
  if (ap.status !== 'canceled') status = paid >= ap.amount_cents ? 'paid' : paid > 0 ? 'partially_paid' : 'pending';
  await env.DB.prepare('UPDATE accounts_payable SET status=? WHERE id=?').bind(status, id).run();
  return { ...ap, status, paid_cents: paid, outstanding_cents: status === 'canceled' ? 0 : ap.amount_cents - paid };
}

const AR_SELECT = `SELECT ar.*, cu.full_name AS customer_name, p.name AS property_name,
  COALESCE((SELECT SUM(CASE WHEN r.kind='receipt' THEN r.amount_cents ELSE -r.amount_cents END) FROM receipts r WHERE r.receivable_id=ar.id),0) AS received_cents
  FROM accounts_receivable ar JOIN customers cu ON cu.id=ar.customer_id LEFT JOIN residential_properties p ON p.id=ar.property_id`;
const AP_SELECT = `SELECT ap.*, fc.name AS category_name, fc.dre_group, COALESCE((SELECT SUM(x.amount_cents) FROM payments x WHERE x.payable_id=ap.id),0) AS paid_cents
  FROM accounts_payable ap LEFT JOIN financial_categories fc ON fc.id=ap.category_id`;

// ───────── DRE (management income statement) ─────────
export async function computeDre(env: Env, companyId: string, from: string, to: string, basis: Basis) {
  const rev: Record<string, number> = { residential: 0, deep: 0, move: 0, additional: 0, other: 0 };
  let discounts = 0, refunds = 0, writeOffs = 0;
  if (basis === 'accrual') {
    const { results } = await env.DB.prepare(`SELECT revenue_class, SUM(gross_cents) g, SUM(discount_cents) d FROM accounts_receivable
      WHERE company_id=? AND status<>'canceled' AND issue_date BETWEEN ? AND ? GROUP BY revenue_class`).bind(companyId, from, to).all<any>();
    for (const r of results) { rev[r.revenue_class] += r.g; discounts += r.d; }
    refunds = await sum(env, "SELECT COALESCE(SUM(amount_cents),0) v FROM receipts WHERE company_id=? AND kind='refund' AND date BETWEEN ? AND ?", companyId, from, to);
    writeOffs = await sum(env, `SELECT COALESCE(SUM(ar.amount_cents - COALESCE((SELECT SUM(CASE WHEN r.kind='receipt' THEN r.amount_cents ELSE -r.amount_cents END) FROM receipts r WHERE r.receivable_id=ar.id),0)),0) v
      FROM accounts_receivable ar WHERE ar.company_id=? AND ar.status='written_off' AND ar.issue_date BETWEEN ? AND ?`, companyId, from, to);
  } else {
    const { results } = await env.DB.prepare(`SELECT ar.revenue_class, r.kind, SUM(r.amount_cents) v FROM receipts r JOIN accounts_receivable ar ON ar.id=r.receivable_id
      WHERE r.company_id=? AND r.date BETWEEN ? AND ? GROUP BY ar.revenue_class, r.kind`).bind(companyId, from, to).all<any>();
    for (const r of results) { if (r.kind === 'receipt') rev[r.revenue_class] += r.v; else refunds += r.v; }
  }
  // Costs/expenses: accrual = by issue_date of non-canceled payables; cash = by payment date.
  const costSql = basis === 'accrual'
    ? `SELECT ap.kind, fc.dre_group, fc.name, SUM(ap.amount_cents) v FROM accounts_payable ap LEFT JOIN financial_categories fc ON fc.id=ap.category_id
       WHERE ap.company_id=? AND ap.status<>'canceled' AND ap.issue_date BETWEEN ? AND ? GROUP BY ap.kind, fc.dre_group, fc.name`
    : `SELECT ap.kind, fc.dre_group, fc.name, SUM(p.amount_cents) v FROM payments p JOIN accounts_payable ap ON ap.id=p.payable_id LEFT JOIN financial_categories fc ON fc.id=ap.category_id
       WHERE p.company_id=? AND p.date BETWEEN ? AND ? GROUP BY ap.kind, fc.dre_group, fc.name`;
  const { results: costs } = await env.DB.prepare(costSql).bind(companyId, from, to).all<any>();
  let helperLabor = 0, taxes = 0, financial = 0;
  const direct: Record<string, number> = {}, opex: Record<string, number> = {};
  for (const r of costs) {
    if (r.kind === 'helper') { helperLabor += r.v; continue; }
    const g = r.dre_group || 'operating_expense', n = r.name || 'Uncategorized';
    if (g === 'direct_cost') direct[n] = (direct[n] || 0) + r.v;
    else if (g === 'tax_deduction') taxes += r.v;
    else if (g === 'financial') financial += r.v;
    else opex[n] = (opex[n] || 0) + r.v;
  }
  const gross = Object.values(rev).reduce((a, b) => a + b, 0);
  const deductions = discounts + refunds + taxes + writeOffs;
  const net = gross - deductions;
  const directTotal = helperLabor + Object.values(direct).reduce((a, b) => a + b, 0);
  const grossProfit = net - directTotal;
  const opexTotal = Object.values(opex).reduce((a, b) => a + b, 0);
  const operating = grossProfit - opexTotal;
  const netResult = operating - financial;
  return {
    basis, from, to, currency: 'USD',
    disclaimer: 'Management report. Not a GAAP-compliant or tax-ready financial statement. Review with a qualified US accountant/CPA.',
    gross_revenue: { total: gross, ...rev },
    deductions: { total: deductions, discounts, refunds, taxes_collected: taxes, write_offs: writeOffs },
    net_revenue: net,
    direct_costs: { total: directTotal, helper_labor: helperLabor, ...direct },
    gross_profit: grossProfit,
    operating_expenses: { total: opexTotal, ...opex },
    operating_result: operating,
    financial_result: -financial,
    net_result: netResult,
    margins_bps: { gross: ratioBps(grossProfit, net), net: ratioBps(netResult, net) },
  };
}

// ───────── Cash flow (actual cash only) ─────────
export async function computeCashFlow(env: Env, companyId: string, from: string, to: string) {
  const ob = await env.DB.prepare('SELECT date, amount_cents FROM opening_balances WHERE company_id=? AND date<=? ORDER BY date DESC LIMIT 1').bind(companyId, from).first<any>();
  const base = ob?.amount_cents ?? 0, baseDate = ob?.date ?? '0000-01-01';
  const net = async (a: string, b: string, inclusiveStart: boolean) => {
    const op = inclusiveStart ? '>=' : '>';
    const rin = await sum(env, `SELECT COALESCE(SUM(CASE WHEN kind='receipt' THEN amount_cents ELSE 0 END),0) v FROM receipts WHERE company_id=? AND date${op}? AND date<=?`, companyId, a, b);
    const rout = await sum(env, `SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN amount_cents ELSE 0 END),0) v FROM receipts WHERE company_id=? AND date${op}? AND date<=?`, companyId, a, b);
    const pout = await sum(env, `SELECT COALESCE(SUM(amount_cents),0) v FROM payments WHERE company_id=? AND date${op}? AND date<=?`, companyId, a, b);
    return { rin, rout, pout };
  };
  const dayBefore = new Date(Date.parse(from + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  // Opening balance registered ON 'from' counts as the start balance; movements before 'from' since the last balance roll forward.
  const prior = baseDate < from ? await net(baseDate, dayBefore, !ob) : { rin: 0, rout: 0, pout: 0 };
  const opening = base + prior.rin - prior.rout - prior.pout;
  const cur = await net(from, to, true);
  const { results: byDay } = await env.DB.prepare(`SELECT d, SUM(i) inflow, SUM(o) outflow FROM (
      SELECT date d, CASE WHEN kind='receipt' THEN amount_cents ELSE 0 END i, CASE WHEN kind='refund' THEN amount_cents ELSE 0 END o FROM receipts WHERE company_id=? AND date BETWEEN ? AND ?
      UNION ALL SELECT date, 0, amount_cents FROM payments WHERE company_id=? AND date BETWEEN ? AND ?) GROUP BY d ORDER BY d`).bind(companyId, from, to, companyId, from, to).all();
  const receipts = cur.rin, payments = cur.pout + cur.rout;
  return { from, to, opening_balance: opening, opening_balance_source: ob ? ob.date : null, receipts, payments, refunds: cur.rout, net_movement: receipts - payments, closing_balance: opening + receipts - payments, by_day: byDay };
}

export async function computeProfitability(env: Env, companyId: string, from: string, to: string) {
  const { results } = await env.DB.prepare(`
    SELECT p.id, p.name, cu.full_name AS customer_name, p.customer_id,
      (SELECT COUNT(*) FROM cleaning_appointments a WHERE a.property_id=p.id AND a.status='completed' AND a.date BETWEEN ?1 AND ?2) AS cleanings,
      (SELECT COALESCE(SUM(gross_cents),0) FROM accounts_receivable ar WHERE ar.property_id=p.id AND ar.status<>'canceled' AND ar.issue_date BETWEEN ?1 AND ?2) AS gross,
      (SELECT COALESCE(SUM(discount_cents),0) FROM accounts_receivable ar WHERE ar.property_id=p.id AND ar.status<>'canceled' AND ar.issue_date BETWEEN ?1 AND ?2) AS discounts,
      (SELECT COALESCE(SUM(r.amount_cents),0) FROM receipts r JOIN accounts_receivable ar ON ar.id=r.receivable_id WHERE ar.property_id=p.id AND r.kind='refund' AND r.date BETWEEN ?1 AND ?2) AS refunds,
      (SELECT COALESCE(SUM(amount_cents),0) FROM accounts_payable ap WHERE ap.property_id=p.id AND ap.kind='helper' AND ap.status<>'canceled' AND ap.issue_date BETWEEN ?1 AND ?2) AS helper_labor,
      (SELECT COALESCE(SUM(ap.amount_cents),0) FROM accounts_payable ap JOIN financial_categories fc ON fc.id=ap.category_id WHERE ap.property_id=p.id AND ap.kind='expense' AND fc.dre_group='direct_cost' AND ap.status<>'canceled' AND ap.issue_date BETWEEN ?1 AND ?2) AS direct_supplies,
      (SELECT COALESCE(SUM(ap.amount_cents),0) FROM accounts_payable ap LEFT JOIN financial_categories fc ON fc.id=ap.category_id WHERE ap.property_id=p.id AND ap.kind='expense' AND COALESCE(fc.dre_group,'operating_expense')<>'direct_cost' AND ap.status<>'canceled' AND ap.issue_date BETWEEN ?1 AND ?2) AS other_allocated
    FROM residential_properties p JOIN customers cu ON cu.id=p.customer_id WHERE p.company_id=?3 ORDER BY p.name`).bind(from, to, companyId).all<any>();
  return {
    from, to,
    note: 'Gross contribution excludes indirect company expenses (no automatic allocation). It is NOT net profit.',
    items: results.filter((r) => r.cleanings || r.gross || r.helper_labor || r.direct_supplies || r.other_allocated).map((r) => {
      const net = r.gross - r.discounts - r.refunds;
      const contribution = net - r.helper_labor - r.direct_supplies - r.other_allocated;
      return { ...r, net_revenue: net, gross_contribution: contribution, contribution_bps: ratioBps(contribution, net) };
    }),
  };
}

export async function helperPaymentsReport(env: Env, companyId: string, q: URLSearchParams) {
  const { from, to } = period(q);
  const where = ["ap.company_id=?", "ap.kind='helper'", "ap.status<>'canceled'", 'ap.issue_date BETWEEN ? AND ?']; const args: any[] = [companyId, from, to];
  const ids = (q.get('helper_ids') || q.get('helper_id') || '').split(',').filter(Boolean);
  if (ids.length) { where.push(`ap.helper_id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
  if (q.get('team_id')) { where.push('ap.helper_id IN (SELECT helper_id FROM team_members WHERE team_id=? AND company_id=ap.company_id)'); args.push(q.get('team_id')); }
  if (q.get('property_id')) { where.push('ap.property_id=?'); args.push(q.get('property_id')); }
  if (q.get('city')) { where.push('p.city=?'); args.push(q.get('city')); }
  if (q.get('state')) { where.push('p.state=?'); args.push(q.get('state')); }
  const { results } = await env.DB.prepare(`SELECT ap.id, ap.helper_id, h.full_name AS helper_name, ap.issue_date AS service_date, ap.amount_cents, ap.status, ap.appointment_id,
      p.name AS property_name, p.city, p.state, ah.pay_basis, ah.rate_cents, ah.worked_minutes,
      COALESCE((SELECT SUM(x.amount_cents) FROM payments x WHERE x.payable_id=ap.id),0) AS paid_cents
    FROM accounts_payable ap JOIN helper_records h ON h.id=ap.helper_id LEFT JOIN residential_properties p ON p.id=ap.property_id
    LEFT JOIN appointment_helpers ah ON ah.appointment_id=ap.appointment_id AND ah.helper_id=ap.helper_id
    WHERE ${where.join(' AND ')} ORDER BY h.full_name, ap.issue_date`).bind(...args).all<any>();
  const byHelper = new Map<string, any>();
  for (const r of results) {
    const g = byHelper.get(r.helper_id) || { helper_id: r.helper_id, helper_name: r.helper_name, cleanings: 0, properties: new Set(), workdays: new Set(), minutes: 0, due_cents: 0, paid_cents: 0 };
    g.cleanings++; g.properties.add(r.property_name); g.workdays.add(r.service_date); g.minutes += r.worked_minutes || 0; g.due_cents += r.amount_cents; g.paid_cents += r.paid_cents;
    byHelper.set(r.helper_id, g);
  }
  const summary = [...byHelper.values()].map((g) => ({ ...g, properties: [...g.properties], workdays: g.workdays.size, hours: Math.floor(g.minutes / 60) + ':' + String(g.minutes % 60).padStart(2, '0'), balance_cents: g.due_cents - g.paid_cents }));
  return { from, to, items: results.map((r) => ({ ...r, balance_cents: r.amount_cents - r.paid_cents })), summary, totals: { due_cents: summary.reduce((a, b) => a + b.due_cents, 0), paid_cents: summary.reduce((a, b) => a + b.paid_cents, 0) } };
}

/** Cron: materialize monthly recurring expenses for the current month (idempotent per parent+month). */
export async function generateRecurringExpenses(env: Env) {
  const month = todayIso().slice(0, 7);
  const { results } = await env.DB.prepare(`SELECT ap.* FROM accounts_payable ap JOIN companies c ON c.id=ap.company_id WHERE ap.recurring_monthly=1 AND ap.recurring_parent_id IS NULL AND ap.status<>'canceled' AND c.status='active' AND substr(ap.issue_date,1,7) < ?`).bind(month).all<any>();
  let n = 0;
  for (const p of results) {
    const exists = await env.DB.prepare('SELECT 1 FROM accounts_payable WHERE recurring_parent_id=? AND substr(issue_date,1,7)=?').bind(p.id, month).first();
    if (exists) continue;
    const day = p.issue_date.slice(8, 10);
    const last = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
    const d = `${month}-${String(Math.min(+day, last)).padStart(2, '0')}`;
    await env.DB.prepare(`INSERT INTO accounts_payable (id,company_id,kind,category_id,payee,supplier,description,amount_cents,currency,issue_date,due_date,property_id,recurring_monthly,recurring_parent_id,created_at)
      VALUES (?,?,'expense',?,?,?,?,?,?,?,?,?,0,?,?)`).bind(uid(), p.company_id, p.category_id, p.payee, p.supplier, p.description, p.amount_cents, p.currency, d, d, p.property_id, p.id, nowIso()).run();
    n++;
  }
  return n;
}

export function financeRoutes(r: Router) {
  // ── Categories ──
  r.get('/api/finance/categories', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.read');
    return json({ items: (await c.env.DB.prepare('SELECT * FROM financial_categories WHERE company_id=? ORDER BY dre_group, name').bind(s.companyId).all()).results });
  });
  r.post('/api/finance/categories', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.write');
    const v = validate(await c.body(), { name: { type: 'string', required: true, max: 80 }, dre_group: { type: 'enum', values: ['direct_cost', 'operating_expense', 'financial', 'tax_deduction'], required: true } });
    const id = uid();
    try { await c.env.DB.prepare('INSERT INTO financial_categories (id,company_id,name,dre_group) VALUES (?,?,?,?)').bind(id, s.companyId, v.name, v.dre_group).run(); }
    catch { throw new HttpError(409, 'category_exists'); }
    return json({ id }, 201);
  });

  // ── Receivables ──
  r.get('/api/finance/receivables', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.read');
    const where = ['ar.company_id=?']; const args: any[] = [s.companyId];
    for (const f of ['status', 'customer_id', 'property_id'] as const) { const v = c.query.get(f); if (v) { where.push(`ar.${f}=?`); args.push(v); } }
    if (c.query.get('from')) { where.push('ar.issue_date>=?'); args.push(c.query.get('from')); }
    if (c.query.get('to')) { where.push('ar.issue_date<=?'); args.push(c.query.get('to')); }
    if (c.query.get('open') === '1') where.push("ar.status IN ('pending','partially_paid')");
    const { results } = await c.env.DB.prepare(`${AR_SELECT} WHERE ${where.join(' AND ')} ORDER BY ar.due_date DESC LIMIT 1000`).bind(...args).all<any>();
    const today = todayIso();
    const items = results.map((x) => {
      const outstanding = ['canceled', 'written_off'].includes(x.status) ? 0 : x.amount_cents - x.received_cents;
      return { ...x, outstanding_cents: outstanding, overdue: outstanding > 0 && x.due_date < today };
    });
    const weekEnd = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10), monthEnd = today.slice(0, 7) + '-31';
    const open = (await c.env.DB.prepare(`SELECT x.* FROM (${AR_SELECT} WHERE ar.company_id=? AND ar.status IN ('pending','partially_paid')) x`).bind(s.companyId).all<any>()).results.map((x) => ({ ...x, o: x.amount_cents - x.received_cents }));
    const tot = (f: (x: any) => boolean) => open.filter(f).reduce((a, b) => a + b.o, 0);
    return json({ items, summary: { total_outstanding: tot(() => true), due_today: tot((x) => x.due_date === today), due_this_week: tot((x) => x.due_date >= today && x.due_date <= weekEnd), due_this_month: tot((x) => x.due_date >= today && x.due_date <= monthEnd), overdue: tot((x) => x.due_date < today) } });
  });
  r.post('/api/finance/receivables', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.write');
    const v = validate(await c.body(), {
      customer_id: { type: 'string', required: true }, property_id: { type: 'string' }, description: { type: 'string', required: true, max: 300 },
      amount: { type: 'money', required: true, min: 1 }, revenue_class: { type: 'enum', values: ['residential', 'deep', 'move', 'additional', 'other'] },
      issue_date: { type: 'date', required: true }, due_date: { type: 'date', required: true }, currency: { type: 'string', max: 3 }, installments: { type: 'int', min: 1, max: 24 },
    });
    await owned(c.env, 'customers', v.customer_id, s.companyId);
    if (v.property_id) { const p: any = await owned(c.env, 'residential_properties', v.property_id, s.companyId); if (p.customer_id !== v.customer_id) throw new HttpError(422, 'property_customer_mismatch'); }
    const cur = assertCurrency(v.currency, s.currency);
    // Installments: split exactly (remainder cents go to the first installment), monthly due dates.
    const n = v.installments || 1, base = Math.floor(v.amount / n), rem = v.amount - base * n;
    const ids: string[] = [];
    const stmts: any[] = [];
    for (let i = 0; i < n; i++) {
      const id = uid(); ids.push(id);
      const due = new Date(Date.parse(v.due_date + 'T00:00:00Z')); due.setUTCMonth(due.getUTCMonth() + i);
      const amt = base + (i === 0 ? rem : 0);
      stmts.push(c.env.DB.prepare(`INSERT INTO accounts_receivable (id,company_id,customer_id,property_id,description,revenue_class,gross_cents,discount_cents,amount_cents,currency,issue_date,due_date,created_at) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?)`)
        .bind(id, s.companyId, v.customer_id, v.property_id ?? null, n > 1 ? `${v.description} (${i + 1}/${n})` : v.description, v.revenue_class || 'other', amt, amt, cur, v.issue_date, due.toISOString().slice(0, 10), nowIso()));
    }
    await c.env.DB.batch(stmts);
    await audit(c.env, s, 'create', 'receivable', ids[0], { amount: v.amount, installments: n });
    return json({ ids }, 201);
  });
  r.get('/api/finance/receivables/:id', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.read');
    const ar = await refreshReceivable(c.env, s.companyId, c.params.id);
    const receipts = (await c.env.DB.prepare('SELECT id,kind,amount_cents,date,method,notes,created_at FROM receipts WHERE receivable_id=? AND company_id=? ORDER BY date, created_at').bind(ar.id, s.companyId).all()).results;
    return json({ receivable: ar, receipts });
  });
  r.post('/api/finance/receivables/:id/receipts', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.write');
    const v = validate(await c.body(), {
      kind: { type: 'enum', values: ['receipt', 'refund'] }, amount: { type: 'money', required: true, min: 1 }, date: { type: 'date', required: true },
      method: { type: 'enum', values: METHODS, required: true }, notes: { type: 'string', max: 500 }, idempotency_key: { type: 'string', max: 100 }, currency: { type: 'string', max: 3 },
    });
    const cur = assertCurrency(v.currency, s.currency);
    if (v.idempotency_key) {
      const dup = await c.env.DB.prepare('SELECT id FROM receipts WHERE company_id=? AND idempotency_key=?').bind(s.companyId, v.idempotency_key).first<any>();
      if (dup) return json({ id: dup.id, duplicate: true }, 200);
    }
    const ar = await refreshReceivable(c.env, s.companyId, c.params.id);
    if (['canceled', 'written_off'].includes(ar.status)) throw new HttpError(409, 'receivable_closed');
    const kind = v.kind || 'receipt';
    if (kind === 'receipt' && v.amount > ar.outstanding_cents) throw new HttpError(422, 'amount_exceeds_outstanding', { outstanding_cents: ar.outstanding_cents });
    if (kind === 'refund' && v.amount > ar.received_cents) throw new HttpError(422, 'refund_exceeds_received', { received_cents: ar.received_cents });
    const id = uid();
    try {
      await c.env.DB.prepare('INSERT INTO receipts (id,company_id,receivable_id,kind,amount_cents,currency,date,method,notes,idempotency_key,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, s.companyId, ar.id, kind, v.amount, cur, v.date, v.method, v.notes ?? null, v.idempotency_key ?? null, s.userId, nowIso()).run();
    } catch { throw new HttpError(409, 'duplicate_transaction'); }
    const after = await refreshReceivable(c.env, s.companyId, ar.id);
    await audit(c.env, s, kind, 'receivable', ar.id, { amount: v.amount, receipt_id: id });
    return json({ id, receivable: after }, 201);
  });
  r.post('/api/finance/receivables/:id/status', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.write');
    const v = validate(await c.body(), { status: { type: 'enum', values: ['canceled', 'written_off'], required: true } });
    const ar = await refreshReceivable(c.env, s.companyId, c.params.id);
    if (v.status === 'canceled' && ar.received_cents > 0) throw new HttpError(409, 'has_receipts_refund_first');
    if (ar.status === 'paid') throw new HttpError(409, 'already_paid');
    await c.env.DB.prepare('UPDATE accounts_receivable SET status=? WHERE id=? AND company_id=?').bind(v.status, ar.id, s.companyId).run();
    await audit(c.env, s, v.status, 'receivable', ar.id);
    return json({ ok: true });
  });

  // ── Payables & expenses ──
  r.get('/api/finance/payables', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.read');
    const where = ['ap.company_id=?']; const args: any[] = [s.companyId];
    for (const f of ['kind', 'status', 'category_id', 'helper_id', 'property_id'] as const) { const v = c.query.get(f); if (v) { where.push(`ap.${f}=?`); args.push(v); } }
    if (c.query.get('supplier')) { where.push('(ap.supplier=? OR ap.payee=?)'); args.push(c.query.get('supplier'), c.query.get('supplier')); }
    if (c.query.get('from')) { where.push('ap.issue_date>=?'); args.push(c.query.get('from')); }
    if (c.query.get('to')) { where.push('ap.issue_date<=?'); args.push(c.query.get('to')); }
    if (c.query.get('open') === '1') where.push("ap.status IN ('pending','partially_paid')");
    const { results } = await c.env.DB.prepare(`${AP_SELECT} WHERE ${where.join(' AND ')} ORDER BY ap.due_date DESC LIMIT 1000`).bind(...args).all<any>();
    const today = todayIso();
    const items = results.map((x) => { const o = x.status === 'canceled' ? 0 : x.amount_cents - x.paid_cents; return { ...x, outstanding_cents: o, overdue: o > 0 && x.due_date < today }; });
    const open = items.filter((x) => x.outstanding_cents > 0);
    return json({ items, summary: { total_outstanding: open.reduce((a, b) => a + b.outstanding_cents, 0), overdue: open.filter((x) => x.overdue).reduce((a, b) => a + b.outstanding_cents, 0), upcoming_7d: open.filter((x) => !x.overdue && x.due_date <= new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)).reduce((a, b) => a + b.outstanding_cents, 0) } });
  });
  r.post('/api/finance/expenses', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.write');
    const v = validate(await c.body(), {
      description: { type: 'string', required: true, max: 300 }, category_id: { type: 'string', required: true }, supplier: { type: 'string', max: 120 },
      amount: { type: 'money', required: true, min: 1 }, currency: { type: 'string', max: 3 }, expense_date: { type: 'date', required: true }, due_date: { type: 'date' },
      property_id: { type: 'string' }, notes: { type: 'string', max: 1000 }, recurring_monthly: { type: 'bool' },
      paid_date: { type: 'date' }, payment_method: { type: 'enum', values: METHODS }, installments: { type: 'int', min: 1, max: 24 },
    });
    await owned(c.env, 'financial_categories', v.category_id, s.companyId);
    if (v.property_id) await owned(c.env, 'residential_properties', v.property_id, s.companyId);
    const cur = assertCurrency(v.currency, s.currency);
    const n = v.installments || 1, base = Math.floor(v.amount / n), rem = v.amount - base * n;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = uid(); ids.push(id);
      const due = new Date(Date.parse((v.due_date || v.expense_date) + 'T00:00:00Z')); due.setUTCMonth(due.getUTCMonth() + i);
      const amt = base + (i === 0 ? rem : 0);
      await c.env.DB.prepare(`INSERT INTO accounts_payable (id,company_id,kind,category_id,payee,supplier,description,amount_cents,currency,issue_date,due_date,property_id,recurring_monthly,notes,created_at)
        VALUES (?,?,'expense',?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, s.companyId, v.category_id, v.supplier || v.description, v.supplier ?? null, n > 1 ? `${v.description} (${i + 1}/${n})` : v.description,
        amt, cur, v.expense_date, due.toISOString().slice(0, 10), v.property_id ?? null, n > 1 ? 0 : v.recurring_monthly ?? 0, v.notes ?? null, nowIso()).run();
      if (v.paid_date && n === 1) {
        await c.env.DB.prepare('INSERT INTO payments (id,company_id,payable_id,amount_cents,currency,date,method,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(uid(), s.companyId, id, amt, cur, v.paid_date, v.payment_method || 'other', s.userId, nowIso()).run();
        await refreshPayable(c.env, s.companyId, id);
      }
    }
    await audit(c.env, s, 'create', 'expense', ids[0], { amount: v.amount });
    return json({ ids }, 201);
  });
  r.post('/api/finance/payables/:id/payments', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.write');
    const v = validate(await c.body(), { amount: { type: 'money', required: true, min: 1 }, date: { type: 'date', required: true }, method: { type: 'enum', values: METHODS, required: true }, notes: { type: 'string', max: 500 }, idempotency_key: { type: 'string', max: 100 }, currency: { type: 'string', max: 3 } });
    const cur = assertCurrency(v.currency, s.currency);
    if (v.idempotency_key) {
      const dup = await c.env.DB.prepare('SELECT id FROM payments WHERE company_id=? AND idempotency_key=?').bind(s.companyId, v.idempotency_key).first<any>();
      if (dup) return json({ id: dup.id, duplicate: true }, 200);
    }
    const ap = await refreshPayable(c.env, s.companyId, c.params.id);
    if (ap.status === 'canceled') throw new HttpError(409, 'payable_canceled');
    if (v.amount > ap.outstanding_cents) throw new HttpError(422, 'amount_exceeds_outstanding', { outstanding_cents: ap.outstanding_cents });
    const id = uid();
    try {
      await c.env.DB.prepare('INSERT INTO payments (id,company_id,payable_id,amount_cents,currency,date,method,notes,idempotency_key,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, s.companyId, ap.id, v.amount, cur, v.date, v.method, v.notes ?? null, v.idempotency_key ?? null, s.userId, nowIso()).run();
    } catch { throw new HttpError(409, 'duplicate_transaction'); }
    const after = await refreshPayable(c.env, s.companyId, ap.id);
    await audit(c.env, s, 'payment', 'payable', ap.id, { amount: v.amount, payment_id: id });
    return json({ id, payable: after }, 201);
  });
  // Pay several helper obligations at once (each recorded individually, outstanding only).
  r.post('/api/finance/helper-payments/pay', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.write');
    const b = await c.body();
    const v = validate(b, { payable_ids: { type: 'array', required: true }, date: { type: 'date', required: true }, method: { type: 'enum', values: METHODS, required: true }, batch_key: { type: 'string', max: 80 } });
    const done: any[] = [];
    for (const pid of v.payable_ids) {
      const ap = await refreshPayable(c.env, s.companyId, pid);
      if (ap.kind !== 'helper' || ap.outstanding_cents <= 0) continue;
      const key = v.batch_key ? `${v.batch_key}:${pid}` : null;
      if (key && (await c.env.DB.prepare('SELECT 1 FROM payments WHERE company_id=? AND idempotency_key=?').bind(s.companyId, key).first())) continue;
      await c.env.DB.prepare('INSERT INTO payments (id,company_id,payable_id,amount_cents,currency,date,method,idempotency_key,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(uid(), s.companyId, pid, ap.outstanding_cents, ap.currency, v.date, v.method, key, s.userId, nowIso()).run();
      await refreshPayable(c.env, s.companyId, pid);
      done.push({ payable_id: pid, amount_cents: ap.outstanding_cents });
    }
    await audit(c.env, s, 'batch_payment', 'helper_payables', null, { count: done.length });
    return json({ paid: done });
  });
  // Expense receipt/invoice attachment (PDF or image, 8 MB). Replaces any previous file.
  r.post('/api/finance/payables/:id/attachment', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.write');
    const ap: any = await owned(c.env, 'accounts_payable', c.params.id, s.companyId);
    if (!c.env.FILES) throw new HttpError(503, 'storage_not_configured');
    if (!(c.req.headers.get('content-type') || '').startsWith('multipart/form-data')) throw new HttpError(415, 'multipart_required');
    const file = (await c.req.formData()).get('file') as unknown as File | null;
    if (!file || typeof file !== 'object') throw new HttpError(422, 'validation_error', { file: 'required' });
    if (file.size > 8 * 1024 * 1024) throw new HttpError(413, 'attachment_too_large');
    const buf = new Uint8Array(await file.arrayBuffer());
    const type = sniff(buf);
    if (!type) throw new HttpError(415, 'attachment_type_not_allowed');
    const key = `expense/${s.companyId}/${ap.id}/${uid()}`;
    await c.env.FILES.put(key, buf, { httpMetadata: { contentType: type } });
    if (ap.attachment_key) await c.env.FILES.delete(ap.attachment_key);
    await c.env.DB.prepare('UPDATE accounts_payable SET attachment_key=?, attachment_name=?, attachment_type=? WHERE id=? AND company_id=?')
      .bind(key, String(file.name || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 100), type, ap.id, s.companyId).run();
    await audit(c.env, s, 'attach', 'payable', ap.id);
    return json({ ok: true }, 201);
  });
  r.get('/api/finance/payables/:id/attachment', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.read');
    const ap: any = await owned(c.env, 'accounts_payable', c.params.id, s.companyId);
    const obj = ap.attachment_key ? await c.env.FILES?.get(ap.attachment_key) : null;
    if (!obj) throw new HttpError(404, 'not_found');
    return new Response(obj.body, { headers: { 'content-type': ap.attachment_type, 'content-disposition': `inline; filename="${ap.attachment_name}"`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'" } });
  });

  r.post('/api/finance/payables/:id/cancel', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.write');
    const ap = await refreshPayable(c.env, s.companyId, c.params.id);
    if (ap.paid_cents > 0) throw new HttpError(409, 'has_payments');
    await c.env.DB.prepare("UPDATE accounts_payable SET status='canceled', recurring_monthly=0 WHERE id=? AND company_id=?").bind(ap.id, s.companyId).run();
    await audit(c.env, s, 'cancel', 'payable', ap.id);
    return json({ ok: true });
  });

  r.get('/api/finance/helper-payments', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.read');
    return json(await helperPaymentsReport(c.env, s.companyId, c.query));
  });
  r.get('/api/finance/dre', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.read');
    const { from, to } = period(c.query);
    const basis = c.query.get('basis') === 'cash' ? 'cash' : 'accrual';
    return json(await computeDre(c.env, s.companyId, from, to, basis));
  });
  r.get('/api/finance/cashflow', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.read');
    const { from, to } = period(c.query);
    return json(await computeCashFlow(c.env, s.companyId, from, to));
  });
  r.get('/api/finance/opening-balances', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.read');
    return json({ items: (await c.env.DB.prepare('SELECT * FROM opening_balances WHERE company_id=? ORDER BY date DESC').bind(s.companyId).all()).results });
  });
  r.post('/api/finance/opening-balances', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.write');
    const v = validate(await c.body(), { date: { type: 'date', required: true }, amount: { type: 'money', required: true, min: -1e14 }, notes: { type: 'string', max: 500 } });
    await c.env.DB.prepare('INSERT INTO opening_balances (id,company_id,date,amount_cents,currency,notes,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(company_id,date) DO UPDATE SET amount_cents=excluded.amount_cents, notes=excluded.notes')
      .bind(uid(), s.companyId, v.date, v.amount, s.currency, v.notes ?? null, nowIso()).run();
    await audit(c.env, s, 'set', 'opening_balance', null, { date: v.date, amount: v.amount });
    return json({ ok: true });
  });
  // Reconciliation: compare the system's computed closing balance against a statement balance the user enters.
  r.get('/api/finance/reconcile', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.read');
    const { from, to } = period(c.query);
    const cf = await computeCashFlow(c.env, s.companyId, from, to);
    const stmt = c.query.get('statement_balance');
    let statement: number | null = null;
    if (stmt !== null) { const { parseMoney } = await import('../lib/core'); try { statement = parseMoney(stmt); } catch { throw new HttpError(422, 'validation_error', { statement_balance: 'money' }); } }
    return json({ ...cf, statement_balance: statement, difference: statement === null ? null : statement - cf.closing_balance, reconciled: statement !== null && statement === cf.closing_balance });
  });
  r.get('/api/finance/profitability', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.read');
    const { from, to } = period(c.query);
    return json(await computeProfitability(c.env, s.companyId, from, to));
  });

  r.get('/api/finance/overview', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.read');
    const { from, to } = period(c.query);
    const dre = await computeDre(c.env, s.companyId, from, to, 'accrual');
    const cf = await computeCashFlow(c.env, s.companyId, from, to);
    const today = todayIso();
    const ar = await c.env.DB.prepare(`SELECT COALESCE(SUM(o),0) total, COALESCE(SUM(CASE WHEN due_date<? THEN o ELSE 0 END),0) overdue FROM (
      SELECT ar.due_date, ar.amount_cents - COALESCE((SELECT SUM(CASE WHEN r.kind='receipt' THEN r.amount_cents ELSE -r.amount_cents END) FROM receipts r WHERE r.receivable_id=ar.id),0) o
      FROM accounts_receivable ar WHERE ar.company_id=? AND ar.status IN ('pending','partially_paid'))`).bind(today, s.companyId).first<any>();
    const ap = await c.env.DB.prepare(`SELECT COALESCE(SUM(o),0) total, COALESCE(SUM(CASE WHEN due_date<? THEN o ELSE 0 END),0) overdue, COALESCE(SUM(CASE WHEN kind='helper' THEN o ELSE 0 END),0) helper FROM (
      SELECT ap.due_date, ap.kind, ap.amount_cents - COALESCE((SELECT SUM(x.amount_cents) FROM payments x WHERE x.payable_id=ap.id),0) o
      FROM accounts_payable ap WHERE ap.company_id=? AND ap.status IN ('pending','partially_paid'))`).bind(today, s.companyId).first<any>();
    const monthly = (Date.parse(to) - Date.parse(from)) / 864e5 > 62;
    const bucket = monthly ? 'substr(d,1,7)' : 'd';
    const { results: series } = await c.env.DB.prepare(`SELECT ${bucket} AS k, SUM(rev) revenue, SUM(exp) expenses, SUM(cnt) cleanings FROM (
        SELECT issue_date d, gross_cents - discount_cents rev, 0 exp, CASE WHEN appointment_id IS NOT NULL THEN 1 ELSE 0 END cnt FROM accounts_receivable WHERE company_id=?1 AND status<>'canceled' AND issue_date BETWEEN ?2 AND ?3
        UNION ALL SELECT issue_date, 0, amount_cents, 0 FROM accounts_payable WHERE company_id=?1 AND status<>'canceled' AND issue_date BETWEEN ?2 AND ?3)
      GROUP BY k ORDER BY k`).bind(s.companyId, from, to).all<any>();
    const top = async (col: string, join: string, name: string) => (await c.env.DB.prepare(`SELECT ${name} AS name, SUM(ar.gross_cents - ar.discount_cents) v FROM accounts_receivable ar ${join}
      WHERE ar.company_id=? AND ar.status<>'canceled' AND ar.issue_date BETWEEN ? AND ? GROUP BY ${col} ORDER BY v DESC LIMIT 10`).bind(s.companyId, from, to).all()).results;
    const cleanings = series.reduce((a: number, b: any) => a + b.cleanings, 0);
    const costs = dre.direct_costs.total;
    return json({
      from, to, basis_note: 'Revenue/result figures are accrual-basis; cash figures are actual receipts/payments.',
      gross_revenue: dre.gross_revenue.total, revenue_deductions: dre.deductions.total, net_revenue: dre.net_revenue, helper_labor: dre.direct_costs.helper_labor,
      other_direct_costs: costs - dre.direct_costs.helper_labor, operating_expenses: dre.operating_expenses.total, gross_profit: dre.gross_profit,
      operating_result: dre.operating_result, net_result: dre.net_result, cash_receipts: cf.receipts, cash_payments: cf.payments,
      accounts_receivable: ar.total, overdue_receivables: ar.overdue, accounts_payable: ap.total, overdue_payables: ap.overdue, pending_helper_payments: ap.helper,
      cleanings, avg_revenue_per_cleaning: cleanings ? divRound(dre.net_revenue, cleanings) : 0, avg_cost_per_cleaning: cleanings ? divRound(costs, cleanings) : 0,
      series, by_property: await top('ar.property_id', 'LEFT JOIN residential_properties p ON p.id=ar.property_id', "COALESCE(p.name,'—')"),
      by_customer: await top('ar.customer_id', 'JOIN customers cu ON cu.id=ar.customer_id', 'cu.full_name'),
      by_service: await top('sv.id', 'LEFT JOIN cleaning_appointments a ON a.id=ar.appointment_id LEFT JOIN cleaning_services sv ON sv.id=a.service_id', "COALESCE(sv.name,'Other')"),
    });
  });
}
export type { Session };
