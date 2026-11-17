// Rev Radar's licence (AGPL-3.0, because MuPDF is) and the notices of every part inside it
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

test('LICENSE is the GNU AGPL v3 text; package.json says so', () => {
  const l = fs.readFileSync('LICENSE', 'utf8');
  assert.match(l, /^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/);
  assert.ok(l.includes('END OF TERMS AND CONDITIONS'));
  assert.equal(pkg.license, 'AGPL-3.0-or-later');
});

test('THIRD-PARTY-NOTICES.txt names every part shipped, with its licence text, and is up to date', (t) => {
  const before = fs.readFileSync('THIRD-PARTY-NOTICES.txt', 'utf8');
  for (const [dep, name] of Object.entries({ mupdf: 'MuPDF', '@embedpdf/pdfium': 'PDFium', 'tesseract.js': 'Tesseract', 'tesseract.js-core': 'tesseract.js-core', react: 'React', 'react-dom': 'React DOM', fflate: 'fflate' })) {
    assert.ok(dep in pkg.dependencies, dep);
    assert.ok(before.includes(name), name);
  }
  for (const s of ['GNU AFFERO GENERAL PUBLIC LICENSE', 'Apache License', 'MIT License', 'SIL OPEN FONT LICENSE', 'Electron', 'klauspost/compress', 'go-webview2']) assert.ok(before.toUpperCase().includes(s.toUpperCase()), s);
  try { execFileSync('go', ['version'], { stdio: 'ignore' }); } catch (_) { t.skip('no Go here (its licence text is read from GOROOT)'); return; }
  execFileSync('python3', ['scripts/notices.py'], { stdio: 'ignore' });
  assert.equal(fs.readFileSync('THIRD-PARTY-NOTICES.txt', 'utf8'), before, 'scripts/notices.py makes a different file: run it and commit the result');
});

test('the app carries both (Settings > Help > Licences)', () => {
  // (the build copies them into dist/ - checked after a real build in public-scan.test.ts; one test
  //  builds, so two builds never run side by side)
  const b = fs.readFileSync('scripts/build.mjs', 'utf8');
  assert.ok(b.includes("copyFileSync('LICENSE', 'dist/LICENSE.txt')") && b.includes("copyFileSync('THIRD-PARTY-NOTICES.txt', 'dist/THIRD-PARTY-NOTICES.txt')"));
});
