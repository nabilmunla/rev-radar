// Rev Radar starts here (package.json "main"): it picks which copy of the app files runs - the
// one the setup installed, or a newer one the app downloaded itself (see versions.cjs) - and
// loads its main.cjs. Kept small and unchanging: it is the part that can't be updated without
// the setup.
'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const V = require('./versions.cjs');

const builtinDir = path.join(__dirname, '..');
// (RR_* settings: for the tests only - never honoured in the installed app)
const dev = !app.isPackaged;
const noRelaunch = dev && process.env.RR_BOOT_NO_RELAUNCH === '1';
const installDir = (dev && process.env.RR_INSTALL_DIR) || path.dirname(process.execPath);
const store = (dev && process.env.RR_APP_STORE) || (process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Rev Radar', 'app')
  : path.join(app.getPath('appData'), 'Rev Radar', 'app'));
const runtime = process.versions.electron;

function note(line) {
  try { fs.mkdirSync(store, { recursive: true }); fs.appendFileSync(path.join(store, 'boot.log'), new Date().toISOString() + ' ' + line + '\n'); } catch (_) { /* never stop the start */ }
}

const builtinVersion = (V.readJson(path.join(builtinDir, 'package.json')) || {}).version || '';
// the setup ran since the last start: what it installed runs (see versions.setupRan)
try { const r = V.setupRan(store, installDir, builtinVersion); if (r) note(r); } catch (e) { note('setup check: ' + (e && e.message || e)); }
let pick = null;
try { pick = V.choose(builtinDir, store, runtime); } catch (e) { note('choose: ' + (e && e.stack || e)); }
// a store copy that failed to come up before is set aside here (and the next one is taken)
let undo = null;
while (pick && !pick.builtin) {
  const dir = pick.dir, before = V.readJson(path.join(dir, 'starts.json'));
  if (V.beginStart(dir)) { undo = () => V.undoStart(dir, before); break; }
  note('set aside ' + pick.version + ' (its window did not come up)');
  pick = V.choose(builtinDir, store, runtime);
}
if (!pick) pick = { version: builtinVersion, dir: builtinDir, builtin: true };

global.__rrBoot = {
  version: pick.version,
  dir: pick.dir,
  builtin: pick.builtin,
  builtinVersion,
  builtinDir,
  store,
  installDir,
  /** the window is up and its code runs: this copy works */
  started() { clearTimeout(watchdog); if (!pick.builtin) V.startedOk(pick.dir); },
  /** not a start after all: another Rev Radar already runs (single-instance lock) */
  notAStart() { clearTimeout(watchdog); if (undo) undo(); },
};
// a copy that loads but never gets its window up (fails once Electron is ready...) would leave an
// invisible process holding the single-instance lock: it counts as a failed start and starts again
let watchdog = null;
if (!pick.builtin) {
  const ms = (dev && Number(process.env.RR_BOOT_WATCHDOG)) || 90000;
  watchdog = setTimeout(() => {
    note(pick.version + ': no window after ' + Math.round(ms / 1000) + ' s');
    if (!noRelaunch) app.relaunch();
    app.exit(0);
  }, ms);
}

if (pick.builtin) {
  require(path.join(builtinDir, 'electron', 'main.cjs'));
} else {
  try {
    require(path.join(pick.dir, 'electron', 'main.cjs'));
  } catch (e) {
    // a downloaded copy that doesn't even load: set aside, and a clean start runs the next one
    note('could not load ' + pick.version + ': ' + (e && e.stack || e));
    V.setAside(pick.dir, 'it could not be loaded: ' + (e && e.message || e));
    if (!noRelaunch) app.relaunch();
    app.exit(0);
  }
}
