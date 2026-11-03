// Core primitives: env, errors, routing, validation, money, ids.

export interface D1Like {
  prepare(sql: string): D1StmtLike;
  batch(stmts: D1StmtLike[]): Promise<unknown[]>;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  first<T = any>(): Promise<T | null>;
  all<T = any>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface R2Like {
  put(key: string, value: ArrayBuffer | Uint8Array | string, opts?: unknown): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream | null; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string | string[]): Promise<void>;
}

export interface Env {
  DB: D1Like;
  FILES?: R2Like;
  ENCRYPTION_KEY: string;      // base64 32 bytes, current key (secret)
  ENCRYPTION_KEY_VERSION?: string;   // integer version of ENCRYPTION_KEY (default "1")
  ENCRYPTION_KEY_PREVIOUS?: string;  // previous key during rotation (secret)
  TURNSTILE_SECRET?: string;   // enables bot protection on auth endpoints (secret)
  TURNSTILE_SITE_KEY?: string; // public site key exposed to the UI
  WHATSAPP_TOKEN?: string;     // WhatsApp Cloud API access token (secret)
  WHATSAPP_PHONE_NUMBER_ID?: string;
  AI?: { run(model: string, input: unknown): Promise<any> };   // Workers AI binding (translation)
  REALTIME?: { idFromName(n: string): any; get(id: any): { fetch(r: Request): Promise<Response> } };  // Durable Object namespace
  PURGE_AFTER_DAYS?: string;   // retention before hard purge of deleted companies (default 30)
  APP_ENV?: string;            // 'development' | 'staging' | 'production'
  APP_ORIGIN?: string;
}

export interface Session {
  userId: string;
  companyId: string;
  role: Role;
  helperId: string | null;
  isPlatformAdmin: boolean;
  sessionId: string;
  currency: string;
  timezone?: string;
}

export type Role = 'owner' | 'admin' | 'manager' | 'scheduler' | 'finance' | 'helper';

export class HttpError extends Error {
  constructor(public status: number, public code: string, public details?: unknown) {
    super(code);
  }
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...securityHeaders, ...headers },
  });

export const securityHeaders: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

export const uid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
export const todayIso = () => new Date().toISOString().slice(0, 10);
/** Current calendar date in an IANA time zone (company-local scheduling dates). */
export const todayIn = (tz?: string | null) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return todayIso(); }
};

// ───────── Router ─────────
export interface Ctx {
  req: Request;
  env: Env;
  params: Record<string, string>;
  query: URLSearchParams;
  session: Session | null;
  body: () => Promise<any>;
}
type Handler = (c: Ctx) => Promise<Response> | Response;
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler; auth: boolean }

export class Router {
  routes: Route[] = [];
  add(method: string, path: string, handler: Handler, auth = true) {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    this.routes.push({ method, re, keys, handler, auth });
  }
  get = (p: string, h: Handler, auth = true) => this.add('GET', p, h, auth);
  post = (p: string, h: Handler, auth = true) => this.add('POST', p, h, auth);
  put = (p: string, h: Handler, auth = true) => this.add('PUT', p, h, auth);
  del = (p: string, h: Handler, auth = true) => this.add('DELETE', p, h, auth);
  match(method: string, path: string) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = path.match(r.re);
      if (m) {
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return { route: r, params };
      }
    }
    return null;
  }
}

// ───────── Validation ─────────
type Rule = { type: 'string' | 'int' | 'money' | 'enum' | 'date' | 'time' | 'bool' | 'email' | 'array'; required?: boolean; max?: number; min?: number; values?: readonly string[] };

export function validate<T extends Record<string, Rule>>(input: any, schema: T, partial = false): Record<keyof T, any> {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'invalid_body');
  const out: any = {};
  const errors: Record<string, string> = {};
  for (const [k, r] of Object.entries(schema)) {
    let v = input[k];
    if (v === undefined || v === null || v === '') {
      if (r.required && !partial) errors[k] = 'required';
      else if (k in input) out[k] = null;
      continue;
    }
    switch (r.type) {
      case 'string':
        if (typeof v !== 'string') { errors[k] = 'string'; break; }
        v = v.trim();
        if (v.length > (r.max ?? 2000)) { errors[k] = 'too_long'; break; }
        out[k] = v; break;
      case 'email':
        if (typeof v !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || v.length > 254) { errors[k] = 'email'; break; }
        out[k] = v.trim().toLowerCase(); break;
      case 'int':
        if (!Number.isInteger(v) || (r.min !== undefined && v < r.min) || (r.max !== undefined && v > r.max)) { errors[k] = 'int'; break; }
        out[k] = v; break;
      case 'money':
        try { out[k] = parseMoney(v); if (out[k] < (r.min ?? 0)) errors[k] = 'min'; } catch { errors[k] = 'money'; }
        break;
      case 'enum':
        if (!r.values!.includes(v)) { errors[k] = 'enum'; break; }
        out[k] = v; break;
      case 'date':
        if (typeof v !== 'string' || !isValidDate(v)) { errors[k] = 'date'; break; }
        out[k] = v; break;
      case 'time':
        if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) { errors[k] = 'time'; break; }
        out[k] = v; break;
      case 'bool':
        out[k] = v === true || v === 1 || v === 'true' ? 1 : 0; break;
      case 'array':
        if (!Array.isArray(v)) { errors[k] = 'array'; break; }
        out[k] = v; break;
    }
  }
  if (Object.keys(errors).length) throw new HttpError(422, 'validation_error', errors);
  return out;
}

export function isValidDate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ───────── Money: integer cents only, no floating point ─────────
// Accepts integer cents (number) or decimal strings like "180", "180.5", "180.50".
export function parseMoney(v: unknown): number {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('money must be integer cents');
    return v;
  }
  if (typeof v !== 'string' || !/^-?\d{1,12}(\.\d{1,2})?$/.test(v.trim())) throw new Error('bad money');
  const s = v.trim();
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const cents = parseInt(i, 10) * 100 + parseInt((f + '00').slice(0, 2), 10);
  return neg ? -cents : cents;
}
export function formatMoney(cents: number) {
  const neg = cents < 0; const a = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
/** rate per hour (cents) × minutes → cents, half-up, integer math only */
export function hourlyAmount(rateCents: number, minutes: number) {
  return Math.floor((rateCents * minutes + 30) / 60);
}
/** integer division a/b rounded half-up (b>0) */
export function divRound(a: number, b: number) { if (b <= 0) return 0; const s = a < 0 ? -1 : 1; return s * Math.floor((Math.abs(a) * 2 + b) / (2 * b)); }
/** a/b as basis points (1% = 100), integer math, half-up */
export function ratioBps(a: number, b: number) {
  if (b === 0) return null;
  const sign = (a < 0) !== (b < 0) ? -1 : 1;
  return sign * Math.floor((Math.abs(a) * 10000 * 2 + Math.abs(b)) / (2 * Math.abs(b)));
}

export function assertCurrency(currency: string | null | undefined, companyCurrency: string) {
  if (currency && currency !== companyCurrency)
    throw new HttpError(422, 'currency_mismatch', { expected: companyCurrency });
  return companyCurrency;
}

export function page(q: URLSearchParams) {
  const limit = Math.min(Math.max(parseInt(q.get('limit') || '50', 10) || 50, 1), 200);
  const offset = Math.max(parseInt(q.get('offset') || '0', 10) || 0, 0);
  return { limit, offset };
}

/** Escape LIKE wildcards; parameters are always bound (no SQL string concatenation of user input). */
export const likeParam = (s: string) => '%' + s.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
