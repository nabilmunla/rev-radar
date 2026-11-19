// T11 (DECISIONS 76): the rule that lets a number read off the sheet pair two sheets. Fails on 0.5.0
// (no pairBySheetNo; pairByContent has no "sheet" pairs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairBySheetNo, type ReadPage } from '../src/ui/sheetpair';
import { pairByContent, drawingNo, drawingNoBare, noZeros, sheetKeyOf, type SheetRef, type Fingerprint } from '../src/ui/pairing';
import type { PageToks, Tok } from '../src/ui/sheets';

const W = 2384, H = 1684; // A1 landscape, points
const keyOf = (raw: string) => noZeros(drawingNoBare(drawingNo(raw)));
const tok = (raw: string, box: [number, number, number, number], band = true): Tok => ({ raw, key: keyOf(raw), box, band, pre: '' });
/** a sheet whose title block says `no` (bottom right) and `title` above it */
function page(pg: number, no: string | null, title = '', extra: Tok[] = []): PageToks {
  const toks = [...(no ? [tok(no, [W - 170, H - 62, W - 90, H - 46])] : []), tok('DD-03', [W - 300, H - 62, W - 250, H - 48]), ...extra];
  return { page: pg, w: W, h: H, text: true, toks, lines: title ? [{ text: title, box: [W - 420, H - 110, W - 100, H - 92] }] : [] };
}
const ref = (file: string, pg: number, pages: number): SheetRef => ({ file, rel: file.split('/').pop()!, page: pg, pages, size: 1, mtime: 1, w: W, h: H });
function combined(file: string, nos: (string | null)[], titles: string[] = []): ReadPage[] {
  return nos.map((no, i) => ({ ref: ref(file, i, nos.length), toks: page(i, no, titles[i] || '') }));
}
const fp = (r: ReadPage, words: string[]): Fingerprint => ({ ref: r.ref, words });
/** the whole step as the runner does it: numbers proposed, then the content pairing with the veto */
function run(olds: ReadPage[], news: ReadPage[], wo: string[][] = [], wn: string[][] = [], witO: ReadPage[] = [], witN: ReadPage[] = []) {
  const sp = pairBySheetNo(olds, news, witO, witN);
  for (const [r, nm] of sp.names) r.read = nm;
  const io = new Map(olds.map((p, i) => [p.ref, i] as const)), jn = new Map(news.map((p, j) => [p.ref, j] as const));
  const by = sp.pairs.map(([a, b, rep]) => [io.get(a)!, jn.get(b)!, rep] as [number, number, boolean]);
  return pairByContent(olds.map((p, i) => fp(p, wo[i] || ['PLAN'])), news.map((p, j) => fp(p, wn[j] || ['PLAN'])), 0.35, by);
}
const nos = (n: number) => Array.from({ length: n }, (_, i) => `A-${101 + i}`);

test('pages of combined PDFs are paired by the number on the sheet, whatever their order; named by it', () => {
  const title = (k: number) => ['GROUND FLOOR PLAN', 'FIRST FLOOR PLAN', 'ROOF PLAN', 'SECTION AA', 'SECTION BB', 'NORTH ELEVATION', 'SOUTH ELEVATION', 'DOOR SCHEDULE'][k];
  const o = combined('/o/Set.pdf', nos(8), nos(8).map((_, k) => title(k)));
  const shuffled = [3, 0, 7, 1, 6, 2, 5, 4];
  const n = combined('/n/Set rev B.pdf', shuffled.map((k) => nos(8)[k]), shuffled.map((k) => title(k)));
  const r = run(o, n);
  assert.equal(r.pairs.length, 8);
  for (const p of r.pairs) {
    assert.equal(p.how, 'sheet');
    assert.equal(p.old!.read!.no, p.neu!.read!.no);
  }
  assert.equal(sheetKeyOf(o[2].ref), 'A-103');
  assert.equal(o[2].ref.read!.title, 'ROOF PLAN');
});

test('a schedule with hardly any words of its own pairs by its number (it was new + removed)', () => {
  const o = combined('/o/Set.pdf', nos(6)), n = combined('/n/Set.pdf', [...nos(6)].reverse());
  // the schedule (A-104): no words in common; the others alike by their words
  const words = (k: string) => (k === 'A-104' ? [] : ['PLAN', 'ROOM' + k, 'GRID' + k]);
  const r = run(o, n, nos(6).map(words), [...nos(6)].reverse().map(words));
  const sch = r.pairs.find((p) => p.old!.read!.no === 'A-104');
  assert.ok(sch && sch.neu!.read!.no === 'A-104', 'schedule paired');
  assert.equal(r.olds.length + r.news.length, 0);
});

test('a number on two pages of one issue is not used; those pages keep today\'s pairing and are named "no (p.N)"', () => {
  // (12 pages: the reader wants the spot to differ on 90 % of them)
  const twice = nos(12).map((k, i) => (i === 2 ? 'A-102' : k));
  const o = combined('/o/Set.pdf', twice), n = combined('/n/Set.pdf', nos(12));
  const sp = pairBySheetNo(o, n);
  const keys = sp.pairs.map(([a]) => a.page).sort((a, b) => a - b);
  assert.deepEqual(keys, [0, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(sp.names.get(o[1].ref)!.no, 'A-102 (p.2)');
  assert.equal(sp.names.get(o[2].ref)!.no, 'A-102 (p.3)');
});

test('a false number, unique in both issues, on two unlike pages is refused when the words pair them elsewhere', () => {
  // spec pages: the reader found "S-900" on old page 2 and new page 0, but the words say old 2 = new 2
  const o = combined('/o/Mixed.pdf', ['A-101', 'A-102', 'S-900', 'A-104']), n = combined('/n/Mixed.pdf', ['S-900', 'A-102', 'A-999', 'A-104']);
  const wo = [['PLAN', 'X1'], ['PLAN', 'X2'], ['CONCRETE', 'CURING', 'SLUMP', 'CEMENT'], ['PLAN', 'X4']];
  const wn = [['DOORS', 'HINGES', 'LOCKS'], ['PLAN', 'X2'], ['CONCRETE', 'CURING', 'SLUMP', 'CEMENT'], ['PLAN', 'X4']];
  const r = run(o, n, wo, wn);
  const bad = r.pairs.find((p) => p.old === o[2].ref && p.neu === n[0].ref);
  assert.equal(bad, undefined, 'false number refused');
  const good = r.pairs.find((p) => p.old === o[2].ref);
  assert.ok(good && good.neu === n[2].ref && good.how === 'content');
});

test('renamed single files pair by their number when the name-paired witnesses agree; not when they do not', () => {
  const one = (file: string, no: string): ReadPage => ({ ref: ref(file, 0, 1), toks: page(0, no) });
  const witO = ['A-201', 'A-202', 'A-203'].map((k) => one(`/o/${k}.pdf`, k)), witN = ['A-201', 'A-202', 'A-203'].map((k) => one(`/n/${k} rev B.pdf`, k));
  const o = [one('/o/scan copy.pdf', 'A-204')], n = [one('/n/final issue.pdf', 'A-204')];
  const r = run(o, n, [['PLAN']], [['ELEVATION']], witO, witN);
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].how, 'sheet');
  assert.equal(sheetKeyOf(o[0].ref), 'A-204');
  // witnesses whose read numbers are not their names' (the spot read something else): not used
  const liar = ['A-201', 'A-202', 'A-203'].map((k, i) => one(`/o/${k}.pdf`, `B-30${i}`)), liarN = ['A-201', 'A-202', 'A-203'].map((k, i) => one(`/n/${k}.pdf`, `B-30${i}`));
  const o2 = [one('/o/x.pdf', 'A-204')], n2 = [one('/n/y.pdf', 'A-204')];
  assert.equal(pairBySheetNo(o2, n2, liar, liarN).pairs.length, 0);
  // no witnesses read at all: not used either
  assert.equal(pairBySheetNo([one('/o/x.pdf', 'A-204')], [one('/n/y.pdf', 'A-204')]).pairs.length, 0);
});

test('a number also on a name-paired witness is not unique: not used', () => {
  const one = (file: string, no: string): ReadPage => ({ ref: ref(file, 0, 1), toks: page(0, no) });
  const witO = ['A-201', 'A-202', 'A-203'].map((k) => one(`/o/${k}.pdf`, k)), witN = ['A-201', 'A-202', 'A-203'].map((k) => one(`/n/${k}.pdf`, k));
  // the renamed file reads A-202 - a sheet already paired by name
  assert.equal(pairBySheetNo([one('/o/odd.pdf', 'A-202')], [one('/n/odd2.pdf', 'A-202')], witO, witN).pairs.length, 0);
});

test('pages with nothing read: no pairs, no names, no error (today\'s pairing)', () => {
  const blank = (file: string, k: number): ReadPage[] => Array.from({ length: k }, (_, i) => ({ ref: ref(file, i, k), toks: { page: i, w: W, h: H, text: false, toks: [], lines: [] } }));
  const none = (file: string, k: number): ReadPage[] => Array.from({ length: k }, (_, i) => ({ ref: ref(file, i, k), toks: null }));
  for (const [o, n] of [[blank('/o/a.pdf', 5), blank('/n/a.pdf', 5)], [none('/o/a.pdf', 5), none('/n/a.pdf', 5)]]) {
    const sp = pairBySheetNo(o, n);
    assert.equal(sp.pairs.length, 0);
    assert.equal(sp.names.size, 0);
  }
});

test('a sheet whose number is read but not its title keeps the title from its file name (sweep, 17 Nov)', async () => {
  (globalThis as unknown as { window: unknown }).window = { addEventListener() {}, removeEventListener() {}, rr: {} };
  (globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = () => 0;
  const { planToPair } = await import('../src/ui/runner');
  const ref = (rel: string, read?: { no: string; title: string }): SheetRef => ({ file: '/x/' + rel, rel, page: 0, pages: 1, size: 1, ...(read ? { read } : {}) } as SheetRef);
  const a = planToPair({ old: ref('A-101 - Ground Floor Plan.pdf', { no: 'A-101', title: '' }), neu: ref('A-101 - Ground Floor Plan rev B.pdf', { no: 'A-101', title: '' }), how: 'sheet' }, 0);
  assert.equal(a.key, 'A-101');
  assert.ok(/Ground Floor Plan/.test(a.title), a.title);
  const b = planToPair({ old: ref('x.pdf', { no: 'A-102', title: 'FIRST FLOOR PLAN' }), neu: ref('y.pdf', { no: 'A-102', title: 'FIRST FLOOR PLAN' }), how: 'sheet' }, 1);
  assert.equal(b.title, 'FIRST FLOOR PLAN');
});

// 0.6.0 T20 (DECISIONS 93): a number read at a spot whose numbers repeat (a set holding some sheets twice -
// the Editor's 0.13 reader, Sheet.repeats) pairs two pages only when their content agrees (score >= 0.35);
// the plain veto (another partner at 0.8) is not needed. Fails on 0.5.1: no repeats flag, the pair is taken.
test('a number from a spot whose numbers repeat pairs only when the content agrees', () => {
  // 30 A1 pages: A-101..A-120, the first ten twice - the spot repeats (repeatedNos), the other ten are unique
  const set = [...nos(20), ...nos(10)];
  const o = combined('/o/Compiled.pdf', set), n = combined('/n/Compiled.pdf', set);
  const sp = pairBySheetNo(o, n);
  const byNo = new Map(sp.pairs.map(([a, b, rep]) => [o.findIndex((p) => p.ref === a), [n.findIndex((p) => p.ref === b), rep]] as const));
  for (let i = 10; i < 20; i++) assert.deepEqual(byNo.get(i), [i, true], `A-${101 + i} pairs by number, marked as read at a repeating spot`);
  for (let i = 0; i < 10; i++) assert.equal(byNo.has(i), false, `A-${101 + i} is on two pages: never paired by its number`);
  // contents: page 14 (A-115) unlike its numbered partner and like nothing else; page 15 (A-116) like it
  const wo = set.map((_, i) => ['PLAN', `R${i}`]), wn = set.map((_, i) => ['PLAN', `R${i}`]);
  wo[14] = ['DOORS', 'HINGES', 'LOCKS', 'Q1']; wn[14] = ['CONCRETE', 'CURING', 'SLUMP', 'Q2'];
  const r = run(o, n, wo, wn);
  const p14 = r.pairs.find((p) => p.old === o[14].ref);
  assert.ok(!p14 || p14.how !== 'sheet', 'unlike content: not paired by the repeating spot\'s number');
  const p15 = r.pairs.find((p) => p.old === o[15].ref);
  assert.ok(p15 && p15.neu === n[15].ref && p15.how === 'sheet', 'like content: paired by its number');
  // the same unlike pair read at a spot that does not repeat is still taken (0.5.1's rule, unchanged)
  const o2 = combined('/o/Plain.pdf', nos(20)), n2 = combined('/n/Plain.pdf', nos(20));
  const w2o = nos(20).map((_, i) => ['PLAN', `R${i}`]), w2n = nos(20).map((_, i) => ['PLAN', `R${i}`]);
  w2o[14] = wo[14]; w2n[14] = wn[14];
  const r2 = run(o2, n2, w2o, w2n);
  assert.equal(r2.pairs.find((p) => p.old === o2[14].ref)?.how, 'sheet');
});
