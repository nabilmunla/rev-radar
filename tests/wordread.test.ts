// T16b (DECISIONS 81): Word files compared as pages by default; the app says, for each Word file, how it was read -
// on screen (wordNote) and in the Documents register's Summary sheet. A compare with no Word file starts no converter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBook } from '../src/engine/sheets';

// (the UI modules read window at load: a bare stand-in; the saved register caught as bytes; the converter a stand-in)
let saved: Uint8Array | null = null;
type Conv = { ok: true; pdf: string; by: string; cached?: boolean } | { ok: false; why: string; none?: boolean; off?: boolean };
let convert: ((p: string) => Promise<Conv>) | undefined;
const asked: string[] = [];
(globalThis as unknown as { window: unknown }).window = {
  addEventListener() {}, removeEventListener() {},
  rr: {
    saveDialog: async () => 'x.xlsx', write: async (_p: string, b: Uint8Array) => { saved = b; }, showInFolder: async () => {}, settings: async () => ({}), setSettings: async () => {},
    docxConvert: async (p: string) => { asked.push(p); return convert ? convert(p) : { ok: false, why: 'no converter' }; },
    // (0.6.0 T23: a Documents compare runs on an engine of its own, started and ended per run)
    engineAdd: async () => {}, engineStop: async () => {},
  },
};
(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = () => 0;
const D = await import('../src/ui/docsrun');
const { ui } = await import('../src/ui/model');
const { workers, jobEngines } = await import('../src/ui/engines');

// (an engine that answers the compare with an empty result and remembers what it was given - the comparing engines and,
//  since 0.6.0 T23, the run's own engine)
const given: unknown[][] = [];
const fake = async (m: string, a: unknown[] = []) => { if (m === 'ping') return 1; given.push(a); return { entries: [], sections: { old: 0, neu: 0, paired: 0 }, paras: { old: 0, neu: 0 }, notes: [] }; };
workers.push({ busy: 0, call: fake } as never);
for (const c of jobEngines()) (c as unknown as { call: typeof fake }).call = fake;

const file = (rel: string) => ({ path: '/in/' + rel, rel, size: 1, mtime: 1 });
const set = (label: string, rels: string[]) => ({ label, paths: ['/in/' + label], files: rels.map(file) });
async function run(oldRels: string[], newRels: string[]) {
  asked.length = 0; given.length = 0;
  await D.startDocs(set('old', oldRels), set('new', newRels));
  return ui.docs!;
}
const cells = (b: Uint8Array, name: string) => readBook(b).sheets.find((x) => x.name === name)!.rows.map((r) => r.c);
async function register() {
  (window as unknown as { __rrSaveAs: string }).__rrSaveAs = 'x.xlsx';
  saved = null;
  await D.exportDocsExcel();
  assert.ok(saved, 'register written');
  return cells(saved!, 'Summary');
}
const wordRows = (sum: unknown[][]) => sum.filter((r) => r[0] === 'Word files').map((r) => String(r[1]));

test('T16b: Word files converted - the line says "as pages (LibreOffice)" on screen, and the compare is given the PDFs', async () => {
  convert = async (p) => ({ ok: true, pdf: p.replace(/\.docx$/, '.pdf'), by: 'LibreOffice' });
  const s = await run(['a.docx'], ['b.docx']);
  assert.equal(s.phase, 'done', s.error);
  assert.equal(s.wordNote, 'Word files shown as pages (LibreOffice)');
  assert.deepEqual(s.conv, { o: { 0: '/in/a.pdf' }, n: { 0: '/in/b.pdf' } });
  const args = given[0] as { file: { $file: { path: string } } }[][];
  assert.equal(args[0][0].file.$file.path, '/in/a.pdf');
  assert.equal(args[1][0].file.$file.path, '/in/b.pdf');
});

test('T16b: Word, LibreOffice and text in one compare - each file named with how it was read', async () => {
  convert = async (p) => /a\.docx$/.test(p) ? { ok: true, pdf: '/t/a.pdf', by: 'Word' } : /b\.docx$/.test(p) ? { ok: true, pdf: '/t/b.pdf', by: 'LibreOffice' } : { ok: false, why: 'Microsoft Word did not finish in 90 s (stopped)' };
  const s = await run(['a.docx', 'c.docx'], ['b.docx', 'd.docx']);
  assert.equal(s.wordNote, 'a.docx shown as pages (Word); b.docx shown as pages (LibreOffice); c.docx, d.docx shown as text as read, not as pages - Microsoft Word did not finish in 90 s (stopped)');
  assert.deepEqual(Object.keys(s.conv!.o), ['0']);
  assert.deepEqual(Object.keys(s.conv!.n), ['0']);
});

test('T16b: a converter that times out - the files are read as text, the line says so and why', async () => {
  convert = async () => ({ ok: false, why: 'Microsoft Word did not finish in 90 s (stopped)' });
  const s = await run(['a.docx'], ['b.docx']);
  assert.equal(s.phase, 'done', s.error);
  assert.equal(s.wordNote, 'Word files shown as text as read, not as pages - Microsoft Word did not finish in 90 s (stopped)');
  assert.deepEqual(s.conv, { o: {}, n: {} });
  const args = given[0] as { file: { $file: { path: string } } }[][];
  assert.equal(args[0][0].file.$file.path, '/in/a.docx', 'the Word file itself is compared (as text)');
});

test('T16b: the register names the reading - the same line in its Summary sheet', async () => {
  convert = async (p) => /a\.docx$/.test(p) ? { ok: true, pdf: '/t/a.pdf', by: 'LibreOffice' } : { ok: false, why: 'Microsoft Word did not finish in 90 s (stopped)' };
  const s = await run(['a.docx'], ['b.docx']);
  const sum = await register();
  assert.deepEqual(wordRows(sum), ['a.docx shown as pages (LibreOffice)', 'b.docx shown as text as read, not as pages - Microsoft Word did not finish in 90 s (stopped)']);
  assert.equal(wordRows(sum).join('; '), s.wordNote);
});

test('T16b: RR_OFF=docxpdf (the converter answers "off") - no line on screen, no row in the register', async () => {
  convert = async () => ({ ok: false, off: true, none: true, why: 'Word files are compared as their text in this version' });
  const s = await run(['a.docx'], ['b.docx']);
  assert.equal(s.phase, 'done', s.error);
  assert.equal(s.wordNote, '');
  assert.deepEqual(s.conv, { o: {}, n: {} });
  assert.deepEqual(wordRows(await register()), []);
});

test('T16b: a compare with no Word file never asks the converter, and its register has no Word row', async () => {
  convert = async () => { throw new Error('must not be asked'); };
  const s = await run(['a.pdf', 'sub/c.PDF'], ['b.pdf']);
  assert.equal(s.phase, 'done', s.error);
  assert.deepEqual(asked, []);
  assert.equal(s.wordNote, '');
  assert.deepEqual(wordRows(await register()), []);
});

// 0.6.0 T30: a PDF made in an earlier session says by which converter (0.5.1: "converted earlier", by nothing)
test('T30: a Word file converted in an earlier session - "converted earlier by Word"', async () => {
  convert = async (p) => ({ ok: true, pdf: p.replace(/\.docx$/, '.pdf'), by: 'Word', cached: true, earlier: true } as never);
  const s = await run(['a.docx'], ['b.docx']);
  assert.equal(s.phase, 'done', s.error);
  assert.equal(s.wordNote, 'Word files shown as pages (converted earlier by Word)');
});
