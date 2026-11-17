// Parts of a sheet that moved as a whole: a plan (a CAD viewport) placed a few millimetres
// elsewhere on the new sheet while the rest of the sheet stayed. Lined up as one, such a sheet
// shows the whole plan as changed. Here each such part gets its own shift, so its real changes
// are found where it is now, and the sheet says "this part moved 1.9 mm down".
//
// Rules (a real change must never be taken for a moved part):
//  - the part's shift must explain its ink both ways (old -> new and new -> old), clearly better
//    than not moving it;
//  - a part is a sizeable view: at least 40 x 40 mm, with plenty of ink;
//  - a view stands on its own on the paper: whatever stayed in place (the grid lines of a
//    building moved against its grid, the walls of a room whose furniture moved) must not run
//    through it or close round it.
// Pure functions on grey pictures (white = 255), like compare.ts.
import { minFilter, minPool, phaseShift, type Gray } from './compare';

export interface MovedPart {
  /** shift of the old picture onto the new one, whole pixels of the check */
  dx: number; dy: number;
  /** box of the part, pixels of the new picture [x0, y0, x1, y1] (x1, y1 exclusive) */
  box: number[];
  /** box of the moved ink itself (the part reaches into the empty paper round it) */
  inkBox: number[];
  /** ink that the shift explains (pixels) */
  ink: number;
  /** lines stretched across the part's edge (see stretchedLines): the drawing was stretched there
   *  (a floor made taller, a bay made wider) - not a view moved on the paper; + longer, - shorter */
  joined?: number;
  shorter?: boolean;
  /** where those lines cross its edge: [x, y, 1 = an upright edge (the line runs across it
   *  sideways) / 0 = a level edge, how much longer / shorter], pixels */
  seams?: number[][];
}

export interface MovedParts {
  /** block size (pixels) of `label` */
  B: number; gw: number; gh: number;
  /** the new picture, darkest within a pixel (who owns old ink: see ownedOld) */
  nD?: Gray;
  /** per block: 0 = stays with the sheet, k = in part k (1-based) */
  label: Uint8Array;
  parts: MovedPart[];
}

export interface MovedTrace { cells: string[]; groups: string[]; comps: string[]; png?: (name: string, rgba: Uint8Array, w: number, h: number) => void }

const INK = 160;
/** votes: clear ink only (a faint line drawn half a pixel elsewhere comes out lighter or darker
 *  than INK), explained by any ink of the other sheet nearby */
const DARK = 128, ANY = 200;

/** ink pixels inside a box, spread evenly, at most n */
function sampleBox(g: Gray, x0: number, y0: number, x1: number, y1: number, n: number): Int32Array {
  let count = 0;
  for (let y = y0; y < y1; y++) { const r = y * g.w; for (let x = x0; x < x1; x++) if (g.px[r + x] < INK) count++; }
  const step = Math.max(1, Math.floor(count / n));
  const out = new Int32Array(Math.min(n, count) + 1);
  let k = 0, c = 0;
  for (let y = y0; y < y1 && k < out.length; y++) { const r = y * g.w; for (let x = x0; x < x1 && k < out.length; x++) if (g.px[r + x] < INK) { if (c % step === 0) out[k++] = r + x; c++; } }
  return out.subarray(0, k);
}

/** share of the sample (pixels of a picture w wide) that finds ink in `dil` moved by (dx, dy) */
function hits(sample: Int32Array, w: number, dil: Gray, dx: number, dy: number): number {
  if (!sample.length) return 0;
  let hit = 0;
  for (let k = 0; k < sample.length; k++) {
    const i = sample[k], x = (i % w) + dx, y = ((i / w) | 0) + dy;
    if (x < 0 || y < 0 || x >= dil.w || y >= dil.h) continue;
    if (dil.px[y * dil.w + x] < INK) hit++;
  }
  return hit / sample.length;
}

function crop(g: Gray, x0: number, y0: number, w: number, h: number): Gray {
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) px.set(g.px.subarray((y0 + y) * g.w + x0, (y0 + y) * g.w + x0 + w), y * w);
  return { w, h, px };
}

/** binary dilation of a block mask by a (2k+1) square, never into `wall` blocks */
function dilate(m: Uint8Array, gw: number, gh: number, k: number, wall?: Uint8Array): Uint8Array {
  const t = new Uint8Array(m.length), out = new Uint8Array(m.length);
  for (let y = 0; y < gh; y++) {
    let last = -1e9;
    for (let x = 0; x < gw; x++) { if (m[y * gw + x]) last = x; if (x - last <= k) t[y * gw + x] = 1; }
    last = 1e9;
    for (let x = gw - 1; x >= 0; x--) { if (m[y * gw + x]) last = x; if (last - x <= k) t[y * gw + x] = 1; }
  }
  for (let x = 0; x < gw; x++) {
    let last = -1e9;
    for (let y = 0; y < gh; y++) { if (t[y * gw + x]) last = y; if (y - last <= k) out[y * gw + x] = 1; }
    last = 1e9;
    for (let y = gh - 1; y >= 0; y--) { if (t[y * gw + x]) last = y; if (last - y <= k) out[y * gw + x] = 1; }
  }
  if (wall) for (let i = 0; i < out.length; i++) if (wall[i] && !m[i]) out[i] = 0;
  return out;
}
const erode = (m: Uint8Array, gw: number, gh: number, k: number) => {
  const inv = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 0 : 1;
  const d = dilate(inv, gw, gh, k);
  for (let i = 0; i < m.length; i++) d[i] = d[i] ? 0 : 1;
  return d;
};

/**
 * Each block goes with the nearest seed (seed[i]: -1 none, 0 stayed, k a move), the way ink runs:
 * a step along blocks with ink costs 1, across empty paper 4 (a wall drawn along the move fits
 * either way - it goes with the drawing its ink runs into, not with whatever lies nearest across
 * the paper). Empty paper is crossed for at most d blocks; ties go to "stayed", then the lower k.
 */
function nearest(seed: Int8Array, ink: Uint8Array, gw: number, gh: number, d: number): Uint8Array {
  const n = seed.length, MAX = 4 * d;
  const own = new Uint8Array(n), cost = new Uint16Array(n).fill(65535);
  const buckets: number[][] = Array.from({ length: MAX + 1 }, () => []);
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
    if (seed[i] < 0 || (pass === 0) !== (seed[i] === 0)) continue;
    own[i] = seed[i]; cost[i] = 0; buckets[0].push(i);
  }
  for (let c = 0; c <= MAX; c++) {
    const list = buckets[c];
    for (let k = 0; k < list.length; k++) {
      const j = list[k];
      if (cost[j] !== c) continue;
      const x = j % gw, y = (j / gw) | 0;
      for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) {
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
        const t = yy * gw + xx, nc = c + (ink[t] && ink[j] ? 1 : 4);
        if (nc > MAX || nc >= cost[t]) continue;
        cost[t] = nc; own[t] = own[j]; buckets[nc].push(t);
      }
    }
    buckets[c] = [];
  }
  return own;
}

/** 4-connected components of a mask: label per block (0 = none) and their count */
function components(m: Uint8Array, gw: number, gh: number): { lab: Int32Array; n: number } {
  const lab = new Int32Array(m.length);
  let n = 0;
  const stack: number[] = [];
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || lab[i]) continue;
    lab[i] = ++n; stack.push(i);
    while (stack.length) {
      const j = stack.pop()!, x = j % gw, y = (j / gw) | 0;
      if (x > 0 && m[j - 1] && !lab[j - 1]) { lab[j - 1] = n; stack.push(j - 1); }
      if (x < gw - 1 && m[j + 1] && !lab[j + 1]) { lab[j + 1] = n; stack.push(j + 1); }
      if (y > 0 && m[j - gw] && !lab[j - gw]) { lab[j - gw] = n; stack.push(j - gw); }
      if (y < gh - 1 && m[j + gw] && !lab[j + gw]) { lab[j + gw] = n; stack.push(j + gw); }
    }
  }
  return { lab, n };
}

/**
 * Stayed votes inside the region that lie along long straight lines (rows or columns of blocks with
 * stayed ink, gaps of up to 2 blocks - dashes - bridged, at least `len` blocks long): the grid lines
 * of a building that moved against its grid. A view moved on the paper has none (only scattered
 * coincidences of its real changes).
 */
function lineVotes(Z: Uint32Array, full: Uint8Array, gw: number, gh: number, len: number): number {
  const counted = new Uint8Array(Z.length);
  let sum = 0;
  const run = (idx: (k: number) => number, n: number) => {
    let start = -1, last = -1;
    const close = () => {
      if (start >= 0 && last - start + 1 >= len) for (let k = start; k <= last; k++) { const i = idx(k); if (Z[i] && !counted[i]) { counted[i] = 1; sum += Z[i]; } }
      start = -1;
    };
    for (let k = 0; k < n; k++) {
      const i = idx(k);
      if (!full[i]) { close(); continue; }
      if (Z[i]) { if (start < 0 || k - last > 3) { close(); start = k; } last = k; }
    }
    close();
  };
  for (let y = 0; y < gh; y++) run((k) => y * gw + k, gw);
  for (let x = 0; x < gw; x++) run((k) => k * gw + x, gh);
  return sum;
}

/** the region plus everything it closes round (blocks the outside can't reach without crossing it) */
function filled(reg: Uint8Array, gw: number, gh: number): Uint8Array {
  const out = new Uint8Array(reg.length).fill(1);
  const stack: number[] = [];
  const push = (i: number) => { if (out[i] && !reg[i]) { out[i] = 0; stack.push(i); } };
  for (let x = 0; x < gw; x++) { push(x); push((gh - 1) * gw + x); }
  for (let y = 0; y < gh; y++) { push(y * gw); push(y * gw + gw - 1); }
  while (stack.length) {
    const j = stack.pop()!, x = j % gw, y = (j / gw) | 0;
    if (x > 0) push(j - 1); if (x < gw - 1) push(j + 1); if (y > 0) push(j - gw); if (y < gh - 1) push(j + gw);
  }
  return out;
}

/**
 * Votes per block for one shift s of the old picture: ink that s explains and "staying" doesn't
 * (S), and ink that staying explains and s doesn't (Z). Old ink votes where it was and where it
 * goes (the part must cover both for the old picture to be moved cleanly).
 */
function votes(o: Gray, n: Gray, oD: Gray, nD: Gray, sx: number, sy: number, B: number, gw: number, gh: number) {
  const { w, h } = n;
  const S = new Uint32Array(gw * gh), Z = new Uint32Array(gw * gh);
  // the same, pixel for pixel (no tolerance): decides where the tolerant votes see both - a wall's
  // hatching moved along the wall still lands on the old hatching nearby, but not on its pixels
  const S2 = new Uint32Array(gw * gh), Z2 = new Uint32Array(gw * gh);
  const I = new Uint8Array(gw * gh);
  const op = o.px, np = n.px, od = oD.px, nd = nD.px;
  for (let y = 0; y < h; y++) {
    const row = y * w, brow = ((y / B) | 0) * gw;
    const yb = y - sy, yf = y + sy;
    const inB = yb >= 0 && yb < h, inF = yf >= 0 && yf < h;
    const browF = inF ? ((yf / B) | 0) * gw : 0;
    for (let x = 0; x < w; x++) {
      const i = row + x, nv = np[i], ov = op[i];
      if (nv >= DARK && ov >= DARK) continue;
      const b = brow + ((x / B) | 0);
      I[b] = 1;
      if (nv < DARK) {
        const e0 = od[i] < ANY;
        const xb = x - sx;
        const inX = inB && xb >= 0 && xb < w;
        const es = inX && od[yb * w + xb] < ANY;
        if (es && !e0) S[b]++; else if (e0 && !es) Z[b]++;
        else if (es) { const a0 = op[i] < INK, as = op[yb * w + xb] < INK; if (as && !a0) S2[b]++; else if (a0 && !as) Z2[b]++; }
      }
      if (ov < DARK) {
        const f0 = nd[i] < ANY;
        const xf = x + sx;
        const inX = inF && xf >= 0 && xf < w;
        const fs = inX && nd[yf * w + xf] < ANY;
        if (fs && !f0) { S[b]++; S[browF + ((xf / B) | 0)]++; } else if (f0 && !fs) { Z[b]++; if (inX) Z[browF + ((xf / B) | 0)]++; }
        else if (fs) { const a0 = np[i] < INK, as = np[yf * w + xf] < INK; if (as && !a0) { S2[b]++; S2[browF + ((xf / B) | 0)]++; } else if (a0 && !as) { Z2[b]++; Z2[browF + ((xf / B) | 0)]++; } }
      }
    }
  }
  return { S, Z, S2, Z2, I };
}

/**
 * Parts of the new sheet that moved as a whole against the old one (already lined up as a whole).
 * changed = the changed pixels per block of the first comparison (block size B). Returns null when
 * nothing moved on its own. When a move explains the paper's edge band (the border) the paper itself
 * is what moved against the whole-sheet alignment (it followed a big plan): `rebase` asks the caller
 * to line the sheet up with the paper and look again.
 */
export function movedParts(o: Gray, n: Gray, pxPerMm: number, changed: { add: Uint32Array; rem: Uint32Array; gw: number; gh: number }, B: number, trace?: MovedTrace): (MovedParts & { rebase?: { dx: number; dy: number } }) | null {
  const { w, h } = n;
  const { gw, gh } = changed;
  const k2 = (pxPerMm / 5.9) * (pxPerMm / 5.9); // pixel counts scale with the resolution squared
  // ---- candidate shifts: cells of ~50 mm where much changed, each lined up on its own
  // (moves up to 20 mm: a plan moved 16 mm made the whole sheet line up with it - border and title
  //  block "changed", their words paired wrongly)
  const C = Math.max(64, Math.round(50 * pxPerMm)), M = Math.round(20 * pxPerMm);
  const cw = Math.ceil(w / C), ch = Math.ceil(h / C);
  const cellChanged = new Float64Array(cw * ch), cellAdd = new Float64Array(cw * ch), cellInkN = new Float64Array(cw * ch), cellInkO = new Float64Array(cw * ch);
  for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
    const b = by * gw + bx, c = (((by * B) / C) | 0) * cw + (((bx * B) / C) | 0);
    cellChanged[c] += changed.add[b] + changed.rem[b];
    cellAdd[c] += changed.add[b];
  }
  for (let y = 0; y < h; y++) {
    const r = y * w, cr = ((y / C) | 0) * cw;
    for (let x = 0; x < w; x++) { const c = cr + ((x / C) | 0); if (n.px[r + x] < INK) cellInkN[c]++; if (o.px[r + x] < INK) cellInkO[c]++; }
  }
  const nD = minFilter(n, 1), oD = minFilter(o, 1);
  // (phase correlation on ~37 dpi copies: whole millimetres are enough, the fit then finds the pixel)
  const f = Math.max(1, Math.round(pxPerMm / 1.5));
  const found: { dx: number; dy: number; c: number }[] = [];
  const known: { dx: number; dy: number }[] = [];
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    const c = cy * cw + cx;
    if (cellInkN[c] < 400 * k2 || cellInkO[c] < 400 * k2 || cellChanged[c] < 0.15 * Math.max(cellInkN[c], cellInkO[c])) continue;
    // (what moved leaves ink where it was and puts ink where it is now - about as much of each: a
    //  cell of only additions or only removals is something drawn or rubbed out, no move)
    const add = cellAdd[c], rem = cellChanged[c] - add;
    if (Math.min(add, rem) < 0.25 * Math.max(add, rem)) continue;
    const x0 = cx * C, y0 = cy * C, x1 = Math.min(w, x0 + C), y1 = Math.min(h, y0 + C);
    const X0 = Math.max(0, x0 - M), Y0 = Math.max(0, y0 - M), X1 = Math.min(w, x1 + M), Y1 = Math.min(h, y1 + M);
    const ns = sampleBox(n, x0, y0, x1, y1, 4000);
    const fit0 = hits(ns, w, oD, 0, 0);
    const back = (dx: number, dy: number) => hits(sampleBox(o, Math.max(0, x0 - dx), Math.max(0, y0 - dy), Math.min(w, x1 - dx), Math.min(h, y1 - dy), 4000), w, nD, dx, dy);
    const ok = (b: { dx: number; dy: number; v: number }) => Math.max(Math.abs(b.dx), Math.abs(b.dy)) >= 2 && Math.max(Math.abs(b.dx), Math.abs(b.dy)) <= M && b.v >= 0.8 && b.v - fit0 >= 0.25;
    // best whole-pixel shift near (cx0, cy0) within ±r (a cell of lines one way only fits as well
    // anywhere along them: the nearest to the estimate)
    // (ties of the tolerant fit - every shift within a pixel of the move fits - go to the one whose
    //  pixels meet exactly, then to the one nearest the estimate)
    const near = (ex: number, ey: number, r: number) => {
      let best = { dx: 0, dy: 0, v: -1, e: -1, d: 0 };
      for (let dy = Math.round(ey) - r; dy <= Math.round(ey) + r; dy++) for (let dx = Math.round(ex) - r; dx <= Math.round(ex) + r; dx++) {
        const v = hits(ns, w, oD, -dx, -dy);
        if (v < best.v - 0.004) continue;
        const e = hits(ns, w, o, -dx, -dy), dd = Math.hypot(dx - ex, dy - ey);
        if (v > best.v + 0.004 || e > best.e + 0.004 || (e >= best.e - 0.004 && dd < best.d)) best = { dx, dy, v: Math.max(v, best.v), e, d: dd };
      }
      return best;
    };
    // a move already found elsewhere (one plan = many cells): checked first, no picture work
    let got: { dx: number; dy: number; v: number } | null = null;
    for (const k of known) {
      const b = near(k.dx, k.dy, 1);
      if (ok(b) && back(b.dx, b.dy) >= 0.8) { got = b; break; }
    }
    if (!got) {
      const pc = phaseShift(minPool(crop(n, X0, Y0, X1 - X0, Y1 - Y0), f), minPool(crop(o, X0, Y0, X1 - X0, Y1 - Y0), f));
      const b = near(pc.dx * f, pc.dy * f, f + 1);
      const bk = ok(b) ? back(b.dx, b.dy) : 0;
      if (trace) trace.cells.push(`${cx},${cy} s ${b.dx},${b.dy} fit ${b.v.toFixed(2)} fit0 ${fit0.toFixed(2)} back ${bk.toFixed(2)} peak ${pc.strength.toFixed(0)}`);
      if (ok(b) && bk >= 0.8) { got = b; if (!known.some((k) => Math.abs(k.dx - b.dx) <= 1 && Math.abs(k.dy - b.dy) <= 1)) known.push({ dx: b.dx, dy: b.dy }); }
    }
    if (got) found.push({ dx: got.dx, dy: got.dy, c });
  }
  if (!found.length) return null;
  // ---- shifts found in two cells or more (within 2 px)
  const groups: { dx: number; dy: number; n: number }[] = [];
  const left = found.slice();
  while (left.length) {
    // the shift most cells agree with
    let bi = 0, bn = 0;
    for (let i = 0; i < left.length; i++) {
      const k = left.filter((q) => Math.abs(q.dx - left[i].dx) <= 2 && Math.abs(q.dy - left[i].dy) <= 2).length;
      if (k > bn) { bn = k; bi = i; }
    }
    const mine = left.filter((q) => Math.abs(q.dx - left[bi].dx) <= 2 && Math.abs(q.dy - left[bi].dy) <= 2);
    const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
    if (mine.length >= 2) groups.push({ dx: med(mine.map((q) => q.dx)), dy: med(mine.map((q) => q.dy)), n: mine.length });
    for (const q of mine) left.splice(left.indexOf(q), 1);
  }
  if (trace) trace.groups.push(...groups.map((g) => `${g.dx},${g.dy} x${g.n}`));
  if (!groups.length) return null;

  // ---- each shift's region
  const label = new Uint8Array(gw * gh);
  const parts: MovedPart[] = [];
  const minInk = 4000 * k2, minSide = Math.ceil((40 * pxPerMm) / B);
  const close = Math.max(1, Math.round((4 * pxPerMm) / B));
  const eb = Math.max(1, Math.ceil((20 * pxPerMm) / B));
  const edge = new Uint8Array(gw * gh);
  for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) if (bx < eb || by < eb || bx >= gw - eb || by >= gh - eb) edge[by * gw + bx] = 1;
  // votes for every move first (each move's region is bounded by the ink of the others)
  const gs = groups.slice(0, 8);
  const per: { S: Uint32Array; Z: Uint32Array; sb: Uint8Array; zb: Uint8Array }[] = [];
  let I = new Uint8Array(0);
  for (const g of gs) {
    const v = votes(o, n, oD, nD, g.dx, g.dy, B, gw, gh);
    const { S, Z, S2, Z2 } = v;
    I = v.I;
    // the paper's edge band: if the shift explains it, the sheet itself moved this way
    let se = 0, ze = 0;
    for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
      if (bx >= eb && by >= eb && bx < gw - eb && by < gh - eb) continue;
      se += S[by * gw + bx]; ze += Z[by * gw + bx];
    }
    if (trace) trace.comps.push(`shift ${g.dx},${g.dy}: edge band S ${se} Z ${ze}`);
    if (se >= 2000 * k2 && se >= 4 * ze) return { B, gw, gh, label, parts: [], rebase: { dx: g.dx, dy: g.dy } };
    if (trace && process.env.RR_PARTS_AT) { const [ax, ay] = process.env.RR_PARTS_AT.split(',').map(Number); for (let y = ay - 1; y <= ay + 1; y++) trace.comps.push(`row ${y}: ` + Array.from({ length: 9 }, (_, k) => ax - 4 + k).map((x) => `${x}:${S[y * gw + x]}/${Z[y * gw + x]}`).join(' ')); }
    const sb = new Uint8Array(gw * gh), zb = new Uint8Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) {
      // (a block of both - a dashed line whose dashes happen to meet the old ones - decides nothing)
      if (S[i] >= 3 * k2 && S[i] >= 4 * Z[i]) sb[i] = 1;
      else if (Z[i] >= 3 * k2 && Z[i] >= 4 * S[i]) zb[i] = 1;
      // (nothing clear with the tolerance: pixel for pixel, clearly moved - by a wider margin. Never
      //  "stayed" that way: the move is known to the whole pixel only, and a hatch moved by a
      //  whole number of its spacings matches where it was pixel for pixel)
      else if (S[i] + Z[i] < 3 * k2 && S2[i] >= 6 * k2 && S2[i] >= 6 * Z2[i]) sb[i] = 1;
    }
    per.push({ S, Z, sb, zb });
  }
  for (let gi = 0; gi < gs.length; gi++) {
    const g = gs[gi], { S, Z, sb, zb } = per[gi];
    // every block goes with the nearer of this move's ink and ink that stayed - or went with another
    // move (along the ink; up to 25 mm across empty paper): a view's empty rooms and its lines along
    // the move (which fit either way) go with the view round them, and two views moved different
    // ways each keep their own
    const seed = new Int8Array(gw * gh).fill(-1);
    for (let i = 0; i < seed.length; i++) {
      if (sb[i]) seed[i] = 1;
      else if (zb[i] || per.some((q, k) => k !== gi && q.sb[i])) seed[i] = 0;
    }
    const own = nearest(seed, I, gw, gh, Math.ceil((25 * pxPerMm) / B));
    const reg = new Uint8Array(gw * gh);
    for (let i = 0; i < reg.length; i++) if (own[i] === 1) reg[i] = 1;
    const { lab, n: nc } = components(reg, gw, gh);
    if (trace?.png) {
      // tests: the votes as a picture (red = moved ink, blue = stayed, green = the closed region)
      const px = new Uint8Array(gw * gh * 4);
      for (let i = 0; i < gw * gh; i++) {
        const c = sb[i] ? [230, 30, 30] : zb[i] ? [30, 60, 230] : reg[i] ? [120, 220, 120] : S[i] || Z[i] ? [190, 190, 190] : [255, 255, 255];
        px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2];
        px[i * 4 + 3] = 255;
      }
      trace.png(`${g.dx},${g.dy}`, px, gw, gh);
    }
    const stat = Array.from({ length: nc + 1 }, () => ({ s: 0, x0: gw, y0: gh, x1: -1, y1: -1 }));
    for (let i = 0; i < lab.length; i++) {
      const l = lab[i];
      if (!l) continue;
      const q = stat[l], x = i % gw, y = (i / gw) | 0;
      q.s += S[i]; if (x < q.x0) q.x0 = x; if (y < q.y0) q.y0 = y; if (x > q.x1) q.x1 = x; if (y > q.y1) q.y1 = y;
    }
    // each piece with everything it closes round, and what stayed in place inside it (grid lines a
    // building moved against, a room's walls) and right round it: a view on the paper has neither
    const pieces: { full: Uint8Array; s: number; zin: number; zring: number; zline: number; paper: number; box: number[]; big: boolean }[] = [];
    for (let l = 1; l <= nc; l++) {
      const q = stat[l];
      if (q.s < minInk / 2) continue;
      const mine = new Uint8Array(gw * gh);
      for (let i = 0; i < lab.length; i++) if (lab[i] === l) mine[i] = 1;
      const full = filled(mine, gw, gh);
      const ring = dilate(full, gw, gh, Math.max(2, close));
      let zin = 0, zring = 0, sAll = 0, e = 0, ef = 0;
      for (let i = 0; i < full.length; i++) {
        if (full[i]) { sAll += S[i]; zin += Z[i]; }
        // (not the paper's edge band: a view a few mm off the border has the border right round it)
        else if (ring[i] && !edge[i]) zring += Z[i];
        if (edge[i] && I[i]) { e++; if (full[i]) ef++; }
      }
      const big = q.s >= minInk && q.x1 - q.x0 + 1 >= minSide && q.y1 - q.y0 + 1 >= minSide;
      pieces.push({ full, s: sAll, zin, zring, zline: lineVotes(Z, full, gw, gh, Math.ceil((30 * pxPerMm) / B)), paper: e ? ef / e : 0, box: [q.x0, q.y0, q.x1, q.y1], big });
    }
    // the part: all its pieces hold (anything inside that stayed in place shows as a change). Its
    // edge already runs midway between it and what stayed (no margin: the paper's border a few mm
    // off must not move with it). One part per move: a view in several pieces is one view.
    const id = parts.length + 1;
    let marked = 0;
    const mark = (pc: (typeof pieces)[0]) => { for (let i = 0; i < pc.full.length; i++) if (pc.full[i] && !label[i]) { label[i] = id; marked++; } };
    const hosts: (typeof pieces)[0][] = [];
    let ink = 0;
    for (const pc of pieces) {
      // (stayed ink in long straight lines through it = grid lines a building moved against; most
      //  of the paper's border inside it = the paper itself)
      // (and the whole sheet is no view: lining the sheet up is the whole-sheet alignment's job)
      const whole = pc.box[2] - pc.box[0] + 1 >= 0.9 * gw && pc.box[3] - pc.box[1] + 1 >= 0.9 * gh;
      const ok = pc.big && pc.zin <= 0.04 * pc.s && pc.zring <= 0.06 * pc.s && pc.zline <= 0.01 * pc.s && pc.paper < 0.3 && !whole;
      if (trace) trace.comps.push(`shift ${g.dx},${g.dy} part ${pc.box[0] * B},${pc.box[1] * B}-${(pc.box[2] + 1) * B},${(pc.box[3] + 1) * B} S ${pc.s} Z inside ${pc.zin} (${(pc.zin / pc.s * 100).toFixed(1)}%) round ${pc.zring} (${(pc.zring / pc.s * 100).toFixed(1)}%) lines ${(pc.zline / pc.s * 100).toFixed(2)}% border ${(pc.paper * 100).toFixed(0)}% ${ok ? 'MOVED' : pc.big ? 'no' : 'small'}`);
      if (!ok || id > 250) continue;
      mark(pc); hosts.push(pc); ink += pc.s;
    }
    if (!hosts.length) continue;
    // small pieces that moved the same way right beside a moved view (its title, a north point):
    // part of it - if nothing that stayed is inside them, and little right round them
    const near = Math.ceil((30 * pxPerMm) / B);
    for (const pc of pieces) {
      if (hosts.includes(pc) || pc.zin > 0.04 * pc.s || pc.zring > 0.3 * pc.s || pc.zline > 0.01 * pc.s || pc.paper >= 0.3) continue;
      if (!hosts.some((host) => Math.max(host.box[0] - pc.box[2], pc.box[0] - host.box[2], host.box[1] - pc.box[3], pc.box[1] - host.box[3]) <= near)) continue;
      mark(pc); ink += pc.s;
      if (trace) trace.comps.push(`  with it: ${pc.box[0] * B},${pc.box[1] * B}-${(pc.box[2] + 1) * B},${(pc.box[3] + 1) * B}`);
    }
    // (all of it already taken by a part found before: nothing new)
    if (marked) parts.push({ dx: g.dx, dy: g.dy, box: [], ink, inkBox: [] });
    else for (let i = 0; i < label.length; i++) if (label[i] === id) label[i] = 0;
    // the moved ink's own extent (the part reaches into the empty paper round it)
    if (marked) {
      let x0 = gw, y0 = gh, x1 = -1, y1 = -1;
      for (let i = 0; i < label.length; i++) if (label[i] === id && sb[i]) { const x = i % gw, y = (i / gw) | 0; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      parts[id - 1].inkBox = x1 < 0 ? [] : [x0 * B, y0 * B, Math.min(w, (x1 + 1) * B), Math.min(h, (y1 + 1) * B)];
    }
  }
  // each part's box
  for (let k = 0; k < parts.length; k++) {
    let x0 = gw, y0 = gh, x1 = -1, y1 = -1;
    for (let i = 0; i < label.length; i++) if (label[i] === k + 1) {
      const x = i % gw, y = (i / gw) | 0;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    parts[k].box = [x0 * B, y0 * B, Math.min(w, (x1 + 1) * B), Math.min(h, (y1 + 1) * B)];
    if (!parts[k].inkBox.length) parts[k].inkBox = parts[k].box;
    const st = stretchedLines(o, n, label, gw, gh, B, k + 1, parts, pxPerMm);
    parts[k].joined = st.longer + st.shorter;
    parts[k].shorter = st.shorter > st.longer;
    parts[k].seams = st.at;
  }
  if (trace) parts.forEach((p, k) => trace.comps.push(`part ${k + 1} ${p.dx},${p.dy}: ${p.joined} lines stretched across its edge${p.shorter ? ' (shorter)' : ''}`));
  return parts.length ? { B, gw, gh, label, parts, nD } : null;
}

/**
 * Lines stretched across part `id`'s edge: a line that runs on across the edge (ink both sides, in
 * both sheets) whose end inside the part moved with the part while its end outside stayed - or moved
 * with the part there, when the view moved as well - a wall made longer when a floor was made
 * taller or a bay wider. A view moved on the paper has no such
 * line: what runs across its edge (the sheet's border at a corner) ends in the same place in both
 * sheets, and a line of the view itself moved at both ends.
 */
export function stretchedLines(o: Gray, n: Gray, label: Uint8Array, gw: number, gh: number, B: number, id: number, moves: { dx: number; dy: number }[], pxPerMm: number): { longer: number; shorter: number; at: number[][] } {
  const { w, h } = n;
  const ink = (g: Gray, x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && g.px[y * w + x] < INK;
  // (the old sheet looked at where the line was: a view that moved across the line's way as well -
  //  a whole elevation moved right and a floor made taller - has its upright lines elsewhere)
  const mv = moves[id - 1];
  const across = (x: number, y: number, ax: number, ay: number) => {
    const lx = ax ? 0 : mv.dx, ly = ax ? mv.dy : 0;
    for (let t = -3; t <= 2; t++) if (!ink(n, x + t * ax, y + t * ay) || !ink(o, x + t * ax - lx, y + t * ay - ly)) return false;
    return true;
  };
  // how far the line goes from (x, y) along (ax, ay) * sg: its last ink, over gaps of up to 3 mm
  // (dashes), within a pixel either side of it
  const G = Math.round(3 * pxPerMm), maxT = Math.max(w, h);
  const end = (g: Gray, x: number, y: number, ax: number, ay: number, sg: number) => {
    let last = 0;
    for (let t = 0; t < maxT; t++) {
      const px = x + sg * t * ax, py = y + sg * t * ay;
      if (px < 0 || py < 0 || px >= w || py >= h) break;
      if (ink(g, px, py) || ink(g, px - ay, py - ax) || ink(g, px + ay, py + ax)) last = t;
      else if (t - last > G) break;
    }
    return last;
  };
  let longer = 0, shorter = 0, seen = 0;
  const at: number[][] = [];
  // across the edge with what is on the other side (the rest: stayed; another part: its own move)
  const check = (x: number, y: number, ax: number, ay: number, into: number, other: number) => {
    // its end inside the part moved with the part (sIn), its end outside with what is there (sOut):
    // the line got longer by into * (sIn - sOut). A move under 0.5 mm can't be told from a line's
    // end drawn a pixel either way; under 1 mm the ends must match to the pixel; a line has to run
    // on 3 mm each side
    const sIn = ax ? mv.dx : mv.dy, sOut = other ? (ax ? moves[other - 1].dx : moves[other - 1].dy) : 0;
    // (across the line's way both sides moved alike, else the line was cut, not stretched)
    const lIn = ax ? mv.dy : mv.dx, lOut = other ? (ax ? moves[other - 1].dy : moves[other - 1].dx) : 0;
    if (Math.abs(lIn - lOut) > 1) return;
    // (between two parts the stretch goes with the one that moved further: the other is the view
    //  moved on the paper as a whole - s08: an elevation moved right, its upper floors up as well)
    if (other && Math.hypot(mv.dx, mv.dy) < Math.hypot(moves[other - 1].dx, moves[other - 1].dy)) return;
    const grow = into * (sIn - sOut), L = 3 * pxPerMm;
    if (Math.abs(grow) < Math.max(3, 0.5 * pxPerMm)) return;
    const tol = (v: number) => (Math.abs(grow) < pxPerMm ? 1 : Math.max(1.5, 0.15 * Math.abs(v)));
    const ox = x - (ax ? 0 : lIn), oy = y - (ax ? lIn : 0);
    const inN = end(n, x, y, ax, ay, into), inO = end(o, ox, oy, ax, ay, into);
    const outN = end(n, x, y, ax, ay, -into), outO = end(o, ox, oy, ax, ay, -into);
    if (inN < L || inO < L || outN < L || outO < L) return;
    seen++;
    if (Math.abs(inN - inO - into * sIn) > tol(sIn)) return;
    if (Math.abs(outN - outO + into * sOut) > (sOut ? tol(sOut) : 1)) return;
    if (grow > 0) longer++; else shorter++;
    at.push([x, y, ax, Math.abs(grow)]);
    if (typeof process !== 'undefined' && process.env?.RR_JOIN) console.log('stretched', x, y, 'in', inO, '->', inN, 'out', outO, '->', outN, 'grow', grow);
  };
  for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
    const la = label[by * gw + bx], a = la === id;
    // the edge with the block to the right (a vertical edge at x) and below (a horizontal one at y);
    // each line across it once, at the middle of its width
    const lr = bx + 1 < gw ? label[by * gw + bx + 1] : -1;
    if (lr >= 0 && a !== (lr === id)) {
      const x = (bx + 1) * B, y1 = Math.min(h, (by + 1) * B);
      for (let y = by * B; y < y1; y++) {
        if (!across(x, y, 1, 0)) continue;
        let e = y; while (e + 1 < y1 && across(x, e + 1, 1, 0)) e++;
        check(x, (y + e) >> 1, 1, 0, a ? -1 : 1, a ? lr : la);
        y = e;
      }
    }
    const lb = by + 1 < gh ? label[(by + 1) * gw + bx] : -1;
    if (lb >= 0 && a !== (lb === id)) {
      const y = (by + 1) * B, x1 = Math.min(w, (bx + 1) * B);
      for (let x = bx * B; x < x1; x++) {
        if (!across(x, y, 0, 1)) continue;
        let e = x; while (e + 1 < x1 && across(e + 1, y, 0, 1)) e++;
        check((x + e) >> 1, y, 0, 1, a ? -1 : 1, a ? lb : la);
        x = e;
      }
    }
  }
  // (a stretch under 1 mm: a pixel either way at a line's end is noise - such lines must be at
  //  least two and half of all those running across the edge: a 0.4 mm view move found 6 "stretched"
  //  lines among the many that simply moved with it)
  const small = at.length && at.every((q) => q[3] < pxPerMm);
  if (small && (at.length < 2 || at.length < 0.5 * seen)) return { longer: 0, shorter: 0, at: [] };
  return { longer, shorter, at };
}

/**
 * The old picture as compared: each part drawn through its own mapping, the rest as it is - and
 * every bit of old ink drawn exactly once, by whoever owns it:
 *  - ink the new sheet has where a part's move takes it (inside that part): the part's - unless
 *    the new sheet has it right there too (a line along the move) and it lies outside the part;
 *  - else ink the new sheet has right there: stays (the paper's border a few mm from a moved view
 *    is not dragged along with it) - unless it lies inside a part and would move inside it: then
 *    it moves (a line cut shorter at its front end would otherwise hide under the moved line);
 *  - else (gone in the new sheet - a real removal): the part it would have moved with, if any, so
 *    it shows where it would be now; else where it was.
 * A note a moved detail now covers stays where it was (its removal is not hidden under the detail),
 * and a bubble the view took along leaves no ghost behind.
 * base = old picture (rest's mapping); pics[k] = part k's picture over its box; maps[k] = from the
 * rest's picture to part k's, pixels ([a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f -
 * a part re-plotted a hair bigger moves a pixel or two more at its far side than in its middle).
 */
export function ownedOld(base: Gray, mp: MovedParts, pics: Gray[], maps: number[][], nD: Gray): Gray {
  const { w, h } = base;
  const { B, gw, label, parts } = mp;
  const lab = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : label[((y / B) | 0) * gw + ((x / B) | 0)]);
  const bp = base.px, nd = nD.px;
  // where part k takes old pixel (x, y), whole pixels; and back
  const fx = (k: number, x: number, y: number) => Math.round(maps[k][0] * x + maps[k][2] * y + maps[k][4]);
  const fy = (k: number, x: number, y: number) => Math.round(maps[k][1] * x + maps[k][3] * y + maps[k][5]);
  const back = maps.map((m) => { const det = m[0] * m[3] - m[1] * m[2]; const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det; return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]; });
  // what the new sheet says about an old ink pixel: the part whose move takes it onto new ink
  // (0: none), and whether new ink is right where it was
  const movedTo = (x: number, y: number): number => {
    for (let k = 0; k < parts.length; k++) {
      const vx = fx(k, x, y), vy = fy(k, x, y);
      if (lab(vx, vy) === k + 1 && nd[vy * w + vx] < ANY) return k + 1;
    }
    return 0;
  };
  const destOf = (x: number, y: number): number => {
    for (let k = 0; k < parts.length; k++) if (lab(fx(k, x, y), fy(k, x, y)) === k + 1) return k + 1;
    return 0;
  };
  // a view's outermost bits (a grid line's last dashes, a bubble) can fall just outside its part
  // when what stayed is close by. Old ink there that the new sheet doesn't have in place, but has
  // exactly the part's move away - where the old sheet has nothing - moved with the part too.
  // Only within 6 blocks (~8 mm) of the part.
  const oD = minFilter(base, 1).px;
  const nearPart = parts.map((_, k) => {
    const m = new Uint8Array(label.length);
    for (let i = 0; i < label.length; i++) if (label[i] === k + 1) m[i] = 1;
    return dilate(m, gw, mp.gh, 6);
  });
  const loose = (x: number, y: number): number => {
    const bi = ((y / B) | 0) * gw + ((x / B) | 0);
    for (let k = 0; k < parts.length; k++) {
      if (!nearPart[k][bi]) continue;
      const vx = fx(k, x, y), vy = fy(k, x, y);
      if (vx < 0 || vy < 0 || vx >= w || vy >= h || lab(vx, vy) === k + 1) continue;
      const j = vy * w + vx;
      if (nd[j] < ANY && oD[j] >= ANY) return k + 1;
    }
    return 0;
  };
  /** is old ink pixel (x, y) drawn at `at` (0 = where it was, k = moved with part k)? Ink both ways
   *  explain (a line along the move) is drawn by whichever owns the spot it lands on */
  const drawn = (x: number, y: number, at: number): boolean => {
    const m = movedTo(x, y), st = nd[y * w + x] < ANY;
    if (m && st) return at === 0 ? lab(x, y) === 0 : m === at;
    if (m) return m === at;
    // (new ink right there - but inside a part, going nowhere else: the part's own ink that is not
    //  where the move takes it - a pipe cut shorter at its front end, now covered by the moved pipe -
    //  moves with the part and shows as the change it is; what stayed beside a part stays)
    if (st) { const k = lab(x, y); return k && destOf(x, y) === k ? at === k : at === 0; }
    const d = destOf(x, y);
    if (d) return d === at;
    // (drawn moved by the rest's picture moved whole pixels: see below)
    return at === 0 && !loose(x, y);
  };
  const out = new Uint8Array(w * h).fill(255);
  // the rest: its ink where it stays; its paper where no part is
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, v = bp[i];
    if (v === 255) continue;
    if (v < ANY ? drawn(x, y, 0) : lab(x, y) === 0) { if (v < out[i]) out[i] = v; }
  }
  // loose bits of a part just outside it: the old ink moved the part's whole pixels
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = bp[y * w + x];
    if (v >= ANY || nd[y * w + x] < ANY || movedTo(x, y) || destOf(x, y)) continue;
    const k = loose(x, y);
    if (!k) continue;
    const vx = fx(k - 1, x, y), vy = fy(k - 1, x, y);
    if (vx < 0 || vy < 0 || vx >= w || vy >= h) continue;
    const j = vy * w + vx;
    if (v < out[j]) out[j] = v;
  }
  // each part: its picture where its old ink is its own
  parts.forEach((p, k) => {
    const pic = pics[k], [x0, y0, x1, y1] = p.box, pw = x1 - x0;
    const m = back[k];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (lab(x, y) !== k + 1) continue;
      const v = pic.px[(y - y0) * pw + (x - x0)];
      if (v === 255) continue;
      const ux = Math.round(m[0] * x + m[2] * y + m[4]), uy = Math.round(m[1] * x + m[3] * y + m[5]);
      const u = ux >= 0 && uy >= 0 && ux < w && uy < h ? bp[uy * w + ux] : 255;
      if (u < ANY && !drawn(ux, uy, k + 1)) continue;
      const i = y * w + x;
      if (v < out[i]) out[i] = v;
    }
  });
  return { w, h, px: out };
}

/** the parts without some (their blocks go back to the rest), numbered afresh */
export function keepParts(mp: MovedParts, keep: boolean[]): MovedParts {
  const map = new Uint8Array(mp.parts.length + 1);
  let k = 0;
  mp.parts.forEach((_, i) => { if (keep[i]) map[i + 1] = ++k; });
  const label = mp.label.map((v) => map[v]);
  return { ...mp, label, parts: mp.parts.filter((_, i) => keep[i]) };
}

/** which part (0 = none) a point of the new picture (pixels) is in */
export function partAt(mp: MovedParts, x: number, y: number): number {
  const bx = Math.floor(x / mp.B), by = Math.floor(y / mp.B);
  if (bx < 0 || by < 0 || bx >= mp.gw || by >= mp.gh) return 0;
  return mp.label[by * mp.gw + bx];
}

/** the part as rectangles (runs of blocks merged down the rows), pixels [x0, y0, x1, y1] */
export function partRects(mp: MovedParts, id: number): number[][] {
  const { B, gw, gh, label } = mp;
  const open = new Map<string, number[]>();
  const out: number[][] = [];
  for (let y = 0; y <= gh; y++) {
    const runs: [number, number][] = [];
    if (y < gh) for (let x = 0; x < gw;) {
      if (label[y * gw + x] !== id) { x++; continue; }
      const a = x; while (x < gw && label[y * gw + x] === id) x++;
      runs.push([a, x]);
    }
    const now = new Set(runs.map(([a, b]) => a + ',' + b));
    for (const [k, r] of open) if (!now.has(k)) { out.push(r); open.delete(k); }
    for (const [a, b] of runs) {
      const k = a + ',' + b;
      const r = open.get(k);
      if (r) r[3] = (y + 1) * B; else open.set(k, [a * B, y * B, b * B, (y + 1) * B]);
    }
  }
  return out;
}
