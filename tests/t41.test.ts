// 0.6.1 T41 - DeepSeek 12, 13, 14 (DECISIONS 147; PLAN)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { readBook, dateSerial } from '../src/engine/sheets';
import { compareParas, type Para } from '../src/engine/docs';

// (a compound file: 512-byte sectors - FAT at 0, directory at 1, then the streams; `chains` - FAT next-sector links)
function cfb(opts: { stream: Uint8Array; mini: boolean }): Uint8Array {
  const sz = 512, END = 0xfffffffe, FREE = 0xffffffff;
  const { stream, mini } = opts;
  const fat = new Uint32Array(128).fill(FREE); fat[0] = 0xfffffffd; fat[1] = END;
  const secs: Uint8Array[] = [];
  let wbStart: number, rootStart = END, rootSize = 0, mfStart = END, mfCount = 0;
  if (!mini) {
    const n = Math.ceil(stream.length / sz); wbStart = 2;
    for (let i = 0; i < n; i++) { fat[2 + i] = i + 1 < n ? 3 + i : END; const s = new Uint8Array(sz); s.set(stream.subarray(i * sz, (i + 1) * sz)); secs.push(s); }
  } else {
    // (minifat at sector 2, the mini stream - held by the root entry - from 3)
    const ms = Math.ceil(stream.length / 64), mf = new Uint32Array(128).fill(FREE);
    for (let i = 0; i < ms; i++) mf[i] = i + 1 < ms ? i + 1 : END;
    fat[2] = END; mfStart = 2; mfCount = 1; secs.push(new Uint8Array(mf.buffer));
    const cont = new Uint8Array(Math.ceil((ms * 64) / sz) * sz); cont.set(stream);
    const n = cont.length / sz; rootStart = 3; rootSize = ms * 64;
    for (let i = 0; i < n; i++) { fat[3 + i] = i + 1 < n ? 4 + i : END; secs.push(cont.subarray(i * sz, (i + 1) * sz)); }
    wbStart = 0;
  }
  const dir = new Uint8Array(sz), dv = new DataView(dir.buffer);
  const ent = (k: number, name: string, type: number, start: number, size: number) => {
    for (let i = 0; i < name.length; i++) dv.setUint16(k * 128 + i * 2, name.charCodeAt(i), true);
    dv.setUint16(k * 128 + 0x40, (name.length + 1) * 2, true); dir[k * 128 + 0x42] = type;
    dv.setUint32(k * 128 + 0x74, start, true); dv.setUint32(k * 128 + 0x78, size, true);
  };
  ent(0, 'Root Entry', 5, rootStart, rootSize); ent(1, 'Workbook', 2, wbStart, stream.length);
  const h = new Uint8Array(sz), hv = new DataView(h.buffer);
  h.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  hv.setUint16(0x18, 0x3e, true); hv.setUint16(0x1a, 3, true); hv.setUint16(0x1c, 0xfffe, true); hv.setUint16(0x1e, 9, true); hv.setUint16(0x20, 6, true);
  hv.setUint32(0x2c, 1, true); hv.setUint32(0x30, 1, true); hv.setUint32(0x38, 4096, true); hv.setUint32(0x3c, mfStart, true); hv.setUint32(0x40, mfCount, true);
  hv.setUint32(0x44, END, true); hv.setUint32(0x48, 0, true);
  for (let i = 0; i < 109; i++) hv.setUint32(0x4c + i * 4, i ? FREE : 0, true);
  const all = [h, new Uint8Array(fat.buffer), dir, ...secs];
  const out = new Uint8Array(all.length * sz); all.forEach((s, i) => out.set(s, i * sz));
  return out;
}
const junk = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff);

test('T41 bug 12: a .xls cut at a sector boundary inside its Workbook stream - "cut short", not blank cells', () => {
  const f = cfb({ stream: junk(8 * 512), mini: false });
  const cut = f.subarray(0, 512 * 3 + 4 * 512); // header, FAT, directory, 4 of the 8 stream sectors
  assert.throws(() => readBook(cut), /cut short/);
});
test('T41 bug 12: a small .xls cut inside its mini stream - "cut short"', () => {
  const f = cfb({ stream: junk(1000), mini: true });
  const cut = f.subarray(0, 512 * 5); // header, FAT, directory, minifat, the first of the mini stream's two sectors
  assert.throws(() => readBook(cut), /cut short/);
});

const xlsx = (cells: string) => zipSync({
  'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'),
  'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
  'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`),
});
test('T41 bug 13: <c t="d"> reads 45306 for 2024-01-15 - equal to the same date stored as a serial; a time is a fraction', () => {
  const b = readBook(xlsx('<c r="A1" t="d"><v>2024-01-15T00:00:00Z</v></c><c r="B1"><v>45306</v></c><c r="C1" t="d"><v>2024-01-15T12:00:00</v></c><c r="D1" t="d"><v>2024-01-15</v></c>'));
  assert.deepEqual(b.sheets[0].rows[0].c, [45306, 45306, 45306.5, 45306]);
  assert.equal(dateSerial('1900-03-01'), 61);
});
test('T41 bug 13: no NaN from any cell - a date cell that is no date and a number cell that is no number stay text', () => {
  const b = readBook(xlsx('<c r="A1" t="d"><v>next week</v></c><c r="B1"><v>12abc</v></c><c r="C1" t="d"><v>2024-02-30</v></c><c r="D1" t="n"><v>3.5</v></c>'));
  const c = b.sheets[0].rows[0].c;
  assert.deepEqual(c, ['next week', '12abc', '2024-02-30', 3.5]);
  assert.ok(c.every((v) => !(typeof v === 'number' && Number.isNaN(v))));
});

test('T41 bug 14: 20,000 unpaired paragraphs of common words between kept headings - the moved search under 2 s', () => {
  // (a kept heading every 20 paragraphs: the gaps between are small, so the time is the moved search over the 20,000 left)
  const W = ['the', 'shall', 'be', 'of', 'and', 'to', 'in', 'contractor', 'works', 'all', 'with', 'as', 'for', 'by', 'specified', 'provide'];
  let s = 7; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const side = (file: string, tag: string) => {
    const out: Para[] = [];
    for (let k = 0; k < 1000; k++) {
      out.push({ i: out.length, file, page: k, num: '', head: '', text: 'Section heading ' + ['alpha', 'bravo', 'delta', 'kilo', 'lima'][k % 5] + ' part ' + k + ' of the works' });
      for (let q = 0; q < 20; q++) out.push({ i: out.length, file, page: k, num: '', head: '', text: Array.from({ length: 10 }, () => W[Math.floor(rnd() * W.length)]).join(' ') + ' ' + tag + ' ' + (k * 20 + q) });
    }
    return out;
  };
  const O = side('o', 'old'), N = side('n', 'new');
  const t = performance.now(); const r = compareParas(O, N); const ms = performance.now() - t;
  assert.ok(ms < 2000, Math.round(ms) + ' ms');
  assert.ok(r !== undefined);
});
