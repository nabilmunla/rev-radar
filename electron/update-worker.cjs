// Updates: the parts that touch the network (GitHub's releases - feed.cjs) or unpack a download run
// here, in a process of their own that only lives for the one job. A connection that hangs (no
// internet, a proxy that doesn't answer) can only stall this process - the app stops it after a
// time limit and carries on.
//   check <web address | folder>                    -> { ok, latest } | { ok: false, reach, err }
//   copy <url | file> <dst> <size>                  -> { progress } ..., { done, sha } | { ok: false, err }
//   install <zip> <store> <version> <runtime> <sha> -> { ok, dir } | { ok: false, err }
//   post <endpoint> <queue> <crashesSince> [<words file>] -> { sent: [names] } per report, then { ok, done }:
//                                     reports sent anonymously to the report receiver (outbound.cjs) -
//                                     problem reports always, crash reports made from <crashesSince>
//                                     (ms) on (0 = none)
//   count <endpoint> <id> <version> <os>            -> { ok, status } | { ok: false, err }: the user count's
//                                     once-a-day ping (counter.cjs; its shape: outbound.cjs countRequest)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const V = require('./versions.cjs');
const feed = require('./feed.cjs');

const port = process.parentPort;
const send = (m) => { try { port.postMessage(m); } catch (_) { /* parent gone */ } };
const [cmd, a, b, c, d, e] = process.argv.slice(2);
const done = (code) => setTimeout(() => process.exit(code), 50);

function check(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return send({ ok: false, reach: 'notdir', err: 'not a folder' });
  } catch (err) {
    return send({ ok: false, reach: 'unreachable', err: err.code || String(err.message || err) });
  }
  let txt;
  try {
    txt = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8');
  } catch (err) {
    return send({ ok: false, reach: err.code === 'ENOENT' ? 'empty' : 'unreachable', err: err.code || String(err.message || err) });
  }
  try {
    const latest = JSON.parse(txt.replace(/^\uFEFF/, ''));
    // (the signed part names the packages the app goes by: whether they are there, checked too)
    let signed = null;
    try { signed = typeof latest.signed === 'string' ? JSON.parse(latest.signed) : null; } catch (_) { signed = null; }
    const present = {};
    for (const k of ['app', 'setup']) {
      const p = signed && signed[k];
      if (p && p.file) { let st = null; try { st = fs.statSync(path.join(dir, path.basename(String(p.file)))); } catch (_) { /* not there */ } present[k] = !!st && st.isFile() && (!p.size || st.size === Number(p.size)); }
    }
    latest.signedPresent = present;
    // the package must be there too, and whole (someone may have copied latest.json first, or the
    // package is still being copied onto the share)
    for (const k of ['app', 'setup']) {
      const f = latest && latest[k] && latest[k].file;
      if (f) { let st = null; try { st = fs.statSync(path.join(dir, path.basename(String(f)))); } catch (_) { /* not there */ } latest[k].present = !!st && st.isFile() && (!latest[k].size || st.size === Number(latest[k].size)); }
    }
    // the setup for a new runtime (named, or the usual name): only a .exe counts
    const sf = path.basename(String((latest && latest.setup && latest.setup.file) || ('Rev-Radar-Setup-' + (latest && latest.version) + '.exe')));
    let sst = null; if (/\.exe$/i.test(sf)) { try { sst = fs.statSync(path.join(dir, sf)); } catch (_) { /* not there */ } }
    if (latest && typeof latest === 'object') latest.setupFound = sst && sst.isFile() ? sf : '';
    send({ ok: true, latest });
  } catch (err) {
    send({ ok: false, reach: 'bad', err: 'latest.json is not valid: ' + (err.message || err) });
  }
}

function copy(src, dst, size) {
  const total = Number(size) || 0;
  let n = 0, last = 0;
  const hash = crypto.createHash('sha256');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const r = fs.createReadStream(src, { highWaterMark: 1 << 20 });
  const w = fs.createWriteStream(dst);
  const fail = (err) => { send({ ok: false, err: err.code || String(err.message || err) }); try { w.destroy(); } catch (_) { /* */ } done(1); };
  r.on('error', fail);
  w.on('error', fail);
  r.on('data', (chunk) => {
    hash.update(chunk);
    n += chunk.length;
    const now = Date.now();
    if (now - last > 200) { last = now; send({ progress: n, total }); }
  });
  w.on('finish', () => {
    send({ progress: n, total });
    send({ done: true, bytes: n, sha: hash.digest('hex') });
    done(0);
  });
  r.pipe(w);
}

// ---------------------------------------------------------------- the web (GitHub releases)
// Electron's own network stack where this process has it (the PC's proxy settings), else Node's
function get(url) {
  let f = null;
  try { const { net } = require('electron'); if (net && typeof net.fetch === 'function') f = (u) => net.fetch(u, { redirect: 'follow', cache: 'no-store' }); } catch (_) { /* not here */ }
  if (!f) f = (u) => fetch(u, { redirect: 'follow', cache: 'no-store', headers: { 'User-Agent': 'Rev Radar updates' } });
  return f(url);
}
async function checkWeb(src) {
  let res;
  try { res = await get(feed.latestUrl(src)); } catch (err) { return send({ ok: false, reach: 'unreachable', err: String((err && (err.code || err.message)) || err) }); }
  // (no release yet - or none with a latest.json)
  if (res.status === 404) return send({ ok: false, reach: 'empty', err: 'HTTP 404' });
  if (!res.ok) return send({ ok: false, reach: 'unreachable', err: 'HTTP ' + res.status });
  try {
    const txt = await res.text();
    if (txt.length > 1 << 20) throw new Error('too long');
    send({ ok: true, latest: JSON.parse(txt.replace(/^\uFEFF/, '')) });
  } catch (err) {
    send({ ok: false, reach: 'bad', err: 'latest.json is not valid: ' + (err.message || err) });
  }
}
async function copyWeb(url, dst, size) {
  const total = Number(size) || 0;
  let n = 0, last = 0;
  const hash = crypto.createHash('sha256');
  const fail = (err) => { send({ ok: false, err }); done(1); };
  let res;
  try { res = await get(url); } catch (err) { return fail(String((err && (err.code || err.message)) || err)); }
  if (res.status === 404) return fail('ENOENT');
  if (!res.ok || !res.body) return fail('HTTP ' + res.status);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const w = fs.createWriteStream(dst);
  let failed = false;
  w.on('error', (err) => { failed = true; fail(err.code || String(err.message || err)); });
  try {
    const rd = res.body.getReader();
    for (;;) {
      const { done: end, value } = await rd.read();
      if (end || failed) break;
      const chunk = Buffer.from(value);
      n += chunk.length;
      // (more than latest.json said: not the file it signed - stopped)
      if (total && n > total) { try { rd.cancel(); } catch (_) { /* */ } w.destroy(); return fail('bigger than announced'); }
      hash.update(chunk);
      if (!w.write(chunk)) await new Promise((r) => w.once('drain', r));
      const now = Date.now();
      if (now - last > 200) { last = now; send({ progress: n, total }); }
    }
  } catch (err) { w.destroy(); return fail(String((err && (err.code || err.message)) || err)); }
  if (failed) return;
  w.end(() => {
    send({ progress: n, total });
    send({ done: true, bytes: n, sha: hash.digest('hex') });
    done(0);
  });
}

// ---------------------------------------------------------------- anonymous reports (reports.cjs)
async function post(endpoint, queue, since, wordsFile) {
  const anon = require('./anon.cjs');
  const out = require('./outbound.cjs');
  const os = require('os');
  let who = { user: '', pc: '' };
  try { who = { user: os.userInfo().username, pc: os.hostname() }; } catch (_) { /* no names to take out */ }
  // (names known to be private on this PC - the recent comparisons' files and folders: reports.cjs)
  try { if (wordsFile) who.words = JSON.parse(fs.readFileSync(wordsFile, 'utf8')); } catch (_) { /* none */ }
  const from = Number(since) || 0;
  const sentAll = [];
  let names = [];
  try { names = fs.readdirSync(queue).filter((n) => n.endsWith('.json')).sort(); } catch (err) { return send({ ok: false, err: err.code || String(err.message || err), done: sentAll }); }
  const go = out.fetcher();
  for (const n of names) {
    let rep;
    try { rep = JSON.parse(fs.readFileSync(path.join(queue, n), 'utf8')); } catch (_) { continue; }
    // crash reports only with the person's say-so, and only those made since they said so
    if (rep.kind !== 'problem' && !(from && Date.parse(rep.time) >= from)) continue;
    const req = out.reportRequest(endpoint, anon.anonymize(rep, who));
    let res;
    try { res = await go(req.url, req.init); } catch (err) { return send({ ok: false, err: String((err && (err.code || err.message)) || err), done: sentAll }); }
    // (refused for good - too big, not a report: dropped, or it would block the queue forever)
    if (!res.ok && res.status !== 400 && res.status !== 413) return send({ ok: false, err: 'HTTP ' + res.status, done: sentAll });
    sentAll.push(n);
    send({ sent: [n] });
  }
  send({ ok: true, done: sentAll });
}

// ---------------------------------------------------------------- the user count (counter.cjs)
async function count(endpoint, id, version, osName) {
  const out = require('./outbound.cjs');
  const req = out.countRequest(endpoint, { id, version, os: osName });
  try {
    const res = await out.fetcher()(req.url, req.init);
    send(res.ok ? { ok: true, status: res.status } : { ok: false, err: 'HTTP ' + res.status });
  } catch (err) { send({ ok: false, err: String((err && (err.code || err.message)) || err) }); }
}

function install(zip, store, version, runtime, sha) {
  try {
    const dir = V.installPackage(zip, store, version, runtime, sha);
    send({ ok: true, dir });
  } catch (err) {
    send({ ok: false, err: String(err.message || err) });
  }
}

if (cmd === 'post') post(a, b, c, d).finally(() => done(0));
else if (cmd === 'count') count(a, b, c, d).finally(() => done(0));
else if (cmd === 'check' && feed.isWeb(a)) checkWeb(a).finally(() => done(0));
else if (cmd === 'check') { check(a); done(0); }
else if (cmd === 'copy' && feed.isWeb(a)) copyWeb(a, b, c);
else if (cmd === 'copy') copy(a, b, c);
else if (cmd === 'install') { install(a, b, c, d, e); done(0); }
else { send({ ok: false, err: 'unknown command' }); done(2); }
