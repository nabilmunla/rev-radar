// Help and privacy (T12): Report a problem, the crash-report switch, what is sent, and the user count
// (its pop-up and Settings > Privacy). The work is done in electron/reports.cjs and counter.cjs;
// nothing leaves the PC without a receiver (the released build names one; from source: none - no pop-up, no switch).
import { useEffect, useState } from 'react';
import { rr, type ReportStatus, type CountState } from './api';
import { toast } from './model';
import { COUNT_TITLE, COUNT_BODY, COUNT_KEEP, COUNT_OFF, COUNT_SWITCH, COUNT_HINT } from './counttext';

/** what a problem report keeps of the text (reports.cjs) */
const REPORT_MAX = 20000;

function useReports(): [ReportStatus | null, (s: ReportStatus) => void] {
  const [st, setSt] = useState<ReportStatus | null>(null);
  useEffect(() => {
    let live = true;
    const get = () => void rr.reportStatus().then((x) => { if (live) setSt(x); }).catch(() => {});
    get();
    const off = rr.onReports(get);
    return () => { live = false; off(); };
  }, []);
  return [st, setSt];
}

/** Settings > Help: Report a problem; reports still waiting on this PC; crash reports (with a receiver) */
export function HelpSettings({ onReport, onLicences }: { onReport(): void; onLicences(): void }) {
  const [st, setSt] = useReports();
  const [example, setExample] = useState<string | null>(null);
  return (
    <div className="row">
      <label>Help</label>
      <div className="flexrow">
        <button className="btn sm" onClick={onReport}>Report a problem…</button>
        {st && st.waiting > 0 && <button className="btn sm ghost" onClick={() => void rr.reportOpenQueue()}>Show them</button>}
      </div>
      <span className="hint">
        {!st ? '' : st.waiting > 0
          ? `${st.waiting} report${st.waiting === 1 ? '' : 's'} on this PC${st.anon ? (st.state === 'failed' ? ' - sent once the internet can be reached' : ' - waiting to be sent') : ' (this version sends no reports: they stay here)'}.`
          : st.anon ? 'Report a problem sends your words to the developer, anonymously, when you press Send.' : 'This version sends no reports: Report a problem keeps yours on this PC.'}
      </span>
      <span className="hint">
        Rev Radar is free software under the GNU AGPL v3 or later. <button className="linkbtn" onClick={onLicences}>Licences</button> · <a className="linkbtn" href="https://github.com/nabilmunla/rev-radar" target="_blank" rel="noreferrer">Source code</a>
      </span>
      {st?.anon && (
        <>
          <label className="check sm">
            <input type="checkbox" checked={!!st.crashes} onChange={async (e) => { const on = e.target.checked; setSt({ ...st, crashes: on }); setSt(await rr.reportCrashSharing(on)); }} />
            <span>Send anonymous crash reports (off until you turn it on; only crashes from then on are sent)</span>
          </label>
          <details className="hint">
            <summary>What's sent, and where</summary>
            <p><b>Sent:</b> the app and Windows versions, memory, what went wrong (the error and the app's recent log) - and for Report a problem, the words you type.</p>
            <p><b>Taken out first:</b> your Windows user name, the PC's name, every file name, folder and path. The time is rounded to the hour.</p>
            <p><b>Never sent:</b> your drawings, BOQs or documents, or a picture of the screen.</p>
            <p><b>Where:</b> the developer's own small receiver, hosted on Cloudflare - no analytics or crash-reporting company. Like any web host, Cloudflare sees your internet address; the receiver doesn't keep it. Crash reports aren't kept on this PC either unless the box above is ticked.</p>
            <button className="btn sm" onClick={async () => setExample(example === null ? await rr.reportPreview() : null)}>{example === null ? 'Show an example' : 'Hide the example'}</button>
            {example !== null && <pre className="anon-example">{example}</pre>}
          </details>
        </>
      )}
    </div>
  );
}

/** Report a problem: the person's words, kept on this PC - and sent anonymously when there is a receiver */
export function ReportDlg({ onClose, openFiles, tab }: { onClose(): void; openFiles: number; tab: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [st] = useReports();
  const anon = !!st?.anon;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  const go = async () => {
    setSending(true);
    try {
      const r = await rr.reportProblem(text.trim(), { openFiles, tab });
      onClose();
      if (r.state === 'sent') toast('Sent anonymously - thank you.', 'ok', 6000);
      else if (r.anon) toast('Saved on this PC - it is sent anonymously once the internet can be reached.', undefined, 9000);
      else toast('Saved on this PC. Nothing was sent: this version sends no reports.', undefined, 9000, { label: 'Show', run: () => void rr.reportOpenQueue() });
    } catch (e) { setSending(false); toast(String((e as Error)?.message || e), 'err'); }
  };
  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal report-dlg" role="dialog" aria-label="Report a problem">
        <h2>Report a problem</h2>
        <p className="sub">What went wrong, and what did you expect? The more exact, the faster it gets fixed.</p>
        <textarea className="input report-text" autoFocus maxLength={REPORT_MAX} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. I compared two BOQs and an item that moved to another sheet showed as removed." />
        {text.length > REPORT_MAX * 0.9 && <p className="hint">{text.length.toLocaleString('en-GB')} of {REPORT_MAX.toLocaleString('en-GB')} characters</p>}
        {!st ? <p className="hint">&nbsp;</p> : anon
          ? <p className="hint">Sent anonymously to the developer's own receiver when you press Send: your words, the app and Windows versions and the app's recent log - with your user name, PC name, file names and folders taken out. Never your drawings, BOQs or documents.</p>
          : <p className="hint">This version of Rev Radar sends no reports: yours is kept on this PC only (Settings › Help › Show them), with the app and Windows versions and the app's recent log. Nothing leaves the PC.</p>}
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={sending || !text.trim() || !st} onClick={() => void go()}>{sending ? 'Sending…' : anon ? 'Send' : 'Save on this PC'}</button>
        </div>
      </div>
    </div>
  );
}

/** the user count's question, once (nothing is sent before it is answered); only with a receiver */
export function CountAsk() {
  const [ask, setAsk] = useState(false);
  useEffect(() => { void rr.countGet().then((c) => setAsk(c.ask)).catch(() => {}); }, []);
  if (!ask) return null;
  const answer = (on: boolean) => { setAsk(false); void rr.countSet(on); };
  return (
    <div className="scrim">
      <div className="modal count-ask" role="dialog" aria-label={COUNT_TITLE}>
        <h2>{COUNT_TITLE}</h2>
        {COUNT_BODY.map((p) => <p key={p} className="sub">{p}</p>)}
        <div className="actions">
          {/* (both the same weight; Keep it on is the default - the shared text's order) */}
          <button className="btn" autoFocus onClick={() => answer(true)}>{COUNT_KEEP}</button>
          <button className="btn" onClick={() => answer(false)}>{COUNT_OFF}</button>
        </div>
      </div>
    </div>
  );
}

/** Settings > Privacy: the user count's switch (only with a receiver) */
export function PrivacySettings() {
  const [c, setC] = useState<CountState | null>(null);
  useEffect(() => { void rr.countGet().then(setC).catch(() => {}); }, []);
  if (!c?.available) return null;
  return (
    <div className="row">
      <label>Privacy</label>
      <label className="check sm">
        <input type="checkbox" checked={c.on} onChange={async (e) => { const on = e.target.checked; setC({ ...c, on }); setC(await rr.countSet(on)); }} />
        <span>{COUNT_SWITCH}</span>
      </label>
      <span className="hint">{COUNT_HINT}</span>
    </div>
  );
}

/** the licence of the app and of the open-source parts in it (THIRD-PARTY-NOTICES.txt, shipped with the app) */
export function LicencesDlg({ onClose }: { onClose(): void }) {
  const [text, setText] = useState('Loading…');
  useEffect(() => { fetch('./THIRD-PARTY-NOTICES.txt').then((r) => (r.ok ? r.text() : Promise.reject(r.status))).then(setText).catch(() => setText('The licence file is missing from this copy.')); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide" role="dialog" aria-label="Licences">
        <h2>Licences</h2>
        <pre className="anon-example licences">{text}</pre>
        <div className="actions"><button className="btn primary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
