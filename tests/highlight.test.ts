import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spotMask, tintPaper, TINT, type Spot } from '../src/ui/highlight';

const px = (...cs: number[][]) => new Uint8ClampedArray(cs.flatMap((c) => [...c, 255]));
const all = (n: number) => new Uint8Array(n).fill(1);

test('white paper turns the highlighter colour', () => {
  const d = px([255, 255, 255]);
  tintPaper(d, all(1));
  assert.deepEqual([...d.slice(0, 3)], [...TINT]);
});

test('ink keeps its colour exactly: added blue, removed red, black, purple mix', () => {
  const ink = [[24, 98, 255], [222, 40, 40], [0, 0, 0], [120, 60, 150], [70, 78, 80]];
  const d = px(...ink);
  tintPaper(d, all(ink.length));
  ink.forEach((c, i) => assert.deepEqual([...d.slice(i * 4, i * 4 + 3)], c));
});

test('unchanged lines keep their grey exactly as the overlay draws them (RR-027); light blue too', () => {
  // full ink, grey-70 ink and light (150) ink at the default fade 0.55; full ink at fade 0.75
  const greys = [[172, 177, 178], [195, 197, 198], [221, 222, 223], [209, 212, 213], [150, 185, 255]];
  const d = px(...greys);
  tintPaper(d, all(greys.length));
  greys.forEach((c, i) => assert.deepEqual([...d.slice(i * 4, i * 4 + 3)], c));
});

test('a scan as issued: its light grey paper is tinted when told so (old / new view of a scan)', () => {
  const d = px([228, 229, 226], [60, 60, 60]);
  tintPaper(d, all(2), 200);
  assert.ok(d[2] < 200 && d[0] >= 226, `scan paper ${[...d.slice(0, 3)]}`);
  assert.deepEqual([...d.slice(4, 7)], [60, 60, 60]);
});

test('paper tinted once is left alone by a second pass (the canvas is drawn afresh every frame anyway)', () => {
  const d = px([255, 255, 255]);
  tintPaper(d, all(1));
  tintPaper(d, all(1));
  assert.deepEqual([...d.slice(0, 3)], [...TINT]);
});

test('outside the mask nothing changes', () => {
  const d = px([255, 255, 255], [255, 255, 255]);
  tintPaper(d, new Uint8Array([0, 1]));
  assert.deepEqual([...d.slice(0, 3)], [255, 255, 255]);
  assert.deepEqual([...d.slice(4, 7)], [...TINT]);
});

test('mask: boxes are filled whole, dots are round, overlaps count once, off-canvas parts are cut', () => {
  const box: Spot = { x: 2, y: 2, w: 4, h: 3, dot: false };
  const m = spotMask([box, { ...box, x: 3 }], 1, 0, 0, 10, 10);
  assert.equal(m.reduce((a, b) => a + b, 0), 5 * 3);
  assert.equal(m[2 * 10 + 2], 1); assert.equal(m[2 * 10 + 6], 1); assert.equal(m[2 * 10 + 7], 0);
  const dot = spotMask([{ x: 0, y: 0, w: 10, h: 10, dot: true }], 1, 0, 0, 10, 10);
  assert.equal(dot[0], 0, 'a dot leaves its corners out');
  assert.equal(dot[5 * 10 + 5], 1);
  const n = dot.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(n - Math.PI * 25) < 8, `circle area ${n}`);
  // device pixels: a 2x screen doubles it; a spot half off the box read is cut there
  const hi = spotMask([{ x: 1, y: 1, w: 2, h: 2, dot: false }], 2, 0, 0, 8, 8);
  assert.equal(hi.reduce((a, b) => a + b, 0), 16);
  const cut = spotMask([{ x: -3, y: 1, w: 5, h: 1, dot: false }], 1, 0, 0, 4, 4);
  assert.equal(cut.reduce((a, b) => a + b, 0), 2);
  // (the read starts at x0, y0: the mask is relative to it)
  const off = spotMask([{ x: 5, y: 5, w: 2, h: 2, dot: false }], 1, 4, 4, 4, 4);
  assert.equal(off[1 * 4 + 1], 1); assert.equal(off[0], 0);
});

test('fast enough for every frame of a pan: a full-HD screen of spots', () => {
  const W = 1920, H = 1080;
  const spots: Spot[] = [];
  for (let i = 0; i < 300; i++) spots.push({ x: (i * 97) % W, y: (i * 53) % H, w: 24 + (i % 7) * 40, h: 24 + (i % 5) * 30, dot: i % 3 === 0 });
  const d = new Uint8ClampedArray(W * H * 4).fill(255);
  const t0 = performance.now();
  for (let k = 0; k < 5; k++) tintPaper(d, spotMask(spots, 1, 0, 0, W, H));
  const ms = (performance.now() - t0) / 5;
  // (generous: a loaded test machine doubled it)
  assert.ok(ms < 60, `${ms.toFixed(1)} ms a frame`);
});
