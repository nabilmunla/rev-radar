// The marked-up PDF: the chosen sheets of the new set, each change area clouded and numbered
// (real PDF markups: they can be moved, edited or deleted in any PDF program), behind a
// summary page. Sheets are copied page by page from the files (nothing is redrawn).
import fs from 'node:fs';
import path from 'node:path';
import * as pf from './pdfium';
import { VFile, tempPath, testHang, type FileSrc } from './files';

export interface ExportSheet {
  /** the new issue's file: opened only when its turn comes (one unreadable sheet doesn't stop the rest) */
  path: string;
  /** what to read for it (a monster sheet: the file plus its merged strokes) */
  src?: FileSrc;
  page: number;
  /** sheet name for the summary */
  name: string;
  /** areas: box in page space (points, as shown), label, note */
  /** dashed: a view moved on the sheet (blue); 'stretched': a part made longer / shorter (orange) - an
   *  outline, as in the viewer, not a cloud: its seam is a change of its own (RR-034) */
  areas: { box: number[]; n: number; note: string; dim?: boolean; dashed?: boolean | 'stretched' }[];
}

const invert = (m: number[]) => {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};
const ap = (m: number[], x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** engine memory one export part may fill (the engine's whole memory is 2 GB, and saving needs room) */
const PART_BUDGET = 1.1 * 1024 ** 3;

/**
 * Write the sheets (in order) to `out`, as many as fit this engine's memory: the result says how
 * many were done - the caller writes the rest as further parts from a fresh engine. Sheets that
 * can't be read are left out and named in `skipped`. summary: the summary pages (first part only).
 */
export function exportReport(sheets: ExportSheet[], out: string, title: string, summary: string[][] | null): { pages: number; bytes: number; done: number; skipped: string[] } {
  const R = pf.raw();
  const q = R.q;
  const D = q.FPDF_CreateNewDocument();
  if (!D) throw new Error('Could not start the PDF');
  const rect = R.malloc(16);
  let pages = 0, done = 0;
  const skipped: string[] = [];
  const uni = unicodeFont(D, [title, ...(summary || []).flat()]);
  // (beyond plain ASCII - ², ³, µ, accents - the standard font's encoding in PDFium is not to be
  // trusted: such text goes to the PC's font)
  try {
    if (summary) pages += summaryPages(D, title, summary, uni?.font || 0);
    let at = pages;
    for (const s of sheets) {
      if (done > 0 && pf.heapBytes() > PART_BUDGET) break;
      done++;
      const id = 'x' + Math.random().toString(36).slice(2);
      let src: VFile | null = null;
      try {
        src = new VFile(s.src ?? { path: s.path });
        pf.openDoc(id, src);
        const idx = R.malloc(4);
        new Int32Array(R.heap().HEAPU8.buffer, idx, 1)[0] = s.page;
        const ok = q.FPDF_ImportPagesByIndex(D, R.doc(id), idx, 1, at);
        R.free(idx);
        if (!ok) throw new Error('Could not copy ' + s.name);
        if (src.failed) { q.FPDFPage_Delete(D, at); throw new Error(pf.READ_FAIL); }
      } catch (e) {
        skipped.push(`${s.name}: ${String((e as Error)?.message || e)}`);
        continue;
      } finally { pf.closeDoc(id); src?.close(); }
      const p = q.FPDF_LoadPage(D, at);
      const w = q.FPDF_GetPageWidthF(p), h = q.FPDF_GetPageHeightF(p);
      const inv = invert(R.affine(p, w, h));
      const big = Math.max(w, h);
      const lw = Math.max(1.2, big / 1400);
      for (const a of s.areas) {
        const pad = lw * 4;
        const c1 = ap(inv, a.box[0] - pad, a.box[1] - pad), c2 = ap(inv, a.box[2] + pad, a.box[3] + pad);
        const l = Math.min(c1[0], c2[0]), r = Math.max(c1[0], c2[0]), b = Math.min(c1[1], c2[1]), t = Math.max(c1[1], c2[1]);
        const an = q.FPDFPage_CreateAnnot(p, 15); // ink: a revision cloud every viewer draws the same
        if (!an) continue;
        // (a view moved on the sheet: a blue dashed outline, as in the viewer - a cloud round a whole
        //  plan would read as "all of this changed")
        const col = a.dashed === 'stretched' ? [224, 137, 11] : a.dashed ? [46, 111, 149] : a.dim ? [140, 140, 140] : [226, 35, 26];
        for (const pts of a.dashed ? dashes(l, b, r, t, lw * 7, lw * 4.5) : [cloud(l, b, r, t, Math.max(lw * 5, Math.min(r - l, t - b) / 6 > lw * 5 ? lw * 6 : lw * 4))]) {
          const pp = R.malloc(pts.length * 4);
          new Float32Array(R.heap().HEAPU8.buffer, pp, pts.length).set(pts);
          q.FPDFAnnot_AddInkStroke(an, pp, pts.length / 2);
          R.free(pp);
        }
        const F = new Float32Array(R.heap().HEAPU8.buffer, rect, 4);
        const e = lw * 8;
        F[0] = l - e; F[1] = t + e; F[2] = r + e; F[3] = b - e;
        q.FPDFAnnot_SetRect(an, rect);
        q.FPDFAnnot_SetColor(an, 0, col[0], col[1], col[2], 255);
        q.FPDFAnnot_SetBorder(an, 0, 0, lw);
        q.FPDFAnnot_SetFlags(an, 4);
        setStr(an, 'Contents', a.note);
        setStr(an, 'T', 'Rev Radar');
        setStr(an, 'Subj', 'Change ' + a.n);
        try { q.EPDFAnnot_GenerateAppearance(an); } catch { /* viewer draws it */ }
        q.FPDFPage_CloseAnnot(an);
        // the number in a small box at the cloud's top-left corner - drawn as strokes (upright on
        // turned pages, the same in every viewer)
        const tag = a.n > 0 ? q.FPDFPage_CreateAnnot(p, 15) : 0;
        if (tag) {
          const th = Math.max(10, big / 110), tw = th * (0.25 + 0.6 * String(a.n).length);
          const x1 = a.box[0] - pad - tw, y1 = a.box[1] - pad - th;
          const lines = numberStrokes(String(a.n), x1, y1, tw, th);
          let L = Infinity, B = Infinity, Rr = -Infinity, T = -Infinity;
          for (const line of lines) {
            const flat: number[] = [];
            for (let k = 0; k < line.length; k += 2) {
              const u = ap(inv, line[k], line[k + 1]);
              flat.push(u[0], u[1]);
              L = Math.min(L, u[0]); Rr = Math.max(Rr, u[0]); B = Math.min(B, u[1]); T = Math.max(T, u[1]);
            }
            const pp = R.malloc(flat.length * 4);
            new Float32Array(R.heap().HEAPU8.buffer, pp, flat.length).set(flat);
            q.FPDFAnnot_AddInkStroke(tag, pp, flat.length / 2);
            R.free(pp);
          }
          const F2 = new Float32Array(R.heap().HEAPU8.buffer, rect, 4);
          F2[0] = L - lw; F2[1] = T + lw; F2[2] = Rr + lw; F2[3] = B - lw;
          q.FPDFAnnot_SetRect(tag, rect);
          q.FPDFAnnot_SetColor(tag, 0, col[0], col[1], col[2], 255);
          q.FPDFAnnot_SetBorder(tag, 0, 0, Math.max(0.8, lw * 0.8));
          q.FPDFAnnot_SetFlags(tag, 4);
          setStr(tag, 'Contents', 'Change ' + a.n);
          setStr(tag, 'T', 'Rev Radar');
          try { q.EPDFAnnot_GenerateAppearance(tag); } catch { /* */ }
          q.FPDFPage_CloseAnnot(tag);
        }
      }
      q.FPDF_ClosePage(p);
      at++;
      pages++;
    }
    if (!pages) return { pages, bytes: 0, done, skipped }; // nothing could be read: no empty file
    const bytes = save(D, out);
    return { pages, bytes, done, skipped };
  } finally {
    R.free(rect);
    q.FPDF_CloseDocument(D);
    if (uni) { q.FPDFFont_Close(uni.font); R.free(uni.mem); }
  }

  function setStr(an: number, key: string, v: string) {
    const p = pf.wide(v);
    try { q.FPDFAnnot_SetStringValue(an, key, p); } finally { R.free(p); }
  }
}

/** seven-segment digits as polylines (page space, y down) inside a box at (x, y) of size w x h */
const SEG: Record<string, number[][]> = {
  '0': [[0, 0, 1, 0, 1, 1.6, 0, 1.6, 0, 0]], '1': [[0.25, 0.3, 0.55, 0, 0.55, 1.6]], '2': [[0, 0, 1, 0, 1, 0.8, 0, 0.8, 0, 1.6, 1, 1.6]],
  '3': [[0, 0, 1, 0, 1, 1.6, 0, 1.6], [0.15, 0.8, 1, 0.8]], '4': [[0, 0, 0, 0.8, 1, 0.8], [1, 0, 1, 1.6]], '5': [[1, 0, 0, 0, 0, 0.8, 1, 0.8, 1, 1.6, 0, 1.6]],
  '6': [[1, 0, 0, 0, 0, 1.6, 1, 1.6, 1, 0.8, 0, 0.8]], '7': [[0, 0, 1, 0, 1, 1.6]], '8': [[0, 0, 1, 0, 1, 1.6, 0, 1.6, 0, 0], [0, 0.8, 1, 0.8]],
  '9': [[1, 0.8, 0, 0.8, 0, 0, 1, 0, 1, 1.6, 0, 1.6]],
};
function numberStrokes(s: string, x: number, y: number, w: number, h: number): number[][] {
  const out: number[][] = [[x, y, x + w, y, x + w, y + h, x, y + h, x, y]];
  const ch = h * 0.62, cw = ch / 1.6 * 0.95, gap = cw * 0.45;
  const total = s.length * cw + (s.length - 1) * gap;
  let cx = x + (w - total) / 2;
  const cy = y + (h - ch) / 2;
  for (const c of s) {
    for (const seg of SEG[c] || []) {
      const line: number[] = [];
      for (let k = 0; k < seg.length; k += 2) line.push(cx + seg[k] * cw, cy + (seg[k + 1] / 1.6) * ch);
      out.push(line);
    }
    cx += cw + gap;
  }
  return out;
}

/** a dashed rectangle: one stroke per dash, round the box (user space) */
function dashes(l: number, b: number, r: number, t: number, dash: number, gap: number): number[][] {
  const out: number[][] = [];
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / (len || 1), uy = (y1 - y0) / (len || 1);
    for (let s = 0; s < len; s += dash + gap) { const e = Math.min(len, s + dash); out.push([x0 + ux * s, y0 + uy * s, x0 + ux * e, y0 + uy * e]); }
  };
  edge(l, b, l, t); edge(l, t, r, t); edge(r, t, r, b); edge(r, b, l, b);
  return out;
}

/** revision cloud around a box (user space): scallops of radius ~r bulging outwards, as a closed polyline */
function cloud(l: number, b: number, r: number, t: number, rad: number): number[] {
  const out: number[] = [];
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / (rad * 1.6)));
    const dx = (x1 - x0) / n, dy = (y1 - y0) / n;
    // outward normal for a clockwise walk in y-up space (left edge up, top right, right down, bottom left)
    const nx = -dy / (Math.hypot(dx, dy) || 1), ny = dx / (Math.hypot(dx, dy) || 1);
    for (let i = 0; i < n; i++) {
      const ax = x0 + dx * i, ay = y0 + dy * i;
      const seg = Math.hypot(dx, dy) / 2;
      for (let k = 0; k <= 8; k++) {
        const th = Math.PI * (k / 8);
        // half circle from a to a + d, bulging along the normal
        const along = seg - Math.cos(th) * seg, out_ = Math.sin(th) * seg * 0.9;
        out.push(ax + (dx / (2 * seg)) * along + nx * out_, ay + (dy / (2 * seg)) * along + ny * out_);
      }
    }
  };
  edge(l, b, l, t); edge(l, t, r, t); edge(r, t, r, b); edge(r, b, l, b);
  out.push(out[0], out[1]);
  return out;
}

/** a TrueType font for text the standard PDF fonts can't show (Cyrillic, Greek, Arabic... file names),
 *  from the PC's fonts - only loaded (and embedded) when such text is there */
function unicodeFont(D: number, texts: string[]): { font: number; mem: number } | null {
  if (!texts.some((t) => /[^\x00-\x7e]/.test(t))) return null;
  const win = process.env.WINDIR || 'C:\\Windows';
  const cands = [path.join(win, 'Fonts', 'arial.ttf'), path.join(win, 'Fonts', 'segoeui.ttf'), '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
  for (const f of cands) {
    try {
      const data = fs.readFileSync(f);
      const R = pf.raw();
      const mem = R.malloc(data.length);
      R.heap().HEAPU8.set(data, mem);
      const font = R.q.FPDFText_LoadFont(D, mem, data.length, 2, true);
      if (font) return { font, mem };
      R.free(mem);
    } catch { /* not on this PC */ }
  }
  return null;
}

/** right-to-left words (Arabic, Hebrew) in drawing order: PDF text runs left to right (letters stay
 *  unjoined - readable, not typeset) */
const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]+(?:[\s\d.,_-]+[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]+)*/g;
const visual = (s: string) => s.replace(RTL, (m) => [...m].reverse().join(''));

/** summary table pages (A3 landscape) */
function summaryPages(D: number, title: string, rows: string[][], uniFont: number): number {
  const R = pf.raw();
  const q = R.q;
  const W = 1190.55, H = 841.89, M = 40;
  const lineH = 13;
  const perPage = Math.floor((H - 2 * M - 70) / lineH);
  const n = Math.max(1, Math.ceil((rows.length - 1) / perPage));
  const cols = colWidths(rows, W - 2 * M, 8.5);
  for (let k = 0; k < n; k++) {
    const p = q.FPDFPage_New(D, k, W, H);
    let y = H - M;
    text(p, title + (n > 1 ? `  (${k + 1}/${n})` : ''), M, y - 16, 16, true, [9, 48, 47]);
    y -= 40;
    const head = rows[0];
    const body = rows.slice(1 + k * perPage, 1 + (k + 1) * perPage);
    for (const [ri, r] of [head, ...body].entries()) {
      if (ri === 0) box(p, M - 4, y - 4, W - 2 * M + 8, lineH, [223, 233, 231]);
      else if (ri % 2 === 0) box(p, M - 4, y - 4, W - 2 * M + 8, lineH, [245, 248, 247]);
      let x = M;
      for (const [ci, c] of r.entries()) {
        const colr: [number, number, number] = ri > 0 && ci === 2 ? statusColour(c) : [16, 32, 31];
        text(p, fit(c, cols[ci] - 8, 8.5, ri === 0), x, y, 8.5, ri === 0, colr);
        x += cols[ci];
      }
      y -= lineH;
    }
    text(p, 'Made with Rev Radar - clouds are PDF markups: they can be moved, edited or removed.', M, M - 14, 7.5, false, [124, 141, 138]);
    q.FPDFPage_GenerateContent(p);
    q.FPDF_ClosePage(p);
  }
  return n;

  function text(p: number, s: string, x: number, y: number, size: number, bold: boolean, c: number[]) {
    // (PDFium aborts on an empty text object)
    if (!s || !s.trim()) return;
    const other = /[^\x20-\x7e]/.test(s);
    const o = other && uniFont ? q.FPDFPageObj_CreateTextObj(D, uniFont, size) : q.FPDFPageObj_NewTextObj(D, bold ? 'Helvetica-Bold' : 'Helvetica', size);
    if (!o) return;
    const w = pf.wide(other && uniFont ? visual(s) : s.replace(/[^\x20-\x7e]/g, '?'));
    q.FPDFText_SetText(o, w);
    R.free(w);
    q.FPDFPageObj_SetFillColor(o, c[0], c[1], c[2], 255);
    q.FPDFPageObj_Transform(o, 1, 0, 0, 1, x, y);
    q.FPDFPage_InsertObject(p, o);
  }
  function box(p: number, x: number, y: number, w: number, h: number, c: number[]) {
    const o = q.FPDFPageObj_CreateNewRect(x, y, w, h);
    q.FPDFPageObj_SetFillColor(o, c[0], c[1], c[2], 255);
    q.FPDFPath_SetDrawMode(o, 1, false);
    q.FPDFPage_InsertObject(p, o);
  }
}

function statusColour(s: string): [number, number, number] {
  if (/^Changed|^Tiny/.test(s)) return [180, 35, 24];
  if (/^New/.test(s)) return [47, 111, 209];
  if (/^Removed/.test(s)) return [146, 74, 34];
  if (/^No change/.test(s)) return [21, 127, 84];
  return [71, 89, 87];
}

// the standard fonts' widths (1/1000 em) for ASCII 32-126: Helvetica and Helvetica-Bold
const HV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HB = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
/** how wide a text is on the page (points) */
export function textWidth(s: string, size: number, bold = false): number {
  const t = bold ? HB : HV;
  let u = 0;
  for (const ch of s) { const c = ch.codePointAt(0)!; u += c >= 32 && c <= 126 ? t[c - 32] : 640; }
  return (u / 1000) * size;
}

/** column widths: every column gets what its widest text needs when it fits; the columns that
 *  don't fit share the rest equally (their texts are cut with "...") */
export function colWidths(rows: string[][], total: number, size: number): number[] {
  // (loops, not Math.max(...rows): that throws past ~125,000 rows - 0.6.0 T24)
  let n = 0;
  for (const r of rows) if (r.length > n) n = r.length;
  const need = Array.from({ length: n }, (_, i) => { let m = 0; rows.forEach((r, k) => { const v = textWidth(r[i] || '', size, k === 0); if (v > m) m = v; }); return m + 10; });
  const out = new Array<number>(n).fill(0);
  let open = need.map((_, i) => i), left = total;
  for (;;) {
    const share = left / Math.max(1, open.length);
    const fits = open.filter((i) => need[i] <= share);
    if (!fits.length) break;
    for (const i of fits) { out[i] = need[i]; left -= need[i]; }
    open = open.filter((i) => !fits.includes(i));
    if (!open.length) break;
  }
  for (const i of open) out[i] = left / open.length;
  // room to spare: to the last column (the table still spans the page)
  if (!open.length && left > 0) out[n - 1] += left;
  return out;
}
/** cut text to a width, ending in "..." */
export function fit(s: string, w: number, size: number, bold = false): string {
  if (textWidth(s, size, bold) <= w) return s;
  const chars = [...s];
  let lo = 0, hi = chars.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (textWidth(chars.slice(0, mid).join('') + '...', size, bold) <= w) lo = mid; else hi = mid - 1; }
  return chars.slice(0, lo).join('').trimEnd() + '...';
}

/** the block writer PDFium calls while saving (made once: the function table never shrinks) */
let writeTo: ((data: number, size: number) => number) | null = null;
let writerFn = 0;

/** write the document to a file block by block (no whole copy in engine memory) - into the temp
 *  folder first, moved into place when complete (a window closed half way leaves nothing behind
 *  in the user's folder) */
function save(D: number, out: string): number {
  const R = pf.raw();
  const part = tempPath(path.basename(out) + '.part');
  const fd = fs.openSync(part, 'w');
  let bytes = 0;
  let failed: unknown = null;
  writeTo = (data: number, size: number) => {
    try {
      // all of it (a network drive may take a block in pieces)
      for (let k = 0; k < size;) { const n = fs.writeSync(fd, R.heap().HEAPU8, data + k, size - k); if (n <= 0) throw new Error('short write'); k += n; }
      bytes += size; return 1;
    } catch (e) { failed = e; return 0; }
  };
  if (!writerFn) writerFn = R.addFunction((_self: number, data: number, size: number) => (writeTo ? writeTo(data, size) : 0), 'iiii');
  const fn = writerFn;
  const fw = R.malloc(8);
  try {
    const I = new Int32Array(R.heap().HEAPU8.buffer, fw, 2);
    I[0] = 1; I[1] = fn;
    const ok = R.q.FPDF_SaveAsCopy(D, fw, 0);
    fs.closeSync(fd);
    if (!ok || failed) throw new Error('Could not write the PDF' + (failed ? ': ' + String(failed) : ''));
    testHang('exportPdf.save'); // (tests only: RR_TEST_HANG - the finished part is in the temp folder, not yet in place)
    moveInto(part, out);
    return bytes;
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* */ }
    throw e;
  } finally {
    R.free(fw); writeTo = null;
    try { fs.rmSync(path.dirname(part), { recursive: true, force: true }); } catch { /* */ }
  }
}

/** the finished file into its place (another drive: copied, through a .part next to it) */
function moveInto(from: string, to: string) {
  try { fs.renameSync(from, to); return; } catch (e) {
    const c = (e as NodeJS.ErrnoException).code;
    if (c !== 'EXDEV') throw busyHint(e);
  }
  const p = to.replace(/\.pdf$/i, '') + '.part.pdf';
  try {
    fs.copyFileSync(from, p);
    fs.renameSync(p, to);
  } catch (e) {
    try { fs.rmSync(p, { force: true }); } catch { /* */ }
    throw busyHint(e);
  }
}
const busyHint = (e: unknown) => {
  const c = (e as NodeJS.ErrnoException)?.code;
  return c === 'EBUSY' || c === 'EPERM' || c === 'EACCES' ? new Error('the file is open in another program (close it there) or the folder is read-only') : e;
}
