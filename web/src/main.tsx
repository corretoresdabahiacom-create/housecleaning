import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { get, post, put } from './api';
import { I18nProvider, SessionCtx, Toaster, canUi, useT } from './ui';
import type { Lang } from './i18n';
import { AuthScreen } from './pages/auth';
import { Customers, CustomerDetail, Properties, PropertyDetail, Services } from './pages/crm';
import { CalendarPage } from './pages/schedule';
import { Helpers, HelperDetail, Teams } from './pages/helpers';
import { FinanceOverview, Receivables, Payables, HelperPayments, DrePage, CashFlowPage, Profitability } from './pages/finance';
import { Dashboard, Messages, Reports, Settings, AdminPage } from './pages/misc';

function useHash() {
  const [h, setH] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => { const f = () => { setH(location.hash.slice(1) || '/'); window.scrollTo(0, 0); }; window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return h;
}
export const nav = (p: string) => { location.hash = p; };

const NAV: { path: string; label: string; icon: string; perm?: Parameters<typeof canUi>[1]; children?: { path: string; label: string }[] }[] = [
  { path: '/', label: 'Dashboard', icon: '▦' },
  { path: '/customers', label: 'Customers', icon: '◉' },
  { path: '/properties', label: 'Properties', icon: '⌂' },
  { path: '/services', label: 'Cleaning Services', icon: '✦' },
  { path: '/calendar', label: 'Calendar', icon: '▤' },
  { path: '/helpers', label: 'Helpers', icon: '☺' },
  { path: '/teams', label: 'Teams', icon: '⚇' },
  { path: '/messages', label: 'Messages', icon: '✉' },
  { path: '/finance', label: 'Financial Management', icon: '$', perm: 'finance', children: [
    { path: '/finance', label: 'Financial Overview' }, { path: '/finance/receivables', label: 'Revenue and Receipts' }, { path: '/finance/expenses', label: 'Expenses' },
    { path: '/finance/receivables?open=1', label: 'Accounts Receivable' }, { path: '/finance/payables', label: 'Accounts Payable' }, { path: '/finance/helpers', label: 'Helper Payments' },
    { path: '/finance/dre', label: 'DRE' }, { path: '/finance/cashflow', label: 'Cash Flow' }, { path: '/finance/profitability', label: 'Property Profitability' },
  ] },
  { path: '/reports', label: 'Reports', icon: '≡', perm: 'finance' },
  { path: '/settings', label: 'Settings', icon: '⚙' },
];

function Shell({ me }: { me: any }) {
  const { t, lang, setLang } = useT();
  const hash = useHash();
  const [open, setOpen] = useState(false);
  const [path, query] = hash.split('?');
  const q = new URLSearchParams(query || '');
  const seg = path.split('/').filter(Boolean);
  const helperOnly = me.role === 'helper';

  let page: React.ReactNode;
  if (helperOnly) page = <Messages />;
  else switch (seg[0]) {
    case undefined: page = <Dashboard />; break;
    case 'customers': page = seg[1] ? <CustomerDetail id={seg[1]} /> : <Customers />; break;
    case 'properties': page = seg[1] ? <PropertyDetail id={seg[1]} /> : <Properties />; break;
    case 'services': page = <Services />; break;
    case 'calendar': page = <CalendarPage initial={Object.fromEntries(q)} />; break;
    case 'helpers': page = seg[1] ? <HelperDetail id={seg[1]} /> : <Helpers />; break;
    case 'teams': page = <Teams />; break;
    case 'messages': page = <Messages />; break;
    case 'finance':
      page = ({ undefined: <FinanceOverview />, receivables: <Receivables openOnly={q.get('open') === '1'} />, expenses: <Payables kind="expense" />, payables: <Payables />,
        helpers: <HelperPayments />, dre: <DrePage />, cashflow: <CashFlowPage />, profitability: <Profitability /> } as any)[String(seg[1])] ?? <FinanceOverview />; break;
    case 'reports': page = <Reports />; break;
    case 'settings': page = <Settings />; break;
    case 'admin': page = <AdminPage />; break;
    default: page = <Dashboard />;
  }
  const active = (p: string) => (p === '/' ? hash === '/' : hash.startsWith(p.split('?')[0]) && (p.includes('?') ? hash.includes(p.split('?')[1]) : true));
  const items = helperOnly ? NAV.filter((n) => n.path === '/messages') : NAV.filter((n) => !n.perm || canUi(me, n.perm));

  return (
    <div className="shell">
      <a href="#main" className="skip">{t('Skip to content')}</a>
      <header className="topbar">
        <button className="btn ghost menu-btn" onClick={() => setOpen(!open)} aria-label={t('Menu')} aria-expanded={open}>☰</button>
        <a href="#/" className="brand"><span className="logo" aria-hidden>⌂</span><span><b>House Cleaning</b><small>Management</small></span></a>
        <div className="stripes" aria-hidden />
        <div className="row topright">
          <select value={lang} aria-label={t('Language')} onChange={(e) => { const l = e.target.value as Lang; setLang(l); put('/api/auth/language', { language: l }).catch(() => {}); }}>
            <option value="en">EN</option><option value="pt">PT</option><option value="es">ES</option>
          </select>
          <span className="who hide-sm">{me.user.full_name}<small>{me.company.name}</small></span>
          <button className="btn ghost" onClick={async () => { await post('/api/auth/logout'); location.hash = '/'; location.reload(); }}>{t('Log out')}</button>
        </div>
      </header>
      <nav className={`side ${open ? 'open' : ''}`} onClick={() => setOpen(false)} aria-label={t('Main navigation')}>
        {items.map((n) => (
          <div key={n.path}>
            <a href={'#' + n.path} className={`nav ${active(n.path) && !n.children ? 'on' : ''}`}><span className="ico" aria-hidden>{n.icon}</span>{t(n.label)}</a>
            {n.children && hash.startsWith('/finance') && <div className="subnav">{n.children.map((c) => <a key={c.path} href={'#' + c.path} className={`nav sub ${hash === c.path ? 'on' : ''}`}>{t(c.label)}</a>)}</div>}
          </div>
        ))}
        {me.user.is_platform_admin ? <a href="#/admin" className="nav"><span className="ico">⛨</span>{t('Platform admin')}</a> : null}
      </nav>
      <main id="main" className="main">
        {!me.user.email_verified_at && <div className="banner">{t('Please verify your email address.')} <button className="link" onClick={() => post('/api/auth/resend-verification').then(() => alert(t('Verification email requested.')))}>{t('Resend')}</button></div>}
        {page}
      </main>
    </div>
  );
}

function App() {
  const [me, setMe] = useState<any>(undefined);
  const refresh = useCallback(async () => { try { setMe(await get('/api/auth/me')); } catch { setMe(null); } }, []);
  useEffect(() => { refresh(); const f = () => setMe(null); window.addEventListener('hcm:unauthenticated', f); return () => window.removeEventListener('hcm:unauthenticated', f); }, [refresh]);
  let stored: Lang = 'en';
  try { stored = (localStorage.getItem('hcm_lang') as Lang) || (navigator.language.startsWith('pt') ? 'pt' : navigator.language.startsWith('es') ? 'es' : 'en'); } catch {}
  if (me === undefined) return null;
  return (
    <I18nProvider initial={me?.user?.language || stored} key={me?.user?.id || 'anon'}>
      <SessionCtx.Provider value={{ me, refresh }}>
        {me ? <Shell me={me} /> : <AuthScreen onDone={refresh} />}
        <Toaster />
      </SessionCtx.Provider>
    </I18nProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
