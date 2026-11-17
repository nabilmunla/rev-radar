// The repository's README (the GitHub page): the motto word for word, one screenshot per tab, and
// what it promises about privacy matches what the app does (outbound.test.ts, count.test.ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const md = fs.readFileSync('README.md', 'utf8');

test('the motto, word for word', () => {
  assert.ok(md.includes("Let's help the people get through the tough work, the tough grind."));
});

test('one screenshot per tab, each there', () => {
  const pics = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(pics, ['assets/readme/drawings.png', 'assets/readme/boq.png', 'assets/readme/documents.png']);
  for (const p of pics) assert.ok(fs.statSync(p).size > 20000, p);
});

test('download, updates, privacy, licence, maker', () => {
  for (const s of ['https://github.com/nabilmunla/rev-radar/releases', 'signed', 'works offline', 'Send', 'crash reports', 'once a day', 'GNU Affero General Public License', 'Made by Nabil Munla']) assert.ok(md.includes(s), s);
  assert.ok(!/\/home\/|[A-Z]:\\/.test(md), 'no paths of this machine');
});
