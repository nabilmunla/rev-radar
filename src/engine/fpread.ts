// What a page says, for pairing the sheets of two issues (the engine's `fingerprint` call): its words, upper case, and
// the sheet reader's candidates (`toks`, T11 - DECISIONS 75) read from the characters of the page the words came from.
// The reader (src/ui/sheets.ts) is the PDF Editor's file, pure, and bundled into the engine here.
import type { VFile } from './files';
import * as pf from './pdfium';
import { tokensOf, type PageToks } from '../ui/sheets';

export interface PageFingerprint { page: number; words: string[]; toks?: PageToks; error?: string }

let seq = 0;
export function fingerprintPages(src: VFile, pages: number[]): PageFingerprint[] {
  const id = 'f' + ++seq;
  pf.openDoc(id, src);
  try {
    const sizes = pf.pageSizes(id);
    return pages.map((p): PageFingerprint => {
      try {
        const ws = pf.words(id, p);
        // (the characters before the page is let go; a throw here is only the reader's loss - the words stay)
        let toks: PageToks | undefined;
        try {
          const s = sizes[p];
          let label = '';
          try { label = pf.pageLabel(id, p); } catch { /* none */ }
          toks = tokensOf(p, pf.chars(id, p), s.w, s.h, label);
        } catch { toks = undefined; }
        pf.dropPages(id);
        const out: PageFingerprint = { page: p, words: ws.map((w) => w.s.toUpperCase()).filter((s) => s.length >= 2).slice(0, 4000) };
        if (toks) out.toks = toks;
        return out;
      } catch (e) { return { page: p, words: [], error: String(e) }; }
    });
  } finally { pf.closeDoc(id); }
}
