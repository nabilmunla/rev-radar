// Documents tab: specifications and other written documents (PDF, Word) compared by what they say -
// paragraph by paragraph, clause numbers apart, headers / footers / page numbers left out (a date-only change listed light).
// A clause moved elsewhere is "moved", a clause renumbered by an insertion before it is
// "renumbered", not changed. Folders of specs: the files paired by section number first.
// Pure: tests/docs.test.ts.
import { unzipSync, strFromU8 } from 'fflate';
import type { Word, Rules } from './pdfium';
import type { Pic, Verdict } from './picdiff';
import { norm, fold, tok, likeness, alignGap, inOrder, wordDiff, strictWord, type Tok } from './boq';
import { hunksOf, figsOf, repKey, groupKeys, type Hunk, type Fig } from './figs';
import { isOff } from './flags';
export type { Fig } from './figs';

export interface Para {
  i: number; file: string; page: number;
  /** the clause number it starts with ("2.3", "A.", "1)"), and its text without it */
  num: string; text: string;
  /** the clause / part heading it falls under ("PART 2 - PRODUCTS › 2.1 MATERIALS") */
  head: string;
  /** read from a scanned page (OCR) */
  ocr?: boolean;
  /** a PDF's paragraph: where it is - each page it is on: [page (0-based), x0, y0, x1, y1] (points) */
  seg?: number[][];
  /** and each word of its text: [page, x0, y0, x1, y1] (two boxes for a word broken at its hyphen) */
  wb?: number[][];
  /** a row of a ruled table (T6): its cells' texts (the text is them joined " | "; the item number, when
   *  the first cell is one, is `num`), each cell's box [page, x0, y0, x1, y1], the row's label (number and
   *  first cell) and the columns' headers when the table has a header row */
  cells?: string[]; cb?: number[][]; row?: string; cols?: string[];
}

// (not a measurement wrapped onto a line's start - "0.025 mm thickness ..." - nor a number from 0.)
// ("C.4" - an appendix's clause: a capital, a dot, a number)
const CLAUSE = /^((?:PART|SECTION|ARTICLE|CLAUSE)\s+[\dA-Z]+(?:\.\d+)*\s*[-–:.]?|[A-Z]\.\d+(?:\.\d+)*\.?(?=\s)|(?!0\.)\d+(?:\.\d+)+\.?(?!\s*(?:mm|m|cm|m2|m3|kg|g|t|kn|mpa|kpa|pa|bar|%|°|deg|w|kw|kva|v|a|l|l\/s|hz|db|nos?|nr|inch|in|ft)\b)|\d+\.(?=\s)|\d+\)|\(?[a-zA-Z]\)|[A-Za-z]\.(?=\s)|\([ivx]+\)|[ivx]+\.(?=\s))\s*/;
/** a heading: upper case, or a numbered title line ("1.2 REFERENCES") */
const isHead = (t: string) => { const l = t.replace(/[^A-Za-z]/g, ''); return l.length >= 3 && t.length <= 90 && l.replace(/[^A-Z]/g, '').length >= l.length * 0.8; };
/** a line stopping on a small word goes on: "... requirements for" (DECISIONS 86) */
const SMALL_END = /\b(to|for|of|in|by|with|and|or|the|a|an|per|as|at|from|on|than|under|into|including|between)$/;
const PAGE_NO = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$|^-\s*\d{1,4}\s*-$|^\d{1,4}\s*$/i;
/** a contents line: dot leaders ending in its page number ("1.1 RELATED DOCUMENTS ........ 3") - left out, and nothing
 *  is joined onto it (a section's own contents list ran into its first clause, which was then lost with it) */
const LEADERS_END = /(\.{6,}|…{2,}|(\.\s){5,})\s*(page\s*)?\d{1,4}$/i;
/** a page number anywhere on the page: only when its words say so ("Page 3", "3 of 40", "- 3 -"); a bare number away from the top
 *  and bottom bands is a value ("1200" alone on its line) - ritual 17 Nov */
const PAGE_NO_SURE = /^page\s*\d{1,4}(\s*(of|\/)\s*\d{1,4})?$|^\d{1,4}\s*of\s*\d{1,4}$|^-\s*\d{1,4}\s*-$/i;
// dates (left out: an issue date is not a change of the document) - only what is surely a date:
// 25/06/2026, 25-06-26, 2026-06-25 (day <= 31, month <= 12; not "3.2.10" - a clause - nor
// "90.1-2010" - an edition), "June 2026", "25 June 2026", "June 25, 2026" (whole month names; a
// year 19xx / 20xx). Was much wider: "separation 3000 mm" read as "Sep 3000".
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
// (a numeric date only with a four-digit year: "26-05-19" may be a section, "10/12/16" bar sizes, "6-12-10" glazing -
//  when unsure, a difference; Engineer A5)
const DATE_RE = new RegExp(`(?<![\\d.])\\b(\\d{1,2})[/-](\\d{1,2})[/-](\\d{4})\\b(?![\\d.-])|\\b(19|20)\\d{2}-(\\d{2})-(\\d{2})\\b|\\b(?:\\d{1,2}(?:st|nd|rd|th)?\\s+)?${MONTH}\\.?,?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?(?:19|20)\\d{2}\\b`, 'gi');
const DATE = { [Symbol.replace]: (t: string, by: string) => t.replace(DATE_RE, (m, d?: string, mo?: string, _y?: string, _c?: string, mo2?: string, d2?: string) => {
  if (d && mo && (Number(d) > 31 || Number(mo) > 12 || Number(d) < 1 || Number(mo) < 1)) return m;
  if (mo2 && d2 && (Number(mo2) > 12 || Number(d2) > 31)) return m;
  return by;
}) } as unknown as RegExp;

function split(text: string): { num: string; text: string } {
  const m = CLAUSE.exec(text);
  return m && m[0].trim() && text.length > m[0].length ? { num: m[0].trim().replace(/[-–:.]$/, '').trim(), text: text.slice(m[0].length).trim() } : { num: '', text };
}

/** paragraphs made into Paras: numbers split off, each read under the headings before it */
function paras(file: string, raw: { t: string; page: number; wb?: number[][]; row?: RowInfo }[]): Para[] {
  const out: Para[] = [];
  // (a contents list: 3 or more dot-leader lines together, their page numbers not falling - a lone one is a schedule
  //  line, "Minimum cement content .......... 350", and is read; Engineer A6)
  const contents = new Set<number>();
  for (let i = 0; i < raw.length;) {
    let j = i;
    while (j < raw.length && !raw[j].row && LEADERS_END.test(raw[j].t.replace(/\s+/g, ' ').trim())) j++;
    if (j - i >= 3) {
      const ns = raw.slice(i, j).map((r) => Number(/(\d{1,4})\s*$/.exec(r.t.trim())?.[1] ?? 0));
      if (ns.every((n, k) => !k || n >= ns[k - 1])) for (let k = i; k < j; k++) contents.add(k);
    }
    i = Math.max(j, i + 1);
  }
  let at = -1;
  const heads: { level: number; t: string }[] = [];
  for (const r of raw) {
    at++;
    const t = r.t.replace(/\s+/g, ' ').trim();
    if (r.row) {
      // (a table row: its number and cells as read, never joined with the lines round it; a heading only
      //  when it is one cell across the table - "2 | CABIN DETAILS & FINISHES")
      const { num, cells, cb, band, cols } = r.row;
      const text = t;
      if (!text && !num) continue;
      if (cells.filter(Boolean).length <= 1 && isHead(text) && text.length < 90) {
        const level = /^\d+(\.\d+)+/.test(num) ? num.split('.').filter(Boolean).length : num ? 3 : 1;
        while (heads.length && heads[heads.length - 1].level >= level) heads.pop();
        heads.push({ level, t: (num ? num + ' ' : '') + text });
      }
      const label = ((num ? num + ' ' : '') + (cells.find(Boolean) ?? '')).slice(0, 80);
      out.push({ i: out.length, file, page: r.page, num, text, head: heads.map((h) => h.t).join(' › '), seg: [band], wb: r.wb, cells, cb, row: label, ...(cols ? { cols } : {}) });
      continue;
    }
    if (!t || PAGE_NO_SURE.test(t)) continue;
    // (a line of a contents list: "1.1 RELATED DOCUMENTS ........ 3" - the leaders end in a page number; a form's
    //  fill-in line "Manufacturer: .........." is content)
    if (contents.has(at)) continue;
    const { num, text } = split(t);
    // (where it is: its words' boxes - the clause number's own words taken off)
    let pos: { seg?: number[][]; wb?: number[][] } = {};
    if (r.wb?.length) {
      const nw = num ? t.slice(0, t.length - text.length).trim().split(' ').length : 0;
      const glued = num && !/\s$/.test(t.slice(0, t.length - text.length)) && text.length > 0;
      const wb = r.wb.slice(glued ? Math.max(0, nw - 1) : nw);
      const seg = new Map<number, number[]>();
      for (const b of r.wb) for (let k = 0; k + 4 < b.length; k += 5) {
        const g = seg.get(b[k]);
        if (g) { g[1] = Math.min(g[1], b[k + 1]); g[2] = Math.min(g[2], b[k + 2]); g[3] = Math.max(g[3], b[k + 3]); g[4] = Math.max(g[4], b[k + 4]); } else seg.set(b[k], b.slice(k, k + 5));
      }
      pos = { seg: [...seg.values()], wb };
    }
    if (isHead(text) && text.length < 90) {
      // (a heading's level: PART > 1.1 > A.)
      const level = /^(part|section|article)/i.test(num) ? 0 : /^\d+(\.\d+)+/.test(num) ? num.split('.').filter(Boolean).length : num ? 3 : 1;
      while (heads.length && heads[heads.length - 1].level >= level) heads.pop();
      heads.push({ level, t: (num ? num + ' ' : '') + text });
    }
    out.push({ i: out.length, file, page: r.page, num, text, head: heads.map((h) => h.t).join(' › '), ...pos });
  }
  return out;
}

// ---------------------------------------------------------------- tables (PLAN T6, AUDIT B3)

/** a ruled table: its box and its rows, each row its cells [x0, y0, x1, y1] (page space) */
export interface Table { box: number[]; rows: number[][][] }
/** what a table row hands to the paragraphs: its number, cells, boxes, band, columns */
interface RowInfo { num: string; cells: string[]; cb: number[][]; band: number[]; cols?: string[] }
interface Line1 { c: number; a: number; b: number }
/** pieces on one line (within 1.2 pt) joined where they touch or overlap (2 pt) */
function joinLines(segs: number[]): Line1[] {
  const ls: Line1[] = [];
  for (let k = 0; k + 2 < segs.length; k += 3) ls.push({ c: segs[k], a: segs[k + 1], b: segs[k + 2] });
  ls.sort((x, y) => x.c - y.c || x.a - y.a);
  const out: Line1[] = [];
  for (let i = 0; i < ls.length;) {
    let j = i;
    while (j < ls.length && ls[j].c - ls[i].c <= 1.2) j++;
    const g = ls.slice(i, j).sort((x, y) => x.a - y.a);
    const c = g.reduce((t, x) => t + x.c, 0) / g.length;
    let cur: Line1 | null = null;
    for (const x of g) { if (cur && x.a <= cur.b + 2) cur.b = Math.max(cur.b, x.b); else { cur = { c, a: x.a, b: x.b }; out.push(cur); } }
    i = j;
  }
  return out;
}
/**
 * The ruled tables of a page from its rules: lines that cross make a lattice; its rows are the bands
 * between lines that run across (nearly) all of it, and a row's cells the spaces between the
 * vertical lines through (most of) that band - a cell merged across columns is one cell. Tables of
 * at least 2 rows, one of them of 2 cells or more; a frame round a note is not one.
 */
export function lattice(r: Rules): Table[] {
  const H = joinLines(r.h), V = joinLines(r.v);
  if (!H.length || !V.length || H.length * V.length > 2e6) return [];
  const par = new Int32Array(H.length + V.length).map((_, i) => i);
  const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const T = 2;
  for (let i = 0; i < H.length; i++) for (let j = 0; j < V.length; j++) {
    const h = H[i], v = V[j];
    if (v.c >= h.a - T && v.c <= h.b + T && h.c >= v.a - T && h.c <= v.b + T) { const a = find(i), b = find(H.length + j); if (a !== b) par[a] = b; }
  }
  const groups = new Map<number, { h: Line1[]; v: Line1[] }>();
  H.forEach((h, i) => { const g = find(i); if (!groups.has(g)) groups.set(g, { h: [], v: [] }); groups.get(g)!.h.push(h); });
  V.forEach((v, j) => { const g = find(H.length + j); if (!groups.has(g)) groups.set(g, { h: [], v: [] }); groups.get(g)!.v.push(v); });
  const out: Table[] = [];
  for (const g of groups.values()) {
    if (g.h.length < 2 || g.v.length < 2) continue;
    // (loops, not Math.min(...a): a dense grid of 120k+ rules overflows the call's arguments)
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const h of g.h) { if (h.a < x0) x0 = h.a; if (h.b > x1) x1 = h.b; if (h.c < y0) y0 = h.c; if (h.c > y1) y1 = h.c; }
    for (const v of g.v) { if (v.c < x0) x0 = v.c; if (v.c > x1) x1 = v.c; if (v.a < y0) y0 = v.a; if (v.b > y1) y1 = v.b; }
    const across = g.h.filter((h) => h.b - h.a >= (x1 - x0) * 0.9).map((h) => h.c).sort((a, b) => a - b);
    const ys: number[] = [];
    for (const y of across) if (!ys.length || y - ys[ys.length - 1] > 2) ys.push(y);
    const rows: number[][][] = [];
    for (let k = 0; k + 1 < ys.length; k++) {
      const a = ys[k], b = ys[k + 1];
      if (b - a < 4) continue;
      const xs = [x0, x1, ...g.v.filter((v) => Math.min(v.b, b) - Math.max(v.a, a) >= (b - a) * 0.5).map((v) => v.c)].sort((p, q) => p - q);
      const cut: number[] = [];
      for (const x of xs) if (!cut.length || x - cut[cut.length - 1] > 3) cut.push(x);
      const row: number[][] = [];
      for (let c = 0; c + 1 < cut.length; c++) if (cut[c + 1] - cut[c] >= 4) row.push([cut[c], a, cut[c + 1], b]);
      if (row.length) rows.push(row);
    }
    if (rows.length >= 2 && rows.some((row) => row.length >= 2)) out.push({ box: [x0, y0, x1, y1], rows });
  }
  return out.sort((a, b) => a.box[1] - b.box[1]);
}

/** a cell's words read into its text: lines by height, each left to right, a word broken at its hyphen
 *  joined; and each word's box (wb, as a paragraph's) */
function cellText(ws: Word[], p: number, box: (w: Word, p: number) => number[]): { t: string; wb: number[][] } {
  const s = [...ws].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const ls: Word[][] = [];
  for (const w of s) {
    const l = ls[ls.length - 1];
    const cy = (w.y0 + w.y1) / 2, h = w.y1 - w.y0;
    if (l) { const ly = (l[0].y0 + l[0].y1) / 2, lh = l[0].y1 - l[0].y0; if (Math.abs(cy - ly) < Math.max(h, lh) * 0.55) { l.push(w); continue; } }
    ls.push([w]);
  }
  let t = '';
  const wb: number[][] = [];
  for (const l of ls) {
    l.sort((a, b) => a.x0 - b.x0);
    const lt = l.map((w) => w.s).join(' ');
    const bs = l.map((w) => box(w, p));
    if (t && /[a-z]-$/.test(t) && /^[a-z]/.test(lt)) { t += lt; wb[wb.length - 1] = [...wb[wb.length - 1], ...bs[0]]; bs.shift(); }
    else t = t ? t + ' ' + lt : lt;
    wb.push(...bs);
  }
  return { t: t.replace(/\s+/g, ' ').trim(), wb };
}
/** an item number standing alone in a row's first cell ("2.07", "3", "A.", "(b)") */
const ITEM_NO = /^(?:\(?[A-Z]?\d{1,3}(?:\.\d{1,3})*[.)]?|\(?[A-Za-z][.)]|\(?[ivx]{1,4}[.)])$/;
/** the parts of an item number: "2.07" -> ['', 2, 7]; "C4" -> ['C', 4]; "(b)" / "b." -> ['#', 2]; "iv." -> ['#', 4] */
function numParts(x: string): (string | number)[] | null {
  const m = /^\(?([A-Z]?)(\d{1,3}(?:\.\d{1,3})*)[.)]?$/.exec(x.trim());
  if (m) return [m[1], ...m[2].split('.').map(Number)];
  const r = /^\(?([ivx]{1,4})[.)]$/.exec(x.trim());
  if (r) { const v: Record<string, number> = { i: 1, v: 5, x: 10 }; let s = 0; const c = [...r[1]].map((ch) => v[ch]); c.forEach((d, k) => { s += d < (c[k + 1] ?? 0) ? -d : d; }); return ['#', s]; }
  const l = /^\(?([A-Za-z])[.)]$/.exec(x.trim());
  return l ? ['#', l[1].toLowerCase().charCodeAt(0) - 96] : null;
}
/** b follows a as the next item number: the same prefix and depth, one step on (a gap of up to 3 - items taken out) */
function follows(a: string, b: string): boolean {
  const x = numParts(a), y = numParts(b);
  if (!x || !y || x.length !== y.length || x[0] !== y[0]) return false;
  for (let k = 1; k < x.length; k++) {
    if (x[k] === y[k]) continue;
    const d = (y[k] as number) - (x[k] as number);
    return d >= 1 && d <= 3 && y.slice(k + 1).every((v) => (v as number) <= 1);
  }
  return false;
}
/** a table's first column holds the rows' numbers: carried on from the page before; else its header names it; else
 *  most of its values follow one another down the table */
function numberColumn(carried: boolean | null, head: string[] | undefined, first: string[]): boolean {
  if (carried !== null) return carried;
  const h = head?.[0]?.trim();
  if (h) return /^(?:items?|no\.?|nos?\.?|nr\.?|ref(?:erence)?\.?|clause|para(?:graph)?\.?|art(?:icle)?\.?|s\.?\s?no\.?|sr\.?\s?no\.?|sl\.?\s?no\.?|#)$/i.test(h);
  const v = first.filter((x) => x && ITEM_NO.test(x));
  if (v.length < 2) return false;
  let ok = 0;
  for (let k = 1; k < v.length; k++) if (follows(v[k - 1], v[k])) ok++;
  return ok >= (v.length - 1) * 0.6;
}
/** a header row: every cell short and without figures ("ITEM | DESCRIPTION | DD | TD") */
const headerLike = (cells: string[]) => cells.filter(Boolean).length >= 2 && cells.every((c) => c.length <= 30 && !/\d/.test(c));

// ---------------------------------------------------------------- reading

/** a PDF's paragraphs: lines by height, page headers / footers (on most pages) left out, lines joined
 *  into paragraphs (a new one at a gap, a clause number, or after a short last line) */
export function pdfParas(file: string, pageCount: number, pageWords: (i: number) => Word[], pageHeight: (i: number) => number, scanned?: Set<number>, leftOut?: number[], pageRules?: (i: number) => Rules | null): Para[] {
  type PLine = { y0: number; y1: number; x0: number; t: string; h: number; ws: Word[]; row?: RowInfo & { wb: number[][] } };
  const pages: PLine[][] = [];
  // (a word's box: page and points, to a tenth)
  const box = (w: Word, p: number) => [p, Math.round(w.x0 * 10) / 10, Math.round(w.y0 * 10) / 10, Math.round(w.x1 * 10) / 10, Math.round(w.y1 * 10) / 10];
  /** the table before (its header row and columns: a table carried on to the next page) */
  let lastTable: { head: string; cols?: string[]; xs: string; page: number; low: boolean; numCol: boolean } | null = null;
  for (let p = 0; p < pageCount; p++) {
    // (the rules read before the words: the words' call may let the page go - every 40 pages - and the
    //  page read in again for its rules cost the 3,000-page MEP pair ~170 MB more at its peak)
    const ruled = pageRules && scanned?.has(p) !== true ? pageRules(p) : null;
    let ws = [...pageWords(p)].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    // ruled tables (T6): their words read cell by cell into rows, taken out of the ordinary lines
    const rowLines: PLine[] = [];
    const tables = ruled && ws.length ? lattice(ruled) : [];
    if (tables.length) {
      const H = pageHeight(p);
      const rest: Word[] = [];
      const inCell: Word[][][][] = tables.map((t) => t.rows.map((r) => r.map(() => [])));
      for (const w of ws) {
        const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
        const ti = tables.findIndex((t) => cx >= t.box[0] - 1 && cx <= t.box[2] + 1 && cy >= t.box[1] - 1 && cy <= t.box[3] + 1);
        const t = tables[ti];
        let ri = t ? t.rows.findIndex((r) => cy >= r[0][1] && cy <= r[0][3]) : -1;
        if (t && ri < 0) { let best = Infinity; t.rows.forEach((r, k) => { const d = Math.min(Math.abs(cy - r[0][1]), Math.abs(cy - r[0][3])); if (d < best) { best = d; ri = k; } }); }
        if (!t || ri < 0) { rest.push(w); continue; }
        const row = t.rows[ri];
        let ci = row.findIndex((c) => cx >= c[0] && cx <= c[2]);
        if (ci < 0) ci = cx < row[0][0] ? 0 : row.length - 1;
        inCell[ti][ri][ci].push(w);
      }
      ws = rest;
      tables.forEach((t, ti) => {
        const xs = t.rows.reduce((a, r) => (r.length > a.length ? r : a), t.rows[0]).map((c) => Math.round(c[0] / 3)).join(',');
        // (carried on from the page before: the same columns, the table before ended low on its page)
        const carried = lastTable && lastTable.page === p - 1 && lastTable.low && lastTable.xs === xs && ti === 0 ? lastTable : null;
        let cols = carried?.cols, head = carried?.head ?? '';
        const rowsCs = t.rows.map((r, ri) => r.map((_, ci) => cellText(inCell[ti][ri][ci], p, box)));
        // (is the first column the rows' numbers? Its header says so, or its values follow one another down the table -
        //  else a first column of values - C30 / C40, 25 / 32, M12 - stays a cell: "C40" -> "C45" was "Number only";
        //  Engineer A3)
        const numCol = numberColumn(carried ? carried.numCol : null, cols ?? (rowsCs[0] && headerLike(rowsCs[0].map((c) => c.t)) ? rowsCs[0].map((c) => c.t) : undefined), rowsCs.map((cs) => (cs.length > 1 ? cs[0].t : '')));
        t.rows.forEach((r, ri) => {
          const cs = rowsCs[ri];
          let texts = cs.map((c) => c.t), cb = r.map((c) => [p, Math.round(c[0] * 10) / 10, Math.round(c[1] * 10) / 10, Math.round(c[2] * 10) / 10, Math.round(c[3] * 10) / 10]);
          if (!texts.some(Boolean)) return;
          const key = fold(texts.join(' | '));
          if (ri === 0) {
            // (the header row repeated at the top of the next page: left out, as a running header)
            if (lastTable && lastTable.head && key === lastTable.head) { cols = lastTable.cols; head = lastTable.head; return; }
            if (!carried && headerLike(texts)) { head = key; cols = texts; }
          }
          let num = '', wbs = cs.map((c) => c.wb), colsHere = cols && cols.length === texts.length ? cols : undefined;
          if (numCol && texts.length > 1 && ITEM_NO.test(texts[0])) { num = texts[0]; texts = texts.slice(1); wbs = wbs.slice(1); cb = cb.slice(1); colsHere = colsHere?.slice(1); }
          const wb: number[][] = [];
          wbs.forEach((b, k) => { if (k) wb.push([]); wb.push(...b); });
          const band = [p, Math.round(r[0][0] * 10) / 10, Math.round(r[0][1] * 10) / 10, Math.round(r[r.length - 1][2] * 10) / 10, Math.round(r[0][3] * 10) / 10];
          rowLines.push({ y0: r[0][1], y1: r[0][3], x0: r[0][0], t: (num ? num + ' | ' : '') + texts.join(' | '), h: 0, ws: [], row: { num, cells: texts, cb, band, cols: colsHere, wb } });
        });
        lastTable = { head, cols, xs, page: p, low: t.box[3] > H * 0.75, numCol };
      });
    }
    const ls: Word[][] = [];
    for (const w of ws) {
      const l = ls[ls.length - 1];
      const cy = (w.y0 + w.y1) / 2, h = w.y1 - w.y0;
      if (l) { const ly = (l[0].y0 + l[0].y1) / 2, lh = l[0].y1 - l[0].y0; if (Math.abs(cy - ly) < Math.max(h, lh) * 0.55) { l.push(w); continue; } }
      ls.push([w]);
    }
    const lines: PLine[] = ls.map((l) => { l.sort((a, b) => a.x0 - b.x0); return { y0: Math.min(...l.map((w) => w.y0)), y1: Math.max(...l.map((w) => w.y1)), x0: l[0].x0, h: Math.max(...l.map((w) => w.y1 - w.y0)), t: l.map((w) => w.s).join(' '), ws: l }; });
    // (the rows go in among the lines where they are on the page; a page without tables as before)
    for (const r of rowLines) {
      const cy = (r.y0 + r.y1) / 2;
      let k = lines.findIndex((l) => !l.row && (l.y0 + l.y1) / 2 > cy);
      if (k < 0) k = lines.length;
      lines.splice(k, 0, r);
    }
    pages.push(lines);
  }
  // headers and footers: a line in the top / bottom eighth found on many pages (numbers and dates aside)
  const key = (t: string) => t.toLowerCase().replace(DATE, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const seen = new Map<string, number>();
  pages.forEach((ls, p) => { const H = pageHeight(p); for (const k of new Set(ls.filter((l) => !l.row && (l.y1 < H * 0.125 || l.y0 > H * 0.875)).map((l) => key(l.t)))) seen.set(k, (seen.get(k) || 0) + 1); });
  // (a table row at the top or bottom is furniture only when the same row, figures and all, is there on 3
  //  pages or more - a title block drawn as a table; "5.15 | REQUIRED | REQUIRED" is a row of the schedule)
  const seenRow = new Map<string, number>();
  pages.forEach((ls, p) => { const H = pageHeight(p); for (const k of new Set(ls.filter((l) => l.row && (l.y1 < H * 0.125 || l.y0 > H * 0.875)).map((l) => l.t))) seenRow.set(k, (seenRow.get(k) || 0) + 1); });
  // (in a book every section has its own running header - "... 230713-Duct Insulation": a line at
  //  the top or bottom found on 3 pages or more is one)
  // (a scanned page's header read by OCR comes out a little different each time - "VOL II-C -" /
  //  "VOL II-C =": alike enough on two other pages is the same line)
  const fuzzy = new Set<object>();
  if (scanned?.size && pageCount >= 3) {
    const band = pages.map((ls, p) => { const H = pageHeight(p); return ls.filter((l) => l.y1 < H * 0.125 || l.y0 > H * 0.875).map((l) => ({ l, t: tok(key(l.t)) })); });
    for (const p of scanned) for (const a of band[p] ?? []) {
      let n = 0;
      for (let q = 0; q < band.length && n < 2; q++) if (q !== p && band[q].some((b) => likeness(a.t, b.t) >= 0.7)) n++;
      if (n >= 2) fuzzy.add(a.l);
    }
  }
  // (a scanned contents page: OCR drops the dotted leaders the text version is known by - "1.3
  //  PERFORMANCE REQUIREMENTS 3" line after line: the page is left out, as a contents page is)
  //  (a "CONTENTS" / "INDEX" title on it, or most of its lines such, their page numbers rising - a
  //  schedule of thicknesses in capitals is no contents page; said in the notes)
  const contentsPage = new Set<number>();
  for (const p of scanned ?? []) {
    const ls = pages[p] ?? [];
    const m = ls.map((l) => /^(\d+(\.\d+)*\s+|PART\s+\d+\s*-\s*)?[A-Z][A-Z0-9 ,&/()'-]{6,}(\s+\S{1,3})?\s+(\d{1,3})$/.exec(l.t.trim())).filter(Boolean) as RegExpExecArray[];
    if (m.length < 5) continue;
    const ns = m.map((x) => +x[4]);
    // (mostly rising: OCR misreads a page number now and then - "11" read "1"; a schedule's values jump about)
    let up = 0;
    for (let k = 1; k < ns.length; k++) if (ns[k] >= ns[k - 1]) up++;
    const rising = up >= (ns.length - 1) * 0.8 && Math.max(...ns.slice(-3)) <= pageCount + 50;
    if (rising && (ls.some((l) => /\b(contents|index)\b/i.test(l.t)) || m.length >= ls.length * 0.6)) { contentsPage.add(p); leftOut?.push(p + 1); }
  }
  const furniture = (l: PLine, p: number) => { const H = pageHeight(p); return (l.y1 < H * 0.125 || l.y0 > H * 0.875) && (l.row ? pageCount >= 3 && (seenRow.get(l.t) || 0) >= 3 : PAGE_NO.test(l.t.trim()) || fuzzy.has(l) || (pageCount >= 3 && (seen.get(key(l.t)) || 0) >= 3)); };
  const raw: { t: string; page: number; wb: number[][]; row?: RowInfo }[] = [];
  let cur: { t: string; page: number; y1: number; h: number; x0: number; lastLen: number; wb: number[][] } | null = null;
  // (a full line: most lines of body text are about this long - not the longest line of the book; rows aside)
  const lens = pages.flatMap((ls) => ls.filter((l) => !l.row).map((l) => l.t.length)).sort((a, b) => a - b);
  const width = lens.length ? lens[Math.floor(lens.length * 0.85)] : 80;
  const flush = () => { if (cur) raw.push({ t: cur.t, page: cur.page, wb: cur.wb }); cur = null; };
  pages.forEach((ls, p) => {
    for (const l of ls) {
      if (furniture(l, p) || contentsPage.has(p)) continue;
      // (a table row is a paragraph of its own)
      if (l.row) { flush(); const { wb, ...row } = l.row; raw.push({ t: row.cells.join(' | '), page: p, wb, row }); continue; }
      const startsClause = !!CLAUSE.exec(l.t)?.[0].trim();
      // (the same paragraph: close under the line before, no clause number, the line before full)
      // (a line in capitals is a heading - unless it ends the clause before: that one stops mid-sentence and this one
      //  ends in a full stop or holds a figure ("... 15.5 MPa," / "ASTM D412.", "... according to" / "ASTM C 795."), or
      //  that one stops on a small word on the same page ("... requirements for" / "VOC"); "... insulation material" /
      //  "QUALITY ASSURANCE" stays a heading - DECISIONS 86, Engineer B3)
      const endsClause = (h: string) => /[,;a-z]$/.test(cur!.t) && (/\.["'”’)\]]*$/.test(h) || /\d/.test(h)) || (cur!.page === p && SMALL_END.test(cur!.t));
      if (cur && !startsClause && !LEADERS_END.test(cur.t) && (cur.page === p ? l.y0 - cur.y1 < cur.h * 0.9 : true) && (cur.lastLen > width * 0.6 || /^[a-z(]/.test(l.t)) && (!isHead(l.t) || endsClause(l.t))) {
        // (a word broken at its hyphen - "pressure-" / "sensitive" - is one word, its hyphen kept)
        const join = /[a-z]-$/.test(cur.t) && /^[a-z]/.test(l.t);
        cur.t = join ? cur.t + l.t : cur.t + ' ' + l.t;
        const bs = l.ws.map((w) => box(w, p));
        if (join && cur.wb.length) { cur.wb[cur.wb.length - 1] = [...cur.wb[cur.wb.length - 1], ...bs[0]]; bs.shift(); }
        cur.wb.push(...bs);
        cur.y1 = l.y1; cur.page = p; cur.lastLen = l.t.length;
        continue;
      }
      flush();
      cur = { t: l.t, page: p, y1: l.y1, h: l.h, x0: l.x0, lastLen: l.t.length, wb: l.ws.map((w) => box(w, p)) };
    }
  });
  flush();
  return paras(file, raw.map((r) => ({ t: r.t, page: r.page + 1, wb: r.wb, ...(r.row ? { row: r.row } : {}) })));
}

/** a Word document's paragraphs (its own text: tracked deletions and field codes left out; headers
 *  and footers are other parts of the file) */
export function docxParas(file: string, b: Uint8Array): Para[] {
  const z = unzipSync(b, { filter: (f) => f.name === 'word/document.xml' });
  const xml = z['word/document.xml'] ? strFromU8(z['word/document.xml']) : '';
  if (!xml) throw new Error('Not a Word document (.docx)');
  const raw: { t: string; page: number }[] = [];
  let page = 1;
  const un = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()] ?? m));
  // (a text box holds paragraphs of its own inside a paragraph: read apart, after the body - and
  //  its copy for old Word versions (mc:Fallback) not at all)
  const boxes: string[] = [];
  const body0 = xml.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '').replace(/<w:txbxContent\b[^>]*>([\s\S]*?)<\/w:txbxContent>/g, (_m, inner: string) => { boxes.push(inner); return ''; });
  for (const m of (body0 + boxes.join('')).matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    // (tracked: deleted and moved-away text left out - the text moved is where it went, w:moveTo)
    let body = m[1].replace(/<w:del\b[\s\S]*?<\/w:del>/g, '').replace(/<w:moveFrom\b[\s\S]*?<\/w:moveFrom>/g, '').replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, '');
    if (/<w:br\b[^>]*w:type="page"/.test(body) || /<w:lastRenderedPageBreak\/>/.test(body)) page++;
    body = body.replace(/<w:(tab|br)\b[^>]*\/>/g, '<w:t> </w:t>');
    let t = '';
    for (const x of body.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)) t += un(x[1]);
    if (t.trim()) raw.push({ t, page });
  }
  return paras(file, raw);
}

// ---------------------------------------------------------------- pairing

export interface DocPair { o: number; n: number; changed: boolean; renumbered: boolean; moved: boolean; like: number }
export interface DocDiff { pairs: DocPair[]; removed: number[]; added: number[] }

/** the paragraphs of two issues of a document paired: the same text, then by place, then by likeness */
export function compareParas(O: Para[], N: Para[]): DocDiff {
  const k = (p: Para) => norm(p.text.replace(DATE, ''));
  const kO = O.map(k), kN = N.map(k);
  const tO: Tok[] = O.map((p) => tok(p.text)), tN: Tok[] = N.map((p) => tok(p.text));
  const oTo = new Int32Array(O.length).fill(-1), nTo = new Int32Array(N.length).fill(-1);
  const put = (o: number, n: number) => { oTo[o] = n; nTo[n] = o; };
  // 1. the same text: found as often in both - by order
  const by = (ks: string[], to: Int32Array, at?: number[]) => { const m = new Map<string, number[]>(); (at ?? ks.map((_, i) => i)).forEach((i) => { const x = ks[i]; if (to[i] < 0 && x) m.set(x, [...(m.get(x) ?? []), i]); }); return m; };
  const same = (mO: Map<string, number[]>, mN: Map<string, number[]>) => {
    // (a short line said several times - "1 Flexible Elastomeric:" in each schedule - is paired by its
    //  place in step 2, not by order: by order it came out "moved")
    for (const [x, os] of mO) { const ns = mN.get(x); if (ns && ns.length === os.length && (os.length === 1 || tO[os[0]].n >= 8)) os.forEach((o, j) => put(o, ns[j])); }
  };
  /** the paragraphs not yet paired between those paired in order, gap by gap */
  const gaps = (fn: (os: number[], ns: number[]) => void, oneSided = false) => {
    const anchors = inOrder(O.map((_, o) => o).filter((o) => oTo[o] >= 0), (o) => oTo[o]);
    const bounds = [[-1, -1], ...anchors.map((o) => [o, oTo[o]]), [O.length, N.length]];
    for (let g = 0; g + 1 < bounds.length; g++) {
      const os: number[] = [], ns: number[] = [];
      for (let o = bounds[g][0] + 1; o < bounds[g + 1][0]; o++) if (oTo[o] < 0) os.push(o);
      for (let n = bounds[g][1] + 1; n < bounds[g + 1][1]; n++) if (nTo[n] < 0) ns.push(n);
      if (os.length && ns.length || oneSided && (os.length || ns.length)) fn(os, ns);
    }
  };
  // (a text said once in each issue first; a text said several times - "Maximum W/C Ratio: 0.29" under
  //  three mixes - then between those, where it is: paired by order over the whole document, the one edited
  //  in mix F came out "moved" from F to H - the hand check of 17 Nov)
  const once = (m: Map<string, number[]>) => new Map([...m].filter(([, v]) => v.length === 1));
  same(once(by(kO, oTo)), once(by(kN, nTo)));
  /** a short line (under 8 words) right next to a pair, on both sides, at the same distance, with the same text:
   *  paired too - "Floor:", "Walls:" follow the clause they stand with, and "Warranty:" at the end of a block that
   *  moved whole (step 1c, DECISIONS 78). Only through short lines: a heading said in every schedule would carry
   *  the pairing on into the next schedule */
  const extend = () => {
    for (let o = 0; o < O.length; o++) {
      const n = oTo[o];
      if (n < 0) continue;
      for (const d of [1, -1]) for (let i = o + d, j = n + d; i >= 0 && j >= 0 && i < O.length && j < N.length && oTo[i] < 0 && nTo[j] < 0 && tO[i].n < 8 && kO[i] && kO[i] === kN[j]; i += d, j += d) put(i, j);
    }
  };
  extend();
  gaps((os, ns) => same(by(kO, oTo, os), by(kN, nTo, ns)));
  extend();
  // 2. between those kept in order, the rest by place and likeness (a clause edited where it is)
  gaps((os, ns) => alignGap(os, ns, (o, n) => likeness(tO[o], tN[n]) + (O[o].num && O[o].num === N[n].num ? 0.05 : 0), 0.5, put));
  /** step 1c (DECISIONS 78): between two paragraphs that are paired with partners in the same order, the same
   *  text found as often on both sides is paired there - short lines too ("Floor:", "Test documents:") */
  const between = () => {
    const paired = O.map((_, o) => o).filter((o) => oTo[o] >= 0);
    for (let k = 0; k + 1 < paired.length; k++) {
      const a = paired[k], b = paired[k + 1];
      if (b - a < 2 || oTo[b] - oTo[a] < 2 || oTo[b] < oTo[a]) continue;
      const os: number[] = [], ns: number[] = [];
      for (let o = a + 1; o < b; o++) if (oTo[o] < 0) os.push(o);
      for (let n = oTo[a] + 1; n < oTo[b]; n++) if (nTo[n] < 0) ns.push(n);
      if (!os.length || !ns.length) continue;
      const mO = by(kO, oTo, os), mN = by(kN, nTo, ns);
      for (const [x, ol] of mO) { const nl = mN.get(x); if (nl && nl.length === ol.length) ol.forEach((o, j) => put(o, nl[j])); }
    }
  };
  between();
  extend();
  // 3. the rest: the same text left in both, found as often - by order over the whole document only when it is
  //  left once in each issue, or all its leftovers lie in one gap on each side (a block moved whole, its repeated
  //  headings with it - 70); then alike enough anywhere: moved (perhaps edited too)
  {
    const gapOf = (side: 0 | 1) => {
      const m = new Int32Array(side ? N.length : O.length).fill(-1);
      let g = 0;
      // (a gap with leftovers on one side only counts too: a block moved whole leaves one on each side - Engineer B4)
      gaps((os, ns) => { for (const i of side ? ns : os) m[i] = g; g++; }, true);
      return m;
    };
    const gO = gapOf(0), gN = gapOf(1);
    const mO = by(kO, oTo), mN = by(kN, nTo);
    const oneGap = (l: number[], g: Int32Array) => l.every((i) => g[i] >= 0 && g[i] === g[l[0]]);
    for (const [x, os] of mO) {
      const ns = mN.get(x);
      if (!ns || ns.length !== os.length) continue;
      if (os.length === 1 || (tO[os[0]].n >= 8 && oneGap(os, gO) && oneGap(ns, gN))) os.forEach((o, j) => put(o, ns[j]));
    }
  }
  const cands: [number, number, number][] = [];
  const index = new Map<string, number[]>();
  N.forEach((_, n) => { if (nTo[n] < 0) for (const w of tN[n].words.keys()) index.set(w, [...(index.get(w) ?? []), n]); });
  O.forEach((_, o) => {
    if (oTo[o] >= 0 || tO[o].n < 4) return;
    const hit = new Set<number>();
    for (const w of tO[o].words.keys()) for (const n of index.get(w) ?? []) if ((index.get(w)?.length ?? 0) < 200) hit.add(n);
    for (const n of hit) { const v = likeness(tO[o], tN[n]); if (v >= 0.8) cands.push([v, o, n]); }
  });
  cands.sort((a, b) => b[0] - a[0]);
  for (const [, o, n] of cands) if (oTo[o] < 0 && nTo[n] < 0) put(o, n);
  // (and short lines left between paragraphs paired again: inside a block that moved whole)
  between();
  extend();
  // (runs of the same text are interchangeable: a section said twice in each issue with another between them
  //  - a 3,000-page MEP spec: Telephone, Telephone, Public Address -> Telephone, Public Address, Telephone - had its copies
  //  paired across each other and a whole copy "Moved" (385 rows). Runs of one text are given to their partners
  //  in order when that keeps more paragraphs in order)
  {
    const runs: { o: number; n: number; len: number; sig: string }[] = [];
    // (only texts said more than once: a run stops at a paragraph of its own, which has one partner anyway)
    const times = new Map<string, number>();
    for (const x of kO) if (x) times.set(x, (times.get(x) || 0) + 1);
    const rep = (o: number) => (times.get(kO[o]) || 0) > 1;
    const keptCount = () => inOrder(O.map((_, o) => o).filter((o) => oTo[o] >= 0), (o) => oTo[o]).length;
    // (first all of them at once - two copies of a section that differ by an edit or two are runs of different
    //  texts that only keep more in order together - then each kind of run by itself)
    {
      const groups = new Map<string, number[]>();
      O.forEach((_, o) => { const n = oTo[o]; if (n >= 0 && rep(o) && kO[o] === kN[n]) { const g = groups.get(kO[o]); if (g) g.push(o); else groups.set(kO[o], [o]); } });
      const was = new Map<number, number>();
      const before = keptCount();
      for (const os of groups.values()) {
        if (os.length < 2) continue;
        const ns = os.map((o) => oTo[o]).sort((a, b) => a - b);
        os.forEach((o, j) => { was.set(o, oTo[o]); put(o, ns[j]); });
      }
      if (keptCount() <= before) for (const [o, n] of was) put(o, n);
    }
    for (let o = 0; o < O.length;) {
      const n = oTo[o];
      if (n < 0 || kO[o] !== kN[n] || !rep(o)) { o++; continue; }
      let len = 1;
      while (o + len < O.length && oTo[o + len] === n + len && kO[o + len] === kN[n + len] && rep(o + len)) len++;
      runs.push({ o, n, len, sig: kO.slice(o, o + len).join('\u0001') });
      o += len;
    }
    const bySig = new Map<string, typeof runs>();
    for (const r of runs) { const g = bySig.get(r.sig); if (g) g.push(r); else bySig.set(r.sig, [r]); }
    // (each try counts the paragraphs in order over the whole document: the 64 groups with the most paragraphs
    //  out of place are tried, the rest left - 20,000 paragraphs with a repeated line after every clause took
    //  19 s for no change, Engineer B5; the Telephone sections are one group)
    const out = [...bySig.values()].filter((g) => { if (g.length < 2) return false; const st = g.map((r) => r.n).sort((a, b) => a - b); return !g.every((r, k) => r.n === st[k]); });
    out.sort((a, b) => b.reduce((x, r) => x + r.len, 0) - a.reduce((x, r) => x + r.len, 0));
    for (const g of out.slice(0, 64)) {
      const starts = g.map((r) => r.n).sort((a, b) => a - b);
      const before = keptCount();
      const was = g.map((r) => r.n);
      const assign = (ns: number[]) => g.forEach((r, k) => { for (let d = 0; d < r.len; d++) put(r.o + d, ns[k] + d); });
      assign(starts);
      if (keptCount() <= before) assign(was);
    }
  }
  const paired = O.map((_, o) => o).filter((o) => oTo[o] >= 0);
  const kept = new Set(inOrder(paired, (o) => oTo[o]));
  return {
    pairs: paired.map((o) => ({ o, n: oTo[o], changed: fold(O[o].text) !== fold(N[oTo[o]].text), renumbered: norm(O[o].num) !== norm(N[oTo[o]].num) && !!(O[o].num || N[oTo[o]].num), moved: !kept.has(o), like: Math.round(likeness(tO[o], tN[oTo[o]]) * 100) / 100 })),
    removed: O.map((_, o) => o).filter((o) => oTo[o] < 0),
    added: N.map((_, n) => n).filter((n) => nTo[n] < 0),
  };
}

// ---------------------------------------------------------------- sections

/** a part of a document compared on its own: a spec section ("SECTION 221316 ..."), or a whole file */
export interface DocSection {
  key: string; num: string; title: string; file: string; paras: Para[];
  /** the pictures in it (T6.5): each after the paragraph `after` (-1: before the first) */
  pics?: { p: Pic; after: number }[];
}

/** a file's pictures put in the flow of its sections: each after the last paragraph above it (T6.5) */
export function placePics(secs: DocSection[], file: string, pics: Pic[]): void {
  if (!pics.length) return;
  let mine = secs.filter((s) => s.file === file);
  if (!mine.length) { const s: DocSection = { key: file + '#0', num: secNum(file), title: file.replace(/\.(pdf|docx)$/i, ''), file, paras: [] }; secs.push(s); mine = [s]; }
  // (each paragraph's place: page and top)
  const at: { s: DocSection; k: number; pg: number; y: number }[] = [];
  for (const s of mine) s.paras.forEach((q, k) => at.push({ s, k, pg: q.seg?.[0]?.[0] ?? q.page - 1, y: q.seg?.[0]?.[2] ?? 0 }));
  const sorted = [...pics].sort((a, b) => a.page - b.page || a.box[1] - b.box[1]);
  let j = -1;
  for (const p of sorted) {
    while (j + 1 < at.length && (at[j + 1].pg < p.page || (at[j + 1].pg === p.page && at[j + 1].y <= p.box[1]))) j++;
    const s = j >= 0 ? at[j].s : mine[0];
    (s.pics ??= []).push({ p, after: j >= 0 ? at[j].k : -1 });
  }
}
// (written in capitals, its title too - "Section 230713 Duct Insulation for ..." inside the text is a
//  reference to another section, not the start of one)
const SEC_RE = /^SECTION\s+(\d{2}\s?\d{2}\s?\d{2}(?:[.\s]\d{2})?)\b\s*[-–:]?\s*(.*)$/;
const SEC_HEAD = { exec: (t: string) => { const m = SEC_RE.exec(t); return m && (!m[2] || isHead(m[2])) ? m : null; }, test: (t: string) => !!SEC_HEAD.exec(t) };
// (not a date written without separators: "..._R0_06042026.pdf" is 6 April 2026, no section 060420)
const notDate = (m: RegExpExecArray) => !(m[4] && /^(19|20)$/.test(m[3]) && +m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12);
const SECNUM = /(?:^|\D)(\d{2})\s?(\d{2})\s?(\d{2})(?:[.\s-]?(\d{2}))?(?:\D|$)/;
const secNum = (s: string) => { const m = SECNUM.exec(s); return m && notDate(m) ? m.slice(1).filter(Boolean).join('') : ''; };
const revTail = (t: string) => t.replace(/\s*[-–]?\s*\(?\b(R|Rev\.?\s*)\d{1,2}\)?\s*$/i, '').trim();

/** a file's sections: each "SECTION 221316 ..." heading starts one (a spec book holds hundreds);
 *  a file without them is one section, numbered from its name when it has a section number */
export function sectionsOf(file: string, paras: Para[]): DocSection[] {
  const out: DocSection[] = [];
  let cur: DocSection | null = null;
  // contents pages: several sections listed on one page - no section starts there
  const perPage = new Map<number, number>();
  for (const p of paras) if (SEC_HEAD.test((p.num ? p.num + ' ' : '') + p.text)) perPage.set(p.page, (perPage.get(p.page) || 0) + 1);
  for (const p of paras) {
    const t = (p.num ? p.num + ' ' : '') + p.text;
    const m = (perPage.get(p.page) || 0) >= 3 ? null : SEC_HEAD.exec(t);
    // (a SECTION line in a table of contents is followed by more of them: only one that starts text)
    if (m) {
      const num = m[1].replace(/\s/g, '');
      cur = { key: file + '#' + out.length, num, title: revTail(m[2] || ''), file, paras: [] };
      out.push(cur);
    }
    if (!cur) { cur = { key: file + '#0', num: secNum(file), title: file.replace(/\.(pdf|docx)$/i, ''), file, paras: [] }; out.push(cur); }
    // (the title on its own line under "SECTION 230713")
    else if (!m && !cur.title && cur.paras.length === 1 && isHead(p.text)) cur.title = revTail(p.text);
    cur.paras.push(p);
  }
  // a contents list of sections ("SECTION 230713 DUCT INSULATION" line after line): not sections -
  // their lines go with what is before them; a section number found twice: one section
  for (let i = out.length - 2; i >= 0; i--) {
    // (a stub followed on its own page by the next section; a real "SECTION 230510 - NOT USED" ends its page)
    if (out[i].paras.length <= 2 && out[i + 1] && i > 0 && out[i + 1].paras[0]?.page === out[i].paras[0]?.page) { out[i - 1].paras.push(...out[i].paras); out.splice(i, 1); }
  }
  // (the same section again right after itself: its heading repeated on every page - one section;
  //  further on, it is a second copy of it - kept apart)
  for (let i = 1; i < out.length; i++) {
    if (out[i].num && out[i].num === out[i - 1].num) { out[i - 1].paras.push(...out[i].paras); if (!out[i - 1].title) out[i - 1].title = out[i].title; out.splice(i--, 1); }
  }
  // (a book: what comes before its first section is its front matter - cover, contents - paired
  //  with the other book's front matter, whatever the files are called)
  if (out.length > 1 && !SEC_HEAD.exec((out[0].paras[0]?.num ? out[0].paras[0].num + ' ' : '') + (out[0].paras[0]?.text ?? ''))) { out[0].num = ''; out[0].title = '(front matter: cover, contents)'; }
  return out;
}

export interface SecDiff { o?: DocSection; n?: DocSection; diff?: DocDiff }
/** sections of two issues paired - by number, else by title - and each pair's paragraphs compared;
 *  a paragraph that left one section for another found too (moved) */
export function compareSections(O: DocSection[], N: DocSection[]): { secs: SecDiff[]; moves: { from: [number, number]; to: [number, number]; like: number }[] } {
  const pf = pairFiles(O.map((s) => (s.num ? s.num + ' ' : '') + s.title), N.map((s) => (s.num ? s.num + ' ' : '') + s.title));
  const secs: SecDiff[] = pf.pairs.map(([i, j]) => ({ o: O[i], n: N[j], diff: compareParas(O[i].paras, N[j].paras) }));
  for (const i of pf.onlyOld) secs.push({ o: O[i] });
  for (const j of pf.onlyNew) secs.push({ n: N[j] });
  // (removed from one section, added to another: moved - only long, near-identical paragraphs)
  const left: [number, number][] = [], come: [number, number][] = [];
  secs.forEach((s, k) => { if (s.diff) { for (const o of s.diff.removed) left.push([k, o]); for (const n of s.diff.added) come.push([k, n]); } });
  const moves: { from: [number, number]; to: [number, number]; like: number }[] = [];
  if (left.length && come.length && left.length * come.length < 4e6) {
    const tl = left.map(([k, o]) => tok(secs[k].o!.paras[o].text)), tc = come.map(([k, n]) => tok(secs[k].n!.paras[n].text));
    const c: [number, number, number][] = [];
    tl.forEach((a, x) => { if (a.n < 8) return; tc.forEach((b, y) => { if (left[x][0] === come[y][0] || b.n < 8) return; const v = likeness(a, b); if (v >= 0.9) c.push([v, x, y]); }); });
    c.sort((a, b) => b[0] - a[0]);
    const ux = new Set<number>(), uy = new Set<number>();
    for (const [v, x, y] of c) if (!ux.has(x) && !uy.has(y)) { ux.add(x); uy.add(y); moves.push({ from: left[x], to: come[y], like: Math.round(v * 100) / 100 }); }
  }
  return { secs, moves };
}

/** files of two folders paired: by spec section number ("22 13 16", "221316"), else by name */
export function pairFiles(oldNames: string[], newNames: string[]): { pairs: [number, number][]; onlyOld: number[]; onlyNew: number[] } {
  const sec = secNum;
  // (its name without a revision or a date - "_R0_06042026", "Rev B", "05.10.2026" - or an issue stage: "DD", "TD")
  const base = (n: string) => norm(n.replace(/\.(pdf|docx)$/i, '').replace(/\b(rev(ision)?\.?\s*[a-z0-9]{1,3}|r\d{1,2}|\d{1,2}[.-]\d{1,2}[.-]\d{2,4}|(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])(19|20)\d\d|v\d+|dd|td|cd|sd|ifc|ift|ifa)\b/gi, ''));
  const pairs: [number, number][] = [];
  const usedO = new Set<number>(), usedN = new Set<number>();
  const by = (f: (n: string) => string) => {
    const m = new Map<string, number[]>();
    newNames.forEach((n, j) => { if (!usedN.has(j)) { const k = f(n); if (k) m.set(k, [...(m.get(k) ?? []), j]); } });
    oldNames.forEach((n, i) => { if (usedO.has(i)) return; const k = f(n); const js = k ? m.get(k)?.filter((j) => !usedN.has(j)) : undefined; if (js?.length === 1) { pairs.push([i, js[0]]); usedO.add(i); usedN.add(js[0]); } });
  };
  by(sec); by(base);
  // (alike names: the best pair first)
  const c: [number, number, number][] = [];
  oldNames.forEach((a, i) => { if (!usedO.has(i)) newNames.forEach((b, j) => { if (!usedN.has(j)) { const v = likeness(tok(base(a)), tok(base(b))); if (v >= 0.6) c.push([v, i, j]); } }); });
  c.sort((x, y) => y[0] - x[0]);
  for (const [, i, j] of c) if (!usedO.has(i) && !usedN.has(j)) { pairs.push([i, j]); usedO.add(i); usedN.add(j); }
  // (one left on each side: one document against one - they are the two issues of it)
  const lo = oldNames.map((_, i) => i).filter((i) => !usedO.has(i)), ln = newNames.map((_, j) => j).filter((j) => !usedN.has(j));
  if (lo.length === 1 && ln.length === 1 && oldNames.length === 1 && newNames.length === 1) { pairs.push([lo[0], ln[0]]); usedO.add(lo[0]); usedN.add(ln[0]); }
  return { pairs, onlyOld: oldNames.map((_, i) => i).filter((i) => !usedO.has(i)), onlyNew: newNames.map((_, j) => j).filter((j) => !usedN.has(j)) };
}

// ---------------------------------------------------------------- what the window is sent

export interface DocLine {
  page: number; num: string; text: string; head: string; file: string; ocr?: boolean; seg?: number[][]; wb?: number[][]; i?: number;
  /** a table row (T6): its cells, their boxes, its label, the columns' headers (see Para) */
  cells?: string[]; cb?: number[][]; row?: string; cols?: string[];
  /** a picture's line (T7): the paragraph above it as an index in its file (-1: before the first) - the
   *  text view puts the placeholder there */
  pic?: true; after?: number;
}
export type DocKind = 'changed' | 'added' | 'removed' | 'moved' | 'renumbered' | 'secAdded' | 'secRemoved' | 'pic';
/** what an entry is, decided here once (the side view, Details and the Excel register all read it): `changed` -
 *  a word, figure, sign, comparator or percent differs; `punct` - the same words, only punctuation or
 *  spacing; `dateOnly` - only a date or a revision stamp; the rest as the kinds */
export type DocClass = 'changed' | 'added' | 'removed' | 'moved' | 'renum' | 'punct' | 'dateOnly' | 'pic';
export const DOC_CLASS_LABEL: Record<DocClass, string> = { changed: 'Changed', added: 'Added', removed: 'Removed', moved: 'Moved', renum: 'Number only', punct: 'Punctuation only', dateOnly: 'Date / revision only', pic: 'Picture' };
/** the words that differ in a changed paragraph, by their place in the text split at its spaces: `o` the old
 *  words taken out, `n` the new words put in (the strict rule of DECISIONS 19; a word that is only
 *  punctuation - a lone comma - is no word) */
export interface ChangedWords { o: number[]; n: number[] }
/** a picture's entry (T6.5): changed / added / removed; the changed areas on each side (page space) - the
 *  picture boxed whole when there are none, too many or most of it; text-like (6.5b reads its words) */
export interface PicChange { what: 'changed' | 'added' | 'removed'; o?: number[][]; n?: number[][]; whole: boolean; text: boolean; why: string[]; /** (6.5b, the window) what OCR read where it changed */ read?: string; /** (T7) a Word file read without a converter: its pictures' hashes differ, nothing is drawn - open the file */ word?: boolean }
export const PIC_LABEL: Record<PicChange['what'], string> = { changed: 'Picture changed', added: 'Picture added', removed: 'Picture removed' };
export interface DocEntry {
  /** a picture (kind and cls 'pic') */
  pic?: PicChange;
  k: string; kind: DocKind; sec: string;
  /** the kind, decided once (see DocClass) */
  cls: DocClass;
  /** a changed entry: the words changed, both sides (the boxes' places) */
  cw?: ChangedWords;
  /** (T8) the figures among them: changed word pairs where a side holds a digit or is a unit, grade, standard
   *  or finish code (figs.ts FIG_CODES), each with its unit; dates alone are not figures */
  figs?: Fig[];
  /** (T8, DECISIONS 25) the same change x N: the group of 3 or more entries with exactly the same words taken
   *  out and put in (one id for the group; -1 / absent: none) */
  rep?: number;
  o?: DocLine; n?: DocLine; like?: number; moved?: boolean; renumbered?: boolean; paras?: number; at: number; /** a section added / removed: its last paragraph */ end?: DocLine }
/** a paragraph as read (T7): clause number, text, heading (an index in the file's `heads`), the page (0-based) and
 *  top of its first box - what the anchors say; a paragraph without a box (Word): -1 and its place in the file -
 *  and, for a table row, its cells */
export type ReadRow = [num: string, text: string, head: number, pg: number, y: number, cells?: string[]];
export interface ReadFile { heads: string[]; rows: ReadRow[] }
export interface DocsReading { o: Record<string, ReadFile>; n: Record<string, ReadFile> }
export interface DocsResult {
  entries: DocEntry[]; sections: { old: number; neu: number; paired: number }; paras: { old: number; neu: number }; notes: string[];
  /** the side-by-side view: each side's files (by name, in order) */
  files?: { o: string[]; n: string[] };
  /** every paragraph paired, where it is on both sides: [old file, page, y, new file, page, y] (a Word
   *  file's paragraph: page -1, y its place in the file) - one after the other */
  anchors?: number[];
  /** the Word files' paragraphs as read, by file name (T7, the text view; the host adds them) - the PDFs' are
   *  written beside (`readFile`): a spec book is megabytes of text */
  read?: DocsReading;
  /** where the host wrote the PDFs' (the window reads it when "Text as read" is first asked for) */
  readFile?: string;
  /** pictures' words are read by OCR in the window (6.5b on; RR_OFF=picocr: flag and boxes only) */
  picOcr?: boolean;
  /** the PDFs (the host adds them): name, place in the set, page sizes */
  pdfs?: { o: { name: string; idx: number; sizes: { w: number; h: number }[] }[]; n: { name: string; idx: number; sizes: { w: number; h: number }[] }[] };
}

// dates as the kind of an entry sees them: as DATE, and also joined to a word by "_" ("R0_06-04-2026" -
// \b does not break at an underscore). Not used to leave anything out - an entry whose only change is
// such a date is listed, light (DECISIONS 26)
const DATE_U_RE = new RegExp(DATE_RE.source.replace(/\\b/g, '(?:(?<=_)|(?=_)|\\b)'), 'gi');
function maskDates(t: string): string {
  const d = t.replace(DATE_U_RE, (m, a?: string, b?: string, _y?: string, _c?: string, mo2?: string, d2?: string) => {
    if (a && b && (Number(a) > 31 || Number(b) > 12 || Number(a) < 1 || Number(b) < 1)) return m;
    if (mo2 && d2 && (Number(mo2) > 12 || Number(d2) > 31)) return m;
    return '#';
  });
  // (the revision stamp in front of a date: "R0_#", "Rev 2-#" - R0 -> R1 beside a new date is the same stamp)
  return d.replace(/(?<![A-Za-z0-9])(?:rev(?:ision)?\.?\s?|r)\d{1,2}(?=[_-]#)/gi, 'R#');
}
/** the words that differ between two texts, by place (words that are only punctuation do not count) */
export function changedWords(a: string, b: string): ChangedWords { return diffWords(a, b).cw; }
/** the same, and the changed stretches (T8: the figures and the group key are made from them - one diff) */
function diffWords(a: string, b: string): { cw: ChangedWords; hunks: Hunk[] } {
  const out: ChangedWords = { o: [], n: [] };
  let i = 0, j = 0;
  const d = wordDiff(a, b);
  for (const x of d) {
    const ws = x.t.split(/\s+/).filter(Boolean);
    if (x.op === '=') { i += ws.length; j += ws.length; }
    else if (x.op === '-') for (const w of ws) { if (strictWord(w)) out.o.push(i); i++; }
    else for (const w of ws) { if (strictWord(w)) out.n.push(j); j++; }
  }
  return { cw: out, hunks: hunksOf(d, (w) => !!strictWord(w)) };
}
/** the words that differ between two rows of as many cells, cell by cell, by their place in the row's
 *  text (the cells joined " | ") */
export function cellWords(a: string[], b: string[], f: (t: string) => string = (t) => t): ChangedWords { return cellDiff(a, b, f).cw; }
function cellDiff(a: string[], b: string[], f: (t: string) => string = (t) => t): { cw: ChangedWords; hunks: Hunk[] } {
  const out: ChangedWords = { o: [], n: [] };
  const hunks: Hunk[] = [];
  let i = 0, j = 0;
  const n = (t: string) => t.split(/\s+/).filter(Boolean).length;
  a.forEach((ca, k) => {
    const cb = b[k];
    if (k) { i++; j++; }
    if (ca !== cb) { const w = diffWords(f(ca), f(cb)); out.o.push(...w.cw.o.map((x) => x + i)); out.n.push(...w.cw.n.map((x) => x + j)); for (const h of w.hunks) hunks.push({ ...h, cell: k }); }
    i += n(ca); j += n(cb);
  });
  return { cw: out, hunks };
}
/** two pictures' looks (16 x 16 mean colours) alike: paired as equal (picdiff.ts alike, kept here: this
 *  file is pure) */
function alikeLooks(a?: Uint8Array, b?: Uint8Array): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let s = 0, mx = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); s += d; if (d > mx) mx = d; }
  return s / a.length < 6 && mx < 40;
}
/** a changed table row's cells that differ: the column (its header, else its place "column 3"), old and
 *  new text, the cell's place in the row - for the strip ("Table row 2.07 ... · column MATERIAL: old → new") */
export function rowChanges(o?: DocLine, n?: DocLine): { k: number; col: string; o: string; n: string }[] {
  if (!o?.cells || !n?.cells || o.cells.length !== n.cells.length) return [];
  const off = n.num || o.num ? 2 : 1;
  const out: { k: number; col: string; o: string; n: string }[] = [];
  o.cells.forEach((c, k) => { if (strictText(c) !== strictText(n.cells![k])) out.push({ k, col: n.cols?.[k] || o.cols?.[k] || `column ${k + off}`, o: c, n: n.cells![k] }); });
  return out;
}
const strictText = (t: string) => t.split(/\s+/).map(strictWord).filter(Boolean).join(' ');
/** an entry's kind (DECISIONS 19, 20, 26): added / removed / moved / renum as listed; a changed paragraph
 *  is `punct` when no word differs under the strict rule, `dateOnly` when it differs only by dates (and
 *  revision stamps) - else `changed`. A moved paragraph whose words are the same stays `moved`. */
function classify(e: Omit<DocEntry, 'cls' | 'cw'>, key?: { k: string }): DocEntry {
  if (e.kind === 'pic') return { ...e, cls: 'pic' };
  if (e.kind === 'added' || e.kind === 'secAdded') return { ...e, cls: 'added' };
  if (e.kind === 'removed' || e.kind === 'secRemoved') return { ...e, cls: 'removed' };
  if (e.kind === 'moved') return { ...e, cls: 'moved' };
  if (e.kind === 'renumbered') return { ...e, cls: 'renum' };
  // (changed; no text on a side cannot happen - then everything is a change)
  if (!e.o || !e.n) return { ...e, cls: 'changed', cw: { o: [0], n: [] } };
  // (a table row against a row of as many cells: diffed cell by cell - a word does not wander into the
  //  next column; T6)
  const byCell = !!(e.o.cells && e.n.cells && e.o.cells.length === e.n.cells.length);
  const diff = (f: (t: string) => string) => (byCell ? cellDiff(e.o!.cells!, e.n!.cells!, f) : diffWords(f(e.o!.text), f(e.n!.text)));
  const { cw, hunks } = diff((t) => t);
  if (!cw.o.length && !cw.n.length) return { ...e, cls: e.moved ? 'moved' : 'punct', cw };
  const m = diff(maskDates).cw;
  const dateOnly = !m.o.length && !m.n.length;
  // (T8: the group key - the exact words out and in; the figures - a date alone is none)
  if (key) key.k = repKey(hunks, strictWord) + (e.moved ? '\u0005mv' : '') + (e.renumbered ? '\u0005rn' : '');
  const figs = dateOnly ? [] : figsOf(hunks.filter((h) => maskDates(h.o.join(' ')) !== maskDates(h.n.join(' '))));
  return { ...e, cls: dateOnly ? 'dateOnly' : 'changed', cw, ...(figs.length ? { figs } : {}) };
}

/** (T8) where an entry is in the document, outermost first: its section, then the headings over it (a heading
 *  that starts in lower case is the tail of a wrapped one - left out) */
export function headPath(e: DocEntry): string[] {
  const h = (e.n ?? e.o)?.head ?? '';
  const out = [e.sec, ...h.split(' › ').map((x) => x.trim()).filter((x) => x && !/^[a-z)(]/.test(x))].filter(Boolean);
  return out.filter((x, i) => out.indexOf(x) === i);
}

/** a paragraph as one reading row: its place is its first box (what the anchors say), else its place in the file */
const rowOf = (p: Para, h: number, at: number): ReadRow => {
  const g = p.seg?.[0];
  const row: ReadRow = [p.num, p.text, h, g ? g[0] : -1, g ? g[2] : at];
  if (p.cells) row.push(p.cells);
  return row;
};
/** the files of a side, each with its sections' paragraphs in the order the entries' `i` and the anchors count them */
function filesOf(side: DocSection[], want: (file: string) => boolean): Map<string, Para[]> {
  const out = new Map<string, Para[]>();
  for (const s of side) if (want(s.file)) { const l = out.get(s.file); if (l) l.push(...s.paras); else out.set(s.file, [...s.paras]); }
  return out;
}
/** the paragraphs of the files wanted, as read (T7, the text view) - the Word files', which stay in the result */
export function readingOf(O: DocSection[], N: DocSection[], want: (side: 'o' | 'n', file: string) => boolean = () => true): DocsReading {
  const out: DocsReading = { o: {}, n: {} };
  for (const [side, tag] of [[O, 'o'], [N, 'n']] as const) {
    for (const [file, ps] of filesOf(side, (f) => want(tag, f))) {
      const heads: string[] = [], hi = new Map<string, number>();
      const rows = ps.map((p, i) => {
        let h = hi.get(p.head);
        if (h === undefined) { h = heads.length; heads.push(p.head); hi.set(p.head, h); }
        return rowOf(p, h, i);
      });
      out[tag][file] = { heads, rows };
    }
  }
  return out;
}
/** the same, as JSON in pieces written to a file, a file at a time and no row object kept: a book of 3,000 pages
 *  is megabytes of text and the engine's memory is not for it (the host writes the pieces beside the result) */
export function* readingChunks(O: DocSection[], N: DocSection[], want: (side: 'o' | 'n', file: string) => boolean): Generator<string> {
  yield '{';
  let first = true;
  for (const [side, tag] of [[O, 'o'], [N, 'n']] as const) {
    yield (first ? '' : ',') + `"${tag}":{`; first = false;
    let f1 = true;
    for (const [file, ps] of filesOf(side, (f) => want(tag, f))) {
      const heads: string[] = [], hi = new Map<string, number>();
      for (const p of ps) if (!hi.has(p.head)) { hi.set(p.head, heads.length); heads.push(p.head); }
      yield (f1 ? '' : ',') + JSON.stringify(file) + ':{"heads":' + JSON.stringify(heads) + ',"rows":['; f1 = false;
      for (let i = 0; i < ps.length; i += 400) yield (i ? ',' : '') + ps.slice(i, i + 400).map((p, k) => JSON.stringify(rowOf(p, hi.get(p.head)!, i + k))).join(',');
      yield ']}';
    }
    yield '}';
  }
  yield '}';
}
/** a Word file's pictures: each media file's CRC-32 and size, from the zip's central directory (nothing unzipped) */
export function zipMedia(b: Uint8Array): string[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) return [];
  const n = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const out: string[] = [];
  for (let k = 0; k < n && p + 46 <= b.length && dv.getUint32(p, true) === 0x02014b50; k++) {
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const name = strFromU8(b.subarray(p + 46, p + 46 + nl));
    if (/^word\/media\/[^/]/i.test(name)) out.push(dv.getUint32(p + 16, true).toString(16) + ':' + dv.getUint32(p + 24, true));
    p += 46 + nl + xl + cl;
  }
  return out;
}

/** the list of what changed, in the new issue's order (removed: where they were) */
/** how pictures are judged and told apart (host.ts: drawn from the open documents) */
export interface PicJudge { judge(o: Pic, n: Pic): Verdict; look(p: Pic): Uint8Array | undefined; /** the furniture's hashes of each side (left out, but the same picture) */ furniture?: { o: Set<string>; n: Set<string> }; /** (bench) each picture's fate */ account?(p: Pic, how: 'same' | 'changed' | 'added' | 'removed' | 'section'): void; /** an added / removed picture is text-like (6.5b) */ textLike?(p: Pic): boolean }
/** a sequence match: pairs (i, j) of a longest run of equal items in order */
function lcs<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): [number, number][] {
  // (past 2,000 x 2,000: no table - paired in order where the counts allow; Engineer A14)
  if ((a.length + 1) * (b.length + 1) > 4e6) return [];
  const n = a.length, m = b.length, L = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * (m + 1) + j] = eq(a[i], b[j]) ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) { if (eq(a[i], b[j]) && L[i * (m + 1) + j] === L[(i + 1) * (m + 1) + j + 1] + 1) { out.push([i, j]); i++; j++; } else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) i++; else j++; }
  return out;
}

/**
 * 0.6.0 T29 (DECISIONS 100): a ruled table's row that runs over a page break in one issue and is whole in the other
 * gave a false "Changed" (its first part) and a false "Removed" / "Added" (the part on the next page - VT old p.67/68
 * and four more). A candidate: the first row of a page, its number cell empty, right after a row that was the last
 * thing on the page before, of as many cells (the empty number column dropped when it was read as a cell). It is
 * joined to that row, cell by cell, ONLY when the other issue holds a row equal (strict) or >= 0.9 alike to the joined
 * row - or a candidate of its own whose join is - and no row equal to either part alone. A heading row without a
 * number is so never glued on unless the other issue has it glued too. The joined row keeps the first part's page,
 * its bands and words on both pages. Both issues, every section; the pictures' places follow (`pics.after`).
 */
export function joinSplitRows(O: DocSection[], N: DocSection[]): number {
  type Cand = { sec: DocSection; k: number; joined: Para };
  const strict = (t: string) => strictText(t);
  const cellsOf = (prev: Para, cur: Para): string[] | null => {
    const a = prev.cells!, b = cur.cells!;
    const bb = b.length === a.length + 1 && !b[0] ? b.slice(1) : b.length === a.length ? b : null;
    if (!bb) return null;
    return a.map((x, i) => (x && bb[i] ? x + ' ' + bb[i] : x || bb[i]));
  };
  // (a row's word boxes: each word's, an empty entry for each " | " between cells - the reader's own layout, line ~314)
  const wordsIn = (p: Para): number[][][] => {
    const out: number[][][] = [[]];
    for (const w of p.wb ?? []) { if (w.length) out[out.length - 1].push(w); else out.push([]); }
    return out;
  };
  /** the two rows as one, cell by cell (built from the rows as they are when it is taken: a row over three pages) */
  const joinTwo = (prev: Para, cur: Para): Para | null => {
    const cells = cellsOf(prev, cur);
    if (!cells) return null;
    const wa = wordsIn(prev), wbB = wordsIn(cur);
    const off = cur.cells!.length === prev.cells!.length + 1 ? 1 : 0;
    const wb: number[][] = [];
    cells.forEach((_, i) => { if (i) wb.push([]); wb.push(...(wa[i] ?? []), ...(wbB[i + off] ?? [])); });
    return { ...prev, text: cells.join(' | '), cells, seg: [...(prev.seg ?? []), ...(cur.seg ?? [])], ...(prev.wb || cur.wb ? { wb } : {}) };
  };
  const candidates = (side: DocSection[]): Cand[] => {
    const out: Cand[] = [];
    for (const sec of side) {
      const ps = sec.paras;
      // (where each page first comes: "nothing earlier on this page" in one look, not a scan per row - ritual 19 Nov:
      //  3,000 pages of 40 rows took 52 s)
      const first = new Map<number, number>();
      ps.forEach((q, i) => { if (!first.has(q.page)) first.set(q.page, i); });
      for (let k = 1; k < ps.length; k++) {
        const cur = ps[k], prev = ps[k - 1];
        if (!cur.cells || !prev.cells || cur.num || prev.file !== cur.file || prev.page !== cur.page - 1) continue;
        // (the first row of its page; the row before the last thing on its page - prev is on the page before, so
        //  "an earlier row on this page" is the page's first row coming before k)
        if (first.get(cur.page)! < k) continue;
        const joined = joinTwo(prev, cur);
        if (joined) out.push({ sec, k, joined });
      }
    }
    return out;
  };
  const cO = candidates(O), cN = candidates(N);
  if (!cO.length && !cN.length) return 0;
  // (rows of the other issue looked at only near a text's length: a strict fold or 0.9 alike needs it - the folds of
  //  all rows cost VT's compare ~100 ms, the joins themselves under 5)
  const rows = (side: DocSection[]) => side.flatMap((s) => s.paras.filter((p) => p.cells)).sort((a, b) => a.text.length - b.text.length);
  const rO = rows(O), rN = rows(N);
  const folds = new Map<Para, string>(), toks = new Map<Para, Tok>();
  const fd = (p: Para) => { let f = folds.get(p); if (f === undefined) folds.set(p, (f = strict(p.text))); return f; };
  const tk = (p: Para) => { let t = toks.get(p); if (!t) toks.set(p, (t = tok(p.text))); return t; };
  const near = (rs: Para[], len: number): Para[] => {
    let lo = 0, hi = rs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (rs[m].text.length < len * 0.75) lo = m + 1; else hi = m; }
    const out: Para[] = [];
    for (let i = lo; i < rs.length && rs[i].text.length <= len * 1.34 + 4; i++) out.push(rs[i]);
    return out;
  };
  const equal = (a: Para, b: Para) => fd(a) === fd(b);
  const like = (a: Para, b: Para) => {
    if (equal(a, b)) return true;
    const x = tk(a), y = tk(b);
    // (Dice >= 0.9 needs the shorter at least 0.82 of the longer)
    if (Math.min(x.n, y.n) < 0.81 * Math.max(x.n, y.n)) return false;
    return likeness(x, y) >= 0.9;
  };
  /** the other issue backs the join: a row (or a joined candidate) like the joined row, none equal to a part alone */
  // (the other issue's rows by their strict fold: "a row equal to it" in one look - ritual 19 Nov, a long table of
  //  rows alike in length made every look a scan of thousands)
  const foldsOf = new Map<Para[], Set<string>>();
  const foldSet = (rs: Para[]) => { let f = foldsOf.get(rs); if (!f) foldsOf.set(rs, (f = new Set(rs.map(fd)))); return f; };
  const backed = (c: Cand, otherRows: Para[], otherCands: Cand[]): Cand | 'row' | null => {
    const prev = c.sec.paras[c.k - 1], cur = c.sec.paras[c.k], fs = foldSet(otherRows);
    if (fs.has(fd(prev)) || fs.has(fd(cur))) return null;
    if (fs.has(fd(c.joined)) || near(otherRows, c.joined.text.length).some((r) => like(r, c.joined))) return 'row';
    return otherCands.find((d) => like(d.joined, c.joined)) ?? null;
  };
  const take = new Set<Cand>();
  for (const c of cO) { const b = backed(c, rN, cN); if (b) { take.add(c); if (b !== 'row') take.add(b); } }
  for (const c of cN) { const b = backed(c, rO, cO); if (b) { take.add(c); if (b !== 'row') take.add(b); } }
  // (joined from the end of each section back: the indices before stay right)
  const bySec = new Map<DocSection, Cand[]>();
  for (const c of take) bySec.set(c.sec, [...(bySec.get(c.sec) ?? []), c]);
  for (const [sec, cs] of bySec) {
    for (const c of cs.sort((a, b) => b.k - a.k)) {
      // (from the rows as they are now: a later part already joined to this one comes with it)
      const j = joinTwo(sec.paras[c.k - 1], sec.paras[c.k]) ?? c.joined;
      sec.paras.splice(c.k - 1, 2, j);
      for (const pic of sec.pics ?? []) if (pic.after >= c.k) pic.after--;
    }
  }
  return take.size;
}

export function docEntries(O: DocSection[], N: DocSection[], pj?: PicJudge, wm?: { o: Map<string, string[]>; n: Map<string, string[]> }): DocsResult {
  // (0.6.0 T29: a table row split over a page break in one issue, whole in the other - one row again)
  if (!isOff('splitrows')) joinSplitRows(O, N);
  const { secs, moves } = compareSections(O, N);
  // (a Word file's paragraph: its place in the file; a PDF's: where it is, and its words' boxes when it changed)
  const iIn = new Map<Para, number>();
  for (const side of [O, N]) { const at = new Map<string, number>(); for (const s of side) for (const p of s.paras) { const k = at.get(p.file) ?? 0; iIn.set(p, k); at.set(p.file, k + 1); } }
  const line = (p: Para, words = false): DocLine => ({ page: p.page, num: p.num, text: p.text, head: p.head, file: p.file, i: iIn.get(p), ...(p.ocr ? { ocr: true } : {}), ...(p.seg ? { seg: p.seg } : {}), ...(words && p.wb ? { wb: p.wb } : {}), ...(p.cells ? { cells: p.cells, cb: p.cb, row: p.row, ...(p.cols ? { cols: p.cols } : {}) } : {}) });
  const title = (s: DocSection) => (s.num ? s.num + ' ' : '') + s.title;
  const order = new Map<DocSection, number>(N.map((s, i) => [s, i]));
  const listed: Omit<DocEntry, 'cls' | 'cw'>[] = [];
  const movedFrom = new Set<string>(), movedTo = new Set<string>();
  for (const m of moves) { movedFrom.add(m.from.join(':')); movedTo.add(m.to.join(':')); }
  secs.forEach((s, k) => {
    const at = (s.n ? order.get(s.n)! : (() => { const i = O.indexOf(s.o!); for (let j = i - 1; j >= 0; j--) { const t = secs.find((x) => x.o === O[j] && x.n); if (t) return order.get(t.n!)! + 0.5; } return -0.5; })()) * 1e6;
    if (!s.diff) {
      const x = (s.n ?? s.o)!;
      const empty = { i: 0, file: x.file, page: 1, num: '', text: '', head: '' };
      listed.push({ k: (s.n ? 'sa' : 'sr') + k, kind: s.n ? 'secAdded' : 'secRemoved', sec: title(x), [s.n ? 'n' : 'o']: line(x.paras[0] ?? empty), end: line(x.paras[x.paras.length - 1] ?? empty), paras: x.paras.length, at });
      return;
    }
    const d = s.diff, o = s.o!, n = s.n!;
    for (const p of d.pairs) {
      if (!p.changed && !p.moved && !p.renumbered) continue;
      listed.push({ k: `c${k}:${p.o}`, kind: p.changed ? 'changed' : p.moved ? 'moved' : 'renumbered', sec: title(n), o: line(o.paras[p.o], p.changed), n: line(n.paras[p.n], p.changed), like: p.like, moved: p.moved, renumbered: p.renumbered, at: at + p.n });
    }
    for (const x of d.added) if (!movedTo.has(k + ':' + x)) listed.push({ k: `a${k}:${x}`, kind: 'added', sec: title(n), n: line(n.paras[x]), at: at + x });
    const toN = new Map(d.pairs.map((p) => [p.o, p.n]));
    for (const x of d.removed) {
      if (movedFrom.has(k + ':' + x)) continue;
      let b = x - 1; while (b >= 0 && !toN.has(b)) b--;
      listed.push({ k: `r${k}:${x}`, kind: 'removed', sec: title(o), o: line(o.paras[x]), at: at + (b >= 0 ? toN.get(b)! : -1) + 0.5 });
    }
  });
  // (moved from one section to another)
  for (const m of moves) {
    const so = secs[m.from[0]], sn = secs[m.to[0]];
    const a = so.o!.paras[m.from[1]], b = sn.n!.paras[m.to[1]];
    // (moved to another section with words changed: a change that also moved - not "Moved", light; Engineer A4)
    listed.push({ k: `m${m.from.join(':')}`, kind: fold(a.text) !== fold(b.text) ? 'changed' : 'moved', sec: title(sn.n!), o: line(a, true), n: line(b, true), like: m.like, moved: true, at: order.get(sn.n!)! * 1e6 + m.to[1] });
  }
  // pictures (T6.5): paired inside each gap of the paired text, as a sequence (the same bytes or a look-alike
  // are equal; the rest in order where the counts allow), each pair judged; a picture whose bytes are on the
  // other side elsewhere moved with its text (no entry); the rest added / removed
  const picNotes: string[] = [];
  if (pj) {
    const tally = new Map<string, { same: number; changed: number; added: number; removed: number }>();
    const t = (f: string) => { if (!tally.has(f)) tally.set(f, { same: 0, changed: 0, added: 0, removed: 0 }); return tally.get(f)!; };
    const looks = new Map<Pic, Uint8Array | undefined>();
    const look = (p: Pic) => { if (!looks.has(p)) looks.set(p, pj.look(p)); return looks.get(p); };
    const eq = (a: Pic, b: Pic) => (!a.whole && !b.whole && a.sha === b.sha) || alikeLooks(look(a), look(b));
    const lone: { o: { p: Pic; k: number; at: number; head: string; after: number }[]; n: { p: Pic; k: number; at: number; head: string; after: number }[] } = { o: [], n: [] };
    const headAt = (sec: DocSection, after: number) => sec.paras[Math.max(0, after)]?.head ?? '';
    // (T7: the paragraph above it as an index in the file; before a section's first paragraph: the one before that)
    const fileAfter = (sec: DocSection, after: number) => (after >= 0 ? iIn.get(sec.paras[after]) ?? -1 : sec.paras[0] ? (iIn.get(sec.paras[0]) ?? 0) - 1 : -1);
    const picLine = (p: Pic, head: string, sec: DocSection, after: number): DocLine => ({ page: p.page + 1, num: '', text: `[Picture, p. ${p.page + 1}]`, head, file: p.file, seg: [[p.page, ...p.box]], pic: true, after: fileAfter(sec, after) });
    secs.forEach((sd, k) => {
      const at0 = (sd.n ? order.get(sd.n)! : -1) * 1e6;
      if (!sd.diff) { for (const x of [...(sd.o?.pics ?? []), ...(sd.n?.pics ?? [])]) pj.account?.(x.p, 'section'); return; } // (a section added / removed: its pictures are in that entry)
      const po = sd.o!.pics ?? [], pn = sd.n!.pics ?? [];
      if (!po.length && !pn.length) return;
      const anchors = sd.diff.pairs.filter((x) => !x.moved).sort((a, b) => a.o - b.o);
      const bounds = [[-1, -1], ...anchors.map((x) => [x.o, x.n]), [Infinity, Infinity]];
      for (let g = 0; g + 1 < bounds.length; g++) {
        const os = po.filter((x) => x.after >= bounds[g][0] && x.after < bounds[g + 1][0]), ns = pn.filter((x) => x.after >= bounds[g][1] && x.after < bounds[g + 1][1]);
        if (!os.length && !ns.length) continue;
        const m = lcs(os, ns, (a, b) => eq(a.p, b.p));
        // (between two equal ones: in order where the counts allow, the surplus added / removed)
        const pairs: [number, number][] = [];
        let i0 = 0, j0 = 0;
        for (const [i1, j1] of [...m, [os.length, ns.length] as [number, number]]) {
          const c = Math.min(i1 - i0, j1 - j0);
          for (let q = 0; q < c; q++) pairs.push([i0 + q, j0 + q]);
          for (let q = c; q < i1 - i0; q++) lone.o.push({ p: os[i0 + q].p, k, at: at0 + Math.min(bounds[g][1], 1e5) + 0.5, head: headAt(sd.o!, os[i0 + q].after), after: os[i0 + q].after });
          for (let q = c; q < j1 - j0; q++) lone.n.push({ p: ns[j0 + q].p, k, at: at0 + ns[j0 + q].after + 0.5, head: headAt(sd.n!, ns[j0 + q].after), after: ns[j0 + q].after });
          if (i1 < os.length) pairs.push([i1, j1]);
          i0 = i1 + 1; j0 = j1 + 1;
        }
        for (const [i, j] of pairs) {
          const a = os[i].p, b = ns[j].p;
          const v = pj.judge(a, b);
          pj.account?.(a, v.same ? 'same' : 'changed'); pj.account?.(b, v.same ? 'same' : 'changed');
          if (v.same) { t(b.file).same++; continue; }
          t(b.file).changed++;
          listed.push({ k: `p${k}:${a.page}:${a.box.join(',')}`, kind: 'pic', sec: title(sd.n!), o: picLine(a, headAt(sd.o!, os[i].after), sd.o!, os[i].after), n: picLine(b, headAt(sd.n!, ns[j].after), sd.n!, ns[j].after), at: at0 + ns[j].after + 0.5, pic: { what: 'changed', o: v.o, n: v.n, whole: v.whole, text: v.text, why: v.why } } as Omit<DocEntry, 'cls' | 'cw'>);
        }
      }
    });
    // (the same bytes on the other side, elsewhere: moved with its text - no entry)
    const allN = new Set<string>(), allO = new Set<string>();
    for (const s of N) for (const x of s.pics ?? []) allN.add(x.p.sha);
    for (const s of O) for (const x of s.pics ?? []) allO.add(x.p.sha);
    for (const h of pj.furniture?.n ?? []) allN.add(h);
    for (const h of pj.furniture?.o ?? []) allO.add(h);
    for (const x of lone.o) {
      if (!x.p.whole && allN.has(x.p.sha)) { t(x.p.file).same++; pj.account?.(x.p, 'same'); continue; }
      t(x.p.file).removed++; pj.account?.(x.p, 'removed');
      listed.push({ k: `pr${x.k}:${x.p.page}:${x.p.box.join(',')}`, kind: 'pic', sec: title(secs[x.k].o!), o: picLine(x.p, x.head, secs[x.k].o!, x.after), at: x.at, pic: { what: 'removed', o: [x.p.box], whole: true, text: pj.textLike?.(x.p) ?? false, why: [] } } as Omit<DocEntry, 'cls' | 'cw'>);
    }
    for (const x of lone.n) {
      if (!x.p.whole && allO.has(x.p.sha)) { pj.account?.(x.p, 'same'); continue; } // (counted on the old side)
      t(x.p.file).added++; pj.account?.(x.p, 'added');
      listed.push({ k: `pa${x.k}:${x.p.page}:${x.p.box.join(',')}`, kind: 'pic', sec: title(secs[x.k].n!), n: picLine(x.p, x.head, secs[x.k].n!, x.after), at: x.at, pic: { what: 'added', n: [x.p.box], whole: true, text: pj.textLike?.(x.p) ?? false, why: [] } } as Omit<DocEntry, 'cls' | 'cw'>);
    }
    for (const [f, c] of tally) {
      const n = c.same + c.changed + c.added + c.removed;
      const parts = [c.same && `${c.same} the same`, c.changed && `${c.changed} changed`, c.added && `${c.added} added`, c.removed && `${c.removed} removed`].filter(Boolean);
      picNotes.push(`${f}: ${n} picture${n === 1 ? '' : 's'} compared: ${parts.join(', ')}`);
    }
  }
  // Word files read without a converter (T7, DECISIONS 49): the media's hashes of a file against its pair's -
  // nothing is drawn, the entry says to open the file
  if (wm) {
    const done = new Set<string>();
    secs.forEach((sd) => {
      if (!sd.o || !sd.n) return;
      const key = sd.o.file + '\u0000' + sd.n.file;
      if (done.has(key)) return;
      done.add(key);
      const a = wm.o.get(sd.o.file), b = wm.n.get(sd.n.file);
      if (!a || !b || [...a].sort().join() === [...b].sort().join()) return;
      const what: PicChange['what'] = !a.length ? 'added' : !b.length ? 'removed' : 'changed';
      const ln = (f: string, t: string): DocLine => ({ page: 0, num: '', text: `[${t} - open the file]`, head: '', file: f, pic: true, after: -1 });
      const t = what === 'changed' ? 'Picture(s) in the Word file changed' : what === 'added' ? 'Picture(s) only in the new Word file' : 'Picture(s) not in the new Word file';
      listed.push({ k: `pw${done.size}`, kind: 'pic', sec: title(sd.n), ...(what !== 'added' ? { o: ln(sd.o.file, t) } : {}), ...(what !== 'removed' ? { n: ln(sd.n.file, t) } : {}), at: (order.get(sd.n) ?? 0) * 1e6 - 0.25, pic: { what, whole: true, text: false, why: [`pictures in the file: ${a.length} -> ${b.length}`], word: true } } as Omit<DocEntry, 'cls' | 'cw'>);
    });
  }
  listed.sort((a, b) => a.at - b.at);
  // (T8: the same change x N - the keys of the changed entries counted once, in one pass)
  const keys: { k: string }[] = [];
  const entries = listed.map((e) => { const key = { k: '' }; keys.push(key); return classify(e, key); });
  const { rep } = groupKeys(keys.map((x) => x.k));
  entries.forEach((e, i) => { if (rep[i] >= 0) e.rep = rep[i]; });
  // where every pair is (scrolling the two sides kept level), the files in order, a Word file's text
  const files = { o: [...new Set(O.map((s) => s.file))], n: [...new Set(N.map((s) => s.file))] };
  const fo = new Map(files.o.map((f, i) => [f, i])), fn = new Map(files.n.map((f, i) => [f, i]));
  const where = (p: Para, f: Map<string, number>) => (p.seg ? [f.get(p.file)!, p.seg[0][0], p.seg[0][2]] : [f.get(p.file)!, -1, iIn.get(p)!]);
  const anchors: number[] = [];
  for (const s of secs) if (s.diff) for (const p of s.diff.pairs) anchors.push(...where(s.o!.paras[p.o], fo), ...where(s.n!.paras[p.n], fn));
  for (const m of moves) anchors.push(...where(secs[m.from[0]].o!.paras[m.from[1]], fo), ...where(secs[m.to[0]].n!.paras[m.to[1]], fn));
  return { files, anchors, entries, sections: { old: O.length, neu: N.length, paired: secs.filter((s) => s.diff).length }, paras: { old: O.reduce((a, s) => a + s.paras.length, 0), neu: N.reduce((a, s) => a + s.paras.length, 0) }, notes: picNotes };
}
