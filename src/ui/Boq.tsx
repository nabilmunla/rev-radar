// The BOQ tab's review: what changed between two issues of a bill of quantities - the list on the
// left (filters with counts, search), the item old and new in the middle, the totals and files on
// the right. The same keys as the drawings: N / P through the changes, R ticks one off.
import { useEffect, useRef } from 'react';
import { ui, bump, useUI } from './model';
import { Icon } from './icons';
import { startBoq, ticksChanged, visible, boqCount, boqChanged, summary, needsCheck, fmt, wordDiff, boqMates, boqTickGroup, type BoqEntry, type BoqFilter, type BoqSession } from './boqrun';
import type { BoqItem } from '../engine/boq';
import { BoqSide } from './BoqSide';
import { FigChip, SameChange } from './DocsSide';

/** side by side (the two issues as laid out) or the list's detail - kept between comparisons */
type View = 'side' | 'list';
let view: View = (() => { try { return localStorage.getItem('rr.boqView') === 'list' ? 'list' : 'side'; } catch { return 'side'; } })();
const setView = (v: View) => { view = v; try { localStorage.setItem('rr.boqView', v); } catch { /* fine */ } bump(); };

const FILTERS: [BoqFilter, string, string][] = [
  ['changes', 'Changes', 'Everything that changed: items changed, added, removed, moved (renumbering apart)'],
  ['todo', 'To review', 'Changes not ticked off yet (R ticks the one shown)'],
  ['qty', 'Quantity', 'Quantities that changed (rounding apart)'],
  ['rounded', 'Rounded', 'Quantities only rounded: 50.7 → 51, 7.75 → 8 - the same amount written shorter'],
  ['unit', 'Unit', 'Units that changed'],
  ['text', 'Description', 'Descriptions and headings reworded'],
  ['price', 'Rate / amount', 'Rates or amounts that changed (priced BOQs)'],
  ['added', 'Added', 'Items only in the new issue'],
  ['removed', 'Removed', 'Items only in the old issue'],
  ['moved', 'Moved', 'Items now in another place or bill'],
  ['renumbered', 'Renumbered', 'Items whose number changed (refs are lettered afresh on every page: a page that grew renumbers everything after it)'],
  ['check', 'Check', 'Pairings worth a look: descriptions that differ a lot, or read from a PDF'],
];

export function BoqResults() {
  const st = useUI();
  const s = st.boq!;
  const list = s.phase === 'done' ? visible(s) : [];
  const cur = s.sel >= 0 ? s.entries[s.sel] : undefined;
  const listRef = useRef<HTMLDivElement>(null);

  const select = (e: BoqEntry | undefined) => { if (!e) return; s.sel = s.entries.indexOf(e); bump(); };
  const step = (d: 1 | -1) => {
    if (!list.length) return;
    const k = cur ? list.indexOf(cur) : -1;
    if (k < 0 && cur) {
      // (the one shown is not in the list - clicked in the sheets, or filtered out: the next / last before it)
      const at = s.sel;
      const next = d > 0 ? list.find((e) => s.entries.indexOf(e) > at) : [...list].reverse().find((e) => s.entries.indexOf(e) < at);
      select(next ?? list[d > 0 ? list.length - 1 : 0]);
      return;
    }
    select(list[k < 0 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, k + d))]);
  };
  /** Shift + R: this change and every place it was made, ticked - and on */
  const tickAll = () => { if (!cur || cur.rep === undefined) return; boqTickGroup(s, cur); step(1); bump(); };
  const tick = () => {
    if (!cur) return;
    if (s.ticked.has(cur.k)) s.ticked.delete(cur.k); else { s.ticked.add(cur.k); step(1); } ticksChanged();
    bump();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // (a text box takes the keys; a tick box clicked does not keep them - N / P / R go on working)
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || t?.closest?.('textarea, select, [contenteditable]') || (t?.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'range'].includes((t as HTMLInputElement).type))) return;
      if (t?.tagName === 'INPUT') t.blur();
      const k = e.key.toLowerCase();
      if (k === 'n' || e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (k === 'p' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (k === 'r' && !e.repeat) { e.preventDefault(); if (e.shiftKey) tickAll(); else tick(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // the selected line kept in view
  useEffect(() => { listRef.current?.querySelector('.srow.on')?.scrollIntoView({ block: 'nearest' }); }, [s.sel, s.filter]);

  if (s.phase === 'running') return <div className="empty"><span className="dot busy" /> {s.note || 'Reading and pairing the items…'}</div>;
  if (s.phase === 'error') return <div className="empty"><h3>The BOQs could not be compared</h3><p>{s.error}</p><button className="btn" onClick={() => void startBoq(s.oldSet, s.newSet, s.partial)}><Icon n="refresh" size={14} /> Try again</button></div>;
  const r = s.result!;
  const count = (f: BoqFilter) => boqCount(s, f);
  const todo = count('todo');
  return (
    <div className={'results' + (st.panels.left ? '' : ' noleft') + (st.panels.right && view === 'list' ? '' : ' noright')}>
      {st.panels.left && (
        <aside className="left">
          <div className="filters">
            {FILTERS.map(([f, label, tip]) => {
              const n = count(f);
              if (!n && f !== 'changes' && f !== s.filter) return null;
              return <button key={f} className={'fchip' + (s.filter === f ? ' on' : '')} title={tip} onClick={() => { s.filter = f; bump(); }}>{label} <span className="n">{n}</span></button>;
            })}
          </div>
          <div className="searchrow">
            <label className="search"><Icon n="search" size={14} /><input placeholder="Find an item (words, ref)" value={s.search} onChange={(e) => { s.search = e.target.value; bump(); }} /></label>
          </div>
          {s.chip !== 'all' && <div className="zoneline" title="Chosen with the chips in the side view: the list and N / P show only these">Showing only {s.chip === 'figs' ? 'the changes in figures' : 'the changes still to review'} <button className="linkbtn" onClick={() => { s.chip = 'all'; bump(); }}>show all</button></div>}
          <div className={'slist' + (list.length ? '' : ' empty-list')} ref={listRef}>
            {!list.length && <div>{s.entries.length ? 'Nothing here.' : 'Nothing changed: every item is in both issues, the same.'}</div>}
            {list.map((e) => {
              if (e.pic) {
                const w = e.pic.n ?? e.pic.o!;
                return (
                  <button key={e.k} className={'srow' + (cur === e ? ' on' : '') + (s.ticked.has(e.k) ? ' reviewed' : '')} onClick={() => select(e)}>
                    <span className="bdot k-changed" />
                    <span className="sname"><span className="skey">{summary(e)}</span><span className="stitle">{w.file} · page {w.page + 1}</span></span>
                    <span className="chip st-wait" title="Compare the picture by eye">check</span>
                    {s.ticked.has(e.k) && <Icon n="check" size={15} />}
                  </button>
                );
              }
              const x = e.n ?? e.o!;
              return (
                <button key={e.k} className={'srow' + (cur === e ? ' on' : '') + (s.ticked.has(e.k) ? ' reviewed' : '')} onClick={() => select(e)}>
                  <span className={'bdot k-' + e.kind + (e.pair?.moved ? ' moved' : '')} />
                  <span className="sname">
                    <span className="skey">{x.ref ? <b>{x.ref}</b> : null} {x.text}</span>
                    <span className="stitle">{summary(e)} · {x.sheet} {x.page}</span>
                  </span>
                  {needsCheck(e, s) && <span className="chip st-wait" title="Worth a look: see why in the middle">check</span>}
                  {s.ticked.has(e.k) && <Icon n="check" size={15} />}
                </button>
              );
            })}
          </div>
        </aside>
      )}
      <main className={'center boq-center' + (view === 'side' ? ' side' : '')}>
        <div className="boq-bar">
          <div className="seg" role="tablist">
            <button className={view === 'side' ? 'on' : ''} onClick={() => setView('side')} title="The old and new sheets side by side, the changes coloured: click one, the other side goes to it">Side by side</button>
            <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} title="The change chosen on the left, old and new field by field, with the totals and files">Details</button>
          </div>
          <span className="faint">{r.old.items.length.toLocaleString()} items old · {r.neu.items.length.toLocaleString()} new · {todo ? `${todo} of ${count('changes')} to review` : count('changes') ? 'all changes ticked off' : 'nothing changed'}</span>
          {(r.oldPdf || r.newPdf) && <span className="chip st-wait" title="A PDF's table is rebuilt from the page: look at the PDF before relying on a change">read from PDF</span>}
          {view === 'side' && (
            <label className="check sm boq-partial" title="The new issue holds only the pages that changed: items it does not have are not counted as removed">
              <input type="checkbox" checked={s.partial} onChange={(e) => void startBoq(s.oldSet, s.newSet, e.target.checked)} /> New issue is changed pages only
            </label>
          )}
        </div>
        {view === 'side' ? <BoqSide s={s} /> : cur ? <Detail e={cur} s={s} /> : <div className="empty">Choose a change on the left (N goes to the next one).</div>}
      </main>
      {st.panels.right && view === 'list' && (
        <aside className="right">
          <div className="panel">
            <h3>BOQ comparison</h3>
            <div className="sumtable">
              <Row l="Items, old issue" v={r.old.items.length} />
              <Row l="Items, new issue" v={r.neu.items.length} />
              <Row l="Changed" v={boqChanged(s.entries)} />
              <Row l="Added" v={r.added.length} />
              <Row l="Removed" v={r.removed.length} />
              <Row l="Renumbered only" v={s.entries.filter((e) => e.kind === 'renumbered').length} />
              {s.partial && <Row l="Not in the pages issued" v={r.outside.length} />}
            </div>
            <div className="reviewline">{todo ? `${todo} of ${count('changes')} to review` : count('changes') ? 'All changes ticked off' : ''}</div>
            <label className="check sm" title="The new issue holds only the pages that changed: items it does not have are not counted as removed">
              <input type="checkbox" checked={s.partial} onChange={(e) => void startBoq(s.oldSet, s.newSet, e.target.checked)} /> New issue is changed pages only
            </label>
            {(r.oldPdf || r.newPdf) && <div className="infobox"><Icon n="info" size={15} /> {r.oldPdf && r.newPdf ? 'Both issues were' : r.oldPdf ? 'The old issue was' : 'The new issue was'} read from a PDF: its table is rebuilt from the page, so every change is marked "check" - look at the PDF before relying on it.</div>}
            <h3>Files</h3>
            <div className="bfiles">
              <div><span className="faint">Old:</span> {s.oldSet.files.map((f) => f.rel).join(', ')}</div>
              <div><span className="faint">New:</span> {s.newSet.files.map((f) => f.rel).join(', ')}</div>
            </div>
            {[...r.old.notes.map((n) => 'Old: ' + n), ...r.neu.notes.map((n) => 'New: ' + n)].slice(0, 8).map((n, i) => <div key={i} className="warnbox">{n}</div>)}
            <details className="bsheets">
              <summary>Sheets read ({r.old.sheets.filter((x) => x.items).length} old, {r.neu.sheets.filter((x) => x.items).length} new)</summary>
              {[['Old', r.old.sheets], ['New', r.neu.sheets] as const].map(([side, sh]) => (
                <div key={side as string}><b>{side as string}</b>{(sh as { name: string; items: number; skipped?: string }[]).map((x) => <div key={x.name} className="faint">{x.name}: {x.skipped ? x.skipped : `${x.items} items`}</div>)}</div>
              ))}
            </details>
          </div>
        </aside>
      )}
    </div>
  );
}

function Row({ l, v }: { l: string; v: number }) { return <div className="sumrow"><span>{l}</span><b>{v.toLocaleString()}</b></div>; }

function Where({ x, label }: { x: BoqItem; label: string }) {
  return <div className="bwhere"><span className="faint">{label}</span> {x.file ? <>{x.file} › </> : null}{x.sheet}, row {x.row} · page {x.page}{x.ref ? <> · item <b>{x.ref}</b></> : null}{x.mark ? <span className="chip st-new" title="Marked as revised in the BOQ (*)">*</span> : null}</div>;
}

function Diff({ a, b }: { a: string; b: string }) {
  if (a === b) return <span>{b}</span>;
  return <>{wordDiff(a, b).map((d, i) => (d.op === '=' ? <span key={i}>{d.t} </span> : d.op === '-' ? <s key={i} className="minus">{d.t} </s> : <span key={i} className="plus">{d.t} </span>))}</>;
}

function Detail({ e, s }: { e: BoqEntry; s: BoqSession }) {
  const a = e.o, b = e.n, p = e.pair;
  const ticked = s.ticked.has(e.k);
  if (e.pic) {
    const w = (x?: { file: string; page: number }) => (x ? `${x.file} · page ${x.page + 1}` : '-');
    return (
      <div className="bdetail">
        <div className="bhead">
          <span className="chip big st-changed">{summary(e)}</span>
          <span className="grow" />
          <button className={'btn sm' + (ticked ? ' on' : '')} onClick={() => { if (ticked) s.ticked.delete(e.k); else s.ticked.add(e.k); ticksChanged(); bump(); }} title="Tick off as reviewed (R)"><Icon n="check" size={14} /> {ticked ? 'Reviewed' : 'Reviewed - R'}</button>
        </div>
        <div className="bwhere"><span className="faint">Old:</span> {w(e.pic.o)}</div>
        <div className="bwhere"><span className="faint">New:</span> {w(e.pic.n)}</div>
        <div className="bblock"><div className="blabel">Picture</div><div className="btext">A picture inside the bill's pages {e.pic.what === 'changed' ? 'changed' : e.pic.what === 'added' ? 'is only in the new issue' : 'is not in the new issue'} - it is never read as items. Open "Side by side" and compare the boxed areas by eye.</div></div>
      </div>
    );
  }
  const head = (x: BoqItem) => [x.section, x.group].filter(Boolean).join(' › ');
  return (
    <div className="bdetail">
      <div className="bhead">
        <span className={'chip big ' + ({ added: 'st-new', removed: 'st-removed', heading: 'st-title', renumbered: 'st-same', changed: 'st-changed', pic: 'st-changed' } as const)[e.kind]}>{e.kind === 'changed' ? 'Changed' : e.kind === 'heading' ? 'Heading reworded' : e.kind === 'renumbered' ? 'Renumbered' : e.kind === 'added' ? 'Added' : 'Removed'}</span>
        {p?.moved && <span className="chip big st-run">Moved</span>}
        <span className="grow" />
        <button className={'btn sm' + (ticked ? ' on' : '')} onClick={() => { if (ticked) s.ticked.delete(e.k); else s.ticked.add(e.k); ticksChanged(); bump(); }} title="Tick off as reviewed (R)"><Icon n="check" size={14} /> {ticked ? 'Reviewed' : 'Reviewed - R'}</button>
      </div>
      {a && <Where x={a} label="Old:" />}
      {b && <Where x={b} label="New:" />}
      {e.kind === 'heading' ? (
        <>
          <div className="bblock"><div className="blabel">Heading</div><div className="btext"><Diff a={[a!.section, a!.group].filter(Boolean).join(' › ')} b={[b!.section, b!.group].filter(Boolean).join(' › ')} /></div></div>
          <div className="bblock"><div className="blabel">Read with it ({e.items!.length} items, otherwise the same)</div>
            {e.items!.map((q) => { const x = s.result!.neu.items[q.n]; return <div key={q.n} className="bitem"><b>{x.ref}</b> {x.text} <span className="faint">· {fmt(x.qty)} {x.unit}</span></div>; })}
          </div>
        </>
      ) : (
        <>
          {e.figs?.length ? <div className="bblock"><div className="blabel">Figures in the description</div><div className="btext sbs-figs">{e.figs.map((f, i) => <FigChip key={i} f={f} />)}</div></div> : null}
          {boqMates(s, e).length > 0 && <div className="bblock"><SameChange n={boqMates(s, e).length} what="in" noun={['item', 'items']} tick={() => { boqTickGroup(s, e); bump(); }} /></div>}
          {(a || b) && <div className="bblock"><div className="blabel">Heading</div><div className="btext faint">{a && b ? <Diff a={head(a)} b={head(b)} /> : head((b ?? a)!)}</div></div>}
          <div className="bblock"><div className="blabel">Description</div><div className="btext">{a && b ? <Diff a={a.text} b={b.text} /> : (b ?? a)!.text}</div>
            {(b ?? a)!.basis && <div className="faint">"Ditto": read with the item above it - {(b ?? a)!.basis}</div>}
          </div>
          <table className="btable">
            <thead><tr><th /><th>Qty</th><th>Unit</th><th>Rate</th><th>Amount</th></tr></thead>
            <tbody>
              {a && <tr><td className="faint">Old</td><td className={p?.changed.includes('qty') ? 'bchg' : ''}>{fmt(a.qty)}</td><td className={p?.changed.includes('unit') ? 'bchg' : ''}>{a.unit || '-'}</td><td className={p?.changed.includes('rate') ? 'bchg' : ''}>{fmt(a.rate)}</td><td className={p?.changed.includes('amount') ? 'bchg' : ''}>{fmt(a.amount)}</td></tr>}
              {b && <tr><td className="faint">New</td><td className={p?.changed.includes('qty') ? 'bchg' : ''}>{fmt(b.qty)}</td><td className={p?.changed.includes('unit') ? 'bchg' : ''}>{b.unit || '-'}</td><td className={p?.changed.includes('rate') ? 'bchg' : ''}>{fmt(b.rate)}</td><td className={p?.changed.includes('amount') ? 'bchg' : ''}>{fmt(b.amount)}</td></tr>}
              {a && b && typeof a.qty === 'number' && typeof b.qty === 'number' && p?.changed.includes('qty') && <tr><td className="faint">Change</td><td className="bchg">{(b.qty - a.qty > 0 ? '+' : '') + fmt(Math.round((b.qty - a.qty) * 1000) / 1000)}{a.qty ? ` (${(((b.qty - a.qty) / Math.abs(a.qty)) * 100).toFixed(1)} %)` : ''}</td><td colSpan={3} /></tr>}
            </tbody>
          </table>
        </>
      )}
      {p && <div className="faint bhow">{p.how === 'same' ? 'Paired by the same description.' : p.how === 'place' ? `Paired by its place between the items round it (descriptions ${Math.round(p.like * 100)} % alike).` : `Paired by likeness (${Math.round(p.like * 100)} % alike) - it is somewhere else now.`}{needsCheck(e, s) ? ' Worth a look.' : ''}</div>}
      {(e.o?.ocr || e.n?.ocr) && <div className="warnbox">Read from a scanned page (OCR): words and figures can be misread - check them on the page.</div>}
    </div>
  );
}
