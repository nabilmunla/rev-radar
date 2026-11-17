// The engines, each in its own background process: several compare sheet pairs side by side,
// one draws the viewer's pictures (so looking at a sheet never waits for the batch).
import { EngineClient } from '../engine/rpc';
import { rr } from './api';

export const workers: EngineClient[] = [];
export const viewer = new EngineClient('View engine');
/** a second view engine: makes the next sheet ready while one is looked at (see viewpool.ts) */
export const viewer2 = new EngineClient('View engine 2');
/** two view engines take turns (started with the others when the PC has the room) */
export let pooled = false;
const byName = new Map<string, EngineClient>();
let started: Promise<void> | null = null;
const restartHooks = new Set<(c: EngineClient) => void>();
export function onEngineRestart(f: (c: EngineClient) => void) { restartHooks.add(f); return () => { restartHooks.delete(f); }; }

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || !e.data || e.data.type !== 'engine-port' || !e.ports[0]) return;
  const { name, restarted, code } = e.data as { name: string; restarted: boolean; code: number };
  const c = byName.get(name);
  if (!c) return;
  c.attach(e.ports[0], restarted);
  if (restarted) { rr.log(`engine ${name} restarted (exit ${code})`); for (const h of restartHooks) h(c); }
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
