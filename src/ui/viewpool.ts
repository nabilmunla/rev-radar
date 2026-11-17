// Two view engines take turns: one draws the sheet on screen, the other makes the next sheet ready
// (opens it, reads its pages in - 2 s a dense page, 2-5 s a heavy blended display list - and draws
// the first pictures the viewer will ask for). Moving on, they swap. Each keeps one pair open on a
// PC under 12 GB (memory as one engine with two pairs before), two above (going back a sheet then
// finds it still open).
//
// Which engine holds which pairs is known here (in the order the engine opened them: it lets go of
// the oldest first, as this list does); an engine that starts afresh holds nothing.
import { viewer, viewer2, pooled, onEngineRestart, nameOf } from './engines';
import type { EngineClient } from '../engine/rpc';
import { rr } from './api';

const holds = new Map<EngineClient, string[]>();
let front: EngineClient = viewer;
let perEngine = 1;

onEngineRestart((c) => {
  holds.delete(c);
  dropWarm(c);
  // (started afresh at normal priority: the one making ready gives way again - main.cjs applies it
  //  once the new process is there)
  if (pooled && c !== front && (c === viewer || c === viewer2)) void rr.enginePriority(nameOf(c), true);
});
/** at the start: the second view engine makes ready, so it gives way; pairs kept by the PC's memory */
export function poolStarted(memGB: number) {
  perEngine = memGB >= 12 ? 2 : 1;
  // (both said: after "Reload the window" the main process may still have either down as low)
  if (pooled) { void rr.enginePriority(nameOf(viewer), false); void rr.enginePriority(nameOf(viewer2), true); }
}

/** pairs kept open per view engine */
export const keepPairs = () => (pooled ? perEngine : 2);

const held = (e: EngineClient) => holds.get(e) ?? [];
/** `e` has the pair open (as far as is known here) */
export const has = (e: EngineClient, pairId: string) => held(e).includes(pairId);
/** some view engine has the pair open */
export const anyHas = (pairId: string) => [...holds.values()].some((l) => l.includes(pairId));
function note(e: EngineClient, pairId: string) {
  const l = held(e);
  if (l.includes(pairId)) return;
  l.push(pairId);
  while (l.length > keepPairs()) l.shift();
  holds.set(e, l);
}

/** the engine that draws this pair: the one that has it open, else the one on screen (the pair
 *  left first goes - a pair made ready on the other one stays ready) */
export function engineFor(pairId: string): EngineClient {
  if (!pooled) return viewer;
  for (const [e, l] of holds) if (l.includes(pairId)) return e;
  return front;
}

/** the pair on screen is opened on `e` */
export function shown(pairId: string, e: EngineClient) {
  if (pooled && e !== front) {
    // (turns swapped: the one drawing the screen comes first, the one making ready gives way - on
    //  a two-core PC they would share the CPU half and half)
    void rr.enginePriority(nameOf(e), false);
    void rr.enginePriority(nameOf(front), true);
  }
  front = e;
  note(e, pairId);
}

/** the engine that makes the next pair ready (null: one view engine only) */
export function backEngine(): EngineClient | null {
  if (!pooled) return null;
  return front === viewer ? viewer2 : viewer;
}
/** `e` is opening the pair (known before it is: going there meanwhile waits on e, not opens it twice) */
export function opened(e: EngineClient, pairId: string) { note(e, pairId); }
/** `e` could not open the pair after all */
export function notOpened(e: EngineClient, pairId: string) {
  const l = held(e), k = l.indexOf(pairId);
  if (k >= 0) l.splice(k, 1);
}

// ---------------------------------------------------------------- pictures made ahead

/** a picture made ahead for a pair: base (whole sheet) or detail (rect at zr, device pixels) */
export interface Warm { pairId: string; kind: 'base' | 'detail'; mode: string; zr: number; rect: number[]; fade: number; bmp: ImageBitmap }
let warm: { e: EngineClient; pics: Warm[] } | null = null;

function dropWarm(e?: EngineClient) {
  if (!warm || (e && warm.e !== e)) return;
  for (const p of warm.pics) p.bmp.close();
  warm = null;
}
/** pictures made ahead for a pair (the ones before, for another pair, are let go) */
export function putWarm(e: EngineClient, pics: Warm[]) {
  dropWarm();
  warm = { e, pics };
}
/** the sheet view is closed: the pictures made ahead go with it (they held tens of MB for the rest of
 *  the session - RR-028); with a pair id: only that pair's (its files were read again - "Again") */
export function releaseWarm(pairId?: string) {
  if (!warm) return;
  if (!pairId) { dropWarm(); return; }
  for (const p of warm.pics) if (p.pairId === pairId) p.bmp.close();
  warm.pics = warm.pics.filter((p) => p.pairId !== pairId);
}
/** the pictures made ahead for this pair - handed over once (the caller closes them) */
export function takeWarm(pairId: string): Warm[] {
  if (!warm) return [];
  const mine = warm.pics.filter((p) => p.pairId === pairId);
  if (!mine.length) return [];
  warm.pics = warm.pics.filter((p) => p.pairId !== pairId);
  return mine;
}

/**
 * A pair read in ahead with no pictures (the first sheet to review while the list of sheets is on
 * screen - the viewer is not there to say what it will ask for): opened on the engine that makes
 * ready, its pages read in. Quietly does nothing when it can't.
 */
export async function warmOpen(pairId: string, oldFile: unknown, newFile: unknown, pages: number[], color: boolean): Promise<void> {
  const e = backEngine();
  if (!e || anyHas(pairId)) return;
  note(e, pairId);
  try {
    await e.call('viewOpen', [pairId, oldFile, newFile, keepPairs()]);
    await e.call('viewWarm', [pairId, pages[0], pages[1], color, []], undefined, 'warm');
  } catch (err) {
    // (made pointless by a newer call: it is open, just not read in)
    if (!/superseded/.test(String((err as Error)?.message))) notOpened(e, pairId);
  }
}
