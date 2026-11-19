// The side panels' room rule (DECISIONS 97), pure: no React, no window - the tests call it directly.
// The three tabs (Drawings, BOQ, Documents) each have a list on the left and details on the right;
// the person sets each width (remembered per tab and side) and can hide either one.
export type Side = 'left' | 'right';
export type Tab = 'drawings' | 'boq' | 'docs';
export const TABS: Tab[] = ['drawings', 'boq', 'docs'];

/** a hidden panel leaves this much at the window's edge: the rail with the tab that brings it back */
export const RAIL = 14;
/** the middle (the drawing, the grid) keeps at least this much room while a panel is dragged */
export const KEEP = 480;
/** a panel is never wider than this share of the window */
export const MAX_SHARE = 0.45;
/** a window up to this wide gets the narrower normal widths (as the style sheet always did) */
export const SMALL_WINDOW = 1500;
/** normal width (big window / small window) and the narrowest, per side */
export const SPEC: Record<Side, { def: number; small: number; min: number }> = {
  left: { def: 320, small: 286, min: 220 },
  right: { def: 320, small: 300, min: 240 },
};

export const normalWidth = (side: Side, win: number): number => (win <= SMALL_WINDOW ? SPEC[side].small : SPEC[side].def);
export const maxWidth = (side: Side, win: number): number => Math.max(SPEC[side].min, Math.floor(win * MAX_SHARE));
export const clampWidth = (side: Side, win: number, w: number): number => Math.round(Math.max(SPEC[side].min, Math.min(maxWidth(side, win), w)));

export interface Layout {
  /** the width of each column: the panel as shown; the rail when it is hidden; 0 when the tab has no such panel */
  left: number;
  right: number;
  /** what is left for the middle */
  mid: number;
}

/**
 * The widths shown. `set` = the widths the person chose (kept as they are - a window made smaller only
 * shows less of them, and they come back with the room), `hidden` = the panels turned off (a rail each),
 * `absent` = no such panel in this view at all (no rail either).
 * The middle keeps KEEP px: when the window cannot give it that, the WIDER panel gives way first, down to
 * the other's width, then both together - never under a panel's own minimum.
 */
export function panelLayout(
  win: number,
  set: { left: number; right: number },
  hidden: { left: boolean; right: boolean } = { left: false, right: false },
  absent: { left?: boolean; right?: boolean } = {},
): Layout {
  const rail = (s: Side) => (absent[s] ? 0 : hidden[s] ? RAIL : -1);
  const ps = (['left', 'right'] as Side[]).filter((s) => rail(s) < 0).map((s) => ({ s, w: clampWidth(s, win, set[s]), min: SPEC[s].min }));
  const fixed = (['left', 'right'] as Side[]).reduce((n, s) => n + Math.max(0, rail(s)), 0);
  let excess = ps.reduce((n, p) => n + p.w, 0) + fixed + KEEP - win;
  for (let i = 0; i < 6 && excess > 0.01; i++) {
    const act = ps.filter((p) => p.w > p.min + 1e-9);
    if (!act.length) break;
    const top = Math.max(...act.map((p) => p.w));
    const tops = act.filter((p) => p.w >= top - 1e-9);
    const floor = Math.max(...ps.filter((p) => p.w < top - 1e-9).map((p) => p.w), ...tops.map((p) => p.min));
    const cut = Math.min(excess / tops.length, top - floor);
    for (const p of tops) p.w -= cut;
    excess -= cut * tops.length;
  }
  const out = { left: Math.max(0, rail('left')), right: Math.max(0, rail('right')) };
  for (const p of ps) out[p.s] = Math.floor(p.w + 1e-6);
  return { ...out, mid: win - out.left - out.right };
}

/** the most a panel can be dragged to: its share of the window, and the middle keeps KEEP beside the other column as it is shown */
export function dragMax(side: Side, win: number, other: number): number {
  return Math.max(SPEC[side].min, Math.min(maxWidth(side, win), win - KEEP - other));
}

export type Shown = Record<Tab, { left: boolean; right: boolean }>;
export const allShown = (): Shown => ({ drawings: { left: true, right: true }, boq: { left: true, right: true }, docs: { left: true, right: true } });

/**
 * The settings' `panels`, whatever shape it has: `{ drawings, boq, docs: { left, right } }`, or the old
 * `{ left, right }` (one for all tabs: read as all three). Anything else: everything shown.
 */
export function readPanels(raw: unknown): Shown {
  const out = allShown();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const pair = (v: unknown) => (v && typeof v === 'object' ? { left: (v as Record<string, unknown>).left !== false, right: (v as Record<string, unknown>).right !== false } : null);
  if ('left' in r || 'right' in r) {
    const p = pair(r)!;
    for (const t of TABS) out[t] = { ...p };
    return out;
  }
  for (const t of TABS) out[t] = pair(r[t]) ?? out[t];
  return out;
}
