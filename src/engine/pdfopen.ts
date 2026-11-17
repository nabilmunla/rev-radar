/// <reference types="node" />
// PDFs of the BOQ and Documents tabs, opened in the engine (host.ts calls these).
//  - openInput: a file of a side, for the comparison (one call)
//  - pagePicture / ocrPicture: from documents kept open between calls (the side view's pages, OCR's pictures)
import { VFile } from './files';
import * as pf from './pdfium';
import { prepGray } from './ocrprep';

let seq = 0;

/** PDFs under this size are read whole into the engine for the comparison (DECISIONS 16: kept only
 *  if reading a spec through the reader is over 5 % slower than from memory - see PROGRESS T4) */
export const IN_MEMORY_BELOW = 0;

/** the file starts "%PDF" (the first bytes only are read) */
function isPdf(file: VFile): boolean {
  const h = new Uint8Array(5);
  return file.read(h, 0, 5, 0) >= 4 && h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46;
}
function whole(file: VFile): Uint8Array {
  const b = new Uint8Array(file.size);
  file.read(b, 0, file.size, 0);
  return b;
}

/** a file of a BOQ / Documents side: a PDF is opened under `id`, read on demand from the call's file
 *  (PDFium asks for the pieces it needs - a 400 MB spec book costs a few MB, not 800; AUDIT A6); any
 *  other file (Word, workbook) is read whole and its bytes given back. The document holds the call's
 *  file: closeDoc closes it, and a read that failed makes the call fail (host.ts). */
export function openInput(id: string, file: VFile): { pdf: true } | { pdf: false; bytes: Uint8Array } {
  if (!isPdf(file.scattered())) {
    // (only a zip - .docx, .xlsx - or an old .xls is read whole: any other file - a video dropped in with the folder -
    //  is left out by its first bytes, not read into memory first; ritual 17 Nov)
    const head = new Uint8Array(4);
    const zip = (h: Uint8Array) => h[0] === 0x50 && h[1] === 0x4b, xls = (h: Uint8Array) => h[0] === 0xd0 && h[1] === 0xcf && h[2] === 0x11 && h[3] === 0xe0;
    if (file.size < 4 || file.read(head, 0, 4, 0) < 4 || !(zip(head) || xls(head))) return { pdf: false, bytes: head.subarray(0, 0) };
    return { pdf: false, bytes: whole(file) };
  }
  if (file.size < IN_MEMORY_BELOW) pf.openDoc(id, whole(file));
  else pf.openDoc(id, file);
  return { pdf: true };
}

/**
 * Documents kept open between calls (the side view's pages; OCR's pictures). Each has a file handle
 * of its own (the call's file is closed when the call ends - the next page would come out white),
 * closed when the document is let go: pushed out by newer ones, on boqPagesDone / ocrDone, when its
 * file is seen replaced (same name, another size or time: opened afresh), and when a read from it failed.
 */
class Kept {
  private list: { stamp: string; path: string; id: string }[] = [];
  constructor(private prefix: string, private max: number) {}
  get(f: VFile): string {
    const had = this.list.find((d) => d.stamp === f.stamp);
    if (had) { this.list.splice(this.list.indexOf(had), 1); this.list.unshift(had); return had.id; }
    // (the same file under another stamp: replaced since - its old copy is of no more use)
    for (const d of this.list.filter((x) => x.path === f.src.path)) this.drop(d.id);
    const id = this.prefix + ++seq;
    const own = f.reopen().scattered();
    try { pf.openDoc(id, own); } catch (e) { own.close(); throw e; }
    // (stamped as found now: replaced since the call began, the next call's file will say so too)
    this.list.unshift({ stamp: own.stamp, path: f.src.path, id });
    for (const d of this.list.splice(this.max)) pf.closeDoc(d.id);
    return id;
  }
  drop(id: string) {
    const k = this.list.findIndex((d) => d.id === id);
    if (k >= 0) this.list.splice(k, 1);
    pf.closeDoc(id);
  }
  clear() { for (const d of this.list.splice(0)) pf.closeDoc(d.id); return true; }
  ids() { return this.list.map((d) => d.id); }
  /** `f` drawn from the document `id`: if its file stopped reading part way (cut short, replaced,
   *  network drive dropped), what was drawn is not given out - the document is let go (opened afresh
   *  next time) and the call fails with the read-failed message */
  use<T>(id: string, f: () => T): T {
    let v: T;
    try { v = f(); } catch (e) {
      if (pf.readFailed(id)) { this.drop(id); throw new Error(pf.READ_FAIL); }
      throw e;
    }
    if (pf.readFailed(id)) { this.drop(id); throw new Error(pf.READ_FAIL); }
    return v;
  }
}
/** documents open for OCR pictures (the last two) */
const ocrDocs = new Kept('ocr', 2);
/** BOQ PDFs open for the side-by-side view's pages (the last four: an old and a new bill or two) */
const pageDocs = new Kept('pg', 4);

/** a BOQ PDF's page as a picture for the side-by-side view: RGBA at `scale` pixels a point (at most 5,000 px a side) */
export function pagePicture(file: VFile, page: number, scale: number) {
  const id = pageDocs.get(file);
  const sz = pf.pageSizes(id)[page];
  if (!sz) throw new Error('No page ' + (page + 1));
  const s = Math.max(0.05, Math.min(scale, 5000 / Math.max(sz.w, sz.h, 1)));
  const W = Math.max(1, Math.round(sz.w * s)), H = Math.max(1, Math.round(sz.h * s));
  const rgba = pageDocs.use(id, () => { try { return pf.renderRGBA(id, page, [s, 0, 0, s, 0, 0], W, H, true); } finally { pf.dropPages(id); } });
  return { rgba, W, H, s };
}

/** a page drawn grey for OCR at `dpi` (at most 7,000 px a side, 10 million in all), turned by `quarter` x 90°,
 *  cleaned (ocrprep) -> PGM; scale = pixels per point */
export function ocrPicture(file: VFile, page: number, dpi: number, quarter: number, denoise: number, rect?: number[] | null) {
  const id = ocrDocs.get(file);
  const g = ocrDocs.use(id, () => {
    try {
      const pg = pf.loadPage(id, page);
      // (a part of the page - a picture's box, T6.5b - drawn alone, from its corner)
      const r = rect && rect.length === 4 ? [Math.max(0, rect[0]), Math.max(0, rect[1]), Math.min(pg.w, rect[2]), Math.min(pg.h, rect[3])] : [0, 0, pg.w, pg.h];
      const sz = { w: Math.max(1, r[2] - r[0]), h: Math.max(1, r[3] - r[1]) };
      // (at most ~10 million pixels - A3 at 260 dpi: a bigger picture runs Tesseract out of memory,
      //  and every page after it comes back empty)
      const s = Math.min(dpi / 72, 7000 / Math.max(sz.w, sz.h, 1), Math.sqrt(10e6 / Math.max(1, sz.w * sz.h)));
      const W = Math.max(1, Math.round(sz.w * s)), H = Math.max(1, Math.round(sz.h * s));
      const rgba = pf.renderRGBA(id, page, [s, 0, 0, s, -r[0] * s, -r[1] * s], W, H, false);
      const px = new Uint8Array(W * H);
      for (let i = 0, j = 0; i < px.length; i++, j += 4) px[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
      return { px, s, W, H, ox: r[0], oy: r[1] };
    } finally { pf.releasePages(id); }
  });
  const { s, W, H } = g;
  const { pgm, OW, OH } = prepGray(g.px, W, H, quarter, denoise);
  return { pgm, scale: s, W, H, OW, OH, ox: g.ox, oy: g.oy };
}

/** the BOQ's pages no longer shown: their files let go */
export function pagesDone() { return pageDocs.clear(); }
/** OCR done: the files kept open for its pictures let go */
export function ocrDone() { return ocrDocs.clear(); }
/** (tests) documents kept open: for pages, for OCR */
export const keptForTests = () => ({ pages: pageDocs.ids(), ocr: ocrDocs.ids() });
