import React, { useEffect, useRef, useState } from 'react';
import { ApiError, get } from '../api';
import { googleIdToken, type FirebaseWebConfig } from '../google';
import { post } from '../api';
import { Form, toast, useT } from '../ui';
import type { Lang } from '../i18n';

const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
export const STATE_OPTIONS = US_STATES.map((s) => ({ value: s, label: s }));
export const LANG_OPTIONS = [{ value: 'en', label: 'English' }, { value: 'pt', label: 'Português' }, { value: 'es', label: 'Español' }];

/** Cloudflare Turnstile widget, rendered only when the server exposes a site key. */
function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const render = () => (window as any).turnstile?.render(ref.current, { sitekey: siteKey, callback: onToken, 'expired-callback': () => onToken('') });
    if ((window as any).turnstile) { render(); return; }
    const sc = document.createElement('script');
    sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; sc.async = true; sc.onload = render;
    document.head.appendChild(sc);
  }, [siteKey]);
  return <div ref={ref} className="turnstile" />;
}

export function AuthScreen({ onDone }: { onDone: () => void }) {
  const { t, lang, setLang } = useT();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset'>(params.get('reset') ? 'reset' : 'login');
  const verify = params.get('verify');
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [firebase, setFirebase] = useState<FirebaseWebConfig | null>(null);
  const [googleReg, setGoogleReg] = useState<{ idToken: string; email: string; name: string } | null>(null);
  useEffect(() => { get('/api/auth/config').then((c) => { setSiteKey(c.turnstile_site_key); setFirebase(c.firebase); }).catch(() => {}); }, []);
  const google = async () => {
    if (!firebase) return;
    try {
      const g = await googleIdToken(firebase);
      try {
        const r = await post('/api/auth/google', { id_token: g.idToken });
        if (r.mfa_required) setMfaToken(r.mfa_token); else onDone();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'google_account_not_registered') { setGoogleReg(g); setMode('register'); toast(t('No account for this Google email yet — complete your business details.')); }
        else throw e;
      }
    } catch (e: any) {
      if (e?.code === 'auth/popup-closed-by-user' || e?.code === 'auth/cancelled-popup-request') return;
      const code = String(e?.code || e?.message || 'unknown');
      const msg = e instanceof ApiError ? t(e.code)
        : code === 'auth/popup-blocked' ? t('Google sign-in failed. Check that pop-ups are allowed.')
        : code === 'auth/unauthorized-domain' ? t('This site is not authorized in Firebase (Authentication → Settings → Authorized domains).')
        : code === 'auth/operation-not-allowed' ? t('Google sign-in is not enabled in Firebase (Authentication → Sign-in method).')
        : `${t('Google sign-in failed.')} (${code})`;
      console.error('Google sign-in error', code, e);
      toast(msg, 'err');
    }
  };
  const GoogleButton = () => firebase ? <><div className="or"><span>{t('or')}</span></div>
    <button type="button" className="btn google" onClick={google}><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>{t('Continue with Google')}</button></> : null;
  React.useEffect(() => { if (verify) post('/api/auth/verify-email', { token: verify }).then(() => toast(t('Email verified.'))).catch(() => toast(t('invalid_token'), 'err')); }, [verify]);

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand"><span className="logo" aria-hidden>⌂</span><div><b>House Cleaning Management</b><small>{t('Run your residential cleaning business in one place.')}</small></div></div>
        <div className="stripes thin" aria-hidden />
        <div className="row end"><select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t('Language')}>{LANG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        {mode === 'login' && mfaToken && <>
          <h1>{t('Two-step verification')}</h1>
          <p className="muted">{t('Enter the 6-digit code from your authenticator app, or a recovery code.')}</p>
          <Form submitLabel="Verify" fields={[{ name: 'code', label: 'Code', required: true, full: true }]}
            onSubmit={async (v) => { await post('/api/auth/mfa/verify', { mfa_token: mfaToken, code: v.code }); onDone(); }} />
          <button className="link" onClick={() => setMfaToken(null)}>{t('Back to sign in')}</button>
        </>}
        {mode === 'login' && !mfaToken && <>
          <h1>{t('Sign in')}</h1>
          <Form submitLabel="Sign in" fields={[{ name: 'email', label: 'Email', type: 'email', required: true, full: true }, { name: 'password', label: 'Password', type: 'password', required: true, full: true }]}
            onSubmit={async (v) => { const r = await post('/api/auth/login', { ...v, turnstile_token: captcha || undefined }); if (r.mfa_required) setMfaToken(r.mfa_token); else onDone(); }} />
          {siteKey && <Turnstile siteKey={siteKey} onToken={setCaptcha} />}
          <GoogleButton />
          <div className="row between"><button className="link" onClick={() => setMode('forgot')}>{t('Forgot password?')}</button><button className="link" onClick={() => setMode('register')}>{t('Create a business account')}</button></div>
        </>}
        {mode === 'register' && <>
          <h1>{t('Create your business account')}</h1>
          {googleReg && <p className="banner">{t('Signing up with Google as')} <b>{googleReg.email}</b></p>}
          <Form key={googleReg?.email || 'pw'} submitLabel="Create account" initial={{ language: lang, country: 'US', full_name: googleReg?.name, email: googleReg?.email }} fields={[
            { name: 'full_name', label: "Owner's full name", required: true }, { name: 'company_name', label: 'Company name', required: true },
            { name: 'email', label: 'Email', type: 'email', required: true },
            ...(googleReg ? [] : [{ name: 'password', label: 'Password', type: 'password' as const, required: true, help: 'At least 10 characters with letters and numbers.' }]),
            { name: 'state', label: 'State', type: 'select', options: STATE_OPTIONS, required: true }, { name: 'city', label: 'City', required: true },
            { name: 'phone', label: 'Business telephone (optional)', type: 'tel' }, { name: 'language', label: 'Preferred language', type: 'select', options: LANG_OPTIONS, required: true },
            { name: 'accept_terms', label: 'I accept the Terms of Service and Privacy Policy', type: 'checkbox', full: true },
          ]} onSubmit={async (v) => {
            const r = await post('/api/auth/register', { ...v, country: 'US', turnstile_token: captcha || undefined, google_id_token: googleReg?.idToken });
            if (r.dev_token) console.info('Development verification link: #/?verify=' + r.dev_token);
            onDone();
          }} />
          {siteKey && <Turnstile siteKey={siteKey} onToken={setCaptcha} />}
          {!googleReg && <GoogleButton />}
          <button className="link" onClick={() => { setGoogleReg(null); setMode('login'); }}>{t('I already have an account')}</button>
        </>}
        {mode === 'forgot' && <>
          <h1>{t('Reset your password')}</h1>
          <Form submitLabel="Send reset link" fields={[{ name: 'email', label: 'Email', type: 'email', required: true, full: true }]} onSubmit={async (v) => {
            const r = await post('/api/auth/forgot-password', v);
            if (r.dev_token) console.info('Development reset link: #/?reset=' + r.dev_token);
            toast(t('If the account exists, a reset link has been sent.'));
            setMode('login');
          }} />
          <button className="link" onClick={() => setMode('login')}>{t('Back to sign in')}</button>
        </>}
        {mode === 'reset' && <>
          <h1>{t('Choose a new password')}</h1>
          <Form submitLabel="Save" fields={[{ name: 'password', label: 'New password', type: 'password', required: true, full: true }]} onSubmit={async (v) => {
            await post('/api/auth/reset-password', { token: params.get('reset'), password: v.password });
            toast(t('Password updated. Please sign in.')); location.hash = '/'; setMode('login');
          }} />
        </>}
      </div>
    </div>
  );
}
