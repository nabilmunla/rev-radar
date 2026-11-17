// "Text as read" laid out (T7, DECISIONS 23): a text document's blocks wrapped to a width, each block's height
// from its measured lines, so a long paragraph is shown whole. Pure - the face's measure comes in as a
// function (sideview.tsx gives it a canvas's; the tests a fixed-width one).
// A place in a text doc is a block's index and a fraction of it ("unit"); the layout turns that into pixels
// and back, so marks, anchors and N / P stepping stay the same when the width or the zoom changes.

/** one block: a paragraph (its clause number and text), a table row (its cells), or a picture's placeholder line */
export interface LayBlock {
  /** the heading path, set when it differs from the block before's */
  head: string;
  num: string;
  text: string;
  cells?: string[];
  /** a picture's placeholder: its label */
  pic?: string;
}
/** the sizes at a zoom (px) - the same numbers lay the text out and draw it */
export function geom(z: number) {
  return { fs: 13 * z, lh: Math.round(18 * z), padY: Math.round(6 * z), padX: Math.round(8 * z), headH: Math.round(16 * z), headFs: 11 * z, numW: Math.round(54 * z), cellPad: Math.round(5 * z) };
}
export type Measure = (s: string) => number;

/** the lines a text takes in `width`: greedy at the spaces; a word wider than the line is broken anywhere */
export function wrapLines(text: string, width: number, m: Measure): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const sp = m(' ');
  let lines = 1, cur = 0;
  const longWord = (w: string) => {
    // (the word on a line of its own, wider than it: broken where the line is full)
    let used = 0;
    for (const c of w) { const cw = m(c); if (used + cw > width && used > 0) { lines++; used = 0; } used += cw; }
    cur = used;
  };
  for (const w of words) {
    const ww = m(w);
    if (cur === 0) { if (ww <= width) cur = ww; else longWord(w); continue; }
    if (cur + sp + ww <= width) { cur += sp + ww; continue; }
    lines++; cur = 0;
    if (ww <= width) cur = ww; else longWord(w);
  }
  return lines;
}

export interface Layout {
  /** each block's top and height (px), the whole height */
  tops: number[]; hs: number[]; total: number;
  /** a place (block index + fraction) in pixels and back */
  px(u: number): number;
  unit(y: number): number;
}
/** the blocks laid out to a width at a zoom */
export function layoutText(blocks: LayBlock[], W: number, z: number, m: Measure): Layout {
  const g = geom(z);
  const textW = Math.max(40, W - g.numW - 2 * g.padX);
  const tops: number[] = [], hs: number[] = [];
  let y = 0;
  for (const b of blocks) {
    let lines = 1;
    if (b.cells) { const cw = Math.max(20, textW / b.cells.length - 2 * g.cellPad); for (const c of b.cells) lines = Math.max(lines, wrapLines(c, cw, m)); }
    else if (!b.pic) lines = Math.max(wrapLines(b.text, textW, m), b.num ? wrapLines(b.num, g.numW - 8, m) : 1);
    const h = (b.head ? g.headH : 0) + g.padY + lines * g.lh;
    tops.push(y); hs.push(h); y += h;
  }
  const n = blocks.length;
  return {
    tops, hs, total: y,
    px: (u) => { if (u <= 0) return 0; if (u >= n) return y; const i = Math.floor(u); return tops[i] + (u - i) * hs[i]; },
    unit: (p) => {
      if (p <= 0) return 0;
      if (p >= y) return n;
      let lo = 0, hi = n - 1;
      while (lo < hi) { const md = (lo + hi + 1) >> 1; if (tops[md] <= p) lo = md; else hi = md - 1; }
      return lo + (p - tops[lo]) / hs[lo];
    },
  };
}

let ctx: CanvasRenderingContext2D | null = null;
/** word widths kept per face (a face is a family at a size): a layout again at the same zoom measures nothing new */
const faces = new Map<string, Map<string, number>>();
/** a face loaded: what was measured before it was is forgotten */
export const forgetWidths = () => faces.clear();
/** a canvas's measure of the text face at a zoom */
export function canvasMeasure(family: string, z: number): Measure {
  ctx ??= document.createElement('canvas').getContext('2d')!;
  const c = ctx, font = `${13 * z}px ${family}`;
  if (faces.size > 12) faces.clear();
  let kept = faces.get(font);
  if (!kept) faces.set(font, (kept = new Map()));
  const k = kept;
  return (s) => {
    let w = k.get(s);
    if (w === undefined) { if (c.font !== font) c.font = font; w = c.measureText(s).width; if (k.size > 150000) k.clear(); k.set(s, w); }
    return w;
  };
}
