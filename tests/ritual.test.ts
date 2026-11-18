// The 0.5.0 Deep ritual (17 Nov): the sweep's findings confirmed in the code, each fixed with a test that
// fails on the code before (976981a). Pictures in a catalogue: tests/pics.test.ts ("ritual 17 Nov").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { zipSync, strToU8 } from 'fflate';
import { docxParas, pdfParas, sectionsOf, docEntries, type DocEntry, type Para } from '../src/engine/docs';
import { wordDiff } from '../src/engine/boq';
import { furniture, sheetMedia, type Pic } from '../src/engine/picdiff';
import { isFatalError } from '../src/engine/pdfium';
import { openInput } from '../src/engine/pdfopen';
import { EngineClient } from '../src/engine/rpc';

const req = createRequire(import.meta.url);

/** one paragraph per side through the whole engine: the entry of the pair */
function entryOf(a: string, b: string): DocEntry | undefined {
  const mk = (t: string): Para => ({ i: 0, file: 'f.pdf', page: 1, num: '', text: t, head: '', seg: [[0, 0, 0, 200, 10]], wb: t.split(' ').map((_, k) => [0, k * 10, 0, k * 10 + 8, 10]) });
  return docEntries(sectionsOf('f.pdf', [mk(a)]), sectionsOf('f.pdf', [mk(b)])).entries.find((e) => e.kind === 'changed');
}
const docx = (paras: string[]): Uint8Array => zipSync({ 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${paras.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`) });

test('a date changed and nothing else is listed - "Date / revision only", light (DECISIONS 26) - not left out', () => {
  for (const [a, b] of [
    ['Completion of the works shall be 31 December 2027 at the latest', 'Completion of the works shall be 31 March 2028 at the latest'],
    ['The tender validity runs to 25/06/2026 from the closing date', 'The tender validity runs to 30/06/2026 from the closing date'],
    ['Samples are due by June 2026 for the approval of the engineer', 'Samples are due by August 2026 for the approval of the engineer'],
  ]) {
    const e = entryOf(a, b);
    assert.ok(e, 'an entry: ' + b);
    assert.equal(e.cls, 'dateOnly', b);
  }
  // (the same date both sides: nothing)
  assert.equal(entryOf('Completion of the works shall be 31 December 2027', 'Completion of the works shall be 31 December 2027'), undefined);
});

test('a number alone on its line is a value, kept; page numbers said in words still left out', () => {
  const t = docxParas('a.docx', docx(['Thickness of the gypsum board in millimetres', '1200', 'Page 3', '3 of 40', '- 3 -'])).map((p) => p.text);
  assert.ok(t.includes('1200'), t.join(' | '));
  for (const x of ['Page 3', '3 of 40', '- 3 -']) assert.ok(!t.includes(x), x);
});

test('dot leaders: a contents list (3+ lines ending in page numbers) left out; a form\'s fill-in line and a lone schedule line kept', () => {
  const t = docxParas('a.docx', docx(['1.1 RELATED DOCUMENTS ........ 3', '1.2 SUMMARY ........ 3', '1.3 SUBMITTALS ........ 4', 'Manufacturer: ................', 'Colour reference: ……………', 'Thermal insulation', 'Minimum cement content .......... 350'])).map((p) => p.text);
  assert.ok(!t.some((x) => /RELATED DOCUMENTS|SUMMARY|SUBMITTALS/.test(x)), t.join(' | '));
  assert.ok(t.some((x) => x.startsWith('Minimum cement content')), 'a lone schedule line (Engineer A6): ' + t.join(' | '));
  assert.ok(t.some((x) => x.startsWith('Manufacturer')), t.join(' | '));
  assert.ok(t.some((x) => x.startsWith('Colour reference')), t.join(' | '));
});

test('a very long paragraph (over 2,000 x 2,000 words) with one word changed: only that word marked, the ends kept', () => {
  const words = Array.from({ length: 2100 }, (_, i) => `w${i}`);
  const b = [...words]; b[1050] = 'CHANGED';
  const d = wordDiff(words.join(' '), b.join(' '));
  assert.deepEqual(d.map((x) => x.op), ['=', '-', '+', '=']);
  assert.equal(d[1].t, 'w1050');
  assert.equal(d[2].t, 'CHANGED');
});

test('furniture: the same frame and size on every page but different photos is content; the same look is furniture', () => {
  const mk = (page: number, sha: string): Pic => ({ file: 'f.pdf', page, box: [100, 200, 400, 440], pw: 300, ph: 240, sha });
  const ps = [mk(0, 'a'), mk(1, 'b'), mk(2, 'c'), mk(3, 'd')];
  const looks = new Map(ps.map((p, k) => [p, Uint8Array.from({ length: 768 }, () => k * 50)]));
  assert.equal(furniture(ps, (p) => looks.get(p)).size, 0, 'four different photos');
  const one = Uint8Array.from({ length: 768 }, () => 90);
  assert.equal(furniture(ps, () => one).size, 4, 'a logo re-saved per page');
});

test('an engine that broke (wasm trap, out of memory) is told apart from a picture that cannot be drawn', () => {
  assert.ok(isFatalError(new WebAssembly.RuntimeError('unreachable')));
  assert.ok(isFatalError(new Error('Aborted(OOM)')));
  assert.ok(isFatalError(new Error('Cannot enlarge memory arrays')));
  assert.ok(!isFatalError(new Error('FPDF_LoadPage failed')));
  // (picdiff's draw passes these on: never "a picture that changed")
  assert.match(fs.readFileSync(path.join(import.meta.dirname, '../src/engine/picdiff.ts'), 'utf8'), /if \(pf\.isFatalError\(e\)\) throw e;/);
});

test('a big file that is neither PDF nor zip / .xls (a video in the folder) is left out by its first bytes, not read whole', () => {
  let most = 0;
  const rd = { size: 3e9, read(buf: Uint8Array, off: number, len: number) { most = Math.max(most, len); buf.fill(0x11, off, off + len); return len; }, close() { /* */ } };
  const big = { ...rd, failed: false, scattered: () => rd };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = openInput('x', big as any);
  assert.equal(r.pdf, false);
  assert.equal((r as { bytes: Uint8Array }).bytes.length, 0);
  assert.ok(most <= 16, 'read ' + most + ' bytes');
});

test('a workbook\'s pasted pictures are known without unpacking them (a corrupt picture stream does not matter)', () => {
  const rel = (t: string, target: string) => strToU8(`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="${t}" Target="${target}"/></Relationships>`);
  const book = (png: Uint8Array) => zipSync({
    'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Bill 3" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': rel('ws', 'worksheets/sheet1.xml'),
    'xl/worksheets/_rels/sheet1.xml.rels': rel('dr', '../drawings/drawing1.xml'),
    'xl/drawings/_rels/drawing1.xml.rels': rel('img', '../media/image1.png'),
    'xl/media/image1.png': [png, { level: 9 }],
  } as Parameters<typeof zipSync>[0]);
  const pic = Uint8Array.from({ length: 50000 }, (_, i) => (i * 7) % 251);
  const a = sheetMedia(book(pic)), b = sheetMedia(book(pic.map((v, i) => (i === 100 ? v ^ 1 : v))));
  assert.equal(a.get('Bill 3')?.length, 1);
  assert.notDeepEqual(a.get('Bill 3'), b.get('Bill 3'));
  // (the picture's compressed bytes spoiled: the zip directory still says what it is)
  const z = book(pic), name = strToU8('xl/media/image1.png');
  let h = -1;
  for (let i = 30; i < z.length && h < 0; i++) if (z[i] === name[0] && name.every((c, k) => z[i + k] === c)) h = i - 30;
  assert.ok(h >= 0 && z[h] === 0x50 && z[h + 1] === 0x4b, 'the picture\'s local header');
  const data = h + 30 + (z[h + 26] | (z[h + 27] << 8)) + (z[h + 28] | (z[h + 29] << 8));
  for (let i = data; i < data + 8; i++) z[i] = 0xff; // (an invalid deflate block: unpacking it fails)
  assert.equal(sheetMedia(z).get('Bill 3')?.length, 1);
});

test('Word stuck once (a dialog, an activation prompt): not asked again for the other files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-rit-'));
  try {
    const files = ['a.docx', 'b.docx', 'c.docx'].map((n) => { const f = path.join(dir, n); fs.writeFileSync(f, Buffer.from(docx([n]))); return f; });
    let word = 0;
    const c = (req('../electron/wordpdf.cjs') as { makeConverter: (d: Record<string, unknown>) => { convert(p: string): Promise<{ ok: boolean; why?: string }> } }).makeConverter({
      platform: 'win32', env: { RR_ON: 'docxpdf' }, tmpdir: dir, timeoutMs: 50, find: () => null, killPid: () => { /* */ },
      run: async (cmd: string) => { if (/powershell/i.test(cmd)) word++; return { code: null, stdout: 'WORDPID:1\n', stderr: '', timedOut: true }; },
    });
    for (const f of files) { const r = await c.convert(f); assert.equal(r.ok, false); }
    assert.equal(word, 1, 'Word asked once');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('problem reports: drawing, model and schedule file names are scrubbed too (.rvt, .ifc, .xer, .mpp, .xlsb, .dwf)', () => {
  const { scrub } = req('../electron/anon.cjs') as { scrub: (s: string, who?: unknown) => string };
  for (const n of ['Tower A model.rvt', 'Site.ifc', 'Programme R3.xer', 'Baseline.mpp', 'BOQ final.xlsb', 'Set 4.dwf']) {
    const out = scrub(`opened ${n} and it froze`);
    assert.ok(!out.includes(n), out);
  }
});

test('a call queued while the engine restarts, that cannot be posted, fails - it is not left waiting for ever', async () => {
  const c = new EngineClient('test');
  const p = c.call('x', [() => 1]);
  const port = { onmessage: null, start() { /* */ }, close() { /* */ }, postMessage() { throw new Error('could not be cloned'); } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c.attach(port as any, false);
  await assert.rejects(Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('never settled')), 500))]), /could not be cloned/);
  assert.equal(c.busy, 0);
});

test('a scanned schedule page with the word "index" and numbers that do not rise is kept - only a real contents page is left out', () => {
  // (words of a line laid out across the page, one line every 20 pt)
  const line = (t: string, y: number) => { let x = 60; return t.split(' ').map((w) => { const o = { s: w, x0: x, y0: y, x1: x + w.length * 6, y1: y + 10 }; x += w.length * 6 + 5; return o; }); };
  const page = (ls: string[]) => ls.flatMap((t, k) => line(t, 120 + k * 20));
  const schedule = ['DOOR SCHEDULE INDEX OF TYPES', 'FLUSH TIMBER DOOR TYPE A 45', 'FLUSH TIMBER DOOR TYPE B 30', 'STEEL FIRE DOOR TYPE C 120', 'STEEL FIRE DOOR TYPE D 60', 'GLAZED ALUMINIUM DOOR TYPE E 15', 'GLAZED ALUMINIUM DOOR TYPE F 90'];
  const contents = ['CONTENTS', 'SECTION ONE GENERAL REQUIREMENTS 1', 'SECTION TWO SITE WORKS AND DEMOLITION 4', 'SECTION THREE CONCRETE WORKS AND REINFORCEMENT 9', 'SECTION FOUR MASONRY AND BLOCKWORK 15', 'SECTION FIVE METALWORK AND FIXINGS 22', 'SECTION SIX CARPENTRY AND JOINERY 30'];
  const pages = [page(schedule), page(contents)];
  const left: number[] = [];
  const ps = pdfParas('scan.pdf', 2, (i) => pages[i], () => 842, new Set([0, 1]), left);
  const t = ps.map((p) => p.text).join(' | ');
  assert.ok(/STEEL FIRE DOOR TYPE C 120/.test(t), 'the schedule kept: ' + t);
  assert.ok(!/MASONRY AND BLOCKWORK/.test(t), 'the contents page left out: ' + t);
  assert.deepEqual(left, [2]);
});

test('a section\'s own contents line is not glued to the clause under it: the line left out, the clause kept as it is', () => {
  const line = (t: string, y: number) => { let x = 60; return t.split(' ').map((w) => { const o = { s: w, x0: x, y0: y, x1: x + w.length * 5, y1: y + 10 }; x += w.length * 5 + 4; return o; }); };
  const body = ['3.7 PROTECTION .................................................................. 19', '3.8 CLEANING .................................................................... 19', '3.9 DEMONSTRATION ............................................................... 20',
    'Drawings and general provisions of the Contract, including General and Supplementary Conditions and General', 'Specification Sections, apply to this Section.'];
  const ws = body.flatMap((t, k) => line(t, 120 + k * 12));
  const t = pdfParas('s.pdf', 1, () => ws, () => 842).map((p) => p.text);
  assert.ok(t.some((x) => x.startsWith('Drawings and general provisions')), t.join(' | '));
  assert.ok(!t.some((x) => /DEMONSTRATION|CLEANING|PROTECTION/.test(x)), t.join(' | '));
});

test('a clause whose last line is a standard in capitals ("ASTM D412.") after a comma keeps it; a heading after a full stop stays a heading', () => {
  // (STR old p.132: "... 15.5 MPa," / "ASTM D412." - the last line read as a heading, the clause shown "Changed" against the
  //  new issue where it broke after "ASTM"; T17's truth check found it)
  const line = (t: string, y: number) => { let x = 60; return t.split(' ').map((w) => { const o = { s: w, x0: x, y0: y, x1: x + w.length * 5, y1: y + 10 }; x += w.length * 5 + 4; return o; }); };
  const body = ['1. Elastomeric Pads: AASHTO M 251, plain, vulcanized, 100 percent polychloroprene', '(neoprene) elastomer, molded to size or cut from a molded sheet, 50 to 70 Shore,',
    'Type A durometer hardness, ASTM D2240; minimum tensile strength 15.5 MPa,', 'ASTM D412.', '2. Bearing strips: high-density plastic strips, 3 mm thick, of the width of the plank seat.', 'FABRICATION'];
  const ws = body.flatMap((t, k) => line(t, 120 + k * 12));
  const t = pdfParas('s.pdf', 1, () => ws, () => 842).map((p) => p.text);
  assert.ok(t.some((x) => x.endsWith('15.5 MPa, ASTM D412.')), t.join(' | '));
  assert.ok(!t.includes('ASTM D412.'), t.join(' | '));
  assert.ok(t.includes('FABRICATION'), 'the heading after a full stop: ' + t.join(' | '));
  // (the generated Word pair as LibreOffice prints it: "... qualified as acceptable according to" / "ASTM C 795." - T16b)
  const b2 = ['D. Insulation materials for use on austenitic stainless steel shall be qualified as acceptable according to', 'ASTM C 795.', 'E. Foam insulation materials shall not use CFC or HCFC blowing agents in the manufacturing process.',
    'Provide the insulation in the thicknesses scheduled, with all joints sealed, all as shown on the Drawings', 'PART 3 - EXECUTION', 'A LONG NOTE IN CAPITALS THAT RUNS ACROSS THE WHOLE WIDTH OF THE PAGE AND ENDS IN A WORD', 'ALL WORK'];
  const t2 = pdfParas('s.pdf', 1, () => b2.flatMap((x, k) => line(x, 120 + k * 12)), () => 842).map((p) => p.text);
  assert.ok(t2.some((x) => x.endsWith('according to ASTM C 795.')), t2.join(' | '));
  assert.ok(t2.includes('EXECUTION') && t2.includes('ALL WORK'), 'headings stay headings: ' + t2.join(' | '));
});

test('a scanned contents page with one page number misread by OCR ("11" read "1") is still a contents page', () => {
  const line = (t: string, y: number) => { let x = 60; return t.split(' ').map((w) => { const o = { s: w, x0: x, y0: y, x1: x + w.length * 6, y1: y + 10 }; x += w.length * 6 + 5; return o; }); };
  const ls = ['TABLE OF CONTENTS', 'PERFORMANCE REQUIREMENTS 3', 'DELIVERY STORAGE AND HANDLING 4', 'MINERAL-FIBER INSULATION APPLICATION 9', 'FLEXIBLE ELASTOMERIC INSULATION APPLICATION 10', 'FIRE-RATED INSULATION SYSTEM INSTALLATION 1', 'CONCEALED INDOOR DUCT APPLICATION SCHEDULE 12', 'OUTDOOR DUCT AND PLENUM APPLICATION SCHEDULE 13'];
  const ws = ls.flatMap((t, k) => line(t, 120 + k * 20));
  const left: number[] = [];
  const t = pdfParas('scan.pdf', 14, (i) => (i === 0 ? ws : []), () => 842, new Set([0]), left).map((p) => p.text);
  assert.ok(!t.some((x) => /APPLICATION/.test(x)), t.join(' | '));
  assert.deepEqual(left, [1]);
});

test('what\'s new after a setup run over an older copy: this version\'s own notes, each short enough for the card (200 characters)', () => {
  const V = req('../electron/versions.cjs') as { bundledNotes: (dir: string, v: string) => Record<string, string[]> | null };
  const ver = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../package.json'), 'utf8')).version;
  const notes = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../release-notes.json'), 'utf8'))[ver];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-notes-'));
  try {
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'release-notes.json'), JSON.stringify({ [ver]: notes }));
    assert.deepEqual(V.bundledNotes(dir, ver), notes);
    assert.equal(V.bundledNotes(dir, '9.9.9'), null);
    assert.equal(V.bundledNotes(path.join(dir, 'none'), ver), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // (the card keeps 200 characters a note - electron/updater.cjs noteGroups, and the old copies' updaters too)
  for (const xs of Object.values(notes) as string[][]) for (const x of xs) assert.ok(x.length <= 200, `${x.length}: ${x.slice(0, 60)}`);
  // (the build writes this version's notes into dist/)
  assert.ok(/release-notes\.json/.test(fs.readFileSync(path.join(import.meta.dirname, '../scripts/build.mjs'), 'utf8')));
});
