// Dependency-free XLSX and PDF writers for report exports (Workers-compatible, no Node APIs).
import { formatMoney } from './core';

const enc = new TextEncoder();

// ───────── ZIP (stored, no compression) + CRC32 ─────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b: Uint8Array) { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zip(files: { name: string; data: Uint8Array }[]) {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, 0, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = (i: number) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

/** Builds an .xlsx. Money columns (integer cents) are written as exact decimal numbers with a currency format. */
export function toXlsx(rows: Record<string, unknown>[], moneyCols: string[], sheetName = 'Report') {
  const cols = rows.length ? Object.keys(rows[0]) : ['(empty)'];
  const cell = (r: number, c: number, v: unknown, k: string) => {
    const ref = `${colName(c)}${r}`;
    if (moneyCols.includes(k) && typeof v === 'number') return `<c r="${ref}" s="1"><v>${formatMoney(v)}</v></c>`;
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    if (v === null || v === undefined || v === '') return '';
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
  };
  const header = `<row r="1">${cols.map((k, i) => `<c r="${colName(i)}1" t="inlineStr" s="2"><is><t>${xml(k)}</t></is></c>`).join('')}</row>`;
  const body = rows.map((row, ri) => `<row r="${ri + 2}">${cols.map((k, ci) => cell(ri + 2, ci, row[k], k)).join('')}</row>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${header}${body}</sheetData></worksheet>`;
  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00;[Red]\\-&quot;$&quot;#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf numFmtId="164" applyNumberFormat="1"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': sheet,
  };
  return zip(Object.entries(files).map(([name, s]) => ({ name, data: enc.encode(s) })));
}

// ───────── PDF (Helvetica, landscape Letter, paginated table) ─────────
const WIN = (s: string) => s.normalize('NFC').replace(/[^\x20-\x7e -ÿ]/g, (c) => ({ '—': '-', '–': '-', '→': '->', '’': "'", '“': '"', '”': '"', '…': '...', '·': '-' }[c] ?? '?'));
const pdfStr = (s: string) => '(' + WIN(s).replace(/[\\()]/g, (m) => '\\' + m) + ')';
const latin1 = (s: string) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };

export function toPdf(title: string, subtitle: string, rows: Record<string, unknown>[], moneyCols: string[], footer: string) {
  const W = 792, H = 612, M = 36, LINE = 13, FS = 8;
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const fmt = (k: string, v: unknown) => (v === null || v === undefined ? '' : moneyCols.includes(k) && typeof v === 'number' ? '$' + formatMoney(v) : String(v));
  // column widths proportional to content length (capped)
  const len = cols.map((k) => Math.min(40, Math.max(k.length, ...rows.slice(0, 200).map((r) => fmt(k, r[k]).length))));
  const total = len.reduce((a, b) => a + b, 0) || 1;
  const widths = len.map((l) => ((W - 2 * M) * l) / total);
  const maxChars = widths.map((w) => Math.max(3, Math.floor(w / (FS * 0.5))));
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '.' : s);
  const pages: string[] = [];
  let ops = '', y = 0, pageNo = 0;
  const text = (x: number, yy: number, s: string, size = FS, bold = false) => { ops += `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td ${pdfStr(s)} Tj ET\n`; };
  const newPage = () => {
    if (ops) pages.push(ops);
    ops = ''; pageNo++; y = H - M;
    text(M, y, title, 14, true); y -= 16;
    text(M, y, subtitle, 9); y -= 18;
    let x = M; cols.forEach((k, i) => { text(x, y, clip(k, maxChars[i]), FS, true); x += widths[i]; });
    ops += `0.6 w ${M} ${y - 4} m ${W - M} ${y - 4} l S\n`; y -= LINE + 2;
  };
  newPage();
  if (!rows.length) text(M, y, '(no data)');
  for (const r of rows) {
    if (y < M + 30) { text(M, M - 10, `${footer}   -   page ${pageNo}`, 7); newPage(); }
    let x = M;
    cols.forEach((k, i) => { const s = clip(fmt(k, r[k]), maxChars[i]); const right = moneyCols.includes(k) || typeof r[k] === 'number'; text(right ? x + widths[i] - s.length * FS * 0.5 - 4 : x, y, s); x += widths[i]; });
    y -= LINE;
  }
  text(M, M - 10, `${footer}   -   page ${pageNo}`, 7);
  pages.push(ops);

  const objs: string[] = [];
  const add = (s: string) => (objs.push(s), objs.length);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // pages placeholder
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const p of pages) {
    const content = add(`<< /Length ${latin1(p).length} >>\nstream\n${p}endstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(out);
}
