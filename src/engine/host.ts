/// <reference types="node" />
// An engine in its own background process (Electron utility process). A monster file that
// exhausts an engine's memory only takes this process down; the app starts a new one.
//
// Calls arrive on message ports: { id, method, args }.
//  - an argument { $file: { path } } becomes a file read on demand
//  - pictures go back as { $img: 1, w, h, px }
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VFile, isFileSrc, testHang, type FileSrc } from './files';
import * as pf from './pdfium';
import { comparePair, viewPicture, sheetThumb, type Settings, type ViewMode, type ViewPart } from './job';
import { exportReport, type ExportSheet } from './report';
import { readable } from './heavy';
import { muHeap, shouldRecycle, RECYCLE_AT, muBar } from './muheap';
import { muOpenCount } from './murender';
import { SUPERSEDED } from './rpc';
import { readBook, type Book } from './sheets';
import { fingerprintPages } from './fpread';
import { readItems, compareBoq, billOf, byBill, type BoqDoc } from './boq';
import { pdfBook } from './pdftable';
import { pdfParas, docxParas, sectionsOf, docEntries, placePics, readingOf, readingChunks, zipMedia, type DocSection, type DocsResult, type DocsReading } from './docs';
import { pagePics, furniture, judge, lookOf, textLikeOf, pairPics, sheetMedia, PicDocs, type Pic } from './picdiff';
import { openInput, pagePicture, ocrPicture, pagesDone, ocrDone } from './pdfopen';
import { pageText, wordKeep, type OcrWords, type Scan } from './pagetext';
import { isOff } from './flags';

type Handler = (...a: any[]) => unknown;
interface PortMain { on(ev: 'message', f: (e: { data: any }) => void): void; postMessage(m: unknown): void; start(): void }
const parentPort = (process as unknown as { parentPort: { on(ev: 'message', f: (e: { data: any; ports: PortMain[] }) => void): void; postMessage(m: unknown): void } }).parentPort;
const resDir = process.argv[2] || '.';

/** the PDFs' paragraphs as read (T7, the text view) are written here, beside the result - a spec book is
 *  megabytes of text - and read by the window when "Text as read" is first asked for; main.cjs clears them */
const readDir = () => path.join(os.tmpdir(), 'Rev Radar', 'work');
let lastReading = '';
function writeReading(O: DocSection[], N: DocSection[], want: (side: 'o' | 'n', file: string) => boolean): string {
  fs.mkdirSync(readDir(), { recursive: true });
  if (lastReading) fs.rmSync(lastReading, { force: true });
  lastReading = path.join(readDir(), `read-${process.pid}-${Date.now().toString(36)}.json`);
  const fd = fs.openSync(lastReading, 'w');
  try { for (const c of readingChunks(O, N, want)) fs.writeSync(fd, c); } finally { fs.closeSync(fd); }
  return lastReading;
}

const img = (px: Uint8ClampedArray, w: number, h: number) => ({ $img: 1, w, h, px });

/** documents the viewer has open (one pair at a time, plus the one before) */
/** pairs open for the viewer; stamps: each side's file as it was read (size and time - '' none) */
const viewDocs: { key: string; ids: string[]; stamps: string[]; pages?: string }[] = [];
/** (0.6.0 T22 B) how much memory (PDFium's + MuPDF's) each view document's calls took: the one that took the most
 *  is the sheet that put a view engine past a bar - kept after it is closed (the memory stays) */
const grew = new Map<string, number>();
let seq = 0;

function openTemp(src: VFile): string {
  const id = 't' + ++seq;
  pf.openDoc(id, src);
  return id;
}

/** the screen's picture with a margin round it (half the screen each way, inside the page, at
 *  most ~6 million pixels): [x, y, w, h] pixels at `zoom` */
export function grown(rect: number[], zoom: number, page: { w: number; h: number }): number[] {
  const [x, y, w, h] = rect.map((n) => Math.round(n));
  const PW = Math.floor(page.w * zoom), PH = Math.floor(page.h * zoom);
  let f = 0.5;
  for (;;) {
    const x0 = Math.max(0, Math.min(x, x - Math.round(w * f))), y0 = Math.max(0, Math.min(y, y - Math.round(h * f)));
    const x1 = Math.max(x + w, Math.min(PW, x + w + Math.round(w * f))), y1 = Math.max(y + h, Math.min(PH, y + h + Math.round(h * f)));
    if ((x1 - x0) * (y1 - y0) <= 6e6 || f < 0.02) return [x0, y0, x1 - x0, y1 - y0];
    f /= 2;
  }
}

async function handlers(): Promise<Record<string, Handler>> {
  const wasm = fs.readFileSync(path.join(resDir, 'pdfium.wasm'));
  await pf.startPdfium(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
  return {
    ping() { return process.pid; },
    memory() {
      const heap = pf.heapBytes(), mu = muHeap();
      let grewMost: string | null = null, most = 0;
      for (const [k, n] of grew) if (n > most) { most = n; grewMost = k; }
      // (T22 B: a view engine past a bar says so, and which sheet took it there - the window then lets go of what it
      //  holds when that sheet is not one it keeps, and the rule after the call starts it afresh. RR_OFF=viewrecycle: never)
      const past = !isOff('viewrecycle') && (heap > RECYCLE_AT || mu > muBar());
      return { rss: process.memoryUsage().rss, heap, mu, past, grewMost };
    },

    /** page sizes (points, as shown) and labels of a file */
    info(src: VFile) {
      const id = openTemp(src);
      try {
        const sizes = pf.pageSizes(id);
        const labels = sizes.map((_, i) => { try { return pf.pageLabel(id, i); } catch { return ''; } });
        return { pages: sizes, labels };
      } finally { pf.closeDoc(id); }
    },

    /** what a page says (for pairing sheets of two sets): its words, upper case */
    fingerprint(src: VFile, pages: number[]) { return fingerprintPages(src, pages); },

    /** the list picture of one sheet (new / removed sheets) */
    async thumb(src: VFile, page: number) {
      const id = openTemp(src);
      try {
        if (!src.layered) await pf.chooseRenderer([[id, page]]);
        return sheetThumb(id, page);
      } finally { pf.closeDoc(id); }
    },

    /** compare one sheet pair */
    async compare(oldSrc: VFile, oldPage: number, newSrc: VFile, newPage: number, settings: Settings, manualAlign?: number[] | null) {
      const a = openTemp(oldSrc);
      let b = '';
      try {
        b = openTemp(newSrc);
        // a monster sheet (merged strokes, see heavy.ts): one page in memory at a time
        const heavy = oldSrc.layered || newSrc.layered;
        // a busy page that blends: both drawn by MuPDF (murender.ts)
        if (!heavy) await pf.chooseRenderer([[a, oldPage], [b, newPage]]);
        return comparePair(a, oldPage, b, newPage, settings, manualAlign, heavy);
      } finally {
        pf.closeDoc(a);
        if (b) pf.closeDoc(b);
      }
    },

    /** the viewer opens a pair (kept open for its pictures) */
    viewOpen(key: string, oldSrc: VFile | null, newSrc: VFile | null, keep = 2) {
      const stamps = [oldSrc?.stamp ?? '', newSrc?.stamp ?? ''];
      const k = viewDocs.findIndex((v) => v.key === key);
      if (k >= 0) {
        const have = viewDocs[k];
        if (have.stamps[0] === stamps[0] && have.stamps[1] === stamps[1]) { oldSrc?.close(); newSrc?.close(); return { ids: have.ids }; }
        // the files are not the ones it was opened with: issued again under the same name and compared
        // again ("Again" - its pictures showed the file before, or nothing), or a side that could not
        // be read then reads now ("Try again" - it stayed blank). Read afresh.
        for (const i of have.ids) if (i) pf.closeDoc(i);
        viewDocs.splice(k, 1);
      }
      const ids = [oldSrc ? 'vo' + ++seq : '', newSrc ? 'vn' + ++seq : ''];
      try {
        if (oldSrc) pf.openDoc(ids[0], oldSrc);
        if (newSrc) pf.openDoc(ids[1], newSrc);
      } catch (e) { for (const i of ids) if (i) pf.closeDoc(i); throw e; }
      viewDocs.push({ key, ids, stamps });
      // (keep: pairs kept open - fewer when two view engines take turns, see ui/viewpool.ts; the
      //  oldest goes once this one is open - a file that can't be opened leaves the one before)
      while (viewDocs.length > Math.max(1, keep)) { const o = viewDocs.shift()!; for (const i of o.ids) if (i) pf.closeDoc(i); }
      return { ids };
    },
    viewClose(key: string) {
      const k = viewDocs.findIndex((v) => v.key === key);
      if (k >= 0) { for (const i of viewDocs[k].ids) if (i) pf.closeDoc(i); viewDocs.splice(k, 1); }
      return true;
    },
    /** a picture of part of the view (see job.viewPicture) */
    view(key: string, oldPage: number, newPage: number, align: number[], mode: ViewMode, zoom: number, rect: number[], settings: Settings, fade: number, scan = false, parts?: ViewPart[], grow = false) {
      return viewOne(key, oldPage, newPage, align, mode, zoom, rect, settings, fade, scan, parts, grow);
    },
    /**
     * The next sheet made ready while the one on screen is looked at (a second view engine - see
     * ui/viewpool.ts): its pages read in (a dense sheet: 2 s each; a blended heavy sheet's display
     * list: 2-5 s), then the pictures the viewer will ask for first.
     */
    async viewWarm(key: string, oldPage: number, newPage: number, color: boolean, jobs: Parameters<typeof viewOne>[]) {
      const v = viewDocs.find((x) => x.key === key);
      if (!v) throw new Error('Pair is not open');
      const pk = oldPage + '|' + newPage;
      if (v.pages !== pk) { await chooseFor(v, oldPage, newPage); v.pages = pk; }
      v.ids.forEach((id, k) => {
        if (!id) return;
        const pg = k === 0 ? oldPage : newPage;
        // (a page MuPDF draws: its display list read in - the one the first pictures use; PDFium's
        //  reading of it would never be used)
        if (!pf.usesMu(id, pg)) pf.loadPage(id, pg);
        else if (!jobs.length) { if (color) pf.renderRGBA(id, pg, [1, 0, 0, 1, 0, 0], 1, 1, true); else pf.renderGray(id, pg, [1, 0, 0, 1, 0, 0], 1, 1, 0); }
      });
      const out: unknown[] = [];
      for (const j of jobs) out.push(await viewOne(...j));
      return out;
    },
    /**
     * One page of a pair made ready cut into tiles (a page MuPDF draws: murender.ts buildTiles -
     * close looks then take 0.01-0.3 s, not ~1 s). Asked for later, one page a call: it takes
     * 4-12 s on a heavy tender sheet, and only once the first pictures are ready.
     */
    viewTiles(key: string, which: 0 | 1, page: number) {
      const v = viewDocs.find((x) => x.key === key);
      const id = v?.ids[which];
      if (!id) return false;
      return pf.prepareTiles(id, page);
    },
  };
}

/** the drawing engine for a viewed pair (as the comparison chose); pages MuPDF draws are let go in
 *  PDFium - read in there only to choose (a heavy tender page: ~330 MB never used again) */
async function chooseFor(v: { ids: string[] }, oldPage: number, newPage: number) {
  const mu = await pf.chooseRenderer([[v.ids[0] || null, oldPage], [v.ids[1] || null, newPage]]);
  if (mu) for (const id of v.ids) if (id) pf.releasePages(id);
}

/** a picture of part of the view of an open pair (see job.viewPicture) */
async function viewOne(key: string, oldPage: number, newPage: number, align: number[], mode: ViewMode, zoom: number, rect: number[], settings: Settings, fade: number, scan = false, parts?: ViewPart[], grow = false) {
  const v = viewDocs.find((x) => x.key === key);
  if (!v) throw new Error('Pair is not open');
  // (the same drawing engine as the comparison: see murender.ts)
  const pk = oldPage + '|' + newPage;
  if (v.pages !== pk) { await chooseFor(v, oldPage, newPage); v.pages = pk; }
  // grow: a page MuPDF draws costs about the same whatever the size of the picture (~1 s a
  // picture on a heavy tender sheet, most of it reading the whole display list): drawn with a margin
  // round the screen, moving about needs no new picture. (PDFium's time grows with the drawing
  // in the picture: as asked.) The answer then says where the picture is.
  const muPage = v.ids.some((i, k) => i && pf.usesMu(i, k === 0 ? oldPage : newPage));
  const at = grow && muPage ? grown(rect, zoom, pf.pageSizes(v.ids[1] || v.ids[0])[v.ids[1] ? newPage : oldPage]) : rect;
  const w = Math.round(at[2]), h = Math.round(at[3]);
  const px = viewPicture(v.ids[0] || null, oldPage, v.ids[1] || null, newPage, align, mode, zoom, at, settings, fade, scan, parts);
  if (v.ids.some((i) => i && pf.readFailed(i))) {
    // drawn from a file that stopped reading: open it afresh next time
    const k = viewDocs.indexOf(v);
    for (const i of v.ids) if (i) pf.closeDoc(i);
    viewDocs.splice(k, 1);
    throw new Error(pf.READ_FAIL);
  }
  return grow ? { pic: img(px, w, h), rect: at.map((n) => Math.round(n)) } : img(px, w, h);
}

/** the rest of the calls (the view engine's words, exports) */
function more(): Record<string, Handler> {
  return {
    /** words of the new sheet in a box (the change list shows what is written there) */
    wordsIn(key: string, which: 0 | 1, page: number, box: number[]) {
      const v = viewDocs.find((x) => x.key === key);
      if (!v || !v.ids[which]) return [];
      return pf.words(v.ids[which], page).filter((w) => (w.x0 + w.x1) / 2 >= box[0] && (w.x0 + w.x1) / 2 <= box[2] && (w.y0 + w.y1) / 2 >= box[1] && (w.y0 + w.y1) / 2 <= box[3]).map((w) => w.s);
    },

    /** the marked-up PDF: chosen sheets of the new set with clouds, plus a summary page (a part
     *  of it: the sheets that fit this engine's memory - see exportReport) */
    async exportPdf(sheets: ExportSheet[], out: string, title: string, summary: string[][] | null) {
      if (!/\.pdf$/i.test(out)) throw new Error('Not a PDF file name');
      // (a monster sheet is copied from its merged form: the original can't be loaded to cloud it)
      for (const s of sheets) s.src = await readable(s.path);
      return exportReport(sheets, out, title, summary);
    },
    /**
     * BOQ issues compared (BOQ tab): each side one or more workbooks / PDFs (`name`: the file's
     * name, for the bill it is in a set of several). Items of every file read in order, paired.
     */
    boqCompare(oldSide: { file: VFile; name: string }[], newSide: { file: VFile; name: string }[], opts: { partial?: boolean; ocr?: OcrWords } = {}) {
      const scans: Scan[] = [];
      // (pictures inside a bill's pages - T6.5: compared as in Documents, never made into items; a
      //  workbook's pasted pictures: their hashes, a note. RR_OFF=pictures: as before)
      const withPics = !isOff('pictures');
      const pd = new PicDocs();
      const picsOf: { o: Pic[]; n: Pic[] } = { o: [], n: [] };
      const furn = { o: new Set<string>(), n: new Set<string>() };
      const media: { o: Map<string, Map<string, string[]>>; n: Map<string, Map<string, string[]>> } = { o: new Map(), n: new Map() };
      try {
      const side = (fs2: { file: VFile; name: string }[], tag: 'o' | 'n'): BoqDoc & { pdf: boolean } => {
        const doc: BoqDoc & { pdf: boolean } = { items: [], notes: [], sheets: [], pdfs: [], pdf: false };
        // (two files of one name - from two folders of the set: told apart, or their sheets would be one)
        const named = new Map<string, number>();
        const uniq = fs2.map((x, idx) => { const k = (named.get(x.name) || 0) + 1; named.set(x.name, k); return { ...x, idx, name: k > 1 ? `${x.name} (${k})` : x.name }; });
        for (const { file, name, idx } of uniq.sort((x, y) => byBill(x.name, y.name))) {
          const id = 'boq' + tag + ++seq;
          const inp = openInput(id, file);
          let book: Book;
          if (inp.pdf) {
            try {
              const n = pf.pageSizes(id).length;
              doc.pdfs!.push({ name, idx, sizes: pf.pageSizes(id).map((z) => ({ w: z.w, h: z.h })) });
              const key = tag + '|' + idx, scan: Scan = { key, name, side: tag, idx, pages: [] }, done = new Set<number>(), failed: number[] = [];
              const pics: Pic[] = [];
              const sz = pf.pageSizes(id);
              book = pdfBook(name, n, (i) => { const w = pageText(id, i, key, opts.ocr, scan, done, failed, file.stamp); if (withPics) pics.push(...pagePics(id, name, i, w, sz[i])); if (i % 40 === 39) pf.dropPages(id); return w; }, done);
              if (withPics) {
                const fu = furniture(pics, (x) => lookOf(id, x));
                for (const x of fu) furn[tag].add(x.sha);
                if (fu.size) doc.notes.push(`${name}: ${new Set([...fu].map((x) => x.sha)).size} picture${fu.size === 1 ? '' : 's'} on 3 pages or more (logo, letterhead, watermark) left out`);
                for (const x of pics) if (!fu.has(x)) picsOf[tag].push(x);
                pd.add(tag + '|' + name, file);
              }
              doc.pdf = true;
              if (scan.pages.length) scans.push(scan);
              if (failed.length) doc.notes.push(`${name}: ${failed.length} scanned page${failed.length === 1 ? '' : 's'} could not be read by OCR - left out (items on ${failed.length === 1 ? 'it' : 'them'} are not compared): page ${failed.slice(0, 8).join(', ')}${failed.length > 8 ? '…' : ''}`);
              if (done.size) doc.notes.push(`${name}: ${done.size} scanned page${done.size === 1 ? '' : 's'} read by OCR - words and figures from a scan can be misread: its items are marked "check"`);
              if (!book.sheets[0].rows.length && !scan.pages.length) doc.notes.push(`${name}: no item table found (Item / Description / Qty / Unit)`);
            } finally { pf.closeDoc(id); }
          } else { book = readBook(inp.bytes); if (withPics) media[tag].set(name, sheetMedia(inp.bytes)); }
          // (one file against one file: its name is not the bill - a folder of bills: it is)
          const d = readItems(book, name, doc.items.length, fs2.length > 1 ? billOf(name) : '');
          doc.items.push(...d.items);
          doc.notes.push(...d.notes.map((x) => `${name}: ${x}`));
          doc.sheets.push(...d.sheets.map((x) => ({ ...x, file: name, sheet: x.name, name: fs2.length > 1 ? `${name} › ${x.name}` : x.name })));
        }
        return doc;
      };
      const O = side(oldSide, 'o'), N = side(newSide, 'n');
      // (scanned pages: the window reads them (OCR) and asks again)
      if (scans.length && !opts.ocr) return { scans };
      // (no items on a side: say so - "nothing changed" would be wrong)
      for (const [d, w] of [[O, 'old'], [N, 'new']] as const) {
        if (!d.items.length) throw new Error(`No BOQ items were found in the ${w} issue: none of its sheets has a header row with Description and Qty or Unit (Item / Description / Qty / Unit / Rate / Amount). A schedule or a summary without them cannot be compared item by item.`);
      }
      const r = compareBoq(O, N, opts);
      let pics: ReturnType<typeof pairPics>['entries'] | undefined;
      if (withPics) {
        // (a bill's pictures: one sequence a side, page by page - never items)
        if (picsOf.o.length || picsOf.n.length) {
          const pp = pairPics(picsOf.o, picsOf.n, (p) => pd.id('o|' + p.file), (p) => pd.id('n|' + p.file), furn);
          if (pd.failed) throw new Error(pf.READ_FAIL);
          pics = pp.entries;
          const c = (w: string) => pp.entries.filter((e) => e.what === w).length;
          const k = pp.same + pp.entries.length;
          r.neu.notes.push(`${k} picture${k === 1 ? '' : 's'} in the bills' pages compared: ${[pp.same && `${pp.same} the same`, c('changed') && `${c('changed')} changed`, c('added') && `${c('added')} added`, c('removed') && `${c('removed')} removed`].filter(Boolean).join(', ')} - a picture is never read as items: check it by eye`);
        }
        // (a workbook's pasted pictures, sheet by sheet: by their bytes; the file of the same name, or the one against the one)
        const one = media.o.size === 1 && media.n.size === 1;
        for (const [f, mo] of media.n) {
          const of = media.o.get(f) ?? (one ? [...media.o.values()][0] : undefined);
          if (!of) continue;
          for (const sh of new Set([...mo.keys(), ...of.keys()])) {
            const a = of.get(sh) ?? [], b = mo.get(sh) ?? [];
            if (a.join() === b.join()) continue;
            r.neu.notes.push(`${f} › ${sh}: a pasted picture changed (${a.length} -> ${b.length} picture${b.length === 1 ? '' : 's'}, ${b.filter((x) => !a.includes(x)).length} new or different) - open the workbook to see it; pictures in a workbook are not compared by their pixels`);
          }
        }
      }
      return { ...r, oldPdf: O.pdf, newPdf: N.pdf, ...(pics ? { pics } : {}) };
      } finally { pd.close(); }
    },
    /** documents compared (Documents tab): each side PDFs / Word files, read into sections and paragraphs */
    docsCompare(oldSide: { file: VFile; name: string }[], newSide: { file: VFile; name: string }[], opts: { ocr?: OcrWords } = {}) {
      const notes: string[] = [];
      const scans: Scan[] = [];
      const pdfs: NonNullable<DocsResult['pdfs']> = { o: [], n: [] };
      // (pictures inside the pages - T6.5; RR_OFF=pictures: as before. The PDFs stay open until their
      //  pictures are judged - read on demand since T4, an open file holds next to nothing)
      const withPics = !isOff('pictures');
      const pd = new PicDocs();
      const furn = { o: new Set<string>(), n: new Set<string>() };
      const wm = { o: new Map<string, string[]>(), n: new Map<string, string[]>() };
      try {
      const side = (fs2: { file: VFile; name: string }[], tag: 'o' | 'n', label: string): DocSection[] => {
        const out: DocSection[] = [];
        // (two files of one name - from two folders of the set: told apart, or their sheets would be one)
        const named = new Map<string, number>();
        const uniq = fs2.map((x, idx) => { const k = (named.get(x.name) || 0) + 1; named.set(x.name, k); return { ...x, idx, name: k > 1 ? `${x.name} (${k})` : x.name }; });
        for (const { file, name, idx } of uniq.sort((x, y) => byBill(x.name, y.name))) {
          const id = 'doc' + tag + ++seq;
          const inp = openInput(id, file);
          if (inp.pdf) {
            try {
              const sz = pf.pageSizes(id);
              pdfs[tag].push({ name, idx, sizes: sz.map((z) => ({ w: z.w, h: z.h })) });
              const empty: number[] = [];
              const key = tag + '|' + idx, scan: Scan = { key, name, side: tag, idx, pages: [] }, done = new Set<number>(), failed: number[] = [], leftOut: number[] = [];
              // (a 3,000-page spec book read page by page: what was read is let go every 40 pages)
              // (ruled tables read as tables - T6; RR_OFF=tables: as before)
              const tables = !isOff('tables');
              const pics: Pic[] = [];
              const ps = pdfParas(name, sz.length, (i) => {
                const w = pageText(id, i, key, opts.ocr, scan, done, failed, file.stamp);
                if (!w.length) empty.push(i + 1);
                // (its pictures, while the page is read in: under 8 words, the page itself)
                if (withPics) pics.push(...pagePics(id, name, i, w, sz[i]));
                if (i % 40 === 39) pf.dropPages(id);
                return w;
              }, (i) => sz[i].h, done, leftOut, tables ? (i) => pf.rules(id, i) : undefined);
              if (failed.length) notes.push(`${label}: ${name} - ${failed.length} scanned page${failed.length === 1 ? '' : 's'} could not be read by OCR (not compared): ${failed.slice(0, 8).join(', ')}${failed.length > 8 ? '…' : ''}`);
              if (leftOut.length) notes.push(`${label}: ${name} - scanned contents page${leftOut.length === 1 ? '' : 's'} left out: ${leftOut.join(', ')}`);
              pf.dropPages(id);
              if (scan.pages.length) scans.push(scan);
              for (const p of ps) if (done.has(p.page - 1)) p.ocr = true;
              if (done.size) notes.push(`${label}: ${name} - ${done.size} scanned page${done.size === 1 ? '' : 's'} read by OCR: words from a scan can be misread - its paragraphs are marked "check"`);
              if (withPics) {
                // (pages without text are compared as pictures; furniture - a logo on every page - left out)
                const fu = furniture(pics, (x) => lookOf(id, x));
                for (const x of fu) furn[tag].add(x.sha);
                if (fu.size) { const pg = new Set([...fu].map((x) => x.page)); notes.push(`${label}: ${name} - ${new Set([...fu].map((x) => x.sha)).size} picture${fu.size === 1 ? '' : 's'} on 3 pages or more (logo, letterhead, watermark) left out: ${pg.size === sz.length ? 'on every page' : `on ${pg.size} pages`}`); }
                const secs = sectionsOf(name, ps);
                placePics(secs, name, pics.filter((x) => !fu.has(x)));
                out.push(...secs);
              } else {
                if (empty.length > sz.length * 0.5) notes.push(`${label}: ${name} has no text on ${empty.length} of ${sz.length} pages${opts.ocr ? ' (OCR found none)' : ''} - not compared there`);
                else if (empty.length) notes.push(`${label}: ${name} - ${empty.length} page${empty.length === 1 ? '' : 's'} without text (pictures), not compared: ${empty.slice(0, 8).join(', ')}${empty.length > 8 ? '…' : ''}`);
                out.push(...sectionsOf(name, ps));
              }
              if (withPics) pd.add(tag + '|' + name, file);
            } finally { pf.closeDoc(id); }
          } else if (inp.bytes[0] === 0x50 && inp.bytes[1] === 0x4b) {
            // (a Word file read as text - no converter, or it could not be converted: its pictures by their media's hashes, T7)
            out.push(...sectionsOf(name, docxParas(name, inp.bytes)));
            wm[tag].set(name, zipMedia(inp.bytes));
          }
          else notes.push(`${label}: ${name} is not a PDF or Word (.docx) file - left out`);
        }
        return out;
      };
      const so = side(oldSide, 'o', 'Old'), sn = side(newSide, 'n', 'New');
      if (scans.length && !opts.ocr) return { scans };
      const oldPics = new Set(so.flatMap((s) => (s.pics ?? []).map((x) => x.p)));
      const r = docEntries(so, sn, withPics ? {
        judge: (a, b) => judge(pd.id('o|' + a.file), a, pd.id('n|' + b.file), b),
        look: (p) => lookOf(pd.id((oldPics.has(p) ? 'o|' : 'n|') + p.file), p),
        textLike: (p) => textLikeOf(pd.id((oldPics.has(p) ? 'o|' : 'n|') + p.file), p),
        furniture: furn,
      } : undefined, withPics ? wm : undefined);
      if (pd.failed) throw new Error(pf.READ_FAIL);
      r.notes.push(...notes);
      r.pdfs = pdfs;
      // (the paragraphs as read - T7: a Word file's in the result, the PDFs' in a file beside it)
      const pdfName = { o: new Set(pdfs.o.map((x) => x.name)), n: new Set(pdfs.n.map((x) => x.name)) };
      r.read = readingOf(so, sn, (t, f) => !pdfName[t].has(f));
      if (pdfs.o.length + pdfs.n.length) r.readFile = writeReading(so, sn, (t, f) => pdfName[t].has(f));
      // (the words in changed text-like pictures read by OCR in the window - 6.5b, gated: RR_OFF=picocr)
      r.picOcr = withPics && !isOff('picocr');
      return r;
      } finally { pd.close(); }
    },
    /** the PDFs' paragraphs as read, from the file docsCompare wrote (only such files) */
    docsReading(p: string): DocsReading {
      const f = path.resolve(String(p));
      if (path.dirname(f) !== readDir() || !/^read-[\w-]+\.json$/.test(path.basename(f))) throw new Error('Not a reading file');
      return JSON.parse(fs.readFileSync(f, 'utf8')) as DocsReading;
    },
    /** a page drawn grey for OCR (pdfopen.ts ocrPicture) */
    ocrPgm(file: VFile, page: number, dpi: number, quarter: number, denoise: number, rect?: number[] | null) { return ocrPicture(file, page, dpi, quarter, denoise, rect); },
    /** a BOQ PDF's page as a picture for the side-by-side view (pdfopen.ts pagePicture) */
    boqPage(file: VFile, page: number, scale: number) { return pagePicture(file, page, scale); },
    /** the BOQ's pages no longer shown: their files let go */
    boqPagesDone() { return pagesDone(); },
    /** OCR done: the files kept open for its pictures let go */
    ocrDone() { return ocrDone(); },
    /** a finished export part renamed ("x.pdf" -> "x (part 1).pdf") */
    renamePdf(from: string, to: string) {
      if (!/\.pdf$/i.test(from) || !/\.pdf$/i.test(to)) throw new Error('Not a PDF file name');
      fs.renameSync(from, to);
      return true;
    },
  };
}

// ---------------------------------------------------------------- calls

/** a call's arguments: { $file } becomes a file read on demand - for a file with monster pages,
 *  the file plus their merged strokes (heavy.ts), except where only page sizes are read */
async function inArgs(v: unknown, files: VFile[], heavy: boolean, depth = 0): Promise<unknown> {
  if (!v || typeof v !== 'object' || depth > 5) return v;
  if (ArrayBuffer.isView(v)) return v;
  const f = (v as { $file?: unknown }).$file;
  if (f && isFileSrc(f)) {
    const src = f as FileSrc;
    const vf = new VFile(heavy && !src.delta ? await readable(src.path) : src);
    files.push(vf);
    return vf;
  }
  if (Array.isArray(v)) { const out: unknown[] = []; for (const x of v) out.push(await inArgs(x, files, heavy, depth + 1)); return out; }
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) o[k] = await inArgs(x, files, heavy, depth + 1);
  return o;
}
/** calls that only read page sizes: the file as it is */
const SIZES_ONLY = new Set(['info']);

const isFatal = pf.isFatalError;

/** methods whose files stay open after the call (the documents read from them later) */
const KEEPS = new Set(['viewOpen']);

let chain: Promise<void> = Promise.resolve();
let exiting = false;
/** the two comparisons that can come back asking for OCR and be asked again: the first pass keeps the
 *  words it read for the second, which lets them go (pagetext.ts) */
const keepsWords = (f: Handler): Handler => (a: unknown, b: unknown, opts: { ocr?: unknown } = {}) => {
  wordKeep.begin(!!opts.ocr);
  let r: { scans?: unknown[] } | undefined;
  try { return (r = f(a, b, opts) as { scans?: unknown[] }); } finally { wordKeep.end(!!opts.ocr, !!r?.scans?.length); }
};
const ready: Promise<Record<string, Handler>> = handlers().then((h) => { const m = more(); return { ...h, ...m, boqCompare: keepsWords(m.boqCompare), docsCompare: keepsWords(m.docsCompare) }; });

const ports: PortMain[] = [];
/** the newest call that came in per lane (see EngineClient.call) */
const newest = new Map<string, number>();
function serve(port: PortMain) {
  ports.push(port);
  port.on('message', (e) => {
    const { id, method, args, lane } = e.data as { id: number; method: string; args: unknown[]; lane?: string };
    if (lane) newest.set(lane, id);
    chain = chain.then(async () => {
      if (exiting) { port.postMessage({ id, ok: false, error: 'engine restarting', retry: true }); return; }
      if (lane) {
        // (calls that arrived while the one before was drawing are read in first)
        await new Promise((r) => setImmediate(r));
        if (newest.get(lane) !== id) { port.postMessage({ id, ok: false, error: SUPERSEDED }); return; }
      }
      const files: VFile[] = [];
      let fatal = false, failed = false;
      try {
        const h = (await ready)[method];
        if (!h) throw new Error('unknown call ' + method);
        const a: unknown[] = [];
        for (const x of args || []) a.push(await inArgs(x, files, !SIZES_ONLY.has(method)));
        // (T22 B: the memory a view document's call takes, put down to that document)
        const viewKey = method.startsWith('view') && typeof args?.[0] === 'string' ? args[0] as string : null;
        const before = viewKey ? pf.heapBytes() + muHeap() : 0;
        testHang(method); // (tests only: RR_TEST_HANG)
        const value = await h(...a);
        if (viewKey) { const d = pf.heapBytes() + muHeap() - before; if (d > 0) grew.set(viewKey, (grew.get(viewKey) ?? 0) + d); }
        // a file that stopped reading part way gives a wrong answer that looks right (blank or half
        // drawn pages): never pass it on
        if (files.some((f) => f.failed)) throw new Error(pf.READ_FAIL);
        port.postMessage({ id, ok: true, value });
      } catch (err) {
        failed = true;
        fatal = isFatal(err);
        if (fatal || !(err instanceof Error)) console.error(`call ${method} failed${fatal ? ' (fatal)' : ''}: ${err instanceof Error ? err.stack : String(err)}`);
        port.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err), fatal });
      } finally {
        if (failed || !KEEPS.has(method)) for (const f of files) f.close();
      }
      if (fatal) { exiting = true; parentPort.postMessage({ type: 'fatal' }); setTimeout(() => process.exit(70), 50); return; }
      try {
        const why = shouldRecycle({ uptime: process.uptime(), pdfHeap: pf.heapBytes(), muHeap: muHeap(), muOpen: muOpenCount(), viewDocs: viewDocs.length });
        if (why) {
          // tell the window first: it holds new calls for the next engine (calls already on their
          // way are answered 'retry' and sent again)
          console.error(`starting afresh: ${why} memory ${Math.round((why === 'mupdf' ? muHeap() : pf.heapBytes()) / 2 ** 20)} MB`);
          exiting = true;
          for (const p of ports) p.postMessage({ notice: 'recycling' });
          setTimeout(() => process.exit(75), 50);
        }
      } catch { /* */ }
    });
  });
  port.start();
}

parentPort.on('message', (e) => {
  if (e.data && e.data.type === 'port' && e.ports && e.ports[0]) serve(e.ports[0]);
});
ready.then(() => parentPort.postMessage({ type: 'ready', pid: process.pid }), (err) => {
  parentPort.postMessage({ type: 'failed', error: String((err && err.stack) || err) });
  setTimeout(() => process.exit(71), 50);
});
