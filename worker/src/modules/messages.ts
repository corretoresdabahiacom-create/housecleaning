import { Env, HttpError, Router, Session, json, nowIso, uid, validate } from '../lib/core';
import { owned, requirePerm } from '../lib/security';
import { connectRealtime, notifyRealtime } from '../realtime';

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
export function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return null;
}

// ───────── WhatsApp Cloud API (optional; only when configured AND enabled by the company) ─────────
// Meta rules: free-form text is delivered only within 24 h of the helper's last WhatsApp reply; outside that window
// Meta requires a pre-approved template (error 131047). Failures are logged and never block in-app delivery.
export async function sendWhatsApp(env: Env, companyId: string, messageId: string, phone: string, body: string) {
  const co = await env.DB.prepare('SELECT whatsapp_enabled FROM companies WHERE id=?').bind(companyId).first<any>();
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID || !co?.whatsapp_enabled) return { status: 'disabled' as const };
  const to = phone.replace(/\D/g, '');
  let status: 'sent' | 'failed' = 'failed', providerId: string | null = null, error: string | null = null;
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID)}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: body.slice(0, 4096) } }),
    });
    const d: any = await r.json().catch(() => ({}));
    if (r.ok && d?.messages?.[0]?.id) { status = 'sent'; providerId = d.messages[0].id; }
    else error = String(d?.error?.code ?? r.status) + ' ' + String(d?.error?.message ?? '').slice(0, 200);
  } catch (e) { error = String((e as Error).message).slice(0, 200); }
  await env.DB.prepare('INSERT INTO message_delivery_events (id,company_id,message_id,channel,status,provider_id,error,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(uid(), companyId, messageId, 'whatsapp', status, providerId, error, nowIso()).run();
  return { status, error };
}

async function insertMessage(env: Env, s: Session, convId: string, body: string, side: 'company' | 'helper', att?: { key: string; name: string; type: string }) {
  const id = uid(), created = new Date();
  await env.DB.prepare('INSERT INTO messages (id,company_id,conversation_id,sender_user_id,sender_side,body,attachment_key,attachment_name,attachment_type,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, s.companyId, convId, s.userId, side, body, att?.key ?? null, att?.name ?? null, att?.type ?? null, created.toISOString(), new Date(created.getTime() + MESSAGE_TTL_MS).toISOString()).run();
  const conv = await env.DB.prepare('SELECT helper_id FROM conversations WHERE id=?').bind(convId).first<any>();
  await notifyRealtime(env, s.companyId, { conversation_id: convId, helper_id: conv?.helper_id });
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
    let whatsapp: unknown;
    const wantWa = ct.startsWith('multipart/form-data') ? false : !!(await c.body())?.send_whatsapp;
    if (wantWa && s.role !== 'helper' && body.trim()) {
      const h = await c.env.DB.prepare('SELECT whatsapp FROM helper_records WHERE id=? AND company_id=?').bind(conv.helper_id, s.companyId).first<any>();
      whatsapp = await sendWhatsApp(c.env, s.companyId, id, h.whatsapp, body);
    }
    return json({ id, whatsapp }, 201);
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
    const v = validate(await c.body(), { helper_ids: { type: 'array', required: true }, body: { type: 'string', required: true, max: 4000 }, send_whatsapp: { type: 'bool' } });
    let waSent = 0, waFailed = 0;
    if (v.helper_ids.length > 500) throw new HttpError(422, 'too_many_recipients');
    const ids: string[] = [];
    for (const h of new Set<string>(v.helper_ids)) {
      await owned(c.env, 'helper_records', h, s.companyId);
      const conv = await ensureConversation(c.env, s.companyId, h);
      const mid = await insertMessage(c.env, s, conv.id, v.body, 'company');
      ids.push(mid);
      if (v.send_whatsapp) {
        const hr = await c.env.DB.prepare('SELECT whatsapp FROM helper_records WHERE id=? AND company_id=?').bind(h, s.companyId).first<any>();
        const r = await sendWhatsApp(c.env, s.companyId, mid, hr.whatsapp, v.body);
        if (r.status === 'sent') waSent++; else if (r.status === 'failed') waFailed++;
      }
    }
    return json({ delivered: ids.length, whatsapp: v.send_whatsapp ? { sent: waSent, failed: waFailed } : undefined }, 201);
  });
  r.get('/api/realtime', async (c) => {
    const s = await requirePerm(c.env, c.session, 'messages.use');
    return connectRealtime(c.env, s, c.req);
  });

  // Optional machine translation (Workers AI). The original message is never modified or stored translated.
  r.post('/api/messages/:id/translate', async (c) => {
    const s = await requirePerm(c.env, c.session, 'messages.use');
    const v = validate(await c.body(), { target: { type: 'enum', values: ['en', 'pt', 'es'], required: true } });
    const m = await c.env.DB.prepare('SELECT * FROM messages WHERE id=? AND company_id=? AND expires_at>?').bind(c.params.id, s.companyId, nowIso()).first<any>();
    if (!m) throw new HttpError(404, 'not_found');
    await resolveConversation(c.env, s, m.conversation_id);
    if (!c.env.AI) throw new HttpError(503, 'translation_not_configured');
    let out: any;
    try { out = await c.env.AI.run('@cf/meta/m2m100-1.2b', { text: m.body, target_lang: v.target }); }
    catch { throw new HttpError(502, 'translation_failed'); }
    const text = out?.translated_text ?? out?.result?.translated_text;
    if (typeof text !== 'string') throw new HttpError(502, 'translation_failed');
    return json({ translated_text: text, target: v.target, machine_translated: true });
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
