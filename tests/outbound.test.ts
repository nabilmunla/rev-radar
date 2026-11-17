// What leaves the PC besides updates (electron/outbound.cjs, the update worker's "post"): only to the
// receiver named in package.json, which is empty in this build - then nothing is sent at all
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const out = require('../electron/outbound.cjs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

test('running from source names no receiver (nothing sent); the released build names the developer\'s', () => {
  assert.equal(pkg.reportEndpoint, '');
  assert.equal(pkg.countEndpoint, '');
  const pack = fs.readFileSync('scripts/pack.mjs', 'utf8');
  assert.match(pack, /const RECEIVER = 'https:\/\/greenline-reports\.n-munla\.workers\.dev';/);
  assert.match(pack, /reportEndpoint: RECEIVER, countEndpoint: RECEIVER/);
  const keep = { r: process.env.RR_REPORT_ENDPOINT, c: process.env.RR_COUNT_ENDPOINT };
  delete process.env.RR_REPORT_ENDPOINT; delete process.env.RR_COUNT_ENDPOINT;
  try {
    assert.equal(out.endpoint('report', pkg), '');
    assert.equal(out.endpoint('count', pkg), '');
    assert.equal(out.endpoint('report', { reportEndpoint: 'not an address' }), '');
    assert.equal(out.endpoint('report', { reportEndpoint: 'https://r.example.workers.dev' }), 'https://r.example.workers.dev');
  } finally { if (keep.r !== undefined) process.env.RR_REPORT_ENDPOINT = keep.r; if (keep.c !== undefined) process.env.RR_COUNT_ENDPOINT = keep.c; }
});

test('a report is posted to /report, marked as Rev Radar\'s', () => {
  for (const e of ['https://r.example.workers.dev', 'https://r.example.workers.dev/', 'https://r.example.workers.dev/report']) {
    const r = out.reportRequest(e, { kind: 'problem', app: 'Rev Radar' });
    assert.equal(r.url, 'https://r.example.workers.dev/report');
    assert.equal(r.init.method, 'POST');
    assert.equal(r.init.headers['x-report-client'], 'rev-radar');
    assert.equal(JSON.parse(r.init.body).app, 'Rev Radar');
  }
});

/** a local receiver: what reaches it */
async function receiver() {
  const got: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { got.push({ url: req.url || '', headers: req.headers, body: b }); res.writeHead(200); res.end('ok'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { got, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((r) => server.close(r)) };
}
const worker = (args: string[]) => new Promise<number>((res) => { const p = spawn(process.execPath, ['electron/update-worker.cjs', ...args], { stdio: 'ignore' }); p.on('exit', (c) => res(c ?? 1)); });

test('the update worker posts the queue anonymised: problem reports, crash reports only from when they were turned on', async () => {
  const rx = await receiver();
  const q = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-outbox-'));
  try {
    const me = os.userInfo().username;
    const base = { app: 'Rev Radar', version: '0.5.0', runtime: '44.9.3', windows: '10.0.22631', arch: 'x64', memoryMB: { total: 16000, free: 4000 } };
    fs.writeFileSync(path.join(q, 'a_problem.json'), JSON.stringify({ kind: 'problem', ...base, time: new Date().toISOString(), text: 'The BOQ tab froze', log: `opened C:\\Users\\${me}\\Bids\\Tower B BOQ.xlsx: 3 sheets` }));
    fs.writeFileSync(path.join(q, 'b_crash_old.json'), JSON.stringify({ kind: 'crash', ...base, time: '2026-01-01T10:00:00Z', where: 'main', message: 'x' }));
    // crash reports not turned on (since = 0): only the problem report goes
    assert.equal(await worker(['post', rx.url, q, '0']), 0);
    assert.equal(rx.got.length, 1);
    const r = rx.got[0];
    assert.equal(r.url, '/report');
    assert.equal(r.headers['x-report-client'], 'rev-radar');
    const body = JSON.parse(r.body);
    assert.equal(body.app, 'Rev Radar');
    assert.equal(body.kind, 'problem');
    assert.equal(body.text, 'The BOQ tab froze');
    for (const bad of ['Tower B', 'Bids', 'BOQ.xlsx', ...(me.length >= 3 ? [me] : [])]) assert.ok(!r.body.includes(bad), bad + ' left in');
    assert.ok(!('user' in body) && !('pc' in body));
    // turned on after that crash: it is still never sent
    rx.got.length = 0;
    assert.equal(await worker(['post', rx.url, q, String(Date.parse('2026-06-01T00:00:00Z'))]), 0);
    assert.ok(!rx.got.some((g) => JSON.parse(g.body).kind === 'crash'), 'a crash from before the switch was turned on');
  } finally { fs.rmSync(q, { recursive: true, force: true }); await rx.close(); }
});

test('the user count\'s ping: POST /count, marked rev-radar, exactly three things', () => {
  for (const e of ['https://r.example.workers.dev', 'https://r.example.workers.dev/count']) {
    const r = out.countRequest(e, { id: 'a'.repeat(32), version: '0.5.0', os: 'Windows', extra: 'never' });
    assert.equal(r.url, 'https://r.example.workers.dev/count');
    assert.equal(r.init.method, 'POST');
    assert.equal(r.init.headers['x-report-client'], 'rev-radar');
    // (the receiver's shape, 17 Nov: exactly {"id":"<32 lowercase hex>","v":"d.d.d","os":"win|linux|mac"}, 200 bytes at most)
    assert.equal(r.init.body, '{"id":"' + 'a'.repeat(32) + '","v":"0.5.0","os":"win"}');
    assert.ok(Buffer.byteLength(r.init.body) <= 200);
    assert.equal(JSON.parse(out.countRequest(e, { id: 'B'.repeat(32), version: '0.5.0', os: 'Linux' }).init.body).os, 'linux');
    assert.equal(JSON.parse(out.countRequest(e, { id: 'B'.repeat(32), version: '0.5.0', os: 'Linux' }).init.body).id, 'b'.repeat(32));
  }
});

test('the update worker sends the ping; no internet = it just ends', async () => {
  const rx = await receiver();
  try {
    assert.equal(await worker(['count', rx.url, 'b'.repeat(32), '0.5.0', 'Linux']), 0);
    assert.equal(rx.got.length, 1);
    assert.equal(rx.got[0].url, '/count');
    assert.equal(rx.got[0].headers['x-report-client'], 'rev-radar');
    assert.deepEqual(JSON.parse(rx.got[0].body), { id: 'b'.repeat(32), v: '0.5.0', os: 'linux' });
  } finally { await rx.close(); }
  const t = Date.now();
  assert.equal(await worker(['count', 'http://127.0.0.1:9', 'b'.repeat(32), '0.5.0', 'Linux']), 0);
  assert.ok(Date.now() - t < 10000);
});
