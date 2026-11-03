import React, { useState } from 'react';
import { ApiError, addDays, centsToInput, del, fmtMoney, get, mapsUrl, post, put, qs, today, waUrl } from '../api';
import { Badge, Card, Empty, Loading, Modal, Page, SearchSelect, canUi, toast, useErr, useLoad, useMe, useT } from '../ui';
const propLabel = (x: any) => x.name + (x.customer_name ? ` — ${x.customer_name}` : '');
import { STATE_OPTIONS } from './auth';

const STATUSES = ['scheduled', 'confirmed', 'pending_confirmation', 'in_progress', 'completed', 'canceled', 'rescheduled', 'customer_unavailable'];
type View = 'day' | 'week' | 'month';

function range(view: View, anchor: string) {
  const d = new Date(anchor + 'T00:00:00Z');
  if (view === 'day') return { from: anchor, to: anchor };
  if (view === 'week') { const s = addDays(anchor, -d.getUTCDay()); return { from: s, to: addDays(s, 6) }; }
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { from: addDays(first.toISOString().slice(0, 10), -first.getUTCDay()), to: addDays(last.toISOString().slice(0, 10), 6 - last.getUTCDay()) };
}

export function CalendarPage({ initial }: { initial: Record<string, string> }) {
  const { t, lang } = useT(); const { me } = useMe();
  const [view, setView] = useState<View>((initial.view as View) || (window.innerWidth < 700 ? 'day' : 'week'));
  const [anchor, setAnchor] = useState(initial.date || today());
  const [f, setF] = useState<Record<string, string>>({ helper_id: initial.helper_id || '', team_id: initial.team_id || '', property_id: initial.property_id || '', customer_id: '', city: '', state: '', service_id: '', status: '' });
  const [groupCity, setGroupCity] = useState(false);
  const [open, setOpen] = useState<string | null>(initial.appointment || null);
  const [creating, setCreating] = useState<string | null>(null);
  const r = range(view, anchor);
  const { data, error, reload } = useLoad(() => get(`/api/appointments?${qs({ ...r, ...f })}`), [r.from, r.to, JSON.stringify(f)]);
  const helpers = useLoad(() => get('/api/helpers'), []); const teams = useLoad(() => get('/api/teams'), []);
  const services = useLoad(() => get('/api/services'), []);
  const step = (n: number) => setAnchor(view === 'day' ? addDays(anchor, n) : view === 'week' ? addDays(anchor, 7 * n) : (() => { const d = new Date(anchor + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n, 1); return d.toISOString().slice(0, 10); })());
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const fmtDay = (d: string, o: Intl.DateTimeFormatOptions) => new Date(d + 'T12:00:00Z').toLocaleDateString(lang === 'pt' ? 'pt-BR' : lang === 'es' ? 'es-US' : 'en-US', { timeZone: 'UTC', ...o });
  const items: any[] = data?.items || [];
  const byDay = (d: string) => items.filter((a) => a.date === d);
  const days: string[] = []; for (let d = r.from; d <= r.to; d = addDays(d, 1)) days.push(d);

  const ApptChip = ({ a, full }: { a: any; full?: boolean }) => (
    <button className={`appt s-${a.status}`} onClick={() => setOpen(a.id)}>
      <b>{a.start_time}</b> {a.property_name}
      {full && <span className="appt-meta">{a.customer_name} · {a.street}, {a.city} · {a.service_name || t('Cleaning')} · {a.duration_minutes} min<br />{a.helpers || t('No helpers assigned.')} · <Badge s={a.status} /></span>}
    </button>
  );

  return (
    <Page title={t('Calendar')} actions={canUi(me, 'schedule') && <button className="btn primary" onClick={() => setCreating(view === 'day' ? anchor : today())}>+ {t('Schedule cleaning')}</button>}>
      <Card>
        <div className="row wrap between cal-bar">
          <div className="row"><button className="btn ghost" onClick={() => step(-1)} aria-label={t('Previous')}>‹</button><button className="btn ghost" onClick={() => setAnchor(today())}>{t('Today')}</button><button className="btn ghost" onClick={() => step(1)} aria-label={t('Next')}>›</button>
            <b className="cal-title">{view === 'month' ? fmtDay(anchor, { month: 'long', year: 'numeric' }) : view === 'day' ? fmtDay(anchor, { weekday: 'long', month: 'short', day: 'numeric' }) : `${fmtDay(r.from, { month: 'short', day: 'numeric' })} – ${fmtDay(r.to, { month: 'short', day: 'numeric' })}`}</b></div>
          <div className="seg" role="tablist">{(['day', 'week', 'month'] as View[]).map((v) => <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{t('view_' + v)}</button>)}</div>
        </div>
        <details className="filters-box"><summary>{t('Filters')}{Object.values(f).some(Boolean) ? ' •' : ''}</summary>
          <div className="row wrap filters">
            <select value={f.helper_id} onChange={set('helper_id')} aria-label={t('Helper')}><option value="">{t('All helpers')}</option>{helpers.data?.items.map((h: any) => <option key={h.id} value={h.id}>{h.full_name}</option>)}</select>
            <select value={f.team_id} onChange={set('team_id')} aria-label={t('Team')}><option value="">{t('All teams')}</option>{teams.data?.items.map((h: any) => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
            <span className="combo-sm"><SearchSelect endpoint="/api/properties" value={f.property_id} onChange={(id) => setF({ ...f, property_id: id })} label={propLabel} placeholder={t('All properties')} /></span>
            {f.property_id && <button className="btn sm ghost" onClick={() => setF({ ...f, property_id: '' })} aria-label={t('Clear')}>✕</button>}
            <select value={f.service_id} onChange={set('service_id')} aria-label={t('Service')}><option value="">{t('All services')}</option>{services.data?.items.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            <input placeholder={t('City')} value={f.city} onChange={set('city')} aria-label={t('City')} className="sm" />
            <select value={f.state} onChange={set('state')} aria-label={t('State')}><option value="">{t('State')}</option>{STATE_OPTIONS.map((o) => <option key={o.value}>{o.value}</option>)}</select>
            <select value={f.status} onChange={set('status')} aria-label={t('Status')}><option value="">{t('All statuses')}</option>{STATUSES.map((s) => <option key={s} value={s}>{t(s)}</option>)}</select>
            {view === 'day' && <label className="chip"><input type="checkbox" checked={groupCity} onChange={(e) => setGroupCity(e.target.checked)} />{t('Group by city')}</label>}
          </div>
        </details>
        {!data ? <Loading error={error} /> : view === 'day' ? (
          items.length === 0 ? <Empty>{t('No cleanings scheduled.')}</Empty> : groupCity
            ? Object.entries(items.reduce((g: any, a) => ((g[`${a.city}, ${a.state}`] ||= []).push(a), g), {})).map(([city, list]: any) =>
              <div key={city}><h3 className="group-h">{city} <span className="muted">({list.length})</span></h3><div className="day-list">{list.map((a: any) => <ApptChip key={a.id} a={a} full />)}</div></div>)
            : <div className="day-list">{items.map((a) => <ApptChip key={a.id} a={a} full />)}</div>
        ) : (
          <div className={`cal-grid ${view}`}>
            {[0, 1, 2, 3, 4, 5, 6].map((d) => <div key={d} className="cal-wd">{t('wd_' + d)}</div>)}
            {days.map((d) => (
              <div key={d} className={`cal-cell ${d === today() ? 'today' : ''} ${view === 'month' && d.slice(5, 7) !== anchor.slice(5, 7) ? 'dim' : ''}`}>
                <button className="cal-date" onClick={() => { setAnchor(d); setView('day'); }}>{parseInt(d.slice(8), 10)}</button>
                {byDay(d).slice(0, view === 'month' ? 3 : 50).map((a) => <ApptChip key={a.id} a={a} />)}
                {view === 'month' && byDay(d).length > 3 && <button className="more" onClick={() => { setAnchor(d); setView('day'); }}>+{byDay(d).length - 3}</button>}
              </div>
            ))}
          </div>
        )}
      </Card>
      {view === 'day' && items.length > 1 && <RoutePanel date={anchor} helperId={f.helper_id} />}
      {open && <AppointmentModal id={open} onClose={() => setOpen(null)} onChange={reload} />}
      {creating && <Modal title={t('Schedule cleaning')} onClose={() => setCreating(null)}><AppointmentForm date={creating} propertyId={f.property_id || undefined} onDone={() => { setCreating(null); reload(); }} /></Modal>}
    </Page>
  );
}

function ConflictNote({ conflicts }: { conflicts: any[] }) {
  const { t } = useT();
  return <div className="warn-box" role="alert"><b>⚠ {t('Scheduling conflict')}</b><ul>{conflicts.map((c, i) => <li key={i}>{c.helper_name}: {c.property_name} @ {c.start_time}</li>)}</ul><small>{t('You can still save if this overlap is authorized (e.g. travel arrangements).')}</small></div>;
}

export function AppointmentForm({ propertyId, date, onDone }: { propertyId?: string; date?: string; onDone: () => void }) {
  const { t } = useT(); const onErr = useErr();
  const services = useLoad(() => get('/api/services'), []);
  const helpers = useLoad(() => get('/api/helpers'), []);
  const [v, setV] = useState<any>({ property_id: propertyId || '', date: date || today(), start_time: '09:00', status: 'scheduled' });
  const [team, setTeam] = useState<string[] | null>(null);
  const [conflicts, setConflicts] = useState<any[] | null>(null);
  const set = (k: string, val: any) => { setV({ ...v, [k]: val }); setConflicts(null); };
  React.useEffect(() => { if (v.property_id) get(`/api/properties/${v.property_id}`).then((r) => { setTeam(r.default_team.map((h: any) => h.helper_id)); setV((x: any) => ({ ...x, duration_minutes: x.duration_minutes || r.property.estimated_minutes || '', start_time: r.property.preferred_time || x.start_time })); }); }, [v.property_id]);
  const submit = async (force = false) => {
    try {
      const body: any = { ...v, force, duration_minutes: v.duration_minutes ? parseInt(v.duration_minutes, 10) : undefined, helpers: (team || []).map((id) => ({ helper_id: id })) };
      if (!body.service_id) delete body.service_id; if (!body.price) delete body.price;
      const r = await post('/api/appointments', body); toast(t('Saved')); if (r.warnings?.length) toast(t('Saved with scheduling conflict warning'), 'err'); onDone();
    } catch (e) { if (e instanceof ApiError && e.code === 'schedule_conflict') setConflicts(e.details); else onErr(e); }
  };
  if (!helpers.data) return <Loading />;
  return <form className="form" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
    <div className="grid2">
      <div className="field full"><span>{t('Property')} *</span><SearchSelect endpoint="/api/properties" extraQuery="&status=active" value={v.property_id} onChange={(id) => set('property_id', id)} label={propLabel} required /></div>
      <label className="field"><span>{t('Service')}</span><select value={v.service_id || ''} onChange={(e) => set('service_id', e.target.value)}><option value="">—</option>{services.data?.items.filter((s: any) => s.active).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="field"><span>{t('Price charged (blank = negotiated price)')}</span><input inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={v.price || ''} onChange={(e) => set('price', e.target.value)} placeholder="0.00" /></label>
      <label className="field"><span>{t('Date')} *</span><input type="date" required value={v.date} onChange={(e) => set('date', e.target.value)} /></label>
      <label className="field"><span>{t('Start time')} *</span><input type="time" required value={v.start_time} onChange={(e) => set('start_time', e.target.value)} /></label>
      <label className="field"><span>{t('Estimated duration (minutes)')}</span><input type="number" min={15} value={v.duration_minutes || ''} onChange={(e) => set('duration_minutes', e.target.value)} /></label>
      <label className="field"><span>{t('Status')}</span><select value={v.status} onChange={(e) => set('status', e.target.value)}>{['scheduled', 'confirmed', 'pending_confirmation'].map((s) => <option key={s} value={s}>{t(s)}</option>)}</select></label>
      <fieldset className="field full"><legend>{t('Assigned helpers')}</legend><div className="row wrap">{helpers.data.items.map((h: any) => <label key={h.id} className="chip"><input type="checkbox" checked={!!team?.includes(h.id)} onChange={(e) => { setTeam(e.target.checked ? [...(team || []), h.id] : (team || []).filter((x) => x !== h.id)); setConflicts(null); }} />{h.full_name}</label>)}</div></fieldset>
      <label className="field full"><span>{t('Internal instructions')}</span><textarea rows={2} value={v.internal_instructions || ''} onChange={(e) => set('internal_instructions', e.target.value)} /></label>
      <label className="field full"><span>{t('Customer instructions')}</span><textarea rows={2} value={v.customer_instructions || ''} onChange={(e) => set('customer_instructions', e.target.value)} /></label>
    </div>
    {conflicts && <ConflictNote conflicts={conflicts} />}
    <div className="row end">{conflicts ? <button type="button" className="btn danger" onClick={() => submit(true)}>{t('Save anyway')}</button> : <button className="btn primary">{t('Save')}</button>}</div>
  </form>;
}

export function AppointmentModal({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { t } = useT(); const { me } = useMe(); const onErr = useErr();
  const { data, error, reload } = useLoad(() => get(`/api/appointments/${id}`), [id]);
  const [mode, setMode] = useState<null | 'complete' | 'reschedule' | 'helpers' | 'item'>(null);
  const [att, setAtt] = useState<Record<string, { attendance: string; worked_minutes: string }>>({});
  const [form, setForm] = useState<any>({});
  const [conflicts, setConflicts] = useState<any[] | null>(null);
  const allHelpers = useLoad(() => get('/api/helpers'), []);
  const refresh = () => { reload(); onChange(); };
  const act = async (fn: () => Promise<any>) => { try { await fn(); toast(t('Saved')); setMode(null); setConflicts(null); refresh(); } catch (e) { if (e instanceof ApiError && e.code === 'schedule_conflict') setConflicts(e.details); else onErr(e); } };
  if (!data) return <Modal title={t('Appointment')} onClose={onClose}><Loading error={error} /></Modal>;
  const a = data.appointment, p = data.property;
  const open = !['completed', 'canceled', 'rescheduled'].includes(a.status);
  const canEdit = canUi(me, 'schedule') && open;
  return (
    <Modal title={`${p.name} · ${a.date} ${a.start_time}`} onClose={onClose}>
      <div className="appt-detail">
        <div className="row wrap between"><Badge s={a.status} /><a className="btn sm ghost" href={mapsUrl(p)} target="_blank" rel="noopener noreferrer">{t('Open in maps')}</a></div>
        <dl className="dl">
          <dt>{t('Address')}</dt><dd>{p.street}{p.unit ? `, ${p.unit}` : ''}, {p.city}, {p.state} {p.zip}</dd>
          <dt>{t('Duration')}</dt><dd>{a.duration_minutes} min</dd>
          <dt>{t('Price charged')}</dt><dd>{fmtMoney(a.base_price_cents)}{a.items.map((i: any) => <div key={i.id} className="muted">{i.kind === 'addon' ? '+' : '−'} {fmtMoney(i.amount_cents)} {i.description} {canEdit && <button className="link" onClick={() => act(() => del(`/api/appointments/${a.id}/items/${i.id}`))}>✕</button>}</div>)}<b>{t('Total')}: {fmtMoney(a.total_cents)}</b></dd>
          <dt>{t('Assigned helpers')}</dt><dd>{a.helpers.length ? a.helpers.map((h: any) => <div key={h.helper_id}>{h.full_name} <span className="muted">· {t(h.pay_basis)} {fmtMoney(h.rate_cents)}{h.attendance !== 'assigned' ? ` · ${t(h.attendance)}` : ''}</span> {h.whatsapp && <a href={waUrl(h.whatsapp)} target="_blank" rel="noopener noreferrer" className="link">WhatsApp</a>}</div>) : '—'}</dd>
          {a.internal_instructions && <><dt>{t('Internal instructions')}</dt><dd>{a.internal_instructions}</dd></>}
          {a.customer_instructions && <><dt>{t('Customer instructions')}</dt><dd>{a.customer_instructions}</dd></>}
          {a.notes && <><dt>{t('Notes')}</dt><dd className="pre">{a.notes}</dd></>}
        </dl>
        {canEdit && !mode && <div className="row wrap">
          <button className="btn primary" onClick={() => { setAtt(Object.fromEntries(a.helpers.map((h: any) => [h.helper_id, { attendance: 'completed', worked_minutes: String(a.duration_minutes) }]))); setMode('complete'); }}>✓ {t('Mark completed')}</button>
          {a.status !== 'confirmed' && <button className="btn" onClick={() => act(() => post(`/api/appointments/${a.id}/status`, { status: 'confirmed' }))}>{t('Confirm')}</button>}
          {a.status !== 'in_progress' && <button className="btn" onClick={() => act(() => post(`/api/appointments/${a.id}/status`, { status: 'in_progress' }))}>{t('Start')}</button>}
          <button className="btn" onClick={() => { setForm({ date: a.date, start_time: a.start_time }); setMode('reschedule'); }}>{t('Reschedule')}</button>
          <button className="btn" onClick={() => { setForm({ helpers: a.helpers.map((h: any) => h.helper_id) }); setMode('helpers'); }}>{t('Change helpers')}</button>
          <button className="btn" onClick={() => { setForm({ kind: 'addon' }); setMode('item'); }}>{t('Add charge / discount')}</button>
          <button className="btn ghost" onClick={() => act(() => post(`/api/appointments/${a.id}/status`, { status: 'customer_unavailable' }))}>{t('customer_unavailable')}</button>
          <button className="btn danger" onClick={() => confirm(t('Cancel this appointment?')) && act(() => post(`/api/appointments/${a.id}/status`, { status: 'canceled' }))}>{t('Cancel appointment')}</button>
        </div>}
        {mode === 'complete' && <Card title={t('Complete cleaning')}>
          <p className="muted">{t('Completing creates the customer receivable and the helper payables. Absent helpers are not paid.')}</p>
          {a.helpers.map((h: any) => <div key={h.helper_id} className="row wrap team-row"><b className="grow">{h.full_name}</b>
            <select value={att[h.helper_id]?.attendance} onChange={(e) => setAtt({ ...att, [h.helper_id]: { ...att[h.helper_id], attendance: e.target.value } })} aria-label={t('Attendance')}><option value="completed">{t('completed')}</option><option value="absent">{t('absent')}</option></select>
            {h.pay_basis === 'hourly' && <label className="row">{t('Minutes worked')} <input className="sm" type="number" min={1} value={att[h.helper_id]?.worked_minutes} onChange={(e) => setAtt({ ...att, [h.helper_id]: { ...att[h.helper_id], worked_minutes: e.target.value } })} /></label>}
          </div>)}
          <div className="row end"><button className="btn ghost" onClick={() => setMode(null)}>{t('Cancel')}</button><button className="btn primary" onClick={() => act(() => post(`/api/appointments/${a.id}/status`, { status: 'completed', attendance: Object.entries(att).map(([helper_id, x]) => ({ helper_id, attendance: x.attendance, worked_minutes: parseInt(x.worked_minutes, 10) || undefined })) }))}>{t('Confirm completion')}</button></div>
        </Card>}
        {mode === 'reschedule' && <Card title={t('Reschedule')}>
          <div className="row wrap"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} aria-label={t('Date')} /><input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} aria-label={t('Start time')} /></div>
          {conflicts && <ConflictNote conflicts={conflicts} />}
          <div className="row end"><button className="btn ghost" onClick={() => { setMode(null); setConflicts(null); }}>{t('Cancel')}</button><button className="btn primary" onClick={() => act(async () => { const r = await post(`/api/appointments/${a.id}/reschedule`, { ...form, force: !!conflicts }); onClose(); return r; })}>{conflicts ? t('Save anyway') : t('Save')}</button></div>
        </Card>}
        {mode === 'helpers' && <Card title={t('Change helpers (this appointment only)')}>
          <div className="row wrap">{allHelpers.data?.items.map((h: any) => <label key={h.id} className="chip"><input type="checkbox" checked={form.helpers.includes(h.id)} onChange={(e) => { setConflicts(null); setForm({ helpers: e.target.checked ? [...form.helpers, h.id] : form.helpers.filter((x: string) => x !== h.id) }); }} />{h.full_name}</label>)}</div>
          {conflicts && <ConflictNote conflicts={conflicts} />}
          <div className="row end"><button className="btn ghost" onClick={() => setMode(null)}>{t('Cancel')}</button><button className="btn primary" onClick={() => act(() => put(`/api/appointments/${a.id}/helpers`, { helpers: form.helpers.map((x: string) => ({ helper_id: x })), force: !!conflicts }))}>{conflicts ? t('Save anyway') : t('Save')}</button></div>
        </Card>}
        {mode === 'item' && <Card title={t('Add charge / discount')}>
          <div className="row wrap"><select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} aria-label={t('Type')}><option value="addon">{t('Additional charge')}</option><option value="discount">{t('Discount')}</option></select>
            <input placeholder={t('Description (e.g. Oven cleaning)')} value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} aria-label={t('Description')} />
            <input className="sm" inputMode="decimal" placeholder="0.00" value={form.amount || ''} onChange={(e) => setForm({ ...form, amount: e.target.value })} aria-label={t('Amount')} /></div>
          <div className="row end"><button className="btn ghost" onClick={() => setMode(null)}>{t('Cancel')}</button><button className="btn primary" onClick={() => act(() => post(`/api/appointments/${a.id}/items`, form))}>{t('Save')}</button></div>
        </Card>}
        <details><summary>{t('Status history')}</summary><ul className="list">{data.history.map((h: any, i: number) => <li key={i}>{h.changed_at.slice(0, 16).replace('T', ' ')} · {h.from_status ? t(h.from_status) + ' → ' : ''}{t(h.to_status)}</li>)}</ul></details>
      </div>
    </Modal>
  );
}
export { centsToInput };

function RoutePanel({ date, helperId }: { date: string; helperId: string }) {
  const { t } = useT();
  const { data } = useLoad(() => get(`/api/routes/day?${qs({ date, helper_id: helperId })}`), [date, helperId]);
  if (!data) return null;
  const byId = Object.fromEntries(data.stops.map((s: any) => [s.id, s]));
  const saves = data.straight_line_miles.scheduled - data.straight_line_miles.suggested;
  return <Card title={t('Route suggestion')} actions={data.google_maps_directions && <a className="btn sm primary" href={data.google_maps_directions} target="_blank" rel="noopener noreferrer">{t('Open route in Google Maps')}</a>}>
    {data.suggested_order.length < 2 ? <p className="muted">{t('Locate at least two addresses (property page → Locate address) to get a route suggestion.')}</p> : <>
      <ol className="route-list">{data.suggested_order.map((id: string) => <li key={id}><b>{byId[id].property_name}</b> <span className="muted">· {t('scheduled')} {byId[id].start_time} · {byId[id].address}</span></li>)}</ol>
      <p className="small">{t('Straight-line distance')}: {data.straight_line_miles.suggested} mi {saves > 0.05 ? `(${t('current order')}: ${data.straight_line_miles.scheduled} mi)` : `· ${t('current order is already the shortest found')}`}</p>
    </>}
    {data.missing_coordinates.length > 0 && <p className="small muted">{t('{n} stops without coordinates are not included.', { n: data.missing_coordinates.length })}</p>}
    <p className="small muted">{t('Order suggested by straight-line distance only — not driving distance, traffic or travel time. Google Maps calculates the actual route.')}</p>
  </Card>;
}
