// The engine watch's rules (T23, DECISIONS 96, 117-119), driven with a clock of its own.
// M2-5 (119c): time the PC slept is not the engine's - a look more than 2 minutes after the one before counts for nothing.
// npx tsx --test tests/watch.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineClient } from '../src/engine/rpc';
import { Watch } from '../src/ui/watch';

const MIN = 60_000;
const fakePort = () => ({ posted: [] as any[], onmessage: null as any, postMessage(m: any) { this.posted.push(m); }, start() {}, close() {} }) as any;
/** one comparing engine (w0) and one view engine (view) each running a call that never answers; the watch with a recording environment */
function rig() {
  const w0 = new EngineClient('Engine 1'), view = new EngineClient('View engine');
  w0.attach(fakePort(), false); view.attach(fakePort(), false);
  void w0.call('fingerprint').catch(() => {}); void view.call('view').catch(() => {});
  const t0 = performance.now();
  const got = { kills: [] as string[], notices: [] as string[], over: [] as string[] };
  const watch = new Watch({
    limits: () => ({ limit: 6 * MIN, viewLimit: 90_000 }),
    onScreen: () => true,
    log: () => {}, kill: (n) => got.kills.push(n), notice: (n) => got.notices.push(n), over: (n) => got.over.push(n),
  });
  const look = (at: number) => watch.check(t0 + at, [['w0', w0], ['view', view]]);
  return { got, look, w0 };
}

test('a call that has run past its limit is ended, and a view call is noticed at 90 s and asked again at 180 s (M2-2) - looks every 5 s', () => {
  const { got, look, w0 } = rig();
  for (let t = 0; t < 6 * MIN; t += 5000) look(t);
  assert.deepEqual(got.kills, [], 'not yet');
  assert.deepEqual(got.notices, ['view', 'view'], 'the view call: at 90 s, again at 180 s');
  look(6 * MIN);
  assert.deepEqual(got.kills, ['w0']);
  assert.ok(w0.hung, 'marked as the call that hung');
});

test('M2-5: a call 7 minutes old of which 6.5 passed between two looks is not ended and raises no notice', () => {
  const { got, look } = rig();
  look(30_000);
  look(7 * MIN); // (the PC slept: the clock went on, the engine did not)
  assert.deepEqual(got.kills, []);
  assert.deepEqual(got.notices, []);
});

test('M2-5: after the sleep it is ended after 6 further minutes of looks at most 2 minutes apart', () => {
  const { got, look } = rig();
  look(30_000);
  look(7 * MIN);
  for (let t = 9 * MIN; t < 13 * MIN; t += 2 * MIN) look(t);
  assert.deepEqual(got.kills, [], '4 minutes since the sleep');
  look(13 * MIN);
  assert.deepEqual(got.kills, ['w0'], '6 minutes since the sleep');
  assert.deepEqual(got.notices, ['view', 'view'], 'the view call: noticed 90 s after the sleep (at 2 min), and again at twice that age (4 min)');
});

test('M2-5: looks 60 s apart (a window throttled in the background) are not taken for sleep - it is ended at 6 minutes', () => {
  const { got, look } = rig();
  for (let t = 0; t < 6 * MIN; t += MIN) look(t);
  assert.deepEqual(got.kills, []);
  look(6 * MIN);
  assert.deepEqual(got.kills, ['w0']);
});

test('M2-5: a notice that was up when the PC slept goes, and comes again if the call still runs 90 s after', () => {
  const { got, look } = rig();
  look(0); look(95_000);
  assert.deepEqual(got.notices, ['view']);
  look(95_000 + 4 * MIN); // (slept)
  assert.deepEqual(got.over, ['view']);
  look(95_000 + 4 * MIN + 100_000);
  assert.deepEqual(got.notices, ['view', 'view']);
});
