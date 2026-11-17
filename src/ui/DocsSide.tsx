// The Documents tab's side-by-side view (sideview.tsx): a PDF's own pages - each paragraph changed
// marked with a band, the words taken out (old) / put in (new) boxed - or "Text as read": the paragraphs
// wrapped to the pane, the words struck / marked in them (a Word file turned into a PDF is a PDF here; one
// that could not be is always text, with a note saying why). Click a change: the other side goes to it.
import { useEffect, useMemo, useState } from 'react';
import { bump } from './model';
import { Icon } from './icons';
import { docSummary, docNeedsCheck, docTicksChanged, docMates, docTickGroup, docChip, figText, loadReading, convPath, type DocSession } from './docsrun';
import { wordDiff } from '../engine/boq';
import { DOC_CLASS_LABEL, PIC_LABEL, rowChanges, headPath, type DocEntry, type DocLine, type DocsResult, type DocClass, type ReadFile } from '../engine/docs';
import { SideView, Legend, pdfDoc, textDoc, shortTabs, addMark, linkDocs, type Chip, type Side, type Doc, type Mark, type Model, type Place, type Box, type TBlock } from './sideview';

type Kind = DocClass;
const pdfKey = (file: string) => 'pdf\u0000' + file;
const textKey = (file: string) => 'txt\u0000' + file;
/** a text doc's places: each paragraph's block (its index in the file -> block), the paragraph at a page and
 *  top (what the anchors say) -> block, each picture's line -> its placeholder's block */
interface TMeta { para: number[]; pos: Map<string, number>; pic: Map<DocLine, number> }
/** a file's blocks: its paragraphs as read, the picture entries' placeholders after the paragraph above them */
function textBlocks(rf: ReadFile | undefined, pics: { x: DocLine; label: string }[]): { blocks: TBlock[]; meta: TMeta } {
  const blocks: TBlock[] = [], meta: TMeta = { para: [], pos: new Map(), pic: new Map() };
  const after = new Map<number, { x: DocLine; label: string }[]>();
  for (const q of pics) { const k = q.x.after ?? -1; if (!after.has(k)) after.set(k, []); after.get(k)!.push(q); }
  const putPics = (k: number) => { for (const q of after.get(k) ?? []) { meta.pic.set(q.x, blocks.length); blocks.push({ head: '', num: '', text: '', pic: q.label }); } };
  putPics(-1);
  let prev = '';
  rf?.rows.forEach((row, i) => {
    const head = rf.heads[row[2]] ?? '';
    blocks.push({ head: head !== prev ? head : '', num: row[0], text: row[1], ...(row[5] ? { cells: row[5] } : {}) });
    prev = head;
    meta.para[i] = blocks.length - 1;
    const k = row[3] + '\u0000' + row[4];
    if (!meta.pos.has(k)) meta.pos.set(k, blocks.length - 1);
    putPics(i);
  });
  return { blocks, meta };
}

/** words' boxes (several next to each other on a line: one box) */
function wordBoxes(wb: number[][], at: number[]): Box[] {
  const out: Box[] = [];
  for (const w of at) {
    const bs = wb[w];
    if (!bs) continue;
    for (let k = 0; k + 4 < bs.length; k += 5) {
      const pg = bs[k], b = [bs[k + 1] - 1.5, bs[k + 2] - 1, bs[k + 3] + 1.5, bs[k + 4] + 1];
      const l = out[out.length - 1];
      if (l && l.pg === pg && Math.abs(l.b[1] - b[1]) < 2.5 && b[0] - l.b[2] < 12 && b[0] >= l.b[0]) { l.b[2] = b[2]; l.b[3] = Math.max(l.b[3], b[3]); l.b[1] = Math.min(l.b[1], b[1]); } else out.push({ pg, b });
    }
  }
  return out;
}
/** the entry's kind: decided once, in the engine (docEntries) - the same for this view, Details and the register */
const kindOf = (e: DocEntry): Kind => e.cls;

function build(r: DocsResult, s: DocSession, asText: boolean): Model<DocLine> {
  const docs: Record<Side, Doc<DocLine>[]> = { o: [], n: [] };
  const byKey: Model<DocLine>['byKey'] = { o: new Map(), n: new Map() };
  const files = r.files ?? { o: [], n: [] };
  const A = r.anchors ?? [];
  // (where the text is on each page: from the paragraphs' places - the flow kept level by them)
  const text: Record<Side, Map<string, Map<number, [number, number]>>> = { o: new Map(), n: new Map() };
  const seeText = (side: Side, file: string, pg: number, y0: number, y1: number) => {
    if (!text[side].has(file)) text[side].set(file, new Map());
    const m = text[side].get(file)!, t = m.get(pg);
    m.set(pg, t ? [Math.min(t[0], y0), Math.max(t[1], y1)] : [y0, y1]);
  };
  for (let k = 0; k + 5 < A.length; k += 6) {
    if (A[k + 1] >= 0) seeText('o', files.o[A[k]], A[k + 1], A[k + 2], A[k + 2] + 12);
    if (A[k + 4] >= 0) seeText('n', files.n[A[k + 3]], A[k + 4], A[k + 5], A[k + 5] + 12);
  }
  for (const e of r.entries) for (const [side, x] of [['o', e.o], ['n', e.n], [e.kind === 'secAdded' ? 'n' : 'o', e.end]] as const) for (const g of x?.seg ?? []) seeText(side, x!.file, g[0], g[2], g[4]);
  let anyPdf = false;
  // (the picture entries' lines by side and file: their placeholders in a text doc)
  const picsBy = new Map<string, { x: DocLine; label: string }[]>();
  for (const e of r.entries) if (e.pic) for (const side of ['o', 'n'] as Side[]) {
    const x = side === 'o' ? e.o : e.n;
    if (!x) continue;
    const label = `${PIC_LABEL[e.pic.what]}${x.page > 0 ? ` on page ${x.page}` : ''} - ${e.pic.word ? 'open the file' : 'see it in PDF pages'}`;
    const k = side + '\u0000' + x.file;
    if (!picsBy.has(k)) picsBy.set(k, []);
    picsBy.get(k)!.push({ x, label });
  }
  for (const side of ['o', 'n'] as Side[]) {
    const pdfs = new Map((r.pdfs?.[side] ?? []).map((p) => [p.name, p]));
    for (const f of files[side]) {
      const p = pdfs.get(f), path = p && convPath(s, side, p.idx);
      let d: Doc<DocLine>;
      if (p && path) anyPdf = true;
      if (p && path && !asText) d = pdfDoc<DocLine>(pdfKey(f), f, path, p.sizes, text[side].get(f) ?? new Map());
      else {
        // (text as read: a PDF's from the file the engine wrote beside the result, a Word file's from the result)
        const { blocks, meta } = textBlocks(s.reading?.[side]?.[f] ?? r.read?.[side]?.[f], picsBy.get(side + '\u0000' + f) ?? []);
        d = textDoc<DocLine>(textKey(f), f, blocks, meta);
      }
      docs[side].push(d); byKey[side].set(d.key, d);
    }
    shortTabs(docs[side]);
  }
  const docOf = (side: Side, file: string) => byKey[side].get(pdfKey(file)) ?? byKey[side].get(textKey(file));
  const place = (side: Side, x: DocLine): Place<DocLine> | null => {
    const d = docOf(side, x.file);
    if (!d) return null;
    if (d.text) {
      const mt = d.data as TMeta, bi = x.pic ? mt.pic.get(x) : x.i === undefined ? undefined : mt.para[x.i];
      return bi === undefined ? null : { doc: d, u0: bi, u1: bi + 1, a: bi, b: bi, segs: [] };
    }
    const g = x.seg?.[0];
    if (!g || g[0] >= d.tops!.length) return null;
    return { doc: d, u0: d.tops![g[0]] + g[2], u1: d.tops![g[0]] + g[4], a: 0, b: 0, segs: x.seg!.map((sg) => ({ pg: sg[0], b: [sg[1] - 2, sg[2], sg[3] + 2, sg[4]] })) };
  };
  // the marks: a band over each paragraph (a section added / removed: over all of it), the words changed boxed
  r.entries.forEach((e, ei) => {
    const kind = kindOf(e);
    const minor = kind === 'moved' || kind === 'renum' || kind === 'punct' || kind === 'dateOnly';
    const w = e.kind === 'changed' ? e.cw ?? null : null;
    for (const side of ['o', 'n'] as Side[]) {
      const x = side === 'o' ? e.o : e.n;
      if (!x) continue;
      const p = place(side, x);
      if (!p) continue;
      const d = p.doc;
      const end = (e.kind === 'secAdded' || e.kind === 'secRemoved') && e.end ? e.end : null;
      const mk: Mark<DocLine> = { kind, e: ei, o: e.o, n: e.n, u0: p.u0, u1: p.u1, minor, a: p.a, b: p.b, first: true, segs: [], hot: [], id: x.i };
      if (d.pdf) {
        if (end?.seg?.length) {
          // (a whole section: from its first paragraph to its last, the pages between in full)
          const a = x.seg![0], z = end.seg[end.seg.length - 1];
          const x0 = Math.min(a[1], z[1]) - 3, x1 = Math.max(a[3], z[3]) + 3;
          for (let pg = a[0]; pg <= z[0] && pg < d.sizes!.length; pg++) mk.segs.push({ pg, b: [x0, pg === a[0] ? a[2] - 1.5 : 30, x1, pg === z[0] ? z[4] + 1.5 : d.sizes![pg].h - 30] });
        } else mk.segs = x.seg!.map((sg) => ({ pg: sg[0], b: [sg[1] - 3, sg[2] - 1.5, sg[3] + 3, sg[4] + 1.5] }));
        if (w && x.wb) mk.hot = wordBoxes(x.wb, side === 'o' ? w.o : w.n);
        // (a picture - T6.5: banded whole, its changed areas boxed)
        if (e.pic) for (const b of (side === 'o' ? e.pic.o : e.pic.n) ?? []) mk.hot.push({ pg: x.seg![0][0], b: [b[0] - 1.5, b[1] - 1.5, b[2] + 1.5, b[3] + 1.5] });
        // (a table row: the band is the row; the cells that changed boxed, round their words - T6)
        if (e.kind === 'changed' && x.cb) for (const c of rowChanges(e.o, e.n)) { const b = x.cb[c.k]; if (b) mk.hot.push({ pg: b[0], b: [b[1] + 1, b[2] + 1, b[3] - 1, b[4] - 1] }); }
      } else {
        // (a text doc: the section's last paragraph's block; the words changed kept in the block, drawn struck / marked)
        if (end?.i !== undefined) mk.b = Math.max(mk.a, (d.data as TMeta).para[end.i] ?? mk.a);
        if (w && d.text?.[p.a] && !d.text[p.a].pic) d.text[p.a].hot = new Set(side === 'o' ? w.o : w.n);
      }
      addMark(d, mk);
    }
  });
  // docs matched by where their paragraphs went; the anchors (every paragraph paired) between them
  const at = (side: Side, f: number, pg: number, y: number): Place<DocLine> | null => {
    const d = docOf(side, files[side][f]);
    if (!d) return null;
    if (d.text) {
      const mt = d.data as TMeta, bi = pg < 0 ? mt.para[y] : mt.pos.get(pg + '\u0000' + y);
      return bi === undefined ? null : { doc: d, u0: bi, u1: bi + 1, a: bi, b: bi, segs: [] };
    }
    return pg >= 0 && pg < d.tops!.length ? { doc: d, u0: d.tops![pg] + y, u1: d.tops![pg] + y + 12, a: 0, b: 0, segs: [] } : null;
  };
  const pl: [Place<DocLine>, Place<DocLine>][] = [];
  for (let k = 0; k + 5 < A.length; k += 6) { const a = at('o', A[k], A[k + 1], A[k + 2]), b = at('n', A[k + 3], A[k + 4], A[k + 5]); if (a && b) pl.push([a, b]); }
  return { docs, byKey, ...linkDocs(docs, pl), place, pdfs: anyPdf };
}

const LABEL = DOC_CLASS_LABEL;
/** a cell's text, shortened for the strip */
const cut = (t: string) => (t.length > 70 ? t.slice(0, 67) + '…' : t || '(empty)');
/** a change in plain words */
function explain(e: DocEntry): string {
  const k = kindOf(e);
  if (e.kind === 'secAdded') return `Section added: ${e.paras} paragraphs new in the new issue`;
  if (e.kind === 'secRemoved') return `Section removed: ${e.paras} paragraphs not in the new issue`;
  if (k === 'added') return 'Added: a paragraph new in the new issue';
  if (k === 'removed') return 'Removed: not in the new issue';
  if (e.pic?.word) return e.pic.what === 'changed' ? 'Picture(s) inside the Word file changed - a Word file is compared as its text, so the pictures are not drawn here: open the file and compare them by eye' : e.pic.what === 'added' ? 'Picture(s) only in the new Word file - open the file' : 'Picture(s) not in the new Word file - open the file';
  if (e.pic) return e.pic.what === 'changed' ? `Picture changed - compare the boxed areas by eye${e.pic.whole ? ' (the picture boxed whole: changed all over, or too many places to box)' : ''}` : e.pic.what === 'added' ? 'Picture added: only in the new issue - look at it' : 'Picture removed: not in the new issue';
  const out: string[] = [];
  const rc = k === 'changed' ? rowChanges(e.o, e.n) : [];
  if (rc.length) return `Table row ${e.n?.row ?? e.o?.row ?? ''} · ` + rc.slice(0, 3).map((c) => `${c.col}: ${cut(c.o)} → ${cut(c.n)}`).join(' · ') + (rc.length > 3 ? ` · ${rc.length - 3} more cells` : '');
  if (k === 'changed') out.push('Changed: reworded - the words taken out and put in are boxed');
  if (k === 'punct') out.push('Punctuation only: the same words, its punctuation or spacing changed (no sign, figure or comparator changed)');
  if (k === 'dateOnly') out.push('Date / revision only: only a date or a revision stamp changed');
  if (e.moved) out.push(out.length ? 'and moved' : `Moved: the same paragraph, now ${e.o && e.n && e.o.head !== e.n.head ? 'under ' + (e.n.head.split(' › ').pop() || 'another heading') : 'in another place'}`);
  if (e.renumbered) out.push(out.length ? `number ${e.o?.num || '-'} → ${e.n?.num || '-'}` : `Number only: the same paragraph, its clause number ${e.o?.num || '-'} → ${e.n?.num || '-'}`);
  return out.join('; ') || docSummary(e);
}

/** the change in full, word by word (nothing shortened: what was taken out struck, what was put in marked) */
const Diff = ({ a, b }: { a: string; b: string }) => <>{wordDiff(a, b).map((d, i) => (d.op === '=' ? <span key={i}>{d.t} </span> : d.op === '-' ? <s key={i} className="minus">{d.t} </s> : <span key={i} className="plus">{d.t} </span>))}</>;
/** a figure changed, as the BOQ strip's number chips: 41 → 33 kg/m3 */
export const FigChip = ({ f }: { f: { o: string; n: string; unit?: string } }) => (
  <span className="sbs-num"><span className="faint">Figure</span> {f.o ? <s className="minus">{f.o}</s> : null}{f.o && f.n ? ' → ' : f.n ? '+ ' : '− '}{f.n ? <b className="plus">{f.n}</b> : null}{f.unit ? <span className="faint"> {f.unit}</span> : null}</span>
);
/** the same change in other places, and one tick for the lot (Shift + R) */
export function SameChange({ n, tick, what, noun = ['place', 'places'] }: { n: number; tick: () => void; what: string; noun?: [string, string] }) {
  return (
    <span className="sbs-same">
      <span className="faint">Same change {what} {n} other {noun[n === 1 ? 0 : 1]}</span>
      <button className="btn sm" onClick={tick} title="Tick this change and every place it was made, as reviewed (Shift + R)"><Icon n="check" size={14} /> Tick all {n + 1}</button>
    </span>
  );
}

function Strip({ e, s }: { e?: DocEntry; s: DocSession }) {
  if (!e) return <div className="sbs-strip faint">Click a coloured change on either side (or N / P) - the other side goes to the same paragraph.</div>;
  const a = e.o, b = e.n, k = kindOf(e), ticked = s.ticked.has(e.k);
  const where = (x: DocLine) => `${x.file}${x.page > 0 ? ' p.' + x.page : ''}${x.num ? ' · ' + x.num : ''}`;
  const path = headPath(e), mates = docMates(s, e);
  const rc = k === 'changed' ? rowChanges(a, b) : [];
  return (
    <div className="sbs-strip">
      <span className={'sbs-kind mk-' + k}>{e.kind === 'secAdded' ? 'Section added' : e.kind === 'secRemoved' ? 'Section removed' : e.pic ? PIC_LABEL[e.pic.what] : LABEL[k]}</span>
      {path.length > 0 && <span className="sbs-path faint" title={path.join(' › ')}>{path.join(' › ')}</span>}
      <span className="sbs-what">{explain(e)}</span>
      {e.figs?.map((f, i) => <FigChip key={i} f={f} />)}
      {docNeedsCheck(e) && <span className="chip st-wait">check</span>}
      {mates.length > 0 && <SameChange n={mates.length} what="in" tick={() => { docTickGroup(s, e); bump(); }} />}
      <span className="sbs-where faint">{a ? `Old: ${where(a)}` : ''}{a && b ? '   ' : ''}{b ? `New: ${where(b)}` : ''}</span>
      {e.pic?.read && <span className="sbs-text"><span className="faint">read by OCR, check by eye: </span>{e.pic.read}</span>}
      {e.pic && !e.pic.read && s.picReading && e.pic.text && <span className="sbs-text faint">reading the picture (OCR)…</span>}
      {!e.pic && <span className="sbs-text">{a && b && e.kind === 'changed' && !rc.length ? <Diff a={a.text} b={b.text} /> : rc.length ? rc.map((c, i) => <span key={i} className="sbs-cell"><span className="faint">{c.col}: </span><Diff a={c.o} b={c.n} />{' '}</span>) : (b ?? a)?.text}</span>}
      <button className={'btn sm' + (ticked ? ' on' : '')} onClick={() => { if (ticked) s.ticked.delete(e.k); else s.ticked.add(e.k); docTicksChanged(); bump(); }} title="Tick off as reviewed (R)"><Icon n="check" size={14} /> {ticked ? 'Reviewed' : 'R'}</button>
    </div>
  );
}

export function DocsSide({ s }: { s: DocSession }) {
  const r = s.result!;
  const hasPdf = (r.pdfs?.o.length ?? 0) + (r.pdfs?.n.length ?? 0) > 0;
  // "PDF pages | Text as read" (as the BOQ's switch), kept between comparisons
  const [pages, setPages] = useState(() => { try { return localStorage.getItem('rr.docsPdf') !== 'text'; } catch { return true; } });
  const setView = (p: boolean) => { try { localStorage.setItem('rr.docsPdf', p ? 'pdf' : 'text'); } catch { /* fine */ } setPages(p); };
  // (the PDFs' paragraphs wait in a file the engine wrote: read when the text is first asked for; the pages stay till then)
  const wantText = hasPdf && !pages;
  const loading = wantText && !!r.readFile && !s.reading && !s.readingError;
  useEffect(() => { if (loading) void loadReading(s); }, [loading, s]);
  const asText = wantText && !loading && !s.readingError;
  const m = useMemo(() => build(r, s, asText), [r, s, asText, s.reading]); // eslint-disable-line react-hooks/exhaustive-deps
  // (T8) the chips: counted over the changes the list holds (renumbering apart)
  const base = r.entries.filter((e) => e.kind !== 'renumbered');
  const n: Record<Chip, number> = { all: base.length, figs: base.filter((e) => !!e.figs?.length).length, todo: base.filter((e) => !s.ticked.has(e.k)).length };
  return (
    <SideView<DocLine>
      chip={{ value: s.chip, set: (c) => { s.chip = c; bump(); }, n, ok: (e) => docChip(r.entries[e], s.chip, s), rev: s.ticked.size, what: s.chip === 'figs' ? 'only the changes in figures' : 'only the changes still to review' }}
      m={m} sel={s.sel} itemsOf={(e) => ({ o: r.entries[e].o, n: r.entries[e].n })} choose={(e) => { s.sel = e; bump(); }}
      ticked={(e) => s.ticked.has(r.entries[e].k)} titleOf={(mk) => explain(r.entries[mk.e])} idOf={(x) => x.i}
      rowsNote={(d) => (d.text ? ' - text as read' : '')}
      tools={hasPdf && (
        <div className="seg">
          <button className={pages ? 'on' : ''} onClick={() => setView(true)} title="The PDF's own pages (a Word file as the PDF made from it), the changes marked on them">PDF pages</button>
          <button className={!pages ? 'on' : ''} onClick={() => setView(false)} title="The paragraphs as they were read - wrapped to the pane, the words taken out struck and the words put in marked: what was compared. Where a mark on a page looks wrong, look here">Text as read</button>
        </div>
      )}
      note={s.readingError ? `The text could not be read (${s.readingError}) - the pages are shown.` : loading ? 'Reading the text…' : s.wordNote}
      legend={(minor) => <Legend minor={minor} major={[
        ['changed', 'Changed', 'The paragraph was reworded - the words taken out (old) and put in (new) are marked'],
        ['added', 'Added', 'New in the new issue (a section added: all of it)'],
        ['removed', 'Removed', 'Not in the new issue (a section removed: all of it)'],
        ['pic', 'Picture', 'A picture inside a page changed, was added or removed (a photo, a table placed as a picture, a whole page of pictures) - its changed areas boxed: compare them by eye']]} light={[
        ['moved', 'Moved', 'The same paragraph, now in another place or section'],
        ['renum', 'Number only', 'The same paragraph; only its clause number changed (one inserted or taken out before it)'],
        ['punct', 'Punctuation only', 'The same words; only punctuation or spacing changed - a sign, comparator or percent is never "punctuation"'],
        ['dateOnly', 'Date / revision only', 'Only a date or a revision stamp (R0_06-04-2026) changed']]} />}
      minorKey="rr.docsMinor" minorTitle="Moved, number only, punctuation only, date / revision only: the paragraph's words are the same in both issues. Shown light (dashed) - or hide them to see only what really changed"
      empty="No paragraphs." what="paragraph"
      strip={() => <Strip e={s.sel >= 0 ? r.entries[s.sel] : undefined} s={s} />}
    />
  );
}
