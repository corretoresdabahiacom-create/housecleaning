// Verifies Firebase Authentication ID tokens (used for "Sign in with Google") without the Admin SDK.
// Spec: https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
import { HttpError } from './core';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let cache: { keys: Record<string, JsonWebKey>; exp: number } | null = null;

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

async function keys(fetcher: typeof fetch) {
  if (cache && cache.exp > Date.now()) return cache.keys;
  const r = await fetcher(JWKS_URL);
  if (!r.ok) throw new HttpError(502, 'google_keys_unavailable');
  const maxAge = parseInt(/max-age=(\d+)/.exec(r.headers.get('cache-control') || '')?.[1] || '3600', 10);
  const body = (await r.json()) as { keys: (JsonWebKey & { kid: string })[] };
  cache = { keys: Object.fromEntries(body.keys.map((k) => [k.kid, k])), exp: Date.now() + maxAge * 1000 };
  return cache.keys;
}
export const _resetFirebaseKeyCache = () => { cache = null; };

export interface FirebaseIdentity { uid: string; email: string; email_verified: boolean; name?: string; provider?: string }

export async function verifyFirebaseIdToken(token: unknown, projectId: string | undefined, fetcher: typeof fetch = fetch, now = Date.now()): Promise<FirebaseIdentity> {
  if (!projectId) throw new HttpError(503, 'google_login_not_configured');
  if (typeof token !== 'string' || token.split('.').length !== 3) throw new HttpError(401, 'invalid_google_token');
  const [h, p, sig] = token.split('.');
  let header: any, payload: any;
  try { header = json(h); payload = json(p); } catch { throw new HttpError(401, 'invalid_google_token'); }
  if (header.alg !== 'RS256' || !header.kid) throw new HttpError(401, 'invalid_google_token');
  const jwk = (await keys(fetcher))[header.kid];
  if (!jwk) throw new HttpError(401, 'invalid_google_token');
  const key = await crypto.subtle.importKey('jwk', { ...jwk, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  const t = Math.floor(now / 1000);
  if (!ok || payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}` || !payload.sub
    || typeof payload.exp !== 'number' || payload.exp < t || typeof payload.iat !== 'number' || payload.iat > t + 300
    || typeof payload.auth_time !== 'number' || payload.auth_time > t + 300) throw new HttpError(401, 'invalid_google_token');
  if (!payload.email || payload.email_verified !== true) throw new HttpError(401, 'google_email_not_verified');
  return { uid: payload.sub, email: String(payload.email).toLowerCase(), email_verified: true, name: payload.name, provider: payload.firebase?.sign_in_provider };
}
