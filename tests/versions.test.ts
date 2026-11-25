// The app's own updates (electron/versions.cjs): which copy runs, set-aside copies, unpacking a
// download, tidying the store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { zipSync, strToU8 } from 'fflate';

const require = createRequire(import.meta.url);
const V = require('../electron/versions.cjs');
const RT = '44.9.3';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rr-versions-')); }
function appFiles(ver: string): Record<string, Uint8Array> {
  return { 'package.json': strToU8(JSON.stringify({ version: ver, main: 'electron/boot.cjs' })), 'electron/main.cjs': strToU8('// main ' + ver), 'dist/index.html': strToU8('<html>' + ver) };
}
function builtin(root: string, ver: string) {
  const d = path.join(root, 'resources', 'app');
  for (const [n, b] of Object.entries(appFiles(ver))) { fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true }); fs.writeFileSync(path.join(d, n), b); }
  return d;
}
function zipOf(dir: string, ver: string, extra: Record<string, Uint8Array> = {}, level: 0 | 6 = 6) {
  const p = path.join(dir, `app-v${ver}.zip`);
  fs.writeFileSync(p, zipSync({ ...appFiles(ver), ...extra }, { level }));
  return p;
}

test('the newest good copy runs; the setup copy wins a tie; another runtime or an unfinished copy never runs', () => {
  const root = tmp(), store = path.join(root, 'store');
  const b = builtin(root, '0.3.0');
  assert.equal(V.choose(b, store, RT).version, '0.3.0');
  V.installPackage(zipOf(root, '0.3.1'), store, '0.3.1', RT, 'x');
  assert.equal(V.choose(b, store, RT).version, '0.3.1');
  assert.equal(V.choose(b, store, RT).builtin, false);
  // made for another Electron: not this runtime's
  V.installPackage(zipOf(root, '0.3.2'), store, '0.3.2', '45.0.0', 'x');
  assert.equal(V.choose(b, store, RT).version, '0.3.1');
  // unpacked but never finished (no ready.json)
  fs.mkdirSync(path.join(store, '0.3.3', 'electron'), { recursive: true });
  fs.writeFileSync(path.join(store, '0.3.3', 'package.json'), JSON.stringify({ version: '0.3.3' }));
  fs.writeFileSync(path.join(store, '0.3.3', 'electron', 'main.cjs'), '');
  assert.equal(V.choose(b, store, RT).version, '0.3.1');
  // a setup that brings the same version: its own copy runs
  const b2 = builtin(path.join(root, 'b2'), '0.3.1');
  assert.equal(V.choose(b2, store, RT).builtin, true);
});

test('going back pins a copy; a pinned copy that is gone is ignored', () => {
  const root = tmp(), store = path.join(root, 'store');
  const b = builtin(root, '0.3.0');
  V.installPackage(zipOf(root, '0.3.1'), store, '0.3.1', RT, 'x');
  V.pin(store, '0.3.0');
  assert.equal(V.choose(b, store, RT).version, '0.3.0');
  V.pin(store, '0.2.9');
  assert.equal(V.choose(b, store, RT).version, '0.3.1');
  V.pin(store, '');
  assert.equal(V.pinned(store), '');
});

test('a copy whose window never came up twice is set aside, and the one before runs', () => {
  const root = tmp(), store = path.join(root, 'store');
  const b = builtin(root, '0.3.0');
  const d = V.installPackage(zipOf(root, '0.3.1'), store, '0.3.1', RT, 'x');
  assert.equal(V.beginStart(d), true); // 1st start, no window
  assert.equal(V.beginStart(d), true); // 2nd
  assert.equal(V.beginStart(d), false); // 3rd: set aside
  assert.ok(fs.existsSync(path.join(d, 'bad.json')));
  assert.equal(V.choose(b, store, RT).version, '0.3.0');
  // a start that got its window clears the count
  const d2 = V.installPackage(zipOf(root, '0.3.2'), store, '0.3.2', RT, 'x');
  V.beginStart(d2); V.startedOk(d2); V.beginStart(d2); V.startedOk(d2); V.beginStart(d2);
  assert.equal(V.beginStart(d2), true);
});

test('unpacking: deflated and stored entries; paths outside refused; wrong version or missing files leave nothing', () => {
  const root = tmp(), store = path.join(root, 'store');
  const d = V.installPackage(zipOf(root, '0.4.0', { 'dist/assets/a.bin': new Uint8Array(70000).map((_, i) => i % 251) }, 0), store, '0.4.0', RT, 'x');
  assert.equal(fs.readFileSync(path.join(d, 'dist', 'assets', 'a.bin')).length, 70000);
  assert.equal(fs.readFileSync(path.join(d, 'dist', 'index.html'), 'utf8'), '<html>0.4.0');
  assert.equal(V.readJson(path.join(d, 'ready.json')).runtime, RT);
  // a package that says another version
  const wrong = zipOf(root, '0.4.1');
  assert.throws(() => V.installPackage(wrong, store, '0.4.2', RT, 'x'), /holds version 0.4.1/);
  assert.ok(!fs.readdirSync(store).some((n) => n.startsWith('0.4.2')));
  // a path that climbs out
  const evil = path.join(root, 'evil.zip');
  fs.writeFileSync(evil, zipSync({ ...appFiles('0.4.3'), '../../outside.txt': strToU8('x') }));
  assert.throws(() => V.installPackage(evil, store, '0.4.3', RT, 'x'), /bad path/);
  assert.ok(!fs.existsSync(path.join(root, 'outside.txt')));
  // not a zip at all
  const junk = path.join(root, 'junk.zip');
  fs.writeFileSync(junk, 'not a zip');
  assert.throws(() => V.installPackage(junk, store, '0.4.4', RT, 'x'));
  assert.ok(!fs.readdirSync(store).some((n) => n.includes('part')));
});

test('tidy keeps the running copy, the one to go back to, the pinned one and newer ones', () => {
  const root = tmp(), store = path.join(root, 'store');
  for (const v of ['0.3.0', '0.3.1', '0.3.2', '0.3.3', '0.3.5']) V.installPackage(zipOf(root, v), store, v, RT, 'x');
  V.setAside(path.join(store, '0.3.2'), 'test');
  fs.mkdirSync(path.join(store, '0.3.4.part-123'));
  fs.mkdirSync(path.join(store, 'downloads'));
  fs.writeFileSync(path.join(store, 'downloads', 'app-v0.3.3.zip'), 'x');
  fs.writeFileSync(path.join(store, 'downloads', 'app-v0.3.9.zip.part'), 'x');
  V.pin(store, '0.3.0');
  V.tidy(store, '0.3.3');
  const left = fs.readdirSync(store).filter((n) => /^\d/.test(n)).sort();
  // 0.3.3 running, 0.3.1 newest good older (0.3.2 was set aside), 0.3.0 pinned, 0.3.5 newer
  assert.deepEqual(left, ['0.3.0', '0.3.1', '0.3.3', '0.3.5']);
  assert.deepEqual(fs.readdirSync(path.join(store, 'downloads')), []);
});

test("a package never brings the store's own marks; duplicate names and oversized entries are refused", () => {
  const root = tmp(), store = path.join(root, 'store');
  const z = zipOf(root, '0.4.0', { 'bad.json': strToU8('{"why":"planted"}'), 'starts.json': strToU8('{"n":9}') });
  V.installPackage(z, store, '0.4.0', RT, 'x');
  assert.ok(!fs.existsSync(path.join(store, '0.4.0', 'bad.json')) && !fs.existsSync(path.join(store, '0.4.0', 'starts.json')));
  assert.equal(V.choose(builtin(root, '0.3.0'), store, RT).version, '0.4.0');
  // the same name twice (a crafted zip): fflate can't write that, so the central directory is doubled by hand
  const one = Buffer.from(zipSync({ 'a.txt': strToU8('x') }, { level: 0 }));
  const eocd = one.length - 22, cdOff = one.readUInt32LE(eocd + 16), cdLen = one.readUInt32LE(eocd + 12);
  const cd = one.subarray(cdOff, cdOff + cdLen);
  const tail = Buffer.from(one.subarray(eocd));
  tail.writeUInt16LE(2, 8); tail.writeUInt16LE(2, 10); tail.writeUInt32LE(cdLen * 2, 12);
  const dup = path.join(root, 'dup.zip');
  fs.writeFileSync(dup, Buffer.concat([one.subarray(0, cdOff), cd, cd, tail]));
  assert.throws(() => V.unzip(dup, path.join(root, 'dupout')), /twice/);
  // an entry that inflates to more than it says: stopped at its stated size
  const big = Buffer.from(zipSync({ 'big.bin': new Uint8Array(4 << 20) }, { level: 6 }));
  const bcd = big.readUInt32LE(big.length - 22 + 16);
  big.writeUInt32LE(1000, bcd + 24); // stated size 1000 bytes
  const bz = path.join(root, 'big.zip');
  fs.writeFileSync(bz, big);
  assert.throws(() => V.unzip(bz, path.join(root, 'bigout')));
});

test('after the setup ran, what it installed runs: the old choice and newer downloads go - once', () => {
  const root = tmp(), store = path.join(root, 'store'), inst = path.join(root, 'inst');
  const b = builtin(root, '0.3.0');
  fs.mkdirSync(inst, { recursive: true });
  V.installPackage(zipOf(root, '0.3.1'), store, '0.3.1', RT, 'x');
  V.installPackage(zipOf(root, '0.2.9'), store, '0.2.9', RT, 'x');
  V.pin(store, '0.3.1');
  assert.equal(V.setupRan(store, inst, '0.3.0'), '', 'no install.json (a portable copy): nothing happens');
  fs.writeFileSync(path.join(inst, 'install.json'), JSON.stringify({ version: '0.3.0', installed: 'T1' }));
  assert.match(V.setupRan(store, inst, '0.3.0'), /removed 0\.3\.1/);
  assert.equal(V.pinned(store), '');
  assert.ok(fs.existsSync(path.join(store, '0.2.9')), 'older copies are left to tidy');
  assert.equal(V.choose(b, store, RT).version, '0.3.0');
  V.installPackage(zipOf(root, '0.3.2'), store, '0.3.2', RT, 'x');
  assert.equal(V.setupRan(store, inst, '0.3.0'), '', 'the same install is not new again');
  assert.equal(V.choose(b, store, RT).version, '0.3.2');
});

test('a copy offered twice in one start is not taken: a store that cannot be written ends on the installed copy (bug 26)', () => {
  const root = tmp(), store = path.join(root, 'store');
  const b = builtin(root, '0.3.0');
  const d = V.installPackage(zipOf(root, '0.3.1'), store, '0.3.1', RT, 'x');
  fs.writeFileSync(path.join(d, 'starts.json'), JSON.stringify({ n: 2, at: 1 }));
  const log: string[] = [];
  // 1. the function itself, the write failure stubbed: choose() keeps returning the same folder
  let calls = 0;
  const r = V.pickStart(() => { if (++calls > 50) throw new Error('spins'); return V.choose(b, store, RT); }, () => false, (l: string) => log.push(l));
  assert.equal(r.pick, null, 'the installed copy runs');
  assert.equal(log.filter((l) => l.startsWith('set aside')).length, 1, 'one log line');
  assert.ok(calls <= 3, 'ended: ' + calls);
  // 2. the real functions on a store that cannot be written: bad.json's temp file cannot be created
  //    (a directory sits in its place - works for root too, where chmod 0o555 would not stop the write)
  fs.mkdirSync(path.join(d, `bad.json.${process.pid}.tmp`));
  const log2: string[] = [];
  let n = 0;
  const r2 = V.pickStart(() => { if (++n > 50) throw new Error('spins'); return V.choose(b, store, RT); }, V.beginStart, (l: string) => log2.push(l));
  assert.equal(r2.pick, null);
  assert.equal(log2.filter((l) => l.startsWith('set aside')).length, 1);
  assert.ok(!fs.existsSync(path.join(d, 'bad.json')), 'it really could not be written');
  fs.rmSync(path.join(d, `bad.json.${process.pid}.tmp`), { recursive: true });
  // 3. a copy that can be counted still runs, with what starts.json held
  const d2 = V.installPackage(zipOf(root, '0.3.2'), store, '0.3.2', RT, 'x');
  const ok = V.pickStart(() => V.choose(b, store, RT), V.beginStart, () => {});
  assert.equal(ok.pick.version, '0.3.2');
  assert.equal(ok.before, null);
  assert.deepEqual(V.readJson(path.join(d2, 'starts.json')).n, 1);
});
