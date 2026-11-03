import { describe, expect, it } from 'vitest';
import { divRound, formatMoney, hourlyAmount, parseMoney, ratioBps } from '../worker/src/lib/core';
import { occurrences, overlaps } from '../worker/src/lib/recurrence';
import { toCsv } from '../worker/src/modules/reports';

describe('money (integer cents, no floating point)', () => {
  it('parses decimal strings exactly', () => {
    expect(parseMoney('180')).toBe(18000);
    expect(parseMoney('0.1')).toBe(10);
    expect(parseMoney('19.99')).toBe(1999);
    expect(parseMoney('-5.05')).toBe(-505);
    expect(parseMoney(1999)).toBe(1999);
  });
  it('rejects floats and malformed input', () => {
    expect(() => parseMoney(0.1)).toThrow();
    expect(() => parseMoney('1.234')).toThrow();
    expect(() => parseMoney('1e3')).toThrow();
    expect(() => parseMoney('abc')).toThrow();
  });
  it('classic float trap 0.1+0.2 is exact in cents', () => {
    expect(parseMoney('0.10') + parseMoney('0.20')).toBe(parseMoney('0.30'));
  });
  it('formats and computes hourly amounts half-up', () => {
    expect(formatMoney(18000)).toBe('180.00');
    expect(formatMoney(-505)).toBe('-5.05');
    expect(hourlyAmount(2500, 150)).toBe(6250);   // $25/h × 2.5h
    expect(hourlyAmount(1999, 61)).toBe(2032);    // 2032.32 → 2032
    expect(divRound(10, 4)).toBe(3);               // 2.5 → 3
    expect(ratioBps(3000, 18000)).toBe(1667);      // 16.67%
    expect(ratioBps(1, 0)).toBeNull();
  });
});

describe('recurrence engine', () => {
  it('weekly on Mondays', () => {
    expect(occurrences({ frequency: 'weekly', weekdays: '1', start_date: '2026-11-02' }, '2026-11-01', '2026-11-30'))
      .toEqual(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);
  });
  it('twice per week, biweekly, triweekly', () => {
    expect(occurrences({ frequency: 'twice_weekly', weekdays: '2,5', start_date: '2026-11-03' }, '2026-11-03', '2026-11-14'))
      .toEqual(['2026-11-03', '2026-11-06', '2026-11-10', '2026-11-13']);
    expect(occurrences({ frequency: 'biweekly', weekdays: '1', start_date: '2026-11-02' }, '2026-11-01', '2026-12-01'))
      .toEqual(['2026-11-02', '2026-11-16', '2026-11-30']);
    expect(occurrences({ frequency: 'triweekly', weekdays: '1', start_date: '2026-11-02' }, '2026-11-01', '2026-12-31'))
      .toEqual(['2026-11-02', '2026-11-23', '2026-12-14']);
  });
  it('monthly clamps the 31st; bimonthly; custom interval; daily', () => {
    expect(occurrences({ frequency: 'monthly', start_date: '2026-01-31' }, '2026-01-01', '2026-04-30'))
      .toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(occurrences({ frequency: 'bimonthly', start_date: '2026-01-15' }, '2026-01-01', '2026-06-30'))
      .toEqual(['2026-01-15', '2026-03-15', '2026-05-15']);
    expect(occurrences({ frequency: 'custom', interval_days: 10, start_date: '2026-11-01' }, '2026-11-05', '2026-11-30'))
      .toEqual(['2026-11-11', '2026-11-21']);
    expect(occurrences({ frequency: 'daily', start_date: '2026-11-01' }, '2026-11-01', '2026-11-03')).toHaveLength(3);
  });
  it('respects end date, exceptions (holidays) and pauses; one-time', () => {
    const r = { frequency: 'weekly' as const, weekdays: '4', start_date: '2026-11-05', end_date: '2026-12-31', exceptions: '2026-11-26', paused_from: '2026-12-10', paused_until: '2026-12-20' };
    expect(occurrences(r, '2026-11-01', '2027-02-01')).toEqual(['2026-11-05', '2026-11-12', '2026-11-19', '2026-12-03', '2026-12-24', '2026-12-31']);
    expect(occurrences({ frequency: 'once', start_date: '2026-11-10' }, '2026-11-01', '2026-12-01')).toEqual(['2026-11-10']);
  });
  it('is duplicate-free and deterministic', () => {
    const r = { frequency: 'twice_weekly' as const, weekdays: '1,1,3', start_date: '2026-11-02' };
    const a = occurrences(r, '2026-11-01', '2027-01-31');
    expect(new Set(a).size).toBe(a.length);
    expect(occurrences(r, '2026-11-01', '2027-01-31')).toEqual(a);
  });
  it('detects time overlaps', () => {
    expect(overlaps('09:00', 120, '10:30', 60)).toBe(true);
    expect(overlaps('09:00', 120, '11:00', 60)).toBe(false);
  });
});

describe('CSV export', () => {
  it('neutralizes formula injection and quotes', () => {
    const csv = toCsv([{ name: '=HYPERLINK("x")', amount: -500 }], ['amount']);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('-5.00');
  });
});
