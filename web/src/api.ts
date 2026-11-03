export class ApiError extends Error {
  constructor(public status: number, public code: string, public details?: any) { super(code); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-requested-with': 'hcm' };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const res = await fetch(path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin' });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('hcm:unauthenticated'));
    throw new ApiError(res.status, (data as any)?.error || 'error', (data as any)?.details);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body: unknown = {}) => api<T>(p, { method: 'POST', body });
export const put = <T = any>(p: string, body: unknown = {}) => api<T>(p, { method: 'PUT', body });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });

/** Money is integer cents end-to-end. Display only; never parse floats back. */
export const fmtMoney = (cents: number | null | undefined, currency = 'USD') =>
  cents === null || cents === undefined ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
/** cents → editable decimal string (exact) */
export const centsToInput = (c: number | null | undefined) => {
  if (c === null || c === undefined) return '';
  const neg = c < 0, a = Math.abs(c);
  return `${neg ? '-' : ''}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
};
export const qs = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null) as any).toString();
export const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
export const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const mapsUrl = (a: { street: string; unit?: string; city: string; state: string; zip: string }) =>
  'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([a.street, a.unit, a.city, a.state, a.zip].filter(Boolean).join(', '));
export const waUrl = (phone: string) => 'https://wa.me/' + phone.replace(/\D/g, '');
