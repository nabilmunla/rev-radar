// T25: the side panels' room rule (DECISIONS 97) - pure function, no window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelLayout, normalWidth, maxWidth, clampWidth, dragMax, readPanels, RAIL, KEEP } from '../src/ui/panels';

const SHOWN = { left: false, right: false };
const NORMAL = (w: number) => ({ left: normalWidth('left', w), right: normalWidth('right', w) });

test('normal widths: 320 / 320 on a big window, 286 / 300 up to 1500 px', () => {
  assert.deepEqual([normalWidth('left', 1920), normalWidth('right', 1920)], [320, 320]);
  assert.deepEqual([normalWidth('left', 1366), normalWidth('right', 1366)], [286, 300]);
  assert.deepEqual([normalWidth('left', 1500), normalWidth('right', 1500)], [286, 300]);
  assert.deepEqual([normalWidth('left', 1501), normalWidth('right', 1501)], [320, 320]);
});

test('45 % of the window at most, a panel at least 220 / 240', () => {
  assert.equal(maxWidth('left', 1920), 864);
  assert.equal(maxWidth('right', 1366), 614);
  assert.equal(clampWidth('left', 1366, 100), 220);
  assert.equal(clampWidth('right', 1366, 100), 240);
  assert.equal(clampWidth('left', 1366, 5000), 614);
  // a tiny window: the minimum still wins over the share
  assert.equal(maxWidth('right', 400), 240);
});

test('room enough: the widths set are shown as they are, the middle is the rest', () => {
  const l = panelLayout(1920, { left: 400, right: 350 }, SHOWN);
  assert.deepEqual(l, { left: 400, right: 350, mid: 1170 });
  assert.deepEqual(panelLayout(1366, NORMAL(1366), SHOWN), { left: 286, right: 300, mid: 780 });
});

test('a hidden panel is a 14 px rail; the other keeps its width', () => {
  assert.deepEqual(panelLayout(1920, { left: 400, right: 350 }, { left: true, right: false }), { left: RAIL, right: 350, mid: 1920 - RAIL - 350 });
  assert.deepEqual(panelLayout(1920, { left: 400, right: 350 }, { left: true, right: true }), { left: RAIL, right: RAIL, mid: 1920 - 2 * RAIL });
});

test('a panel the view has none of: no rail, no column', () => {
  assert.deepEqual(panelLayout(1920, { left: 400, right: 350 }, SHOWN, { right: true }), { left: 400, right: 0, mid: 1520 });
  assert.deepEqual(panelLayout(1920, { left: 400, right: 350 }, { left: true, right: false }, { right: true }), { left: RAIL, right: 0, mid: 1920 - RAIL });
});

test('a window made smaller: the wider panel gives way first, never under its minimum', () => {
  // 1100 px: 480 for the middle leaves 620 for panels set to 450 / 300: the wider gives 130
  const l = panelLayout(1100, { left: 450, right: 300 }, SHOWN);
  assert.deepEqual([l.left, l.right, l.mid], [320, 300, 480], 'the narrower one is left alone while the wider can give');
  // 1000 px: the wider comes down level with the other (150), the rest is shared by both (40 each)
  const k = panelLayout(1000, { left: 450, right: 300 }, SHOWN);
  assert.deepEqual([k.left, k.right, k.mid], [260, 260, 480]);
  // two panels the same: both give, evenly
  const e = panelLayout(1000, { left: 400, right: 400 }, SHOWN);
  assert.equal(e.mid >= KEEP && e.mid <= KEEP + 1, true);
  assert.equal(e.left, e.right, 'the same: both give the same');
  // 800 px: nothing more can give - both at their minimum, the middle is what is left (under 480)
  const m = panelLayout(800, { left: 450, right: 450 }, SHOWN);
  assert.deepEqual([m.left, m.right, m.mid], [220, 240, 340]);
});

test('the widths set are kept: the same set on a bigger window comes back whole', () => {
  const set = { left: 450, right: 300 };
  const small = panelLayout(1000, set, SHOWN);
  const big = panelLayout(1920, set, SHOWN);
  assert.ok(small.left < 450);
  assert.deepEqual([big.left, big.right], [450, 300]);
});

test('never wider than 45 % of the window even when the set width is', () => {
  assert.equal(panelLayout(1366, { left: 900, right: 240 }, SHOWN).left, 614);
});

test('hiding one gives the room back: showing it again is the width it had', () => {
  const set = { left: 400, right: 350 };
  const hid = panelLayout(1366, set, { left: true, right: false });
  const back = panelLayout(1366, set, SHOWN);
  assert.equal(hid.left, RAIL);
  assert.equal(back.left, 400);
});

test('dragMax: the middle keeps 480 beside the other column as shown, never more than 45 %', () => {
  assert.equal(dragMax('left', 1366, 300), 586);
  assert.equal(dragMax('left', 1366, RAIL), 614);
  assert.equal(dragMax('right', 1920, 864), 576);
  assert.equal(dragMax('left', 800, 240), 220, 'a window too small for it: the minimum');
});

test('the settings: one shape per tab, the old shape read as all three, junk as all shown', () => {
  const all = (l: boolean, r: boolean) => ({ drawings: { left: l, right: r }, boq: { left: l, right: r }, docs: { left: l, right: r } });
  assert.deepEqual(readPanels(undefined), all(true, true));
  assert.deepEqual(readPanels('x'), all(true, true));
  assert.deepEqual(readPanels({ left: false, right: true }), all(false, true));
  assert.deepEqual(readPanels({ left: true, right: false }), all(true, false));
  assert.deepEqual(readPanels({ drawings: { left: false, right: true }, docs: { right: false } }), {
    drawings: { left: false, right: true }, boq: { left: true, right: true }, docs: { left: true, right: false },
  });
  assert.deepEqual(readPanels({ drawings: 5, boq: null }), all(true, true));
});
