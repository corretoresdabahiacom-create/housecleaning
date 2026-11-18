// Minimal Stripe REST client (no SDK): form encoding, requests, and webhook signature verification (HMAC-SHA256, 5-minute tolerance).
import { HttpError } from './core';

/** Encodes nested objects/arrays the way Stripe expects: a[b][0][c]=v */
export function stripeForm(obj: Record<string, unknown>, prefix = '', out: [string, string][] = []): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' && x !== null ? stripeForm(x as Record<string, unknown>, `${key}[${i}]`, out) : out.push([`${key}[${i}]`, String(x)])));
    else if (typeof v === 'object') stripeForm(v as Record<string, unknown>, key, out);
    else out.push([key, String(v)]);
  }
  return new URLSearchParams(out);
}

export async function stripeRequest<T = any>(secretKey: string, method: 'GET' | 'POST', path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${secretKey}` };
  let body: string | undefined;
  if (method === 'POST') { headers['content-type'] = 'application/x-www-form-urlencoded'; body = stripeForm(params || {}).toString(); if (idempotencyKey) headers['idempotency-key'] = idempotencyKey; }
  let r: Response;
  try { r = await fetch(`https://api.stripe.com/v1/${path}`, { method, headers, body }); }
  catch { throw new HttpError(502, 'stripe_unreachable'); }
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status === 401 ? 422 : 502, r.status === 401 ? 'stripe_key_invalid' : 'stripe_error', { message: String(d?.error?.message ?? '').slice(0, 200), code: d?.error?.code });
  return d as T;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
function safeEqual(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

/** Stripe-Signature: t=timestamp,v1=hex(HMAC_SHA256(secret, `${t}.${rawBody}`)) — any v1 may match. */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, now = Date.now(), toleranceSec = 300): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('=') as [string, string]);
  const t = parts.find((p) => p[0] === 't')?.[1];
  const sigs = parts.filter((p) => p[0] === 'v1').map((p) => p[1]);
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(now / 1000 - parseInt(t, 10)) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`)));
  return sigs.some((s) => safeEqual(s, expected));
}
