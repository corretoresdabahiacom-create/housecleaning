import React, { useState } from 'react';
import { api, centsToInput, fmtMoney, get, post, qs, today } from '../api';
import { Badge, Bars, Card, Empty, FieldDef, Form, HBars, Loading, Modal, Page, Period, PeriodPicker, Stat, Table, canUi, ExportButtons, periodFor, toast, useErr, useLoad, useMe, useT } from '../ui';

const METHODS = ['cash', 'check', 'bank_transfer', 'zelle', 'credit_card_manual', 'other'].map((v) => ({ value: v, label: 'pm_' + v }));
const usePeriod = () => { const [p, setP] = useState<Period>(() => periodFor('month')); return [p, setP] as const; };
const m = (c: number) => fmtMoney(c);
const pct = (bps: number | null) => (bps === null ? '—' : `${(bps / 100).toFixed(1)}%`);

export function FinanceOverview() {
  const { t } = useT();
  const [p, setP] = usePeriod();
  const { data, error } = useLoad(() => get(`/api/finance/overview?from=${p.from}&to=${p.to}`), [p.from, p.to]);
  return (
    <Page title={t('Financial Overview')} actions={<PeriodPicker value={p} onChange={setP} />}>
      {!data ? <Loading error={error} /> : <>
        <p className="muted small">{t('Revenue and results are accrual-basis; cash figures are actual receipts and payments.')}</p>
        <div className="stats">
          <Stat label={t('Gross revenue')} value={m(data.gross_revenue)} /><Stat label={t('Revenue deductions')} value={m(-data.revenue_deductions)} />
          <Stat label={t('Net revenue')} value={m(data.net_revenue)} /><Stat label={t('Helper labor costs')} value={m(data.helper_labor)} />
          <Stat label={t('Other direct costs')} value={m(data.other_direct_costs)} /><Stat label={t('Gross profit')} value={m(data.gross_profit)} tone={data.gross_profit < 0 ? 'bad' : 'good'} />
          <Stat label={t('Operating expenses')} value={m(data.operating_expenses)} /><Stat label={t('Operating result')} value={m(data.operating_result)} tone={data.operating_result < 0 ? 'bad' : undefined} />
          <Stat label={t('Net result')} value={m(data.net_result)} tone={data.net_result < 0 ? 'bad' : 'good'} />
        </div>
        <div className="stats">
          <Stat label={t('Cash receipts')} value={m(data.cash_receipts)} /><Stat label={t('Cash payments')} value={m(data.cash_payments)} />
          <Stat label={t('Accounts receivable')} value={m(data.accounts_receivable)} /><Stat label={t('Overdue receivables')} value={m(data.overdue_receivables)} tone={data.overdue_receivables ? 'warn' : undefined} />
          <Stat label={t('Accounts payable')} value={m(data.accounts_payable)} /><Stat label={t('Overdue payables')} value={m(data.overdue_payables)} tone={data.overdue_payables ? 'warn' : undefined} />
          <Stat label={t('Pending helper payments')} value={m(data.pending_helper_payments)} />
          <Stat label={t('Number of cleanings')} value={data.cleanings} /><Stat label={t('Average revenue per cleaning')} value={m(data.avg_revenue_per_cleaning)} /><Stat label={t('Average cost per cleaning')} value={m(data.avg_cost_per_cleaning)} />
        </div>
        <div className="grid-2">
          <Card title={t('Revenue vs expenses')}><Bars data={data.series.map((s: any) => ({ label: s.k, value: s.revenue, value2: s.expenses }))} format={m} /><div className="legend"><i className="l1" />{t('Revenue')} <i className="l2" />{t('Expenses')}</div></Card>
          <Card title={t('Net result by period')}><Bars data={data.series.map((s: any) => ({ label: s.k, value: s.revenue - s.expenses }))} format={m} /></Card>
          <Card title={t('Number of cleanings')}><Bars data={data.series.map((s: any) => ({ label: s.k, value: s.cleanings }))} format={(n) => String(n)} /></Card>
          <Card title={t('Revenue by service type')}><HBars data={data.by_service} format={m} /></Card>
          <Card title={t('Revenue by property')}><HBars data={data.by_property} format={m} /></Card>
          <Card title={t('Revenue by customer')}><HBars data={data.by_customer} format={m} /></Card>
        </div>
      </>}
    </Page>
  );
}

function ReceiptForm({ ar, onDone }: { ar: any; onDone: () => void }) {
  const { t } = useT();
  // Idempotency key generated once per form instance prevents double submission duplicates.
  const [key] = useState(() => crypto.randomUUID());
  return <Form fields={[
    { name: 'kind', label: 'Type', type: 'select', options: [{ value: 'receipt', label: 'Payment received' }, { value: 'refund', label: 'Refund' }], required: true },
    { name: 'amount', label: 'Amount (USD)', type: 'money', required: true }, { name: 'date', label: 'Payment date', type: 'date', required: true },
    { name: 'method', label: 'Payment method', type: 'select', options: METHODS, required: true }, { name: 'notes', label: 'Notes', type: 'textarea' },
  ]} initial={{ kind: 'receipt', date: today(), method: 'zelle', amount: centsToInput(ar.amount_cents - ar.received_cents) }} submitLabel="Register payment"
    onSubmit={async (v) => { await post(`/api/finance/receivables/${ar.id}/receipts`, { ...v, idempotency_key: key }); toast(t('Saved')); onDone(); }} />;
}

export function Receivables({ openOnly }: { openOnly?: boolean }) {
  const { t } = useT(); const { me } = useMe(); const onErr = useErr();
  const [status, setStatus] = useState(''); const [sel, setSel] = useState<any>(null); const [adding, setAdding] = useState(false);
  const { data, error, reload } = useLoad(() => get(`/api/finance/receivables?${qs({ status, open: openOnly ? 1 : '' })}`), [status, openOnly]);
  const detail = useLoad(() => (sel ? get(`/api/finance/receivables/${sel.id}`) : Promise.resolve(null)), [sel?.id]);
  return (
    <Page title={openOnly ? t('Accounts Receivable') : t('Revenue and Receipts')} actions={canUi(me, 'financeWrite') && <button className="btn primary" onClick={() => setAdding(true)}>+ {t('New invoice')}</button>}>
      {data && <div className="stats">
        <Stat label={t('Total outstanding')} value={m(data.summary.total_outstanding)} /><Stat label={t('Due today')} value={m(data.summary.due_today)} />
        <Stat label={t('Due this week')} value={m(data.summary.due_this_week)} /><Stat label={t('Due this month')} value={m(data.summary.due_this_month)} />
        <Stat label={t('Overdue balances')} value={m(data.summary.overdue)} tone={data.summary.overdue ? 'bad' : undefined} />
      </div>}
      <Card actions={<ExportButtons name="receivables" params={{}} />}>
        {!openOnly && <div className="row wrap filters"><select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('Status')}><option value="">{t('All statuses')}</option>{['pending', 'partially_paid', 'paid', 'canceled', 'written_off'].map((s) => <option key={s} value={s}>{t(s)}</option>)}</select></div>}
        {!data ? <Loading error={error} /> : <Table rows={data.items} onRow={setSel} cols={[
          { key: 'due_date', label: 'Due date' }, { key: 'customer_name', label: 'Customer' }, { key: 'property_name', label: 'Property', hideSm: true },
          { key: 'amount_cents', label: 'Amount', num: true, render: (r) => m(r.amount_cents) }, { key: 'received_cents', label: 'Received', num: true, hideSm: true, render: (r) => m(r.received_cents) },
          { key: 'outstanding_cents', label: 'Outstanding', num: true, render: (r) => m(r.outstanding_cents) },
          { key: 'status', label: 'Status', render: (r) => <>{<Badge s={r.status} />}{r.overdue && <Badge s="overdue" />}</> },
        ]} />}
      </Card>
      {sel && <Modal title={sel.description} onClose={() => setSel(null)}>
        {!detail.data ? <Loading /> : <>
          <dl className="dl"><dt>{t('Customer')}</dt><dd>{sel.customer_name}</dd><dt>{t('Gross')}</dt><dd>{m(detail.data.receivable.gross_cents)}</dd><dt>{t('Discounts')}</dt><dd>{m(detail.data.receivable.discount_cents)}</dd>
            <dt>{t('Amount')}</dt><dd>{m(detail.data.receivable.amount_cents)}</dd><dt>{t('Received')}</dt><dd>{m(detail.data.receivable.received_cents)}</dd><dt>{t('Outstanding')}</dt><dd><b>{m(detail.data.receivable.outstanding_cents)}</b></dd>
            <dt>{t('Issue date')}</dt><dd>{detail.data.receivable.issue_date}</dd><dt>{t('Due date')}</dt><dd>{detail.data.receivable.due_date}</dd><dt>{t('Status')}</dt><dd><Badge s={detail.data.receivable.status} /></dd></dl>
          <h3>{t('Payment history')}</h3>
          <Table rows={detail.data.receipts} cols={[{ key: 'date', label: 'Date' }, { key: 'kind', label: 'Type', render: (r) => t(r.kind) }, { key: 'method', label: 'Method', render: (r) => t('pm_' + r.method) }, { key: 'amount_cents', label: 'Amount', num: true, render: (r) => m(r.kind === 'refund' ? -r.amount_cents : r.amount_cents) }]} empty="No payments recorded." />
          {canUi(me, 'financeWrite') && !['canceled', 'written_off'].includes(detail.data.receivable.status) && <>
            <h3>{t('Register payment')}</h3><ReceiptForm ar={detail.data.receivable} onDone={() => { detail.reload(); reload(); }} />
            <div className="row end">{detail.data.receivable.received_cents === 0 && <button className="btn ghost" onClick={async () => { try { await post(`/api/finance/receivables/${sel.id}/status`, { status: 'canceled' }); setSel(null); reload(); } catch (e) { onErr(e); } }}>{t('Cancel invoice')}</button>}
              {detail.data.receivable.status !== 'paid' && <button className="btn ghost" onClick={async () => { if (!confirm(t('Write off the outstanding balance?'))) return; try { await post(`/api/finance/receivables/${sel.id}/status`, { status: 'written_off' }); setSel(null); reload(); } catch (e) { onErr(e); } }}>{t('Write off')}</button>}</div>
          </>}
        </>}
      </Modal>}
      {adding && <Modal title={t('New invoice')} onClose={() => setAdding(false)}><Form fields={[
        { name: 'customer_id', label: 'Customer', type: 'search', endpoint: '/api/customers', required: true },
        { name: 'description', label: 'Description', required: true }, { name: 'amount', label: 'Amount (USD)', type: 'money', required: true },
        { name: 'revenue_class', label: 'Revenue class', type: 'select', options: ['residential', 'deep', 'move', 'additional', 'other'].map((v) => ({ value: v, label: 'cat_' + v })) },
        { name: 'issue_date', label: 'Issue date', type: 'date', required: true }, { name: 'due_date', label: 'Due date', type: 'date', required: true },
        { name: 'installments', label: 'Installments', type: 'number' },
      ]} initial={{ issue_date: today(), due_date: today(), revenue_class: 'other', installments: '1' }} onCancel={() => setAdding(false)} onSubmit={async (v) => { await post('/api/finance/receivables', v); toast(t('Saved')); setAdding(false); reload(); }} /></Modal>}
    </Page>
  );
}

export function Payables({ kind }: { kind?: 'expense' }) {
  const { t } = useT(); const { me } = useMe(); const onErr = useErr();
  const [f, setF] = useState({ status: '', category_id: '', supplier: '', from: '', to: '' });
  const [adding, setAdding] = useState(false); const [paying, setPaying] = useState<any>(null); const [catsOpen, setCatsOpen] = useState(false);
  const cats = useLoad(() => get('/api/finance/categories'), []);
  const { data, error, reload } = useLoad(() => get(`/api/finance/payables?${qs({ ...f, kind })}`), [JSON.stringify(f), kind]);
  const [payKey] = useState(() => crypto.randomUUID());
  const expenseFields: FieldDef[] = [
    { name: 'description', label: 'Description', required: true }, { name: 'category_id', label: 'Category', type: 'select', required: true, options: (cats.data?.items || []).filter((c: any) => c.name !== 'Helper labor').map((c: any) => ({ value: c.id, label: c.name })) },
    { name: 'supplier', label: 'Supplier / payee' }, { name: 'amount', label: 'Amount (USD)', type: 'money', required: true },
    { name: 'expense_date', label: 'Expense date', type: 'date', required: true }, { name: 'due_date', label: 'Due date', type: 'date' },
    { name: 'property_id', label: 'Property (direct allocation, optional)', type: 'search', endpoint: '/api/properties', itemLabel: (x: any) => x.name + (x.customer_name ? ` — ${x.customer_name}` : '') },
    { name: 'installments', label: 'Installments', type: 'number' }, { name: 'paid_date', label: 'Paid on (leave blank if unpaid)', type: 'date' },
    { name: 'payment_method', label: 'Payment method', type: 'select', options: METHODS }, { name: 'recurring_monthly', label: 'Recurring monthly', type: 'checkbox' }, { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
  return (
    <Page title={kind ? t('Expenses') : t('Accounts Payable')} actions={canUi(me, 'financeWrite') && <><button className="btn" onClick={() => setCatsOpen(true)}>{t('Categories')}</button><button className="btn primary" onClick={() => setAdding(true)}>+ {t('Add expense')}</button></>}>
      {data && <div className="stats"><Stat label={t('Total outstanding')} value={m(data.summary.total_outstanding)} /><Stat label={t('Due in 7 days')} value={m(data.summary.upcoming_7d)} /><Stat label={t('Overdue')} value={m(data.summary.overdue)} tone={data.summary.overdue ? 'bad' : undefined} /></div>}
      <Card actions={<ExportButtons name="payables" params={{ from: f.from, to: f.to }} />}>
        <div className="row wrap filters">
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label={t('Status')}><option value="">{t('All statuses')}</option>{['pending', 'partially_paid', 'paid', 'canceled'].map((s) => <option key={s} value={s}>{t(s)}</option>)}</select>
          <select value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })} aria-label={t('Category')}><option value="">{t('All categories')}</option>{cats.data?.items.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <input placeholder={t('Supplier / payee')} value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} aria-label={t('Supplier / payee')} />
          <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label={t('From')} /><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label={t('To')} />
        </div>
        {!data ? <Loading error={error} /> : <Table rows={data.items} onRow={setPaying} cols={[
          { key: 'due_date', label: 'Due date' }, { key: 'payee', label: 'Payee' }, { key: 'description', label: 'Description', hideSm: true },
          { key: 'category_name', label: 'Category', hideSm: true }, { key: 'amount_cents', label: 'Amount', num: true, render: (r) => m(r.amount_cents) },
          { key: 'outstanding_cents', label: 'Outstanding', num: true, render: (r) => m(r.outstanding_cents) },
          { key: 'status', label: 'Status', render: (r) => <><Badge s={r.status} />{r.overdue && <Badge s="overdue" />}{r.attachment_key && <span title={t('Receipt attached')}> 📎</span>}</> },
        ]} />}
      </Card>
      {catsOpen && <CategoriesModal cats={cats.data?.items || []} onClose={() => setCatsOpen(false)} onChange={cats.reload} />}
      {adding && <Modal title={t('Add expense')} onClose={() => setAdding(false)}><Form fields={expenseFields} initial={{ expense_date: today(), installments: '1' }} onCancel={() => setAdding(false)} onSubmit={async (v) => { await post('/api/finance/expenses', v); toast(t('Saved')); setAdding(false); reload(); }} /></Modal>}
      {paying && <Modal title={`${t('Register payment')} · ${paying.payee}`} onClose={() => setPaying(null)}>
        <p>{paying.description} — {t('Outstanding')}: <b>{m(paying.outstanding_cents)}</b></p>
        <Attachment payable={paying} canEdit={canUi(me, 'financeWrite')} onChange={() => { reload(); setPaying({ ...paying, attachment_key: 'x' }); }} />
        {canUi(me, 'financeWrite') && paying.outstanding_cents > 0 && <Form fields={[{ name: 'amount', label: 'Amount (USD)', type: 'money', required: true }, { name: 'date', label: 'Payment date', type: 'date', required: true }, { name: 'method', label: 'Payment method', type: 'select', options: METHODS, required: true }, { name: 'notes', label: 'Notes', type: 'textarea' }]}
          initial={{ amount: centsToInput(paying.outstanding_cents), date: today(), method: 'zelle' }} submitLabel="Register payment"
          onSubmit={async (v) => { await post(`/api/finance/payables/${paying.id}/payments`, { ...v, idempotency_key: `${payKey}:${paying.id}` }); toast(t('Saved')); setPaying(null); reload(); }} />}
        {canUi(me, 'financeWrite') && paying.paid_cents === 0 && paying.status !== 'canceled' && <div className="row end"><button className="btn ghost" onClick={async () => { try { await post(`/api/finance/payables/${paying.id}/cancel`); setPaying(null); reload(); } catch (e) { onErr(e); } }}>{t('Cancel bill')}</button></div>}
      </Modal>}
    </Page>
  );
}

function Attachment({ payable, canEdit, onChange }: { payable: any; canEdit: boolean; onChange: () => void }) {
  const { t } = useT(); const onErr = useErr(); const [busy, setBusy] = useState(false);
  return <div className="row wrap attach">
    {payable.attachment_key ? <a className="btn sm ghost" href={`/api/finance/payables/${payable.id}/attachment`} target="_blank" rel="noopener">📎 {payable.attachment_name || t('View receipt')}</a> : <span className="muted small">{t('No receipt attached.')}</span>}
    {canEdit && <label className="btn sm">{busy ? t('Saving…') : payable.attachment_key ? t('Replace receipt') : t('Attach receipt')}
      <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; if (!f) return; setBusy(true);
        try { const fd = new FormData(); fd.set('file', f); await api(`/api/finance/payables/${payable.id}/attachment`, { method: 'POST', form: fd }); toast(t('Saved')); onChange(); } catch (er) { onErr(er); } finally { setBusy(false); e.target.value = ''; }
      }} /></label>}
  </div>;
}

const DRE_GROUPS = ['direct_cost', 'operating_expense', 'financial', 'tax_deduction'];
function CategoriesModal({ cats, onClose, onChange }: { cats: any[]; onClose: () => void; onChange: () => void }) {
  const { t } = useT();
  return <Modal title={t('Financial categories')} onClose={onClose}>
    <p className="muted small">{t('Each category belongs to one DRE line, so custom categories appear in the right place of the income statement.')}</p>
    {DRE_GROUPS.map((g) => <div key={g}><h3>{t('dre_' + g)}</h3><div className="row wrap">{cats.filter((c) => c.dre_group === g).map((c) => <span key={c.id} className="badge">{c.name}</span>)}</div></div>)}
    <h3>{t('New category')}</h3>
    <Form fields={[{ name: 'name', label: 'Name', required: true }, { name: 'dre_group', label: 'DRE line', type: 'select', required: true, options: DRE_GROUPS.map((g) => ({ value: g, label: 'dre_' + g })) }]}
      initial={{ dre_group: 'operating_expense' }} submitLabel="Add" onSubmit={async (v) => { await post('/api/finance/categories', v); toast(t('Saved')); onChange(); }} />
  </Modal>;
}

export function HelperPayments() {
  const { t } = useT(); const { me } = useMe(); const onErr = useErr();
  const [p, setP] = usePeriod();
  const [f, setF] = useState({ helper_ids: '', team_id: '', property_id: '', city: '', state: '' });
  const helpers = useLoad(() => get('/api/helpers?status=all'), []); const teams = useLoad(() => get('/api/teams'), []);
  const { data, error, reload } = useLoad(() => get(`/api/finance/helper-payments?${qs({ from: p.from, to: p.to, ...f })}`), [p.from, p.to, JSON.stringify(f)]);
  const [batchKey] = useState(() => crypto.randomUUID());
  const payAll = async (ids: string[]) => {
    if (!ids.length || !confirm(t('Record payment of all outstanding balances shown?'))) return;
    try { const r = await post('/api/finance/helper-payments/pay', { payable_ids: ids, date: today(), method: 'zelle', batch_key: batchKey }); toast(t('{n} payments recorded', { n: r.paid.length })); reload(); } catch (e) { onErr(e); }
  };
  return (
    <Page title={t('Helper Payments')} actions={<PeriodPicker value={p} onChange={setP} />}>
      <Card>
        <div className="row wrap filters">
          <select value={f.helper_ids} onChange={(e) => setF({ ...f, helper_ids: e.target.value })} aria-label={t('Helper')}><option value="">{t('All helpers')}</option>{helpers.data?.items.map((h: any) => <option key={h.id} value={h.id}>{h.full_name}</option>)}</select>
          <select value={f.team_id} onChange={(e) => setF({ ...f, team_id: e.target.value })} aria-label={t('Team')}><option value="">{t('All teams')}</option>{teams.data?.items.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          <input className="sm" placeholder={t('City')} value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} aria-label={t('City')} />
          <input className="sm" placeholder={t('State')} value={f.state} onChange={(e) => setF({ ...f, state: e.target.value.toUpperCase() })} aria-label={t('State')} maxLength={2} />
          <ExportButtons name="helper-payments" params={{ from: p.from, to: p.to, ...f }} />
          
        </div>
        {!data ? <Loading error={error} /> : <>
          <div className="stats"><Stat label={t('Total amount due')} value={m(data.totals.due_cents)} /><Stat label={t('Amount paid')} value={m(data.totals.paid_cents)} /><Stat label={t('Remaining balance')} value={m(data.totals.due_cents - data.totals.paid_cents)} tone={data.totals.due_cents - data.totals.paid_cents ? 'warn' : 'good'} /></div>
          <h3>{t('Consolidated report')}</h3>
          <Table rows={data.summary} cols={[{ key: 'helper_name', label: 'Helper' }, { key: 'cleanings', label: 'Cleanings', num: true }, { key: 'workdays', label: 'Workdays', num: true, hideSm: true }, { key: 'hours', label: 'Hours', num: true, hideSm: true },
            { key: 'properties', label: 'Properties serviced', hideSm: true, render: (r) => r.properties.join(', ') }, { key: 'due_cents', label: 'Due', num: true, render: (r) => m(r.due_cents) }, { key: 'paid_cents', label: 'Paid', num: true, render: (r) => m(r.paid_cents) }, { key: 'balance_cents', label: 'Balance', num: true, render: (r) => m(r.balance_cents) }]} empty="No completed cleanings in this period." />
          <h3>{t('Completed appointments')}</h3>
          <Table rows={data.items} cols={[{ key: 'service_date', label: 'Date' }, { key: 'helper_name', label: 'Helper' }, { key: 'property_name', label: 'Property' }, { key: 'pay_basis', label: 'Basis', hideSm: true, render: (r) => `${t(r.pay_basis)}${r.pay_basis === 'hourly' ? ` (${r.worked_minutes} min)` : ''}` },
            { key: 'amount_cents', label: 'Agreed amount', num: true, render: (r) => m(r.amount_cents) }, { key: 'paid_cents', label: 'Paid', num: true, render: (r) => m(r.paid_cents) }, { key: 'status', label: 'Status', render: (r) => <Badge s={r.status} /> }]} />
          {canUi(me, 'financeWrite') && <div className="row end"><button className="btn primary" onClick={() => payAll(data.items.filter((x: any) => x.balance_cents > 0).map((x: any) => x.id))}>{t('Pay all outstanding shown')}</button></div>}
        </>}
      </Card>
    </Page>
  );
}

function DreLine({ label, v, strong, sub }: { label: string; v: number; strong?: boolean; sub?: boolean }) {
  return <tr className={`${strong ? 'strong' : ''} ${sub ? 'sub' : ''}`}><td>{label}</td><td className={`num ${v < 0 ? 'neg' : ''}`}>{fmtMoney(v)}</td></tr>;
}
export function DrePage() {
  const { t } = useT();
  const [p, setP] = usePeriod(); const [basis, setBasis] = useState<'accrual' | 'cash'>('accrual');
  const { data: d, error } = useLoad(() => get(`/api/finance/dre?from=${p.from}&to=${p.to}&basis=${basis}`), [p.from, p.to, basis]);
  const subs = (o: any, neg = false) => Object.entries(o).filter(([k, v]) => k !== 'total' && v).map(([k, v]: any) => <DreLine key={k} sub label={t(k)} v={neg ? -v : v} />);
  return (
    <Page title={t('DRE — Income Statement')} actions={<><PeriodPicker value={p} onChange={setP} />
      <div className="seg">{(['accrual', 'cash'] as const).map((b) => <button key={b} className={basis === b ? 'on' : ''} onClick={() => setBasis(b)}>{t('basis_' + b)}</button>)}</div>
      <ExportButtons name="dre" params={{ from: p.from, to: p.to, basis }} /></>}>
      {!d ? <Loading error={error} /> : <Card>
        <div className="basis-tag">{t('Basis')}: <b>{t('basis_' + d.basis)}</b> · {d.from} → {d.to}</div>
        <table className="dre"><tbody>
          <DreLine strong label={t('1. Gross Revenue')} v={d.gross_revenue.total} />{subs(d.gross_revenue)}
          <DreLine strong label={t('2. Revenue Deductions')} v={-d.deductions.total} />{subs(d.deductions, true)}
          <DreLine strong label={t('3. Net Revenue')} v={d.net_revenue} />
          <DreLine strong label={t('4. Direct Costs')} v={-d.direct_costs.total} />{subs(d.direct_costs, true)}
          <DreLine strong label={t('5. Gross Profit')} v={d.gross_profit} />
          <DreLine strong label={t('6. Operating Expenses')} v={-d.operating_expenses.total} />{subs(d.operating_expenses, true)}
          <DreLine strong label={t('7. Operating Result')} v={d.operating_result} />
          <DreLine strong label={t('8. Financial Result')} v={d.financial_result} />
          <DreLine strong label={t('9. Net Result')} v={d.net_result} />
        </tbody></table>
        <p className="muted small">{t('Gross margin')}: {pct(d.margins_bps.gross)} · {t('Net margin')}: {pct(d.margins_bps.net)}</p>
        <p className="disclaimer">{t('Management report. Not a GAAP-compliant or tax-ready financial statement. Review with a qualified US accountant or CPA.')}</p>
      </Card>}
    </Page>
  );
}

export function CashFlowPage() {
  const { t } = useT(); const { me } = useMe();
  const [p, setP] = usePeriod(); const [ob, setOb] = useState(false); const [stmt, setStmt] = useState('');
  const { data, error, reload } = useLoad(() => get(`/api/finance/cashflow?from=${p.from}&to=${p.to}`), [p.from, p.to]);
  const rec = useLoad(() => (stmt && /^-?\d+(\.\d{1,2})?$/.test(stmt) ? get(`/api/finance/reconcile?from=${p.from}&to=${p.to}&statement_balance=${stmt}`) : Promise.resolve(null)), [stmt, p.from, p.to]);
  return (
    <Page title={t('Cash Flow')} actions={<><PeriodPicker value={p} onChange={setP} />{canUi(me, 'financeWrite') && <button className="btn" onClick={() => setOb(true)}>{t('Set opening balance')}</button>}</>}>
      {!data ? <Loading error={error} /> : <>
        <div className="stats"><Stat label={t('Opening balance')} value={m(data.opening_balance)} /><Stat label={t('Actual receipts')} value={m(data.receipts)} tone="good" /><Stat label={t('Actual payments')} value={m(data.payments)} />
          <Stat label={t('Net cash movement')} value={m(data.net_movement)} tone={data.net_movement < 0 ? 'bad' : 'good'} /><Stat label={t('Closing balance')} value={m(data.closing_balance)} /></div>
        {!data.opening_balance_source && <p className="muted small">{t('No opening balance registered on or before this period — starting from zero.')}</p>}
        <Card title={t('Daily cash movement')}><Bars data={data.by_day.map((x: any) => ({ label: x.d, value: x.inflow, value2: x.outflow }))} format={m} /><div className="legend"><i className="l1" />{t('Receipts')} <i className="l2" />{t('Payments')}</div></Card>
        <Card title={t('Reconciliation')}>
          <div className="row wrap"><label className="row">{t('Bank statement closing balance')} <input inputMode="decimal" className="sm" placeholder="0.00" value={stmt} onChange={(e) => setStmt(e.target.value)} /></label>
            {rec.data && <span className={rec.data.reconciled ? 'ok-text' : 'bad-text'}>{rec.data.reconciled ? '✓ ' + t('Reconciled') : `${t('Difference')}: ${m(rec.data.difference)}`}</span>}</div>
          <p className="muted small">{t('Bank connectivity is not integrated; enter the statement balance manually.')}</p>
        </Card>
      </>}
      {ob && <Modal title={t('Set opening balance')} onClose={() => setOb(false)}><Form fields={[{ name: 'date', label: 'Date', type: 'date', required: true }, { name: 'amount', label: 'Amount (USD)', type: 'money', required: true }, { name: 'notes', label: 'Notes', type: 'textarea' }]} initial={{ date: p.from }} onCancel={() => setOb(false)} onSubmit={async (v) => { await post('/api/finance/opening-balances', v); toast(t('Saved')); setOb(false); reload(); }} /></Modal>}
    </Page>
  );
}

export function Profitability() {
  const { t } = useT();
  const [p, setP] = usePeriod(); const [by, setBy] = useState<'property' | 'customer'>('property');
  const { data, error } = useLoad(() => get(`/api/finance/profitability?from=${p.from}&to=${p.to}`), [p.from, p.to]);
  let rows: any[] = data?.items || [];
  if (by === 'customer') {
    const g = new Map<string, any>();
    for (const r of rows) { const x = g.get(r.customer_id) || { id: r.customer_id, name: r.customer_name, cleanings: 0, net_revenue: 0, helper_labor: 0, direct_supplies: 0, other_allocated: 0, gross_contribution: 0 };
      for (const k of ['cleanings', 'net_revenue', 'helper_labor', 'direct_supplies', 'other_allocated', 'gross_contribution']) x[k] += r[k]; g.set(r.customer_id, x); }
    rows = [...g.values()].map((x) => ({ ...x, contribution_bps: x.net_revenue ? Math.trunc((x.gross_contribution * 10000) / x.net_revenue) : null /* display-only percentage */ }));
  }
  return (
    <Page title={t('Property Profitability')} actions={<><PeriodPicker value={p} onChange={setP} /><div className="seg">{(['property', 'customer'] as const).map((b) => <button key={b} className={by === b ? 'on' : ''} onClick={() => setBy(b)}>{t(b === 'property' ? 'By property' : 'By customer')}</button>)}</div>
      <ExportButtons name="profitability" params={{ from: p.from, to: p.to }} /></>}>
      <Card>
        <p className="muted small">{t('Gross contribution = net revenue − helper labor − direct supplies − other directly allocated expenses. It is NOT net profit: indirect company expenses are not allocated.')}</p>
        {!data ? <Loading error={error} /> : <Table rows={rows.sort((a, b) => b.gross_contribution - a.gross_contribution)} cols={[
          { key: 'name', label: by === 'property' ? 'Property' : 'Customer' }, { key: 'cleanings', label: 'Cleanings', num: true, hideSm: true },
          { key: 'net_revenue', label: 'Net revenue', num: true, render: (r) => m(r.net_revenue) }, { key: 'helper_labor', label: 'Helper labor', num: true, hideSm: true, render: (r) => m(r.helper_labor) },
          { key: 'direct_supplies', label: 'Direct supplies', num: true, hideSm: true, render: (r) => m(r.direct_supplies) }, { key: 'other_allocated', label: 'Other allocated', num: true, hideSm: true, render: (r) => m(r.other_allocated) },
          { key: 'gross_contribution', label: 'Gross contribution', num: true, render: (r) => <span className={r.gross_contribution < 0 ? 'bad-text' : ''}>{m(r.gross_contribution)}</span> },
          { key: 'contribution_bps', label: 'Margin', num: true, render: (r) => pct(r.contribution_bps) },
        ]} empty="No completed cleanings in this period." />}
      </Card>
    </Page>
  );
}
export { Empty };
