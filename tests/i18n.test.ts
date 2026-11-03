import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { DICT } from '../web/src/i18n';

// Every literal UI string passed to t(), used as a form label or submit label must have PT and ES translations.
describe('i18n coverage', () => {
  it('has Portuguese and Spanish for every UI string', () => {
    const dir = new URL('../web/src/', import.meta.url);
    const files = ['ui.tsx', 'main.tsx', ...readdirSync(new URL('pages/', dir)).map((f) => 'pages/' + f)];
    const keys = new Set<string>();
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)+)'/g)) keys.add(m[1]);
      for (const m of src.matchAll(/label: '([^']+)'/g)) keys.add(m[1]);
      for (const m of src.matchAll(/submitLabel="([^"]+)"/g)) keys.add(m[1]);
    }
    const ignore = /^(English|Español|Português|WhatsApp|DRE|Zelle|[a-z_]+|freq_|ptype_|cat_|pm_|wd_|period_|view_|basis_|role_|[^A-Za-z]*)$/;
    const missing = [...keys].filter((k) => !ignore.test(k) && (!DICT.pt[k] || !DICT.es[k]));
    expect(missing).toEqual([]);
  });
});
