// What leaves the PC besides updates (T12) - the only two kinds of request Rev Radar makes, both to
// the developer's own small receiver (the PDF Editor's Cloudflare worker, told apart by "app"):
//   - a problem / crash report, anonymised first (anon.cjs) - reports.cjs
//   - the once-a-day user count: a random number, the version, the OS - counter.cjs
// Where: package.json "reportEndpoint" / "countEndpoint" (the receiver's address; /report and /count
// are added). Empty (running from source, and the tests): nothing is ever sent. The released build's
// package.json gets the receiver from scripts/pack.mjs (RECEIVER). Both are sent from the update worker's process
// (update-worker.cjs), with a time limit; no internet = nothing happens.
// (x-report-client: a web page can't send a custom header without asking first, so a site can't make
// its visitors' browsers post to the receiver - the receiver refuses requests without it)
'use strict';

const CLIENT = 'rev-radar';
const at = (endpoint, route) => {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  return base.endsWith('/' + route) ? base : base + '/' + route;
};

/** a report (already anonymised) as it is posted */
function reportRequest(endpoint, body) {
  return { url: at(endpoint, 'report'), init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-report-client': CLIENT }, body: JSON.stringify(body) } };
}

/** the OS as the receiver takes it: win | linux | mac */
const osKey = (os) => (/^win/i.test(String(os)) ? 'win' : /^(mac|darwin)/i.test(String(os)) ? 'mac' : 'linux');

/** the user count's ping: exactly three things - the random number, the version, the OS - in the shape
 *  the receiver takes (the PDF Editor's worker, 17 Nov): {"id":"<32 lowercase hex>","v":"d.d.d","os":"win|linux|mac"} */
function countRequest(endpoint, { id, version, os }) {
  return { url: at(endpoint, 'count'), init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-report-client': CLIENT }, body: JSON.stringify({ id: String(id).toLowerCase(), v: String(version), os: osKey(os) }) } };
}

/** Electron's network stack where this process has it (the PC's proxy settings), else Node's */
function fetcher() {
  try { const { net } = require('electron'); if (net && typeof net.fetch === 'function') return (u, i) => net.fetch(u, i); } catch (_) { /* not here */ }
  return (u, i) => fetch(u, i);
}

/** the receiver's address from package.json (tests: RR_REPORT_ENDPOINT / RR_COUNT_ENDPOINT) */
function endpoint(kind, pkg) {
  const env = kind === 'count' ? process.env.RR_COUNT_ENDPOINT : process.env.RR_REPORT_ENDPOINT;
  const v = env !== undefined ? env : pkg && pkg[kind === 'count' ? 'countEndpoint' : 'reportEndpoint'];
  const s = String(v || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

module.exports = { reportRequest, countRequest, fetcher, endpoint, CLIENT };
