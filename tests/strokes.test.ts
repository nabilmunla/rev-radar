// Merged strokes draw the same as the original strokes (PDFium, the engine's renderer), including
// the awkward cases: clips, state changes inside a path, dots, dashes, paths that don't start with
// m, fills between strokes, text and inline pictures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as pf from '../src/engine/pdfium';
import { mergeStrokes } from '../src/engine/strokes';

const W = 1900, H = 1000;
const wasm = fs.readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
const ready = pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);

/** many little strokes all over (enough to be merged and grouped), then the case */
function filler(seed = 1): string {
  let s = seed;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const out: string[] = ['q 0 0 0 RG 0.5 w'];
  for (let i = 0; i < 20000; i++) { const x = 20 + r() * 1400, y = 20 + r() * 960, a = r() * 6.283; out.push(`${x.toFixed(2)} ${y.toFixed(2)} m ${(x + 3 * Math.cos(a)).toFixed(2)} ${(y + 3 * Math.sin(a)).toFixed(2)} l S`); }
  out.push('Q');
  return out.join('\n') + '\n';
}
function pdf(content: Uint8Array | string): Uint8Array {
  const c = zlib.deflateSync(typeof content === 'string' ? Buffer.from(content, 'latin1') : Buffer.from(content));
  const objs = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`),
    Buffer.concat([Buffer.from(`<< /Length ${c.length} /Filter /FlateDecode >>\nstream\n`), c, Buffer.from('\nendstream')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')];
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')];
  let at = parts[0].length;
  const offs: number[] = [];
  objs.forEach((o, k) => { offs.push(at); const b = Buffer.concat([Buffer.from(`${k + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]); parts.push(b); at += b.length; });
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}
let seq = 0;
function render(doc: Uint8Array, dpi: number) {
  const id = 'd' + ++seq;
  pf.openDoc(id, doc);
  try { const k = dpi / 72; return pf.renderGray(id, 0, [k, 0, 0, k, 0, 0], Math.round(W * k), Math.round(H * k)); } finally { pf.closeDoc(id); }
}
/** pixels that differ clearly (more than anti-aliasing) */
function differ(a: { w: number; px: Uint8Array }, b: { px: Uint8Array }, fromX = 0) { let n = 0; for (let i = 0; i < a.px.length; i++) if (i % a.w >= fromX && Math.abs(a.px[i] - b.px[i]) > 48) n++; return n; }

const cases: Record<string, string> = {
  'plain': '',
  'W S (clip + stroke)': 'q 1 0 0 RG 6 w 1600 850 200 100 re W S 0 1 0 rg 1500 800 400 200 re f Q',
  'colour inside path': 'q 6 w 1600 950 m 1850 950 l 1 0 0 RG S Q',
  'width inside path': 'q 1 0 0 RG 1600 950 m 1850 950 l 8 w S Q',
  'm S dots, round caps': 'q 1 J 12 w 1 0 0 RG 1650 900 m S 1700 900 m S 1750 900 m S 1800 900 m S Q',
  'm l S dots, round caps': 'q 1 J 12 w 1 0 0 RG 1650 900 m 1650 900 l S 1700 900 m 1700 900 l S 1750 900 m 1750 900 l S Q',
  'path without m': 'q 4 w 1 0 0 RG 1600 900 m 1700 900 l 1700 950 l h S 1850 990 l 1880 960 l S Q',
  'dash + phase': 'q 3 w 1 0 0 RG [12 7] 5 d 1600 900 m 1890 900 l S 1600 920 m 1890 925 l S 1600 940 m 1700 960 l 1890 940 l S Q',
  'closed subpaths, square caps': 'q 2 J 5 w 1 0 0 RG 1600 850 m 1650 850 l 1650 900 l h S 1700 850 m 1750 850 l 1750 900 l h S Q',
  'fill between strokes': 'q 1 0 0 rg 1500 100 m 1700 100 l 1700 300 l h f 1450 50 m 1750 350 l S 0 0 1 rg 1520 120 100 100 re f Q',
  'text between strokes': 'q 1500 600 m 1800 600 l S BT /F1 30 Tf 1500 620 Td (4200 MM) Tj ET 1500 660 m 1800 660 l S Q',
  'curves': 'q 2 w 1500 400 m 1600 500 1700 300 1800 400 c S 1500 450 m 1600 550 1800 450 v S Q',
};

test('merged strokes draw the same (PDFium, 150 and 300 dpi)', async () => {
  await ready;
  for (const [name, extra] of Object.entries(cases)) {
    const src = filler(name.length) + extra + '\n';
    const r = mergeStrokes(new TextEncoder().encode(src), 1000);
    assert.ok(r, name + ': merged');
    assert.ok(r!.strokesOut * 4 <= r!.strokesIn, name);
    for (const dpi of [150, 300]) {
      const a = render(pdf(src), dpi), b = render(pdf(r!.out), dpi);
      // the case itself (right of the filler): the same; the filler: a few anti-aliasing pixels at
      // most (strokes touching inside one merged path are anti-aliased once)
      const k = dpi / 72, dCase = differ(a, b, Math.round(1440 * k)), dAll = differ(a, b);
      console.log(`${name} @${dpi}: case ${dCase}, all ${dAll}`);
      assert.equal(dCase, 0, `${name} at ${dpi} dpi: ${dCase} pixels of the case differ`);
      assert.ok(dAll <= 12, `${name} at ${dpi} dpi: ${dAll} pixels differ`);
    }
  }
});

test('pages of ordinary size are left alone', () => {
  assert.equal(mergeStrokes(new TextEncoder().encode(filler(3))), null);
});
