// Mobile-first pages: helper "My day", push-notification settings, and the post-payment thank-you page.
import React, { useEffect, useState } from 'react';
import { get, post, addDays, mapsUrl } from '../api';
import { Card, Empty, Loading, Page, toast, useErr, useLoad, useMe, useT } from '../ui';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../push';

export function PushCard() {
  const { t } = useT(); const { me } = useMe(); const onErr = useErr();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { currentSubscription().then((s) => setOn(!!s)); }, []);
  const standaloneIos = /iphone|ipad/i.test(navigator.userAgent) && !(navigator as any).standalone;
  return <Card title={'🔔 ' + t('Notifications')}>
    {!me.config?.push_available ? <p className="muted small">{t('Push notifications are not configured on this server.')}</p>
      : !pushSupported() ? <p className="muted small">{standaloneIos ? t('On iPhone, first add this app to your Home Screen (Share → Add to Home Screen), then open it from there to enable notifications.') : t('This browser does not support push notifications.')}</p>
      : <>
        <p className="muted small">{me.role === 'helper' ? t('Get a notification when a service is added, changed or canceled, and when you receive a message.') : t('Get a notification when a helper finishes a service and when a helper sends you a message.')}</p>
        <div className="row wrap">
          {on
            ? <><span className="ok-text">✓ {t('Enabled on this device')}</span>
              <button className="btn sm" disabled={busy} onClick={async () => { setBusy(true); try { const r = await post('/api/push/test'); toast(r?.sent ? t('Test notification sent.') : t('No notification could be delivered.'), r?.sent ? 'ok' : 'err'); } catch (e) { onErr(e); } finally { setBusy(false); } }}>{t('Send test')}</button>
              <button className="btn sm ghost" disabled={busy} onClick={async () => { setBusy(true); try { await disablePush(); setOn(false); } finally { setBusy(false); } }}>{t('Turn off')}</button></>
            : <button className="btn primary" disabled={busy} onClick={async () => {
              setBusy(true);
              try { const r = await enablePush(); if (r === 'on') { setOn(true); toast(t('Notifications enabled.')); } else toast(r === 'denied' ? t('Notifications are blocked in your browser settings.') : t('Notifications are not available.'), 'err'); }
              catch (e) { onErr(e); } finally { setBusy(false); }
            }}>{t('Enable notifications')}</button>}
        </div>
      </>}
  </Card>;
}

const fmtDate = (d: string, lang: string) => new Date(d + 'T12:00:00').toLocaleDateString(lang === 'pt' ? 'pt-BR' : lang === 'es' ? 'es-US' : 'en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const hm = (s: string) => s.slice(0, 5);

function FinishBox({ item, onDone, onCancel }: { item: any; onDone: () => void; onCancel: () => void }) {
  const { t } = useT(); const onErr = useErr();
  const [h, setH] = useState(String(Math.floor(item.duration_minutes / 60))); const [m, setM] = useState(String(item.duration_minutes % 60));
  const [busy, setBusy] = useState(false);
  return <div className="finish-box">
    <b>{t('How long did you work?')}</b>
    <div className="row">
      <label className="field"><span>{t('Hours')}</span><input inputMode="numeric" value={h} onChange={(e) => setH(e.target.value.replace(/\D/g, '').slice(0, 2))} /></label>
      <label className="field"><span>{t('Minutes')}</span><input inputMode="numeric" value={m} onChange={(e) => setM(e.target.value.replace(/\D/g, '').slice(0, 2))} /></label>
    </div>
    <div className="row end">
      <button className="btn ghost" onClick={onCancel}>{t('Cancel')}</button>
      <button className="btn primary big" disabled={busy} onClick={async () => {
        const total = (parseInt(h || '0', 10) || 0) * 60 + (parseInt(m || '0', 10) || 0);
        if (total < 1 || total > 1440) { toast(t('Enter the time worked.'), 'err'); return; }
        setBusy(true);
        try { const r = await post(`/api/my-day/${item.id}/finish`, { worked_minutes: total }); toast(r.completed ? t('Service completed. Thank you!') : t('Sent. The office will confirm.')); onDone(); }
        catch (e) { onErr(e); } finally { setBusy(false); }
      }}>✓ {t('Confirm')}</button>
    </div>
  </div>;
}

export function MyDay() {
  const { t, lang } = useT(); const onErr = useErr();
  const [date, setDate] = useState<string | undefined>(undefined);
  const day = useLoad(() => get('/api/my-day' + (date ? `?date=${date}` : '')), [date]);
  const [finishing, setFinishing] = useState<string | null>(null);
  const d = day.data;
  const cur = d?.date || date || '';
  return (
    <Page title={t('My day')}>
      <div className="daynav">
        <button className="btn" aria-label={t('Previous day')} onClick={() => cur && setDate(addDays(cur, -1))}>‹</button>
        <div className="dayname"><b>{cur ? fmtDate(cur, lang) : '…'}</b>{d && cur === d.today && <small>{t('Today')}</small>}</div>
        <button className="btn" aria-label={t('Next day')} onClick={() => cur && setDate(addDays(cur, 1))}>›</button>
        {d && cur !== d.today && <button className="btn sm ghost" onClick={() => setDate(undefined)}>{t('Today')}</button>}
      </div>
      {day.error ? <Loading error={day.error} /> : !d ? <Loading /> : d.items.length === 0 ? <Empty>{t('No services for this day.')}</Empty> :
        d.items.map((a: any) => {
          const addr = [a.street, a.unit].filter(Boolean).join(', ');
          const done = !!a.done_at || a.status === 'completed';
          return <div key={a.id} className={`card myday ${done ? 'is-done' : ''}`}>
            <div className="row between"><b className="big-time">{hm(a.start_time)}</b><span className={`badge b-${a.status}`}>{t(done && a.status !== 'completed' ? 'Sent to the office' : a.status)}</span></div>
            <div className="svc">{a.service_name || t('Cleaning')} · {Math.floor(a.duration_minutes / 60)}h{a.duration_minutes % 60 ? String(a.duration_minutes % 60).padStart(2, '0') : ''}</div>
            <div>{a.customer_name}</div>
            <a className="link addr" target="_blank" rel="noopener noreferrer" href={mapsUrl(a)}>📍 {addr}, {a.city} {a.state} {a.zip}</a>
            {a.teammates && <div className="muted small">👥 {t('With')}: {a.teammates}</div>}
            {(a.bedrooms || a.bathrooms) ? <div className="muted small">{a.bedrooms ?? '–'} {t('bedrooms')} · {a.bathrooms ?? '–'} {t('bathrooms')}{a.pets ? ` · 🐾 ${a.pets}` : ''}</div> : null}
            {a.access_instructions && <div className="accessbox"><b>🔑 {t('Access')}</b><div>{a.access_instructions}</div></div>}
            {a.parking && <div className="small">🅿 {a.parking}</div>}
            {a.special_instructions && <div className="small"><b>{t('Property notes')}:</b> {a.special_instructions}</div>}
            {a.customer_instructions && <div className="small"><b>{t('Customer notes')}:</b> {a.customer_instructions}</div>}
            {a.internal_instructions && <div className="small"><b>{t('Team notes')}:</b> {a.internal_instructions}</div>}
            {!done && a.date <= d.today && (finishing === a.id
              ? <FinishBox item={a} onCancel={() => setFinishing(null)} onDone={() => { setFinishing(null); day.reload(); }} />
              : <div className="row wrap actions">
                {a.status !== 'in_progress' && <button className="btn big" onClick={async () => { try { await post(`/api/my-day/${a.id}/start`); day.reload(); } catch (e) { onErr(e); } }}>▶ {t('Start')}</button>}
                <button className="btn primary big" onClick={() => setFinishing(a.id)}>✓ {t('Finish')}</button>
              </div>)}
          </div>;
        })}
      <PushCard />
    </Page>
  );
}

/** Public thank-you page after a customer pays through a payment link. No data is read or shown. */
export function PaidPage() {
  const { t } = useT();
  const canceled = location.hash.includes('canceled=1');
  return <div className="auth"><div className="auth-card center">
    <div className="logo big" aria-hidden>{canceled ? '↩' : '✓'}</div>
    <h1>{canceled ? t('Payment canceled') : t('Payment received')}</h1>
    <p className="muted">{canceled ? t('No charge was made. You can use the payment link again whenever you are ready.') : t('Thank you! Your payment is being confirmed and you will receive a receipt from the payment processor by email.')}</p>
  </div></div>;
}
