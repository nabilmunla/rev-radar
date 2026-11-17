// Revision clouds. A consultant clouds what changed; at the next issue the old clouds are taken
// off. A change area that is nothing but a scalloped ring - every changed pixel close to the
// ring's outline, all four sides covered, the inner edge going in and out arc by arc, nothing
// changed inside - is a cloud coming or going, not a change to the drawing.
//
// The test is strict on purpose: anything it is unsure of stays an ordinary change. A cloud
// drawn along an L-shaped outline, or one merged with real changes, simply isn't recognised.

export interface CloudInfo {
  /** 'removed' / 'added' when the area is a revision cloud and nothing else */
  cloud: 'removed' | 'added' | null;
  why: string;
}

/**
 * m: per pixel of the area (plus a little margin): bit 1 = removed ink, bit 2 = added ink
 * pxPerMm: pixels per paper millimetre
 */
export function cloudRing(mask: { w: number; h: number; m: Uint8Array; x0?: number; y0?: number }, pxPerMm: number, sheet?: { w: number; px: Uint8Array }): CloudInfo {
  const { w, h, m } = mask;
  let nr = 0, na = 0;
  for (let i = 0; i < m.length; i++) { if (m[i] & 1) nr++; if (m[i] & 2) na++; }
  const bit = nr >= na ? 1 : 2, other = bit === 1 ? 2 : 1;
  const N = Math.max(nr, na);
  let nOther = 0;
  for (let i = 0; i < m.length; i++) if ((m[i] & other) && !(m[i] & bit)) nOther++;
  const no = (why: string): CloudInfo => ({ cloud: null, why });
  if (N < 40) return no('small');
  if (nOther > 0.03 * N + 2) return no('both kinds');
  // tight box of the ring
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x] & bit) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (bw < 6 * pxPerMm || bh < 6 * pxPerMm) return no('too small for a cloud');
  const band = Math.max(3, Math.min(6 * pxPerMm, 0.3 * Math.min(bw, bh)));
  // nearly all of it along the outline, nothing inside
  let inBand = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!(m[y * w + x] & bit)) continue;
    const d = Math.min(x - x0, x1 - x, y - y0, y1 - y);
    if (d <= band) inBand++;
  }
  if (inBand < 0.985 * N) return no(`inside ${(1 - inBand / N).toFixed(3)}`);
  // each side: how deep the ring reaches inward at each position along it
  const minAmp = 0.35 * pxPerMm;
  const sides: { cover: number; amp: number; cycles: number; len: number }[] = [];
  for (let s = 0; s < 4; s++) {
    const horiz = s < 2;
    const len = horiz ? bw : bh;
    const a = Math.ceil(band) + 1, b = len - Math.ceil(band) - 1;
    if (b - a < 3 * pxPerMm) return no('short side');
    const e: number[] = [];
    let covered = 0;
    for (let t = a; t <= b; t++) {
      let deep = -1;
      for (let d = 0; d <= band; d++) {
        const x = horiz ? x0 + t : s === 2 ? x0 + d : x1 - d;
        const y = horiz ? (s === 0 ? y0 + d : y1 - d) : y0 + t;
        if (m[y * w + x] & bit) deep = d;
      }
      if (deep >= 0) { covered++; e.push(deep); }
    }
    const span = b - a + 1;
    const cover = covered / span;
    if (cover < 0.85) return no(`side ${s} covered ${cover.toFixed(2)}`);
    const sorted = [...e].sort((p, q) => p - q);
    const p10 = sorted[Math.floor(sorted.length * 0.1)], p90 = sorted[Math.floor(sorted.length * 0.9)];
    const amp = p90 - p10;
    // arcs: the inner edge goes in and out again and again
    const mid = (p10 + p90) / 2, hyst = amp * 0.25;
    let state = 0, flips = 0;
    for (const v of e) {
      if (v > mid + hyst && state !== 1) { if (state) flips++; state = 1; }
      else if (v < mid - hyst && state !== -1) { if (state) flips++; state = -1; }
    }
    sides.push({ cover, amp: amp / pxPerMm, cycles: flips / 2, len: span / pxPerMm });
    if (amp < minAmp) return no(`side ${s} straight (${(amp / pxPerMm).toFixed(2)} mm)`);
    // at least one arc per 25 mm of side (and one on a short side)
    if (flips / 2 < Math.max(1, span / pxPerMm / 25)) return no(`side ${s} ${flips / 2} arcs over ${(span / pxPerMm).toFixed(0)} mm`);
  }
  const arcs = sides.reduce((t, q) => t + q.cycles, 0);
  if (arcs < 6) return no(`${arcs} arcs in all`);
  // a cloud is drawn around something that is still there (a scalloped symbol taken off on its
  // own - a tree canopy - has nothing inside)
  if (sheet) {
    const mx = mask.x0 || 0, my = mask.y0 || 0;
    const ix0 = Math.ceil(x0 + band), ix1 = Math.floor(x1 - band), iy0 = Math.ceil(y0 + band), iy1 = Math.floor(y1 - band);
    let ink = 0, all = 0;
    for (let y = iy0; y <= iy1; y++) for (let x = ix0; x <= ix1; x++) { all++; if (sheet.px[(my + y) * sheet.w + mx + x] < 160) ink++; }
    if (all > 0 && ink < Math.max(20, 0.004 * all)) return no('nothing inside');
  }
  return { cloud: bit === 1 ? 'removed' : 'added', why: sides.map((q) => `${q.len.toFixed(0)}mm a${q.amp.toFixed(2)} c${q.cycles}`).join(' ') };
}

export interface Comp { id: number; n: number; rem: number; add: number; x0: number; y0: number; x1: number; y1: number }

/**
 * The separate pieces of a change mask (pixels within 2 px of each other belong together, so a
 * cloud's arcs stay one ring). Biggest first. label: piece id + 1 per pixel (0 = unchanged).
 */
export function components(mask: { w: number; h: number; m: Uint8Array }): { comps: Comp[]; label: Int32Array } {
  const { w, h, m } = mask;
  const label = new Int32Array(w * h);
  const comps: Comp[] = [];
  const stack: number[] = [];
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || label[s]) continue;
    const id = comps.length + 1;
    const c: Comp = { id, n: 0, rem: 0, add: 0, x0: w, y0: h, x1: -1, y1: -1 };
    label[s] = id; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      c.n++; if (m[i] & 1) c.rem++; if (m[i] & 2) c.add++;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (m[j] && !label[j]) { label[j] = id; stack.push(j); }
        }
      }
    }
    comps.push(c);
  }
  comps.sort((a, b) => b.n - a.n);
  return { comps, label };
}
