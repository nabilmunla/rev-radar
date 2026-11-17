import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refade, inkOf } from '../src/ui/refade';
import { overlay } from '../src/engine/compare';

const px = (...cs: number[][]) => new Uint8ClampedArray(cs.flatMap((c) => [...c, 255]));
// the preview's grey for a cell with this much unchanged ink (compare.ts previewColours)
const preview = (c: number) => { const s = Math.min(1, Math.pow(c * 2.2, 0.7)) * 0.75; return [255 - s * 185, 255 - s * 177, 255 - s * 175].map(Math.round); };
// what the engine's overlay draws for a pixel of this much unchanged ink at `fade`
const engine = (c: number, fade: number) => {
  const v = Math.round(255 - c * 255);
  const g = { w: 1, h: 1, px: new Uint8Array([v]) };
  return [...overlay(g, g, 1, 40, undefined, fade).slice(0, 3)];
};

test('a thin line on the whole-sheet picture comes out as the engine draws it, at every fade (RR-025)', () => {
  for (const c of [0.05, 0.15, 0.3, 0.4]) {
    for (const f of [0, 0.2, 0.35, 0.55, 0.75, 0.9]) {
      const d = px(preview(c));
      refade(d, f);
      const e = engine(c, f);
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(d[k] - e[k]) <= 4, `ink ${c} fade ${f}: ${[...d.slice(0, 3)]} vs engine ${e}`);
    }
  }
});

test('the whole slider works: every step lightens the unchanged ink (0.3.3 stopped below 0.35)', () => {
  let last = -1;
  for (const f of [0, 0.1, 0.2, 0.3, 0.35, 0.45, 0.55, 0.65, 0.75, 0.9]) {
    const d = px([116, 122, 124]);
    refade(d, f);
    assert.ok(d[0] > last, `fade ${f}: ${d[0]} after ${last}`);
    last = d[0];
  }
});

test('changed ink (red removed, blue added, a mix) and paper are left exactly as they are', () => {
  const ink = [[222, 40, 40], [24, 98, 255], [150, 70, 160], [240, 200, 200], [255, 255, 255]];
  const d = px(...ink);
  refade(d, 0.9);
  ink.forEach((c, i) => assert.deepEqual([...d.slice(i * 4, i * 4 + 3)], c));
});

test('never darker than the overlay draws unchanged ink; dense cells read smoothly', () => {
  const d = px([116, 122, 124], [70, 78, 80]);
  refade(d, 0);
  assert.ok(d[0] >= 70 && d[1] >= 78 && d[2] >= 80, `${[...d.slice(0, 3)]}`);
  for (let e = 0; e < 1; e += 0.01) assert.ok(inkOf(e + 0.01) >= inkOf(e) && inkOf(e + 0.01) - inkOf(e) < 0.08, `step at ${e}`);
});
