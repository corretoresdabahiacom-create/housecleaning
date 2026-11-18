// Settings cards for round 4: invitations by link, plan billing (Stripe) and the company's own Stripe account for customer payment links.
import React, { useState } from 'react';
import { del, fmtMoney, get, post, put } from '../api';
import { Card, Empty, Form, Modal, Table, toast, useErr, useLoad, useMe, useT } from '../ui';

const copy = async (text: string, ok: string) => { try { await navigator.clipboard.writeText(text); toast(ok); } catch { toast(text); } };

export function InvitesCard({ helpers }: { helpers: any[] }) {
  const { t, lang } = useT(); const { me } = useMe(); const onErr = useErr();
  const list = useLoad(() => get('/api/invitations'), []);
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<any>(null);
  const roles = ['manager', 'scheduler', 'finance', 'helper', ...(me.role === 'owner' ? ['admin'] : [])];
  return <Card title={t('Invite by link')} actions={<button className="btn sm primary" onClick={() => { setResult(null); setAdding(true); }}>+ {t('Invite person')}</button>}>
    <p className="muted small">{t('The person opens the link and signs in with their own Google account (or sets a password) and joins with exactly the role you choose. Links expire in 7 days and work once.')}</p>
    {!me.config?.email_available && <p className="small warn-text">{t('Email sending is not configured on this server: copy the link and send it yourself (WhatsApp, text message…).')}</p>}
    {list.data?.items?.length ? <Table rows={list.data.items} cols={[{ key: 'full_name', label: 'Name' }, { key: 'email', label: 'Email', hideSm: true }, { key: 'role', label: 'Role', render: (r: any) => t('role_' + r.role) },
      { key: 'expires_at', label: 'Expires', hideSm: true, render: (r: any) => new Date(r.expires_at).toLocaleDateString() },
      { key: 'x', label: '', render: (r: any) => <button className="btn sm ghost" onClick={async () => { try { await del(`/api/invitations/${r.id}`); list.reload(); } catch (e) { onErr(e); } }}>{t('Revoke')}</button> }]} /> : <Empty>{t('No pending invitations.')}</Empty>}
    {adding && <Modal title={t('Invite person')} onClose={() => { setAdding(false); setResult(null); list.reload(); }}>
      {result ? <>
        <p>{result.email === 'sent' ? '✓ ' + t('Invitation sent by email.') : t('Email was not sent. Copy the link and send it yourself.')}</p>
        <p className="muted small">{t('This link is shown only now. Anyone who has it can join, so send it only to the invited person.')}</p>
        <div className="linkbox"><input readOnly value={result.link} onFocus={(e) => e.currentTarget.select()} aria-label={t('Invitation link')} /><button className="btn primary" onClick={() => copy(result.link, t('Copied'))}>{t('Copy')}</button></div>
        <div className="row end"><button className="btn" onClick={() => { setAdding(false); setResult(null); list.reload(); }}>{t('Done')}</button></div>
      </> : <Form submitLabel="Create invitation" initial={{ role: 'scheduler', language: lang }} onCancel={() => setAdding(false)} fields={[
        { name: 'full_name', label: 'Full name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true, help: 'For Google sign-in, use the person’s Gmail / Google account email.' },
        { name: 'role', label: 'Role', type: 'select', required: true, options: roles.map((r) => ({ value: r, label: 'role_' + r })) },
        { name: 'helper_id', label: 'Linked helper (for helper role)', type: 'select', options: helpers.map((h: any) => ({ value: h.id, label: h.full_name })), help: 'Required for the helper role: the helper record this person will see as “My day”.' },
        { name: 'language', label: 'Language of the invitation', type: 'select', options: [{ value: 'en', label: 'English' }, { value: 'pt', label: 'Português' }, { value: 'es', label: 'Español' }] },
      ]} onSubmit={async (v) => { setResult(await post('/api/invitations', v)); }} />}
    </Modal>}
  </Card>;
}

export function BillingCard() {
  const { t } = useT(); const onErr = useErr();
  const b = useLoad(() => get('/api/billing'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const status = new URLSearchParams(location.hash.split('?')[1] || '').get('billing');
  const go = async (path: string, body: any, key: string) => { setBusy(key); try { const r = await post(path, body); if (r.url) location.href = r.url; } catch (e) { onErr(e); setBusy(null); } };
  const d = b.data;
  return <Card title={t('Plan & billing')}>
    {status === 'success' && <p className="banner">{t('Thank you! Your subscription is being activated.')}</p>}
    {!d ? null : <>
      <p className="small">{t('Current plan')}: <b>{d.plans.find((p: any) => p.id === d.plan_id)?.name || '—'}</b> · <span className={`badge b-${d.subscription_status === 'active' ? 'paid' : d.subscription_status === 'trial' ? 'pending' : 'overdue'}`}>{t('sub_' + d.subscription_status)}</span>{d.trial_ends_at && d.subscription_status === 'trial' ? ` · ${t('Trial ends')} ${d.trial_ends_at.slice(0, 10)}` : ''}</p>
      {!d.billing_available ? <p className="muted small">{t('Online plan billing is not configured on this server.')}</p> : <>
        {d.plans.map((p: any) => <div key={p.id} className="plan-row">
          <div><b>{p.name}</b><div className="muted small">{fmtMoney(p.price_cents, p.currency)} / {t('month')} · {p.max_properties ?? '∞'} {t('properties')} · {p.max_users ?? '∞'} {t('users')}</div></div>
          {p.id === d.plan_id && d.subscription_status === 'active' ? <span className="ok-text">✓ {t('Current plan')}</span> : <button className="btn sm primary" disabled={!!busy} onClick={() => go('/api/billing/checkout', { plan_id: p.id }, p.id)}>{busy === p.id ? '…' : t('Subscribe')}</button>}
        </div>)}
        {d.can_manage && <div className="row end"><button className="btn" disabled={!!busy} onClick={() => go('/api/billing/portal', {}, 'portal')}>{t('Manage payment method & invoices')}</button></div>}
      </>}
    </>}
  </Card>;
}

export function PaymentsCard() {
  const { t } = useT(); const { refresh } = useMe(); const onErr = useErr();
  const s = useLoad(() => get('/api/payments/settings'), []);
  const [edit, setEdit] = useState(false);
  const d = s.data;
  return <Card title={t('Customer payments (Stripe)')}>
    <p className="muted small">{t('Connect your own Stripe account to send customers a payment link for an invoice. Payments go straight to your Stripe account and are recorded here automatically.')}</p>
    {d?.stripe_configured && !edit ? <>
      <p className="ok-text">✓ {t('Stripe connected')}{d.webhook_secret_configured ? '' : ' · ' + t('webhook not set')}</p>
      <label className="field"><span>{t('Webhook URL (add it in Stripe → Developers → Webhooks, event: checkout.session.completed)')}</span>
        <div className="linkbox"><input readOnly value={d.webhook_url} onFocus={(e) => e.currentTarget.select()} /><button className="btn" onClick={() => copy(d.webhook_url, t('Copied'))}>{t('Copy')}</button></div></label>
      <div className="row end">
        <button className="btn" onClick={() => setEdit(true)}>{t('Replace keys')}</button>
        <button className="btn danger" onClick={async () => { if (!confirm(t('Remove the Stripe connection? Existing payment links will stop being recorded.'))) return; try { await del('/api/payments/settings'); s.reload(); refresh(); } catch (e) { onErr(e); } }}>{t('Disconnect')}</button>
      </div>
    </> : <Form submitLabel="Save" onCancel={d?.stripe_configured ? () => setEdit(false) : undefined} fields={[
      { name: 'stripe_secret_key', label: 'Stripe secret or restricted key', type: 'password', required: true, full: true, help: 'Starts with sk_ or rk_. Stored encrypted and never shown again. Use a restricted key that can only create Checkout Sessions.' },
      { name: 'stripe_webhook_secret', label: 'Stripe webhook signing secret', type: 'password', full: true, help: 'Starts with whsec_. Add it after creating the webhook in Stripe with the URL shown here after saving.' },
    ]} onSubmit={async (v) => { await put('/api/payments/settings', v); toast(t('Saved')); setEdit(false); s.reload(); refresh(); }} />}
  </Card>;
}
