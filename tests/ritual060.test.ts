// The 0.6.0 Deep ritual (19 Nov): the sweep's findings confirmed in the code, each fixed with a test that fails on
// the code before (6110cdb).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinSplitRows, sectionsOf, type Para } from '../src/engine/docs';

// sweep 6: T29's split-row join looked at every earlier row and every row of near length for each page break -
// 3,000 pages of a 40-row table took 52 s
test('ritual 0.6.0: a long table - the split-row join is not a scan per page break (1,000 pages x 40 rows < 2 s)', () => {
  const mk = (pages: number, per: number): Para[] => {
    const ps: Para[] = [];
    let i = 0;
    for (let p = 1; p <= pages; p++) for (let r = 0; r < per; r++) {
      const t = `row ${p} ${r} concrete grade item`;
      ps.push({ i: i++, file: 'f.pdf', page: p, num: r === 0 ? '' : String(r), text: t, head: '', seg: [[0, 0, 0, 200, 10]], wb: t.split(' ').map((_, k) => [0, k * 10, 0, k * 10 + 8, 10]), cells: [t, '1', 'm2'] } as Para);
    }
    return ps;
  };
  const O = sectionsOf('f.pdf', mk(1000, 40)), N = sectionsOf('f.pdf', mk(1000, 40));
  const t = performance.now();
  joinSplitRows(O, N);
  const ms = performance.now() - t;
  assert.ok(ms < 2000, `${Math.round(ms)} ms`);
});

// sweep 1: Stop while part 2 of an export was being written took away "<name> (part 2).pdf" - a file this run had not
// written yet, so an earlier export's part 2
test('ritual 0.6.0: export Stop takes away only what this run wrote, not an earlier export\'s part of the same name', async () => {
  (globalThis as unknown as { window: unknown }).window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, rr: {} };
  (globalThis as unknown as { localStorage: unknown }).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const E = await import('../src/ui/exporting');
  const d = E.stopDiscard(['C:/x/Set (part 1).pdf'], 'C:/x/Set (part 2).pdf');
  assert.ok(!d.includes('C:/x/Set (part 2).pdf'), d.join('; '));
  assert.ok(d.includes('C:/x/Set (part 1).pdf') && d.includes('C:/x/Set (part 2).part.pdf'), d.join('; '));
});
