// The 0.6.1 ritual (19 Nov): the sweep's findings confirmed in the code, each fixed with a test that fails on the code
// before (b57f94c).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// sweep 2: a job engine that restarts or closes mid-compare rejected with "Documents engine restarted" / "... was
// closed" - shown as it was on the BOQ / Documents error screen
test('ritual 0.6.1: an engine that restarted or closed is not named on screen', async () => {
  (globalThis as unknown as { window: unknown }).window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, rr: {} };
  (globalThis as unknown as { localStorage: unknown }).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const { plainError } = await import('../src/ui/model');
  for (const m of ['Documents engine restarted', 'BOQ engine was closed', 'Engine 2 restarted', 'View engine was closed']) {
    const t = plainError(new Error(m), 'a file');
    assert.ok(!/engine/i.test(t), `${m} -> ${t}`);
    assert.equal(t, STOPPED_TEXT);
  }
  assert.equal(plainError(new Error('a file could not be read')), 'a file could not be read', 'other errors as before');
});
const STOPPED_TEXT = 'The work stopped before it finished. Try again - if it stops again, a file may be damaged or too heavy for this PC.';
