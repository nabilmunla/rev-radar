// 0.6.1 T42 (DECISIONS 148): run state. The registry rule (bug 18) and the thumbnails released on Home (bug 21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const stub = () => {
  (globalThis as unknown as { window: unknown }).window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, rr: {} };
  (globalThis as unknown as { localStorage: unknown }).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
};

test('T42 (18): an old call ending leaves a newer registration of the same sheet', async () => {
  stub();
  const R = await import('../src/ui/runner');
  const c1 = { name: 'a' } as never, c2 = { name: 'b' } as never;
  const old = R.register('sheet-1', c1);
  const newer = R.register('sheet-1', c2); // the sheet compared again while the old call is still going
  R.unregister('sheet-1', old); // the old call ends
  assert.equal(R.registered('sheet-1'), newer, 'the newer registration stays');
  assert.equal(R.registered('sheet-1')?.c, c2);
  R.unregister('sheet-1', newer);
  assert.equal(R.registered('sheet-1'), undefined, 'its own call removes it');
  R.unregister('sheet-1', old); // a second remove of a gone registration changes nothing
  assert.equal(R.registered('sheet-1'), undefined);
});

test('T42 (21): releasing the session on Home revokes each thumbnail once', async () => {
  stub();
  const revoked: string[] = [];
  const U = URL as unknown as { revokeObjectURL: (u: string) => void };
  const keep = U.revokeObjectURL;
  U.revokeObjectURL = (u: string) => { revoked.push(u); };
  try {
    const R = await import('../src/ui/runner');
    const { ui } = await import('../src/ui/model');
    const saved = ui.session;
    ui.session = { pairs: [{ thumbUrl: 'blob:a' }, { thumbUrl: undefined }, { thumbUrl: 'blob:b' }] } as never;
    R.releasePictures();
    R.releasePictures(); // (again: nothing left to revoke)
    ui.session = saved;
    assert.deepEqual(revoked, ['blob:a', 'blob:b']);
  } finally { U.revokeObjectURL = keep; }
  // and Home is where it is called
  assert.match(fs.readFileSync('src/ui/App.tsx', 'utf8'), /const newComparison = \(\) => \{ leave\(\); releasePictures\(\);/);
});
