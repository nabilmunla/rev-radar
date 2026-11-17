// Side by side - the BOQ and Documents tabs' view of two issues: the old on the left, the new on the
// right, as they were issued - a PDF's own pages (the changes drawn on them) - or as rows (a workbook's
// sheet, a PDF's table as read, a Word file's paragraphs). A click on a change brings the other side
// to its counterpart - in whatever sheet or file it is now - set at the same height; scrolling either
// side keeps the other with it, on the sheet / file where the things in view went, kept level by the
// things paired between the two. What is shown and how a row looks is the tab's (BoqSide, DocsSide).
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons';
import { viewer } from './engines';
import { fileArg } from '../engine/rpc';
import { layoutText, canvasMeasure, forgetWidths, geom, type LayBlock, type Layout } from './textlay';

/** a row (a sheet's, a paragraph's) */
export const RH = 22;
/** the column letters' row over a sheet (sticky, inside the scroll box) */
export const HEAD = 20;
/** a PDF: space over the first page, beside the pages (px); between pages (points) */
export const PAD = 10, MARGIN = 12, GAP = 8;
/** room under the last row / page, a pane high: anything - the last too - can be set level with its counterpart */
export const room = (h: number) => Math.max(0, h);
export type Side = 'o' | 'n';
export const SIDES: Side[] = ['o', 'n'];
export const other = (s: Side): Side => (s === 'o' ? 'n' : 'o');
/** (T8) the chip in the legend row: which changes N / P go through and the change map shows. `all`: every one,
 *  nothing left out - the default (DECISIONS 21); the others only when the user picks them. */
export type Chip = 'all' | 'figs' | 'todo';
export interface ChipProps {
  value: Chip; set: (c: Chip) => void;
  /** how many changes each chip holds now */
  n: Record<Chip, number>;
  /** does entry e belong under the chip chosen */
  ok: (e: number) => boolean;
  /** changes when what the chip holds may have changed (a tick given) - the change map is made again */
  rev: number;
  /** the words for what is shown, with a chip chosen (the choice is said, never silent) */
  what: string;
}
/** a box on a PDF page: [x0, y0, x1, y1] in points */
export interface Box { pg: number; b: number[] }

/** a change where it is shown: its entry, the thing and its counterpart, where it starts and ends
 *  (units: rows; a PDF's points, its pages one under the other) */
export interface Mark<I> {
  kind: string; e: number; o?: I; n?: I; u0: number; u1: number;
  /** the thing's own text the same (moved, renumbered, a heading over it reworded): drawn light */
  minor: boolean;
  /** rows: its first and last row, the columns changed; the mark of its first row */
  a: number; b: number; first: boolean; cells?: Set<number>;
  /** a PDF: the bands it is marked with (one a page it is on), the boxes inside them changed (cells, words) */
  segs: Box[]; hot: Box[];
  /** what tests know it by (an item's row, a paragraph's place) */
  id?: number;
}
/** a line marked for what is under it: a heading reworded over items that are the same */
export interface Extra { e: number; kind: string; title: string; box?: Box; row?: number; /** drawn only with the minor changes */ minor?: boolean }
/** what a side shows: a PDF file (its pages) or rows */
export interface Doc<I> {
  key: string; label: string; tab: string; pdf: boolean; len: number; flen: number;
  marks: Mark<I>[]; ticks: Mark<I>[]; major: Mark<I>[]; changes: number;
  /** rows: the marks by row; the extra lines by row */
  byRow?: Map<number, Mark<I>>; extraRows?: Map<number, Extra>;
  /** a PDF: the file, its pages one under the other, the marks and extra lines by page */
  path?: string; sizes?: { w: number; h: number }[]; tops?: number[]; maxW?: number; byPage?: Map<number, Mark<I>[]>; extras?: Map<number, Extra[]>;
  /** the page width fit to the pane: most pages' (a few wide pages - an A3 schedule - scroll sideways) */
  fitW?: number;
  /** scrolling kept level in "flow": a PDF's text at full weight, the rest of each page (header,
   *  footer, the gap) at a fraction - a page break falls in different places in two issues */
  fu?: number[]; ff?: number[];
  /** what the tab's rows need */
  data?: unknown;
  /** a text doc ("Text as read", T7): its blocks, laid out to the pane here - its units are block indices (and
   *  a fraction of one), so marks, anchors and N / P stay put when the width or the zoom changes */
  text?: TBlock[];
}
/** a block of a text doc: see textlay.ts; `hot`: the words of its text changed (their places in it split at
 *  the spaces; a table row: the cells joined " | "), struck on the old side and marked on the new */
export interface TBlock extends LayBlock { hot?: Set<number> }
export interface Place<I> { doc: Doc<I>; u0: number; u1: number; a: number; b: number; segs: Box[] }
export interface Model<I> {
  docs: Record<Side, Doc<I>[]>;
  byKey: Record<Side, Map<string, Doc<I>>>;
  /** a doc's match on the other side: where most of what is in it went */
  match: Record<Side, Map<string, string>>;
  /** things paired between two docs, in order on both: [old flow, new flow] */
  anchors: Map<string, [number, number][]>;
  /** each doc's paired things in order: where each is, the doc its counterpart is in */
  near: Record<Side, Map<string, { u: number; other: string }[]>>;
  place: (side: Side, x: I) => Place<I> | null;
  pdfs: boolean;
}
export const pairKey = (o: string, n: string) => o + '\u0001' + n;

const lerp = (xs: number[], ys: number[], x: number) => {
  if (x <= xs[0]) return ys[0] + (x - xs[0]);
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1] + (x - xs[xs.length - 1]);
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  return ys[lo] + ((x - xs[lo]) * (ys[hi] - ys[lo])) / Math.max(1e-9, xs[hi] - xs[lo]);
};
export const flowOf = <I,>(d: Doc<I>, u: number) => (d.fu ? lerp(d.fu, d.ff!, u) : u);
export const unitOf = <I,>(d: Doc<I>, f: number) => (d.fu ? lerp(d.ff!, d.fu, f) : f);

/** a PDF doc: its pages one under the other (fit to the widest), its flow from where its text is on
 *  each page (`text`: top, bottom by page) */
export function pdfDoc<I>(key: string, label: string, path: string, sizes: { w: number; h: number }[], text: Map<number, [number, number]>): Doc<I> {
  const tops: number[] = [];
  let y = 0;
  for (const z of sizes) { tops.push(y); y += z.h + GAP; }
  const fu: number[] = [0], ff: number[] = [0];
  let f = 0;
  const W = 0.15;
  sizes.forEach((z, p) => {
    const top = tops[p], t = text.get(p);
    const end = p + 1 < sizes.length ? tops[p + 1] : top + z.h;
    if (t && t[1] > t[0]) {
      const a = Math.max(0, t[0] - 4), b = Math.min(z.h, t[1] + 4);
      f += a * W; fu.push(top + a); ff.push(f);
      f += b - a; fu.push(top + b); ff.push(f);
      f += (end - top - b) * W; fu.push(end); ff.push(f);
    } else { f += (end - top) * W; fu.push(end); ff.push(f); }
  });
  const ws = sizes.map((z) => z.w).sort((a, b) => a - b);
  return { key, label, tab: label.replace(/\.(pdf|docx)$/i, ''), pdf: true, len: Math.max(1, y - GAP), flen: Math.max(1, f), fu, ff, marks: [], ticks: [], major: [], changes: 0, path, sizes, tops, maxW: Math.max(1, ...ws), fitW: Math.max(1, ws[ws.length >> 1] ?? 1), byPage: new Map(), extras: new Map() };
}
/** a text doc: its blocks one under the other (a unit = a block) */
export function textDoc<I>(key: string, label: string, blocks: TBlock[], data?: unknown): Doc<I> {
  return { key, label, tab: label.replace(/\.(pdf|docx)$/i, ''), pdf: false, len: Math.max(1, blocks.length), flen: Math.max(1, blocks.length), marks: [], ticks: [], major: [], changes: 0, byRow: new Map(), extraRows: new Map(), text: blocks, data };
}
/** PDF docs' tabs: their names without what they all share at the start and the end
 *  ("Client OS 3A - Project- Tower 1 & 2 _Bill-3 (Tower 1) 2026.06.04.pdf" -> "Bill-3 (Tower 1)") */
export function shortTabs<I>(docs: Doc<I>[]) {
  const pdfs = docs.filter((x) => x.pdf || x.text);
  if (pdfs.length < 2) return;
  const names = pdfs.map((x) => x.label.replace(/\.(pdf|docx)$/i, ''));
  let k = 0, e = 0;
  while (names.every((nm) => nm.length > k + 3 && nm[k] === names[0][k])) k++;
  while (k > 0 && !/[\s_(]/.test(names[0][k - 1])) k--;
  while (names.every((nm) => nm.length - e - 1 > k + 3 && nm[nm.length - 1 - e] === names[0][names[0].length - 1 - e])) e++;
  while (e > 0 && !/[\s_]/.test(names[0][names[0].length - e])) e--;
  pdfs.forEach((x, i) => { x.tab = names[i].slice(k, names[i].length - e).replace(/^[\s_-]+|[\s_-]+$/g, '') || names[i]; });
}
/** a mark added to its doc (by page / by row), counted */
export function addMark<I>(d: Doc<I>, mk: Mark<I>) {
  if (d.pdf) {
    for (const pg of new Set(mk.segs.map((x) => x.pg))) { if (!d.byPage!.has(pg)) d.byPage!.set(pg, []); d.byPage!.get(pg)!.push(mk); }
  } else {
    d.byRow ??= new Map();
    for (let i = mk.a; i <= mk.b; i++) if (!d.byRow.has(i)) d.byRow.set(i, i === mk.a ? mk : { ...mk, first: false });
  }
  d.marks.push(mk);
  d.changes++;
}
/** the docs matched (where most of what is in each went), the anchors (pairs in order on both - the
 *  longest such run) and what is near what, from the pairs' places */
export function linkDocs<I>(docs: Record<Side, Doc<I>[]>, pairs: [Place<I>, Place<I>][]): Pick<Model<I>, 'match' | 'anchors' | 'near'> {
  for (const side of SIDES) for (const d of docs[side]) { d.ticks = d.marks.slice().sort((x, y) => x.u0 - y.u0); d.major = d.ticks.filter((x) => !x.minor); }
  const count = new Map<string, number>();
  const lists = new Map<string, [number, number][]>();
  const near: Model<I>['near'] = { o: new Map(), n: new Map() };
  const nearOf = (side: Side, k: string) => { if (!near[side].has(k)) near[side].set(k, []); return near[side].get(k)!; };
  for (const [a, b] of pairs) {
    nearOf('o', a.doc.key).push({ u: a.u0, other: b.doc.key });
    nearOf('n', b.doc.key).push({ u: b.u0, other: a.doc.key });
    const k = pairKey(a.doc.key, b.doc.key);
    count.set(k, (count.get(k) || 0) + 1);
    if (!lists.has(k)) lists.set(k, []);
    lists.get(k)!.push([flowOf(a.doc, a.u0), flowOf(b.doc, b.u0)]);
  }
  const match: Model<I>['match'] = { o: new Map(), n: new Map() };
  const best: Record<Side, Map<string, number>> = { o: new Map(), n: new Map() };
  for (const [k, c] of count) {
    const [a, b] = k.split('\u0001');
    if (c > (best.o.get(a) ?? 0)) { best.o.set(a, c); match.o.set(a, b); }
    if (c > (best.n.get(b) ?? 0)) { best.n.set(b, c); match.n.set(b, a); }
  }
  // (a doc nothing went from or to: the one of the same name, else the one in the same place)
  for (const side of SIDES) docs[side].forEach((d, i) => {
    if (match[side].has(d.key)) return;
    const others = docs[other(side)];
    const same = others.find((x) => x.tab.toLowerCase() === d.tab.toLowerCase()) ?? others[Math.min(i, others.length - 1)];
    if (same) match[side].set(d.key, same.key);
  });
  const anchors = new Map<string, [number, number][]>();
  for (const [k, l] of lists) {
    l.sort((x, y) => x[0] - y[0]);
    const tails: number[] = [], prev = new Array<number>(l.length).fill(-1), at2: number[] = [];
    l.forEach(([, b], i) => {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] < b) lo = m + 1; else hi = m; }
      tails[lo] = b; at2[lo] = i; prev[i] = lo ? at2[lo - 1] : -1;
    });
    const run: [number, number][] = [];
    for (let i = tails.length ? at2[tails.length - 1] : -1; i >= 0; i = prev[i]) run.unshift(l[i]);
    anchors.set(k, run);
  }
  for (const side of SIDES) for (const l of near[side].values()) l.sort((x, y) => x.u - y.u);
  return { match, anchors, near };
}

/** the place on the other side level with `x` on this side (flow), by the anchors round it - the ends
 *  of both docs anchors too (a tail of added pages maps onto the other's tail) */
function level(anchors: [number, number][], x: number, from: Side, lenTo: number, lenFrom: number): number {
  const A = from === 'o' ? 0 : 1, B = 1 - A;
  if (!anchors.length) return lenFrom ? (x * lenTo) / lenFrom : 0;
  let lo = 0, hi = anchors.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (anchors[m][A] <= x) lo = m + 1; else hi = m; }
  const p = anchors[lo - 1], q = anchors[lo];
  let y: number;
  if (!p) y = q[B] - ((q[A] - x) * q[B]) / Math.max(1e-9, q[A]);
  else if (!q) y = p[B] + ((x - p[A]) * (lenTo - p[B])) / Math.max(1e-9, lenFrom - p[A]);
  else y = p[B] + ((x - p[A]) * (q[B] - p[B])) / Math.max(1e-9, q[A] - p[A]);
  return Math.max(0, Math.min(lenTo, y));
}

// ---------------------------------------------------------------- a PDF's page pictures
const pics = new Map<string, { p: Promise<ImageBitmap>; t: number; bytes: number }>();
let picClock = 0;
/** the pictures kept: at most ~250 MB (a page at twice the screen's pixels in a wide pane is ~18 MB) */
const PIC_BYTES = 250e6;
function trimPictures() {
  let total = 0;
  for (const v of pics.values()) total += v.bytes;
  if (total <= PIC_BYTES && pics.size <= 60) return;
  for (const [kk, v] of [...pics].sort((a, b) => a[1].t - b[1].t)) {
    if ((total <= PIC_BYTES && pics.size <= 60) || !v.bytes) continue;
    pics.delete(kk); total -= v.bytes;
    void v.p.then((b) => b.close()).catch(() => {});
  }
}
function picture(path: string, page: number, scale: number): Promise<ImageBitmap> {
  const k = `${path}\u0000${page}\u0000${scale}`;
  const had = pics.get(k);
  if (had) { had.t = ++picClock; return had.p; }
  const e = { p: null as unknown as Promise<ImageBitmap>, t: ++picClock, bytes: 0 };
  e.p = viewer.call<{ rgba: Uint8ClampedArray; W: number; H: number }>('boqPage', [fileArg(path), page, scale])
    .then((r) => { e.bytes = r.W * r.H * 4; return createImageBitmap(new ImageData(new Uint8ClampedArray(r.rgba.buffer as ArrayBuffer, r.rgba.byteOffset, r.W * r.H * 4), r.W, r.H)); })
    .then((b) => { trimPictures(); return b; });
  e.p.catch(() => pics.delete(k));
  pics.set(k, e);
  return e.p;
}
function dropPictures() {
  for (const v of pics.values()) void v.p.then((b) => b.close()).catch(() => {});
  pics.clear();
  void viewer.call('boqPagesDone').catch(() => {});
}
/** a page as a picture, drawn when it comes (a moment after it is scrolled to: not for every page flown past) */
const Page = memo(function Page({ path, page, scale }: { path: string; page: number; scale: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      picture(path, page, scale).then((b) => {
        const c = ref.current;
        if (!live || !c) return;
        c.width = b.width; c.height = b.height;
        c.getContext('2d')!.drawImage(b, 0, 0);
        setFailed(false);
      }, () => { if (live) setFailed(true); });
    }, pics.has(`${path}\u0000${page}\u0000${scale}`) ? 0 : 60);
    return () => { live = false; clearTimeout(t); };
  }, [path, page, scale]);
  return <>{failed && <span className="pdf-fail">Page {page + 1} could not be drawn</span>}<canvas ref={ref} className="pdf-pic" /></>;
});

/** what a tab's rows are drawn with */
export interface RowsCtx<I> {
  top: number; h: number; sel: Place<I> | null; minor: boolean;
  shows: (mk?: Mark<I>) => boolean; ticked: (e: number) => boolean; titleOf: (mk: Mark<I>) => string;
  click: (mk: Mark<I>) => void; clickExtra: (x: Extra, u: number) => void;
}
export interface SideViewProps<I> {
  m: Model<I>;
  /** the entry chosen (-1: none), an entry's things, choose one */
  sel: number; itemsOf: (e: number) => { o?: I; n?: I }; choose: (e: number) => void;
  ticked: (e: number) => boolean; titleOf: (mk: Mark<I>) => string;
  /** a doc that is no PDF drawn as rows; what its header says */
  rows?: (side: Side, d: Doc<I>, ctx: RowsCtx<I>) => ReactNode; rowsNote?: (d: Doc<I>) => string;
  /** the tools bar: the tab's own (before the zoom), the legend; the strip under the two sides */
  tools?: ReactNode; /** a line under the tools (why a file is shown as it is) */ note?: ReactNode; legend: (minor: boolean) => ReactNode; strip: (shown: { e: number; o?: I; n?: I } | null) => ReactNode;
  /** where the "Minor changes" choice is kept; what it means; what a pane says with nothing in it */
  minorKey: string; minorTitle: string; empty: string; what: string;
  /** (T8) the chips All / Figures / To review in the legend row */
  chip?: ChipProps;
  /** what tests know a thing by */
  idOf?: (x: I) => number | undefined;
}

export function SideView<I>(P: SideViewProps<I>) {
  const { m } = P;
  const first = (side: Side) => m.docs[side][0]?.key ?? '';
  const [key, setKey] = useState<Record<Side, string>>(() => ({ o: first('o'), n: m.match.o.get(first('o')) ?? first('n') }));
  const [top, setTop] = useState<Record<Side, number>>({ o: 0, n: 0 });
  const [size, setSize] = useState<Record<Side, { w: number; h: number }>>({ o: { w: 600, h: 600 }, n: { w: 600, h: 600 } });
  const [zoom, setZoom] = useState(1);
  // the minor changes (the thing's own text the same) - shown light, or hidden
  const [minor, setMinorState] = useState(() => { try { return localStorage.getItem(P.minorKey) !== 'off'; } catch { return true; } });
  const setMinor = (v: boolean) => { try { localStorage.setItem(P.minorKey, v ? 'on' : 'off'); } catch { /* fine */ } setMinorState(v); };
  const chipOn = !!P.chip && P.chip.value !== 'all';
  const shows = (mk?: Mark<I>) => !!mk && (minor || !mk.minor) && (!chipOn || P.chip!.ok(mk.e));
  // (T8) the change map under the chip: made again only when the doc, the minor switch or the chip's content changes)
  const tickMemo = useMemo(() => new Map<string, Mark<I>[]>(), [m, minor, chipOn, P.chip?.value, P.chip?.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const ticksOf = (d: Doc<I>): Mark<I>[] => {
    const all = minor ? d.ticks : d.major;
    if (!chipOn) return all;
    let t = tickMemo.get(d.key);
    if (!t) { t = all.filter((x) => P.chip!.ok(x.e)); tickMemo.set(d.key, t); }
    return t;
  };
  const box = { o: useRef<HTMLDivElement>(null), n: useRef<HTMLDivElement>(null) };
  // a scroll the view made itself (not the user's): where it went, so its event is not followed
  const sent = useRef<Record<Side, number | null>>({ o: null, n: null });
  const pending = useRef<Record<Side, number | null>>({ o: null, n: null });
  const fromGrid = useRef(false);
  // each side's last scrollTop: a scroll event that did not move it up or down (a sideways scroll) is not followed
  const lastTop = useRef<Record<Side, number>>({ o: 0, n: 0 });
  // each side's place kept when the scale changes (zoom, the pane's width): the thing chosen where it
  // is in view, else the place 1/3 down - its unit, how far down the pane, the scale it was drawn at
  const unitAt = useRef<Record<Side, { key: string; u: number; off: number; k: number } | null>>({ o: null, n: null });
  const items = P.sel >= 0 ? P.itemsOf(P.sel) : null;
  // the thing shown: the entry's, or - a heading reworded over many - the one clicked
  const [focus, setFocus] = useState<{ e: number; o?: I; n?: I } | null>(null);
  const shown = focus && focus.e === P.sel ? focus : items ? { e: P.sel, ...items } : null;
  const anchor = (side: Side, d: Doc<I>, y: number) => {
    const h = box[side].current?.clientHeight ?? 600, k = scaleOf(side, d);
    const x = shown ? (side === 'o' ? shown.o : shown.n) : undefined;
    const p = x ? m.place(side, x) : null;
    if (p && p.doc.key === d.key) { const off = toPx(side, d, p.u0) - y; if (off > 0 && off < h - 20) return { key: d.key, u: p.u0, off, k }; }
    return { key: d.key, u: toU(side, d, y + h / 3), off: h / 3, k };
  };

  // (the docs shown kept to ones there are: the view switched)
  const doc = (side: Side) => m.byKey[side].get(key[side]) ?? m.docs[side][0];
  /** px a unit, and where unit 0 is in the scroll box: rows; a PDF's points, fit to the pane */
  const kOf = (side: Side, d?: Doc<I>) => (!d || !d.pdf ? RH : zoom * Math.max(0.1, (size[side].w - 2 * MARGIN) / (d.fitW ?? d.maxW!)));
  const top0 = (d?: Doc<I>) => (d?.pdf ? PAD : HEAD);
  // text docs (T7): laid out to the pane's width at the zoom - the layout kept per doc until either changes
  // (the face's metrics are in once it is loaded: the text laid out again then)
  const [fontTick, setFontTick] = useState(0);
  useEffect(() => {
    let live = true;
    const again = () => { if (live) { forgetWidths(); setFontTick((t) => t + 1); } };
    void document.fonts?.ready.then(again);
    document.fonts?.addEventListener?.('loadingdone', again);
    return () => { live = false; document.fonts?.removeEventListener?.('loadingdone', again); };
  }, []);
  const lays = useRef(new WeakMap<Doc<I>, { k: string; L: Layout & { id: number } }>());
  const layId = useRef(0);
  const textW = (side: Side) => Math.max(240, Math.floor(size[side].w / 8) * 8);
  const lay = (side: Side, d: Doc<I>): Layout & { id: number } => {
    const k = `${textW(side)}|${zoom}|${fontTick}`, had = lays.current.get(d);
    if (had && had.k === k) return had.L;
    const family = (box[side].current ? getComputedStyle(box[side].current!).fontFamily : '') || 'sans-serif';
    const L = { ...layoutText(d.text!, textW(side), zoom, canvasMeasure(family, zoom)), id: ++layId.current };
    lays.current.set(d, { k, L });
    return L;
  };
  /** a place in a doc (unit) in px down the scroll box, and back */
  const toPx = (side: Side, d: Doc<I>, u: number) => (d.text ? HEAD + lay(side, d).px(u) : top0(d) + u * kOf(side, d));
  const toU = (side: Side, d: Doc<I>, px: number) => (d.text ? lay(side, d).unit(px - HEAD) : (px - top0(d)) / kOf(side, d));
  /** what the units are drawn at: changes when the doc is drawn again (zoom, width) */
  const scaleOf = (side: Side, d: Doc<I>) => (d.text ? lay(side, d).id : kOf(side, d));
  const height = (side: Side, d?: Doc<I>) => (d ? (d.text ? HEAD + lay(side, d).total : top0(d) + d.len * kOf(side, d)) + room(size[side].h) : 0);

  const scrollTo = (side: Side, k: string, px: number) => {
    const d = m.byKey[side].get(k);
    if (!d) return;
    const h = box[side].current?.clientHeight ?? 0;
    const y = Math.round(Math.max(0, Math.min(Math.max(0, height(side, d) - h), px)));
    if (k !== doc(side)?.key) { pending.current[side] = y; setKey((kk) => ({ ...kk, [side]: k })); return; }
    const el = box[side].current;
    if (el) put(side, el, y);
  };
  /** a side scrolled by the view: where it really went (the box may hold it short) is remembered, so its event is not followed */
  const put = (side: Side, el: HTMLDivElement, y: number) => {
    const was = el.scrollTop;
    el.scrollTop = y;
    const got = el.scrollTop;
    sent.current[side] = Math.abs(got - was) >= 1 ? got : null;
    lastTop.current[side] = got;
    const d = doc(side);
    if (d) unitAt.current[side] = anchor(side, d, got);
    setTop((t) => ({ ...t, [side]: got }));
  };
  // a doc just switched: its scroll set once it is drawn
  useLayoutEffect(() => {
    for (const side of SIDES) {
      const y = pending.current[side];
      const el = box[side].current;
      if (y === null || !el) continue;
      pending.current[side] = null;
      put(side, el, y);
    }
  });
  // the panes' sizes
  useEffect(() => {
    const ro = new ResizeObserver(() => setSize({ o: { w: box.o.current?.clientWidth ?? 600, h: box.o.current?.clientHeight ?? 600 }, n: { w: box.n.current?.clientWidth ?? 600, h: box.n.current?.clientHeight ?? 600 } }));
    for (const side of SIDES) if (box[side].current) ro.observe(box[side].current!);
    return () => ro.disconnect();
  }, []);
  // the PDF's pictures let go when the view goes
  useEffect(() => () => dropPictures(), []);
  // a PDF drawn bigger or smaller (zoom, the pane's width): the same place kept in view
  useLayoutEffect(() => {
    for (const side of SIDES) {
      const d = doc(side), el = box[side].current;
      if (!d || !el) continue;
      const k = scaleOf(side, d);
      const was = unitAt.current[side];
      if (was && was.key === d.key && Math.abs(was.k - k) > 1e-6 && pending.current[side] === null) put(side, el, toPx(side, d, was.u) - was.off);
      else unitAt.current[side] = anchor(side, d, el.scrollTop);
    }
  });
  // ctrl + wheel over a PDF: zoom (both sides)
  useEffect(() => {
    const on = (ev: WheelEvent) => { if (!ev.ctrlKey) return; ev.preventDefault(); setZoom((z) => Math.max(0.5, Math.min(4, z * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)))); };
    const els = SIDES.map((x) => box[x].current).filter(Boolean) as HTMLDivElement[];
    for (const el of els) el.addEventListener('wheel', on, { passive: false });
    return () => { for (const el of els) el.removeEventListener('wheel', on); };
  });

  /** the doc on the other side matching this place on this side: where most of the things round it went
   *  (a PDF of every bill against a workbook of a sheet a bill: the sheet of the bill in view; a part
   *  split in two or two made one: the half in view) - the one shown kept on a tie */
  const matchAt = (side: Side, A: Doc<I>, ua: number): string | undefined => {
    const L = m.near[side].get(A.key);
    if (!L?.length) return m.match[side].get(A.key);
    let lo = 0, hi = L.length;
    while (lo < hi) { const md = (lo + hi) >> 1; if (L[md].u < ua) lo = md + 1; else hi = md; }
    const tally = new Map<string, number>();
    for (let i = lo - 1, j = lo, c = 0; c < 15 && (i >= 0 || j < L.length); c++) {
      if (j >= L.length || (i >= 0 && ua - L[i].u <= L[j].u - ua)) { tally.set(L[i].other, (tally.get(L[i].other) || 0) + 1); i--; }
      else { tally.set(L[j].other, (tally.get(L[j].other) || 0) + 1); j++; }
    }
    const now = doc(other(side))?.key;
    let best: string | undefined, bc = -1;
    for (const [k, c] of tally) if (c > bc || (c === bc && k === now)) { best = k; bc = c; }
    return best;
  };
  /** the other side brought level with this side's scroll (1/3 down) - on the doc matching that place */
  const follow = (side: Side, y: number, A = doc(side)) => {
    const b = other(side);
    if (!A) return;
    const ref = (box[side].current?.clientHeight ?? 600) / 3;
    const ua = toU(side, A, y + ref);
    const k = matchAt(side, A, ua);
    const B = k ? m.byKey[b].get(k) : undefined;
    if (!B) return;
    const an = m.anchors.get(side === 'o' ? pairKey(A.key, B.key) : pairKey(B.key, A.key)) ?? [];
    const ub = unitOf(B, level(an, flowOf(A, ua), side, B.flen, A.flen));
    scrollTo(b, B.key, toPx(b, B, ub) - ref);
  };
  const onScroll = (side: Side) => {
    const el = box[side].current!;
    const y = el.scrollTop;
    if (Math.abs(y - lastTop.current[side]) < 1) return; // (sideways only)
    lastTop.current[side] = y;
    setTop((t) => ({ ...t, [side]: y }));
    const d = doc(side);
    if (d) unitAt.current[side] = anchor(side, d, y);
    const was = sent.current[side];
    if (was !== null && Math.abs(was - y) < 2) { sent.current[side] = null; return; }
    sent.current[side] = null;
    follow(side, y);
  };

  /** a thing and its counterpart shown: each side at it, level with each other (`side` clicked: its
   *  top is `off` px down the pane - the other side is set to that) */
  const show = (e: { o?: I; n?: I }, side?: Side, off?: number) => {
    const at = { o: e.o !== undefined ? m.place('o', e.o) : null, n: e.n !== undefined ? m.place('n', e.n) : null };
    const y0 = off ?? Math.round((box.o.current?.clientHeight ?? 600) / 3);
    const go = (sd: Side, p: Place<I>) => scrollTo(sd, p.doc.key, toPx(sd, p.doc, p.u0) - y0);
    if (side) {
      const b = other(side), t = at[b];
      if (t) go(b, t);
      else if (at[side]) follow(side, box[side].current?.scrollTop ?? 0); // (added / removed: the other side where it would be)
      return;
    }
    for (const sd of SIDES) { const p = at[sd]; if (p) go(sd, p); }
    // (added / removed: the other side where it would be, on the matching doc)
    for (const sd of SIDES) {
      const p = at[sd], b = other(sd);
      if (!p || at[b]) continue;
      const k = matchAt(sd, p.doc, p.u0), B = k ? m.byKey[b].get(k) : undefined;
      if (!B) continue;
      const an = m.anchors.get(sd === 'o' ? pairKey(p.doc.key, B.key) : pairKey(B.key, p.doc.key)) ?? [];
      scrollTo(b, B.key, toPx(b, B, unitOf(B, level(an, flowOf(p.doc, p.u0), sd, B.flen, p.doc.flen))) - y0);
    }
  };
  // the choice changed from the list or N / P: both sides to it
  useEffect(() => {
    if (fromGrid.current) { fromGrid.current = false; return; }
    if (items) show(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [P.sel]);
  // the view switched (PDF pages / rows): both sides to the change chosen
  useEffect(() => { if (shown) show(shown); }, [m]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (mk: Mark<I>) => {
    fromGrid.current = P.sel !== mk.e;
    setFocus({ e: mk.e, o: mk.o, n: mk.n });
    P.choose(mk.e);
  };
  /** a change clicked: its entry chosen; the other side to its counterpart, level */
  const clickMark = (side: Side, mk: Mark<I>) => {
    choose(mk);
    const d = doc(side)!;
    show(mk, side, toPx(side, d, mk.u0) - (box[side].current?.scrollTop ?? 0));
  };
  /** an extra line clicked (a heading reworded): the change under it (the first one below it) */
  const clickExtra = (side: Side, x: Extra, u: number) => {
    const d = doc(side)!;
    const mk = d.ticks.find((t) => t.e === x.e && t.u0 >= u) ?? d.ticks.find((t) => t.e === x.e);
    if (mk) clickMark(side, mk);
  };
  /** a change picked on the bar beside the scrollbar: both sides to it */
  const pickMark = (_side: Side, mk: Mark<I>) => { choose(mk); show(mk); };
  const pickRef = useRef(pickMark);
  pickRef.current = pickMark;
  const onPick = useMemo(() => (side: Side, mk: Mark<I>) => pickRef.current(side, mk), []);
  const pickDoc = (side: Side, k: string) => {
    scrollTo(side, k, 0);
    const A = m.byKey[side].get(k);
    if (A) follow(side, 0, A);
  };

  const sel: Record<Side, Place<I> | null> = { o: null, n: null };
  if (shown) for (const side of SIDES) { const x = side === 'o' ? shown.o : shown.n; sel[side] = x !== undefined ? m.place(side, x) : null; }
  const idOf = (x?: I) => (x !== undefined && P.idOf ? P.idOf(x) : undefined);

  const pdfPages = (side: Side, d: Doc<I>) => {
    const k = kOf(side, d), t = top[side], h = size[side].h;
    const u0 = (t - PAD) / k - 40, u1 = (t + h - PAD) / k + 40;
    // (pictures drawn a little sharper than the screen, in steps - not again for every pixel of width)
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = Math.pow(1.1, Math.round(Math.log(k * dpr) / Math.log(1.1)));
    const sl = sel[side]?.doc === d ? sel[side] : null;
    const W = 2 * MARGIN + d.maxW! * k;
    const r = (b: number[]) => ({ left: b[0] * k, top: b[1] * k, width: (b[2] - b[0]) * k, height: (b[3] - b[1]) * k });
    const out = [];
    for (let p = 0; p < d.sizes!.length; p++) {
      const z = d.sizes![p], y = d.tops![p];
      if (y > u1 || y + z.h < u0) continue;
      const marks = (d.byPage!.get(p) ?? []).filter(shows);
      out.push(
        <div key={p} className="pdf-page" data-pg={p} style={{ top: PAD + y * k, left: Math.max(MARGIN, (W - z.w * k) / 2), width: z.w * k, height: z.h * k }}>
          <Page path={d.path!} page={p} scale={scale} />
          {(d.extras!.get(p) ?? []).filter((x) => (minor || !x.minor) && (!chipOn || P.chip!.ok(x.e))).map((x, i) => (
            <div key={'x' + i} className={'pdf-head mk-' + x.kind} data-e={x.e} style={r(x.box!.b)} onClick={() => clickExtra(side, x, y + x.box!.b[1])} title={x.title} />
          ))}
          {marks.map((mk, i) => mk.segs.filter((sg) => sg.pg === p).map((sg, j) => (
            <div key={i + '.' + j} className={'pdf-mk mk-' + mk.kind + (mk.minor ? ' minor' : '') + (P.ticked(mk.e) ? ' ticked' : '')} data-e={mk.e} data-row={mk.id ?? idOf(side === 'o' ? mk.o : mk.n)}
              style={r(sg.b)} onClick={() => clickMark(side, mk)} title={P.titleOf(mk)} />
          )))}
          {marks.map((mk, i) => mk.hot.filter((x) => x.pg === p).map((x, j) => <i key={'h' + i + '.' + j} className={'pdf-hot mk-' + mk.kind + (mk.minor ? ' minor' : '') + (P.ticked(mk.e) ? ' ticked' : '')} style={r(x.b)} />))}
          {sl && sl.segs.filter((sg) => sg.pg === p).map((sg, j) => <div key={'s' + j} className="pdf-sel" data-row={idOf(side === 'o' ? shown?.o : shown?.n)} style={r(sg.b)} />)}
        </div>,
      );
    }
    return <div className="pdf-doc" style={{ height: height(side, d), width: W }}>{out}</div>;
  };

  /** a text doc's blocks: each as high as its measured lines, the words changed struck (old) / marked (new) */
  const textBlocks = (side: Side, d: Doc<I>, c: RowsCtx<I>) => {
    const L = lay(side, d), g = geom(zoom), blocks = d.text!;
    const W = textW(side);
    const from = Math.max(0, Math.floor(L.unit(c.top - HEAD - 40)) - 2), to = Math.min(blocks.length, Math.ceil(L.unit(c.top - HEAD + c.h + 40)) + 2);
    const cls = side === 'o' ? 'tw-x' : 'tw-m';
    /** the words, the changed ones (`hot`, from `at`) in spans of their own: the same text, joined by single spaces */
    const words = (t: string, hot: Set<number> | undefined, at: number) => {
      if (!hot || !hot.size) return t;
      const ws = t.split(/\s+/).filter(Boolean), out: ReactNode[] = [];
      let run: string[] = [];
      ws.forEach((w, i) => {
        if (hot.has(at + i)) { if (run.length) { out.push(run.join(' ') + ' '); run = []; } out.push(<span key={i} className={cls}>{w}</span>); if (i + 1 < ws.length) out.push(' '); } else run.push(w);
      });
      if (run.length) out.push(run.join(' '));
      return out;
    };
    const out: ReactNode[] = [];
    for (let i = from; i < to; i++) {
      const b = blocks[i], m0 = d.byRow!.get(i), mk = c.shows(m0) ? m0 : undefined;
      const on = !!c.sel && i >= c.sel.a && i <= c.sel.b;
      const hot = mk ? b.hot : undefined;
      let at = 0;
      out.push(
        <div key={i} className={'sbs-row sbs-block' + (b.pic ? ' tx-pic' : '') + (mk ? ' mk mk-' + mk.kind + (mk.minor ? ' minor' : '') : '') + (on ? ' on' : '') + (mk && c.ticked(mk.e) ? ' ticked' : '')}
          style={{ top: L.tops[i], height: L.hs[i], paddingTop: g.padY / 2, fontSize: g.fs, lineHeight: g.lh + 'px' }}
          onClick={mk ? () => c.click(mk.first ? mk : d.byRow!.get(mk.a)!) : undefined} data-row={i} data-e={mk?.e} title={mk ? c.titleOf(mk) : undefined}>
          {b.head ? <div className="tx-head" style={{ height: g.headH, lineHeight: g.headH + 'px', fontSize: g.headFs }} title={b.head}>{b.head}</div> : null}
          <div className="tx-line">
            <span className="tx-num" style={{ width: g.numW }}>{b.num}</span>
            {b.cells
              ? <span className="tx-cells" style={{ padding: `0 ${g.padX}px` }}>{b.cells.map((t, k) => { const a0 = at; at += (t.split(/\s+/).filter(Boolean).length) + 1; return <span key={k} className="sbs-c tx-cell" style={{ padding: `0 ${g.cellPad}px` }}>{words(t, hot, a0)}</span>; })}</span>
              : <span className="sbs-c tx-text" style={{ padding: `0 ${g.padX}px` }}>{b.pic ?? words(b.text, hot, 0)}</span>}
          </div>
        </div>,
      );
    }
    return (
      <>
        <div className="sbs-cols sbs-para"><span>¶</span><span className="d">Text as read - the paragraphs, wrapped to the pane</span></div>
        <div className="sbs-rows" style={{ height: L.total + room(c.h), width: W }}>{out}</div>
      </>
    );
  };

  const pane = (side: Side) => {
    const d = doc(side);
    const label = side === 'o' ? 'Old issue' : 'New issue';
    if (!d) return <div className="sbs-pane" data-side={side}><div className="sbs-head"><b>{label}</b></div><div className="empty">{P.empty}</div></div>;
    const [file, sheet] = d.key.split('\u0000');
    const k = kOf(side, d);
    const u0 = toU(side, d, top[side]), u1 = toU(side, d, top[side] + size[side].h);
    const pn = d.pdf ? d.tops!.findIndex((y, p) => PAD + (y + d.sizes![p].h) * k > top[side] + size[side].h / 3) : -1;
    const pageNow = d.pdf ? (pn < 0 ? d.sizes!.length - 1 : pn) : -1;
    const ctx: RowsCtx<I> = { top: top[side], h: size[side].h, sel: sel[side]?.doc === d ? sel[side] : null, minor, shows, ticked: P.ticked, titleOf: P.titleOf, click: (mk) => clickMark(side, mk), clickExtra: (x, u) => clickExtra(side, x, u) };
    return (
      <div className="sbs-pane" data-side={side} data-mode={d.pdf ? 'pdf' : d.text ? 'text' : 'grid'} data-file={d.pdf ? sheet : file} data-sheet={d.pdf ? '' : sheet} data-top={top[side]}>
        <div className="sbs-head">
          <b>{label}</b> <span className="faint">{d.label}{d.pdf ? ` - page ${pageNow + 1} of ${d.sizes!.length}` : P.rowsNote ? P.rowsNote(d) : ''}</span>
        </div>
        <div className="sbs-body">
          <div className={'sbs-scroll' + (d.pdf ? ' pdf' : '')} ref={box[side]} onScroll={() => onScroll(side)} data-side={side}>
            {d.pdf ? pdfPages(side, d) : d.text ? textBlocks(side, d, ctx) : P.rows?.(side, d, ctx)}
          </div>
          <div className="sbs-map" title="Where the changes are - click to go there">
            <Ticks ticks={ticksOf(d)} len={d.len} side={side} pick={onPick} />
            <span className="sbs-view" style={{ top: `${Math.max(0, u0 / d.len) * 100}%`, height: `${Math.min(100, ((u1 - u0) / Math.max(1, d.len)) * 100)}%` }} />
          </div>
        </div>
        <div className="sbs-tabs">
          {m.docs[side].map((x) => { const c = minor ? x.changes : x.major.length; return <button key={x.key} className={'sbs-tab' + (x.key === d.key ? ' on' : '')} onClick={() => pickDoc(side, x.key)} title={x.label + (c ? ` - ${c} ${P.what}${c === 1 ? '' : 's'} marked` : '')}>{x.pdf && <Icon n="file" size={12} />}{x.tab}{c ? <span className="n">{c}</span> : null}</button>; })}
        </div>
      </div>
    );
  };

  const anyPdfShown = SIDES.some((x) => doc(x)?.pdf || doc(x)?.text);
  return (
    <div className="sbs">
      <div className="sbs-tools">
        {P.tools}
        {anyPdfShown && (
          <span className="sbs-zoom">
            <button className="btn sm" onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))} title="Smaller (Ctrl + wheel)">−</button>
            <button className="btn sm" onClick={() => setZoom(1)} title="Page width">{Math.round(zoom * 100)}%</button>
            <button className="btn sm" onClick={() => setZoom((z) => Math.min(4, z * 1.25))} title="Bigger (Ctrl + wheel)">+</button>
          </span>
        )}
        {P.chip && (
          <span className="sbs-chips" role="group" aria-label="Which changes N and P go through">
            {([['all', 'All', 'Every change - nothing is left out (N / P go through all of them)'], ['figs', 'Figures', 'Only the changes in figures: a number, a unit, a grade, a standard or a finish code changed - N / P and the change map show only these'], ['todo', 'To review', 'Only the changes not ticked off yet - N / P and the change map show only these']] as [Chip, string, string][]).map(([c, label, tip]) => (
              <button key={c} className={'fchip' + (P.chip!.value === c ? ' on' : '')} title={tip} onClick={() => P.chip!.set(c)}>{label} <span className="n">{P.chip!.n[c]}</span></button>
            ))}
            {chipOn && <span className="sbs-chipnote" title="The other changes are not hidden for good - click All">Showing {P.chip.what}: {P.chip.n[P.chip.value]} of {P.chip.n.all} - <button className="linkbtn" onClick={() => P.chip!.set('all')}>show all</button></span>}
          </span>
        )}
        {P.legend(minor)}
        <label className="check sm sbs-minor" title={P.minorTitle}>
          <input type="checkbox" checked={minor} onChange={(ev) => setMinor(ev.target.checked)} /> Minor changes
        </label>
      </div>
      {P.note && <div className="sbs-note">{P.note}</div>}
      <div className="sbs-panes">{pane('o')}{pane('n')}</div>
      {P.strip(shown)}
    </div>
  );
}

/** the changes on the bar beside a pane's scrollbar (drawn again only when the doc changes) */
const Ticks = memo(function Ticks<I>({ ticks, len, side, pick }: { ticks: Mark<I>[]; len: number; side: Side; pick: (side: Side, mk: Mark<I>) => void }) {
  return <>{ticks.map((mk, i) => <span key={i} data-e={mk.e} className={'mk-' + mk.kind + (mk.minor ? ' minor' : '')} style={{ top: `${(mk.u0 / Math.max(1, len)) * 100}%` }} onClick={() => pick(side, mk)} />)}</>;
}) as <I>(p: { ticks: Mark<I>[]; len: number; side: Side; pick: (side: Side, mk: Mark<I>) => void }) => JSX.Element;

/** a legend: what the colours mean, in words - the minor ones drawn light */
export function Legend({ minor, major, light }: { minor: boolean; major: [string, string, string][]; light: [string, string, string][] }) {
  const one = ([k, l, t]: [string, string, string], isLight = false) => <span key={k} className={'lg' + (isLight ? ' minor' : '')} title={t}><i className={'mk-' + k + (isLight ? ' minor' : '')} />{l}</span>;
  return (
    <span className="sbs-legend" aria-label="What the colours mean">
      {major.map((x) => one(x))}
      {minor && light.length > 0 && <><span className="lg-sep">minor:</span>{light.map((x) => one(x, true))}</>}
    </span>
  );
}
