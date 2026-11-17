// Exports: the marked-up PDF (new sheets with numbered clouds + a summary page) and the
// Excel list of every sheet with its status and what changed.
import { rr } from './api';
import { freshExporter, closeExporter } from './engines';
import { ui, realAreas, areaLabels, statusLabel, movedNote, moveWords, seamTitle, where, plainError, toast, bump, textGroups, groupOfArea, isFigText, type Pair, type AreaR } from './model';
import { writeXlsx, type XCell } from './xlsxwrite';

/** where to save (tests set this to skip the dialog) */
async function savePath(opts: Parameters<typeof rr.saveDialog>[0]): Promise<string | null> {
  const forced = (window as unknown as { __rrSaveAs?: string }).__rrSaveAs;
  if (forced) { (window as unknown as { __rrSaveAs?: string }).__rrSaveAs = ''; return forced; }
  return rr.saveDialog(opts);
}
const stamp = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

export function describe(a: AreaR): string {
  const parts: string[] = [];
  for (const t of a.text) {
    if (t.kind === 'changed') parts.push(`${t.from} → ${t.to}`);
    else if (t.kind === 'added') parts.push(`added "${t.to}"`);
    else if (t.kind === 'removed') parts.push(`removed "${t.from}"`);
  }
  if (a.seam) return `${seamTitle(a.seam)} - the lines running across were drawn ${a.seam.shorter ? 'shorter' : 'longer'}`;
  if (a.shift?.stretched) return `Part of the drawing moved ${moveWords(a.shift.dx, a.shift.dy)} and the lines running into it got ${a.shift.shorter ? 'shorter (the drawing was shortened there)' : 'longer (the drawing was stretched there)'} - lined up on its own; what changed in it is listed separately`;
  if (a.shift) return `Moved ${moveWords(a.shift.dx, a.shift.dy)} on the sheet as a whole, nothing in it changed - a view placed elsewhere, or something moved in the drawing (check which); lined up on its own, what changed in it is listed separately`;
  if (a.cloud === 'added') return 'Revision cloud added - nothing changed inside it';
  if (a.cloud === 'removed') return 'Old revision cloud taken off';
  if (a.pattern) return 'Dashes / hatch redrawn - the line did not move';
  const what = kindOf(a);
  return parts.length ? `${what}: ${parts.slice(0, 6).join('; ')}${parts.length > 6 ? ` (+${parts.length - 6} more)` : ''}` : `${what} drawing content`;
}

/** Added / Removed / Changed - a pair of words that changed is a change, whatever the ink says */
export function kindOf(a: AreaR): string {
  if (a.shift) return a.shift.stretched ? (a.shift.shorter ? 'Shortened' : 'Stretched') : 'Moved';
  if (a.seam) return a.seam.shorter ? 'Shortened' : 'Stretched';
  if (a.text.some((t) => t.kind === 'changed') || (a.text.some((t) => t.kind === 'added') && a.text.some((t) => t.kind === 'removed'))) return 'Changed';
  return a.kind === 'added' ? 'Added' : a.kind === 'removed' ? 'Removed' : 'Changed';
}

export async function exportExcel() {
  const s = ui.session;
  if (!s) return;
  const out = await savePath({ title: 'Save the sheet list', defaultPath: `Rev Radar - ${safe(s.oldSet.label)} to ${safe(s.newSet.label)} - ${stamp()}.xlsx`, filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
  if (!out) return;
  const head: XCell[] = ['No.', 'Sheet', 'Title', 'Status', 'Changes', 'What changed (text)', 'Figures', 'Group', 'Title block changes', 'Moved on the sheet', 'Problem', 'Old file', 'New file', 'Paired by', 'Reviewed'].map((v) => ({ v, s: 'h' as const }));
  const rows: XCell[][] = [head];
  // (T8) the same text change on 3 or more sheets: a group - "G1 (4 sheets)"
  const groups = textGroups(s.pairs);
  const gid = new Map([...groups.keys()].map((k, i) => [k, i + 1]));
  const gname = (key: string) => `G${gid.get(key)} (${groups.get(key)!.sheets.length} sheets)`;
  const figText = (t: AreaR['text']) => words(t.filter(isFigText));
  s.pairs.forEach((p, i) => {
    const ok = counted(p);
    const real = ok ? realAreas(p) : [];
    const text = words(real.flatMap((k) => p.result!.areas[k].text));
    // (the title block: issue status, revision, "not for tender" - what a tender needs to know)
    const tb = ok ? titleBlockText(p) : '';
    rows.push([i + 1, p.key, p.title, statusLabel(p), ok ? real.length : null, text, ok ? figText(real.flatMap((k) => p.result!.areas[k].text)) : '', ok ? [...new Set(real.map((k) => groupOfArea(groups, p, k)?.key).filter((k): k is string => !!k))].map(gname).join('; ') : '', tb, movedNote(p), p.status === 'error' ? p.error || '' : '',
      fileOf(p.old), fileOf(p.neu),
      { name: 'File name', number: 'Drawing number', content: 'Sheet content', order: 'Order', hand: 'By hand', none: '' }[p.how], p.reviewed ? 'Yes' : '']);
  });
  // second sheet: every change area of changed sheets
  const rows2: XCell[][] = [['Sheet', 'Change', 'Kind', 'Description', 'Figures', 'Group', 'Where on the sheet', 'Position x (mm)', 'Position y (mm)'].map((v) => ({ v, s: 'h' as const }))];
  for (const p of s.pairs) {
    if (p.status !== 'changed' || !p.result) continue;
    const lab = areaLabels(p);
    for (const k of realAreas(p)) {
      const a = p.result.areas[k];
      rows2.push([p.key, Number(lab[k]), kindOf(a), describe(a), figText(a.text), (() => { const g = groupOfArea(groups, p, k); return g ? gname(g.key) : ''; })(), where(a.box, p.result.newSize), Math.round(((a.box[0] + a.box[2]) / 2) * 25.4 / 72), Math.round(((a.box[1] + a.box[3]) / 2) * 25.4 / 72)]);
    }
  }
  const xl = writeXlsx([
    { name: 'Sheets', rows, widths: [6, 28, 34, 16, 9, 60, 24, 16, 40, 34, 40, 50, 50, 14, 10], header: 1 },
    { name: 'Changes', rows: rows2, widths: [28, 9, 10, 80, 24, 16, 16, 14, 14], header: 1 },
  ]);
  try {
    await rr.write(out, xl);
  } catch (e) {
    toast('Could not save the sheet list: ' + plainError(e, 'the file'), 'err', 9000);
    return;
  }
  toast('Sheet list saved' + stillComparing(s), 'ok', 6000);
  void rr.showInFolder(out);
}

/** text changes as one line: "302 → 300; + NOTE 4; - NOT FOR TENDER" (the rest counted, not cut off silently) */
function words(t: AreaR['text']): string {
  const all = t.filter((x) => x.kind !== 'moved');
  const s = all.slice(0, 30).map((x) => (x.kind === 'changed' ? `${x.from} → ${x.to}` : x.kind === 'added' ? `+ ${x.to}` : `- ${x.from}`)).join('; ');
  return all.length > 30 ? `${s}; … (+${all.length - 30} more)` : s;
}

/** the title block's text changes, one phrase per changed spot ("DETAILED DESIGN 100% SUBMISSION →
 *  ISSUED FOR CONSTRUCTION"), each once - word pairs alone read as nonsense there */
function titleBlockText(p: Pair): string {
  const out: string[] = [];
  p.result!.areas.forEach((a, k) => {
    if (!p.common?.[k]) return;
    const t = a.text.filter((x) => x.kind !== 'moved');
    const was = t.filter((x) => x.kind !== 'added').map((x) => x.from).filter(Boolean).join(' ');
    const now = t.filter((x) => x.kind !== 'removed').map((x) => x.to).filter(Boolean).join(' ');
    const ph = was && now ? `${was} → ${now}` : was ? `- ${was}` : now ? `+ ${now}` : '';
    if (ph && !out.includes(ph)) out.push(ph);
  });
  return out.join('; ');
}

/** a file and (in a combined PDF) its page */
const fileOf = (r: Pair['old']) => (r ? r.rel + (r.pages > 1 ? ` (p.${r.page + 1})` : '') : '');

/** why a sheet could not be compared, short ("new issue's file: damaged or cut short") */
function problemShort(p: Pair): string {
  if (p.status === 'error') return (p.error || 'could not be compared').replace(/^Could not read the /, '').replace(/\.? ?Ask for .*$/, '').replace(/\.$/, '');
  if (p.status === 'waiting' || p.status === 'running') return 'not compared yet';
  return '';
}

/** where on the sheet a box is, in words ("top left", "centre") */

/** a note when the export was made while sheets are still being compared (or the comparison was stopped) */
function stillComparing(s: NonNullable<typeof ui.session>): string {
  const n = s.pairs.filter((p) => p.status === 'waiting' || p.status === 'running').length;
  if (!n) return '';
  return s.phase === 'stopped'
    ? ` - the comparison was stopped: ${n} sheet${n === 1 ? ' is' : 's are'} not compared and not in it`
    : ` - ${n} sheet${n === 1 ? ' is' : 's are'} still being compared and not in it yet`;
}
/** its changes count (a sheet that could not be compared after all - an odd page size - has a
 *  result whose changes mean nothing) */
const counted = (p: Pair) => !!p.result && p.status !== 'error';

/** one PDF at a time: a second export started meanwhile closed the first one's engine (it never
 *  finished, and said nothing) */
let pdfBusy = false;
export async function exportPdf(which: 'changed' | 'all' | 'one', one?: Pair) {
  if (pdfBusy) { toast('A PDF is being written already - wait for it to finish', 'warn'); return; }
  pdfBusy = true;
  try { await writePdf(which, one); } finally { pdfBusy = false; }
}
async function writePdf(which: 'changed' | 'all' | 'one', one?: Pair) {
  const s = ui.session;
  if (!s) return;
  // the changed sheets - and the new ones (a drawing nobody has seen yet is the biggest change)
  const list = which === 'one' && one ? [one] : s.pairs.filter((p) => p.neu && (which === 'all' ? true : p.status === 'changed' || p.status === 'new'));
  if (!list.length) { toast('No changed sheets to export yet', 'warn'); return; }
  const out = await savePath({ title: 'Save the marked-up PDF', defaultPath: `Rev Radar - ${which === 'one' ? safe(one!.key) : safe(s.newSet.label)} - changes ${stamp()}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (!out) return;
  const sheets = list.map((p) => {
    const lab = areaLabels(p);
    // a new sheet: one cloud around the whole drawing (no number)
    const m = 12 * 72 / 25.4;
    const areas = p.status === 'new' && p.neu ? [{ box: [m, m, p.neu.w - m, p.neu.h - m], n: 0, note: 'New sheet - not in the old issue' }]
      : p.result ? realAreas(p).map((k) => ({ box: p.result!.areas[k].box, n: Number(lab[k]), note: `Change ${lab[k]}: ${describe(p.result!.areas[k])}`, ...(p.result!.areas[k].shift ? { dashed: p.result!.areas[k].shift!.stretched ? 'stretched' as const : true } : {}) })) : [];
    return { path: p.neu!.file, page: p.neu!.page, name: p.key, areas };
  });
  // (the summary page lists the whole set - not for a single sheet)
  const summary: string[][] | null = which === 'one' ? null : [['Sheet', 'Title', 'Status', 'Changes', 'Reviewed', 'Note', 'Old file', 'New file']];
  for (const p of summary ? s.pairs : []) summary!.push([p.key, p.title, statusLabel(p), counted(p) ? String(realAreas(p).length) : '', p.reviewed ? 'Yes' : '', problemShort(p) || movedNote(p), fileOf(p.old), fileOf(p.neu)]);
  const title = `Rev Radar - ${s.oldSet.label} to ${s.newSet.label}`;
  const note = stillComparing(s);
  toast(`Writing ${list.length} sheet${list.length === 1 ? '' : 's'}…`, undefined, 3000);
  bump();
  // on an engine of its own; a set too big for one engine's memory is written in parts
  // ("… (part 1).pdf", "… (part 2).pdf"), each part from a fresh engine
  const partName = (k: number) => out.replace(/\.pdf$/i, '') + ` (part ${k}).pdf`;
  const files: string[] = [], skipped: string[] = [];
  let rest = sheets, pages = 0, bytes = 0;
  void rr.busy(out);
  try {
    for (let k = 1; rest.length; k++) {
      if (k > 1) toast(`Writing part ${k} (${rest.length} sheet${rest.length === 1 ? '' : 's'} to go)…`, undefined, 3000);
      const eng = await freshExporter();
      const target = k === 1 ? out : partName(k);
      const r = await eng.call<{ pages: number; bytes: number; done: number; skipped: string[] }>('exportPdf', [rest, target, k === 1 ? title : `${title} (part ${k})`, k === 1 ? summary : null]);
      skipped.push(...r.skipped);
      rest = rest.slice(Math.max(1, r.done));
      if (r.pages) { files.push(target); pages += r.pages; bytes += r.bytes; }
      if (k === 1 && rest.length && r.pages) { await eng.call('renamePdf', [out, partName(1)]); files[0] = partName(1); }
    }
    const parts = files.length > 1 ? ` in ${files.length} files (too big for one)` : '';
    // (sheets with nothing new to show are on the summary page only - say so)
    const out1 = which === 'one' ? [] : s.pairs.filter((p) => p.status === 'error' || p.status === 'removed');
    const notIn = out1.length ? ` - ${[out1.filter((p) => p.status === 'removed').length && `${out1.filter((p) => p.status === 'removed').length} removed`, out1.filter((p) => p.status === 'error').length && `${out1.filter((p) => p.status === 'error').length} that could not be compared`].filter(Boolean).join(' and ')} only listed on the summary page` : '';
    toast(`Saved ${pages} page${pages === 1 ? '' : 's'} (${(bytes / 1e6).toFixed(1)} MB)${parts}${note}${notIn}`, 'ok', note || parts || notIn ? 9000 : 4500);
    if (skipped.length) toast(`${skipped.length} sheet${skipped.length === 1 ? '' : 's'} could not be read and ${skipped.length === 1 ? 'is' : 'are'} not in the PDF: ${skipped.slice(0, 3).join('; ')}${skipped.length > 3 ? ' …' : ''}`, 'warn', 15000);
    if (files.length) void rr.openPath(files[0]);
  } catch (e) {
    toast('Could not write the PDF: ' + plainError(e), 'err', 9000);
  } finally {
    void rr.busy('');
    void closeExporter();
  }
}
