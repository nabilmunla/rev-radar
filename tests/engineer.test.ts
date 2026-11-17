// The Engineer's review of 0.5.0 (17 Nov): A1-A6, A8-A14 - each test fails on 4e59475.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pdfParas, sectionsOf, docEntries, type Para, type DocEntry } from '../src/engine/docs';
import { compareBoq, pairMeta, type BoqItem, type BoqDoc } from '../src/engine/boq';
import { figsOf, hunksOf } from '../src/engine/figs';
import { wordDiff, strictWord } from '../src/engine/boq';

const P = (t: string, page = 1, num = ''): Para => ({ i: 0, file: 'f.pdf', page, num, text: t, head: '', seg: [[0, 0, 0, 200, 10]], wb: t.split(' ').map((_, k) => [0, k * 10, 0, k * 10 + 8, 10]) });
const run = (O: Para[], N: Para[]) => docEntries(sectionsOf('f.pdf', O), sectionsOf('f.pdf', N)).entries;
const changed = (es: DocEntry[]) => es.filter((e) => e.kind === 'changed' || e.cls === 'changed');

test('A1: "25 -> 30" in three unrelated clauses is three changes, not one group; the same words in the same place are one', () => {
  const o = ['Concrete cover to the reinforcement shall be 25 mm minimum throughout', 'Curing of the slabs shall continue for 25 days after placing the concrete', 'Provide 25 spare lamps of each type to the employer at handover'];
  const es = changed(run(o.map((t) => P(t)), o.map((t) => P(t.replace('25', '30')))));
  assert.equal(es.length, 3);
  assert.ok(es.every((e) => e.rep === undefined), es.map((e) => e.rep).join(','));
  // (the same figure change with the same words round it: one change made three times)
  const s = ['Blockwork walls in the basement: cover 25 mm to the steel', 'Blockwork walls on the ground floor: cover 25 mm to the steel', 'Blockwork walls on the roof: cover 25 mm to the steel'];
  const g = changed(run(s.map((t) => P(t)), s.map((t) => P(t.replace('25', '30')))));
  assert.ok(g.length === 3 && g[0].rep !== undefined && g.every((e) => e.rep === g[0].rep), g.map((e) => e.rep).join(','));
  // (words changed, the same everywhere: a group, as T8)
  const w = ['Joints shall be approved by the Architect before sealing', 'Samples shall be approved by the Architect before ordering', 'Setting out shall be approved by the Architect before fixing'];
  const gw = changed(run(w.map((t) => P(t)), w.map((t) => P(t.replace('Architect', 'Engineer')))));
  assert.ok(gw.length === 3 && gw[0].rep !== undefined && gw.every((e) => e.rep === gw[0].rep));
});

test('A10: an entry that moved is not ticked with the same change made in place', () => {
  const o = ['Joints shall be approved by the Architect before sealing', 'Samples shall be approved by the Architect before ordering', 'Setting out shall be approved by the Architect before fixing', 'Ceiling grids shall be approved by the Architect before closing'];
  const N = [o[3], o[0], o[1], o[2]].map((t) => P(t.replace('Architect', 'Engineer')));
  const es = changed(run(o.map((t) => P(t)), N));
  const mv = es.find((e) => e.moved), inPlace = es.filter((e) => !e.moved);
  assert.ok(mv, 'one moved');
  assert.ok(mv.rep === undefined || inPlace.every((e) => e.rep !== mv.rep), 'the moved one is not in the in-place group');
});

const B = (i: number, text: string, o: Partial<BoqItem> = {}): BoqItem => ({ i, file: 'b.xlsx', bill: String(1 + (i % 3)), sheet: 'Bill 1', row: i + 5, page: '', ref: String.fromCharCode(65 + (i % 26)), mark: false, section: 'Mechanical', group: 'Plant', text, unit: 'nr', qty: 1, rate: 1000 + i, amount: 1000 + i, ...o });
const doc = (items: BoqItem[]): BoqDoc => ({ items, notes: [], sheets: [{ name: 'Bill 1', items: items.length }] });

test('A2: qty 1 -> 2 on a fire pump set, a timber door and a chiller is three changes; on the same item in three bills, one group', () => {
  const names = ['Fire pump set, electric, duty and standby', 'Timber door D1 single leaf complete', 'Air cooled chiller 500 kW complete', 'Water tank 20 m3 sectional', 'Booster set packaged'];
  const O = names.map((t, i) => B(i, t)), N = names.map((t, i) => B(i, t, i < 3 ? { qty: 2, amount: 2 * (1000 + i) } : {}));
  const r = compareBoq(doc(O), doc(N));
  const m = pairMeta(O, N, r.pairs);
  for (const i of [0, 1, 2]) assert.equal(m.rep[r.pairs.findIndex((p) => p.o === i)], -1, names[i]);
  const same = [0, 1, 2].map((i) => B(i, 'Fire hose reel complete with 30 m hose'));
  const S = same.map((x) => ({ ...x, qty: 2, amount: 2 * Number(x.rate) }));
  const r2 = compareBoq(doc(same), doc(S));
  const m2 = pairMeta(same, S, r2.pairs);
  const g = r2.pairs.map((_, k) => m2.rep[k]);
  assert.ok(g[0] >= 0 && g.every((x) => x === g[0]), g.join(','));
});

test('A11: items that differ only in punctuation are not all one group', () => {
  const names = ['Pipe sleeves, 100 mm', 'Fire stopping, 2 hours', 'Access panel, 600 x 600'];
  const O = names.map((t, i) => B(i, t)), N = names.map((t, i) => B(i, t.replace(',', '')));
  const r = compareBoq(doc(O), doc(N));
  const m = pairMeta(O, N, r.pairs);
  assert.ok(r.pairs.every((_, k) => m.rep[k] === -1), r.pairs.map((_, k) => m.rep[k]).join(','));
});

/** a ruled table on a page: rows of cells (x edges, y edges), its words placed in the cells */
function tablePage(rows: string[][], xs: number[], y0 = 100, rh = 20) {
  const h: number[] = [], v: number[] = [];
  for (let r = 0; r <= rows.length; r++) h.push(y0 + r * rh, xs[0], xs[xs.length - 1]);
  for (const x of xs) v.push(x, y0, y0 + rows.length * rh);
  const words = rows.flatMap((cells, r) => cells.flatMap((c, k) => { let x = xs[k] + 4; return c.split(' ').filter(Boolean).map((s) => { const w = { s, x0: x, y0: y0 + r * rh + 5, x1: x + s.length * 5, y1: y0 + r * rh + 14 }; x += s.length * 5 + 4; return w; }); }));
  const intro = 'The concrete grades below shall be used for the elements of the structure listed against each grade in this table.'.split(' ').map((s, k) => ({ s, x0: 50 + k * 30, y0: 60, x1: 50 + k * 30 + 26, y1: 70 }));
  return { words: [...intro, ...words], rules: { h, v } };
}
const tableEntries = (o: string[][], n: string[][]) => {
  const xs = [50, 150, 450];
  const a = tablePage(o, xs), b = tablePage(n, xs);
  const po = pdfParas('t.pdf', 1, () => a.words, () => 842, undefined, undefined, () => a.rules);
  const pn = pdfParas('t.pdf', 1, () => b.words, () => 842, undefined, undefined, () => b.rules);
  return docEntries(sectionsOf('t.pdf', po), sectionsOf('t.pdf', pn)).entries;
};

test('A3: a table whose first column is a value (C30 / C40) - "C40" -> "C45" is a change, not "Number only"', () => {
  const rows = [['GRADE', 'USE'], ['C30', 'Blinding and mass fill under footings'], ['C40', 'Raft foundation and pile caps'], ['C50', 'Columns and core walls up to level 10']];
  const es = tableEntries(rows, rows.map((r) => (r[0] === 'C40' ? ['C45', r[1]] : r)));
  assert.equal(es.length, 1, es.map((e) => e.kind + ' ' + e.cls).join(' / '));
  assert.equal(es[0].cls, 'changed');
  // (a column headed "Item" with numbers that follow one another stays the rows' numbers: 2.02 -> 2.03 is "Number only")
  const items = [['ITEM', 'DESCRIPTION'], ['2.01', 'Excavation to reduce levels'], ['2.02', 'Disposal of surplus material off site'], ['2.03', 'Backfilling with approved material']];
  const es2 = tableEntries(items, items.map((r) => (r[0] === '2.02' ? ['2.04', r[1]] : r)));
  assert.ok(es2.length === 1 && es2[0].cls === 'renum', es2.map((e) => e.kind + ' ' + e.cls).join(' / '));
});

test('A4: a clause moved to another section with words changed is a change, not "Moved"', () => {
  const clause = 'Insulation shall be mineral wool slabs of 100 mm thickness with a density of 45 kg per cubic metre, fixed with stainless pins to every panel.';
  const O = [P('SECTION 07 21 00 THERMAL INSULATION', 1), P('General requirements of the insulation work apply to this section in full.', 1), P(clause, 1), P('SECTION 09 21 00 GYPSUM BOARD', 2), P('Gypsum board partitions shall be as the schedule of partitions in full.', 2)];
  const N = [P('SECTION 07 21 00 THERMAL INSULATION', 1), P('General requirements of the insulation work apply to this section in full.', 1), P('SECTION 09 21 00 GYPSUM BOARD', 2), P('Gypsum board partitions shall be as the schedule of partitions in full.', 2), P(clause.replace('mineral wool', 'glass wool'), 2)];
  const es = run(O, N).filter((e) => e.moved);
  assert.equal(es.length, 1, run(O, N).map((e) => e.kind + ' ' + e.cls).join(' / '));
  assert.equal(es[0].cls, 'changed');
  assert.ok(es[0].cw && es[0].cw.o.length > 0, 'its changed words marked');
});

test('A5: a d-m-yy shape that is not surely a date is a change, not "Date / revision only"', () => {
  for (const [a, b] of [['Cabling to Section 26-05-19 of the electrical works', 'Cabling to Section 26-05-33 of the electrical works'], ['Bars shall be 10/12/16 mm as shown on the schedule', 'Bars shall be 10/12/20 mm as shown on the schedule'], ['Double glazed units 6-12-10 mm overall thickness', 'Double glazed units 8-12-10 mm overall thickness']]) {
    const e = changed(run([P(a)], [P(b)]))[0];
    assert.ok(e, b);
    assert.equal(e.cls, 'changed', b);
  }
  // (a real date with a four-digit year, or a month name: still a date)
  assert.equal(run([P('Issued for tender on 25/06/2026 for pricing only')], [P('Issued for tender on 30/06/2026 for pricing only')]).find((e) => e.kind === 'changed')?.cls, 'dateOnly');
});

test('A9 / A13: number words are figures; figure words are paired with figure words', () => {
  const f = (a: string, b: string) => figsOf(hunksOf(wordDiff(a, b), (w) => !!strictWord(w)));
  assert.deepEqual(f('Apply two coats of the primer to all steel', 'Apply three coats of the primer to all steel').map((x) => [x.o, x.n]), [['two', 'three']]);
  assert.deepEqual(f('Spacing shall not 25 mm at the joints', 'Spacing shall 30 mm at the joints').map((x) => [x.o, x.n]), [['25', '30']]);
});

test('A8: furniture draws each picture\'s look once, not once per pair (a 1,000-page catalogue drew a million)', async () => {
  const { furniture } = await import('../src/engine/picdiff');
  const ps = Array.from({ length: 60 }, (_, k) => ({ file: 'c.pdf', page: k, box: [100, 200, 400, 440], pw: 300, ph: 240, sha: 's' + k }));
  let draws = 0;
  furniture(ps, () => { draws++; return Uint8Array.from({ length: 768 }, () => draws % 7 * 30); });
  assert.ok(draws <= ps.length, `${draws} looks drawn for ${ps.length} pictures`);
});

test('A15 (17 Nov, hand check of the STR spec): a line said several times is paired where it is, not by order - "W/C 0.29" in F edited to 0.32 is a change in F, not "moved"', () => {
  const mix = (mixd: string | null, mpa: string, wc: string, cm: string) => [mixd && `Mix description: ${mixd}`, `Minimum Compressive Strength: ${mpa} Mpa at 28 days, cubic strength.`, `Maximum W/C Ratio: ${wc}`, 'Slump Limit: 120 mm to 180 mm, plus or minus 25 mm.', `Total Cement/Content Cm: ${cm} kg/m3`].filter(Boolean) as string[];
  const clause = (head: [string, string], items: string[]) => [P(head[1], 1, head[0]), ...items.map((t, i) => P(t, 1, String(i + 1)))];
  const W = '0.29 unless otherwise indicated.';
  const O = [...clause(['E', 'Columns, Walls & Retaining: Normal-weight concrete.'], mix('OPC+26%GGBS+8%SF', '95', W, '510')), ...clause(['F', 'Slab & Beams: Normal-weight concrete.'], mix('OPC+26%GGBS+7%SF', '75', W, '510')), ...clause(['G', 'Spandrel beams 14th-18th floors: Normal-weight concrete.'], mix('OPC+26%GGBS+8%SF', '95', W, '510')), ...clause(['H', 'Beams between Core Walls: Normal-weight concrete.'], mix(null, '95', 'As per structural requirements.', '510'))];
  const N = [...clause(['E', 'Columns, Walls & Retaining: Normal-weight concrete.'], mix('OPC+26%GGBS+8%SF', '95', W, '510')), ...clause(['F', 'Slab & Beams: Normal-weight concrete.'], mix('OPC+26%GGBS+7%SF', '75', '0.32 unless otherwise indicated.', '470')), ...clause(['G', 'Spandrel beams 14th-18th floors: Normal-weight concrete.'], mix('OPC+26%GGBS+8%SF', '95', W, '510')), ...clause(['H', 'Beams between Core Walls: Normal-weight concrete.'], mix('OPC+26%GGBS+8%SF', '95', W, '510'))];
  const es = run(O, N);
  const say = es.map((e) => `${e.kind}: ${e.o?.text ?? ''} -> ${e.n?.text ?? ''}`).join(' / ');
  assert.ok(!es.some((e) => e.moved || e.kind === 'moved'), say);
  assert.ok(es.some((e) => e.kind === 'changed' && /0\.29/.test(e.o?.text ?? '') && /0\.32/.test(e.n?.text ?? '')), say);
  assert.ok(es.some((e) => e.kind === 'changed' && /510/.test(e.o?.text ?? '') && /470/.test(e.n?.text ?? '')), say);
});
