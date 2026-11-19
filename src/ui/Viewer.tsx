// The sheet view: the comparison picture (overlay: removed red, added blue, unchanged grey),
// side by side, or one issue alone; change areas boxed and numbered. Wheel = zoom, drag = pan.
// The first look is the picture the comparison made (instant); zoomed in, sharp pictures of
// what is on screen are drawn by the view engine.
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { ui, bump, realAreas, areaLabels, moveTitle, type Pair } from './model';
import { viewer, pooled, onEngineRestart } from './engines';
import { fileArg, type EngineClient } from '../engine/rpc';
import { engineFor, shown as shownOn, backEngine, has, anyHas, opened as openedOn, notOpened, keepPairs, letGoIfHeavy, putWarm, takeWarm, releaseWarm, type Warm } from './viewpool';
import { SUPERSEDED } from '../engine/rpc';
import { previewOf, addZone } from './runner';
import { Icon } from './icons';
import { paperTint, TINT, type Spot } from './highlight';
import { refade } from './refade';

export type Mode = 'overlay' | 'side' | 'old' | 'new';

interface View { z: number; tx: number; ty: number }
interface Pic { bmp: ImageBitmap; x: number; y: number; w: number; h: number; mode: string; fade?: number; preview?: boolean }

/** a number per comparison result: the same pair compared again ("Again", "Try again") is a new one */
const resIds = new WeakMap<object, number>();
let resSeq = 0;
const resId = (r: object | undefined) => { if (!r) return 0; let n = resIds.get(r); if (!n) resIds.set(r, (n = ++resSeq)); return n; };

const ID = [1, 0, 0, 1, 0, 0];
/** going to a change zooms in at most this far (screen pixels per point: 2.5 mm text ~35 px) - some
 *  of the drawing around it stays in sight */
const AREA_ZOOM_MAX = 5;
/** the next sheet is made ready this long after arriving at one (ms - see makeReady) */
const READY_AFTER = 3000;
/** tiles for the next sheet are cut only after this long on a sheet (ms - see makeReady) */
const CUT_AFTER = 8000;
/** the highlighter's smallest fill (screen pixels): on a whole A0 sheet a 1 mm change is about 1 px */
const HL_MIN = 24;
/** the zoom the user chose (wheel, + / -) on a change, as a share of the zoom the app picked for
 *  it: the next changes are shown that much closer / farther too (a zoom on the whole sheet, with
 *  no change chosen, is not remembered). 0 (whole sheet) forgets it; Esc keeps it */
let prefRatio: number | null = null;
const dpr = () => window.devicePixelRatio || 1;

/** the sheet N goes to after this one's last change, and the change it opens at (-1: whole sheet) */
export interface NextUp { pair: Pair; area: number }

export function Viewer({ pair, mode, fade, flicker, onMode, next }: { pair: Pair | null; mode: Mode; fade: number; flicker: boolean; onMode: (m: Mode) => void; next?: NextUp | null }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const cv2 = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const view = useRef<View>({ z: 0, tx: 0, ty: 0 });
  const base = useRef<Map<string, Pic>>(new Map());
  /** the comparison's own picture (PNG) of the open pair: faded to the slider here (refade.ts) */
  const previewPng = useRef<Uint8Array | null>(null);
  const detail = useRef<Map<string, Pic>>(new Map());
  const gen = useRef(0);
  const [, force] = useState(0);
  const [flickOld, setFlickOld] = useState(false);
  const [busy, setBusy] = useState(false);
  /** the view engine could not open the pair's files (shown, with Try again - RR-032) */
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; area: number } | null>(null);
  // the menu stays inside the viewer (opened near its right or bottom edge: moved in)
  const menuEl = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const m = menuEl.current, w = wrap.current;
    if (!m || !w || !menu) return;
    m.style.left = Math.max(6, Math.min(menu.x, w.clientWidth - m.offsetWidth - 6)) + 'px';
    m.style.top = Math.max(6, Math.min(menu.y, w.clientHeight - m.offsetHeight - 6)) + 'px';
  }, [menu]);
  const miniRect = useRef<SVGRectElement>(null);
  const deskFor = useRef({ theme: '', bg: '' });
  const opened = useRef<string>('');
  /** when the open pair was opened (tiles for the next sheet are cut only after a while here) */
  const arrivedAt = useRef(0);
  /** the comparison's own picture of the open pair is on its way (the whole sheet is not drawn meanwhile) */
  const previewComing = useRef(false);
  /** the view engine that draws the open pair (two take turns - see viewpool.ts) */
  const eng = useRef<EngineClient>(viewer);
  // the view engine started afresh (its open files are gone): open the pair again - unless it went
  // down on this very pair twice (a sheet too heavy to draw here: the comparison's own picture stays)
  const [epoch, setEpoch] = useState(0);
  const shown = useRef('');
  const downs = useRef(new Map<string, number>());
  useEffect(() => onEngineRestart((c, planned) => {
    // (the other view engine: what it made ready is gone - viewpool.ts forgets it)
    if (c !== eng.current) return;
    // (a restart for its memory - T22 - is not the sheet's doing: no "down", never "Too heavy" for it)
    if (shown.current && !planned) downs.current.set(shown.current, (downs.current.get(shown.current) || 0) + 1);
    opened.current = '';
    setEpoch((e) => e + 1);
  }), []);
  const tooHeavy = !!pair && (downs.current.get(pair.id) || 0) >= 2;

  const r = pair?.result;
  const pageW = r?.newSize.w || pair?.neu?.w || pair?.old?.w || 1;
  const pageH = r?.newSize.h || pair?.neu?.h || pair?.old?.h || 1;
  const align = r?.align || ID;
  // (a file that couldn't be read is left out: the other one is shown)
  const hasOld = !!pair?.old && !pair.old.bad, hasNew = !!pair?.neu && !pair.neu.bad;
  // what is actually shown (a sheet only in one issue is shown on its own)
  // (no comparison result - still waiting, or it could not be compared: both sheets side by side)
  const eff: Mode = !hasOld ? 'new' : !hasNew ? 'old' : !r && mode === 'overlay' ? 'side' : mode;
  const showMode = (side: 0 | 1): 'overlay' | 'old' | 'new' => (eff === 'side' ? (side === 0 ? 'old' : 'new') : eff === 'overlay' && flicker ? (flickOld ? 'old' : 'new') : (eff as 'overlay' | 'old' | 'new'));

  // ---------------------------------------------------------------- size
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const paneW = eff === 'side' ? Math.floor((size.w - 2) / 2) : size.w;

  /** the whole sheet (PW x PH points) in a pane vw x vh */
  const fitIn = (vw: number, vh: number, PW: number, PH: number): View => {
    const m = 24;
    const z = Math.max(0.01, Math.min((vw - 2 * m) / PW, (vh - 2 * m) / PH));
    return { z, tx: (vw - PW * z) / 2, ty: (vh - PH * z) / 2 };
  };
  const fitFor = (pw: number, ph: number): View => fitIn(pw, ph, pageW, pageH);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fitView = useCallback((): View => fitFor(paneW, size.h), [paneW, size.h, pageW, pageH]);

  // the sheet view closed: what was made ready for the next sheet goes too - and what comes back
  // after (a make-ready still running) is let go at once
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; releaseWarm(); }; }, []);

  // ---------------------------------------------------------------- a new pair
  const lastShown = useRef('');
  useEffect(() => {
    gen.current++;
    // (a picture asked for the sheet before is not drawn into this one - RR-026)
    clearTimeout(timer.current);
    // (a load of the sheet before that is still running no longer owns the busy badge - RR-044)
    setBusy(false);
    setOpenErr(null);
    for (const p of base.current.values()) p.bmp.close();
    for (const p of detail.current.values()) p.bmp.close();
    base.current.clear(); detail.current.clear();
    previewPng.current = null;
    previewComing.current = false;
    view.current = fitView();
    setMenu(null);
    shown.current = pair?.id || '';
    arrivedAt.current = Date.now();
    const again = !!pair && lastShown.current === pair.id;
    lastShown.current = pair?.id || '';
    if (!pair) { force((x) => x + 1); return; }
    const my = gen.current;
    // the engine that has this pair open (made ready by the other one), else the one on screen
    eng.current = engineFor(pair.id);
    shownOn(pair.id, eng.current);
    // pictures made ahead for this pair (viewpool.ts): the first look is sharp at once - not after
    // "Again" (they were drawn from the files as they were before)
    if (again) releaseWarm(pair.id); else adopt(pair.id);
    (async () => {
      // the comparison's own picture first: an instant look - not held up by the view engine
      // (busy with another sheet's pictures, it left the sheet blank for seconds)
      if (pair.result) {
        // (while it comes - and is faded to the slider - the whole sheet is not drawn by the engine)
        previewComing.current = true;
        try {
          const png = await previewOf(pair).catch(() => null);
          if (png && my === gen.current) {
            const bmp = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }));
            if (my !== gen.current) { bmp.close(); return; }
            previewPng.current = png;
            // (its greys drawn as the engine draws them at the slider's fade - see refade.ts)
            const fresh = await refaded(png, fade).catch(() => null);
            if (my !== gen.current) { bmp.close(); fresh?.close(); return; }
            if (fresh) bmp.close();
            base.current.set('overlay', { bmp: fresh || bmp, x: 0, y: 0, w: pageW, h: pageH, mode: 'overlay', fade: fresh ? fade : -1, preview: true });
            force((x) => x + 1);
          }
        } finally { if (my === gen.current) previewComing.current = false; }
      }
      if (my !== gen.current) return;
      // (opened again when a file that could not be read reads now - "Try again" - and when the pair
      //  was compared again: the engine reads its files afresh if they changed - RR-029 / RR-031)
      const e = eng.current;
      const openKey = `${e.name}|${pair.id}|${hasOld}|${hasNew}|${resId(pair.result)}`;
      if (!tooHeavy && opened.current !== openKey) {
        opened.current = openKey;
        const err = await e.call('viewOpen', [pair.id, pair.old && !pair.old.bad ? fileArg(pair.old.file) : null, pair.neu && !pair.neu.bad ? fileArg(pair.neu.file) : null, keepPairs()]).then(() => null, (x: unknown) => String((x as Error)?.message || x));
        if (err !== null) {
          // (said, with Try again - not a blank sheet that looks like the drawing; and the pool no
          //  longer counts the pair as open there)
          opened.current = '';
          notOpened(e, pair.id);
          if (my === gen.current && !/superseded/.test(err)) setOpenErr(err);
          return;
        }
      }
      if (my !== gen.current) return;
      if (!tooHeavy) requestPictures();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair?.id, pair?.result, epoch, hasOld, hasNew]);

  // the pane changed shape (window resized, side by side switched): the whole sheet stays the
  // whole sheet; zoomed in, the same spot stays in the middle at the same zoom
  const lastPane = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const prev = lastPane.current;
    if (prev && (prev.w !== paneW || prev.h !== size.h)) {
      // (the whole sheet for the pane before - or already for this one: a result that arrived for
      //  the open sheet fitted it to the new pane first, then the pane changed from side by side)
      const v = view.current, f0 = fitFor(prev.w, prev.h), f1 = fitFor(paneW, size.h);
      if (Math.abs(v.z - f0.z) <= f0.z * 0.02 || (Math.abs(v.z - f1.z) <= f1.z * 0.02 && Math.abs(v.tx - f1.tx) < 2 && Math.abs(v.ty - f1.ty) < 2)) view.current = fitView();
      else { const cx = (prev.w / 2 - v.tx) / v.z, cy = (prev.h / 2 - v.ty) / v.z; view.current = { z: v.z, tx: paneW / 2 - cx * v.z, ty: size.h / 2 - cy * v.z }; }
    }
    lastPane.current = { w: paneW, h: size.h };
    requestPictures();
    force((x) => x + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneW, size.h, eff]);

  // ---------------------------------------------------------------- pictures from the engine
  const timer = useRef(0);
  // (the viewer as it is when the pictures are asked for: a request made before "Again" or another
  //  sheet uses that sheet's result - and is dropped: RR-026)
  const loadNow = useRef(loadPictures);
  loadNow.current = loadPictures;
  const requestPictures = useCallback(() => {
    clearTimeout(timer.current);
    const g = gen.current;
    timer.current = window.setTimeout(() => { if (g === gen.current) void loadNow.current(g); }, 140);
  }, []);

  /** the zoom of the whole-sheet picture (base) of a sheet PW x PH points */
  function baseZoom(PW: number, PH: number) {
    return Math.min(3, Math.max(0.05, Math.min((paneW * dpr()) / PW, (size.h * dpr()) / PH)) * 1.25);
  }
  /** the part of a sheet (PW x PH points) on screen in view v: [x0, y0, x1, y1] points, or null */
  function onScreen(v: View, PW: number, PH: number): number[] | null {
    const x0 = Math.max(0, -v.tx / v.z), y0 = Math.max(0, -v.ty / v.z);
    const x1 = Math.min(PW, (paneW - v.tx) / v.z), y1 = Math.min(PH, (size.h - v.ty) / v.z);
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
  }

  async function loadPictures(my: number) {
    if (!pair || my !== gen.current) return;
    // (the files could not be opened, or the sheet is too heavy to draw here: only the comparison's
    //  own picture - it still follows the Fade slider)
    const previewOnly = !!openErr || (downs.current.get(pair.id) || 0) >= 2;
    const v = view.current;
    const modes = new Set<'overlay' | 'old' | 'new'>();
    if (eff === 'side') { modes.add('old'); modes.add('new'); } else if (eff === 'overlay' && flicker) { modes.add('old'); modes.add('new'); } else modes.add(eff as 'overlay' | 'old' | 'new');
    setBusy(true);
    try {
      for (const m of modes) {
        // whole sheet at about screen size (the base) - again when the fade slider moved
        const had = base.current.get(m);
        if (m === 'overlay' && had?.preview && had.fade !== fade && previewPng.current) {
          // the slider moved: the comparison's picture faded here (instant) - not the whole sheet
          // drawn again by the engine (7-9 s on a dense sheet, with every close look queued behind)
          const bmp = await refaded(previewPng.current, fade).catch(() => null);
          if (!bmp || my !== gen.current) { bmp?.close(); return; }
          base.current.get(m)?.bmp.close();
          base.current.set(m, { ...had, bmp, fade });
          force((x) => x + 1);
        } else if (m === 'overlay' && !had && previewComing.current) {
          // (the comparison's own picture is on its way: asked for again once it is here)
          continue;
        } else if (previewOnly) {
          continue;
        } else if (!had || (m === 'overlay' && had.fade !== fade)) {
          if (my !== gen.current) return;
          const zf = baseZoom(pageW, pageH);
          const w = Math.round(pageW * zf), h = Math.round(pageH * zf);
          // (lanes: a newer picture of the same kind makes this one pointless - the engine skips it)
          const bmp = await eng.current.call<ImageBitmap>('view', [pair.id, pair.old?.page ?? 0, pair.neu?.page ?? 0, align, m, zf, [0, 0, w, h], r?.settings || ui.settings, fade, !!r?.scan, m === 'overlay' ? r?.parts : undefined], undefined, 'base|' + m).catch(() => null);
          if (!bmp || my !== gen.current) { bmp?.close(); return; }
          base.current.get(m)?.bmp.close();
          base.current.set(m, { bmp, x: 0, y: 0, w: pageW, h: pageH, mode: m, fade });
          force((x) => x + 1);
        }
        // sharp picture of what is on screen when zoomed past the base
        const b = base.current.get(m);
        if (!b || previewOnly) continue;
        const baseZ = b.bmp.width / pageW;
        const zr = v.z * dpr();
        // (the whole sheet on a large high-resolution screen: the comparison's own picture, a little
        //  soft, rather than the whole dense sheet drawn again - 7-9 s, and every close look after
        //  it waited)
        const enough = b.preview && v.z <= fitView().z * 1.2 ? 1.6 : 1.15;
        if (zr <= baseZ * enough) { const d = detail.current.get(m); if (d) { d.bmp.close(); detail.current.delete(m); } continue; }
        const on = onScreen(v, pageW, pageH);
        if (!on) continue;
        const [x0, y0, x1, y1] = on;
        const have = detail.current.get(m);
        if (have && Math.abs(have.bmp.width / have.w - zr) < 0.01 && have.x <= x0 + 0.5 && have.y <= y0 + 0.5 && have.x + have.w >= x1 - 0.5 && have.y + have.h >= y1 - 0.5) continue;
        const rect = [x0 * zr, y0 * zr, (x1 - x0) * zr, (y1 - y0) * zr].map((n) => Math.round(n));
        if (rect[2] < 2 || rect[3] < 2) continue;
        // (another sheet opened meanwhile: nothing more is asked for this one - a call for it would
        //  make the new sheet's own call in its lane pointless)
        if (my !== gen.current) return;
        // (a page MuPDF draws comes back with a margin round the screen - see host.ts grown)
        const res = await eng.current.call<ImageBitmap | { pic: ImageBitmap; rect: number[] }>('view', [pair.id, pair.old?.page ?? 0, pair.neu?.page ?? 0, align, m, zr, rect, r?.settings || ui.settings, fade, !!r?.scan, m === 'overlay' ? r?.parts : undefined, true], undefined, 'detail|' + m).catch(() => null);
        if (!res) continue;
        const bmp = res instanceof ImageBitmap ? res : res.pic;
        const got = res instanceof ImageBitmap ? rect : res.rect;
        if (my !== gen.current || Math.abs(view.current.z * dpr() - zr) > 1e-6) { bmp.close(); continue; }
        have?.bmp.close();
        detail.current.set(m, { bmp, x: got[0] / zr, y: got[1] / zr, w: got[2] / zr, h: got[3] / zr, mode: m });
        force((x) => x + 1);
      }
    } finally { if (my === gen.current) setBusy(false); }
  }

  // tests (window.__rrSharp): is what is on screen drawn sharp - the picture that is there is good
  // enough for this zoom and covers the screen (tests/e2e-speed.mjs times the review with it)
  useEffect(() => {
    (window as unknown as { __rrSharp?: () => unknown }).__rrSharp = () => {
      if (!pair) return { pair: null, sharp: false };
      const v = view.current, zr = v.z * dpr();
      const panes = eff === 'side' ? ['old', 'new'] : [eff === 'overlay' && flicker ? 'new' : eff];
      const sharp = panes.every((m) => {
        const b = base.current.get(m);
        if (!b || (m === 'overlay' && b.fade !== fade)) return false;
        const enough = b.preview && v.z <= fitView().z * 1.2 ? 1.6 : 1.15;
        if (zr <= (b.bmp.width / pageW) * enough) return true;
        const on = onScreen(v, pageW, pageH);
        if (!on) return true;
        const d = detail.current.get(m);
        return !!d && Math.abs(d.bmp.width / d.w - zr) < 0.01 && d.x <= on[0] + 0.5 && d.y <= on[1] + 0.5 && d.x + d.w >= on[2] - 0.5 && d.y + d.h >= on[3] - 0.5;
      });
      return { pair: pair.key, area: ui.area, sharp };
    };
  });

  // fade changed: overlay pictures are redrawn by the engine
  useEffect(() => {
    const b = base.current.get('overlay');
    if (b && pair?.result) { /* the comparison's picture has its own fading; detail follows the slider */ }
    const d = detail.current.get('overlay');
    if (d) { d.bmp.close(); detail.current.delete('overlay'); }
    requestPictures();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fade]);

  /** pictures made ahead for the open pair, taken in where nothing better is there yet */
  function adopt(id: string): boolean {
    let took = false;
    for (const w of takeWarm(id)) {
      const d = detail.current.get(w.mode);
      if (w.kind === 'base' && w.mode !== 'overlay' && !base.current.has(w.mode)) { base.current.set(w.mode, { bmp: w.bmp, x: 0, y: 0, w: pageW, h: pageH, mode: w.mode, fade: w.fade }); took = true; }
      else if (w.kind === 'detail' && (w.mode !== 'overlay' || w.fade === fade) && (!d || Math.abs(d.bmp.width / d.w - w.zr) > 0.01)) {
        d?.bmp.close();
        detail.current.set(w.mode, { bmp: w.bmp, x: w.rect[0] / w.zr, y: w.rect[1] / w.zr, w: w.rect[2] / w.zr, h: w.rect[3] / w.zr, mode: w.mode });
        took = true;
      } else w.bmp.close();
    }
    return took;
  }

  // ---------------------------------------------------------------- the next sheet made ready
  // While this sheet is looked at, the other view engine opens the sheet N goes to next, reads its
  // pages in and draws the pictures going there asks for first (viewpool.ts) - in its own process,
  // so nothing here waits for it. Done once per sheet and way of looking.
  const warmed = useRef('');
  /** sheets that could not be made ready (not tried again: going there draws them as before) */
  const warmFailed = useRef(new Set<string>());
  useEffect(() => {
    if (!pooled || !pair || !next || busy || next.pair.id === pair.id) return;
    // (not at once: making the next one ready lets go of the sheet before on that engine - a quick
    //  step back finds it still open)
    const t = window.setTimeout(() => void makeReady(next), Math.max(400, arrivedAt.current + READY_AFTER - Date.now()));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // (prefRatio: the zoom chosen with the wheel carries over to the next sheet's first change)
  }, [pair?.id, next?.pair.id, next?.area, next?.pair.result, busy, eff, flicker, fade, paneW, size.h, prefRatio]);

  // (the viewer as it is now - makeReady's answer can come after another sheet was opened)
  const adoptNow = useRef(adopt);
  adoptNow.current = adopt;
  const askNow = useRef(requestPictures);
  askNow.current = requestPictures;

  /** the way of looking now: what the pictures made ahead depend on */
  const lookNow = useRef('');
  lookNow.current = [mode === 'side' || (mode === 'overlay' && flicker) ? 'old+new' : mode, fade, paneW, size.h, dpr(), prefRatio ?? 0].join('|');
  const look = () => lookNow.current;

  async function makeReady(nx: NextUp) {
    const e = backEngine();
    const np = nx.pair, nr = np.result;
    if (!e || !nr || !np.old || !np.neu || np.old.bad || np.neu.bad || (downs.current.get(np.id) || 0) > 0 || warmFailed.current.has(np.id)) return;
    // (open on the engine on screen already - going back and forth: it is read in there)
    if (anyHas(np.id) && !has(e, np.id)) return;
    const PW = nr.newSize.w, PH = nr.newSize.h;
    // (that sheet has both issues and a result: it is shown the way chosen)
    const modes: ('overlay' | 'old' | 'new')[] = mode === 'side' || (mode === 'overlay' && flicker) ? ['old', 'new'] : [mode];
    const lk = look();
    const key = [np.id, nx.area, lk, e.name].join('|');
    if (warmed.current === key) return;
    warmed.current = key;
    const pages = [np.old.page ?? 0, np.neu.page ?? 0];
    const settings = nr.settings || ui.settings;
    const jobs: unknown[][] = [];
    const meta: Omit<Warm, 'bmp'>[] = [];
    // whole sheets (the overlay's is the comparison's own picture - nothing to draw)
    for (const m of modes) {
      if (m === 'overlay') continue;
      const zf = baseZoom(PW, PH), w = Math.round(PW * zf), h = Math.round(PH * zf);
      jobs.push([np.id, pages[0], pages[1], nr.align, m, zf, [0, 0, w, h], settings, fade, !!nr.scan, undefined, false]);
      meta.push({ pairId: np.id, kind: 'base', mode: m, zr: zf, rect: [0, 0, w, h], fade });
    }
    // the close look at the change it opens at (only past what the whole-sheet picture shows)
    const a = nx.area >= 0 ? nr.areas[nx.area] : undefined;
    if (a) {
      const v = viewOn(a.box, PW, PH), zr = v.z * dpr(), on = onScreen(v, PW, PH);
      // (the comparison's own picture: ~2400 px across - see job.ts)
      const pvZ = nr.scale / Math.max(1, Math.round((Math.max(PW, PH) * nr.scale) / 2400));
      if (on) {
        const rect = [on[0] * zr, on[1] * zr, (on[2] - on[0]) * zr, (on[3] - on[1]) * zr].map((n) => Math.round(n));
        for (const m of modes) {
          const bz = m === 'overlay' ? pvZ : baseZoom(PW, PH);
          if (zr <= bz * (m === 'overlay' && v.z <= fitIn(paneW, size.h, PW, PH).z * 1.2 ? 1.6 : 1.15) || rect[2] < 2 || rect[3] < 2) continue;
          jobs.push([np.id, pages[0], pages[1], nr.align, m, zr, rect, settings, fade, !!nr.scan, m === 'overlay' ? nr.parts : undefined, true]);
          meta.push({ pairId: np.id, kind: 'detail', mode: m, zr, rect, fade });
        }
      }
    }
    try {
      if (!has(e, np.id)) {
        try {
          // (T22 B: past a bar for a sheet it will not keep - it lets go of all it holds and starts afresh first. It
          //  notes np as opening on e before its first wait - M1 C3 - so it is called before openedOn, which would
          //  put out of the list the sheet it must look at)
          const going = letGoIfHeavy(e, np.id);
          // (known to be there before it is: going there meanwhile waits on this engine, not opens it twice)
          openedOn(e, np.id);
          await going;
          await e.call('viewOpen', [np.id, fileArg(np.old.file), fileArg(np.neu.file), keepPairs()]);
        } catch (err) { notOpened(e, np.id); throw err; }
      }
      const res = await e.call<unknown[]>('viewWarm', [np.id, pages[0], pages[1], modes[0] !== 'overlay', jobs], undefined, 'warm');
      const pics: Warm[] = res.map((x, i) => {
        const g = x as ImageBitmap | { pic: ImageBitmap; rect: number[] };
        return g instanceof ImageBitmap ? { ...meta[i], bmp: g } : { ...meta[i], rect: g.rect, bmp: g.pic };
      });
      // (another way of looking chosen meanwhile, or the window resized: let go)
      if (look() !== lk || !alive.current) { for (const p of pics) p.bmp.close(); return; }
      putWarm(e, pics);
      // (already there - it came before the pictures did: they are shown now - by the viewer as it is
      //  now, not as it was when this was asked for: another sheet, another size)
      if (shown.current === np.id && adoptNow.current(np.id)) { force((x) => x + 1); askNow.current(); }
      // a little later, still on this sheet: the pages of a heavy blended sheet cut into tiles, one
      // a call - 4-12 s each, so not while going there is likely; close looks then take a fraction
      // of a second there (nothing happens for other sheets)
      // (never on the engine drawing the screen: gone to that sheet meanwhile, its engine is the
      //  one on screen now, and a 4-12 s cut would hold up every picture)
      // (and only once this sheet has been looked at for a while: a cut can't be stopped, and going
      //  there in the middle of one waits for it - quick skipping through sheets never starts one)
      const here = shown.current;
      const mayCut = () => shown.current === here && here !== np.id && has(e, np.id) && backEngine() === e;
      if (mayCut()) window.setTimeout(async () => {
        for (const which of [0, 1] as const) {
          if (!mayCut()) return;
          await e.call('viewTiles', [np.id, which, pages[which]]).catch(() => false);
        }
      }, Math.max(2500, arrivedAt.current + CUT_AFTER - Date.now()));
    } catch (err) {
      // (not made ready: going there draws it as before - unless a newer call only made it pointless)
      if ((err as Error)?.message !== SUPERSEDED) warmFailed.current.add(np.id);
      else if (warmed.current === key) warmed.current = '';
    }
  }

  // the right-click menu belongs to one change: N / P (or another sheet) close it
  useEffect(() => { setMenu(null); }, [ui.area, pair?.id]);

  // Escape closes the right-click menu (and only that)
  useEffect(() => {
    if (!menu) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); setMenu(null); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [menu]);

  // flicker: swap old/new every 0.6 s
  useEffect(() => {
    if (!flicker) return;
    const t = setInterval(() => setFlickOld((x) => !x), 600);
    requestPictures();
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flicker]);

  // ---------------------------------------------------------------- drawing
  useEffect(() => { draw(); });
  function draw() {
    const panes: [HTMLCanvasElement | null, 0 | 1][] = eff === 'side' ? [[cv.current, 0], [cv2.current, 1]] : [[cv.current, 1]];
    for (const [c, side] of panes) {
      if (!c) continue;
      const D = dpr();
      const W = Math.round(paneW * D), H = Math.round(size.h * D);
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const g = c.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      // (the desk colour read once per theme: a style read per frame forced a style recalculation
      // on every pointer move while dragging)
      if (deskFor.current.theme !== ui.theme) deskFor.current = { theme: ui.theme, bg: getComputedStyle(c).getPropertyValue('--desk').trim() || '#e6ecea' };
      const bg = deskFor.current.bg;
      g.fillStyle = bg;
      g.fillRect(0, 0, W, H);
      if (!pair) continue;
      const v = view.current;
      g.setTransform(D, 0, 0, D, 0, 0);
      // the sheet
      g.save();
      g.shadowColor = 'rgba(9,48,47,0.22)'; g.shadowBlur = 14; g.shadowOffsetY = 3;
      g.fillStyle = '#fff';
      g.fillRect(v.tx, v.ty, pageW * v.z, pageH * v.z);
      g.restore();
      const m = showMode(side);
      const b = base.current.get(m) || (m !== 'overlay' ? null : null);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      if (b) g.drawImage(b.bmp, v.tx + b.x * v.z, v.ty + b.y * v.z, b.w * v.z, b.h * v.z);
      const d = detail.current.get(m);
      if (d) g.drawImage(d.bmp, v.tx + d.x * v.z, v.ty + d.y * v.z, d.w * v.z, d.h * v.z);
      // change areas
      if (r) drawAreas(g, v, m === 'old', m);
    }
    // where the screen is, on the little map of the sheet
    const mr = miniRect.current;
    if (mr) {
      const v = view.current;
      const x0 = Math.max(0, -v.tx / v.z), y0 = Math.max(0, -v.ty / v.z);
      const x1 = Math.min(pageW, (paneW - v.tx) / v.z), y1 = Math.min(pageH, (size.h - v.ty) / v.z);
      mr.setAttribute('x', String(x0)); mr.setAttribute('y', String(y0));
      mr.setAttribute('width', String(Math.max(0, x1 - x0))); mr.setAttribute('height', String(Math.max(0, y1 - y0)));
    }
  }

  function drawAreas(g: CanvasRenderingContext2D, v: View, oldPane = false, m: 'overlay' | 'old' | 'new' = 'overlay') {
    if (!pair || !r) return;
    // (on the old sheet as issued, what lies in a moved part is drawn where it was: its box moved
    //  back by the part's move)
    const back = (a: (typeof r.areas)[0]): number[] => {
      if (!oldPane) return a.box;
      let d = a.shift;
      if (!d) {
        const cx = (a.box[0] + a.box[2]) / 2, cy = (a.box[1] + a.box[3]) / 2;
        d = r.parts?.find((p) => p.rects.some((q) => cx >= q[0] && cx < q[2] && cy >= q[1] && cy < q[3]));
      }
      return d ? [a.box[0] - d.dx, a.box[1] - d.dy, a.box[2] - d.dx, a.box[3] - d.dy] : a.box;
    };
    const real = new Set(realAreas(pair));
    const labels = areaLabels(pair);
    const sel = ui.area;
    const fs = 11;
    const many = real.size > 30;
    g.font = `600 ${fs}px Inter Variable, Segoe UI, sans-serif`;
    // the highlighter (toolbar / H): the paper inside each change box goes pale yellow - first,
    // under every outline and number tag. A change too small to see on the whole sheet gets a dot
    // of HL_MIN screen pixels round it.
    if (ui.highlight) {
      const spots: Spot[] = [];
      r.areas.forEach((a, i) => {
        if (a.shift || !real.has(i)) return;
        const pad = 3, bx = back(a);
        let x = v.tx + bx[0] * v.z - pad, y = v.ty + bx[1] * v.z - pad, w = (bx[2] - bx[0]) * v.z + 2 * pad, h = (bx[3] - bx[1]) * v.z + 2 * pad;
        const dot = w < HL_MIN || h < HL_MIN;
        if (w < HL_MIN) { x -= (HL_MIN - w) / 2; w = HL_MIN; }
        if (h < HL_MIN) { y -= (HL_MIN - h) / 2; h = HL_MIN; }
        // (only what is on screen: one far off on each side made it read the whole canvas)
        if (x + w > 0 && y + h > 0 && x < paneW && y < size.h) spots.push({ x, y, w, h, dot });
      });
      // (a scan shown as issued: its paper is a light grey - 220-235 - not white)
      if (!moving.current && !flicker) paperTint(g, spots, dpr(), m !== 'overlay' && r.scan ? 200 : undefined);
      else {
        // moving (dragging, wheel) or flickering: the quick fill - blue ink a shade darker under it
        // for that moment; the exact tint comes back as soon as it stops (reading the canvas back
        // every frame made a high-resolution screen stutter)
        g.save();
        g.globalCompositeOperation = 'darken';
        g.fillStyle = `rgb(${TINT.join(',')})`;
        for (const p of spots) { roundRect(g, p.x, p.y, p.w, p.h, p.dot ? Math.min(p.w, p.h) / 2 : 4); g.fill(); }
        g.restore();
      }
    }
    // a view moved on the sheet: its drawing outlined dashed, with its number and how far - drawn
    // first, under the change boxes inside it (the label half see-through: the view's own title
    // may sit right there)
    r.areas.forEach((a, i) => {
      if (!a.shift || !real.has(i)) return;
      const on = i === sel, bx = back(a);
      // (a stretched part is a change of the drawing: the change colour, dashed)
      const rgb = a.shift.stretched ? '224,137,11' : '46,111,149';
      const x = v.tx + bx[0] * v.z - 4, y = v.ty + bx[1] * v.z - 4, w = (bx[2] - bx[0]) * v.z + 8, h = (bx[3] - bx[1]) * v.z + 8;
      g.save();
      g.setLineDash([9, 6]);
      g.lineWidth = on ? 2.4 : 1.4;
      g.strokeStyle = on ? `rgba(${rgb},1)` : `rgba(${rgb},0.85)`;
      if (on) { g.shadowColor = `rgba(${rgb},0.5)`; g.shadowBlur = 8; }
      roundRect(g, x, y, w, h, 6);
      g.stroke();
      g.restore();
      const label = `${labels[i]}  ${moveTitle(a.shift)}`;
      const tw = g.measureText(label).width + 10, th = fs + 6;
      // (kept in view when zoomed in on the part)
      // (below the "Old issue" / "New issue" tag where there is one)
      const top = eff === 'side' || eff !== 'overlay' || flicker ? 36 : 2;
      const lx = Math.min(Math.max(x, 2), Math.max(2, x + w - tw)), ly = Math.min(Math.max(y - th - 2 < top ? y + 2 : y - th - 2, top), Math.max(top, y + h - th - 2));
      g.fillStyle = on ? `rgba(${rgb},0.95)` : `rgba(${rgb},0.78)`;
      roundRect(g, lx, ly, tw, th, 3);
      g.fill();
      g.fillStyle = '#fff';
      g.fillText(label, lx + 5, ly + fs + 1);
    });
    r.areas.forEach((a, i) => {
      const isReal = real.has(i);
      if (a.shift || (!isReal && !ui.showCommon && i !== sel)) return;
      const pad = 3, bx = back(a);
      const x = v.tx + bx[0] * v.z - pad, y = v.ty + bx[1] * v.z - pad;
      const w = (bx[2] - bx[0]) * v.z + 2 * pad, h = (bx[3] - bx[1]) * v.z + 2 * pad;
      const on = i === sel;
      const col = !isReal ? 'rgba(110,125,122,0.9)' : on ? '#e0890b' : 'rgba(224,137,11,0.85)';
      g.save();
      if (!isReal) g.setLineDash([5, 4]);
      if (on) { g.shadowColor = 'rgba(224,137,11,0.55)'; g.shadowBlur = 10; }
      g.lineWidth = on ? 2.6 : many ? 1.1 : 1.6;
      g.strokeStyle = col;
      roundRect(g, x, y, w, h, 4);
      g.stroke();
      g.restore();
      // number tag (when there is room for it)
      if (!on && (many ? Math.min(w, h) < 46 : Math.min(w, h) < 14)) return;
      const label = labels[i];
      const tw = g.measureText(label).width + 8, th = fs + 5;
      const lx = x, ly = y - th - 1 < 0 ? y + 1 : y - th - 1;
      g.fillStyle = col;
      roundRect(g, lx, ly, tw, th, 3);
      g.fill();
      g.fillStyle = '#fff';
      g.fillText(label, lx + 4, ly + fs + 0.5);
    });
  }

  // ---------------------------------------------------------------- zoom to the selected area
  const lastArea = useRef<string>('');
  useEffect(() => {
    if (!pair || !r) return;
    const k = pair.id + ':' + ui.area;
    if (k === lastArea.current) return;
    lastArea.current = k;
    if (ui.area < 0 || !r.areas[ui.area]) return;
    zoomTo(r.areas[ui.area].box);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  /** the zoom the app picks for a change (box, points) on a sheet PW x PH points */
  function autoZoom(b: number[], PW = pageW, PH = pageH) {
    const bw = Math.max(b[2] - b[0], 20), bh = Math.max(b[3] - b[1], 20);
    return Math.max(fitIn(paneW, size.h, PW, PH).z, Math.min(AREA_ZOOM_MAX, (paneW * 0.55) / bw, (size.h * 0.55) / bh));
  }
  /** the view going to a change shows (also worked out for the next sheet, to make it ready) */
  function viewOn(b: number[], PW = pageW, PH = pageH): View {
    const bw = Math.max(b[2] - b[0], 20), bh = Math.max(b[3] - b[1], 20);
    // the user's own closer / farther when they chose one - but the change always fits on screen
    const fits = Math.min((paneW * 0.9) / bw, (size.h * 0.9) / bh);
    const auto = autoZoom(b, PW, PH);
    const z = Math.max(fitIn(paneW, size.h, PW, PH).z, prefRatio ? Math.min(auto * prefRatio, Math.max(fits, auto)) : auto);
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    return { z, tx: paneW / 2 - cx * z, ty: size.h / 2 - cy * z };
  }
  function zoomTo(b: number[]) {
    view.current = viewOn(b);
    force((x) => x + 1);
    requestPictures();
  }

  // public: fit / zoom buttons
  useEffect(() => {
    const onCmd = (e: Event) => {
      const c = (e as CustomEvent).detail as string | number[];
      if (Array.isArray(c)) { zoomTo(c); return; }
      if (c === 'fit' || c === 'whole') { if (c === 'fit') prefRatio = null; view.current = fitView(); force((x) => x + 1); requestPictures(); }
      else if (c === 'in' || c === 'out') zoomAt(paneW / 2, size.h / 2, c === 'in' ? 1.4 : 1 / 1.4);
      else if (c === 'area' && pair?.result && ui.area >= 0 && pair.result.areas[ui.area]) zoomTo(pair.result.areas[ui.area].box);
    };
    window.addEventListener('rr-view', onCmd);
    return () => window.removeEventListener('rr-view', onCmd);
  });

  function zoomAt(sx: number, sy: number, f: number) {
    const v = view.current;
    const fz = fitView().z;
    const z = Math.min(16, Math.max(fz * 0.5, v.z * f));
    // (remembered only on a change, and relative to the zoom picked for it)
    const a = pair?.result && ui.area >= 0 ? pair.result.areas[ui.area] : null;
    if (a) { const r0 = z / autoZoom(a.box); prefRatio = Math.abs(r0 - 1) < 0.04 ? null : r0; }
    const px = (sx - v.tx) / v.z, py = (sy - v.ty) / v.z;
    view.current = { z, tx: sx - px * z, ty: sy - py * z };
    if (ui.highlight) moved();
    force((x) => x + 1);
    requestPictures();
  }

  // ---------------------------------------------------------------- mouse
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  /** the view is being moved (drag, wheel): the highlighter takes its quick fill meanwhile */
  const moving = useRef(false);
  const still = useRef(0);
  const moved = () => {
    moving.current = true;
    clearTimeout(still.current);
    still.current = window.setTimeout(() => { moving.current = false; draw(); }, 160);
  };
  const onWheel = (e: React.WheelEvent) => {
    const rc = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1));
    zoomAt(e.clientX - rc.left, e.clientY - rc.top, f);
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    setMenu(null);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    view.current = { ...view.current, tx: d.tx + dx, ty: d.ty + dy };
    if (ui.highlight) moved();
    draw();
  };
  const hit = (e: React.MouseEvent, noMoves = false): number => {
    if (!r || !pair) return -1;
    const rc = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const v = view.current;
    const px = (e.clientX - rc.left - v.tx) / v.z, py = (e.clientY - rc.top - v.ty) / v.z;
    const real = new Set(realAreas(pair));
    let best = -1, ba = Infinity;
    r.areas.forEach((a, i) => {
      if ((!real.has(i) && !ui.showCommon) || (noMoves && a.shift)) return;
      const pad = 4 / v.z;
      if (px >= a.box[0] - pad && px <= a.box[2] + pad && py >= a.box[1] - pad && py <= a.box[3] + pad) {
        const ar = (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]);
        if (ar < ba) { ba = ar; best = i; }
      }
    });
    return best;
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) { requestPictures(); return; }
    const i = hit(e);
    if (i >= 0 && i !== ui.area) { ui.area = i; lastArea.current = pair!.id + ':' + i; bump(); force((x) => x + 1); }
  };
  const onDbl = (e: React.MouseEvent) => {
    const rc = (e.currentTarget as HTMLElement).getBoundingClientRect();
    zoomAt(e.clientX - rc.left, e.clientY - rc.top, e.shiftKey ? 0.5 : 2);
  };
  const onCtx = (e: React.MouseEvent) => {
    e.preventDefault();
    // (not a moved view: leaving its whole box out would hide every change there on every sheet)
    const i = hit(e, true);
    if (i < 0) { setMenu(null); return; }
    const rc = wrap.current!.getBoundingClientRect();
    setMenu({ x: e.clientX - rc.left, y: e.clientY - rc.top, area: i });
  };

  const handlers = { onWheel, onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onDoubleClick: onDbl, onContextMenu: onCtx };

  // the little map of the sheet (zoomed in): where the screen is; click or drag on it to move there
  const fz = fitView().z;
  const ms = Math.min(170 / pageW, 128 / pageH);
  const mw = Math.round(pageW * ms), mh = Math.round(pageH * ms);
  const showMini = !!pair && (hasOld || hasNew) && view.current.z > fz * 1.3 && paneW >= 380 && size.h >= 280;
  const miniDrag = useRef(false);
  const miniGo = (e: React.PointerEvent) => {
    const rc = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = ((e.clientX - rc.left) / rc.width) * pageW, py = ((e.clientY - rc.top) / rc.height) * pageH;
    const v = view.current;
    view.current = { z: v.z, tx: paneW / 2 - px * v.z, ty: size.h / 2 - py * v.z };
    draw();
  };
  const label = (m: string) => (m === 'old' ? 'Old issue' : m === 'new' ? 'New issue' : '');

  return (
    <div className="viewer" ref={wrap}>
      {!pair && <div className="viewer-empty">Pick a sheet on the left</div>}
      <canvas ref={cv} className="vcanvas" style={{ width: paneW, height: size.h, left: 0 }} {...handlers} />
      {eff === 'side' && <canvas ref={cv2} className="vcanvas" style={{ width: paneW, height: size.h, left: paneW + 2 }} {...handlers} />}
      {eff === 'side' && <div className="vsplit" style={{ left: paneW }} />}
      {pair && eff === 'side' && <><div className="vtag" style={{ left: 10 }}>Old issue</div><div className="vtag" style={{ left: paneW + 12 }}>New issue</div></>}
      {pair && hasOld && hasNew && eff !== 'side' && (eff !== 'overlay' || flicker) && <div className="vtag" style={{ left: 10 }}>{label(showMode(1))}{flicker && eff === 'overlay' ? ' (flicker)' : ''}</div>}
      {pair && !hasOld && hasNew && <div className="vtag new" style={{ left: 10 }}>{pair.old?.bad ? 'The old file could not be read - the new sheet alone' : 'New sheet - not in the old issue'}</div>}
      {pair && !hasNew && hasOld && <div className="vtag removed" style={{ left: 10 }}>{pair.neu?.bad ? 'The new file could not be read - the old sheet alone' : 'Removed sheet - not in the new issue'}</div>}
      {pair && !hasNew && !hasOld && <div className="viewer-empty">Neither file could be read</div>}
      {busy && <div className="vbusy"><span className="dot busy" /> drawing</div>}
      {showMini && (
        <div className="minimap" style={{ width: mw, height: mh }} title="Where you are on the sheet - click or drag here to move"
          onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); miniDrag.current = true; miniGo(e); }}
          onPointerMove={(e) => { if (miniDrag.current) miniGo(e); }}
          onPointerUp={() => { miniDrag.current = false; requestPictures(); force((x) => x + 1); }}
          onWheel={(e) => e.stopPropagation()}>
          {pair.thumbUrl && <img src={pair.thumbUrl} alt="" draggable={false} />}
          <svg viewBox={`0 0 ${pageW} ${pageH}`} preserveAspectRatio="none">
            {r && realAreas(pair).map((i) => {
              const b = r.areas[i].box, m = 2.5 / ms;
              const w = Math.max(m, b[2] - b[0]), h = Math.max(m, b[3] - b[1]);
              return <rect key={i} className={(i === ui.area ? 'on' : '') + (r.areas[i].shift ? ' moved' : '')} x={(b[0] + b[2]) / 2 - w / 2} y={(b[1] + b[3]) / 2 - h / 2} width={w} height={h} />;
            })}
            <rect ref={miniRect} className="vp" />
          </svg>
        </div>
      )}
      {tooHeavy && <div className="vtag removed" style={{ left: 10, top: 40 }}>Too heavy to draw here - the comparison's own picture is shown (zoom is not sharp)</div>}
      {openErr && !tooHeavy && <div className="vtag removed vtag-act" style={{ left: 10, top: 40 }}>The sheet's file{hasOld && hasNew ? 's' : ''} could not be opened for viewing{pair?.result ? ' - the comparison\'s own picture is shown, zoom is not sharp' : ''}: {openErr.replace(/^Error:\s*/, '').slice(0, 140)} <button className="link" onClick={() => { setOpenErr(null); opened.current = ''; setEpoch((x) => x + 1); }}>Try again</button></div>}
      {menu && pair?.result && (
        <div className="ctxmenu" ref={menuEl} style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <div className="ctxhead">Change {areaLabels(pair)[menu.area]}</div>
          <button onClick={() => { addZone(pair, pair.result!.areas[menu.area].box); setMenu(null); }}><Icon n="zone" size={15} /> Leave this spot out on every sheet this size</button>
          <button onClick={() => { addZone(pair, pair.result!.areas[menu.area].box, true); setMenu(null); }}><Icon n="zone" size={15} /> Leave this spot out on all sheets</button>
          <button onClick={() => { onMode('side'); setMenu(null); }}><Icon n="side" size={15} /> Show side by side</button>
        </div>
      )}
    </div>
  );
}

/** the comparison's overlay picture (PNG) faded to `fade` (see refade.ts) */
async function refaded(png: Uint8Array, fade: number): Promise<ImageBitmap> {
  const src = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }));
  try {
    const c = new OffscreenCanvas(src.width, src.height);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(src, 0, 0);
    const d = g.getImageData(0, 0, src.width, src.height);
    refade(d.data, fade);
    return await createImageBitmap(d);
  } finally { src.close(); }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

/** ask the viewer to fit / zoom / show the selected area */
export const viewCmd = (c: 'fit' | 'whole' | 'in' | 'out' | 'area') => window.dispatchEvent(new CustomEvent('rr-view', { detail: c }));
/** show a box of the sheet (points) */
export const viewBox = (b: number[]) => window.dispatchEvent(new CustomEvent('rr-view', { detail: b }));
