// Rev Radar - Electron main process: the window, the background engines, files and the
// results cache. Everything that reads PDFs runs in the engines (see src/engine/host.ts).
'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, net, utilityProcess, MessageChannelMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { pathToFileURL } = require('url');
// Word files turned into PDFs for the Documents tab (wordpdf.cjs): Word on Windows, else LibreOffice
const docxConv = require('./wordpdf.cjs').makeConverter({});

const VERSION = require('../package.json').version;
const APP = 'Rev Radar';

function arg(name) {
  const p = process.argv.find((a) => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3).replace(/^"|"$/g, '') : null;
}
const profile = (arg('profile') || 'default').replace(/[^\w-]/g, '');
app.setPath('userData', path.join(app.getPath('appData'), APP, profile === 'default' ? '' : 'profile-' + profile));
// big things that belong to this PC stay out of the roaming profile: the results cache, Chromium's caches
const localDir = () => process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, APP, profile === 'default' ? '' : 'profile-' + profile)
  : app.getPath('userData');
try { app.setPath('sessionData', path.join(localDir(), 'session')); } catch (_) { /* older Electron */ }

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) { try { global.__rrBoot?.notAStart?.(); } catch (_) { /* */ } app.quit(); return; }

const dataDir = () => app.getPath('userData');
const settingsPath = () => path.join(dataDir(), 'settings.json');
// Settings hold the remembered comparisons (ticks, pairs made by hand, spots left out) and the
// updates folder: never wiped by a moment's trouble reading them (as the PDF Editor learnt) -
//  - missing: none (or the last good copy, settings.json.bak);
//  - held by another program (antivirus, backup): tried again; still held -> the next write merges
//    into what is there once it can be read, instead of replacing it with only its own change;
//  - damaged: kept as settings.damaged-<time>.json, the last good copy used.
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let settingsHeld = false;
/** settings text read (a BOM - the file saved by Notepad - dropped: it made the file "damaged" and the
 *  last good copy was used instead; found in the PDF Editor, 0.8.5) */
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
function readBak() {
  try { return readJson(settingsPath() + '.bak'); } catch (_) { return null; }
}
function loadSettings(tries) {
  for (let k = 0; ; k++) {
    try { const s = readJson(settingsPath()); settingsHeld = false; return s && typeof s === 'object' ? s : {}; } catch (e) {
      if (e && e.code === 'ENOENT') { settingsHeld = false; return readBak() || {}; }
      if (e instanceof SyntaxError) {
        try { fs.copyFileSync(settingsPath(), path.join(dataDir(), `settings.damaged-${Date.now()}.json`)); } catch (_) { /* */ }
        settingsHeld = false;
        log('settings damaged - kept aside, the last good copy used');
        return readBak() || {};
      }
      if (k >= tries) throw e;
      wait(60 * (k + 1));
    }
  }
}
function readSettings() {
  try { return loadSettings(4); } catch (e) { settingsHeld = true; log('settings could not be read: ' + (e && e.code)); return {}; }
}
function writeSettings(s) {
  fs.mkdirSync(dataDir(), { recursive: true });
  // (read while held: s holds only the change - put it over what is really there)
  if (settingsHeld) s = { ...loadSettings(6), ...s };
  const tmp = settingsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  try { fs.copyFileSync(settingsPath(), settingsPath() + '.bak'); } catch (_) { /* first time */ }
  for (let k = 0; ; k++) {
    try { fs.renameSync(tmp, settingsPath()); return; } catch (e) {
      if (k >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      wait(60 * (k + 1));
    }
  }
}
let logLines = 0;
function log(line) {
  try {
    const dir = path.join(dataDir(), 'logs');
    const f = path.join(dir, 'app.log');
    fs.mkdirSync(dir, { recursive: true });
    if (logLines++ % 400 === 0) { try { if (fs.statSync(f).size > 4e6) fs.renameSync(f, path.join(dir, 'app.old.log')); } catch (_) { /* none yet */ } }
    fs.appendFileSync(f, new Date().toISOString() + ' ' + line + '\n');
  } catch (_) { /* never let logging break the app */ }
}
process.on('uncaughtException', (e) => log('main uncaught: ' + (e && e.stack ? e.stack : e)));
process.on('unhandledRejection', (e) => log('main rejection: ' + (e && e.stack ? e.stack : e)));

let win = null;
const TITLEBAR = {
  light: { color: '#09302f', symbolColor: '#ffffff', height: 40 },
  dark: { color: '#020d0c', symbolColor: '#e8eeec', height: 40 },
};

function createWindow() {
  const s = readSettings();
  win = new BrowserWindow({
    width: s.width || 1500,
    height: s.height || 940,
    minWidth: 980,
    minHeight: 600,
    show: false,
    title: APP,
    backgroundColor: '#09302f',
    icon: path.join(__dirname, '..', 'dist', 'icon256.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: s.theme === 'dark' ? TITLEBAR.dark : TITLEBAR.light,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      additionalArguments: [...(arg('engines') ? ['--rr-engines=' + arg('engines')] : []), ...(arg('viewers') ? ['--rr-viewers=' + arg('viewers')] : [])],
    },
  });
  if (s.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL('app://rr/index.html');
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    log('renderer gone: ' + JSON.stringify(d));
    if (d.reason === 'clean-exit' || !win || win.isDestroyed()) return;
    const w = win;
    void dialog.showMessageBox(w, { type: 'error', message: 'The Rev Radar window stopped working', detail: 'Reason: ' + d.reason + '. Finished comparisons are kept and come back at once.', buttons: ['Start again', 'Close'], defaultId: 0, noLink: true })
      .then((r) => { if (w.isDestroyed()) return; if (r.response === 0) w.webContents.reload(); else w.close(); })
      .catch(() => {});
  });
  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    const st = readSettings();
    st.maximized = win.isMaximized();
    if (!st.maximized) { const b = win.getBounds(); st.width = b.width; st.height = b.height; }
    try { writeSettings(st); } catch (_) { /* */ }
  };
  win.on('close', (e) => {
    if (busy) {
      const r = dialog.showMessageBoxSync(win, { type: 'warning', message: 'Rev Radar is still saving ' + path.basename(busy), detail: 'Close anyway? The unfinished file is not saved.', buttons: ['Keep saving', 'Close anyway'], defaultId: 0, cancelId: 0, noLink: true });
      if (r === 0) { e.preventDefault(); updater.cancelRelaunch(); send('update:state', updater.snapshot()); return; }
      busy = '';
    }
    saveBounds();
  });
}

// ---------------------------------------------------------------- engines (background processes)
// Each engine is a Node process of its own with a direct message port to the window. If one
// dies (out of memory on a monster file), it is started again and the window gets a new port.
const engines = new Map();
let quitting = false;
const engineFile = () => path.join(__dirname, 'engine.mjs');
const resDir = () => path.join(__dirname, '..', 'dist');

function spawnEngine(name, restarted, code) {
  const proc = utilityProcess.fork(engineFile(), [resDir()], { serviceName: APP + ' ' + name, stdio: 'pipe' });
  const e = { proc, born: Date.now() };
  engines.set(name, e);
  // the comparing (and exporting) engines give way: the sheet on screen, drawn by the view engine,
  // and the rest of the PC come first - a batch running while you review slowed every picture
  // (a view engine making the next sheet ready gives way too - set once its process is there)
  proc.on('spawn', () => { try { if (proc.pid && (!name.startsWith('view') || lowViews.has(name))) os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) { /* not allowed: as before */ } });
  const out = (b) => String(b).split('\n').filter(Boolean).forEach((l) => log('[' + name + '] ' + l));
  proc.stdout?.on('data', out);
  proc.stderr?.on('data', out);
  proc.on('message', (m) => { if (m && m.type === 'failed') log('engine ' + name + ' failed to start: ' + m.error); });
  proc.on('exit', (c) => {
    if (engines.get(name) !== e) return;
    log('engine ' + name + ' exited ' + c);
    if (quitting || !win || win.isDestroyed()) return;
    const wait = Date.now() - e.born < 3000 ? 1500 : 0;
    setTimeout(() => { if (!quitting && win && !win.isDestroyed()) spawnEngine(name, true, c); }, wait);
  });
  const { port1, port2 } = new MessageChannelMain();
  proc.postMessage({ type: 'port' }, [port1]);
  win.webContents.postMessage('engine:port', { name, restarted: !!restarted, code: code ?? 0 }, [port2]);
}
ipcMain.handle('engines:start', (_e, names) => {
  for (const [name, e] of engines) { engines.delete(name); try { e.proc.kill(); } catch (_) { /* gone */ } }
  for (const name of names) spawnEngine(name, false, 0);
  return true;
});
/** a view engine's turn: drawing the sheet on screen (normal) or making the next one ready (low) */
/** view engines that make the next sheet ready (kept for one started afresh) */
const lowViews = new Set();
ipcMain.handle('engines:priority', (_e, name, low) => {
  if (!String(name).startsWith('view')) return false;
  if (low) lowViews.add(name); else lowViews.delete(name);
  const e = engines.get(name);
  if (!e || !e.proc.pid) return false; // (not there yet: set when it is - spawnEngine)
  try { os.setPriority(e.proc.pid, low ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL); return true; } catch (_) { return false; }
});
/** stop an engine on purpose (cancel a running comparison) - it starts again by itself */
ipcMain.handle('engines:kill', (_e, name) => {
  const e = engines.get(name);
  if (e) try { e.proc.kill(); } catch (_) { /* */ }
  return true;
});
/** an engine started afresh (exports), and closed for good after */
ipcMain.handle('engines:add', (_e, name) => {
  const old = engines.get(name);
  if (old) { engines.delete(name); try { old.proc.kill(); } catch (_) { /* gone */ } }
  spawnEngine(name, false, 0);
  return true;
});
ipcMain.handle('engines:stop', (_e, name) => {
  const e = engines.get(name);
  if (e) { engines.delete(name); try { e.proc.kill(); } catch (_) { /* gone */ } }
  return true;
});
app.on('before-quit', () => { quitting = true; });

/** a file being written right now (closing the window asks first) */
let busy = '';
ipcMain.handle('app:busy', (_e, what) => { busy = String(what || ''); return true; });

// ---------------------------------------------------------------- basics

ipcMain.handle('app:info', () => ({
  version: VERSION,
  cores: os.cpus().length,
  memGB: Math.round(os.totalmem() / 1024 ** 3),
  platform: process.platform,
  engines: Number(arg('engines')) || 0,
  docs: app.getPath('documents'),
}));
ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, patch) => { const s = { ...readSettings(), ...patch }; writeSettings(s); return s; });
ipcMain.handle('win:theme', (_e, mode) => {
  if (win && !win.isDestroyed()) { try { win.setTitleBarOverlay(mode === 'dark' ? TITLEBAR.dark : TITLEBAR.light); } catch (_) { /* not on this platform */ } }
  return true;
});
ipcMain.handle('win:title', (_e, t) => { if (win && !win.isDestroyed()) win.setTitle(String(t || APP)); return true; });
ipcMain.on('log', (_e, line) => log('window: ' + line));
// the window's code runs (its first screen is drawn): a downloaded copy of the app counts as working
// (boot.cjs). Not did-finish-load: that fires for a page whose script is broken or missing, too.
ipcMain.once('app:up', () => { try { global.__rrBoot?.started?.(); } catch (_) { /* */ } });

// ---------------------------------------------------------------- files

const isPdf = (n) => /\.pdf$/i.test(n);
// what each tab compares: drawings (PDF), BOQs (workbooks or PDF), documents (PDF, Word)
const KINDS = { pdf: /\.pdf$/i, boq: /\.(xlsx|xlsm|xls|pdf)$/i, docs: /\.(pdf|docx)$/i };
const kindRe = (k) => KINDS[k] || KINDS.pdf;

/** PDFs in a folder (sub folders too when asked), sorted by path */
async function listPdfs(dir, recursive, kind = 'pdf') {
  const want = kindRe(kind);
  const out = [];
  // each real folder once: a link or junction back up the tree would list the same files forever
  const seen = new Set();
  const walk = async (d, depth) => {
    try { const real = (await fsp.realpath(d)).toLowerCase(); if (seen.has(real)) return; seen.add(real); } catch (_) { /* listed below */ }
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { if (depth === 0) throw e; return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      let isDir = e.isDirectory(), isFile = e.isFile();
      if (e.isSymbolicLink()) { try { const st = await fsp.stat(p); isDir = st.isDirectory(); isFile = st.isFile(); } catch (_) { continue; } }
      // (64 levels: a guard for a folder whose real path can't be read - deeper than any Windows path
      //  allows; 12 before left real sheets out silently and they read as Removed / New, RR-042)
      if (isDir) { if (recursive && !e.name.startsWith('.')) { if (depth < 64) await walk(p, depth + 1); else console.error('folder too deep, not read: ' + p); } }
      else if (isFile && want.test(e.name) && !e.name.startsWith('~$')) {
        try { const st = await fsp.stat(p); out.push({ path: p, rel: path.relative(dir, p), size: st.size, mtime: st.mtimeMs }); } catch (_) { /* gone */ }
      }
    }
  };
  await walk(dir, 0);
  out.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true, sensitivity: 'base' }));
  return out;
}
ipcMain.handle('fs:list', (_e, dir, recursive, kind) => listPdfs(dir, !!recursive, typeof kind === 'string' ? kind : 'pdf'));
ipcMain.handle('fs:stat', async (_e, paths) => Promise.all(paths.map(async (p) => {
  try { const st = await fsp.stat(p); return { path: p, size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() }; } catch (_) { return null; }
})));

/** whole-file fingerprint (identical files are recognised without drawing them) */
const hashCache = new Map();
async function fileHash(p, quick) {
  const st = await fsp.stat(p);
  const k = p + '|' + st.size + '|' + st.mtimeMs + '|' + (quick ? 'q' : 'f');
  if (hashCache.has(k)) return hashCache.get(k);
  const h = crypto.createHash('sha1');
  const fd = await fsp.open(p, 'r');
  try {
    const CH = 1 << 20;
    const buf = Buffer.allocUnsafe(CH);
    if (quick && st.size > 3 * CH) {
      // a cache key, not an identity check: start + end + 16 samples across the middle + size +
      // modified time (a re-issue of the same size that kept its first and last MB still differs)
      for (const at of [0, st.size - CH]) { const { bytesRead } = await fd.read(buf, 0, CH, at); h.update(buf.subarray(0, bytesRead)); }
      const S = 64 * 1024;
      for (let k = 1; k <= 16; k++) { const at = Math.floor((st.size - S) * k / 17); const { bytesRead } = await fd.read(buf, 0, S, at); h.update(buf.subarray(0, bytesRead)); }
      h.update(String(st.size) + '|' + Math.round(st.mtimeMs));
    } else {
      for (let at = 0; at < st.size; at += CH) { const { bytesRead } = await fd.read(buf, 0, CH, at); if (!bytesRead) break; h.update(buf.subarray(0, bytesRead)); }
    }
  } finally { await fd.close(); }
  const v = h.digest('hex');
  hashCache.set(k, v);
  return v;
}
ipcMain.handle('fs:hash', (_e, p, quick) => fileHash(p, !!quick));

ipcMain.handle('dialog:open', async (_e, opts) => {
  const r = await dialog.showOpenDialog(win, {
    title: opts?.title,
    defaultPath: opts?.defaultPath,
    properties: opts?.folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
    filters: opts?.folder ? undefined : opts?.kind === 'boq' ? [{ name: 'BOQ (Excel or PDF)', extensions: ['xlsx', 'xlsm', 'xls', 'pdf'] }] : opts?.kind === 'docs' ? [{ name: 'Documents (PDF or Word)', extensions: ['pdf', 'docx'] }] : [{ name: 'PDF drawings', extensions: ['pdf'] }],
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dialog:save', async (_e, opts) => {
  // a bare file name opens in the last export folder (or Documents) - not wherever the dialog was
  // last, which may be the drawings' own folder on the server
  let def = opts?.defaultPath;
  if (def && !path.isAbsolute(def)) {
    const last = readSettings().exportDir;
    def = path.join(last && fs.existsSync(last) ? last : app.getPath('documents'), def);
  }
  const r = await dialog.showSaveDialog(win, { title: opts?.title, defaultPath: def, filters: opts?.filters });
  if (r.canceled || !r.filePath) return null;
  try { writeSettings({ ...readSettings(), exportDir: path.dirname(r.filePath) }); } catch (_) { /* */ }
  return r.filePath;
});
/** the window only ever writes Excel lists and opens what the app made: nothing else (a page bug
 *  must not become a way to write or start any file) */
const exported = /\.(xlsx|pdf)$/i;
ipcMain.handle('file:write', async (_e, p, data) => {
  p = String(p);
  if (!/\.xlsx$/i.test(p)) throw new Error('Not an Excel file name');
  const tmp = p + '.part';
  try {
    await fsp.writeFile(tmp, Buffer.from(data));
    await fsp.rename(tmp, p);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return true;
});
ipcMain.handle('shell:open', (_e, p) => (exported.test(String(p)) ? shell.openPath(String(p)) : 'not an exported file'));
ipcMain.handle('shell:show', (_e, p) => { if (exported.test(String(p))) shell.showItemInFolder(String(p)); return true; });
ipcMain.handle('docx:convert', (_e, p) => docxConv.convert(String(p || '')));
ipcMain.handle('paths:temp', async (_e, name) => {
  const d = path.join(os.tmpdir(), APP);
  await fsp.mkdir(d, { recursive: true });
  return path.join(d, String(name || 'file').replace(/[\\/:*?"<>|]/g, '_'));
});

// ---------------------------------------------------------------- results cache
// One folder per compared pair (key = both files + pages + settings): result.json and the
// two pictures. Opening the same comparison again is instant.
const cacheDir = () => path.join(localDir(), 'cache');
const CACHE_MAX = 3 * 1024 ** 3;
const safeKey = (k) => String(k).replace(/[^a-f0-9]/gi, '').slice(0, 64);
ipcMain.handle('cache:get', async (_e, key) => {
  const d = path.join(cacheDir(), safeKey(key));
  try {
    const json = JSON.parse(await fsp.readFile(path.join(d, 'result.json'), 'utf8'));
    const thumb = await fsp.readFile(path.join(d, 'thumb.png'));
    const now = new Date();
    fsp.utimes(path.join(d, 'result.json'), now, now).catch(() => {});
    return { json, thumb: new Uint8Array(thumb) };
  } catch (_) { return null; }
});
ipcMain.handle('cache:preview', async (_e, key) => {
  try { return new Uint8Array(await fsp.readFile(path.join(cacheDir(), safeKey(key), 'preview.png'))); } catch (_) { return null; }
});
let pruneAt = 0;
ipcMain.handle('cache:put', async (_e, key, json, thumb, preview) => {
  const d = path.join(cacheDir(), safeKey(key));
  await fsp.mkdir(d, { recursive: true });
  await fsp.writeFile(path.join(d, 'thumb.png'), Buffer.from(thumb));
  await fsp.writeFile(path.join(d, 'preview.png'), Buffer.from(preview));
  await fsp.writeFile(path.join(d, 'result.json.tmp'), JSON.stringify(json));
  await fsp.rename(path.join(d, 'result.json.tmp'), path.join(d, 'result.json'));
  if (Date.now() - pruneAt > 60000) { pruneAt = Date.now(); void pruneCache(); }
  return true;
});
ipcMain.handle('cache:clear', async () => { await fsp.rm(cacheDir(), { recursive: true, force: true }); return true; });
ipcMain.handle('cache:size', async () => (await cacheEntries()).reduce((s, e) => s + e.size, 0));
async function cacheEntries() {
  const out = [];
  let ents = [];
  try { ents = await fsp.readdir(cacheDir()); } catch (_) { return out; }
  for (const n of ents) {
    const d = path.join(cacheDir(), n);
    let size = 0, t = 0;
    try { for (const f of await fsp.readdir(d)) { const st = await fsp.stat(path.join(d, f)); size += st.size; t = Math.max(t, st.mtimeMs); } } catch (_) { continue; }
    out.push({ d, size, t });
  }
  return out;
}
async function pruneCache() {
  const list = await cacheEntries();
  let total = list.reduce((s, e) => s + e.size, 0);
  list.sort((a, b) => a.t - b.t);
  for (const e of list) { if (total <= CACHE_MAX) break; await fsp.rm(e.d, { recursive: true, force: true }).catch(() => {}); total -= e.size; }
}

// ---------------------------------------------------------------- updates (GitHub releases, signed; no helper program: see updater.cjs)

const send = (ch, v) => { if (win && !win.isDestroyed()) win.webContents.send(ch, v); };
const updater = require('./updater.cjs').create({ version: VERSION, readSettings, writeSettings, log, send });
ipcMain.handle('update:get', () => updater.snapshot());
ipcMain.handle('update:check', () => updater.check(true));
ipcMain.handle('update:download', () => updater.download());
ipcMain.handle('update:cancel', () => updater.cancel());
ipcMain.handle('update:later', () => { updater.later(); return true; });
/** restart onto a downloaded version / go back / the newest again: the window closes the normal way */
ipcMain.handle('update:restart', (_e, what) => {
  const ok = what === 'back' ? updater.goBack() : what === 'newest' ? updater.useNewest() : updater.restartForUpdate();
  if (ok && win && !win.isDestroyed()) setTimeout(() => win.close(), 50);
  return ok;
});
ipcMain.handle('update:afterStart', () => updater.afterStart());
/** the setup for a new runtime: its download page in the browser (never downloaded or started from here) */
ipcMain.handle('update:showSetup', () => {
  // only what the updater found - never a path or address from the window - and a file is only ever
  // selected in its folder, never opened (opening a .msi/.cmd/.js would start it)
  const t = updater.setupTarget();
  if (t.url && /^https?:\/\//.test(t.url)) void shell.openExternal(t.url);
  else if (t.file) shell.showItemInFolder(t.file); else if (t.dir) void shell.openPath(t.dir);
  return true;
});
/** the releases page (Settings > Updates) */
ipcMain.handle('update:openPage', () => { const u = updater.snapshot().page; if (u && /^https:\/\//.test(u)) void shell.openExternal(u); return true; });
app.on('will-quit', () => {
  updater.stop();
  docxConv.stop(); // (a conversion running now: its PowerShell and Word ended, before the folder goes)
  docxConv.clean();
  // (the text the Documents tab reads for "Text as read": src/engine/host.ts writeReading)
  try { const w = path.join(os.tmpdir(), APP, 'work'); for (const n of fs.readdirSync(w)) if (/^read-[\w-]+\.json$/.test(n)) fs.rmSync(path.join(w, n), { force: true }); } catch (_) { /* none */ }
  if (updater.wantsRelaunch()) {
    log('update: starting again');
    // (tests start the app themselves: a restart they can't follow would be left running)
    if (process.env.RR_TEST_NO_RELAUNCH !== '1') app.relaunch();
  }
});

// ---------------------------------------------------------------- problem + crash reports (T12; reports.cjs)
// (a receiver named in package.json "reportEndpoint" - the released build's, set by scripts/pack.mjs; empty from source: nothing leaves the PC)
const outbound = require('./outbound.cjs');
const reports = require('./reports.cjs').create({
  version: VERSION, readSettings, writeSettings, log, appName: APP, send,
  logFile: () => path.join(dataDir(), 'logs', 'app.log'),
  endpoint: outbound.endpoint('report', require('../package.json')),
});
process.on('uncaughtException', (e) => reports.crash('main', e));
process.on('unhandledRejection', (e) => reports.crash('main (promise)', e));
app.on('render-process-gone', (_e, _wc, d) => { if (d && d.reason !== 'clean-exit') reports.crash('window gone', { message: d.reason + ' (exit ' + d.exitCode + ')' }); });
app.on('child-process-gone', (_e, d) => {
  // (stopped on purpose - an update check over its time limit, an engine closed - is no crash; nor
  //  an engine that ends itself to start again fresh, codes 70 / 71 / 75)
  if (quitting || !d || ['clean-exit', 'killed'].includes(d.reason) || [70, 71, 75].includes(d.exitCode)) return;
  reports.crash('process ' + d.type + (d.name ? ' ' + d.name : ''), { message: d.reason + ' (exit ' + d.exitCode + ')' });
});
ipcMain.handle('report:problem', (_e, text, extra) => reports.problem(String(text || ''), extra && typeof extra === 'object' ? { openFiles: Number(extra.openFiles) || 0, tab: String(extra.tab || '').slice(0, 20) } : {}));
ipcMain.handle('report:status', () => reports.status());
ipcMain.handle('report:crashSharing', (_e, on) => reports.crashSharing(!!on));
ipcMain.handle('report:preview', () => reports.preview());
ipcMain.handle('report:openQueue', async () => {
  const st = await reports.status();
  await fsp.mkdir(st.queue, { recursive: true });
  return shell.openPath(st.queue);
});
ipcMain.on('report:crash', (_e, where, message, stack) => reports.crash(String(where || 'window').slice(0, 60), { message: String(message || ''), stack: String(stack || '') }));
app.whenReady().then(() => {
  // (reports left waiting - no internet last time - go a little after the start, and every half hour)
  reports.scheduleFlush(Number(process.env.RR_REPORT_FIRST) || 30000);
  setInterval(() => reports.scheduleFlush(1000), 30 * 60 * 1000);
});

// ---------------------------------------------------------------- the anonymous user count (T12; counter.cjs)
// (a receiver named in package.json "countEndpoint" - the released build's, set by scripts/pack.mjs; empty from source: no pop-up, nothing sent)
const COUNT_TIMEOUT = 15000;
/** one job in the update worker's process, with a time limit (no internet: it just ends) */
function countJob(args) {
  return new Promise((resolve) => {
    let proc;
    try { proc = utilityProcess.fork(path.join(__dirname, 'update-worker.cjs'), args, { serviceName: APP + ' count', stdio: 'ignore' }); } catch (e) { resolve({ ok: false, err: String(e.message || e) }); return; }
    let result = null, fin = false;
    const finish = (r) => { if (fin) return; fin = true; clearTimeout(t); try { proc.kill(); } catch (_) { /* gone */ } resolve(r); };
    const t = setTimeout(() => finish({ ok: false, err: 'timeout' }), COUNT_TIMEOUT);
    proc.on('message', (m) => { result = m; if (m && m.ok !== undefined) finish(m); });
    proc.on('exit', () => finish(result || { ok: false, err: 'stopped' }));
  });
}
const counter = require('./counter.cjs').create({ endpoint: outbound.endpoint('count', require('../package.json')), version: VERSION, readSettings, writeSettings, log, run: countJob });
const countTick = () => void counter.tick().catch((e) => log('user count: ' + e));
ipcMain.handle('count:get', () => counter.state());
ipcMain.handle('count:set', (_e, on) => { const st = counter.set(!!on); if (st.on) setTimeout(countTick, 3000); return st; });
app.whenReady().then(() => {
  counter.init();
  setTimeout(countTick, Number(process.env.RR_COUNT_FIRST) || 60000);
  setInterval(countTick, 3600 * 1000);
});

// ---------------------------------------------------------------- start

if (process.platform === 'win32') app.setAppUserModelId('revradar.app');
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // leftovers of exports cut short (window closed, PC off) in the temp folder; monster sheets'
  // merged strokes (src/engine/heavy.ts) not used for two weeks
  docxConv.prune(24 * 3600e3);
  void (async () => {
    for (const [sub, days] of [['work', 1], ['heavy', 14]]) {
      const w = path.join(os.tmpdir(), APP, sub);
      for (const n of await fsp.readdir(w).catch(() => [])) {
        const d = path.join(w, n);
        const st = await fsp.stat(d).catch(() => null);
        if (st && Date.now() - st.mtimeMs > days * 24 * 3600e3) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
      }
    }
  })();
  const root = path.join(__dirname, '..', 'dist');
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const f = path.normalize(path.join(root, rel));
    if (!f.startsWith(root + path.sep)) return new Response('no', { status: 403 });
    return net.fetch(pathToFileURL(f).href);
  });
  createWindow();
  updater.start();
});
app.on('window-all-closed', () => app.quit());
