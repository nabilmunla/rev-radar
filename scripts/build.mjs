// Build: the interface (dist/) and the engine process (electron/engine.mjs).
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const prod = !process.argv.includes('--dev');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
// MuPDF (monster sheets, see src/engine/heavy.ts) stays a module of its own next to the engine:
// it loads its .wasm from its own folder
rmSync('electron/mupdf', { recursive: true, force: true });
mkdirSync('electron/mupdf', { recursive: true });
for (const f of ['mupdf.js', 'mupdf-wasm.js', 'mupdf-wasm.wasm']) copyFileSync(join('node_modules/mupdf/dist', f), join('electron/mupdf', f));
writeFileSync('electron/mupdf/package.json', JSON.stringify({ type: 'module' }) + '\n');
await build({
  entryPoints: { engine: 'src/engine/host.ts' },
  outdir: 'electron',
  outExtension: { '.js': '.mjs' },
  bundle: true, format: 'esm', platform: 'node', target: 'node22',
  minify: prod, legalComments: 'none', logLevel: 'warning',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [{ name: 'mupdf-external', setup(b) { b.onResolve({ filter: /^mupdf$/ }, () => ({ path: './mupdf/mupdf.js', external: true })); } }],
});
await build({
  entryPoints: { app: 'src/ui/main.tsx' },
  outdir: 'dist',
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome140',
  minify: prod, sourcemap: !prod, legalComments: 'none', logLevel: 'warning',
  jsx: 'automatic',
  loader: { '.woff2': 'file', '.woff': 'file', '.svg': 'text' },
  assetNames: 'assets/[name]-[hash]',
  define: { 'process.env.NODE_ENV': prod ? '"production"' : '"development"' },
});
copyFileSync('node_modules/@embedpdf/pdfium/dist/pdfium.wasm', 'dist/pdfium.wasm');
copyFileSync('public/icon256.png', 'dist/icon256.png');
// the licences (Settings > Help > Licences; the AGPL's notices travel with the app)
copyFileSync('LICENSE', 'dist/LICENSE.txt');
copyFileSync('THIRD-PARTY-NOTICES.txt', 'dist/THIRD-PARTY-NOTICES.txt');
// (this version's notes, for the "what's new" after a setup run over an older copy - electron/versions.cjs bundledNotes)
{ const v = JSON.parse(readFileSync('package.json', 'utf8')).version; const n = JSON.parse(readFileSync('release-notes.json', 'utf8'))[v]; writeFileSync('dist/release-notes.json', JSON.stringify(n ? { [v]: n } : {}) + '\n'); }
// OCR (scanned BOQs and documents): Tesseract's worker, its engines (LSTM only - the one the app
// asks for) and English, served from the app - nothing is fetched from the internet
mkdirSync('dist/ocr/core', { recursive: true });
mkdirSync('dist/ocr/lang', { recursive: true });
copyFileSync('node_modules/tesseract.js/dist/worker.min.js', 'dist/ocr/worker.min.js');
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) copyFileSync(join('node_modules/tesseract.js-core', f), join('dist/ocr/core', f));
for (const f of ['eng']) copyFileSync(`assets/ocr-lang/${f}.traineddata.gz`, `dist/ocr/lang/${f}.traineddata.gz`);
const v = JSON.parse(readFileSync('package.json', 'utf8')).version;
writeFileSync('dist/index.html', `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>Rev Radar</title><link rel="stylesheet" href="app.css"><meta name="rr-version" content="${v}"></head>
<body><div id="root"></div><script type="module" src="app.js"></script></body></html>
`);
console.log('built', v);
