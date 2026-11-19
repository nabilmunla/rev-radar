// The BOQ tab's side-by-side view (sideview.tsx): a PDF BOQ's own pages - each changed item marked
// with a band across the page's table, its changed cells boxed, a heading line reworded boxed - or a
// workbook's sheet as laid out (rows, the columns that hold anything), or a PDF's table as it was read.
import { useMemo, useState } from 'react';
import { bump } from './model';
import { Icon } from './icons';
import { summary, fmt, wordDiff, ticksChanged, needsCheck, boqMates, boqTickGroup, chipOk, isFigure, type BoqEntry, type BoqSession, itemCount } from './boqrun';
import { FigChip, SameChange } from './DocsSide';
import { billOf, type BoqGrid, type BoqItem, type BoqResult } from '../engine/boq';
import { PIC_LABEL } from '../engine/docs';
import { SideView, Legend, pdfDoc, shortTabs, addMark, linkDocs, SIDES, RH, room, type Chip, type Side, type Doc, type Mark, type Model, type Place, type RowsCtx, type Extra } from './sideview';

type MarkKind = 'changed' | 'moved' | 'heading' | 'renum' | 'added' | 'removed' | 'pic';
/** a sheet shown as rows: the grid, its rows by sheet row, column widths */
interface Grid { grid: BoqGrid; rowAt: Map<number, number>; widths: string; minW: number }
const sheetKey = (file: string, sheet: string) => file + '\u0000' + sheet;
const pdfKey = (file: string) => 'pdf\u0000' + file;
/** a word as compared (a heading's words told apart from the ones changed) */
const wkey = (w: string) => w.toLowerCase().replace(/[^a-z0-9]+/g, '');

function build(r: BoqResult, entries: BoqEntry[], s: BoqSession, pages: boolean): Model<BoqItem> {
  const docs: Record<Side, Doc<BoqItem>[]> = { o: [], n: [] };
  const byKey: Model<BoqItem>['byKey'] = { o: new Map(), n: new Map() };
  /** the sheets as read (a PDF's too: its items' places on the page are on its rows) */
  const sheets: Record<Side, Map<string, { grid: BoqGrid; rowAt: Map<number, number> }>> = { o: new Map(), n: new Map() };
  /** a PDF page's table: its left, right, top and bottom */
  const tables: Record<Side, Map<string, Map<number, number[]>>> = { o: new Map(), n: new Map() };
  let anyPdf = false;
  for (const [side, doc, set] of [['o', r.old, s.oldSet], ['n', r.neu, s.newSet]] as const) {
    const pdfs = new Map((doc.pdfs ?? []).map((p) => [p.name, p]));
    const shown = new Map<string, { name: string; path: string; sizes: { w: number; h: number }[] }>();
    for (const sh of doc.sheets) {
      if (!sh.grid) continue;
      const g = sh.grid;
      const rowAt = new Map<number, number>();
      g.rows.forEach((row, i) => rowAt.set(row, i));
      sheets[side].set(sheetKey(sh.file ?? '', sh.sheet ?? sh.name), { grid: g, rowAt });
      // (the table's place on each page of a PDF: the band an item is marked across; the text's top and bottom)
      const pdf = g.bx && pdfs.get(sh.file ?? '');
      if (pdf) {
        anyPdf = true;
        const k = pdfKey(pdf.name);
        if (!tables[side].has(k)) tables[side].set(k, new Map());
        const tb = tables[side].get(k)!;
        g.bx!.forEach((b, i) => { if (!b) return; const pg = g.pg![i], t = tb.get(pg); tb.set(pg, t ? [Math.min(t[0], b[0]), Math.max(t[1], b[2]), Math.min(t[2], b[1]), Math.max(t[3], b[3])] : [b[0], b[2], b[1], b[3]]); });
      }
      if (!sh.items) continue;
      if (pdf && pages && set.files[pdf.idx]?.path) {
        if (!shown.has(pdf.name)) { shown.set(pdf.name, { name: pdf.name, path: set.files[pdf.idx].path, sizes: pdf.sizes }); docs[side].push(null as never); }
        continue;
      }
      const key = sheetKey(sh.file ?? '', sh.sheet ?? sh.name);
      // column widths: the description takes the room; the rest by what they hold (first 400 rows)
      // (a sheet whose description column was not found: the widest column takes the room)
      const w = g.cols.map((_, c) => {
        let m = 3;
        for (let i = 0; i < Math.min(g.cells.length, 400); i++) m = Math.max(m, (g.cells[i][c] ?? '').length);
        return m;
      });
      const wide = g.at.desc >= 0 ? g.at.desc : w.indexOf(Math.max(...w));
      const px = w.map((m, c) => (c === wide ? 240 : Math.max(44, Math.min(150, Math.round(m * 7.2 + 14)))));
      const tpl = px.map((x, c) => (c === wide ? 'minmax(240px, 1fr)' : x + 'px'));
      const lead = 48 + (g.pg ? 40 : 0);
      const data: Grid = { grid: g, rowAt, widths: `48px ${g.pg ? '40px ' : ''}${tpl.join(' ')}`, minW: lead + px.reduce((a, b) => a + b, 0) };
      const one: Doc<BoqItem> = { key, label: sh.name, tab: sh.name, pdf: false, len: g.rows.length, flen: g.rows.length, marks: [], ticks: [], major: [], changes: 0, byRow: new Map(), extraRows: new Map(), data };
      docs[side].push(one); byKey[side].set(key, one);
    }
    // a PDF file: its pages, in the place of its first sheet among the docs
    const made = [...shown.values()].map((f) => {
      const tb = tables[side].get(pdfKey(f.name)) ?? new Map<number, number[]>();
      const d = pdfDoc<BoqItem>(pdfKey(f.name), f.name, f.path, f.sizes, new Map([...tb].map(([pg, t]) => [pg, [t[2], t[3]] as [number, number]])));
      byKey[side].set(d.key, d);
      return d;
    });
    docs[side] = docs[side].map((d) => d ?? made.shift()!).filter(Boolean);
  }
  // the tabs: the sheet's own name - with its bill (or file) where two files have a sheet of that name
  for (const side of SIDES) {
    const seen = new Map<string, number>();
    for (const x of docs[side]) if (!x.pdf) { const nm = x.key.split('\u0000')[1]; seen.set(nm, (seen.get(nm) || 0) + 1); }
    shortTabs(docs[side]);
    for (const x of docs[side]) {
      if (x.pdf) continue;
      const [file, nm] = x.key.split('\u0000');
      x.tab = (seen.get(nm) || 0) > 1 ? `${billOf(file) || file.replace(/\.[^.]+$/, '')} › ${nm}` : nm;
    }
  }
  interface At extends Place<BoqItem> { pg: number; y0: number; y1: number; rows: number[]; tb?: number[] }
  const place = (side: Side, x: BoqItem): At | null => {
    // (a picture's stand-in - T6.5: where the picture is on its page)
    const w = (x as PicItem).picAt;
    if (w) {
      const d = byKey[side].get(pdfKey(w.file));
      if (!d || !d.pdf || !d.tops || w.page >= d.tops.length) return null;
      return { doc: d, u0: d.tops[w.page] + w.box[1], u1: d.tops[w.page] + w.box[3], a: 0, b: 0, segs: [{ pg: w.page, b: [w.box[0] - 3, w.box[1] - 3, w.box[2] + 3, w.box[3] + 3] }], pg: w.page, y0: w.box[1], y1: w.box[3], rows: [] };
    }
    const sh = sheets[side].get(sheetKey(x.file, x.sheet));
    const a = sh?.rowAt.get(x.row);
    if (!sh || a === undefined) return null;
    const b = sh.rowAt.get(x.last ?? x.row) ?? a;
    const d = byKey[side].get(pdfKey(x.file)) ?? byKey[side].get(sheetKey(x.file, x.sheet));
    if (!d) return null;
    if (!d.pdf) return { doc: d, u0: a, u1: b + 1, a, b, segs: [], pg: -1, y0: 0, y1: 0, rows: [] };
    const g = sh.grid, pg = g.pg?.[a] ?? -1;
    if (pg < 0 || !d.tops || pg >= d.tops.length) return null;
    let y0 = Infinity, y1 = -Infinity;
    const rows: number[] = [];
    for (let i = a; i <= b; i++) { const bx = g.bx?.[i]; if (bx && g.pg![i] === pg) { y0 = Math.min(y0, bx[1]); y1 = Math.max(y1, bx[3]); rows.push(i); } }
    if (!rows.length) return null;
    const tb = tables[side].get(d.key)?.get(pg) ?? [0, d.sizes![pg].w];
    return { doc: d, u0: d.tops[pg] + y0, u1: d.tops[pg] + y1, a, b, segs: [{ pg, b: [tb[0] - 2, y0, tb[1] + 2, y1] }], pg, y0, y1, rows, tb };
  };
  // the marks: each entry's item(s) - on a PDF a band across the page's table, the changed cells boxed
  const FIELD: Record<string, keyof BoqGrid['at']> = { qty: 'qty', unit: 'unit', rate: 'rate', amount: 'amount', text: 'desc' };
  const mark = (side: Side, x: BoqItem, kind: MarkKind, fields: string[], e: number, o?: BoqItem, n?: BoqItem) => {
    const p = place(side, x);
    if (!p) return;
    const d = p.doc;
    const g = sheets[side].get(sheetKey(x.file, x.sheet))!.grid;
    const cols = new Set<number>();
    for (const f of fields) { const k = FIELD[f]; if (k && g.at[k] >= 0) cols.add(g.at[k]); }
    if (fields.includes('renumbered') && g.at.item >= 0) cols.add(g.at.item);
    // (a heading reworded is no minor change: the heading says what the item is - "3mm aluminium sheet"
    //  and "25mm steel plate" are priced apart; moved and letter only are)
    const mk: Mark<BoqItem> = { kind, e, o, n, u0: p.u0, u1: p.u1, minor: kind === 'moved' || kind === 'renum', a: p.a, b: p.b, first: true, cells: cols, segs: [], hot: [], id: x.row };
    if (d.pdf) {
      mk.segs = [{ pg: p.pg, b: [p.tb![0] - 3, p.y0 - 1.5, p.tb![1] + 3, p.y1 + 1.5] }];
      for (const c of cols) {
        let x0 = Infinity, x1 = -Infinity;
        for (const i of p.rows) { const bx = g.bx![i]!; if (Number.isFinite(bx[4 + 2 * c])) { x0 = Math.min(x0, bx[4 + 2 * c]); x1 = Math.max(x1, bx[5 + 2 * c]); } }
        if (x0 < x1) mk.hot.push({ pg: p.pg, b: [x0 - 2, p.y0 - 1.5, x1 + 2, p.y1 + 1.5] });
      }
    }
    addMark(d, mk);
  };
  entries.forEach((e, ei) => {
    // (a picture inside a page - T6.5: banded whole on the page, its changed areas boxed)
    if (e.pic) {
      for (const side of SIDES) {
        const w = side === 'o' ? e.pic.o : e.pic.n;
        const d = w && byKey[side].get(pdfKey(w.file));
        if (!w || !d || !d.pdf || !d.tops || w.page >= d.tops.length) continue;
        const b = w.box;
        addMark(d, { kind: 'pic', e: ei, o: picItem(e).o, n: picItem(e).n, u0: d.tops[w.page] + b[1], u1: d.tops[w.page] + b[3], minor: false, a: 0, b: 0, first: true, cells: new Set(), segs: [{ pg: w.page, b: [b[0] - 3, b[1] - 3, b[2] + 3, b[3] + 3] }], hot: w.areas.map((a) => ({ pg: w.page, b: [a[0] - 1.5, a[1] - 1.5, a[2] + 1.5, a[3] + 1.5] })), id: -1 });
      }
      return;
    }
    if (e.kind === 'added') { mark('n', e.n!, 'added', [], ei, undefined, e.n); return; }
    if (e.kind === 'removed') { mark('o', e.o!, 'removed', [], ei, e.o); return; }
    const pairs = e.kind === 'heading' ? e.items! : [e.pair!];
    for (const q of pairs) {
      const ch = [...q.changed, ...(q.renumbered ? ['renumbered'] : [])];
      // (what the item's own line shows first: a figure or its words changed; else moved; else the
      //  heading above it reworded; else its letter only)
      const own = q.changed.some((f) => f !== 'group' && f !== 'section');
      const kind: MarkKind = own ? 'changed' : q.moved ? 'moved' : q.changed.length ? 'heading' : 'renum';
      const xo = r.old.items[q.o], xn = r.neu.items[q.n];
      mark('o', xo, kind, ch, ei, xo, xn);
      mark('n', xn, kind, ch, ei, xo, xn);
    }
  });
  // the heading lines reworded: over an item whose heading changed, the lines above it holding the
  // words taken out (old) / put in (new) - up to the block of headings they are in
  const itemRows: Record<Side, Map<string, Set<number>>> = { o: new Map(), n: new Map() };
  for (const [side, doc] of [['o', r.old], ['n', r.neu]] as const) for (const x of doc.items) {
    const k = sheetKey(x.file, x.sheet), sh = sheets[side].get(k), a = sh?.rowAt.get(x.row);
    if (a === undefined) continue;
    if (!itemRows[side].has(k)) itemRows[side].set(k, new Set());
    const b = sh!.rowAt.get(x.last ?? x.row) ?? a;
    for (let i = a; i <= b; i++) itemRows[side].get(k)!.add(i);
  }
  const diffs = new Map<string, Record<Side, Set<string>>>();
  const headDone = new Set<string>();
  const TITLE = 'This heading was reworded (the items under it are the same)';
  const markHeads = (side: Side, x: BoqItem, words: Set<string>, e: number) => {
    if (!words.size) return;
    const k = sheetKey(x.file, x.sheet), sh = sheets[side].get(k), a = sh?.rowAt.get(x.row);
    if (!sh || a === undefined) return;
    const d = byKey[side].get(pdfKey(x.file)) ?? byKey[side].get(k);
    if (!d) return;
    const g = sh.grid, items = itemRows[side].get(k) ?? new Set<number>();
    const dc = g.at.desc >= 0 ? g.at.desc : 0;
    let found = false;
    for (let i = a - 1, n = 0; i >= 0 && n < 160; i--, n++) {
      if (items.has(i)) { if (found) break; continue; }
      const t = (g.cells[i][dc] || g.cells[i].join(' ')).split(/\s+/).map(wkey).filter(Boolean);
      if (!t.length) continue;
      if (t.some((w) => words.has(w))) {
        found = true;
        const id = d.key + '|' + i;
        if (headDone.has(id)) continue;
        headDone.add(id);
        const ex: Extra = { e, kind: 'heading', title: TITLE };
        if (d.pdf) { const b = g.bx?.[i], pg = g.pg?.[i] ?? -1; if (b && pg >= 0) { if (!d.extras!.has(pg)) d.extras!.set(pg, []); d.extras!.get(pg)!.push({ ...ex, box: { pg, b: [b[0] - 3, b[1] - 1.5, b[2] + 3, b[3] + 1.5] } }); } }
        else d.extraRows!.set(i, { ...ex, row: i });
      } else if (found) break;
    }
  };
  entries.forEach((e, ei) => {
    const pairs = e.kind === 'heading' ? e.items! : e.pair ? [e.pair] : [];
    for (const q of pairs) {
      if (!q.changed.includes('group') && !q.changed.includes('section')) continue;
      const xo = r.old.items[q.o], xn = r.neu.items[q.n];
      const dk = xo.section + '\u0000' + xo.group + '\u0001' + xn.section + '\u0000' + xn.group;
      if (!diffs.has(dk)) {
        const w: Record<Side, Set<string>> = { o: new Set(), n: new Set() };
        for (const dd of wordDiff(xo.section + ' ' + xo.group, xn.section + ' ' + xn.group)) {
          if (dd.op === '=') continue;
          for (const t of dd.t.split(/\s+/).map(wkey).filter((t) => t.length > 1 || /\d/.test(t))) w[dd.op === '-' ? 'o' : 'n'].add(t);
        }
        diffs.set(dk, w);
      }
      const w = diffs.get(dk)!;
      markHeads('o', xo, w.o, ei);
      markHeads('n', xn, w.n, ei);
    }
  });
  // docs matched by where their items went, and the anchors between them
  const pl: [Place<BoqItem>, Place<BoqItem>][] = [];
  for (const p of r.pairs) { const a = place('o', r.old.items[p.o]), b = place('n', r.neu.items[p.n]); if (a && b) pl.push([a, b]); }
  return { docs, byKey, ...linkDocs(docs, pl), place, pdfs: anyPdf };
}

/** a sheet's rows (a workbook's, or a PDF's table as read) */
function rows(side: Side, d: Doc<BoqItem>, c: RowsCtx<BoqItem>) {
  const { grid: g, widths, minW } = d.data as Grid;
  const from = Math.max(0, Math.floor((c.top - 20) / RH) - 8), to = Math.min(g.rows.length, Math.ceil((c.top + c.h) / RH) + 8);
  const out = [];
  for (let i = from; i < to; i++) {
    const m0 = d.byRow!.get(i), mk = c.shows(m0) ? m0 : undefined;
    const x0 = !mk ? d.extraRows!.get(i) : undefined, he = x0 && (c.minor || !x0.minor) ? x0 : undefined;
    const on = c.sel && i >= c.sel.a && i <= c.sel.b;
    out.push(
      <div key={i} className={'sbs-row' + (mk ? ' mk mk-' + mk.kind + (mk.minor ? ' minor' : '') : '') + (he ? ' hl mk-heading' : '') + (on ? ' on' : '') + (mk && c.ticked(mk.e) ? ' ticked' : '')} style={{ top: i * RH, gridTemplateColumns: widths }}
        onClick={mk ? () => c.click(mk.first ? mk : d.byRow!.get(mk.a)!) : he ? () => c.clickExtra(he, i) : undefined} data-row={g.rows[i]} data-e={mk?.e ?? he?.e} data-first={mk ? (mk.first ? 1 : 0) : undefined} title={mk ? c.titleOf(mk) : he?.title}>
        <span className="sbs-rn">{g.rows[i]}</span>
        {g.pg && <span className="sbs-rn">{g.pg[i] >= 0 ? 'p.' + (g.pg[i] + 1) : ''}</span>}
        {g.cells[i].map((t, k) => <span key={k} className={'sbs-c' + (mk?.cells?.has(k) ? ' chg' : '') + (k === g.at.qty || k === g.at.rate || k === g.at.amount ? ' num' : '')} title={t.length > 30 ? t : undefined}>{t}</span>)}
      </div>,
    );
  }
  return (
    <>
      <div className="sbs-cols" style={{ gridTemplateColumns: widths, minWidth: minW }}>
        <span />{g.pg && <span>page</span>}{g.cols.map((col, k) => <span key={k} className={k === g.at.desc ? 'd' : ''}>{colName(col)}</span>)}
      </div>
      <div className="sbs-rows" style={{ height: d.len * RH + room(c.h), minWidth: minW }}>{out}</div>
    </>
  );
}

export function BoqSide({ s }: { s: BoqSession }) {
  const r = s.result!;
  const [pages, setPages] = useState(() => { try { return localStorage.getItem('rr.boqPdf') !== 'table'; } catch { return true; } });
  const m = useMemo(() => build(r, s.entries, s, pages), [r, s.entries, s, pages]);
  const setView = (p: boolean) => { try { localStorage.setItem('rr.boqPdf', p ? 'pdf' : 'table'); } catch { /* fine */ } setPages(p); };
  // (T8) the chips: counted over the changes the list holds (renumbering apart)
  const base = s.entries.filter((e) => e.kind !== 'renumbered');
  // (in items: a reworded heading over 4 items is 4 - the chip, the summary and the register agree, T15)
  const items = (es: typeof base) => es.reduce((n, e) => n + itemCount(e), 0);
  const cn: Record<Chip, number> = { all: items(base), figs: items(base.filter(isFigure)), todo: items(base.filter((e) => !s.ticked.has(e.k))) };
  return (
    <SideView<BoqItem>
      tab="boq"
      chip={{ value: s.chip, set: (c) => { s.chip = c; bump(); }, n: cn, ok: (e) => chipOk(s.entries[e], s.chip, s), rev: s.ticked.size, what: s.chip === 'figs' ? 'only the changes in figures' : 'only the changes still to review' }}
      m={m} sel={s.sel} itemsOf={(e) => (s.entries[e].pic ? picItem(s.entries[e]) : { o: s.entries[e].o, n: s.entries[e].n })} choose={(e) => { s.sel = e; bump(); }}
      ticked={(e) => s.ticked.has(s.entries[e].k)} titleOf={(mk) => explain(s, s.entries[mk.e], mk)}
      rows={rows} rowsNote={(d) => ((d.data as Grid).grid.pg ? ' - the table as read from the PDF' : '')} idOf={(x) => x.row}
      tools={m.pdfs && (
        <div className="seg">
          <button className={pages ? 'on' : ''} onClick={() => setView(true)} title="The PDF's own pages, the changes marked on them">PDF pages</button>
          <button className={!pages ? 'on' : ''} onClick={() => setView(false)} title="The PDF's table as it was read (rows and columns) - what was compared: where a mark on a page looks wrong, look here">Table as read</button>
        </div>
      )}
      legend={(minor) => <Legend minor={minor} major={[
        ['changed', 'Changed', 'The quantity, unit, rate, amount or description changed - the changed cells are boxed'],
        ['added', 'Added', 'New in the new issue'],
        ['removed', 'Removed', 'Not in the new issue (or marked "Deleted")'],
        ['heading', 'Heading reworded', 'The heading over the item was reworded - it says what the item is: the heading line is boxed'],
        ['pic', 'Picture', 'A picture inside a page (a sketch, a pasted table, a photo) changed, was added or removed - never read as items: compare the boxed areas by eye']]} light={[
        ['moved', 'Moved', 'The same item, now in another place (another section, bill or order)'],
        ['renum', 'Letter only', 'The same item; only its item letter changed (items added or taken out above it)']]} />}
      minorKey="rr.boqMinor" minorTitle="Moved, letter only: the item and its heading are the same in both issues. Shown light (dashed) - or hide them to see only what really changed"
      empty="No sheet with items." what="item"
      strip={(sh) => <Strip e={s.sel >= 0 ? s.entries[s.sel] : undefined} s={s} o={sh?.o} n={sh?.n} />}
    />
  );
}

/** a picture entry's stand-ins for the side view's items (one each side, the same objects each time:
 *  the view follows a click to the other side by them) */
type PicItem = BoqItem & { picAt?: { file: string; page: number; box: number[] } };
const picItems = new WeakMap<BoqEntry, { o?: BoqItem; n?: BoqItem }>();
function picItem(e: BoqEntry): { o?: BoqItem; n?: BoqItem } {
  let v = picItems.get(e);
  if (!v) {
    const mk = (w?: { file: string; page: number; box: number[] }) => (w ? ({ file: w.file, sheet: '', row: -1, picAt: w } as unknown as PicItem) : undefined);
    v = { o: mk(e.pic?.o), n: mk(e.pic?.n) };
    picItems.set(e, v);
  }
  return v;
}
const LABEL: Record<MarkKind, string> = { changed: 'Changed', added: 'Added', removed: 'Removed', moved: 'Moved', heading: 'Heading reworded', renum: 'Letter only', pic: 'Picture' };
/** a change in plain words: what the mark means for this item */
function explain(s: BoqSession, e: BoqEntry, mk?: { o?: BoqItem; n?: BoqItem }, figures = true): string {
  if (e.pic) return e.pic.what === 'changed' ? 'Picture changed - compare the boxed areas by eye (a picture is never read as items)' : e.pic.what === 'added' ? 'Picture added: only in the new issue - look at it' : 'Picture removed: not in the new issue';
  if (e.kind === 'added') return 'Added: new in the new issue';
  if (e.kind === 'removed') return 'Removed: not in the new issue';
  const r = s.result!, a = mk?.o ?? e.o, b = mk?.n ?? e.n;
  const q = e.pair ?? e.items?.find((x) => r.old.items[x.o] === a && r.neu.items[x.n] === b);
  if (!q || !a || !b) return summary(e);
  const out: string[] = [];
  const nm: Record<string, string> = { qty: 'quantity', unit: 'unit', rate: 'rate', amount: 'amount', text: 'description' };
  const own = q.changed.filter((f) => nm[f]);
  if (own.length) out.push('Changed: ' + own.map((f) => (f === 'text' ? 'description reworded' : figures ? `${nm[f]} ${fmt(a[f as 'qty'])} → ${fmt(b[f as 'qty'])}` : nm[f])).join(', '));
  if (q.moved) out.push(own.length ? 'and moved' : `Moved: the same item, now ${a.sheet !== b.sheet ? 'in ' + b.sheet : 'in another place'}`);
  if (q.changed.includes('group') || q.changed.includes('section')) out.push(own.length || q.moved ? 'heading above reworded' : 'Heading reworded: the heading over this item changed (boxed) - it says what the item is');
  if (q.renumbered) out.push(out.length ? `letter ${a.ref} → ${b.ref}` : `Letter only: the same item, its letter ${a.ref} → ${b.ref}`);
  return out.join('; ');
}

const colName = (c: number) => { let s = ''; c++; while (c > 0) { const k = (c - 1) % 26; s = String.fromCharCode(65 + k) + s; c = Math.floor((c - 1) / 26); } return s; };

/** words changed, with a few words round each change ("... cutting the ~~10mm~~ 10cm of concrete ...") */
export function brief(d: { op: '=' | '-' | '+'; t: string }[]) {
  const out: JSX.Element[] = [];
  d.forEach((x, i) => {
    if (x.op !== '=') { out.push(x.op === '-' ? <s key={i} className="minus">{x.t} </s> : <span key={i} className="plus">{x.t} </span>); return; }
    const w = x.t.split(/\s+/).filter(Boolean);
    const before = i > 0, after = i < d.length - 1;
    if (w.length <= 7) { out.push(<span key={i}>{x.t} </span>); return; }
    out.push(<span key={i} className="faint">{(before ? w.slice(0, 3).join(' ') + ' … ' : '… ') + (after ? w.slice(-3).join(' ') + ' ' : '')}</span>);
  });
  return out;
}

/** the change shown in short under the two sides: what changed, word by word */
function Strip({ e, s, o, n }: { e?: BoqEntry; s: BoqSession; o?: BoqItem; n?: BoqItem }) {
  if (!e) return <div className="sbs-strip faint">Click a coloured change on either side (or N / P) - the other side goes to the same item.</div>;
  if (e.pic) {
    const t = s.ticked.has(e.k), w = (x?: { file: string; page: number }) => (x ? `${x.file} p.${x.page + 1}` : '');
    return (
      <div className="sbs-strip">
        <span className="sbs-kind mk-pic">{PIC_LABEL[e.pic.what]}</span>
        <span className="sbs-what">{explain(s, e)}</span>
        <span className="chip st-wait">check</span>
        <span className="sbs-where faint">{e.pic.o ? `Old: ${w(e.pic.o)}` : ''}{e.pic.o && e.pic.n ? '   ' : ''}{e.pic.n ? `New: ${w(e.pic.n)}` : ''}</span>
        <button className={'btn sm' + (t ? ' on' : '')} onClick={() => { if (t) s.ticked.delete(e.k); else s.ticked.add(e.k); ticksChanged(); bump(); }} title="Tick off as reviewed (R)"><Icon n="check" size={14} /> {t ? 'Reviewed' : 'R'}</button>
      </div>
    );
  }
  const a = o ?? e.o, b = n ?? e.n;
  const p = e.pair ?? e.items?.find((x) => s.result!.old.items[x.o] === a && s.result!.neu.items[x.n] === b), ch = p?.changed ?? [];
  const kind: MarkKind = e.kind === 'added' ? 'added' : e.kind === 'removed' ? 'removed' : ch.some((f) => f !== 'group' && f !== 'section') ? 'changed' : p?.moved ? 'moved' : ch.length ? 'heading' : 'renum';
  const ticked = s.ticked.has(e.k), mates = boqMates(s, e);
  const pdfOf = (x: BoqItem, side: Side) => (side === 'o' ? s.result!.old : s.result!.neu).pdfs?.some((f) => f.name === x.file);
  const where = (x: BoqItem, side: Side) => `${x.sheet} ${pdfOf(x, side) ? x.page : 'r' + x.row}${x.ref ? ' · ' + x.ref : ''}`;
  const num = (f: 'qty' | 'unit' | 'rate' | 'amount', l: string) => (a && b && ch.includes(f) ? <span className="sbs-num"><span className="faint">{l}</span> <s className="minus">{fmt(a[f])}</s> → <b className="plus">{fmt(b[f])}</b></span> : null);
  return (
    <div className="sbs-strip">
      <span className={'sbs-kind mk-' + kind}>{LABEL[kind]}</span>
      <span className="sbs-what">{explain(s, e, { o: a, n: b }, false)}</span>
      {a && b && (ch.includes('group') || ch.includes('section')) && <span className="sbs-text sbs-hd"><span className="faint">Heading: </span>{brief(wordDiff(a.section + ' ' + a.group, b.section + ' ' + b.group))}</span>}
      {needsCheck(e, s) && <span className="chip st-wait">check</span>}
      <span className="sbs-where faint">{a ? `Old: ${where(a, 'o')}` : ''}{a && b ? '   ' : ''}{b ? `New: ${where(b, 'n')}` : ''}</span>
      {num('qty', 'Qty')}{num('unit', 'Unit')}{num('rate', 'Rate')}{num('amount', 'Amount')}
      {e.figs?.map((f, i) => <FigChip key={i} f={f} />)}
      {mates.length > 0 && <SameChange n={mates.length} what="in" noun={['item', 'items']} tick={() => { boqTickGroup(s, e); bump(); }} />}
      <span className="sbs-text">{a && b && a.text !== b.text ? wordDiff(a.text, b.text).map((d, i) => (d.op === '=' ? <span key={i}>{d.t} </span> : d.op === '-' ? <s key={i} className="minus">{d.t} </s> : <span key={i} className="plus">{d.t} </span>)) : (b ?? a)?.text}</span>
      <button className={'btn sm' + (ticked ? ' on' : '')} onClick={() => { if (ticked) s.ticked.delete(e.k); else s.ticked.add(e.k); ticksChanged(); bump(); }} title="Tick off as reviewed (R)"><Icon n="check" size={14} /> {ticked ? 'Reviewed' : 'R'}</button>
    </div>
  );
}
