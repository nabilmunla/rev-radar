// Word-by-word comparison of the text on two sheets (positions matter: the same word moved
// is a change, the same word in the same place is not). Gives "4200 -> 4500" instead of just
// "something changed here". Only used to describe change areas the pictures found - text that
// changed without changing what is printed (invisible text, re-encoded fonts) is ignored there.
import type { Word } from './pdfium';

export interface TextChange { kind: 'changed' | 'added' | 'removed' | 'moved'; from?: string; to?: string; box: number[] }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const cx = (w: Word) => (w.x0 + w.x1) / 2;
const cy = (w: Word) => (w.y0 + w.y1) / 2;
const hgt = (w: Word) => Math.max(0.5, Math.min(w.x1 - w.x0, w.y1 - w.y0));

/** old words moved into the new sheet's space by affine t */
export function moveWords(ws: Word[], t: number[]): Word[] {
  return ws.map((w) => {
    const ax = t[0] * w.x0 + t[2] * w.y0 + t[4], ay = t[1] * w.x0 + t[3] * w.y0 + t[5];
    const bx = t[0] * w.x1 + t[2] * w.y1 + t[4], by = t[1] * w.x1 + t[3] * w.y1 + t[5];
    return { s: w.s, x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
  });
}

/** words by place: a grid of cells, each word in every cell its box touches (a sheet of 50,000
 *  words compares in milliseconds, not minutes) */
class Grid {
  private m = new Map<number, number[]>();
  constructor(private cell: number) {}
  private k(ix: number, iy: number) { return (ix + 50000) * 100000 + (iy + 50000); }
  add(i: number, x0: number, y0: number, x1: number, y1: number) {
    const c = this.cell;
    for (let iy = Math.floor(y0 / c); iy <= Math.floor(y1 / c); iy++) for (let ix = Math.floor(x0 / c); ix <= Math.floor(x1 / c); ix++) {
      const k = this.k(ix, iy);
      let l = this.m.get(k);
      if (!l) this.m.set(k, (l = []));
      l.push(i);
    }
  }
  /** indices of items touching the box, ascending, once each */
  near(x0: number, y0: number, x1: number, y1: number): number[] {
    const c = this.cell, out: number[] = [];
    for (let iy = Math.floor(y0 / c); iy <= Math.floor(y1 / c); iy++) for (let ix = Math.floor(x0 / c); ix <= Math.floor(x1 / c); ix++) {
      const l = this.m.get(this.k(ix, iy));
      if (l) for (const i of l) out.push(i);
    }
    out.sort((a, b) => a - b);
    let n = 0;
    for (let i = 0; i < out.length; i++) if (i === 0 || out[i] !== out[i - 1]) out[n++] = out[i];
    out.length = n;
    return out;
  }
}

/**
 * Words of old (already in new space) vs new. tol = how far (points) a word may sit from its
 * old place and still be the same word.
 */
export function textDiff(oldW: Word[], newW: Word[], tol = 1.5): TextChange[] {
  // the new words, in order, with their text; looked up by place
  const nw: { w: Word; k: string; used: boolean }[] = [];
  for (const w of newW) { const k = norm(w.s); if (k) nw.push({ w, k, used: false }); }
  const byPlace = new Grid(16);
  nw.forEach((c, i) => byPlace.add(i, cx(c.w), cy(c.w), cx(c.w), cy(c.w)));
  // the same word near the same place (the nearest; the first of equals as listed)
  const nearest = (w: Word, k: string, lim: number, dist: (a: Word, b: Word) => number) => {
    let best = -1, bd = Infinity;
    for (const i of byPlace.near(cx(w) - lim, cy(w) - lim, cx(w) + lim, cy(w) + lim)) {
      const c = nw[i];
      if (c.used || c.k !== k) continue;
      const d = dist(c.w, w);
      if (d <= lim && d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const cheb = (a: Word, b: Word) => Math.max(Math.abs(cx(a) - cx(b)), Math.abs(cy(a) - cy(b)));
  const eucl = (a: Word, b: Word) => Math.hypot(cx(a) - cx(b), cy(a) - cy(b));
  const removed: Word[] = [];
  for (const w of oldW) {
    const k = norm(w.s);
    if (!k) continue;
    const b = nearest(w, k, tol + 0.25 * hgt(w), cheb);
    if (b >= 0) nw[b].used = true;
    else removed.push(w);
  }
  // second pass: the same word a little further away = it moved (re-flowed notes, a tag
  // dragged aside) - not a text change
  const moved: TextChange[] = [];
  const still: Word[] = [];
  // ...except a number whose place now holds another number: values swapped in a schedule row
  // (1200 | 2100 -> 2100 | 1200) changed where they stand
  const isNum = (k: string) => /^[\d][\d.,/x×+-]*$/.test(k) && /\d/.test(k);
  const ov = (a: Word, b: Word) => {
    const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (ix <= 0 || iy <= 0) return 0;
    return (ix * iy) / Math.max(1e-6, Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0)));
  };
  const placeTaken = (w: Word, k: string) => {
    const lim = Math.max(2, hgt(w));
    for (const i of byPlace.near(w.x0 - lim, w.y0 - lim, w.x1 + lim, w.y1 + lim)) {
      const c = nw[i];
      if (c.k !== k && isNum(c.k) && ov(c.w, w) > 0.5) return true;
    }
    return false;
  };
  for (const w of removed) {
    const k0 = norm(w.s);
    if (isNum(k0) && placeTaken(w, k0)) { still.push(w); continue; }
    const b = nearest(w, k0, Math.max(8, 5 * hgt(w)), eucl);
    if (b >= 0) {
      const best = nw[b];
      best.used = true;
      moved.push({ kind: 'moved', from: norm(w.s), to: norm(best.w.s), box: [Math.min(w.x0, best.w.x0), Math.min(w.y0, best.w.y0), Math.max(w.x1, best.w.x1), Math.max(w.y1, best.w.y1)] });
    } else still.push(w);
  }
  removed.length = 0;
  removed.push(...still);
  // (left-over new words in the order of the old algorithm: grouped by text, first seen first)
  const groups = new Map<string, Word[]>();
  for (const c of nw) { let l = groups.get(c.k); if (!l) groups.set(c.k, (l = [])); if (!c.used) l.push(c.w); }
  const added: Word[] = [];
  for (const l of groups.values()) added.push(...l);
  const addBox = new Grid(24);
  added.forEach((a, i) => addBox.add(i, a.x0, a.y0, a.x1, a.y1));
  // a removed word and an added word in the same place = the text changed
  const out: TextChange[] = [];
  const takenAdd = new Uint8Array(added.length);
  // (only words that really share their place: a word in a crowded spot must not be paired with
  //  a neighbour's - "THK -> C/C" helps nobody)
  const area = (x0: number, y0: number, x1: number, y1: number) => Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  for (const r of removed) {
    let best = -1, bs = 0;
    for (const i of addBox.near(r.x0, r.y0, r.x1, r.y1)) {
      if (takenAdd[i]) continue;
      const a = added[i];
      if (a.x0 > r.x1 || a.x1 < r.x0 || a.y0 > r.y1 || a.y1 < r.y0) continue;
      // same direction of writing (a vertical dimension is not a horizontal note)
      const rv = r.y1 - r.y0 > (r.x1 - r.x0) * 1.2 && norm(r.s).length > 1, av = a.y1 - a.y0 > (a.x1 - a.x0) * 1.2 && norm(a.s).length > 1;
      if (rv !== av) continue;
      const inter = area(Math.max(a.x0, r.x0), Math.max(a.y0, r.y0), Math.min(a.x1, r.x1), Math.min(a.y1, r.y1));
      const share = inter / Math.max(1e-6, Math.min(area(r.x0, r.y0, r.x1, r.y1), area(a.x0, a.y0, a.x1, a.y1)));
      // and of similar height (text size)
      const hr = hgt(r), ha = hgt(a);
      if (Math.max(hr, ha) > 1.6 * Math.min(hr, ha)) continue;
      if (share > 0.5 && share > bs) { bs = share; best = i; }
    }
    if (best >= 0) {
      takenAdd[best] = 1;
      const a = added[best];
      const from = norm(r.s), to = norm(a.s);
      out.push({ kind: from === to ? 'moved' : 'changed', from, to, box: [Math.min(r.x0, a.x0), Math.min(r.y0, a.y0), Math.max(r.x1, a.x1), Math.max(r.y1, a.y1)] });
    } else out.push({ kind: 'removed', from: norm(r.s), box: [r.x0, r.y0, r.x1, r.y1] });
  }
  added.forEach((a, i) => { if (!takenAdd[i]) out.push({ kind: 'added', to: norm(a.s), box: [a.x0, a.y0, a.x1, a.y1] }); });
  return out.concat(moved);
}

/**
 * Text changes that sit inside a change area, joined into readable lines: words on one line
 * next to each other become one phrase ("PLANT ROOM" not "PLANT", "ROOM").
 */
export function phrases(list: TextChange[]): TextChange[] {
  const kinds: TextChange['kind'][] = ['changed', 'removed', 'added', 'moved'];
  const out: TextChange[] = [];
  for (const k of kinds) {
    const l = list.filter((t) => t.kind === k).sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));
    let cur: TextChange | null = null;
    for (const t of l) {
      if (cur) {
        const h = Math.max(1, Math.min(cur.box[3] - cur.box[1], t.box[3] - t.box[1]));
        const sameLine = Math.abs((cur.box[1] + cur.box[3]) / 2 - (t.box[1] + t.box[3]) / 2) < h * 0.5;
        const close = t.box[0] - cur.box[2] < h * 1.5 && t.box[0] >= cur.box[0];
        if (sameLine && close && k !== 'changed' && k !== 'moved') {
          if (cur.from != null) cur.from += ' ' + (t.from ?? '');
          if (cur.to != null) cur.to += ' ' + (t.to ?? '');
          cur.box = [Math.min(cur.box[0], t.box[0]), Math.min(cur.box[1], t.box[1]), Math.max(cur.box[2], t.box[2]), Math.max(cur.box[3], t.box[3])];
          continue;
        }
        out.push(cur);
      }
      cur = { ...t, box: t.box.slice() };
    }
    if (cur) out.push(cur);
  }
  return out;
}
