// The comparison itself: two pictures of the same sheet (old, new) at the same scale ->
// where they differ. Pure functions on grey pictures (white = 255), no PDF in here.
//
// Accuracy rules:
//  - a pixel of the old sheet is "removed" only if no pixel of the new sheet within the
//    tolerance radius is at least as dark (and the reverse for "added"). Anti-aliasing,
//    half-pixel shifts and re-exported line work therefore don't count as changes, while a
//    dimension 4200 -> 4500 or a wall moved by 50 mm does.
//  - changed pixels are grouped into change areas (nearby changes join) and areas too small
//    to be anything but noise are dropped.
//  - the old sheet is aligned to the new one first (moved / re-plotted sheets).

export interface Gray { w: number; h: number; px: Uint8Array }

/** min over a (2r+1) x (2r+1) square: "the darkest pixel nearby" */
export function minFilter(g: Gray, r: number): Gray {
  const { w, h, px } = g;
  if (r <= 0) return { w, h, px: px.slice() };
  if (r === 1) return minFilter1(g);
  const tmp = new Uint8Array(w * h);
  // horizontal
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let m = 255;
      const a = x - r < 0 ? 0 : x - r, b = x + r >= w ? w - 1 : x + r;
      for (let k = a; k <= b; k++) { const v = px[o + k]; if (v < m) m = v; }
      tmp[o + x] = m;
    }
  }
  const out = new Uint8Array(w * h);
  // vertical (row-wise min of rows keeps memory access sequential)
  for (let y = 0; y < h; y++) {
    const a = y - r < 0 ? 0 : y - r, b = y + r >= h ? h - 1 : y + r;
    const o = y * w;
    out.set(tmp.subarray(a * w, a * w + w), o);
    for (let k = a + 1; k <= b; k++) {
      const s = k * w;
      for (let x = 0; x < w; x++) { const v = tmp[s + x]; if (v < out[o + x]) out[o + x] = v; }
    }
  }
  return { w, h, px: out };
}

/**
 * A pixel inside a straight run of ink on sheet `a` (horizontal or vertical, not its end) that
 * sheet `b` doesn't continue: b has nothing as dark across the run within r. A diagonal hatch line
 * crossing nearby doesn't count as the run still being there.
 */
/**
 * A long straight line of the old sheet that the new sheet no longer has, even where other ink
 * now crosses it (a window line taken out of densely hatched wall: the hatch touches the line
 * from both sides and crosses its place, so neither the darkest-nearby nor the short-run test
 * sees it go). The old pixel must sit on a clear run (>= 8 px one way, clearly longer than the
 * other way); the line counts as still there only if the new sheet has a run the same way within r.
 */
const NOLONG = typeof process !== 'undefined' && !!process.env?.RR_NOLONG;
function longLineGone(a: Uint8Array, b: Uint8Array, i: number, x: number, y: number, w: number, h: number, r: number, t: number): boolean {
  if (NOLONG) return false;
  const v = a[i];
  if (v > 128 || b[i] - v <= t) return false;
  if (x < 7 || y < 7 || x >= w - 7 || y >= h - 7) return false;
  // runs of ink of the same tone (a grey line over black hatching is a line of its own)
  const same = (q: number) => q < 160 && Math.abs(q - v) < 50;
  const run = (step: number) => { let n = 0; for (let k = 1; k <= 6 && same(a[i + k * step]); k++) n++; for (let k = 1; k <= 6 && same(a[i - k * step]); k++) n++; return n; };
  const hl = run(1), vl = run(w);
  const horiz = hl >= 8 && hl >= vl + 4, vert = vl >= 8 && vl >= hl + 4;
  if (!horiz && !vert) return false;
  const along = horiz ? 1 : w, across = horiz ? w : 1;
  // still there, along the old line's own run (near its end the window reaches past it):
  //  - one row of the new sheet within r as dark as the old line nearly all the way, or
  //  - a line drawn half a pixel off: two neighbouring rows that together carry its ink and are
  //    even along it (crossing hatch is a texture: dark, light, dark along the row)
  const ms: number[] = [];
  for (let m = -6; m <= 6; m++) if (!m || same(a[i + m * along])) ms.push(m);
  const lim = v + t, need = (255 - v) * 0.85, ok = ms.length - 2;
  // only where other ink crosses the old line's place in the new sheet (dark, light, dark along
  // it); a clean line or letter stroke just drawn a hair off is the other rules' business
  let flips = 0, prev = -1;
  for (const m of ms) { const q = b[i + m * along], st = q <= lim ? 1 : q > lim + 40 ? 0 : prev; if (prev >= 0 && st !== prev) flips++; prev = st; }
  if (flips < 3) return false;
  for (let k = -r; k <= r; k++) {
    let n = 0;
    for (const m of ms) if (b[i + m * along + k * across] <= lim) n++;
    if (n >= ok) return false;
  }
  for (let k = -r; k < r; k++) {
    let n = 0, lo1 = 255, hi1 = 0, lo2 = 255, hi2 = 0;
    for (const m of ms) {
      const p1 = b[i + m * along + k * across], p2 = b[i + m * along + (k + 1) * across];
      if (510 - p1 - p2 >= need) n++;
      if (p1 < lo1) lo1 = p1; if (p1 > hi1) hi1 = p1; if (p2 < lo2) lo2 = p2; if (p2 > hi2) hi2 = p2;
    }
    if (n >= ok && hi1 - lo1 <= 70 && hi2 - lo2 <= 70) return false;
  }
  return true;
}

function lineGone(a: Uint8Array, b: Uint8Array, i: number, x: number, y: number, w: number, h: number, r: number, t: number): boolean {
  const v = a[i];
  if (v > 128 || b[i] - v <= t) return false;
  if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) return false;
  const hRun = a[i - 1] < 160 && a[i + 1] < 160 && a[i - 2] < 200 && a[i + 2] < 200;
  const vRun = a[i - w] < 160 && a[i + w] < 160 && a[i - 2 * w] < 200 && a[i + 2 * w] < 200;
  if (hRun === vRun) return false;
  const lim = v + t;
  if (hRun) { for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h && b[i + k * w] <= lim) return false; } return true; }
  for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w && b[i + k] <= lim) return false; }
  return true;
}

/** min over 3 x 3 (unrolled: the hot loop of every comparison) */
function minFilter1(g: Gray): Gray {
  const { w, h, px } = g;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let a = px[o], b = px[o];
    for (let x = 0; x < w; x++) {
      const c = x + 1 < w ? px[o + x + 1] : px[o + x];
      let m = a < b ? a : b;
      if (c < m) m = c;
      tmp[o + x] = m;
      a = b; b = c;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w, up = (y > 0 ? y - 1 : 0) * w, dn = (y + 1 < h ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      let m = tmp[up + x];
      const v = tmp[o + x], d = tmp[dn + x];
      if (v < m) m = v;
      if (d < m) m = d;
      out[o + x] = m;
    }
  }
  return { w, h, px: out };
}

/**
 * Ink (255 - grey) summed over (2r+1) x (2r+1). A thin line drawn half a pixel off spreads its
 * ink over two lighter pixels: the darkest pixel nearby gets lighter, but the ink nearby stays.
 */
export function inkSum(g: Gray, r: number): Uint16Array {
  const { w, h, px } = g;
  const tmp = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let x = -r; x < w; x++) {
      const add = x + r < w ? 255 - px[o + x + r] : 0;
      const sub = x - r - 1 >= 0 ? 255 - px[o + x - r - 1] : 0;
      acc += add - sub;
      if (x >= 0) tmp[o + x] = acc;
    }
  }
  const out = new Uint16Array(w * h);
  const col = new Uint32Array(w);
  for (let y = -r; y < h; y++) {
    const a = y + r, b = y - r - 1;
    if (a < h) { const o = a * w; for (let x = 0; x < w; x++) col[x] += tmp[o + x]; }
    if (b >= 0) { const o = b * w; for (let x = 0; x < w; x++) col[x] -= tmp[o + x]; }
    if (y >= 0) { const o = y * w; for (let x = 0; x < w; x++) out[o + x] = col[x] > 65535 ? 65535 : col[x]; }
  }
  return out;
}

/** smaller picture: each pixel = darkest of an f x f block (thin lines survive) */
/** box-averaged smaller picture (scans: a min would pick up paper grain) */
export function avgPool(g: Gray, f: number): Gray {
  const W = Math.max(1, Math.ceil(g.w / f)), H = Math.max(1, Math.ceil(g.h / f));
  const sum = new Uint32Array(W * H), cnt = new Uint32Array(W * H);
  for (let y = 0; y < g.h; y++) {
    const oy = ((y / f) | 0) * W, s = y * g.w;
    for (let x = 0; x < g.w; x++) { const i = oy + ((x / f) | 0); sum[i] += g.px[s + x]; cnt[i]++; }
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = cnt[i] ? Math.round(sum[i] / cnt[i]) : 255;
  return { w: W, h: H, px: out };
}

export function minPool(g: Gray, f: number): Gray {
  const W = Math.max(1, Math.ceil(g.w / f)), H = Math.max(1, Math.ceil(g.h / f));
  const out = new Uint8Array(W * H).fill(255);
  for (let y = 0; y < g.h; y++) {
    const oy = ((y / f) | 0) * W, s = y * g.w;
    for (let x = 0; x < g.w; x++) {
      const v = g.px[s + x];
      const i = oy + ((x / f) | 0);
      if (v < out[i]) out[i] = v;
    }
  }
  return { w: W, h: H, px: out };
}

/** move a picture by whole pixels into a w x h canvas (white outside) */
export function shifted(g: Gray, dx: number, dy: number, w = g.w, h = g.h): Gray {
  const out = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= g.h) continue;
    const x0 = Math.max(0, dx), x1 = Math.min(w, g.w + dx);
    if (x1 <= x0) continue;
    out.set(g.px.subarray(sy * g.w + (x0 - dx), sy * g.w + (x1 - dx)), y * w + x0);
  }
  return { w, h, px: out };
}

/** turn a picture by a quarter turn (1 = clockwise), 2 = half turn */
export function turned(g: Gray, q: number): Gray {
  q = ((q % 4) + 4) % 4;
  if (q === 0) return g;
  const { w, h, px } = g;
  if (q === 2) { const out = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) out[i] = px[w * h - 1 - i]; return { w, h, px: out }; }
  const out = new Uint8Array(w * h);
  const W = h, H = w;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // clockwise: (x, y) -> (h-1-y, x); anticlockwise: (x, y) -> (y, w-1-x)
    const nx = q === 1 ? h - 1 - y : y, ny = q === 1 ? x : w - 1 - x;
    out[ny * W + nx] = px[y * w + x];
  }
  return { w: W, h: H, px: out };
}

// ---------------------------------------------------------------- alignment

/** in-place radix-2 FFT of n complex numbers (re, im), n a power of 2; inv = inverse (unscaled) */
function fft(re: Float64Array, im: Float64Array, inv: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inv ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

function fft2(re: Float64Array, im: Float64Array, W: number, H: number, inv: boolean) {
  const rr = new Float64Array(W), ri = new Float64Array(W);
  for (let y = 0; y < H; y++) {
    rr.set(re.subarray(y * W, y * W + W)); ri.set(im.subarray(y * W, y * W + W));
    fft(rr, ri, inv);
    re.set(rr, y * W); im.set(ri, y * W);
  }
  const cr = new Float64Array(H), ci = new Float64Array(H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) { cr[y] = re[y * W + x]; ci[y] = im[y * W + x]; }
    fft(cr, ci, inv);
    for (let y = 0; y < H; y++) { re[y * W + x] = cr[y]; im[y * W + x] = ci[y]; }
  }
}

const pow2 = (n: number) => { let p = 1; while (p < n) p <<= 1; return p; };

/**
 * Shift (dx, dy) that moves picture b onto picture a (b(x - dx, y - dy) ~ a(x, y)), by phase
 * correlation of the ink. Both pictures small (~1000 px). Returns the shift and the peak's
 * strength relative to the mean (higher = surer).
 */
export function phaseShift(a: Gray, b: Gray): { dx: number; dy: number; strength: number } {
  const W = pow2(Math.max(a.w, b.w)), H = pow2(Math.max(a.h, b.h));
  const ar = new Float64Array(W * H), ai = new Float64Array(W * H);
  const br = new Float64Array(W * H), bi = new Float64Array(W * H);
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) ar[y * W + x] = 255 - a.px[y * a.w + x];
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) br[y * W + x] = 255 - b.px[y * b.w + x];
  fft2(ar, ai, W, H, false);
  fft2(br, bi, W, H, false);
  // cross power, partly whitened (pure phase is noisy on sparse line work)
  for (let i = 0; i < W * H; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const m = ai[i] * br[i] - ar[i] * bi[i];
    const mag = Math.pow(r * r + m * m, 0.4) + 1e-9;
    ar[i] = r / mag; ai[i] = m / mag;
  }
  fft2(ar, ai, W, H, true);
  let best = -Infinity, bx = 0, by = 0, sum = 0;
  for (let i = 0; i < W * H; i++) { const v = ar[i]; sum += Math.abs(v); if (v > best) { best = v; bx = i % W; by = (i / W) | 0; } }
  const mean = sum / (W * H) || 1;
  // a fraction of a pixel from the neighbours of the peak
  const at = (x: number, y: number) => ar[((y + H) % H) * W + ((x + W) % W)];
  const sub = (m: number, c0: number, p: number) => { const d = m - 2 * c0 + p; return d < 0 ? Math.max(-0.5, Math.min(0.5, (m - p) / (2 * d))) : 0; };
  const fx = sub(at(bx - 1, by), best, at(bx + 1, by)), fy = sub(at(bx, by - 1), best, at(bx, by + 1));
  return { dx: (bx > W / 2 ? bx - W : bx) + fx, dy: (by > H / 2 ? by - H : by) + fy, strength: best / mean };
}

/**
 * Tile displacements by phase correlation (blurred or noisy content - scans - where the ink
 * sampling has no sharp peak). Same convention as tileShifts.
 */
export function tilePhase(n: Gray, o: Gray, size = 512, stats?: { edge: number }): TileShift[] {
  const { w, h } = n;
  // at least 3 x 3 tiles: an affine fit needs 5 good ones
  const tx = Math.max(3, Math.round(w / 900)), ty = Math.max(3, Math.round(h / 900));
  const out: TileShift[] = [];
  const crop = (g: Gray, x0: number, y0: number, s2: number): Gray => {
    const px = new Uint8Array(s2 * s2);
    for (let y = 0; y < s2; y++) px.set(g.px.subarray((y0 + y) * g.w + x0, (y0 + y) * g.w + x0 + s2), y * s2);
    // remove the paper tone so grain and background don't correlate
    let sum = 0; for (let i = 0; i < px.length; i++) sum += px[i];
    const bg = sum / px.length;
    for (let i = 0; i < px.length; i++) px[i] = px[i] >= bg - 12 ? 255 : px[i];
    return { w: s2, h: s2, px };
  };
  for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) {
    const s2 = Math.min(size, Math.floor(w / tx), Math.floor(h / ty)) & ~1;
    if (s2 < 32) continue;
    const cx = Math.floor(((i + 0.5) * w) / tx), cy = Math.floor(((j + 0.5) * h) / ty);
    const x0 = Math.max(0, Math.min(w - s2, cx - s2 / 2)), y0 = Math.max(0, Math.min(h - s2, cy - s2 / 2));
    const a = crop(n, x0, y0, s2), b = crop(o, x0, y0, s2);
    let ink = 0; for (let k = 0; k < a.px.length; k++) if (a.px[k] < 160) ink++;
    if (ink < 300) continue;
    const r = phaseShift(a, b);
    if (r.strength < 25) continue;
    if (Math.abs(r.dx) > 12 || Math.abs(r.dy) > 12) { if (stats) stats.edge++; continue; }
    out.push({ cx: x0 + s2 / 2, cy: y0 + s2 / 2, dx: r.dx, dy: r.dy, fit: Math.min(1, r.strength / 200), n: ink });
  }
  return out;
}

/** ink pixels of a picture (value < 160) as a sample of up to n positions, spread evenly */
function inkSample(g: Gray, n: number): Int32Array {
  let count = 0;
  for (let i = 0; i < g.px.length; i++) if (g.px[i] < 160) count++;
  const step = Math.max(1, Math.floor(count / n));
  const out = new Int32Array(Math.min(n, count) + 1);
  let k = 0, c = 0;
  for (let i = 0; i < g.px.length && k < out.length; i++) if (g.px[i] < 160) { if (c % step === 0) out[k++] = i; c++; }
  return out.subarray(0, k);
}

/** share of the sample's ink pixels of `a` that find ink in `bDil` when b is moved by (dx, dy) */
function fit(a: Gray, sample: Int32Array, bDil: Gray, dx: number, dy: number): number {
  if (!sample.length) return 1;
  let hit = 0;
  const W = a.w, bw = bDil.w, bh = bDil.h;
  for (let k = 0; k < sample.length; k++) {
    const i = sample[k];
    const x = (i % W) - dx, y = ((i / W) | 0) - dy;
    if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
    if (bDil.px[y * bw + x] < 160) hit++;
  }
  return hit / sample.length;
}

export interface Shift { dx: number; dy: number; fit: number; fit0: number; strength: number }

/**
 * Best whole-pixel shift of `b` (old) onto `a` (new): phase correlation on small copies, then
 * checked and refined on the full pictures. Stays at (0, 0) unless another shift fits clearly
 * better (sheets that didn't move are the normal case; a wrong move would flag everything).
 */
export function findShift(a: Gray, b: Gray, maxSide = 1024): Shift {
  const f = Math.max(1, Math.ceil(Math.max(a.w, a.h, b.w, b.h) / maxSide));
  const bDil = minFilter(b, 1);
  let pc = { dx: 0, dy: 0, strength: 0 };
  const sample = inkSample(a, 40000);
  const fit0 = fit(a, sample, bDil, 0, 0);
  let best = { dx: 0, dy: 0, fit: fit0 };
  if (fit0 > 0.85) return { ...best, fit0, strength: pc.strength };
  pc = phaseShift(minPool(a, f), minPool(b, f));
  const cx = Math.round(pc.dx * f), cy = Math.round(pc.dy * f), R = f + 2;
  for (let dy = cy - R; dy <= cy + R; dy++) for (let dx = cx - R; dx <= cx + R; dx++) {
    const v = fit(a, sample, bDil, dx, dy);
    if (v > best.fit) best = { dx, dy, fit: v };
  }
  // also look right around zero (a sub-block shift the coarse step can't see)
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const v = fit(a, sample, bDil, dx, dy);
    if (v > best.fit) best = { dx, dy, fit: v };
  }
  // keep (0, 0) unless the move is clearly better
  if (best.dx !== 0 || best.dy !== 0) {
    if (!(best.fit > fit0 + 0.02 && best.fit > fit0 * 1.05)) best = { dx: 0, dy: 0, fit: fit0 };
  }
  return { ...best, fit0, strength: pc.strength };
}

// ---------------------------------------------------------------- differences

export interface DiffOptions {
  /** radius in pixels within which a mark may move and still count as the same */
  r: number;
  /** grey-level difference that counts (0-255) */
  t: number;
  /** block size (pixels) for grouping */
  block: number;
  /** blocks between changes that still join them into one area */
  gap: number;
  /** fewest changed pixels a block must have to count */
  minBlockPx: number;
  /** fewest changed pixels an area must have to count */
  minAreaPx: number;
  /** areas to leave out (pixels of the new picture): [x0, y0, x1, y1] */
  ignore?: number[][];
  /** tests: print what happens to the pixels in this box */
  debugBox?: number[];
  /** an area wider or taller than this many blocks is split into its separate changes */
  maxAreaBlocks?: number;
}

/**
 * A mark counts as gone only if its small neighbourhood lost at least this share of the mark's own
 * ink (a line drawn half a pixel off keeps its ink nearby: not a change; a thin line removed from
 * inside a hatched wall still loses its ink: a change).
 */
const LOSS = 0.5;

/** darkest pixel and ink sum within r of (x, y), packed as darkest * 65536 + sum */
function nb(g: Uint8Array, x: number, y: number, w: number, h: number, R: number): number {
  let mn = 255, sum = 0;
  const ya = y - R < 0 ? 0 : y - R, yb = y + R >= h ? h - 1 : y + R, xa = x - R < 0 ? 0 : x - R, xb = x + R >= w ? w - 1 : x + R;
  for (let yy = ya; yy <= yb; yy++) { const row = yy * w; for (let xx = xa; xx <= xb; xx++) { const v = g[row + xx]; if (v < mn) mn = v; sum += 255 - v; } }
  return mn * 65536 + sum;
}

/**
 * The change rule for one pixel whose old and new values differ by more than T (a pixel within T
 * of the other sheet's can never count: the rules need darkest-nearby <= the pixel itself).
 * Returns 1 = removed (old ink gone), 2 = added, 3 = both, 0 = no change.
 *  removed: old ink here, and the new sheet has neither as dark a pixel nor as much ink nearby
 *  (or, inside a line, nothing parallel to it nearby - a crossing line doesn't explain it)
 */
export function pixelChange(op: Uint8Array, np: Uint8Array, i: number, x: number, y: number, w: number, h: number, R: number, T: number): number {
  const ov = op[i], nv = np[i];
  const nN = nb(np, x, y, w, h, R), nO = nb(op, x, y, w, h, R);
  const nMin = nN >>> 16, nSum = nN & 0xffff, oMin = nO >>> 16, oSum = nO & 0xffff;
  let c = 0;
  if ((nMin - ov > T || lineGone(op, np, i, x, y, w, h, R, T) || longLineGone(op, np, i, x, y, w, h, R, T)) && oSum - nSum > (255 - ov) * LOSS) c |= 1;
  if ((oMin - nv > T || lineGone(np, op, i, x, y, w, h, R, T) || longLineGone(np, op, i, x, y, w, h, R, T)) && nSum - oSum > (255 - nv) * LOSS) c |= 2;
  return c;
}

/** the changed pixels inside a box (same rule as diff): 1 removed, 2 added, per pixel of the box */
export function changeMask(o: Gray, n: Gray, opt: DiffOptions, x0: number, y0: number, x1: number, y1: number): { w: number; h: number; m: Uint8Array; x0: number; y0: number } {
  const { w, h } = n;
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(w - 1, Math.ceil(x1)); y1 = Math.min(h - 1, Math.ceil(y1));
  const bw = Math.max(0, x1 - x0 + 1), bh = Math.max(0, y1 - y0 + 1);
  const m = new Uint8Array(bw * bh);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * w + x, dv = o.px[i] - n.px[i];
    if (dv <= opt.t && dv >= -opt.t) continue;
    m[(y - y0) * bw + (x - x0)] = pixelChange(o.px, n.px, i, x, y, w, h, opt.r, opt.t);
  }
  return { w: bw, h: bh, m, x0, y0 };
}

export const defaultDiff = (pxPerMm: number): DiffOptions => ({
  r: Math.max(1, Math.round(0.25 * pxPerMm)),
  t: 48,
  block: Math.max(4, Math.round(1.4 * pxPerMm)),
  gap: 3,
  minBlockPx: 2,
  minAreaPx: Math.max(6, Math.round(0.2 * pxPerMm * pxPerMm)),
  maxAreaBlocks: Math.round((300 * pxPerMm) / Math.max(4, Math.round(1.4 * pxPerMm))),
});

export interface Area { x0: number; y0: number; x1: number; y1: number; add: number; rem: number }
export interface DiffResult { areas: Area[]; addPx: number; remPx: number; inkPx: number; oldInkPx: number; blocks: { gw: number; gh: number; add: Uint32Array; rem: Uint32Array }; preview?: { w: number; h: number; px: Uint8ClampedArray } }

/**
 * Changes between old `o` and new `n` (same size, already aligned).
 * Returns change areas in pixels of the pictures.
 */
export function diff(o: Gray, n: Gray, opt: DiffOptions, pf = 0): DiffResult {
  const { w, h } = n;
  if (o.w !== w || o.h !== h) throw new Error('pictures differ in size');
  const R = opt.r;
  const B = opt.block, gw = Math.ceil(w / B), gh = Math.ceil(h / B);
  const add = new Uint32Array(gw * gh), rem = new Uint32Array(gw * gh);
  const T = opt.t;
  let addPx = 0, remPx = 0, inkPx = 0, oldInkPx = 0;
  const op = o.px, np = n.px;
  // left-out strips (the paper edge): their pixels never count
  const ign = opt.ignore && opt.ignore.length ? opt.ignore : null;
  // small overlay picture made on the way (pf = pixels per picture pixel)
  const PW = pf ? Math.ceil(w / pf) : 0, PH = pf ? Math.ceil(h / pf) : 0;
  const pSame = pf ? new Float32Array(PW * PH) : null, pRem = pf ? new Float32Array(PW * PH) : null, pAdd = pf ? new Float32Array(PW * PH) : null;
  for (let y = 0; y < h; y++) {
    const row = y * w, brow = ((y / B) | 0) * gw, prow = pf ? ((y / pf) | 0) * PW : 0;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const ov = op[i], nv = np[i];
      if (nv < 160) inkPx++;
      if (ov < 160) oldInkPx++;
      const dv = ov - nv;
      if (dv <= T && dv >= -T) {
        if (pSame && (ov < 255 || nv < 255)) pSame[prow + ((x / pf) | 0)] += 255 - (ov < nv ? ov : nv);
        continue;
      }
      let c = pixelChange(op, np, i, x, y, w, h, R, T);
      if (c && ign) for (const r of ign) if (x >= r[0] && x < r[2] && y >= r[1] && y < r[3]) { c = 0; break; }
      if (c & 1) { rem[brow + ((x / B) | 0)]++; remPx++; if (pRem) pRem[prow + ((x / pf) | 0)] += 255 - ov; }
      if (c & 2) { add[brow + ((x / B) | 0)]++; addPx++; if (pAdd) pAdd[prow + ((x / pf) | 0)] += 255 - nv; }
      if (!c && pSame) pSame[prow + ((x / pf) | 0)] += 255 - (ov < nv ? ov : nv);
    }
  }
  let preview: { w: number; h: number; px: Uint8ClampedArray } | undefined;
  if (pf && pSame && pRem && pAdd) preview = { w: PW, h: PH, px: previewColours(pSame, pRem, pAdd, PW, PH, pf) };
  if (opt.debugBox) {
    const [bx0, by0, bx1, by1] = opt.debugBox;
    const st = { pixels: 0, differ: 0, rem: 0, add: 0 };
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const i = y * w + x, ov = op[i], nv = np[i];
      st.pixels++;
      if (Math.abs(ov - nv) > T) st.differ++;
    }
    console.log('debug box', opt.debugBox, st, 'r', R, 't', T, 'minAreaPx', opt.minAreaPx, 'minBlockPx', opt.minBlockPx);
  }
  const areas = group(add, rem, gw, gh, B, w, h, opt);
  return { areas, addPx, remPx, inkPx, oldInkPx, blocks: { gw, gh, add, rem }, preview };
}

/** per-pixel ink sums of a small picture -> colours (changes made to stand out) */
function previewColours(same: Float32Array, rem: Float32Array, add: Float32Array, W: number, H: number, pf: number, pal: Palette = defaultPalette): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  const cell = 255 * pf * pf;
  for (let i = 0, j = 0; i < W * H; i++, j += 4) {
    const s = Math.min(1, Math.pow((same[i] / cell) * 2.2, 0.7)) * 0.75;
    const r = rem[i] ? Math.min(1, 0.35 + Math.pow((rem[i] / cell) * 3, 0.6)) : 0;
    const a = add[i] ? Math.min(1, 0.35 + Math.pow((add[i] / cell) * 3, 0.6)) : 0;
    let R = 255 - s * (255 - pal.same[0]), G = 255 - s * (255 - pal.same[1]), B = 255 - s * (255 - pal.same[2]);
    if (r) { R += r * (pal.old[0] - R); G += r * (pal.old[1] - G); B += r * (pal.old[2] - B); }
    if (a) { R += a * (pal.neu[0] - R); G += a * (pal.neu[1] - G); B += a * (pal.neu[2] - B); }
    out[j] = R; out[j + 1] = G; out[j + 2] = B; out[j + 3] = 255;
  }
  return out;
}

/** blocks with changes -> areas (nearby blocks join) */
function group(add: Uint32Array, rem: Uint32Array, gw: number, gh: number, B: number, w: number, h: number, opt: DiffOptions): Area[] {
  const hot = new Uint8Array(gw * gh);
  let any = false;
  for (let i = 0; i < gw * gh; i++) if (add[i] + rem[i] >= opt.minBlockPx) { hot[i] = 1; any = true; }
  if (!any) return [];
  // label hot blocks; two hot blocks join when within `gap` blocks (chessboard distance)
  const label = new Int32Array(gw * gh).fill(-1);
  const G = opt.gap;
  const areas: Area[] = [];
  const stack: number[] = [];
  for (let s = 0; s < gw * gh; s++) {
    if (!hot[s] || label[s] >= 0) continue;
    const id = areas.length;
    const a: Area = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, add: 0, rem: 0 };
    label[s] = id; stack.push(s);
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % gw, cy = (c / gw) | 0;
      a.x0 = Math.min(a.x0, cx); a.y0 = Math.min(a.y0, cy); a.x1 = Math.max(a.x1, cx); a.y1 = Math.max(a.y1, cy);
      a.add += add[c]; a.rem += rem[c];
      for (let yy = Math.max(0, cy - G); yy <= Math.min(gh - 1, cy + G); yy++) {
        for (let xx = Math.max(0, cx - G); xx <= Math.min(gw - 1, cx + G); xx++) {
          const k = yy * gw + xx;
          if (hot[k] && label[k] < 0) { label[k] = id; stack.push(k); }
        }
      }
    }
    areas.push(a);
  }
  const maxSide = opt.maxAreaBlocks ?? Infinity;
  const list = areas;
  // blocks -> pixels, small areas dropped
  let out: Area[] = [];
  for (const a of list) {
    if (a.add + a.rem < opt.minAreaPx) continue;
    out.push({ x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1, add: a.add, rem: a.rem });
  }
  out = mergeOverlaps(out, 1);
  // still too big (a long line that moved ties everything together): cut into pieces of half
  // the biggest size, each piece shrunk to the changes in it
  if (Number.isFinite(maxSide)) {
    const cut: Area[] = [];
    const cell = Math.max(2, Math.floor(maxSide / 2));
    for (const a of out) {
      if (a.x1 - a.x0 <= maxSide && a.y1 - a.y0 <= maxSide) { cut.push(a); continue; }
      for (let cy0 = a.y0; cy0 <= a.y1; cy0 += cell) for (let cx0 = a.x0; cx0 <= a.x1; cx0 += cell) {
        const p: Area = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, add: 0, rem: 0 };
        for (let yy = cy0; yy < Math.min(a.y1 + 1, cy0 + cell); yy++) for (let xx = cx0; xx < Math.min(a.x1 + 1, cx0 + cell); xx++) {
          const k = yy * gw + xx;
          if (!hot[k]) continue;
          p.x0 = Math.min(p.x0, xx); p.y0 = Math.min(p.y0, yy); p.x1 = Math.max(p.x1, xx); p.y1 = Math.max(p.y1, yy);
          p.add += add[k]; p.rem += rem[k];
        }
        if (p.add + p.rem >= opt.minAreaPx) cut.push(p);
      }
    }
    out = cut;
  }
  return out.map((a) => ({ x0: a.x0 * B, y0: a.y0 * B, x1: Math.min(w, (a.x1 + 1) * B), y1: Math.min(h, (a.y1 + 1) * B), add: a.add, rem: a.rem }));
}

/** areas whose boxes (padded by `pad`) overlap become one */
export function mergeOverlaps(list: Area[], pad: number): Area[] {
  let a = list.slice();
  for (let changed = true; changed;) {
    changed = false;
    a.sort((p, q) => p.x0 - q.x0);
    const out: Area[] = [];
    for (const r of a) {
      const hit = out.find((q) => r.x0 - pad <= q.x1 && q.x0 - pad <= r.x1 && r.y0 - pad <= q.y1 && q.y0 - pad <= r.y1);
      if (hit) {
        hit.x0 = Math.min(hit.x0, r.x0); hit.y0 = Math.min(hit.y0, r.y0); hit.x1 = Math.max(hit.x1, r.x1); hit.y1 = Math.max(hit.y1, r.y1);
        hit.add += r.add; hit.rem += r.rem;
        changed = true;
      } else out.push({ ...r });
    }
    a = out;
  }
  return a;
}

// ---------------------------------------------------------------- colour pictures

export interface Palette { old: [number, number, number]; neu: [number, number, number]; same: [number, number, number] }
export const defaultPalette: Palette = { old: [222, 40, 40], neu: [24, 98, 255], same: [70, 78, 80] };

/**
 * Overlay picture: unchanged ink grey (dimmed by `fade`, 0-1), removed ink in the old colour,
 * added ink in the new colour. Uses the same tolerance as the detection so jitter shows grey.
 */
export function overlay(o: Gray, n: Gray, r: number, t: number, pal: Palette = defaultPalette, fade = 0.55): Uint8ClampedArray {
  const { w, h } = n;
  const out = new Uint8ClampedArray(w * h * 4);
  const nMin = minFilter(n, r).px, oMin = minFilter(o, r).px;
  const nSum = inkSum(n, r), oSum = inkSum(o, r);
  const op = o.px, np = n.px;
  const sr = pal.same[0], sg = pal.same[1], sb = pal.same[2];
  const keep = 1 - fade;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const ov = op[i], nv = np[i];
    const x = i % w, y = (i / w) | 0;
    const removed = ov !== nv && (nMin[i] - ov > t || lineGone(op, np, i, x, y, w, h, r, t)) && oSum[i] - nSum[i] > (255 - ov) * LOSS;
    const added = ov !== nv && (oMin[i] - nv > t || lineGone(np, op, i, x, y, w, h, r, t)) && nSum[i] - oSum[i] > (255 - nv) * LOSS;
    let R = 255, G = 255, B = 255;
    if (removed || added) {
      // the changed mark at full strength; where both changed (moved in place), purple-ish mix
      const io = removed ? (255 - ov) / 255 : 0, inn = added ? (255 - nv) / 255 : 0;
      R = 255 - io * (255 - pal.old[0]) - inn * (255 - pal.neu[0]);
      G = 255 - io * (255 - pal.old[1]) - inn * (255 - pal.neu[1]);
      B = 255 - io * (255 - pal.old[2]) - inn * (255 - pal.neu[2]);
      // keep any unchanged ink under it visible
      const c = (255 - Math.max(ov, nv)) / 255 * keep * 0.6;
      R -= c * (R - sr); G -= c * (G - sg); B -= c * (B - sb);
    } else {
      const ink = (255 - (ov < nv ? ov : nv)) / 255 * keep;
      R = 255 - ink * (255 - sr); G = 255 - ink * (255 - sg); B = 255 - ink * (255 - sb);
    }
    out[j] = R; out[j + 1] = G; out[j + 2] = B; out[j + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------- fine alignment (scale, skew)

export interface TileShift { cx: number; cy: number; dx: number; dy: number; fit: number; n: number }

/**
 * Local displacement of the old picture against the new one on a grid of tiles: at each tile
 * the shift (whole pixels within ±R, refined to a fraction of a pixel) that makes most of the
 * new ink land on old ink. A sheet re-plotted a hair bigger or smaller shows as shifts that
 * grow steadily across the sheet.
 */
export function tileShifts(n: Gray, o: Gray, R = 5, tile = 900, stats?: { edge: number }, keep?: (i: number) => boolean, sharp = false): TileShift[] {
  const { w, h } = n;
  // at least 3 x 3 tiles: an affine fit needs 5 good ones (an A4 sheet still gets 9)
  const tx = Math.max(3, Math.round(w / tile)), ty = Math.max(3, Math.round(h / tile));
  const out: TileShift[] = [];
  for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) {
    const x0 = Math.floor((i * w) / tx) + R + 3, x1 = Math.floor(((i + 1) * w) / tx) - R - 3;
    const y0 = Math.floor((j * h) / ty) + R + 3, y1 = Math.floor(((j + 1) * h) / ty) - R - 3;
    // ink pixels of the new tile (thin dark lines give sharp peaks), at most ~2500
    let cnt = 0;
    // (keep: only the ink of one part of the sheet - a plan that moved on its own, or the rest)
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) if (n.px[y * w + x] < 110 && (!keep || keep(y * w + x))) cnt++;
    if (cnt < 150) continue;
    const step = Math.max(1, Math.floor(cnt / 2500));
    const samp: number[] = [];
    let c = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) if (n.px[y * w + x] < 110 && (!keep || keep(y * w + x))) { if (c++ % step === 0) samp.push(y * w + x); }
    const S = 2 * R + 1;
    const score = new Float32Array(S * S);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      let hit = 0;
      const off = -dy * w - dx;
      for (let k = 0; k < samp.length; k++) hit += 255 - o.px[samp[k] + off];
      score[(dy + R) * S + (dx + R)] = hit / (255 * samp.length);
    }
    let bi = 0;
    for (let k = 1; k < S * S; k++) if (score[k] > score[bi]) bi = k;
    const bx = (bi % S) - R, by = ((bi / S) | 0) - R;
    if (Math.abs(bx) === R || Math.abs(by) === R) { // at the edge of the search: not a real peak here
      const mean0 = score.reduce((s2, v) => s2 + v, 0) / score.length;
      if (stats && score[bi] - mean0 >= 0.12) stats.edge++; // ...but there is ink to match: moved further
      continue;
    }
    // a fraction of a pixel from a smoothed score (the sharp score is step-like near its peak)
    const sm = (dx: number, dy: number) => {
      let v = 0;
      for (let k = 0; k < samp.length; k++) {
        const q = samp[k] - dy * w - dx;
        v += 1275 - o.px[q] - o.px[q - 1] - o.px[q + 1] - o.px[q - w] - o.px[q + w];
      }
      return v;
    };
    const sub = (m: number, c0: number, p: number) => { const d = m - 2 * c0 + p; return d < 0 ? Math.max(-0.5, Math.min(0.5, (m - p) / (2 * d))) : 0; };
    const c0 = sm(bx, by);
    const fx = bx + sub(sm(bx - 1, by), c0, sm(bx + 1, by));
    const fy = by + sub(sm(bx, by - 1), c0, sm(bx, by + 1));
    // a clear peak only (flat = empty-ish or repetitive pattern)
    const mean = score.reduce((s2, v) => s2 + v, 0) / score.length;
    if (score[bi] < 0.35 || score[bi] - mean < 0.12) continue;
    // sharp: the peak must stand out both ways (a tile of lines one way only - the sheet's border -
    // fits equally well anywhere along them)
    if (sharp) {
      const sc2 = (dx: number, dy: number) => (Math.abs(dx) > R || Math.abs(dy) > R ? 0 : score[(dy + R) * S + (dx + R)]);
      const top = score[bi];
      if (top - Math.max(sc2(bx - 2, by), sc2(bx + 2, by)) < 0.06 || top - Math.max(sc2(bx, by - 2), sc2(bx, by + 2)) < 0.06) continue;
    }
    out.push({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, dx: fx, dy: fy, fit: score[bi], n: samp.length });
  }
  return out;
}

/**
 * The fraction-of-a-pixel move of `o` that best fits `n` (pictures already lined up within a pixel
 * or so): o is resampled (bilinear) at moves on a 0.1 px grid within ±range, compared on the ink of
 * either where keep() says. Returns the move (o(q - d) ~ n(q)) and how much better it fits than none.
 */
export function bestMove(n: Gray, o: Gray, keep?: (i: number) => boolean, range = 1, maxSamples = 20000, region?: number[]): { dx: number; dy: number; gain: number; cost: number; n: number; sharpX: number; sharpY: number } | null {
  const { w, h } = n;
  let count = 0;
  const m = Math.ceil(range) + 2;
  const X0 = Math.max(m, region ? region[0] : 0), Y0 = Math.max(m, region ? region[1] : 0), X1 = Math.min(w - m, region ? region[2] : w), Y1 = Math.min(h - m, region ? region[3] : h);
  // (every pixel looked at - a sample on even pixels only leans the estimate towards half pixels)
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) { const i = y * w + x; if ((n.px[i] < 200 || o.px[i] < 200) && (!keep || keep(i))) count++; }
  if (count < 200) return null;
  const step = Math.max(1, Math.floor(count / maxSamples));
  const samp: number[] = [];
  let c = 0;
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) { const i = y * w + x; if ((n.px[i] < 200 || o.px[i] < 200) && (!keep || keep(i))) { if (c++ % step === 0) samp.push(i); } }
  // (the coarse steps on every 4th sample: they only pick where the fine steps look)
  const few = samp.filter((_, k) => (k & 3) === 0);
  const cost = (dx: number, dy: number, set = samp) => {
    const ix = Math.floor(-dx), iy = Math.floor(-dy), fx = -dx - ix, fy = -dy - iy;
    let s2 = 0;
    for (const i of set) {
      const k = i + iy * w + ix;
      const top = o.px[k] + (o.px[k + 1] - o.px[k]) * fx, bot = o.px[k + w] + (o.px[k + w + 1] - o.px[k + w]) * fx;
      const v = top + (bot - top) * fy - n.px[i];
      s2 += v * v;
    }
    return s2;
  };
  const c0 = cost(0, 0);
  // coarse to fine: 0.5, 0.1 (every 4th sample), 0.025 px (all)
  let best = { dx: 0, dy: 0, c: cost(0, 0, few) };
  const around = (cx: number, cy: number, r: number, st: number, set: number[]) => {
    for (let dy = cy - r; dy <= cy + r + 1e-9; dy += st) for (let dx = cx - r; dx <= cx + r + 1e-9; dx += st) {
      if (Math.abs(dx) > range + 0.3 || Math.abs(dy) > range + 0.3) continue;
      const v = cost(dx, dy, set);
      if (v < best.c) best = { dx, dy, c: v };
    }
  };
  around(0, 0, Math.ceil(range * 2) / 2, 0.5, few);
  around(best.dx, best.dy, 0.3, 0.1, few);
  best = { ...best, c: cost(best.dx, best.dy) };
  around(best.dx, best.dy, 0.075, 0.025, samp);
  // how sharply the fit falls off half a pixel either way, per axis (a tile of lines one way only
  // fits as well anywhere along them: that axis says nothing)
  const bc = Math.max(best.c, 1);
  const sharpX = (cost(best.dx - 0.5, best.dy) + cost(best.dx + 0.5, best.dy)) / 2 / bc - 1;
  const sharpY = (cost(best.dx, best.dy - 0.5) + cost(best.dx, best.dy + 0.5)) / 2 / bc - 1;
  return { dx: best.dx, dy: best.dy, gain: c0 ? 1 - best.c / c0 : 0, cost: best.c / samp.length, n: count, sharpX, sharpY };
}

/**
 * Affine displacement d(q) = A q + t fitted to the tile shifts (least squares, outliers - tiles
 * where the drawing really changed - dropped). Returns null when the tiles don't agree well
 * enough to trust a model.
 */
export function fitDisplacement(ts: TileShift[], maxRms = 0.9): { A: number[]; t: number[]; used: number; rms: number } | null {
  let list = ts.slice();
  // drop the worst-fitting tile one at a time (tiles where the drawing really changed, or a
  // false peak on repetitive linework) until the rest agree
  // (never more than half of them: then the tiles don't agree and no model is trusted)
  const least = Math.max(5, Math.ceil(ts.length / 2));
  for (let iter = 0; iter < 64; iter++) {
    if (list.length < least) return null;
    const m = lsq(list);
    if (!m) return null;
    const res = list.map((s) => Math.hypot(m.A[0] * s.cx + m.A[1] * s.cy + m.t[0] - s.dx, m.A[2] * s.cx + m.A[3] * s.cy + m.t[1] - s.dy));
    const rms = Math.sqrt(res.reduce((a, r) => a + r * r, 0) / res.length);
    const med = [...res].sort((a, b) => a - b)[res.length >> 1];
    let wi = 0;
    for (let i = 1; i < res.length; i++) if (res[i] > res[wi]) wi = i;
    if (res[wi] <= Math.max(0.8, 2.5 * med) && rms < maxRms) return { ...m, used: list.length, rms };
    list = list.filter((_, i) => i !== wi);
  }
  return null;
}

function lsq(list: TileShift[]): { A: number[]; t: number[] } | null {
  // per axis: d = a*x + b*y + c, weighted by sample count
  const solve = (val: (s: TileShift) => number) => {
    let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, s1 = 0, bx = 0, by = 0, b1 = 0;
    for (const s of list) {
      const wgt = Math.sqrt(s.n) * s.fit;
      const x = s.cx / 1000, y = s.cy / 1000, v = val(s);
      sxx += wgt * x * x; sxy += wgt * x * y; sx += wgt * x; syy += wgt * y * y; sy += wgt * y; s1 += wgt;
      bx += wgt * x * v; by += wgt * y * v; b1 += wgt * v;
    }
    const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, s1]], B = [bx, by, b1];
    const r = solve3(M, B);
    return r ? [r[0] / 1000, r[1] / 1000, r[2]] : null;
  };
  const ax = solve((s) => s.dx), ay = solve((s) => s.dy);
  if (!ax || !ay) return null;
  return { A: [ax[0], ax[1], ay[0], ay[1]], t: [ax[2], ay[2]] };
}

function solve3(M: number[][], B: number[]): number[] | null {
  const a = M.map((r, i) => [...r, B[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 3; r++) if (r !== c) { const f = a[r][c] / a[c][c]; for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k]; }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

/**
 * Resample a picture through an affine map (pixels): out(q) = g(M^-1 q), bilinear, white outside.
 * For scans: PDFium draws a picture turned by a fraction of a degree as if it weren't turned.
 */
export function warpGray(g: Gray, M: number[], w = g.w, h = g.h): Gray {
  const [a, b, c, d, e, f] = M;
  const det = a * d - b * c || 1;
  // inverse: u = Mi q
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  const ie = (c * f - d * e) / det, iff = (b * e - a * f) / det;
  const out = new Uint8Array(w * h);
  const src = g.px, gw = g.w, gh = g.h;
  for (let y = 0; y < h; y++) {
    let ux = ic * y + ie, uy = id * y + iff;
    for (let x = 0; x < w; x++, ux += ia, uy += ib) {
      const x0 = Math.floor(ux), y0 = Math.floor(uy);
      if (x0 < 0 || y0 < 0 || x0 >= gw - 1 || y0 >= gh - 1) { out[y * w + x] = 255; continue; }
      const fx = ux - x0, fy = uy - y0, k = y0 * gw + x0;
      const top = src[k] + (src[k + 1] - src[k]) * fx, bot = src[k + gw] + (src[k + gw + 1] - src[k + gw]) * fx;
      out[y * w + x] = top + (bot - top) * fy;
    }
  }
  return { w, h, px: out };
}
