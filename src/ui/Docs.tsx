// The Documents tab's review: specifications / documents compared paragraph by paragraph - the list
// (filters, search) on the left, the clause old and new in the middle, totals on the right. Keys as
// everywhere: N / P through the changes, R ticks one off.
import { useEffect, useRef } from 'react';
import { bump, useUI } from './model';
import { Icon } from './icons';
import { usePanels, SidePanel, togglePanel, panelTip } from './PanelSize';
import { HScroll } from './Scroller';
import { BusyLine } from './busy';
import { startDocs, stopDocs, docTicksChanged, docVisible, docMatches, docSummary, docNeedsCheck, docMates, docTickGroup, type DocFilter, type DocSession } from './docsrun';
import { wordDiff } from '../engine/boq';
import type { DocEntry, DocLine } from '../engine/docs';
import { DocsSide, FigChip, SameChange } from './DocsSide';

/** side by side (the two issues' pages) or the list's detail - kept between comparisons */
type View = 'side' | 'list';
let view: View = (() => { try { return localStorage.getItem('rr.docsView') === 'list' ? 'list' : 'side'; } catch { return 'side'; } })();
const setView = (v: View) => { view = v; try { localStorage.setItem('rr.docsView', v); } catch { /* fine */ } bump(); };

const FILTERS: [DocFilter, string, string][] = [
  ['changes', 'Changes', 'Everything that changed (renumbering apart)'],
  ['todo', 'To review', 'Changes not ticked off yet (R ticks the one shown)'],
  ['changed', 'Changed', 'Paragraphs reworded - any word, figure, sign, comparator or percent changed'],
  ['added', 'Added', 'Paragraphs only in the new issue'],
  ['removed', 'Removed', 'Paragraphs only in the old issue'],
  ['moved', 'Moved', 'Paragraphs now somewhere else (another place or section)'],
  ['renumbered', 'Renumbered', 'Clauses whose number changed (one inserted before them renumbers the rest)'],
  ['punct', 'Punctuation only', 'The same words; only punctuation or spacing changed (never a sign, comparator or percent)'],
  ['dateOnly', 'Date / revision only', 'Only a date or a revision stamp changed (R0_06-04-2026 → R0_07-07-2026)'],
  ['sections', 'Sections', 'Whole sections added or removed'],
  ['pics', 'Pictures', 'Pictures inside the pages that changed, were added or removed - compare them by eye on the pages'],
  ['check', 'Check', 'Pairings worth a look: the texts differ a lot'],
];

export function DocsResults() {
  const st = useUI();
  const s = st.docs!;
  const list = s.phase === 'done' ? docVisible(s) : [];
  const all = s.result?.entries ?? [];
  const cur = s.sel >= 0 ? all[s.sel] : undefined;
  const listRef = useRef<HTMLDivElement>(null);
  const pn = usePanels('docs', { right: view === 'side' });
  const select = (e?: DocEntry) => { if (!e) return; s.sel = all.indexOf(e); bump(); };
  const step = (d: 1 | -1) => { if (!list.length) return; const k = cur ? list.indexOf(cur) : -1; select(list[k < 0 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, k + d))]); };
  /** Shift + R: this change and every place it was made, ticked - and on */
  const tickAll = () => { if (!cur || cur.rep === undefined) return; docTickGroup(s, cur); step(1); bump(); };
  const tick = () => { if (!cur) return; if (s.ticked.has(cur.k)) s.ticked.delete(cur.k); else { s.ticked.add(cur.k); step(1); } docTicksChanged(); bump(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // (a text box takes the keys; a tick box clicked does not keep them - N / P / R go on working)
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || t?.closest?.('textarea, select, [contenteditable]') || (t?.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'range'].includes((t as HTMLInputElement).type))) return;
      if (t?.tagName === 'INPUT') t.blur();
      if (document.querySelector('.scrim')) return;
      // [ and ] by the key's place as well (other keyboard layouts); ] does nothing in the side view (no details there)
      const k = e.code === 'BracketLeft' ? '[' : e.code === 'BracketRight' ? ']' : e.key.toLowerCase();
      if (k === 'n' || e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (k === 'p' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (k === '[') togglePanel('docs', 'left');
      else if (k === ']') { if (view === 'list') togglePanel('docs', 'right'); }
      else if (k === 'r' && !e.repeat) { e.preventDefault(); if (e.shiftKey) tickAll(); else tick(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => { listRef.current?.querySelector('.srow.on')?.scrollIntoView({ block: 'nearest' }); }, [s.sel, s.filter, st.panels.docs.left]);

  if (s.phase === 'running') return <div className="empty"><BusyLine what={s.note || 'Reading the documents and pairing their paragraphs… (a 3,000-page book takes about half a minute)'} since={s.t0 ?? performance.now()} onStop={stopDocs} stopTitle="Stop and go back to the two issues - nothing is kept" /></div>;
  if (s.phase === 'error') return <div className="empty"><h3>The documents could not be compared</h3><p>{s.error}</p><button className="btn" onClick={() => void startDocs(s.oldSet, s.newSet)}><Icon n="refresh" size={14} /> Try again</button></div>;
  const r = s.result!;
  const count = (f: DocFilter) => all.filter((e) => docMatches(e, f, s)).length;
  const todo = count('todo');
  return (
    <div className="results pw" style={pn.style} ref={pn.ref}>
      <SidePanel side="left" p={pn.left}>
        <aside className="left">
          <div className="filters">
            {FILTERS.map(([f, label, tip]) => { const n = count(f); if (!n && f !== 'changes' && f !== s.filter) return null; return <button key={f} className={'fchip' + (s.filter === f ? ' on' : '')} title={tip} onClick={() => { s.filter = f; bump(); }}>{label} <span className="n">{n}</span></button>; })}
          </div>
          <div className="searchrow"><label className="search"><Icon n="search" size={14} /><input placeholder="Find (words, clause, section)" value={s.search} onChange={(e) => { s.search = e.target.value; bump(); }} /></label></div>
          {s.chip !== 'all' && <div className="zoneline" title="Chosen with the chips in the side view: the list and N / P show only these">Showing only {s.chip === 'figs' ? 'the changes in figures' : 'the changes still to review'} <button className="linkbtn" onClick={() => { s.chip = 'all'; bump(); }}>show all</button></div>}
          <div className={'slist' + (list.length ? '' : ' empty-list')} ref={listRef}>
            {!list.length && <div>{all.length ? 'Nothing here.' : 'Nothing changed: every paragraph is in both issues, the same.'}</div>}
            {list.map((e) => { const x = (e.n ?? e.o)!; return (
              <button key={e.k} className={'srow' + (cur === e ? ' on' : '') + (s.ticked.has(e.k) ? ' reviewed' : '')} onClick={() => select(e)}>
                <span className={'bdot k-' + ({ changed: 'changed', added: 'added', removed: 'removed', moved: 'heading', renum: 'renumbered', punct: 'renumbered', dateOnly: 'renumbered', pic: 'changed' } as const)[e.cls]} />
                <span className="sname"><span className="skey">{x.num ? <b>{x.num}</b> : null} {e.kind === 'secAdded' || e.kind === 'secRemoved' ? e.sec : x.text}</span><span className="stitle">{docSummary(e)} · {e.sec}{x.page > 0 ? ` · p.${x.page}` : ''}</span></span>
                {docNeedsCheck(e) && <span className="chip st-wait">check</span>}
                {s.ticked.has(e.k) && <Icon n="check" size={15} />}
              </button>); })}
          </div>
        </aside>
      </SidePanel>
      <main className={'center boq-center' + (view === 'side' ? ' side' : '')}>
        <div className="boq-bar">
          <button className={'btn sm icon panelbtn' + (st.panels.docs.left ? '' : ' on')} onClick={() => togglePanel('docs', 'left')} title={panelTip('left', st.panels.docs.left)}><Icon n="panelleft" size={16} /></button>
          <HScroll className="boq-tools" wrapClass="boq-scroll">
            <div className="seg" role="tablist">
              <button className={view === 'side' ? 'on' : ''} onClick={() => setView('side')} title="The old and new issues' pages side by side, the changes marked on them: click one, the other side goes to it">Side by side</button>
              <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} title="The change chosen on the left, old and new word by word, with the totals and files on the right">Details</button>
            </div>
            <span className="faint">{r.paras.old.toLocaleString()} paragraphs old · {r.paras.neu.toLocaleString()} new · {todo ? `${todo} of ${count('changes')} to review` : count('changes') ? 'all changes ticked off' : 'nothing changed'}</span>
          </HScroll>
          {view === 'list' && <button className={'btn sm icon panelbtn' + (st.panels.docs.right ? '' : ' on')} onClick={() => togglePanel('docs', 'right')} title={panelTip('right', st.panels.docs.right)}><Icon n="panelright" size={16} /></button>}
        </div>
        {view === 'side' ? <DocsSide s={s} /> : cur ? <Detail e={cur} s={s} /> : <div className="empty">Choose a change on the left (N goes to the next one).</div>}
      </main>
      {view === 'list' && (
        <SidePanel side="right" p={pn.right}>
        <aside className="right"><div className="panel">
          <h3>Document comparison</h3>
          <div className="sumtable">
            <div className="sumrow"><span>Sections, old / new</span><b>{r.sections.old} / {r.sections.neu}</b></div>
            <div className="sumrow"><span>Sections paired</span><b>{r.sections.paired}</b></div>
            <div className="sumrow"><span>Paragraphs, old / new</span><b>{r.paras.old.toLocaleString()} / {r.paras.neu.toLocaleString()}</b></div>
            <div className="sumrow"><span>Changed</span><b>{count('changed')}</b></div>
            <div className="sumrow"><span>Added / removed</span><b>{count('added')} / {count('removed')}</b></div>
            <div className="sumrow"><span>Moved</span><b>{count('moved')}</b></div>
            <div className="sumrow"><span>Renumbered</span><b>{count('renumbered')}</b></div>
          </div>
          <div className="reviewline">{todo ? `${todo} of ${count('changes')} to review` : count('changes') ? 'All changes ticked off' : ''}</div>
          <div className="faint" style={{ fontSize: 12 }}>Headers, footers and page numbers are left out; a change of a date alone is listed light ("Date / revision only"); clause numbers are compared on their own.</div>
          <h3>Files</h3>
          <div className="bfiles"><div><span className="faint">Old:</span> {s.oldSet.files.map((f) => f.rel).join(', ')}</div><div><span className="faint">New:</span> {s.newSet.files.map((f) => f.rel).join(', ')}</div></div>
          {r.notes.slice(0, 8).map((n, i) => <div key={i} className="warnbox">{n}</div>)}
        </div></aside>
        </SidePanel>
      )}
    </div>
  );
}

function Where({ x, label }: { x: DocLine; label: string }) {
  return <div className="bwhere"><span className="faint">{label}</span> {x.file}{x.page > 0 ? ` · page ${x.page}` : ''}{x.num ? <> · clause <b>{x.num}</b></> : null}</div>;
}

function Detail({ e, s }: { e: DocEntry; s: DocSession }) {
  const a = e.o, b = e.n, ticked = s.ticked.has(e.k);
  const kindCls = ({ changed: 'st-changed', added: 'st-new', removed: 'st-removed', moved: 'st-run', renum: 'st-same', punct: 'st-same', dateOnly: 'st-same', pic: 'st-changed' } as const)[e.cls];
  return (
    <div className="bdetail">
      <div className="bhead">
        <span className={'chip big ' + kindCls}>{docSummary(e)}</span>
        <span className="grow" />
        <button className={'btn sm' + (ticked ? ' on' : '')} onClick={() => { if (ticked) s.ticked.delete(e.k); else s.ticked.add(e.k); docTicksChanged(); bump(); }} title="Tick off as reviewed (R)"><Icon n="check" size={14} /> {ticked ? 'Reviewed' : 'Reviewed - R'}</button>
      </div>
      <div className="bwhere"><span className="faint">Section:</span> <b>{e.sec}</b></div>
      {e.figs?.length ? <div className="bblock"><div className="blabel">Figures</div><div className="btext sbs-figs">{e.figs.map((f, i) => <FigChip key={i} f={f} />)}</div></div> : null}
      {docMates(s, e).length > 0 && <div className="bblock"><SameChange n={docMates(s, e).length} what="in" tick={() => { docTickGroup(s, e); bump(); }} /></div>}
      {a && <Where x={a} label="Old:" />}
      {b && <Where x={b} label="New:" />}
      {(b ?? a)!.head && <div className="bblock"><div className="blabel">Under</div><div className="btext faint">{(b ?? a)!.head}</div></div>}
      {e.pic ? <div className="bblock"><div className="blabel">Picture</div><div className="btext">{e.pic.what === 'changed' ? `The picture changed${e.pic.whole ? '' : ` in ${(e.pic.n ?? []).length} place${(e.pic.n ?? []).length === 1 ? '' : 's'}`} - open "Side by side" and compare the boxed areas by eye.` : e.pic.what === 'added' ? 'A picture only in the new issue - look at it on the page.' : 'A picture not in the new issue.'}</div>{e.pic.read && <div className="btext"><span className="faint">Read by OCR, check by eye: </span>{e.pic.read}</div>}</div>
      : e.kind === 'secAdded' || e.kind === 'secRemoved'
        ? <div className="bblock"><div className="blabel">The whole section is {e.kind === 'secAdded' ? 'new' : 'gone'} - {e.paras} paragraphs. It starts:</div><div className="btext">{(b ?? a)!.text}</div></div>
        : <div className="bblock"><div className="blabel">Text</div><div className="btext">{a && b ? wordDiff(a.text, b.text).map((d, i) => (d.op === '=' ? <span key={i}>{d.t} </span> : d.op === '-' ? <s key={i} className="minus">{d.t} </s> : <span key={i} className="plus">{d.t} </span>)) : (b ?? a)!.text}</div></div>}
      {(a?.ocr || b?.ocr) && <div className="warnbox">Read from a scanned page (OCR): words can be misread - check them on the page.</div>}
      {e.like !== undefined && <div className="faint bhow">{Math.round(e.like * 100)} % alike.{docNeedsCheck(e) ? ' Worth a look: the texts differ a lot - check it is the same clause.' : ''}</div>}
    </div>
  );
}
