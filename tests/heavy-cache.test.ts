// RR-037: a record of merged pages whose delta is gone is not trusted; a merge that fails is not written down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const base0 = os.tmpdir();

test('a merged record without its delta is thrown away; a failed merge leaves no record', async () => {
  const tmp = fs.mkdtempSync(path.join(base0, 'rr-heavy-'));
  process.env.TMPDIR = tmp; process.env.TEMP = tmp; process.env.TMP = tmp;
  const { readable, heavyDir } = await import('../src/engine/heavy');
  assert.ok(heavyDir().startsWith(tmp), heavyDir());
  const f = path.join(tmp, 'big.pdf');
  fs.writeFileSync(f, Buffer.alloc(10_500_000, 32)); // (not a PDF: the merge fails)
  const st = fs.statSync(f);
  const key = crypto.createHash('sha1').update(`2|${f.toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 24);
  fs.mkdirSync(heavyDir(), { recursive: true });
  const info = path.join(heavyDir(), key + '.json');
  fs.writeFileSync(info, JSON.stringify({ merged: 2, base: st.size, deltaSize: 1234 }));
  const r = await readable(f);
  assert.deepEqual(r, { path: f });
  assert.equal(fs.existsSync(info), false, 'the stale record is gone, and the failed merge wrote none');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a stale record that cannot be removed does not spin the engine: read as it is', async () => {
  const tmp = fs.mkdtempSync(path.join(base0, 'rr-heavy2-'));
  process.env.TMPDIR = tmp; process.env.TEMP = tmp; process.env.TMP = tmp;
  const { readable, heavyDir } = await import('../src/engine/heavy');
  const f = path.join(tmp, 'big2.pdf');
  fs.writeFileSync(f, Buffer.alloc(10_400_000, 32));
  const st = fs.statSync(f);
  const key = crypto.createHash('sha1').update(`2|${f.toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 24);
  fs.mkdirSync(heavyDir(), { recursive: true });
  const info = path.join(heavyDir(), key + '.json');
  fs.writeFileSync(info, JSON.stringify({ merged: 1, base: st.size, deltaSize: 99 }));
  const rm = fs.rmSync;
  (fs as { rmSync: typeof fs.rmSync }).rmSync = ((p: fs.PathLike, o?: fs.RmOptions) => { if (String(p) === info) { const e = new Error('busy') as NodeJS.ErrnoException; e.code = 'EBUSY'; throw e; } return rm(p, o); }) as typeof fs.rmSync;
  try {
    const t = Date.now();
    const r = await readable(f);
    assert.deepEqual(r, { path: f });
    assert.ok(Date.now() - t < 2000, `${Date.now() - t} ms`);
  } finally { (fs as { rmSync: typeof fs.rmSync }).rmSync = rm; }
  fs.rmSync(tmp, { recursive: true, force: true });
});
