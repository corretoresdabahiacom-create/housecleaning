import { Env, HttpError, Router, Session, json, nowIso, uid, validate } from '../lib/core';
import { owned, requirePerm } from '../lib/security';

export const MESSAGE_TTL_MS = 24 * 3600 * 1000;
const MAX_ATTACHMENT = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

/** Helpers (role=helper) may only access their own conversation; staff with messages.use may access all of their company's. */
async function resolveConversation(env: Env, s: Session, id: string) {
  const conv: any = await owned(env, 'conversations', id, s.companyId);
  if (s.role === 'helper' && conv.helper_id !== s.helperId) throw new HttpError(404, 'not_found');
  return conv;
}
async function ensureConversation(env: Env, companyId: string, helperId: string) {
  await env.DB.prepare('INSERT INTO conversations (id,company_id,helper_id,created_at) VALUES (?,?,?,?) ON CONFLICT(company_id,helper_id) DO NOTHING').bind(uid(), companyId, helperId, nowIso()).run();
  return (await env.DB.prepare('SELECT * FROM conversations WHERE company_id=? AND helper_id=?').bind(companyId, helperId).first<any>())!;
}

// Magic-number sniffing so the declared content-type cannot be spoofed.
function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return null;
}

async function insertMessage(env: Env, s: Session, convId: string, body: string, side: 'company' | 'helper', att?: { key: string; name: string; type: string }) {
  const id = uid(), created = new Date();
  await env.DB.prepare('INSERT INTO messages (id,company_id,conversation_id,sender_user_id,sender_side,body,attachment_key,attachment_name,attachment_type,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, s.companyId, convId, s.userId, side, body, att?.key ?? null, att?.name ?? null, att?.type ?? null, created.toISOString(), new Date(created.getTime() + MESSAGE_TTL_MS).toISOString()).run();
  return id;
}

export function messageRoutes(r: Router) {
  r.get('/api/conversations', async (c) => {
    const s = await requirePerm(c.env, c.session, 'messages.use');
    const now = nowIso();
    const where = s.role === 'helper' ? 'c.company_id=? AND c.helper_id=?' : 'c.company_id=?';
    const args = s.role === 'helper' ? [s.companyId, s.helperId] : [s.companyId];
    const { results } = await c.env.DB.prepare(`SELECT c.id, c.helper_id, h.full_name AS helper_name, h.whatsapp,
        (SELECT body FROM messages m WHERE m.conversation_id=c.id AND m.expires_at>? ORDER BY created_at DESC LIMIT 1) AS last_body,
        (SELECT created_at FROM messages m WHERE m.conversation_id=c.id AND m.expires_at>? ORDER BY created_at DESC LIMIT 1) AS last_at
      FROM conversations c JOIN helper_records h ON h.id=c.helper_id WHERE ${where} ORDER BY last_at DESC`).bind(now, now, ...args).all();
    return json({ items: results });
  });
  r.post('/api/conversations', async (c) => {
    const s = await requirePerm(c.env, c.session, 'messages.use');
    if (s.role === 'helper') throw new HttpError(403, 'forbidden');
    const v = validate(await c.body(), { helper_id: { type: 'string', required: true } });
    await owned(c.env, 'helper_records', v.helper_id, s.companyId);
    return json({ id: (await ensureConversation(c.env, s.companyId, v.helper_id)).id }, 201);
  });
  r.get('/api/conversations/:id/messages', async (c) => {
    const s = await requirePerm(c.env, c.session, 'messages.use');
    const conv = await resolveConversation(c.env, s, c.params.id);
    // Expired messages are filtered at query time even before the cleanup job runs.
    const { results } = await c.env.DB.prepare('SELECT id,sender_side,body,attachment_name,attachment_type,created_at,expires_at, attachment_key IS NOT NULL AS has_attachment FROM messages WHERE conversation_id=? AND company_id=? AND expires_at>? ORDER BY created_at')
      .bind(conv.id, s.companyId, nowIso()).all();
    return json({ items: results, retention: '24h' });
  });
  r.post('/api/conversations/:id/messages', async (c) => {
    const s = await requirePerm(c.env, c.session, 'messages.use');
    const conv = await resolveConversation(c.env, s, c.params.id);
    const ct = c.req.headers.get('content-type') || '';
    let body = '', att: { key: string; name: string; type: string } | undefined;
    if (ct.startsWith('multipart/form-data')) {
      const form = await c.req.formData();
      body = String(form.get('body') || '').slice(0, 4000);
      const file = form.get('file') as unknown as File | null;
      if (file && typeof file === 'object') {
        if (!c.env.FILES) throw new HttpError(503, 'storage_not_configured');
        if (file.size > MAX_ATTACHMENT) throw new HttpError(413, 'attachment_too_large');
        const buf = new Uint8Array(await file.arrayBuffer());
        const type = sniff(buf);
        if (!type || !ALLOWED_TYPES.has(type)) throw new HttpError(415, 'attachment_type_not_allowed');
        const key = `msg/${s.companyId}/${conv.id}/${uid()}`;
        await c.env.FILES.put(key, buf, { httpMetadata: { contentType: type } });
        att = { key, name: String(file.name || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 100), type };
      }
    } else {
      body = String((await c.body())?.body ?? '');
    }
    if (!body.trim() && !att) throw new HttpError(422, 'validation_error', { body: 'required' });
    if (body.length > 4000) throw new HttpError(422, 'validation_error', { body: 'too_long' });
    const id = await insertMessage(c.env, s, conv.id, body, s.role === 'helper' ? 'helper' : 'company', att);
    return json({ id }, 201);
  });
  r.get('/api/messages/:id/attachment', async (c) => {
    const s = await requirePerm(c.env, c.session, 'messages.use');
    const m = await c.env.DB.prepare('SELECT * FROM messages WHERE id=? AND company_id=? AND expires_at>?').bind(c.params.id, s.companyId, nowIso()).first<any>();
    if (!m || !m.attachment_key) throw new HttpError(404, 'not_found');
    await resolveConversation(c.env, s, m.conversation_id);
    const obj = await c.env.FILES?.get(m.attachment_key);
    if (!obj) throw new HttpError(404, 'not_found');
    return new Response(obj.body, { headers: { 'content-type': m.attachment_type, 'content-disposition': `attachment; filename="${m.attachment_name}"`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' } });
  });
  // Bulk announcement: one PRIVATE message per helper conversation. Never a shared group.
  r.post('/api/messages/bulk', async (c) => {
    const s = await requirePerm(c.env, c.session, 'messages.use');
    if (s.role === 'helper') throw new HttpError(403, 'forbidden');
    const v = validate(await c.body(), { helper_ids: { type: 'array', required: true }, body: { type: 'string', required: true, max: 4000 } });
    if (v.helper_ids.length > 500) throw new HttpError(422, 'too_many_recipients');
    const ids: string[] = [];
    for (const h of new Set<string>(v.helper_ids)) {
      await owned(c.env, 'helper_records', h, s.companyId);
      const conv = await ensureConversation(c.env, s.companyId, h);
      ids.push(await insertMessage(c.env, s, conv.id, v.body, 'company'));
    }
    return json({ delivered: ids.length }, 201);
  });
  // Export: a text transcript of currently-active messages. It is generated on demand and not stored server-side,
  // so it never extends retention on our side; the user is told the export is their own copy.
  r.get('/api/conversations/:id/export', async (c) => {
    const s = await requirePerm(c.env, c.session, 'messages.use');
    const conv = await resolveConversation(c.env, s, c.params.id);
    const { results } = await c.env.DB.prepare('SELECT sender_side, body, created_at FROM messages WHERE conversation_id=? AND company_id=? AND expires_at>? ORDER BY created_at').bind(conv.id, s.companyId, nowIso()).all<any>();
    const text = results.map((m) => `[${m.created_at}] ${m.sender_side}: ${m.body}`).join('\n');
    return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="conversation-${conv.id}.txt"`, 'cache-control': 'no-store' } });
  });
}

/** Cron job: hard-delete expired messages and their attachments; retried with backoff, recorded for monitoring. */
export async function purgeExpiredMessages(env: Env) {
  const now = nowIso();
  let deleted = 0;
  for (;;) {
    const { results } = await env.DB.prepare('SELECT id, attachment_key FROM messages WHERE expires_at<=? LIMIT 200').bind(now).all<any>();
    if (!results.length) break;
    const keys = results.map((r) => r.attachment_key).filter(Boolean);
    if (keys.length && env.FILES) await env.FILES.delete(keys);
    await env.DB.prepare(`DELETE FROM messages WHERE id IN (${results.map(() => '?').join(',')})`).bind(...results.map((r) => r.id)).run();
    deleted += results.length;
  }
  return deleted;
}
