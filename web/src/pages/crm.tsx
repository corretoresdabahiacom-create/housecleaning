import React, { useState } from 'react';
import { api, centsToInput, del, fmtMoney, get, mapsUrl, post, put, qs, waUrl } from '../api';
import { Badge, Card, Empty, Form, FieldDef, Loading, Modal, Page, Table, canUi, toast, useErr, useLoad, useMe, useT } from '../ui';
import { LANG_OPTIONS, STATE_OPTIONS } from './auth';
import { AppointmentForm } from './schedule';

export const FREQ_OPTIONS = ['once', 'daily', 'weekly', 'twice_weekly', 'biweekly', 'triweekly', 'monthly', 'bimonthly', 'custom'].map((v) => ({ value: v, label: 'freq_' + v }));
const STATUS_OPTIONS = ['active', 'inactive', 'archived', 'pending'].map((v) => ({ value: v, label: v }));

const customerFields: FieldDef[] = [
  { name: 'full_name', label: 'Full name', required: true }, { name: 'phone', label: 'Telephone', type: 'tel' },
  { name: 'whatsapp', label: 'WhatsApp number', type: 'tel' }, { name: 'email', label: 'Email', type: 'email' },
  { name: 'language', label: 'Preferred language', type: 'select', options: LANG_OPTIONS }, { name: 'contact_person', label: 'Additional contact person' },
  { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS }, { name: 'notes', label: 'Notes', type: 'textarea' },
];

export function Customers() {
  const { t } = useT(); const { me } = useMe();
  const [q, setQ] = useState(''); const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const { data, error, reload } = useLoad(() => get(`/api/customers?${qs({ q, status, offset, limit: 50 })}`), [q, status, offset]);
  return (
    <Page title={t('Customers')} actions={canUi(me, 'write') && <button className="btn primary" onClick={() => setAdding(true)}>+ {t('Add customer')}</button>}>
      <Card>
        <div className="row wrap filters">
          <input type="search" placeholder={t('Search name, phone or email')} value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} aria-label={t('Search')} />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('Status')}><option value="">{t('All statuses')}</option>{STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}</select>
        </div>
        {!data ? <Loading error={error} /> : <>
          <Table rows={data.items} onRow={(r) => (location.hash = `/customers/${r.id}`)} cols={[
            { key: 'full_name', label: 'Name' }, { key: 'phone', label: 'Telephone', hideSm: true }, { key: 'email', label: 'Email', hideSm: true },
            { key: 'status', label: 'Status', render: (r) => <Badge s={r.status} /> },
          ]} />
          <Pager total={data.total} offset={offset} limit={50} onChange={setOffset} />
        </>}
      </Card>
      {adding && <Modal title={t('Add customer')} onClose={() => setAdding(false)}>
        <Form fields={customerFields} initial={{ language: 'en', status: 'active' }} onCancel={() => setAdding(false)} onSubmit={async (v) => { const r = await post('/api/customers', v); toast(t('Saved')); setAdding(false); reload(); location.hash = `/customers/${r.id}`; }} />
      </Modal>}
    </Page>
  );
}

export function Pager({ total, offset, limit, onChange }: { total: number; offset: number; limit: number; onChange: (o: number) => void }) {
  const { t } = useT();
  if (total <= limit) return null;
  return <div className="row between pager"><button className="btn ghost" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>‹ {t('Previous')}</button>
    <span className="muted">{offset + 1}–{Math.min(total, offset + limit)} / {total}</span>
    <button className="btn ghost" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>{t('Next')} ›</button></div>;
}

export function CustomerDetail({ id }: { id: string }) {
  const { t } = useT(); const { me } = useMe();
  const { data, error, reload } = useLoad(() => get(`/api/customers/${id}`), [id]);
  const [edit, setEdit] = useState(false); const [addProp, setAddProp] = useState(false);
  if (!data) return <Loading error={error} />;
  const c = data.customer;
  return (
    <Page title={c.full_name} actions={<>
      {c.whatsapp && <a className="btn ghost" href={waUrl(c.whatsapp)} target="_blank" rel="noopener noreferrer">WhatsApp</a>}
      {canUi(me, 'write') && <button className="btn" onClick={() => setEdit(true)}>{t('Edit')}</button>}
      {canUi(me, 'write') && <button className="btn primary" onClick={() => setAddProp(true)}>+ {t('Add residence')}</button>}
    </>}>
      <Card title={t('Contact')}>
        <dl className="dl"><dt>{t('Telephone')}</dt><dd>{c.phone || '—'}</dd><dt>{t('Email')}</dt><dd>{c.email || '—'}</dd><dt>{t('Preferred language')}</dt><dd>{c.language}</dd>
          <dt>{t('Additional contact person')}</dt><dd>{c.contact_person || '—'}</dd><dt>{t('Status')}</dt><dd><Badge s={c.status} /></dd><dt>{t('Registration date')}</dt><dd>{c.created_at.slice(0, 10)}</dd></dl>
        {c.notes && <p className="note">{c.notes}</p>}
      </Card>
      <Card title={t('Properties')}>
        <Table rows={data.properties} onRow={(r) => (location.hash = `/properties/${r.id}`)} cols={[
          { key: 'name', label: 'Property' }, { key: 'street', label: 'Address', render: (r) => `${r.street}${r.unit ? ' ' + r.unit : ''}, ${r.city}, ${r.state}` },
          { key: 'frequency', label: 'Frequency', render: (r) => t('freq_' + r.frequency), hideSm: true }, { key: 'price_cents', label: 'Price', num: true, render: (r) => fmtMoney(r.price_cents) },
          { key: 'status', label: 'Status', render: (r) => <Badge s={r.status} /> },
        ]} empty="No residences registered for this customer." />
      </Card>
      {edit && <Modal title={t('Edit')} onClose={() => setEdit(false)}><Form fields={customerFields} initial={c} onCancel={() => setEdit(false)} onSubmit={async (v) => { await put(`/api/customers/${id}`, v); toast(t('Saved')); setEdit(false); reload(); }} /></Modal>}
      {addProp && <Modal title={t('Add residence')} onClose={() => setAddProp(false)}><PropertyForm initial={{ customer_id: id }} onDone={(pid) => { setAddProp(false); location.hash = `/properties/${pid}`; }} onCancel={() => setAddProp(false)} /></Modal>}
    </Page>
  );
}

const propertyFields = (): FieldDef[] => [
  { name: 'customer_id', label: 'Customer responsible', type: 'search', endpoint: '/api/customers', required: true },
  { name: 'name', label: 'Property name / identification', required: true },
  { name: 'street', label: 'Street address', required: true }, { name: 'unit', label: 'Apt / suite / unit' },
  { name: 'city', label: 'City', required: true }, { name: 'state', label: 'State', type: 'select', options: STATE_OPTIONS, required: true },
  { name: 'zip', label: 'ZIP code', required: true, placeholder: '30303' }, { name: 'phone', label: 'Property telephone (if different)', type: 'tel' },
  { name: 'price', label: 'Cleaning price (USD)', type: 'money', required: true }, { name: 'pricing_model', label: 'Pricing model', type: 'select', options: [{ value: 'fixed', label: 'Fixed per cleaning' }, { value: 'hourly', label: 'Hourly' }, { value: 'custom', label: 'Custom' }] },
  { name: 'frequency', label: 'Cleaning frequency', type: 'select', options: FREQ_OPTIONS, required: true }, { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS },
  { name: 'property_type', label: 'Property type', type: 'select', options: ['house', 'apartment', 'condo', 'townhouse', 'other'].map((v) => ({ value: v, label: 'ptype_' + v })) },
  { name: 'bedrooms', label: 'Bedrooms', type: 'number' }, { name: 'bathrooms', label: 'Bathrooms', type: 'number' }, { name: 'size_sqft', label: 'Approx. size (sq ft)', type: 'number' },
  { name: 'floors', label: 'Floors', type: 'number' }, { name: 'preferred_time', label: 'Preferred arrival time', type: 'time' }, { name: 'estimated_minutes', label: 'Estimated duration (minutes)', type: 'number' },
  { name: 'parking', label: 'Parking information' }, { name: 'pets', label: 'Pets present' },
  { name: 'special_instructions', label: 'Special cleaning instructions', type: 'textarea' },
  { name: 'private_notes', label: 'Internal private notes', type: 'textarea', help: 'Never store alarm codes or passwords here — use the encrypted access instructions.' },
];

export function PropertyForm({ initial = {}, id, onDone, onCancel }: { initial?: any; id?: string; onDone: (id: string) => void; onCancel: () => void }) {
  const { t } = useT();
  const init = { status: 'active', pricing_model: 'fixed', frequency: 'weekly', ...initial, price: initial.price_cents !== undefined ? centsToInput(initial.price_cents) : initial.price };
  return <Form fields={propertyFields()} initial={init} onCancel={onCancel} onSubmit={async (v) => {
    if (id) { await put(`/api/properties/${id}`, v); toast(t('Saved')); onDone(id); }
    else { const r = await post('/api/properties', v); toast(t('Saved')); onDone(r.id); }
  }} />;
}

export function Properties() {
  const { t } = useT(); const { me } = useMe();
  const [f, setF] = useState<Record<string, string>>({ q: '', city: '', state: '', zip: '', frequency: '', status: '', helper_id: '' });
  const [offset, setOffset] = useState(0); const [adding, setAdding] = useState(false);
  const helpers = useLoad(() => get('/api/helpers'), []);
  const { data, error } = useLoad(() => get(`/api/properties?${qs({ ...f, offset, limit: 50 })}`), [JSON.stringify(f), offset]);
  const set = (k: string) => (e: any) => { setF({ ...f, [k]: e.target.value }); setOffset(0); };
  return (
    <Page title={t('Properties')} actions={canUi(me, 'write') && <button className="btn primary" onClick={() => setAdding(true)}>+ {t('Add residence')}</button>}>
      <Card>
        <div className="row wrap filters">
          <input type="search" placeholder={t('Customer, property, address or phone')} value={f.q} onChange={set('q')} aria-label={t('Search')} />
          <input placeholder={t('City')} value={f.city} onChange={set('city')} aria-label={t('City')} />
          <select value={f.state} onChange={set('state')} aria-label={t('State')}><option value="">{t('State')}</option>{STATE_OPTIONS.map((o) => <option key={o.value}>{o.value}</option>)}</select>
          <input placeholder={t('ZIP code')} value={f.zip} onChange={set('zip')} aria-label={t('ZIP code')} className="sm" />
          <select value={f.frequency} onChange={set('frequency')} aria-label={t('Frequency')}><option value="">{t('Frequency')}</option>{FREQ_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}</select>
          <select value={f.helper_id} onChange={set('helper_id')} aria-label={t('Assigned helper')}><option value="">{t('Assigned helper')}</option>{helpers.data?.items.map((h: any) => <option key={h.id} value={h.id}>{h.full_name}</option>)}</select>
          <select value={f.status} onChange={set('status')} aria-label={t('Status')}><option value="">{t('All statuses')}</option>{STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}</select>
        </div>
        {!data ? <Loading error={error} /> : <>
          <Table rows={data.items} onRow={(r) => (location.hash = `/properties/${r.id}`)} cols={[
            { key: 'name', label: 'Property' }, { key: 'customer_name', label: 'Customer' },
            { key: 'street', label: 'Address', hideSm: true, render: (r) => `${r.street}${r.unit ? ' ' + r.unit : ''}, ${r.city}, ${r.state} ${r.zip}` },
            { key: 'frequency', label: 'Frequency', render: (r) => t('freq_' + r.frequency), hideSm: true },
            { key: 'price_cents', label: 'Price', num: true, render: (r) => fmtMoney(r.price_cents) }, { key: 'status', label: 'Status', render: (r) => <Badge s={r.status} /> },
          ]} />
          <Pager total={data.total} offset={offset} limit={50} onChange={setOffset} />
        </>}
      </Card>
      {adding && <Modal title={t('Add residence')} onClose={() => setAdding(false)}><PropertyForm onDone={(id) => { setAdding(false); location.hash = `/properties/${id}`; }} onCancel={() => setAdding(false)} /></Modal>}
    </Page>
  );
}

export function PropertyDetail({ id }: { id: string }) {
  const { t } = useT(); const { me } = useMe(); const onErr = useErr();
  const { data, error, reload } = useLoad(() => get(`/api/properties/${id}`), [id]);
  const history = useLoad(() => get(`/api/properties/${id}/history`), [id]);
  const rules = useLoad(() => get(`/api/rules?property_id=${id}`), [id]);
  const [modal, setModal] = useState<null | 'edit' | 'team' | 'access' | 'rule' | 'schedule'>(null);
  const [access, setAccess] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const p = data.property;
  const close = () => setModal(null);
  return (
    <Page title={p.name} actions={<>
      <a className="btn ghost" href={mapsUrl(p)} target="_blank" rel="noopener noreferrer">{t('Open in maps')}</a>
      {canUi(me, 'write') && <button className="btn" onClick={() => setModal('edit')}>{t('Edit')}</button>}
      {canUi(me, 'schedule') && <button className="btn primary" onClick={() => setModal('schedule')}>+ {t('Schedule cleaning')}</button>}
    </>}>
      <div className="grid-2">
        <Card title={t('Residence')}>
          <dl className="dl">
            <dt>{t('Customer')}</dt><dd><a href={`#/customers/${data.customer.id}`}>{data.customer.full_name}</a></dd>
            <dt>{t('Address')}</dt><dd>{p.street}{p.unit ? `, ${p.unit}` : ''}<br />{p.city}, {p.state} {p.zip}</dd>
            <dt>{t('Price')}</dt><dd>{fmtMoney(p.price_cents, p.currency)} <small className="muted">({t(p.pricing_model)})</small></dd>
            <dt>{t('Frequency')}</dt><dd>{t('freq_' + p.frequency)}</dd><dt>{t('Status')}</dt><dd><Badge s={p.status} /></dd>
            {p.property_type && <><dt>{t('Property type')}</dt><dd>{t('ptype_' + p.property_type)}</dd></>}
            {(p.bedrooms ?? p.bathrooms) !== null && <><dt>{t('Bedrooms')} / {t('Bathrooms')}</dt><dd>{p.bedrooms ?? '—'} / {p.bathrooms ?? '—'}</dd></>}
            {p.pets && <><dt>{t('Pets present')}</dt><dd>{p.pets}</dd></>}
            {p.parking && <><dt>{t('Parking information')}</dt><dd>{p.parking}</dd></>}
            <dt>{t('Coordinates')}</dt><dd>{p.latitude !== null ? `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}` : '—'} {canUi(me, 'write') && <button className="link small" onClick={async () => { try { const r = await post(`/api/properties/${id}/geocode`); toast(`${t('Located')}: ${r.matched_address}`); reload(); } catch (e) { onErr(e); } }}>{t('Locate address')}</button>}</dd>
          </dl>
          {p.special_instructions && <p className="note">{p.special_instructions}</p>}
          {p.private_notes && <p className="note private">🔒 {p.private_notes}</p>}
        </Card>
        <div>
          <Card title={t('Default team')} actions={canUi(me, 'write') && <button className="btn sm" onClick={() => setModal('team')}>{t('Edit')}</button>}>
            {data.default_team.length ? <ul className="list">{data.default_team.map((h: any) => <li key={h.helper_id}><a href={`#/helpers/${h.helper_id}`}>{h.full_name}</a><span className="muted">{t(h.pay_basis)} · {fmtMoney(h.rate_cents)}</span></li>)}</ul> : <Empty>{t('No helpers assigned.')}</Empty>}
            <small className="muted">{t('Changing the default team never rewrites past appointments.')}</small>
          </Card>
          {canUi(me, 'access') && <Card title={'🔒 ' + t('Access instructions')} actions={<button className="btn sm" onClick={async () => {
            try { const r = await get(`/api/properties/${id}/access`); setAccess(r.instructions || ''); setModal('access'); } catch (e) { onErr(e); }
          }}>{data.has_access_instructions ? t('View / edit') : t('Add')}</button>}>
            <small className="muted">{t('Encrypted. Visible only to authorized roles. Every view is audited.')}</small>
          </Card>}
          <Card title={t('Recurring schedule')} actions={canUi(me, 'schedule') && <button className="btn sm" onClick={() => setModal('rule')}>+ {t('Add')}</button>}>
            {rules.data?.items.length ? <ul className="list">{rules.data.items.map((r: any) => <RuleRow key={r.id} r={r} onChange={() => { rules.reload(); history.reload(); }} />)}</ul> : <Empty>{t('No recurring schedule.')}</Empty>}
          </Card>
        </div>
      </div>
      <ServicePricesCard propertyId={id} prices={data.service_prices} basePrice={p.price_cents} canEdit={canUi(me, 'write')} onChange={reload} />
      <PhotosCard propertyId={id} canEdit={canUi(me, 'write')} />
      <Card title={t('Cleaning history')} actions={history.data?.next && <span className="muted">{t('Next cleaning')}: {history.data.next.date} {history.data.next.start_time}</span>}>
        {!history.data ? <Loading /> : <Table rows={history.data.items} onRow={(r) => (location.hash = `/calendar?appointment=${r.id}`)} cols={[
          { key: 'date', label: 'Date', render: (r) => `${r.date} ${r.start_time}` }, { key: 'service_name', label: 'Cleaning type', hideSm: true },
          { key: 'helpers', label: 'Helpers' }, { key: 'base_price_cents', label: 'Price charged', num: true, render: (r) => fmtMoney(r.invoiced_cents ?? r.base_price_cents + r.adjustments_cents) },
          { key: 'status', label: 'Status', render: (r) => <Badge s={r.status} /> }, { key: 'payment_status', label: 'Payment', render: (r) => (r.payment_status ? <Badge s={r.payment_status} /> : '—'), hideSm: true },
        ]} />}
      </Card>
      {modal === 'edit' && <Modal title={t('Edit')} onClose={close}><PropertyForm id={id} initial={p} onDone={() => { close(); reload(); }} onCancel={close} /></Modal>}
      {modal === 'team' && <Modal title={t('Default team')} onClose={close}><TeamEditor propertyId={id} current={data.default_team} onDone={() => { close(); reload(); }} /></Modal>}
      {modal === 'access' && <Modal title={t('Access instructions')} onClose={close}>
        <Form fields={[{ name: 'instructions', label: 'Gate / entry / alarm / key instructions', type: 'textarea' }]} initial={{ instructions: access }} onCancel={close}
          onSubmit={async (v) => { await put(`/api/properties/${id}/access`, { instructions: v.instructions || null }); toast(t('Saved')); close(); reload(); }} />
      </Modal>}
      {modal === 'rule' && <Modal title={t('Recurring schedule')} onClose={close}><RuleForm propertyId={id} defaults={{ duration_minutes: p.estimated_minutes || 180, start_time: p.preferred_time || '09:00', frequency: p.frequency }} onDone={() => { close(); rules.reload(); history.reload(); }} /></Modal>}
      {modal === 'schedule' && <Modal title={t('Schedule cleaning')} onClose={close}><AppointmentForm propertyId={id} onDone={() => { close(); history.reload(); }} /></Modal>}
    </Page>
  );
}

/** Negotiated price per service for this property (overrides the service default; never changes past appointments). */
function ServicePricesCard({ propertyId, prices, basePrice, canEdit, onChange }: { propertyId: string; prices: any[]; basePrice: number; canEdit: boolean; onChange: () => void }) {
  const { t } = useT(); const onErr = useErr();
  const services = useLoad(() => get('/api/services'), []);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const byId = Object.fromEntries(prices.map((x) => [x.service_id, x.price_cents]));
  const save = async (sid: string, value: string | null) => {
    try { await put(`/api/properties/${propertyId}/service-prices`, { service_id: sid, price: value || null }); toast(t('Saved')); setEdit((e) => { const n = { ...e }; delete n[sid]; return n; }); onChange(); } catch (e) { onErr(e); }
  };
  return <Card title={t('Services & negotiated prices')}>
    <p className="muted small">{t('Without a negotiated price, appointments use the property price')} ({fmtMoney(basePrice)}). {t('Default prices never overwrite negotiated property-specific prices.')}</p>
    {!services.data ? <Loading /> : <Table rows={services.data.items.filter((sv: any) => sv.active || byId[sv.id] !== undefined)} cols={[
      { key: 'name', label: 'Service' }, { key: 'default_price_cents', label: 'Default price', num: true, hideSm: true, render: (sv) => fmtMoney(sv.default_price_cents) },
      { key: 'neg', label: 'Negotiated price', num: true, render: (sv) => edit[sv.id] !== undefined
        ? <span className="row end-inline"><input className="sm" inputMode="decimal" value={edit[sv.id]} onChange={(e) => setEdit({ ...edit, [sv.id]: e.target.value })} aria-label={t('Negotiated price')} /><button className="btn sm primary" onClick={() => save(sv.id, edit[sv.id])}>{t('Save')}</button></span>
        : <span className="row end-inline">{byId[sv.id] !== undefined ? <b>{fmtMoney(byId[sv.id])}</b> : <span className="muted">—</span>}
          {canEdit && <button className="btn sm ghost" onClick={() => setEdit({ ...edit, [sv.id]: byId[sv.id] !== undefined ? centsToInput(byId[sv.id]) : '' })}>{t('Edit')}</button>}
          {canEdit && byId[sv.id] !== undefined && <button className="btn sm ghost" onClick={() => save(sv.id, null)} aria-label={t('Remove')}>✕</button>}</span> },
    ]} />}
  </Card>;
}

function PhotosCard({ propertyId, canEdit }: { propertyId: string; canEdit: boolean }) {
  const { t } = useT(); const onErr = useErr();
  const { data, reload } = useLoad(() => get(`/api/properties/${propertyId}/photos`), [propertyId]);
  const [busy, setBusy] = useState(false);
  return <Card title={t('Photos')} actions={canEdit && <label className="btn sm">{busy ? t('Saving…') : '+ ' + t('Add photo')}<input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={async (e) => {
    const f = e.target.files?.[0]; if (!f) return; setBusy(true);
    try { const fd = new FormData(); fd.set('file', f); await api(`/api/properties/${propertyId}/photos`, { method: 'POST', form: fd }); reload(); } catch (er) { onErr(er); } finally { setBusy(false); e.target.value = ''; }
  }} /></label>}>
    {data?.items.length ? <div className="photos">{data.items.map((ph: any) => <div key={ph.id} className="photo">
      <a href={`/api/photos/${ph.id}`} target="_blank" rel="noopener"><img src={`/api/photos/${ph.id}`} alt={ph.caption || t('Property photo')} loading="lazy" /></a>
      {ph.caption && <small>{ph.caption}</small>}
      {canEdit && <button className="btn sm danger" aria-label={t('Delete')} onClick={async () => { if (confirm(t('Delete this photo?'))) { await del(`/api/photos/${ph.id}`); reload(); } }}>✕</button>}
    </div>)}</div> : <Empty>{t('No photos.')}</Empty>}
  </Card>;
}

function RuleRow({ r, onChange }: { r: any; onChange: () => void }) {
  const { t } = useT(); const onErr = useErr();
  const days = (r.weekdays || '').split(',').filter(Boolean).map((d: string) => t('wd_' + d)).join(', ');
  return <li><span><b>{t('freq_' + r.frequency)}</b> {days && `· ${days}`} · {r.start_time} · {r.duration_minutes} min<br /><small className="muted">{t('From')} {r.start_date}{r.end_date ? ` ${t('to')} ${r.end_date}` : ''}{r.paused_from ? ` · ${t('Paused')} ${r.paused_from}→${r.paused_until || '…'}` : ''}{!r.active ? ` · ${t('inactive')}` : ''}</small></span>
    <span className="row">
      <button className="btn sm ghost" onClick={async () => { try { await put(`/api/rules/${r.id}`, { active: !r.active }); onChange(); } catch (e) { onErr(e); } }}>{r.active ? t('Deactivate') : t('Activate')}</button>
    </span></li>;
}

export function RuleForm({ propertyId, defaults, onDone }: { propertyId: string; defaults: any; onDone: () => void }) {
  const { t } = useT(); const onErr = useErr();
  const services = useLoad(() => get('/api/services'), []);
  const [v, setV] = useState<any>({ frequency: defaults.frequency === 'once' ? 'weekly' : defaults.frequency, weekdays: [1], start_date: new Date().toISOString().slice(0, 10), start_time: defaults.start_time, duration_minutes: defaults.duration_minutes, interval_days: 14, exceptions: '' });
  const set = (k: string, val: any) => setV({ ...v, [k]: val });
  const needsDays = ['weekly', 'twice_weekly', 'biweekly', 'triweekly'].includes(v.frequency);
  return <form className="form" onSubmit={async (e) => {
    e.preventDefault();
    try {
      const body: any = { property_id: propertyId, frequency: v.frequency, start_date: v.start_date, start_time: v.start_time, duration_minutes: parseInt(v.duration_minutes, 10), service_id: v.service_id || undefined, end_date: v.end_date || undefined };
      if (needsDays) body.weekdays = v.weekdays;
      if (v.frequency === 'custom') body.interval_days = parseInt(v.interval_days, 10);
      if (v.exceptions) body.exceptions = v.exceptions.split(/[\s,]+/).filter(Boolean);
      if (v.paused_from) { body.paused_from = v.paused_from; body.paused_until = v.paused_until || undefined; }
      const r = await post('/api/rules', body); toast(t('{n} appointments generated', { n: r.generated })); onDone();
    } catch (err) { onErr(err); }
  }}>
    <div className="grid2">
      <label className="field"><span>{t('Frequency')}</span><select value={v.frequency} onChange={(e) => set('frequency', e.target.value)}>{FREQ_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}</select></label>
      <label className="field"><span>{t('Service')}</span><select value={v.service_id || ''} onChange={(e) => set('service_id', e.target.value)}><option value="">—</option>{services.data?.items.filter((s: any) => s.active).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      {needsDays && <fieldset className="field full"><legend>{t('Preferred weekdays')}</legend><div className="row wrap">{[0, 1, 2, 3, 4, 5, 6].map((d) => <label key={d} className="chip"><input type="checkbox" checked={v.weekdays.includes(d)} onChange={(e) => set('weekdays', e.target.checked ? [...v.weekdays, d].sort() : v.weekdays.filter((x: number) => x !== d))} />{t('wd_' + d)}</label>)}</div></fieldset>}
      {v.frequency === 'custom' && <label className="field"><span>{t('Every N days')}</span><input type="number" min={1} value={v.interval_days} onChange={(e) => set('interval_days', e.target.value)} /></label>}
      <label className="field"><span>{t('Start date')}</span><input type="date" required value={v.start_date} onChange={(e) => set('start_date', e.target.value)} /></label>
      <label className="field"><span>{t('End date, if applicable')}</span><input type="date" value={v.end_date || ''} onChange={(e) => set('end_date', e.target.value)} /></label>
      <label className="field"><span>{t('Preferred arrival time')}</span><input type="time" required value={v.start_time} onChange={(e) => set('start_time', e.target.value)} /></label>
      <label className="field"><span>{t('Estimated duration (minutes)')}</span><input type="number" min={15} required value={v.duration_minutes} onChange={(e) => set('duration_minutes', e.target.value)} /></label>
      <label className="field"><span>{t('Temporary pause from')}</span><input type="date" value={v.paused_from || ''} onChange={(e) => set('paused_from', e.target.value)} /></label>
      <label className="field"><span>{t('Pause until')}</span><input type="date" value={v.paused_until || ''} onChange={(e) => set('paused_until', e.target.value)} /></label>
      <label className="field full"><span>{t('Exceptions and holidays (dates, comma separated)')}</span><input value={v.exceptions} placeholder="2026-11-26, 2026-12-25" onChange={(e) => set('exceptions', e.target.value)} /></label>
    </div>
    <p className="muted">{t('Future appointments are generated for the next 90 days and extended automatically. Completed appointments are never changed.')}</p>
    <div className="row end"><button className="btn primary">{t('Save')}</button></div>
  </form>;
}

export function TeamEditor({ propertyId, current, onDone }: { propertyId: string; current: any[]; onDone: () => void }) {
  const { t } = useT(); const onErr = useErr();
  const helpers = useLoad(() => get('/api/helpers'), []);
  const [rows, setRows] = useState<any[]>(current.map((c) => ({ helper_id: c.helper_id, pay_basis: c.pay_basis, rate: centsToInput(c.rate_cents) })));
  if (!helpers.data) return <Loading />;
  const avail = helpers.data.items.filter((h: any) => !rows.some((r) => r.helper_id === h.id));
  return <div className="form">
    {rows.map((r, i) => <div key={r.helper_id} className="row wrap team-row">
      <b className="grow">{helpers.data.items.find((h: any) => h.id === r.helper_id)?.full_name}</b>
      <select value={r.pay_basis} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, pay_basis: e.target.value } : x)))} aria-label={t('Payment basis')}>{['fixed', 'daily', 'hourly', 'other'].map((b) => <option key={b} value={b}>{t(b)}</option>)}</select>
      <input className="sm" inputMode="decimal" value={r.rate} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} aria-label={t('Rate')} />
      <button className="btn ghost sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>{t('Remove')}</button>
    </div>)}
    {avail.length > 0 && <select value="" onChange={(e) => { const h = helpers.data.items.find((x: any) => x.id === e.target.value); if (h) setRows([...rows, { helper_id: h.id, pay_basis: h.default_pay_basis, rate: centsToInput(h.default_rate_cents) }]); }} aria-label={t('Add a helper')}>
      <option value="">+ {t('Add a helper')}</option>{avail.map((h: any) => <option key={h.id} value={h.id}>{h.full_name}</option>)}</select>}
    <div className="row end"><button className="btn primary" onClick={async () => { try { await put(`/api/properties/${propertyId}/team`, { helpers: rows.map((r) => ({ helper_id: r.helper_id, pay_basis: r.pay_basis, rate: r.rate || '0' })) }); toast(t('Saved')); onDone(); } catch (e) { onErr(e); } }}>{t('Save')}</button></div>
  </div>;
}

export function Services() {
  const { t } = useT(); const { me } = useMe();
  const { data, error, reload } = useLoad(() => get('/api/services'), []);
  const [edit, setEdit] = useState<any>(null);
  const fields: FieldDef[] = [
    { name: 'name', label: 'Service name', required: true }, { name: 'category', label: 'Category', type: 'select', options: ['residential', 'deep', 'move', 'additional', 'other'].map((v) => ({ value: v, label: 'cat_' + v })) },
    { name: 'default_price', label: 'Default price (USD)', type: 'money' }, { name: 'estimated_minutes', label: 'Estimated duration (minutes)', type: 'number' },
    { name: 'active', label: 'Active', type: 'checkbox' }, { name: 'description', label: 'Description', type: 'textarea' }, { name: 'checklist', label: 'Checklist (one item per line)', type: 'textarea' },
  ];
  return (
    <Page title={t('Cleaning Services')} actions={canUi(me, 'write') && <button className="btn primary" onClick={() => setEdit({ active: true })}>+ {t('Add service')}</button>}>
      <Card>
        <p className="muted">{t('Default prices never overwrite negotiated property-specific prices.')}</p>
        {!data ? <Loading error={error} /> : <Table rows={data.items} onRow={canUi(me, 'write') ? (r) => setEdit({ ...r, default_price: centsToInput(r.default_price_cents), active: !!r.active }) : undefined} cols={[
          { key: 'name', label: 'Service' }, { key: 'category', label: 'Category', render: (r) => t('cat_' + r.category), hideSm: true },
          { key: 'estimated_minutes', label: 'Duration', hideSm: true, render: (r) => (r.estimated_minutes ? `${r.estimated_minutes} min` : '—') },
          { key: 'default_price_cents', label: 'Default price', num: true, render: (r) => fmtMoney(r.default_price_cents) }, { key: 'active', label: 'Status', render: (r) => <Badge s={r.active ? 'active' : 'inactive'} /> },
        ]} />}
      </Card>
      {edit && <Modal title={edit.id ? t('Edit') : t('Add service')} onClose={() => setEdit(null)}><Form fields={fields} initial={edit} onCancel={() => setEdit(null)} onSubmit={async (v) => {
        if (edit.id) await put(`/api/services/${edit.id}`, v); else await post('/api/services', v);
        toast(t('Saved')); setEdit(null); reload();
      }} /></Modal>}
    </Page>
  );
}
