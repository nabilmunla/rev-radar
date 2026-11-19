// T23 (DECISIONS 96): which call an engine is running and for how long (rpc.ts `stuck`), the limit each kind of
// call gets (`hangLimit`), and what a call fails with when its engine is ended for not answering.
// npx tsx --test tests/rpc-stuck.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineClient, hangLimit, isHung, HUNG_TEXT, hungText } from '../src/engine/rpc';

const fakePort = () => ({ posted: [] as any[], onmessage: null as any, postMessage(m: any) { this.posted.push(m); }, start() {}, close() {} }) as any;

test('hangLimit: 6 minutes for any call, none for the long jobs (they have Stop) - docsReading has no Stop, so it has the limit (M2-4)', () => {
  for (const m of ['compare', 'fingerprint', 'info', 'thumb', 'ocrPgm', 'boqPage', 'view', 'viewOpen', 'viewWarm', 'memory', 'docsReading']) assert.equal(hangLimit(m), 6 * 60_000, m);
  for (const m of ['boqCompare', 'docsCompare', 'exportPdf']) assert.equal(hangLimit(m), Infinity, m);
  assert.equal(hangLimit('compare', 5000), 5000);
  assert.equal(hangLimit('boqCompare', 5000), Infinity);
});

test('M2-3: only the call that hung fails as hung - the others the ended engine had taken fail as a plain restart (so again1 sends them once more)', async () => {
  const c = new EngineClient('Engine 1');
  c.attach(fakePort(), false);
  const p1 = c.call('fingerprint').then(() => null, (e) => e);
  const p2 = c.call('info').then(() => null, (e) => e);
  c.hung = c.stuck()!.id; // (the call it is running - the oldest one taken - is the one that hung)
  c.attach(fakePort(), true);
  const [e1, e2] = (await Promise.all([p1, p2])) as Error[];
  assert.ok(isHung(e1), 'the call that hung');
  assert.equal(e1.message, HUNG_TEXT);
  assert.ok(!isHung(e2), 'the call queued behind it is not marked hung');
  assert.match(e2.message, /restarted/);
  assert.equal(c.busy, 0);
});

test('M2-6: the hung text names no engine and tells nothing of a restart; with the file known it names it (DECISIONS 120)', () => {
  for (const t of [HUNG_TEXT, hungText('A-101 Plan.pdf')]) assert.ok(!/engine|restart/i.test(t), t);
  assert.equal(HUNG_TEXT, 'A file gave no answer for 6 minutes and reading it was stopped (a damaged or extremely heavy file can do this). Start the comparison again.');
  assert.equal(hungText('A-101 Plan.pdf'), '"A-101 Plan.pdf" gave no answer for 6 minutes and reading it was stopped (a damaged or extremely heavy file can do this). Start again - if it stops at the same file, take that file out and compare the rest.');
});

test('stuck: nothing pending, or no engine yet, is not stuck', () => {
  const c = new EngineClient('Engine 1');
  assert.equal(c.stuck(), null);
  void c.call('compare').catch(() => {});
  assert.equal(c.stuck(), null, 'no port: the call is only waiting to be posted');
  c.attach(fakePort(), false);
  assert.ok(c.stuck(), 'posted when the engine came: it is running it');
});

test('stuck: the oldest call, timed from when the engine last answered', () => {
  const c = new EngineClient('Engine 1');
  const port = fakePort();
  c.attach(port, false);
  const t0 = performance.now();
  void c.call('compare').catch(() => {});
  void c.call('thumb').catch(() => {});
  const s1 = c.stuck(t0 + 5000)!;
  assert.equal(s1.method, 'compare');
  assert.ok(s1.ms >= 4900 && s1.ms < 5100, String(s1.ms));
  // the first answers late: the next one only starts then, so it is not "old" the moment it does
  port.onmessage({ data: { id: s1.id, ok: true, value: 1 } });
  const s2 = c.stuck(performance.now() + 100)!;
  assert.equal(s2.method, 'thumb');
  assert.ok(s2.ms >= 90 && s2.ms < 500, 'the second call started when the first answered: ' + s2.ms);
  port.onmessage({ data: { id: s2.id, ok: true, value: 1 } });
  assert.equal(c.stuck(), null, 'idle again');
});

test('stuck: an engine held for its restart (calls wait for the new one) is not stuck', () => {
  const c = new EngineClient('Engine 1');
  const port = fakePort();
  c.attach(port, false);
  void c.call('compare').catch(() => {});
  const id = c.stuck()!.id;
  // answered "restarting - send it again": the call waits for the next engine
  port.onmessage({ data: { id, ok: false, error: 'engine restarting', retry: true } });
  assert.equal(c.stuck(), null);
});

test('an engine ended for not answering: its calls fail saying why, and say it was that - not a plain restart', async () => {
  const c = new EngineClient('Engine 1');
  c.attach(fakePort(), false);
  const p = c.call('fingerprint').then(() => null, (e) => e);
  c.hung = c.stuck()!.id;
  c.attach(fakePort(), true);
  const e = (await p) as Error;
  assert.ok(isHung(e), 'marked as hung');
  assert.equal(e.message, HUNG_TEXT);
  assert.ok(!/Engine 1/.test(e.message), 'plain words, no engine names');
  assert.equal(c.hung, null, 'the mark is used up');
  // the next restart, for another reason, is a plain one again
  const p2 = c.call('fingerprint').then(() => null, (x) => x);
  c.attach(fakePort(), true);
  const e2 = (await p2) as Error;
  assert.ok(!isHung(e2));
  assert.match(e2.message, /restarted/);
});
