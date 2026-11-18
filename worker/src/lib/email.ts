// Transactional email through Resend (https://resend.com). Optional: without RESEND_API_KEY every send is a no-op that
// reports status 'disabled', so flows keep working (links can still be copied by the inviter). Links and bodies are never logged.
import { Env, nowIso, uid } from './core';

export type MailKind = 'verify_email' | 'reset_password' | 'invitation';
type Lang = 'en' | 'pt' | 'es';

const COPY: Record<MailKind, Record<Lang, { subject: string; intro: string; cta: string; outro: string }>> = {
  verify_email: {
    en: { subject: 'Confirm your email', intro: 'Welcome! Please confirm your email address to finish setting up your account.', cta: 'Confirm email', outro: 'If you did not create this account, you can ignore this message.' },
    pt: { subject: 'Confirme seu e-mail', intro: 'Bem-vindo! Confirme seu endereço de e-mail para concluir a configuração da conta.', cta: 'Confirmar e-mail', outro: 'Se você não criou esta conta, ignore esta mensagem.' },
    es: { subject: 'Confirma tu correo', intro: '¡Bienvenido! Confirma tu correo electrónico para terminar de configurar tu cuenta.', cta: 'Confirmar correo', outro: 'Si no creaste esta cuenta, ignora este mensaje.' },
  },
  reset_password: {
    en: { subject: 'Reset your password', intro: 'We received a request to reset your password. The link is valid for 1 hour.', cta: 'Choose a new password', outro: 'If you did not request this, you can ignore this message; your password stays the same.' },
    pt: { subject: 'Redefinir sua senha', intro: 'Recebemos um pedido para redefinir sua senha. O link vale por 1 hora.', cta: 'Escolher nova senha', outro: 'Se você não fez este pedido, ignore esta mensagem; sua senha continua a mesma.' },
    es: { subject: 'Restablecer tu contraseña', intro: 'Recibimos una solicitud para restablecer tu contraseña. El enlace es válido por 1 hora.', cta: 'Elegir nueva contraseña', outro: 'Si no lo solicitaste, ignora este mensaje; tu contraseña no cambia.' },
  },
  invitation: {
    en: { subject: 'You were invited to join {company}', intro: '{inviter} invited you to join {company} as {role}. The invitation is valid for 7 days.', cta: 'Accept invitation', outro: 'If you were not expecting this, you can ignore this message.' },
    pt: { subject: 'Você foi convidado para {company}', intro: '{inviter} convidou você para entrar em {company} como {role}. O convite vale por 7 dias.', cta: 'Aceitar convite', outro: 'Se você não esperava este convite, ignore esta mensagem.' },
    es: { subject: 'Te invitaron a unirte a {company}', intro: '{inviter} te invitó a unirte a {company} como {role}. La invitación es válida por 7 días.', cta: 'Aceptar invitación', outro: 'Si no esperabas esta invitación, ignora este mensaje.' },
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

export function renderMail(kind: MailKind, lang: string, link: string, vars: Record<string, string> = {}) {
  const c = COPY[kind][(['en', 'pt', 'es'] as const).includes(lang as Lang) ? (lang as Lang) : 'en'];
  const subject = fill(c.subject, vars), intro = fill(c.intro, vars);
  const text = `${intro}\n\n${c.cta}: ${link}\n\n${c.outro}\n`;
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;color:#142D52">
<h2 style="margin:0 0 12px">House Cleaning Management</h2><p>${esc(intro)}</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#142D52;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${esc(c.cta)}</a></p>
<p style="font-size:13px;color:#555">${esc(c.outro)}</p></div>`;
  return { subject, text, html };
}

export async function sendMail(env: Env, opts: { to: string; kind: MailKind; lang?: string; link: string; vars?: Record<string, string>; companyId?: string | null }) {
  const m = renderMail(opts.kind, opts.lang || 'en', opts.link, opts.vars);
  let status: 'sent' | 'failed' | 'disabled' = 'disabled', providerId: string | null = null, error: string | null = null;
  if (env.RESEND_API_KEY && env.MAIL_FROM) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [opts.to], subject: m.subject, text: m.text, html: m.html }),
      });
      const d: any = await r.json().catch(() => ({}));
      if (r.ok && d?.id) { status = 'sent'; providerId = d.id; }
      else { status = 'failed'; error = `${r.status} ${String(d?.message ?? d?.name ?? '').slice(0, 160)}`; }
    } catch (e) { status = 'failed'; error = String((e as Error).message).slice(0, 160); }
  }
  try {
    await env.DB.prepare('INSERT INTO email_log (id,company_id,kind,status,provider_id,error,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(uid(), opts.companyId ?? null, opts.kind, status, providerId, error, nowIso()).run();
  } catch { /* logging must never break the flow */ }
  return { status };
}

/** Public origin used in links: explicit APP_ORIGIN, otherwise the origin of the current request. */
export const appOrigin = (env: Env, req: Request) => (env.APP_ORIGIN || new URL(req.url).origin).replace(/\/$/, '');
