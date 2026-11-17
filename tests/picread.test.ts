// PLAN T6.5b: words in a changed picture, read by OCR, shown only inside the areas the pixels found
// changed (DECISIONS 40); a reading that differs elsewhere is a misread and is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Word } from '../src/engine/pdfium';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = async (): Promise<any> => import('../src/engine/picread').catch(() => ({}));
const w = (s: string, x0: number, y0: number, x1 = x0 + 6 * s.length, y1 = y0 + 9): Word => ({ s, x0, y0, x1, y1 });

test('T6.5b: a changed table picture - each changed area says old -> new; a word read differently outside them is dropped', async () => {
  const { picRead } = await load();
  assert.equal(typeof picRead, 'function', 'picread.ts picRead');
  // three changed areas (cells): 304 -> 316, HAIRLINE -> ETCHED, REQUIRED -> NOT REQUIRED; "MIRROR" read
  // as "MlRROR" on the new side, outside every area: a misread, not shown
  const O = [w('2.01', 80, 100), w('HAIRLINE', 150, 100), w('304', 300, 100), w('MIRROR', 150, 122), w('REQUIRED', 300, 144)];
  const N = [w('2.01', 80, 100), w('ETCHED', 150, 100), w('316', 300, 100), w('MlRROR', 150, 122), w('NOT', 300, 144), w('REQUIRED', 324, 144)];
  const areas = [[148, 98, 205, 111], [306, 98, 320, 111], [298, 142, 380, 155]];
  const r = picRead({ what: 'changed', o: areas, n: areas }, O, N);
  assert.deepEqual(r.pairs, [['HAIRLINE', 'ETCHED'], ['304', '316'], ['REQUIRED', 'NOT REQUIRED']]);
  assert.equal(r.text, 'HAIRLINE → ETCHED · 304 → 316 · REQUIRED → NOT REQUIRED');
  assert.ok(!/MlRROR|MIRROR/.test(r.text));
});

test('T6.5b: an area read the same both ways says nothing; not read says nothing; an added picture says what it reads', async () => {
  const { picRead } = await load();
  assert.equal(typeof picRead, 'function');
  const a = [[0, 0, 100, 20]];
  assert.deepEqual(picRead({ what: 'changed', o: a, n: a }, [w('GRADE', 2, 2)], [w('grade', 2, 2)]).pairs, []);
  assert.equal(picRead({ what: 'changed', o: a, n: a }, null, [w('X', 2, 2)]).text, '');
  assert.equal(picRead({ what: 'added', n: [[0, 0, 300, 40]] }, null, [w('PORCELAIN', 2, 2), w('TILE', 70, 2)]).text, 'PORCELAIN TILE');
});

test('T6.5b ships off (its gate missed: PROGRESS): RR_OFF has picocr by default, RR_ON=picocr turns it on', async () => {
  const { isOff } = await import('../src/engine/flags');
  delete process.env.RR_ON; delete process.env.RR_OFF;
  assert.equal(isOff('picocr'), true);
  process.env.RR_ON = 'picocr';
  try { assert.equal(isOff('picocr'), false); } finally { delete process.env.RR_ON; }
  assert.equal(isOff('tables'), false); assert.equal(isOff('pictures'), false);
});
