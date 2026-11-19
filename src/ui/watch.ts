// The watch on the engines (T23, DECISIONS 96, 117-119): which call each engine is running and for how long
// (rpc.ts `stuck`), and what the window does about one that does not answer. The pure part of engines.ts - it
// touches nothing of the window, so tests/watch.test.ts can drive it with a clock of its own.
import { hangLimit, type EngineClient } from '../engine/rpc';

export interface WatchEnv {
  /** the limits now (ms): a comparing engine's call, a view engine's call (tests shorten them) */
  limits(): { limit: number; viewLimit: number };
  /** the view engine that draws the sheet on screen (viewpool.ts) */
  onScreen(c: EngineClient): boolean;
  log(line: string): void;
  /** end the engine (it starts afresh) */
  kill(name: string): void;
  /** put the notice up for a view engine's call that has run `ms`; take it down */
  notice(name: string, ms: number): void;
  over(name: string): void;
}

export class Watch {
  constructor(private env: WatchEnv) {}
  /** the call of each comparing engine already ended */
  private dealt = new Map<EngineClient, number>();
  /** the view call a notice was raised for, and the age (ms) at which it is asked again - twice the age at the last notice */
  private noticeFor = new Map<EngineClient, number>();
  private asked = new Map<EngineClient, { id: number; again: number }>();

  /** when the engines were last looked at */
  private lastLook = -Infinity;

  /** one look at every engine (`now`: performance.now()) */
  check(now: number, engines: Iterable<[string, EngineClient]>) {
    const { limit, viewLimit } = this.env.limits();
    const all = [...engines];
    // (M2-5, DECISIONS 119c - from the clock's behaviour, not reproduced: Windows' clock counts through sleep, so a lid
    //  closed 6 minutes would end a call that waited 5 s. Looks are 5 s apart, a throttled window's 60 s; one more than
    //  2 minutes after the one before is the PC's sleep, and counts for nothing: every call's time starts again from it)
    if (now - this.lastLook > 120_000 && this.lastLook > -Infinity) {
      for (const [name, c] of all) {
        c.timeAgain(now);
        // (a notice up for a call timed from before: it comes again if the call still runs 90 s after)
        if (this.noticeFor.delete(c)) this.env.over(name);
        this.asked.delete(c);
      }
    }
    this.lastLook = now;
    for (const [name, c] of all) {
      // (exports and the BOQ / Documents runs have a busy line with Stop; they are not watched here)
      if (name === 'export' || name.endsWith('job')) continue;
      const isView = name.startsWith('view');
      const s = c.stuck(now);
      // (a notice goes when its call ends - or when its engine is no longer the one on screen: it comes again when it is)
      const away = isView && !this.env.onScreen(c);
      const shown = this.noticeFor.get(c);
      if (shown !== undefined && (s?.id !== shown || away)) {
        this.noticeFor.delete(c);
        if (away) this.asked.delete(c);
        this.env.over(name);
      }
      if (!s || s.method === 'compare') continue;
      if (isView) {
        // (no notice for the engine making the next sheet ready - nobody waits for it; its call is not dealt with,
        //  so the notice comes when the sheet is opened - DECISIONS 118a)
        if (away) continue;
        const a = this.asked.get(c);
        if (s.ms < (a?.id === s.id ? a.again : viewLimit)) continue;
        // ("Keep waiting" is asked again when the call has run twice as long as at this notice - 118b)
        this.asked.set(c, { id: s.id, again: s.ms * 2 });
        this.env.log(`${c.name}: ${s.method} has not answered for ${Math.round(s.ms / 1000)} s`);
        this.noticeFor.set(c, s.id);
        this.env.notice(name, s.ms);
        continue;
      }
      if (this.dealt.get(c) === s.id || s.ms < hangLimit(s.method, limit)) continue;
      this.dealt.set(c, s.id);
      this.env.log(`${c.name}: ${s.method} has not answered for ${Math.round(s.ms / 1000)} s`);
      c.hung = s.id; // (the call that hung - the others it had taken are sent again)
      this.env.kill(name);
    }
  }
}
