// Standard Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8188 / RFC 8291), using only WebCrypto.
// Works with Chrome/Edge/Firefox/Safari push services (Chrome's endpoint is Google's FCM). No provider account or service-account key needed.
import { Env } from './core';

const enc = new TextEncoder();
export const b64uEncode = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ''; for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const b64uDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource));
}
const hkdfExpand = async (prk: Uint8Array, info: Uint8Array, len: number) => (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);

export interface PushSubscriptionLike { endpoint: string; p256dh: string; auth: string }

/** RFC 8291 encryption. `ephemeral`/`salt` are injectable for deterministic tests. */
export async function encryptPayload(sub: PushSubscriptionLike, payload: Uint8Array, opts: { ephemeral?: CryptoKeyPair; salt?: Uint8Array } = {}) {
  const uaPublic = b64uDecode(sub.p256dh), authSecret = b64uDecode(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('invalid_subscription_keys');
  const eph = opts.ephemeral ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hkdfExpand(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const prk = await hmac(salt, ikm);
  const cek = await hkdfExpand(prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, enc.encode('Content-Encoding: nonce\0'), 12);
  if (payload.length > 3993) throw new Error('payload_too_large');
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
  const header = concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPublic.length]), asPublic); // rs = 4096
  return concat(header, ct);
}

async function vapidJwt(env: Env, audience: string) {
  const pub = b64uDecode(env.VAPID_PUBLIC_KEY!);
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY!, x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64uEncode(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:admin@example.com' })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64uEncode(sig)}`;
}

export const pushConfigured = (env: Env) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

/** Returns 'sent' | 'gone' (subscription expired; delete it) | 'failed'. */
export async function sendWebPush(env: Env, sub: PushSubscriptionLike, message: { title: string; body: string; url?: string; tag?: string }): Promise<'sent' | 'gone' | 'failed'> {
  if (!pushConfigured(env)) return 'failed';
  try {
    const u = new URL(sub.endpoint);
    if (u.protocol !== 'https:') return 'gone';
    const body = await encryptPayload(sub, enc.encode(JSON.stringify(message)));
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { authorization: `vapid t=${await vapidJwt(env, u.origin)}, k=${env.VAPID_PUBLIC_KEY}`, 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal' },
      body,
    });
    if (r.status === 404 || r.status === 410) return 'gone';
    return r.ok ? 'sent' : 'failed';
  } catch { return 'failed'; }
}

/** Notify specific users of a company. Payloads carry no addresses, access codes or message text — only a short generic notice. */
export type PushMsg = { title: string; body: string; url?: string; tag?: string };

const TEXTS: Record<string, Record<'en' | 'pt' | 'es', string>> = {
  new_service: { en: 'New service scheduled', pt: 'Novo serviço agendado', es: 'Nuevo servicio programado' },
  service_changed: { en: 'Service rescheduled', pt: 'Serviço reagendado', es: 'Servicio reprogramado' },
  service_canceled: { en: 'Service canceled', pt: 'Serviço cancelado', es: 'Servicio cancelado' },
  service_finished: { en: 'Service finished — ready to confirm', pt: 'Serviço concluído — pronto para confirmar', es: 'Servicio terminado — listo para confirmar' },
  new_message: { en: 'New private message', pt: 'Nova mensagem privada', es: 'Nuevo mensaje privado' },
  new_announcement: { en: 'New announcement', pt: 'Novo comunicado', es: 'Nuevo comunicado' },
};
/** Localized notification text (the notice carries no address, access code or message content). */
export const pushText = (key: keyof typeof TEXTS, lang: string) => TEXTS[key][(['en', 'pt', 'es'] as const).includes(lang as any) ? (lang as 'en' | 'pt' | 'es') : 'en'];

export async function notifyUsers(env: Env, companyId: string, userIds: string[], message: PushMsg | ((lang: string) => PushMsg)) {
  if (!pushConfigured(env) || !userIds.length) return { sent: 0 };
  const marks = userIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth, u.language FROM push_subscriptions ps JOIN users u ON u.id=ps.user_id WHERE ps.company_id=? AND ps.user_id IN (${marks})`).bind(companyId, ...userIds).all<any>();
  let sent = 0;
  for (const s of results) {
    const r = await sendWebPush(env, s, typeof message === 'function' ? message(s.language) : message);
    if (r === 'sent') sent++;
    if (r === 'gone') await env.DB.prepare('DELETE FROM push_subscriptions WHERE id=?').bind(s.id).run();
  }
  return { sent };
}

/** Users (active members) linked to the given helper records. */
export async function userIdsForHelpers(env: Env, companyId: string, helperIds: string[]) {
  if (!helperIds.length) return [];
  const marks = helperIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT user_id FROM company_members WHERE company_id=? AND status='active' AND helper_id IN (${marks})`).bind(companyId, ...helperIds).all<any>();
  return results.map((r) => r.user_id as string);
}
/** Active staff (non-helper) members, optionally only those whose role is in `roles`. */
export async function staffUserIds(env: Env, companyId: string, roles = ['owner', 'admin', 'manager', 'scheduler']) {
  const marks = roles.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT user_id FROM company_members WHERE company_id=? AND status='active' AND role IN (${marks})`).bind(companyId, ...roles).all<any>();
  return results.map((r) => r.user_id as string);
}
