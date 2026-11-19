// The engines, each in its own background process: several compare sheet pairs side by side,
// one draws the viewer's pictures (so looking at a sheet never waits for the batch).
import { EngineClient } from '../engine/rpc';
import { rr } from './api';
import { Watch } from './watch';

export const workers: EngineClient[] = [];
export const viewer = new EngineClient('View engine');
/** a second view engine: makes the next sheet ready while one is looked at (see viewpool.ts) */
export const viewer2 = new EngineClient('View engine 2');
/** two view engines take turns (started with the others when the PC has the room) */
export let pooled = false;
const byName = new Map<string, EngineClient>();
let started: Promise<void> | null = null;
const restartHooks = new Set<(c: EngineClient, planned: boolean) => void>();
/** an engine started again: `planned` - it started afresh for its memory (exit 75, 'recycling'), not a crash */
export function onEngineRestart(f: (c: EngineClient, planned: boolean) => void) { restartHooks.add(f); return () => { restartHooks.delete(f); }; }

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || !e.data || e.data.type !== 'engine-port' || !e.ports[0]) return;
  const { name, restarted, code } = e.data as { name: string; restarted: boolean; code: number };
  const c = byName.get(name);
  if (!c) return;
  c.attach(e.ports[0], restarted);
  if (restarted) { rr.log(`engine ${name} restarted (exit ${code})`); for (const h of restartHooks) h(c, code === 75); }
});

/** how many comparing engines this PC can carry (each can use ~1.5 GB on a dense A0 sheet) */
export function engineCount(cores: number, memGB: number, wanted = 0): number {
  if (wanted > 0) return Math.min(12, wanted);
  const byCpu = Math.max(1, Math.floor((cores - 2) / 2));
  const byMem = Math.max(1, Math.floor((memGB - 4) / 1.8));
  return Math.max(1, Math.min(6, byCpu, byMem));
}

export function startEngines(n: number, twoViewers = true): Promise<void> {
  if (started) return started;
  started = (async () => {
    for (let i = 0; i < n; i++) { const c = new EngineClient('Engine ' + (i + 1)); workers.push(c); byName.set('w' + i, c); }
    byName.set('view', viewer);
    if (twoViewers) { byName.set('view2', viewer2); pooled = true; }
    await rr.enginesStart([...byName.keys()]);
    await Promise.all([...byName.values()].map((c) => c.call('ping')));
  })();
  return started;
}

/** exports run on an engine of their own, started for the job and closed after it (the viewer and
 *  the comparing engines carry on; a big export gets a whole engine's memory) */
export const exporter = new EngineClient('Export engine');
export async function freshExporter(): Promise<EngineClient> {
  byName.set('export', exporter);
  exporter.detach();
  await rr.engineAdd('export');
  await exporter.call('ping');
  return exporter;
}
export async function closeExporter() {
  exporter.detach();
  await rr.engineStop('export');
}

export function nameOf(c: EngineClient): string {
  for (const [k, v] of byName) if (v === c) return k;
  return '';
}

/** the BOQ and Documents compares each run on an engine of their own, started for the run and ended
 *  after it (T23): Stop ends exactly that engine - a Drawings run going on in the other tab loses no
 *  sheet - and nothing the run held stays behind */
export type JobKind = 'boq' | 'docs';
const jobbers: Record<JobKind, EngineClient> = { boq: new EngineClient('BOQ engine'), docs: new EngineClient('Documents engine') };
export async function freshJobEngine(kind: JobKind): Promise<EngineClient> {
  const c = jobbers[kind];
  byName.set(kind + 'job', c);
  c.detach();
  await rr.engineAdd(kind + 'job');
  await c.call('ping');
  return c;
}
/** end a run's engine (it was finished, stopped, or left) */
export async function closeJobEngine(kind: JobKind) {
  jobbers[kind].detach();
  await rr.engineStop(kind + 'job');
}
/** the jobs' engines, for the tests */
export const jobEngines = () => Object.values(jobbers);

// ---- T23 (DECISIONS 96): an engine that stops answering - the rules are in watch.ts (pure, tested)
// Every 5 s the window looks at what each engine is running (rpc.ts `stuck`).
//  - a comparing engine over its limit (6 minutes, hangLimit - never for the long jobs, which have Stop) is
//    ended and starts afresh: nothing of the person's is in it, the open files are reopened there. Always: a call
//    ended is never sent again by itself (runner.ts again1), so a cap would only leave the next hung call - and every
//    call behind it - unanswered for good (DECISIONS 117). (The Drawings queue has its own watch on `compare` - runner.ts - and says which sheet.)
//  - a view engine is never ended unasked (a blended A0 can honestly take a minute): over 90 s the window says so
//    ('rr-view-stuck') - only for the engine on screen - and the person decides: Keep waiting (asked again when the
//    call has run twice as long), or Restart the view (DECISIONS 118).
// (tests shorten the times: localStorage rr-hang-ms / rr-view-hang-ms / rr-hang-check-ms)
const stored = (k: string): number => { try { return Number(localStorage.getItem(k)) || 0; } catch { return 0; } };
export interface ViewStuck { engine: string; ms: number; restart(): void }
/** which view engine is on screen: viewpool.ts says (it holds the turn; engines.ts does not import it) */
let viewOnScreen: (c: EngineClient) => boolean = () => true;
export const setViewOnScreen = (f: (c: EngineClient) => boolean) => { viewOnScreen = f; };
const watch = new Watch({
  limits: () => ({ limit: stored('rr-hang-ms') || 6 * 60_000, viewLimit: stored('rr-view-hang-ms') || 90_000 }),
  onScreen: (c) => viewOnScreen(c),
  log: (line) => rr.log(line),
  kill: (name) => { void rr.engineKill(name); },
  notice: (name, ms) => window.dispatchEvent(new CustomEvent<ViewStuck>('rr-view-stuck', { detail: { engine: name, ms, restart: () => { void rr.engineKill(name); } } })),
  over: (name) => window.dispatchEvent(new CustomEvent('rr-view-stuck-over', { detail: name })),
});
export const checkStuck = (now = performance.now()) => watch.check(now, byName);
const stuckTick = () => {
  if (started) try { checkStuck(); } catch (e) { rr.log('engine check: ' + e); }
  const t = globalThis.setTimeout(stuckTick, stored('rr-hang-check-ms') || 5000);
  (t as unknown as { unref?: () => void }).unref?.();
};
{ const t = globalThis.setTimeout(stuckTick, 5000); (t as unknown as { unref?: () => void }).unref?.(); }
