/**
 * MuPDF's memory in this engine (0.6.0 T22, as the PDF Editor 0.13's mu.ts heap()): its WebAssembly
 * memory only grows - a heavy merge or blended sheets drawn by MuPDF leave it at its peak (T19 probe:
 * 22 MB -> 506 MB after one 15 M-stroke merge, kept to the end). 0 while MuPDF was never loaded here
 * (an engine that never needed it does not load it to ask).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let M: any = null;
/** called by whoever loads MuPDF in this engine (murender.ts, heavy.ts - the same module, one heap) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function noteMu(m: any) { if (m) M = m; }
/** bytes of MuPDF's WebAssembly memory: the buffer under a Buffer's view of it */
export function muHeap(): number {
  if (!M) return 0;
  try {
    const b = new M.Buffer();
    try { b.writeByte(0); return b.asUint8Array().buffer.byteLength; } finally { b.destroy?.(); }
  } catch { return 0; }
}

/** PDFium's WebAssembly memory only grows (to 2 GB at most): an engine past this starts afresh after its call */
export const RECYCLE_AT = 1.25 * 1024 ** 3;
/** MuPDF's, in an engine that has merged a heavy sheet since it started: past this it starts afresh at the next moment
 *  it holds no MuPDF document (DECISIONS 105 / 114: a monster merge leaves 680 MB; once per file, so it cannot repeat) */
export const MU_RECYCLE_AT = 400 * 1024 ** 2;
/** MuPDF's, in an engine that has only drawn (blended sheets): a guard against a climb, not a give-back - one blended A0
 *  pair leaves ~524 MB and the next takes it straight back (DECISIONS 114) */
export const MU_DRAWN_AT = 1024 * 1024 ** 2;
let merged = false;
/** a heavy sheet was merged in this engine (heavy.ts) */
export function noteMerge() { merged = true; }
export const mergedHere = () => merged;
/** the MuPDF bar for this engine: by what put the memory there */
export const muBar = (m = merged) => (m ? MU_RECYCLE_AT : MU_DRAWN_AT);
/**
 * After a call: does the engine start afresh (the window is told 'recycling', the engine exits 75)? Never in the
 * first 20 s, never while it holds a view document (the viewer's sheets would go with it). PDFium past RECYCLE_AT
 * (as before 0.6.0); MuPDF past its bar (muBar: 400 MB after a merge, 1 GB if only drawn) while no MuPDF document is open.
 */
export function shouldRecycle(s: { uptime: number; pdfHeap: number; muHeap: number; muOpen: number; viewDocs: number; merged?: boolean }): 'pdfium' | 'mupdf' | null {
  if (s.uptime <= 20 || s.viewDocs > 0) return null;
  if (s.pdfHeap > RECYCLE_AT) return 'pdfium';
  if (s.muHeap > muBar(s.merged ?? merged) && s.muOpen === 0) return 'mupdf';
  return null;
}
