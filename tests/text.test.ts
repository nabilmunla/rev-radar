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
type W = { makeConverter: (d: Record<string, unknown>) => { convert(p: string): Promise<{ ok: boolean; pdf?: string; by?: string; why?: string; cached?: boolean }>; clean(): void; stop(): void; root: string }; wordScript: (s: string, o: string) => string; encodePs: (s: string) => string; sofficeCandidates: (p: string, env: Record<string, string>) => string[]; cacheName: (p: string, size: number, mtime: number) => string; spawnRun: (c: string, a: string[], o: { timeoutMs: number; onSpawn?: (pid: number) => void; onStdout?: (s: string) => void }) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> };
const wp: () => W = () => req('../electron/wordpdf.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rr-wp-'));
const mkDocx = (dir: string, name = 'a.docx') => { const f = path.join(dir, name); fs.writeFileSync(f, Buffer.from(docx(['A. x']))); return f; };
type Call = { cmd: string; args: string[] };
const decode = (args: string[]) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

test('converter: Word first on Windows - a hidden, read-only, alerts-off COM script that always quits; the PDF is where the hash says', async () => {
  const dir = tmp(), f = mkDocx(dir), calls: Call[] = [];
  const c = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, run: async (cmd: string, args: string[]) => {
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
  assert.match(s, /finally[\s\S]*Quit\(\[ref\]0\)/); // (always quit - by reference, T16a)
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
  const c = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, run: async (_c: string, args: string[]) => { script = decode(args); fs.writeFileSync(/\$out = '([^']+)'/.exec(script)![1], 'x'); return { code: 0, stdout: '', stderr: '', timedOut: false }; } });
  await c.convert(f);
  assert.ok(script.includes("it''s a spec.docx"), script.slice(0, 300));
});

test('converter: Word fails -> LibreOffice (Program Files too on Windows); both fail -> none with the reasons', async () => {
  const dir = tmp(), f = mkDocx(dir), calls: Call[] = [];
  const lo = path.join(dir, 'LibreOffice', 'program', 'soffice.exe');
  fs.mkdirSync(path.dirname(lo), { recursive: true }); fs.writeFileSync(lo, '');
  const mk = (word: boolean, soffice: boolean) => wp().makeConverter({ platform: 'win32', env: { ProgramFiles: dir, 'ProgramFiles(x86)': path.join(dir, 'none') }, tmpdir: dir,
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
  const c = wp().makeConverter({ platform: 'linux', env: {}, tmpdir: dir, find: () => null, run: async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 1, stdout: '', stderr: '', timedOut: false }; } });
  const r = await c.convert(f);
  assert.ok(!r.ok);
  assert.equal(calls.length, 0, 'nothing to run');
  assert.match(r.why!, /Microsoft Word or LibreOffice/);
});

test('converter: on by default (T16b) - no RR_ON needed; off only with RR_OFF=docxpdf (0.5.0\'s behaviour: nothing run, Word files compared as text)', async () => {
  const dir = tmp(), f = mkDocx(dir);
  for (const env of [{ RR_OFF: 'docxpdf' }, { RR_OFF: 'tables,docxpdf' }, { RR_ON: 'docxpdf', RR_OFF: 'docxpdf' }]) {
    const c = wp().makeConverter({ platform: 'win32', env, tmpdir: dir, run: async () => { throw new Error('must not run'); } });
    const r = await c.convert(f) as { ok: boolean; why?: string; off?: boolean };
    assert.ok(!r.ok && r.off, JSON.stringify(env));
    assert.match(r.why!, /compared as their text/);
  }
  // (on with an empty environment, with RR_ON as 0.5.0 asked for it, and with other parts switched off)
  for (const env of [{}, { RR_ON: 'docxpdf' }, { RR_OFF: 'tables' }]) {
    const calls: Call[] = [];
    const c = wp().makeConverter({ platform: 'win32', env, tmpdir: dir, run: async (cmd: string, args: string[]) => { calls.push({ cmd, args }); fs.writeFileSync(/\$out = '([^']+)'/.exec(decode(args))![1], '%PDF'); return { code: 0, stdout: 'WORDPID:1\nOK\n', stderr: '', timedOut: false }; } });
    const r = await c.convert(f);
    assert.ok(r.ok && r.by === 'Word' && calls.length === 1, JSON.stringify(env) + ' ' + JSON.stringify(r));
    c.clean();
  }
});

test('converter: no RR_ON, a fake converter that works - a .docx is converted (Word on Windows, LibreOffice on Linux), and says by which', async () => {
  const dir = tmp(), f = mkDocx(dir), calls: Call[] = [];
  const w = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, run: async (cmd: string, args: string[]) => { calls.push({ cmd, args }); fs.writeFileSync(/\$out = '([^']+)'/.exec(decode(args))![1], '%PDF'); return { code: 0, stdout: 'OK', stderr: '', timedOut: false }; } });
  const a = await w.convert(f);
  assert.ok(a.ok && a.by === 'Word' && fs.existsSync(a.pdf!) && calls.length === 1, JSON.stringify(a));
  // (the same file again: re-used - and still says by which it was made)
  const a2 = await w.convert(f);
  assert.ok(a2.ok && a2.cached && a2.by === 'Word' && calls.length === 1, JSON.stringify(a2));
  w.clean();
  const g = mkDocx(dir, 'g.docx'), lcalls: Call[] = [];
  const l = wp().makeConverter({ platform: 'linux', env: {}, tmpdir: dir, find: () => '/usr/bin/soffice', run: async (cmd: string, args: string[]) => {
    lcalls.push({ cmd, args });
    fs.writeFileSync(path.join(args[args.indexOf('--outdir') + 1], 'g.pdf'), '%PDF');
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  } });
  const b = await l.convert(g);
  assert.ok(b.ok && b.by === 'LibreOffice' && lcalls.length === 1 && lcalls[0].cmd === '/usr/bin/soffice', JSON.stringify(b));
  assert.equal((await l.convert(g)).by, 'LibreOffice');
  l.clean();
});

test('converter: Word times out at the default settings - the file goes to text with the reason, and the stuck Word is not asked again in that run', async () => {
  const dir = tmp(), f = mkDocx(dir), g = mkDocx(dir, 'g.docx'), calls: string[] = [], killed: number[] = [];
  const c = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, timeoutMs: 90000, killPid: (pid: number) => killed.push(pid), find: () => null,
    run: async (cmd: string) => { calls.push(cmd); return { code: null, stdout: 'WORDPID:55\n', stderr: '', timedOut: true }; } });
  const a = await c.convert(f);
  assert.ok(!a.ok && /Microsoft Word did not finish in 90 s/.test(a.why!), JSON.stringify(a));
  const b = await c.convert(g);
  assert.ok(!b.ok && /not asked again/.test(b.why!), JSON.stringify(b));
  assert.deepEqual(calls, ['powershell.exe'], 'Word asked once in the run');
  assert.deepEqual(killed, [55]);
});

test('converter: 90 s then the Word process and its Word are killed, the next converter tried', async () => {
  const dir = tmp(), f = mkDocx(dir), killed: number[] = [], calls: string[] = [];
  const c = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, timeoutMs: 90000, killPid: (pid: number) => killed.push(pid), find: () => null,
    run: async (cmd: string, _a: string[], o: { timeoutMs: number }) => { calls.push(cmd + ' ' + o.timeoutMs); return { code: null, stdout: 'WORDPID:777\n', stderr: '', timedOut: true }; } });
  const r = await c.convert(f);
  assert.ok(!r.ok);
  assert.deepEqual(calls, ['powershell.exe 90000']);
  assert.deepEqual(killed, [777], 'the Word instance this run started - not the person\'s own Word');
  assert.match(r.why!, /90 s/);
});

// ---------------------------------------------------------------- T16c: the Word converter hardened (the Engineer's review)
const OKRUN = { code: 0, stdout: 'OK\n', stderr: '', timedOut: false };

test('T16c 1: the Word process id comes from a WINWORD snapshot taken before New-Object, printed before Documents.Open - no Hwnd, no DllImport', () => {
  const s = wp().wordScript('C:\\a.docx', 'C:\\o.pdf');
  assert.ok(!/Hwnd/i.test(s), 'Word\'s Application has no Hwnd');
  assert.ok(!/Add-Type|DllImport|user32/i.test(s), 'no native import (endpoint protection reads it as malware)');
  const snap = s.search(/Get-Process WINWORD/), neu = s.indexOf('New-Object -ComObject Word.Application'), pid = s.indexOf('WORDPID:'), open = s.indexOf('Documents.Open(');
  assert.ok(snap >= 0 && neu >= 0 && pid >= 0 && open >= 0, 'all four parts are there');
  assert.ok(snap < neu, 'the snapshot comes before the Word is started');
  assert.ok(pid < open, 'WORDPID is printed before Documents.Open (a hang there is the one to kill)');
  assert.ok(neu < pid, 'and after the Word is started');
  assert.match(s, /-Embedding/); // (several new ones: the one started by COM)
  assert.match(s, /Get-CimInstance Win32_Process/);
  assert.match(s, /StartTime/); // (else the newest)
});

test('T16c 2: Documents.Open gets a password (a protected file errors at once, no invisible prompt); the error reaches the user line plainly', async () => {
  const s = wp().wordScript('C:\\a.docx', 'C:\\o.pdf');
  const m = /Documents\.Open\(([^)]*)\)/.exec(s)!;
  assert.ok(m, 'an Open( call');
  const a = m[1].split(',').map((x) => x.trim());
  assert.ok(a.length >= 5, 'five arguments at least: ' + m[1]);
  assert.equal(a[1], '$false', 'ConfirmConversions');
  assert.equal(a[2], '$true', 'ReadOnly');
  assert.equal(a[3], '$false', 'AddToRecentFiles');
  assert.ok(a[4] && a[4] !== '$null' && a[4] !== "''", 'PasswordDocument is not empty: ' + a[4]);
  const lit = /\$pw = '([^']+)'/.exec(s);
  assert.ok(a[4].startsWith("'") || (a[4] === '$pw' && lit), 'a dummy password, as a literal or a variable that is set to one');
  assert.equal(a[7], a[4], 'WritePasswordDocument (8th) is the same dummy');
  // (what Word says for a protected file: the user line says so, plainly)
  const dir = tmp(), f = mkDocx(dir);
  const c = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, find: () => null,
    run: async () => ({ code: 3, stdout: 'WORDPID:9\n', stderr: 'The password is incorrect. Word cannot open the document: C:\\a.docx.', timedOut: false }) });
  const r = await c.convert(f);
  assert.ok(!r.ok);
  assert.match(r.why!, /the file is password-protected/);
  assert.doesNotMatch(r.why!, /Word cannot open the document/);
  // (not stuck: the next file still goes to Word)
  let word = 0;
  const c2 = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, find: () => null, run: async () => { word++; return { code: 3, stdout: '', stderr: 'The password is incorrect.', timedOut: false }; } });
  await c2.convert(f); await c2.convert(mkDocx(dir, 'b.docx'));
  assert.equal(word, 2, 'a protected file is no reason to stop asking Word');
});

test('T16c 7: Word writes to a .part file, renamed on success only; a timeout with the part file held (EBUSY) is still "Word did not finish", no cached half PDF', async () => {
  const dir = tmp(), f = mkDocx(dir), g = mkDocx(dir, 'g.docx'), calls: string[] = [], killed: number[] = [], outs: string[] = [];
  const c = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, timeoutMs: 90000, killPid: (pid: number) => killed.push(pid), find: () => null,
    run: async (cmd: string, args: string[]) => {
      calls.push(cmd);
      const o = /\$out = '([^']+)'/.exec(decode(args))![1];
      outs.push(o);
      fs.writeFileSync(o, '0123456789'); // (10 bytes of a half-written PDF)
      return { code: null, stdout: 'WORDPID:321\n', stderr: '', timedOut: true };
    } });
  const real = fs.rmSync;
  (fs as { rmSync: unknown }).rmSync = (p: string, o?: unknown) => { if (/\.part/.test(String(p))) { const e = new Error('EBUSY: resource busy or locked') as Error & { code: string }; e.code = 'EBUSY'; throw e; } return real(p, o as never); };
  try {
    const a = await c.convert(f);
    assert.ok(!a.ok && /Microsoft Word did not finish/.test(a.why!), JSON.stringify(a));
    assert.ok(/\.part/.test(outs[0]), 'Word was given a .part name: ' + outs[0]);
    assert.deepEqual(killed, [321]);
    const b = await c.convert(g);
    assert.ok(!b.ok && /not asked again/.test(b.why!), 'stuck was recorded in spite of the failed removal: ' + JSON.stringify(b));
    assert.deepEqual(calls, ['powershell.exe'], 'PowerShell was not started again');
    const a2 = await c.convert(f);
    assert.ok(!a2.ok && !(a2 as { cached?: boolean }).cached, 'the half file is no cached conversion: ' + JSON.stringify(a2));
  } finally { (fs as { rmSync: unknown }).rmSync = real; }
});

test('T16c 7b: a good run - the PDF appears at its name only when finished (the .part is gone); LibreOffice a removal that throws does not fail a good conversion', async () => {
  const dir = tmp(), f = mkDocx(dir), seen: string[] = [];
  const c = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, run: async (_c: string, args: string[]) => {
    const o = /\$out = '([^']+)'/.exec(decode(args))![1]; seen.push(o);
    fs.writeFileSync(o, '%PDF-1.4 fake');
    assert.ok(!fs.existsSync(o.replace(/\.part(\.pdf)?$/, '') + '.pdf') || /\.part/.test(o), 'nothing at the final name yet');
    return OKRUN;
  } });
  const r = await c.convert(f);
  assert.ok(r.ok && r.by === 'Word' && fs.existsSync(r.pdf!), JSON.stringify(r));
  assert.notEqual(seen[0], r.pdf, 'Word wrote elsewhere than the final name');
  assert.ok(/\.part/.test(seen[0]));
  assert.ok(!fs.existsSync(seen[0]), 'the .part was renamed away');
  // (LibreOffice: its own temp folder, moved on success; the removal of that folder failing changes nothing)
  const g = mkDocx(dir, 'g.docx');
  const l = wp().makeConverter({ platform: 'linux', env: {}, tmpdir: dir, find: () => '/usr/bin/soffice', run: async (_c: string, args: string[]) => {
    fs.writeFileSync(path.join(args[args.indexOf('--outdir') + 1], 'g.pdf'), '%PDF'); return { code: 0, stdout: '', stderr: '', timedOut: false };
  } });
  const real = fs.rmSync;
  (fs as { rmSync: unknown }).rmSync = (p: string, o?: unknown) => { if (/[\\/]w\d+-/.test(String(p))) throw new Error('EBUSY'); return real(p, o as never); };
  try { const b = await l.convert(g); assert.ok(b.ok && b.by === 'LibreOffice' && fs.existsSync(b.pdf!), JSON.stringify(b)); } finally { (fs as { rmSync: unknown }).rmSync = real; }
});

test('T16c (sweep 1): a WORDPID line split over two reads of the output is read whole - "WORDPID:12" then "34" kills 1234, never 12', async () => {
  const dir = tmp(), f = mkDocx(dir), killed: number[] = [];
  const c = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, timeoutMs: 90000, killPid: (pid: number) => killed.push(pid), find: () => null,
    run: (_cmd: string, _a: string[], o: { onSpawn?: (p: number) => void; onStdout?: (s: string) => void }) => {
      if (o.onSpawn) o.onSpawn(7001);
      if (o.onStdout) { o.onStdout('WORDPID:12'); o.onStdout('34\r\n'); }
      return new Promise(() => { /* never answers */ });
    } });
  void c.convert(f);
  await new Promise((r) => setTimeout(r, 50));
  c.stop();
  assert.deepEqual([...killed].sort((a, b) => a - b), [1234, 7001]);
  // (and a line cut before its end is not taken at all)
  const k2: number[] = [];
  const c2 = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, killPid: (pid: number) => k2.push(pid), find: () => null,
    run: (_cmd: string, _a: string[], o: { onSpawn?: (p: number) => void; onStdout?: (s: string) => void }) => { if (o.onSpawn) o.onSpawn(7003); if (o.onStdout) o.onStdout('WORDPID:56'); return new Promise(() => { /* never */ }); } });
  void c2.convert(mkDocx(dir, 'h.docx'));
  await new Promise((r) => setTimeout(r, 50));
  c2.stop();
  assert.deepEqual(k2, [7003]);
});

test('T16a (PC run, 18 Nov): Quit is called the way PowerShell accepts - Quit($false) threw "should be a PSReference", every Word stayed', () => {
  const s = wp().wordScript('C:\\a.docx', 'C:\\o.pdf');
  assert.ok(!/\.Quit\(\$false\)/.test(s), 'no Quit($false)');
  assert.match(s, /\$w\.Quit\(\[ref\]0\)/);
  assert.match(s, /^\$ProgressPreference = 'SilentlyContinue'/m, 'no progress records on the error stream');
});

test('T16a (PC run): the Word this run started is stopped if it is still there a moment after a finished conversion', async () => {
  const dir = tmp(), f = mkDocx(dir), killed: number[] = [];
  const c = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, graceMs: 20, alive: (pid: number) => pid === 4321, killPid: (pid: number) => killed.push(pid), find: () => null,
    run: (_cmd: string, args: string[], o: { onStdout?: (s: string) => void }) => {
      const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
      const out = /\$out = '([^']+)'/.exec(script)![1].replace(/''/g, "'");
      fs.writeFileSync(out, '%PDF-1.4 x');
      if (o.onStdout) o.onStdout('WORDPID:4321\r\nOK\r\n');
      return Promise.resolve({ code: 0, stdout: 'WORDPID:4321\r\nOK\r\n', stderr: '', timedOut: false });
    } });
  const r = await c.convert(f);
  assert.equal(r.ok, true);
  await new Promise((res) => setTimeout(res, 80));
  assert.deepEqual(killed, [4321]);
});

test('T16a (PC run): PowerShell\'s CLIXML wrapping is taken out of the reason shown', async () => {
  const dir = tmp(), f = mkDocx(dir);
  const c = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, killPid: () => {}, find: () => null,
    run: () => Promise.resolve({ code: 3, stdout: 'WORDPID:9\r\n', stderr: '#< CLIXML\r\nThe file appears to be corrupted.\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN></Obj></Objs>', timedOut: false }) });
  const r = await c.convert(f);
  assert.equal(r.ok, false);
  assert.match(r.why, /Microsoft Word could not convert it \(The file appears to be corrupted\.\)/);
  assert.ok(!/CLIXML|<Objs/.test(r.why), r.why);
});

test('T16c 8: stop() ends the running PowerShell and the Word pid once printed; nothing new starts after it; main calls it before clean()', async () => {
  const dir = tmp(), f = mkDocx(dir), g = mkDocx(dir, 'g.docx'), killed: number[] = [], calls: string[] = [];
  const c = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, timeoutMs: 90000, killPid: (pid: number) => killed.push(pid), find: () => null,
    run: (cmd: string, _a: string[], o: { onSpawn?: (p: number) => void; onStdout?: (s: string) => void }) => {
      calls.push(cmd);
      if (o.onSpawn) o.onSpawn(7001); // (the PowerShell)
      if (o.onStdout) o.onStdout('WORDPID:7002\n'); // (its Word, printed before Documents.Open)
      return new Promise(() => { /* never answers */ });
    } });
  void c.convert(f);
  void c.convert(g);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls, ['powershell.exe']);
  c.stop();
  assert.deepEqual([...killed].sort(), [7001, 7002], 'the child and the Word');
  c.stop(); // (twice: harmless)
  const main = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'electron', 'main.cjs'), 'utf8');
  const wq = main.slice(main.indexOf("app.on('will-quit'"));
  assert.ok(wq.indexOf('docxConv.stop()') > 0 && wq.indexOf('docxConv.stop()') < wq.indexOf('docxConv.clean()'), 'will-quit: stop() before clean()');
});

test('T16c 8b: after stop() a run that ends is no reason to try LibreOffice, and a new convert() starts nothing', async () => {
  const dir = tmp(), f = mkDocx(dir), g = mkDocx(dir, 'g.docx'), calls: string[] = [];
  let release: (v: { code: number | null; stdout: string; stderr: string; timedOut: boolean }) => void = () => { /* */ };
  const c = wp().makeConverter({ platform: 'win32', env: {}, tmpdir: dir, killPid: () => { /* */ }, find: () => '/x/soffice',
    run: (cmd: string) => { calls.push(cmd); return new Promise((res) => { release = res; }); } });
  const p = c.convert(f);
  await new Promise((r) => setTimeout(r, 30));
  c.stop();
  release({ code: 1, stdout: '', stderr: 'killed', timedOut: false });
  const r = await p;
  assert.ok(!r.ok);
  assert.deepEqual(calls, ['powershell.exe'], 'no LibreOffice after stop');
  assert.ok(!(await c.convert(g)).ok);
  assert.deepEqual(calls, ['powershell.exe']);
});

test('T16c 9: Word is quit only when its Documents.Count is 0 (else made visible and left); our document closed first', () => {
  const s = wp().wordScript('C:\\a.docx', 'C:\\o.pdf');
  const fin = s.slice(s.indexOf('finally'));
  const close = fin.indexOf('$d.Close($false)'), cnt = fin.indexOf('Documents.Count -eq 0'), quit = fin.indexOf('Quit([ref]0)'), vis = fin.indexOf('Visible = $true');
  assert.ok(close >= 0 && cnt > close && quit > cnt, 'Close, then the Count check, then Quit');
  assert.ok(vis > cnt, 'else: visible and left running');
  assert.match(s, /\$w\.Documents\.Count -eq 0\)\s*\{\s*\$w\.Quit\(\[ref\]0\)\s*\}\s*else\s*\{\s*\$w\.Visible = \$true/);
});

test('T16c (Contractor): a Word the script did not start - the person\'s own - is not hidden, not quit, its settings put back; our document opened unseen', () => {
  const s = wp().wordScript('C:\\a.docx', 'C:\\o.pdf');
  const open = s.indexOf('Documents.Open(');
  assert.match(s, /\$own = \(\$pick -ne \$null\) -or/);
  assert.ok(s.indexOf('if ($own) { $w.Visible = $false }') >= 0 && s.indexOf('if ($own) { $w.Visible = $false }') < open, 'hidden only when ours, before the open');
  assert.ok(!/^\s*\$w\.Visible = \$false/m.test(s), 'never hidden unconditionally');
  const fin = s.slice(s.indexOf('finally'));
  assert.match(fin, /if \(\$own\) \{ try \{ if \(\$w\.Documents\.Count -eq 0\) \{ \$w\.Quit\(\[ref\]0\) \}/, 'quit only when ours');
  assert.match(fin, /else \{ try \{ \$w\.DisplayAlerts = \$da \}/, 'the person\'s Word gets its alerts back');
  assert.match(s.slice(open), /^Documents\.Open\(\$src, \$false, \$true, \$false, \$pw, \$pw, \$false, \$pw, \$pw, 0, \$m, \$false\)/, 'Visible (12th) false');
});

test('T16c: the runner reports the child pid and streams stdout as it comes (so stop() knows them while it runs)', async () => {
  let pid = 0, got = '';
  const r = await wp().spawnRun(process.execPath, ['-e', 'console.log("WORDPID:12")'], { timeoutMs: 5000, onSpawn: (p) => { pid = p; }, onStdout: (s) => { got += s; } });
  assert.ok(r.code === 0 && pid > 0 && /WORDPID:12/.test(got), `${pid} ${got}`);
});

test('converter runner: a command past its time is killed (the whole tree) and says so', async () => {
  const t0 = Date.now();
  const r = await wp().spawnRun(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 400 });
  assert.ok(r.timedOut);
  assert.ok(Date.now() - t0 < 5000);
  const ok = await wp().spawnRun(process.execPath, ['-e', 'console.log("hi")'], { timeoutMs: 5000 });
  assert.ok(!ok.timedOut && ok.code === 0 && /hi/.test(ok.stdout));
});
