// Updates from the web (feed.cjs): GitHub releases or any web address - the addresses asked for
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const feed = require('../electron/feed.cjs');

test('a GitHub repository: the newest release, each package from its own version', () => {
  const r = 'https://github.com/someone/rev-radar';
  for (const v of [r, r + '/', r + '.git']) assert.deepEqual(feed.github(v), { owner: 'someone', repo: 'rev-radar' });
  assert.equal(feed.latestUrl(r), r + '/releases/latest/download/latest.json');
  assert.equal(feed.fileUrl(r, '1.2.3', 'app-v1.2.3.zip'), r + '/releases/download/v1.2.3/app-v1.2.3.zip');
  assert.equal(feed.fileUrl(r, '1.2.3', 'Rev Radar Setup 1.2.3.exe'), r + '/releases/download/v1.2.3/Rev%20Radar%20Setup%201.2.3.exe');
  // (a file name can't reach outside the release)
  assert.equal(feed.fileUrl(r, '1.2.3', '../../x/evil.zip'), r + '/releases/download/v1.2.3/evil.zip');
  assert.equal(feed.releasePage(r, '1.2.3'), r + '/releases/tag/v1.2.3');
  assert.equal(feed.releasePage(r, ''), r + '/releases/latest');
});

test('any other web address: files side by side; folders are not the web', () => {
  const w = 'http://127.0.0.1:8080/feed';
  assert.ok(feed.isWeb(w) && feed.isWeb('HTTPS://x.y/') && !feed.isWeb('\\\\server\\share\\Rev Radar') && !feed.isWeb('C:\\updates') && !feed.isWeb(''));
  assert.equal(feed.github(w), null);
  assert.equal(feed.github('https://github.com/someone'), null);
  assert.equal(feed.latestUrl(w + '/'), w + '/latest.json');
  assert.equal(feed.fileUrl(w, '1.0.0', 'app-v1.0.0.zip'), w + '/app-v1.0.0.zip');
  assert.equal(feed.releasePage(w, '1.0.0'), w);
  assert.equal(feed.issueUrl(w, 't', 'b'), '', 'no issues page outside GitHub');
});

test('a problem report as a new GitHub issue: text filled in, cut to a length browsers take', () => {
  const r = 'https://github.com/someone/repo';
  const u = feed.issueUrl(r, 'Crash on open', 'It crashed & burned\nVersion 1.0');
  assert.ok(u.startsWith(r + '/issues/new?title=Crash%20on%20open&body='));
  assert.equal(decodeURIComponent(u.split('body=')[1]), 'It crashed & burned\nVersion 1.0');
  const long = feed.issueUrl(r, 'x', 'ي'.repeat(20000));
  assert.ok(long.length <= 7000 && decodeURIComponent(long.split('body=')[1]).endsWith('…'), 'long text (Arabic: 6 bytes each in the address) cut, marked');
});

test("every copy reads Rev Radar's own GitHub releases", () => {
  assert.equal(feed.FEED, 'https://github.com/nabilmunla/rev-radar');
  assert.equal(feed.latestUrl(feed.FEED), 'https://github.com/nabilmunla/rev-radar/releases/latest/download/latest.json');
  assert.equal(feed.fileUrl(feed.FEED, '0.5.1', 'app-v0.5.1.zip'), 'https://github.com/nabilmunla/rev-radar/releases/download/v0.5.1/app-v0.5.1.zip');
});

// DeepSeek bug 27: a folder feed whose latest.json names another runtime -> the card's "Show the setup"
// selects the setup FILE the worker found, not the folder. The real updater.cjs + update-worker.cjs run
// here; only electron's utilityProcess (a node child with a parentPort) and the signing key are stand-ins.
test('a new runtime from a folder feed: setupPath is the setup file, not the folder', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), cp = await import('node:child_process'), crypto = await import('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-feed27-'));
  const dir = path.join(root, 'updates'); fs.mkdirSync(dir);
  const wrapper = path.join(root, 'fork.cjs');
  fs.writeFileSync(wrapper, `process.parentPort = { postMessage: (m) => process.send(m) };\nrequire(${JSON.stringify(path.resolve('electron/update-worker.cjs'))});\n`);
  const kp = crypto.generateKeyPairSync('ed25519');
  const pub = kp.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const sign = (o: object) => { const signed = JSON.stringify(o, null, 2); return { ...o, signed, signature: crypto.sign(null, Buffer.from(signed, 'utf8'), kp.privateKey).toString('base64') }; };
  fs.writeFileSync(path.join(dir, 'Rev-Radar-Setup-9.9.9.exe'), 'x');
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(sign({ product: 'Rev Radar', version: '9.9.9', runtime: '999.0.0', notes: ['n'], setup: { file: 'Rev-Radar-Setup-9.9.9.exe', sha256: 'a'.repeat(64), size: 1 } })));
  const updaterPath = path.resolve('electron/updater.cjs'), sigPath = path.resolve('electron/updsig.cjs');
  const realSig = require(sigPath);
  const fakeElectron = {
    utilityProcess: { fork: (_m: string, args: string[]) => { const c = cp.fork(wrapper, args, { silent: true }); return Object.assign(c, { kill: () => c.kill() }); } },
    powerMonitor: { on() {} },
  };
  const electronPath = createRequire(updaterPath).resolve('electron');
  const saved = { e: require.cache[electronPath], s: require.cache[sigPath], u: require.cache[updaterPath], env: process.env.RR_UPDATE_FEED };
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fakeElectron } as never;
  require.cache[sigPath] = { id: sigPath, filename: sigPath, loaded: true, exports: { ...realSig, verifyLatest: (j: unknown) => realSig.verifyLatest(j, pub) } } as never;
  delete require.cache[updaterPath];
  process.env.RR_UPDATE_FEED = dir;
  try {
    const u = require(updaterPath).create({ version: '0.1.0', readSettings: () => ({}), writeSettings() {}, log() {}, send() {} });
    const s = await u.check(true);
    assert.equal(s.state, 'setup');
    assert.equal(s.setupPath, path.join(dir, 'Rev-Radar-Setup-9.9.9.exe'), 'the file, not the folder');
    assert.deepEqual(u.setupTarget(), { file: path.join(dir, 'Rev-Radar-Setup-9.9.9.exe'), dir, url: '' });
  } finally {
    for (const [p, v] of [[electronPath, saved.e], [sigPath, saved.s], [updaterPath, saved.u]] as const) { if (v) require.cache[p] = v; else delete require.cache[p]; }
    if (saved.env === undefined) delete process.env.RR_UPDATE_FEED; else process.env.RR_UPDATE_FEED = saved.env;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
