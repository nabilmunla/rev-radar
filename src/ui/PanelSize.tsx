// Side panels whose width the person sets - and turns off and on (DECISIONS 97). Drag the panel's inner edge,
// double-click it for the normal width; a hidden panel leaves a narrow rail with a tab that brings it back.
// Widths are remembered per tab and side in localStorage (rr.pw.<tab>.<side>), the hidden state in the settings.
//
// usePanelWidth and PanelEdge are near-copies of the Estimation app's (est/src/ui/PanelSize.tsx, `.pw-edge` in
// its styles.css). The changes: the key is rr.pw.<key>; a remembered width is only held to the minimum (the
// most depends on the window: panelLayout, panels.ts, gives what is shown, so a window made smaller keeps the
// width set); the edge is told how far it may go (`max`, from the layout rule) instead of measuring its
// neighbours. PanelTab, SidePanel and usePanels are new: the three tabs share them.
// T27: useSplit and SplitEdge - the line between the old and the new pane of BOQ and Documents' side by side,
// kept the same way (rr.pw.<tab>.split, in % of the two panes).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { ui, bump, useUI } from './model';
import { rr } from './api';
import { Icon } from './icons';
import { panelLayout, normalWidth, maxWidth, dragMax, SPEC, RAIL, type Side, type Tab } from './panels';

const KEY = 'rr.pw.';
const read = (key: string): number | null => {
  try {
    const v = Number(localStorage.getItem(KEY + key));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
};

/**
 * width of a panel: [width, set width (null = the normal one), a width was set]. `def` may change (a narrower
 * normal width on a small window): a panel never set follows it; one set keeps its width.
 */
export function usePanelWidth(key: string, def: number, min: number, max: number): [number, (w: number | null) => void, boolean] {
  const [w, setW] = useState<number | null>(() => read(key));
  const set = useCallback((v: number | null) => {
    const x = v === null ? null : Math.round(Math.max(min, Math.min(max, v)));
    setW(x);
    try { if (x === null) localStorage.removeItem(KEY + key); else localStorage.setItem(KEY + key, String(x)); } catch { /* this visit only */ }
  }, [key, min, max]);
  return [w === null ? def : Math.max(min, w), set, w !== null];
}

/**
 * The handle on a panel's edge. side = which edge of the PANEL it sits on: a left panel is
 * dragged at its right edge ('right'), a right panel at its left edge ('left').
 */
export function PanelEdge({ side, width, onWidth, max, onStart, title, style }: {
  side: 'left' | 'right';
  width: number;
  onWidth: (w: number | null) => void;
  /** the most the panel may be dragged to (the middle keeps its room: panels.ts dragMax) */
  max: number;
  /** a drag begins (the other panel keeps the width it shows) */
  onStart?: () => void;
  title?: string;
  style?: CSSProperties;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [active, setActive] = useState(false);
  useEffect(() => () => { document.body.classList.remove('pw-dragging'); }, []);
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // start from the width on the screen (a small window may show the panel narrower than set)
    const wrap = (e.currentTarget as HTMLElement).parentElement;
    drag.current = { x: e.clientX, w: wrap ? wrap.getBoundingClientRect().width || width : width };
    onStart?.();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setActive(true);
    document.body.classList.add('pw-dragging');
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!(e.buttons & 1)) { up(); return; } // the button came up somewhere else (Alt+Tab)
    const dx = e.clientX - d.x;
    onWidth(Math.min(max, side === 'right' ? d.w + dx : d.w - dx));
  };
  const up = () => {
    drag.current = null;
    setActive(false);
    document.body.classList.remove('pw-dragging');
  };
  return (
    <div
      className={'pw-edge ' + side + (active ? ' on' : '')}
      style={style}
      title={title ?? 'Drag to make this panel wider or narrower - double-click for the normal width'}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onDoubleClick={() => onWidth(null)}
      role="separator"
      aria-orientation="vertical"
      data-pw-edge={side}
    />
  );
}

/** the old | new split of the side view (T27, DECISIONS 99): the old pane's share of the two, 30-70 %, 50 = equal */
export const SPLIT = { def: 50, min: 30, max: 70 };
const clampSplit = (v: number) => Math.round(Math.max(SPLIT.min, Math.min(SPLIT.max, v)) * 10) / 10;
/** [the split in %, set it (null = equal halves)] - remembered per tab (rr.pw.<tab>.split); a tenth of a percent is kept, so a drag is smooth */
export function useSplit(tab: 'boq' | 'docs'): [number, (v: number | null) => void] {
  const key = tab + '.split';
  const [v, setV] = useState<number | null>(() => { const x = read(key); return x === null ? null : clampSplit(x); });
  const set = useCallback((x: number | null) => {
    const n = x === null ? null : clampSplit(x);
    setV(n);
    try { if (n === null) localStorage.removeItem(KEY + key); else localStorage.setItem(KEY + key, String(n)); } catch { /* this visit only */ }
  }, [key]);
  return [v ?? SPLIT.def, set];
}

/**
 * The line between the old and the new pane: sits at `pct` % of the element it is in (the two panes), dragged
 * like a panel's edge (pointer capture, the same look), double-click for equal halves.
 */
export function SplitEdge({ pct, onPct, title }: { pct: number; onPct: (p: number | null) => void; title?: string }) {
  // (dx: where on the line it was taken, so the line does not jump to the pointer)
  const drag = useRef<{ dx: number } | null>(null);
  const [active, setActive] = useState(false);
  useEffect(() => () => { document.body.classList.remove('pw-dragging'); }, []);
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect();
    if (!r || !r.width) return;
    drag.current = { dx: e.clientX - (r.left + (r.width * pct) / 100) };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setActive(true);
    document.body.classList.add('pw-dragging');
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!(e.buttons & 1)) { up(); return; } // the button came up somewhere else (Alt+Tab)
    const r = (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect();
    if (r && r.width) onPct(((e.clientX - d.dx - r.left) / r.width) * 100);
  };
  const up = () => {
    drag.current = null;
    setActive(false);
    document.body.classList.remove('pw-dragging');
  };
  return (
    <div
      className={'pw-edge mid' + (active ? ' on' : '')}
      style={{ left: `calc(${pct}% - 3px)` }}
      title={title ?? 'Drag to give the old or the new issue more room - double-click for equal halves'}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onDoubleClick={() => onPct(null)}
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={SPLIT.min}
      aria-valuemax={SPLIT.max}
      aria-valuenow={Math.round(pct)}
      data-pw-edge="split"
    />
  );
}

/** what a panel is called in the tooltips ("Hide the list ( [ )") */
const NAME: Record<Side, string> = { left: 'the list', right: 'the details' };
const KEYCAP: Record<Side, string> = { left: '[', right: ']' };
export const panelTip = (side: Side, shown: boolean) => `${shown ? 'Hide' : 'Show'} ${NAME[side]} ( ${KEYCAP[side]} )`;

/** the tab on a panel's inner edge (and on the rail of a hidden one): a chevron that hides or brings back the panel */
export function PanelTab({ side, shown, onClick }: { side: Side; shown: boolean; onClick: () => void }) {
  // the arrow points where the panel goes (hide) or comes from (show)
  const toLeft = (side === 'left') === shown;
  return (
    <button className={'pw-tab ' + side + (shown ? ' open' : ' rail-tab')} data-pw-tab={side} data-shown={shown} title={panelTip(side, shown)} aria-label={panelTip(side, shown)} onClick={onClick}>
      <Icon n={toLeft ? 'chevl' : 'chevr'} size={14} sw={2} />
    </button>
  );
}

export interface PanelSide {
  shown: boolean;
  /** the width of its column: the panel, or the rail when hidden, or 0 when the view has none */
  width: number;
  /** the width set (null = the normal one) */
  set: (w: number | null) => void;
  max: number;
  /** a drag begins: the other panel keeps the width it shows now */
  pin: () => void;
  toggle: () => void;
}

/** show or hide a side panel of a tab (remembered) */
export function togglePanel(tab: Tab, side: Side) {
  ui.panels = { ...ui.panels, [tab]: { ...ui.panels[tab], [side]: !ui.panels[tab][side] } };
  void rr.setSettings({ panels: ui.panels });
  bump();
}

/** the width of the element the panels sit in (the results area is a little narrower than the window: its frame) */
const useWidthOf = (ref: RefObject<HTMLElement>) => {
  const [w, setW] = useState(() => window.innerWidth - 16);
  const seen = useRef<{ el: HTMLElement | null; ro: ResizeObserver | null }>({ el: null, ro: null });
  // (every render: BOQ / Documents mount the element only once the comparison is done - watch whichever is there now)
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === seen.current.el) return;
    seen.current.ro?.disconnect();
    seen.current = { el, ro: null };
    if (!el) return;
    const f = () => setW((o) => { const n = el.clientWidth || window.innerWidth - 16; return o === n ? o : n; });
    f();
    const ro = new ResizeObserver(f);
    ro.observe(el);
    seen.current.ro = ro;
  });
  useEffect(() => () => { seen.current.ro?.disconnect(); seen.current = { el: null, ro: null }; }, []);
  return w;
};

/**
 * One tab's two side panels: the widths shown (panelLayout), the hide / show state, the `--lw` / `--rw` of the
 * `.results.pw` grid (put `ref` on that element: the room is measured there). `absent`: a panel this view does not have (BOQ and Documents' side-by-side: no details).
 */
export function usePanels(tab: Tab, absent: { left?: boolean; right?: boolean } = {}): { ref: RefObject<HTMLDivElement>; style: CSSProperties; left: PanelSide; right: PanelSide; win: number } {
  const st = useUI();
  const ref = useRef<HTMLDivElement>(null);
  const win = useWidthOf(ref);
  const nw = (side: Side) => normalWidth(side, window.innerWidth);
  const [lw, setL] = usePanelWidth(tab + '.left', nw('left'), SPEC.left.min, maxWidth('left', win));
  const [rw, setR] = usePanelWidth(tab + '.right', nw('right'), SPEC.right.min, maxWidth('right', win));
  const shown = st.panels[tab];
  const lay = panelLayout(win, { left: lw, right: rw }, { left: !shown.left, right: !shown.right }, absent);
  const mk = (side: Side, set: (w: number | null) => void, other: Side, setOther: (w: number | null) => void, otherSet: number): PanelSide => ({
    shown: shown[side],
    width: lay[side],
    set,
    max: dragMax(side, win, lay[other]),
    // the panel not being dragged keeps what the screen shows (a window too small for its width set would
    // otherwise give it back the moment this one shrinks)
    pin: () => { if (shown[other] && !absent[other] && lay[other] < otherSet) setOther(lay[other]); },
    toggle: () => togglePanel(tab, side),
  });
  return {
    ref,
    style: { ['--lw' as string]: lay.left + 'px', ['--rw' as string]: lay.right + 'px' } as CSSProperties,
    left: mk('left', setL, 'right', setR, rw),
    right: mk('right', setR, 'left', setL, lw),
    win,
  };
}

/**
 * One side panel's place in the `.results.pw` grid: the panel with its edge and its tab, or - hidden - the rail
 * with the tab that brings it back. `children` is the panel's own <aside>.
 */
export function SidePanel({ side, p, children }: { side: Side; p: PanelSide; children: ReactNode }) {
  if (!p.shown) {
    return (
      <div className={'rail ' + side} data-rail={side} style={{ width: RAIL }}>
        <PanelTab side={side} shown={false} onClick={p.toggle} />
      </div>
    );
  }
  return (
    <div className={'pw-wrap ' + side} data-panel={side}>
      {children}
      <PanelEdge side={side === 'left' ? 'right' : 'left'} width={p.width} onWidth={p.set} max={p.max} onStart={p.pin} />
      <PanelTab side={side} shown onClick={p.toggle} />
    </div>
  );
}
