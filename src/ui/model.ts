// What the interface knows: the two issues, the sheet pairs and their results.
import { useSyncExternalStore } from 'react';
import type { SheetRef, PairPlan } from './pairing';
import type { FileItem } from './api';
import type { TextChange } from '../engine/textdiff';
import { isFigWord } from '../engine/figs';
import { allShown } from './panels';

export type Status = 'waiting' | 'running' | 'changed' | 'titleonly' | 'same' | 'identical' | 'new' | 'removed' | 'error';

export interface AreaR { box: number[]; add: number; rem: number; kind: 'added' | 'removed' | 'modified'; text: TextChange[]; moved: number; cloud?: 'removed' | 'added'; pattern?: boolean; shift?: { dx: number; dy: number; stretched?: boolean; shorter?: boolean }; seam?: { by: number; shorter?: boolean } }
export interface PartR { dx: number; dy: number; box: number[]; rects: number[][]; align: number[]; stretched?: boolean; shorter?: boolean; inkBox?: number[] }
export interface ResultR {
  /** the settings it was made with */
  settings?: Settings;
  oldSize: { w: number; h: number }; newSize: { w: number; h: number };
  align: number[];
  alignInfo: { fit: number; fit0: number; turned: number; scale: number; moved: boolean; fine: string };
  areas: AreaR[];
  /** parts of the sheet that moved on their own (a plan placed elsewhere on the paper): each lined
   *  up separately - dx, dy = how far it moved (points), box / rects in the new sheet's space */
  parts?: PartR[];
  addPx: number; remPx: number; inkPx: number; oldInkPx: number; scan: boolean; scanMix?: boolean; scale: number;
  thumbSize: { w: number; h: number };
  previewSize: { w: number; h: number };
  ms: Record<string, number>;
  fromCache?: boolean;
}

export interface Pair {
  id: string;
  old: SheetRef | null;
  neu: SheetRef | null;
  how: PairPlan['how'];
  score?: number;
  /** drawing number (or file name) and the file's descriptive name */
  key: string;
  title: string;
  status: Status;
  result?: ResultR;
  thumbUrl?: string;
  cacheKey?: string;
  error?: string;
  reviewed?: boolean;
  /** a tick kept from last time: how many changes counted then (more now: not ticked any more) */
  tickedReal?: number;
  /** per area: sits where most sheets changed (title block, revision table) */
  common?: boolean[];
  /** per area: inside a spot the user chose to leave out */
  ignored?: boolean[];
  manualAlign?: number[] | null;
  /** seconds the check took */
  secs?: number;
  /** when its comparison started (while running: the progress line names sheets taking long) */
  since?: number;
}

export interface Manual { hand: [string, string][]; split: [string, string][] }
export const refKey = (r: { rel: string; page: number }) => `${r.rel}#${r.page}`;
/** what a reviewed mark is kept by: the two sheets themselves (a key alone can repeat) - and the
 *  files' size and date, so a file re-issued under the same name is not ticked off unseen */
type RefLike = { rel: string; page: number; size?: number; mtime?: number };
const tickRef = (r: RefLike) => `${refKey(r)}#${r.size ?? ''}#${r.mtime ? Math.round(r.mtime) : ''}`;
export const reviewKey = (p: { old: RefLike | null; neu: RefLike | null }) => `${p.old ? tickRef(p.old) : ''}|${p.neu ? tickRef(p.neu) : ''}`;

export interface SetInfo { label: string; paths: string[]; recursive: boolean; files: FileItem[] }
/** a spot left out on every sheet of one size: box as fractions of the page */
export interface Zone { group: string; box: number[] }

export interface Settings { dpi: number; tolMM: number; contrast: number; joinMM: number }
export const DEFAULTS: Settings = { dpi: 150, tolMM: 0.25, contrast: 48, joinMM: 3 };

export interface Session {
  id: string;
  oldSet: SetInfo;
  newSet: SetInfo;
  pairs: Pair[];
  zones: Zone[];
  /** pairs made or split by hand (file + page of the old and the new sheet), kept for reopening */
  manual: Manual;
  started: number;
  finished?: number;
  phase: 'reading' | 'pairing' | 'comparing' | 'done' | 'stopped';
  note?: string;
  /** the settings this comparison runs with (Settings > Save during a run is for the next one) */
  settings?: Settings;
}

export interface UIState {
  session: Session | null;
  selected: string | null;
  filter: 'all' | 'figs' | 'changed' | 'tiny' | 'moved' | 'titleonly' | 'same' | 'new' | 'removed' | 'error' | 'todo';
  search: string;
  /** area number selected in the viewer (index into the pair's areas) */
  area: number;
  showCommon: boolean;
  settings: Settings;
  engines: number;
  theme: 'light' | 'dark';
  /** the tab: drawings, BOQ, documents (each keeps its comparison open while another is looked at) */
  tab: 'drawings' | 'boq' | 'docs';
  /** the BOQ tab's comparison (boqrun.ts) */
  boq: import('./boqrun').BoqSession | null;
  /** the Documents tab's comparison (docsrun.ts) */
  docs: import('./docsrun').DocSession | null;
  listMode: 'rows' | 'grid';
  toast: Toast[];
  /** side panels shown, per tab (the drawing gets the room when they are hidden; panels.ts) */
  panels: import('./panels').Shown;
  /** the keyboard keys sheet is open */
  keys: boolean;
  /** N shows tiny changes last on a sheet that has bigger ones too (remembered) */
  skipTiny: boolean;
  /** the change boxes get a faint highlighter fill - easier to spot on a poor screen (remembered) */
  highlight: boolean;
}
export interface Toast { id: number; text: string; kind?: 'ok' | 'warn' | 'err'; action?: { label: string; run: () => void }; key?: string }

/** the two sets a stopped BOQ / Documents run was started with: the start screen shows them chosen again (T23) */
export interface KeptSets { old: { paths: string[]; files: FileItem[] }; neu: { paths: string[]; files: FileItem[] }; partial?: boolean }
export const kept: { boq?: KeptSets; docs?: KeptSets } = {};

let version = 0;
const listeners = new Set<() => void>();
export const ui: UIState = {
  session: null, selected: null, filter: 'all', search: '', area: -1, showCommon: false,
  settings: { ...DEFAULTS }, engines: 0, theme: 'light', listMode: 'rows', toast: [],
  panels: allShown(), keys: false, skipTiny: true, highlight: false,
  tab: 'drawings', boq: null, docs: null,
};

/**
 * The part of the sheet keys every sheet shares ("F109-ARG-DWG-") is left out in the list: what
 * tells the sheets apart is at the end, and a narrow list cut it off ("F109-ARG-DWG-AR-000...").
 */
let prefixFor = { pairs: null as Pair[] | null, n: 0, prefix: '' };
export function keyPrefix(pairs: Pair[]): string {
  if (prefixFor.pairs === pairs && prefixFor.n === pairs.length) return prefixFor.prefix;
  let pre = '';
  const keys = pairs.map((p) => p.key);
  if (keys.length >= 3) {
    // the longest start (up to a separator) that at least 80 % of the sheets share - one odd sheet
    // ("ZZ-900") must not keep the whole list long; sheets without it are shown in full
    const counts = new Map<string, number>();
    for (const k of keys) {
      const here = new Set<string>();
      for (let i = 3; i < k.length - 3; i++) if (k[i] === '-' || k[i] === '_' || k[i] === ' ') here.add(k.slice(0, i + 1));
      for (const c of here) counts.set(c, (counts.get(c) || 0) + 1);
    }
    const need = Math.max(3, Math.ceil(keys.length * 0.8));
    for (const [c, n] of counts) if (n >= need && c.length > pre.length) pre = c;
  }
  prefixFor = { pairs, n: pairs.length, prefix: pre };
  return pre;
}
export const shortKey = (p: Pair, pre: string) => (pre && p.key.startsWith(pre) ? p.key.slice(pre.length) : p.key);

let pending = false;
/** something changed: redraw (batched to one frame) */
export function bump(now = false) {
  if (now) { version++; for (const l of listeners) l(); return; }
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; version++; for (const l of listeners) l(); });
}
export function useUI(): UIState {
  useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f); }, () => version);
  return ui;
}

let toastSeq = 0;
/** key: a toast of the same key replaces the one before (one "ticked off" at a time) */
export function toast(text: string, kind?: 'ok' | 'warn' | 'err', ms = 4500, action?: Toast['action'], key?: string) {
  const id = ++toastSeq;
  ui.toast = [...ui.toast.filter((t) => !key || t.key !== key), { id, text, kind, action, key }];
  bump();
  setTimeout(() => { ui.toast = ui.toast.filter((t) => t.id !== id); bump(); }, ms);
}

export const STATUS: Record<Status, { label: string; cls: string; tip: string }> = {
  waiting: { label: 'Waiting', cls: 'st-wait', tip: 'Not compared yet' },
  running: { label: 'Comparing…', cls: 'st-run', tip: 'Being compared now' },
  changed: { label: 'Changed', cls: 'st-changed', tip: 'The drawing itself changed' },
  titleonly: { label: 'Title block only', cls: 'st-title', tip: 'The drawing did not change: only the title block / revision table, old revision clouds taken off, dashed lines redrawn with their dashes elsewhere, or spots you left out' },
  same: { label: 'No change', cls: 'st-same', tip: 'The sheets look the same' },
  identical: { label: 'Identical file', cls: 'st-same', tip: 'The very same file was issued again' },
  new: { label: 'New sheet', cls: 'st-new', tip: 'Only in the new issue' },
  removed: { label: 'Removed sheet', cls: 'st-removed', tip: 'Only in the old issue' },
  error: { label: 'Could not compare', cls: 'st-err', tip: 'See the details on the right' },
};

/** an area that does not count as a drawing change: why (or '' when it counts) */
export function areaSkip(p: Pair, i: number): '' | 'title block' | 'left out' | 'old cloud' | 'pattern' {
  if (p.ignored?.[i]) return 'left out';
  if (p.common?.[i]) return 'title block';
  const a = p.result?.areas[i];
  if (a?.cloud === 'removed') return 'old cloud';
  if (a?.pattern) return 'pattern';
  return '';
}

/** the change areas that count (not title block / old clouds taken off / left-out spots) */
export function realAreas(p: Pair): number[] {
  const r = p.result;
  if (!r) return [];
  const out: number[] = [];
  r.areas.forEach((_, i) => { if (!areaSkip(p, i)) out.push(i); });
  return out;
}

/**
 * A very small change: under ~1.2 mm² of ink on paper and no words changed (a line join, a hair of
 * re-drafting). Still a change - but a sheet with nothing else is worth only a quick look.
 */
export function isTiny(p: Pair, i: number): boolean {
  const r = p.result, a = r?.areas[i];
  if (!r || !a || a.cloud || a.shift || a.seam) return false;
  const pxPerMm = r.scale * 72 / 25.4;
  return (a.add + a.rem) / (pxPerMm * pxPerMm) < 1.2 && !a.text.some((t) => t.kind !== 'moved');
}
/**
 * The numbers shown for a sheet's change areas: the changes that count are 1..N (as the count
 * says, the same in the list, on the sheet, in the PDF and in Excel); the hidden ones get a
 * letter for why plus their own count - T1 title block, C1 old cloud, D1 dashes, X1 left out.
 */
export function areaLabels(p: Pair): string[] {
  const r = p.result;
  if (!r) return [];
  let n = 0;
  const per: Record<string, number> = {};
  const L: Record<string, string> = { 'title block': 'T', 'old cloud': 'C', pattern: 'D', 'left out': 'X' };
  return r.areas.map((_, i) => {
    const why = areaSkip(p, i);
    if (!why) return String(++n);
    per[why] = (per[why] || 0) + 1;
    return L[why] + per[why];
  });
}
/** a sheet that needs a look: changed, new or removed in this issue, or one that could not be
 *  compared (someone has to ask for the file again) */
export const needsReview = (p: Pair) => p.status === 'changed' || p.status === 'new' || p.status === 'removed' || p.status === 'error';

/** the order N / P go through a sheet's changes: on a sheet that has bigger changes too, the tiny
 *  ones come last (after one stop that says so) - never left out: a planted removed window can be
 *  "tiny" (a sheet is only ticked off by N once every change was seen) */
export function stepAreas(p: Pair, common = false): number[] {
  const r = p.result;
  if (!r) return [];
  if (common) return r.areas.map((_, i) => i);
  // (T8: with the Figures filter chosen, only the changes in figures)
  if (ui.filter === 'figs') return figAreas(p);
  const real = realAreas(p);
  if (!ui.skipTiny) return real;
  const big = real.filter((i) => !isTiny(p, i));
  return big.length ? [...big, ...real.filter((i) => isTiny(p, i))] : real;
}
/** where the tiny ones begin in stepAreas (-1: none held back) */
export function tinyFrom(p: Pair): number {
  if (!ui.skipTiny || !p.result) return -1;
  const real = realAreas(p);
  const big = real.filter((i) => !isTiny(p, i)).length;
  return big && big < real.length ? big : -1;
}

/** changed, but only a view (or views) moved on the sheet - nothing in the drawing itself (a
 *  stretched part is a change of the drawing: the lines running into it got longer) */
export function onlyMoves(p: Pair): boolean {
  if (p.status !== 'changed' || !p.result) return false;
  const real = realAreas(p);
  return real.length > 0 && real.every((i) => { const s = p.result!.areas[i].shift; return !!s && !s.stretched; });
}

/** changed, but only tiny changes */
export function onlyTiny(p: Pair): boolean {
  if (p.status !== 'changed') return false;
  const real = realAreas(p);
  return real.length > 0 && real.every((i) => isTiny(p, i));
}

/** the status as shown: "Title block only" says so when old clouds were taken off too */
export function statusLabel(p: Pair): string {
  if (onlyTiny(p)) return 'Tiny changes only';
  if (p.status === 'titleonly' && p.result?.areas.some((a, i) => a.cloud === 'removed' && !p.common?.[i] && !p.ignored?.[i])) {
    return p.result.areas.some((_, i) => p.common?.[i]) ? 'Title block + old clouds' : 'Old clouds removed';
  }
  if (onlyMoves(p)) return 'Moved only';
  return STATUS[p.status].label;
}

/** how far a part moved, in words: "1.9 mm down", "1.2 mm right and 1.5 mm up" */
export function moveWords(dx: number, dy: number): string {
  const x = (dx * 25.4) / 72, y = (dy * 25.4) / 72;
  const out: string[] = [];
  if (Math.abs(x) >= 0.1) out.push(`${Math.abs(x).toFixed(1)} mm ${x > 0 ? 'right' : 'left'}`);
  if (Math.abs(y) >= 0.1) out.push(`${Math.abs(y).toFixed(1)} mm ${y > 0 ? 'down' : 'up'}`);
  return out.join(' and ') || 'a fraction of a millimetre';
}

/** an error as a person reads it: without Electron's "Error invoking remote method 'x': Error:" in
 *  front, and the usual file troubles in words */
export function plainError(e: unknown, file = 'the file'): string {
  const m = String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']*': (\w*Error: )?/, '');
  if (/EBUSY|EPERM|EACCES|EISDIR/.test(m)) return `${file} is open in another program (close it there) or the folder is read-only`;
  if (/ENOENT/.test(m)) return "the folder isn't there any more (moved, renamed or a network drive dropped)";
  if (/ENOSPC/.test(m)) return 'the disk is full';
  // (0.6.1 ritual: a background process that restarted or closed mid-run - the app's business, not a name to show)
  if (/^(Engine \d+|View engine|\w+ engine) (restarted|was closed)$/i.test(m.trim())) return STOPPED_TEXT;
  return m;
}
/** (0.6.1) work that ended before it finished - its process restarted or closed */
export const STOPPED_TEXT = 'The work stopped before it finished. Try again - if it stops again, a file may be damaged or too heavy for this PC.';

/** where on the sheet a box is, in thirds: "top left", "middle right", "centre" */
export function where(b: number[], page: { w: number; h: number }): string {
  const cx = (b[0] + b[2]) / 2 / page.w, cy = (b[1] + b[3]) / 2 / page.h;
  const v = cy < 1 / 3 ? 'top' : cy < 2 / 3 ? 'middle' : 'bottom', h = cx < 1 / 3 ? 'left' : cx < 2 / 3 ? 'middle' : 'right';
  return v === 'middle' && h === 'middle' ? 'centre' : v === 'middle' ? `middle ${h}` : h === 'middle' ? `${v} middle` : `${v} ${h}`;
}

/** the moved parts of a sheet in one line ("The part at the bottom left moved 1.9 mm down on the
 *  sheet, as a whole"; a stretched part: "Part of the drawing at the top moved 3.0 mm up - stretched...") */
export function movedNote(p: Pair): string {
  const r = p.result;
  if (!r?.parts?.length || p.status === 'error') return '';
  const lines = r.parts.map((q) => {
    const n = partName(q.inkBox ?? q.box, r.newSize, q.stretched);
    return n.charAt(0).toUpperCase() + n.slice(1) + ' moved ' + moveWords(q.dx, q.dy) + (q.stretched ? (q.shorter ? ' - shortened: the lines running into it got shorter' : ' - stretched: the lines running into it got longer') : ' on the sheet, as a whole');
  });
  return lines.join('; ') + (r.parts.some((q) => !q.stretched) ? ' (a view placed elsewhere, or something moved in the drawing - check which)' : '');
}

/** where a part is on the sheet: "the part at the bottom left", "the drawing" (most of the sheet);
 *  stretched: "part of the drawing at the top" */
export function partName(box: number[], size: { w: number; h: number }, stretched = false): string {
  const fw = (box[2] - box[0]) / size.w, fh = (box[3] - box[1]) / size.h;
  const at = where(box, size), place = at === 'centre' ? 'in the middle' : `at the ${at}`;
  if (stretched) return `part of the drawing ${place}`;
  // (only a part this big is "the drawing": a half-sheet plan may well have a second plan beside it)
  if (fw > 0.6 && fh > 0.6) return 'the drawing';
  return `the part ${place}`;
}

/** a stretch seam's title: "Lines 3.0 mm longer here (stretched)" */
export function seamTitle(s: { by: number; shorter?: boolean }): string {
  return `Lines ${(s.by * 25.4 / 72).toFixed(1)} mm ${s.shorter ? 'shorter' : 'longer'} here (${s.shorter ? 'shortened' : 'stretched'})`;
}

/** a move item's title: "Moved 1.9 mm down" / "Stretched 3.0 mm up" / "Shortened 3.0 mm down" */
export function moveTitle(s: { dx: number; dy: number; stretched?: boolean; shorter?: boolean }): string {
  return (s.stretched ? (s.shorter ? 'Shortened ' : 'Stretched ') : 'Moved ') + moveWords(s.dx, s.dy);
}

export const sizeGroup = (s: { w: number; h: number }) => `${Math.round(s.w / 10) * 10}x${Math.round(s.h / 10) * 10}`;

/** (T8) a text change that is a figure: a word changed to another, or put in / taken out, that holds a digit or is a
 *  unit, grade, standard or finish code ("4200 -> 4500", "C30 -> C40") */
export const isFigText = (t: TextChange) => `${t.from ?? ''} ${t.to ?? ''}`.split(/\s+/).some((w) => !!w && isFigWord(w));
/** the sheet has a change in its figures (a counted area with such a text) */
export function hasFigures(p: Pair): boolean {
  return !!p.result && realAreas(p).some((i) => p.result!.areas[i].text.some(isFigText));
}
/** the areas of a sheet N visits with the Figures filter on: the ones with a figure text */
export const figAreas = (p: Pair): number[] => realAreas(p).filter((i) => p.result!.areas[i].text.some(isFigText));

/** (T8, DECISIONS 25) the same change on many sheets: one text changed from -> to (exactly the same words) on 3 or
 *  more sheets - a note reworded on every sheet. `hits`: where it is, each sheet once per area. */
export interface SheetGroup { key: string; from: string; to: string; hits: { p: Pair; area: number }[]; sheets: Pair[] }
const wsp = (t?: string) => (t ?? '').replace(/\s+/g, ' ').trim();
export function textGroups(pairs: Pair[], min = 3): Map<string, SheetGroup> {
  const by = new Map<string, SheetGroup>();
  for (const p of pairs) {
    if (!p.result) continue;
    for (const i of realAreas(p)) for (const t of p.result.areas[i].text) {
      if (t.kind !== 'changed' || !t.from || !t.to) continue;
      const key = wsp(t.from) + '\u0001' + wsp(t.to);
      let g = by.get(key);
      if (!g) by.set(key, (g = { key, from: wsp(t.from), to: wsp(t.to), hits: [], sheets: [] }));
      if (!g.hits.some((h) => h.p === p && h.area === i)) g.hits.push({ p, area: i });
      if (g.sheets[g.sheets.length - 1] !== p) g.sheets.push(p);
    }
  }
  for (const [k, g] of by) if (g.sheets.length < min) by.delete(k);
  return by;
}
/** the group an area's text changes belong to (the first), if any */
export function groupOfArea(groups: Map<string, SheetGroup>, p: Pair, area: number): SheetGroup | null {
  for (const t of p.result?.areas[area]?.text ?? []) {
    if (t.kind !== 'changed' || !t.from || !t.to) continue;
    const g = groups.get(wsp(t.from) + '\u0001' + wsp(t.to));
    if (g) return g;
  }
  return null;
}
/** the sheet's counted areas that are not part of the group's change: what is left to look at on it after
 *  "Tick all" (none: ticking the group's change is the whole sheet) */
export function leftOver(g: SheetGroup, p: Pair): number[] {
  const mine = new Set(g.hits.filter((h) => h.p === p).map((h) => h.area));
  return realAreas(p).filter((i) => !mine.has(i));
}

export function visiblePairs(st: UIState): Pair[] {
  const s = st.session;
  if (!s) return [];
  const q = st.search.trim().toLowerCase();
  return s.pairs.filter((p) => {
    if (q && !(p.key.toLowerCase().includes(q) || p.title.toLowerCase().includes(q) || (p.old?.rel || '').toLowerCase().includes(q) || (p.neu?.rel || '').toLowerCase().includes(q))) return false;
    switch (st.filter) {
      case 'all': return true;
      case 'changed': return p.status === 'changed';
      case 'figs': return hasFigures(p);
      case 'tiny': return onlyTiny(p);
      case 'moved': return onlyMoves(p);
      case 'titleonly': return p.status === 'titleonly';
      case 'same': return p.status === 'same' || p.status === 'identical';
      case 'new': return p.status === 'new';
      case 'removed': return p.status === 'removed';
      case 'error': return p.status === 'error';
      case 'todo': return needsReview(p) && !p.reviewed;
    }
    return true;
  });
}
