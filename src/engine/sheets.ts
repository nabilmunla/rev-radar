// Spreadsheets read for the BOQ comparison: .xlsx (zip of XML) and the old .xls (BIFF8 in an OLE
// compound file) - values only (a formula's last calculated value), with hidden rows, columns and
// sheets marked. Our own small readers: the npm SheetJS is years old with known holes in reading
// crafted files, and there is nothing to run here but reading cells. Pure: tests/sheets.test.ts.
import { unzipSync, strFromU8 } from 'fflate';

export type Val = string | number | boolean | null;
export interface SheetRow {
  r: number; hidden: boolean; c: Val[]; /** read from a scan (OCR) */ ocr?: boolean; /** a PDF's page (0-based) the row is on */ pg?: number;
  /** a PDF's row: where it is on its page (points, top-down) - x0, y0, x1, y1, then each cell's x0, x1 (NaN: empty) */
  bx?: number[];
}
export interface Sheet { name: string; hidden: boolean; rows: SheetRow[]; hiddenCols: number[] }
export interface Book { sheets: Sheet[] }

/** a workbook from its bytes (.xlsx / .xlsm / .xls - told by what the bytes are, not the name) */
export function readBook(b: Uint8Array): Book {
  if (b[0] === 0x50 && b[1] === 0x4b) return readXlsx(b);
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return readXls(b);
  throw new Error('Not an Excel workbook (.xlsx or .xls)');
}

// ---------------------------------------------------------------- .xlsx

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unxml(s: string): string {
  if (s.indexOf('&') >= 0) s = s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m));
  // (Excel writes control characters as _xHHHH_)
  if (s.indexOf('_x') >= 0) s = s.replace(/_x([0-9A-F]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return s;
}
function attrs(s: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:]+)\s*=\s*"([^"]*)"|([\w:]+)\s*=\s*'([^']*)'/g)) o[(m[1] ?? m[3]).replace(/^\w+:/, (p) => (p === 'r:' ? 'r:' : ''))] = unxml(m[2] ?? m[4]);
  return o;
}
/** the text of a string item: its <t> runs, not the phonetic guide (<rPh>) */
function itemText(x: string): string {
  x = x.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let t = '';
  // (a self-closed <t/> first: read the other way round it swallowed what came after it)
  for (const m of x.matchAll(/<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g)) t += m[1] ? unxml(m[1]) : '';
  return t;
}
const colOf = (ref: string): number => { let n = 0; for (let i = 0; i < ref.length; i++) { const c = ref.charCodeAt(i); if (c < 65 || c > 90) break; n = n * 26 + c - 64; } return n - 1; };

function readXlsx(b: Uint8Array): Book {
  const files = unzipSync(b, { filter: (f) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/i.test(f.name) });
  const get = (n: string) => { const k = Object.keys(files).find((f) => f.toLowerCase() === n.toLowerCase()); return k ? strFromU8(files[k]) : ''; };
  const wb = get('xl/workbook.xml');
  if (!wb) throw new Error('Not an Excel workbook (no workbook part)');
  const rels: Record<string, string> = {};
  for (const m of get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)) { const a = attrs(m[1]); if (a.Id) rels[a.Id] = a.Target; }
  const sst: string[] = [];
  // (an empty <si/> first - else it took the next string and every one after it moved up by one)
  for (const m of get('xl/sharedStrings.xml').matchAll(/<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g)) sst.push(m[1] ? itemText(m[1]) : '');
  const sheets: Sheet[] = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    let target = rels[a['r:id']] || '';
    if (!target) continue;
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const xml = get(target);
    if (!xml && !/worksheets\//i.test(target)) continue; // (a chart sheet: no cells)
    sheets.push(readSheetXml(a.name || '', !!a.state && a.state !== 'visible', xml, sst));
  }
  return { sheets };
}

function readSheetXml(name: string, hidden: boolean, xml: string, sst: string[]): Sheet {
  const hiddenCols: number[] = [];
  for (const m of xml.matchAll(/<col\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.hidden === '1' || a.hidden === 'true') for (let c = Number(a.min) - 1; c <= Number(a.max) - 1 && c < 16384; c++) hiddenCols.push(c);
  }
  const rows: SheetRow[] = [];
  let next = 0;
  for (const m of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const a = attrs(m[1]);
    const r = a.r ? Number(a.r) - 1 : next;
    next = r + 1;
    const c: Val[] = [];
    let col = 0;
    if (m[2]) for (const cm of m[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = attrs(cm[1]);
      col = ca.r ? colOf(ca.r) : col;
      const body = cm[2] || '';
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val: Val = null;
      switch (ca.t) {
        case 's': val = v != null ? sst[Number(v)] ?? '' : null; break;
        case 'inlineStr': val = itemText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] || ''); break;
        case 'str': val = v != null ? unxml(v) : null; break;
        case 'b': val = v === '1'; break;
        case 'e': val = v != null ? '#' + unxml(v).replace(/^#/, '') : null; break;
        default: val = v != null && v !== '' ? Number(v) : null;
      }
      if (val !== null && val !== '') { while (c.length < col) c.push(null); c[col] = val; }
      col++;
    }
    rows.push({ r, hidden: a.hidden === '1' || a.hidden === 'true', c });
  }
  return { name, hidden, rows, hiddenCols };
}

// ---------------------------------------------------------------- .xls (BIFF8)

/** the "Workbook" stream of an OLE compound file */
function cfbStream(b: Uint8Array, want: RegExp): Uint8Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u32 = (o: number) => dv.getUint32(o, true);
  const shift = dv.getUint16(0x1e, true), sz = 1 << shift, mshift = dv.getUint16(0x20, true), msz = 1 << mshift;
  const cutoff = u32(0x38);
  const sec = (id: number) => (id + 1) * sz;
  // the FAT, from the header's DIFAT entries and the DIFAT chain
  const fatSecs: number[] = [];
  for (let i = 0; i < 109; i++) { const s = u32(0x4c + i * 4); if (s < 0xfffffffa) fatSecs.push(s); }
  for (let d = u32(0x44), n = 0; d < 0xfffffffa && n < u32(0x48) + 1 && sec(d) + sz <= b.length; n++) {
    for (let i = 0; i < sz / 4 - 1; i++) { const s = u32(sec(d) + i * 4); if (s < 0xfffffffa) fatSecs.push(s); }
    d = u32(sec(d) + sz - 4);
  }
  const fat: number[] = [];
  for (const s of fatSecs) for (let i = 0; i < sz / 4 && sec(s) + i * 4 + 4 <= b.length; i++) fat.push(u32(sec(s) + i * 4));
  const chain = (start: number, table: number[]) => { const out: number[] = []; for (let s = start, n = 0; s < 0xfffffffa && n <= table.length; n++) { out.push(s); s = table[s] ?? 0xfffffffe; } return out; };
  const read = (start: number, size: number) => {
    const out = new Uint8Array(size);
    let at = 0;
    for (const s of chain(start, fat)) { if (at >= size) break; const n = Math.min(sz, size - at); out.set(b.subarray(sec(s), sec(s) + n), at); at += n; }
    if (at < size) throw new Error('The workbook file is cut short');
    return out;
  };
  // the directory
  const dirStart = u32(0x30);
  const dir = (() => { const ids = chain(dirStart, fat); const out = new Uint8Array(ids.length * sz); ids.forEach((s, i) => out.set(b.subarray(sec(s), sec(s) + sz), i * sz)); return out; })();
  const dd = new DataView(dir.buffer);
  type Entry = { name: string; type: number; start: number; size: number };
  const entries: Entry[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nl = dd.getUint16(o + 0x40, true);
    let name = '';
    for (let i = 0; i + 2 < nl; i += 2) name += String.fromCharCode(dd.getUint16(o + i, true));
    entries.push({ name, type: dir[o + 0x42], start: dd.getUint32(o + 0x74, true), size: dd.getUint32(o + 0x78, true) });
  }
  const e = entries.find((x) => x.type === 2 && want.test(x.name));
  if (!e) throw new Error('Not an Excel workbook (no Workbook stream)');
  if (e.size >= cutoff) return read(e.start, e.size);
  // a small stream: in the mini stream (held by the root entry)
  const root = entries.find((x) => x.type === 5)!;
  const mini = read(root.start, root.size);
  const mfat: number[] = [];
  const mf = read(u32(0x3c), u32(0x40) * sz);
  for (let i = 0; i + 4 <= mf.length; i += 4) mfat.push(new DataView(mf.buffer).getUint32(i, true));
  const out = new Uint8Array(e.size);
  let at = 0;
  for (const s of chain(e.start, mfat)) { if (at >= e.size) break; const n = Math.min(msz, e.size - at); out.set(mini.subarray(s * msz, s * msz + n), at); at += n; }
  return out;
}

function readXls(b: Uint8Array): Book {
  const w = cfbStream(b, /^(Workbook|Book)$/i);
  const dv = new DataView(w.buffer, w.byteOffset, w.byteLength);
  // records, CONTINUEs joined to the record before (with where each piece starts: a string carried
  // over a CONTINUE starts that piece with a fresh options byte)
  interface Rec { t: number; d: Uint8Array; cuts: number[] }
  const recAt = (o: number): [Rec, number] => {
    const t = dv.getUint16(o, true), l = dv.getUint16(o + 2, true);
    let d = w.subarray(o + 4, o + 4 + l);
    const cuts: number[] = [];
    let p = o + 4 + l;
    while (p + 4 <= w.length && dv.getUint16(p, true) === 0x3c && (t === 0xfc || t === 0x207 || t === 0x204)) {
      const cl = dv.getUint16(p + 2, true);
      cuts.push(d.length);
      const nd = new Uint8Array(d.length + cl); nd.set(d); nd.set(w.subarray(p + 4, p + 4 + cl), d.length); d = nd;
      p += 4 + cl;
    }
    return [{ t, d, cuts }, p];
  };
  if (w.length < 4 || dv.getUint16(0, true) !== 0x809) throw new Error('Not an Excel 97-2003 workbook');
  // a Unicode string at o in a record: [text, end]
  const ustr = (r: Rec, o: number, cch: number, flagsAt: number): [string, number] => {
    const d = r.d;
    const flags = d[flagsAt];
    o = flagsAt + 1;
    let rich = 0, ext = 0;
    if (flags & 8) { rich = d[o] | (d[o + 1] << 8); o += 2; }
    if (flags & 4) { ext = d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24); o += 4; }
    let s = '';
    let left = cch, wide = flags & 1;
    let ci = r.cuts.findIndex((c) => c >= o);
    // (the characters start right at a CONTINUE: it opens with its own options byte)
    if (left > 0 && ci >= 0 && r.cuts[ci] === o) { wide = d[o] & 1; o++; ci = ci + 1 < r.cuts.length ? ci + 1 : -1; }
    while (left > 0) {
      const end = ci >= 0 ? r.cuts[ci] : d.length;
      const fit = Math.min(left, Math.floor((end - o) / (wide ? 2 : 1)));
      for (let i = 0; i < fit; i++) s += String.fromCharCode(wide ? d[o + 2 * i] | (d[o + 2 * i + 1] << 8) : d[o + i]);
      o += fit * (wide ? 2 : 1); left -= fit;
      if (left > 0) { if (ci < 0 || o !== end) break; wide = d[o] & 1; o++; ci = ci + 1 < r.cuts.length ? ci + 1 : -1; }
    }
    return [s, o + rich * 4 + ext];
  };
  // the workbook globals: sheets and shared strings
  const bound: { pos: number; name: string; hidden: boolean }[] = [];
  const sst: string[] = [];
  let p = 0;
  for (;;) {
    if (p + 4 > w.length) break;
    const [r, np] = recAt(p);
    p = np;
    if (r.t === 0x2f) throw new Error('The workbook is password-protected (encrypted) - open it in Excel and save a copy without the password');
    if (r.t === 0x85 && r.d[5] === 0) {
      const cch = r.d[6], wide = r.d[7] & 1;
      let name = '';
      for (let i = 0; i < cch; i++) name += String.fromCharCode(wide ? r.d[8 + 2 * i] | (r.d[9 + 2 * i] << 8) : r.d[8 + i]);
      bound.push({ pos: new DataView(r.d.buffer, r.d.byteOffset).getUint32(0, true), name, hidden: r.d[4] !== 0 });
    } else if (r.t === 0xfc) {
      const n = new DataView(r.d.buffer, r.d.byteOffset).getUint32(4, true);
      let o = 8;
      for (let i = 0; i < n && o + 3 <= r.d.length; i++) {
        // (a string's header never splits over a CONTINUE; its characters may)
        const cch = r.d[o] | (r.d[o + 1] << 8);
        const [s, e] = ustr(r, o + 2, cch, o + 2);
        sst.push(s); o = e;
      }
    } else if (r.t === 0x0a) break;
  }
  const rk = (v: number) => {
    let x: number;
    if (v & 2) x = v >> 2;
    else { const t = new DataView(new ArrayBuffer(8)); t.setUint32(4, v & 0xfffffffc, true); t.setUint32(0, 0, true); x = t.getFloat64(0, true); }
    return v & 1 ? x / 100 : x;
  };
  const sheets: Sheet[] = [];
  for (const s of bound) {
    const rows = new Map<number, SheetRow>();
    const hiddenCols: number[] = [];
    const row = (r: number) => { let x = rows.get(r); if (!x) rows.set(r, (x = { r, hidden: false, c: [] })); return x; };
    const put = (r: number, c: number, v: Val) => { if (v === null || v === '') return; const x = row(r); while (x.c.length < c) x.c.push(null); x.c[c] = v; };
    let q = s.pos, pendingStr: [number, number] | null = null, depth = 0;
    while (q + 4 <= w.length) {
      const [r, nq] = recAt(q);
      q = nq;
      const d = r.d, rv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const u16 = (o: number) => rv.getUint16(o, true);
      if (r.t === 0x809) { depth++; continue; }
      if (r.t === 0x0a) { if (--depth <= 0) break; continue; }
      if (depth > 1) continue; // (a chart inside the sheet)
      switch (r.t) {
        case 0x208: if (u16(12) & 0x20) row(u16(0)).hidden = true; break;
        case 0x7d: if (u16(8) & 1) for (let c = u16(0); c <= u16(2) && c < 256; c++) hiddenCols.push(c); break;
        case 0xfd: put(u16(0), u16(2), sst[rv.getUint32(6, true)] ?? ''); break;
        case 0x204: put(u16(0), u16(2), ustr(r, 8, u16(6), 8)[0]); break;
        case 0x203: put(u16(0), u16(2), rv.getFloat64(6, true)); break;
        case 0x27e: put(u16(0), u16(2), rk(rv.getUint32(6, true))); break;
        case 0xbd: { const rr = u16(0), c0 = u16(2), c1 = u16(d.length - 2); for (let c = c0; c <= c1; c++) put(rr, c, rk(rv.getUint32(4 + (c - c0) * 6 + 2, true))); break; }
        case 0x205: put(u16(0), u16(2), d[7] ? null : !!d[6]); break;
        case 0x06: {
          if (u16(12) === 0xffff) {
            const k = d[6];
            if (k === 0) pendingStr = [u16(0), u16(2)];
            else if (k === 1) put(u16(0), u16(2), !!d[8]);
          } else put(u16(0), u16(2), rv.getFloat64(6, true));
          break;
        }
        case 0x207: if (pendingStr) { put(pendingStr[0], pendingStr[1], ustr(r, 2, u16(0), 2)[0]); pendingStr = null; } break;
      }
    }
    sheets.push({ name: s.name, hidden: s.hidden, rows: [...rows.values()].sort((a, b2) => a.r - b2.r), hiddenCols });
  }
  return { sheets };
}
