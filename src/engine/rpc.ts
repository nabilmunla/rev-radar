// Calls to the engines. Each engine is a separate background process (see host.ts),
// reached through a message port. If an engine process dies (out of memory on a monster
// file), the app starts a new one and hands over a new port: calls in flight fail, the
// open files are reopened in it (see engines.ts), and everything else carries on.
type Pending = { res: (v: unknown) => void; rej: (e: Error) => void; method: string; t0: number; msg: unknown; sent: boolean };
/** slow calls (> 150 ms), newest last - for finding what makes the app wait (window.__rrSlow) */
export const slowCalls: { engine: string; method: string; ms: number; at: number }[] = [];
(globalThis as { __rrSlow?: unknown }).__rrSlow = slowCalls;

/** what the call that hung fails with when its engine was ended for not answering (T23; `hung` on the error: the call's id).
 *  The words are the Engineer's (DECISIONS 120): no engine, no restart - that is the app's business; with the file known, its name. */
export const hungText = (file?: string): string => file
  ? `"${file}" gave no answer for 6 minutes and reading it was stopped (a damaged or extremely heavy file can do this). Start again - if it stops at the same file, take that file out and compare the rest.`
  : 'A file gave no answer for 6 minutes and reading it was stopped (a damaged or extremely heavy file can do this). Start the comparison again.';
export const HUNG_TEXT = hungText();
export const isHung = (e: unknown) => !!e && typeof e === 'object' && typeof (e as { hung?: number }).hung === 'number';
/** the same hung error, naming the file the caller knows it was reading (fingerprint, info) */
export const hungFile = (e: unknown, file: string): Error => Object.assign(new Error(hungText(file)), { hung: (e as { hung: number }).hung, engineRestarted: true });

/** an engine's answer to a call a newer one in its lane made pointless (see EngineClient.call) */
export const SUPERSEDED = 'superseded';

/** an engine's answer when a file stopped reading part way (network drive, file replaced) */
export const READ_FAIL = 'The file could not be read completely (network drive dropped, or the file was changed or replaced meanwhile). Try again.';

/** calls that are long jobs by design (T23, DECISIONS 96): no limit - a 3,000-page book with OCR is honest
 *  work. The window shows them a busy line with the time so far and Stop instead (BOQ, Documents, the export).
 *  `docsReading` is not one (M2-4, DECISIONS 119b): it reads one file the app wrote and has no Stop. */
const LONG_JOBS = /^(?:boqCompare|docsCompare|exportPdf)$/;
/** how long a call may run before its engine is said not to answer (ms): 6 minutes for a comparing engine
 *  (the Drawings watchdog's limit), never for the long jobs (Infinity = no limit) */
export function hangLimit(method: string, ms = 6 * 60_000): number {
  return LONG_JOBS.test(method) ? Infinity : ms;
}

/** a file made or read by an engine */
export interface FileRef { $file: { path: string; size?: number; delta?: string; mtime?: number } }
export const fileArg = (path: string, extra: { size?: number; delta?: string; mtime?: number } = {}): FileRef => ({ $file: { path, ...extra } });
export const isFileRef = (v: unknown): v is FileRef => !!v && typeof v === 'object' && !!(v as FileRef).$file;

export class EngineClient {
  private port: MessagePort | null = null;
  private seq = 1;
  private pending = new Map<number, Pending>();
  private waiting: { id: number; msg: unknown }[] = [];
  /** number of calls in flight (used to spread tiles over engines) */
  busy = 0;
  /** times the engine had to be restarted */
  restarts = 0;
  constructor(public name: string) {}

  /** when the engine last answered anything (or was attached): the call it is running started no
   *  earlier than this - what it queued behind has just ended */
  private answeredAt = 0;
  /** set by the window when it ends this engine for not answering (T23): the id of the call that hung (`stuck().id`) -
   *  only that call fails with the hung text, the others the engine had taken fail as a plain restart (M2-3) */
  hung: number | null = null;

  /**
   * The call the engine is running now and for how long (T23), or null when it is idle or has no
   * engine: the oldest call it has taken (an engine does one call at a time, in order), timed from when
   * it last answered if that is later than the call was asked for.
   */
  stuck(now = performance.now()): { id: number; method: string; ms: number } | null {
    if (!this.port) return null;
    for (const [id, p] of this.pending) if (p.sent) return { id, method: p.method, ms: now - Math.max(p.t0, this.answeredAt, this.timedFrom) };
    return null;
  }

  /** the time of every call it is running starts again at `now` (M2-5, DECISIONS 119c: the PC slept - the clock
   *  went on, the engine did not) */
  private timedFrom = 0;
  timeAgain(now = performance.now()) { this.timedFrom = now; }

  attach(port: MessagePort, restarted: boolean) {
    this.answeredAt = performance.now();
    if (restarted) {
      this.restarts++;
      // calls the old engine had taken fail (one of them may be what brought it down); calls
      // still waiting for an engine go to the new one
      const why = this.hung;
      this.hung = null;
      for (const [id, p] of this.pending) if (p.sent) {
        this.pending.delete(id); this.busy--;
        p.rej(id === why ? Object.assign(new Error(HUNG_TEXT), { hung: id, engineRestarted: true }) : new Error(this.name + ' restarted'));
      }
    }
    this.port?.close();
    this.dying?.close();
    this.dying = null;
    this.port = port;
    port.onmessage = (e: MessageEvent) => this.reply(e.data);
    port.start();
    for (const w of this.waiting) {
      const p = this.pending.get(w.id);
      if (!p) continue;
      // (as in call(): a message that cannot be posted fails its call - it was left "sent" and never settled)
      try { port.postMessage(w.msg); p.sent = true; } catch (e) { this.pending.delete(w.id); this.busy--; p.rej(e instanceof Error ? e : new Error(String(e))); }
    }
    this.waiting = [];
  }

  /** the engine was closed for good (calls not yet sent wait for the next one started under this
   *  name; calls it had taken fail - they would never be answered) */
  detach() {
    const err = new Error(this.name + ' was closed');
    for (const [id, p] of this.pending) if (p.sent) { this.pending.delete(id); this.busy--; p.rej(err); }
    this.port?.close();
    this.port = null;
  }

  /** the engine is about to start afresh: hold calls until the new one is there */
  private hold() {
    if (!this.port) return;
    this.dying = this.port; // still listened to: its last answers ('retry') arrive on it
    this.port = null;
  }
  private dying: MessagePort | null = null;

  /** messages the engine sends on its own (e.g. 'recycle': restart me at a safe moment) */
  onNotice: ((notice: string) => void) | null = null;

  private reply(d: { id: number; ok: boolean; value: unknown; error: string; notice?: string; retry?: boolean; fatal?: boolean }) {
    if (d.notice) { if (d.notice === 'recycling') this.hold(); this.onNotice?.(d.notice); return; }
    const p = this.pending.get(d.id);
    if (!p) return;
    this.answeredAt = performance.now();
    // the engine was restarting when this call reached it: send it again to the new one
    if (!d.ok && d.retry) { this.hold(); p.sent = false; this.waiting.push({ id: d.id, msg: p.msg }); return; }
    this.pending.delete(d.id);
    this.busy--;
    const ms = performance.now() - p.t0;
    if (ms > 150 && d.error !== SUPERSEDED) { slowCalls.push({ engine: this.name, method: p.method, ms: Math.round(ms), at: Math.round(p.t0) }); if (slowCalls.length > 200) slowCalls.shift(); }
    if (!d.ok) {
      const e = new Error(d.error) as Error & { fatal?: boolean };
      // the engine ran out of memory on this call and is about to start afresh: later calls wait for
      // the new one (sent to the dying one they would be lost)
      if (d.fatal) { e.fatal = true; this.hold(); }
      p.rej(e);
      return;
    }
    const v = d.value;
    if (hasImg(v, 0)) void toBitmaps(v, 0).then(p.res, (e) => p.rej(e instanceof Error ? e : new Error(String(e))));
    else p.res(v);
  }

  /**
   * Call `method`. out: the file the call makes is written by the engine to a temp file
   * (true) or to the given path, and comes back as a FileRef instead of bytes.
   */
  call<T>(method: string, args: unknown[] = [], out?: boolean | string, lane?: string): Promise<T> {
    const id = this.seq++;
    this.busy++;
    // lane: a call that a newer call in the same lane makes pointless (the viewer's picture of a
    // spot already zoomed past) - the engine skips it if the newer one is waiting (SUPERSEDED)
    const msg = lane ? { id, method, args, out, lane } : { id, method, args, out };
    return new Promise<T>((res, rej) => {
      const p: Pending = { res: res as (v: unknown) => void, rej, method, t0: performance.now(), msg, sent: !!this.port };
      this.pending.set(id, p);
      try {
        if (this.port) this.port.postMessage(msg);
        else this.waiting.push({ id, msg });
      } catch (e) {
        // (the message could not be posted - a closed port, something that cannot be cloned: the
        // call is not in flight, and left counted it kept `busy` above 0, which BOQ reads to pick its engine)
        this.pending.delete(id);
        this.busy--;
        rej(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

type Img = { $img: 1; w: number; h: number; px: Uint8ClampedArray };
const isImg = (v: unknown): v is Img => !!v && typeof v === 'object' && (v as Img).$img === 1;
function hasImg(v: unknown, d: number): boolean {
  if (!v || typeof v !== 'object' || d > 2 || ArrayBuffer.isView(v)) return false;
  if (isImg(v)) return true;
  return Object.values(v).some((x) => hasImg(x, d + 1));
}
/** engine pictures (raw pixels) -> ImageBitmaps */
async function toBitmaps(v: unknown, d: number): Promise<unknown> {
  if (isImg(v)) return createImageBitmap(new ImageData(v.px as unknown as Uint8ClampedArray<ArrayBuffer>, v.w, v.h));
  if (!v || typeof v !== 'object' || d > 2 || ArrayBuffer.isView(v)) return v;
  if (Array.isArray(v)) return Promise.all(v.map((x) => toBitmaps(x, d + 1)));
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) o[k] = await toBitmaps(x, d + 1);
  return o;
}
