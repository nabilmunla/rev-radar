// The BOQ tab: a comparison of two issues of a bill of quantities (engine: boqCompare), the list
// of what changed made from it, ticks, and the Excel change register.
import { ui, bump, toast, plainError, kept } from './model';
import { rr, type FileItem } from './api';
import { workers, freshJobEngine, closeJobEngine } from './engines';
import { fileArg } from '../engine/rpc';
import type { BoqItem, BoqPair, BoqResult } from '../engine/boq';
import { pairMeta } from '../engine/boq';
import type { Fig } from '../engine/figs';
import type { BoqPic } from '../engine/picdiff';
import { PIC_LABEL } from '../engine/docs';
import { wordDiff, norm } from '../engine/boq';
import { writeXlsx, type XCell } from './xlsxwrite';
import { ocrScans, stopOcr } from './ocr';

/** scanned pages the engine found: read by OCR here, then compared again with their words */
export interface ScanInfo { key: string; name: string; side: 'o' | 'n'; idx: number; pages: { i: number; w: number; h: number }[] }
export async function readScans(c: (typeof workers)[number], scans: ScanInfo[], sets: { o: { files: FileItem[] }; n: { files: FileItem[] } }, note: (t: string) => void, live: () => boolean) {
  // (by the file's place in the set the engine was sent - two files of a folder may share a name)
  const jobs = scans.flatMap((sc) => { const f = sets[sc.side].files[sc.idx]; return f ? [{ key: sc.key, path: f.path, pages: sc.pages }] : []; });
  const total = jobs.reduce((a, j) => a + j.pages.length, 0);
  note(`Reading ${total} scanned page${total === 1 ? '' : 's'} (OCR)…`);
  return ocrScans(c, jobs, (d, t) => note(`Reading scanned pages (OCR): ${d} of ${t}`), live);
}

export interface BoqSet { label: string; paths: string[]; files: FileItem[] }
export type BoqKind = 'changed' | 'heading' | 'added' | 'removed' | 'renumbered' | 'pic';
/** one line of the list: a changed item, a heading reworded over several items, an item added / removed */
export interface BoqEntry {
  k: string; kind: BoqKind;
  pair?: BoqPair; o?: BoqItem; n?: BoqItem;
  /** a heading reworded: the items read with it */
  items?: BoqPair[];
  /** the order in the new issue (removed items: where they were) */
  at: number;
  /** a picture inside a bill's pages (T6.5) */
  pic?: BoqPic;
  /** (T8) the figures changed inside the description (a digit, a unit, a grade, a standard, a finish code) */
  figs?: Fig[];
  /** (T8, DECISIONS 25) the same change x N: its group (3 or more items with the same words / rate / quantity change) */
  rep?: number;
}
export type BoqFilter = 'changes' | 'qty' | 'rounded' | 'unit' | 'text' | 'price' | 'added' | 'removed' | 'moved' | 'renumbered' | 'check' | 'todo';
export interface BoqSession {
  oldSet: BoqSet; newSet: BoqSet;
  phase: 'running' | 'done' | 'error'; error?: string;
  partial: boolean;
  result?: BoqResult & { oldPdf: boolean; newPdf: boolean };
  entries: BoqEntry[];
  sel: number; filter: BoqFilter; search: string;
  /** (T8) the side view's chip: All (nothing left out), Figures, To review */
  chip: 'all' | 'figs' | 'todo';
  ticked: Set<string>;
  run: number;
  /** what it is doing while running ("Reading scanned pages (OCR): 3 of 12") */
  note?: string;
  /** when the run started (performance.now) - the busy line counts from it */
  t0?: number;
}

let runId = 0;
export async function startBoq(oldSet: BoqSet, newSet: BoqSet, partial = false) {
  flushTicks();
  const my = ++runId;
  ui.boq = { oldSet, newSet, phase: 'running', partial, entries: [], sel: -1, filter: 'changes', search: '', chip: 'all', ticked: ui.boq && ui.boq.oldSet.paths.join() === oldSet.paths.join() && ui.boq.newSet.paths.join() === newSet.paths.join() ? ui.boq.ticked : new Set(), run: my, t0: performance.now() };
  bump();
  try {
    // on an engine of its own, ended after the run: Stop ends exactly that one (T23)
    const c = await freshJobEngine('boq');
    if (my !== runId || !ui.boq) return;
    const side = (s: BoqSet) => s.files.map((f) => ({ file: fileArg(f.path), name: f.rel.split(/[\\/]/).pop() || f.rel }));
    let r = await c.call<BoqSession['result'] & { scans?: ScanInfo[] }>('boqCompare', [side(oldSet), side(newSet), { partial }]);
    if (my !== runId || !ui.boq) return;
    if (r?.scans?.length) {
      const live = () => my === runId && !!ui.boq;
      const ocr = await readScans(c, r.scans, { o: oldSet, n: newSet }, (t) => { if (live()) { ui.boq!.note = t; bump(); } }, live);
      if (!live()) return;
      ui.boq!.note = 'Reading and pairing the items…'; bump();
      r = await c.call<BoqSession['result'] & { scans?: ScanInfo[] }>('boqCompare', [side(oldSet), side(newSet), { partial, ocr }]);
      if (my !== runId || !ui.boq) return;
    }
    ui.boq.result = r!;
    ui.boq.entries = entriesOf(r!);
    await restoreTicks(ui.boq);
    if (my !== runId || !ui.boq) return;
    ui.boq.phase = 'done';
    ui.boq.sel = ui.boq.entries.findIndex((e) => e.kind !== 'renumbered');
    void rememberBoq(ui.boq);
  } catch (e) {
    if (my !== runId || !ui.boq) return;
    ui.boq.phase = 'error';
    ui.boq.error = plainError(e, 'a file');
  } finally {
    // (a newer run - "Try again", the changed-pages box - has an engine of its own by now: not this one's to end)
    if (my === runId) void closeJobEngine('boq');
  }
  bump();
}
/** Stop (T23): the engine and the OCR pass end, nothing is kept, and the start screen comes back with the
 *  two issues still chosen */
export function stopBoq() {
  const s = ui.boq;
  if (!s || s.phase !== 'running') return;
  runId++;
  if (ui.docs?.phase !== 'running' && !ui.docs?.picReading) void stopOcr();
  void closeJobEngine('boq');
  kept.boq = { old: { paths: s.oldSet.paths, files: s.oldSet.files }, neu: { paths: s.newSet.paths, files: s.newSet.files }, partial: s.partial };
  ui.boq = null;
  toast('Stopped - the two issues are still chosen', undefined, 5000);
  bump();
}
export function leaveBoq() {
  flushTicks();
  if (ui.boq?.phase === 'running') { runId++; if (ui.docs?.phase !== 'running' && !ui.docs?.picReading) void stopOcr(); void closeJobEngine('boq'); }
  runId++; ui.boq = null; bump();
}

export function entriesOf(r: BoqResult): BoqEntry[] {
  const O = r.old.items, N = r.neu.items;
  const out: BoqEntry[] = [];
  const headings = new Map<string, BoqPair[]>();
  const meta = pairMeta(O, N, r.pairs);
  const at = new Map(r.pairs.map((p, i) => [p, i]));
  /** (T8) the group and the figures of an item's entry */
  const extra = (p: BoqPair): Pick<BoqEntry, 'rep' | 'figs'> => { const i = at.get(p)!; return { ...(meta.rep[i] >= 0 ? { rep: meta.rep[i] } : {}), ...(meta.figs[i] ? { figs: meta.figs[i] } : {}) }; };
  for (const p of r.pairs) {
    const only = p.changed.length > 0 && p.changed.every((f) => f === 'group' || f === 'section') && !p.moved;
    if (only) { const k = norm(O[p.o].section) + '\u0000' + norm(O[p.o].group) + '\u0000' + norm(N[p.n].section) + '\u0000' + norm(N[p.n].group); headings.set(k, [...(headings.get(k) ?? []), p]); continue; }
    if (p.changed.length || p.moved) out.push({ k: 'c' + p.o + ':' + p.n, kind: 'changed', pair: p, o: O[p.o], n: N[p.n], at: p.n, ...extra(p) });
    else if (p.renumbered) out.push({ k: 'r' + p.o + ':' + p.n, kind: 'renumbered', pair: p, o: O[p.o], n: N[p.n], at: p.n });
  }
  for (const [, ps] of headings) {
    if (ps.length === 1) { const p = ps[0]; out.push({ k: 'c' + p.o + ':' + p.n, kind: 'changed', pair: p, o: O[p.o], n: N[p.n], at: p.n, ...extra(p) }); continue; }
    out.push({ k: 'h' + ps[0].o + ':' + ps[0].n, kind: 'heading', items: ps, pair: ps[0], o: O[ps[0].o], n: N[ps[0].n], at: ps[0].n });
  }
  for (const n of r.added) out.push({ k: 'a' + n, kind: 'added', n: N[n], at: n });
  // (a removed item is listed where it was: after the item before it, as that one is now)
  const toN = new Map(r.pairs.map((p) => [p.o, p.n]));
  for (const o of r.removed) {
    let b = o - 1;
    while (b >= 0 && !toN.has(b)) b--;
    out.push({ k: 'd' + o, kind: 'removed', o: O[o], at: (b >= 0 ? toN.get(b)! : -1) + 0.5 });
  }
  // (pictures - T6.5: after the last item of their file, in page order; never items)
  (r.pics ?? []).forEach((p, i) => {
    const f = (p.n ?? p.o)!.file;
    let last = -1;
    N.forEach((x, k) => { if (x.file === f) last = k; });
    out.push({ k: 'p' + i + ':' + (p.o ? p.o.page + ',' + p.o.box.join(',') : '') + '|' + (p.n ? p.n.page + ',' + p.n.box.join(',') : ''), kind: 'pic', pic: p, at: (last >= 0 ? last : N.length) + 0.75 + (p.n ?? p.o)!.page * 1e-4 });
  });
  return out.sort((a, b) => a.at - b.at);
}

const LIKE_CHECK = 0.7;
/** a quantity only rounded (50.7 -> 51, 7.75 -> 8, 2,272.53 -> 2,272.5): the same amount written shorter */
export function rounded(a: unknown, b: unknown): boolean {
  // (only a small step: 2.75 -> 3 t is 9 % more, 0.4 -> 0 is nothing left - not "rounded")
  if (typeof a !== 'number' || typeof b !== 'number' || a === b || b === 0 || Math.abs(b - a) > 0.02 * Math.abs(a)) return false;
  for (const d of [0, 1, 2]) { const f = 10 ** d; if (Math.round(a * f) / f === b) return true; }
  return false;
}
const onlyRounded = (e: BoqEntry) => !!e.pair && e.pair.changed.includes('qty') && rounded(e.o?.qty, e.n?.qty);
// (worth a look: a pairing by likeness or of descriptions far apart, or an item read from a scan (OCR) -
//  a PDF's text layer is read as printed: every item of a PDF flagged made the flag say nothing)
export const needsCheck = (e: BoqEntry, _s?: BoqSession) => e.kind === 'pic' || (!!e.pair && (e.pair.like < LIKE_CHECK || e.pair.how === 'like')) || !!(e.o?.ocr || e.n?.ocr);
export function matches(e: BoqEntry, f: BoqFilter, s: BoqSession): boolean {
  const ch = e.pair?.changed ?? [];
  switch (f) {
    case 'changes': return e.kind !== 'renumbered';
    case 'qty': return ch.includes('qty') && !onlyRounded(e);
    case 'rounded': return onlyRounded(e);
    case 'unit': return ch.includes('unit');
    case 'text': return e.kind === 'heading' || ch.includes('text') || ch.includes('group') || ch.includes('section');
    case 'price': return ch.includes('rate') || ch.includes('amount');
    case 'added': return e.kind === 'added';
    case 'removed': return e.kind === 'removed';
    case 'moved': return !!e.pair?.moved;
    case 'renumbered': return !!e.pair?.renumbered && e.kind !== 'heading';
    case 'check': return e.kind !== 'renumbered' && (e.kind === 'heading' ? checkCount(e, s) > 0 : needsCheck(e, s)); // (T30: a heading by its items)
    case 'todo': return e.kind !== 'renumbered' && !s.ticked.has(e.k);
  }
}
/** (T8) a figure change: a quantity, unit, rate or amount changed, or a figure inside the description */
export const isFigure = (e: BoqEntry) => e.kind === 'changed' && !!e.pair && (e.pair.changed.some((f) => f === 'qty' || f === 'unit' || f === 'rate' || f === 'amount') || !!e.figs?.length);
/** (T8) the chip: all, the figure changes, or the ones not ticked off yet */
export const chipOk = (e: BoqEntry, chip: BoqSession['chip'], s: BoqSession) => chip === 'all' || (chip === 'figs' ? isFigure(e) : e.kind !== 'renumbered' && !s.ticked.has(e.k));
export function visible(s: BoqSession): BoqEntry[] {
  const q = s.search.trim().toLowerCase();
  return s.entries.filter((e) => matches(e, s.filter, s) && chipOk(e, s.chip, s) && (!q || [e.o, e.n].some((x) => x && (x.text + ' ' + x.group + ' ' + x.ref + ' ' + x.section).toLowerCase().includes(q))));
}

/** (T8) the entries of each group, by group id - made once per list of entries */
const groupCache = new WeakMap<BoqEntry[], Map<number, BoqEntry[]>>();
export function boqGroups(entries: BoqEntry[]): Map<number, BoqEntry[]> {
  let m = groupCache.get(entries);
  if (!m) { m = new Map(); for (const e of entries) if (e.rep !== undefined) { const l = m.get(e.rep); if (l) l.push(e); else m.set(e.rep, [e]); } groupCache.set(entries, m); }
  return m;
}
export const boqMates = (s: BoqSession, e: BoqEntry): BoqEntry[] => (e.rep === undefined ? [] : (boqGroups(s.entries).get(e.rep) ?? []).filter((x) => x !== e));
/** tick the entry and all its group; the number of items newly ticked */
export function boqTickGroup(s: BoqSession, e: BoqEntry): number {
  let n = 0;
  for (const x of [e, ...boqMates(s, e)]) if (!s.ticked.has(x.k)) { s.ticked.add(x.k); n += itemCount(x); }
  ticksChanged();
  return n;
}
/** (T8) an entry's figures in words: "Qty 10 → 12; Rate 120 → 135; 30 → 40" (the register's Figures column) */
export function boqFigureText(e: BoqEntry): string {
  const p = e.pair, a = e.o, b = e.n, out: string[] = [];
  if (e.kind === 'changed' && p && a && b) for (const [f, l] of [['qty', 'Qty'], ['unit', 'Unit'], ['rate', 'Rate'], ['amount', 'Amount']] as const) if (p.changed.includes(f)) out.push(`${l} ${f === 'unit' ? a.unit || '-' : fmt(a[f])} → ${f === 'unit' ? b.unit || '-' : fmt(b[f])}`);
  for (const f of e.figs ?? []) out.push(`${f.o && f.n ? `${f.o} → ${f.n}` : f.n ? `+ ${f.n}` : `− ${f.o}`}${f.unit ? ' ' + f.unit : ''}`);
  return out.join('; ');
}

/** (T15, DECISIONS 80) the items an entry stands for: a heading reworded over N items is N, every other line is 1 -
 *  the one place the counts (chips, To review, summary, register) are made from */
export const itemCount = (e: BoqEntry): number => (e.kind === 'heading' ? e.items!.length : 1);
/** the items in the entries a filter shows (the chips on the left, "to review") */
/** (0.6.0 T30) the count lines - the same on the panel and in the register's Summary; they add up to its Changes rows */
export function countLines(s: BoqSession): [string, number][] {
  const r = s.result!;
  const pics = s.entries.filter((e) => e.kind === 'pic').length;
  return [['Changed', boqChanged(s.entries)], ['Added', r.added.length], ['Removed', r.removed.length],
    // ("only": an item renumbered and changed is a change - the Renumbered filter shows both)
    ['Renumbered only', s.entries.filter((e) => e.kind === 'renumbered').length],
    // (pictures are rows of the Changes sheet too: their own line, so the lines add up to the rows - sweep)
    ...(pics ? [['Pictures changed, added or removed', pics] as [string, number]] : [])];
}
export const boqCount = (s: BoqSession, f: BoqFilter): number => s.entries.reduce((n, e) => n + (f === 'check' ? checkCount(e, s) : matches(e, f, s) ? itemCount(e) : 0), 0);
/** (0.6.0 T30) the items of an entry that need a check, as the register marks them: a heading entry's one by one */
function checkCount(e: BoqEntry, s: BoqSession): number {
  if (e.kind === 'renumbered') return 0;
  if (e.kind !== 'heading' || !e.items) return needsCheck(e, s) ? 1 : 0;
  return e.items.filter((p) => needsCheck({ ...e, o: s.result?.old.items[p.o], n: s.result?.neu.items[p.n], pair: p }, s)).length;
}
/** the changed items (a heading reworded counts its items) - the summary's "Changed" */
export const boqChanged = (entries: BoqEntry[]): number => entries.reduce((n, e) => n + (e.kind === 'changed' || e.kind === 'heading' ? itemCount(e) : 0), 0);

/** what the list says about an entry (a few words) */
export function summary(e: BoqEntry): string {
  if (e.kind === 'pic') return PIC_LABEL[e.pic!.what];
  if (e.kind === 'added') return 'Added';
  if (e.kind === 'removed') return 'Removed';
  if (e.kind === 'heading') return `Heading reworded (${e.items!.length} items)`;
  if (e.kind === 'renumbered') return `Renumbered ${e.o!.ref || '-'} → ${e.n!.ref || '-'}`;
  const p = e.pair!, a = e.o!, b = e.n!;
  const bits: string[] = [];
  if (p.changed.includes('qty')) bits.push(`Qty ${fmt(a.qty)} → ${fmt(b.qty)}${rounded(a.qty, b.qty) ? ' (rounded)' : ''}`);
  if (p.changed.includes('unit')) bits.push(`Unit ${a.unit || '-'} → ${b.unit || '-'}`);
  if (p.changed.includes('text')) bits.push('Description');
  else if (p.changed.includes('group') || p.changed.includes('section')) bits.push('Heading');
  if (p.changed.includes('rate')) bits.push('Rate');
  if (p.changed.includes('amount') && !p.changed.includes('rate')) bits.push('Amount');
  if (p.moved) bits.push(a.sheet !== b.sheet || a.file !== b.file ? `Moved from ${a.sheet}` : `Moved from ${a.page}`);
  return bits.join(' · ');
}
export const fmt = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? '-' : typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) : v);
export { wordDiff };

// ---------------------------------------------------------------- remembered

export interface BoqRecent { when: number; label: string; old: { paths: string[] }; neu: { paths: string[] }; partial?: boolean; counts?: Record<string, number>; sigs?: Sigs; ticks?: string[] }
/** each file as it was when ticked (name -> size and time), both sides */
export interface Sigs { o: Record<string, string>; n: Record<string, string> }
const nameOf = (f: FileItem) => f.rel.split(/[\\/]/).pop() || f.rel;
export const setSigs = (a: { files: FileItem[] }, b: { files: FileItem[] }): Sigs => {
  const one = (x: { files: FileItem[] }) => Object.fromEntries(x.files.map((f) => [nameOf(f), `${f.size}:${Math.round(f.mtime)}`]));
  return { o: one(a), n: one(b) };
};
/** the ticks still good - "<kind>|<old file>#...|<new file>#...": a file issued again since (another
 *  size or time) drops the ticks on it, not the others */
export function keptTicks(ticks: string[], was: Sigs | undefined, now: Sigs): { keep: Set<string>; dropped: number } {
  const keep = new Set<string>();
  let dropped = 0;
  const ok = (side: 'o' | 'n', part: string) => { const f = part.split('#')[0]; return !f || (!!was && was[side][f] !== undefined && was[side][f] === now[side][f]); };
  for (const t of ticks) { const [, a = '', b = ''] = t.split('|'); if (ok('o', a) && ok('n', b)) keep.add(t); else dropped++; }
  return { keep, dropped };
}
export const droppedNote = (n: number) => toast(`${n} tick${n === 1 ? '' : 's'} not kept: ${n === 1 ? 'its file was' : 'their files were'} issued again since you ticked ${n === 1 ? 'it' : 'them'} off`, 'warn', 9000);
/** a tick kept by what it is on (the items' sheet and row), not by its place in the list */
const at = (x?: BoqItem) => (x ? `${x.file}#${x.sheet}#${x.row}` : '');
export const tickKeyOf = (e: BoqEntry) => (e.kind === 'pic' ? `pic|${e.k}` : `${e.kind}|${at(e.o)}|${at(e.n)}`);
async function restoreTicks(s: BoqSession) {
  try {
    const st = await rr.settings();
    const row = ((st.recentBoq || []) as BoqRecent[]).find((x) => x.old.paths.join() === s.oldSet.paths.join() && x.neu.paths.join() === s.newSet.paths.join() && !!x.partial === s.partial);
    if (!row?.ticks?.length) return;
    const { keep, dropped } = keptTicks(row.ticks, row.sigs, setSigs(s.oldSet, s.newSet));
    if (dropped) droppedNote(dropped);
    let k = 0;
    for (const e of s.entries) if (keep.has(tickKeyOf(e)) && !s.ticked.has(e.k)) { s.ticked.add(e.k); k++; }
    if (k) toast(`${k} change${k === 1 ? '' : 's'} ticked off last time - still ticked`, 'ok', 6000);
  } catch { /* a convenience */ }
}
let saveT: ReturnType<typeof setTimeout> | null = null;
/** a tick given or taken back: kept for next time (shortly after, once for several) */
export function ticksChanged() {
  if (saveT) clearTimeout(saveT);
  saveT = setTimeout(() => { saveT = null; if (ui.boq?.phase === 'done') void rememberBoq(ui.boq); }, 600);
}
/** a tick given just before leaving: kept now, not lost with the comparison */
function flushTicks() {
  if (!saveT) return;
  clearTimeout(saveT); saveT = null;
  if (ui.boq?.phase === 'done') void rememberBoq(ui.boq);
}
async function rememberBoq(s: BoqSession) {
  try {
    const st = await rr.settings();
    const counts: Record<string, number> = {};
    for (const f of ['changes', 'added', 'removed'] as BoqFilter[]) counts[f] = boqCount(s, f);
    const byK = new Map(s.entries.map((e) => [e.k, e]));
    const ticks = [...s.ticked].map((k) => byK.get(k)).filter(Boolean).map((e) => tickKeyOf(e!));
    const row: BoqRecent = { when: Date.now(), label: `${s.oldSet.label} → ${s.newSet.label}`, old: { paths: s.oldSet.paths }, neu: { paths: s.newSet.paths }, partial: s.partial, counts, sigs: setSigs(s.oldSet, s.newSet), ticks };
    const list = ((st.recentBoq || []) as BoqRecent[]).filter((x) => x.old.paths.join() !== row.old.paths.join() || x.neu.paths.join() !== row.neu.paths.join());
    await rr.setSettings({ recentBoq: [row, ...list].slice(0, 12) });
  } catch { /* the list is a convenience */ }
}

// ---------------------------------------------------------------- the change register

export async function exportBoqExcel() {
  const s = ui.boq;
  if (!s?.result) return;
  const forced = (window as unknown as { __rrSaveAs?: string }).__rrSaveAs;
  if (forced) (window as unknown as { __rrSaveAs?: string }).__rrSaveAs = '';
  const out = forced || await rr.saveDialog({ title: 'Save the BOQ change register', defaultPath: `BOQ changes - ${s.newSet.label.replace(/[\\/:*?"<>|]+/g, ' ')}.xlsx`, filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
  if (!out) return;
  const H = (v: string) => ({ v, s: 'h' as const });
  const rows: XCell[][] = [['No.', 'What', 'Figures', 'Group', 'Where (new)', 'Page', 'Item', 'Was item', 'Section', 'Description (new)', 'Description (old)', 'Qty old', 'Qty new', 'Qty change', 'Unit old', 'Unit new', 'Rate old', 'Rate new', 'Amount old', 'Amount new', 'Moved from', 'Check', 'Reviewed'].map(H)];
  const loc = (x?: BoqItem) => (x ? `${x.file !== s.newSet.files[0]?.rel && s.newSet.files.length > 1 ? x.file + ' › ' : ''}${x.sheet} row ${x.row}` : '');
  const num = (v: number | string | null | undefined): XCell => (typeof v === 'number' ? { v, s: 'n2' } : v ?? '');
  // (quantities to 3 decimals: 12.345 -> 12.348 read "12.35 -> 12.35, change 0.00" at 2)
  const qn = (v: number | string | null | undefined): XCell => (typeof v === 'number' ? { v, s: 'n3' } : v ?? '');
  let k = 0;
  for (const e of s.entries) {
    if (e.pic) {
      const w = e.pic.n ?? e.pic.o!;
      rows.push([++k, `${PIC_LABEL[e.pic.what]} - compare by eye`, '', '', `${w.file} page ${w.page + 1}`, w.page + 1, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'check', s.ticked.has(e.k) ? 'yes' : '']);
      continue;
    }
    const list = e.kind === 'heading' ? e.items!.map((p) => ({ ...e, o: s.result!.old.items[p.o], n: s.result!.neu.items[p.n], pair: p })) : [e];
    for (const x of list) {
      const a = x.o, b = x.n;
      const dq = typeof a?.qty === 'number' && typeof b?.qty === 'number' && x.pair?.changed.includes('qty') ? b.qty - a.qty : null;
      rows.push([
        ++k, e.kind === 'heading' ? 'Heading reworded' : summary(x), e.kind === 'heading' ? '' : boqFigureText(x), e.rep === undefined ? '' : `G${e.rep + 1} (${boqGroups(s.entries).get(e.rep)!.length} the same)`, loc(b ?? a), (b ?? a)?.page ?? '', b?.ref ?? '', a?.ref ?? '', ((b ?? a)?.section ?? ''),
        b ? (b.group ? b.group + ' — ' : '') + b.text : '', a && (!b || x.pair?.changed.some((f) => f === 'text' || f === 'group' || f === 'section')) ? (a.group ? a.group + ' — ' : '') + a.text : '',
        qn(a?.qty), qn(b?.qty), dq === null ? '' : { v: Math.round(dq * 1e6) / 1e6, s: 'n3' }, a?.unit ?? '', b?.unit ?? '', num(a?.rate), num(b?.rate), num(a?.amount), num(b?.amount),
        x.pair?.moved && a ? `${a.sheet} row ${a.row} (${a.page})` : '', needsCheck(x, s) ? 'check' : '', s.ticked.has(e.k) ? 'yes' : '',
      ]);
    }
  }
  const r = s.result;
  const sum: XCell[][] = [
    [H('BOQ comparison'), ''], ['Old issue', s.oldSet.paths.join('; ')], ['New issue', s.newSet.paths.join('; ')],
    ['Items in the old issue', r.old.items.length], ['Items in the new issue', r.neu.items.length],
    ...countLines(s),
    // (T15: every item has its own row, so the rows of the Changes sheet = the chip + the renumbered)
    ['Rows in Changes = changes + renumbered only', rows.length - 1],
    ...(s.partial ? [['Not in the pages issued', r.outside.length] as XCell[]] : []),
    ...(r.oldPdf || r.newPdf ? [['Note', 'One side was read from a PDF: check the items marked "check" against it'] as XCell[]] : []),
    ...[...r.old.notes, ...r.neu.notes].slice(0, 30).map((n) => ['Note', n] as XCell[]),
  ];
  const xl = writeXlsx([
    { name: 'Changes', rows, widths: [6, 30, 26, 14, 30, 8, 7, 7, 26, 70, 70, 11, 11, 11, 8, 8, 11, 11, 13, 13, 30, 7, 9], header: 1 },
    { name: 'Summary', rows: sum, widths: [26, 90] },
  ]);
  try { await rr.write(out, xl); } catch (e) { toast('Could not save the register: ' + plainError(e, 'the file'), 'err', 9000); return; }
  toast('BOQ change register saved', 'ok', 6000);
  void rr.showInFolder(out);
}
