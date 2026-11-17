// Moved parts (moved.ts) on drawn pictures: a view moved on the paper is found with its move; a
// building moved against grid lines that stayed is not a moved view; the part's rectangles cover
// exactly its blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff, defaultDiff, type Gray } from '../src/engine/compare';
import { movedParts, partRects, stretchedLines } from '../src/engine/moved';

const W = 1600, H = 1100, PXMM = 150 / 25.4;
const blank = (): Gray => ({ w: W, h: H, px: new Uint8Array(W * H).fill(255) });
const hline = (g: Gray, x0: number, x1: number, y: number, t = 2) => { for (let yy = y; yy < y + t; yy++) for (let x = x0; x < x1; x++) if (x >= 0 && x < W && yy >= 0 && yy < H) g.px[yy * W + x] = 0; };
const vline = (g: Gray, x: number, y0: number, y1: number, t = 2) => { for (let y = y0; y < y1; y++) for (let xx = x; xx < x + t; xx++) if (xx >= 0 && xx < W && y >= 0 && y < H) g.px[y * W + xx] = 0; };
const rect = (g: Gray, x0: number, y0: number, x1: number, y1: number) => { hline(g, x0, x1, y0); hline(g, x0, x1, y1); vline(g, x0, y0, y1); vline(g, x1, y0, y1 + 2); };
/** "text": a row of small blocks */
const text = (g: Gray, x: number, y: number, n: number) => { for (let k = 0; k < n; k++) for (let yy = y; yy < y + 9; yy++) for (let xx = x + k * 8; xx < x + k * 8 + 5; xx++) if ((xx + yy) % 3) g.px[yy * W + xx] = 20; };

/** the paper: border and a title block column */
function paper(g: Gray) {
  rect(g, 20, 20, W - 22, H - 22);
  vline(g, W - 260, 20, H - 22);
  for (let k = 0; k < 8; k++) { hline(g, W - 260, W - 22, 120 + k * 110); text(g, W - 240, 140 + k * 110, 14); }
}
/** a plan: rooms, walls, labels - drawn at (ox, oy); grid = its grid lines (or not: drawn apart) */
function plan(g: Gray, ox: number, oy: number, grid = true) {
  const cols = 6, rows = 4, cw = 170, rh = 160;
  for (let i = 0; i <= cols; i++) { vline(g, ox + i * cw, oy, oy + rows * rh, 3); if (grid) vline(g, ox + i * cw + 1, oy - 40, oy, 1); }
  for (let j = 0; j <= rows; j++) { hline(g, ox, ox + cols * cw, oy + j * rh, 3); if (grid) hline(g, ox - 40, ox, oy + j * rh + 1, 1); }
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) { text(g, ox + i * cw + 40, oy + j * rh + 60, 8 + ((i + j) % 4)); rect(g, ox + i * cw + 20, oy + j * rh + 100, ox + i * cw + 70, oy + j * rh + 130); }
}

function run(o: Gray, n: Gray) {
  const opt = defaultDiff(PXMM);
  const d = diff(o, n, opt);
  return movedParts(o, n, PXMM, d.blocks, opt.block);
}

test('a plan moved 10 px down on the paper is one moved part, with its move', () => {
  const o = blank(), n = blank();
  paper(o); paper(n);
  plan(o, 120, 150); plan(n, 120, 160);
  const r = run(o, n);
  assert.ok(r && !r.rebase, 'found');
  assert.equal(r!.parts.length, 1);
  const p = r!.parts[0];
  assert.deepEqual([p.dx, p.dy], [0, 10]);
  // the part holds the plan (not the title block column)
  assert.ok(p.box[0] <= 120 && p.box[2] >= 120 + 6 * 170 && p.box[2] < W - 260, `box ${p.box}`);
  // its rectangles are exactly its blocks
  const rects = partRects(r!, 1);
  let inRects = 0, labelled = 0;
  for (let by = 0; by < r!.gh; by++) for (let bx = 0; bx < r!.gw; bx++) {
    const x = bx * r!.B + 1, y = by * r!.B + 1;
    const inside = rects.some((q) => x >= q[0] && x < q[2] && y >= q[1] && y < q[3]);
    if (inside) inRects++;
    if (r!.label[by * r!.gw + bx] === 1) { labelled++; assert.ok(inside); }
  }
  assert.equal(inRects, labelled);
});

test('the paper moved and the plan stayed: the sheet is lined up with the paper (rebase)', () => {
  const o = blank(), n = blank();
  // old picture lined up with the plan (the bigger part): the paper sits 12 px off
  const p0 = blank(); paper(p0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (y + 12 < H && p0.px[y * W + x] === 0) o.px[(y + 12) * W + x] = 0;
  paper(n);
  plan(o, 120, 160); plan(n, 120, 160);
  const r = run(o, n);
  assert.ok(r && r.rebase, 'rebase asked');
  assert.deepEqual([r!.rebase!.dx, r!.rebase!.dy], [0, -12]);
});

test('a building moved against grid lines that stayed is not a moved view', () => {
  const o = blank(), n = blank();
  paper(o); paper(n);
  plan(o, 120, 150, false); plan(n, 120, 160, false);
  // long grid lines through the plan, the same in both
  for (const g of [o, n]) { for (let i = 0; i <= 6; i++) vline(g, 120 + i * 170 + 85, 100, 860, 1); for (let j = 0; j <= 4; j++) hline(g, 80, 1200, 150 + j * 160 + 80, 1); }
  const r = run(o, n);
  assert.ok(!r || r.parts.length === 0, `parts: ${r?.parts.map((p) => p.box).join(' | ')}`);
});

test('nothing moved: nothing found', () => {
  const o = blank(), n = blank();
  paper(o); paper(n); plan(o, 120, 150); plan(n, 120, 150);
  text(n, 400, 500, 12); // a real change
  assert.equal(run(o, n), null);
});

test('a floor made taller: lines stretched across the edge of the part above (it moved up, its walls got longer)', () => {
  const o = blank(), n = blank();
  paper(o); paper(n);
  // an elevation: walls from the roof down to the ground, floor lines, windows; in the new sheet
  // everything above y 700 is 18 px higher (the walls run on: longer)
  const elev = (g: Gray, up: number) => {
    const lift = (y: number) => (y < 700 ? y - up : y);
    for (const x of [120, 1240]) vline(g, x, lift(100), 1000, 3);
    const floors = [100, 250, 400, 550, 700, 850];
    for (const y of [...floors, 1000]) hline(g, 120, 1240, lift(y), 2);
    for (const f of floors) for (let k = 0; k < 8; k++) { rect(g, 160 + k * 135, lift(f + 30), 230 + k * 135, lift(f + 100)); text(g, 165 + k * 135, lift(f + 115), 6); }
  };
  elev(o, 0); elev(n, 18);
  // the part: the blocks above y 664 (between the moved windows and the floor line that stayed)
  const B = 8, gw = Math.ceil(W / B), gh = Math.ceil(H / B), label = new Uint8Array(gw * gh);
  for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) if (by * B < 664 && bx * B >= 80 && bx * B < 1280 && by * B >= 48) label[by * gw + bx] = 1;
  // (o lined up with the rest: the part's ink is 18 px off in it)
  const ls = (r: { longer: number; shorter: number }) => ({ longer: r.longer, shorter: r.shorter });
  assert.deepEqual(ls(stretchedLines(o, n, label, gw, gh, B, 1, [{ dx: 0, dy: -18 }], PXMM)), { longer: 2, shorter: 0 });
  // the other way round (a floor made lower): the walls got shorter
  const lowered = blank(); paper(lowered); elev(lowered, 18);
  const label2 = new Uint8Array(gw * gh);
  for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) if (by * B < 680 && bx * B >= 80 && bx * B < 1280 && by * B >= 48) label2[by * gw + bx] = 1;
  const orig = blank(); paper(orig); elev(orig, 0);
  assert.deepEqual(ls(stretchedLines(lowered, orig, label2, gw, gh, B, 1, [{ dx: 0, dy: 18 }], PXMM)), { longer: 0, shorter: 2 });
  // the same with the view moved whole (walls not longer): none
  const n2 = blank(); paper(n2);
  const lifted = (g: Gray) => { const t = blank(); elev(t, 0); for (let y = 18; y < H; y++) for (let x = 0; x < W; x++) if (t.px[y * W + x] < 128 && y < 1000 + 3) g.px[(y - 18) * W + x] = 0; };
  lifted(n2);
  assert.deepEqual(ls(stretchedLines(o, n2, label, gw, gh, B, 1, [{ dx: 0, dy: -18 }], PXMM)), { longer: 0, shorter: 0 });
});

test('a view moved on the paper has no stretched lines', () => {
  const o = blank(), n = blank();
  paper(o); paper(n);
  plan(o, 120, 150); plan(n, 120, 168);
  const r = run(o, n);
  assert.ok(r && r.parts.length === 1);
  assert.equal(r!.parts[0].joined, 0);

});
