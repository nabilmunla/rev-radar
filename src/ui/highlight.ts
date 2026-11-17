// The highlighter (toolbar / H): the paper inside the change boxes goes pale yellow, the ink keeps
// its colour. Pure: unit-tested in tests/highlight.test.ts.
//
// (A plain 'darken' / 'multiply' fill lowers the blue of everything under it: the overlay's blue
//  "added" lines went dark teal in a highlighted box - the one colour that must not change.)

/** a highlighted spot on screen (CSS pixels); dot: a change too small to see, given a round dot */
export interface Spot { x: number; y: number; w: number; h: number; dot: boolean }

/** the highlighter colour (the paper turns this) */
export const TINT = [255, 240, 160] as const;
/** paper: what is lighter than this (darkest channel) - the faintest unchanged line the overlay draws
 *  at the default fade is ~221, a full one 172; at fade 0.9 a full line is ~236 */
const PAPER = 236;

/**
 * Which pixels of the box [x0, y0, x0 + bw, y0 + bh] (device pixels) lie in a spot: 1, else 0.
 * Spots that overlap are one patch - the yellow does not add up where boxes cross.
 */
export function spotMask(spots: Spot[], D: number, x0: number, y0: number, bw: number, bh: number): Uint8Array {
  const m = new Uint8Array(bw * bh);
  for (const s of spots) {
    const sx0 = Math.max(x0, Math.floor(s.x * D)), sy0 = Math.max(y0, Math.floor(s.y * D));
    const sx1 = Math.min(x0 + bw, Math.ceil((s.x + s.w) * D)), sy1 = Math.min(y0 + bh, Math.ceil((s.y + s.h) * D));
    if (sx1 <= sx0 || sy1 <= sy0) continue;
    // (a dot: the ellipse in its box - a circle, or a capsule-ish oval for a thin long change)
    const cx = (s.x + s.w / 2) * D, cy = (s.y + s.h / 2) * D, rx = (s.w * D) / 2, ry = (s.h * D) / 2;
    for (let y = sy0; y < sy1; y++) {
      const row = (y - y0) * bw - x0;
      const ey = s.dot ? ((y + 0.5 - cy) / ry) ** 2 : 0;
      if (ey > 1) continue;
      for (let x = sx0; x < sx1; x++) {
        if (s.dot && ((x + 0.5 - cx) / rx) ** 2 + ey > 1) continue;
        m[row + x] = 1;
      }
    }
  }
  return m;
}

/**
 * Tint the masked pixels (RGBA): only paper moves - white paper becomes TINT, the soft edge of a line
 * a little - and every line (the grey of unchanged ones at any usual fade, red, blue, black) stays
 * exactly as it is. (0.3.3 moved everything lighter than the tint's darkest channel, 160: the grey of
 * unchanged lines, 172-223 at the default fade, went yellow in every box.)
 */
export function tintPaper(d: Uint8ClampedArray, mask: Uint8Array, paper = PAPER): void {
  const PAPER_ = paper, span = 255 - PAPER_, dr = 255 - TINT[0], dg = 255 - TINT[1], db = 255 - TINT[2];
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    if (!mask[i]) continue;
    const r = d[j], g = d[j + 1], b = d[j + 2];
    const lo = r < g ? (r < b ? r : b) : g < b ? g : b;
    if (lo <= PAPER_) continue;
    const w = (lo - PAPER_) / span;
    d[j] = r - w * dr; d[j + 1] = g - w * dg; d[j + 2] = b - w * db;
  }
}

/** a canvas of its own for the tint: the screen's canvas is never read back (a canvas read back
 *  often is moved off the graphics card by the browser - every picture on it slower after) */
let side: OffscreenCanvas | null = null;
let sideG: OffscreenCanvasRenderingContext2D | null = null;

/** the highlighter on a canvas: its spots' paper tinted (copied out, tinted, drawn back); paper: what
 *  is lighter than this is paper (a scan as issued: lower) */
export function paperTint(g: CanvasRenderingContext2D, spots: Spot[], D: number, paper = PAPER): void {
  if (!spots.length) return;
  const W = g.canvas.width, H = g.canvas.height;
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (const s of spots) {
    x0 = Math.min(x0, Math.floor(s.x * D)); y0 = Math.min(y0, Math.floor(s.y * D));
    x1 = Math.max(x1, Math.ceil((s.x + s.w) * D)); y1 = Math.max(y1, Math.ceil((s.y + s.h) * D));
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
  if (x1 <= x0 || y1 <= y0) return;
  const bw = x1 - x0, bh = y1 - y0;
  if (!side || side.width < bw || side.height < bh) {
    side = new OffscreenCanvas(Math.max(bw, side?.width ?? 0), Math.max(bh, side?.height ?? 0));
    sideG = side.getContext('2d', { willReadFrequently: true });
  }
  const c = sideG!;
  c.clearRect(0, 0, bw, bh);
  c.drawImage(g.canvas, x0, y0, bw, bh, 0, 0, bw, bh);
  const img = c.getImageData(0, 0, bw, bh);
  tintPaper(img.data, spotMask(spots, D, x0, y0, bw, bh), paper);
  c.putImageData(img, 0, 0);
  // (opaque - drawn over, it replaces what was there; 'copy' would clear the rest of the canvas)
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.drawImage(side, 0, 0, bw, bh, x0, y0, bw, bh);
  g.restore();
}
