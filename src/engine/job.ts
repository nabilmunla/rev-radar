// Compare one sheet pair: draw both at the checking resolution, line the old one up with the
// new one, find the change areas, read the text changes inside them, make the pictures for
// the list and the first view. Runs in an engine process (or a test).
import * as pf from './pdfium';
import type { Word } from './pdfium';
import { diff, changeMask, pixelChange, findShift, defaultDiff, minPool, avgPool, minFilter, turned, tileShifts, tilePhase, fitDisplacement, mergeOverlaps, warpGray, bestMove, type Gray, type Area, type TileShift } from './compare';
import { textDiff, moveWords, phrases, type TextChange } from './textdiff';
import { encodePNG } from './png';
import { cloudRing, components } from './cloud';
import { patternShift } from './pattern';
import { movedParts, partAt, partRects, ownedOld, keepParts, type MovedParts, type MovedTrace } from './moved';

/** affine x' = a x + c y + e, y' = b x + d y + f as [a, b, c, d, e, f]; mul(A, B) = A after B */
export const mul = (A: number[], B: number[]) => [
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
];
export const invert = (m: number[]) => {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};
export const ID = [1, 0, 0, 1, 0, 0];

export interface Settings {
  /** checking resolution (dots per inch) */
  dpi: number;
  /** how far a line may move and still count as unchanged, mm on paper */
  tolMM: number;
  /** grey-level difference that counts (0-255) */
  contrast: number;
  /** changes closer than this (mm) join into one area */
  joinMM: number;
}
export const defaultSettings: Settings = { dpi: 150, tolMM: 0.25, contrast: 48, joinMM: 3 };

export interface ChangeArea {
  /** box in the new sheet's page space (points) */
  box: number[];
  add: number; rem: number;
  kind: 'added' | 'removed' | 'modified';
  text: TextChange[];
  /** words that only moved a little inside this area */
  moved: number;
  /** the area is a revision cloud and nothing else (taken off / put on) */
  cloud?: 'removed' | 'added';
  /** a dashed / hatched line drawn with its pattern slid along it: nothing moved */
  pattern?: boolean;
  /** not a change of the drawing: a view (box = its drawing) moved on the sheet by this much
   *  (points) - one item to review instead of the whole view as changed */
  shift?: { dx: number; dy: number; stretched?: boolean; shorter?: boolean };
  /** where a stretched part's lines got longer (or shorter): the seam - a change of its own */
  seam?: { by: number; shorter?: boolean };
}

export interface PairResult {
  ok: true;
  /** sizes of the pages (points, as shown) */
  oldSize: { w: number; h: number }; newSize: { w: number; h: number };
  /** old page space -> new page space */
  align: number[];
  alignInfo: { fit: number; fit0: number; turned: number; scale: number; moved: boolean; fine: string };
  areas: ChangeArea[];
  addPx: number; remPx: number; inkPx: number; oldInkPx: number;
  /** both sheets are scans (looser checking) */
  scan: boolean;
  /** one sheet is a scan, the other not: many small differences are unavoidable */
  scanMix: boolean;
  /** pixels per point the check ran at */
  scale: number;
  /** small picture of the new sheet for the list (PNG) */
  thumb: { png: Uint8Array; w: number; h: number };
  /** overlay picture for the first view (PNG) */
  preview: { png: Uint8Array; w: number; h: number };
  /** text on the sheets: words that changed but sit outside every change area are left out */
  textInfo: { oldWords: number; newWords: number };
  /** parts of the sheet that moved on their own (a plan placed elsewhere on the paper): the old
   *  sheet is lined up with each of them separately. Page space of the new sheet (points). */
  parts?: SheetPart[];
  ms: Record<string, number>;
}

export interface SheetPart {
  /** how far the part moved from the old sheet to the new one (points, after `align`) */
  dx: number; dy: number;
  /** its box, and the part itself as rectangles (points, new sheet) */
  box: number[];
  rects: number[][];
  /** the part's own mapping, old page space -> new page space (like `align` for the rest) */
  align: number[];
  /** lines stretched across its edge (see moved.ts); from 2: the drawing itself was stretched there
   *  (a floor made taller), not a view moved on the paper */
  joined?: number;
  stretched?: boolean;
  /** stretched the other way: the lines running into it got shorter (a floor made lower) */
  shorter?: boolean;
  /** the box of its ink (its box reaches into the empty paper round it) */
  inkBox?: number[];
}

/**
 * Rows of little wordless bits on one straight line (across it within 0.5 mm, gaps up to 15 mm):
 * their dashes redrawn elsewhere along the line, if the row as a whole is (see pattern.ts). Each
 * bit is then "pattern" - set aside like any dashes redrawn.
 */
function linePatterns(areas: ChangeArea[], o: Gray, n: Gray, opt: ReturnType<typeof defaultDiff>, sc: number, pxPerMm: number) {
  const mm = pxPerMm / sc; // points per mm
  for (const horiz of [true, false]) {
    const c = areas.filter((a) => !a.text.length && !a.cloud && !a.pattern && !a.shift && (horiz ? a.box[3] - a.box[1] : a.box[2] - a.box[0]) <= 1.5 * mm && (horiz ? a.box[2] - a.box[0] : a.box[3] - a.box[1]) <= 20 * mm);
    const across = (a: ChangeArea) => (horiz ? a.box[1] + a.box[3] : a.box[0] + a.box[2]) / 2;
    const along = (a: ChangeArea, k: number) => a.box[horiz ? k : k + 1];
    c.sort((p, q) => across(p) - across(q) || along(p, 0) - along(q, 0));
    const used = new Set<ChangeArea>();
    for (const a of c) {
      if (used.has(a)) continue;
      const row = c.filter((b) => !used.has(b) && Math.abs(across(b) - across(a)) <= 0.5 * mm).sort((p, q) => along(p, 0) - along(q, 0));
      // runs of the row with gaps up to 15 mm
      let run: ChangeArea[] = [];
      const flush = () => {
        if (run.length >= 3) {
          const x0 = Math.min(...run.map((b) => b.box[0])), y0 = Math.min(...run.map((b) => b.box[1])), x1 = Math.max(...run.map((b) => b.box[2])), y1 = Math.max(...run.map((b) => b.box[3]));
          const m = changeMask(o, n, opt, Math.floor(x0 * sc) - 1, Math.floor(y0 * sc) - 1, Math.ceil(x1 * sc) + 1, Math.ceil(y1 * sc) + 1);
          if (patternShift(o, n, m, pxPerMm)) for (const b of run) b.pattern = true;
        }
        run.forEach((b) => used.add(b));
        run = [];
      };
      for (const b of row) { if (run.length && along(b, 0) - along(run[run.length - 1], 2) > 15 * mm) flush(); run.push(b); }
      flush();
    }
  }
}

/** lines stretched across a moved part's edge that make it a stretched drawing, not a moved view
 *  (an elevation abutting its neighbour has one full-height edge) */
const STRETCHED = 1;

/** a scan: one big picture and little else drawn (an invisible OCR text layer doesn't count) */
const isScan = (k: { drawn: number; images: number; imageArea: number }) => k.images >= 1 && k.imageArea > 0.6 && k.drawn < 60;

/** at most this many pixels per page are checked (an A0 at 150 dpi is 35 million) */
const MAX_PX = 72e6;

/**
 * heavy: one of the sheets is a monster (millions of strokes, merged - see heavy.ts): only one page
 * is kept in the engine's memory at a time (two such pages filled its 2 GB), at the cost of
 * reading one of them in twice for the close looks.
 */
export function comparePair(oldId: string, oldPg: number, newId: string, newPg: number, s: Settings = defaultSettings, manualAlign?: number[] | null, heavy = false): PairResult {
  const ms: Record<string, number> = {};
  let t = performance.now();
  const lap = (k: string) => { const n = performance.now(); ms[k] = Math.round(n - t); t = n; };
  const os = pf.pageSizes(oldId)[oldPg], ns = pf.pageSizes(newId)[newPg];
  if (!os || !ns) throw new Error(!pf.pageSizes(oldId).length || !pf.pageSizes(newId).length ? 'This PDF has no pages' : 'Page not found');
  // page sizes as shown (rotation applied): load gives the shown size
  const nS = pf.loadPage(newId, newPg);
  let rawOld: Word[] | null = null, rawNew: Word[] | null = null;
  // (a monster: the new page is drawn and read, then let go before the old one is read in)
  const oS = heavy ? { w: 0, h: 0 } : pf.loadPage(oldId, oldPg);
  lap('load');
  let sc = s.dpi / 72;
  if (nS.w * nS.h * sc * sc > MAX_PX) sc = Math.sqrt(MAX_PX / (nS.w * nS.h));
  const W = Math.max(1, Math.round(nS.w * sc)), H = Math.max(1, Math.round(nS.h * sc));
  const n: Gray = pf.renderGray(newId, newPg, [sc, 0, 0, sc, 0, 0], W, H);
  let kindNew: ReturnType<typeof pf.pageKind> | null = null;
  if (heavy) {
    try { rawNew = pf.words(newId, newPg); } catch { /* text is a bonus */ }
    try { kindNew = pf.pageKind(newId, newPg); } catch { /* */ }
    pf.dropPages(newId);
    Object.assign(oS, pf.loadPage(oldId, oldPg));
  }
  lap('renderNew');

  // old page -> new page space before any shift: same size = as is; other size = scaled to
  // fit; turned the other way = a quarter turn
  let T0 = ID.slice(), turns = 0, k = 1;
  if (manualAlign) T0 = manualAlign.slice();
  else {
    const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(2, 0.004 * Math.max(a, b));
    const landscape = (z: { w: number; h: number }) => z.w >= z.h;
    if (!same(oS.w, nS.w) || !same(oS.h, nS.h)) {
      const swapped = landscape(oS) !== landscape(nS) && Math.abs(oS.w - oS.h) > 0.05 * Math.max(oS.w, oS.h);
      const ow = swapped ? oS.h : oS.w, oh = swapped ? oS.w : oS.h;
      const kw = nS.w / ow, kh = nS.h / oh;
      k = Math.abs(kw - kh) < 0.01 * Math.max(kw, kh) ? (kw + kh) / 2 : 1;
      if (swapped) { turns = 1; T0 = [0, k, -k, 0, k * oS.h, 0]; } // clockwise: (x, y) -> (h - y, x)
      else T0 = [k, 0, 0, k, 0, 0];
    }
  }
  let o: Gray = pf.renderGray(oldId, oldPg, mul([sc, 0, 0, sc, 0, 0], T0), W, H);
  lap('renderOld');
  let scan = false, scanMix = false;
  try { const so = isScan(pf.pageKind(oldId, oldPg)), sn = isScan(kindNew ?? pf.pageKind(newId, newPg)); scan = so && sn; scanMix = so !== sn; } catch { /* */ }

  let T = T0;
  /** the alignment before the fine passes (a plain move) */
  let Tplain = T0;
  let info = { fit: 1, fit0: 1, turned: turns, scale: k, moved: false, fine: '' };
  if (!manualAlign) {
    let sh = findShift(n, o);
    if (turns === 1 && sh.fit < 0.6) {
      // the quarter turn the other way: turn the old picture half round and try again
      const o2 = turned(o, 2);
      const sh2 = findShift(n, o2);
      if (sh2.fit > sh.fit) { T = mul([-1, 0, 0, -1, nS.w, nS.h], T0); info.turned = 3; }
    } else if (turns === 0 && sh.fit < 0.5) {
      // the same paper, issued upside down (/Rotate 180)?
      const o2 = turned(o, 2);
      const sh2 = findShift(n, o2);
      if (sh2.fit > sh.fit + 0.25) { T = mul([-1, 0, 0, -1, nS.w, nS.h], T0); info.turned = 2; }
    }
    // turned half round: drawn again through the exact page geometry (flipping the pixels would be
    // up to half a pixel off - a rounded picture size)
    if (T !== T0) { o = pf.renderGray(oldId, oldPg, mul([sc, 0, 0, sc, 0, 0], T), W, H); sh = findShift(n, o); }
    if (sh.dx || sh.dy) {
      o = shiftGray(o, sh.dx, sh.dy);
      T = mul([1, 0, 0, 1, sh.dx / sc, sh.dy / sc], T);
      info.moved = true;
    }
    info = { ...info, fit: sh.fit, fit0: sh.fit0 };
    // fine alignment: a sheet re-plotted a hair bigger / smaller / turned shows as shifts that
    // grow across the sheet; fit them and draw the old sheet again through the exact mapping
    // (measured again after each correction: rotation and uneven re-plots need a second pass)
    const o0 = o;
    Tplain = T;
    let Mcum = [1, 0, 0, 1, 0, 0];
    for (let pass = 0; pass < 4; pass++) {
      const st = { edge: 0 };
      const tsh = scan ? tilePhase(n, o, 512, st) : tileShifts(n, o, 5, 900, st);
      let m = fitDisplacement(tsh);
      // many tiles moved further than the fine search reaches (a re-plot a few tenths of a percent
      // bigger, fit-to-paper): measure on 4x smaller pictures first, then fine again next pass
      if (st.edge >= 2 && (!m || st.edge >= 0.25 * (tsh.length + st.edge))) {
        const f = 4;
        const tc = scan ? tilePhase(avgPool(n, f), avgPool(o, f), 256) : tileShifts(minPool(n, f), minPool(o, f), 6, Math.round(900 / f));
        const mc = fitDisplacement(tc, 1.2);
        if (process.env.RR_DEBUG) console.log('coarse', tc.length, 'edge', st.edge, mc && { A: mc.A.map((v) => +(v * 1e4).toFixed(3)), t: mc.t }, tc.map((t) => `${Math.round(t.cx)},${Math.round(t.cy)}:${t.dx.toFixed(1)},${t.dy.toFixed(1)}`).join(' '));
        if (mc) m = { A: mc.A, t: [mc.t[0] * f, mc.t[1] * f], used: mc.used, rms: mc.rms * f };
      }
      if (process.env.RR_DEBUG) console.log('pass', pass, 'tiles', tsh.length, 'model', m && { A: m.A.map((v) => +(v * 1e4).toFixed(3)), t: m.t.map((v) => +v.toFixed(2)), used: m.used, rms: +m.rms.toFixed(2) }, 'shifts', tsh.slice(0, 40).map((t) => `${t.dx.toFixed(1)},${t.dy.toFixed(1)}`).join(' '));
      if (!m) break;
      // (a vector sheet is re-plotted bigger / smaller / turned, never sheared or stretched one way:
      //  such a model is two groups of tiles fitted as one - a plan moved on the paper and the paper
      //  itself - and lining the sheet up with it spoils both; the moved plan is found later)
      if (!scan && (Math.abs(m.A[1] + m.A[2]) > 0.002 || Math.abs(m.A[0] - m.A[3]) > 0.003)) break;
      // largest displacement the model gives anywhere on the sheet
      const at = (x: number, y: number) => Math.hypot(m.A[0] * x + m.A[1] * y + m.t[0], m.A[2] * x + m.A[3] * y + m.t[1]);
      const worst = Math.max(at(0, 0), at(W, 0), at(0, H), at(W, H));
      if (worst <= (pass ? 0.5 : 0.75)) break;
      // d(q) = A q + t: old pixel u = q - d(q) lands on new pixel q  =>  q = (I - A)^-1 (u + t)
      const a = 1 - m.A[0], b = -m.A[1], c = -m.A[2], d = 1 - m.A[3];
      const det = a * d - b * c;
      const Mi = [d / det, -c / det, -b / det, a / det]; // inverse of [[a b][c d]] in [a, b, c, d] affine order
      const Mpx = [Mi[0], Mi[1], Mi[2], Mi[3], Mi[0] * m.t[0] + Mi[2] * m.t[1], Mi[1] * m.t[0] + Mi[3] * m.t[1]];
      const keep = { o, T, Mcum };
      T = mul([1 / sc, 0, 0, 1 / sc, 0, 0], mul(Mpx, mul([sc, 0, 0, sc, 0, 0], T)));
      // vector sheets are drawn again through the new mapping (sharp); scans are resampled
      // (PDFium ignores a fraction-of-a-degree turn of a picture)
      Mcum = mul(Mpx, Mcum);
      o = scan ? warpGray(o0, Mcum) : pf.renderGray(oldId, oldPg, mul([sc, 0, 0, sc, 0, 0], T), W, H);
      // keep it only if the sheets really match better now (a correction measured from noise in the
      // tiles - a few tenths of a pixel - would make things worse)
      const before = mismatch(keep.o, n), after = mismatch(o, n);
      if (process.env.RR_DEBUG) console.log('mismatch', before, '->', after);
      if (after >= before * 0.985) { o = keep.o; T = keep.T; Mcum = keep.Mcum; break; }
      info.moved = true;
      info.fine = `${(Math.hypot(T[0], T[1]) * 100).toFixed(3)}% · ${pass ? info.fine.split(' · ')[1] : worst.toFixed(1) + ' px'}`;
    }
  }
  lap('align');
  // the words of both sheets, now that both pages are loaded (read later, they would be parsed again)
  try { rawOld = pf.words(oldId, oldPg); if (!heavy) rawNew = pf.words(newId, newPg); } catch { /* text is a bonus */ }
  // (pages MuPDF draws: PDFium read them in for their words only - let go, a busy sheet holds
  // hundreds of MB there)
  if (rawOld && (heavy || rawNew) && pf.usesMu(newId, newPg)) { pf.releasePages(oldId); pf.releasePages(newId); }
  lap('words');

  const pxPerMm = sc * 72 / 25.4;
  const opt = defaultDiff(pxPerMm);
  // scanned sheets (one big picture each): paper grain, toner and a slight skew are not changes
  opt.r = Math.max(1, Math.round((scan ? Math.max(s.tolMM, 0.34) : s.tolMM) * pxPerMm));
  opt.t = scan ? Math.max(s.contrast, 64) : s.contrast;
  if (scan) opt.minAreaPx = Math.round(opt.minAreaPx * 1.3);
  opt.gap = Math.max(1, Math.round((s.joinMM * pxPerMm) / opt.block));
  // a thin band along the paper's edge is left out: content the sheet edge cuts off comes and
  // goes there when the old sheet is moved or scaled to line up
  if (process.env.RR_BOX) opt.debugBox = process.env.RR_BOX.split(',').map((v) => Math.round(Number(v) * sc));
  const e = Math.round(1.5 * pxPerMm);
  opt.ignore = [[0, 0, W, e], [0, H - e, W, H], [0, 0, e, H], [W - e, 0, W, H]];
  // overlay preview ~2400 px across
  const pfac = Math.max(1, Math.round(Math.max(W, H) / 2400));
  let d = diff(o, n, opt, pfac);
  lap('diff');
  // a plan moved on the paper on its own (much of the sheet changed): line the old sheet up with
  // each part separately
  let mp: MovedParts | null = null;
  /** per moved part: old page -> new page */
  let partT: number[][] = [];
  const k2 = (pxPerMm / 5.9) ** 2;
  // (not for scans, nor a scan against a vector sheet: its noise reads as moves)
  if (!scan && !scanMix && !heavy && process.env.RR_NOPARTS !== '1' && d.addPx + d.remPx >= Math.max(12000 * k2, 0.02 * d.inkPx)) {
    const trace: MovedTrace | undefined = process.env.RR_PARTS ? { cells: [], groups: [], comps: [] } : undefined;
    if (trace && process.env.RR_PARTS_PNG) {
      const at = process.env.RR_PARTS_PNG;
      trace.png = (name, px, w, h) => { void import('node:fs').then((fs) => fs.writeFileSync(`${at}-${name}.png`, encodePNG(px, w, h))); };
    }
    const tp = performance.now(), tlog = (k: string) => { if (process.env.RR_PARTS) console.log(`  [${k} ${Math.round(performance.now() - tp)} ms]`); };
    let r = movedParts(o, n, pxPerMm, d.blocks, opt.block, trace);
    tlog('found');
    let rebase: { dx: number; dy: number } | null = null;
    if (r?.rebase) {
      // the paper itself (border, title block) lines up another way: the sheet is lined up with
      // the paper, and the plan that the whole-sheet alignment followed becomes the moved part
      const { dx, dy } = r.rebase;
      const o2 = shiftGray(o, dx, dy);
      // (the strips the shift uncovers drawn afresh: the paper's border ran there)
      const Tr = mul([1, 0, 0, 1, dx / sc, dy / sc], T), P0 = mul([sc, 0, 0, sc, 0, 0], Tr);
      const strip = (x0: number, y0: number, sw: number, sh: number) => {
        if (sw <= 0 || sh <= 0) return;
        const g = pf.renderGray(oldId, oldPg, mul([1, 0, 0, 1, -x0, -y0], P0), sw, sh);
        for (let y = 0; y < sh; y++) o2.px.set(g.px.subarray(y * sw, y * sw + sw), (y0 + y) * W + x0);
      };
      if (dy > 0) strip(0, 0, W, dy); else if (dy < 0) strip(0, H + dy, W, -dy);
      if (dx > 0) strip(0, 0, dx, H); else if (dx < 0) strip(W + dx, 0, -dx, H);
      const d2 = diff(o2, n, opt);
      const r2 = movedParts(o2, n, pxPerMm, d2.blocks, opt.block, trace);
      if (r2 && !r2.rebase) { rebase = r.rebase; o = o2; d = d2; r = r2; T = mul([1, 0, 0, 1, dx / sc, dy / sc], T); info.moved = true; }
      else r = null;
    }
    if (trace) console.log('parts:', JSON.stringify(trace, null, 1));
    if (r && r.parts.length) {
      const m = r;
      const lab = (x: number, y: number) => m.label[((y / m.B) | 0) * m.gw + ((x / m.B) | 0)];
      // the rest of the sheet lined up again on its own ink (the whole-sheet fine alignment saw the
      // moved parts too), then each part on its own ink, starting from its whole-pixel move
      const keepBase = (x: number, y: number) => lab(x, y) === 0;
      // (the whole-sheet fine alignment, if any, was pulled towards the parts: a scale it fitted to
      //  them shows on the rest's own tiles and is corrected. When it followed the plan - the paper
      //  had to be lined up afresh - the rest starts again from the plain move)
      // (not lined up afresh: the whole-sheet alignment was mostly the rest's own - the parts were
      //  its outliers - so only a clear miss, half a pixel, is worth a new picture of the sheet:
      //  20 s on a sheet the second engine draws)
      let base = refine(oldId, oldPg, n, T, o, sc, [0, 0, W, H], keepBase, false, !rebase);
      if (rebase && info.fine) {
        // the whole-sheet fine alignment followed the plan: its scale may be the plan's alone (two
        // populations fitted at once) or the sheet's (re-plotted a hair smaller) - the rest is
        // also lined up from the plain move, and keeps whichever fits it better
        const Ts = mul([1, 0, 0, 1, rebase.dx / sc, rebase.dy / sc], Tplain);
        const alt = refine(oldId, oldPg, n, Ts, pf.renderGray(oldId, oldPg, mul([sc, 0, 0, sc, 0, 0], Ts), W, H), sc, [0, 0, W, H], keepBase);
        const kb = (i: number) => keepBase(i % W, (i / W) | 0);
        if (mismatch(alt.o, n, kb) < mismatch(base.o, n, kb)) base = alt;
      }
      if (process.env.RR_PARTS) console.log('base refined', base.T.map((v) => +v.toFixed(4)));
      tlog('base');
      if (base.T !== T) {
        const k = Math.hypot(base.T[0], base.T[1]) / Math.hypot(T0[0], T0[1]);
        info.fine = Math.abs(k - 1) >= 0.00005 ? `${(k * 100).toFixed(3)}%` : '';
      }
      T = base.T; o = base.o;
      const pics: Gray[] = [];
      partT = m.parts.map((p, k) => {
        const [x0, y0, x1, y1] = p.box, pw = x1 - x0, ph = y1 - y0;
        const start = new Uint8Array(pw * ph).fill(255);
        for (let y = 0; y < ph; y++) {
          const sy = y0 + y - p.dy;
          if (sy < 0 || sy >= H) continue;
          for (let x = 0; x < pw; x++) { const sx = x0 + x - p.dx; if (sx >= 0 && sx < W) start[y * pw + x] = o.px[sy * W + sx]; }
        }
        const rf = refine(oldId, oldPg, n, mul([1, 0, 0, 1, p.dx / sc, p.dy / sc], T), { w: pw, h: ph, px: start }, sc, p.box, (x, y) => lab(x, y) === k + 1, true);
        if (process.env.RR_PARTS) console.log('part', k + 1, 'refined', rf.passes, rf.T.map((v) => +v.toFixed(4)));
        tlog('part ' + (k + 1));
        pics.push(rf.o);
        return rf.T;
      });
      // each part's move from the rest's picture (its middle), pixels; and the whole mapping
      const moves = m.parts.map((p, k) => {
        const c = [(p.box[0] + p.box[2]) / 2 / sc, (p.box[1] + p.box[3]) / 2 / sc], D = mul(partT[k], invert(T));
        return [(D[0] * c[0] + D[2] * c[1] + D[4] - c[0]) * sc, (D[1] * c[0] + D[3] * c[1] + D[5] - c[1]) * sc];
      });
      const maps = m.parts.map((_, k) => { const D = mul(partT[k], invert(T)); return [D[0], D[1], D[2], D[3], D[4] * sc, D[5] * sc]; });
      // a "part" that, lined up exactly, hardly moved (under the tolerance) is no moved view: it
      // was the rest seen through a rough first alignment
      const keep = moves.map((d) => Math.hypot(d[0], d[1]) >= Math.max(1.5, s.tolMM * pxPerMm));
      const nD = m.nD ?? minFilter(n, 1);
      const m2 = keep.every(Boolean) ? m : keepParts(m, keep);
      partT = partT.filter((_, k) => keep[k]);
      if (m2.parts.length) {
        mp = m2;
        o = ownedOld(o, m2, pics.filter((_, k) => keep[k]), maps.filter((_, k) => keep[k]), nD);
      }
      m.nD = undefined;
      d = diff(o, n, opt, pfac);
      tlog('diff');
    }
    lap('parts');
  }
  if ((globalThis as { __keep?: boolean }).__keep) (globalThis as { __last?: unknown }).__last = { o, n, opt, mp };

  // text: words of both sheets, old moved into new space (describes the areas, and is a second
  // detector: a word that changed in place but escaped the picture check - "100" -> "150" in
  // small text - becomes a change of its own, if the pictures differ there at all)
  let tw = { oldWords: 0, newWords: 0 };
  let tchanges: TextChange[] = [];
  try {
    const ow = moveWords(rawOld ?? pf.words(oldId, oldPg), T);
    // words of a moved part: moved with it (where they were and where they went both in it)
    if (mp) for (const w of ow) {
      const cx = ((w.x0 + w.x1) / 2) * sc, cy = ((w.y0 + w.y1) / 2) * sc;
      const k = partAt(mp, cx, cy);
      if (!k) continue;
      const p = mp.parts[k - 1];
      if (partAt(mp, cx + p.dx, cy + p.dy) !== k) continue;
      // (the word drawn through the part's own mapping: old page -> new page)
      const D = mul(partT[k - 1], invert(T));
      const a = [D[0] * w.x0 + D[2] * w.y0 + D[4], D[1] * w.x0 + D[3] * w.y0 + D[5]], b = [D[0] * w.x1 + D[2] * w.y1 + D[4], D[1] * w.x1 + D[3] * w.y1 + D[5]];
      w.x0 = Math.min(a[0], b[0]); w.x1 = Math.max(a[0], b[0]); w.y0 = Math.min(a[1], b[1]); w.y1 = Math.max(a[1], b[1]);
    }
    const nw = rawNew ?? (heavy ? [] : pf.words(newId, newPg));
    tw = { oldWords: ow.length, newWords: nw.length };
    // (scans: the words are an OCR layer - its reading errors differ between two scans)
    // (one issue without a text layer - a scan, an outlined print - and the other with one: every
    //  word would read "added" / "removed"; the pictures still show what changed)
    const oneSided = Math.min(ow.length, nw.length) < 0.1 * Math.max(ow.length, nw.length) && Math.max(ow.length, nw.length) >= 20;
    if (!scan && !oneSided && (ow.length || nw.length)) tchanges = textDiff(ow, nw, Math.max(1.2, (opt.r + 1) / sc));
  } catch { /* text is a bonus */ }
  const pxAreas = d.areas.map((a: Area) => [a.x0 / sc, a.y0 / sc, a.x1 / sc, a.y1 / sc]);
  const inside = (b: number[], pad = 1.5) => pxAreas.some((q) => (b[0] + b[2]) / 2 >= q[0] - pad && (b[0] + b[2]) / 2 <= q[2] + pad && (b[1] + b[3]) / 2 >= q[1] - pad && (b[1] + b[3]) / 2 <= q[3] + pad);
  const extra: Area[] = [];
  const looks: { c: TextChange; x0: number; y0: number; x1: number; y1: number; dif: number }[] = [];
  // (a monster sheet: every close look draws all its millions of pieces - a few only)
  const maxLooks = heavy ? 12 : 400;
  if (!scan) for (const c of tchanges) {
    if (c.kind === 'moved' || inside(c.box)) continue;
    // visible? count pixels that differ inside the word's box
    const x0 = Math.max(0, Math.floor(c.box[0] * sc) - 1), x1 = Math.min(W - 1, Math.ceil(c.box[2] * sc) + 1);
    const y0 = Math.max(0, Math.floor(c.box[1] * sc) - 1), y1 = Math.min(H - 1, Math.ceil(c.box[3] * sc) + 1);
    let dif = 0, ink = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (Math.abs(o.px[i] - n.px[i]) > 40) dif++;
      if (n.px[i] < 160 || o.px[i] < 160) ink++;
    }
    if (dif < 2 || ink < 4 || looks.length >= maxLooks) continue;
    looks.push({ c, x0, y0, x1, y1, dif });
  }
  // ...and seen up close: both sheets drawn again at 4x around the word, and the change rule (with
  // its tolerance) applied there. A look-alike digit (6 -> 9 in 2 mm text) shows plainly; a word
  // that only came out differently in the text layer (outlines, re-encoded fonts) shows nothing
  const Tof = (box: number[]) => {
    const k = mp ? partAt(mp, ((box[0] + box[2]) / 2) * sc, ((box[1] + box[3]) / 2) * sc) : 0;
    return k ? partT[k - 1] : T;
  };
  const closeN = closeLooks(oldId, oldPg, newId, newPg, looks.map((l) => Tof(l.c.box)), looks.map((l) => l.c.box), sc * 4, s, heavy);
  looks.forEach(({ c, x0, y0, x1, y1, dif }, k) => {
    const close = closeN[k];
    if (process.env.RR_DEBUG) console.log('close look', c.kind, c.from, c.to, 'dif', dif, 'changed px', close);
    if (close >= 12) {
      const pad = 2;
      extra.push({ x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad, add: c.kind === 'removed' ? 0 : dif, rem: c.kind === 'added' ? 0 : dif });
      pxAreas.push([(x0 - pad) / sc, (y0 - pad) / sc, (x1 + pad) / sc, (y1 + pad) / sc]);
    }
  });
  // (the pages stay loaded until the close looks are done: loading a dense A0 page again costs
  //  seconds)
  pf.dropPages();
  // a word change that overlaps a picture area joins it (one area, not two on top of each other)
  for (const x of extra.length ? mergeOverlaps(extra, 2) : []) {
    const hit = d.areas.find((a: Area) => a.x0 <= x.x1 && x.x0 <= a.x1 && a.y0 <= x.y1 && x.y0 <= a.y1);
    if (hit) { hit.x0 = Math.min(hit.x0, x.x0); hit.y0 = Math.min(hit.y0, x.y0); hit.x1 = Math.max(hit.x1, x.x1); hit.y1 = Math.max(hit.y1, x.y1); hit.add += x.add; hit.rem += x.rem; }
    else d.areas.push(x);
  }
  lap('text');

  const kindOf = (add: number, rem: number): ChangeArea['kind'] => add && rem ? (Math.min(add, rem) < 0.04 * Math.max(add, rem) ? (add > rem ? 'added' : 'removed') : 'modified') : add ? 'added' : 'removed';
  const describe = (box: number[], add: number, rem: number): ChangeArea => {
    const pad = 1.5;
    const mine = tchanges.filter((c) => {
      const mx = (c.box[0] + c.box[2]) / 2, my = (c.box[1] + c.box[3]) / 2;
      return mx >= box[0] - pad && mx <= box[2] + pad && my >= box[1] - pad && my <= box[3] + pad;
    });
    return { box, add, rem, kind: kindOf(add, rem), text: phrases(mine).filter((t) => t.kind !== 'moved').slice(0, 40), moved: mine.filter((t) => t.kind === 'moved').length };
  };
  const areas: ChangeArea[] = d.areas.flatMap((a: Area) => {
    const out = describe([a.x0 / sc, a.y0 / sc, a.x1 / sc, a.y1 / sc], a.add, a.rem);
    // a revision cloud taken off or put on (no words changed in it). Only the ring itself is the
    // cloud: anything else that changed in the area - inside the cloud being removed, beside it -
    // stays a change of its own
    if (!out.text.length && a.x1 - a.x0 >= 6 * pxPerMm && a.y1 - a.y0 >= 6 * pxPerMm) {
      const mk = changeMask(o, n, opt, a.x0 - 2, a.y0 - 2, a.x1 + 2, a.y1 + 2);
      const { comps, label } = components(mk);
      // the ring: the pieces lying along the outline of everything that changed here (a cloud
      // crossing other lines comes out in several arcs); pieces inside are something else
      let bx0 = mk.w, by0 = mk.h, bx1 = -1, by1 = -1;
      for (const q of comps) { if (q.x0 < bx0) bx0 = q.x0; if (q.y0 < by0) by0 = q.y0; if (q.x1 > bx1) bx1 = q.x1; if (q.y1 > by1) by1 = q.y1; }
      const band = Math.max(3, Math.min(6 * pxPerMm, 0.3 * Math.min(bx1 - bx0 + 1, by1 - by0 + 1)));
      const inBand = new Map<number, number>(), edge = new Map<number, number>();
      for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
        const l = label[y * mk.w + x];
        if (!l) continue;
        const dd = Math.min(x - bx0, bx1 - x, y - by0, by1 - y);
        if (dd <= band) inBand.set(l, (inBand.get(l) || 0) + 1);
        if (dd < (edge.get(l) ?? Infinity)) edge.set(l, dd);
      }
      // (each arc reaches the outline; a line a few mm inside it doesn't. And a ring taken off
      //  is all removed ink: something added beside it is a change)
      const ringBit = comps[0] && comps[0].rem >= comps[0].add ? 1 : 2;
      const ringIds = new Set(comps.filter((q) => (inBand.get(q.id) || 0) >= 0.95 * q.n && (edge.get(q.id) ?? Infinity) <= Math.max(2, pxPerMm)
        && (ringBit === 1 ? q.rem >= q.add * 9 : q.add >= q.rem * 9)).map((q) => q.id));
      const ringN = comps.filter((q) => ringIds.has(q.id)).reduce((t, q) => t + q.n, 0);
      if (ringN >= 0.5 * comps.reduce((t, q) => t + q.n, 0)) {
        const rm = new Uint8Array(mk.m.length);
        let rx0 = mk.w, ry0 = mk.h, rx1 = -1, ry1 = -1, ra = 0, rr = 0;
        for (let i = 0; i < rm.length; i++) if (ringIds.has(label[i])) {
          rm[i] = mk.m[i];
          const x = i % mk.w, y = (i / mk.w) | 0;
          if (x < rx0) rx0 = x; if (x > rx1) rx1 = x; if (y < ry0) ry0 = y; if (y > ry1) ry1 = y;
          if (mk.m[i] & 1) rr++; if (mk.m[i] & 2) ra++;
        }
        const c = cloudRing({ ...mk, m: rm }, pxPerMm, n);
        if (process.env.RR_CLOUD) console.log('cloud?', out.box.map(Math.round).join(','), out.kind, c.cloud, c.why, 'pieces', comps.length, 'ring pieces', ringIds.size);
        if (c.cloud) {
          const pb = (x0: number, y0: number, x1: number, y1: number) => [(mk.x0 + x0) / sc, (mk.y0 + y0) / sc, (mk.x0 + x1 + 1) / sc, (mk.y0 + y1 + 1) / sc];
          const cl = describe(pb(rx0, ry0, rx1, ry1), ra, rr);
          cl.cloud = c.cloud;
          const rest = comps.filter((q) => !ringIds.has(q.id) && q.n >= opt.minAreaPx).map((q) => describe(pb(q.x0, q.y0, q.x1, q.y1), q.add, q.rem));
          return [cl, ...rest];
        }
      }
    }
    if (!out.text.length && out.kind === 'modified' && Math.max(a.x1 - a.x0, a.y1 - a.y0) <= 80 * pxPerMm) {
      if (patternShift(o, n, changeMask(o, n, opt, a.x0 - 1, a.y0 - 1, a.x1 + 1, a.y1 + 1), pxPerMm)) out.pattern = true;
    }
    return [out];
  });
  // a dashed line drawn again along its whole length (made longer at one end: a bay made wider)
  // comes out as a row of little bits, each too short to tell on its own: the row as one
  linePatterns(areas, o, n, opt, sc, pxPerMm);

  // biggest first is not useful for walking a sheet: reading order (top to bottom, left to right in bands)
  const band = Math.max(nS.h / 12, 1);
  areas.sort((p, q) => (Math.floor(p.box[1] / band) - Math.floor(q.box[1] / band)) || (p.box[0] - q.box[0]));
  // each view moved on the sheet: one item of its own, first (what it holds that changed is listed
  // as usual). Never hidden as "title block": a building moved on a site plan looks just the same.
  const moveItems: ChangeArea[] = [];
  if (mp) mp.parts.forEach((p, k) => {
    const b = (p.inkBox.length ? p.inkBox : p.box).map((v) => v / sc), c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const D = mul(partT[k], invert(T));
    moveItems.push({ box: b, add: p.ink, rem: p.ink, kind: 'modified', text: [], moved: 0, shift: { dx: D[0] * c[0] + D[2] * c[1] + D[4] - c[0], dy: D[1] * c[0] + D[3] * c[1] + D[5] - c[1], ...((p.joined ?? 0) >= STRETCHED ? { stretched: true, ...(p.shorter ? { shorter: true } : {}) } : {}) } });
  });
  moveItems.sort((p, q) => (Math.floor(p.box[1] / band) - Math.floor(q.box[1] / band)) || (p.box[0] - q.box[0]));
  // a stretched part: where its lines got longer - the seam, a change of its own (the move item
  // only says the part moved): the crossings on one edge line, 3 mm round them
  if (mp) mp.parts.forEach((p, k) => {
    if ((p.joined ?? 0) < STRETCHED || !p.seams?.length) return;
    // (one edge line: crossings of the same kind within 6 mm across it - the part's edge runs in
    //  steps of a block)
    const near = 3 * pxPerMm, clusters: number[][] = [];
    for (const ax of [0, 1]) {
      const list = p.seams.filter((q) => q[2] === ax).sort((a, b) => (ax ? a[0] - b[0] : a[1] - b[1]));
      let c: number[] | null = null;
      for (const [x, y, , grow] of list) {
        if (c && (ax ? x - c[2] : y - c[3]) <= 2 * near) { c[0] = Math.min(c[0], x); c[1] = Math.min(c[1], y); c[2] = Math.max(c[2], x); c[3] = Math.max(c[3], y); c.push(grow); }
        else { c = [x, y, x, y, grow]; clusters.push(c); }
      }
    }
    for (const c of clusters) {
      const box = [(c[0] - near) / sc, (c[1] - near) / sc, (c[2] + near) / sc, (c[3] + near) / sc];
      const g = c.slice(4).sort((a, b) => a - b), by = g[g.length >> 1] / sc;
      areas.push({ ...describe(box, 0, 0), kind: 'modified', seam: { by, ...(p.shorter ? { shorter: true } : {}) } });
    }
  });
  areas.sort((p, q) => (Math.floor(p.box[1] / band) - Math.floor(q.box[1] / band)) || (p.box[0] - q.box[0]));
  areas.unshift(...moveItems);

  // list picture (~480 across): average of the new sheet
  const tf = Math.max(1, Math.round(Math.max(W, H) / 480));
  const thumb = avgThumb(n, tf);
  const thumbPng = encodePNG(thumb.px, thumb.w, thumb.h, 4);
  const prev = d.preview!;
  const prevPng = encodePNG(prev.px, prev.w, prev.h, 3);
  lap('pictures');

  return {
    ok: true,
    oldSize: { w: oS.w, h: oS.h }, newSize: { w: nS.w, h: nS.h },
    align: T, alignInfo: info,
    areas, addPx: d.addPx, remPx: d.remPx, inkPx: d.inkPx, oldInkPx: d.oldInkPx, scan, scanMix, scale: sc,
    thumb: { png: thumbPng, w: thumb.w, h: thumb.h },
    preview: { png: prevPng, w: prev.w, h: prev.h },
    textInfo: tw,
    ...(mp ? { parts: mp.parts.map((p, k) => [p, k, p.inkBox.length ? p.inkBox : p.box] as const).sort(([, , p], [, , q]) => (Math.floor(p[1] / sc / band) - Math.floor(q[1] / sc / band)) || (p[0] - q[0])).map(([p, k]) => {
      // how far the part moved: its middle drawn through its own mapping vs the sheet's
      const box = p.box.map((v) => v / sc), c = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      const D = mul(partT[k], invert(T));
      return { dx: D[0] * c[0] + D[2] * c[1] + D[4] - c[0], dy: D[1] * c[0] + D[3] * c[1] + D[5] - c[1], box, rects: partRects(mp!, k + 1).map((r) => r.map((v) => v / sc)), align: partT[k], joined: p.joined ?? 0, stretched: (p.joined ?? 0) >= STRETCHED, ...((p.joined ?? 0) >= STRETCHED && p.shorter ? { shorter: true } : {}), inkBox: (p.inkBox.length ? p.inkBox : p.box).map((v) => v / sc) };
    }) } : {}),
    ms,
  };
}

/**
 * Fine alignment of one part of the sheet on its own ink: box = the part's box (pixels of n), o =
 * the old picture of that box as lined up so far (through T), keep = which pixels of n belong to the
 * part. Like the whole-sheet passes; the old sheet is drawn again only when it matches better.
 */
function refine(oldId: string, oldPg: number, n: Gray, T: number[], o: Gray, sc: number, box: number[], keep: (x: number, y: number) => boolean, moveOnly = false, light = false): { T: number[]; o: Gray; passes: number } {
  const [bx0, by0, bx1, by1] = box, w = bx1 - bx0, h = by1 - by0;
  const whole = bx0 === 0 && by0 === 0 && w === n.w && h === n.h;
  let nc = n;
  if (!whole) {
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) px.set(n.px.subarray((by0 + y) * n.w + bx0, (by0 + y) * n.w + bx0 + w), y * w);
    nc = { w, h, px };
  }
  const P = [sc, 0, 0, sc, -bx0, -by0], Pi = invert(P);
  const kp = (i: number) => keep(bx0 + (i % w), by0 + ((i / w) | 0));
  const tile = Math.max(240, Math.min(900, Math.round(Math.max(w, h) / 3)));
  // tiles for the fraction-of-a-pixel moves: about 4 x 3 over the box, none under ~25 mm
  const tw = Math.max(150, Math.round(Math.max(w, h) / 4));
  const gx = Math.max(1, Math.round(w / tw)), gy = Math.max(1, Math.round(h / tw));
  let cur = o, Tc = T, passes = 0;
  for (let pass = 0; pass < 3; pass++) {
    // whole pixels first (the tiles' search), then the fraction of a pixel per tile, from the
    // pictures themselves (the tiles' own estimates lean towards whole pixels). A scale / turn
    // only where the tiles clearly show one (one fitted to a few tiles' noise would put the far
    // edge off by a fraction of a pixel - faint lines show that). A part moved on the paper keeps
    // the rest's scale unless its own tiles clearly differ.
    const ts = tileShifts(nc, cur, 5, tile, undefined, kp, true);
    const med = (a: number[]) => a.slice().sort((p, q) => p - q)[a.length >> 1];
    const t0 = ts.length >= 3 ? [med(ts.map((q) => q.dx)), med(ts.map((q) => q.dy))] : [0, 0];
    if (Math.abs(t0[0]) > 1.5 || Math.abs(t0[1]) > 1.5) {
      if (ts.length < 3) break;
    } else {
      // (an axis a tile can't tell - lines one way only - or a move at the edge of the search is
      //  left out; the scale / turn only from tiles that tell both)
      const fine: TileShift[] = [], fx: number[] = [], fy: number[] = [];
      for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
        const r = [Math.floor((i * w) / gx), Math.floor((j * h) / gy), Math.floor(((i + 1) * w) / gx), Math.floor(((j + 1) * h) / gy)];
        const bm = bestMove(nc, cur, kp, 1.25, 8000, r);
        if (!bm || bm.n < 600) continue;
        const okX = bm.sharpX >= 0.05 && Math.abs(bm.dx) < 1.45, okY = bm.sharpY >= 0.05 && Math.abs(bm.dy) < 1.45;
        if (okX) fx.push(bm.dx);
        if (okY) fy.push(bm.dy);
        if (okX && okY) fine.push({ cx: (r[0] + r[2]) / 2, cy: (r[1] + r[3]) / 2, dx: bm.dx, dy: bm.dy, fit: 1, n: bm.n });
      }
      if (fx.length >= 3 && fy.length >= 3) { ts.length = 0; ts.push(...fine); t0[0] = med(fx); t0[1] = med(fy); }
      else { const bm = bestMove(nc, cur, kp, 1.25); if (!bm) break; t0[0] = bm.dx; t0[1] = bm.dy; ts.length = 0; }
    }
    let m = { A: [0, 0, 0, 0], t: t0, used: ts.length, rms: 0 };
    if (process.env.RR_PARTS) console.log('  refine pass', pass, 'tiles', ts.length, 'move', t0.map((v) => +v.toFixed(3)), ts.map((q) => `${q.dx.toFixed(2)},${q.dy.toFixed(2)}`).join(' '));
    const aff0 = ts.length >= 6 && !light ? fitDisplacement(ts, 0.6) : null;
    // (no shear / one-way stretch: see the whole-sheet fine alignment)
    const aff = aff0 && Math.abs(aff0.A[1] + aff0.A[2]) <= 0.002 && Math.abs(aff0.A[0] - aff0.A[3]) <= 0.003 ? aff0 : null;
    if (aff) {
      const off = (x: number, y: number) => Math.hypot(aff.A[0] * x + aff.A[1] * y + aff.t[0] - m.t[0], aff.A[2] * x + aff.A[3] * y + aff.t[1] - m.t[1]);
      if (Math.max(off(0, 0), off(w, 0), off(0, h), off(w, h)) > (moveOnly ? 0.2 : 0.6)) m = aff;
    }
    const mm = m;
    const at = (x: number, y: number) => Math.hypot(mm.A[0] * x + mm.A[1] * y + mm.t[0], mm.A[2] * x + mm.A[3] * y + mm.t[1]);
    // (a part: to a tenth of a pixel - text edges a quarter pixel off show as specks - then only a
    //  clear miss (the estimate's own noise is ~0.15 px on sheets the second engine draws, seconds a
    //  picture); the rest of the sheet - drawn again whole for it - to a quarter, then a clear miss.
    //  Its scale / turn only on clear evidence: its tiles hold the real changes)
    if (Math.max(at(0, 0), at(w, 0), at(0, h), at(w, h)) <= (moveOnly ? (pass ? 0.2 : 0.08) : light ? 0.5 : pass ? 0.35 : 0.25)) break;
    const a = 1 - m.A[0], b = -m.A[1], c = -m.A[2], d = 1 - m.A[3], det = a * d - b * c;
    const Mi = [d / det, -c / det, -b / det, a / det];
    const Mpx = [Mi[0], Mi[1], Mi[2], Mi[3], Mi[0] * m.t[0] + Mi[2] * m.t[1], Mi[1] * m.t[0] + Mi[3] * m.t[1]];
    const Tn = mul(Pi, mul(Mpx, mul(P, Tc)));
    // (drawn again: moving the picture by resampling softens thin lines enough to show as changes)
    const on = pf.renderGray(oldId, oldPg, mul(P, Tn), w, h);
    if (mismatch(on, nc, kp) >= mismatch(cur, nc, kp) * 0.985) break;
    cur = on; Tc = Tn; passes++;
  }
  return { T: Tc, o: cur, passes };
}

/** how badly two pictures match: grey difference over the ink of either, inner 94 % of the sheet
 *  (keep: only those pixels) */
function mismatch(a: Gray, b: Gray, keep?: (i: number) => boolean): number {
  const { w, h } = b;
  const mx = Math.round(w * 0.03), my = Math.round(h * 0.03);
  let s = 0;
  // (one part of the sheet: every other row is plenty to choose between two pictures)
  for (let y = my; y < h - my; y += keep ? 2 : 1) {
    const r = y * w;
    for (let x = mx; x < w - mx; x++) {
      const p = a.px[r + x], q = b.px[r + x];
      if ((p < 200 || q < 200) && (!keep || keep(r + x))) s += p > q ? p - q : q - p;
    }
  }
  return s;
}

/**
 * Changed pixels around a word (page box), both sheets drawn at zoom z (pixels per point) with
 * 0.5 mm around it - the change rule with the usual tolerance in paper millimetres
 */
/** close looks at word boxes: changed pixels in each (the old sheet's pictures first, then the new
 *  one's - with a monster sheet only one page is in memory at a time) */
function closeLooks(oldId: string, oldPg: number, newId: string, newPg: number, Ts: number[][], boxes: number[][], z: number, s: Settings, heavy: boolean): number[] {
  const pad = 0.5 * 72 / 25.4;
  const spots = boxes.map((box) => {
    const x0 = Math.floor((box[0] - pad) * z), y0 = Math.floor((box[1] - pad) * z);
    const w = Math.min(1600, Math.ceil((box[2] - box[0] + 2 * pad) * z)), h = Math.min(1600, Math.ceil((box[3] - box[1] + 2 * pad) * z));
    return { S: [z, 0, 0, z, -x0, -y0], w, h, ok: w >= 4 && h >= 4 };
  });
  if (!spots.some((q) => q.ok)) return boxes.map(() => 0);
  const olds = spots.map((q, k) => (q.ok ? pf.renderGray(oldId, oldPg, mul(q.S, Ts[k]), q.w, q.h) : null));
  if (heavy) pf.dropPages(oldId);
  const out = spots.map((q, k) => {
    const o = olds[k];
    if (!o) return 0;
    const n = pf.renderGray(newId, newPg, q.S, q.w, q.h);
    const { w, h } = q;
    // (r at most 31: the neighbourhood sum is exact up to there - DECISIONS 142)
    const r = Math.min(31, Math.max(1, Math.round(s.tolMM * z * 72 / 25.4))), t = s.contrast;
    let c = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, dv = o.px[i] - n.px[i];
      if (dv <= t && dv >= -t) continue;
      if (pixelChange(o.px, n.px, i, x, y, w, h, r, t)) c++;
    }
    return c;
  });
  if (heavy) pf.dropPages(newId);
  return out;
}

function shiftGray(g: Gray, dx: number, dy: number): Gray {
  const out = new Uint8Array(g.w * g.h).fill(255);
  for (let y = 0; y < g.h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= g.h) continue;
    const x0 = Math.max(0, dx), x1 = Math.min(g.w, g.w + dx);
    if (x1 > x0) out.set(g.px.subarray(sy * g.w + (x0 - dx), sy * g.w + (x1 - dx)), y * g.w + x0);
  }
  return { w: g.w, h: g.h, px: out };
}

/** average-pooled grey picture as RGBA (a dense sheet stays readable small) */
/** the list picture of a sheet on its own (a new or removed sheet: nothing to compare it with) */
export function sheetThumb(id: string, pg: number): { png: Uint8Array; w: number; h: number } {
  const S = pf.loadPage(id, pg);
  const k = Math.min(4, 960 / Math.max(S.w, S.h));
  const g = pf.renderGray(id, pg, [k, 0, 0, k, 0, 0], Math.max(1, Math.round(S.w * k)), Math.max(1, Math.round(S.h * k)));
  pf.dropPages(id);
  const t = avgThumb(g, 2);
  return { png: encodePNG(t.px, t.w, t.h, 4), w: t.w, h: t.h };
}

function avgThumb(g: Gray, f: number): { w: number; h: number; px: Uint8ClampedArray } {
  const W = Math.ceil(g.w / f), H = Math.ceil(g.h / f);
  const sum = new Float32Array(W * H), cnt = new Float32Array(W * H);
  for (let y = 0; y < g.h; y++) {
    const r = ((y / f) | 0) * W, s = y * g.w;
    for (let x = 0; x < g.w; x++) { const i = r + ((x / f) | 0); sum[i] += g.px[s + x]; cnt[i]++; }
  }
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0, j = 0; i < W * H; i++, j += 4) {
    // darken: thin lines would vanish in a plain average
    const v = sum[i] / (cnt[i] || 1);
    const ink = Math.min(1, Math.pow((255 - v) / 255 * 2.5, 0.75));
    const c = 255 - ink * 220;
    px[j] = px[j + 1] = px[j + 2] = c; px[j + 3] = 255;
  }
  return { w: W, h: H, px };
}

// ---------------------------------------------------------------- pictures for the viewer

export type ViewMode = 'overlay' | 'old' | 'new';
/** the viewer's narrowest line on pages MuPDF draws: none (see viewPicture) */
const VIEW_MIN_PT = 0;
/** a moved part as the viewer needs it (see SheetPart) */
export interface ViewPart { align: number[]; box: number[]; rects: number[][] }

/**
 * A region of the view: rect = [x, y, w, h] in pixels of the new sheet at `zoom` pixels per
 * point. overlay = both sheets combined (tolerance scaled to the zoom), old / new = one sheet
 * in its own colours (old drawn in the new sheet's space so the two line up).
 */
export function viewPicture(oldId: string | null, oldPg: number, newId: string | null, newPg: number, align: number[], mode: ViewMode, zoom: number, rect: number[], s: Settings = defaultSettings, fade = 0.55, scan = false, parts?: ViewPart[]): Uint8ClampedArray {
  const [x, y, w, h] = rect.map((v) => Math.round(v));
  const S = [zoom, 0, 0, zoom, -x, -y];
  // pages MuPDF draws: lines as drawn, at every zoom - one display list per page for the whole look
  // (widened as for the comparison, the list took twice as long to read in, and a list per zoom
  // read the page in again: 3-7 s each on a heavy blended sheet; measured: no red / blue away from the listed changes
  // either way)
  const minNew = VIEW_MIN_PT;
  const grayOld = (m: number[], gw: number, gh: number) => pf.renderGray(oldId!, oldPg, m, gw, gh, VIEW_MIN_PT);
  // parts of the sheet that moved on their own: the old sheet drawn through each part's own
  // mapping there (as compared), so the overlay, the old sheet and flicker show only real changes
  const here = (parts ?? []).filter((p) => p.box[0] * zoom < x + w && p.box[2] * zoom > x && p.box[1] * zoom < y + h && p.box[3] * zoom > y);
  // a part's rects in this picture's pixels (cut to it)
  const spans = (p: ViewPart) => p.rects.map((r) => [Math.max(0, Math.round(r[0] * zoom) - x), Math.max(0, Math.round(r[1] * zoom) - y), Math.min(w, Math.round(r[2] * zoom) - x), Math.min(h, Math.round(r[3] * zoom) - y)]).filter((q) => q[2] > q[0] && q[3] > q[1]);
  /**
   * The old sheet through a part's own mapping, drawn only over the part (the box round its rects
   * in this picture: a whole extra picture per part made a sheet with two parts four drawings -
   * seconds each on a heavy blended sheet) and pasted into dst there. An integer move of the
   * drawing origin: the same pixels as drawing the whole picture.
   */
  const pastePart = <A extends Uint8Array | Uint8ClampedArray>(dst: A, bpp: number, p: ViewPart, draw: (m: number[], w: number, h: number) => A) => {
    const sp = spans(p);
    if (!sp.length) return;
    const bx0 = Math.min(...sp.map((q) => q[0])), by0 = Math.min(...sp.map((q) => q[1]));
    const bw = Math.max(...sp.map((q) => q[2])) - bx0, bh = Math.max(...sp.map((q) => q[3])) - by0;
    const src = draw(mul([zoom, 0, 0, zoom, -x - bx0, -y - by0], p.align), bw, bh);
    for (const [x0, y0, x1, y1] of sp) {
      for (let yy = y0; yy < y1; yy++) dst.set(src.subarray(((yy - by0) * bw + x0 - bx0) * bpp, ((yy - by0) * bw + x1 - bx0) * bpp), (yy * w + x0) * bpp);
    }
  };
  if (mode === 'new') {
    if (!newId) return blank(w, h);
    return pf.renderRGBA(newId, newPg, S, w, h, true);
  }
  // the old sheet drawn in the new sheet's space; a scan turned by a fraction of a degree is drawn
  // straight and resampled (PDFium draws such a picture as if it weren't turned)
  const oldGray = (): Gray => {
    const [a, b, c, d] = align;
    // the nearest straight mapping (quarter turns included: PDFium draws those exactly)
    const k = Math.sqrt(Math.abs(a * d - b * c));
    const straight = Math.abs(a) + Math.abs(d) >= Math.abs(b) + Math.abs(c)
      ? [Math.sign(a) * k, 0, 0, Math.sign(d) * k, align[4], align[5]]
      : [0, Math.sign(b) * k, Math.sign(c) * k, 0, align[4], align[5]];
    const resid = Math.abs(a - straight[0]) + Math.abs(b - straight[1]) + Math.abs(c - straight[2]) + Math.abs(d - straight[3]);
    if (!scan || resid < 1e-7) return grayOld(mul(S, align), w, h);
    const Sst = mul(S, straight);
    const M = mul(S, mul(align, invert(Sst))); // straight picture pixels -> view pixels
    // draw the straight picture over the part that lands in the view (with a margin), then turn it
    const Mi = invert(M);
    const cs = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [Mi[0] * x + Mi[2] * y + Mi[4], Mi[1] * x + Mi[3] * y + Mi[5]]);
    const bx0 = Math.floor(Math.min(...cs.map((q) => q[0]))) - 2, by0 = Math.floor(Math.min(...cs.map((q) => q[1]))) - 2;
    const bw = Math.ceil(Math.max(...cs.map((q) => q[0]))) + 2 - bx0, bh = Math.ceil(Math.max(...cs.map((q) => q[1]))) + 2 - by0;
    if (bw * bh > 4 * w * h + 1e6) return grayOld(mul(S, align), w, h); // (not a small turn: plain)
    const g = grayOld(mul([1, 0, 0, 1, -bx0, -by0], Sst), bw, bh);
    return warpGray(g, mul(M, [1, 0, 0, 1, bx0, by0]), w, h);
  };
  if (mode === 'old') {
    if (!oldId) return blank(w, h);
    if (!scan) {
      const px = pf.renderRGBA(oldId, oldPg, mul(S, align), w, h, true);
      for (const p of here) pastePart(px, 4, p, (m, bw, bh) => pf.renderRGBA(oldId, oldPg, m, bw, bh, true));
      return px;
    }
    const g = oldGray();
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) { px[j] = px[j + 1] = px[j + 2] = g.px[i]; px[j + 3] = 255; }
    return px;
  }
  // overlay
  const n = newId ? pf.renderGray(newId, newPg, S, w, h, minNew) : { w, h, px: new Uint8Array(w * h).fill(255) };
  const o = oldId ? oldGray() : { w, h, px: new Uint8Array(w * h).fill(255) };
  if (oldId && !scan) for (const p of here) pastePart(o.px, 1, p, (m, bw, bh) => grayOld(m, bw, bh).px);
  const pxPerMm = zoom * 72 / 25.4;
  const r = Math.max(1, Math.min(6, Math.round((scan ? Math.max(s.tolMM, 0.34) : s.tolMM) * pxPerMm)));
  return overlayFn(o, n, r, scan ? Math.max(s.contrast, 64) : s.contrast, defaultPalette, fade);
}
import { overlay as overlayFn, defaultPalette } from './compare';

function blank(w: number, h: number) { const b = new Uint8ClampedArray(w * h * 4); b.fill(255); return b; }
