import { Ctx, Env, HttpError, Router, json, securityHeaders } from './lib/core';
import { loadSession } from './lib/security';
import { authRoutes } from './modules/auth';
import { crmRoutes } from './modules/crm';
import { scheduleRoutes, extendAllRules } from './modules/schedule';
import { financeRoutes, generateRecurringExpenses } from './modules/finance';
import { messageRoutes, purgeExpiredMessages } from './modules/messages';
import { reportRoutes, adminRoutes, recordJob } from './modules/reports';
import { purgeDeletedCompanies } from './modules/maintenance';
import { routeRoutes } from './modules/routes';
import { rotateEncryptedData } from './lib/security';

export { RealtimeHub } from './realtime';

export const router = new Router();
authRoutes(router); crmRoutes(router); scheduleRoutes(router); financeRoutes(router); messageRoutes(router); reportRoutes(router); adminRoutes(router); routeRoutes(router);
router.get('/api/health', () => json({ ok: true }), false);

const MAX_BODY = 1_000_000;

export async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  try {
    const m = router.match(req.method, url.pathname);
    if (!m) throw new HttpError(404, 'not_found');
    // CSRF: session cookie is SameSite=Strict AND every state-changing request must carry a custom header,
    // which cross-site forms cannot set (and CORS is not enabled).
    if (req.method !== 'GET' && req.headers.get('x-requested-with') !== 'hcm') throw new HttpError(403, 'csrf');
    const session = await loadSession(env, req);
    if (m.route.auth && !session) throw new HttpError(401, 'unauthenticated');
    let cached: any;
    const ctx: Ctx = {
      req, env, params: m.params, query: url.searchParams, session,
      body: async () => {
        if (cached !== undefined) return cached;
        const len = Number(req.headers.get('content-length') || 0);
        if (len > MAX_BODY) throw new HttpError(413, 'payload_too_large');
        const text = await req.text();
        if (text.length > MAX_BODY) throw new HttpError(413, 'payload_too_large');
        try { cached = text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'invalid_json'); }
        return cached;
      },
    };
    return await m.route.handler(ctx);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, details: e.details }, e.status);
    // Never leak internals or private data in responses/logs.
    console.error('unhandled', (e as Error)?.name, (e as Error)?.message?.slice(0, 200));
    return json({ error: 'internal_error' }, 500);
  }
}

export default {
  async fetch(req: Request, env: Env & { ASSETS?: { fetch: (r: Request) => Promise<Response> } }): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env);
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(req);
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(securityHeaders)) if (k !== 'cache-control') h.set(k, v);
      const wsOrigin = url.origin.replace(/^http/, 'ws');
      h.set('content-security-policy', `default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ${wsOrigin}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
      return new Response(res.body, { status: res.status, headers: h });
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(_ev: unknown, env: Env) {
    await recordJob(env, 'purge_expired_messages', () => purgeExpiredMessages(env));
    await recordJob(env, 'extend_recurring_appointments', () => extendAllRules(env));
    await recordJob(env, 'recurring_expenses', () => generateRecurringExpenses(env));
    await recordJob(env, 'purge_deleted_companies', () => purgeDeletedCompanies(env));
    await recordJob(env, 'reencrypt_old_key_versions', () => rotateEncryptedData(env));
    await recordJob(env, 'prune_rate_limits', () => env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Math.floor(Date.now() / 1000) - 86400).run());
  },
};
