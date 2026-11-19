// 0.6.0 T21 (DECISIONS 94) - the heavy-sheet merge, from the PDF Editor 0.13 (heavy.ts makeMerger):
// (1) a deflate that fails while the merge waits for its drain makes the merge reject - it never hangs;
// (2) a heavy page whose content has no filter (what an editor writes after page numbers, a redaction or a
//     text edit) is merged, alone or beside a Flate part; any other filter still refuses the page;
// (3) the merged content is the same as before (only the compression level changed).
// Fails on 0.5.1: (1) never settles, (2) the unfiltered pages are left as they are.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as mupdf from 'mupdf';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-merge-'));
process.env.TMPDIR = tmp; // (heavyDir() under it: a fresh record store)
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const { mergeContent, readable } = await import('../src/engine/heavy');

/** `n` short strokes as traced line work writes them ("x y m x y l S"), 400 to a run */
function strokes(n: number, seed = 7): string {
  const out: string[] = [];
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) {
    if (i % 400 === 0) { x = 60 + rnd() * 2000; y = 60 + rnd() * 1400; }
    out.push(`${x.toFixed(2)} ${y.toFixed(2)} m ${(x + 1.5).toFixed(2)} ${y.toFixed(2)} l S`);
    x += 1.5;
  }
  return out.join('\n');
}

test('a deflate that fails while the merge waits for its drain: the merge rejects (never hangs)', async () => {
  const part = zlib.deflateSync(Buffer.from(strokes(300_000)));
  const realCreate = zlib.createDeflate;
  const patched = ((opts?: zlib.ZlibOptions) => {
    const d = realCreate(opts);
    const write = d.write.bind(d);
    let armed = false;
    (d as unknown as { write: (c: Buffer) => boolean }).write = (c: Buffer) => {
      write(c);
      if (!armed) { armed = true; setTimeout(() => d.emit('error', new Error('deflate failed')), 5); }
      return false; // "full": the merge waits for a drain that never comes
    };
    return d;
  }) as typeof zlib.createDeflate;
  Object.defineProperty(zlib, 'createDeflate', { value: patched, writable: true, configurable: true });
  try {
    const outcome = await Promise.race([
      mergeContent([part], 100_000).then(() => 'settled', () => 'rejected'),
      new Promise<string>((res) => setTimeout(() => res('still waiting'), 2000)),
    ]);
    assert.equal(outcome, 'rejected');
  } finally {
    Object.defineProperty(zlib, 'createDeflate', { value: realCreate, writable: true, configurable: true });
  }
});

/** a one-page A1 PDF whose content is `parts` (each: its text and whether it is stored with Flate) */
function sheetPdf(file: string, parts: { text: string; flate: boolean }[]) {
  const doc = new mupdf.PDFDocument();
  const page = doc.addPage([0, 0, 2384, 1684], 0, doc.newDictionary(), '');
  const refs = doc.newArray();
  for (const p of parts) {
    const d = doc.newDictionary();
    if (p.flate) { d.put('Filter', doc.newName('FlateDecode')); refs.push(doc.addRawStream(zlib.deflateSync(Buffer.from(p.text)), d)); }
    else refs.push(doc.addRawStream(Buffer.from(p.text), d));
  }
  doc.insertPage(-1, page);
  doc.findPage(0).put('Contents', refs);
  fs.writeFileSync(file, doc.saveToBuffer('').asUint8Array());
}
/** the page's content as MuPDF decodes it (all parts joined) */
function decoded(file: string, delta?: string): { text: string; merged: boolean } {
  const bytes = delta ? Buffer.concat([fs.readFileSync(file), fs.readFileSync(delta)]) : fs.readFileSync(file);
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF()!;
  const c = doc.findPage(0).get('Contents');
  const list = c.isArray() ? [...Array(c.length).keys()].map((k) => c.get(k)) : [c];
  const merged = list.some((s) => s.get('RRMerged').isBoolean());
  return { text: list.map((s) => s.readStream().asString()).join('\n'), merged };
}

test('a heavy page with no filter is merged; beside a Flate part too; another filter still refuses', async () => {
  const line = strokes(2_100_000); // ~ 75 MB of content: past the 2 M-stroke bar (MIN_STROKES)
  // (1) one part, stored without a filter (a sheet numbered or redacted in an editor and saved)
  const raw = path.join(tmp, 'raw.pdf');
  sheetPdf(raw, [{ text: line, flate: false }]);
  const a = await readable(raw);
  assert.ok(a.delta, 'unfiltered heavy page: merged (0.5.1: left as it is)');
  const da = decoded(raw, a.delta);
  assert.ok(da.merged);
  // (2) the line work unfiltered and a small Flate part (page numbers added after): one content
  const mixed = path.join(tmp, 'mixed.pdf');
  sheetPdf(mixed, [{ text: line, flate: false }, { text: 'BT /F1 12 Tf 100 100 Td (A-101) Tj ET', flate: true }]);
  const b = await readable(mixed);
  assert.ok(b.delta, 'unfiltered + Flate: merged as one content');
  assert.match(decoded(mixed, b.delta).text, /\(A-101\) Tj/, 'the unfiltered part is kept in the merged content');
  // (3) a part with another filter (ASCIIHex): the page is left as it is, as before
  const hex = path.join(tmp, 'hex.pdf');
  {
    const doc = new mupdf.PDFDocument();
    const page = doc.addPage([0, 0, 2384, 1684], 0, doc.newDictionary(), '');
    doc.insertPage(-1, page);
    const d = doc.newDictionary();
    d.put('Filter', doc.newName('ASCIIHexDecode'));
    doc.findPage(0).put('Contents', doc.addRawStream(Buffer.from(Buffer.from(strokes(160_000)).toString('hex') + '>'), d)); // (11 MB: over HEAVY_FILE)
    fs.writeFileSync(hex, doc.saveToBuffer('').asUint8Array());
  }
  const c = await readable(hex);
  assert.equal(c.delta, undefined, 'another filter: not merged');
});

test('content without a filter merges to the same content as the same bytes stored with Flate', async () => {
  const line = Buffer.from(strokes(300_000, 11));
  const a = await mergeContent([zlib.deflateSync(line)], 100_000);
  const b = await mergeContent([{ bytes: new Uint8Array(line), flate: false }] as never, 100_000);
  assert.ok(a && b);
  assert.equal(zlib.inflateSync(b!).equals(zlib.inflateSync(a!)), true);
});
