import { useEffect, useMemo, useState } from 'react';
import { ui, bump, useUI, DEFAULTS, toast, type Settings } from './model';
import { rr } from './api';
import { Icon, Logo } from './icons';
import { Home } from './Home';
import { Results } from './Results';
import { startEngines, engineCount, workers } from './engines';
import { poolStarted } from './viewpool';
import { startSession, leave, releasePictures, tickKey } from './runner';
import { exportExcel, exportPdf, exportJob } from './exporting';
import { BusyLine, soFar } from './busy';
import type { ViewStuck } from './engines';
import { UpdateCard, UpdateSettings } from './Update';
import { BoqResults } from './Boq';
import { leaveBoq, exportBoqExcel } from './boqrun';
import { DocsResults } from './Docs';
import { leaveDocs, exportDocsExcel } from './docsrun';
import { HelpSettings, ReportDlg, CountAsk, PrivacySettings, LicencesDlg } from './Privacy';
import { readPanels } from './panels';

/** the view notice (T23, DECISIONS 118, 120): its time counts on, like the busy line */
function StuckLine({ v, onKeep, onRestart }: { v: ViewStuck; onKeep: () => void; onRestart: () => void }) {
  const since = useMemo(() => performance.now() - v.ms, [v]);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => { const t = setInterval(() => setNow(performance.now()), 1000); return () => clearInterval(t); }, []);
  return (
    <div className="stuckline" role="alert">
      <span>The sheet is taking a long time to draw - {soFar(now - since)} so far. A very large drawing can take a minute or two.</span>
      <button className="btn sm" onClick={onKeep}>Keep waiting</button>
      <button className="btn sm" onClick={onRestart} title="Stops the picture being drawn and starts the viewer again - nothing you have compared is lost">Restart the view</button>
    </div>
  );
}

export function App() {
  const st = useUI();
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [licencesOpen, setLicencesOpen] = useState(false);
  const [version, setVersion] = useState('');

  useEffect(() => {
    rr.up?.();
    (async () => {
      try {
        const [info, s] = await Promise.all([rr.info(), rr.settings()]);
        setVersion(info.version);
        ui.settings = { ...DEFAULTS, ...(s.compare || {}) };
        ui.theme = s.theme === 'dark' ? 'dark' : 'light';
        ui.listMode = s.listMode === 'grid' ? 'grid' : 'rows';
        ui.panels = readPanels(s.panels);
        if (typeof s.skipTiny === 'boolean') ui.skipTiny = s.skipTiny;
        if (typeof s.highlight === 'boolean') ui.highlight = s.highlight;
        document.documentElement.dataset.theme = ui.theme;
        const n = engineCount(info.cores, info.memGB, rr.engines || info.engines || Number(s.engines) || 0);
        ui.engines = n;
        // (a second view engine makes the next sheet ready - one more process, ~100 MB idle)
        await startEngines(n, rr.viewers ? rr.viewers >= 2 : info.memGB >= 6);
        poolStarted(info.memGB);
        setReady(true);
        bump();
      } catch (e) { setErr(String((e as Error)?.message || e)); }
    })();
  }, []);

  // a view engine that has not answered for 90 s (T23): said over the sheet; never restarted unasked - a blended
  // A0 can honestly take a minute. "Keep waiting" is asked again when the call has run twice as long (engines.ts).
  const [stuckView, setStuckView] = useState<ViewStuck | null>(null);
  useEffect(() => {
    const on = (e: Event) => setStuckView((e as CustomEvent<ViewStuck>).detail);
    const over = (e: Event) => setStuckView((v) => (v && v.engine === (e as CustomEvent<string>).detail ? null : v));
    window.addEventListener('rr-view-stuck', on);
    window.addEventListener('rr-view-stuck-over', over);
    return () => { window.removeEventListener('rr-view-stuck', on); window.removeEventListener('rr-view-stuck-over', over); };
  }, []);

  const b = st.boq, d = st.docs;
  useEffect(() => {
    const on = st.tab === 'boq' ? b : st.tab === 'docs' ? d : st.session;
    void rr.setTitle(on ? `${on.oldSet.label} → ${on.newSet.label}${st.tab === 'boq' ? ' (BOQ)' : st.tab === 'docs' ? ' (documents)' : ''} - Rev Radar` : 'Rev Radar');
  }, [st.session, b, d, st.tab]);
  const tabTo = (t: typeof st.tab) => { ui.tab = t; bump(); };

  const s = st.session;
  const newComparison = () => { leave(); releasePictures(); ui.session = null; ui.selected = null; bump(); };
  const again = () => { if (!s) return; void startSession(s.oldSet, s.newSet, { zones: s.zones, manual: s.manual, reviewed: s.pairs.filter((p) => p.reviewed).map(tickKey) }); };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><Logo size={22} /><span className="word">Rev <b>Radar</b></span></div>
        <nav className="tabs" aria-label="What to compare">
          <button className={'tab' + (st.tab === 'drawings' ? ' on' : '')} onClick={() => tabTo('drawings')} title="Compare two issues of drawings (PDF)"><Icon n="overlay" size={15} /> Drawings{s && st.tab !== 'drawings' ? <span className="tabdot" title="A comparison is open here" /> : null}</button>
          <button className={'tab' + (st.tab === 'boq' ? ' on' : '')} onClick={() => tabTo('boq')} title="Compare two issues of a bill of quantities (Excel or PDF)"><Icon n="sheet" size={15} /> BOQ{b && st.tab !== 'boq' ? <span className="tabdot" title="A comparison is open here" /> : null}</button>
          <button className={'tab' + (st.tab === 'docs' ? ' on' : '')} onClick={() => tabTo('docs')} title="Compare two issues of specifications or other documents (PDF or Word)"><Icon n="pdf" size={15} /> Documents{d && st.tab !== 'docs' ? <span className="tabdot" title="A comparison is open here" /> : null}</button>
        </nav>
        {st.tab === 'docs' && d && (
          <div className="crumb">
            <button onClick={leaveDocs} title="Start a new document comparison"><Icon n="home" size={15} /></button>
            <span className="pname" title={d.oldSet.paths.join('\n')}>{d.oldSet.label}</span>
            <span className="sep">→</span>
            <span className="pname" title={d.newSet.paths.join('\n')}>{d.newSet.label}</span>
          </div>
        )}
        {st.tab === 'boq' && b && (
          <div className="crumb">
            <button onClick={leaveBoq} title="Start a new BOQ comparison"><Icon n="home" size={15} /></button>
            <span className="pname" title={b.oldSet.paths.join('\n')}>{b.oldSet.label}</span>
            <span className="sep">→</span>
            <span className="pname" title={b.newSet.paths.join('\n')}>{b.newSet.label}</span>
          </div>
        )}
        {st.tab === 'drawings' && s && (
          <div className="crumb">
            <button onClick={newComparison} title="Start a new comparison"><Icon n="home" size={15} /></button>
            <span className="pname" title={s.oldSet.paths.join('\n')}>{s.oldSet.label}</span>
            <span className="sep">→</span>
            <span className="pname" title={s.newSet.paths.join('\n')}>{s.newSet.label}</span>
          </div>
        )}
        <span className="spacer" />
        {st.tab === 'docs' && d?.phase === 'done' && <button className="tb-btn" onClick={() => void exportDocsExcel()} title="Every change, paragraph by paragraph, old against new"><Icon n="sheet" size={16} /> Excel</button>}
        {st.tab === 'boq' && b?.phase === 'done' && <button className="tb-btn" onClick={() => void exportBoqExcel()} title="Every change, item by item, old against new"><Icon n="sheet" size={16} /> Excel</button>}
        {st.tab === 'drawings' && s && s.pairs.length > 0 && (
          <>
            <button className="tb-btn" onClick={() => exportPdf('changed')} title="The changed sheets of the new issue, every change clouded and numbered"><Icon n="pdf" size={16} /> Clouded PDF</button>
            <button className="tb-btn" onClick={() => exportExcel()} title="Every sheet with its status and what changed"><Icon n="sheet" size={16} /> Excel</button>
          </>
        )}
        <button className="tb-btn" onClick={() => { ui.theme = ui.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = ui.theme; void rr.setTheme(ui.theme); void rr.setSettings({ theme: ui.theme }); bump(); }} title="Light / dark"><Icon n={st.theme === 'dark' ? 'sun' : 'moon'} size={16} /></button>
        <button className="tb-btn" onClick={() => setSettingsOpen(true)} title="Settings"><Icon n="settings" size={16} /></button>
      </header>
      {(exportJob.cur || stuckView) && (
        <div className="floatline">
          {exportJob.cur && <BusyLine what={exportJob.cur.what} since={exportJob.cur.t0} onStop={exportJob.cur.stop} stopTitle="Stop writing the PDF - nothing is saved" />}
          {stuckView && (
            <StuckLine v={stuckView} onKeep={() => setStuckView(null)} onRestart={() => { const v = stuckView; setStuckView(null); v.restart(); }} />
          )}
        </div>
      )}
      <div className="sheet">
        {err && <div className="empty"><h3>Rev Radar could not start</h3><p>Close it and open it again. If this screen comes back, install Rev Radar again.</p><p className="detail">Detail: {err}</p></div>}
        {!err && !ready && <div className="empty"><span className="dot busy" /> Starting…</div>}
        {ready && st.tab === 'drawings' && !s && <Home key="pdf" />}
        {ready && st.tab === 'drawings' && s && <Results />}
        {ready && st.tab === 'boq' && !b && <Home key="boq" kind="boq" />}
        {ready && st.tab === 'boq' && b && <BoqResults />}
        {ready && st.tab === 'docs' && !d && <Home key="docs" kind="docs" />}
        {ready && st.tab === 'docs' && d && <DocsResults />}
      </div>
      <footer className="statusbar">
        <span className="s">{ready ? `${st.engines} sheet${st.engines === 1 ? '' : 's'} at a time` : 'starting'}</span>
        {st.tab === 'drawings' && (() => {
          // the settings the comparison on screen runs with (a Save meanwhile is for the next one)
          const cur = st.session?.settings || st.settings;
          const next = JSON.stringify(cur) !== JSON.stringify(st.settings);
          return <span className="s" title={next ? 'Settings saved for the next comparison' : undefined}>Checking at {cur.dpi} dpi · tolerance {cur.tolMM} mm{next ? ` · next comparison: ${st.settings.dpi} dpi, ${st.settings.tolMM} mm` : ''}</span>;
        })()}
        <span className="grow" />
        <span className="s">Rev Radar {version}</span>
      </footer>
      {settingsOpen && <SettingsDlg onClose={() => setSettingsOpen(false)} onAgain={s ? again : undefined} onReport={() => { setSettingsOpen(false); setReportOpen(true); }} onLicences={() => { setSettingsOpen(false); setLicencesOpen(true); }} />}
      {licencesOpen && <LicencesDlg onClose={() => setLicencesOpen(false)} />}
      {reportOpen && <ReportDlg onClose={() => setReportOpen(false)} tab={st.tab} openFiles={st.tab === 'boq' ? (b ? b.oldSet.paths.length + b.newSet.paths.length : 0) : st.tab === 'docs' ? (d ? d.oldSet.paths.length + d.newSet.paths.length : 0) : (s ? s.pairs.length : 0)} />}
      {ready && <UpdateCard />}
      {ready && <CountAsk />}
      <div className="toasts">
        {st.toast.map((t) => (
          <div key={t.id} className="toast"><span className="bar" style={{ background: t.kind === 'err' ? 'var(--danger)' : t.kind === 'warn' ? 'var(--warn)' : t.kind === 'ok' ? 'var(--ok)' : 'var(--gold-300)' }} />
            <span className="ttext">{t.text}</span>
            {t.action && <button className="tbtn" onClick={() => { t.action!.run(); ui.toast = ui.toast.filter((x) => x.id !== t.id); bump(); }}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsDlg({ onClose, onAgain, onReport, onLicences }: { onClose: () => void; onAgain?: () => void; onReport: () => void; onLicences: () => void }) {
  const [v, setV] = useState<Settings>({ ...ui.settings });
  const [engines, setEngines] = useState<number>(0);
  const [cache, setCache] = useState<number | null>(null);
  useEffect(() => { void rr.settings().then((s) => setEngines(Number(s.engines) || 0)); void rr.cacheSize().then(setCache); }, []);
  const changed = JSON.stringify(v) !== JSON.stringify(ui.settings);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  const save = async (again: boolean) => {
    ui.settings = { ...v };
    await rr.setSettings({ compare: v, engines });
    bump();
    onClose();
    if (again && onAgain) onAgain();
  };
  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>Settings</h2>
        <p className="sub">How closely sheets are checked. The defaults suit A0-A3 drawings.</p>
        <div className="row">
          <label>Checking resolution</label>
          <div className="seg full">
            {[[100, 'Fast (100 dpi)'], [150, 'Standard (150 dpi)'], [200, 'Fine (200 dpi)'], [300, 'Finest (300 dpi)']].map(([d, l]) => <button key={d} className={v.dpi === d ? 'on' : ''} onClick={() => setV({ ...v, dpi: d as number })}>{l}</button>)}
          </div>
          <span className="hint">Higher finds smaller changes and takes longer. Standard catches a changed digit in a 1.8 mm dimension.</span>
        </div>
        <div className="row">
          <label>Ignore movements smaller than</label>
          <div className="seg full">
            {[[0.15, '0.15 mm'], [0.25, '0.25 mm'], [0.4, '0.4 mm'], [0.6, '0.6 mm']].map(([d, l]) => <button key={d} className={v.tolMM === d ? 'on' : ''} onClick={() => setV({ ...v, tolMM: d as number })}>{l}</button>)}
          </div>
          <span className="hint">Lines that moved less than this on paper count as unchanged (re-plotting jitter). Raise it for scanned drawings.</span>
        </div>
        <div className="row">
          <label>Join changes closer than</label>
          <div className="seg full">
            {[[1.5, '1.5 mm'], [3, '3 mm'], [6, '6 mm'], [12, '12 mm']].map(([d, l]) => <button key={d} className={v.joinMM === d ? 'on' : ''} onClick={() => setV({ ...v, joinMM: d as number })}>{l}</button>)}
          </div>
          <span className="hint">Changes this close together become one numbered change.</span>
        </div>
        <div className="row">
          <label>Sheets compared at once</label>
          <select className="input" value={engines} onChange={(e) => setEngines(Number(e.target.value))}>
            <option value={0}>As many as this PC can carry (now {workers.length})</option>
            {[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span className="hint">Each one can use 1-1.5 GB of memory on a dense A0 sheet. Takes effect at the next start.</span>
        </div>
        <UpdateSettings />
        <HelpSettings onReport={onReport} onLicences={onLicences} />
        <PrivacySettings />
        <div className="row">
          <label>Remembered results</label>
          <div className="flexrow"><span className="faint">{cache == null ? '…' : `${(cache / 1e6).toFixed(0)} MB`}</span><button className="btn sm" onClick={async () => { await rr.cacheClear(); setCache(0); toast('Remembered results cleared'); }}>Clear</button></div>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => setV({ ...DEFAULTS })}>Defaults</button>
          <span className="grow" />
          <button className="btn" onClick={onClose}>Cancel</button>
          {changed && onAgain && <button className="btn" onClick={() => save(false)} title="For the next comparison; the results on screen stay as they are">Save</button>}
          {changed && onAgain ? <button className="btn primary" onClick={() => save(true)}>Save and compare again</button> : <button className="btn primary" onClick={() => save(false)}>Save</button>}
        </div>
      </div>
    </div>
  );
}
