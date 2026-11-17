// Updates in the window: the card that offers a new version (bottom right), the "what's new"
// after one, and the Updates part of Settings. The work is done in electron/updater.cjs.
import { useEffect, useState } from 'react';
import { rr, type UpdateState, type Updated } from './api';
import { ui, toast } from './model';
import { Icon } from './icons';

let current: UpdateState | null = null;
const subs = new Set<(s: UpdateState) => void>();
let wired = false;
function wire() {
  if (wired || !rr.onUpdate) return;
  wired = true;
  rr.onUpdate((s) => { current = s; for (const f of subs) f(s); });
  void rr.updateGet().then((s) => { current = s; for (const f of subs) f(s); }).catch(() => {});
}
export function useUpdate(): UpdateState | null {
  const [s, set] = useState<UpdateState | null>(current);
  useEffect(() => { wire(); subs.add(set); if (current) set(current); return () => { subs.delete(set); }; }, []);
  return s;
}

const STOPS = 'A comparison is running. Restarting stops it - the sheets already compared are kept: open it again from Recent comparisons.';
const mb = (n?: number) => (n ? ` · ${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB` : '');
const running = () => ui.session?.phase === 'comparing' || ui.session?.phase === 'reading' || ui.session?.phase === 'pairing';

function Notes({ notes, groups }: { notes?: string[]; groups?: Record<string, string[]> | null }) {
  if (groups && Object.keys(groups).length) {
    return <div className="unotes">{Object.entries(groups).map(([g, xs]) => <div key={g}><b>{g}</b><ul>{xs.map((x, i) => <li key={i}>{x}</li>)}</ul></div>)}</div>;
  }
  if (notes?.length) return <div className="unotes"><ul>{notes.map((x, i) => <li key={i}>{x}</li>)}</ul></div>;
  return <div className="unotes faint">No notes came with this version.</div>;
}

/** the card: a new version, its download, "restart now", or "needs the setup" */
export function UpdateCard() {
  const s = useUpdate();
  const [open, setOpen] = useState(false);
  const [ask, setAsk] = useState(false);
  const [after, setAfter] = useState<Updated | null>(null);
  // after an update (or going back): what's new, once
  useEffect(() => { void rr.updateAfterStart?.().then((u) => { if (u) setAfter(u); }).catch(() => {}); }, []);
  useEffect(() => { setAsk(false); }, [s?.state, s?.available]);

  const afterCard = after && (
    <div className="ucard uafter">
      <div className="uhead"><Icon n="check" size={16} /><b>{after.back ? `Rev Radar ${after.to} runs` : `Rev Radar is now ${after.to}`}</b><span className="grow" /><button className="btn sm ghost icon" title="Close" onClick={() => setAfter(null)}><Icon n="x" size={14} /></button></div>
      {after.back
        ? <p>{s?.pinned ? `You went back from ${after.from}. It is not offered again by itself; Settings has the way forward.` : `${after.from} is not in use any more on this PC.`}</p>
        : <Notes notes={after.notes} groups={after.groups} />}
    </div>
  );
  const offer = !!s && !!s.show && ['available', 'downloading', 'installing', 'ready', 'setup', 'error'].includes(s.state);
  if (!afterCard && !offer) return null;
  if (!offer || !s) return <div className="ucards">{afterCard}</div>;
  const v = s.available || '';
  const restart = () => {
    if (running() && !ask) { setAsk(true); return; }
    void rr.updateRestart('update');
  };
  return (
    <div className="ucards">
    {afterCard}
    <div className="ucard" role="dialog" aria-label="Update">
      <div className="uhead">
        <Icon n={s.state === 'error' ? 'info' : 'refresh'} size={16} />
        <b>{s.state === 'ready' ? `Rev Radar ${v} is ready` : s.state === 'setup' ? `Rev Radar ${v} needs the setup` : s.state === 'error' ? 'The update did not work' : `Rev Radar ${v} is available`}</b>
        <span className="grow" />
        {!['downloading', 'installing'].includes(s.state) && <button className="btn sm ghost icon" title="Later" onClick={() => void rr.updateLater()}><Icon n="x" size={14} /></button>}
      </div>
      {s.state === 'available' && (
        <>
          {s.note && <p>{s.note}</p>}
          <p>You have {s.version}.{mb(s.size)} · <button className="linkbtn" onClick={() => setOpen(!open)}>{open ? 'Hide' : "What's new"}</button></p>
          {open && <Notes notes={s.notes} groups={s.groups} />}
          <div className="uact"><span className="grow" /><button className="btn sm" onClick={() => void rr.updateLater()}>Later</button><button className="btn sm primary" onClick={() => void rr.updateDownload()}>Update</button></div>
        </>
      )}
      {(s.state === 'downloading' || s.state === 'installing') && (
        <>
          <div className="ubar"><i style={{ width: `${Math.round((s.pct || 0) * 100)}%` }} /></div>
          <div className="uact"><span className="faint">{s.state === 'installing' ? 'Unpacking…' : `Copying ${v}… ${Math.round((s.pct || 0) * 100)}%`}</span><span className="grow" />{s.state === 'downloading' && <button className="btn sm" onClick={() => void rr.updateCancel()}>Cancel</button>}</div>
        </>
      )}
      {s.state === 'ready' && (
        <>
          <p>{ask ? STOPS : s.pinned ? (s.left ? `You went back from it (to ${s.version}). Restart now to use it again.` : `You went back to ${s.version} before, so that one keeps starting until you restart now.`) : 'It starts the next time you open Rev Radar - or restart now.'}</p>
          {!ask && open && <Notes notes={s.notes} groups={s.groups} />}
          <div className="uact">{!ask && <button className="linkbtn" onClick={() => setOpen(!open)}>{open ? 'Hide' : "What's new"}</button>}<span className="grow" /><button className="btn sm" onClick={() => (ask ? setAsk(false) : void rr.updateLater())}>{ask ? 'Wait' : 'Later'}</button><button className="btn sm primary" onClick={restart}>{ask ? 'Restart anyway' : 'Restart now'}</button></div>
        </>
      )}
      {s.state === 'setup' && (
        <>
          <p>This version comes with a new runtime, so it is installed with its setup (once): download the setup from its release page, close Rev Radar, then run it.</p>
          <div className="uact"><span className="grow" /><button className="btn sm" onClick={() => void rr.updateLater()}>Later</button><button className="btn sm primary" disabled={!s.setupPath} onClick={() => void rr.updateShowSetup()}>{/^https?:/.test(s.setupPath || '') ? 'Open the release page' : 'Show the setup'}</button></div>
        </>
      )}
      {s.state === 'error' && (
        <>
          <p>{s.err || 'Something went wrong.'} The version you have is unchanged.</p>
          <div className="uact"><span className="grow" /><button className="btn sm" onClick={() => void rr.updateLater()}>Close</button><button className="btn sm primary" onClick={() => void rr.updateCheck()}>Try again</button></div>
        </>
      )}
    </div>
    </div>
  );
}

const when = (t: number) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
function statusLine(s: UpdateState): string {
  switch (s.state) {
    case 'off': return 'New versions are not looked for.';
    case 'checking': return 'Looking for a new version…';
    case 'none': return `Up to date${s.checked ? ' (looked ' + when(s.checked) + ')' : ''}.`;
    case 'pending': return `Rev Radar ${s.available} is being published - it isn't complete yet. It is offered once it is.`;
    case 'available': return `Rev Radar ${s.available} is available.`;
    case 'downloading': return `Downloading ${s.available}… ${Math.round((s.pct || 0) * 100)}%`;
    case 'installing': return `Unpacking ${s.available}…`;
    case 'ready': return s.pinned ? (s.left ? `Rev Radar ${s.available} is on this PC - you went back from it.` : `Rev Radar ${s.available} is on this PC - Restart now to use it.`) : `Rev Radar ${s.available} is ready - it starts the next time.`;
    case 'setup': return `Rev Radar ${s.available} needs the setup (new runtime).`;
    case 'unreachable': return s.err === 'stuck'
      ? 'GitHub isn\'t answering. Rev Radar works as usual and looks again after a restart.'
      : 'GitHub can\'t be reached from here (no internet?). Rev Radar works as usual.';
    case 'empty': return 'Nothing has been published yet.';
    case 'error': return s.err || 'The last check did not work.';
    default: return 'New versions are looked for 20 seconds after the start and every 4 hours.';
  }
}

/** Settings > Updates */
export function UpdateSettings() {
  const s = useUpdate();
  const [ask, setAsk] = useState<'back' | 'newest' | null>(null);
  if (!s) return null;
  const busy = ['checking', 'downloading', 'installing'].includes(s.state);
  const go = (w: 'back' | 'newest') => { toast(w === 'back' ? `Going back to ${s.previous}…` : `Starting ${s.newest}…`); void rr.updateRestart(w); };
  return (
    <div className="row">
      <label>Updates</label>
      <div className="ustatus">
        <span>Rev Radar {s.version}{s.pinned ? ' (you went back)' : ''}. {statusLine(s)}</span>
      </div>
      <div className="flexrow">
        <button className="btn sm" disabled={busy} onClick={() => void rr.updateCheck()}>Check now</button>
        {s.page && <button className="btn sm ghost" onClick={() => void rr.updateOpenPage()}>All versions</button>}
      </div>
      <span className="hint">
        New versions come from Rev Radar's releases on GitHub, signed by its maker: a version that isn't signed, or doesn't match what was signed, is refused. Rev Radar asks before it takes one. Without internet it just works as it is.
      </span>
      {ask && (
        <div className="flexrow">
          <span className="faint" style={{ flex: 1 }}>{STOPS}</span>
          <button className="btn sm" onClick={() => setAsk(null)}>Wait</button>
          <button className="btn sm primary" onClick={() => { const w = ask; setAsk(null); go(w); }}>Restart anyway</button>
        </div>
      )}
      {!ask && (s.previous || (s.pinned && s.newest)) && (
        <div className="flexrow">
          {s.previous && <button className="btn sm" onClick={() => (running() ? setAsk('back') : go('back'))} title="Rev Radar closes and opens again on the version you had before">Go back to {s.previous}</button>}
          {s.pinned && s.newest && <button className="btn sm" onClick={() => (running() ? setAsk('newest') : go('newest'))}>Use {s.newest} again</button>}
          <span className="faint">Rev Radar restarts.</span>
        </div>
      )}
    </div>
  );
}
