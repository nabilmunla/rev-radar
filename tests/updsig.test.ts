// Signed updates (electron/updsig.cjs): only a latest.json signed with the publisher's key is taken
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { verifyLatest, signLatest, PUBLIC_KEY } = require('../electron/updsig.cjs');

const pair = () => { const k = crypto.generateKeyPairSync('ed25519'); return { priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, pub: k.publicKey.export({ type: 'spki', format: 'pem' }) as string }; };
const payload = { product: 'Rev Radar', version: '0.5.1', runtime: '44.9.3', app: { file: 'app-v0.5.1.zip', sha256: 'a'.repeat(64), size: 10 } };

test('a signed latest.json gives what was signed - not the plain fields beside it', () => {
  const k = pair();
  const j = signLatest(payload, k.priv);
  // (the plain fields are for copies before 0.5.0: someone changing them changes nothing here)
  const swapped = { ...j, app: { file: 'evil.zip', sha256: 'b'.repeat(64), size: 10 } };
  const r = verifyLatest(swapped, k.pub);
  assert.deepEqual(r.latest, payload);
});

test('unsigned, signed with another key, or changed after signing: refused', () => {
  const k = pair(), other = pair();
  assert.match(verifyLatest(payload, k.pub).err, /not signed/);
  assert.match(verifyLatest({ ...payload, signed: JSON.stringify(payload) }, k.pub).err, /not signed/);
  assert.match(verifyLatest(signLatest(payload, other.priv), k.pub).err, /doesn't match/);
  const j = signLatest(payload, k.priv);
  assert.match(verifyLatest({ ...j, signed: j.signed.replace('a'.repeat(64), 'c'.repeat(64)) }, k.pub).err, /doesn't match/);
  assert.match(verifyLatest({ ...j, signature: Buffer.from('x'.repeat(64)).toString('base64') }, k.pub).err, /doesn't match/);
  assert.match(verifyLatest(null).err, /not signed/);
});

test("the key in the app is the publisher's (keys/ on the developer's copy)", (t) => {
  const f = 'keys/rev-radar-update-signing.pem';
  if (!fs.existsSync(f)) { t.skip('no signing key on this copy (the public source has none)'); return; }
  const j = signLatest(payload, fs.readFileSync(f, 'utf8'));
  assert.deepEqual(verifyLatest(j).latest, payload);
  assert.equal(crypto.createPublicKey(fs.readFileSync(f, 'utf8')).export({ type: 'spki', format: 'pem' }), PUBLIC_KEY);
});
