// Pure recurrence engine (dates are company-local YYYY-MM-DD strings; computed in UTC to avoid DST drift).

export interface RuleSpec {
  frequency: 'once' | 'daily' | 'weekly' | 'twice_weekly' | 'biweekly' | 'triweekly' | 'monthly' | 'bimonthly' | 'custom';
  interval_days?: number | null;
  weekdays?: string | null;      // "1,4"
  start_date: string;
  end_date?: string | null;
  paused_from?: string | null;
  paused_until?: string | null;
  exceptions?: string | null;    // "2026-12-25,2027-01-01"
}

const D = (s: string) => new Date(s + 'T00:00:00Z');
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 864e5);

function parseWeekdays(r: RuleSpec): number[] {
  const list = (r.weekdays || '').split(',').map((x) => parseInt(x, 10)).filter((x) => x >= 0 && x <= 6);
  return list.length ? [...new Set(list)].sort() : [D(r.start_date).getUTCDay()];
}

/** All occurrence dates in [from, to] (inclusive) for the rule. Deterministic, duplicate-free. */
export function occurrences(r: RuleSpec, from: string, to: string): string[] {
  const start = D(r.start_date);
  const lo = D(from) > start ? D(from) : start;
  let hi = D(to);
  if (r.end_date && D(r.end_date) < hi) hi = D(r.end_date);
  if (lo > hi) return [];
  const skip = new Set((r.exceptions || '').split(',').map((s) => s.trim()).filter(Boolean));
  const paused = (d: string) => !!r.paused_from && d >= r.paused_from && (!r.paused_until || d <= r.paused_until);
  const out: string[] = [];
  const push = (d: Date) => { const s = iso(d); if (d >= lo && d <= hi && !skip.has(s) && !paused(s)) out.push(s); };

  switch (r.frequency) {
    case 'once': push(start); break;
    case 'daily': for (let d = lo; d <= hi; d = addDays(d, 1)) push(d); break;
    case 'custom': {
      const step = Math.max(1, r.interval_days || 1);
      const k = Math.ceil(Math.max(0, daysBetween(start, lo)) / step);
      for (let d = addDays(start, k * step); d <= hi; d = addDays(d, step)) push(d);
      break;
    }
    case 'weekly': case 'twice_weekly': case 'biweekly': case 'triweekly': {
      const weeks = r.frequency === 'biweekly' ? 2 : r.frequency === 'triweekly' ? 3 : 1;
      const wds = parseWeekdays(r);
      const anchorWeek = addDays(start, -start.getUTCDay()); // Sunday of the start week
      for (let d = lo; d <= hi; d = addDays(d, 1)) {
        if (!wds.includes(d.getUTCDay())) continue;
        const wk = Math.floor(daysBetween(anchorWeek, d) / 7);
        if (wk % weeks === 0) push(d);
      }
      break;
    }
    case 'monthly': case 'bimonthly': {
      const step = r.frequency === 'bimonthly' ? 2 : 1;
      const dom = start.getUTCDate();
      for (let i = 0; ; i += step) {
        const y = start.getUTCFullYear(), m = start.getUTCMonth() + i;
        const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const d = new Date(Date.UTC(y, m, Math.min(dom, last))); // clamp e.g. 31st → 30th/28th
        if (d > hi) break;
        push(d);
      }
      break;
    }
  }
  return out;
}

export const minutesOf = (hhmm: string) => parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10);
export const overlaps = (aStart: string, aDur: number, bStart: string, bDur: number) => {
  const a = minutesOf(aStart), b = minutesOf(bStart);
  return a < b + bDur && b < a + aDur;
};
