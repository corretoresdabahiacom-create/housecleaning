import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, addDays, today } from './api';
import { DICT, Lang } from './i18n';

// ───────── i18n ─────────
const I18n = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (s: string, vars?: Record<string, any>) => string }>(null as any);
export function I18nProvider({ children, initial }: { children: React.ReactNode; initial: Lang }) {
  const [lang, setLang] = useState<Lang>(initial);
  useEffect(() => { document.documentElement.lang = lang; try { localStorage.setItem('hcm_lang', lang); } catch {} }, [lang]);
  const t = useCallback((s: string, vars?: Record<string, any>) => {
    let out = DICT[lang][s] || DICT.en[s] || s;
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v));
    return out;
  }, [lang]);
  return <I18n.Provider value={{ lang, setLang, t }}>{children}</I18n.Provider>;
}
export const useT = () => useContext(I18n);

// ───────── Session context ─────────
export const SessionCtx = createContext<{ me: any; refresh: () => Promise<void> }>(null as any);
export const useMe = () => useContext(SessionCtx);
const PERMS: Record<string, string[]> = {
  finance: ['owner', 'admin', 'finance', 'manager'], financeWrite: ['owner', 'admin', 'finance'], manage: ['owner', 'admin'],
  write: ['owner', 'admin', 'manager'], schedule: ['owner', 'admin', 'manager', 'scheduler'], access: ['owner', 'admin', 'manager'], private: ['owner', 'admin', 'manager'],
};
/** UI hint only — every permission is enforced by the API. */
export const canUi = (me: any, p: keyof typeof PERMS) => PERMS[p].includes(me?.role);

// ───────── Async data hook ─────────
export function useLoad<T = any>(fn: () => Promise<T>, deps: any[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true); setError(null);
    fn().then(setData).catch((e) => setError(e instanceof ApiError ? e.code : 'error')).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

// ───────── Toast ─────────
let pushToast: (m: string, kind?: 'ok' | 'err') => void = () => {};
export const toast = (m: string, kind: 'ok' | 'err' = 'ok') => pushToast(m, kind);
export function Toaster() {
  const [items, setItems] = useState<{ id: number; m: string; kind: string }[]>([]);
  pushToast = (m, kind = 'ok') => { const id = Date.now() + Math.random(); setItems((x) => [...x, { id, m, kind }]); setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4000); };
  return <div className="toasts" role="status" aria-live="polite">{items.map((i) => <div key={i.id} className={`toast ${i.kind}`}>{i.m}</div>)}</div>;
}
export function useErr() {
  const { t } = useT();
  return (e: any) => {
    if (e instanceof ApiError) {
      if (e.code === 'validation_error' && e.details) toast(t('Please check') + ': ' + Object.entries(e.details).map(([k, v]) => `${t(k)} (${t(String(v))})`).join(', '), 'err');
      else toast(t(e.code), 'err');
    } else toast(t('error'), 'err');
  };
}

// ───────── Primitives ─────────
export const Card = ({ title, actions, children, className = '' }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) => (
  <section className={`card ${className}`}>
    {(title || actions) && <header className="card-h"><h2>{title}</h2><div className="row">{actions}</div></header>}
    {children}
  </section>
);
export const Page = ({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) => (
  <div className="page"><div className="page-h"><h1>{title}</h1><div className="row wrap">{actions}</div></div>{children}</div>
);
export const Stat = ({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'good' | 'bad' | 'warn' }) => (
  <div className={`stat ${tone || ''}`}><div className="stat-l">{label}</div><div className="stat-v">{value}</div></div>
);
export const Badge = ({ s }: { s: string }) => { const { t } = useT(); return <span className={`badge b-${s}`}>{t(s)}</span>; };
export const Loading = ({ error }: { error?: string | null }) => { const { t } = useT(); return <div className="muted pad">{error ? t(error) : t('Loading…')}</div>; };
export const Empty = ({ children }: { children?: React.ReactNode }) => { const { t } = useT(); return <div className="empty">{children || t('Nothing here yet.')}</div>; };

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="card-h"><h2>{title}</h2><button className="btn ghost" onClick={onClose} aria-label="Close">✕</button></header>
        {children}
      </div>
    </div>
  );
}

// ───────── Declarative form ─────────
export type FieldDef = {
  name: string; label: string; type?: 'text' | 'email' | 'tel' | 'number' | 'money' | 'date' | 'time' | 'select' | 'textarea' | 'checkbox' | 'password' | 'search';
  options?: { value: string; label: string }[]; endpoint?: string; itemLabel?: (x: any) => string; required?: boolean; full?: boolean; placeholder?: string; help?: string;
};
export function Form({ fields, initial = {}, onSubmit, submitLabel, onCancel }: { fields: FieldDef[]; initial?: Record<string, any>; onSubmit: (v: Record<string, any>) => Promise<void> | void; submitLabel?: string; onCancel?: () => void }) {
  const { t } = useT();
  const [v, setV] = useState<Record<string, any>>(initial);
  const [busy, setBusy] = useState(false);
  const onErr = useErr();
  const set = (k: string, val: any) => setV((x) => ({ ...x, [k]: val }));
  return (
    <form className="form" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true);
      try {
        const out: Record<string, any> = {};
        for (const f of fields) {
          let val = v[f.name];
          if (f.type === 'number') val = val === '' || val === undefined ? undefined : parseInt(val, 10);
          if (f.type === 'checkbox') val = !!val;
          if (val !== undefined) out[f.name] = val;
        }
        await onSubmit(out);
      } catch (err) { onErr(err); } finally { setBusy(false); }
    }}>
      <div className="grid2">
        {fields.map((f) => (
          <label key={f.name} className={`field ${f.full || f.type === 'textarea' ? 'full' : ''} ${f.type === 'checkbox' ? 'check' : ''}`}>
            {f.type !== 'checkbox' && <span>{t(f.label)}{f.required && <b className="req"> *</b>}</span>}
            {f.type === 'search' ? (
              <SearchSelect endpoint={f.endpoint!} value={v[f.name] ?? ''} onChange={(id) => set(f.name, id)} label={f.itemLabel || ((x) => x.full_name || x.name)} required={f.required} />
            ) : f.type === 'select' ? (
              <select value={v[f.name] ?? ''} required={f.required} onChange={(e) => set(f.name, e.target.value)}>
                <option value="">—</option>
                {f.options!.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
              </select>
            ) : f.type === 'textarea' ? (
              <textarea rows={3} value={v[f.name] ?? ''} required={f.required} onChange={(e) => set(f.name, e.target.value)} placeholder={f.placeholder} />
            ) : f.type === 'checkbox' ? (
              <><input type="checkbox" checked={!!v[f.name]} onChange={(e) => set(f.name, e.target.checked)} /> <span>{t(f.label)}</span></>
            ) : (
              <input type={f.type === 'money' ? 'text' : f.type || 'text'} inputMode={f.type === 'money' ? 'decimal' : undefined} pattern={f.type === 'money' ? '-?\\d+(\\.\\d{1,2})?' : undefined}
                value={v[f.name] ?? ''} required={f.required} placeholder={f.placeholder ?? (f.type === 'money' ? '0.00' : undefined)} onChange={(e) => set(f.name, e.target.value)} autoComplete={f.type === 'password' ? 'new-password' : undefined} />
            )}
            {f.help && <small className="muted">{t(f.help)}</small>}
          </label>
        ))}
      </div>
      <div className="row end">
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>{t('Cancel')}</button>}
        <button className="btn primary" disabled={busy}>{busy ? t('Saving…') : t(submitLabel || 'Save')}</button>
      </div>
    </form>
  );
}

export function Table<T extends Record<string, any>>({ rows, cols, onRow, empty }: { rows: T[]; cols: { key: string; label: string; render?: (r: T) => React.ReactNode; num?: boolean; hideSm?: boolean }[]; onRow?: (r: T) => void; empty?: string }) {
  const { t } = useT();
  if (!rows.length) return <Empty>{empty ? t(empty) : undefined}</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{cols.map((c) => <th key={c.key} className={`${c.num ? 'num' : ''} ${c.hideSm ? 'hide-sm' : ''}`}>{t(c.label)}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={r.id ?? i} onClick={onRow ? () => onRow(r) : undefined} className={onRow ? 'click' : ''} tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? (e) => e.key === 'Enter' && onRow(r) : undefined}>
            {cols.map((c) => <td key={c.key} data-label={t(c.label)} className={`${c.num ? 'num' : ''} ${c.hideSm ? 'hide-sm' : ''}`}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}
          </tr>))}
        </tbody>
      </table>
    </div>
  );
}

// ───────── Period picker (shared by all financial views) ─────────
export type Period = { from: string; to: string; key: string };
export function periodFor(key: string): Period {
  const d = today(); const dt = new Date(d + 'T00:00:00Z');
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth(), wd = dt.getUTCDay();
  const ymd = (Y: number, M: number, D: number) => new Date(Date.UTC(Y, M, D)).toISOString().slice(0, 10);
  const q = Math.floor(m / 3);
  switch (key) {
    case 'today': return { key, from: d, to: d };
    case 'yesterday': return { key, from: addDays(d, -1), to: addDays(d, -1) };
    case 'week': return { key, from: addDays(d, -wd), to: addDays(d, 6 - wd) };
    case 'prev_week': return { key, from: addDays(d, -wd - 7), to: addDays(d, -wd - 1) };
    case 'prev_month': return { key, from: ymd(y, m - 1, 1), to: ymd(y, m, 0) };
    case 'quarter': return { key, from: ymd(y, q * 3, 1), to: ymd(y, q * 3 + 3, 0) };
    case 'prev_quarter': return { key, from: ymd(y, q * 3 - 3, 1), to: ymd(y, q * 3, 0) };
    case 'year': return { key, from: ymd(y, 0, 1), to: ymd(y, 11, 31) };
    case 'prev_year': return { key, from: ymd(y - 1, 0, 1), to: ymd(y - 1, 11, 31) };
    default: return { key: 'month', from: ymd(y, m, 1), to: ymd(y, m + 1, 0) };
  }
}
const PERIOD_KEYS = ['today', 'yesterday', 'week', 'prev_week', 'month', 'prev_month', 'quarter', 'prev_quarter', 'year', 'prev_year', 'custom'];
export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const { t } = useT();
  return (
    <div className="row wrap period">
      <select value={value.key} onChange={(e) => onChange(e.target.value === 'custom' ? { ...value, key: 'custom' } : periodFor(e.target.value))} aria-label={t('Period')}>
        {PERIOD_KEYS.map((k) => <option key={k} value={k}>{t('period_' + k)}</option>)}
      </select>
      {value.key === 'custom' && <>
        <input type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} aria-label={t('From')} />
        <input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} aria-label={t('To')} />
      </>}
    </div>
  );
}

/** Tiny dependency-free bar chart (SVG). */
export function Bars({ data, height = 140, format }: { data: { label: string; value: number; value2?: number }[]; height?: number; format: (n: number) => string }) {
  const { t } = useT();
  if (!data.length) return <Empty>{t('No data for this period.')}</Empty>;
  const max = Math.max(1, ...data.flatMap((d) => [Math.abs(d.value), Math.abs(d.value2 ?? 0)]));
  const w = Math.max(320, data.length * 28);
  const bw = Math.max(6, (w / data.length) * (data[0].value2 !== undefined ? 0.35 : 0.7));
  return (
    <div className="chart" role="img" aria-label={data.map((d) => `${d.label}: ${format(d.value)}`).join('; ')}>
      <svg viewBox={`0 0 ${w} ${height + 24}`} preserveAspectRatio="none">
        {data.map((d, i) => {
          const x = (i + 0.5) * (w / data.length);
          const h1 = (Math.abs(d.value) / max) * height, h2 = ((Math.abs(d.value2 ?? 0)) / max) * height;
          return <g key={i}>
            <rect x={x - bw - (d.value2 !== undefined ? 1 : -bw / 2)} y={height - h1} width={bw} height={h1} rx="3" className={d.value < 0 ? 'bar-neg' : 'bar1'}><title>{`${d.label}: ${format(d.value)}`}</title></rect>
            {d.value2 !== undefined && <rect x={x + 1} y={height - h2} width={bw} height={h2} rx="3" className="bar2"><title>{`${d.label}: ${format(d.value2)}`}</title></rect>}
            {(data.length <= 14 || i % Math.ceil(data.length / 12) === 0) && <text x={x} y={height + 16} textAnchor="middle" className="axis">{d.label.length > 7 ? d.label.slice(5) : d.label}</text>}
          </g>;
        })}
      </svg>
    </div>
  );
}

export function HBars({ data, format }: { data: { name: string; v: number }[]; format: (n: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.v));
  if (!data.length) return <Empty />;
  return <div className="hbars">{data.map((d) => <div key={d.name} className="hbar"><span className="hbar-n">{d.name}</span><span className="hbar-t"><i style={{ width: `${(d.v / max) * 100}%` }} /></span><span className="hbar-v">{format(d.v)}</span></div>)}</div>;
}

export function downloadReport(name: string, params: Record<string, string>, format: 'csv' | 'xlsx' | 'pdf' = 'csv') {
  let lang = 'en'; try { lang = document.documentElement.lang || 'en'; } catch { /* ignore */ }
  const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).filter(([, v]) => v)), format, lang });
  const a = document.createElement('a'); a.href = `/api/reports/${name}?${q}`; a.rel = 'noopener'; a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}
/** CSV · XLSX · PDF buttons for a report. */
export function ExportButtons({ name, params }: { name: string; params: Record<string, string> }) {
  return <span className="row">{(['pdf', 'xlsx', 'csv'] as const).map((f) => <button key={f} type="button" className="btn sm ghost" onClick={() => downloadReport(name, params, f)}>{f.toUpperCase()}</button>)}</span>;
}

/**
 * Autocomplete select backed by a server search endpoint (no 200-record limit).
 * `endpoint` must accept ?q= and return { items }; `label` renders an item.
 */
export function SearchSelect({ endpoint, value, onChange, label, placeholder, required, extraQuery = '' }: {
  endpoint: string; value: string; onChange: (id: string, item?: any) => void; label: (x: any) => string; placeholder?: string; required?: boolean; extraQuery?: string;
}) {
  const { t } = useT();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<any>(null);
  const [active, setActive] = useState(0);
  const listId = React.useId();
  useEffect(() => {
    if (!value) { setSelected(null); return; }
    if (selected?.id === value) return;
    fetch(`${endpoint.split('?')[0]}/${value}`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((d: any) => d && setSelected(d.customer || d.property || d.helper || d)).catch(() => {});
  }, [value]);
  useEffect(() => {
    if (!open) return;
    const h = setTimeout(() => {
      const sep = endpoint.includes('?') ? '&' : '?';
      fetch(`${endpoint}${sep}q=${encodeURIComponent(q)}&limit=20${extraQuery}`, { credentials: 'same-origin' }).then((r) => r.json()).then((d: any) => { setItems(d.items || []); setActive(0); }).catch(() => setItems([]));
    }, 200);
    return () => clearTimeout(h);
  }, [q, open, endpoint, extraQuery]);
  const pick = (x: any) => { setSelected(x); onChange(x.id, x); setOpen(false); setQ(''); };
  return (
    <div className="combo">
      <input role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" required={required && !value}
        value={open ? q : selected ? label(selected) : ''} placeholder={placeholder || t('Type to search…')}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === 'Enter' && open && items[active]) { e.preventDefault(); pick(items[active]); }
          else if (e.key === 'Escape') setOpen(false);
        }} />
      {open && <ul className="combo-list" id={listId} role="listbox">
        {items.length === 0 ? <li className="muted">{t('No matches')}</li> : items.map((x, i) => <li key={x.id} role="option" aria-selected={i === active} className={i === active ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(x); }}>{label(x)}</li>)}
      </ul>}
    </div>
  );
}
