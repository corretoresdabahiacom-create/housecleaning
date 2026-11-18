// 24-hour appointment reminders to customers who opted in, by WhatsApp (approved template) or SMS (Twilio).
// Safe by construction: one row per (appointment, kind) is claimed BEFORE sending, so overlapping cron runs never double-send;
// failures retry up to 3 times; messages never contain addresses or access instructions.
import { Env, nowIso } from './core';

type Lang = 'en' | 'pt' | 'es';
const WA_LANG: Record<Lang, string> = { en: 'en_US', pt: 'pt_BR', es: 'es' };
const asLang = (l: string): Lang => (['en', 'pt', 'es'] as const).includes(l as Lang) ? (l as Lang) : 'en';

/** US-centric normalization to E.164; returns null when the number cannot be trusted. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, '');
  if (raw.trim().startsWith('+')) return d.length >= 8 && d.length <= 15 ? '+' + d : null;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return null;
}

/** Local wall-clock time in an IANA zone as 'YYYY-MM-DD HH:MM'. */
export function localStamp(tz: string, at = new Date()) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  } catch { return at.toISOString().slice(0, 16).replace('T', ' '); }
}
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

export function reminderText(lang: string, company: string, name: string, date: string, time: string) {
  const l = asLang(lang);
  const first = name.split(' ')[0] || name;
  if (l === 'pt') return `${company}: Olá ${first}, lembrete da sua limpeza em ${date} às ${time}. Responda STOP para não receber mais lembretes.`;
  if (l === 'es') return `${company}: Hola ${first}, recordatorio de su limpieza el ${date} a las ${time}. Responda STOP para dejar de recibir recordatorios.`;
  return `${company}: Hi ${first}, a reminder of your cleaning on ${date} at ${time}. Reply STOP to opt out.`;
}

export function channelConfigured(env: Env, channel: string, whatsappEnabled: number) {
  if (channel === 'whatsapp') return !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_REMINDER_TEMPLATE && whatsappEnabled);
  if (channel === 'sms') return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
  return false;
}

async function deliver(env: Env, channel: string, to: string, a: { company: string; name: string; date: string; time: string; lang: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    if (channel === 'whatsapp') {
      const r = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID!)}/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/\D/g, ''), type: 'template', template: { name: env.WHATSAPP_REMINDER_TEMPLATE, language: { code: WA_LANG[asLang(a.lang)] },
          components: [{ type: 'body', parameters: [a.name.split(' ')[0] || a.name, a.date, a.time, a.company].map((text) => ({ type: 'text', text })) }] } }),
      });
      const d: any = await r.json().catch(() => ({}));
      return r.ok && d?.messages?.[0]?.id ? { ok: true } : { ok: false, error: `${d?.error?.code ?? r.status} ${String(d?.error?.message ?? '').slice(0, 120)}` };
    }
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID!)}/Messages.json`, {
      method: 'POST', headers: { authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: env.TWILIO_FROM!, Body: reminderText(a.lang, a.company, a.name, a.date, a.time) }).toString(),
    });
    const d: any = await r.json().catch(() => ({}));
    return r.ok && d?.sid ? { ok: true } : { ok: false, error: `${d?.code ?? r.status} ${String(d?.message ?? '').slice(0, 120)}` };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 120) }; }
}

export async function sendDueReminders(env: Env, now = new Date()) {
  const cos = (await env.DB.prepare("SELECT id,name,timezone,reminder_channel,whatsapp_enabled FROM companies WHERE status='active' AND reminder_channel IN ('whatsapp','sms')").all<any>()).results;
  let sent = 0, failed = 0;
  for (const co of cos) {
    if (!channelConfigured(env, co.reminder_channel, co.whatsapp_enabled)) continue;
    const local = localStamp(co.timezone, now), today = local.slice(0, 10);
    const { results } = await env.DB.prepare(`SELECT a.id, a.date, a.start_time, cu.full_name, cu.language, cu.phone, cu.whatsapp
        FROM cleaning_appointments a JOIN customers cu ON cu.id=a.customer_id
       WHERE a.company_id=? AND a.date BETWEEN ? AND ? AND a.status IN ('scheduled','confirmed') AND cu.reminder_opt_in=1 AND cu.status='active'`).bind(co.id, today, addDays(today, 1)).all<any>();
    for (const a of results) {
      const start = `${a.date} ${a.start_time}`, trigger = `${addDays(a.date, -1)} ${a.start_time}`;
      if (local < trigger || local >= start) continue;   // only inside the 24 h window before the visit, never after it started
      const stale = new Date(now.getTime() - 30 * 60e3).toISOString();
      let claimed = (await env.DB.prepare("INSERT OR IGNORE INTO appointment_reminders (appointment_id,kind,company_id,channel,status,attempts,updated_at) VALUES (?,'24h',?,?,'sending',1,?)").bind(a.id, co.id, co.reminder_channel, nowIso()).run()).meta.changes === 1;
      if (!claimed) claimed = (await env.DB.prepare("UPDATE appointment_reminders SET status='sending', attempts=attempts+1, channel=?, updated_at=? WHERE appointment_id=? AND kind='24h' AND attempts<3 AND (status='failed' OR (status='sending' AND updated_at<?))").bind(co.reminder_channel, nowIso(), a.id, stale).run()).meta.changes === 1;
      if (!claimed) continue;
      const to = toE164(co.reminder_channel === 'whatsapp' ? a.whatsapp || a.phone : a.phone || a.whatsapp);
      const res = to ? await deliver(env, co.reminder_channel, to, { company: co.name, name: a.full_name, date: a.date, time: a.start_time, lang: a.language }) : { ok: false, error: 'invalid_phone' };
      await env.DB.prepare("UPDATE appointment_reminders SET status=?, error=?, attempts=CASE WHEN ?='invalid_phone' THEN 3 ELSE attempts END, updated_at=? WHERE appointment_id=? AND kind='24h'")
        .bind(res.ok ? 'sent' : 'failed', res.ok ? null : res.error ?? 'error', res.ok ? '' : res.error ?? '', nowIso(), a.id).run();
      res.ok ? sent++ : failed++;
    }
  }
  return { sent, failed };
}
