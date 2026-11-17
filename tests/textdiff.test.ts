import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textDiff, phrases } from '../src/engine/textdiff';

const w = (s: string, x: number, y = 100) => ({ s, x0: x, y0: y, x1: x + 25, y1: y + 10 });

test('two values swapped in a schedule row are text changes, not moved words', () => {
  const t = phrases(textDiff([w('1200', 100), w('2100', 145)], [w('2100', 100), w('1200', 145)])).filter((c) => c.kind !== 'moved');
  assert.deepEqual(t.map((c) => `${c.from}>${c.to}`).sort(), ['1200>2100', '2100>1200']);
});

test('a note that re-flowed (same words a little further on) is moved, not changed', () => {
  const t = textDiff([w('WALL', 100), w('TYPE', 130)], [w('WALL', 108), w('TYPE', 138)]);
  assert.ok(t.every((c) => c.kind === 'moved'), JSON.stringify(t));
});

test('a dimension changed in place', () => {
  const t = textDiff([w('4200', 100)], [w('4500', 100)]);
  assert.deepEqual(t.map((c) => [c.kind, c.from, c.to]), [['changed', '4200', '4500']]);
});
