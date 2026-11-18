// PDFium (the engine inside Chrome, as WebAssembly): page drawing and text positions.
// No DOM in here so tests run it in plain Node.
//
// "Page space" everywhere: the page as shown (rotation and crop box applied), origin
// top-left, 1 unit = 1 PDF point.
import crypto from 'node:crypto';
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';
import type { Reader } from './files';

let P: WrappedPdfiumModule | null = null;

export async function startPdfium(wasm: ArrayBuffer): Promise<void> {
  if (P) return;
  P = await init({ wasmBinary: wasm });
  P.PDFiumExt_Init();
}

function Q(): WrappedPdfiumModule {
  if (!P) throw new Error('PDF engine not started');
  return P;
}
type Heap = {
  HEAPU8: Uint8Array; HEAPF32: Float32Array; HEAP32: Int32Array;
  wasmExports: { malloc(n: number): number; free(p: number): void };
  getValue(p: number, t: string): number; setValue(p: number, v: number, t: string): void;
  addFunction(f: (...a: number[]) => number, sig: string): number;
};
const M = () => Q().pdfium as unknown as Heap;
// (addresses unsigned: past 2 GB they come back from the engine negative. 0 = no memory left: a
// file was then copied over address 0 - the engine's own data - and every later call failed
// "table index is out of bounds"; now it stops as out of memory (fatal: started afresh, and the
// window blames the page, as when PDFium itself runs out))
const malloc = (n: number) => {
  const p = M().wasmExports.malloc(n) >>> 0;
  if (!p && n > 0) throw new Error(`Aborted: the drawing engine is out of memory (${Math.round(n / 2 ** 20)} MB more needed)`);
  return p;
};
const free = (p: number) => M().wasmExports.free(p);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const X = () => Q() as any;

interface PageCache { ptr: number; text: number; aff: number[]; w: number; h: number; t: number; chars?: CharInfo }
/** every character of a page: its text (one UTF-16 unit per character) and its loose box (x0, y0, x1, y1 a character, page space as shown, y down) */
export interface CharInfo { text: string; box: Float32Array }
interface Doc { mem: number; fa: number; slot: number; reader: Reader | null; doc: number; pages: Map<number, PageCache>; sizes: { w: number; h: number }[] }
const docs = new Map<string, Doc>();

export interface OpenInfo { pages: { w: number; h: number }[] }

import { READ_FAIL } from './rpc';
import { ensureMu, pageBlends, muGray, muRGBA, dropMu, dropMuLists, buildTiles, markups } from './murender';
export { READ_FAIL };

/** documents read on demand: PDFium asks for blocks, we read them from the file */
const readers = new Map<number, Reader>();
let slotSeq = 1;
let getBlockFn = 0;
function getBlock(): number {
  if (!getBlockFn) {
    getBlockFn = M().addFunction((param: number, pos: number, buf: number, len: number) => {
      const r = readers.get(param);
      if (!r) return 0;
      try { return r.read(M().HEAPU8, buf >>> 0, len, pos >>> 0) === len ? 1 : 0; } catch { return 0; }
    }, 'iiiii');
  }
  return getBlockFn;
}

/** the size given to a page PDFium cannot size (A4, in points) */
const DEFAULT_PAGE = { w: 595, h: 842 };

/** open from bytes, or from a reader (the file stays on disk; PDFium reads what it needs) */
export function openDoc(id: string, src: Uint8Array | Reader, password = ''): OpenInfo {
  // (ported from the PDF Editor: the document is registered only once every page is sized - a throw
  // in here left it in `docs` half made and its memory and reader slot taken for good. Now what
  // was taken for it is given back, and the copy open under this id so far is closed only when the
  // new one is ready: a failed reopen keeps drawing)
  const q = Q();
  let mem = 0, fa = 0, slot = 0, doc = 0;
  if (src instanceof Uint8Array) {
    mem = malloc(src.length);
    M().HEAPU8.set(src, mem);
    doc = q.FPDF_LoadMemDocument(mem, src.length, password);
  } else {
    if (src.size > 0xffffffff) throw new Error('Files over 4 GB are not supported');
    slot = slotSeq++;
    readers.set(slot, src);
    try {
      fa = malloc(12);
    } catch (e) { readers.delete(slot); throw e; }
    M().setValue(fa, src.size | 0, 'i32');
    M().setValue(fa + 4, getBlock(), 'i32');
    M().setValue(fa + 8, slot, 'i32');
    doc = X().FPDF_LoadCustomDocument(fa, password);
  }
  if (!doc) {
    const err = q.FPDF_GetLastError();
    if (mem) free(mem);
    if (fa) free(fa);
    if (slot) readers.delete(slot);
    if (err === 4) throw new Error('This PDF is password protected');
    if ((src as { failed?: boolean }).failed) throw new Error(READ_FAIL);
    if (err === 3) throw new Error('The file is damaged or cut short - not a PDF that can be read');
    if (err === 5) throw new Error('This PDF is locked (security settings)');
    throw new Error('Could not open this PDF (it may be damaged; error ' + err + ')');
  }
  const sizes: { w: number; h: number }[] = [];
  let sz = 0;
  try {
    sz = malloc(16);
    const n = q.FPDF_GetPageCount(doc);
    for (let i = 0; i < n; i++) {
      // (a page PDFium cannot size leaves the buffer as it was: the one before's size, or whatever
      // was in the memory - so the buffer is cleared first and the result checked; such a page gets
      // the default size rather than its neighbour's)
      M().HEAPU8.fill(0, sz, sz + 16);
      const ok = q.FPDF_GetPageSizeByIndexF(doc, i, sz);
      const f = new Float32Array(M().HEAPU8.buffer, sz, 2);
      sizes.push(ok ? { w: f[0], h: f[1] } : { w: DEFAULT_PAGE.w, h: DEFAULT_PAGE.h });
    }
  } catch (e) {
    try { q.FPDF_CloseDocument(doc); } catch { /* the first failure is the one to report */ }
    if (mem) free(mem);
    if (fa) free(fa);
    if (slot) readers.delete(slot);
    throw e;
  } finally {
    if (sz) free(sz);
  }
  closeDoc(id);
  docs.set(id, { mem, fa, slot, reader: src instanceof Uint8Array ? null : src, doc, pages: new Map(), sizes });
  return { pages: sizes };
}

/** closes the document and gives back everything it held, even if closing one page throws (the
 *  first failure is logged; nothing that comes after it is skipped) */
export function closeDoc(id: string): void {
  const d = docs.get(id);
  if (!d) return;
  const fails: unknown[] = [];
  const attempt = (f: () => void) => { try { f(); } catch (e) { fails.push(e); } };
  attempt(() => dropMu(id));
  for (const k of [...muOn]) if (k.startsWith(id + '#')) muOn.delete(k);
  const q = Q();
  for (const p of d.pages.values()) freePageSafe(p, attempt);
  attempt(() => q.FPDF_CloseDocument(d.doc));
  if (d.mem) attempt(() => free(d.mem));
  if (d.fa) attempt(() => free(d.fa));
  if (d.slot) readers.delete(d.slot);
  if (d.reader) attempt(() => d.reader!.close());
  docs.delete(id);
  if (fails.length) console.error(`closing document ${id}: ${fails.length} step(s) failed, the rest was released:`, fails[0]);
}

export const isOpen = (id: string) => docs.has(id);
// (tests) the PDFium module itself, to stub a call in it; how many reader slots are registered
export const engineForTests = () => Q() as unknown as Record<string, unknown> & { pdfium: { wasmExports: { malloc(n: number): number; free(p: number): void } } };
export const readerSlotsForTests = () => readers.size;
export const openIds = () => [...docs.keys()];
export const heapBytes = () => M().HEAPU8.buffer.byteLength;
/** a document whose file could not be read completely (see VFile.failed) */
export const readFailed = (id: string) => !!(docs.get(id)?.reader as { failed?: boolean } | null | undefined)?.failed;
export function pageSizes(id: string) { return mustDoc(id).sizes; }
/** what the document is read from (MuPDF reads the same - see murender.ts) */
export const readerOf = (id: string): Reader | null => docs.get(id)?.reader ?? null;

// ---------------------------------------------------------------- MuPDF for some pages
/** pages drawn by MuPDF (murender.ts): "<id>#<page>" */
const muOn = new Set<string>();
export function setMu(id: string, pg: number, on: boolean) { if (on) muOn.add(id + '#' + pg); else muOn.delete(id + '#' + pg); }
export const usesMu = (id: string, pg: number) => muOn.has(id + '#' + pg);
/** objects on a page (cheap once it is read in) */
export function objectCount(id: string, pg: number): number { return Q().FPDFPage_CountObjects(page(mustDoc(id), pg).ptr); }
/** a page with this many objects that blends is drawn by MuPDF (PDFium: ~0.5 ms per blended object) */
const MU_OBJECTS = 5000;
/**
 * Pick the drawing engine for a pair (both the same): MuPDF when either page blends and is busy
 * (see murender.ts), else PDFium. Returns whether MuPDF draws them.
 */
export async function chooseRenderer(pages: [string | null, number][]): Promise<boolean> {
  // (tests: RR_FORCE_MU=1 draws every pair with MuPDF - to measure what the engine change does)
  let want = process.env.RR_FORCE_MU === '1' && (await ensureMu());
  for (const [id, pg] of pages) {
    if (!id || want) continue;
    if (objectCount(id, pg) < MU_OBJECTS) continue;
    if (!(await ensureMu())) break;
    want = pageBlends(id, pg);
  }
  for (const [id, pg] of pages) if (id) setMu(id, pg, want);
  return want;
}

/** the viewer's next sheet, made ready: a page MuPDF draws cut into tiles (murender.ts buildTiles -
 *  a close look then walks only its own part of the page). False: drawn whole, as before. */
export function prepareTiles(id: string, pg: number): boolean {
  return muOn.has(id + '#' + pg) ? buildTiles(id, pg) : false;
}

function mustDoc(id: string): Doc {
  const d = docs.get(id);
  if (!d) throw new Error('Document is not open');
  return d;
}

/** parsed pages kept per document (a dense A0 sheet holds hundreds of MB once read in) */
const KEEP = 2;

function freePage(p: PageCache) {
  const q = Q();
  if (p.text) q.FPDFText_ClosePage(p.text);
  q.FPDF_ClosePage(p.ptr);
}
/** both of a page's handles are tried even if the first close throws */
function freePageSafe(p: PageCache, attempt: (f: () => void) => void) {
  const q = Q();
  if (p.text) attempt(() => q.FPDFText_ClosePage(p.text));
  attempt(() => q.FPDF_ClosePage(p.ptr));
}

function page(d: Doc, i: number): PageCache {
  const have = d.pages.get(i);
  if (have) { have.t = performance.now(); return have; }
  if (i < 0 || i >= d.sizes.length) throw new Error('No page ' + (i + 1));
  const q = Q();
  const ptr = q.FPDF_LoadPage(d.doc, i);
  if (!ptr) throw new Error('Could not read page ' + (i + 1));
  const w = q.FPDF_GetPageWidthF(ptr), h = q.FPDF_GetPageHeightF(ptr);
  const p: PageCache = { ptr, text: 0, aff: affine(ptr, w, h), w, h, t: performance.now() };
  d.pages.set(i, p);
  while (d.pages.size > KEEP) {
    let old = -1, ot = Infinity;
    for (const [k, v] of d.pages) if (k !== i && v.t < ot) { ot = v.t; old = k; }
    if (old < 0) break;
    freePage(d.pages.get(old)!);
    d.pages.delete(old);
  }
  return p;
}

/** let go of PDFium's parsed pages only (MuPDF draws them: PDFium was needed for the words) */
export function releasePages(id: string) {
  const d = docs.get(id);
  if (!d) return;
  for (const p of d.pages.values()) freePage(p);
  d.pages.clear();
}

/** let go of every parsed page (memory) - the documents stay open */
export function dropPages(id?: string) {
  for (const [k, d] of docs) {
    if (id && k !== id) continue;
    for (const p of d.pages.values()) freePage(p);
    d.pages.clear();
  }
  dropMuLists(id);
}

/** affine from PDF user space to page space: x' = a x + c y + e, y' = b x + d y + f */
function affine(ptr: number, w: number, h: number): number[] {
  const q = Q();
  const K = 64;
  const sx = Math.round(w * K), sy = Math.round(h * K);
  const out = malloc(8);
  const dev = (x: number, y: number): [number, number] => {
    q.FPDF_PageToDevice(ptr, 0, 0, sx, sy, 0, x, y, out, out + 4);
    return [M().getValue(out, 'i32') / K, M().getValue(out + 4, 'i32') / K];
  };
  const o = dev(0, 0), ex = dev(1000, 0), ey = dev(0, 1000);
  free(out);
  return [(ex[0] - o[0]) / 1000, (ex[1] - o[1]) / 1000, (ey[0] - o[0]) / 1000, (ey[1] - o[1]) / 1000, o[0], o[1]];
}
const apply = (m: number[], x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** page loaded (parsed): for timing / memory decisions */
export function loadPage(id: string, pg: number): { w: number; h: number } {
  const p = page(mustDoc(id), pg);
  return { w: p.w, h: p.h };
}

export interface Gray { w: number; h: number; px: Uint8Array }

/**
 * Draw a region of a page as grey levels, darkest channel of each pixel (a yellow or cyan line
 * counts as ink as much as a black one). m = page space -> picture pixels (a, b, c, d, e, f);
 * the picture is w x h. White = 255. minPt: the narrowest line (points) on a page MuPDF draws - the
 * viewer gives 0, lines as drawn (see murender.ts); PDFium draws every line at least a pixel wide.
 */
export function renderGray(id: string, pg: number, m: number[], w: number, h: number, minPt?: number): Gray {
  // (minPt 0, the viewer's, on a page without markups: MuPDF's colour display list serves the grey
  //  pictures too - one list read in per page, not two: 3-5 s each on a heavy blended sheet)
  if (muOn.has(id + '#' + pg)) return muGray(id, pg, m, w, h, minPt, minPt === 0 && markups(id, pg) === 0);
  const rgba = renderRGBA(id, pg, m, w, h, false);
  const px = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < px.length; i++, j += 4) {
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    px[i] = r < g ? (r < b ? r : b) : (g < b ? g : b);
  }
  return { w, h, px };
}

/**
 * Draw a region of a page in colour, RGBA (straight into ImageData).
 * m = page space -> picture pixels.
 */
export function renderRGBA(id: string, pg: number, m: number[], w: number, h: number, annots = true): Uint8ClampedArray {
  if (w > 0 && h > 0 && muOn.has(id + '#' + pg)) return muRGBA(id, pg, m, w, h, annots);
  const q = Q();
  const d = mustDoc(id);
  const p = page(d, pg);
  if (w <= 0 || h <= 0) return new Uint8ClampedArray(0);
  const bmp = q.FPDFBitmap_Create(w, h, 0);
  if (!bmp) throw new Error('Out of memory for a ' + w + '×' + h + ' picture');
  const mat = malloc(24), clip = malloc(16);
  try {
    q.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
    const F = new Float32Array(M().HEAPU8.buffer, mat, 6);
    for (let k = 0; k < 6; k++) F[k] = m[k];
    const C = new Float32Array(M().HEAPU8.buffer, clip, 4);
    C[0] = 0; C[1] = 0; C[2] = w; C[3] = h; // left, top, right, bottom (device)
    // 0x10 = RGBA byte order; 0x01 = annotations (revision clouds drawn as markups count)
    X().FPDF_RenderPageBitmapWithMatrix(bmp, p.ptr, mat, clip, 0x10 | (annots ? 0x01 : 0));
    const buf = q.FPDFBitmap_GetBuffer(bmp);
    const stride = q.FPDFBitmap_GetStride(bmp);
    const heap = M().HEAPU8;
    if (stride === w * 4) return new Uint8ClampedArray(heap.buffer, buf, w * h * 4).slice();
    const px = new Uint8ClampedArray(w * h * 4);
    for (let r = 0; r < h; r++) px.set(heap.subarray(buf + r * stride, buf + r * stride + w * 4), r * w * 4);
    return px;
  } finally {
    free(mat); free(clip);
    q.FPDFBitmap_Destroy(bmp);
  }
}

/** a word on the page: its text and box in page space */
export interface Word { s: string; x0: number; y0: number; x1: number; y1: number }

/** (tests) how many pages words() has read in this process */
export const wordsReads = () => wordsRead;
let wordsRead = 0;

/**
 * Words with boxes. Characters are joined into words while they sit next to each other on one
 * line (CAD text often places every character on its own; spaces are not always there).
 *
 * (T5a, AUDIT A8: the same words as the 0.4.5 function - tests/words-oracle.ts - with far fewer
 *  calls into the engine. The wrapped calls of the package go through a generic `ccall` with an
 *  argument array each time; the engine's own exports are resolved once here and called as they
 *  are. One view on the heap is kept (made again if the heap grew under it). The angle and the font
 *  size are asked for only where the joining rule uses them: the size only when the next character
 *  is not near enough with the smallest allowance, the angle only when it is near.)
 */
export function words(id: string, pg: number): Word[] {
  wordsRead++;
  const d = mustDoc(id);
  const p = page(d, pg);
  const q = Q();
  const mod = M();
  const tp = textPage(p);
  const E = mod.wasmExports as unknown as Record<string, ((...a: number[]) => number) | undefined>;
  const n = tp ? q.FPDFText_CountChars(tp) : 0;
  const out: Word[] = [];
  if (n <= 0) return out;
  // (the engine's own exports; the package's wrapped ones if a build does not have them by that name)
  const getUnicode = E.FPDFText_GetUnicode ?? ((t: number, i: number) => q.FPDFText_GetUnicode(t, i));
  const getBox = E.FPDFText_GetCharBox ?? ((t: number, i: number, a: number, b: number, c: number, d2: number) => (q.FPDFText_GetCharBox(t, i, a, b, c, d2) ? 1 : 0));
  const getSize = E.FPDFText_GetFontSize ?? ((t: number, i: number) => q.FPDFText_GetFontSize(t, i));
  const getAngle = E.FPDFText_GetCharAngle ?? (X().FPDFText_GetCharAngle ? ((t: number, i: number) => X().FPDFText_GetCharAngle(t, i) as number) : null);
  const m0 = p.aff[0], m1 = p.aff[1], m2 = p.aff[2], m3 = p.aff[3], m4 = p.aff[4], m5 = p.aff[5];
  const db = malloc(32);
  let f = new Float64Array(mod.HEAPU8.buffer, db, 4); // left, right, bottom, top (user space)
  let cur: Word | null = null;
  let lastH = 0, lastCx = 0, lastCy = 0, lastAngle = 0, lastIdx = -1, angleKnown = false;
  const flush = () => { if (cur && cur.s.trim()) out.push(cur); cur = null; };
  try {
    for (let i = 0; i < n; i++) {
      const u = getUnicode(tp, i);
      // (2: a hyphen PDFium found at a line's end - "(IP-" / "20)" - kept on its word)
      if (u === 2) { if (cur) cur.s += '-'; flush(); continue; }
      if (u === 32 || u === 9 || u === 10 || u === 13 || u === 0 || u === 0xa0 || u === 0xfffe) { flush(); continue; }
      if (!getBox(tp, i, db, db + 8, db + 16, db + 24)) { flush(); continue; }
      if (f.byteLength === 0) f = new Float64Array(mod.HEAPU8.buffer, db, 4); // the heap grew: its old buffer is gone
      const fl = f[0], fr = f[1], fb = f[2], ft = f[3];
      const ax = m0 * fl + m2 * fb + m4, ay = m1 * fl + m3 * fb + m5;
      const bx = m0 * fr + m2 * ft + m4, by = m1 * fr + m3 * ft + m5;
      let x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
      if (!(x1 >= x0) || !(y1 >= y0)) { flush(); continue; }
      const rawMax = Math.max(x1 - x0, y1 - y0);
      // a char box of zero size (some fonts): give it a small one so it can be matched
      if (x1 - x0 < 0.01) { x0 -= 0.1; x1 += 0.1; }
      if (y1 - y0 < 0.01) { y0 -= 0.1; y1 += 0.1; }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      let ang = 0, angKnown = false;
      if (cur) {
        const w = x1 - x0, h = y1 - y0, dx = Math.abs(cx - lastCx), dy = Math.abs(cy - lastCy);
        // the allowance is Math.max(lastH, size * 0.3, 0.8) and only grows with the size: near with
        // the smallest one is near, and then the size is not asked for
        let hh = Math.max(lastH, 0.8);
        let near = dx < hh * 1.6 + w && dy < hh * 1.6 + h;
        if (!near) {
          const size = Math.max(0.5, getSize(tp, i) || rawMax);
          hh = Math.max(lastH, size * 0.3, 0.8);
          near = dx < hh * 1.6 + w && dy < hh * 1.6 + h;
        }
        if (near) {
          // the angle of this character and of the one before it (not asked for until now)
          if (getAngle) {
            ang = getAngle(tp, i); angKnown = true;
            if (!angleKnown) lastAngle = getAngle(tp, lastIdx);
          } else { ang = 0; angKnown = true; lastAngle = 0; }
          if (Math.abs(ang - lastAngle) > 0.05) flush();
        } else flush();
      }
      if (!cur) cur = { s: String.fromCharCode(u), x0, y0, x1, y1 };
      else { cur.s += String.fromCharCode(u); cur.x0 = Math.min(cur.x0, x0); cur.y0 = Math.min(cur.y0, y0); cur.x1 = Math.max(cur.x1, x1); cur.y1 = Math.max(cur.y1, y1); }
      lastH = Math.max(x1 - x0, y1 - y0); lastCx = cx; lastCy = cy; lastIdx = i;
      lastAngle = ang; angleKnown = angKnown;
    }
    flush();
  } finally { free(db); }
  return out;
}

/**
 * Every character on the page with its loose box in page space (T11, as the PDF Editor's `chars`): read from the text
 * page words() loads - the page is not opened twice. Kept with the page; dropPages lets it go.
 */
export function chars(id: string, pg: number): CharInfo {
  return charsOf(page(mustDoc(id), pg));
}
function boxToPage(m: number[], l: number, r: number, b: number, t: number): [number, number, number, number] {
  const p1 = apply(m, l, b), p2 = apply(m, r, t);
  return [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1])];
}
function textPage(p: PageCache): number {
  if (!p.text) p.text = Q().FPDFText_LoadPage(p.ptr);
  return p.text;
}
function charsOf(p: PageCache): CharInfo {
  if (p.chars) return p.chars;
  const q = Q();
  const tp = textPage(p);
  const n = tp ? q.FPDFText_CountChars(tp) : 0;
  if (n <= 0) return (p.chars = { text: '', box: new Float32Array(0) });
  const text = textAt(tp, 0, n);
  const box = new Float32Array(n * 4);
  const db = malloc(32);
  for (let i = 0; i < n; i++) {
    // loose box = the character's full line height (even selections and highlights)
    if (!q.FPDFText_GetLooseCharBox(tp, i, db)) { box.set([NaN, NaN, NaN, NaN], i * 4); continue; }
    const f = new Float32Array(M().HEAPU8.buffer, db, 4); // left, top, right, bottom
    if (!(f[2] > f[0])) { box.set([NaN, NaN, NaN, NaN], i * 4); continue; }
    const b = boxToPage(p.aff, f[0], f[2], f[3], f[1]);
    box.set(b, i * 4);
  }
  free(db);
  return (p.chars = { text, box });
}

/**
 * The text of chars [start, start + n) with exactly one UTF-16 unit per char index (text[i] is the
 * character whose box is box[i]). GetText leaves out characters it treats as control codes (a
 * hyphen some files map to U+0002...) and says how many units it wrote: when that isn't n, the
 * text is read char by char instead - everything after such a character drifted onto the next
 * one's box (selections copied the wrong letters, the search list bolded the wrong words) and the
 * end of the text held a NUL and leftover memory.
 */
function textAt(tp: number, start: number, n: number): string {
  const q = Q();
  const tb = malloc((n + 1) * 2);
  try {
    const got = q.FPDFText_GetText(tp, start, n, tb) - 1; // (the count includes the closing NUL)
    if (got === n) {
      const u16 = new Uint16Array(M().HEAPU8.buffer, tb, n);
      let text = '';
      for (let i = 0; i < n; i += 4096) text += String.fromCharCode(...u16.subarray(i, Math.min(n, i + 4096)));
      return text;
    }
  } finally { free(tb); }
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = q.FPDFText_GetUnicode(tp, start + i);
    // (control codes a page maps its glyphs to - hidden by GetText - as an invisible soft hyphen;
    // a code point beyond 16 bits can't take one unit: the replacement character)
    out[i] = (u < 32 && u !== 9 && u !== 10 && u !== 13) || (u >= 0x7f && u < 0xa0) || u === 0xfffe ? '\u00ad' : u > 0xffff ? '\ufffd' : String.fromCharCode(u);
  }
  return out.join('');
}

/** a quick look at what the page is made of (a scan = one big picture, little else) */
export function pageKind(id: string, pg: number): { objects: number; drawn: number; images: number; imageArea: number; hiddenText: number } {
  const d = mustDoc(id);
  const p = page(d, pg);
  const q = Q();
  const n = q.FPDFPage_CountObjects(p.ptr);
  // drawn = everything but text (an OCR layer on a scan is hundreds of invisible words)
  let images = 0, imageArea = 0, drawn = 0, hiddenText = 0;
  const b = malloc(16);
  try {
    for (let i = 0; i < n && drawn < 400; i++) {
      const o = q.FPDFPage_GetObject(p.ptr, i);
      const t = q.FPDFPageObj_GetType(o);
      if (t === 1) { if (X().FPDFTextObj_GetTextRenderMode && X().FPDFTextObj_GetTextRenderMode(o) === 3) hiddenText++; continue; }
      drawn++;
      if (t !== 3) continue;
      images++;
      if (q.FPDFPageObj_GetBounds(o, b, b + 4, b + 8, b + 12)) {
        const f = new Float32Array(M().HEAPU8.buffer, b, 4);
        imageArea += Math.abs((f[2] - f[0]) * (f[3] - f[1]));
      }
    }
  } finally { free(b); }
  return { objects: n, drawn, images, imageArea: imageArea / (p.w * p.h || 1), hiddenText };
}

/** a page's ruling (PLAN T6): horizontal lines as [y, x0, x1, ...], vertical as [x, y0, y1, ...], page space */
export interface Rules { h: number[]; v: number[] }
/** pages with more objects than this are not read for rules (a drawing, a traced scan) */
export const RULES_MAX_OBJECTS = 20000;
/** (tests) how many pages rules() has read in this process */
export const rulesReads = () => rulesRead;
let rulesRead = 0;

/**
 * The page's horizontal and vertical line pieces, read from its path objects the way the PDF Editor's
 * snap index reads them (ref pdfed011 pdfium.ts buildSnap: the object's matrix on the page's, forms
 * entered): a stroked straight piece that runs level or plumb, and a thin filled rectangle (under 2 pt
 * across: a rule drawn as a fill, as Word and Excel write them) as the line along its middle. Curves,
 * slanted pieces and wide fills (a shaded header) are not rules. A page of over 20,000 objects gives
 * none (a drawing: its words are not a spec table).
 */
export function rules(id: string, pg: number): Rules {
  rulesRead++;
  const d = mustDoc(id);
  const p = page(d, pg);
  const q = Q();
  const mod = M();
  const X = mod.wasmExports as unknown as Record<string, (...a: number[]) => number>;
  const h: number[] = [], v: number[] = [];
  const count = q.FPDFPage_CountObjects(p.ptr);
  if (count > RULES_MAX_OBJECTS) return { h, v };
  const mat = malloc(24), xy = malloc(8), md = malloc(8);
  let f32 = new Float32Array(mod.HEAPU8.buffer);
  const mi = mat >>> 2, xi = xy >>> 2;
  let budget = 400000; // path pieces read at most (forms inside forms can hold many)
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const level = (x0: number, y0: number, x1: number, y1: number) => {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    if (dx >= 3 && dy <= 0.5) h.push(r1((y0 + y1) / 2), r1(Math.min(x0, x1)), r1(Math.max(x0, x1)));
    else if (dy >= 3 && dx <= 0.5) v.push(r1((x0 + x1) / 2), r1(Math.min(y0, y1)), r1(Math.max(y0, y1)));
  };
  const pts: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const visit = (obj: number, t0: number, t1: number, t2: number, t3: number, t4: number, t5: number, depth: number) => {
    if (budget <= 0) return;
    const type = X.FPDFPageObj_GetType(obj);
    if (type !== 2 && type !== 5) return;
    let b0 = 1, b1 = 0, b2 = 0, b3 = 1, b4 = 0, b5 = 0;
    if (X.FPDFPageObj_GetMatrix(obj, mat)) {
      if (mod.HEAPU8.buffer !== f32.buffer) f32 = new Float32Array(mod.HEAPU8.buffer);
      b0 = f32[mi]; b1 = f32[mi + 1]; b2 = f32[mi + 2]; b3 = f32[mi + 3]; b4 = f32[mi + 4]; b5 = f32[mi + 5];
    }
    const a0 = t0 * b0 + t2 * b1, a1 = t1 * b0 + t3 * b1, a2 = t0 * b2 + t2 * b3, a3 = t1 * b2 + t3 * b3;
    const a4 = t0 * b4 + t2 * b5 + t4, a5 = t1 * b4 + t3 * b5 + t5;
    if (type === 5) {
      if (depth > 6) return;
      const c = X.FPDFFormObj_CountObjects(obj);
      for (let k = 0; k < c; k++) visit(X.FPDFFormObj_GetObject(obj, k), a0, a1, a2, a3, a4, a5, depth + 1);
      return;
    }
    let fill = 0, stroke = 0;
    if (X.FPDFPath_GetDrawMode && X.FPDFPath_GetDrawMode(obj, md, md + 4)) { fill = mod.HEAP32[md >>> 2]; stroke = mod.HEAP32[(md + 4) >>> 2]; }
    else stroke = 1;
    if (!fill && !stroke) return;
    const cnt = X.FPDFPath_CountSegments(obj);
    budget -= cnt;
    if (budget <= 0) return;
    // (a rectangle's corners are kept only for a short path: a long one is no thin fill, and keeping its
    //  points made garbage enough on drawing pages to lift the peak by ~190 MB on MEP)
    const few = !stroke && cnt <= 6;
    pts.length = 0;
    let curved = false, sx = 0, sy = 0, px = 0, py = 0, has = false;
    for (let k = 0; k < cnt; k++) {
      const sg = X.FPDFPath_GetPathSegment(obj, k);
      if (!X.FPDFPathSegment_GetPoint(sg, xy, xy + 4)) continue;
      if (mod.HEAPU8.buffer !== f32.buffer) f32 = new Float32Array(mod.HEAPU8.buffer);
      const ux = f32[xi], uy = f32[xi + 1];
      const gx = a0 * ux + a2 * uy + a4, gy = a1 * ux + a3 * uy + a5;
      const t = X.FPDFPathSegment_GetType(sg);
      if (few) pts.push(gx, gy);
      if (t === 2 || !has) { sx = gx; sy = gy; has = true; }
      else if (t === 1) curved = true;
      else if (stroke) level(px, py, gx, gy);
      px = gx; py = gy;
      if (X.FPDFPathSegment_GetClose(sg) && (px !== sx || py !== sy)) { if (stroke) level(px, py, sx, sy); px = sx; py = sy; }
    }
    // (a thin filled rectangle: the line along its middle)
    if (fill && !stroke && !curved && pts.length >= 8 && pts.length <= 12) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < pts.length; k += 2) { x0 = Math.min(x0, pts[k]); x1 = Math.max(x1, pts[k]); y0 = Math.min(y0, pts[k + 1]); y1 = Math.max(y1, pts[k + 1]); }
      // (its corners on its box: a rectangle, not a slanted shape)
      let square = true;
      for (let k = 0; k < pts.length; k += 2) if ((Math.abs(pts[k] - x0) > 0.3 && Math.abs(pts[k] - x1) > 0.3) || (Math.abs(pts[k + 1] - y0) > 0.3 && Math.abs(pts[k + 1] - y1) > 0.3)) square = false;
      if (square) {
        if (y1 - y0 <= 2 && x1 - x0 >= 3) h.push(r1((y0 + y1) / 2), r1(x0), r1(x1));
        else if (x1 - x0 <= 2 && y1 - y0 >= 3) v.push(r1((x0 + x1) / 2), r1(y0), r1(y1));
      }
    }
  };
  try {
    for (let i = 0; i < count; i++) visit(X.FPDFPage_GetObject(p.ptr, i), p.aff[0], p.aff[1], p.aff[2], p.aff[3], p.aff[4], p.aff[5], 0);
  } finally { free(mat); free(xy); free(md); }
  return { h, v };
}

/** a picture on a page (PLAN T6.5): its box in page space, its pixel size, the sha1 of its stream as
 *  stored (raw: the same bytes are the same picture), the stream's size */
export interface PicObj { box: number[]; pw: number; ph: number; sha: string; bytes: number }
/**
 * Every image object of a page, forms entered two levels: where it is drawn (its unit square through
 * its matrix, the forms' and the page's), its pixel size, a hash of its raw stream.
 */
export function pictures(id: string, pg: number): PicObj[] {
  const d = mustDoc(id);
  const p = page(d, pg);
  const q = Q();
  const mod = M();
  const X = mod.wasmExports as unknown as Record<string, (...a: number[]) => number>;
  const out: PicObj[] = [];
  const count = q.FPDFPage_CountObjects(p.ptr);
  const mat = malloc(24), wh = malloc(8);
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const visit = (obj: number, t0: number, t1: number, t2: number, t3: number, t4: number, t5: number, depth: number) => {
    const type = X.FPDFPageObj_GetType(obj);
    if (type !== 3 && type !== 5) return;
    let b0 = 1, b1 = 0, b2 = 0, b3 = 1, b4 = 0, b5 = 0;
    if (X.FPDFPageObj_GetMatrix(obj, mat)) { const f = new Float32Array(mod.HEAPU8.buffer, mat, 6); b0 = f[0]; b1 = f[1]; b2 = f[2]; b3 = f[3]; b4 = f[4]; b5 = f[5]; }
    const a0 = t0 * b0 + t2 * b1, a1 = t1 * b0 + t3 * b1, a2 = t0 * b2 + t2 * b3, a3 = t1 * b2 + t3 * b3;
    const a4 = t0 * b4 + t2 * b5 + t4, a5 = t1 * b4 + t3 * b5 + t5;
    if (type === 5) {
      if (depth >= 2) return;
      const c = X.FPDFFormObj_CountObjects(obj);
      for (let k = 0; k < c; k++) visit(X.FPDFFormObj_GetObject(obj, k), a0, a1, a2, a3, a4, a5, depth + 1);
      return;
    }
    // (the unit square, drawn)
    const xs = [a4, a0 + a4, a2 + a4, a0 + a2 + a4], ys = [a5, a1 + a5, a3 + a5, a1 + a3 + a5];
    const box = [r1(Math.min(...xs)), r1(Math.min(...ys)), r1(Math.max(...xs)), r1(Math.max(...ys))];
    let pw = 0, ph = 0;
    if (X.FPDFImageObj_GetImagePixelSize && X.FPDFImageObj_GetImagePixelSize(obj, wh, wh + 4)) { pw = mod.HEAP32[wh >>> 2] >>> 0; ph = mod.HEAP32[(wh + 4) >>> 2] >>> 0; }
    let sha = '', bytes = 0;
    const n = X.FPDFImageObj_GetImageDataRaw ? X.FPDFImageObj_GetImageDataRaw(obj, 0, 0) >>> 0 : 0;
    if (n > 0) {
      const buf = malloc(n);
      try {
        X.FPDFImageObj_GetImageDataRaw(obj, buf, n);
        sha = crypto.createHash('sha1').update(M().HEAPU8.subarray(buf, buf + n)).digest('hex').slice(0, 20);
        bytes = n;
      } finally { free(buf); }
    }
    // (a stream that cannot be read: an id of its own - two such pictures of one size are not "the same bytes"; their
    //  pixels decide; Engineer A12)
    out.push({ box, pw, ph, sha: sha || `none:${pg}:${out.length}:${pw}x${ph}`, bytes });
  };
  try {
    for (let i = 0; i < count; i++) visit(X.FPDFPage_GetObject(p.ptr, i), p.aff[0], p.aff[1], p.aff[2], p.aff[3], p.aff[4], p.aff[5], 0);
  } finally { free(mat); free(wh); }
  return out;
}

/** the page label or empty (some sets carry the sheet number there) */
export function pageLabel(id: string, pg: number): string {
  const d = mustDoc(id);
  const q = Q();
  const n = q.FPDF_GetPageLabel(d.doc, pg, 0, 0);
  if (n <= 2) return '';
  const b = malloc(n);
  try {
    q.FPDF_GetPageLabel(d.doc, pg, b, n);
    return new TextDecoder('utf-16le').decode(M().HEAPU8.slice(b, b + n - 2));
  } finally { free(b); }
}

// ---------------------------------------------------------------- raw access (report writer)

export function raw() {
  return {
    q: X(),
    heap: () => M(),
    malloc, free,
    doc: (id: string) => mustDoc(id).doc,
    affine,
    addFunction: (f: (...a: number[]) => number, sig: string) => M().addFunction(f, sig),
  };
}

/** UTF-16LE, zero ended, in engine memory (free it) */
export function wide(s: string): number {
  const p = malloc((s.length + 1) * 2);
  const h = new Uint16Array(M().HEAPU8.buffer, p, s.length + 1);
  for (let i = 0; i < s.length; i++) h[i] = s.charCodeAt(i);
  h[s.length] = 0;
  return p;
}

/** the engine itself is broken (out of memory, aborted, a wasm trap): the call fails and the engine is replaced -
 *  never read as an answer (host.ts, picdiff.ts) */
export function isFatalError(e: unknown): boolean {
  if (e instanceof WebAssembly.RuntimeError) return true;
  const m = e instanceof Error ? e.message : String(e);
  return /^Aborted|memory access out of bounds|unreachable|Out of memory|Cannot enlarge memory/i.test(m);
}
