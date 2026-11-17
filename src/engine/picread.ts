// T6.5b (DECISIONS 40-42): the words in a changed picture, read by OCR - only to say *what* changed where
// the pixels already said *that* and *where*. Two readings of the same pixels differ by themselves, so a
// word is shown only inside a changed area (area by area, the old reading against the new); elsewhere the
// pictures are the same and a difference would be a misread. Never made into paragraphs or BOQ items.
// Pure: tests/picread.test.ts.
import type { Word } from './pdfium';
import { strictWord } from './boq';

/** a picture's change as the engine gave it (docs.ts PicChange, picdiff.ts BoqPic): areas both sides */
export interface PicAreas { what: 'changed' | 'added' | 'removed'; o?: number[][]; n?: number[][] }

/** words touching a box, in reading order (lines by height, each left to right) */
export function wordsIn(ws: Word[], a: number[]): string {
  const hit = ws.filter((w) => w.x1 >= a[0] - 1 && w.x0 <= a[2] + 1 && w.y1 >= a[1] - 1 && w.y0 <= a[3] + 1).sort((p, q) => (p.y0 + p.y1) - (q.y0 + q.y1));
  const lines: Word[][] = [];
  for (const w of hit) {
    const l = lines[lines.length - 1];
    if (l && Math.abs((w.y0 + w.y1) / 2 - (l[0].y0 + l[0].y1) / 2) < Math.max(w.y1 - w.y0, l[0].y1 - l[0].y0) * 0.55) l.push(w); else lines.push([w]);
  }
  return lines.map((l) => l.sort((p, q) => p.x0 - q.x0).map((w) => w.s).join(' ')).join(' ');
}
const key = (t: string) => t.split(/\s+/).map(strictWord).filter(Boolean).join(' ');
const cut = (t: string, n = 60) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/**
 * What OCR read where a picture changed: for each changed area (the same area on both sides), the old
 * words in it -> the new ("304 -> 316"); an area read the same both ways says nothing. An added or removed
 * picture: what it says. null words: not read.
 */
export function picRead(p: PicAreas, ow: Word[] | null, nw: Word[] | null): { pairs: [string, string][]; text: string } {
  if (p.what === 'changed') {
    if (!ow || !nw) return { pairs: [], text: '' };
    const pairs: [string, string][] = [];
    (p.n ?? []).forEach((b, k) => {
      const a = p.o?.[k];
      if (!a) return;
      const x = wordsIn(ow, a), y = wordsIn(nw, b);
      if (key(x) !== key(y)) pairs.push([x, y]);
    });
    return { pairs, text: pairs.map(([x, y]) => `${cut(x) || '(nothing)'} → ${cut(y) || '(nothing)'}`).join(' · ') };
  }
  const ws = p.what === 'added' ? nw : ow, box = (p.what === 'added' ? p.n : p.o)?.[0];
  if (!ws || !box) return { pairs: [], text: '' };
  const t = wordsIn(ws, box);
  return { pairs: [], text: t ? cut(t, 120) : '' };
}
