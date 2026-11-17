// Pictures inside the pages of documents and bills (PLAN T6.5, DECISIONS 39-50): which pictures count,
// their fingerprints, and the visual rule that says whether two of them differ and where.
//  - counted: a picture of >= 1 % of its page and >= 36 pt each way, with fewer than 8 of the page's
//    words over it (a scan with its text layer is compared as text); a page with under 8 words is one
//    picture, the whole page (a cutsheet of photos, a drawing); furniture - the same bytes, or the
//    same box and pixel size, on 3 or more pages of a file - is left out with a note
//  - judged: the same bytes are the same; else both are drawn at one size, in colour, and three rules
//    look: the drawings' ink rule for text-like pictures (a changed digit), pooled colour for photos
//    (a re-save passes, stone -> tile does not), a 16 x 16 colour grid for both (a recolour with the
//    same pattern). Any rule that trips: changed. Cannot be drawn, or sizes far apart: changed.
import crypto from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import * as pf from './pdfium';
import type { VFile } from './files';
import { diff, defaultDiff, mergeOverlaps, type Gray, type Area } from './compare';

export interface Pic {
  /** the file's place in its set and the page (0-based) */
  file: string; page: number;
  /** where it is drawn, page space; its pixel size (0 for a whole page) */
  box: number[]; pw: number; ph: number;
  /** its stream's hash ("page:<n>" for a whole page: never the same bytes as another) */
  sha: string;
  /** the whole page, drawn (under 8 words on it) */
  whole?: boolean;
  /** its look: 16 x 16 mean colours, r g b (look-alike pictures pair as equal) */
  fp?: Uint8Array;
}
export const MIN_SHARE = 0.01, MIN_PT = 36, FEW_WORDS = 8, FURNITURE_PAGES = 3;

/** the pictures of a page that count (furniture is decided over the file: see furniture) */
export function pagePics(id: string, file: string, pg: number, words: pf.Word[], size: { w: number; h: number }): Pic[] {
  if (words.length < FEW_WORDS) {
    // (an empty page - no words, nothing drawn - is no picture)
    if (!words.length && pf.pageKind(id, pg).drawn === 0) return [];
    return [{ file, page: pg, box: [0, 0, Math.round(size.w * 10) / 10, Math.round(size.h * 10) / 10], pw: 0, ph: 0, sha: `page:${file}:${pg}`, whole: true }];
  }
  const out: Pic[] = [];
  for (const o of pf.pictures(id, pg)) {
    const b = [Math.max(0, o.box[0]), Math.max(0, o.box[1]), Math.min(size.w, o.box[2]), Math.min(size.h, o.box[3])];
    const w = b[2] - b[0], h = b[3] - b[1];
    if (w < MIN_PT || h < MIN_PT || w * h < MIN_SHARE * size.w * size.h) continue;
    // (the page's own words over it: a scan with its text layer, compared as text)
    let over = 0;
    for (const x of words) { const cx = (x.x0 + x.x1) / 2, cy = (x.y0 + x.y1) / 2; if (cx > b[0] && cx < b[2] && cy > b[1] && cy < b[3] && ++over >= FEW_WORDS) break; }
    if (over >= FEW_WORDS) continue;
    out.push({ file, page: pg, box: b, pw: o.pw, ph: o.ph, sha: o.sha });
  }
  return out;
}

/** furniture of one file: the same bytes, or the same box (± 3 pt) and pixel size and the same look, on 3 pages
 *  or more. (The look too - ritual 17 Nov: a catalogue's template puts a different product photo in the same frame
 *  on every page; same place and size alone left all of them out.) `look` absent: the place and size alone. */
export function furniture(pics: Pic[], look?: (p: Pic) => Uint8Array | undefined): Set<Pic> {
  const out = new Set<Pic>();
  const bySha = new Map<string, Set<number>>();
  for (const p of pics) if (!p.whole) { if (!bySha.has(p.sha)) bySha.set(p.sha, new Set()); bySha.get(p.sha)!.add(p.page); }
  for (const p of pics) if (!p.whole && bySha.get(p.sha)!.size >= FURNITURE_PAGES) out.add(p);
  const rest = pics.filter((p) => !p.whole && !out.has(p));
  // (each look drawn once; only pictures of the same pixel size are compared - a 1,000-page catalogue drew k x k
  //  pictures; Engineer A8)
  const looks = new Map<Pic, Uint8Array | undefined>();
  const lookOnce = (p: Pic) => { if (!looks.has(p)) looks.set(p, look!(p)); return looks.get(p); };
  const bySize = new Map<string, Pic[]>();
  for (const p of rest) { const k = p.pw + 'x' + p.ph; if (!bySize.has(k)) bySize.set(k, []); bySize.get(k)!.push(p); }
  for (const p of rest) {
    const pages = new Set<number>();
    const same = bySize.get(p.pw + 'x' + p.ph)!.filter((q) => q.box.every((v, k) => Math.abs(v - p.box[k]) <= 3));
    if (new Set(same.map((q) => q.page)).size < FURNITURE_PAGES) continue;
    const lp = look ? lookOnce(p) : undefined;
    for (const q of same) if (!look || q === p || alike(lp, lookOnce(q))) pages.add(q.page);
    if (pages.size >= FURNITURE_PAGES) out.add(p);
  }
  return out;
}

/** a region of a page drawn in colour at w x h (null: it cannot be drawn) */
function draw(id: string, p: Pic, w: number, h: number): Uint8ClampedArray | null {
  try {
    const sx = w / (p.box[2] - p.box[0]), sy = h / (p.box[3] - p.box[1]);
    return pf.renderRGBA(id, p.page, [sx, 0, 0, sy, -p.box[0] * sx, -p.box[1] * sy], w, h, false);
  } catch (e) {
    // (the engine itself broken - out of memory, aborted: not "a picture that changed"; the call fails and the
    //  engine is replaced - ritual 17 Nov)
    if (pf.isFatalError(e)) throw e;
    return null;
  }
}
/** mean colours over a g x g grid */
function grid(px: Uint8ClampedArray, w: number, h: number, g = 16): Float32Array {
  const s = new Float32Array(g * g * 3), n = new Float32Array(g * g);
  for (let y = 0; y < h; y++) { const gy = Math.min(g - 1, Math.floor((y * g) / h)); for (let x = 0; x < w; x++) { const gx = Math.min(g - 1, Math.floor((x * g) / w)), c = gy * g + gx, i = (y * w + x) * 4; s[c * 3] += px[i]; s[c * 3 + 1] += px[i + 1]; s[c * 3 + 2] += px[i + 2]; n[c]++; } }
  for (let c = 0; c < g * g; c++) for (let k = 0; k < 3; k++) s[c * 3 + k] /= n[c] || 1;
  return s;
}
/** the look of a picture: 16 x 16 mean colours (drawn at 64 x 64) */
export function lookOf(id: string, p: Pic): Uint8Array | undefined {
  const px = draw(id, p, 64, 64);
  return px ? Uint8Array.from(grid(px, 64, 64), (v) => Math.round(v)) : undefined;
}
/** a picture alone: ink on paper? (an added / removed one: OCR is tried on it - 6.5b) */
export function textLikeOf(id: string, p: Pic): boolean {
  const w = p.box[2] - p.box[0], h = p.box[3] - p.box[1], k = Math.min(1, 400 / Math.max(w, h, 1)) * 2;
  const px = draw(id, p, Math.max(8, Math.round(w * k)), Math.max(8, Math.round(h * k)));
  return !!px && textLike(px);
}
/** two pictures look alike (pairing: equal) */
export function alike(a?: Uint8Array, b?: Uint8Array): boolean {
  if (!a || !b) return false;
  let s = 0, mx = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); s += d; if (d > mx) mx = d; }
  return s / a.length < 6 && mx < 40;
}
/** ink on paper: most pixels paper, the rest mostly grey (text, lines) */
function textLike(px: Uint8ClampedArray): boolean {
  let paper = 0, grey = 0, n = 0;
  for (let i = 0; i < px.length; i += 16) {
    const r = px[i], g = px[i + 1], b = px[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    n++;
    if (mn > 200 && mx - mn < 30) paper++; else if (mx - mn < 40) grey++;
  }
  return paper >= n * 0.6 && grey >= (n - paper) * 0.7;
}
const gray = (px: Uint8ClampedArray, w: number, h: number): Gray => { const g = new Uint8Array(w * h); for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = Math.min(px[j], px[j + 1], px[j + 2]); return { w, h, px: g }; };
/** average-pooled to at most `max` px on its long side */
function pool(px: Uint8ClampedArray, w: number, h: number, max = 256): { w: number; h: number; px: Float32Array } {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / max)), W = Math.ceil(w / f), H = Math.ceil(h / f);
  const s = new Float32Array(W * H * 3), n = new Float32Array(W * H);
  for (let y = 0; y < h; y++) { const yy = (y / f) | 0; for (let x = 0; x < w; x++) { const c = yy * W + ((x / f) | 0), i = (y * w + x) * 4; s[c * 3] += px[i]; s[c * 3 + 1] += px[i + 1]; s[c * 3 + 2] += px[i + 2]; n[c]++; } }
  for (let c = 0; c < W * H; c++) for (let k = 0; k < 3; k++) s[c * 3 + k] /= n[c] || 1;
  return { w: W, h: H, px: s };
}
/** cells of a mask (w x h) joined into boxes where they touch or are within `pad` cells */
function boxesOf(m: Uint8Array, w: number, h: number, pad: number): number[][] {
  const seen = new Uint8Array(w * h), out: number[][] = [];
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || seen[i]) continue;
    const st = [i]; seen[i] = 1;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (st.length) {
      const k = st.pop()!, x = k % w, y = (k / w) | 0;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (let yy = Math.max(0, y - pad); yy <= Math.min(h - 1, y + pad); yy++) for (let xx = Math.max(0, x - pad); xx <= Math.min(w - 1, x + pad); xx++) { const j = yy * w + xx; if (m[j] && !seen[j]) { seen[j] = 1; st.push(j); } }
    }
    out.push([x0, y0, x1 + 1, y1 + 1]);
  }
  return out;
}

export interface Verdict {
  same: boolean;
  /** the rules that tripped ('ink', 'colour', 'grid', 'size', 'draw') */
  why: string[];
  /** text-like (OCR may be tried on it - 6.5b) */
  text: boolean;
  /** changed areas, page space, on each side ([] with the picture boxed whole) */
  o: number[][]; n: number[][];
  /** the picture boxed whole (no areas, over 40, or over half of it) */
  whole: boolean;
}
const MAX_AREAS = 40;

/** two pictures judged (the old in document `ido`, the new in `idn`) */
export function judge(ido: string, o: Pic, idn: string, n: Pic): Verdict {
  if (!o.whole && !n.whole && o.sha === n.sha) return { same: true, why: [], text: false, o: [], n: [], whole: false };
  const ow = o.box[2] - o.box[0], oh = o.box[3] - o.box[1], nw = n.box[2] - n.box[0], nh = n.box[3] - n.box[1];
  const changedWhole = (why: string): Verdict => ({ same: false, why: [why], text: false, o: [o.box], n: [n.box], whole: true });
  // (sizes far apart: not the same picture drawn again - a change; DECISIONS 46)
  if (Math.abs(ow / oh - nw / nh) > 0.1 * Math.max(ow / oh, nw / nh)) return changedWhole('size');
  // drawn at one size: the pictures' own density (the lower), at most 200 dpi; a whole page at 150
  const dpiOf = (p: Pic, w: number) => (p.whole || !p.pw ? 150 : (p.pw / w) * 72);
  let dpi = Math.max(50, Math.min(200, dpiOf(o, ow), dpiOf(n, nw)));
  let W = Math.round((ow / 72) * dpi), H = Math.round((oh / 72) * dpi);
  if (W * H > 4e6) { const k = Math.sqrt(4e6 / (W * H)); W = Math.round(W * k); H = Math.round(H * k); dpi *= k; }
  W = Math.max(16, W); H = Math.max(16, H);
  const po = draw(ido, o, W, H), pn = po ? draw(idn, n, W, H) : null;
  if (!po || !pn) return changedWhole('draw');
  const text = textLike(po) && textLike(pn);
  const why: string[] = [];
  // areas in picture pixels (W x H)
  let areas: number[][] = [];
  // 1. the 16 x 16 colour grid (both kinds): a recolour with the same pattern
  {
    const G = 16, a = grid(po, W, H, G), b = grid(pn, W, H, G), m = new Uint8Array(G * G);
    let k = 0;
    for (let c = 0; c < G * G; c++) { const d = Math.max(Math.abs(a[c * 3] - b[c * 3]), Math.abs(a[c * 3 + 1] - b[c * 3 + 1]), Math.abs(a[c * 3 + 2] - b[c * 3 + 2])); if (d > 20) { m[c] = 1; k++; } }
    if (k) { why.push('grid'); areas.push(...boxesOf(m, G, G, 1).map((r) => [(r[0] * W) / G, (r[1] * H) / G, (r[2] * W) / G, (r[3] * H) / G])); }
  }
  if (text) {
    // 2. text-like: the drawings' ink rule at the picture's density, with a scan's tolerance
    const pxPerMm = dpi / 25.4, opt = defaultDiff(pxPerMm);
    opt.r = Math.max(1, Math.round(0.34 * pxPerMm)); opt.t = 64; opt.minAreaPx = Math.round(opt.minAreaPx * 1.3);
    const r = diff(gray(po, W, H), gray(pn, W, H), opt);
    if (r.areas.length) { why.push('ink'); areas.push(...mergeOverlaps(r.areas, Math.round(1.5 * pxPerMm)).map((a: Area) => [a.x0, a.y0, a.x1 + 1, a.y1 + 1])); }
  } else {
    // 3. photo-like: colours after pooling to <= 256 px (a re-save or a smaller copy passes)
    const a = pool(po, W, H), b = pool(pn, W, H), m = new Uint8Array(a.w * a.h);
    let k = 0;
    for (let c = 0; c < a.w * a.h; c++) { const d = Math.max(Math.abs(a.px[c * 3] - b.px[c * 3]), Math.abs(a.px[c * 3 + 1] - b.px[c * 3 + 1]), Math.abs(a.px[c * 3 + 2] - b.px[c * 3 + 2])); if (d > 48) { m[c] = 1; k++; } }
    if (k >= Math.max(12, a.w * a.h * 0.003)) { why.push('colour'); const f = W / a.w; areas.push(...boxesOf(m, a.w, a.h, 2).map((r) => [r[0] * f, r[1] * f, Math.min(W, r[2] * f), Math.min(H, r[3] * f)])); }
  }
  if (!why.length) return { same: true, why, text, o: [], n: [], whole: false };
  // (areas together where they overlap; too many, or over half the picture: the picture boxed whole)
  areas = joinBoxes(areas);
  const cover = areas.reduce((t, a) => t + (a[2] - a[0]) * (a[3] - a[1]), 0);
  if (areas.length > MAX_AREAS || cover > W * H * 0.5) return { same: false, why, text, o: [o.box], n: [n.box], whole: true };
  const to = (p: Pic, w: number, h: number) => (a: number[]) => [p.box[0] + (a[0] / W) * w, p.box[1] + (a[1] / H) * h, p.box[0] + (a[2] / W) * w, p.box[1] + (a[3] / H) * h].map((v) => Math.round(v * 10) / 10);
  return { same: false, why, text, o: areas.map(to(o, ow, oh)), n: areas.map(to(n, nw, nh)), whole: false };
}
/** boxes that overlap joined (repeated until none do) */
function joinBoxes(bs: number[][]): number[][] {
  const out = bs.map((b) => [...b]);
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < out.length && !again; i++) for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j];
      if (a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]) { out[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; out.splice(j, 1); again = true; break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------- bills (BOQ tab)

/** a picture entry of a bill (BOQ): changed / added / removed, where on each side, the changed areas */
export interface BoqPic { what: 'changed' | 'added' | 'removed'; o?: { file: string; page: number; box: number[]; areas: number[][] }; n?: { file: string; page: number; box: number[]; areas: number[][] }; whole: boolean; text: boolean; why: string[] }
/**
 * The pictures of two issues of a bill paired as one sequence each (file by file, page by page; the
 * same bytes or a look-alike equal, the rest in order where the counts allow), each pair judged. A
 * picture whose bytes are on the other side elsewhere is the same. Bills have no text flow to pair
 * pictures in (their items are paired apart): the order of the pages is the flow.
 */
export function pairPics(O: Pic[], N: Pic[], ido: (p: Pic) => string, idn: (p: Pic) => string, furn: { o: Set<string>; n: Set<string> } = { o: new Set(), n: new Set() }): { entries: BoqPic[]; same: number } {
  const looks = new Map<Pic, Uint8Array | undefined>();
  const look = (p: Pic, id: string) => { if (!looks.has(p)) looks.set(p, lookOf(id, p)); return looks.get(p); };
  const eq = (a: Pic, b: Pic) => (!a.whole && !b.whole && a.sha === b.sha) || alike(look(a, ido(a)), look(b, idn(b)));
  // (a longest run of equal ones in order; past 2,000 x 2,000 pictures, in order where the counts allow - the
  //  table would not fit a weak PC's memory)
  const n = O.length, m = N.length, big = (n + 1) * (m + 1) > 4e6, L = new Uint32Array(big ? 1 : (n + 1) * (m + 1));
  if (!big) for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * (m + 1) + j] = eq(O[i], N[j]) ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
  const run: [number, number][] = [];
  if (!big) for (let i = 0, j = 0; i < n && j < m;) { if (eq(O[i], N[j]) && L[i * (m + 1) + j] === L[(i + 1) * (m + 1) + j + 1] + 1) { run.push([i, j]); i++; j++; } else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) i++; else j++; }
  const pairs: [number, number][] = [], lo: number[] = [], ln: number[] = [];
  let i0 = 0, j0 = 0;
  for (const [i1, j1] of [...run, [n, m] as [number, number]]) {
    const c = Math.min(i1 - i0, j1 - j0);
    for (let q = 0; q < c; q++) pairs.push([i0 + q, j0 + q]);
    for (let q = c; q < i1 - i0; q++) lo.push(i0 + q);
    for (let q = c; q < j1 - j0; q++) ln.push(j0 + q);
    if (i1 < n) pairs.push([i1, j1]);
    i0 = i1 + 1; j0 = j1 + 1;
  }
  const out: BoqPic[] = [];
  let same = 0;
  const at = (p: Pic, areas: number[][]) => ({ file: p.file, page: p.page, box: p.box, areas });
  for (const [i, j] of pairs) {
    const v = judge(ido(O[i]), O[i], idn(N[j]), N[j]);
    if (v.same) { same++; continue; }
    out.push({ what: 'changed', o: at(O[i], v.o), n: at(N[j], v.n), whole: v.whole, text: v.text, why: v.why });
  }
  // (the other side's furniture counts: a logo on two pages of one issue and on every page of the other is the same logo)
  const shaN = new Set([...N.filter((p) => !p.whole).map((p) => p.sha), ...furn.n]), shaO = new Set([...O.filter((p) => !p.whole).map((p) => p.sha), ...furn.o]);
  for (const i of lo) { if (!O[i].whole && shaN.has(O[i].sha)) { same++; continue; } out.push({ what: 'removed', o: at(O[i], [O[i].box]), whole: true, text: false, why: [] }); }
  for (const j of ln) { if (!N[j].whole && shaO.has(N[j].sha)) continue; out.push({ what: 'added', n: at(N[j], [N[j].box]), whole: true, text: false, why: [] }); }
  return { entries: out, same };
}

/** a workbook's pasted pictures: the hashes of the media each sheet draws (sheet -> sha1s, sorted) -
 *  no pixels, no OCR (DECISIONS 49) */
/** a zip's entries by name: "crc32:size" from its central directory (nothing unpacked) */
function zipCrcs(b: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) return out;
  const n = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  for (let k = 0; k < n && p + 46 <= b.length && dv.getUint32(p, true) === 0x02014b50; k++) {
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    out.set(strFromU8(b.subarray(p + 46, p + 46 + nl)), dv.getUint32(p + 16, true).toString(16) + ':' + dv.getUint32(p + 24, true));
    p += 46 + nl + xl + cl;
  }
  return out;
}
export function sheetMedia(bytes: Uint8Array): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let z: Record<string, Uint8Array>;
  // (the pictures themselves are never unpacked: each is known by its CRC-32 and size from the zip's directory - a
  //  workbook with hundreds of MB of pasted photos cost that much memory; ritual 17 Nov)
  try { z = unzipSync(bytes, { filter: (f) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/_rels\/|drawings\/_rels\/)/.test(f.name) }); } catch { return out; }
  const crcs = zipCrcs(bytes);
  const txt = (k: string) => (z[k] ? strFromU8(z[k]) : '');
  const rels = (k: string) => { const m = new Map<string, string>(); for (const r of txt(k).matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)) m.set(r[1], r[2]); for (const r of txt(k).matchAll(/<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*\bId="([^"]+)"/g)) m.set(r[2], r[1]); return m; };
  const join = (base: string, t: string) => { const parts = (t.startsWith('/') ? t.slice(1) : base + t).split('/'); const st: string[] = []; for (const x of parts) { if (x === '..') st.pop(); else if (x && x !== '.') st.push(x); } return st.join('/'); };
  const wbRels = rels('xl/_rels/workbook.xml.rels');
  for (const s of txt('xl/workbook.xml').matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"/g)) {
    const sheet = join('xl/', wbRels.get(s[2]) ?? '');
    const sr = rels(sheet.replace(/([^/]+)$/, '_rels/$1.rels'));
    const shas: string[] = [];
    for (const t of sr.values()) {
      const dr = join(sheet.replace(/[^/]+$/, ''), t);
      if (!/drawings\//.test(dr)) continue;
      for (const mt of rels(dr.replace(/([^/]+)$/, '_rels/$1.rels')).values()) { const media = join(dr.replace(/[^/]+$/, ''), mt); const c = crcs.get(media); if (c) shas.push(c); }
    }
    if (shas.length) out.set(s[1].replace(/&amp;/g, '&'), shas.sort());
  }
  return out;
}

/**
 * The files whose pictures are judged, opened again only when a picture of theirs is drawn (each side
 * is read and closed as before: an open 3,000-page spec holds ~200 MB of PDFium's caches, so keeping
 * the old side open while the new one is read lifted MEP's peak by 110 MB). Each opened on a handle of
 * its own; a file that stopped reading fails the call (READ_FAIL), as any other.
 */
export class PicDocs {
  private src = new Map<string, VFile>();
  private ids = new Map<string, string>();
  private own: VFile[] = [];
  private static seq = 0;
  add(key: string, f: VFile): void { this.src.set(key, f); }
  id(key: string): string {
    let id = this.ids.get(key);
    if (id) return id;
    const f = this.src.get(key);
    if (!f) throw new Error('picture of a file not read: ' + key);
    id = 'pic' + ++PicDocs.seq;
    const v = f.reopen();
    try { pf.openDoc(id, v); } catch (e) { v.close(); throw e; }
    this.own.push(v); this.ids.set(key, id);
    return id;
  }
  /** a file read part way only: the answer would be wrong */
  get failed(): boolean { return this.own.some((v) => v.failed); }
  close(): void { for (const id of this.ids.values()) pf.closeDoc(id); for (const v of this.own) v.close(); this.ids.clear(); this.own = []; }
}
