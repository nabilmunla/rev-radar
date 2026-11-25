// The results screen: sheet list (left), the sheet (middle), what changed (right).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ui, bump, useUI, visiblePairs, textGroups, groupOfArea, leftOver, hasFigures, type SheetGroup, realAreas, stepAreas, tinyFrom, areaSkip, areaLabels, needsReview, statusLabel, onlyTiny, onlyMoves, moveWords, moveTitle, seamTitle, partName, isTiny, keyPrefix, shortKey, toast, STATUS, type Pair, type UIState } from './model';
import { rr } from './api';
import { Icon } from './icons';
import { usePanels, SidePanel, togglePanel, panelTip } from './PanelSize';
import { HScroll } from './Scroller';
import { Viewer, viewCmd, viewBox, type Mode, type NextUp } from './Viewer';
import { warmOpen } from './viewpool';
import { fileArg } from '../engine/rpc';
import { prioritise, rerun, stop, resume, clearZones, remember, pairByHand, unpair, zonesOver, removeZones, onRerun } from './runner';
import { describe, kindOf, exportExcel, exportPdf } from './exporting';
import type { TextChange } from '../engine/textdiff';

const FILTERS: [UIState['filter'], string, string?][] = [
  ['all', 'All'], ['todo', 'To review', 'Sheets not ticked off yet: changed, new, removed and the ones that could not be compared (R ticks one off)'],
  ['figs', 'Figures', 'Sheets where a number, a unit, a grade, a standard or a finish code changed in the text (4200 → 4500) - N goes through only these changes'], ['changed', 'Changed'],
  ['tiny', 'Tiny only', 'Changed sheets with only very small changes'], ['moved', 'Moved only', 'Changed sheets where only a part moved as a whole'], ['titleonly', 'Title block', 'Only the title block / revision table changed, old clouds taken off'],
  ['same', 'No change'], ['new', 'New'], ['removed', 'Removed'], ['error', 'Problems', 'Sheets that could not be compared'],
];
/** a filter shown only while it is on (from the summary) */
const QUIET = new Set<UIState['filter']>(['tiny', 'moved']);

function counts(pairs: Pair[]) {
  const c: Record<string, number> = { all: pairs.length, figs: 0, changed: 0, tiny: 0, moved: 0, todo: 0, ticked: 0, pending: 0, titleonly: 0, same: 0, new: 0, removed: 0, error: 0, done: 0 };
  for (const p of pairs) {
    if (needsReview(p)) { if (p.reviewed) c.ticked++; else c.todo++; }
    if (p.status === 'changed') { c.changed++; if (hasFigures(p)) c.figs++; if (onlyTiny(p)) c.tiny++; if (onlyMoves(p)) c.moved++; }
    else if (p.status === 'titleonly') c.titleonly++;
    else if (p.status === 'same' || p.status === 'identical') c.same++;
    else if (p.status === 'new') c.new++;
    else if (p.status === 'removed') c.removed++;
    else if (p.status === 'error') c.error++;
    if (p.status !== 'waiting' && p.status !== 'running') c.done++; else c.pending++;
  }
  return c;
}

/** the changes looked at, per sheet (this session): a sheet left with N after all of them were seen
 *  is ticked off by itself */
const seen = new Map<string, Set<number>>();
/** when the open sheet was opened: R right after a jump is a key pressed twice, not a look */
let openedAt = 0;
/** sheets where N already stopped once before their tiny changes */
const tinyTold = new Set<string>();
/** the change last shown per sheet: after Esc (the whole sheet), N goes on from there */
const lastAt = new Map<string, number>();
/** a change counts as looked at once it was on screen a moment - not when a held N flashed past it */
const SEEN_AFTER = 200;
let dwell: { pid: string; area: number; t: ReturnType<typeof setTimeout> } | null = null;
// compared again: the change numbers belong to the new result - nothing of it is seen yet, N starts at
// its first change and stops before its tiny ones (RR-036: N went on from the old result's place and
// ticked the sheet off with new changes never shown)
// (and the sheet on screen goes to its whole view: the change number shown was the old result's - it
//  was taken as seen again, and N went on from it)
onRerun.add((p) => {
  seen.delete(p.id); lastAt.delete(p.id); tinyTold.delete(p.id);
  if (dwell?.pid === p.id) { clearTimeout(dwell.t); dwell = null; }
  if (ui.selected === p.id) ui.area = -1;
});
function seenSoon(pid: string, area: number) {
  if (seen.get(pid)?.has(area) || (dwell && dwell.pid === pid && dwell.area === area)) return;
  if (dwell) clearTimeout(dwell.t);
  dwell = {
    pid, area,
    t: setTimeout(() => {
      dwell = null;
      if (ui.selected !== pid || ui.area !== area) return;
      let v = seen.get(pid);
      if (!v) seen.set(pid, (v = new Set()));
      v.add(area);
    }, SEEN_AFTER),
  };
}

/** (T8) Tick all: a change made on many sheets (the same note reworded) counted as seen on each of them; a sheet with
 *  nothing else left to look at is ticked off - one with other changes stays to review (said, not silent) */
export function tickGroup(g: SheetGroup) {
  const s = ui.session;
  if (!s) return;
  let off = 0, left = 0;
  for (const p of g.sheets) {
    let v = seen.get(p.id);
    if (!v) seen.set(p.id, (v = new Set()));
    for (const h of g.hits) if (h.p === p) v.add(h.area);
    if (p.reviewed || !needsReview(p)) continue;
    if (realAreas(p).every((i) => v!.has(i))) { p.reviewed = true; off++; } else left++;
  }
  void remember(s);
  toast(`Same change on ${g.sheets.length} sheets: ${off} ticked off${left ? `, ${left} still ha${left === 1 ? 's' : 've'} other changes to look at` : ''}`, 'ok', 6000, undefined, 'ticked');
  bump();
}

/** the change boxes filled with a faint highlighter colour, or not (remembered) */
export function toggleHighlight() {
  ui.highlight = !ui.highlight;
  void rr.setSettings({ highlight: ui.highlight });
  bump();
}

export function Results() {
  const st = useUI();
  const s = st.session!;
  const list = visiblePairs(st);
  const c = counts(s.pairs);
  const pair = s.pairs.find((p) => p.id === st.selected) || null;
  const [mode, setModeRaw] = useState<Mode>('overlay');
  const [fade, setFade] = useState(0.55);
  const [flicker, setFlicker] = useState(false);
  const pre = keyPrefix(s.pairs);

  // (the handlers below look the open sheet and the list up afresh: two keys in one frame must
  // not act on the sheet the last drawing showed)
  const cur = () => ui.session?.pairs.find((p) => p.id === ui.selected) || null;
  const lst = () => visiblePairs(ui);
  const select = (p: Pair | null, area = -1) => {
    if ((p?.id ?? null) !== ui.selected) openedAt = Date.now();
    ui.selected = p?.id ?? null;
    ui.area = area;
    if (p) prioritise(p.id);
    bump(true);
    if (p) setTimeout(() => document.querySelector(`[data-pid="${p.id}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
  };
  /** a sheet just opened: N past its end / R / the button wait a moment (a key held down or pressed
   *  twice must not tick off a sheet nobody has looked at) */
  const tooSoon = () => Date.now() - openedAt < 400;
  const areasOf = (p: Pair) => stepAreas(p, ui.showCommon);
  if (pair && st.area >= 0) { lastAt.set(pair.id, st.area); seenSoon(pair.id, st.area); }
  /** a sheet to stop at with N / P: changed (with changes to show), or one to look at as a whole -
   *  new, removed, could not be compared */
  const isStop = (p: Pair) => (p.status === 'changed' && areasOf(p).length > 0) || (needsReview(p) && p.status !== 'changed');
  const goArea = (i: number) => { ui.area = i; bump(true); viewCmd('area'); };
  /** held: the key is held down (repeating) - it stops at the sheet's end, never moves on */
  const stepArea = (d: 1 | -1, held = false) => {
    const pair = cur(), list = lst();
    const idx = pair ? areasOf(pair) : [];
    let k = idx.indexOf(ui.area);
    // off the change (Esc: the whole sheet): on from the change shown last, not from the first
    if (k < 0 && ui.area < 0 && pair && lastAt.has(pair.id)) k = idx.indexOf(lastAt.get(pair.id)!);
    // on a change N doesn't stop at (clicked in the list, hidden, left out): from where it is
    if (k < 0 && ui.area >= 0 && idx.length) {
      const after = idx.findIndex((i) => i > ui.area);
      if (d > 0) { if (after >= 0) { goArea(idx[after]); return; } k = idx.length - 1; }
      else { const before = [...idx].reverse().find((i) => i < ui.area); if (before !== undefined) { goArea(before); return; } k = 0; }
    }
    // the tiny ones come last: one stop first that says so (R ticks the sheet off without them)
    const tf = pair && !ui.showCommon ? tinyFrom(pair) : -1;
    if (pair && d > 0 && tf > 0 && k === tf - 1 && !tinyTold.has(pair.id) && idx.slice(tf).some((i) => !seen.get(pair.id)?.has(i))) {
      tinyTold.add(pair.id);
      const n = idx.length - tf;
      toast(`${n} tiny change${n === 1 ? '' : 's'} left on this sheet (each under about 1 mm² of ink) - N shows ${n === 1 ? 'it' : 'them'}, R ticks the sheet off now`, 'ok', 8000, undefined, 'ticked');
      return;
    }
    if (idx.length && !(k >= 0 && (k + d < 0 || k + d >= idx.length))) { goArea(idx[k < 0 ? (d > 0 ? 0 : idx.length - 1) : k + d]); return; }
    if (held || tooSoon()) return;
    // past the last change: every change of this sheet seen (or a new sheet looked at) - it is
    // ticked off, and on to the next sheet still to review
    if (d > 0) {
      // ticked off by N only when every change was looked at - and never a sheet that could not be
      // compared (nothing of it was seen: R ticks it off once someone has dealt with it)
      const unseen = pair && pair.status === 'changed' ? realAreas(pair).filter((i) => !seen.get(pair.id)?.has(i)) : [];
      const done = !!pair && needsReview(pair) && !pair.reviewed && pair.status !== 'error' && !unseen.length;
      if (pair && !pair.reviewed && pair.status === 'error') toast(`${pair.key} not ticked off: it could not be compared. R ticks it off once you have dealt with it.`, 'warn', 6000, undefined, 'ticked');
      else if (pair && !pair.reviewed && unseen.length) { const lab = areaLabels(pair); toast(`${pair.key} not ticked off: change${unseen.length === 1 ? '' : 's'} ${unseen.slice(0, 6).map((i) => lab[i]).join(', ')}${unseen.length > 6 ? ' …' : ''} not looked at yet (R ticks it off)`, 'warn', 7000, undefined, 'ticked'); }
      if (done && pair) {
        pair.reviewed = true;
        void remember(s);
        const p0 = pair;
        toast(`${p0.key} ticked off as reviewed${p0.status !== 'changed' ? '' : ' - all its changes seen'}`, 'ok', 5000, { label: 'Undo', run: () => { p0.reviewed = false; void remember(s); select(p0); } }, 'ticked');
      }
      const at = pair ? s.pairs.indexOf(pair) : -1;
      const l = list.filter((p) => isStop(p) && !p.reviewed && p !== pair);
      const nx = l.find((p) => s.pairs.indexOf(p) > at) || l[0];
      if (!nx) {
        const left = s.pairs.filter((p) => needsReview(p) && !p.reviewed && p !== pair).length;
        // (T43, 151) unless this sheet is itself still to review AND sheets are left elsewhere: then the warning just shown is the whole message
        if (!(pair && !pair.reviewed && needsReview(pair) && left)) toast(left ? `Nothing more to review in this list - ${left} more in other lists (To review shows them)` : (pair && !pair.reviewed && needsReview(pair) ? `${pair.key} is the last sheet to review` : list.some(isStop) || s.pairs.some(needsReview) ? 'Every sheet to review is ticked off' : 'No changed sheets here') + stillOpen(), 'ok', 6000);
        bump(); return;
      }
      select(nx, areasOf(nx)[0] ?? -1);
      return;
    }
    // before the first change: the previous changed or new sheet, at its last change
    const at = pair ? s.pairs.indexOf(pair) : s.pairs.length;
    const nx = [...list].reverse().find((p) => isStop(p) && s.pairs.indexOf(p) < at);
    if (!nx) { if (idx.length) goArea(idx[0]); return; }
    const a = areasOf(nx);
    select(nx, a[a.length - 1] ?? -1);
  };
  const stepSheet = (d: 1 | -1, changedOnly = false) => {
    const pair = cur(), list = lst();
    const l = changedOnly ? list.filter((p) => p.status === 'changed') : list;
    if (!l.length) return;
    let k = l.findIndex((p) => p.id === ui.selected);
    let n: number;
    if (k >= 0) n = Math.max(0, Math.min(l.length - 1, k + d));
    else {
      // the sheet just left this list (ticked off in "To review"): carry on from where it was
      const at = pair ? s.pairs.indexOf(pair) : -1;
      k = d > 0 ? l.findIndex((p) => s.pairs.indexOf(p) > at) : l.length - 1 - [...l].reverse().findIndex((p) => s.pairs.indexOf(p) < at);
      n = at < 0 || k < 0 || k >= l.length ? (d > 0 ? 0 : l.length - 1) : k;
    }
    select(l[n]);
  };
  /** where N goes after this sheet's last change (the same choice as stepArea's): the next sheet to
   *  stop at, at its first change - made ready ahead by the viewer */
  const nextUp = (p: Pair): NextUp | null => {
    const at = s.pairs.indexOf(p);
    const l = list.filter((q) => q !== p && isStop(q) && !q.reviewed);
    const nx = l.find((q) => s.pairs.indexOf(q) > at) || l[0];
    return nx ? { pair: nx, area: areasOf(nx)[0] ?? -1 } : null;
  };
  /** the next sheet still to review after `from` (in the list as shown, then from its top) */
  const nextToReview = (from: Pair | null): Pair | null => {
    const l = lst().filter((p) => needsReview(p) && !p.reviewed && p !== from);
    const at = from ? s.pairs.indexOf(from) : -1;
    return l.find((p) => s.pairs.indexOf(p) > at) || l[0] || null;
  };
  // the list of sheets on screen, comparing done: the first sheet Enter opens is read in ahead (its
  // first close look then waits for the drawing only - not 2-5 s of reading its pages in)
  const firstUp = !pair && s.phase === 'done' ? nextToReview(null) : null;
  useEffect(() => {
    if (!firstUp || !firstUp.result || !firstUp.old || !firstUp.neu || firstUp.old.bad || firstUp.neu.bad) return;
    const t = setTimeout(() => void warmOpen(firstUp.id, fileArg(firstUp.old!.file), fileArg(firstUp.neu!.file), [firstUp.old!.page ?? 0, firstUp.neu!.page ?? 0], mode !== 'overlay' || flicker), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstUp?.id, firstUp?.result]);
  /** tick a sheet off and go on to the next one to review; ticked already: untick (stay). Not
   *  within a moment of the sheet opening (a key or click pressed twice) */
  const markReviewed = (p: Pair) => {
    if (!needsReview(p) || p.id !== ui.selected || tooSoon()) return;
    p.reviewed = !p.reviewed;
    openedAt = Date.now();
    void remember(s);
    if (!p.reviewed) { bump(); return; }
    const nx = nextToReview(p);
    if (nx) select(nx);
    else { bump(); toast((counts(s.pairs).todo ? 'Every sheet to review in this list is ticked off' : 'Every sheet to review is ticked off') + stillOpen(), 'ok', 6000); }
  };
  /** the review is only finished once every sheet is compared: say so while some are not */
  const stillOpen = () => {
    const n = s.pairs.filter((p) => p.status === 'waiting' || p.status === 'running').length;
    return n ? ` so far - ${n} sheet${n === 1 ? ' is' : 's are'} ${s.phase === 'stopped' ? 'not compared (stopped)' : 'still being compared'}` : '';
  };
  /** another list: the open sheet stays in sight in it */
  const setFilter = (f: UIState['filter']) => {
    ui.filter = f;
    bump();
    setTimeout(() => document.querySelector(`[data-pid="${ui.selected}"]`)?.scrollIntoView({ block: 'nearest' }), 30);
  };
  const startReview = () => {
    const nx = nextToReview(null) || s.pairs.find((p) => needsReview(p) && !p.reviewed) || null;
    if (!nx) { toast('Nothing left to review' + stillOpen(), 'ok', 6000); return; }
    if (!lst().includes(nx)) { ui.filter = 'all'; ui.search = ''; }
    select(nx);
  };
  // flicker swaps old and new in one place: from side by side (or one issue alone) it goes to
  // overlay; another view stops it
  const setMode = (m: Mode) => { setModeRaw(m); if (m !== 'overlay') setFlicker(false); };
  const toggleFlicker = () => { if (!flicker && mode !== 'overlay') setModeRaw('overlay'); setFlicker(!flicker); };

  // keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // typing somewhere, or a dialog is open: not for us (a slider takes its own arrow keys)
      const t = e.target as HTMLElement;
      if (t?.closest('textarea, select, [contenteditable]') || (t?.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes((t as HTMLInputElement).type))) return;
      if (t?.tagName === 'INPUT' && (t as HTMLInputElement).type === 'range' && e.key.startsWith('Arrow')) return;
      if (document.querySelector('.scrim') || e.ctrlKey || e.altKey || e.metaKey) return;
      if (t?.tagName === 'INPUT') t.blur();
      // [ and ] by the key's place as well: on other keyboard layouts they are not those letters
      const k = e.code === 'BracketLeft' ? '[' : e.code === 'BracketRight' ? ']' : e.key.toLowerCase();
      if (k === 'n' || k === 'arrowright') { e.preventDefault(); stepArea(1, e.repeat); }
      else if (k === 'p' || k === 'arrowleft') { e.preventDefault(); stepArea(-1, e.repeat); }
      else if (k === 'j' || k === 'arrowdown') { e.preventDefault(); stepSheet(1, e.shiftKey); }
      else if (k === 'k' || k === 'arrowup') { e.preventDefault(); stepSheet(-1, e.shiftKey); }
      else if (k === 'o') setMode('overlay');
      else if (k === 's') setMode('side');
      else if (k === '1') setMode('old');
      else if (k === '2') setMode('new');
      else if (k === 'f') toggleFlicker();
      else if (k === 'h') toggleHighlight();
      else if (k === '0' || k === 'home') viewCmd('fit');
      else if (k === '+' || k === '=') viewCmd('in');
      else if (k === '-') viewCmd('out');
      else if (k === 'r' && e.shiftKey) {
        // (T8) Shift + R: the change shown, ticked on every sheet it was made on
        const p = cur();
        if (p && !e.repeat) { const gs = textGroups(ui.session?.pairs ?? []); if (ui.area < 0) toast('No change is open - Shift + R ticks the change shown, on every sheet it was made on', 'ok', 3500, undefined, 'ticked'); else { const g = groupOfArea(gs, p, ui.area); if (g) { tickGroup(g); const nx = nextToReview(p); if (nx && p.reviewed) select(nx); } else toast('This change is not on other sheets - R ticks the sheet off', 'ok', 3500, undefined, 'ticked'); } }
      }
      else if (k === 'r') { const p = cur(); if (p && !e.repeat) markReviewed(p); }
      else if (k === '[') togglePanel('drawings', 'left');
      else if (k === ']') togglePanel('drawings', 'right');
      else if (k === '?' || k === 'f1') { e.preventDefault(); ui.keys = true; bump(); }
      else if (k === 'enter' && !cur()) { e.preventDefault(); startReview(); }
      // Escape: off the change (the whole sheet; a zoom of one's own is kept for the next change),
      // then off the sheet (the overview)
      else if (k === 'escape') { if (ui.area >= 0) { ui.area = -1; bump(); viewCmd('whole'); } else if (ui.selected) { ui.selected = null; bump(); } }
      else return;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // a button or list row clicked with the mouse lets go of the keyboard (it kept it: Enter / Space
  // pressed it again - on the next sheet's "Reviewed" button, or the row of the sheet before)
  useEffect(() => {
    const f = (e: MouseEvent) => { if (e.detail > 0) { const b = (e.target as HTMLElement)?.closest?.('button, [role="button"]') as HTMLElement | null; if (b) setTimeout(() => b.blur(), 0); } };
    window.addEventListener('click', f, true);
    return () => window.removeEventListener('click', f, true);
  }, []);

  // a sheet with both issues readable: the ways of comparing them make sense
  const two = !!pair && !!pair.old && !!pair.neu && !pair.old.bad && !pair.neu.bad;
  // (not compared - yet, or it could not be: the two sheets side by side, there is no overlay)
  const shown = two && !pair!.result && mode === 'overlay' ? 'side' : mode;
  // the toolbar measured: too narrow for its words, they go (then the fade slider), not the buttons
  const bar = useRef<HTMLDivElement>(null);
  const pn = usePanels('drawings');
  // the list shown again: it is at the open sheet (the keys went on while it was hidden)
  useEffect(() => { if (st.panels.drawings.left) setTimeout(() => document.querySelector(`[data-pid="${ui.selected}"]`)?.scrollIntoView({ block: 'nearest' }), 30); }, [st.panels.drawings.left]);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const fit = () => {
      // short of room the words go first (stage 1: the optional ones, 2: all); what still does not fit
      // scrolls sideways (HScroll) - no tool is ever hidden (DECISIONS 98)
      let t = 0;
      el.dataset.tight = '0';
      while (t < 2 && el.scrollWidth > el.clientWidth + 1) el.dataset.tight = String(++t);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pair?.id, two, mode, flicker, st.area, c.todo, st.panels.drawings.left, st.panels.drawings.right]);

  const running = s.phase === 'comparing';
  const [, tick] = useState(0);
  useEffect(() => { if (!running) return undefined; const t = setInterval(() => tick((x) => x + 1), 5000); return () => clearInterval(t); }, [running]);
  const total = s.pairs.filter((p) => p.old && p.neu).length;
  const doneN = s.pairs.filter((p) => p.old && p.neu && p.status !== 'waiting' && p.status !== 'running').length;
  // (only sheets really compared: an identical file or a remembered result takes no time)
  const secs = s.pairs.filter((p) => p.secs && p.result && !p.result.fromCache).map((p) => p.secs!);
  const avg = secs.length ? secs.reduce((a, b) => a + b, 0) / secs.length : 0;
  // (sheets are compared several at a time)
  const left = running && avg && secs.length >= 2 ? ((total - doneN) * avg) / Math.max(1, st.engines) : 0;
  // sheets that take long (very heavy drawings): said, with how long so far - the estimate alone
  // would sit at "a minute" for as long as they take
  const now = performance.now();
  const slow = running ? s.pairs.filter((p) => p.status === 'running' && p.since && now - p.since > 90_000) : [];
  const slowFor = slow.length ? Math.max(...slow.map((p) => now - p.since!)) / 1000 : 0;

  return (
    <div className="results pw" style={pn.style} ref={pn.ref}>
      <SidePanel side="left" p={pn.left}>
        <aside className="left">
          <div className="filters">
            {FILTERS.map(([f, label, tip]) => ((c[f] && !QUIET.has(f)) || f === 'all' || f === st.filter) ? (
              <button key={f} className={'fchip ' + (st.filter === f ? 'on ' : '') + 'f-' + f} onClick={() => setFilter(f)} title={tip}>
                {label} <span className="n">{c[f]}</span>
              </button>
            ) : null)}
          </div>
          {s.zones.length > 0 && <div className="zoneline"><Icon n="zone" size={13} /> {s.zones.length} spot{s.zones.length === 1 ? '' : 's'} left out on purpose <button className="linkbtn" onClick={clearZones}>bring back</button></div>}
          <div className="searchrow">
            <div className="search"><Icon n="search" size={15} /><input placeholder="Find a sheet (number or title)" value={st.search} onChange={(e) => { ui.search = e.target.value; bump(true); }} onKeyDown={(e) => {
                if (e.key === 'Escape') { ui.search = ''; bump(); (e.target as HTMLInputElement).blur(); }
                // Enter / down: open the first sheet found, and the keys work on the sheet again
                else if ((e.key === 'Enter' || e.key === 'ArrowDown') && list.length) { e.preventDefault(); (e.target as HTMLInputElement).blur(); select(list.find((p) => p.id === ui.selected) && e.key === 'ArrowDown' ? list[Math.min(list.length - 1, list.findIndex((p) => p.id === ui.selected) + 1)] : list[0]); }
              }} />
              {st.search && <button className="xbtn" title="Clear" onClick={() => { ui.search = ''; bump(); }}><Icon n="x" size={13} /></button>}
            </div>
          </div>
          {pre && <div className="prefix" title="The start every sheet number shares - left out in the list">{pre}…</div>}
          <SheetList list={list} selected={st.selected} pre={pre} onSelect={select} />
          {(running || s.phase === 'reading' || s.phase === 'pairing' || s.phase === 'stopped') && (
            <div className="progress">
              {s.phase === 'reading' || s.phase === 'pairing' ? <div className="ptext"><span className="dot busy" /> {s.note || 'Reading…'}</div> : (
                <>
                  <div className="pbar"><div style={{ width: `${total ? (100 * doneN) / total : 0}%` }} /></div>
                  <div className="ptext">
                    {s.phase === 'stopped' ? 'Stopped' : 'Comparing'} {doneN} of {total}{left && !slow.length ? ` · about ${fmtLeft(left)} left` : ''}{slow.length ? ` · ${slow.length} heavy sheet${slow.length === 1 ? '' : 's'}, ${fmtLeft(slowFor)} so far` : ''}
                    <span className="grow" />
                    {running ? <button className="btn sm ghost" onClick={stop} title="Stop comparing - what is done stays"><Icon n="stop" size={13} /> Stop</button> : <button className="btn sm ghost" onClick={resume}><Icon n="play" size={13} /> Go on</button>}
                  </div>
                </>
              )}
            </div>
          )}
        </aside>
      </SidePanel>
      <main className="center">
        <div className="vtbar">
          {/* the two panel buttons stay put at the ends; what is between them scrolls sideways when it does not fit */}
          <button className={'btn sm icon panelbtn' + (st.panels.drawings.left ? '' : ' on')} onClick={() => togglePanel('drawings', 'left')} title={panelTip('left', st.panels.drawings.left)}><Icon n="panelleft" size={16} /></button>
          <HScroll className="vtoolbar" wrapClass="vtscroll" innerRef={bar}>
          {pair && !two ? (
            <>
              <span className="onlyone">{pair.status === 'new' ? 'New sheet: only in the new issue' : pair.status === 'removed' ? 'Removed sheet: only in the old issue' : pair.old?.bad && pair.neu?.bad ? 'Neither file of this sheet could be read' : 'Only one issue of this sheet could be read'}</span>
              <span className="grow" />
              <div className="seg zoomseg">
                <button title="Zoom out (-)" onClick={() => viewCmd('out')}><Icon n="zoomout" size={15} /></button>
                <button title="Whole sheet (0)" onClick={() => viewCmd('fit')}><Icon n="fit" size={15} /></button>
                <button title="Zoom in (+)" onClick={() => viewCmd('in')}><Icon n="zoomin" size={15} /></button>
              </div>
            </>
          ) : pair ? (
            <>
              <div className="seg modes">
                <button className={shown === 'overlay' ? 'on' : ''} onClick={() => setMode('overlay')} title="Both issues in one picture: removed red, added blue (O)"><Icon n="overlay" size={15} /><span className="lbl"> Overlay</span></button>
                <button className={shown === 'side' ? 'on' : ''} onClick={() => setMode('side')} title="Old and new side by side, moving together (S)"><Icon n="side" size={15} /><span className="lbl"> Side by side</span></button>
                <button className={mode === 'old' ? 'on' : ''} onClick={() => setMode('old')} title="The old issue alone (1)">Old</button>
                <button className={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')} title="The new issue alone (2)">New</button>
              </div>
              <button className={'btn sm flickerbtn' + (flicker ? ' on' : '')} onClick={toggleFlicker} title="Swap old and new over and over in one place: changes jump out (F)"><Icon n="flicker" size={15} /><span className="lbl lbl-opt"> Flicker</span></button>
              <button className={'btn sm hlbtn' + (st.highlight ? ' on' : '')} onClick={toggleHighlight} aria-pressed={st.highlight} title="Fill the change boxes with a faint highlighter colour - easier to spot on a poor screen (H)"><Icon n="highlight" size={15} /><span className="lbl lbl-opt"> Highlight</span></button>
              {mode === 'overlay' && !flicker && (
                <label className="fade" title="Fade what did not change, so the changes stand out (right: fainter)">
                  <span className="lbl lbl-opt">Fade</span>
                  <input type="range" min={0} max={0.9} step={0.05} value={fade} onChange={(e) => setFade(Number(e.target.value))} />
                </label>
              )}
              <span className="grow" />
              <AreaNav pair={pair} onStep={stepArea} />
              <div className="seg zoomseg">
                <button title="Zoom out (-)" onClick={() => viewCmd('out')}><Icon n="zoomout" size={15} /></button>
                <button title="Whole sheet (0)" onClick={() => viewCmd('fit')}><Icon n="fit" size={15} /></button>
                <button title="Zoom in (+)" onClick={() => viewCmd('in')}><Icon n="zoomin" size={15} /></button>
              </div>
            </>
          ) : (
            <>
              <span className="ovtitle">{list.length} sheet{list.length === 1 ? '' : 's'}{st.filter !== 'all' ? ` · ${FILTERS.find((f) => f[0] === st.filter)?.[1]}` : ''}</span>
              <span className="faint ovhint">Click a sheet to open it</span>
              <span className="grow" />
              {c.todo > 0 && <button className="btn sm primary" onClick={startReview} title="Open the first sheet still to review (Enter)">Start review <span className="n">{c.todo}</span></button>}
            </>
          )}
          </HScroll>
          <button className={'btn sm icon panelbtn' + (st.panels.drawings.right ? '' : ' on')} onClick={() => togglePanel('drawings', 'right')} title={panelTip('right', st.panels.drawings.right)}><Icon n="panelright" size={16} /></button>
        </div>
        {pair ? <Viewer pair={pair} mode={mode} fade={fade} flicker={flicker} onMode={setMode} next={nextUp(pair)} /> : <Overview list={list} pre={pre} onSelect={select} />}
        <div className="legend">
          {/* what the colours mean, each with a tooltip, as the BOQ and Documents views have it (DECISIONS 36) */}
          {pair && !two ? <span className="faint">Shown as drawn - there is nothing to compare it with</span> : pair ? (
            <span className="sbs-legend dlegend" aria-label="What the colours mean">
              {mode !== 'overlay' || flicker ? <span className="faint">{mode === 'side' ? 'The two issues side by side, as drawn' : flicker ? 'Old and new in turn, as drawn' : `The ${mode === 'old' ? 'old' : 'new'} issue as drawn`}</span> : <>
                <span className="lg" title="Lines only in the old issue: taken out"><i className="sw old" /> old only (removed)</span>
                <span className="lg" title="Lines only in the new issue: put in"><i className="sw new" /> new only (added)</span>
                <span className="lg" title="Lines in both issues, in the same place"><i className="sw same" /> unchanged</span>
              </>}
              <span className="lg" title="A changed area, numbered: N / P step through them"><i className="sw box" /> change</span>
              {pair.result?.areas.some((a) => a.shift) && <span className="lg" title="A whole view moved on the sheet, drawn dashed with how far it moved; a stretched one is a change"><i className="sw box moved" /> view moved</span>}
              {st.showCommon && <span className="lg" title="Not counted as a change - a title block, an old cloud taken off, a hatch pattern or a spot you left out: shown dashed because you asked for it"><i className="sw box notc" /> not counted</span>}
            </span>
          ) : <span className="faint">Boxes on the pictures: where the sheet changed</span>}
          <span className="grow" />
          <span className="faint keyhint"><kbd>N</kbd> next change · <kbd>P</kbd> back · <kbd>R</kbd> reviewed, next sheet</span>
          <button className="linkbtn keysbtn" onClick={() => { ui.keys = true; bump(); }} title="All keyboard keys (?)"><Icon n="keyboard" size={14} /> Keys</button>
        </div>
      </main>
      <SidePanel side="right" p={pn.right}>
        <aside className="right">
          <SheetPanel pair={pair} onReviewed={markReviewed} onStart={startReview} />
        </aside>
      </SidePanel>
      {st.keys && <KeysDlg onClose={() => { ui.keys = false; bump(); }} />}
    </div>
  );
}

function fmtLeft(s: number): string {
  if (s < 50) return 'a minute';
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** every keyboard key, on one sheet (? or the Keys button) */
function KeysDlg({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === '?' || e.key === 'F1') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  const groups: [string, [string, string][]][] = [
    ['Going through the changes', [['N  or  →', 'next change - after the last one the sheet is ticked off as reviewed (all its changes seen) and the next sheet to review opens. On sheets with bigger changes the tiny ones come last, after one stop (switch: above the list of changes)'], ['P  or  ←', 'previous change'], ['R', 'tick the sheet off now and go on to the next one to review (again: untick)'], ['J / K  or  ↓ / ↑', 'next / previous sheet in the list'], ['Shift+J / Shift+K', 'next / previous changed sheet'], ['Enter', 'start the review (from the overview)'], ['Esc', 'whole sheet; again: back to the overview']]],
    ['Looking', [['O', 'overlay: removed red, added blue'], ['S', 'side by side'], ['1 / 2', 'the old / the new issue alone'], ['F', 'flicker: old and new in turn'], ['H', 'highlight: a faint fill in the change boxes'], ['0', 'whole sheet'], ['+ / -', 'zoom in / out (or the mouse wheel; drag to move)']]],
    ['Room on screen', [['[', 'hide / show the list (or its tab at the edge)'], [']', 'hide / show the details'], ['Drag an edge', 'make the list or the details wider or narrower - double-click it for the normal width'], ['?', 'this list']]],
  ];
  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal keysdlg">
        <h2>Keyboard keys</h2>
        {groups.map(([g, rows]) => (
          <div key={g} className="keysgroup">
            <h4>{g}</h4>
            {rows.map(([k, what]) => <div key={k} className="keyrow"><span className="kk">{k.split('  ').map((x, i) => <kbd key={i}>{x.trim()}</kbd>)}</span><span>{what}</span></div>)}
          </div>
        ))}
        <div className="actions"><span className="grow" /><button className="btn primary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/** the sheets as pictures (no sheet open): where each changed, at a glance */
function Overview({ list, pre, onSelect }: { list: Pair[]; pre: string; onSelect: (p: Pair) => void }) {
  const st = useUI();
  const s = st.session!;
  if (s.phase === 'reading' || s.phase === 'pairing') return <div className="overview empty-list"><div><span className="dot busy" /> {s.note || 'Reading the issues…'}</div></div>;
  if (!list.length) return <div className="overview empty-list">{st.search ? `No sheet matches "${st.search}"` : 'No sheets here'}</div>;
  return (
    <div className="overview">
      {list.map((p) => <Card key={p.id} p={p} pre={pre} onSelect={onSelect} />)}
    </div>
  );
}

function AreaNav({ pair, onStep }: { pair: Pair | null; onStep: (d: 1 | -1) => void }) {
  const st = useUI();
  if (!pair?.result) return null;
  const idx = stepAreas(pair, st.showCommon);
  const n = realAreas(pair).length;
  const lab = st.area >= 0 ? areaLabels(pair)[st.area] : undefined;
  // (only hidden ones shown - title block: their own letters, no count of changes)
  const num = !idx.length ? 'no changes' : !n ? (lab ?? `${idx.length} hidden`) : `${lab ?? '–'} / ${n}`;
  return (
    <div className="areanav">
      <button className="btn sm icon" disabled={!idx.length} onClick={() => onStep(-1)} title="Previous change (P)"><Icon n="prev" size={15} /></button>
      <span className="num">{num}</span>
      <button className="btn sm icon" disabled={!idx.length} onClick={() => onStep(1)} title="Next change (N)"><Icon n="next" size={15} /></button>
    </div>
  );
}

function SheetList({ list, selected, pre, onSelect }: { list: Pair[]; selected: string | null; pre: string; onSelect: (p: Pair) => void }) {
  const st = useUI();
  if (!list.length) return <div className="slist empty-list">{st.session?.phase === 'reading' || st.session?.phase === 'pairing' ? '' : st.search ? `No sheet matches "${st.search}"` : 'No sheets here'}</div>;
  return (
    <div className="slist">
      {list.map((p) => <Row key={p.id} p={p} pre={pre} on={p.id === selected} onSelect={onSelect} />)}
    </div>
  );
}

function Badge({ p }: { p: Pair }) {
  const n = p.result ? realAreas(p).length : 0;
  const s = STATUS[p.status];
  if (onlyTiny(p)) return <span className="chip st-tiny" title="Only very small changes (each under ~1 mm² of ink, no words): line joins, a hair of re-drafting. Worth a quick look.">{n} tiny</span>;
  if (onlyMoves(p)) return <span className="chip st-moved" title="Only something that moved as a whole, nothing in it changed - a view placed elsewhere on the paper, or a building / equipment moved in the drawing. Worth a look.">moved</span>;
  return <span className={'chip ' + s.cls} title={s.tip}>{p.status === 'changed' ? `${n} change${n === 1 ? '' : 's'}` : statusLabel(p)}</span>;
}

function Row({ p, pre, on, onSelect }: { p: Pair; pre: string; on: boolean; onSelect: (p: Pair) => void }) {
  return (
    <button data-pid={p.id} className={'srow' + (on ? ' on' : '') + (p.reviewed ? ' reviewed' : '')} onClick={() => onSelect(p)} title={[p.key, p.old?.rel, p.neu?.rel && '→ ' + p.neu.rel].filter(Boolean).join('\n')}>
      <span className={'sdot ' + (onlyTiny(p) ? 'st-tiny' : onlyMoves(p) ? 'st-moved' : STATUS[p.status].cls)} />
      <span className="sname">
        <span className="skey">{shortKey(p, pre)}</span>
        <span className="stitle">{p.title}</span>
      </span>
      {p.reviewed && <Icon n="check" size={14} className="revd" />}
      <Badge p={p} />
    </button>
  );
}

function Card({ p, pre, onSelect }: { p: Pair; pre: string; onSelect: (p: Pair) => void }) {
  const r = p.result;
  const real = new Set(realAreas(p)); // (p changes in place: no memo)
  // (a sheet in one issue only: its own shape - a portrait sheet isn't squashed into landscape)
  const one = !r ? (p.neu && !p.neu.bad ? p.neu : p.old && !p.old.bad ? p.old : null) : null;
  return (
    <button data-pid={p.id} className={'scard' + (p.reviewed ? ' reviewed' : '')} onClick={() => onSelect(p)} title={p.key + (p.title ? ' - ' + p.title : '')}>
      <div className="thumb" style={r ? { aspectRatio: `${r.thumbSize.w} / ${r.thumbSize.h}` } : one ? { aspectRatio: `${one.w} / ${one.h}` } : undefined}>
        {p.thumbUrl ? <img src={p.thumbUrl} alt="" draggable={false} /> : <div className="thumb-none">{p.status === 'running' ? <><span className="dot busy" />Comparing…</> : statusLabel(p)}</div>}
        {r && p.thumbUrl && (
          <svg viewBox={`0 0 ${r.newSize.w} ${r.newSize.h}`} preserveAspectRatio="none">
            {r.areas.map((a, i) => real.has(i) ? <rect key={i} className={a.shift ? (a.shift.stretched ? 'moved stretched' : 'moved') : undefined} x={a.box[0] - 6} y={a.box[1] - 6} width={a.box[2] - a.box[0] + 12} height={a.box[3] - a.box[1] + 12} rx={6} /> : null)}
          </svg>
        )}
        {p.reviewed && <span className="cardcheck" title="Reviewed"><Icon n="check" size={14} /></span>}
      </div>
      <div className="cmeta"><span className="skey">{shortKey(p, pre)}</span><Badge p={p} /></div>
      <div className="ctitle">{p.title}</div>
    </button>
  );
}

// ---------------------------------------------------------------- right panel

function SheetPanel({ pair, onReviewed, onStart }: { pair: Pair | null; onReviewed: (p: Pair) => void; onStart: () => void }) {
  const st = useUI();
  const s = st.session!;
  const c = counts(s.pairs);
  const [unpairAsk, setUnpairAsk] = useState('');
  // the change being looked at stays in sight in the list
  useEffect(() => { document.querySelector('.clist .citem.on')?.scrollIntoView({ block: 'nearest' }); }, [st.area, pair?.id]);
  if (!pair) {
    const busy = s.phase === 'reading' || s.phase === 'pairing' || s.phase === 'comparing' || s.phase === 'stopped';
    return (
      <div className="panel">
        <h3>Summary{busy ? <span className="faint">{st.session?.phase === 'stopped' ? ' - stopped, not all compared' : ' - still comparing'}</span> : ''}</h3>
        {c.todo > 0 ? (
          <div className="startbox">
            <button className="btn primary" onClick={onStart} title="Open the first sheet still to review (Enter)"><Icon n="play" size={14} /> {c.ticked ? 'Go on with the review' : 'Start review'}</button>
            {c.ticked > 0 && <div className="revcount"><span><b>{c.ticked}</b> of {c.ticked + c.todo} sheets ticked off</span><div className="reviewbar"><div style={{ width: `${(100 * c.ticked) / (c.ticked + c.todo)}%` }} /></div></div>}
            <span>{c.todo} sheet{c.todo === 1 ? '' : 's'} to review{busy ? ' so far' : ''}: changed, new, removed and any that could not be compared. Press <b>N</b> to go from change to change - a sheet whose changes you have all seen is ticked off and the next one opens. <b>R</b> ticks a sheet off at once.</span>
          </div>
        ) : c.done > 0 && !c.pending ? <div className="infobox"><Icon n="check" size={15} /> {c.ticked ? `Every sheet to review is ticked off (${c.ticked}).` : 'Nothing to review: no sheet changed, came or went, and every file could be read.'}</div> : null}
        {s.phase === 'stopped' && s.note?.startsWith('Stopped:') && <div className="warnbox"><Icon n="info" size={15} /> {s.note}</div>}
        {c.pending > 0 && s.phase === 'stopped' && <div className="warnbox"><Icon n="info" size={15} /> Stopped: {c.pending} sheet{c.pending === 1 ? ' is' : 's are'} not compared yet ("Go on", bottom left). Nothing about {c.pending === 1 ? 'it' : 'them'} is known.</div>}
        <SummaryTable c={c} />
        <ExportBox />
      </div>
    );
  }
  const r = pair.result;
  const real = r ? realAreas(pair) : [];
  const common = r ? r.areas.map((_, i) => i).filter((i) => !real.includes(i)) : [];
  const labels = areaLabels(pair);
  const groups = textGroups(s.pairs);
  const tinyN = real.filter((i) => isTiny(pair, i)).length;
  const skipped = new Set(tinyFrom(pair) > 0 ? real.filter((i) => isTiny(pair, i)) : []);
  return (
    <div className="panel">
      <button className="linkbtn back" onClick={() => { ui.selected = null; ui.area = -1; bump(); }} title="All sheets, counts and exports (Esc, Esc)"><Icon n="prev" size={13} /> All sheets</button>
      <div className="ptop">
        <div className="pkey">{pair.key}</div>
        <div className="ptitle2">{pair.title}</div>
        <div className="pstatus"><span className={'chip big ' + (onlyTiny(pair) ? 'st-tiny' : onlyMoves(pair) ? 'st-moved' : STATUS[pair.status].cls)}>{statusLabel(pair)}</span>
          {needsReview(pair) && (pair.reviewed
            ? <button className="btn sm on" onClick={() => onReviewed(pair)} title="Ticked off - click (or R) to untick"><Icon n="check" size={14} /> Reviewed</button>
            : <button className="btn sm reviewbtn" onClick={() => onReviewed(pair)} title="Tick this sheet off and open the next one to review (R)"><Icon n="check" size={14} /> Reviewed - next <kbd>R</kbd></button>)}
        </div>
        {pair.status !== 'changed' || onlyTiny(pair) ? <div className="pnote">{onlyTiny(pair) ? 'Only very small changes - each under about 1 mm² of ink, no words changed (line joins, a hair of re-drafting). Worth a quick look.' : pair.status === 'error' ? 'This pair could not be compared - see below.' + (pair.old && pair.neu && !pair.old.bad && !pair.neu.bad && !pair.result ? ' Both sheets are shown side by side.' : '') : STATUS[pair.status].tip}</div> : onlyMoves(pair) ? <div className="pnote">Only {r!.parts && r!.parts.filter((q) => !q.stretched).length > 1 ? 'parts' : 'a part'} of the sheet moved, as a whole - nothing in {r!.parts && r!.parts.filter((q) => !q.stretched).length > 1 ? 'them' : 'it'} changed. Usually a view placed elsewhere on the paper; but a building or a piece of equipment moved in the drawing looks just the same - check which.</div> : null}
      </div>
      <div className="files">
        {pair.old && pair.neu && base(pair.old.rel) === base(pair.neu.rel) && pair.old.pages === pair.neu.pages && pair.old.page === pair.neu.page
          ? <FileLine label="File" f={pair.neu} both={pair.old} one />
          : <><FileLine label="Old" f={pair.old} /><FileLine label="New" f={pair.neu} /></>}
        {pair.old && pair.neu && <div className="faint pairedby">Paired by {({ name: 'file name', number: 'drawing number', sheet: 'the number on the sheet', content: 'what the sheets say', order: 'page order', hand: 'hand', none: '' })[pair.how]}{pair.score ? ` (${Math.round(pair.score * 100)}% alike)` : ''}
          {' · '}<button className="linkbtn" onClick={() => { if (unpairAsk === pair.id) { setUnpairAsk(''); unpair(pair); } else { setUnpairAsk(pair.id); setTimeout(() => setUnpairAsk(''), 4000); } }} title="Not the same sheet? Split into a removed and a new sheet; then pair each by hand">{unpairAsk === pair.id ? 'click again to unpair' : 'unpair'}</button></div>}
      </div>
      {(!pair.old || !pair.neu) && <PairWith pair={pair} />}
      {pair.error && <div className="errbox">{pair.error}<div><button className="btn sm" onClick={() => rerun(pair)}><Icon n="refresh" size={14} /> Try again</button></div></div>}
      {r && (
        <>
          {r.alignInfo.moved && (fmtMove(r.align, r.oldSize, r.newSize) !== 'slightly' || r.alignInfo.scale !== 1 || !!r.alignInfo.turned) && <div className="infobox"><Icon n="info" size={15} /> The old sheet was moved {fmtMove(r.align, r.oldSize, r.newSize)} to line up with the new one{r.alignInfo.scale !== 1 ? `, and scaled ${(r.alignInfo.scale * 100).toFixed(1)}%` : ''}{r.alignInfo.turned ? ', and turned' : ''}.</div>}
          {(r.parts ?? []).map((p, k) => (
            <div key={'part' + k} className="infobox partnote"><Icon n="info" size={15} /> {p.stretched ? <span>{cap(partName(p.inkBox ?? p.box, r.newSize, true))} moved {moveWords(p.dx, p.dy)} (dashed outline) and the lines running into it got {p.shorter ? 'shorter: the drawing itself was shortened there (a floor made lower, a bay made narrower)' : 'longer: the drawing itself was stretched there (a floor made taller, a bay made wider)'}. That part was lined up on its own, so its other changes are found where it is now. <button className="linkbtn" onClick={() => viewBox(p.inkBox ?? p.box)}>show</button></span> : <span>{cap(partName(p.inkBox ?? p.box, r.newSize))} moved {moveWords(p.dx, p.dy)} on the sheet, as a whole (dashed outline){(r.parts!.length === 1 && partName(p.inkBox ?? p.box, r.newSize) === 'the drawing') ? ' - the border and title block stayed' : ''}. It was lined up on its own, so its changes are found where it is now. <button className="linkbtn" onClick={() => viewBox(p.inkBox ?? p.box)}>show</button></span>}</div>
          ))}
          {r.oldInkPx < 50 && <div className="warnbox"><Icon n="info" size={15} /> The old sheet is blank (nothing drawn on it).</div>}
          {r.inkPx < 50 && <div className="warnbox"><Icon n="info" size={15} /> The new sheet is blank (nothing drawn on it).</div>}
          {r.scanMix && <div className="warnbox"><Icon n="info" size={15} /> One issue of this sheet is a scan, the other is not: their lines never match exactly, so expect many small differences. Compare by eye (side by side).</div>}
          {r.scan && <div className="infobox"><Icon n="info" size={15} /> Scanned sheets: checked with a wider tolerance (paper grain and skew). Very small edits, like one digit in small text, may not show.</div>}
          {r.alignInfo.fit < 0.5 && real.length > 20 && r.oldInkPx >= 50 && r.inkPx >= 50 && <div className="warnbox"><Icon n="info" size={15} /> Most of the sheet differs. It was redrawn or re-plotted, or it is a different drawing.</div>}
          <div className="chead">
            <h3>{onlyMoves(pair) ? `${real.length} part${real.length === 1 ? '' : 's'} moved` : real.length ? `${real.length} change${real.length === 1 ? '' : 's'}` : 'No changes in the drawing'}</h3>
            {common.length > 0 && <button className="linkbtn" onClick={() => { ui.showCommon = !ui.showCommon; bump(); }} title="Changes that don't count as drawing changes (on every sheet)">{st.showCommon ? `Hide the ${common.length}` : `Show ${common.length} hidden`} ({skipWords(pair, common)})</button>}
          </div>
          {tinyN > 0 && tinyN < real.length && (
            <label className="skiptiny" title="On sheets with bigger changes, N goes through the tiny ones (each under about 1 mm² of ink, no words) last, after one stop that says so - R ticks the sheet off without them. Off: in sheet order.">
              <input type="checkbox" checked={st.skipTiny} onChange={(e) => { ui.skipTiny = e.target.checked; void rr.setSettings({ skipTiny: ui.skipTiny }); bump(true); }} />
              N shows the {tinyN} tiny one{tinyN === 1 ? '' : 's'} last
            </label>
          )}
          <div className="clist">
            {(st.showCommon ? r.areas.map((_, i) => i) : real).map((i) => {
              const a = r.areas[i];
              const isReal = real.includes(i);
              return (
                <div key={i} className={'citem' + (st.area === i ? ' on' : '') + (isReal ? '' : ' dim') + (skipped.has(i) ? ' skipped' : '')} role="button" tabIndex={0} onClick={() => { ui.area = i; bump(); viewCmd('area'); }}>
                  <span className="cnum">{labels[i]}</span>
                  <span className="cbody">
                    <span className="ckind">{a.shift ? <>{moveTitle(a.shift)}<span className="faint">{a.shift.stretched ? ` · part of the drawing, outlined - the lines running into it got ${a.shift.shorter ? 'shorter' : 'longer'}; what changed in it is listed on its own` : ' · as a whole, outlined: a view placed elsewhere, or something moved in the drawing - what changed in it is listed on its own'}</span></> : a.seam ? <>{seamTitle(a.seam)}<span className="faint"> · where the part above moved on - the walls / lines running across were drawn {a.seam.shorter ? 'shorter' : 'longer'}</span></> : a.cloud === 'removed' ? 'Old revision cloud taken off' : a.cloud === 'added' ? 'Revision cloud added - nothing changed inside it' : a.pattern && !isReal && areaSkip(pair, i) === 'pattern' ? 'Dashes / hatch redrawn - the line didn\'t move' : kindOf(a)}{!isReal && a.cloud !== 'removed' && areaSkip(pair, i) !== 'pattern' ? ' · ' + areaSkip(pair, i) : ''}{a.shift ? null : <span className="faint"> · {sizeOf(a.box)}{isReal && isTiny(pair, i) ? ' · tiny' : ''}</span>}</span>
                    <TextLines t={a.text} />
                    {(() => { const g = groupOfArea(groups, pair, i); return g ? <span className="sbs-same" onClick={(e) => e.stopPropagation()}><span className="faint">Same change on {g.sheets.length - 1} other {g.sheets.length === 2 ? 'sheet' : 'sheets'}</span><button className="btn sm" onClick={(e) => { e.stopPropagation(); tickGroup(g); }} title="Count this change as seen on every sheet it was made on - a sheet with nothing else left is ticked off (Shift + R)"><Icon n="check" size={14} /> Tick all {g.sheets.length}</button></span> : null; })()}
                    {areaSkip(pair, i) === 'left out' && <button className="linkbtn" onClick={(e) => { e.stopPropagation(); removeZones(zonesOver(pair, i)); }}>bring this spot back</button>}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="pfoot">
            <button className="btn sm" onClick={() => exportPdf('one', pair)}><Icon n="pdf" size={14} /> This sheet as clouded PDF</button>
            <button className="btn sm ghost" onClick={() => rerun(pair, true)} title="Compare this pair again from scratch"><Icon n="refresh" size={14} /> Again</button>
          </div>
          <div className="faint tiny">{r.fromCache ? 'From the last time this pair was compared' : `Compared in ${((pair.secs || 0)).toFixed(1)} s`} · checked at {Math.round(r.scale * 72)} dpi</div>
        </>
      )}
    </div>
  );
}


/** a new sheet paired by hand with a removed one (renumbered drawings), or the other way */
function PairWith({ pair }: { pair: Pair }) {
  const st = useUI();
  const others = st.session!.pairs.filter((p) => (pair.old ? !p.old && p.neu : p.old && !p.neu));
  if (!others.length) return null;
  return (
    <div className="pairwith">
      <label>{pair.old ? 'Removed? Or renumbered - pair it with a new sheet:' : 'New? Or renumbered - pair it with an old sheet:'}</label>
      <select className="input" value="" onChange={(e) => { const o = others.find((p) => p.id === e.target.value); if (o) pairByHand(pair, o); }}>
        <option value="">Choose…</option>
        {others.map((p) => <option key={p.id} value={p.id}>{p.key}{p.title ? ' - ' + p.title : ''}</option>)}
      </select>
    </div>
  );
}

/** the texts of a change: the first five, "+6 more" opens the rest (and "fewer" closes them) */
function TextLines({ t }: { t: TextChange[] }) {
  const [all, setAll] = useState(false);
  if (!t.length) return null;
  const shown = all ? t : t.slice(0, 5);
  const flip = (e: React.MouseEvent | React.KeyboardEvent) => { e.stopPropagation(); setAll((v) => !v); };
  return (
    <span className="ctext">
      {shown.map((x, i) => (
        <span key={i} className="tline">
          {x.kind === 'changed' ? <><s>{x.from}</s> → <b>{x.to}</b></> : x.kind === 'added' ? <><i className="plus">+</i><b>{x.to}</b></> : <><i className="minus">−</i><s>{x.from}</s></>}
        </span>
      ))}
      {t.length > 5 && (
        <span className="tmore" role="button" tabIndex={0} title={all ? 'Show the first five only' : `Show all ${t.length}`}
          onClick={flip} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') flip(e); }}>
          {all ? 'Show fewer' : `+${t.length - 5} more`}
        </span>
      )}
    </span>
  );
}

const base = (rel: string) => rel.split(/[\\/]/).pop()!.toLowerCase();
function FileLine({ label, f, both, one }: { label: string; f: Pair['old']; both?: Pair['old']; one?: boolean }) {
  const name = f ? f.rel + (f.pages > 1 ? ` · page ${f.page + 1}` : '') : '';
  return (
    <div className="fline" title={both ? `old: ${both.file}\nnew: ${f?.file}` : f?.file || ''}>
      <span className="flabel">{label}</span>
      <span className={'fname' + (one ? ' one' : '')}>{f ? (one ? midFit(name, 206) : breakable(name)) : <span className="faint">{label === 'Old' ? 'not in the old issue' : 'not in the new issue'}</span>}</span>
    </div>
  );
}

/** a long name cut in the middle to fit `px` (its start and its end tell files apart) */
let measure: CanvasRenderingContext2D | null = null;
function midFit(s: string, px: number) {
  if (!measure) { measure = document.createElement('canvas').getContext('2d'); if (measure) measure.font = `12px ${getComputedStyle(document.body).getPropertyValue('--font-ui') || 'sans-serif'}`; }
  const w = (t: string) => measure?.measureText(t).width ?? t.length * 7;
  if (w(s) <= px) return s;
  let n = s.length;
  const cut = (k: number) => { const a = Math.ceil(k * 0.55); return s.slice(0, a) + '…' + s.slice(s.length - (k - a)); };
  while (n > 8 && w(cut(n)) > px) n--;
  return cut(n);
}

/** a long file name that wraps after its separators, not in the middle of a word */
function breakable(s: string) {
  const parts = s.split(/(?<=[-_\\/.])/);
  return parts.map((x, i) => <span key={i}>{x}{i < parts.length - 1 && <wbr />}</span>);
}

function SummaryTable({ c }: { c: Record<string, number> }) {
  const rows: [string, string, number][] = [['st-changed', 'Changed', c.changed], ...(c.tiny ? [['st-tiny', '…of which tiny changes only', c.tiny] as [string, string, number]] : []), ...(c.moved ? [['st-moved', '…of which moved only', c.moved] as [string, string, number]] : []), ['st-title', 'Title block only', c.titleonly], ['st-same', 'No change', c.same], ['st-new', 'New sheets', c.new], ['st-removed', 'Removed sheets', c.removed], ['st-err', 'Could not compare', c.error]];
  return (
    <div className="sumtable">
      {rows.filter((r) => r[2] || r[0] !== 'st-err').map(([cls, label, n]) => (
        <button key={label} className="sumrow" onClick={() => { ui.filter = ({ 'st-changed': 'changed', 'st-tiny': 'tiny', 'st-moved': 'moved', 'st-title': 'titleonly', 'st-same': 'same', 'st-new': 'new', 'st-removed': 'removed', 'st-err': 'error' } as Record<string, UIState['filter']>)[cls]; bump(); }}>
          <span className={'sdot ' + cls} /> <span className="grow">{label}</span> <b className="num">{n}</b>
        </button>
      ))}
    </div>
  );
}

function ExportBox() {
  return (
    <div className="exportbox">
      <h3>Export</h3>
      <button className="btn" onClick={() => exportPdf('changed')}><Icon n="pdf" size={15} /> Changed sheets, clouded (PDF)</button>
      <button className="btn" onClick={() => exportExcel()}><Icon n="sheet" size={15} /> Sheet list with changes (Excel)</button>
      <p className="hint">The PDF has the new sheets with every change clouded and numbered (PDF markups you can edit or delete), behind a summary page.</p>
    </div>
  );
}

function sizeOf(b: number[]) {
  const w = ((b[2] - b[0]) * 25.4) / 72, h = ((b[3] - b[1]) * 25.4) / 72;
  return `${w < 10 ? w.toFixed(1) : Math.round(w)} × ${h < 10 ? h.toFixed(1) : Math.round(h)} mm`;
}
/** how far the old sheet was moved: where its middle went against the new sheet's middle (with a
 *  turn or a scale the mapping's own offset is mostly the turn - a quarter turn read "594 mm") */
function fmtMove(t: number[], from?: { w: number; h: number }, to?: { w: number; h: number }) {
  const cx = from ? from.w / 2 : 0, cy = from ? from.h / 2 : 0;
  const mx = t[0] * cx + t[2] * cy + t[4] - (to ? to.w / 2 : 0), my = t[1] * cx + t[3] * cy + t[5] - (to ? to.h / 2 : 0);
  const dx = (mx * 25.4) / 72, dy = (my * 25.4) / 72;
  const parts: string[] = [];
  if (Math.abs(dx) >= 0.1) parts.push(`${Math.abs(dx).toFixed(1)} mm ${dx > 0 ? 'right' : 'left'}`);
  if (Math.abs(dy) >= 0.1) parts.push(`${Math.abs(dy).toFixed(1)} mm ${dy > 0 ? 'down' : 'up'}`);
  return parts.join(' and ') || 'slightly';
}

export { describe };

/** "title block / old clouds / left-out" - what the hidden areas of a sheet are */
function skipWords(p: Pair, idx: number[]): string {
  const kinds = new Set(idx.map((i) => areaSkip(p, i)));
  const words = [kinds.has('title block') && 'title block', kinds.has('old cloud') && 'old cloud', kinds.has('pattern') && 'dash pattern', kinds.has('left out') && 'left-out'].filter(Boolean) as string[];
  return words.join(' / ') || 'hidden';
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
