/// <reference types="node" />
// Pages PDFium can't draw in reasonable time are drawn by MuPDF.
//
// The case (a tender's tower plans, Oct 2026): CAD sheets that set a blend mode for the whole page
// ("/BM /Darken" in the first graphics state - every one of 1.3 million strokes is blended). PDFium
// treats every blended object as a transparency group of its own - a drawing surface, a renderer and
// a composite per stroke - and one sheet took over 10 minutes at any resolution (5 dpi too), so the
// comparison hit its time limit and the viewer never showed the sheet. MuPDF blends such pages in
// 3-7 s with the blend mode honoured (drawing them with the blend mode switched off was 18 % of the
// ink different: light fills then cover the lines under them).
//
// Both sheets of a pair are drawn by the same engine (the two draw thin lines a little differently:
// mixed, that would be a difference on every line). Words, sizes and page kinds still come from
// PDFium. Pages are kept as display lists (read once, drawn many times: the close looks, the viewer).
import { readerOf, type Gray } from './pdfium';
import { noteMu } from './muheap';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MU = any;
let mu: MU | null = null;
let muFailed = false;
/** MuPDF loaded (once per engine): false when it isn't there (PDFium then draws everything) */
export async function ensureMu(): Promise<boolean> {
  if (mu) return true;
  if (muFailed) return false;
  try { mu = await import('mupdf'); noteMu(mu); return true; } catch (e) { muFailed = true; console.error('MuPDF not available: ' + String((e as Error)?.message || e)); return false; }
}

interface MDoc { doc: MU; lists: Map<string, { list: MU; t: number }>; blend: Map<number, boolean>; tiles: Map<number, Tiles | null>; marks: Map<number, number> }
/** a page "as shown" cut into tiles (see buildTiles): the tile rects (page space) and their lists */
interface Tiles { rects: number[][]; lists: MU[] }
const mdocs = new Map<string, MDoc>();
/** MuPDF documents open in this engine (T22: it starts afresh for MuPDF's memory only when none is) */
export const muOpenCount = () => mdocs.size;

function mdoc(id: string): MDoc {
  const have = mdocs.get(id);
  if (have) return have;
  if (!mu) throw new Error('MuPDF is not loaded');
  const r = readerOf(id);
  if (!r) throw new Error('Document is not open');
  // the same reader as PDFium's (read on demand); it is closed with the PDFium document
  const stm = new mu.Stream({ fileSize: () => r.size, read: (memory: Uint8Array, offset: number, length: number, position: number) => r.read(memory, offset, length, position), close() { /* closed by its owner */ } });
  const d: MDoc = { doc: mu.Document.openDocument(stm, 'application/pdf'), lists: new Map(), blend: new Map(), tiles: new Map(), marks: new Map() };
  mdocs.set(id, d);
  return d;
}

/** let go of a document's MuPDF side (before the reader closes) */
export function dropMu(id: string) {
  for (const k of [...minLine.keys()]) if (k.startsWith(id + '#')) minLine.delete(k);
  const d = mdocs.get(id);
  if (!d) return;
  for (const v of d.lists.values()) try { v.list.destroy?.(); } catch { /* */ }
  dropTiles(d);
  try { d.doc.destroy?.(); } catch { /* */ }
  mdocs.delete(id);
}
function dropTiles(d: MDoc) {
  for (const t of d.tiles.values()) for (const l of t?.lists ?? []) try { l.destroy?.(); } catch { /* */ }
  d.tiles.clear();
}

const NORMAL = new Set(['Normal', 'Compatible']);
/**
 * Does this page blend (a blend mode other than Normal in its graphics states)? Only asked for
 * pages with many objects - a few blended ones PDFium draws quickly.
 */
export function pageBlends(id: string, pg: number): boolean {
  if (!mu) return false;
  let d: MDoc;
  try { d = mdoc(id); } catch { return false; } // (MuPDF can't read it: PDFium draws it, as before)
  const had = d.blend.get(pg);
  if (had !== undefined) return had;
  let blends = false;
  try {
    const pdf = d.doc.asPDF?.() ?? d.doc;
    const po = pdf.findPage(pg);
    const gs = po.getInheritable('Resources').get('ExtGState');
    if (gs && gs.isDictionary()) {
      gs.forEach((v: MU) => {
        const bm = v.get('BM');
        const names = bm.isArray() ? [bm.get(0)] : [bm];
        for (const n of names) if (n.isName() && !NORMAL.has(n.asName())) blends = true;
      });
    }
  } catch { /* not readable this way: PDFium draws it */ }
  d.blend.set(pg, blends);
  return blends;
}

/**
 * Markups drawn on a page "as shown" (annotations and form fields - not links, which are not
 * drawn): the viewer's grey pictures share the colour display list when there are none. Read from
 * the page's /Annots (counting them through PDFium read the whole page in there: 1.8 s and 330 MB
 * on a heavy blended sheet, never used). Can't tell: 1 (two lists, as before).
 */
export function markups(id: string, pg: number): number {
  if (!mu) return 1;
  let d: MDoc;
  try { d = mdoc(id); } catch { return 1; }
  const had = d.marks.get(pg);
  if (had !== undefined) return had;
  let n = 1;
  try {
    const pdf = d.doc.asPDF?.() ?? d.doc;
    const an = pdf.findPage(pg).get('Annots');
    n = 0;
    if (an && an.isArray()) {
      for (let i = 0; i < an.length; i++) {
        const st = an.get(i).get('Subtype');
        if (!(st && st.isName() && st.asName() === 'Link')) n++;
      }
    }
  } catch { n = 1; }
  d.marks.set(pg, n);
  return n;
}

/** display lists kept per document (a dense sheet's list is a few hundred MB) */
const KEEP = 2;
/**
 * Thin lines: MuPDF draws a line thinner than a pixel pale - its coverage - and how pale depends on
 * where it falls between pixels; PDFium draws every line at least a pixel wide. A sheet moved half
 * a pixel to line up then made pale lines come and go: false changes along thin lines (9-18 on each
 * of the test suite's shifted sheets). Making greys darker afterwards hid black marks on grey fills
 * (rebar ticks in structural column drawings); drawing finer and taking the darkest pixel made lines jump
 * between one and two pixels wide. So, as PDFium: for the comparison, every stroke is at least one
 * pixel wide at the comparison's scale - set once, when the page is read into its display list.
 */
/** wrappers mupdf.js lends a device (paths, text, stroke states, colour spaces - each holding a
 *  reference) are let go at once: one collected later, after its display list is gone, writes into
 *  freed memory and the engine dies at a random moment ("memory access out of bounds" - found in
 *  the PDF Editor, same mupdf.js 1.28.1) */
function done(...xs: MU[]) {
  for (const x of xs) try { x?.destroy?.(); } catch { /* already gone */ }
}
/** shadings are lent WITHOUT a reference, yet their wrapper drops one when collected (freed twice):
 *  told to leave them alone - MuPDF still owns them. (Pictures are lent WITH one - mupdf.js 1.28.1
 *  keeps the image for its wrapper: they are let go with done(), like paths; told to leave them
 *  alone instead, every picture on such a page stayed in memory for good - checked: fz_image refs
 *  3 -> 4 -> 5 -> 6 over four runs) */
function borrowed(x: MU) {
  try { (x?.constructor as { _finalizer?: FinalizationRegistry<number> } | undefined)?._finalizer?.unregister(x); } catch { /* other mupdf.js */ }
}

function minWidthDevice(target: MU, minPx: number): MU {
  const scaleOf = (m: number[]) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const widen = (stroke: MU, ctm: number[]) => {
    const w = stroke.getLineWidth(), min = minPx / scaleOf(ctm);
    if (w >= min) return stroke;
    return new mu.StrokeState({
      lineCap: mu.StrokeState.LINE_CAP[stroke.getLineCap()], lineJoin: mu.StrokeState.LINE_JOIN[stroke.getLineJoin()],
      lineWidth: min, miterLimit: stroke.getMiterLimit(), dashPhase: stroke.getDashPhase(), dashes: stroke.getDashes() || undefined,
    });
  };
  const t = target;
  return new mu.Device({
    close: () => t.close(),
    fillPath: (p: MU, eo: boolean, ctm: MU, cs: MU, c: MU, a: number) => { try { t.fillPath(p, eo, ctm, cs, c, a); } finally { done(p, cs); } },
    strokePath: (p: MU, st: MU, ctm: MU, cs: MU, c: MU, a: number) => { const s2 = widen(st, ctm); try { t.strokePath(p, s2, ctm, cs, c, a); } finally { if (s2 !== st) s2.destroy?.(); done(p, st, cs); } },
    clipPath: (p: MU, eo: boolean, ctm: MU) => { try { t.clipPath(p, eo, ctm); } finally { done(p); } },
    clipStrokePath: (p: MU, st: MU, ctm: MU) => { try { t.clipStrokePath(p, st, ctm); } finally { done(p, st); } },
    fillText: (x: MU, ctm: MU, cs: MU, c: MU, a: number) => { try { t.fillText(x, ctm, cs, c, a); } finally { done(x, cs); } },
    strokeText: (x: MU, st: MU, ctm: MU, cs: MU, c: MU, a: number) => { try { t.strokeText(x, st, ctm, cs, c, a); } finally { done(x, st, cs); } },
    clipText: (x: MU, ctm: MU) => { try { t.clipText(x, ctm); } finally { done(x); } },
    clipStrokeText: (x: MU, st: MU, ctm: MU) => { try { t.clipStrokeText(x, st, ctm); } finally { done(x, st); } },
    ignoreText: (x: MU, ctm: MU) => { try { t.ignoreText(x, ctm); } finally { done(x); } },
    fillShade: (sh: MU, ctm: MU, a: number) => { borrowed(sh); t.fillShade(sh, ctm, a); },
    fillImage: (im: MU, ctm: MU, a: number) => { try { t.fillImage(im, ctm, a); } finally { done(im); } },
    fillImageMask: (im: MU, ctm: MU, cs: MU, c: MU, a: number) => { try { t.fillImageMask(im, ctm, cs, c, a); } finally { done(im, cs); } },
    clipImageMask: (im: MU, ctm: MU) => { try { t.clipImageMask(im, ctm); } finally { done(im); } },
    popClip: () => t.popClip(),
    beginMask: (r: MU, lum: boolean, cs: MU, c: MU) => { try { t.beginMask(r, lum, cs, c); } finally { done(cs); } },
    endMask: () => t.endMask(),
    beginGroup: (r: MU, cs: MU, iso: boolean, ko: boolean, bm: MU, a: number) => { try { t.beginGroup(r, cs, iso, ko, bm, a); } finally { done(cs); } },
    endGroup: () => t.endGroup(),
    beginTile: (r: MU, v: MU, xs: number, ys: number, ctm: MU, tid: number, did: number) => t.beginTile(r, v, xs, ys, ctm, tid, did),
    endTile: () => t.endTile(),
    beginLayer: (n: string) => t.beginLayer(n),
    endLayer: () => t.endLayer(),
  });
}
/** the narrowest line in the comparison's pictures, in page points: one pixel of the first full
 *  picture of the page (its scale - the old sheet's includes the A1 -> A0 enlargement), kept for the
 *  close looks after it. Small pictures (thumbnails) are drawn as they are. */
const minLine = new Map<string, number>();
function minLineFor(id: string, pg: number, scale: number): number {
  const k = id + '#' + pg;
  const had = minLine.get(k);
  if (had !== undefined) return had;
  if (scale < 1) return 0;
  const v = Math.round((1 / scale) * 10000) / 10000;
  minLine.set(k, v);
  return v;
}
function listOf(id: string, pg: number, annots: boolean, minPt = 0): MU {
  const d = mdoc(id);
  const key = pg + (annots ? '+a' : '@' + minPt);
  const have = d.lists.get(key);
  if (have) { have.t = performance.now(); return have.list; }
  const page = d.doc.loadPage(pg);
  let list: MU;
  try {
    // page contents only for the comparison (as PDFium draws it there); with markups for the viewer
    if (annots) list = page.toDisplayList(true);
    else {
      list = new mu.DisplayList(page.getBounds());
      const ld = new mu.DisplayListDevice(list);
      const dev = minPt > 0 ? minWidthDevice(ld, minPt) : ld;
      try { page.runPageContents(dev, mu.Matrix.identity); dev.close(); } finally { if (dev !== ld) dev.destroy?.(); ld.destroy?.(); }
    }
  } finally { page.destroy?.(); }
  d.lists.set(key, { list, t: performance.now() });
  while (d.lists.size > KEEP) {
    let old = '', ot = Infinity;
    for (const [k, v] of d.lists) if (k !== key && v.t < ot) { ot = v.t; old = k; }
    if (!old) break;
    try { d.lists.get(old)!.list.destroy?.(); } catch { /* */ }
    d.lists.delete(old);
  }
  return list;
}

/** let go of the drawn-once pages (memory) - the document stays open */
export function dropMuLists(id?: string) {
  for (const [k, d] of mdocs) {
    if (id && k !== id) continue;
    for (const v of d.lists.values()) try { v.list.destroy?.(); } catch { /* */ }
    d.lists.clear();
    dropTiles(d);
  }
}

// ---------------------------------------------------------------- tiles (the viewer)
// A heavy blended sheet is ~735 000 strokes, each in a blend group of its own: drawing any picture
// walks all 2.2 million display list entries - ~1 s even for a picture of nothing. Cut into tiles,
// a close look walks only the tiles it shows. Each tile's list holds every object that reaches into
// it (in page order), wrapped in the clips and groups it was drawn in; a picture draws each tile
// clipped to whole pixels of its own, so every pixel is drawn by exactly one tile's list - the same
// pixels as the whole list (tests/check-tiles.ts). Made for the next sheet by the view engine that
// makes it ready (2-5 s a page, in the background); pages it can't cut this way are drawn whole.
const [COLS, ROWS] = (process.env.RR_TILES || "8x6").split("x").map(Number);
/** reach (points) beyond an object's own bounds: its edge pixels at the smallest zoom tiles serve */
const REACH = 14;
/** a group this big (share of the page) does not say where what is in it lies - its own bounds do
 *  (a page drawn inside one big group put everything in every tile: 48 times the memory) */
const BIG_GROUP = 0.25;
/** more copies than this per object on average: the page is not cut (memory) */
const MAX_COPIES = 6;
/** tile rects reach this far past the page (points): the pixels just past its edge have a tile */
const PAST = 1e5;
/** (tests: tiles for every picture they can serve) */
const FORCE_TILES = process.env.RR_TILES_FORCE === '1';
/** pixels drawn round a tile's own, not kept (see runTiles) */
const TILE_PAD = 4;
/** tiles serve pictures at least this many pixels per point (smaller: the whole list) */
const TILE_MIN_ZOOM = 0.15;

/** cut a page "as shown" (contents and markups) into tiles: false when it can't be */
export function buildTiles(id: string, pg: number): boolean {
  if (!mu) return false;
  const d = mdoc(id);
  if (d.tiles.has(pg)) return !!d.tiles.get(pg);
  const page = d.doc.loadPage(pg);
  const lists: MU[] = [], devs: MU[] = [];
  let ok = true;
  try {
    const b = page.getBounds();
    // (the outer tiles reach far past the page: what is drawn just over its edge has a tile too)
    const xs = Array.from({ length: COLS + 1 }, (_, i) => (i === 0 ? b[0] - PAST : i === COLS ? b[2] + PAST : b[0] + ((b[2] - b[0]) * i) / COLS));
    const ys = Array.from({ length: ROWS + 1 }, (_, i) => (i === 0 ? b[1] - PAST : i === ROWS ? b[3] + PAST : b[1] + ((b[3] - b[1]) * i) / ROWS));
    const pageArea = (b[2] - b[0]) * (b[3] - b[1]);
    const rects: number[][] = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) rects.push([xs[c], ys[r], xs[c + 1], ys[r + 1]]);
    for (const r of rects) { const l = new mu.DisplayList(r); lists.push(l); devs.push(new mu.DisplayListDevice(l)); }
    // clips and groups open now; each is opened in a tile only once something in it goes there
    interface Level { begin: (D: MU) => void; end: (D: MU) => void; open: Set<number>; keep: MU[]; rect?: number[] }
    const stack: Level[] = [];
    const all = rects.map((_, i) => i);
    const hit = (r: number[] | null): number[] => {
      if (!r || !(r[2] >= r[0]) || !(r[3] >= r[1])) return all;
      const c0 = Math.max(0, Math.floor(((r[0] - REACH - b[0]) / (b[2] - b[0])) * COLS)), c1 = Math.min(COLS - 1, Math.floor(((r[2] + REACH - b[0]) / (b[2] - b[0])) * COLS));
      const r0 = Math.max(0, Math.floor(((r[1] - REACH - b[1]) / (b[3] - b[1])) * ROWS)), r1 = Math.min(ROWS - 1, Math.floor(((r[3] + REACH - b[1]) / (b[3] - b[1])) * ROWS));
      const out: number[] = [];
      for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) out.push(rr * COLS + cc);
      return out;
    };
    // (the innermost group's area holds what is drawn in it - a small group, one object each on a
    //  heavy blended sheet; else the object's own bounds)
    const area = (own: () => number[] | null): number[] | null => {
      for (let i = stack.length - 1; i >= 0; i--) {
        const r = stack[i].rect;
        if (!r) continue;
        if ((r[2] - r[0]) * (r[3] - r[1]) < BIG_GROUP * pageArea) return r;
        break;
      }
      try { return own(); } catch { return null; }
    };
    // dead: given up on (it can't be cut, or would cost too much memory) - nothing more recorded.
    // Nothing may throw out of these callbacks: a throw through MuPDF's own frames leaves its
    // error stack broken (an ink colour mupdf.js can't pass on, for one) - the page is drawn whole
    let dead = false, objects = 0, copies = 0;
    const fail = () => { ok = false; dead = true; };
    const send = (r: number[] | null, f: (D: MU) => void) => {
      if (dead) return;
      objects++;
      try {
        for (const t of hit(r)) {
          for (const e of stack) if (!e.open.has(t)) { e.begin(devs[t]); e.open.add(t); }
          f(devs[t]);
          copies++;
        }
      } catch { fail(); }
      if (copies > MAX_COPIES * objects + 20000) fail();
    };
    const push = (begin: (D: MU) => void, end: (D: MU) => void, keep: MU[], rect?: number[]) => { stack.push({ begin, end, open: new Set(), keep, rect }); };
    const pop = () => {
      const e = stack.pop();
      if (!e) return;
      if (!dead) { try { for (const t of e.open) e.end(devs[t]); } catch { fail(); } }
      done(...e.keep);
    };
    const no = () => { fail(); };
    const dev = new mu.Device({
      close: () => {},
      fillPath: (p: MU, eo: boolean, ctm: MU, cs: MU, c: MU, a: number) => { try { send(area(() => p.getBounds(null, ctm)), (D) => D.fillPath(p, eo, ctm, cs, c, a)); } finally { done(p, cs); } },
      strokePath: (p: MU, st: MU, ctm: MU, cs: MU, c: MU, a: number) => { try { send(area(() => p.getBounds(st, ctm)), (D) => D.strokePath(p, st, ctm, cs, c, a)); } finally { done(p, st, cs); } },
      // (a clip's path is drawn with what is in it - kept until the clip ends)
      clipPath: (p: MU, eo: boolean, ctm: MU) => push((D) => D.clipPath(p, eo, ctm), (D) => D.popClip(), [p]),
      clipStrokePath: (p: MU, st: MU, ctm: MU) => push((D) => D.clipStrokePath(p, st, ctm), (D) => D.popClip(), [p, st]),
      fillText: (x: MU, ctm: MU, cs: MU, c: MU, a: number) => { try { send(area(() => x.getBounds(null, ctm)), (D) => D.fillText(x, ctm, cs, c, a)); } finally { done(x, cs); } },
      strokeText: (x: MU, st: MU, ctm: MU, cs: MU, c: MU, a: number) => { try { send(area(() => x.getBounds(st, ctm)), (D) => D.strokeText(x, st, ctm, cs, c, a)); } finally { done(x, st, cs); } },
      clipText: (x: MU, ctm: MU) => push((D) => D.clipText(x, ctm), (D) => D.popClip(), [x]),
      clipStrokeText: (x: MU, st: MU, ctm: MU) => push((D) => D.clipStrokeText(x, st, ctm), (D) => D.popClip(), [x, st]),
      ignoreText: (x: MU, ctm: MU) => { try { send(area(() => x.getBounds(null, ctm)), (D) => D.ignoreText(x, ctm)); } finally { done(x); } },
      // (pictures and shadings: drawn at once, everywhere they might be; MuPDF owns them)
      fillShade: (sh: MU, ctm: MU, a: number) => { borrowed(sh); send(area(() => null), (D) => D.fillShade(sh, ctm, a)); },
      // (pictures: MuPDF resamples a picture drawn in pieces a little differently - up to 82 levels
      //  seen - so a page with any is not cut; nor one with a picture as a clip, soft masks or tiling
      //  patterns: the page is drawn whole)
      fillImage: (im: MU) => { done(im); no(); },
      fillImageMask: (im: MU, _ctm: MU, cs: MU) => { done(im, cs); no(); },
      clipImageMask: (im: MU) => { done(im); no(); push(() => {}, () => {}, []); },
      popClip: () => pop(),
      beginMask: (_r: MU, _l: boolean, cs: MU) => { done(cs); no(); push(() => {}, () => {}, []); },
      endMask: () => { no(); },
      beginGroup: (r: number[], cs: MU, iso: boolean, ko: boolean, bm: MU, a: number) => push((D) => D.beginGroup(r, cs, iso, ko, bm, a), (D) => D.endGroup(), [cs], r),
      endGroup: () => pop(),
      beginTile: () => { no(); return 0; },
      endTile: () => { no(); },
      beginLayer: () => {},
      endLayer: () => {},
    });
    // (from the whole list when it is there - the page is not read again; else from the page)
    const whole = d.lists.get(pg + '+a');
    try { if (whole && !process.env.RR_TILES_FROM_PAGE) whole.list.run(dev, mu.Matrix.identity); else page.run(dev, mu.Matrix.identity); dev.close(); } finally { dev.destroy?.(); }
    while (stack.length) pop();
    for (const D of devs) { try { D.close(); } catch { ok = false; } }
    if (!ok) { for (const l of lists) l.destroy?.(); d.tiles.set(pg, null); return false; }
    d.tiles.set(pg, { rects, lists });
    // (the whole list is not needed any more: the tiles draw every picture "as shown")
    if (whole) { try { whole.list.destroy?.(); } catch { /* */ } d.lists.delete(pg + '+a'); }
    return true;
  } catch (e) {
    for (const l of lists) try { l.destroy?.(); } catch { /* */ }
    d.tiles.set(pg, null);
    console.error('tiles not made: ' + String((e as Error)?.message || e));
    return false;
  } finally {
    for (const D of devs) try { D.destroy?.(); } catch { /* */ }
    page.destroy?.();
  }
}

/** the page's tiles, when they serve this picture: an upright mapping (or turned by a hair - the old
 *  sheet lined up: under 0.001 a tile's pixels are within a few points of its rect, well inside
 *  REACH), not too small, and not most of the page while the whole list is there anyway (every tile
 *  then costs more than the list) */
function tilesFor(id: string, pg: number, m: number[], w: number, h: number): Tiles | null {
  const d = mdocs.get(id), t = d?.tiles.get(pg);
  if (!t || m[0] < TILE_MIN_ZOOM || m[3] < TILE_MIN_ZOOM || Math.abs(m[1]) > 1e-3 * m[0] || Math.abs(m[2]) > 1e-3 * m[3]) return null;
  if (d!.lists.has(pg + '+a') && !FORCE_TILES) {
    let n = 0;
    for (const [x0, y0, x1, y1] of t.rects) if (m[0] * x1 + m[4] > 0 && m[0] * x0 + m[4] < w && m[3] * y1 + m[5] > 0 && m[3] * y0 + m[5] < h) n++;
    if (n > 0.6 * t.rects.length) return null;
  }
  return t;
}

/**
 * Draw tiles (m: page space -> picture pixels, upright) into an RGB picture w x h (3 bytes a pixel,
 * white to start): each tile into a picture of its own - the whole pixels whose centres lie in it -
 * pasted in. (Clipped with a clip path instead, MuPDF draws through a mask: a level or two off here
 * and there.)
 */
function runTiles(T: Tiles, m: number[], out: Uint8Array, w: number, h: number) {
  for (let i = 0; i < T.rects.length; i++) {
    const [x0, y0, x1, y1] = T.rects[i];
    const X0 = Math.max(0, Math.round(m[0] * x0 + m[4])), X1 = Math.min(w, Math.round(m[0] * x1 + m[4]));
    const Y0 = Math.max(0, Math.round(m[3] * y0 + m[5])), Y1 = Math.min(h, Math.round(m[3] * y1 + m[5]));
    if (X1 <= X0 || Y1 <= Y0) continue;
    // (drawn a few pixels wider than kept where it meets another tile: MuPDF cuts a shape at a
    //  picture's edge, and the pixels right there come out a level or two off - at the picture's own
    //  edges it is cut just as the whole picture is)
    const bx0 = X0 > 0 ? X0 - TILE_PAD : 0, by0 = Y0 > 0 ? Y0 - TILE_PAD : 0;
    const bx1 = X1 < w ? X1 + TILE_PAD : w, by1 = Y1 < h ? Y1 + TILE_PAD : h;
    const pix = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [bx0, by0, bx1, by1], false);
    try {
      pix.clear(255);
      const dev = new mu.DrawDevice(mu.Matrix.identity, pix);
      try { T.lists[i].run(dev, m); dev.close(); } finally { dev.destroy?.(); }
      const px = pix.getPixels(), stride = pix.getStride ? pix.getStride() : (bx1 - bx0) * 3, n = (X1 - X0) * 3;
      for (let y = Y0; y < Y1; y++) { const a = (y - by0) * stride + (X0 - bx0) * 3; out.set(px.subarray(a, a + n), (y * w + X0) * 3); }
    } finally { pix.destroy?.(); }
  }
}

/** a picture as RGB bytes (w x h, 3 a pixel, rows packed): from the tiles, or the whole list */
function drawRGB(T: Tiles | null, list: MU, m: number[], w: number, h: number): Uint8Array {
  if (T) {
    const out = new Uint8Array(w * h * 3).fill(255);
    runTiles(T, m, out, w, h);
    return out;
  }
  const pix = new mu.Pixmap(mu.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  try {
    pix.clear(255);
    const dev = new mu.DrawDevice(mu.Matrix.identity, pix);
    try { list.run(dev, m); dev.close(); } finally { dev.destroy?.(); }
    // (getPixels is a view into MuPDF's memory: copied out before the picture is let go)
    const rgb = pix.getPixels(), stride = pix.getStride ? pix.getStride() : w * 3;
    if (stride === w * 3) return new Uint8Array(rgb);
    const out = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) out.set(rgb.subarray(y * stride, y * stride + w * 3), y * w * 3);
    return out;
  } finally { pix.destroy?.(); }
}

/** draw a region in colour: m = page space (points, top left, as shown) -> picture pixels, the same
 *  space and matrix PDFium's FPDF_RenderPageBitmapWithMatrix takes. RGBA out. */
export function muRGBA(id: string, pg: number, m: number[], w: number, h: number, annots: boolean): Uint8ClampedArray {
  const T = annots ? tilesFor(id, pg, m, w, h) : null;
  const rgb = drawRGB(T, T ? null : listOf(id, pg, annots), m, w, h);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) { const k = i * 4; out[k] = rgb[j]; out[k + 1] = rgb[j + 1]; out[k + 2] = rgb[j + 2]; out[k + 3] = 255; }
  return out;
}

/** the same as grey (the darkest of red, green, blue - as the PDFium path) */
export function muGray(id: string, pg: number, m: number[], w: number, h: number, minPt?: number, asShown = false): Gray {
  // (the viewer gives its narrowest line itself - one for every zoom: taken from the first picture's
  //  zoom, the whole sheet then the first close look read the page in twice, 3-7 s each on a heavy blended sheet.
  //  asShown: a page without markups, the viewer's - the same display list as its colour pictures)
  const T = asShown ? tilesFor(id, pg, m, w, h) : null;
  const list = T ? null : asShown ? listOf(id, pg, true) : listOf(id, pg, false, minPt ?? minLineFor(id, pg, Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))));
  const rgb = drawRGB(T, list, m, w, h);
  const px = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) { const r = rgb[j], g = rgb[j + 1], b = rgb[j + 2]; px[i] = r < g ? (r < b ? r : b) : (g < b ? g : b); }
  return { w, h, px };
}
