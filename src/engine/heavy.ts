/// <reference types="node" />
// Monster sheets: a page drawn as millions of separate little strokes (F104-DNK-DWG-LS-00412, 46 MB,
// 15 million strokes) needs more than the engine's 2 GB in PDFium - the comparison, the viewer and
// the export all failed on it. Such pages get their strokes merged (strokes.ts: drawn the same) by
// MuPDF into a change appended to the file; the engines then read "the file + that change".
//
// Decided once per file (path + size + modified time) and kept in the temp folder, so every
// engine and every later comparison of that file reuses it:
//   <key>.json   { merged: pages changed, deltaSize } - also for files that needed nothing (not for
//                a merge that failed: tried again by the next engine started)
//   <key>.delta  the appended part (the merged content, a new page dictionary, a new xref) - a record
//                whose delta is gone or cut short (a temp cleaner) is thrown away and merged again
// Files under 10 MB are never looked at; in bigger ones only pages whose compressed content is
// over 6 MB are read through - the file is read on demand (its page tree and content lengths), and
// whole only when a page is merged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { VFile, type FileSrc } from './files';
import { MIN_STROKES } from './strokes';
import { StrokeMergeStream } from './strokestream';

export const HEAVY_FILE = 10e6;
const HEAVY_CONTENT = 6e6;
const V = 1;

export const heavyDir = () => path.join(os.tmpdir(), 'Rev Radar', 'heavy');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MU = any;
let mu: MU | null = null, muFailed = false;
async function mupdf(): Promise<MU | null> {
  if (mu || muFailed) return mu;
  try { mu = await import('mupdf'); } catch (e) { muFailed = true; console.error('MuPDF not available: ' + String((e as Error)?.message || e)); }
  return mu;
}

const memo = new Map<string, FileSrc>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** what to read for the file at `p`: the file itself, or the file plus its merged heavy pages */
export async function readable(p: string): Promise<FileSrc> {
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { return { path: p }; } // (opening it says what is wrong)
  if (!st.isFile() || st.size < HEAVY_FILE) return { path: p };
  const key = crypto.createHash('sha1').update(`${V}|${p.toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 24);
  const had = memo.get(key);
  if (had) return had;
  const dir = heavyDir();
  const info = path.join(dir, key + '.json'), delta = path.join(dir, key + '.delta'), lock = path.join(dir, key + '.lock');
  const use = (merged: number, base: number): FileSrc => {
    // (base: how much of the file comes first - all of it; 0 when the change is a whole new file)
    const r: FileSrc = merged > 0 && fs.existsSync(delta) ? { path: p, size: base, delta, mtime: st.mtimeMs } : { path: p };
    memo.set(key, r);
    return r;
  };
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return { path: p }; }
  let dropped = false;
  for (let wait = 0; ; wait++) {
    // (every turn after the first waits a moment: a record or lock that can't be removed - a scanner
    //  holding it - spun the engine at full speed; after ~6 minutes the file is read as it is)
    if (wait) await sleep(50);
    if (wait > 700) { console.error(`heavy pages of ${path.basename(p)}: gave up waiting for the merge - read as it is`); return use(0, st.size); }
    const known = readJson(info);
    // (a record of merged pages with its delta gone or not the size written: merged again - it was
    //  trusted, and the sheet compared unmerged for good, RR-037; if it can't even be removed, the
    //  file is read as it is)
    if (known && Number(known.merged) > 0 && !deltaOk(delta, known.deltaSize)) {
      if (dropped) return use(0, st.size);
      dropped = true;
      for (const f of [info, delta]) try { fs.rmSync(f, { force: true }); } catch { /* */ }
      continue;
    }
    if (known) {
      // (used: kept another two weeks - the app clears what wasn't used for that long)
      const now = new Date();
      for (const f of [info, delta]) try { fs.utimesSync(f, now, now); } catch { /* */ }
      return use(Number(known.merged) || 0, Number(known.base ?? st.size));
    }
    // one engine does it; the others wait for its answer (merging a monster takes a minute or so)
    let fd = -1;
    try { fd = fs.openSync(lock, 'wx'); } catch {
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      // the engine that took the lock was stopped (Stop, Home, out of memory): taken over at once,
      // not after minutes of waiting
      let owner = 0;
      try { owner = Number(fs.readFileSync(lock, 'utf8').trim()) || 0; } catch { continue; }
      if (owner && owner !== process.pid && !alive(owner)) { try { fs.rmSync(lock, { force: true }); } catch { /* */ } continue; }
      if (age < 4 * 60_000 && wait < 600) { await sleep(500); continue; }
      try { fs.rmSync(lock, { force: true }); } catch { /* */ }
      continue;
    }
    try {
      try { fs.writeSync(fd, String(process.pid)); } catch { /* the age rule still works */ }
      fs.closeSync(fd);
      let r: { merged: number; base: number; deltaSize?: number };
      try { r = await mergeFile(p, st, delta); } catch (e) {
        // (not written down: "could not" is not "nothing to merge" - the next engine started tries again)
        console.error(`heavy pages of ${path.basename(p)} not merged: ${String((e as Error)?.message || e)}`);
        return use(0, st.size);
      }
      writeJson(info, { ...r, file: path.basename(p), size: st.size });
      return use(r.merged, r.base);
    } finally { try { fs.rmSync(lock, { force: true }); } catch { /* */ } }
  }
}

/** the delta is there, and as big as written down (records before 0.3.4 have no size: there will do) */
function deltaOk(delta: string, size: unknown): boolean {
  try { const n = fs.statSync(delta).size; return size == null || n === Number(size); } catch { return false; }
}

/** is that process still running? */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function readJson(f: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function writeJson(f: string, v: unknown) {
  const t = f + '.' + process.pid + '.part';
  try { fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); } catch { try { fs.rmSync(t, { force: true }); } catch { /* */ } }
}

/** merge the heavy pages of a file; the appended part is written to `delta`. Pages changed, and
 *  how many bytes of the file come before the delta */
async function mergeFile(p: string, st: fs.Stats, delta: string): Promise<{ merged: number; base: number; deltaSize?: number }> {
  const size = st.size;
  const none = { merged: 0, base: size };
  const M = await mupdf();
  if (!M) throw new Error('MuPDF is not available');
  // read on demand (as murender.ts): the page tree and the content lengths, then only the heavy
  // pages' content - a big file with nothing heavy (nearly all) is not read whole (AUDIT A7). The
  // whole file is read only once a page is merged (the save copies it).
  const f = new VFile({ path: p }).scattered();
  try {
    const same = () => { const now = fs.fstatSync(f.parts[0].fd); return now.size === size && Math.abs(now.mtimeMs - st.mtimeMs) <= 1; };
    if (f.size !== size || !same()) throw new Error('the file changed meanwhile');
    const stm = new M.Stream({ fileSize: () => f.size, read: (memory: Uint8Array, offset: number, length: number, position: number) => f.read(memory, offset, length, position), close() { /* closed below */ } });
    let doc: MU;
    try { doc = M.Document.openDocument(stm, 'application/pdf').asPDF(); } finally { stm.destroy?.(); }
    if (!doc) return none;
    try {
      // (a file cut short or changed while it was looked at: "nothing heavy" can't be trusted - not
      //  written down, looked at again next time)
      const check = () => { if (f.failed || !same()) throw new Error('the file changed meanwhile or could not be read through'); };
      if (doc.needsPassword()) { check(); return none; }
      const t0 = Date.now();
      let changed = 0;
      const done = new Map<string, unknown>();
      let failed = 0;
      for (let i = 0, n = doc.countPages(); i < n; i++) { const m = await mergePage(doc, i, done); if (m === 'failed') failed++; else if (m) changed++; }
      check();
      // (a page that went wrong - out of memory, say - is not "nothing to merge": not written down)
      if (failed) throw new Error(`${failed} page(s) could not be merged`);
      if (!changed) return none;
      // the original bytes, then the change: only the change is kept (no copy of a 46 MB file)
      let out: Uint8Array;
      let base = size;
      try {
        out = doc.saveToBuffer('incremental').asUint8Array();
        if (out.length <= size || !startsWithFile(out, f)) base = 0;
      } catch {
        out = doc.saveToBuffer('').asUint8Array(); // (a repaired file can't be saved as a change)
        base = 0;
      }
      check();
      return written(out, base, delta, p, t0, changed);
    } finally { doc.destroy(); }
  } finally { f.close(); }
}

/** the saved document begins with the file as it is (an incremental save: the file, then the change) */
function startsWithFile(out: Uint8Array, f: VFile): boolean {
  const CH = 4 << 20, b = new Uint8Array(CH);
  for (let at = 0; at < f.size; at += CH) {
    const n = Math.min(CH, f.size - at);
    if (f.read(b, 0, n, at) !== n) return false;
    if (Buffer.compare(Buffer.from(b.buffer, 0, n), Buffer.from(out.buffer, out.byteOffset + at, n)) !== 0) return false;
  }
  return true;
}

/** the appended part (or the whole new file) written to `delta` */
function written(out: Uint8Array, base: number, delta: string, p: string, t0: number, changed: number): { merged: number; base: number; deltaSize: number } {
  const part = base ? out.subarray(base) : out;
  const t = delta + '.' + process.pid + '.part';
  fs.writeFileSync(t, part);
  fs.renameSync(t, delta);
  console.error(`merged ${changed} heavy page(s) of ${path.basename(p)} in ${Date.now() - t0} ms (${(part.length / 1e6).toFixed(1)} MB ${base ? 'added' : 'rewritten'})`);
  return { merged: changed, base, deltaSize: part.length };
}

/** one page's strokes merged; true if its content was replaced, 'failed' if it went wrong */
async function mergePage(doc: MU, i: number, done: Map<string, unknown>): Promise<boolean | 'failed'> {
  try {
    const po = doc.findPage(i);
    const c = po.get('Contents');
    const list: MU[] = c.isArray() ? [...Array(c.length).keys()].map((k) => c.get(k)) : [c];
    let total = 0;
    for (const s of list) { const l = s.get('Length'); if (l.isNumber()) total += l.asNumber(); }
    if (total <= HEAVY_CONTENT) return false;
    // (pages sharing their content objects share the merge; a content written into the page itself
    //  is that page's own - keyed -1 before, a second such page was given the first one's drawing, RR-038)
    const key = list.map((s, k) => (s.isIndirect() ? s.asIndirect() : `p${i}.${k}`)).join(',');
    if (done.has(key)) { po.put('Contents', done.get(key)); return true; }
    if (list.some((s) => !s.isStream())) return false;
    if (!opaqueStates(po)) return false;
    // every part Flate-compressed (as such files are); the parts are one content together - a
    // path can begin in one and be stroked in the next, so they are merged as one
    const flate = (s: MU) => { const f = s.get('Filter'); const nm = f.isName() ? f.asName() : f.isArray() && f.length === 1 && f.get(0).isName() ? f.get(0).asName() : ''; return nm === 'FlateDecode' && s.get('DecodeParms').isNull(); };
    if (!list.every(flate)) return false;
    const raws = list.map((s) => s.readRawStream());
    let out: Uint8Array | null = null;
    try { out = await mergeContent(raws.map((r: MU) => r.asUint8Array())); } finally { for (const r of raws) r.destroy?.(); }
    if (!out) return false;
    const d = doc.newDictionary();
    d.put('Filter', doc.newName('FlateDecode'));
    d.put('RRMerged', true);
    const ref = doc.addRawStream(out, d);
    po.put('Contents', ref);
    done.set(key, ref);
    return true;
  } catch (e) {
    const why = String((e as Error)?.message || e);
    console.error(`page ${i + 1} not merged: ${why}`);
    // (out of memory, a file busy: may work next time - not written down; a page that can't be merged
    //  - a stream zlib won't read, say - is left as it is and the others merged, as before)
    return /memory|alloc|ENOMEM|EBUSY|EAGAIN|EMFILE/i.test(why) ? 'failed' : false;
  }
}

const NL = new Uint8Array([10]);

/**
 * Inflate, merge, deflate - in pieces (PLAN T3, as the PDF Editor's makeMerger): each part is inflated
 * a block at a time and goes through the merge as it comes (strokestream.ts); the merged content is
 * deflated alongside. Only the compressed result is kept whole - the whole inflated content (up to
 * 550 MB on the real sheets), the merged copy and its deflate were all held at once: 2.3 GB.
 * Null when the page is not one of those: the same decision as before (a quick count of "S" first:
 * content under 10 x `minStrokes` bytes, or about 0.8 x `minStrokes` strokes, is left; then the exact
 * count - `minStrokes` or more strokes, and at least 4 to 1 merged). The quick count is a pass of
 * its own, stopped as soon as the page has passed it: a big page that is not heavy costs an inflate, not a merge.
 */
export async function mergeContent(parts: Uint8Array[], minStrokes = MIN_STROKES): Promise<Uint8Array | null> {
  // (the quick count first, as before: an ordinary dense sheet is not read through stroke by stroke
  //  for nothing - inflated and counted in blocks, nothing kept)
  const rough = new RoughStrokes();
  let bytes = 0;
  const enough = () => bytes >= minStrokes * 10 && rough.n >= minStrokes * 0.8;
  count: for (let k = 0; k < parts.length; k++) {
    if (k) { rough.add(NL); bytes++; }
    // (a heavy page passes the count long before its end)
    for await (const chunk of inflating(parts[k])) { rough.add(chunk); bytes += chunk.length; if (enough()) break count; }
  }
  if (!enough()) return null;
  const deflate = zlib.createDeflate({ level: 6, chunkSize: 1 << 20 });
  const out: Buffer[] = [];
  deflate.on('data', (c: Buffer) => out.push(c));
  const ended = new Promise<void>((res, rej) => { deflate.on('end', () => res()); deflate.on('error', rej); });
  ended.catch(() => { /* reported by the await below */ });
  let full = false;
  const m = new StrokeMergeStream((piece) => { if (!deflate.write(piece)) full = true; });
  const drain = async () => { if (full) { full = false; await new Promise((r) => deflate.once('drain', r)); } };
  try {
    // (a page's content parts are one content: joined with a line break between them)
    for (let k = 0; k < parts.length; k++) {
      if (k) m.push(NL);
      for await (const chunk of inflating(parts[k])) { m.push(chunk); await drain(); }
    }
    m.end();
    deflate.end();
    await ended;
  } catch (e) { deflate.destroy(); throw e; }
  // (the exact count decides: `minStrokes` or more strokes, merged at least 4 to 1)
  if (m.strokesIn < minStrokes || m.strokesOut * 4 > m.strokesIn) return null;
  const z = Buffer.concat(out);
  console.error(`heavy page: ${m.strokesIn} strokes -> ${m.strokesOut}, ${Math.round(m.bytesIn / 1e6)} -> ${Math.round(m.bytesOut / 1e6)} MB`);
  return new Uint8Array(z.buffer, z.byteOffset, z.byteLength);
}

/** a Flate part inflated in blocks of 256 KB */
function inflating(raw: Uint8Array): AsyncIterable<Buffer> {
  const inflate = zlib.createInflate({ chunkSize: 1 << 18 });
  inflate.end(raw);
  return inflate as unknown as AsyncIterable<Buffer>;
}

/** about how many stroke operators ("S" between white space) in content that comes in blocks -
 *  native searches, no parsing (the count the whole content got in one go before) */
class RoughStrokes {
  n = 0;
  private last = 0;
  private last2 = 0;
  add(b: Buffer | Uint8Array) {
    if (!b.length) return;
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    const ws = (c: number) => c === 32 || c === 10 || c === 13;
    // an "S" that ended the block before: its follower is this block's first byte
    if (this.last === 0x53 && ws(this.last2) && ws(buf[0])) this.n++;
    for (const pat of PATS) {
      for (let i = buf.indexOf(pat); i >= 0; i = buf.indexOf(pat, i + 2)) { if (ws(i ? buf[i - 1] : this.last)) this.n++; }
    }
    this.last2 = buf.length > 1 ? buf[buf.length - 2] : this.last;
    this.last = buf[buf.length - 1];
  }
}
const PATS = ['S\n', 'S ', 'S\r'].map((x) => Buffer.from(x));

/** no transparency / blend modes / soft masks in the page's graphics states (merged strokes would
 *  overlap differently) */
function opaqueStates(po: MU): boolean {
  const gs = po.getInheritable('Resources').get('ExtGState');
  if (!gs.isDictionary()) return true;
  let ok = true;
  gs.forEach((v: MU) => {
    const g = v.resolve();
    if (!g.isDictionary()) return;
    for (const k of ['CA', 'ca']) { const a = g.get(k); if (a.isNumber() && a.asNumber() < 1) ok = false; }
    const bm = g.get('BM'); if (!bm.isNull() && !(bm.isName() && bm.asName() === 'Normal')) ok = false;
    const sm = g.get('SMask'); if (!sm.isNull() && !(sm.isName() && sm.asName() === 'None')) ok = false;
  });
  return ok;
}
