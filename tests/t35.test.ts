// 0.6.1 T35 (DECISIONS 130): no line on screen says "the engine" - the three left from before 0.6.0, word for word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('T35: the out-of-memory and stopped-twice lines, word for word', async () => {
  (globalThis as unknown as { window: unknown }).window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, rr: {} };
  (globalThis as unknown as { localStorage: unknown }).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const R = await import('../src/ui/runner');
  assert.equal(R.TOO_LARGE_TEXT, 'This sheet is too large to compare at this checking resolution - the PC ran out of memory on it. Lower the checking resolution (Settings) and try again.');
  assert.equal(R.STOPPED_TWICE_TEXT, 'Comparing this sheet stopped twice before it finished. Try again - if it stops again, the drawing may be damaged or too heavy for this PC.');
});

test('T35: the start screen and no quoted text in src/ui says "the engine"', () => {
  const app = fs.readFileSync('src/ui/App.tsx', 'utf8');
  assert.match(app, /<h3>Rev Radar could not start<\/h3>/);
  assert.ok(app.includes('Close it and open it again. If this screen comes back, install Rev Radar again.'));
  assert.ok(app.includes('Detail: '));
  const hits: string[] = [];
  for (const f of fs.readdirSync('src/ui').filter((x) => /\.(tsx?|ts)$/.test(x))) {
    for (const [i, l] of fs.readFileSync(path.join('src/ui', f), 'utf8').split('\n').entries()) {
      const code = l.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').replace(/^\s*\*.*$/, '');
      if (/(['"`>])[^'"`<]*\b[Tt]he engine\b[^'"`<]*(['"`<])/.test(code)) hits.push(`${f}:${i + 1}`);
    }
  }
  assert.deepEqual(hits, []);
});
