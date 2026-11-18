// T11 (DECISIONS 74-77): sheets paired by the number read off their title block - pages of combined PDFs
// and renamed single files. The reading is the PDF Editor's (`./sheets`, a copy kept in step); this file
// only decides which numbers may pair two sheets:
//  - a number pairs only when it is on exactly one sheet of each issue (counted here, over every sheet
//    read, the name-paired witnesses included - the reader's own map keeps the first of a repeat);
//  - only sheets still unpaired after the file names (a pair by name is never undone);
//  - what the pages say may veto it (`pairByContent`'s bySheet: under 0.35 alike while one of them has
//    another partner at 0.8);
//  - single-page files are read as one set (the reader's spot needs 3+ pages of a size), with up to 8
//    name-paired files of that size as witnesses: the read numbers count only if at least 80 % of the
//    witnesses' read numbers are their file names' numbers.
// A number not read, not unique or refused leaves today's pairing as it was. (Kept apart from
// `pairing.ts`: the reader imports its number helpers from there.)
import { drawingNo, drawingNoBare, noZeros, type SheetRef } from './pairing';
import { sheetIndex, type PageToks, type Sheet } from './sheets';

export interface ReadPage { ref: SheetRef; toks?: PageToks | null }

const base = (p: string) => (p.split(/[\\/]/).pop() || p).replace(/\.pdf$/i, '');
const nameKey = (r: SheetRef) => { try { return noZeros(drawingNoBare(drawingNo(base(r.rel)))); } catch { return ''; } };
/** witnesses that must agree with their names before single files' read numbers are used */
export const WITNESS_AGREE = 0.8;

function index(pages: PageToks[]): Sheet[] {
  try { return sheetIndex(pages).sheets; } catch { return []; }
}

/** one issue: what each sheet's title block says (combined files each by themselves; the single files as
 *  one set, used only if the witnesses agree) - and the witnesses' own readings, for the counts */
export function readIssue(pages: ReadPage[], wits: ReadPage[] = []): { read: Map<SheetRef, Sheet>; witRead: Map<SheetRef, Sheet> } {
  const read = new Map<SheetRef, Sheet>(), witRead = new Map<SheetRef, Sheet>();
  const byFile = new Map<string, ReadPage[]>();
  const singles: ReadPage[] = [];
  for (const p of pages) {
    if (!p.toks) continue;
    if (p.ref.pages > 1) { let g = byFile.get(p.ref.file); if (!g) byFile.set(p.ref.file, (g = [])); g.push(p); } else singles.push(p);
  }
  for (const g of byFile.values()) {
    const at = new Map(g.map((p) => [p.ref.page, p.ref] as const));
    for (const s of index(g.map((p) => ({ ...p.toks!, page: p.ref.page })))) { const r = at.get(s.page); if (r) read.set(r, s); }
  }
  if (singles.length) {
    const set = [...singles, ...wits.filter((w) => w.toks && w.ref.pages === 1)];
    const sheets = index(set.map((p, i) => ({ ...p.toks!, page: i })));
    const got = new Map(sheets.map((s) => [s.page, s] as const));
    let readW = 0, agree = 0;
    set.forEach((p, i) => {
      if (i < singles.length) return;
      const s = got.get(i);
      if (!s) return;
      witRead.set(p.ref, s); readW++;
      if (s.key && s.key === nameKey(p.ref)) agree++;
    });
    if (readW > 0 && agree >= WITNESS_AGREE * readW) singles.forEach((p, i) => { const s = got.get(i); if (s) read.set(p.ref, s); });
  }
  return { read, witRead };
}

/**
 * Which leftover sheets the numbers pair (by the refs; the content veto is `pairByContent`'s), and how
 * each sheet whose number was read is listed: the number ("number (p.N)" when it is on two pages of
 * the issue) and the title read.
 */
export function pairBySheetNo(olds: ReadPage[], news: ReadPage[], witO: ReadPage[] = [], witN: ReadPage[] = []): { pairs: [SheetRef, SheetRef][]; names: Map<SheetRef, { no: string; title: string }> } {
  const o = readIssue(olds, witO), n = readIssue(news, witN);
  const count = (x: { read: Map<SheetRef, Sheet>; witRead: Map<SheetRef, Sheet> }) => {
    const m = new Map<string, number>();
    for (const s of [...x.read.values(), ...x.witRead.values()]) if (s.key) m.set(s.key, (m.get(s.key) || 0) + 1);
    return m;
  };
  const co = count(o), cn = count(n);
  const names = new Map<SheetRef, { no: string; title: string }>();
  for (const [x, c] of [[o, co], [n, cn]] as const) {
    for (const [r, s] of x.read) if (s.no) names.set(r, { no: (c.get(s.key) || 0) > 1 && r.pages > 1 ? `${s.no} (p.${r.page + 1})` : s.no, title: s.title || '' });
  }
  const newBy = new Map<string, SheetRef>();
  for (const [r, s] of n.read) if (s.key && cn.get(s.key) === 1) newBy.set(s.key, r);
  const pairs: [SheetRef, SheetRef][] = [];
  for (const [r, s] of o.read) {
    if (!s.key || co.get(s.key) !== 1) continue;
    const m = newBy.get(s.key);
    if (m) pairs.push([r, m]);
  }
  return { pairs, names };
}
