// Problem and crash reports (the PDF Editor's, for Rev Radar). Each report is one file in a queue on
// this PC (<settings folder>\reports-outbox). With a report receiver (package.json "reportEndpoint")
// it is sent anonymously (anon.cjs: no user or PC name, paths cut to file names... and those taken
// out too) from the update worker's process (own process, time limit - no internet just leaves it
// waiting): a problem report when the person presses Send, crash reports only once they have turned
// that on in Settings > Help (and only those made from then on). No receiver (this build): nothing
// leaves the PC - "Report a problem" keeps the report in the queue and says so; crash reports are not
// kept at all. Never a drawing, BOQ or document, and no picture of the screen (it would show them).
'use strict';
const { app, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const JOB_TIMEOUT = Number(process.env.RR_REPORT_TIMEOUT) || 20000;
const MAX_AUTO_PER_DAY = 10;
const MAX_QUEUE = 60;

function create({ version, readSettings, writeSettings, log, logFile, appName, send, endpoint = '' }) {
  const queueDir = () => path.join(app.getPath('userData'), 'reports-outbox');
  let flushing = null;
  let last = { state: 'idle', err: '', at: 0, sent: 0 };

  function logTail(lines = 160) {
    try { return fs.readFileSync(logFile(), 'utf8').split('\n').slice(-lines).join('\n'); } catch (_) { return ''; }
  }
  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  /** what a report says about the app and the PC (no user or PC name - not even in the queue) */
  function base() {
    return {
      app: appName,
      version,
      runtime: process.versions.electron,
      windows: os.platform() === 'win32' ? os.release() : os.platform() + ' ' + os.release(),
      arch: os.arch(),
      memoryMB: { total: Math.round(os.totalmem() / 2 ** 20), free: Math.round(os.freemem() / 2 ** 20) },
      uptimeMin: Math.round(process.uptime() / 60),
      time: new Date().toISOString(),
    };
  }

  async function queue(kind, body) {
    const dir = queueDir();
    await fsp.mkdir(dir, { recursive: true });
    const name = `${stamp()}_${kind}_${version}_${Math.random().toString(36).slice(2, 7)}`;
    const rep = { kind, ...base(), ...body, log: logTail() };
    await fsp.writeFile(path.join(dir, name + '.json.part'), JSON.stringify(rep, null, 2));
    await fsp.rename(path.join(dir, name + '.json.part'), path.join(dir, name + '.json'));
    // keep the queue bounded (a PC that never reaches the internet, or no receiver)
    const all = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    for (const n of all.slice(0, Math.max(0, all.length - MAX_QUEUE))) await fsp.rm(path.join(dir, n), { force: true });
    return name;
  }

  /** an automatic report: only with a receiver and the person's say-so; once per kind of failure a day, at most 10 a day */
  function crash(where, err) {
    try {
      if (!endpoint || !readSettings().anonCrashReports) return;
      const msg = String((err && err.message) || err || 'unknown');
      const stack = String((err && err.stack) || '');
      if (/ResizeObserver loop/.test(msg)) return;
      // (engines 1-4 going down together are one kind of failure, not four)
      const key = String(where).replace(/\d+$/, '#') + '|' + msg.slice(0, 120) + '|' + (stack.split('\n')[1] || '').trim().slice(0, 120);
      const s = readSettings();
      const day = new Date().toISOString().slice(0, 10);
      const lim = s.reportLimits && s.reportLimits.day === day ? s.reportLimits : { day, count: 0, keys: [] };
      if (lim.keys.includes(key) || lim.count >= MAX_AUTO_PER_DAY) return;
      lim.count++;
      lim.keys = [...lim.keys, key].slice(-50);
      writeSettings({ ...readSettings(), reportLimits: lim });
      void queue('crash', { where: String(where), message: msg, stack }).then(() => scheduleFlush(3000)).catch((e) => log('report: ' + e));
    } catch (e) { log('report failed: ' + e); }
  }

  /** "Report a problem": the person's words; sent at once when there is a receiver */
  async function problem(text, extra) {
    const name = await queue('problem', { text: String(text || '').slice(0, 20000), ...(extra || {}) });
    if (!endpoint) return { ...(await status()), state: 'local' };
    let r = await flush();
    // (a send already under way listed the queue before this report was in it: once more)
    if (fs.existsSync(path.join(queueDir(), name + '.json'))) r = await flush();
    return { ...r, state: fs.existsSync(path.join(queueDir(), name + '.json')) ? 'failed' : 'sent' };
  }

  function runJob(args) {
    return new Promise((resolve) => {
      let proc;
      try { proc = utilityProcess.fork(path.join(__dirname, 'update-worker.cjs'), args, { serviceName: appName + ' reports', stdio: 'ignore' }); }
      catch (e) { resolve({ ok: false, err: String(e.message || e), done: [] }); return; }
      let result = null, fin = false, t = null;
      // (reports sent one by one: each that got there counts, even if a later one runs out of time;
      // the time limit is per report, not for the whole queue)
      const sent = [];
      const arm = () => { clearTimeout(t); t = setTimeout(() => finish({ ok: false, err: 'timeout', done: [] }), JOB_TIMEOUT); };
      arm();
      function finish(r) { if (fin) return; fin = true; clearTimeout(t); try { proc.kill(); } catch (_) { /* gone */ } resolve({ ...r, done: [...new Set([...sent, ...(r.done || [])])] }); }
      proc.on('message', (m) => { if (m && Array.isArray(m.sent)) { sent.push(...m.sent); arm(); return; } result = m; if (m && m.ok !== undefined) finish(m); });
      proc.on('exit', () => finish(result || { ok: false, err: 'stopped', done: [] }));
    });
  }

  async function waiting() {
    try { return (await fsp.readdir(queueDir())).filter((n) => n.endsWith('.json')).length; } catch (_) { return 0; }
  }

  /** send what waits (receiver only); whatever got there leaves the queue */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      if (!endpoint) { last = { ...last, state: 'local' }; return status(); }
      const s = readSettings();
      // (crash reports the person hasn't agreed to send are never sent - they don't wait here either)
      const since = s.anonCrashReports ? Number(s.anonCrashSince) || 0 : 0;
      await dropUnsendable(since);
      if (!(await waiting())) { last = { ...last, state: 'idle' }; return status(); }
      // (the names file is only for that one job: removed when it is over, sent or not)
      const words = await wordsFile();
      let r;
      try { r = await runJob(['post', endpoint, queueDir(), String(since), words]); } finally { if (words) await fsp.rm(words, { force: true }).catch(() => {}); }
      for (const f of r.done || []) await fsp.rm(path.join(queueDir(), f), { force: true }).catch(() => {});
      const sent = (r.done || []).filter((f) => f.endsWith('.json')).length;
      last = { state: r.ok ? 'sent' : 'failed', err: r.ok ? '' : r.err || 'unknown', at: Date.now(), sent };
      if (!r.ok) log('reports: not sent (' + r.err + '), ' + (await waiting()) + ' waiting');
      return status();
    })().finally(() => { flushing = null; send('reports:state', null); });
    return flushing;
  }
  let timer = null;
  function scheduleFlush(ms) { if (!endpoint) return; clearTimeout(timer); timer = setTimeout(() => void flush().catch(() => {}), ms); }

  async function status() {
    const anon = !!endpoint;
    return { waiting: await waiting(), queue: queueDir(), ...last, state: anon ? last.state : 'local', anon, crashes: anon && !!readSettings().anonCrashReports };
  }

  /** crash reports that will never be sent (none agreed to, or made before) go */
  async function dropUnsendable(since) {
    let names = [];
    try { names = (await fsp.readdir(queueDir())).filter((n) => n.endsWith('.json')); } catch (_) { return; }
    for (const n of names) {
      let rep = null;
      try { rep = JSON.parse(await fsp.readFile(path.join(queueDir(), n), 'utf8')); } catch (_) { continue; }
      if (rep && rep.kind !== 'problem' && !(since && Date.parse(rep.time) >= since)) await fsp.rm(path.join(queueDir(), n), { force: true }).catch(() => {});
    }
  }
  /** names this PC knows are private (the recent comparisons: file names and folders), for anon.cjs
   *  to take out whole - a name with spaces can't be told from the words around it otherwise */
  async function wordsFile() {
    const words = new Set();
    try {
      const s = readSettings();
      for (const key of ['recent', 'recentBoq', 'recentDocs']) {
        for (const r of Array.isArray(s[key]) ? s[key] : []) {
          if (!r || typeof r !== 'object') continue;
          if (typeof r.label === 'string') for (const part of r.label.split(/\s*(?:→|->)\s*|[\\/]+/)) if (part.length >= 4) words.add(part);
          for (const side of [r.old, r.neu]) {
            for (const p of (side && Array.isArray(side.paths) ? side.paths : [])) {
              if (typeof p !== 'string' || !p) continue;
              const b = path.win32.basename(p);
              words.add(b);
              words.add(b.replace(/\.[^.]+$/, ''));
              for (const part of path.win32.dirname(p).split(/[\\/]+/).slice(1)) if (part.length >= 4) words.add(part);
            }
          }
        }
      }
    } catch (_) { /* none */ }
    const f = path.join(app.getPath('userData'), 'report-words.tmp');
    try { await fsp.writeFile(f, JSON.stringify([...words].slice(0, 400))); } catch (_) { return ''; }
    return f;
  }
  /** anonymous crash reports on / off (only those made from now on are ever sent) */
  function crashSharing(on) {
    const s = readSettings();
    if (on && endpoint) { s.anonCrashReports = true; s.anonCrashSince = Date.now(); } else { s.anonCrashReports = false; delete s.anonCrashSince; }
    writeSettings(s);
    if (on) scheduleFlush(2000);
    return status();
  }
  /** exactly what a crash report sent from here looks like (Settings > Help: "Show an example") */
  function preview() {
    let who = { user: '', pc: '' };
    try { who = { user: os.userInfo().username, pc: os.hostname() }; } catch (_) { /* none */ }
    const sample = { kind: 'crash', ...base(), where: 'window', message: 'TypeError: an example error (the real one goes here)', stack: '', log: logTail() };
    return JSON.stringify(require('./anon.cjs').anonymize(sample, who), null, 2);
  }

  return { crash, problem, flush, scheduleFlush, status, crashSharing, preview };
}

module.exports = { create };
