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

const NEW_LINE = 'Drawings: an amount on a bill of quantities page among the drawings is not taken for a sheet number any more';

test('bug 29: the wrong 0.6.0 line is gone, the corrected one is in the notes and the release body', () => {
  for (const f of ['release-notes.json', 'docs/RELEASE-BODY-0.6.0.md', 'README.md', 'pack/README.txt']) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes('listed as BOQ pages'), f);
  }
  assert.ok(fs.readFileSync('release-notes.json', 'utf8').includes(NEW_LINE));
  assert.ok(fs.readFileSync('docs/RELEASE-BODY-0.6.0.md', 'utf8').includes(NEW_LINE.replace('Drawings: ', '**Drawings:** ')));
});

test('bug 30: the manual\'s first line is stamped with the package version', async () => {
  const { stampReadme } = await import('../scripts/stamp-readme.mjs');
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const stamped = stampReadme(fs.readFileSync('pack/README.txt', 'utf8'), version);
  assert.equal(stamped.split('\n')[0].split(' ')[2], version);
  assert.ok(stamped.startsWith('REV RADAR ' + version + ' - '));
});

test('bug 30: the manual names the panel edge, [ and ], the divider and Stop', () => {
  const man = fs.readFileSync('pack/README.txt', 'utf8');
  for (const s of ['panel', 'edge', '[', ']', 'divider', 'Stop']) assert.ok(man.includes(s), s);
});
