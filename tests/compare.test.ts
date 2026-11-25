import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pixelChange } from '../src/engine/compare';

// 0.6.1 T37 (DeepSeek 1, DECISIONS 142): the neighbourhood ink sum is exact past r = 7 (it was packed in 16 bits and
// spilled into the darkest-pixel field: solid ink read as changed at the close looks' r = 8 / 12)
test('T37 (bug 1): r = 12 on dense ink - a block of ink added is found (the new sum crossed 65,536, wrapped in 16 bits and hid it)', () => {
  // (the same random sheet the search found: ~47 % of pixels dark, a dark block added in the new)
  let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const w = 60, h = 60;
  let o = new Uint8Array(0), n = new Uint8Array(0);
  for (let trial = 0; trial <= 51; trial++) {
    o = new Uint8Array(w * h).fill(255); n = new Uint8Array(w * h);
    const dens = rnd(); for (let i = 0; i < w * h; i++) if (rnd() < dens) o[i] = Math.floor(rnd() * 60);
    n.set(o);
    const bx = 20 + Math.floor(rnd() * 15), by = 20 + Math.floor(rnd() * 15), bw = 2 + Math.floor(rnd() * 10), bh = 1 + Math.floor(rnd() * 4), dark = rnd() < 0.5;
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) n[y * w + x] = dark ? 0 : 255;
  }
  const x = 41, y = 34, r = 12, i = y * w + x;
  // the rule by hand, with exact sums: new ink nearby exceeds old by more than half the pixel's ink, and the old has
  // nothing as dark nearby
  let oMin = 255, oSum = 0, nSum = 0;
  for (let yy = y - r; yy <= y + r; yy++) for (let xx = x - r; xx <= x + r; xx++) { const k = yy * w + xx; oMin = Math.min(oMin, o[k]); oSum += 255 - o[k]; nSum += 255 - n[k]; }
  assert.ok(oSum < 65536 && nSum > 65535 && nSum - oSum > (255 - n[i]) * 0.5, `sums ${oSum} ${nSum}`);
  assert.equal(pixelChange(o, n, i, x, y, w, h, r, 48) & 2, 2, 'added');
});
test('T37 (bug 1): r <= 7 - the same answers as 0.6.0 for 10,000 random pixels', () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const w = 60, h = 60, o = new Uint8Array(w * h), n = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { o[i] = rnd() < 0.5 ? Math.floor(rnd() * 256) : 255; n[i] = rnd() < 0.5 ? Math.floor(rnd() * 256) : o[i]; }
  let hsh = 0;
  for (let k = 0; k < 10000; k++) {
    const x = Math.floor(rnd() * w), y = Math.floor(rnd() * h), r = 1 + Math.floor(rnd() * 7), i = y * w + x;
    hsh = (hsh * 31 + pixelChange(o, n, i, x, y, w, h, r, 48) + 1) >>> 0;
  }
  assert.equal(hsh, EXPECT_060);
});
const EXPECT_060 = 2924456914; // (taken on 0.6.0's compare.ts)

// 0.6.1 T37 (DeepSeek 3, DECISIONS 144): the overlay picture colours what the change rule calls changed - a long line
// taken out of a densely hatched wall (longLineGone) was counted but drawn grey
test('T37 (bug 3): a long line taken out of hatching - every pixel the rule calls removed is drawn in the old colour', async () => {
  const { overlay, defaultPalette } = await import('../src/engine/compare');
  const w = 120, h = 60;
  const o = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x + y) % 4 === 0 || (x - y + 400) % 4 === 0) o[y * w + x] = 40;
  const n = o.slice();
  for (let x = 10; x < 110; x++) { o[30 * w + x] = 0; o[31 * w + x] = 0; }
  const r = 2, t = 48;
  const pic = overlay({ w, h, px: o }, { w, h, px: n }, r, t, defaultPalette, 0.55);
  let removed = 0, drawn = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (Math.abs(o[i] - n[i]) <= t || !(pixelChange(o, n, i, x, y, w, h, r, t) & 1)) continue;
    removed++;
    const R = pic[i * 4], G = pic[i * 4 + 1];
    if (R > 150 && G < 120) drawn++;
  }
  assert.ok(removed > 20, `removed ${removed}`);
  assert.equal(drawn, removed, 'drawn in the old colour');
});
