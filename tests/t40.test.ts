// 0.6.1 T40 - DeepSeek 9, 10, 11, 4 (DECISIONS 145, 146; PLAN)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readItems, compareBoq, unitOf } from '../src/engine/boq';
import { pairPics, type Pic } from '../src/engine/picdiff';
import type { Book } from '../src/engine/sheets';
import { gen } from './gen/gapgen';

const book1 = (rows: (string | number | null)[][]): Book => ({ sheets: [{ name: 'S', hidden: false, hiddenCols: [], rows: rows.map((c, r) => ({ r, hidden: false, c })) }] });
const HDR = ['Item', 'Description', 'Qty', 'Unit', 'Rate', 'Amount'];
const key = (r: ReturnType<typeof compareBoq>) => JSON.stringify([r.pairs.map((p) => [p.o, p.n, p.how, p.changed]), r.added, r.removed]);
const both = (o: any, n: any) => {
  const prev = process.env.RR_OFF;
  try { process.env.RR_OFF = 'gapindex'; const full = key(compareBoq(o, n)); process.env.RR_OFF = ''; return { full, index: key(compareBoq(o, n)) }; } finally { process.env.RR_OFF = prev ?? ''; }
};

test('T40 bug 9: a big rewritten gap (600 x 600, five seeds) - the index pairs exactly as the full weighing', () => {
  for (const seed of [1, 2, 3, 4, 5]) { const { o, n } = gen(600, seed, false); const r = both(o, n); assert.equal(r.index, r.full, 'seed ' + seed); }
});
test('T40 bug 9: the same with descriptions full of numbers and common words (each shares "w" 7 times) - still exact', () => {
  for (const seed of [1, 2]) { const { o, n } = gen(600, seed, true); const r = both(o, n); assert.equal(r.index, r.full, 'seed ' + seed); }
});
test('T40 bug 9: 5,000 x 5,000 rewritten gap under 5 s', () => {
  const { o, n } = gen(5000, 1, false);
  const t = performance.now(); const r = compareBoq(o, n); const ms = performance.now() - t;
  assert.ok(r.pairs.length > 4500, 'pairs ' + r.pairs.length);
  assert.ok(ms < 5000, Math.round(ms) + ' ms');
});

test('E3 (DECISIONS 160): a pair reached only through the same quantity - float noise, 0 on the new side - index = full weighing', () => {
  const mk = (i: number, text: string, unit: string, qty: number) => ({ i, file: 'f', bill: '', sheet: 'S', row: i + 2, page: '', ref: '', mark: false, section: '', group: '', text, unit, qty, rate: null, amount: null });
  const L = (i: number) => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + ((i / 26) | 0));
  for (const [qo, qn] of [[0.7 + 0.2 + 0.1, 1], [1e-12, 0], [0.00012340001, 0.0001234], [250.5, 250.5]]) {
    const O: any[] = [], N: any[] = [];
    for (let i = 0; i < 520; i++) { O.push(mk(i, 'alpha' + 'abcdefghij'[i % 10].repeat(1 + (i % 7)) + 'q' + L(i) + ' zed', 'm2', 3)); N.push(mk(i, 'beta' + L(i) + 'k yon', 'm3', 7)); }
    O[100] = mk(100, 'only old words here', 'm', qo); N[100] = mk(100, 'totally different text there', 'm', qn);
    const r = both({ items: O, notes: [], sheets: [] }, { items: N, notes: [], sheets: [] });
    assert.equal(r.index, r.full, qo + ' / ' + qn);
  }
});

test('T40 bug 10: "Total heat rejection" measured (1 No / 5,000) is an item; an amount alone and a collection line are not', () => {
  const it = readItems(book1([HDR, ['A', 'Chiller', 2, 'nr', 100, 200], ['', 'Total heat rejection', 1, 'no', 5000, 5000], ['', 'Total heat rejection capacity', null, null, null, 5000],
    ['', 'Total carried to collection', null, null, null, 5400], ['D', 'Pump', 3, 'nr', 10, 30]]), 'x', 0, '').items;
  assert.deepEqual(it.map((x) => x.text), ['Chiller', 'Total heat rejection', 'Pump']);
  assert.equal(it[1].qty, 1);
});
test('T40 bug 10: a "Total ..." line with an unknown unit or a text quantity still ends the page', () => {
  const it = readItems(book1([HDR, ['A', 'Chiller', 2, 'nr', 100, 200], ['', 'Total for the plant', 'see', 'nr', null, 200], ['', 'Total floor area', 1200, 'zones', null, null], ['D', 'Pump', 3, 'nr', 10, 30]]), 'x', 0, '').items;
  assert.deepEqual(it.map((x) => x.text), ['Chiller', 'Pump']);
});

test('T40 bug 11: units written with dots and spaces - SQ. M. = m2, CU. M = m3, L. S. = sum; units resolved before stay', () => {
  assert.equal(unitOf('SQ. M.'), 'm2'); assert.equal(unitOf('CU. M'), 'm3'); assert.equal(unitOf('L. S.'), 'sum'); assert.equal(unitOf('l.s.'), 'sum');
  for (const [u, k] of [['m2', 'm2'], ['Sq.m', 'm2'], ['m 2', 'm2'], ['Nos.', 'nr'], ['LS', 'sum'], ['P.S.', 'ps'], ['kg', 'kg'], ['cu m', 'm3'], ['zones', 'zones']]) assert.equal(unitOf(u), k, u);
});

test('T40 bug 4: a picture once in the old issue and twice in the new counts as its mirror does', () => {
  const pic = (page: number): Pic => ({ file: 'f', page, box: [0, 0, 100, 100], pw: 200, ph: 200, sha: 'abc' } as Pic);
  const id = () => 'x';
  const a = pairPics([pic(0)], [pic(0), pic(1)], id, id), b = pairPics([pic(0), pic(1)], [pic(0)], id, id);
  assert.equal(a.entries.length, 0); assert.equal(b.entries.length, 0);
  assert.equal(a.same, b.same);
  assert.equal(a.same, 2);
});
