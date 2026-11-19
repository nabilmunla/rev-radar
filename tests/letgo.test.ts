// 0.6.0 T22 B (DECISIONS 106): when the view engine that makes ready lets go of what it holds (and starts afresh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mustLetGo } from '../src/ui/letgo';

const base = { onScreen: false, past: true, grewMost: 'monster', held: ['monster'], nextId: 'A-102', keep: 1 };
test('past a bar, the sheet that took it there no longer kept: lets go', () => {
  assert.equal(mustLetGo(base), true);
  assert.equal(mustLetGo({ ...base, grewMost: null }), true, 'no sheet named: lets go');
});
test('the engine on screen never; under its bars never; the heavy sheet still kept: no restart (acceptance 4)', () => {
  assert.equal(mustLetGo({ ...base, onScreen: true }), false);
  assert.equal(mustLetGo({ ...base, past: false }), false);
  assert.equal(mustLetGo({ ...base, keep: 2 }), false, 'two pairs kept: the monster stays open beside the next one');
  assert.equal(mustLetGo({ ...base, nextId: 'monster' }), false, 'going back to the monster itself');
  assert.equal(mustLetGo({ ...base, held: ['monster', 'A-101'], keep: 2 }), true, 'two kept, the monster the oldest: it goes');
});
