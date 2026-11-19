// The busy line of a long job (T23, DECISIONS 96): what it is doing, the time so far, Stop - and past
// three minutes, that it is taking longer than usual. BOQ and Documents compares and the PDF export have no
// time limit (a 3,000-page book with OCR is honest work); Stop is the way out.
import { useEffect, useState } from 'react';
import { Icon } from './icons';

/** past this long the line says it is taking longer than usual (ms; tests shorten it: localStorage rr-slow-ms) */
export const slowAfter = (): number => { try { return Number(localStorage.getItem('rr-slow-ms')) || 180_000; } catch { return 180_000; } };

/** seconds so far in words: "42 s", "3 min 05 s" */
export function soFar(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

export function BusyLine({ what, since, onStop, stopTitle }: { what: string; since: number; onStop: () => void; stopTitle?: string }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => { const t = setInterval(() => setNow(performance.now()), 1000); return () => clearInterval(t); }, []);
  const ms = now - since;
  return (
    <div className="busyline" role="status">
      <div className="btext"><span className="dot busy" /> {what}</div>
      <div className="btime faint">{soFar(ms)} so far{ms >= slowAfter() ? ' - taking longer than usual' : ''}</div>
      <button className="btn sm" onClick={onStop} title={stopTitle || 'Stop and go back - nothing is kept'}><Icon n="stop" size={13} /> Stop</button>
    </div>
  );
}
