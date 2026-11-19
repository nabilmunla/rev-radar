// Start: choose the old issue and the new issue (folders or PDF files - dropped or picked),
// then compare. Recent comparisons open again in a click (their results are remembered).
import { useEffect, useRef, useState } from 'react';
import { rr, type FileItem, type Kind } from './api';
import { Icon, Logo } from './icons';
import { readSet, setLabel, sideLabels, startSession, whenSaved, type Recent } from './runner';
import { toast, plainError, kept } from './model';
import { startBoq, type BoqRecent } from './boqrun';
import { startDocs } from './docsrun';

/** what each tab says (drawings / BOQ / documents) */
const TEXT = {
  pdf: { hero: 'Drop in two issues of the same drawings. Every sheet is paired and compared, and you see at once which ones really changed and where.', oldSub: 'the drawings you have', newSub: 'the revision just received', drop: 'Drop a folder or PDF files here', files: 'PDF files…', none: 'No PDF drawings found there', hint: 'Choose both issues: a folder of PDFs, a few PDF files, or one combined PDF each.', what: 'PDF file' },
  boq: { hero: 'Drop in two issues of a bill of quantities. Every item is paired - wherever it went - and you see what changed: quantities, units, descriptions, items added, removed or moved.', oldSub: 'the BOQ you have', newSub: 'the BOQ just received', drop: 'Drop a BOQ (Excel or PDF), or a folder of bills', files: 'BOQ files…', none: 'No BOQ found there (Excel .xlsx / .xls, or PDF)', hint: 'Choose both issues: one workbook each, or a folder of bills each.', what: 'file' },
  docs: { hero: 'Drop in two issues of a specification or other document - or two folders of them. Paragraphs are paired wherever they went: you see what was reworded, added, removed or moved. Headers, footers and page numbers are left out; a change of a date alone is shown light.', oldSub: 'the documents you have', newSub: 'the issue just received', drop: 'Drop PDF / Word files or a folder here', files: 'Documents…', none: 'No PDF or Word (.docx) documents found there', hint: 'Choose both issues: a spec book each, a few files each, or a folder of sections each.', what: 'document' },
};

interface Side { paths: string[]; recursive: boolean; files: FileItem[] | null; reading: boolean }
const empty = (): Side => ({ paths: [], recursive: true, files: null, reading: false });

export function Home({ kind = 'pdf' }: { kind?: Kind }) {
  const T = TEXT[kind];
  // (a BOQ / Documents run that was stopped: its two sets are chosen again - T23)
  const k = kind === 'pdf' ? undefined : kept[kind];
  const [old, setOld] = useState<Side>(() => (k ? { ...empty(), paths: k.old.paths, files: k.old.files } : empty()));
  const [neu, setNeu] = useState<Side>(() => (k ? { ...empty(), paths: k.neu.paths, files: k.neu.files } : empty()));
  useEffect(() => { if (kind !== 'pdf') delete kept[kind]; }, [kind]);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [recentBoq, setRecentBoq] = useState<BoqRecent[]>([]);
  const [partial, setPartial] = useState(!!k?.partial);
  // (after the comparison just left has been saved: its row shows how far it got)
  // (the BOQ and Documents tabs keep lists of their own)
  const otherKey = kind === 'docs' ? 'recentDocs' : 'recentBoq';
  useEffect(() => { void whenSaved().then(() => rr.settings()).then((s) => { setRecent(s.recent || []); setRecentBoq(s[otherKey] || []); }); }, [otherKey]);

  // (one number per side: a slow earlier pick that finishes last is dropped - it put the folder before
  //  back in the box, RR-035)
  const reads = useRef(new Map<(s: Side) => void, number>());
  const load = async (paths: string[], recursive: boolean, set: (s: Side) => void) => {
    if (!paths.length) return;
    const my = (reads.current.get(set) || 0) + 1;
    reads.current.set(set, my);
    const latest = () => reads.current.get(set) === my;
    set({ paths, recursive, files: null, reading: true });
    try {
      const files = await readSet(paths, recursive, kind);
      if (!latest()) return;
      set({ paths, recursive, files, reading: false });
      if (!files.length) toast(T.none, 'warn');
    } catch (e) {
      if (!latest()) return;
      set({ paths: [], recursive, files: null, reading: false });
      toast('Could not read that: ' + plainError(e, 'it'), 'err');
    }
  };

  const go = async (o = old, n = neu, keep?: Recent) => {
    if (!o.files?.length || !n.files?.length) return;
    // the same drawings on both sides: every sheet would come out "identical"
    const inOld = new Set(o.files.map((f) => f.path.toLowerCase()));
    const both = n.files.filter((f) => inOld.has(f.path.toLowerCase())).length;
    if (both === n.files.length && both === o.files.length) { toast('Both issues are the same files - choose the old issue on the left and the new one on the right', 'err', 7000); return; }
    if (both > 0) toast(`${both} file${both === 1 ? ' is' : 's are'} in both issues (the same files) - they will show as identical`, 'warn', 7000);
    if (kind === 'docs') {
      const [lo, ln] = sideLabels(o.paths, n.paths);
      void startDocs({ label: lo, paths: o.paths, files: o.files }, { label: ln, paths: n.paths, files: n.files });
      return;
    }
    if (kind === 'boq') {
      const [lo, ln] = sideLabels(o.paths, n.paths);
      void startBoq({ label: lo, paths: o.paths, files: o.files }, { label: ln, paths: n.paths, files: n.files }, partial);
      return;
    }
    await startSession(
      { label: sideLabels(o.paths, n.paths)[0], paths: o.paths, recursive: o.recursive, files: o.files },
      { label: sideLabels(o.paths, n.paths)[1], paths: n.paths, recursive: n.recursive, files: n.files },
      keep ? { zones: keep.zones, reviewed: keep.reviewed, manual: keep.manual } : undefined,
    );
  };

  const openRecentBoq = async (r: BoqRecent) => {
    try {
      const [fo, fn] = await Promise.all([readSet(r.old.paths, true, kind), readSet(r.neu.paths, true, kind)]);
      if (!fo.length || !fn.length) { toast(kind === 'docs' ? 'Those documents are no longer there' : 'Those BOQs are no longer there', 'warn'); return; }
      const [lo, ln] = sideLabels(r.old.paths, r.neu.paths);
      if (kind === 'docs') void startDocs({ label: lo, paths: r.old.paths, files: fo }, { label: ln, paths: r.neu.paths, files: fn });
      else void startBoq({ label: lo, paths: r.old.paths, files: fo }, { label: ln, paths: r.neu.paths, files: fn }, !!r.partial);
    } catch (e) { toast('Could not open it: ' + plainError(e, 'it'), 'err'); }
  };
  const forgetBoq = async (r: BoqRecent) => {
    const s = await rr.settings();
    const list = ((s[otherKey] || []) as BoqRecent[]).filter((x) => x.when !== r.when);
    await rr.setSettings({ [otherKey]: list });
    setRecentBoq(list);
  };
  const openRecent = async (r: Recent) => {
    try {
      const [fo, fn] = await Promise.all([readSet(r.old.paths, r.old.recursive), readSet(r.neu.paths, r.neu.recursive)]);
      if (!fo.length || !fn.length) { toast('Those drawings are no longer there', 'warn'); return; }
      await go({ paths: r.old.paths, recursive: r.old.recursive, files: fo, reading: false }, { paths: r.neu.paths, recursive: r.neu.recursive, files: fn, reading: false }, r);
    } catch (e) { toast('Could not open it: ' + plainError(e, 'it'), 'err'); }
  };
  const forget = async (r: Recent) => {
    const s = await rr.settings();
    const list = (s.recent || []).filter((x: Recent) => x.when !== r.when);
    await rr.setSettings({ recent: list });
    setRecent(list);
  };

  // (not while a side is still being read: its answer would land on the other side)
  const swap = () => { if (old.reading || neu.reading) return; const o = old; setOld(neu); setNeu(o); };
  const ready = !!old.files?.length && !!neu.files?.length;

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-hero">
          <Logo size={54} />
          <div>
            <h1>{kind === 'boq' ? 'Compare BOQs' : kind === 'docs' ? 'Compare documents' : 'Rev Radar'}</h1>
            <p>{T.hero}</p>
          </div>
        </div>
        <div className="pick-row">
          <Picker kind={kind} title="Old issue" sub={T.oldSub} side={old} onPick={(p, r) => load(p, r, setOld)} onClear={() => { reads.current.set(setOld, (reads.current.get(setOld) || 0) + 1); setOld(empty()); }} onRecursive={(r) => (old.paths.length ? load(old.paths, r, setOld) : setOld({ ...old, recursive: r }))} />
          <button className="swap" title="Swap old and new" onClick={swap}><Icon n="swap" /></button>
          <Picker kind={kind} title="New issue" sub={T.newSub} side={neu} onPick={(p, r) => load(p, r, setNeu)} onClear={() => { reads.current.set(setNeu, (reads.current.get(setNeu) || 0) + 1); setNeu(empty()); }} onRecursive={(r) => (neu.paths.length ? load(neu.paths, r, setNeu) : setNeu({ ...neu, recursive: r }))} />
        </div>
        <div className="go-row">
          <button className="btn primary big" disabled={!ready} onClick={() => go()}><Icon n="play" size={16} /> Compare</button>
          {!ready && <span className="hint">{T.hint}</span>}
          {ready && <span className="hint">{old.files!.length} file{old.files!.length === 1 ? '' : 's'} against {neu.files!.length} file{neu.files!.length === 1 ? '' : 's'}</span>}
          {kind === 'boq' && <label className="check sm" title="The new issue holds only the pages that changed (an addendum's updated pages): items it does not have are not counted as removed"><input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} /> New issue is changed pages only</label>}
        </div>
        {kind !== 'pdf' && recentBoq.length > 0 && (
          <div className="recent">
            <h3>Recent {kind === 'docs' ? 'document' : 'BOQ'} comparisons</h3>
            {recentBoq.map((r) => (
              <div className="recent-row" key={r.when}>
                <button className="recent-open" onClick={() => openRecentBoq(r)} title={`${r.old.paths.join('\n')}\n→\n${r.neu.paths.join('\n')}`}>
                  <span className="rtext"><span className="rlabel">{r.label}</span><span className="rpath">{r.old.paths[0]}  →  {r.neu.paths[0]}</span></span>
                  <span className="rmeta">
                    {r.counts?.changes ? <span className="chip st-changed">{r.counts.changes} changes</span> : <span className="chip st-same">no changes</span>}
                    {r.counts?.added ? <span className="chip st-new">{r.counts.added} added</span> : null}
                    {r.counts?.removed ? <span className="chip st-removed">{r.counts.removed} removed</span> : null}
                    <span className="faint">{new Date(r.when).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  </span>
                </button>
                <button className="btn ghost icon sm" title="Remove from the list" onClick={() => forgetBoq(r)}><Icon n="x" size={14} /></button>
              </div>
            ))}
          </div>
        )}
        {kind === 'pdf' && recent.length > 0 && (
          <div className="recent">
            <h3>Recent comparisons</h3>
            {recent.map((r) => (
              <div className="recent-row" key={r.when}>
                <button className="recent-open" onClick={() => openRecent(r)} title={`${r.old.paths.join('\n')}\n→\n${r.neu.paths.join('\n')}`}>
                  <span className="rtext">
                    <span className="rlabel">{recent.some((x) => x !== r && x.label === r.label) ? `${twoLevels(r.old.paths)} → ${twoLevels(r.neu.paths)}` : r.label}</span>
                    <span className="rpath">{r.old.paths[0]}{r.old.paths.length > 1 ? ` +${r.old.paths.length - 1}` : ''}  →  {r.neu.paths[0]}{r.neu.paths.length > 1 ? ` +${r.neu.paths.length - 1}` : ''}</span>
                  </span>
                  <span className="rmeta">
                    {r.counts?.changed ? <span className="chip st-changed">{r.counts.changed} changed</span> : null}
                    {r.counts?.titleonly ? <span className="chip st-title">{r.counts.titleonly} title block</span> : null}
                    {(r.counts?.same || 0) + (r.counts?.identical || 0) ? <span className="chip st-same">{(r.counts?.same || 0) + (r.counts?.identical || 0)} same</span> : null}
                    {r.counts?.new ? <span className="chip st-new">{r.counts.new} new</span> : null}
                    {r.counts?.removed ? <span className="chip st-removed">{r.counts.removed} removed</span> : null}
                    {r.counts?.error ? <span className="chip st-err" title="Sheets that could not be compared">{r.counts.error} problem{r.counts.error === 1 ? '' : 's'}</span> : null}
                    {r.counts?.pending ? <span className="chip st-wait" title="Not compared yet (stopped or closed before the end) - open it to go on">{r.counts.pending} not compared</span> : null}
                    {r.counts?.ticked ? <span className="chip rev" title="Sheets ticked off as reviewed">{r.counts.ticked === r.counts.toReview && !r.counts.pending ? 'all reviewed' : `${r.counts.ticked} of ${r.counts.toReview}${r.counts.pending ? '+' : ''} reviewed`}</span> : null}
                    <span className="faint">{new Date(r.when).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  </span>
                </button>
                <button className="btn ghost icon sm" title="Remove from the list" onClick={() => forget(r)}><Icon n="x" size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** "ST\TD" for "...\Bids\ST\TD": two recent comparisons both called "old → new" told apart */
function twoLevels(paths: string[]): string {
  const p = (paths[0] || '').replace(/[\\/]+$/, '').split(/[\\/]/);
  return p.slice(-2).join('\\') + (paths.length > 1 ? ` + ${paths.length - 1}` : '');
}

function Picker({ kind, title, sub, side, onPick, onClear, onRecursive }: { kind: Kind; title: string; sub: string; side: Side; onPick: (paths: string[], recursive: boolean) => void; onClear: () => void; onRecursive: (r: boolean) => void }) {
  const T = TEXT[kind];
  const [over, setOver] = useState(false);
  const drop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const paths = [...e.dataTransfer.files].map((f) => rr.pathOf(f)).filter(Boolean);
    if (paths.length) onPick(paths, side.recursive);
  };
  const pickFolder = async () => { const p = await rr.openDialog({ title: `${title}: choose the folder`, folder: true, kind }); if (p.length) onPick(p, side.recursive); };
  const pickFiles = async () => { const p = await rr.openDialog({ title: `${title}: choose ${kind === 'boq' ? 'the BOQ' : kind === 'docs' ? 'the documents' : 'PDF'} files`, kind }); if (p.length) onPick(p, side.recursive); };
  const n = side.files?.length || 0;
  return (
    <div className={'picker' + (over ? ' over' : '') + (n ? ' has' : '')} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
      <div className="ptitle">{title}</div>
      <div className="psub">{sub}</div>
      {side.reading && <div className="pstate"><span className="dot busy" /> Reading…</div>}
      {!side.reading && !n && (
        <div className="pempty">
          <Icon n="folder" size={30} sw={1.3} />
          <div>{T.drop}</div>
          <div className="pbtns">
            <button className="btn" onClick={pickFolder}><Icon n="folder" size={16} /> Folder…</button>
            <button className="btn" onClick={pickFiles}><Icon n="files" size={16} /> {T.files}</button>
          </div>
        </div>
      )}
      {!side.reading && n > 0 && (
        <div className="pfull">
          <div className="ppath" title={side.paths.join('\n')}><Icon n={side.paths.length === 1 && !/\.(pdf|xlsx?|xlsm|docx)$/i.test(side.paths[0]) ? 'folder' : 'files'} size={16} /> {setLabel(side.paths)}</div>
          <div className="pcount"><b>{n}</b> {T.what}{n === 1 ? '' : 's'} · {((mb) => (mb < 1 ? 'under 1' : mb.toFixed(0)))(side.files!.reduce((s, f) => s + f.size, 0) / 1e6)} MB</div>
          <div className="plist">{side.files!.slice(0, 7).map((f) => <div key={f.path} className="pf" title={f.path}>{f.rel}</div>)}{n > 7 && <div className="pf faint">and {n - 7} more…</div>}</div>
          <div className="pbtns">
            <button className="btn sm" onClick={pickFolder}>Other folder…</button>
            <button className="btn sm" onClick={pickFiles}>Other files…</button>
            <button className="btn sm ghost" onClick={onClear}>Clear</button>
          </div>
        </div>
      )}
      <label className="check sm" title="Look in sub folders of a chosen folder too">
        <input type="checkbox" checked={side.recursive} onChange={(e) => onRecursive(e.target.checked)} /> Include sub folders
      </label>
    </div>
  );
}
