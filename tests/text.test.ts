// PLAN T7: "Text as read" and Word files readable.
//  - engine: every paragraph of a file as read (headings by index, page and top of its first box, a table
//    row's cells), kept out of the result for PDFs (a side file), picture lines placed by the paragraph
//    above them, Word pictures by their media's hashes
//  - window: the text laid out to a width - heights from measured lines, a long paragraph whole
//  - electron/wordpdf.cjs: the converter order, the Word command, the soffice command, the timeout and kill
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { zipSync, strToU8 } from 'fflate';
import { docxParas, sectionsOf, docEntries, readingOf, readingChunks, zipMedia, type DocSection, type Para } from '../src/engine/docs';
import type { Pic } from '../src/engine/picdiff';
import { layoutText, wrapLines, geom, type LayBlock } from '../src/ui/textlay';

const docx = (paras: string[]): Uint8Array => zipSync({ 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${paras.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`) });
const secs = (file: string, paras: string[]) => sectionsOf(file, docxParas(file, docx(paras)));

test('reading: each paragraph once, in order - clause number, text, heading by index, place', () => {
  const O = secs('a.docx', ['PART 1 - GENERAL', '1.1 SUMMARY', 'A. Ducts are insulated.', 'B. Pipes are lagged.']);
  const rd = readingOf(O, []);
  const f = rd.o['a.docx'];
  assert.equal(f.rows.length, 4);
  assert.deepEqual(f.rows.map((r) => r[1]), ['GENERAL', 'SUMMARY', 'Ducts are insulated.', 'Pipes are lagged.']);
  assert.deepEqual(f.rows.map((r) => r[0]), ['PART 1', '1.1', 'A', 'B']);
  // (heading path through the table: the same string once)
  assert.equal(f.heads[f.rows[2][2]], f.heads[f.rows[3][2]]);
  assert.match(f.heads[f.rows[3][2]], /1\.1 SUMMARY/);
  assert.equal(f.heads.length, new Set(f.heads).size);
  // (a Word paragraph: page -1, its place in the file - as the anchors say it)
  assert.deepEqual(f.rows.map((r) => [r[3], r[4]]), [[-1, 0], [-1, 1], [-1, 2], [-1, 3]]);
});

test('reading: a PDF paragraph is placed by its first box (the anchors\' page and y); a table row keeps its cells', () => {
  const p = (i: number, extra: Partial<Para>): Para => ({ i, file: 'p.pdf', page: 1, num: '', text: 't' + i, head: 'H', ...extra });
  const s: DocSection = { key: 'k', num: '', title: 't', file: 'p.pdf', paras: [p(0, { seg: [[0, 10, 20, 100, 32]] }), p(1, { seg: [[2, 10, 44.5, 100, 52]], num: '2.07', cells: ['a', 'b'], text: 'a | b' }), p(2, {})] };
  const f = readingOf([s], []).o['p.pdf'];
  assert.deepEqual(f.rows.map((r) => [r[3], r[4]]), [[0, 20], [2, 44.5], [-1, 2]]);
  assert.deepEqual(f.rows[1][5], ['a', 'b']);
  assert.equal(f.rows[0][5], undefined);
});

test('reading: the PDFs\' paragraphs go to a side file in JSON pieces (the same as the object); the Word files\' stay in the result', () => {
  const O = secs('w.docx', ['A. one', 'B. two']);
  const pdfSec: DocSection = { key: 'k', num: '', title: 't', file: 'p.pdf', paras: Array.from({ length: 1000 }, (_, i) => ({ i, file: 'p.pdf', page: 1, num: i % 7 ? '' : '1.' + i, text: 'x "q" ' + i, head: 'H' + (i % 3), seg: [[0, 1, i, 3, 4]] })) };
  const all = [...O, pdfSec];
  const pdf = (_t: 'o' | 'n', f: string) => f === 'p.pdf';
  const pieces = [...readingChunks(all, all, pdf)];
  assert.ok(pieces.length > 4, 'in pieces, not one string');
  assert.deepEqual(JSON.parse(pieces.join('')), readingOf(all, all, pdf));
  const word = readingOf(all, all, (t, f) => !pdf(t, f));
  assert.deepEqual(Object.keys(word.o), ['w.docx']);
  assert.deepEqual(Object.keys(word.n), ['w.docx']);
  assert.ok(!('texts' in docEntries(all, all)), 'the old strings list is gone');
});

test('Word pictures: the media hashes of a .docx (central directory: no unzipping)', () => {
  const z = zipSync({ 'word/document.xml': strToU8('<w:document/>'), 'word/media/image1.png': new Uint8Array([1, 2, 3, 4]), 'word/media/image2.jpeg': new Uint8Array([9, 9, 9]), 'docProps/thumbnail.jpeg': new Uint8Array([7]) });
  const m = zipMedia(z);
  assert.equal(m.length, 2);
  assert.notEqual(m[0], m[1]);
  const z2 = zipSync({ 'word/document.xml': strToU8('<w:document/>'), 'word/media/image1.png': new Uint8Array([1, 2, 3, 5]), 'word/media/image2.jpeg': new Uint8Array([9, 9, 9]) });
  assert.notDeepEqual(zipMedia(z2).sort(), m.slice().sort());
  assert.deepEqual(zipMedia(new Uint8Array([1, 2, 3])), []);
});

test('Word without a converter: pictures changed -> one entry "open the file"; the same pictures -> none', () => {
  const O = secs('a.docx', ['A. one', 'B. two']), N = secs('a rev B.docx', ['A. one', 'B. two']);
  const same = docEntries(O, N, undefined, { o: new Map([['a.docx', ['1:4', '2:3']]]), n: new Map([['a rev B.docx', ['2:3', '1:4']]]) });
  assert.equal(same.entries.length, 0);
  const diff = docEntries(O, N, undefined, { o: new Map([['a.docx', ['1:4', '2:3']]]), n: new Map([['a rev B.docx', ['1:5', '2:3']]]) });
  assert.equal(diff.entries.length, 1);
  const e = diff.entries[0];
  assert.equal(e.kind, 'pic');
  assert.equal(e.cls, 'pic');
  assert.ok(e.pic?.word && e.pic.what === 'changed' && e.pic.whole);
  assert.equal(e.o?.after, -1);
  assert.match(e.n!.text, /open the file/i);
});

test('picture lines carry the paragraph above them as an index in the file (the text view puts the placeholder there)', () => {
  const O = secs('a.pdf', ['A. one', 'B. two', 'C. three']), N = secs('a.pdf', ['A. one', 'B. two', 'C. three']);
  const pic = (sha: string): Pic => ({ file: 'a.pdf', page: 0, box: [10, 10, 200, 100], pw: 10, ph: 10, sha });
  O[0].pics = [{ p: pic('x'), after: 1 }]; N[0].pics = [{ p: pic('y'), after: 1 }];
  const r = docEntries(O, N, { judge: () => ({ same: false, why: ['ink'], text: false, whole: true, o: [], n: [] }), look: () => undefined });
  const e = r.entries.find((x) => x.kind === 'pic')!;
  assert.equal(e.o!.after, 1);
  assert.equal(e.n!.after, 1);
  assert.ok(e.o!.pic && e.n!.pic);
});

// ---------------------------------------------------------------- the layout
const ch = (s: string) => s.length * 7; // a face 7 px a character
const blk = (o: Partial<LayBlock>): LayBlock => ({ head: '', num: '', text: '', ...o });

test('wrapLines: words, a word longer than the line breaks anywhere', () => {
  assert.equal(wrapLines('aaa bbb ccc', 100, ch), 1);
  assert.equal(wrapLines('aaa bbb ccc', 70, ch), 2);
  assert.equal(wrapLines('x'.repeat(50), 100, ch), 4);
  assert.equal(wrapLines('', 100, ch), 1);
});

test('layout: a 300-character paragraph is taller than one row; every block as high as its lines; tops add up', () => {
  const g = geom(1);
  const long = ('word '.repeat(60)).trim(); // 299 characters
  const L = layoutText([blk({ num: '1.1', text: 'short' }), blk({ num: 'A.', text: long, head: 'PART 1 › 1.1 X' }), blk({ text: 'tail' })], 600, 1, ch);
  const lines = wrapLines(long, 600 - g.numW - 2 * g.padX, ch);
  assert.ok(lines >= 3, `lines ${lines}`);
  assert.equal(L.hs[0], g.padY + g.lh);
  assert.equal(L.hs[1], g.headH + g.padY + lines * g.lh);
  assert.ok(L.hs[1] > 22 * 3, `${L.hs[1]} px for 300 characters (a row was 22)`);
  assert.deepEqual(L.tops, [0, L.hs[0], L.hs[0] + L.hs[1]]);
  assert.equal(L.total, L.hs[0] + L.hs[1] + L.hs[2]);
  // (wider: fewer lines; bigger zoom: bigger)
  assert.ok(layoutText([blk({ text: long })], 1200, 1, ch).hs[0] < layoutText([blk({ text: long })], 400, 1, ch).hs[0]);
  assert.ok(layoutText([blk({ text: 'a' })], 600, 2, (s) => s.length * 14).hs[0] > layoutText([blk({ text: 'a' })], 600, 1, ch).hs[0]);
});

test('layout: a table row is as high as its tallest cell; a picture is one line', () => {
  const g = geom(1);
  const cells = ['short', 'x '.repeat(80).trim(), 'mid cell'];
  const L = layoutText([blk({ num: '2.07', text: cells.join(' | '), cells }), blk({ pic: 'Picture changed' })], 600, 1, ch);
  const cw = (600 - g.numW - 2 * g.padX) / 3 - 2 * g.cellPad;
  assert.equal(L.hs[0], g.padY + wrapLines(cells[1], cw, ch) * g.lh);
  assert.equal(L.hs[1], g.padY + g.lh);
});

test('layout: place <-> pixels (a block index and a fraction of it)', () => {
  const L = layoutText([blk({ text: 'a' }), blk({ text: 'b '.repeat(100) }), blk({ text: 'c' })], 300, 1, ch);
  assert.equal(L.px(1), L.tops[1]);
  assert.equal(L.px(1.5), L.tops[1] + L.hs[1] / 2);
  assert.equal(L.unit(L.tops[2] + L.hs[2] / 4), 2.25);
  assert.equal(L.unit(-10), 0);
  assert.equal(L.px(99), L.total);
});

// ---------------------------------------------------------------- the converter
const req = createRequire(import.meta.url);
type W = { makeConverter: (d: Record<string, unknown>) => { convert(p: string): Promise<{ ok: boolean; pdf?: string; by?: string; why?: string; cached?: boolean }>; clean(): void; root: string }; wordScript: (s: string, o: string) => string; encodePs: (s: string) => string; sofficeCandidates: (p: string, env: Record<string, string>) => string[]; cacheName: (p: string, size: number, mtime: number) => string; spawnRun: (c: string, a: string[], o: { timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> };
const wp: () => W = () => req('../electron/wordpdf.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rr-wp-'));
const mkDocx = (dir: string, name = 'a.docx') => { const f = path.join(dir, name); fs.writeFileSync(f, Buffer.from(docx(['A. x']))); return f; };
type Call = { cmd: string; args: string[] };
const decode = (args: string[]) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

test('converter: Word first on Windows - a hidden, read-only, alerts-off COM script that always quits; the PDF is where the hash says', async () => {
  const dir = tmp(), f = mkDocx(dir), calls: Call[] = [];
  const c = wp().makeConverter({ platform: 'win32', env: { RR_ON: 'docxpdf' }, tmpdir: dir, run: async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const m = /\$out = '([^']+)'/.exec(decode(args))!;
    fs.writeFileSync(m[1].replace(/''/g, "'"), '%PDF-1.4 fake');
    return { code: 0, stdout: 'WORDPID:4242\nOK\n', stderr: '', timedOut: false };
  } });
  const r = await c.convert(f);
  assert.ok(r.ok && r.by === 'Word', JSON.stringify(r));
  assert.equal(calls.length, 1);
  assert.match(calls[0].cmd, /powershell/i);
  for (const a of ['-NoProfile', '-NonInteractive', '-EncodedCommand']) assert.ok(calls[0].args.includes(a), a);
  const s = decode(calls[0].args);
  assert.match(s, /Word\.Application/);
  assert.match(s, /\.Visible = \$false/);
  assert.match(s, /\.DisplayAlerts = 0/);
  assert.match(s, /Documents\.Open\(\$src, \$false, \$true/); // (not to confirm conversions, read only)
  assert.match(s, /ExportAsFixedFormat\(\$out, 17\)/);
  assert.match(s, /SaveAs2\(\$out, 17\)/); // (the fallback)
  assert.match(s, /finally[\s\S]*Quit\(\$false\)/); // (always quit)
  assert.ok(r.pdf!.startsWith(path.join(dir, 'rev-radar')), r.pdf);
  assert.ok(fs.existsSync(r.pdf!));
  // (named by path + size + mtime; again: re-used, nothing run)
  const st = fs.statSync(f);
  assert.equal(path.basename(r.pdf!), wp().cacheName(f, st.size, st.mtimeMs) + '.pdf');
  const r2 = await c.convert(f);
  assert.ok(r2.ok && r2.cached && r2.pdf === r.pdf && calls.length === 1);
  // (the file changed: another name)
  fs.appendFileSync(f, 'x');
  assert.notEqual((await c.convert(f)).pdf, r.pdf);
  c.clean();
  assert.ok(!fs.existsSync(c.root), 'cleaned when the app quits');
});

test('converter: the path with a quote is escaped in the script', async () => {
  const dir = tmp(), f = mkDocx(dir, "it's a spec.docx");
  let script = '';
  const c = wp().makeConverter({ platform: 'win32', env: { RR_ON: 'docxpdf' }, tmpdir: dir, run: async (_c: string, args: string[]) => { script = decode(args); fs.writeFileSync(/\$out = '([^']+)'/.exec(script)![1], 'x'); return { code: 0, stdout: '', stderr: '', timedOut: false }; } });
  await c.convert(f);
  assert.ok(script.includes("it''s a spec.docx"), script.slice(0, 300));
});

test('converter: Word fails -> LibreOffice (Program Files too on Windows); both fail -> none with the reasons', async () => {
  const dir = tmp(), f = mkDocx(dir), calls: Call[] = [];
  const lo = path.join(dir, 'LibreOffice', 'program', 'soffice.exe');
  fs.mkdirSync(path.dirname(lo), { recursive: true }); fs.writeFileSync(lo, '');
  const mk = (word: boolean, soffice: boolean) => wp().makeConverter({ platform: 'win32', env: { RR_ON: 'docxpdf', ProgramFiles: dir, 'ProgramFiles(x86)': path.join(dir, 'none') }, tmpdir: dir,
    run: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (/powershell/i.test(cmd)) return word ? (fs.writeFileSync(/\$out = '([^']+)'/.exec(decode(args))![1], 'x'), { code: 0, stdout: '', stderr: '', timedOut: false }) : { code: 1, stdout: '', stderr: 'Retrieving the COM class factory for component with CLSID failed', timedOut: false };
      if (!soffice) return { code: 1, stdout: '', stderr: 'Error: source file could not be loaded', timedOut: false };
      const outdir = args[args.indexOf('--outdir') + 1];
      fs.writeFileSync(path.join(outdir, path.basename(f).replace(/\.docx$/, '.pdf')), '%PDF');
      return { code: 0, stdout: 'convert ...', stderr: '', timedOut: false };
    } });
  const r = await mk(false, true).convert(f);
  assert.ok(r.ok && r.by === 'LibreOffice', JSON.stringify(r));
  const so = calls.find((x) => !/powershell/i.test(x.cmd))!;
  assert.equal(so.cmd, lo);
  for (const a of ['--headless', '--convert-to', 'pdf', '--outdir']) assert.ok(so.args.includes(a), a);
  assert.ok(so.args.some((a) => /^-env:UserInstallation=file:\/\//.test(a)), 'a profile of its own: a LibreOffice the person has open is not touched');
  assert.equal(so.args.at(-1), f);
  const none = await mk(false, false).convert(mkDocx(dir, 'b.docx'));
  assert.ok(!none.ok);
  assert.match(none.why!, /Word/);
  assert.match(none.why!, /LibreOffice/);
});

test('converter: no Word on Linux, soffice from the PATH or /usr/bin; nowhere -> none, "needs Word or LibreOffice"', async () => {
  assert.ok(wp().sofficeCandidates('win32', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }).some((x) => /Program Files.*LibreOffice.*program.*soffice\.exe$/i.test(x)));
  assert.ok(wp().sofficeCandidates('linux', {}).includes('/usr/bin/soffice'));
  const dir = tmp(), f = mkDocx(dir), calls: Call[] = [];
  const c = wp().makeConverter({ platform: 'linux', env: { RR_ON: 'docxpdf' }, tmpdir: dir, find: () => null, run: async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 1, stdout: '', stderr: '', timedOut: false }; } });
  const r = await c.convert(f);
  assert.ok(!r.ok);
  assert.equal(calls.length, 0, 'nothing to run');
  assert.match(r.why!, /Microsoft Word or LibreOffice/);
});

test('converter: off by default in 0.5.0 (Engineer, 17 Nov) and with RR_OFF=docxpdf - nothing run, Word files compared as text', async () => {
  const dir = tmp(), f = mkDocx(dir);
  for (const env of [{}, { RR_OFF: 'tables,docxpdf' }, { RR_ON: 'docxpdf', RR_OFF: 'docxpdf' }]) {
    const c = wp().makeConverter({ platform: 'win32', env, tmpdir: dir, run: async () => { throw new Error('must not run'); } });
    const r = await c.convert(f) as { ok: boolean; why?: string; off?: boolean };
    assert.ok(!r.ok && r.off, JSON.stringify(env));
    assert.match(r.why!, /compared as their text/);
  }
});

test('converter: 90 s then the Word process and its Word are killed, the next converter tried', async () => {
  const dir = tmp(), f = mkDocx(dir), killed: number[] = [], calls: string[] = [];
  const c = wp().makeConverter({ platform: 'win32', env: { RR_ON: 'docxpdf' }, tmpdir: dir, timeoutMs: 90000, killPid: (pid: number) => killed.push(pid), find: () => null,
    run: async (cmd: string, _a: string[], o: { timeoutMs: number }) => { calls.push(cmd + ' ' + o.timeoutMs); return { code: null, stdout: 'WORDPID:777\n', stderr: '', timedOut: true }; } });
  const r = await c.convert(f);
  assert.ok(!r.ok);
  assert.deepEqual(calls, ['powershell.exe 90000']);
  assert.deepEqual(killed, [777], 'the Word instance this run started - not the person\'s own Word');
  assert.match(r.why!, /90 s/);
});

test('converter runner: a command past its time is killed (the whole tree) and says so', async () => {
  const t0 = Date.now();
  const r = await wp().spawnRun(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 400 });
  assert.ok(r.timedOut);
  assert.ok(Date.now() - t0 < 5000);
  const ok = await wp().spawnRun(process.execPath, ['-e', 'console.log("hi")'], { timeoutMs: 5000 });
  assert.ok(!ok.timedOut && ok.code === 0 && /hi/.test(ok.stdout));
});
