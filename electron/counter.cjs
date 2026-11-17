// The anonymous user count (T12): how many copies are in use - not people, not starts. Once a day
// one ping with exactly three things: a random number made on this PC (crypto random - nothing of the
// PC in it), the app version, and "Windows" or "Linux" (outbound.cjs countRequest). The number stays
// across updates (it lives in the settings); "Turn it off" deletes it and nothing is ever sent.
// Nothing is sent before the person has answered the pop-up (src/ui/Privacy.tsx, the shared text).
// No receiver (package.json "countEndpoint" empty - running from source): no pop-up, no switch, nothing sent.
// The ping goes from the update worker's process (update-worker.cjs "count"), with a time limit;
// no internet = nothing happens, the next try is an hour later.
// Settings: count = 'on' | 'off' (missing: not answered yet), countId, countDay (UTC day of the last ping).
'use strict';
const crypto = require('crypto');

const newId = () => crypto.randomBytes(16).toString('hex');
const osName = (platform) => (platform === 'win32' ? 'Windows' : 'Linux');
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * run(args) runs one update-worker job and resolves with its answer ({ ok } | { ok: false, err });
 * the rest are the app's settings and log
 */
function create({ endpoint = '', version, readSettings, writeSettings, run, log = () => {}, platform = process.platform, now = () => Date.now() }) {
  let busy = false;

  function state() {
    const s = readSettings();
    const available = !!endpoint;
    return { available, ask: available && s.count !== 'on' && s.count !== 'off', on: available && s.count === 'on' };
  }
  /** first start (and every start): the number, once the count can be on - never after "Turn it off" */
  function init() {
    if (!endpoint) return state();
    const s = readSettings();
    if (s.count !== 'off' && !(typeof s.countId === 'string' && /^[0-9a-f]{32}$/.test(s.countId))) writeSettings({ ...s, countId: newId() });
    return state();
  }
  /** the pop-up's answer, or the switch in Settings > Privacy */
  function set(on) {
    if (!endpoint) return state();
    const s = readSettings();
    if (on) {
      s.count = 'on';
      if (!(typeof s.countId === 'string' && /^[0-9a-f]{32}$/.test(s.countId))) s.countId = newId();
    } else {
      s.count = 'off';
      delete s.countId;
      delete s.countDay;
    }
    writeSettings(s);
    return state();
  }
  /** once a day: the ping, if the count is on and today's hasn't gone yet */
  async function tick() {
    if (!endpoint || busy) return false;
    const s = readSettings();
    if (s.count !== 'on' || typeof s.countId !== 'string' || !s.countId) return false;
    const today = dayOf(now());
    if (s.countDay === today) return false;
    busy = true;
    try {
      const r = await run(['count', endpoint, s.countId, String(version), osName(platform)]);
      if (r && r.ok) {
        const t = readSettings();
        // (turned off while it was on its way: nothing more is written)
        if (t.count === 'on' && t.countId === s.countId) writeSettings({ ...t, countDay: today });
        return true;
      }
      log('user count: not sent (' + ((r && r.err) || 'unknown') + ')');
      return false;
    } finally { busy = false; }
  }

  return { state, init, set, tick };
}

module.exports = { create, osName };
