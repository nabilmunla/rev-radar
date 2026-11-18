import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './base.css';
import './styles.css';
import { App } from './App';
import { rr } from './api';
import { ui, bump, realAreas, stepAreas, tinyFrom, textGroups, hasFigures, isFigText, needsReview } from './model';
import { readSet, sideLabels, startSession } from './runner';
import { startBoq, exportBoqExcel, leaveBoq, visible, boqGroups, isFigure, itemCount } from './boqrun';
import { startDocs, exportDocsExcel, leaveDocs, docVisible, docGroups } from './docsrun';
import { exportExcel, exportPdf } from './exporting';

window.addEventListener('error', (e) => { rr.log('window error: ' + (e.error?.stack || e.message)); rr.reportCrash?.('window', String(e.error?.message || e.message), String(e.error?.stack || '')); });
window.addEventListener('unhandledrejection', (e) => { rr.log('window rejection: ' + ((e.reason as Error)?.stack || e.reason)); rr.reportCrash?.('window (promise)', String((e.reason as Error)?.message || e.reason), String((e.reason as Error)?.stack || '')); });
/** a mistake while drawing the window: a page to reload from instead of an empty window (as the PDF
 *  Editor does) - finished comparisons are kept and come back at once */
class Guard extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { err: String((e as Error)?.message || e) }; }
  componentDidCatch(e: unknown) { rr.log('window render error: ' + ((e as Error)?.stack || e)); rr.reportCrash?.('window render', String((e as Error)?.message || e), String((e as Error)?.stack || '')); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding: 40, fontFamily: 'Inter Variable, Segoe UI, sans-serif', maxWidth: 560 }}>
        <h2 style={{ margin: '0 0 8px' }}>Something went wrong in this window</h2>
        <p style={{ margin: '0 0 16px', opacity: 0.8 }}>Finished comparisons are kept: reload the window and they come back at once.</p>
        <button className="btn primary" onClick={() => location.reload()}>Reload the window</button>
        <p style={{ marginTop: 18, fontSize: 12, opacity: 0.6 }}>{this.state.err}</p>
      </div>
    );
  }
}
createRoot(document.getElementById('root')!).render(<Guard><App /></Guard>);

// hooks for the automated tests (drive the app without its file dialogs)
(window as unknown as { __rrTest: unknown }).__rrTest = {
  async compare(oldPaths: string[], newPaths: string[], recursive = true) {
    const [fo, fn] = await Promise.all([readSet(oldPaths, recursive), readSet(newPaths, recursive)]);
    const [lo, ln] = sideLabels(oldPaths, newPaths);
    void startSession({ label: lo, paths: oldPaths, recursive, files: fo }, { label: ln, paths: newPaths, recursive, files: fn });
    return [fo.length, fn.length];
  },
  state() {
    const s = ui.session;
    return s ? { phase: s.phase, note: s.note, zones: s.zones.length, selected: s.pairs.find((p) => p.id === ui.selected)?.key ?? null, area: ui.area, areaFig: (() => { const p = s.pairs.find((x) => x.id === ui.selected); return !!p && ui.area >= 0 && !!p.result?.areas[ui.area]?.text.some(isFigText); })(), filter: ui.filter, todo: s.pairs.filter((p) => needsReview(p) && !p.reviewed).length, figs: s.pairs.filter((p) => p.status === 'changed' && hasFigures(p)).length, groups: [...textGroups(s.pairs).values()].map((g) => g.sheets.length),
      pairs: s.pairs.map((p) => ({ fig: p.status === 'changed' && hasFigures(p), key: p.key, status: p.status, areas: p.result?.areas.length ?? null, real: p.result ? realAreas(p).length : null, steps: stepAreas(p).length, tinyStop: tinyFrom(p) > 0, error: p.error, how: p.how, secs: p.secs, fine: p.result?.alignInfo?.fine, reviewed: !!p.reviewed, cached: !!p.result?.fromCache, old: p.old?.rel ?? null, neu: p.neu?.rel ?? null })) } : null;
  },
  /** (T8 tests) every sheet's reviewed tick taken back */
  clearReviewed() { for (const p of ui.session?.pairs ?? []) p.reviewed = false; ui.selected = null; ui.area = -1; bump(); },
  /** the change boxes of a sheet (points) */
  boxes(key: string) { const p = ui.session?.pairs.find((x) => x.key === key); return p?.result?.areas.map((a) => a.box) ?? []; },
  /** the counted areas of a sheet with their text changes (T8 tests) */
  texts(key: string) { const p = ui.session?.pairs.find((x) => x.key === key); return p?.result ? realAreas(p).map((i) => p.result!.areas[i].text.map((t) => [t.kind, t.from, t.to])) : []; },
  select(key: string) { const p = ui.session?.pairs.find((x) => x.key === key); if (p) { ui.selected = p.id; ui.area = -1; bump(); } return !!p; },
  /** back to a tab's start screen (its comparison closed) */
  leave(tab: 'boq' | 'docs') { if (tab === 'boq') leaveBoq(); else leaveDocs(); },
  /** the BOQ tab: two issues compared */
  async boq(oldPaths: string[], newPaths: string[], partial = false) {
    const [fo, fn] = await Promise.all([readSet(oldPaths, true, 'boq'), readSet(newPaths, true, 'boq')]);
    const [lo, ln] = sideLabels(oldPaths, newPaths);
    ui.tab = 'boq';
    void startBoq({ label: lo, paths: oldPaths, files: fo }, { label: ln, paths: newPaths, files: fn }, partial);
    return [fo.length, fn.length];
  },
  boqState() {
    const b = ui.boq;
    if (!b) return null;
    const cur = b.sel >= 0 ? b.entries[b.sel] : null;
    return { phase: b.phase, error: b.error, entries: b.entries.length, selIdx: b.sel, filter: b.filter, sel: cur ? { kind: cur.kind, ref: (cur.n ?? cur.o)?.ref, text: (cur.n ?? cur.o)?.text, fig: isFigure(cur), tk: b.ticked.has(cur.k), grp: cur.rep ?? -1 } : null, ticked: b.ticked.size,
      items: b.result ? [b.result.old.items.length, b.result.neu.items.length] : null, added: b.result?.added.length, removed: b.result?.removed.length, outside: b.result?.outside.length,
      chip: b.chip, todo: b.entries.filter((e) => e.kind !== 'renumbered' && !b.ticked.has(e.k)).reduce((n, e) => n + itemCount(e), 0), visible: b.phase === 'done' ? visible(b).length : 0, figs: b.entries.filter(isFigure).length, groups: b.phase === 'done' ? [...boqGroups(b.entries).values()].map((g) => g.length) : [], note: b.note, notes: b.result ? [...b.result.old.notes, ...b.result.neu.notes] : null, same: b.result?.pairs.filter((p) => !p.changed.length && !p.moved).length, ocr: b.result ? b.result.neu.items.filter((x) => x.ocr).length : null };
  },
  /** (T8 tests) put the selection on the first member of the first group that has none ticked (any group when `any`), or of the nth; returns the group's size */
  pickGroup(tab: 'boq' | 'docs', nth = 0, any = false) {
    const es = tab === 'boq' ? ui.boq?.entries : ui.docs?.result?.entries;
    const sess = tab === 'boq' ? ui.boq : ui.docs;
    if (!es || !sess) return null;
    const by = new Map<number, number[]>();
    es.forEach((e, i) => { if (e.rep !== undefined) { if (!by.has(e.rep)) by.set(e.rep, []); by.get(e.rep)!.push(i); } });
    const ok = [...by.values()].filter((l) => any || l.every((i) => !sess.ticked.has(es[i].k)));
    const g = ok[nth];
    if (!g) return null;
    sess.sel = g[0]; bump();
    return { size: g.length, idx: g[0] };
  },
  /** (T8 tests) every tick taken back */
  clearTicks(tab: 'boq' | 'docs') { (tab === 'boq' ? ui.boq : ui.docs)?.ticked.clear(); bump(); },
  /** the changed pairs, old and new side by side (tests) */
  boqChanges() { const b = ui.boq; if (!b?.result) return []; const r = b.result; return r.pairs.filter((p) => p.changed.length).map((p) => [p.changed.join(','), [r.old.items[p.o].ref, r.old.items[p.o].text, r.old.items[p.o].qty, r.old.items[p.o].unit].join(' | '), [r.neu.items[p.n].ref, r.neu.items[p.n].text, r.neu.items[p.n].qty, r.neu.items[p.n].unit].join(' | ')]); },
  /** side by side (tests): the changes whose old and new item are in different sheets */
  boqCross() {
    const b = ui.boq; if (!b?.result) return [];
    const w = (x?: { file: string; sheet: string; row: number }) => x && { file: x.file, sheet: x.sheet, row: x.row };
    return b.entries.map((e, i) => ({ i, kind: e.kind, o: w(e.o), n: w(e.n) })).filter((e) => e.o && e.n && (e.o.file !== e.n.file || e.o.sheet !== e.n.sheet));
  },
  /** side by side (tests): the new sheet most of an old sheet's items went to, counted here on its own */
  boqMatch(file: string, sheet: string) {
    const b = ui.boq; if (!b?.result) return null;
    const r = b.result, n = new Map<string, number>();
    for (const p of r.pairs) { const o = r.old.items[p.o], x = r.neu.items[p.n]; if (o.file === file && o.sheet === sheet) { const k = x.file + '\u0000' + x.sheet; n.set(k, (n.get(k) || 0) + 1); } }
    const best = [...n].sort((a, c) => c[1] - a[1])[0];
    return best ? { file: best[0].split('\u0000')[0], sheet: best[0].split('\u0000')[1], count: best[1] } : null;
  },
  /** side by side (tests): the file most of an old file's items went to */
  boqMatchFile(file: string) {
    const b = ui.boq; if (!b?.result) return null;
    const r = b.result, n = new Map<string, number>();
    for (const p of r.pairs) { const o = r.old.items[p.o], x = r.neu.items[p.n]; if (o.file === file) n.set(x.file, (n.get(x.file) || 0) + 1); }
    const best = [...n].sort((a, c) => c[1] - a[1])[0];
    return best ? { file: best[0], count: best[1] } : null;
  },
  /** side by side (tests): where most of the items round an old item went (15 nearest by row) - file, or file and sheet */
  boqNearDoc(file: string, sheet: string | null, row: number, byFile: boolean) {
    const b = ui.boq; if (!b?.result) return null;
    const r = b.result;
    const l = r.pairs.map((p) => ({ o: r.old.items[p.o], n: r.neu.items[p.n] })).filter((x) => x.o.file === file && (sheet === null || x.o.sheet === sheet)).sort((x, y) => Math.abs(x.o.row - row) - Math.abs(y.o.row - row)).slice(0, 15);
    const t = new Map<string, number>();
    for (const x of l) { const k = byFile ? x.n.file : x.n.file + '\u0000' + x.n.sheet; t.set(k, (t.get(k) || 0) + 1); }
    const best = [...t].sort((a, c) => c[1] - a[1])[0];
    return best ? { file: best[0].split('\u0000')[0], sheet: best[0].split('\u0000')[1], count: best[1] } : null;
  },
  docsChanges() { const d = ui.docs; return (d?.result?.entries ?? []).filter((e) => e.kind !== 'renumbered').map((e) => [e.kind, e.o?.text.slice(0, 90) ?? '', e.n?.text.slice(0, 90) ?? '']); },
  exportBoqExcel,
  async docs(oldPaths: string[], newPaths: string[]) {
    const [fo, fn] = await Promise.all([readSet(oldPaths, true, 'docs'), readSet(newPaths, true, 'docs')]);
    const [lo, ln] = sideLabels(oldPaths, newPaths);
    ui.tab = 'docs';
    void startDocs({ label: lo, paths: oldPaths, files: fo }, { label: ln, paths: newPaths, files: fn });
    return [fo.length, fn.length];
  },
  docsState() {
    const d = ui.docs;
    if (!d) return null;
    const cur = d.sel >= 0 ? d.result?.entries[d.sel] : null;
    return { phase: d.phase, error: d.error, entries: d.result?.entries.length ?? 0, sel: cur ? { kind: cur.kind, sec: cur.sec, text: (cur.n ?? cur.o)?.text.slice(0, 60), fig: !!cur.figs?.length, tk: d.ticked.has(cur.k), grp: cur.rep ?? -1, row: !!(cur.o?.cells || cur.n?.cells) } : null, ticked: d.ticked.size, chip: d.chip, todo: d.result?.entries.filter((e) => e.kind !== 'renumbered' && !d.ticked.has(e.k)).length ?? 0, visible: d.phase === 'done' ? docVisible(d).length : 0, figs: d.result?.entries.filter((e) => e.figs?.length).length ?? 0, groups: d.result ? [...docGroups(d.result).values()].map((g) => g.length) : [], sections: d.result?.sections, paras: d.result?.paras, notes: d.result?.notes, note: d.note, kinds: d.result?.entries.map((e) => e.kind), picReading: d.picReading, picReadMs: d.picReadMs, picRead: d.result?.entries.filter((e) => e.pic).map((e) => e.pic!.read ?? '') };
  },
  docsEntries() { return ui.docs?.result?.entries.map((e) => ({ kind: e.kind, sec: e.sec, o: e.o && { num: e.o.num, text: e.o.text }, n: e.n && { num: e.n.num, text: e.n.text }, ...(e.pic ? { pic: { what: e.pic.what, word: !!e.pic.word } } : {}) })) ?? []; },
  /** the entry chosen, with the words the engine says changed (T7 tests: the words marked are these) */
  docsSelected() { const d = ui.docs, e = d && d.sel >= 0 ? d.result?.entries[d.sel] : null; return e ? { kind: e.kind, cls: e.cls, o: e.o?.text, n: e.n?.text, cw: e.cw ?? null, row: !!(e.o?.cells || e.n?.cells) } : null; },
  exportDocsExcel,
  saveAs(path: string) { (window as unknown as { __rrSaveAs: string }).__rrSaveAs = path; },
  exportExcel, exportPdf,
};
