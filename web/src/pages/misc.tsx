import React, { useEffect, useRef, useState } from 'react';
import { api, fmtMoney, get, post, put, waUrl } from '../api';
import { Badge, Card, Empty, Form, Loading, Modal, Page, Period, PeriodPicker, Stat, Table, canUi, downloadReport, periodFor, toast, useErr, useLoad, useMe, useT } from '../ui';

export function Dashboard() {
  const { t } = useT(); const { me } = useMe();
  const { data, error } = useLoad(() => get('/api/dashboard'), []);
  if (!data) return <Loading error={error} />;
  return (
    <Page title={t('Dashboard')}>
      <div className="quick row wrap">
        {canUi(me, 'write') && <a className="btn" href="#/customers">+ {t('Add customer')}</a>}
        {canUi(me, 'write') && <a className="btn" href="#/properties">+ {t('Add residence')}</a>}
        {canUi(me, 'schedule') && <a className="btn primary" href="#/calendar">+ {t('Schedule cleaning')}</a>}
        <a className="btn" href="#/properties">{t('Assign helpers')}</a>
        {canUi(me, 'financeWrite') && <a className="btn" href="#/finance/receivables?open=1">{t('Register payment')}</a>}
        <a className="btn" href="#/properties">{t('View property history')}</a>
      </div>
      <div className="stats">
        <Stat label={t('Total customers')} value={data.total_customers} /><Stat label={t('Active customers')} value={data.active_customers} />
        <Stat label={t('Total properties')} value={data.total_properties} /><Stat label={t('Active recurring properties')} value={data.active_recurring_properties} />
        <Stat label={t('One-time properties')} value={data.one_time_properties} /><Stat label={t('Upcoming cleaning appointments')} value={data.upcoming_appointments} />
        <Stat label={t('Completed cleanings')} value={data.completed_cleanings} /><Stat label={t('Canceled appointments')} value={data.canceled_appointments} />
        {data.outstanding_balances !== null && <Stat label={t('Outstanding customer balances')} value={fmtMoney(data.outstanding_balances)} tone={data.outstanding_balances ? 'warn' : undefined} />}
      </div>
      <div className="grid-2">
        <Card title={t("Today's cleanings")} actions={<a className="btn sm ghost" href="#/calendar?view=day">{t('Open calendar')}</a>}>
          {data.today.length ? <ul className="list">{data.today.map((a: any) => <li key={a.id}><a href={`#/calendar?view=day&appointment=${a.id}`}><b>{a.start_time}</b> {a.property_name}</a><span><span className="muted">{a.city}</span> <Badge s={a.status} /></span></li>)}</ul> : <Empty>{t('No cleanings scheduled.')}</Empty>}
        </Card>
        {data.recent_payments && <Card title={t('Recent payments')}>
          {data.recent_payments.length ? <ul className="list">{data.recent_payments.map((p: any, i: number) => <li key={i}><span>{p.customer} <small className="muted">{p.date} · {t('pm_' + p.method)}</small></span><b className={p.kind === 'refund' ? 'bad-text' : ''}>{fmtMoney(p.kind === 'refund' ? -p.amount_cents : p.amount_cents)}</b></li>)}</ul> : <Empty />}
        </Card>}
      </div>
    </Page>
  );
}

export function Messages() {
  const { t } = useT(); const { me } = useMe(); const onErr = useErr();
  const initial = new URLSearchParams(location.hash.split('?')[1] || '').get('c');
  const convs = useLoad(() => get('/api/conversations'), []);
  const [active, setActive] = useState<string | null>(initial);
  const [text, setText] = useState(''); const fileRef = useRef<HTMLInputElement>(null);
  const [bulk, setBulk] = useState(false); const [newConv, setNewConv] = useState(false);
  const msgs = useLoad(() => (active ? get(`/api/conversations/${active}/messages`) : Promise.resolve({ items: [] })), [active]);
  const helpers = useLoad(() => (me.role === 'helper' ? Promise.resolve({ items: [] }) : get('/api/helpers')), []);
  useEffect(() => { if (!active && convs.data?.items?.length && window.innerWidth > 800) setActive(convs.data.items[0].id); }, [convs.data]);
  useEffect(() => { if (!active) return; const i = setInterval(() => msgs.reload(), 15000); return () => clearInterval(i); }, [active]);
  const conv = convs.data?.items.find((c: any) => c.id === active);
  const send = async () => {
    const file = fileRef.current?.files?.[0];
    if (!text.trim() && !file) return;
    try {
      if (file) { const fd = new FormData(); fd.set('body', text); fd.set('file', file); await api(`/api/conversations/${active}/messages`, { method: 'POST', form: fd }); fileRef.current!.value = ''; }
      else await post(`/api/conversations/${active}/messages`, { body: text });
      setText(''); msgs.reload(); convs.reload();
    } catch (e) { onErr(e); }
  };
  return (
    <Page title={t('Messages')} actions={me.role !== 'helper' && <><button className="btn" onClick={() => setNewConv(true)}>+ {t('New conversation')}</button><button className="btn primary" onClick={() => setBulk(true)}>{t('Private announcement')}</button></>}>
      <p className="muted small">🔒 {t('Messages are private and expire automatically 24 hours after they are sent.')}</p>
      <div className={`chat ${active ? 'has-active' : ''}`}>
        <div className="chat-list">
          {!convs.data ? <Loading /> : convs.data.items.length === 0 ? <Empty /> : convs.data.items.map((c: any) => (
            <button key={c.id} className={`chat-item ${c.id === active ? 'on' : ''}`} onClick={() => setActive(c.id)}><b>{c.helper_name}</b><small className="muted">{c.last_body ? c.last_body.slice(0, 50) : t('No active messages')}</small></button>))}
        </div>
        <div className="chat-pane">
          {!active ? <Empty>{t('Select a conversation')}</Empty> : <>
            <div className="chat-h row between"><button className="btn ghost sm back" onClick={() => setActive(null)}>‹</button><b>{conv?.helper_name}</b>
              <span className="row">{conv?.whatsapp && <a className="btn sm ghost" href={waUrl(conv.whatsapp)} target="_blank" rel="noopener noreferrer">WhatsApp</a>}<a className="btn sm ghost" href={`/api/conversations/${active}/export`}>{t('Export')}</a></span></div>
            <div className="chat-msgs" aria-live="polite">{msgs.data?.items.map((mm: any) => (
              <div key={mm.id} className={`msg ${(mm.sender_side === 'helper') === (me.role === 'helper') ? 'mine' : ''}`}>
                <div className="pre">{mm.body}</div>
                {mm.has_attachment ? <a href={`/api/messages/${mm.id}/attachment`} className="link">📎 {mm.attachment_name}</a> : null}
                <small>{new Date(mm.created_at).toLocaleString()} · {t('expires')} {new Date(mm.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
              </div>))}</div>
            <form className="chat-input row" onSubmit={(e) => { e.preventDefault(); send(); }}>
              <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Write a message…')} aria-label={t('Message')} maxLength={4000} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <label className="btn ghost sm" title={t('Attach')}>📎<input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden /></label>
              <button className="btn primary">{t('Send')}</button>
            </form>
            <small className="muted">{t('Automatic translation is not enabled; messages are stored exactly as written.')}</small>
          </>}
        </div>
      </div>
      {newConv && <Modal title={t('New conversation')} onClose={() => setNewConv(false)}><ul className="list">{helpers.data?.items.map((h: any) => <li key={h.id}><button className="link" onClick={async () => { const r = await post('/api/conversations', { helper_id: h.id }); setNewConv(false); convs.reload(); setActive(r.id); }}>{h.full_name}</button></li>)}</ul></Modal>}
      {bulk && <BulkModal helpers={helpers.data?.items || []} onClose={() => { setBulk(false); convs.reload(); }} />}
    </Page>
  );
}

function BulkModal({ helpers, onClose }: { helpers: any[]; onClose: () => void }) {
  const { t } = useT(); const onErr = useErr();
  const [ids, setIds] = useState<string[]>([]); const [body, setBody] = useState('');
  return <Modal title={t('Private announcement')} onClose={onClose}>
    <p className="muted small">{t('Each helper receives the message in their own private conversation. No group is created.')}</p>
    <label className="chip"><input type="checkbox" checked={ids.length === helpers.length && helpers.length > 0} onChange={(e) => setIds(e.target.checked ? helpers.map((h) => h.id) : [])} />{t('Select all')}</label>
    <div className="row wrap">{helpers.map((h) => <label key={h.id} className="chip"><input type="checkbox" checked={ids.includes(h.id)} onChange={(e) => setIds(e.target.checked ? [...ids, h.id] : ids.filter((x) => x !== h.id))} />{h.full_name}</label>)}</div>
    <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('Write a message…')} aria-label={t('Message')} />
    <div className="row end"><button className="btn primary" disabled={!ids.length || !body.trim()} onClick={async () => { try { const r = await post('/api/messages/bulk', { helper_ids: ids, body }); toast(t('Sent privately to {n} helpers', { n: r.delivered })); onClose(); } catch (e) { onErr(e); } }}>{t('Send')}</button></div>
  </Modal>;
}

const REPORTS: { group: string; items: [string, string, boolean?][] }[] = [
  { group: 'Operational reports', items: [['customers', 'Customers'], ['properties', 'Properties'], ['properties-by-city', 'Properties by city'], ['properties-by-state', 'Properties by state'], ['recurring-customers', 'Recurring customers'],
    ['appointments', 'Cleaning appointments', true], ['completed-cleanings', 'Completed cleanings', true], ['canceled-appointments', 'Canceled appointments', true], ['helper-assignments', 'Helper assignments', true], ['helper-productivity', 'Helper productivity', true]] },
  { group: 'Financial reports', items: [['revenue-by-period', 'Revenue by period', true], ['revenue-by-property', 'Revenue by property', true], ['revenue-by-customer', 'Revenue by customer', true], ['revenue-by-service', 'Revenue by service', true],
    ['expenses-by-period', 'Expenses by period', true], ['expenses-by-category', 'Expenses by category', true], ['receivables', 'Receivables', true], ['payables', 'Payables', true], ['helper-payments', 'Helper payments', true], ['profitability', 'Property profitability', true], ['dre', 'DRE', true], ['cashflow', 'Cash flow', true]] },
];
export function Reports() {
  const { t } = useT();
  const [p, setP] = useState<Period>(() => periodFor('month'));
  const [preview, setPreview] = useState<{ name: string; label: string } | null>(null);
  const data = useLoad(() => (preview ? get(`/api/reports/${preview.name}?from=${p.from}&to=${p.to}`) : Promise.resolve(null)), [preview?.name, p.from, p.to]);
  return (
    <Page title={t('Reports')} actions={<PeriodPicker value={p} onChange={setP} />}>
      {REPORTS.map((g) => <Card key={g.group} title={t(g.group)}><div className="report-grid">{g.items.map(([name, label, dated]) => (
        <div key={name} className="report-item"><span>{t(label)}{dated && <small className="muted"> · {p.from} → {p.to}</small>}</span>
          <span className="row"><button className="btn sm ghost" onClick={() => setPreview({ name, label })}>{t('View')}</button><button className="btn sm" onClick={() => downloadReport(name, { from: p.from, to: p.to })}>CSV</button></span></div>))}</div></Card>)}
      <p className="muted small">{t('PDF: open a report and use Print → Save as PDF. XLSX: open the CSV in Excel.')}</p>
      {preview && <Modal title={t(preview.label)} onClose={() => setPreview(null)}>
        {!data.data ? <Loading error={data.error} /> : <>
          <Table rows={data.data.rows} cols={Object.keys(data.data.rows[0] || {}).map((k) => ({ key: k, label: k, num: data.data.money_columns.includes(k), render: data.data.money_columns.includes(k) ? (r: any) => (typeof r[k] === 'number' ? fmtMoney(r[k]) : r[k]) : undefined }))} />
          <div className="row end"><button className="btn ghost" onClick={() => window.print()}>{t('Print / PDF')}</button></div>
        </>}
      </Modal>}
    </Page>
  );
}

export function Settings() {
  const { t, lang, setLang } = useT(); const { me } = useMe(); const onErr = useErr();
  const sessions = useLoad(() => get('/api/auth/sessions'), []);
  const members = useLoad(() => (canUi(me, 'manage') ? get('/api/members') : Promise.resolve({ members: [] })), []);
  const helpers = useLoad(() => (canUi(me, 'manage') ? get('/api/helpers') : Promise.resolve({ items: [] })), []);
  const [adding, setAdding] = useState(false); const [del, setDel] = useState(false);
  return (
    <Page title={t('Settings')}>
      <div className="grid-2">
        <Card title={t('Account')}>
          <dl className="dl"><dt>{t('Name')}</dt><dd>{me.user.full_name}</dd><dt>{t('Email')}</dt><dd>{me.user.email} {me.user.email_verified_at ? '✓' : ''}</dd><dt>{t('Company')}</dt><dd>{me.company.name}</dd><dt>{t('Role')}</dt><dd>{t('role_' + me.role)}</dd><dt>{t('Currency')}</dt><dd>{me.company.currency}</dd><dt>{t('Time zone')}</dt><dd>{me.company.timezone}</dd></dl>
          <label className="field"><span>{t('Language')}</span><select value={lang} onChange={(e) => { setLang(e.target.value as any); put('/api/auth/language', { language: e.target.value }); }}><option value="en">English</option><option value="pt">Português</option><option value="es">Español</option></select></label>
        </Card>
        <Card title={t('Active sessions')} actions={<button className="btn sm" onClick={async () => { await post('/api/auth/sessions/revoke-others'); sessions.reload(); toast(t('Other sessions signed out')); }}>{t('Sign out other sessions')}</button>}>
          <ul className="list">{sessions.data?.sessions.map((s: any) => <li key={s.id}><span>{(s.user_agent || '—').slice(0, 60)}</span><small className="muted">{s.created_at.slice(0, 16).replace('T', ' ')}{s.current ? ` · ${t('this device')}` : ''}</small></li>)}</ul>
        </Card>
      </div>
      {canUi(me, 'manage') && <Card title={t('Users & roles')} actions={<button className="btn sm primary" onClick={() => setAdding(true)}>+ {t('Add user')}</button>}>
        <Table rows={members.data?.members || []} cols={[{ key: 'full_name', label: 'Name' }, { key: 'email', label: 'Email', hideSm: true }, { key: 'role', label: 'Role', render: (r) => t('role_' + r.role) },
          { key: 'status', label: 'Status', render: (r) => r.role === 'owner' ? <Badge s={r.status} /> : <button className="btn sm ghost" onClick={async () => { try { await put(`/api/members/${r.id}`, { status: r.status === 'active' ? 'disabled' : 'active' }); members.reload(); } catch (e) { onErr(e); } }}><Badge s={r.status} /></button> }]} />
        <p className="muted small">{t('Permissions are enforced by the server. Schedulers cannot see finances; helpers only see their own messages.')}</p>
      </Card>}
      {me.role === 'owner' && <Card title={t('Danger zone')}><button className="btn danger" onClick={() => setDel(true)}>{t('Delete company account')}</button></Card>}
      <Card title={t('Legal')}><p className="small muted">{t('This application is a management tool. It is not a payroll provider, staffing agency, employer of record, or legal/tax compliance service. Financial reports should be reviewed by a qualified US accountant or CPA.')}</p></Card>
      {adding && <Modal title={t('Add user')} onClose={() => setAdding(false)}><Form fields={[
        { name: 'full_name', label: 'Full name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'role', label: 'Role', type: 'select', required: true, options: ['admin', 'manager', 'scheduler', 'finance', 'helper'].map((r) => ({ value: r, label: 'role_' + r })) },
        { name: 'helper_id', label: 'Linked helper (for helper role)', type: 'select', options: (helpers.data?.items || []).map((h: any) => ({ value: h.id, label: h.full_name })) },
        { name: 'temporary_password', label: 'Temporary password', type: 'password', required: true, help: 'Share it securely; the user should change it via “Forgot password”.' },
      ]} initial={{ role: 'scheduler' }} onCancel={() => setAdding(false)} onSubmit={async (v) => { await post('/api/members', v); toast(t('Saved')); setAdding(false); members.reload(); }} /></Modal>}
      {del && <Modal title={t('Delete company account')} onClose={() => setDel(false)}><p>{t('This deactivates the company immediately and schedules data deletion according to the retention policy.')}</p>
        <Form fields={[{ name: 'password', label: 'Confirm your password', type: 'password', required: true }]} submitLabel="Delete company account" onCancel={() => setDel(false)} onSubmit={async (v) => { await post('/api/company/delete', v); location.reload(); }} /></Modal>}
    </Page>
  );
}

export function AdminPage() {
  const { t } = useT(); const onErr = useErr();
  const companies = useLoad(() => get('/api/admin/companies'), []);
  const health = useLoad(() => get('/api/admin/health'), []);
  return (
    <Page title={t('Platform admin')}>
      <p className="muted small">{t('Aggregate data only. Platform administrators cannot view customer records, addresses, financial records or messages. All actions are audited.')}</p>
      {health.data && <div className="stats">{Object.entries(health.data.metrics || {}).map(([k, v]: any) => <Stat key={k} label={k} value={v} />)}</div>}
      <Card title={t('Companies')}>{!companies.data ? <Loading error={companies.error} /> : <Table rows={companies.data.items} cols={[
        { key: 'name', label: 'Company' }, { key: 'state', label: 'State' }, { key: 'members', label: 'Users', num: true }, { key: 'properties', label: 'Properties', num: true }, { key: 'appointments', label: 'Appointments', num: true },
        { key: 'status', label: 'Status', render: (r) => <Badge s={r.status} /> },
        { key: 'act', label: '', render: (r) => r.status !== 'deleted' && <button className="btn sm ghost" onClick={async () => { const reason = prompt(t('Reason (audited)')); if (!reason) return; try { await post(`/api/admin/companies/${r.id}/status`, { status: r.status === 'active' ? 'suspended' : 'active', reason }); companies.reload(); } catch (e) { onErr(e); } }}>{r.status === 'active' ? t('Suspend') : t('Activate')}</button> },
      ]} />}</Card>
      <Card title={t('Background jobs')}>{health.data && <Table rows={health.data.jobs} cols={[{ key: 'finished_at', label: 'Finished' }, { key: 'job', label: 'Job' }, { key: 'status', label: 'Status', render: (r) => <Badge s={r.status === 'ok' ? 'paid' : 'overdue'} /> }, { key: 'attempts', label: 'Attempts', num: true }]} />}</Card>
      <Card title={t('Security events (7 days)')}>{health.data && <Table rows={health.data.security_events_7d} cols={[{ key: 'kind', label: 'Event' }, { key: 'n', label: 'Count', num: true }]} />}</Card>
    </Page>
  );
}
