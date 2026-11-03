import React, { useState } from 'react';
import { centsToInput, del, fmtMoney, get, post, put, waUrl } from '../api';
import { Badge, Card, Empty, FieldDef, Form, Loading, Modal, Page, Table, canUi, toast, useErr, useLoad, useMe, useT } from '../ui';
import { LANG_OPTIONS, STATE_OPTIONS } from './auth';

const BASIS = ['fixed', 'daily', 'hourly', 'other'].map((v) => ({ value: v, label: v }));
const helperFields: FieldDef[] = [
  { name: 'full_name', label: 'Full name', required: true }, { name: 'main_function', label: 'Main function', required: true, placeholder: 'Cleaner, Team lead…' },
  { name: 'state', label: 'State', type: 'select', options: STATE_OPTIONS, required: true }, { name: 'city', label: 'City', required: true },
  { name: 'whatsapp', label: 'WhatsApp number', type: 'tel', required: true }, { name: 'phone', label: 'Telephone', type: 'tel', required: true },
  { name: 'language', label: 'Preferred language', type: 'select', options: LANG_OPTIONS, required: true }, { name: 'email', label: 'Email', type: 'email' },
  { name: 'default_pay_basis', label: 'Default payment basis', type: 'select', options: BASIS }, { name: 'default_rate', label: 'Default rate (USD)', type: 'money' },
  { name: 'favorite', label: 'Favorite', type: 'checkbox' },
  { name: 'experience', label: 'Experience', type: 'textarea' }, { name: 'skills', label: 'Skills', type: 'textarea' },
  { name: 'availability', label: 'Availability', type: 'textarea' }, { name: 'certifications', label: 'Certifications', type: 'textarea' }, { name: 'description', label: 'Description', type: 'textarea' },
];

export function Helpers() {
  const { t } = useT(); const { me } = useMe();
  const [status, setStatus] = useState('active'); const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const { data, error, reload } = useLoad(() => get(`/api/helpers?status=${status}&q=${encodeURIComponent(q)}`), [status, q]);
  return (
    <Page title={t('Helpers & Cleaning Teams')} actions={canUi(me, 'write') && <button className="btn primary" onClick={() => setAdding(true)}>+ {t('Add helper')}</button>}>
      <Card>
        <div className="row wrap filters"><input type="search" placeholder={t('Search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search')} />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('Status')}><option value="active">{t('active')}</option><option value="archived">{t('archived')}</option><option value="all">{t('All statuses')}</option></select></div>
        {!data ? <Loading error={error} /> : <Table rows={data.items} onRow={(r) => (location.hash = `/helpers/${r.id}`)} cols={[
          { key: 'full_name', label: 'Name', render: (r) => <>{r.favorite ? '★ ' : ''}{r.full_name}</> }, { key: 'main_function', label: 'Main function', hideSm: true },
          { key: 'city', label: 'City', render: (r) => `${r.city}, ${r.state}`, hideSm: true }, { key: 'default_rate_cents', label: 'Rate', num: true, render: (r) => `${fmtMoney(r.default_rate_cents)} · ${t(r.default_pay_basis)}` },
          { key: 'whatsapp', label: 'WhatsApp', render: (r) => <a href={waUrl(r.whatsapp)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{r.whatsapp}</a> },
        ]} />}
      </Card>
      {adding && <Modal title={t('Add helper')} onClose={() => setAdding(false)}><Form fields={helperFields} initial={{ language: 'en', default_pay_basis: 'fixed' }} onCancel={() => setAdding(false)} onSubmit={async (v) => { const r = await post('/api/helpers', v); toast(t('Saved')); setAdding(false); reload(); location.hash = `/helpers/${r.id}`; }} /></Modal>}
    </Page>
  );
}

export function HelperDetail({ id }: { id: string }) {
  const { t } = useT(); const { me } = useMe(); const onErr = useErr();
  const { data, error, reload } = useLoad(() => get(`/api/helpers/${id}`), [id]);
  const notes = useLoad(() => (canUi(me, 'private') ? get(`/api/helpers/${id}/notes`) : Promise.resolve({ items: [] })), [id]);
  const [modal, setModal] = useState<null | 'edit' | 'note' | 'rate'>(null);
  if (!data) return <Loading error={error} />;
  const h = data.helper;
  return (
    <Page title={`${h.favorite ? '★ ' : ''}${h.full_name}`} actions={<>
      <a className="btn ghost" href={waUrl(h.whatsapp)} target="_blank" rel="noopener noreferrer">WhatsApp</a>
      <button className="btn ghost" onClick={async () => { const r = await post('/api/conversations', { helper_id: id }); location.hash = `/messages?c=${r.id}`; }}>{t('Message')}</button>
      {canUi(me, 'write') && <>
        <button className="btn ghost" onClick={async () => { try { await put(`/api/helpers/${id}`, { favorite: !h.favorite }); reload(); } catch (e) { onErr(e); } }}>{h.favorite ? t('Unmark favorite') : t('Mark favorite')}</button>
        <button className="btn ghost" onClick={async () => { try { await put(`/api/helpers/${id}`, { status: h.status === 'active' ? 'archived' : 'active' }); toast(t('Saved')); reload(); } catch (e) { onErr(e); } }}>{h.status === 'active' ? t('Archive') : t('Reactivate')}</button>
        <button className="btn" onClick={() => setModal('edit')}>{t('Edit')}</button></>}
    </>}>
      <div className="grid-2">
        <Card title={t('Profile')}>
          <dl className="dl"><dt>{t('Main function')}</dt><dd>{h.main_function}</dd><dt>{t('City')}</dt><dd>{h.city}, {h.state}</dd><dt>{t('Telephone')}</dt><dd>{h.phone}</dd>
            <dt>{t('Preferred language')}</dt><dd>{h.language}</dd><dt>{t('Default rate')}</dt><dd>{fmtMoney(h.default_rate_cents)} · {t(h.default_pay_basis)}</dd><dt>{t('Status')}</dt><dd><Badge s={h.status} /></dd>
            {h.skills && <><dt>{t('Skills')}</dt><dd>{h.skills}</dd></>}{h.availability && <><dt>{t('Availability')}</dt><dd>{h.availability}</dd></>}</dl>
        </Card>
        <Card title={t('Negotiated rates by property')} actions={canUi(me, 'write') && <button className="btn sm" onClick={() => setModal('rate')}>+ {t('Add')}</button>}>
          {data.rates.length ? <ul className="list">{data.rates.map((r: any) => <li key={r.property_id}>{r.name}<span className="muted">{t(r.pay_basis)} · {fmtMoney(r.rate_cents)}</span></li>)}</ul> : <Empty>{t('Default rate applies to all properties.')}</Empty>}
        </Card>
      </div>
      {canUi(me, 'private') && <Card title={'🔒 ' + t('Private notes & evaluations')} actions={<button className="btn sm" onClick={() => setModal('note')}>+ {t('Add')}</button>}>
        <small className="muted">{t('Never visible to helpers or other companies.')}</small>
        {notes.data?.items.length ? <ul className="list">{notes.data.items.map((n: any) => <li key={n.id}><span>{n.kind === 'evaluation' ? '★'.repeat(n.rating || 0) + ' ' : ''}{n.body}</span><span className="muted">{n.created_at.slice(0, 10)}</span></li>)}</ul> : <Empty />}
      </Card>}
      <Card title={t('Work history')} actions={<a className="btn sm ghost" href={`#/calendar?helper_id=${id}`}>{t('Individual calendar')}</a>}>
        <Table rows={data.history} cols={[{ key: 'date', label: 'Date', render: (r) => `${r.date} ${r.start_time}` }, { key: 'property_name', label: 'Property' }, { key: 'attendance', label: 'Attendance', render: (r) => <Badge s={r.attendance} /> }, { key: 'rate_cents', label: 'Rate', num: true, render: (r) => `${fmtMoney(r.rate_cents)} · ${t(r.pay_basis)}` }]} />
      </Card>
      {modal === 'edit' && <Modal title={t('Edit')} onClose={() => setModal(null)}><Form fields={helperFields} initial={{ ...h, default_rate: centsToInput(h.default_rate_cents), favorite: !!h.favorite }} onCancel={() => setModal(null)} onSubmit={async (v) => { await put(`/api/helpers/${id}`, v); toast(t('Saved')); setModal(null); reload(); }} /></Modal>}
      {modal === 'note' && <Modal title={t('Private notes & evaluations')} onClose={() => setModal(null)}><Form fields={[{ name: 'kind', label: 'Type', type: 'select', options: [{ value: 'note', label: 'Note' }, { value: 'evaluation', label: 'Evaluation' }], required: true }, { name: 'rating', label: 'Rating (1–5)', type: 'number' }, { name: 'body', label: 'Text', type: 'textarea', required: true }]} initial={{ kind: 'note' }} onCancel={() => setModal(null)} onSubmit={async (v) => { await post(`/api/helpers/${id}/notes`, v); setModal(null); notes.reload(); }} /></Modal>}
      {modal === 'rate' && <Modal title={t('Negotiated rates by property')} onClose={() => setModal(null)}><Form fields={[{ name: 'property_id', label: 'Property', type: 'search', endpoint: '/api/properties', required: true, itemLabel: (x: any) => x.name + (x.customer_name ? ` — ${x.customer_name}` : '') }, { name: 'pay_basis', label: 'Payment basis', type: 'select', options: BASIS, required: true }, { name: 'rate', label: 'Rate (USD)', type: 'money', required: true }]} initial={{ pay_basis: 'fixed' }} onCancel={() => setModal(null)} onSubmit={async (v) => { await put(`/api/helpers/${id}/rates`, v); toast(t('Saved')); setModal(null); reload(); }} /></Modal>}
    </Page>
  );
}

export function Teams() {
  const { t } = useT(); const { me } = useMe(); const onErr = useErr();
  const { data, error, reload } = useLoad(() => get('/api/teams'), []);
  const helpers = useLoad(() => get('/api/helpers'), []);
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<any>(null);
  return (
    <Page title={t('Teams')}>
      {canUi(me, 'write') && <Card><form className="row wrap" onSubmit={async (e) => { e.preventDefault(); try { await post('/api/teams', { name }); setName(''); reload(); } catch (er) { onErr(er); } }}>
        <input required placeholder={t('New team name')} value={name} onChange={(e) => setName(e.target.value)} aria-label={t('New team name')} /><button className="btn primary">+ {t('Add team')}</button></form></Card>}
      {!data ? <Loading error={error} /> : data.items.length === 0 ? <Empty /> : <div className="cards">{data.items.map((tm: any) => (
        <Card key={tm.id} title={tm.name} actions={canUi(me, 'write') && <><button className="btn sm" onClick={() => setEdit({ ...tm, ids: tm.members.map((m: any) => m.id) })}>{t('Edit')}</button>
          <button className="btn sm ghost" onClick={async () => { if (confirm(t('Delete this team?'))) { await del(`/api/teams/${tm.id}`); reload(); } }}>{t('Delete')}</button></>}>
          {tm.members.length ? <ul className="list">{tm.members.map((m: any) => <li key={m.id}><a href={`#/helpers/${m.id}`}>{m.full_name}</a></li>)}</ul> : <Empty />}
          <a className="link" href={`#/calendar?view=week&team_id=${tm.id}`}>{t('Team calendar')}</a>
        </Card>))}</div>}
      {edit && <Modal title={edit.name} onClose={() => setEdit(null)}>
        <div className="row wrap">{helpers.data?.items.map((h: any) => <label key={h.id} className="chip"><input type="checkbox" checked={edit.ids.includes(h.id)} onChange={(e) => setEdit({ ...edit, ids: e.target.checked ? [...edit.ids, h.id] : edit.ids.filter((x: string) => x !== h.id) })} />{h.full_name}</label>)}</div>
        <div className="row end"><button className="btn primary" onClick={async () => { try { await put(`/api/teams/${edit.id}/members`, { helper_ids: edit.ids }); setEdit(null); reload(); } catch (e) { onErr(e); } }}>{t('Save')}</button></div>
      </Modal>}
    </Page>
  );
}
