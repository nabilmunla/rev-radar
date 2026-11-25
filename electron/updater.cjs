// Updates from Rev Radar's GitHub releases, without any helper program.
//
// Where: https://github.com/nabilmunla/rev-radar/releases (feed.cjs) - every copy, whatever the
// setup or Settings said before: from 0.5.0 on, the old updates folder (update.json "source", the
// folder once chosen in Settings) is not read any more (0.5.0 itself reached the older copies through
// it once - the bridge). RR_UPDATE_FEED points the tests at a feed of their own.
// Trust: latest.json must carry the publisher's signature (updsig.cjs, Ed25519, the public key in
// the app); the package must match the SHA-256 it signed.
//
// How: the feed is read in update-worker.cjs, a process of its own with a time limit, so a PC
// without internet just gets "not reachable" - no waiting, no popups. A new version
// is announced and only downloaded when the person says so; the copy is checked (SHA-256),
// unpacked into %LOCALAPPDATA%\Rev Radar\app\<version> (scripts and pictures only - no program)
// and the next start runs it: "Restart now" restarts Rev Radar.exe itself. Company antivirus
// blocks programs started from AppData (the PDF Editor's update helper was stopped that way):
// Rev Radar never starts one. A version with a new Electron runtime needs the setup: the card
// says so and shows where it is.
'use strict';
const { utilityProcess, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const V = require('./versions.cjs');
const feed = require('./feed.cjs');
const { verifyLatest } = require('./updsig.cjs');

const CHECK_TIMEOUT = Number(process.env.RR_UPDATE_TIMEOUT) || 15000;
const STALL_TIMEOUT = Number(process.env.RR_UPDATE_STALL) || 60000;
const INSTALL_TIMEOUT = 120000;
const EVERY = 4 * 3600 * 1000;
const FIRST = Number(process.env.RR_UPDATE_FIRST) || 20000;

function create({ version, readSettings, writeSettings, log, send }) {
  const boot = global.__rrBoot || {};
  const store = boot.store || path.join(require('os').tmpdir(), 'Rev Radar', 'app');
  const builtinDir = boot.builtinDir || path.join(__dirname, '..');
  const runtime = process.versions.electron;
  const installDir = () => boot.installDir || path.dirname(process.execPath);
  const install = () => V.readJson(path.join(installDir(), 'install.json'));
  // (update.json's "source" and Settings' updateSource are left as they are - a "Go back" to 0.4.x
  //  still finds its folder - and never read here)
  const source = () => String(process.env.RR_UPDATE_FEED || '').trim() || feed.FEED;
  const list = () => { try { return V.candidates(builtinDir, store, runtime); } catch (_) { return []; } };
  /** the copy to go back to: the newest one older than this */
  const previous = () => list().find((c) => V.newer(version, c.version)) || null;
  /** the newest copy on this PC (when the person went back, it is not the one running) */
  const newest = () => list()[0] || null;

  /** idle | off | checking | none | pending | available | downloading | installing | ready | setup | error | unreachable | empty */
  let st = { state: 'idle' };
  let latest = null; // { version, notes, groups, kind, pkg, setupFile }
  let worker = null;
  let laterFor = '';
  let relaunch = false;
  let timer = null;

  function snapshot() {
    const s = readSettings();
    const ii = install();
    const prev = previous(), top = newest();
    return {
      ...st,
      version,
      builtin: boot.builtin !== false,
      builtinVersion: boot.builtinVersion || version,
      installed: !!ii,
      scope: ii ? ii.scope || 'user' : '',
      source: source(),
      /** the page people can download a version from by hand */
      page: feed.isWeb(source()) ? feed.releasePage(source(), '') : '',
      checked: s.updateChecked || 0,
      previous: prev ? prev.version : '',
      pinned: V.pinned(store),
      /** the version on the card is one the person went back from (not just any newer one) */
      left: !!st.available && skipList().includes(st.available),
      newest: top && V.newer(top.version, version) ? top.version : '',
    };
  }
  function set(patch) {
    st = { ...st, ...patch };
    send('update:state', snapshot());
  }

  /** grouped notes from latest.json ({"New features": [...], ...}): plain text only, kept short */
  function noteGroups(g) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
    const out = {};
    for (const [k, v] of Object.entries(g).slice(0, 6)) if (Array.isArray(v) && v.length) out[String(k).slice(0, 40)] = v.slice(0, 10).map((x) => String(x).slice(0, 200));
    return Object.keys(out).length ? out : null;
  }

  /** worker processes that never ended (a share that hangs - not even a kill gets through) */
  const stuck = new Set();
  /** run update-worker.cjs; resolves with its last message (or a timeout) */
  function runWorker(args, { timeout, onMessage } = {}) {
    return new Promise((resolve) => {
      let proc;
      try {
        proc = utilityProcess.fork(path.join(__dirname, 'update-worker.cjs'), args, { serviceName: 'Rev Radar updates', stdio: 'ignore' });
      } catch (e) { resolve({ ok: false, reach: 'unreachable', err: String(e.message || e) }); return; }
      worker = proc;
      let result = null, done = false, exited = false, t = null;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (worker === proc) worker = null;
        if (!exited) {
          try { proc.kill(); } catch (_) { /* gone */ }
          stuck.add(proc); // until its exit comes (if ever)
        }
        resolve(r);
      };
      const arm = () => { clearTimeout(t); t = setTimeout(() => finish({ ok: false, reach: 'unreachable', err: 'timeout' }), timeout); };
      arm();
      proc.on('message', (m) => {
        if (onMessage && m && m.progress !== undefined) { arm(); onMessage(m); return; }
        result = m;
        if (m && (m.ok !== undefined || m.done)) finish(m);
      });
      proc.on('exit', () => { exited = true; stuck.delete(proc); finish(result || { ok: false, reach: 'unreachable', err: 'stopped' }); });
    });
  }

  /** versions the person went back from: not offered again by themselves */
  function skipList() {
    const s = readSettings();
    if (Array.isArray(s.skipUpdates)) return s.skipUpdates.map(String);
    return typeof s.skipUpdate === 'string' && s.skipUpdate ? [s.skipUpdate] : [];
  }
  function clearSkips() {
    const s = readSettings();
    if (s.skipUpdates || s.skipUpdate) { delete s.skipUpdates; delete s.skipUpdate; writeSettings(s); }
  }

  function validate(j) {
    if (!j || typeof j !== 'object' || typeof j.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(j.version)) return 'latest.json has no valid version';
    if (j.product !== undefined && j.product !== 'Rev Radar') return `the update feed holds another program's latest.json (${String(j.product).slice(0, 40)})`;
    const okPkg = (p) => p && typeof p.file === 'string' && /^[0-9a-f]{64}$/i.test(String(p.sha256 || '')) && Number(p.size) > 0;
    if (!okPkg(j.app) && !okPkg(j.setup)) return 'latest.json lists no complete package';
    return '';
  }

  /** the setup for a new runtime: its download page (a folder feed in tests: the file, found by the worker) */
  let setupAt = { file: '', dir: '', url: '' };
  function setupFor(found, v) {
    const src = source();
    if (feed.isWeb(src)) { setupAt = { file: '', dir: '', url: feed.releasePage(src, v) }; return setupAt.url; }
    setupAt = { file: found ? path.join(src, found) : '', dir: src, url: '' };
    return setupAt.file || src;
  }

  // (the folder a check is running for: a check of another folder - "Use it" in Settings - is not
  //  held up by it, and the older one's answer is dropped - RR-040)
  let checking = '';
  /** one number per look: an answer that comes after a newer look, an Update or another folder is old */
  let lookGen = 0;
  let fetching = false;
  /** "Check now" pressed while a check of the same folder was already running in the background: its
   *  answer is shown as the answer to the press (it returned silently before) */
  let askedMeanwhile = false;
  async function check(manual) {
    const src = source();
    if (!src) { set({ state: 'off', err: '' }); return snapshot(); }
    if (checking === src && manual && !fetching && !['downloading', 'installing'].includes(st.state)) { askedMeanwhile = true; set({ state: 'checking', err: '' }); return snapshot(); }
    if (checking === src || fetching || ['downloading', 'installing'].includes(st.state)) return snapshot();
    if (stuck.size) {
      // the last look at the folder never ended (a server that doesn't answer): not again while it hangs
      log('update check: skipped - an earlier one is still waiting for an answer');
      if (manual) set({ state: 'unreachable', err: 'stuck', show: false });
      return snapshot();
    }
    checking = src;
    try { return await look(manual, src); } finally { if (checking === src) checking = ''; }
  }

  async function look(manual, src) {
    const before = st;
    const my = ++lookGen;
    // (a check by itself in the background changes nothing on screen until it has a result)
    if (manual) set({ state: 'checking', err: '' });
    askedMeanwhile = false;
    let asked = st;
    const r = await runWorker(['check', src], { timeout: CHECK_TIMEOUT });
    if (askedMeanwhile) { manual = true; askedMeanwhile = false; asked = st; }
    // (meanwhile Update was pressed, another folder chosen, a newer check started, or Later pressed:
    //  this answer would put an old card back over it - RR-039 / RR-040)
    if (my !== lookGen || fetching || source() !== src || ['downloading', 'installing'].includes(st.state)) return snapshot();
    try { writeSettings({ ...readSettings(), updateChecked: Date.now() }); } catch (_) { /* */ }
    if (!r.ok) {
      log('update check: ' + (r.reach || '') + ' ' + (r.err || ''));
      // a downloaded version, or an offer on the card, stays when the folder can't be read right now
      if (before.state === 'ready' || (!manual && ['available', 'setup'].includes(before.state))) { if (st === asked) set({ ...before }); return snapshot(); }
      if (r.reach === 'notdir') { set({ state: 'error', err: 'The updates folder in Settings is a file, not a folder.', show: false }); return snapshot(); }
      set({ state: r.reach === 'empty' ? 'empty' : r.reach === 'bad' ? 'error' : 'unreachable', err: r.err || '', show: false });
      return snapshot();
    }
    // only what the publisher signed (updsig.cjs): a latest.json changed anywhere on the way - its
    // checksums swapped for another program's - is refused, not installed
    const sig = verifyLatest(r.latest);
    if (!sig.latest) {
      log('update refused: ' + sig.err);
      if (before.state === 'ready' || (!manual && ['available', 'setup'].includes(before.state))) { if (st === asked) set({ ...before }); return snapshot(); }
      set({ state: 'error', err: sig.err + ' - not installed.', show: !!manual });
      return snapshot();
    }
    const j = sig.latest;
    for (const k of ['app', 'setup']) if (j[k] && r.latest.signedPresent && typeof r.latest.signedPresent[k] === 'boolean') j[k].present = r.latest.signedPresent[k];
    const bad = validate(j);
    if (bad) { log('update check: ' + bad); set({ state: 'error', err: bad, show: !!manual }); return snapshot(); }
    if (!V.newer(j.version, version)) { latest = null; set({ state: 'none', err: '', available: '', note: '', show: false }); return snapshot(); }
    // a new runtime (Electron) comes only with the whole setup; otherwise just the app part
    const full = !!(j.runtime && j.runtime !== runtime) || !j.app;
    const pkg = full ? j.setup : j.app;
    latest = {
      version: j.version,
      notes: Array.isArray(j.notes) ? j.notes.map(String).slice(0, 12) : [],
      groups: noteGroups(j.groups),
      kind: full ? 'full' : 'app',
      setupFile: j.setup && typeof j.setup.file === 'string' ? path.basename(j.setup.file) : '',
      pkg: pkg ? { file: path.basename(String(pkg.file)), sha256: String(pkg.sha256 || '').toLowerCase(), size: Number(pkg.size) || 0, present: pkg.present !== false } : null,
    };
    const skipped = skipList().includes(latest.version);
    const show = !!manual || (laterFor !== latest.version && !skipped);
    const base = { available: latest.version, notes: latest.notes, groups: latest.groups, kind: latest.kind, size: latest.pkg ? latest.pkg.size : 0, err: '', note: '' };
    if (full) { set({ ...base, state: 'setup', setupPath: setupFor(r.latest.setupFound, latest.version), show }); return snapshot(); }
    if (!latest.pkg || !/^[0-9a-f]{64}$/.test(latest.pkg.sha256)) { set({ state: 'error', err: 'latest.json lists no package for this update', show: !!manual }); return snapshot(); }
    // already here (downloaded earlier, or the person went back from it)?
    if (list().some((c) => !c.builtin && c.version === latest.version)) { set({ ...base, state: 'ready', show }); return snapshot(); }
    if (!latest.pkg.present) {
      log('update: package not complete in the folder yet');
      set({ state: 'pending', available: latest.version, err: '', show: false });
      return snapshot();
    }
    // set aside here before (it didn't start): offered only when asked for - Update tries it again
    const setAside = fs.existsSync(path.join(store, latest.version, 'bad.json'));
    set({ ...base, state: 'available', note: setAside ? `${latest.version} did not start on this PC last time. Update tries it once more.` : '', show: setAside ? !!manual : show });
    return snapshot();
  }

  let cancelled = false;
  async function download() {
    // (taken at once, before anything is awaited: two presses started two copies into one file and
    //  the good package failed its checksum - RR-039)
    if (fetching || !latest || latest.kind !== 'app' || !latest.pkg || ['downloading', 'installing'].includes(st.state)) return snapshot();
    fetching = true;
    lookGen++; // (a check running now is answered for the card before this)
    try {
      return await fetchUpdate();
    } catch (e) {
      log('update download: ' + (e && e.stack || e));
      set({ state: 'error', err: 'The update did not work (' + (e.code || e.message || e) + '). Nothing was changed.', show: true });
      return snapshot();
    } finally { fetching = false; }
  }
  async function fetchUpdate() {
    const v = latest.version, pkg = latest.pkg;
    // (from the web: the release of this very version - one published meanwhile can't hand over another file)
    const src = feed.isWeb(source()) ? feed.fileUrl(source(), v, pkg.file) : path.join(source(), pkg.file);
    const dl = path.join(store, 'downloads');
    const dst = path.join(dl, 'app-v' + v + '.zip');
    const part = dst + '.part';
    try { await fsp.mkdir(dl, { recursive: true }); await fsp.rm(part, { force: true }); } catch (e) { set({ state: 'error', err: 'Could not write to ' + dl + ': ' + (e.code || e.message), show: true }); return snapshot(); }
    cancelled = false;
    set({ state: 'downloading', pct: 0, err: '', show: true });
    const r = await runWorker(['copy', src, part, String(pkg.size)], {
      timeout: STALL_TIMEOUT,
      onMessage: (m) => set({ pct: pkg.size ? Math.min(1, m.progress / pkg.size) : 0 }),
    });
    if (!r.done) {
      await fsp.rm(part, { force: true }).catch(() => {});
      if (cancelled) { cancelled = false; set({ state: 'available', pct: 0, err: '', show: false }); return snapshot(); }
      log('update download failed: ' + (r.err || ''));
      const why = { timeout: 'The download stopped (no answer for a minute).', ENOENT: "The update file isn't in the release (any more).", 'bigger than announced': 'The download is not the file that was published (bigger than announced). Nothing was changed.', EACCES: 'No permission to read the update.', EPERM: 'No permission to read the update.', ENOSPC: "This PC's disk is full.", EBUSY: 'The update file is in use.' }[r.err];
      set({ state: 'error', err: why || 'Could not copy the update (' + (r.err || 'unknown') + ').', show: true });
      return snapshot();
    }
    if (String(r.sha).toLowerCase() !== pkg.sha256) {
      await fsp.rm(part, { force: true }).catch(() => {});
      log('update download: checksum mismatch');
      set({ state: 'error', err: 'The downloaded update is damaged (checksum mismatch). Nothing was changed.', show: true });
      return snapshot();
    }
    try {
      await fsp.rm(dst, { force: true }).catch(() => {});
      // (Windows: the antivirus may still hold the fresh file for a moment)
      for (let k = 0; ; k++) {
        try { await fsp.rename(part, dst); break; } catch (e) {
          if (k >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
          await new Promise((r) => setTimeout(r, 250 * (k + 1)));
        }
      }
    } catch (e) {
      await fsp.rm(part, { force: true }).catch(() => {});
      log('update download: could not put it in place: ' + (e.code || e.message));
      set({ state: 'error', err: 'Could not put the update in place (' + (e.code || e.message) + ').', show: true });
      return snapshot();
    }
    set({ state: 'installing', pct: 1 });
    // (a copy set aside before is replaced by this fresh one)
    const u = await runWorker(['install', dst, store, v, runtime, pkg.sha256], { timeout: INSTALL_TIMEOUT });
    await fsp.rm(dst, { force: true }).catch(() => {});
    if (!u.ok) {
      log('update unpack failed: ' + (u.err || ''));
      set({ state: 'error', err: 'Could not unpack the update: ' + (u.err || 'unknown') + '. Nothing was changed.', show: true });
      return snapshot();
    }
    try { writeSettings({ ...readSettings(), updateNotes: { version: v, notes: latest.notes, groups: latest.groups } }); } catch (_) { /* */ }
    log('update: ' + v + ' ready in ' + u.dir);
    // (Update pressed is a new choice: a "go back" made before no longer keeps the old version
    //  starting - it ran on every normal start and the update never did, RR-045)
    if (V.pinned(store)) V.pin(store, '');
    set({ state: 'ready', err: '', note: '', show: true });
    return snapshot();
  }

  function cancel() {
    if (worker && st.state === 'downloading') cancelled = true;
    if (worker) { try { worker.kill(); } catch (_) { /* gone */ } }
    return snapshot();
  }
  function later() {
    if (latest) laterFor = latest.version;
    set({ show: false });
  }

  /** "Restart now": the next start runs the newest copy (a "go back" choice is undone) */
  function restartForUpdate() {
    if (st.state !== 'ready') return false;
    if (V.pinned(store)) V.pin(store, '');
    clearSkips();
    relaunch = true;
    return true;
  }
  /** Settings > Go back: the previous copy runs from the next start (and this version is not offered by itself again) */
  function goBack() {
    const prev = previous();
    if (!prev) return false;
    V.pin(store, prev.version);
    const s = readSettings();
    delete s.skipUpdate;
    s.skipUpdates = [...new Set([...skipList(), version])].slice(-10);
    writeSettings(s);
    relaunch = true;
    return true;
  }
  /** Settings > Use the newest version again */
  function useNewest() {
    V.pin(store, '');
    clearSkips();
    relaunch = true;
    return true;
  }

  /** after an update (or going back): the notes once; old copies cleared */
  function afterStart() {
    const s = readSettings();
    let updated = null;
    if (s.lastRunVersion && s.lastRunVersion !== version) {
      const mine = s.updateNotes && s.updateNotes.version === version;
      // (installed by the setup over an older copy: this copy's own notes)
      const own = mine ? null : V.bundledNotes(path.join(__dirname, '..'), version);
      updated = { from: s.lastRunVersion, to: version, notes: mine ? s.updateNotes.notes || [] : [], groups: mine ? noteGroups(s.updateNotes.groups) : noteGroups(own), back: V.newer(s.lastRunVersion, version) };
    }
    if (s.lastRunVersion !== version) { try { writeSettings({ ...readSettings(), lastRunVersion: version }); } catch (_) { /* */ } }
    setTimeout(() => { try { V.tidy(store, version); } catch (e) { log('update tidy: ' + e); } }, 5000);
    return updated;
  }

  function start() {
    setTimeout(() => void check(false).catch((e) => log('update check: ' + e)), FIRST);
    timer = setInterval(() => void check(false).catch((e) => log('update check: ' + e)), EVERY);
    try { powerMonitor.on('resume', () => setTimeout(() => void check(false).catch(() => {}), 60000)); } catch (_) { /* n/a */ }
  }
  function stop() { clearInterval(timer); cancel(); }

  return {
    snapshot, check, download, cancel,
    /** the setup to show: { url } its download page, or (a folder feed) { file } selected in its folder / { dir } opened */
    setupTarget: () => (st.state === 'setup' ? setupAt : { file: '', dir: '', url: '' }), later, restartForUpdate, goBack, useNewest, afterStart, start, stop,
    /** the app should start again once it has closed */
    wantsRelaunch: () => relaunch,
    /** the close was cancelled: no restart then */
    cancelRelaunch: () => { relaunch = false; },
  };
}

module.exports = { create };
