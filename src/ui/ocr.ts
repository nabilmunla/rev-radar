// OCR of scanned PDF pages for the BOQ and Documents tabs: Tesseract (WebAssembly, offline), English
// (BOQs and specifications are: English + Arabic read Arabic marks into them - "‏م‎" for an "A") -
// the PDF Editor 0.8.9's engine pool and reading (src/ui/ocr.ts there), the
// page pictures drawn and cleaned by a Rev Radar engine (ocrPgm in engine/host.ts). The words come
// back as PDFium words in page points, for the readers (pdftable.ts, docs.ts) to read like text.
import { createWorker, type Worker as TWorker } from 'tesseract.js';
import type { EngineClient } from '../engine/rpc';
import { fileArg } from '../engine/rpc';
import type { Word } from '../engine/pdfium';

type Lang = 'eng';
interface Pool { workers: TWorker[]; free: TWorker[]; waiting: { res(w: TWorker): void; rej(e: Error): void }[]; ended?: boolean }
let pool: Promise<Pool> | null = null;
let using = 0;
let idleT: ReturnType<typeof setTimeout> | null = null;

/** Tesseract engines at once: about one per physical core, at most 4 (each ~150 MB) */
const size = () => Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)));

async function makePool(lang: Lang): Promise<Pool> {
  const base = new URL('./ocr/', location.href).href;
  const make = () => createWorker(lang.split('+'), 1, { workerPath: base + 'worker.min.js', corePath: base + 'core', langPath: base + 'lang', gzip: true, cacheMethod: 'none', workerBlobURL: false });
  // (one engine that can't start: the ones started are ended too, not left running unseen)
  const made = await Promise.allSettled(Array.from({ length: size() }, make));
  const workers = made.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  try {
    const bad = made.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (bad) throw bad.reason;
    for (const w of workers) await w.setParameters({ preserve_interword_spaces: '1' } as never);
  } catch (e) {
    for (const w of workers) void w.terminate().catch(() => {});
    throw e;
  }
  return { workers, free: workers.slice(), waiting: [] };
}
async function hold(): Promise<Pool> {
  using++;
  if (idleT) { clearTimeout(idleT); idleT = null; }
  if (!pool) { const p = makePool('eng'); pool = p; p.catch(() => { if (pool === p) pool = null; }); }
  try { return await pool; } catch (e) { release(); throw e; }
}
/** the engines let go a minute after the last job (each holds ~150 MB) */
function release() {
  using = Math.max(0, using - 1);
  if (using || idleT) return;
  idleT = setTimeout(() => { idleT = null; if (!using) void stopOcr(); }, 60_000);
}
async function take(p: Pool): Promise<TWorker> {
  if (p.ended) throw new Error('OCR was stopped.');
  const w = p.free.pop();
  if (w) return w;
  return new Promise((res, rej) => p.waiting.push({ res, rej }));
}
function give(p: Pool, w: TWorker) {
  if (p.ended) return;
  const n = p.waiting.shift();
  if (n) n.res(w); else p.free.push(w);
}
export async function stopOcr() {
  const pp = pool;
  pool = null;
  if (!pp) return;
  try { const p = await pp; p.ended = true; for (const w of p.workers) void w.terminate().catch(() => {}); for (const q of p.waiting.splice(0)) q.rej(new Error('OCR was stopped.')); } catch { /* never made */ }
}

interface Raw { words: { text: string; conf: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[]; angle: number; conf: number }
async function recognise(p: Pool, pgm: Uint8Array): Promise<Raw> {
  const w = await take(p);
  try {
    // rotateAuto: Tesseract straightens slightly crooked scans itself
    const r = await w.recognize(pgm as unknown as Blob, { rotateAuto: true }, { blocks: true, text: false });
    const words: Raw['words'] = [];
    for (const b of r.data.blocks || []) for (const para of b.paragraphs) for (const line of para.lines) for (const wd of line.words) {
      const t = wd.text.trim();
      if (t) words.push({ text: t, conf: wd.confidence, bbox: wd.bbox });
    }
    const conf = words.length ? words.reduce((s, x) => s + x.conf * x.text.length, 0) / words.reduce((s, x) => s + x.text.length, 0) : 0;
    return { words, angle: (r.data as unknown as { rotateRadians?: number }).rotateRadians || 0, conf };
  } finally { give(p, w); }
}

interface Pic { pgm: Uint8Array; scale: number; W: number; H: number; OW: number; OH: number; quarter: number }
const picture = async (c: EngineClient, path: string, page: number, dpi: number, quarter = 0, denoise = 1): Promise<Pic> =>
  ({ ...(await c.call<Omit<Pic, 'quarter'>>('ocrPgm', [fileArg(path), page, dpi, quarter, denoise])), quarter });

/** one page read: words in page points (top-down) - a doubtful read is tried turned and cleaner,
 *  as the PDF Editor does */
async function readPage(p: Pool, c: EngineClient, path: string, page: number): Promise<Word[]> {
  const dpi = 300;
  let img = await picture(c, path, page, dpi);
  let res = await recognise(p, img.pgm);
  const cleaner = async (q: number) => {
    if (res.conf >= 78 || res.words.length <= 3) return;
    const img2 = await picture(c, path, page, dpi, q, 2);
    const res2 = await recognise(p, img2.pgm);
    if (res2.conf > res.conf + 3) { img = img2; res = res2; }
  };
  const doubtful = () => res.conf < 55 || res.words.length < 8;
  const turn = async () => {
    const best = { q: 0, conf: res.conf, n: res.words.length };
    const probes = await Promise.all([1, 2, 3].map(async (q) => recognise(p, (await picture(c, path, page, 150, q)).pgm)));
    probes.forEach((r, k) => { if (r.conf * Math.min(1, r.words.length / 20) > best.conf * Math.min(1, best.n / 20) + 8) Object.assign(best, { q: k + 1, conf: r.conf, n: r.words.length }); });
    if (!best.q) return false;
    img = await picture(c, path, page, dpi, best.q);
    res = await recognise(p, img.pgm);
    await cleaner(best.q);
    return true;
  };
  if (doubtful()) { if (!(await turn())) await cleaner(0); } else { await cleaner(0); if (doubtful()) await turn(); }
  // boxes back to page points: undo Tesseract's own straightening, then the 90° turn
  const cx = img.OW / 2, cy = img.OH / 2;
  const ca = Math.cos(-res.angle), sa = Math.sin(-res.angle);
  const unrot = (x: number, y: number): [number, number] => [cx + (x - cx) * ca - (y - cy) * sa, cy + (x - cx) * sa + (y - cy) * ca];
  const unturn = (x: number, y: number): [number, number] => {
    switch (img.quarter) { case 1: return [y, img.H - x]; case 2: return [img.W - x, img.H - y]; case 3: return [img.W - y, x]; default: return [x, y]; }
  };
  const out: Word[] = [];
  for (const wd of res.words) {
    if (wd.conf < 20) continue;
    // (a table's ruling read as a letter: "|Description", "[1360x550", a lone "|")
    const t = wd.text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/^[|[\]{}_]+|[|[\]{}_]+$/g, '');
    if (!t) continue;
    wd.text = t;
    const pts = [[wd.bbox.x0, wd.bbox.y0], [wd.bbox.x1, wd.bbox.y0], [wd.bbox.x1, wd.bbox.y1], [wd.bbox.x0, wd.bbox.y1]].map(([x, y]) => unturn(...(res.angle ? unrot(x, y) : ([x, y] as [number, number]))));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    out.push({ s: wd.text, x0: Math.min(...xs) / img.scale, y0: Math.min(...ys) / img.scale, x1: Math.max(...xs) / img.scale, y1: Math.max(...ys) / img.scale });
  }
  return out;
}

/** a picture's box is read at this density (its pictures are rarely finer; 300 cost Tesseract more memory) */
const PIC_DPI = 200;
/** a part of a page read (a picture's box, T6.5b): its words in page points - one read at 300 dpi, the
 *  picture as it is (no turning: a picture on a text page stands as the page) */
async function readRegion(p: Pool, c: EngineClient, path: string, page: number, rect: number[]): Promise<Word[]> {
  const img = await c.call<{ pgm: Uint8Array; scale: number; ox: number; oy: number }>('ocrPgm', [fileArg(path), page, PIC_DPI, 0, 1, rect]);
  const res = await recognise(p, img.pgm);
  const out: Word[] = [];
  for (const wd of res.words) {
    if (wd.conf < 20) continue;
    const t = wd.text.replace(/^[|[\]{}_]+|[|[\]{}_]+$/g, '');
    if (t) out.push({ s: t, x0: img.ox + wd.bbox.x0 / img.scale, y0: img.oy + wd.bbox.y0 / img.scale, x1: img.ox + wd.bbox.x1 / img.scale, y1: img.oy + wd.bbox.y1 / img.scale });
  }
  return out;
}
/** pictures' boxes read by OCR (T6.5b), as many at once as there are OCR engines; null: not read */
export async function ocrRegions(c: EngineClient, jobs: { path: string; page: number; rect: number[] }[], live: () => boolean): Promise<(Word[] | null)[]> {
  const out: (Word[] | null)[] = jobs.map(() => null);
  if (!jobs.length) return out;
  let p: Pool;
  try { p = await hold(); } catch (e) { console.warn('OCR could not start:', (e as Error)?.message ?? e); return out; }
  let next = 0;
  try {
    const lane = async () => { while (next < jobs.length && live()) { const k = next++, j = jobs[k]; try { out[k] = await readRegion(p, c, j.path, j.page, j.rect); } catch (e) { console.warn('OCR of a picture could not be read:', (e as Error)?.message ?? e); } } };
    await Promise.all(Array.from({ length: Math.min(size(), jobs.length) }, lane));
  } finally { release(); void c.call('ocrDone').catch(() => {}); }
  return out;
}

export interface ScanJob { key: string; path: string; pages: { i: number }[] }
/** words by file key and page; null: the page could not be read (said in the notes, not "no words") */
export type OcrOut = Record<string, Record<number, Word[] | null>>;
/**
 * Read the scanned pages of several files, as many pages at once as there are OCR engines.
 * `progress(done, total)` after each page; `live()` false stops (the comparison was left).
 * A page that can't be read stays without words (said in the notes by the engine).
 */
export async function ocrScans(c: EngineClient, jobs: ScanJob[], progress: (done: number, total: number) => void, live: () => boolean): Promise<OcrOut> {
  const out: OcrOut = {};
  const todo = jobs.flatMap((j) => j.pages.map((p) => ({ j, i: p.i })));
  for (const j of jobs) out[j.key] = {};
  if (!todo.length) return out;
  let p: Pool;
  // (OCR that can't start: every scanned page "could not be read" - the comparison goes on without)
  try { p = await hold(); } catch (e) { console.warn('OCR could not start:', (e as Error)?.message ?? e); for (const t of todo) out[t.j.key][t.i] = null; return out; }
  let next = 0, done = 0;
  try {
    const lane = async () => {
      while (next < todo.length && live()) {
        const t = todo[next++];
        try { out[t.j.key][t.i] = await readPage(p, c, t.j.path, t.i); } catch (e) { console.warn('OCR page', t.i + 1, 'of', t.j.path, 'could not be read:', (e as Error)?.message ?? e); out[t.j.key][t.i] = null; }
        progress(++done, todo.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(size(), todo.length) }, lane));
  } finally { release(); void c.call('ocrDone').catch(() => {}); }
  return out;
}
