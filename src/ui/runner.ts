// Running a comparison: read both issues, pair the sheets, compare every pair on the engines
// (several at once, results shown as they come), remember results so the same comparison
// opens instantly next time.
import { rr, type FileItem, type Kind } from './api';
import { workers, viewer } from './engines';
import { fileArg, READ_FAIL, isHung, hungFile, type EngineClient } from '../engine/rpc';
import { pairByNames, pairByContent, sheetKeyOf, cleanTitle, type SheetRef, type PairPlan, type Fingerprint } from './pairing';
import { classifyAreas, sizeKey } from './titleblock';
import { pairBySheetNo, type ReadPage } from './sheetpair';
import type { PageToks } from './sheets';
import { ui, bump, toast, sizeGroup, realAreas, refKey, reviewKey, needsReview, type Pair, type Session, type SetInfo, type ResultR, type Zone, type Manual } from './model';

/** a sheet still not compared after this long is stopped */
const WATCHDOG_MS = 6 * 60 * 1000;
const TOO_LONG = 'This sheet took over 6 minutes and was stopped (an extremely heavy or damaged drawing). Try again, or try a lower checking resolution in Settings.';

const CHANGED = 'The file was saved over while it was being compared. Try again.';

/** engine version: results from an older engine are compared again */
export const ENGINE_V = 9;

// ---------------------------------------------------------------- reading the issues

export async function readSet(paths: string[], recursive: boolean, kind: Kind = 'pdf'): Promise<FileItem[]> {
  const want = kind === 'boq' ? /\.(xlsx|xlsm|xls|pdf)$/i : kind === 'docs' ? /\.(pdf|docx)$/i : /\.pdf$/i;
  const out: FileItem[] = [];
  const st = await rr.stat(paths);
  for (let i = 0; i < paths.length; i++) {
    const s = st[i];
    if (!s) continue;
    if (s.dir) {
      const list = await rr.list(paths[i], recursive, kind);
      const pre = paths.length > 1 ? paths[i].split(/[\\/]/).pop() + '\\' : '';
      out.push(...list.map((f) => ({ ...f, rel: pre + f.rel })));
    } else if (want.test(paths[i]) && !/^~\$/.test(paths[i].split(/[\\/]/).pop()!)) out.push({ path: paths[i], rel: paths[i].split(/[\\/]/).pop()!, size: s.size, mtime: s.mtime });
  }
  // the same file chosen twice: once
  const seen = new Set<string>();
  return out.filter((f) => { const k = f.path.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

export function setLabel(paths: string[], up = 0): string {
  if (!paths.length) return '';
  const last = (p: string) => { const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean); return parts.slice(-1 - up).join('\\') || p; };
  return paths.length === 1 ? last(paths[0]) : `${last(paths[0])} + ${paths.length - 1} more`;
}

/** the two sides' names for the header, the window title and the recent list: with the folders they
 *  are in when the names alone are the same (one A-101.pdf against another read "A-101.pdf -> A-101.pdf",
 *  RR-043) */
export function sideLabels(oldPaths: string[], newPaths: string[]): [string, string] {
  let a = setLabel(oldPaths), b = setLabel(newPaths);
  for (let up = 1; a === b && up <= 4; up++) { a = setLabel(oldPaths, up); b = setLabel(newPaths, up); }
  return [a, b];
}

/** run calls over the engines, a few at a time each (live: false once the comparison is left) */
async function spread<T, R>(items: T[], fn: (c: EngineClient, x: T) => Promise<R>, onEach?: (done: number) => void, live: () => boolean = () => true): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0, done = 0;
  const pool = workers.length ? workers : [viewer];
  await Promise.all(pool.map(async (c) => {
    while (next < items.length && live()) {
      const i = next++;
      out[i] = await fn(c, items[i]);
      onEach?.(++done);
    }
  }));
  return out;
}

/** a call once more when its engine went down meanwhile (another call may have brought it down) */
async function again1<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) {
    // (an engine ended for not answering would only hang again on the same call - T23)
    if (isHung(e)) throw e;
    if (/restart/.test(String((e as Error)?.message)) || (e as { fatal?: boolean }).fatal) return f();
    throw e;
  }
}

/** an engine's error for a call that read `path`: a hung one says which file (M2-6, DECISIONS 120) */
const named = (e: unknown, path: string): unknown => (isHung(e) ? hungFile(e, path.split(/[\\/]/).pop() || path) : e);

/** one sheet's file read again (after "Try again" on a file that could not be read) */
async function refreshRef(c: EngineClient, ref: SheetRef): Promise<SheetRef> {
  type Info = { pages: { w: number; h: number }[]; labels: string[]; error?: string };
  const inf = await again1(() => c.call<Info>('info', [fileArg(ref.file)])).catch((e) => ({ error: String((named(e, ref.file) as Error)?.message || e) }) as Info);
  const st = (await rr.stat([ref.file]).catch(() => [null]))[0];
  if (!inf || inf.error || !inf.pages?.length) return { ...ref, bad: String(inf?.error || 'The PDF has no pages') };
  const k = Math.min(ref.page, inf.pages.length - 1);
  return { ...ref, bad: undefined, page: k, pages: inf.pages.length, w: inf.pages[k].w, h: inf.pages[k].h, label: inf.labels[k] || '', size: st?.size ?? ref.size, mtime: st?.mtime ?? ref.mtime };
}

async function sheetsOf(files: FileItem[], s: Session, which: string, live: () => boolean): Promise<SheetRef[]> {
  type Info = { pages: { w: number; h: number }[]; labels: string[]; error?: string };
  const infos = await spread(files, (c, f) => again1(() => c.call<Info>('info', [fileArg(f.path)])).catch((e) => ({ error: String((named(e, f.path) as Error)?.message || e) }) as Info),
    (d) => { s.note = `Reading ${which}: ${d} of ${files.length} files`; bump(); }, live);
  const out: SheetRef[] = [];
  files.forEach((f, i) => {
    const inf = infos[i];
    // a file that can't be read stays in the list (paired by its name) as a problem - never
    // quietly dropped, which would show its sheet as removed / new
    const bad = !inf || inf.error ? String(inf?.error || 'unknown error') : !inf.pages.length ? 'The PDF has no pages' : '';
    if (bad) { out.push({ file: f.path, rel: f.rel, page: 0, pages: 1, size: f.size, mtime: f.mtime, w: 0, h: 0, label: '', bad }); return; }
    inf.pages.forEach((p: { w: number; h: number }, k: number) => out.push({ file: f.path, rel: f.rel, page: k, pages: inf.pages.length, size: f.size, mtime: f.mtime, w: p.w, h: p.h, label: inf.labels[k] || '' }));
  });
  return out;
}

// ---------------------------------------------------------------- a new comparison

let runId = 0;

export async function startSession(oldSet: SetInfo, newSet: SetInfo, keep?: { zones?: Zone[]; manual?: Manual; reviewed?: string[] }) {
  const my = ++runId;
  // the same two issues compared before (picked again, not opened from Recent): what was done
  // then - ticks, left-out spots, hand pairs - is kept, not wiped
  if (!keep) {
    const r = await recentFor(oldSet, newSet);
    if (my !== runId) return;
    if (r) keep = { zones: r.zones, manual: r.manual, reviewed: r.reviewed };
  }
  const s: Session = { id: Math.random().toString(36).slice(2), oldSet, newSet, pairs: [], zones: keep?.zones || [], manual: { hand: [...(keep?.manual?.hand || [])], split: [...(keep?.manual?.split || [])] }, started: performance.now(), phase: 'reading', settings: { ...ui.settings } };
  dropPictures(ui.session);
  ui.session = s; ui.selected = null; ui.area = -1; ui.filter = 'all'; ui.search = '';
  bump(true);
  try {
    const live = () => my === runId;
    const olds = await sheetsOf(oldSet.files, s, 'the old issue', live);
    if (!live()) return;
    const news = await sheetsOf(newSet.files, s, 'the new issue', live);
    if (!live()) return;
    s.phase = 'pairing'; s.note = 'Pairing sheets'; bump();
    const plans = applyManual(await pairAll(olds, news, s, live), s.manual);
    if (!live()) return;
    s.pairs = plans.map((p, i) => planToPair(p, i));
    // reviewed marks: by both files' name, page, size and date (a re-issue under the same name is
    // not ticked)
    if (keep?.reviewed) {
      // (stored as "<sheets>@<changes counted when ticked>")
      const counted = new Map<string, number>();
      const plain = keep.reviewed.map((k) => { const m = /^(.*)@(\d+)$/.exec(k); if (m) { counted.set(m[1], Number(m[2])); return m[1]; } return k; });
      const r = new Set(plain);
      // a tick whose sheet was issued again (same name and page, another file) is not kept - and said
      const nameOnly = (k: string) => k.split('|').map((x) => x.split('#').slice(0, 2).join('#')).join('|');
      const stale = new Set(plain.filter((k) => k.split('|').some((x) => x.split('#').length > 2)).map(nameOnly));
      const reissued: string[] = [];
      for (const p of s.pairs) {
        if (r.has(reviewKey(p))) { p.reviewed = true; p.tickedReal = counted.get(reviewKey(p)); }
        else if (stale.has(nameOnly(reviewKey(p)))) reissued.push(p.key);
      }
      if (reissued.length) toast(`${reissued.length} sheet${reissued.length === 1 ? ' was' : 's were'} issued again since you ticked ${reissued.length === 1 ? 'it' : 'them'} off (${reissued.slice(0, 3).join(', ')}${reissued.length > 3 ? ' …' : ''}) - not ticked any more`, 'warn', 12000);
    }
    s.phase = 'comparing'; s.note = '';
    // (the overview of all sheets first: they fill in as they are compared)
    ui.selected = null;
    bump(true);
    remember(s);
    await runQueue(s, my);
  } catch (e) {
    if (my !== runId) return;
    s.phase = 'stopped'; s.note = 'Stopped: ' + String((e as Error)?.message || e);
    bump();
  }
}

/** what to do about a file that can't be read */
const ASK_AGAIN = 'Ask for this file to be issued again (or check whether it opens in a PDF reader).';

export function planToPair(p: PairPlan, i: number): Pair {
  // named after the new issue's file - unless that is one combined PDF of many sheets and the old
  // sheet has a file of its own (its name says which drawing it is)
  const ref = p.neu && !(p.neu.pages > 1 && p.old && p.old.pages === 1) ? p.neu : p.old || p.neu!;
  const base = ref.rel.split(/[\\/]/).pop()!.replace(/\.pdf$/i, '');
  const key = sheetKeyOf(ref);
  // the descriptive part of the file name ("GA L04" of "F109-...-10140 - GA L04")
  const at = base.toUpperCase().indexOf(key.split(' ')[0].toUpperCase());
  let title = base.slice(at >= 0 ? at + key.split(' ')[0].length : 0).replace(/^[\s_\-.]+/, '').trim();
  // ("Ground Floor Plan A-101", "Фасад северный A-202": the words come before the number)
  if (!title && at > 0) title = base.slice(0, at).replace(/[\s_\-.]+$/, '').trim();
  if (!title || title === base) title = ref.pages > 1 ? `page ${ref.page + 1} of ${base}` : (title === key ? '' : title);
  // (not a revision mark, copy number or date left over from the name: "(1)", "2026-10-28", "RevB")
  if (ref.pages <= 1) title = cleanTitle(title);
  // (the number and title read off the sheet - T11; no title read: the one from the file name stays - sweep)
  if (ref.read?.no && ref.read.title) title = ref.read.title;
  return {
    id: 'p' + i + '-' + Math.random().toString(36).slice(2, 7),
    old: p.old, neu: p.neu, how: p.how, score: p.score,
    key, title,
    status: p.old?.bad || p.neu?.bad ? 'error' : !p.old ? 'new' : !p.neu ? 'removed' : 'waiting',
    error: p.neu?.bad && p.old?.bad ? `Could not read either file. Old: ${p.old.bad}. New: ${p.neu.bad}. Ask for both to be issued again.`
      : p.neu?.bad ? `Could not read the new issue's file: ${p.neu.bad}. ${ASK_AGAIN}` : p.old?.bad ? `Could not read the old issue's file: ${p.old.bad}. ${ASK_AGAIN}` : undefined,
  };
}

async function pairAll(olds: SheetRef[], news: SheetRef[], s: Session, live: () => boolean): Promise<PairPlan[]> {
  const byName = pairByNames(olds, news);
  const plans: PairPlan[] = [...byName.pairs];
  let lo = byName.olds, ln = byName.news;
  if (lo.length && ln.length) {
    // the rest by what the sheets say - and the number in their title block (T11). Single files left
    // over are read with up to 8 name-paired files of their size as witnesses (sides 2 / 3): their
    // read numbers must agree with their names before a renamed file is paired by its number.
    const witnesses = (left: SheetRef[], paired: SheetRef[]) => {
      const sizes = new Set(left.filter((r) => r.pages === 1 && r.w > 0).map((r) => sizeKey(r)));
      const out: SheetRef[] = [];
      for (const k of sizes) out.push(...paired.filter((r) => r.pages === 1 && !r.bad && sizeKey(r) === k).slice(0, 8));
      return out;
    };
    const witO = witnesses(lo, byName.pairs.map((p) => p.old!).filter(Boolean)), witN = witnesses(ln, byName.pairs.map((p) => p.neu!).filter(Boolean));
    const want = [...lo.map((r) => ({ r, side: 0 })), ...ln.map((r) => ({ r, side: 1 })), ...witO.map((r) => ({ r, side: 2 })), ...witN.map((r) => ({ r, side: 3 }))];
    const byFile = new Map<string, { r: SheetRef; side: number }[]>();
    for (const w of want) { const k = w.r.file; if (!byFile.has(k)) byFile.set(k, []); byFile.get(k)!.push(w); }
    const groups = [...byFile.values()];
    let done = 0;
    // (an engine that stopped answering and was ended - T23: pairing on empty words would call every sheet new or
    //  removed, so the run stops and says why)
    let hung: unknown = null;
    const fps = await spread(groups, async (c, g) => {
      const res = await again1(() => c.call<{ page: number; words: string[]; toks?: PageToks }[]>('fingerprint', [fileArg(g[0].r.file), g.map((x) => x.r.page)])).catch((e) => { if (isHung(e)) hung ??= named(e, g[0].r.file); return g.map((x) => ({ page: x.r.page, words: [] as string[], toks: undefined })); });
      s.note = `Reading what the sheets say: ${(done += g.length)} of ${want.length}`; bump();
      return g.map((x, i) => ({ side: x.side, toks: res[i]?.toks, fp: { ref: x.r, words: res[i]?.words || [] } as Fingerprint }));
    }, undefined, () => live() && !hung);
    if (hung) throw hung;
    if (!live()) return [];
    const flat = fps.flat();
    const side = (k: number) => flat.filter((x) => x.side === k);
    const rp = (k: number): ReadPage[] => side(k).map((x) => ({ ref: x.fp.ref, toks: x.toks }));
    const fo = side(0), fn = side(1);
    let bySheet: [number, number, boolean][] = [];
    try {
      const sp = pairBySheetNo(rp(0), rp(1), rp(2), rp(3));
      for (const [r, nm] of sp.names) r.read = nm;
      const io = new Map(fo.map((x, i) => [x.fp.ref, i] as const)), jn = new Map(fn.map((x, j) => [x.fp.ref, j] as const));
      bySheet = sp.pairs.map(([a, b, rep]) => [io.get(a)!, jn.get(b)!, rep] as [number, number, boolean]).filter(([i, j]) => i != null && j != null);
    } catch { /* (a reading fault leaves today's pairing as it was) */ }
    const byContent = pairByContent(fo.map((x) => x.fp), fn.map((x) => x.fp), 0.35, bySheet);
    plans.push(...byContent.pairs);
    lo = byContent.olds; ln = byContent.news;
  }
  for (const o of lo) plans.push({ old: o, neu: null, how: 'none' });
  for (const n of ln) plans.push({ old: null, neu: n, how: 'none' });
  // sheet order: as the new issue lists them, removed sheets at their old place's neighbours
  const order = (p: PairPlan) => (p.neu ? news.indexOf(p.neu) : olds.indexOf(p.old!) + 0.5);
  plans.sort((a, b) => order(a) - order(b));
  return plans;
}

// ---------------------------------------------------------------- the queue

const running = new Map<string, EngineClient>();
type QPair = Pair & { pri?: number; job?: number; tries?: number };
/** look at this pair next (the user opened it) */
export function prioritise(id: string) {
  const s = ui.session;
  if (!s) return;
  const p = s.pairs.find((x) => x.id === id) as QPair | undefined;
  if (p && p.status === 'waiting') p.pri = Date.now();
}

/** each start of the queue; worker loops of an earlier start (before a stop) end */
let queueGen = 0;
/** each comparison of a pair; only the latest one may write its result */
let jobSeq = 0;

async function runQueue(s: Session, my: number) {
  const gen = ++queueGen;
  // the pair the user opened last first, then in list order
  const next = (): Pair | undefined => {
    let best: QPair | undefined;
    for (const p of s.pairs as QPair[]) {
      if (p.status !== 'waiting') continue;
      if (!best || (p.pri || 0) > (best.pri || 0)) best = p;
    }
    return best;
  };
  await Promise.all(workers.map(async (c) => {
    for (;;) {
      if (my !== runId || gen !== queueGen || s.phase !== 'comparing') return;
      const p = next();
      if (!p) return;
      p.status = 'running';
      p.since = performance.now();
      running.set(p.id, c);
      bump();
      await comparePairJob(c, p, s);
      running.delete(p.id);
      classify(s);
      bump();
    }
  }));
  if (my === runId && gen === queueGen && s.phase === 'comparing') {
    s.phase = 'done'; s.finished = performance.now();
    classify(s);
    staleTicks(s);
    remember(s);
    bump();
    void sheetPictures(s, my);
  }
}

/** pictures of the sheets in one issue only (new, removed, the other file unreadable) for the
 *  overview - after the comparisons */
async function sheetPictures(s: Session, my: number) {
  const want = s.pairs.filter((p) => !p.thumbUrl && !p.result && (p.old && !p.old.bad ? 1 : 0) + (p.neu && !p.neu.bad ? 1 : 0) === 1);
  await spread(want, async (c, p) => {
    const ref = p.neu && !p.neu.bad ? p.neu : p.old!;
    const r = await c.call<{ png: Uint8Array }>('thumb', [fileArg(ref.file), ref.page]).catch(() => null);
    if (r && my === runId && !p.thumbUrl && !p.result) { setThumb(p, r.png); bump(); }
  }, undefined, () => my === runId);
}

/** told when a pair is compared again: what was looked at of its result before means nothing for the
 *  new one (Results' seen / last change / tiny stop - kept by change number - RR-036) */
export const onRerun = new Set<(p: Pair) => void>();

/** compare one pair again (after an error; fresh: not from the remembered results) */
export async function rerun(p: Pair, fresh = false) {
  const s = ui.session;
  if (!s) return;
  // (a tick on a sheet that could not be compared said "dealt with", not "its changes seen")
  const wasOpen = p.status === 'error';
  // (a tick made in this session: the changes it counted then - more now, not ticked any more - RR-030)
  const countedThen = p.result && p.status !== 'error' ? realAreas(p).length : 0;
  for (const f of onRerun) f(p);
  p.status = 'waiting'; p.result = undefined; p.error = undefined; p.common = undefined; p.ignored = undefined;
  (p as QPair).tries = 0;
  bump();
  const c = workers.reduce((a, b) => (b.busy < a.busy ? b : a), workers[0]);
  // a file that could not be read: read again (it may have been issued again since)
  for (const side of ['old', 'neu'] as const) {
    const ref = p[side];
    if (!ref?.bad) continue;
    const fresh2 = await refreshRef(c, ref);
    if (fresh2.bad) { p.status = 'error'; p.error = `Could not read the ${side === 'old' ? 'old' : 'new'} issue's file: ${fresh2.bad}. ${ASK_AGAIN}`; classify(s); remember(s); bump(); return; }
    p[side] = fresh2;
  }
  if (!p.old || !p.neu) { p.status = p.old ? 'removed' : 'new'; classify(s); remember(s); bump(); void sheetPictures(s, runId); return; }
  p.status = 'running'; bump();
  const before = p.reviewed ? (p.tickedReal ?? (wasOpen ? 0 : countedThen)) : -1;
  await comparePairJob(c, p, s, fresh);
  classify(s);
  if (before >= 0 && p.reviewed) { p.tickedReal = before; staleTicks(s, [p]); }
  remember(s); bump();
}

/** ticks kept from last time (or before "Again") whose sheet now counts more changes than when it
 *  was ticked - other settings, a fixed engine, more sheets of its size: not ticked any more */
function staleTicks(s: Session, only?: Pair[]) {
  const off: string[] = [];
  for (const p of only || s.pairs) {
    if (!p.reviewed || p.tickedReal === undefined || !p.result || p.status === 'error') continue;
    if (realAreas(p).length > p.tickedReal) { p.reviewed = false; off.push(p.key); }
    p.tickedReal = undefined;
  }
  if (off.length) toast(`${off.slice(0, 3).join(', ')}${off.length > 3 ? ' …' : ''}: more changes count than when ${off.length === 1 ? 'it was' : 'they were'} ticked off - not ticked any more`, 'warn', 12000);
}

async function sha1(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function comparePairJob(c: EngineClient, p: Pair, s: Session, fresh = false) {
  const t0 = performance.now();
  const o = p.old!, n = p.neu!;
  const q = p as QPair;
  const job = q.job = ++jobSeq;
  // the settings this result is made with (the key, the call and the viewer all use these): the
  // comparison's own - a Save in Settings meanwhile is for the next comparison
  const settings = { ...(s.settings || ui.settings) };
  try {
    // the very same file (and page) issued again: no need to draw it
    if (o.size === n.size && o.page === n.page && o.pages === n.pages) {
      const [ha, hb] = await Promise.all([rr.hash(o.file), rr.hash(n.file)]);
      if (q.job !== job) return;
      if (ha === hb) { p.status = 'identical'; p.result = undefined; p.secs = (performance.now() - t0) / 1000; return; }
    }
    const [qa, qb] = await Promise.all([rr.hash(o.file, true), rr.hash(n.file, true)]);
    const key = await sha1(JSON.stringify({ v: ENGINE_V, a: qa, ap: o.page, b: qb, bp: n.page, s: settings, m: p.manualAlign || null }));
    const hit = fresh ? null : await rr.cacheGet(key);
    if (q.job !== job) return;
    p.cacheKey = key;
    if (hit) {
      p.result = { ...(hit.json as ResultR), settings, fromCache: true };
      setThumb(p, hit.thumb);
      p.status = 'changed';
      oddSizes(p);
      p.secs = (performance.now() - t0) / 1000;
      return;
    }
    // a sheet that never finishes (a damaged or monstrous drawing) must not hold an engine for
    // good: past the limit the engine is closed (it starts afresh) and the sheet is marked
    let timedOut = false;
    const dog = setTimeout(() => { timedOut = true; const k = workers.indexOf(c); if (k >= 0) void rr.engineKill('w' + k); }, WATCHDOG_MS);
    let r: any;
    try { r = await c.call<any>('compare', [fileArg(o.file), o.page, fileArg(n.file), n.page, settings, p.manualAlign || null]); }
    catch (e) { if (timedOut) throw new Error(TOO_LONG); throw e; }
    finally { clearTimeout(dog); }
    if (q.job !== job) return; // stopped or compared again meanwhile
    // a file saved over while it was being compared: the result may mix both - once more
    const [qa2, qb2] = await Promise.all([rr.hash(o.file, true), rr.hash(n.file, true)]);
    if (q.job !== job) return;
    if (qa2 !== qa || qb2 !== qb) throw new Error(CHANGED);
    const res: ResultR = {
      settings,
      oldSize: r.oldSize, newSize: r.newSize, align: r.align, alignInfo: r.alignInfo, areas: r.areas, ...(r.parts?.length ? { parts: r.parts } : {}),
      addPx: r.addPx, remPx: r.remPx, inkPx: r.inkPx, oldInkPx: r.oldInkPx, scan: r.scan, scanMix: r.scanMix, scale: r.scale, ms: r.ms,
      thumbSize: { w: r.thumb.w, h: r.thumb.h }, previewSize: { w: r.preview.w, h: r.preview.h },
    };
    p.result = res;
    setThumb(p, r.thumb.png);
    previews.set(key, r.preview.png);
    while (previews.size > 6) previews.delete(previews.keys().next().value as string);
    p.status = 'changed';
    oddSizes(p);
    p.secs = (performance.now() - t0) / 1000;
    void rr.cachePut(key, res, r.thumb.png, r.preview.png).catch(() => {});
  } catch (e) {
    if (q.job !== job) return; // stopped on purpose (the engine was closed) or compared again
    const m = String((e as Error)?.message || e);
    // the engine went down during this sheet (it may have been another call's fault), the file
    // stopped reading part way (network), or it was saved over meanwhile: once more
    const fatal = !!(e as { fatal?: boolean }).fatal;
    if (m !== TOO_LONG && (/restart/.test(m) || fatal || m === READ_FAIL || m === CHANGED) && !q.tries) {
      q.tries = 1;
      // a network drive that dropped, or a file being saved: give it a moment
      if (m === READ_FAIL || m === CHANGED) await new Promise((r) => setTimeout(r, 2000));
      if (q.job !== job) return;
      return comparePairJob(c, p, s, fresh);
    }
    p.status = 'error';
    p.error = fatal ? 'The engine ran out of memory on this sheet (very large drawing). Try again at a lower checking resolution (Settings).'
      : /restarted|was closed/.test(m) ? 'The engine stopped while comparing this sheet (twice). Try again.' : m;
  }
}

/** pages of wildly different sizes (a drawing against a 3 x 3 pt page): not a comparison anyone
 *  can trust - the old one is shrunk to nothing and "no change" comes out. A problem instead. */
function oddSizes(p: Pair) {
  const r = p.result;
  if (!r) return;
  const a = r.oldSize.w * r.oldSize.h, b = r.newSize.w * r.newSize.h;
  if (!(a > 0 && b > 0) || Math.max(a / b, b / a) <= 20) return;
  const mm = (s: { w: number; h: number }) => `${Math.round((s.w * 25.4) / 72)} × ${Math.round((s.h * 25.4) / 72)} mm`;
  p.status = 'error';
  p.error = `The old and new pages are very different sizes (${mm(r.oldSize)} against ${mm(r.newSize)}) - is it the same drawing? Compare them by eye.`;
}

/** a comparison left: its pictures' memory is given back */
function dropPictures(s: Session | null) {
  for (const p of s?.pairs || []) if (p.thumbUrl) { URL.revokeObjectURL(p.thumbUrl); p.thumbUrl = undefined; }
}

function setThumb(p: Pair, png: Uint8Array) {
  if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
  p.thumbUrl = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }));
}

/** overlay pictures made by the comparison, kept for the viewer's first look */
const previews = new Map<string, Uint8Array>();
export async function previewOf(p: Pair): Promise<Uint8Array | null> {
  if (!p.cacheKey) return null;
  return previews.get(p.cacheKey) || (await rr.cachePreview(p.cacheKey));
}

/** leave this comparison (Home): whatever it is doing - reading, pairing, comparing - ends */
export function leave() {
  runId++;
  queueGen++;
  for (const [, c] of running) { const n = workers.indexOf(c); if (n >= 0) void rr.engineKill('w' + n); }
  running.clear();
  // the sheets being compared: their answers (or the engine's end) are not wanted any more
  for (const p of (ui.session?.pairs || []) as QPair[]) if (p.status === 'running') { p.status = 'waiting'; p.job = 0; p.tries = 0; }
  // (how far it got, for the list of recent comparisons)
  if (ui.session && ui.session.pairs.length) void remember(ui.session);
}

/** stop comparing (what's done stays) */
export function stop() {
  const s = ui.session;
  if (!s || s.phase !== 'comparing') return;
  s.phase = 'stopped';
  queueGen++;
  for (const [, c] of running) { const n = workers.indexOf(c); if (n >= 0) void rr.engineKill('w' + n); }
  // (a sheet stopped on purpose starts its tries afresh: two quick Stop / Go on must not read as
  // an engine that keeps dying on it)
  for (const p of s.pairs as QPair[]) if (p.status === 'running') { p.status = 'waiting'; p.job = 0; p.tries = 0; }
  running.clear();
  void remember(s);
  bump();
  void sheetPictures(s, runId);
}
export function resume() {
  const s = ui.session;
  if (!s || s.phase !== 'stopped') return;
  s.phase = 'comparing';
  bump();
  void runQueue(s, runId);
}

// ---------------------------------------------------------------- title block / left-out spots

/**
 * Mark change areas that sit where most sheets of the same size changed (title block, revision
 * table, "issued for" stamps), revision-table wording, and spots the user left out; then each
 * pair's status. (Logic in titleblock.ts, shared with the tests.)
 */
export function classify(s: Session, opt: { why?: string; keep?: Set<string> } = {}) {
  const withResult = s.pairs.filter((p) => p.result);
  // (a ticked sheet that gains counted changes as more sheets come in - the title block rule
  // learns from all the sheets of a size - is not ticked any more: those changes weren't seen)
  // (a tick kept from last time - tickedReal set - is judged once, at the end, against the count it was ticked with
  //  (staleTicks): while the sheets come back the title block rule is still learning and the counts go up and down -
  //  a reopened comparison lost its ticks that way; ritual 17 Nov, e2e-journey)
  const before = new Map(withResult.filter((p) => p.reviewed && p.common && p.tickedReal === undefined).map((p) => [p, realAreas(p).length]));
  const cls = classifyAreas(withResult.map((p) => ({ size: p.result!.newSize, areas: p.result!.areas })), s.zones);
  withResult.forEach((p, i) => { p.common = cls[i].common; p.ignored = cls[i].ignored; });
  const unticked: string[] = [];
  for (const [p, n] of before) if (realAreas(p).length > n && !opt.keep?.has(p.id)) { p.reviewed = false; unticked.push(p.key); }
  if (unticked.length) toast(`${unticked.slice(0, 3).join(', ')}${unticked.length > 3 ? ' …' : ''}: ${opt.why || 'more changes count now that more sheets are compared'} - not ticked off any more`, 'warn', 10000);
  for (const p of s.pairs) {
    if (!p.result || p.status === 'error' || p.status === 'identical' || p.status === 'running' || p.status === 'waiting') continue;
    const n = p.result.areas.length;
    if (!n) p.status = 'same';
    else if (!realAreas(p).length) p.status = 'titleonly';
    else p.status = 'changed';
  }
}

/** leave a spot out on every sheet of this size (or all sizes): says what that hides, with Undo */
export function addZone(p: Pair, box: number[], allSizes = false) {
  const s = ui.session;
  if (!s || !p.result) return;
  const { w, h } = p.result.newSize;
  const before = new Map(s.pairs.map((x) => [x, realAreas(x).length]));
  const z: Zone = { group: allSizes ? '*' : sizeGroup(p.result.newSize), box: [box[0] / w, box[1] / h, box[2] / w, box[3] / h] };
  // (sheets ticked off before: their changes under the spot were seen - bringing it back later
  // doesn't untick them)
  seenUnder.set(z, new Set(s.pairs.filter((x) => x.reviewed).map((x) => x.id)));
  s.zones.push(z);
  classify(s); remember(s); bump();
  let n = 0, m = 0;
  for (const [x, k] of before) { const d = k - realAreas(x).length; if (d > 0) { n += d; m++; } }
  const big = (box[2] - box[0]) * (box[3] - box[1]) > (100 * 72 / 25.4) ** 2;
  toast(`Left out: ${n} change${n === 1 ? '' : 's'} hidden on ${m} sheet${m === 1 ? '' : 's'}${big ? ' - a big spot, check it is only title block' : ''}`, m > 1 || big ? 'warn' : undefined, 10000,
    { label: 'Undo', run: () => removeZones([z]) });
}
/** spots left out that hide this change area */
export function zonesOver(p: Pair, i: number): Zone[] {
  const s = ui.session;
  if (!s || !p.result) return [];
  return s.zones.filter((z) => classifyAreas([{ size: p.result!.newSize, areas: p.result!.areas }], [z])[0].ignored[i]);
}
/** per spot left out: the sheets that were ticked off when it was (session only) */
const seenUnder = new WeakMap<Zone, Set<string>>();
const backWhy = (n: number) => `the change${n === 1 ? '' : 's'} under the spot${n === 1 ? '' : 's'} brought back count${n === 1 ? 's' : ''} again`;
const seenOf = (zs: Zone[]) => new Set(zs.flatMap((z) => [...(seenUnder.get(z) || [])]));
export function removeZones(zs: Zone[]) {
  const s = ui.session;
  if (!s) return;
  s.zones = s.zones.filter((z) => !zs.includes(z));
  classify(s, { why: backWhy(zs.length), keep: seenOf(zs) }); remember(s); bump();
}
export function clearZones() {
  const s = ui.session;
  if (!s) return;
  const was = s.zones;
  s.zones = [];
  classify(s, { why: backWhy(was.length), keep: seenOf(was) }); remember(s); bump();
  if (was.length) toast(`${was.length} left-out spot${was.length === 1 ? '' : 's'} brought back`, undefined, 8000, { label: 'Undo', run: () => { s.zones = [...was, ...s.zones]; classify(s); remember(s); bump(); } });
}

// ---------------------------------------------------------------- recent comparisons

export interface Recent { old: { paths: string[]; recursive: boolean }; neu: { paths: string[]; recursive: boolean }; when: number; label: string; counts?: Record<string, number>; zones?: Zone[]; reviewed?: string[]; manual?: Manual }

/** pairs made or split by hand last time, made again (when both sheets are still there) */
function applyManual(plans: PairPlan[], m: Manual): PairPlan[] {
  let out = plans.slice();
  for (const [o, n] of m.split) {
    const k = out.findIndex((p) => p.old && p.neu && refKey(p.old) === o && refKey(p.neu) === n);
    if (k >= 0) { const p = out[k]; out.splice(k, 1, { old: null, neu: p.neu, how: 'none' }, { old: p.old, neu: null, how: 'none' }); }
  }
  for (const [o, n] of m.hand) {
    const po = out.find((p) => p.old && refKey(p.old) === o), pn = out.find((p) => p.neu && refKey(p.neu) === n);
    if (!po || !pn || po === pn) continue;
    const old = po.old!, neu = pn.neu!;
    const at = Math.min(out.indexOf(po), out.indexOf(pn));
    out = out.flatMap((p) => p === po ? (p.neu ? [{ old: null, neu: p.neu, how: 'none' as const }] : []) : p === pn ? (p.old ? [{ old: p.old, neu: null, how: 'none' as const }] : []) : [p]);
    out.splice(at, 0, { old, neu, how: 'hand' });
  }
  return out;
}

/** the last save of the recent list: saves go one after the other (each reads the list, then
 *  writes it - two at once would lose one), and the home screen waits for it */
let saving: Promise<void> = Promise.resolve();
export const whenSaved = () => saving;
export function remember(s: Session): Promise<void> {
  saving = saving.then(() => rememberNow(s), () => rememberNow(s));
  return saving;
}
async function rememberNow(s: Session) {
  try {
    const st = await rr.settings();
    const list: Recent[] = (st.recent || []).filter((r: Recent) => !(same(r.old.paths, s.oldSet.paths) && same(r.neu.paths, s.newSet.paths)));
    const counts: Record<string, number> = {};
    for (const p of s.pairs) counts[p.status] = (counts[p.status] || 0) + 1;
    // how far the review got (shown in the list of recent comparisons)
    counts.toReview = s.pairs.filter(needsReview).length;
    counts.ticked = s.pairs.filter((p) => needsReview(p) && p.reviewed).length;
    // not compared (stopped, left, closed): the list must not say "all reviewed"
    counts.pending = s.pairs.filter((p) => p.status === 'waiting' || p.status === 'running').length;
    list.unshift({
      old: { paths: s.oldSet.paths, recursive: s.oldSet.recursive }, neu: { paths: s.newSet.paths, recursive: s.newSet.recursive },
      when: Date.now(), label: `${s.oldSet.label} → ${s.newSet.label}`, counts, zones: s.zones, manual: s.manual,
      reviewed: s.pairs.filter((p) => p.reviewed).map(tickKey),
    });
    await rr.setSettings({ recent: list.slice(0, 12) });
  } catch { /* not important */ }
}
/** a tick as remembered: the two sheets + how many changes counted when it was ticked. A count kept
 *  from last time stays until this run has checked it (staleTicks), never the new count; a tick on a
 *  sheet that could not be compared saw no changes (@0). */
export const tickKey = (p: Pair) => reviewKey(p) + (p.tickedReal !== undefined ? '@' + p.tickedReal : p.status === 'error' ? '@0' : p.result && p.status === 'changed' ? '@' + realAreas(p).length : '');
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x.toLowerCase() === b[i].toLowerCase());
/** the remembered comparison of these two issues, if any */
async function recentFor(o: SetInfo, n: SetInfo): Promise<Recent | null> {
  try {
    const st = await rr.settings();
    return (st.recent || []).find((r: Recent) => same(r.old.paths, o.paths) && same(r.neu.paths, n.paths) && r.old.recursive === o.recursive && r.neu.recursive === n.recursive) || null;
  } catch { return null; }
}

// ---------------------------------------------------------------- pairing by hand

/** join an unpaired old sheet with an unpaired new one and compare them */
export function pairByHand(a: Pair, b: Pair) {
  const s = ui.session;
  if (!s) return;
  const old = a.old || b.old, neu = a.neu || b.neu;
  if (!old || !neu) return;
  const at = Math.min(s.pairs.indexOf(a), s.pairs.indexOf(b));
  s.pairs = s.pairs.filter((p) => p !== a && p !== b);
  const ko = refKey(old), kn = refKey(neu);
  s.manual.split = s.manual.split.filter(([o, n]) => o !== ko && n !== kn);
  s.manual.hand = s.manual.hand.filter(([o, n]) => o !== ko && n !== kn);
  s.manual.hand.push([ko, kn]);
  void remember(s);
  const p = planToPairPublic({ old, neu, how: 'hand' }, at);
  s.pairs.splice(at, 0, p);
  ui.selected = p.id; ui.area = -1;
  bump();
  void rerun(p);
}
/** split a pair that isn't the same sheet into a removed and a new sheet */
export function unpair(p: Pair) {
  const s = ui.session;
  if (!s || !p.old || !p.neu) return;
  const at = s.pairs.indexOf(p);
  const a = planToPairPublic({ old: p.old, neu: null, how: 'none' }, at), b = planToPairPublic({ old: null, neu: p.neu, how: 'none' }, at + 1);
  s.pairs.splice(at, 1, b, a);
  const ko = refKey(p.old), kn = refKey(p.neu);
  s.manual.hand = s.manual.hand.filter(([o, n]) => !(o === ko && n === kn));
  // (also after a pair made by hand: the names may pair them again by themselves next time)
  if (!s.manual.split.some(([o, n]) => o === ko && n === kn)) s.manual.split.push([ko, kn]);
  void remember(s);
  ui.selected = b.id; ui.area = -1;
  classify(s);
  bump();
  // pictures of the two sheets on their own (the overview)
  void sheetPictures(s, runId);
}
export const planToPairPublic = (p: PairPlan, i: number) => planToPair(p, i);
