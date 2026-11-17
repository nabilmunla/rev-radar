// A PDF page's words for the BOQ and Documents comparisons (host.ts boqCompare / docsCompare), and
// the words the first pass keeps for the pass after OCR (PLAN T5b, AUDIT A8).
//
// A set with scanned pages is compared twice: the first pass finds the scans and answers "read these"
// (everything else it read is thrown away); the window reads them by OCR and asks again, and the
// second pass read every text page again. Now the first pass keeps the words it read, by file stamp
// (path, size, time) and page, and the second pass takes them from there - and with them whether the
// page was a scan, so it does not even load the page. Bounded and short-lived:
//  - kept only when the first pass found scans (a set without any: nothing is held after the call);
//  - at most KEEP_MAX bytes (an estimate, see `size`) - beyond it a page is read again;
//  - before the first scan has been found only TENTATIVE_MAX of it is recorded, so a big set without
//    scans does not hold 200 MB it will never use;
//  - let go when the second pass's answer is sent (or it fails), when another first pass starts, and
//    after IDLE_MS without a call of the same set (the window left it).
import * as pf from './pdfium';

/** words read by OCR in the window, by side and the file's place in its set ("o|2") and page - null:
 *  the page could not be read */
export type OcrWords = Record<string, Record<number, pf.Word[] | null>>;
/** a file's scanned pages, for the window to read by OCR (idx: the file's place in the set it sent -
 *  two files of a folder set may have the same name) */
export interface Scan { key: string; name: string; side: 'o' | 'n'; idx: number; pages: { i: number; w: number; h: number }[] }
/** a page with (almost) no text and a picture over most of it: a scan */
export const scanned = (id: string, i: number, w: pf.Word[]) => w.length < 8 && pf.pageKind(id, i).imageArea >= 0.5;

export const KEEP_MAX = 200 * 2 ** 20;
export const TENTATIVE_MAX = 32 * 2 ** 20;
export const IDLE_MS = 10 * 60 * 1000;
/** the three bounds (a property so a test can lower them) */
export const limits = { keep: KEEP_MAX, tentative: TENTATIVE_MAX, idleMs: IDLE_MS };

/** what a page's words hold on the JS heap, estimated (a word: its object and four boxed numbers, its
 *  string: ~167 bytes a word of 4 letters in V8 here; tests/pagetext.test.ts checks the estimate is not under what the heap grows by) */
export const size = (w: pf.Word[]): number => {
  let n = 64 + w.length * 8;
  for (const x of w) n += 160 + 2 * x.s.length;
  return n;
};

interface Kept { w: pf.Word[]; scan: boolean }
class WordKeep {
  private files = new Map<string, Map<number, Kept>>();
  private bytes = 0;
  private sawScan = false;
  private recording = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** a first pass begins (what an earlier set left is let go) / the second pass begins (what the first kept stays) */
  begin(second: boolean): void {
    if (second) { this.arm(); this.recording = false; return; }
    this.release();
    this.recording = true;
  }
  /** the pass is over: the first pass's words stay only if it found scans */
  end(second: boolean, scansFound: boolean): void {
    if (second || !scansFound) { this.release(); return; }
    this.recording = false;
    this.arm();
  }
  release(): void {
    this.files.clear(); this.bytes = 0; this.sawScan = false; this.recording = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.release(), limits.idleMs);
    this.timer.unref?.();
  }
  /** the first pass read this page */
  record(stamp: string, i: number, w: pf.Word[], scan: boolean): void {
    if (!this.recording) return;
    if (scan) this.sawScan = true;
    const n = size(w);
    if (this.bytes + n > (this.sawScan ? limits.keep : limits.tentative)) return;
    let f = this.files.get(stamp);
    if (!f) this.files.set(stamp, (f = new Map()));
    f.set(i, { w, scan });
    this.bytes += n;
  }
  get(stamp: string, i: number): Kept | undefined { return this.files.get(stamp)?.get(i); }
  held(): { bytes: number; pages: number } {
    let pages = 0;
    for (const f of this.files.values()) pages += f.size;
    return { bytes: this.bytes, pages };
  }
}
export const wordKeep = new WordKeep();

/** a PDF page's words - a scan's from the OCR the window did (with what text the page has: a typed
 *  stamp), else noted for it to do. `stamp`: the file's (VFile.stamp), where the first pass kept the
 *  page's words. */
export function pageText(id: string, i: number, key: string, ocr: OcrWords | undefined, scan: Scan, done: Set<number>, failed: number[], stamp: string): pf.Word[] {
  const hit = wordKeep.get(stamp, i);
  const w = hit ? hit.w : pf.words(id, i);
  const isScan = hit ? hit.scan : scanned(id, i, w);
  if (!hit) wordKeep.record(stamp, i, w, isScan);
  if (!isScan) return w;
  const o = ocr?.[key]?.[i];
  if (o) { done.add(i); return [...w, ...o]; }
  if (o === null) { failed.push(i + 1); return w; }
  if (!ocr) { const sz = pf.pageSizes(id)[i]; scan.pages.push({ i, w: sz.w, h: sz.h }); }
  return w;
}
