// The Documents tab: two issues of specifications / documents compared (engine: docsCompare), the
// list made from it, ticks, and the Excel change register.
import { ui, bump, toast, plainError } from './model';
import { rr, type FileItem } from './api';
import { workers } from './engines';
import { fileArg } from '../engine/rpc';
import { DOC_CLASS_LABEL, PIC_LABEL, headPath, type DocEntry, type DocLine, type DocsResult, type DocsReading, type Fig } from '../engine/docs';
import { picRead } from '../engine/picread';
import { ocrRegions } from './ocr';
import type { EngineClient } from '../engine/rpc';
import { setSigs, keptTicks, droppedNote, readScans, type ScanInfo, type Sigs } from './boqrun';
import { writeXlsx, type XCell } from './xlsxwrite';

export interface DocSet { label: string; paths: string[]; files: FileItem[] }
export type DocFilter = 'changes' | 'todo' | 'changed' | 'added' | 'removed' | 'moved' | 'renumbered' | 'punct' | 'dateOnly' | 'sections' | 'pics' | 'check';
export interface DocSession {
  oldSet: DocSet; newSet: DocSet;
  phase: 'running' | 'done' | 'error'; error?: string;
  result?: DocsResult;
  sel: number; filter: DocFilter; search: string;
  /** (T8) the chip in the side view's legend row: All (nothing left out), Figures, To review - what N / P go through and the change map shows */
  chip: 'all' | 'figs' | 'todo';
  ticked: Set<string>;
  /** what it is doing while running */
  note?: string;
  /** (6.5b) pictures being read by OCR; how long it took */
  picReading?: boolean; picReadMs?: number;
  /** (T7) the Word files that were turned into PDFs (by place in the set): the PDF in the temp folder - what is
   *  compared and shown; the line under the tab when some were not (why: text as read, never silent) */
  conv?: { o: Record<number, string>; n: Record<number, string> };
  wordNote?: string;
  /** (T7) the PDFs' paragraphs as read, from the file the engine wrote - loaded when "Text as read" is first asked for */
  reading?: DocsReading; readingError?: string;
}
/** the file the engine reads for a side's file: a Word file's PDF, else the file itself */
export const convPath = (s: DocSession, side: 'o' | 'n', idx: number): string | undefined => s.conv?.[side][idx] ?? (side === 'o' ? s.oldSet : s.newSet).files[idx]?.path;

/** the Word files of both sets turned into PDFs (Word on Windows, else LibreOffice - electron/wordpdf.cjs); one that
 *  cannot be is read as text, and the line says which and why */
async function convertWord(oldSet: DocSet, newSet: DocSet, live: () => boolean, note: (t: string) => void): Promise<{ conv: NonNullable<DocSession['conv']>; wordNote: string }> {
  const conv: NonNullable<DocSession['conv']> = { o: {}, n: {} };
  const todo: { side: 'o' | 'n'; idx: number; f: FileItem }[] = [];
  for (const [side, set] of [['o', oldSet], ['n', newSet]] as const) set.files.forEach((f, idx) => { if (/\.docx$/i.test(f.path)) todo.push({ side, idx, f }); });
  const fails: { name: string; why: string }[] = [];
  let k = 0;
  for (const t of todo) {
    if (!live()) break;
    note(`Turning the Word files into PDFs (${++k} of ${todo.length})…`);
    let r: Awaited<ReturnType<typeof rr.docxConvert>> | null = null;
    try { r = rr.docxConvert ? await rr.docxConvert(t.f.path) : null; } catch { r = null; }
    // (switched off in this version: Word files are read as text, as before - nothing to say)
    if (r && !r.ok && (r as { off?: boolean }).off) { note(''); return { conv, wordNote: '' }; }
    if (r?.ok) conv[t.side][t.idx] = r.pdf;
    else fails.push({ name: t.f.rel.split(/[\\/]/).pop() || t.f.rel, why: r && !r.ok ? r.why : 'the converter could not be asked' });
  }
  if (!fails.length) return { conv, wordNote: '' };
  const why = [...new Set(fails.map((x) => x.why))].join('; ');
  const names = fails.length === todo.length ? `Word file${todo.length === 1 ? '' : 's'}` : `${fails.slice(0, 3).map((x) => x.name).join(', ')}${fails.length > 3 ? '…' : ''}`;
  return { conv, wordNote: `${names} shown as text as read, not as pages - ${why}` };
}
/** the PDFs' paragraphs as read: the file the engine wrote beside the result, read by an engine */
export async function loadReading(s: DocSession) {
  const r = s.result;
  if (!r?.readFile || s.reading) return;
  try {
    const c = workers.reduce((a, b) => (b.busy < a.busy ? b : a), workers[0]);
    const rd = await c.call<DocsReading>('docsReading', [r.readFile]);
    if (ui.docs === s) s.reading = rd;
  } catch (e) { if (ui.docs === s) s.readingError = plainError(e, 'the text'); }
  bump();
}

let runId = 0;
export async function startDocs(oldSet: DocSet, newSet: DocSet) {
  flushTicks();
  const my = ++runId;
  ui.docs = { oldSet, newSet, phase: 'running', sel: -1, filter: 'changes', search: '', chip: 'all', ticked: new Set() };
  bump();
  try {
    const c = workers.reduce((a, b) => (b.busy < a.busy ? b : a), workers[0]);
    // (Word files first: turned into PDFs where a converter is - then they are compared and shown as PDFs)
    const { conv, wordNote } = await convertWord(oldSet, newSet, () => my === runId && !!ui.docs, (t) => { if (my === runId && ui.docs) { ui.docs.note = t; bump(); } });
    if (my !== runId || !ui.docs) return;
    ui.docs.conv = conv; ui.docs.wordNote = wordNote; ui.docs.note = '';
    const side = (s: DocSet, tag: 'o' | 'n') => s.files.map((f, idx) => ({ file: fileArg(conv[tag][idx] ?? f.path), name: f.rel.split(/[\\/]/).pop() || f.rel }));
    let r = await c.call<DocsResult & { scans?: ScanInfo[] }>('docsCompare', [side(oldSet, 'o'), side(newSet, 'n')]);
    if (my !== runId || !ui.docs) return;
    if (r?.scans?.length) {
      const live = () => my === runId && !!ui.docs;
      const ocr = await readScans(c, r.scans, { o: oldSet, n: newSet }, (t) => { if (live()) { ui.docs!.note = t; bump(); } }, live);
      if (!live()) return;
      ui.docs!.note = ''; bump();
      r = await c.call<DocsResult & { scans?: ScanInfo[] }>('docsCompare', [side(oldSet, 'o'), side(newSet, 'n'), { ocr }]);
      if (my !== runId || !ui.docs) return;
    }
    ui.docs.result = r;
    await restoreDocTicks(ui.docs);
    if (my !== runId || !ui.docs) return;
    ui.docs.phase = 'done';
    ui.docs.sel = r.entries.findIndex((e) => e.kind !== 'renumbered');
    void rememberDocs(ui.docs);
    if (r.picOcr) void readPictures(c, ui.docs, () => my === runId && !!ui.docs);
  } catch (e) {
    if (my !== runId || !ui.docs) return;
    ui.docs.phase = 'error';
    ui.docs.error = plainError(e, 'a file');
  }
  bump();
}
/** at most this many pictures' boxes read by OCR a compare (6.5b): beyond, flag and boxes only */
export const PIC_OCR_MAX = 40;
/** the words in changed / added / removed text-like pictures read by OCR (6.5b): shown only where the
 *  pixels changed (picread.ts); never made into paragraphs */
async function readPictures(c: EngineClient, s: DocSession, live: () => boolean) {
  const r = s.result!;
  const pathOf = (side: 'o' | 'n', file: string) => { const p = r.pdfs?.[side].find((x) => x.name === file); return p ? convPath(s, side, p.idx) : undefined; };
  const want = r.entries.filter((e) => e.pic?.text);
  const jobs: { e: DocEntry; side: 'o' | 'n'; path: string; page: number; rect: number[] }[] = [];
  let over = 0;
  for (const e of want) {
    const sides = (['o', 'n'] as const).filter((sd) => e[sd]?.seg?.[0]);
    if (jobs.length + sides.length > PIC_OCR_MAX) { over++; continue; }
    for (const sd of sides) { const x = e[sd]!, g = x.seg![0], path = pathOf(sd, x.file); if (path) jobs.push({ e, side: sd, path, page: g[0], rect: g.slice(1, 5) }); }
  }
  if (over) r.notes.push(`${over} changed picture${over === 1 ? '' : 's'} not read by OCR (${PIC_OCR_MAX} picture boxes at most a compare): flagged and boxed only - compare by eye`);
  if (!jobs.length) return;
  s.picReading = true; bump();
  const t0 = performance.now();
  const words = await ocrRegions(c, jobs, live);
  if (!live()) return;
  for (const e of want) {
    const at = (sd: 'o' | 'n') => { const k = jobs.findIndex((j) => j.e === e && j.side === sd); return k >= 0 ? words[k] : null; };
    const got = picRead(e.pic!, at('o'), at('n'));
    if (got.text) e.pic!.read = got.text;
  }
  s.picReading = false;
  s.picReadMs = Math.round(performance.now() - t0);
  bump();
}
export function leaveDocs() { flushTicks(); runId++; ui.docs = null; bump(); }

/** a tick kept by what it is on (file, page, clause, words), not by its place in the list */
const line = (x?: DocLine) => (x ? `${x.file}#${x.page}#${x.num}#${x.text.slice(0, 80)}` : '');
export const docTickKey = (e: DocEntry) => `${e.kind}|${line(e.o)}|${line(e.n)}`;
interface DocRecent { when: number; label: string; old: { paths: string[] }; neu: { paths: string[] }; counts?: Record<string, number>; sigs?: Sigs; ticks?: string[] }
async function restoreDocTicks(s: DocSession) {
  try {
    const st = await rr.settings();
    const row = ((st.recentDocs || []) as DocRecent[]).find((x) => x.old.paths.join() === s.oldSet.paths.join() && x.neu.paths.join() === s.newSet.paths.join());
    if (!row?.ticks?.length) return;
    const { keep, dropped } = keptTicks(row.ticks, row.sigs, setSigs(s.oldSet, s.newSet));
    if (dropped) droppedNote(dropped);
    let k = 0;
    for (const e of s.result!.entries) if (keep.has(docTickKey(e)) && !s.ticked.has(e.k)) { s.ticked.add(e.k); k++; }
    if (k) toast(`${k} change${k === 1 ? '' : 's'} ticked off last time - still ticked`, 'ok', 6000);
  } catch { /* a convenience */ }
}
let saveT: ReturnType<typeof setTimeout> | null = null;
/** a tick given or taken back: kept for next time */
export function docTicksChanged() {
  if (saveT) clearTimeout(saveT);
  saveT = setTimeout(() => { saveT = null; if (ui.docs?.phase === 'done') void rememberDocs(ui.docs); }, 600);
}
function flushTicks() {
  if (!saveT) return;
  clearTimeout(saveT); saveT = null;
  if (ui.docs?.phase === 'done') void rememberDocs(ui.docs);
}
/** remembered for the start screen's list (as the BOQ tab's) */
async function rememberDocs(s: DocSession) {
  try {
    const st = await rr.settings();
    const counts = { changes: s.result!.entries.filter((e) => e.kind !== 'renumbered').length, added: s.result!.entries.filter((e) => e.kind === 'added' || e.kind === 'secAdded').length, removed: s.result!.entries.filter((e) => e.kind === 'removed' || e.kind === 'secRemoved').length };
    const byK = new Map(s.result!.entries.map((e) => [e.k, e]));
    const ticks = [...s.ticked].map((k) => byK.get(k)).filter(Boolean).map((e) => docTickKey(e!));
    const row: DocRecent = { when: Date.now(), label: `${s.oldSet.label} → ${s.newSet.label}`, old: { paths: s.oldSet.paths }, neu: { paths: s.newSet.paths }, counts, sigs: setSigs(s.oldSet, s.newSet), ticks };
    const list = ((st.recentDocs || []) as DocRecent[]).filter((x) => x.old.paths.join() !== row.old.paths.join() || x.neu.paths.join() !== row.neu.paths.join());
    await rr.setSettings({ recentDocs: [row, ...list].slice(0, 12) });
  } catch { /* a convenience */ }
}

export const docNeedsCheck = (e: DocEntry) => e.kind === 'pic' || (e.like !== undefined && e.like < 0.7) || !!e.o?.ocr || !!e.n?.ocr;
export function docMatches(e: DocEntry, f: DocFilter, s: DocSession): boolean {
  switch (f) {
    case 'changes': return e.kind !== 'renumbered';
    case 'todo': return e.kind !== 'renumbered' && !s.ticked.has(e.k);
    case 'changed': return e.cls === 'changed';
    case 'added': return e.kind === 'added';
    case 'removed': return e.kind === 'removed';
    case 'moved': return !!e.moved;
    case 'renumbered': return !!e.renumbered;
    case 'punct': return e.cls === 'punct';
    case 'dateOnly': return e.cls === 'dateOnly';
    case 'sections': return e.kind === 'secAdded' || e.kind === 'secRemoved';
    case 'pics': return e.kind === 'pic';
    case 'check': return docNeedsCheck(e);
  }
}
/** (T8) the chip: a figure change (a changed word pair that holds a digit or a unit / grade / standard / finish code), or not ticked off yet */
export const docChip = (e: DocEntry, chip: DocSession['chip'], s: DocSession) => chip === 'all' || (chip === 'figs' ? !!e.figs?.length : e.kind !== 'renumbered' && !s.ticked.has(e.k));
export function docVisible(s: DocSession): DocEntry[] {
  const q = s.search.trim().toLowerCase();
  return (s.result?.entries ?? []).filter((e) => docMatches(e, s.filter, s) && docChip(e, s.chip, s) && (!q || [e.o, e.n].some((x) => x && (x.num + ' ' + x.text + ' ' + e.sec).toLowerCase().includes(q))));
}
/** (T8) the figures of an entry in words: "41 → 33 kg/m3; C30 → C40" (a figure only put in: "+ 33") */
export const figText = (figs?: Fig[]) => (figs ?? []).map((f) => `${f.o && f.n ? `${f.o} → ${f.n}` : f.n ? `+ ${f.n}` : `− ${f.o}`}${f.unit ? ' ' + f.unit : ''}`).join('; ');
/** (T8) the entries of each group (the same change x N), by group id - made once per result */
const groupCache = new WeakMap<DocsResult, Map<number, DocEntry[]>>();
export function docGroups(r: DocsResult): Map<number, DocEntry[]> {
  let m = groupCache.get(r);
  if (!m) { m = new Map(); for (const e of r.entries) if (e.rep !== undefined) { const l = m.get(e.rep); if (l) l.push(e); else m.set(e.rep, [e]); } groupCache.set(r, m); }
  return m;
}
/** the entry's group mates (without itself); [] when it is in none */
export const docMates = (s: DocSession, e: DocEntry): DocEntry[] => (e.rep === undefined || !s.result ? [] : (docGroups(s.result).get(e.rep) ?? []).filter((x) => x !== e));
/** tick the entry and all its group; the number newly ticked */
export function docTickGroup(s: DocSession, e: DocEntry): number {
  let n = 0;
  for (const x of [e, ...docMates(s, e)]) if (!s.ticked.has(x.k)) { s.ticked.add(x.k); n++; }
  docTicksChanged();
  return n;
}
export function docSummary(e: DocEntry): string {
  switch (e.kind) {
    case 'pic': return PIC_LABEL[e.pic!.what];
    case 'secAdded': return `Section added (${e.paras} paragraphs)`;
    case 'secRemoved': return `Section removed (${e.paras} paragraphs)`;
    case 'added': return 'Added';
    case 'removed': return 'Removed';
    case 'renumbered': return `Renumbered ${e.o!.num || '-'} → ${e.n!.num || '-'}`;
    case 'moved': return 'Moved' + (e.o && e.n && e.o.file !== e.n.file ? '' : ` from page ${e.o!.page}`);
    // (one kind per entry, the engine's: "Changed", "Punctuation only", "Date / revision only", "Moved" ...)
    case 'changed': return (e.cls === 'punct' || e.cls === 'dateOnly' ? DOC_CLASS_LABEL[e.cls] : e.cls === 'moved' ? 'Moved' : 'Changed') + (e.moved && e.cls !== 'moved' ? ', moved' : '') + (e.renumbered ? `, ${e.o!.num || '-'} → ${e.n!.num || '-'}` : '');
  }
}

export async function exportDocsExcel() {
  const s = ui.docs;
  if (!s?.result) return;
  const forced = (window as unknown as { __rrSaveAs?: string }).__rrSaveAs;
  if (forced) (window as unknown as { __rrSaveAs?: string }).__rrSaveAs = '';
  const out = forced || await rr.saveDialog({ title: 'Save the document change register', defaultPath: `Document changes - ${s.newSet.label.replace(/[\\/:*?"<>|]+/g, ' ')}.xlsx`, filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
  if (!out) return;
  const H = (v: string) => ({ v, s: 'h' as const });
  const rows: XCell[][] = [['No.', 'What', 'Figures', 'Group', 'Section', 'Under', 'Clause (new)', 'Page (new)', 'Text (new)', 'Clause (old)', 'Page (old)', 'Text (old)', 'Picture', 'Check', 'Reviewed'].map(H)];
  let k = 0;
  for (const e of s.result.entries) {
    rows.push([++k, docSummary(e), figText(e.figs), e.rep === undefined ? '' : `G${e.rep + 1} (${docGroups(s.result).get(e.rep)!.length} the same)`, e.sec, headPath(e).slice(1).join(' › '), e.n?.num ?? '', e.n?.page ?? '', e.n?.text ?? '', e.o?.num ?? '', e.o?.page ?? '', e.o?.text ?? '', e.pic ? `${PIC_LABEL[e.pic.what]} - compare by eye${e.pic.what === 'changed' && !e.pic.whole ? ` (${(e.pic.n ?? e.pic.o ?? []).length} areas boxed)` : ''}` : '', docNeedsCheck(e) ? 'check' : '', s.ticked.has(e.k) ? 'yes' : '']);
  }
  const r = s.result;
  const sum: XCell[][] = [[H('Document comparison'), ''], ['Old issue', s.oldSet.paths.join('; ')], ['New issue', s.newSet.paths.join('; ')],
    ['Sections (old / new / paired)', `${r.sections.old} / ${r.sections.neu} / ${r.sections.paired}`], ['Paragraphs (old / new)', `${r.paras.old} / ${r.paras.neu}`],
    ...r.notes.map((n) => ['Note', n] as XCell[])];
  const xl = writeXlsx([{ name: 'Changes', rows, widths: [6, 26, 24, 14, 34, 40, 9, 8, 80, 9, 8, 80, 26, 7, 9], header: 1 }, { name: 'Summary', rows: sum, widths: [28, 90] }]);
  try { await rr.write(out, xl); } catch (e) { toast('Could not save the register: ' + plainError(e, 'the file'), 'err', 9000); return; }
  toast('Document change register saved', 'ok', 6000);
  void rr.showInFolder(out);
}
