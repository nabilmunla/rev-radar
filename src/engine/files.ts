/// <reference types="node" />
// File access for the engines (they run as Node processes): PDFs are read on demand -
// only the bytes a page needs - so a 300 MB file costs a few MB of memory, not 300 MB.
//
// A source is bytes, or a file on disk, optionally "a file plus changes": the first `size`
// bytes of `path` followed by the bytes of `delta` (MuPDF's incremental save of the open
// document = the original file + appended changes, so only the appended part is written).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** mtime: the base file as it was when the changes (delta) were written against it - a file saved
 *  over in between is refused (its start is not what the changes belong to) */
export interface FileSrc { path: string; size?: number; delta?: string; mtime?: number }
export type Src = Uint8Array | FileSrc;
export const isFileSrc = (s: unknown): s is FileSrc => !!s && typeof s === 'object' && !ArrayBuffer.isView(s) && typeof (s as FileSrc).path === 'string';

/** what the engines read a document from (no file system in the engines themselves) */
export interface Reader { readonly size: number; read(buf: Uint8Array, off: number, len: number, pos: number): number; close(): void }

interface Part { fd: number; start: number; len: number }
/** read-ahead: blocks of this size, this many kept per open file (4 MB) */
const BLOCK = 256 * 1024, BLOCKS = 16;
/** read-ahead for a file read here and there (see VFile.scattered): small blocks, runs of them when
 *  the reads go on one after the other (up to 1 MB at a time), 4 MB kept */
const SMALL = 32 * 1024, SMALL_BLOCKS = 128, RUN_MAX = 32;

/** a source read in pieces; several files back to back */
export class VFile implements Reader {
  readonly parts: Part[] = [];
  readonly size: number;
  /** the file as it was read (size, time; and an appended change's size): another stamp, another file */
  readonly stamp: string;
  private closed = false;
  /** the file plus an appended change (a monster sheet's merged strokes) */
  get layered() { return this.parts.length > 1; }
  /** a read came back short or failed (network drive dropped, file cut short or replaced while
   *  open): what PDFium drew from it can't be trusted */
  failed = false;
  /** what it was opened from (opened again from it: reopen) */
  readonly src: FileSrc;
  constructor(src: FileSrc) {
    this.src = { ...src };
    const fds: number[] = [];
    let stamp = '';
    try {
      const a = fs.openSync(src.path, 'r');
      fds.push(a);
      const st = fs.fstatSync(a);
      const full = st.size;
      stamp = `${src.path}|${st.size}|${st.mtimeMs}`;
      if (src.delta && src.mtime != null && Math.abs(st.mtimeMs - src.mtime) > 1) throw new Error('The file was changed meanwhile');
      const baseLen = src.delta ? Math.min(full, src.size ?? full) : full;
      this.parts.push({ fd: a, start: 0, len: baseLen });
      if (src.delta) {
        const b = fs.openSync(src.delta, 'r');
        fds.push(b);
        this.parts.push({ fd: b, start: baseLen, len: fs.fstatSync(b).size });
        stamp += `|${src.delta}|${this.parts[1].len}`;
      }
    } catch (e) {
      for (const f of fds) try { fs.closeSync(f); } catch { /* */ }
      throw e;
    }
    this.size = this.parts.reduce((s, p) => s + p.len, 0);
    this.stamp = stamp;
  }
  /**
   * read len bytes at pos into buf[off..]; returns bytes read (short only at the end). Small reads
   * go through a few 256 KB blocks read ahead: PDFium asks for a document piece by piece, and on a
   * network drive every request is a round trip.
   */
  read(buf: Uint8Array, off: number, len: number, pos: number): number {
    if (this.closed) return 0;
    const B = this.block;
    if (len >= B) return this.readRaw(buf, off, len, pos);
    let done = 0;
    while (done < len) {
      const at = pos + done, bi = Math.floor(at / B);
      let blk = this.blocks.get(bi);
      if (blk) { this.blocks.delete(bi); this.blocks.set(bi, blk); } // most recent last
      else {
        // (scattered: a miss right after the last one doubles the run read in one go - a stream read
        //  through costs few round trips, an object here and there costs 32 KB, not 256)
        const run = this.small ? (this.run = bi === this.lastMiss + 1 ? Math.min(RUN_MAX, this.run * 2) : 1) : 1;
        const want = Math.max(0, Math.min(B * run, this.size - bi * B));
        if (!want) break;
        const b = new Uint8Array(want);
        const got = this.readRaw(b, 0, want, bi * B);
        if (got < want) { const n = Math.min(len - done, Math.max(0, got - (at - bi * B))); buf.set(b.subarray(at - bi * B, at - bi * B + n), off + done); return done + n; }
        for (let k = 0; k * B < want; k++) {
          this.blocks.set(bi + k, want > B ? b.slice(k * B, Math.min(want, (k + 1) * B)) : b); // (copies: a run's buffer is not held by one block left)
          if (this.blocks.size > this.keep) this.blocks.delete(this.blocks.keys().next().value as number);
        }
        this.lastMiss = bi + Math.ceil(want / B) - 1;
        blk = this.blocks.get(bi)!;
      }
      const o = at - bi * B, n = Math.min(len - done, blk.length - o);
      if (n <= 0) break;
      buf.set(blk.subarray(o, o + n), off + done);
      done += n;
    }
    return done;
  }
  private blocks = new Map<number, Uint8Array>();
  private block = BLOCK;
  private keep = BLOCKS;
  private small = false;
  private run = 1;
  private lastMiss = -2;
  /**
   * Read-ahead for a file read here and there - the BOQ / Documents PDFs, the heavy look - set before
   * the first read: PDFium and MuPDF ask for a page's objects ~1-8 KB at a time, scattered over the
   * file, and 256 KB blocks read ~50 MB to size the pages of a 400 MB file. (The Drawings' files keep
   * the 256 KB blocks.)
   */
  scattered(): this {
    this.blocks.clear();
    this.block = SMALL; this.keep = SMALL_BLOCKS; this.small = true;
    return this;
  }
  private readRaw(buf: Uint8Array, off: number, len: number, pos: number): number {
    let done = 0;
    for (const p of this.parts) {
      if (done >= len) break;
      const at = pos + done;
      if (at >= p.start + p.len || at < p.start) continue;
      const want = Math.min(len - done, p.start + p.len - at);
      let got = 0;
      while (got < want) {
        let n = 0;
        try { n = fs.readSync(p.fd, buf, off + done + got, want - got, at - p.start + got); } catch (e) { this.failed = true; throw e; }
        if (n <= 0) break; // file shorter than expected
        got += n;
      }
      done += got;
      if (got < want) { this.failed = true; break; }
    }
    return done;
  }
  /** the same source opened again - a handle of its own, for a document kept open after the call
   *  whose file this is (a call's files are closed when it ends). Its stamp says what it found. */
  reopen(): VFile { const v = new VFile(this.src); return this.small ? v.scattered() : v; }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.blocks.clear();
    for (const p of this.parts) try { fs.closeSync(p.fd); } catch { /* already closed */ }
  }
}

export const workDir = () => path.join(os.tmpdir(), 'Rev Radar', 'work');

let tmpSeq = 0;
/** a fresh temp file path (its folder exists) */
export function tempPath(name = 'file.pdf'): string {
  const d = path.join(workDir(), process.pid + '-' + Date.now().toString(36) + '-' + (++tmpSeq));
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, name.replace(/[\\/:*?"<>|]/g, '_'));
}

/** write a view (e.g. straight out of the engine's memory) in pieces - no extra copy */
export function writeView(p: string, view: Uint8Array, from = 0) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'w');
  try {
    const CH = 16 << 20;
    for (let o = from; o < view.length; o += CH) {
      const end = Math.min(view.length, o + CH);
      let w = o;
      while (w < end) w += fs.writeSync(fd, view, w, end - w);
    }
  } finally { fs.closeSync(fd); }
}

/** remove temp files we made (only inside our work folder) */
export function removeTemp(paths: string[]) {
  const root = path.resolve(workDir()) + path.sep;
  for (const p of paths) {
    if (!p) continue;
    const f = path.resolve(p);
    if (!f.startsWith(root)) continue;
    try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* still open somewhere: cleaned at next start */ }
  }
}

export function statOf(p: string): { size: number; mtime: number } | null {
  try { const s = fs.statSync(p); return { size: s.size, mtime: s.mtimeMs }; } catch { return null; }
}
