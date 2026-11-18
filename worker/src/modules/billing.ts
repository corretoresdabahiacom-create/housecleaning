// Stripe integration, two separate money flows:
//  1) Platform plans: the company subscribes to a plan; the platform's own Stripe key (Worker secret) is used.
//  2) Customer payment links: the cleaning company collects from ITS customers with ITS OWN Stripe account (key stored encrypted),
//     so funds never pass through the platform.
// Card data never touches this app: payment happens on Stripe Checkout. Webhooks are signature-verified and idempotent.
import { Ctx, Env, HttpError, Router, json, nowIso, todayIn, uid, validate } from '../lib/core';
import { audit, decrypt, encrypt, owned, requirePerm } from '../lib/security';
import { appOrigin } from '../lib/email';
import { stripeRequest, verifyStripeSignature } from '../lib/stripe';
import { refreshReceivable } from './finance';

const mapStatus = (s: string) => (s === 'active' || s === 'trialing' ? 'active' : s === 'past_due' || s === 'unpaid' || s === 'incomplete' ? 'past_due' : 'canceled');

async function companyStripe(env: Env, companyId: string) {
  const row = await env.DB.prepare('SELECT * FROM company_payment_settings WHERE company_id=?').bind(companyId).first<any>();
  if (!row?.stripe_key_enc) return null;
  return {
    key: await decrypt(env, row.stripe_key_enc, row.stripe_key_iv, `stripe:key:${companyId}`, row.stripe_key_version),
    whsec: row.stripe_whsec_enc ? await decrypt(env, row.stripe_whsec_enc, row.stripe_whsec_iv, `stripe:whsec:${companyId}`, row.stripe_whsec_version) : null,
  };
}

/** Records a card payment as a receipt, idempotently (key = Stripe session id). Money already collected is always recorded. */
async function recordStripePayment(env: Env, companyId: string, session: any) {
  const link = await env.DB.prepare('SELECT * FROM payment_links WHERE stripe_session_id=? AND company_id=?').bind(session.id, companyId).first<any>();
  if (!link) return 'unknown_session';
  if (session.payment_status !== 'paid') return 'not_paid';
  const co = await env.DB.prepare('SELECT timezone, currency FROM companies WHERE id=?').bind(companyId).first<any>();
  const amount = Number.isSafeInteger(session.amount_total) && session.amount_total > 0 ? session.amount_total : link.amount_cents;
  const dup = await env.DB.prepare('SELECT id FROM receipts WHERE company_id=? AND idempotency_key=?').bind(companyId, `stripe:${session.id}`).first();
  if (!dup) {
    await env.DB.prepare('INSERT INTO receipts (id,company_id,receivable_id,kind,amount_cents,currency,date,method,notes,idempotency_key,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(uid(), companyId, link.receivable_id, 'receipt', amount, link.currency, todayIn(co?.timezone), 'credit_card_manual', amount !== link.amount_cents ? 'Stripe payment link (amount differs from link)' : 'Stripe payment link', `stripe:${session.id}`, 'stripe', nowIso()).run();
  }
  await env.DB.prepare("UPDATE payment_links SET status='paid' WHERE id=?").bind(link.id).run();
  await refreshReceivable(env, companyId, link.receivable_id);
  await audit(env, { userId: 'stripe', companyId } as any, 'stripe_payment', 'receivable', link.receivable_id, { amount });
  return 'recorded';
}

async function processedOnce(env: Env, eventId: string) {
  return !!(await env.DB.prepare('SELECT 1 FROM stripe_events WHERE id=?').bind(eventId).first());
}
const markProcessed = (env: Env, eventId: string) => env.DB.prepare('INSERT OR IGNORE INTO stripe_events (id,received_at) VALUES (?,?)').bind(eventId, nowIso()).run();

async function readSignedEvent(c: Ctx, secret: string | null | undefined) {
  const raw = await c.req.text();
  if (!secret || !(await verifyStripeSignature(raw, c.req.headers.get('stripe-signature'), secret))) throw new HttpError(400, 'invalid_signature');
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_json'); }
}

export function billingRoutes(r: Router) {
  // ── Platform plans ──
  r.get('/api/billing', async (c) => {
    const s = await requirePerm(c.env, c.session, 'company.manage');
    const co = await c.env.DB.prepare('SELECT plan_id, subscription_status, trial_ends_at, stripe_customer_id FROM companies WHERE id=?').bind(s.companyId).first<any>();
    const plans = (await c.env.DB.prepare('SELECT id,name,price_cents,currency,max_properties,max_users FROM subscription_plans WHERE active=1 ORDER BY price_cents').all()).results;
    return json({ plan_id: co.plan_id, subscription_status: co.subscription_status, trial_ends_at: co.trial_ends_at, plans, billing_available: !!c.env.STRIPE_SECRET_KEY, can_manage: !!co.stripe_customer_id && !!c.env.STRIPE_SECRET_KEY });
  });

  r.post('/api/billing/checkout', async (c) => {
    const s = await requirePerm(c.env, c.session, 'company.manage');
    if (s.role !== 'owner' && s.role !== 'admin') throw new HttpError(403, 'forbidden');
    if (!c.env.STRIPE_SECRET_KEY) throw new HttpError(503, 'billing_not_configured');
    const v = validate(await c.body(), { plan_id: { type: 'string', required: true } });
    const plan = await c.env.DB.prepare('SELECT * FROM subscription_plans WHERE id=? AND active=1').bind(v.plan_id).first<any>();
    if (!plan) throw new HttpError(404, 'not_found');
    const key = c.env.STRIPE_SECRET_KEY;
    let priceId: string | null = plan.stripe_price_id;
    if (!priceId) {   // create the Stripe product/price once, from the plan's own data
      const product = await stripeRequest(key, 'POST', 'products', { name: `House Cleaning Management — ${plan.name}`, metadata: { plan_id: plan.id } }, `plan-product-${plan.id}`);
      const price = await stripeRequest(key, 'POST', 'prices', { product: product.id, currency: String(plan.currency).toLowerCase(), unit_amount: plan.price_cents, recurring: { interval: 'month' }, metadata: { plan_id: plan.id } }, `plan-price-${plan.id}-${plan.price_cents}`);
      priceId = price.id;
      await c.env.DB.prepare('UPDATE subscription_plans SET stripe_price_id=? WHERE id=?').bind(priceId, plan.id).run();
    }
    const co = await c.env.DB.prepare('SELECT stripe_customer_id FROM companies WHERE id=?').bind(s.companyId).first<any>();
    const me = await c.env.DB.prepare('SELECT email FROM users WHERE id=?').bind(s.userId).first<any>();
    const origin = appOrigin(c.env, c.req);
    const session = await stripeRequest(key, 'POST', 'checkout/sessions', {
      mode: 'subscription', line_items: [{ price: priceId, quantity: 1 }], client_reference_id: s.companyId,
      ...(co.stripe_customer_id ? { customer: co.stripe_customer_id } : { customer_email: me.email }),
      metadata: { company_id: s.companyId, plan_id: plan.id }, subscription_data: { metadata: { company_id: s.companyId, plan_id: plan.id } },
      success_url: `${origin}/#/settings?billing=success`, cancel_url: `${origin}/#/settings?billing=canceled`,
    });
    await audit(c.env, s, 'billing_checkout', 'plan', plan.id);
    return json({ url: session.url });
  });

  r.post('/api/billing/portal', async (c) => {
    const s = await requirePerm(c.env, c.session, 'company.manage');
    if (s.role !== 'owner' && s.role !== 'admin') throw new HttpError(403, 'forbidden');
    if (!c.env.STRIPE_SECRET_KEY) throw new HttpError(503, 'billing_not_configured');
    const co = await c.env.DB.prepare('SELECT stripe_customer_id FROM companies WHERE id=?').bind(s.companyId).first<any>();
    if (!co?.stripe_customer_id) throw new HttpError(409, 'no_subscription');
    const session = await stripeRequest(c.env.STRIPE_SECRET_KEY, 'POST', 'billing_portal/sessions', { customer: co.stripe_customer_id, return_url: `${appOrigin(c.env, c.req)}/#/settings` });
    return json({ url: session.url });
  });

  // Platform webhook (events about plan subscriptions). Public, signature-verified, idempotent.
  r.post('/api/stripe/webhook', async (c) => {
    const ev = await readSignedEvent(c, c.env.STRIPE_WEBHOOK_SECRET);
    if (await processedOnce(c.env, ev.id)) return json({ ok: true, duplicate: true });
    const o = ev.data?.object ?? {};
    const setStatus = async (where: string, val: string, status: string, extra = '') =>
      c.env.DB.prepare(`UPDATE companies SET subscription_status=?${extra} WHERE ${where}=? AND status<>'deleted'`).bind(status, val).run();
    switch (ev.type) {
      case 'checkout.session.completed': {
        const companyId = o.metadata?.company_id || o.client_reference_id;
        if (o.mode !== 'subscription' || !companyId) break;
        const plan = o.metadata?.plan_id ? await c.env.DB.prepare('SELECT id FROM subscription_plans WHERE id=?').bind(o.metadata.plan_id).first<any>() : null;
        await c.env.DB.prepare("UPDATE companies SET stripe_customer_id=?, stripe_subscription_id=?, plan_id=COALESCE(?,plan_id), subscription_status='active' WHERE id=? AND status<>'deleted'")
          .bind(o.customer ?? null, o.subscription ?? null, plan?.id ?? null, companyId).run();
        await audit(c.env, { userId: 'stripe', companyId } as any, 'subscription_started', 'plan', plan?.id ?? null);
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await setStatus('stripe_subscription_id', o.id, ev.type.endsWith('deleted') ? 'canceled' : mapStatus(o.status));
        break;
      case 'invoice.payment_failed': if (o.subscription) await setStatus('stripe_subscription_id', o.subscription, 'past_due'); break;
      case 'invoice.paid': if (o.subscription) await c.env.DB.prepare("UPDATE companies SET subscription_status='active' WHERE stripe_subscription_id=? AND subscription_status<>'canceled' AND status<>'deleted'").bind(o.subscription).run(); break;
    }
    await markProcessed(c.env, ev.id);
    return json({ ok: true });
  }, false);

  // ── Company's own Stripe account (customer payment links) ──
  r.get('/api/payments/settings', async (c) => {
    const s = await requirePerm(c.env, c.session, 'company.manage');
    const row = await c.env.DB.prepare('SELECT stripe_key_enc, stripe_whsec_enc FROM company_payment_settings WHERE company_id=?').bind(s.companyId).first<any>();
    return json({ stripe_configured: !!row?.stripe_key_enc, webhook_secret_configured: !!row?.stripe_whsec_enc, webhook_url: `${appOrigin(c.env, c.req)}/api/stripe/webhook/${s.companyId}` });
  });
  r.put('/api/payments/settings', async (c) => {
    const s = await requirePerm(c.env, c.session, 'company.manage');
    if (s.role !== 'owner' && s.role !== 'admin') throw new HttpError(403, 'forbidden');
    const b = await c.body();
    const key = String(b?.stripe_secret_key || '').trim(), whsec = String(b?.stripe_webhook_secret || '').trim();
    if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(key)) throw new HttpError(422, 'validation_error', { stripe_secret_key: 'invalid' });
    if (whsec && !/^whsec_[A-Za-z0-9+/=_-]{10,}$/.test(whsec)) throw new HttpError(422, 'validation_error', { stripe_webhook_secret: 'invalid' });
    const k = await encrypt(c.env, key, `stripe:key:${s.companyId}`);
    const w = whsec ? await encrypt(c.env, whsec, `stripe:whsec:${s.companyId}`) : null;
    await c.env.DB.prepare(`INSERT INTO company_payment_settings (company_id,stripe_key_enc,stripe_key_iv,stripe_key_version,stripe_whsec_enc,stripe_whsec_iv,stripe_whsec_version,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(company_id) DO UPDATE SET stripe_key_enc=excluded.stripe_key_enc, stripe_key_iv=excluded.stripe_key_iv, stripe_key_version=excluded.stripe_key_version,
        stripe_whsec_enc=COALESCE(excluded.stripe_whsec_enc, stripe_whsec_enc), stripe_whsec_iv=COALESCE(excluded.stripe_whsec_iv, stripe_whsec_iv), stripe_whsec_version=COALESCE(excluded.stripe_whsec_version, stripe_whsec_version), updated_at=excluded.updated_at`)
      .bind(s.companyId, k.ciphertext, k.iv, k.version, w?.ciphertext ?? null, w?.iv ?? null, w?.version ?? null, nowIso()).run();
    await audit(c.env, s, 'update', 'payment_settings', s.companyId, { live: key.includes('_live_') });   // the key itself is never logged
    return json({ ok: true });
  });
  r.del('/api/payments/settings', async (c) => {
    const s = await requirePerm(c.env, c.session, 'company.manage');
    await c.env.DB.prepare('DELETE FROM company_payment_settings WHERE company_id=?').bind(s.companyId).run();
    await audit(c.env, s, 'delete', 'payment_settings', s.companyId);
    return json({ ok: true });
  });

  // Payment link for the outstanding balance of a receivable.
  r.post('/api/finance/receivables/:id/payment-link', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.write');
    const st = await companyStripe(c.env, s.companyId);
    if (!st) throw new HttpError(503, 'payments_not_configured');
    const ar = await refreshReceivable(c.env, s.companyId, c.params.id);
    if (['canceled', 'written_off', 'paid'].includes(ar.status) || ar.outstanding_cents <= 0) throw new HttpError(409, 'nothing_to_collect');
    const cu: any = await owned(c.env, 'customers', ar.customer_id, s.companyId);
    const origin = appOrigin(c.env, c.req);
    const session = await stripeRequest(st.key, 'POST', 'checkout/sessions', {
      mode: 'payment', client_reference_id: ar.id,
      line_items: [{ quantity: 1, price_data: { currency: String(ar.currency).toLowerCase(), unit_amount: ar.outstanding_cents, product_data: { name: String(ar.description).slice(0, 120) } } }],
      ...(cu.email ? { customer_email: cu.email } : {}),
      metadata: { company_id: s.companyId, receivable_id: ar.id }, payment_intent_data: { metadata: { company_id: s.companyId, receivable_id: ar.id } },
      success_url: `${origin}/#/paid`, cancel_url: `${origin}/#/paid?canceled=1`,
    });
    const id = uid();
    await c.env.DB.prepare('INSERT INTO payment_links (id,company_id,receivable_id,stripe_session_id,amount_cents,currency,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, s.companyId, ar.id, session.id, ar.outstanding_cents, ar.currency, s.userId, nowIso()).run();
    await audit(c.env, s, 'create', 'payment_link', id, { receivable: ar.id, amount: ar.outstanding_cents });
    return json({ id, url: session.url, amount_cents: ar.outstanding_cents }, 201);
  });

  // Company webhook: payments made through its payment links.
  r.post('/api/stripe/webhook/:companyId', async (c) => {
    const st = await companyStripe(c.env, c.params.companyId).catch(() => null);
    const ev = await readSignedEvent(c, st?.whsec);
    if (await processedOnce(c.env, ev.id)) return json({ ok: true, duplicate: true });
    const o = ev.data?.object ?? {};
    if (o.metadata?.company_id && o.metadata.company_id !== c.params.companyId) throw new HttpError(400, 'company_mismatch');
    if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') await recordStripePayment(c.env, c.params.companyId, o);
    else if (ev.type === 'checkout.session.expired') await c.env.DB.prepare("UPDATE payment_links SET status='expired' WHERE stripe_session_id=? AND company_id=? AND status='open'").bind(o.id, c.params.companyId).run();
    await markProcessed(c.env, ev.id);
    return json({ ok: true });
  }, false);

  r.get('/api/finance/receivables/:id/payment-links', async (c) => {
    const s = await requirePerm(c.env, c.session, 'finance.read');
    await owned(c.env, 'accounts_receivable', c.params.id, s.companyId);
    return json({ items: (await c.env.DB.prepare('SELECT id,amount_cents,currency,status,created_at FROM payment_links WHERE company_id=? AND receivable_id=? ORDER BY created_at DESC LIMIT 20').bind(s.companyId, c.params.id).all()).results });
  });
}
