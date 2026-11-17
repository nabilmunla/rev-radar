// PLAN T2 (AUDIT A1-A4): hardening ported from the PDF Editor - the stray ")" that froze the stroke
// merge, a malloc answer of 0, openDoc / closeDoc bookkeeping, EngineClient.call when postMessage throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as pf from '../src/engine/pdfium';
import type { Reader } from '../src/engine/files';
import { EngineClient } from '../src/engine/rpc';

const wasm = fs.readFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);

// ------------------------------------------------------------------ (a) the stray ")"
test('T2a: a stray ")" in the content does not hang the merge (child process, killed at 5 s)', () => {
  const code = `
    const { mergeStrokes } = await import('./src/engine/strokes.ts');
    const line = (i) => i + ' 0 m ' + (i + 1) + ' 1 l S\\n';
    let s = ''; for (let i = 0; i < 20; i++) s += line(i);
    s += ') ';
    for (let i = 20; i < 40; i++) s += line(i);
    const t = Date.now();
    const r = mergeStrokes(new TextEncoder().encode(s), 1);
    console.log(JSON.stringify({ ms: Date.now() - t, strokesIn: r && r.strokesIn, strokesOut: r && r.strokesOut, stray: r ? Buffer.from(r.out).toString('latin1').includes(')') : null }));
  `;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8' });
  assert.equal(r.status, 0, 'the child finished (old code: killed at 5 s) ' + (r.error?.message ?? '') + r.stderr);
  const o = JSON.parse(r.stdout.trim().split('\n').pop()!);
  assert.ok(o.ms < 1000, o.ms + ' ms');
  assert.equal(o.strokesIn, 40);
  assert.equal(o.strokesOut, 1);
  assert.equal(o.stray, true, 'the stray byte is kept in the output, as it was');
});

// ------------------------------------------------------------------ helpers
function raw(objs: string[]): Uint8Array {
  let out = '%PDF-1.7\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array([...out].map((c) => c.charCodeAt(0) & 255));
}
const content = '<< /Length 17 >>\nstream\n0 0 m 10 10 l S \nendstream';
const page = (mb: string) => `<< /Type /Page /Parent 2 0 R /MediaBox ${mb} /Contents 6 0 R >>`;
/** three pages of different sizes: 300 x 400, 500 x 600, 700 x 800 */
const three = () => raw(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>', page('[0 0 300 400]'), page('[0 0 500 600]'), page('[0 0 700 800]'), content]);
const readerOf = (bytes: Uint8Array, onClose?: () => void): Reader => ({ size: bytes.length, read: (buf, off, len, pos) => { buf.set(bytes.subarray(pos, pos + len), off); return len; }, close: () => onClose?.() });

type Fn = (...a: number[]) => number;
const e = () => pf.engineForTests() as unknown as Record<string, Fn>;

// ------------------------------------------------------------------ (b) malloc answers 0
test('T2b: malloc stubbed to 0 -> openDoc throws "out of memory" (fatal) and the heap start is untouched', () => {
  const eng = pf.engineForTests();
  const orig = eng.pdfium;
  const ex = orig.wasmExports;
  eng.pdfium = Object.create(orig, { wasmExports: { value: Object.create(ex, { malloc: { value: () => 0 } }) } });
  const head = (): number[] => [...(orig as unknown as { HEAPU8: Uint8Array }).HEAPU8.subarray(0, 16)];
  const before = head();
  try {
    assert.throws(() => pf.openDoc('mem0', three()), (err: Error) => /out of memory/i.test(err.message) && /^Aborted/i.test(err.message));
    assert.deepEqual(head(), before, 'bytes 0-16 of the heap are as they were');
  } finally { eng.pdfium = orig; }
  assert.deepEqual(pf.openIds(), []);
});

// ------------------------------------------------------------------ (c) openDoc
test('T2c: a page whose size call fails gets the A4 default, not the page before it', () => {
  const oSize = e().FPDF_GetPageSizeByIndexF;
  let calls = 0;
  e().FPDF_GetPageSizeByIndexF = ((...a: number[]) => (++calls === 2 ? 0 : oSize(...a))) as Fn;
  try {
    const info = pf.openDoc('c1', three());
    assert.deepEqual(info.pages, [{ w: 300, h: 400 }, { w: 595, h: 842 }, { w: 700, h: 800 }]);
  } finally { e().FPDF_GetPageSizeByIndexF = oSize; pf.closeDoc('c1'); }
});

test('T2c: a throw while sizing leaves the id, the reader slot and the document open under that id as they were', () => {
  pf.openDoc('c2', three());
  const slots = pf.readerSlotsForTests();
  const oSize = e().FPDF_GetPageSizeByIndexF;
  let calls = 0;
  e().FPDF_GetPageSizeByIndexF = ((...a: number[]) => { if (++calls === 2) throw new Error('boom'); return oSize(...a); }) as Fn;
  try {
    const b = three();
    assert.throws(() => pf.openDoc('c2', readerOf(b)), /boom/);
    assert.equal(pf.readerSlotsForTests(), slots, 'the reader slot taken by the failed open is gone');
    // a first open of a new id that fails is not listed
    calls = 0;
    assert.throws(() => pf.openDoc('c3', readerOf(b)), /boom/);
  } finally { e().FPDF_GetPageSizeByIndexF = oSize; }
  assert.deepEqual(pf.openIds(), ['c2'], 'the id that was open is still open, the new one is not');
  assert.equal(pf.readerSlotsForTests(), slots);
  assert.deepEqual(pf.pageSizes('c2'), [{ w: 300, h: 400 }, { w: 500, h: 600 }, { w: 700, h: 800 }]);
  const g = pf.renderGray('c2', 0, [1, 0, 0, 1, 0, 0], 40, 40);
  assert.equal(g.px.length, 1600, 'it still draws');
  pf.closeDoc('c2');
});

// ------------------------------------------------------------------ (d) closeDoc
test('T2d: a page close that throws - the document is still closed and its reader released', () => {
  let closed = 0;
  pf.openDoc('d1', readerOf(three(), () => closed++));
  pf.loadPage('d1', 0); pf.loadPage('d1', 1);
  const slots = pf.readerSlotsForTests();
  const oClose = e().FPDF_ClosePage, oDoc = e().FPDF_CloseDocument;
  let pageCloses = 0, docCloses = 0;
  e().FPDF_ClosePage = ((p: number) => { pageCloses++; oClose(p); throw new Error('close failed'); }) as Fn;
  e().FPDF_CloseDocument = ((p: number) => { docCloses++; return oDoc(p); }) as Fn;
  const log = console.error;
  console.error = () => { /* the failure is logged */ };
  try { pf.closeDoc('d1'); } finally { e().FPDF_ClosePage = oClose; e().FPDF_CloseDocument = oDoc; console.error = log; }
  assert.equal(pageCloses, 2, 'both pages were tried');
  assert.equal(docCloses, 1, 'the document was closed');
  assert.equal(closed, 1, 'the reader was released');
  assert.equal(pf.readerSlotsForTests(), slots - 1, 'the reader slot is gone');
  assert.deepEqual(pf.openIds(), []);
});

// ------------------------------------------------------------------ (e) rpc
test('T2e: a port whose postMessage throws - the call rejects and busy is 0', async () => {
  const c = new EngineClient('t');
  const bad = { postMessage() { throw new Error('could not be cloned'); }, close() {}, start() {}, onmessage: null };
  c.attach(bad as unknown as MessagePort, false);
  await assert.rejects(c.call('view', [1]), /could not be cloned/);
  assert.equal(c.busy, 0);
  assert.equal((c as unknown as { pending: Map<number, unknown> }).pending.size, 0);
  // and a port that does take messages works again
  const posted: { id: number }[] = [];
  const good = { postMessage(m: { id: number }) { posted.push(m); }, close() {}, start() {}, onmessage: null as null | ((ev: { data: unknown }) => void) };
  c.attach(good as unknown as MessagePort, false);
  const p = c.call<string>('view', [2]);
  assert.equal(c.busy, 1);
  good.onmessage!({ data: { id: posted[0].id, ok: true, value: 'x' } });
  assert.equal(await p, 'x');
  assert.equal(c.busy, 0);
});
