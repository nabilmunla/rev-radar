// Line patterns that slid along their line. A dashed or hatched linetype (hidden lines, masonry
// walls) drawn again with its pattern started at a different point: the dashes sit elsewhere along
// the very same line - red and blue bits alternating - while nothing moved. Such an area is listed
// apart ("line pattern shifted"), not as a change.
//
// Strict on purpose: only an area of no words, made of both removed and added ink in fair balance,
// long and thin along one line, where old and new have the same ink across the line (same place,
// same weight) and about the same amount along it. A line moved sideways, made solid, longer or
// shorter stays an ordinary change.
import type { Gray } from './compare';

export function patternShift(o: Gray, n: Gray, mk: { w: number; h: number; m: Uint8Array; x0: number; y0: number }, pxPerMm: number): boolean {
  const { w, h, m } = mk;
  let add = 0, rem = 0, N = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = m[y * w + x];
    if (!v) continue;
    if (v & 1) rem++;
    if (v & 2) add++;
    N++; sx += x; sy += y;
  }
  if (N < 6 || !add || !rem || Math.min(add, rem) < 0.2 * Math.max(add, rem)) return false;
  // the line: main direction of the changed pixels
  const mx = sx / N, my = sy / N;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { const dx = x - mx, dy = y - my; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy; }
  cxx /= N; cyy /= N; cxy /= N;
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det)), l2 = Math.max(1e-6, tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det)));
  if (l1 / l2 < 6 || Math.sqrt(l1) < 0.4 * pxPerMm) return false;
  let dx = cxy, dy = l1 - cxx;
  if (Math.abs(dx) + Math.abs(dy) < 1e-9) { dx = cxx >= cyy ? 1 : 0; dy = cxx >= cyy ? 0 : 1; }
  const dl = Math.hypot(dx, dy); dx /= dl; dy /= dl;
  const nx = -dy, ny = dx;
  // removed and added bits on the very same line (across it: same place) - a line moved
  // sideways is a real change
  let sr = 0, sa = 0, nr = 0, na = 0, tr0 = Infinity, tr1 = -Infinity, ta0 = Infinity, ta1 = -Infinity;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = m[y * w + x];
    if (v !== 1 && v !== 2) continue;
    const ux = x - mx, uy = y - my, sv = ux * nx + uy * ny, tv = ux * dx + uy * dy;
    if (v === 1) { sr += sv; nr++; if (tv < tr0) tr0 = tv; if (tv > tr1) tr1 = tv; }
    else { sa += sv; na++; if (tv < ta0) ta0 = tv; if (tv > ta1) ta1 = tv; }
  }
  if (!nr || !na || Math.abs(sr / nr - sa / na) > 1.2) return false;
  // every changed bit on that line (a tick or anything across it is a change)
  const sc0 = (sr / nr + sa / na) / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x] && Math.abs((x - mx) * nx + (y - my) * ny - sc0) > 2) return false;
  // ...and the line is dashed, alike, in both: along it (12 mm past the changed part each way),
  // runs of ink and gaps of about the same lengths, at least two gaps each
  const s0 = sc0, reach = Math.max(tr1, ta1) - Math.min(tr0, ta0);
  const L = Math.ceil(reach / 2 + 12 * pxPerMm);
  const runs = (g: Gray) => {
    const on: boolean[] = [];
    for (let t = -L; t <= L; t++) {
      let ink = false;
      for (let k = -1.5; k <= 1.5 && !ink; k += 0.75) {
        const x = Math.round(mk.x0 + mx + t * dx + (s0 + k) * nx), y = Math.round(mk.y0 + my + t * dy + (s0 + k) * ny);
        if (x >= 0 && y >= 0 && x < g.w && y < g.h && g.px[y * g.w + x] < 160) ink = true;
      }
      on.push(ink);
    }
    const first = on.indexOf(true), last = on.lastIndexOf(true);
    // inner runs only (the ends of the window cut a dash or gap short)
    const dash: number[] = [], gap: number[] = [];
    let cur = on[0], len = 0, lead = true;
    for (const v of on) {
      if (v === cur) { len++; continue; }
      if (!lead) (cur ? dash : gap).push(len);
      lead = false; cur = v; len = 1;
    }
    return { dash, gap, first, last };
  };
  const ro = runs(o), rn = runs(n);
  if (typeof process !== 'undefined' && process.env?.RR_PAT) console.log('pat', JSON.stringify(ro), JSON.stringify(rn));
  const med = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
  // the same linetype: dashes and gaps about the same length, about as many
  // (gaps are a few pixels at 150 dpi and come out a pixel or two either way; dashes are long)
  const alike = (a: number[], b: number[], f: number) => a.length >= 2 && b.length >= 2 && Math.abs(med(a) - med(b)) <= Math.max(2, f * Math.max(med(a), med(b)));
  if (!alike(ro.gap, rn.gap, 0.3) || !alike(ro.dash, rn.dash, 0.12) || Math.abs(ro.gap.length - rn.gap.length) > 1) return false;
  // where the line ends inside the window (a blank longer than two gaps before its first or after
  // its last ink): made longer or shorter there is a change, however its dashes came out
  const gapLen = Math.max(2, med(ro.gap), med(rn.gap)), W = 2 * L;
  const endA = (r: { first: number }) => r.first < 0 || r.first > 2 * gapLen;
  const endB = (r: { last: number }) => r.last < 0 || W - r.last > 2 * gapLen;
  if (endA(ro) !== endA(rn) || (endA(ro) && Math.abs(ro.first - rn.first) > gapLen)) return false;
  if (endB(ro) !== endB(rn) || (endB(ro) && Math.abs(ro.last - rn.last) > gapLen)) return false;
  // a strip along the line, reaching 4 mm past the changed part at both ends
  const half = Math.max(1.5 * pxPerMm, 3 * Math.sqrt(l2));
  const len = 2 * Math.sqrt(3 * l1) + 8 * pxPerMm;
  const cx = mk.x0 + mx, cy = mk.y0 + my;
  const r = Math.ceil(Math.hypot(len / 2, half)) + 1;
  const bins = Math.ceil(2 * half) + 1;
  const Po = new Float64Array(bins), Pn = new Float64Array(bins);
  let Mo = 0, Mn = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(n.h - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(n.w - 1, Math.ceil(cx + r)); x++) {
      const ux = x - cx, uy = y - cy;
      const t = ux * dx + uy * dy, s = ux * nx + uy * ny;
      if (Math.abs(t) > len / 2 || Math.abs(s) > half) continue;
      const i = y * n.w + x, io = 255 - o.px[i], inn = 255 - n.px[i];
      const b = Math.round(s + half);
      Po[b] += io; Pn[b] += inn; Mo += io; Mn += inn;
    }
  }
  if (Mo <= 0 || Mn <= 0 || Math.abs(Mo - Mn) > 0.1 * Math.max(Mo, Mn)) return false;
  let dot = 0, no = 0, nn = 0;
  for (let b = 0; b < bins; b++) { dot += Po[b] * Pn[b]; no += Po[b] * Po[b]; nn += Pn[b] * Pn[b]; }
  return dot / Math.sqrt(no * nn) >= 0.97;
}
