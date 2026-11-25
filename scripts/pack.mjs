// Payload for the PC: node scripts/pack.mjs -> build/
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';
import { stampReadme } from './stamp-readme.mjs';
execSync('node scripts/build.mjs', { stdio: 'inherit' });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const v = pkg.version;
// clear the payload files, but never a publish folder (build/publish-v*) made before
mkdirSync('build', { recursive: true });
for (const f of readdirSync('build')) if (!f.startsWith('publish-v')) rmSync(join('build', f), { recursive: true, force: true });
const files = {};
const add = (p, as = p) => { files[as.replace(/\\/g, '/')] = new Uint8Array(readFileSync(p)); };
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (!p.endsWith('.map')) add(p); } };
walk('dist');
// (every main-process file: a list once left a new one out - the app then can't start)
for (const f of readdirSync('electron').sort()) if (/\.(cjs|mjs)$/.test(f)) add(join('electron', f));
for (const f of ['mupdf.js', 'mupdf-wasm.js', 'mupdf-wasm.wasm', 'package.json']) add(join('electron', 'mupdf', f));
// (the released build sends reports and the user count to the developer's receiver - the PDF Editor's
//  Cloudflare worker, live 17 Nov 2026; running from source names none, so a fork or a test sends nothing)
const RECEIVER = 'https://greenline-reports.n-munla.workers.dev';
files['package.json'] = new TextEncoder().encode(JSON.stringify({ name: pkg.name, productName: pkg.productName, version: v, main: pkg.main, private: true, reportEndpoint: RECEIVER, countEndpoint: RECEIVER }, null, 2));
writeFileSync(`build/app-v${v}.zip`, zipSync(files, { level: 6 }));
await build({ entryPoints: ['pack/patch-exe.mjs'], outfile: 'build/patch-exe.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'warning' });
copyFileSync('pack/install.py', 'build/install.py');
copyFileSync('public/app.ico', 'build/app.ico');
writeFileSync('build/README.txt', stampReadme(readFileSync('pack/README.txt', 'utf8'), v));
console.log('payload', v, Object.keys(files).length, 'files');
