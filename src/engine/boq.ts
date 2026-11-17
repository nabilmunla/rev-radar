// BOQ comparison: the items of two issues of a bill of quantities, read from their sheets, paired
// and what changed about each - quantity, unit, description, rate / amount, its number (refs are
// lettered afresh on every page: a page that grew renumbers everything after it - shown apart,
// never as removed + added), and where it went (moved to another place or bill). Pure: the
// readers are in sheets.ts; tests/boq.test.ts runs it on real tender BOQs.
//
// What an item IS: its own line(s) read with the text above it - a BOQ writes "Suspended slabs"
// once and lists "200 mm thick", "300 mm thick" under it; the next issue may write "Suspended
// slabs; 200 mm thick" as one line. So an item is matched on its whole description (group text +
// own text, punctuation and spacing aside), then by position between items that matched, then by
// likeness anywhere (moved).
import type { Book, Val } from './sheets';
import { hunksOf, figsOf, repKey, groupKeys, type Fig } from './figs';

export interface BoqItem {
  /** index in its document (reading order: file, sheet, row) */
  i: number;
  file: string; bill: string; sheet: string; row: number; page: string;
  /** the row its quantity is on, when its description starts on rows above (1-based) */
  last?: number;
  ref: string; mark: boolean;
  section: string; group: string; text: string;
  /** "Ditto ..." - the item it stands on (its text), for matching */
  basis?: string;
  /** read from a scanned page (OCR): its words and figures may be misread */
  ocr?: boolean;
  unit: string; qty: number | string | null; rate: number | string | null; amount: number | string | null;
}
export interface BoqDoc {
  items: BoqItem[]; notes: string[]; sheets: BoqSheet[];
  /** the PDFs of the set (the side-by-side view shows their pages): name as on the items, place in the set, page sizes (points) */
  pdfs?: { name: string; idx: number; sizes: { w: number; h: number }[] }[];
}
/** a sheet as read: `grid` - its visible rows and used columns as text, for the side-by-side view */
export interface BoqSheet { name: string; items: number; skipped?: string; file?: string; sheet?: string; grid?: BoqGrid }
export interface BoqGrid {
  /** the sheet's row numbers (1-based) of the rows shown */
  rows: number[];
  /** the cells of those rows, in the columns shown */
  cells: string[][];
  /** the columns shown, by their place in the sheet (0 = A) */
  cols: number[];
  /** where the item number, description, quantity, unit, rate and amount are among the columns shown (-1: none) */
  at: { item: number; desc: number; qty: number; unit: number; rate: number; amount: number };
  /** a PDF's page of each row (0-based) - a table rebuilt from a PDF */
  pg?: number[];
  /** a PDF's rows: where each is on its page (SheetRow.bx; its cells' x0, x1 in the columns shown) - null: a heading row */
  bx?: (number[] | null)[];
}

// ---------------------------------------------------------------- reading the items

const s = (v: Val | undefined): string => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : String(v)).replace(/\s+/g, ' ').trim();
/** text for matching: lower case, typographic quotes and dashes plain, numbers split from units */
export function norm(t: string): string {
  return t.toLowerCase()
    .replace(/[‘’‛`´]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, '-')
    .replace(/²/g, '2').replace(/³/g, '3')
    .replace(/(\d)\s*[x×]\s*(\d)/g, '$1 x $2')
    .replace(/(\d),(\d{3})(?!\d)/g, '$1$2')
    .replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/[^a-z0-9.؀-ۿЀ-ӿ]+/g, ' ').replace(/(^|\s)\.+|\.+(\s|$)/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
/** text for telling whether it changed: case, spacing, quotes / dashes, thousands separators and
 *  "150mm" / "150 mm" aside - but every sign kept (+ - < > % ± ...: "-1.50" -> "+1.50" is a change;
 *  norm() above drops them and is for pairing only) */
export function fold(t: string): string {
  return t.toLowerCase()
    .replace(/[\u2018\u2019\u201b`´]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2212/g, '-')
    .replace(/²/g, '2').replace(/³/g, '3').replace(/(\d),(\d{3})(?!\d)/g, '$1$2')
    // (a hyphen as a PDF's words come out: "assumed2- T16", "T-grid" / "T grid" - a minus before a
    //  number stays a minus)
    .replace(/(\S)\s*-\s+(?=\S)/g, '$1-').replace(/([a-z])-(?=[a-z])/g, '$1 ')
    .replace(/(\d)\s+([a-z%°])/g, '$1$2').replace(/\s*([,;:.()/])\s*/g, '$1').replace(/\s+/g, ' ').trim();
}
// ("(Cont'd)", "(CONT'D.)" - the dot inside the bracket too -, "Continued", "(cont.)")
const CONTD = /[,;:\s-]*\(?\b(cont['*\u2019]?d|continued|cont(?=\.))\.?\)?\.?\s*$/i;
/** a heading's chain (heads down to it) does not say otherwise of the heads `ctx`: its own heads, as far
 *  as both go, the same */
const agrees = (chain: string[], ctx: string[]) => {
  const par = chain.slice(0, -1);
  for (let i = 0; i < Math.min(par.length, ctx.length); i++) if (norm(par[i]) !== norm(ctx[i])) return false;
  return true;
};
const isCaps = (t: string) => { const l = t.replace(/\([^)]*\)/g, '').replace(/[^A-Za-z]/g, ''); return l.length >= 3 && l.length <= 90 && l.replace(/[^A-Z]/g, '').length >= l.length * 0.85; };
const COLLECT = /\b(to collection|carried (to )?(collection|summary)|total carried|brought forward|carried forward|page total|sub-?total|collection page|total for (this )?page)\b/i;
const UNITS: Record<string, string> = { m2: 'm2', sqm: 'm2', 'sq m': 'm2', 'sq.m': 'm2', sm: 'm2', m3: 'm3', cum: 'm3', 'cu m': 'm3', 'cu.m': 'm3', nr: 'nr', no: 'nr', nos: 'nr', 'no.': 'nr', 'nos.': 'nr', number: 'nr', each: 'nr', ea: 'nr', pcs: 'nr', pc: 'nr', item: 'item', it: 'item', items: 'item', ls: 'sum', 'l.s': 'sum', 'l.s.': 'sum', 'lump sum': 'sum', sum: 'sum', ps: 'ps', 'p.s': 'ps', 'p.s.': 'ps', lm: 'm', rm: 'm', 'r.m': 'm', 'l.m': 'm', m: 'm', mt: 't', 'm.t': 't', kg: 'kg', kgs: 'kg', t: 't', tonne: 't', tonnes: 't', ton: 't', tons: 't', day: 'day', days: 'day', week: 'wk', weeks: 'wk', wk: 'wk', month: 'month', months: 'month', mth: 'month', mths: 'month', 'no/m': 'nr', set: 'set', sets: 'set', lot: 'lot', hr: 'hr', hrs: 'hr', hour: 'hr', hours: 'hr' };
export const unitOf = (u: string) => { const k = u.toLowerCase().replace(/²/g, '2').replace(/³/g, '3').replace(/\s+/g, ' ').trim().replace(/^([a-z.]+)\s+([23])$/, '$1$2'); return UNITS[k] ?? UNITS[k.replace(/\.$/, '')] ?? k; };
const KNOWN = new Set(Object.values(UNITS));
/** a unit the list knows (m2, nr, item, sum ...) */
export const knownUnit = (u: string) => KNOWN.has(unitOf(u));

interface Cols { item: number; desc: number; qty: number; unit: number; rate: number; amount: number }
function headerCols(cells: string[]): Cols | null {
  const f = (re: RegExp) => cells.findIndex((c) => re.test(c));
  const desc = f(/description/i);
  const qty = f(/^(qty|quantity|quantities|qnty)\b/i), unit = f(/^units?\b/i);
  if (desc < 0 || (qty < 0 && unit < 0)) return null;
  // (several: "Sr. No. | Item No. | Description" - the one nearest the description is the item's
  //  number; a serial number left of it is not part of the description)
  const ITEM = /^(item|items|item\s*(no|ref)\.?|ref\.?|reference|no\.?|s\.?\s*no\.?|sr\.?\s*no\.?|code)$/i;
  const its = cells.map((c, k) => (ITEM.test(c) ? k : -1)).filter((k) => k >= 0);
  let item = its.filter((k) => k < desc).pop() ?? its[0] ?? -1;
  if (item < 0 && desc > 0) item = desc - 1;
  return { item, desc, qty, unit, rate: f(/^(unit\s*)?(rate|price)\b/i), amount: f(/^(amount|total|amt)\b/i) };
}
const PAGE_LABEL = /^(page\s*(no\.?)?\s*)?[A-Z]{1,4}\d?\s*[/-]\s*\d{1,4}$/i;
/** a page / section code of the BOQ's own ("B19/Q+R/MEP", "B13/J/FOH/12"): page furniture, not a heading */
const PAGE_CODE = /^[A-Z]{1,3}\d{0,3}(\s*\/\s*[A-Za-z0-9+&.\- ]{1,25}){1,4}$/;
/** a number cell - also one typed as text ("1,447", "2 238.50") - else its text */
const num = (v: Val | undefined): number | string | null => {
  if (typeof v === 'number') return v;
  const t = s(v);
  if (/^-?\d{1,3}([, ]\d{3})+(\.\d+)?$|^-?\d*\.?\d+$/.test(t)) return Number(t.replace(/[, ]/g, ''));
  return t || null;
};

/** the bill a file (or sheet) is: "Bill 02" from its name, else the name */
export function billOf(name: string): string {
  const m = /(?<![a-z])bill\s*(no\.?)?\s*[-.]?\s*0*(\d+)/i.exec(name);
  return m ? 'Bill ' + m[2].padStart(2, '0') : name.replace(/\.(xlsx?|xlsm|pdf)$/i, '');
}

/** the files of a set in the order of their bills ("Bill-2", "Bill-3", ... "Bill-10"), whatever their
 *  names sort as ("_ Bill-4" before "_Bill- 2") - each issue read in the same order */
export function byBill(a: string, b: string): number {
  const n = (x: string) => { const m = /(?<![a-z])bill\s*(no\.?)?\s*[-.]?\s*0*(\d+)/i.exec(x); return m ? +m[2] : Infinity; };
  return n(a) - n(b) || a.localeCompare(b, undefined, { numeric: true });
}

/** the items of a workbook (one file of a set; `file` names it in the results; `bill`: the bill the
 *  file is in a set of several - "" when one file is compared with one file) */
export function readItems(book: Book, file: string, start = 0, bill?: string): BoqDoc {
  const items: BoqItem[] = [];
  const notes: string[] = [];
  const sheets: BoqDoc['sheets'] = [];
  const fileBill = bill ?? billOf(file);
  for (const sh of book.sheets) {
    if (sh.hidden) { sheets.push({ name: sh.name, items: 0, skipped: 'hidden sheet' }); continue; }
    const hiddenCols = new Set(sh.hiddenCols);
    const rows = sh.rows.map((r) => ({ r: r.r, hidden: r.hidden, cells: r.c.map((v, k) => (hiddenCols.has(k) ? '' : s(v))), raw: r.c, ocr: r.ocr, pg: r.pg, bx: r.bx }));
    // the header (Item / Description / Qty / Unit / Rate / Amount) - a sheet without one holds no items
    let cols: Cols | null = null;
    for (const r of rows) { cols = headerCols(r.cells); if (cols) break; }
    if (!cols) { sheets.push({ name: sh.name, items: 0, skipped: 'no item header' }); continue; }
    const C = cols;
    // page furniture: the same line on many pages (client, project, "Issued on", the header)
    const seen = new Map<string, number>();
    const line = (r: (typeof rows)[0]) => r.cells.filter(Boolean).join(' | ');
    for (const r of rows) { const t = line(r); if (t) seen.set(t, (seen.get(t) || 0) + 1); }
    const inItemCol = new Map<string, number>();
    if (C.item >= 0) for (const r of rows) { const v = r.cells[C.item]; if (v) inItemCol.set(v, (inItemCol.get(v) || 0) + 1); }
    const sheetBill = /\bbill\b/i.test(sh.name) ? billOf(sh.name) : fileBill;
    // (pages: a header row again, a "To Collection" line, or a printed page label "B/12")
    let started = false, page = 1, pageLabel = '', inCollection = false, pageEnded = false;
    let section = '', group: string[] = [], afterItem = false;
    const under = new Map<string, string[]>();
    /** the text a "(Cont'd)" heading takes back - once text follows it (items straight after it are
     *  read under the text they were under before the break) */
    let resume: string[] | null = null;
    let pending: { ref: string; text: string[]; row: number } | null = null;
    let count = 0;
    let hiddenItems = 0;
    for (const r of rows) {
      const cells = r.cells;
      // (a row hidden in Excel is not in the BOQ as issued - an item deleted by hiding its row)
      if (r.hidden) { if (cells.some(Boolean)) hiddenItems++; continue; }
      const hc = headerCols(cells);
      if (hc) { if (started && !pageEnded) page++; pageEnded = false; started = true; inCollection = false; continue; }
      if (!started) continue;
      // (a page label - "B/12" - wherever it sits on the row; the line is furniture)
      const lab = cells.find((c) => PAGE_LABEL.test(c) || (PAGE_CODE.test(c) && c.includes('/') && !/\s{0}\b(and|or|of|to|for|with)\b/i.test(c)));
      if (lab) { if (pageEnded) { page++; pageEnded = false; } pageLabel = lab.replace(/^page\s*(no\.?)?\s*/i, ''); }
      const t = line(r);
      if (!t) continue;
      if (pageEnded && !COLLECT.test(t) && !lab) { page++; pageEnded = false; pageLabel = ''; }
      let unit = C.unit >= 0 ? cells[C.unit] || '' : '';
      // (and a collection's lines: "From Page No. B1/3")
      if (COLLECT.test(t) || /^(total|sub-?total|carried|brought|from page)\b/i.test(cells.filter(Boolean).join(' '))) { pageEnded = true; continue; }
      // (a phrase in the unit column - a PDF's column read wrong - is not a unit)
      if (unit.split(/\s+/).length > 3 || unit.length > 16) unit = '';
      // (nor a dash - "nil" - or a page reference "Works/9")
      if (/^[-–—]+$/.test(unit) || /\/\s*\d/.test(unit)) unit = '';
      const qtyV = C.qty >= 0 ? r.raw[C.qty] : null;
      const qty = C.qty >= 0 && !hiddenCols.has(C.qty) ? num(qtyV) : null;
      // (and the columns between the item's number and its description - "Sign Type: ID-BH03" - are
      //  part of what it is)
      let desc = (C.item >= 0 && C.desc - C.item > 1 ? [...cells.slice(C.item + 1, C.desc), cells[C.desc]] : [cells[C.desc]]).filter(Boolean).join(' ');
      let ref = C.item >= 0 && C.item !== C.desc ? cells[C.item] || '' : '';
      // (a 0 in the item column of a heading row - an MEP bill - is no item number; nor a heading set
      //  from the sheet's left edge - "IDENTITY SIGN TYPES" in the "No." column)
      if (ref === '0') ref = '';
      //  (once: client, project and bill names set there are on every page)
      if (ref && !/\d/.test(ref) && ref.replace(/[^A-Za-z]/g, '').length > 3 && (inItemCol.get(ref) || 0) < 2) { desc = [ref, desc].filter(Boolean).join(' '); ref = ''; }
      const amountV = C.amount >= 0 ? num(r.raw[C.amount]) : null, rateV = C.rate >= 0 ? num(r.raw[C.rate]) : null;
      // (an item priced by its amount only - a provisional sum: "A | Allow the sum of ... | | | 50,000")
      const priced = (typeof amountV === 'number' && amountV !== 0) || (typeof rateV === 'number' && rateV !== 0);
      const isItem = !!unit || (!!ref && desc !== '' && (qty !== null || priced));
      if (!isItem) {
        if (lab && (!desc || desc === lab)) continue;
        if (COLLECT.test(t)) { pageEnded = true; continue; }
        // (a line of several cells on every page: client, project, issue date)
        if ((seen.get(t) || 0) >= 3 && cells.filter(Boolean).length > 1) continue;
        if (/^(collection|summary|page summary)$/i.test(desc.replace(CONTD, '').replace(/[^a-z ]/gi, '').trim())) { inCollection = true; continue; }
        if (inCollection) continue;
        if (!desc) continue;
        if (ref) {
          // (an item whose number is on its first line and its quantity on its last)
          if (pending) group.push(...pending.text);
          pending = { ref, text: [desc], row: r.r };
          continue;
        }
        // (a heading in capitals - a section, a bill's title - ends an item number left without its
        //  quantity: "A" on a line of its own for the tenderer to fill in)
        if (pending && !(isCaps(desc) && /^(section|bill|part|division)\b/i.test(desc.trim()))) { pending.text.push(desc); continue; }
        pending = null;
        if (isCaps(desc)) {
          // (a heading carried over a page break - "SUBSTRUCTURE (CONT'D)" - keeps the text read with
          //  the items under it)
          const h = desc.replace(CONTD, '').trim();
          // (the bill's own title written at the top of each page - "BILL 07 - WOODEN JOINERY WORKS -
          //  SECTION F" - is no section: the items after it are under the heading they were before)
          if (/^bill\s*(no\.?)?\s*[-.]?\s*\d+\b/i.test(h)) continue;
          if (CONTD.test(desc)) { if (norm(h) !== norm(section) && !/^bill\b/i.test(h)) section = h; continue; }
          section = h; group = []; afterItem = false; resume = null; continue;
        }
        // (a heading written again after a page break - "Formwork to (Cont'd)" - is not new text: what
        //  follows it is read under the text down to that heading as it was first written; items
        //  straight after it under the text they were under before the break - wherever the page
        //  breaks fall in either issue)
        const d = desc.replace(CONTD, '').trim();
        if (!d) continue;
        if (CONTD.test(desc)) {
          const was = under.get(norm(d));
          if (was) {
            // (under the heads just taken back on this page - "Internal Floor Finishes (Cont'd)" / "Tiles
            //  ... (Cont'd)" / "Common Area (Cont'd)": that "Common Area", not one written under another
            //  head before - a generic sub-heading is written under many)
            //  (only a chain taken back just above: a "(Cont'd)" after a heading of its own is its parent
            //  written again - "Temporary Drainage" / "Contractor's requirements (Cont'd)")
            const ctx = resume as string[] | null;
            const fits: boolean = !ctx?.length || agrees(was, ctx);
            const at: number = ctx ? ctx.findIndex((g) => norm(g) === norm(d)) : -1;
            resume = fits ? was : at >= 0 ? ctx!.slice(0, at + 1) : [...ctx!, d];
            continue;
          }
        }
        // (and a heading written again under it without "(Cont'd)" takes back its own - unless that was
        //  written under other heads: "Common Area" under "Internal Wall Finishes" is not the one under
        //  "Internal Ceiling Finishes (Cont'd)")
        if (resume) {
          //  (one written before under other heads: as if no page broke here - after the items, the text afresh)
          const again = under.get(norm(d));
          const use = !!again && agrees(again, resume);
          group = use ? [...again!] : again ? [] : [...resume]; resume = null; afterItem = false;
          if (use) continue;
        }
        if (afterItem) { group = []; afterItem = false; }
        // (a heading already in the text the items are under - written again under its "(Cont'd)" - is
        //  not added twice)
        if (group.some((g) => norm(g) === norm(d))) continue;
        group.push(d);
        continue;
      }
      let text = desc;
      let row = r.r;
      if (pending) {
        // (its number on the first line, its quantity on this one - unless this line has a number of
        //  its own: then the line before was a heading with a number, read with the items under it)
        if (!ref) { ref = pending.ref; text = [...pending.text, desc].filter(Boolean).join(' '); row = pending.row; }
        else { if (afterItem) { group = []; afterItem = false; } group.push(...pending.text); }
        pending = null;
      }
      // (each line of the text the item is under remembers the text down to it - for a "(Cont'd)" of
      //  it later)
      resume = null;
      if (!afterItem) group.forEach((g, k) => under.set(norm(g), group.slice(0, k + 1)));
      const mark = /^\*/.test(ref) || /\*$/.test(ref);
      const prev = items[items.length - 1];
      const basis = /^ditto\b/i.test(text) && prev ? (prev.basis ? prev.basis + ' ' : '') + prev.text.replace(/^ditto\b[^a-z0-9]*/i, '') : undefined;
      items.push({
        i: start + items.length, file, bill: sheetBill, sheet: sh.name, row: row + 1, ...(row !== r.r ? { last: r.r + 1 } : {}), page: r.pg !== undefined ? 'p.' + (r.pg + 1) : pageLabel || 'p.' + page,
        ref: ref.replace(/\*/g, '').trim(), mark, section, group: group.join(' '), text, basis, ...(r.ocr ? { ocr: true } : {}),
        unit, qty, rate: C.rate >= 0 ? num(r.raw[C.rate]) : null, amount: C.amount >= 0 ? num(r.raw[C.amount]) : null,
      });
      count++;
      afterItem = true;
    }
    if (pending) notes.push(`${sh.name}: item ${pending.ref} at row ${pending.row + 1} has no quantity or unit - left out`);
    if (hiddenItems) notes.push(`${sh.name}: ${hiddenItems} hidden row${hiddenItems === 1 ? '' : 's'} left out (hidden in Excel)`);
    // (the sheet as it is laid out, for the side-by-side view: its visible rows, the columns that hold
    //  anything - a workbook's blank and hidden columns left out - trailing empty rows dropped)
    const vis = rows.filter((r) => !r.hidden);
    while (vis.length && !vis[vis.length - 1].cells.some(Boolean)) vis.pop();
    const used: number[] = [];
    const width = vis.reduce((m, r) => Math.max(m, r.cells.length), 0);
    for (let k = 0; k < width; k++) if (vis.some((r) => r.cells[k])) used.push(k);
    const at = (k: number) => used.indexOf(k);
    const grid: BoqGrid = { rows: vis.map((r) => r.r + 1), cells: vis.map((r) => used.map((k) => r.cells[k] ?? '')), cols: used, at: { item: at(C.item), desc: at(C.desc), qty: at(C.qty), unit: at(C.unit), rate: at(C.rate), amount: at(C.amount) } };
    if (vis.some((r) => r.pg !== undefined)) grid.pg = vis.map((r) => r.pg ?? -1);
    if (vis.some((r) => r.bx)) grid.bx = vis.map((r) => (r.bx ? [...r.bx.slice(0, 4), ...used.flatMap((k) => [r.bx![4 + 2 * k] ?? NaN, r.bx![5 + 2 * k] ?? NaN])] : null));
    sheets.push({ name: sh.name, items: count, file, sheet: sh.name, grid });
  }
  return { items, notes, sheets };
}

// ---------------------------------------------------------------- pairing

export interface Tok { words: Map<string, number>; nums: string[]; n: number }
export function tok(t: string): Tok {
  const words = new Map<string, number>();
  const nums: string[] = [];
  let n = 0;
  for (let w of norm(t).split(' ')) {
    if (!w) continue;
    // (walls / wall, rafts / raft)
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !/^\d/.test(w)) w = w.slice(0, -1);
    n++;
    words.set(w, (words.get(w) || 0) + 1);
    if (/^\d/.test(w)) nums.push(w.replace(/\.0+$/, ''));
  }
  nums.sort();
  return { words, nums, n };
}
/** how alike two descriptions are (0-1): shared words; a number that differs counts heavily */
export function likeness(a: Tok, b: Tok): number {
  if (!a.n && !b.n) return 1;
  let common = 0;
  for (const [w, k] of a.words) common += Math.min(k, b.words.get(w) || 0);
  let d = (2 * common) / (a.n + b.n);
  if (a.nums.join(' ') !== b.nums.join(' ')) d *= a.nums.length && b.nums.length ? 0.75 : 0.85;
  return d;
}

export type Field = 'qty' | 'unit' | 'text' | 'group' | 'section' | 'rate' | 'amount';
export interface BoqPair {
  o: number; n: number;
  /** what changed (empty: the same item) */
  changed: Field[];
  renumbered: boolean;
  /** out of its order against the items round it, or into another bill / sheet */
  moved: boolean;
  /** how it was paired: same text, same place, or likeness */
  how: 'same' | 'place' | 'like';
  /** how alike the two descriptions are (0-1): under 0.7, the pairing is worth a look */
  like: number;
}
export interface BoqResult {
  old: BoqDoc; neu: BoqDoc;
  pairs: BoqPair[];
  removed: number[]; added: number[];
  /** a new issue of changed pages only: old items outside the pages it covers (not "removed") */
  outside: number[];
  /** pictures inside a bill's pages that changed / came / went (T6.5; host.ts) - never items */
  pics?: import('./picdiff').BoqPic[];
}

/** an item's own words: its line(s) - a "Ditto" with the item it stands on */
const own = (x: BoqItem) => (x.basis ? x.basis + ' ' : '') + x.text;
const full = (x: BoqItem) => (x.group ? x.group + ' ' : '') + own(x);
/** a rate / amount that says nothing: blank, 0, "-" (an unpriced BOQ writes any of them) */
const nil = (v: number | string | null) => v === null || v === 0 || (typeof v === 'string' && /^[\s\-–—0.,]*$|^(aed|usd|dhs?)$|^#[A-Z/0!?]+[!?]?$/i.test(v.trim()));
const samePrice = (a: number | string | null, b: number | string | null) => (nil(a) && nil(b)) || sameVal(a, b);
const sameVal = (a: number | string | null, b: number | string | null) => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return norm(String(a ?? '')) === norm(String(b ?? ''));
};

/** the items of two issues paired */
export function compareBoq(old: BoqDoc, neu: BoqDoc, opts: { partial?: boolean } = {}): BoqResult {
  const O = old.items, N = neu.items;
  // (a bill of the new issue whose number the old one has not - "Bill-01 (B+GF+P)" re-issued for
  //  "Bill-2 (B+GF+P)" - is read as the old bill without a namesake it shares most items with; a
  //  number on both sides stays itself: Tower 1 and Tower 2 read alike)
  const bO = (x: BoqItem) => norm(x.bill);
  const billN = new Map<string, string>();
  {
    const has = (A: BoqItem[]) => { const m = new Map<string, Set<string>>(); for (const x of A) { const b = norm(x.bill); if (!m.has(b)) m.set(b, new Set()); m.get(b)!.add(norm(own(x))); } return m; };
    const mo = has(O), mn = has(N);
    const lone = [...mn.keys()].filter((b) => !mo.has(b)), free = new Set([...mo.keys()].filter((b) => !mn.has(b)));
    for (const b of lone) {
      let best = '', bv = 0;
      for (const c of free) { let k = 0; for (const t of mn.get(b)!) if (mo.get(c)!.has(t)) k++; const v = k / Math.max(1, Math.min(mn.get(b)!.size, mo.get(c)!.size)); if (v > bv) { bv = v; best = c; } }
      if (best && bv >= 0.3) { billN.set(b, best); free.delete(best); }
    }
  }
  const bN = (x: BoqItem) => billN.get(norm(x.bill)) ?? norm(x.bill);
  const tO = O.map((x) => tok(full(x))), tN = N.map((x) => tok(full(x)));
  const oO = O.map((x) => tok(own(x))), oN = N.map((x) => tok(own(x)));
  const gO = O.map((x) => tok(x.group)), gN = N.map((x) => tok(x.group));
  // (an item is told from its neighbours by its own line: the heading they share counts less - a
  //  long shared heading made any two items of a group look alike)
  const like = (o: number, n: number) => 0.7 * likeness(oO[o], oN[n]) + 0.3 * likeness(gO[o], gN[n]);
  // (in place: the whole description alike - or the item's own line the same, its heading reworded)
  // (the same quantity and unit - not a 1 / 0 / "Item" - backs a reworded description)
  const sameQty = (o: number, n: number) => typeof O[o].qty === 'number' && typeof N[n].qty === 'number' && O[o].qty !== 0 && O[o].qty !== 1 && sameVal(O[o].qty, N[n].qty) && unitOf(O[o].unit) === unitOf(N[n].unit);
  // (a quantity like 1,083 m says more than 2 nr: the same pipe on several floors, one reworded)
  const qtyBonus = (o: number, n: number) => (!sameQty(o, n) ? 0 : (O[o].qty as number) >= 10 || !Number.isInteger(O[o].qty) ? 0.35 : 0.2);
  // (an item's own code - "Ref. B2-FCU-04", "type SA-426" - says which of a run of look-alike items it
  //  is: the same code backs a pairing, another code weighs against it)
  const CODE = /(?<![A-Za-z0-9])(?=[A-Z0-9./-]*\d)(?=[A-Z0-9./-]*[A-Z])[A-Z0-9]+(?:[-./][A-Z0-9]+)+/g;
  // (and a number after "Ref" / "Type": "Ref: D08", "Type K5")
  const REF = /\b(?:ref|reference|type|code|tag|mark)\b\.?\s*[:.]?\s*\(?([A-Za-z]{0,6}\d[A-Za-z0-9./-]*)/gi;
  // (an IP rating is no code: half the fittings are IP-65)
  const codes = (x: BoqItem) => new Set([...(own(x).match(CODE) ?? []), ...[...own(x).matchAll(REF)].map((m) => m[1].toUpperCase().replace(/[.,;:)]+$/, ''))].filter((c) => !/^IP-?\d+$/.test(c)));
  const cO = O.map(codes), cN = N.map(codes);
  const codeBonus = (o: number, n: number) => (!cO[o].size || !cN[n].size ? 0 : [...cO[o]].some((c) => cN[n].has(c)) ? 0.15 : -0.1);
  const placeLike = (o: number, n: number) => Math.max(like(o, n), oO[o].n >= 2 ? 0.9 * likeness(oO[o], oN[n]) : 0) + qtyBonus(o, n) + codeBonus(o, n);
  const fO = O.map((x) => norm(full(x))), fN = N.map((x) => norm(full(x)));
  const oTo = new Int32Array(O.length).fill(-1), nTo = new Int32Array(N.length).fill(-1);
  const how: ('same' | 'place' | 'like')[] = [];
  const pair = (o: number, n: number, h: 'same' | 'place' | 'like') => { oTo[o] = n; nTo[n] = o; how[o] = h; };
  // 1. the same description, in the same bill / sheet / section, unit - by order among equals
  const exact = (keyO: (i: number) => string, keyN: (i: number) => string, equalCountsOnly: boolean) => {
    const byKey = new Map<string, number[]>();
    N.forEach((_, n) => { if (nTo[n] < 0) { const k = keyN(n); const l = byKey.get(k); if (l) l.push(n); else byKey.set(k, [n]); } });
    const oBy = new Map<string, number[]>();
    O.forEach((_, o) => { if (oTo[o] < 0) { const k = keyO(o); const l = oBy.get(k); if (l) l.push(o); else oBy.set(k, [o]); } });
    for (const [k, os] of oBy) {
      const ns = byKey.get(k);
      if (!ns) continue;
      if (equalCountsOnly && ns.length !== os.length) continue;
      if (ns.length === os.length && os.every((o, j) => sameVal(O[o].qty, N[ns[j]].qty))) os.forEach((o, j) => pair(o, ns[j], 'same'));
      else if (os.length * ns.length <= 40_000) alignGap(os, ns, (o, n) => 1 + (sameVal(O[o].qty, N[n].qty) ? 0.5 : 0) + (norm(O[o].ref) === norm(N[n].ref) ? 0.1 : 0) - 0.2 * Math.abs(o / O.length - n / N.length), 0.5, (o, n) => pair(o, n, 'same'));
      else alignRuns(os, ns, (o, n) => pair(o, n, 'same'));
    }
  };
  const sec = (x: BoqItem, b: string) => b + '|' + norm(x.sheet) + '|' + norm(x.section);
  // (equal items in unequal numbers - one of three identical valves deleted - wait for step 2: the
  //  items round them say which one went)
  exact((o) => sec(O[o], bO(O[o])) + '|' + fO[o] + '|' + unitOf(O[o].unit), (n) => sec(N[n], bN(N[n])) + '|' + fN[n] + '|' + unitOf(N[n].unit), true);
  // (then under the same section of the same bill - its sheet renamed, "EXT WORKS" -> "External
  //  Works" - then in the same bill - Tower 1's items with Tower 1's, though the two towers' bills read
  //  alike - then anywhere; its unit changed last, in its own bill and section first: "Upstand walls"
  //  in tonnes is not the "Upstand walls" in m3 of the next tower)
  const bs = (x: BoqItem, b: string) => b + '|' + norm(x.section);
  exact((o) => bs(O[o], bO(O[o])) + '|' + fO[o] + '|' + unitOf(O[o].unit), (n) => bs(N[n], bN(N[n])) + '|' + fN[n] + '|' + unitOf(N[n].unit), true);
  exact((o) => bO(O[o]) + '|' + fO[o] + '|' + unitOf(O[o].unit), (n) => bN(N[n]) + '|' + fN[n] + '|' + unitOf(N[n].unit), true);
  exact((o) => fO[o] + '|' + unitOf(O[o].unit), (n) => fN[n] + '|' + unitOf(N[n].unit), true);
  // (a description of a few words - "Upstand walls" - says too little to pair across a unit change:
  //  the order and quantities round it decide, step 2; and a unit changed in another section is left to
  //  them too - forty wardrobes "560 x 625" changed from No. to m in their own unit types)
  const says = (t: { n: number }) => t.n >= 4;
  exact((o) => (says(tO[o]) ? bs(O[o], bO(O[o])) + '|' + fO[o] : '\u0001' + o), (n) => (says(tN[n]) ? bs(N[n], bN(N[n])) + '|' + fN[n] : '\u0002' + n), true);
  // 2. between items that stayed in order, the rest paired by place and likeness (an item edited
  //    where it is: its description, quantity, unit)
  const anchors = inOrder(O.map((_, o) => o).filter((o) => oTo[o] >= 0), (o) => oTo[o]);
  const bounds = [[-1, -1], ...anchors.map((o) => [o, oTo[o]]), [O.length, N.length]];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const os: number[] = [], ns: number[] = [];
    for (let o = bounds[k][0] + 1; o < bounds[k + 1][0]; o++) if (oTo[o] < 0) os.push(o);
    for (let n = bounds[k][1] + 1; n < bounds[k + 1][1]; n++) if (nTo[n] < 0) ns.push(n);
    if (!os.length || !ns.length) continue;
    alignGap(os, ns, (o, n) => placeLike(o, n) + (unitOf(O[o].unit) === unitOf(N[n].unit) ? 0.05 : 0), 0.55, (o, n) => pair(o, n, 'place'));
  }
  // 3. the rest: alike enough anywhere (moved, perhaps changed too) - an item's own line the same and
  //    found once on each side (moved under another heading), or its whole description alike
  const ownKey = (x: BoqItem) => norm(own(x)) + '|' + unitOf(x.unit);
  const leftO = new Map<string, number[]>(), leftN = new Map<string, number[]>();
  O.forEach((x, o) => { if (oTo[o] < 0 && oO[o].n >= 3) { const k = ownKey(x); leftO.set(k, [...(leftO.get(k) ?? []), o]); } });
  N.forEach((x, n) => { if (nTo[n] < 0 && oN[n].n >= 3) { const k = ownKey(x); leftN.set(k, [...(leftN.get(k) ?? []), n]); } });
  for (const [k, os] of leftO) {
    const ns = leftN.get(k);
    if (!ns) continue;
    // (the same line in several places, gone from some and come in others: moved - by order, the
    //  same quantity first)
    if (os.length === 1 && ns.length === 1) { if (bO(O[os[0]]) === bN(N[ns[0]]) || oO[os[0]].n >= 4) pair(os[0], ns[0], 'like'); }
    else if (os.length * ns.length <= 40_000) alignGap(os, ns, (o, n) => 1 + (sameVal(O[o].qty, N[n].qty) ? 0.5 : 0), 0.5, (o, n) => pair(o, n, 'like'));
  }
  const index = new Map<string, number[]>();
  N.forEach((_, n) => { if (nTo[n] < 0) for (const w of tN[n].words.keys()) { const l = index.get(w); if (l) l.push(n); else index.set(w, [n]); } });
  const cands: [number, number, number][] = [];
  O.forEach((_, o) => {
    if (oTo[o] >= 0) return;
    const hit = new Map<number, number>();
    for (const w of tO[o].words.keys()) { const l = index.get(w); if (l && l.length < 400) for (const n of l) hit.set(n, (hit.get(n) || 0) + 1); }
    for (const [n] of hit) {
      // (moved anywhere: its own words mostly the same - a quantity alone pairs nothing; its own code -
      //  "Ref: D13" - and half its words are enough)
      const cb = codeBonus(o, n);
      if (likeness(oO[o], oN[n]) < (cb > 0 ? 0.45 : 0.6)) continue;
      const v = Math.max(like(o, n), likeness(tO[o], tN[n]) - 0.1) + (sameQty(o, n) ? 0.2 : 0) + cb + (cb > 0 ? 0.05 : 0);
      // (into another bill - another tower, the villas - only an item that says enough: "To laundry"
      //  is in every bill)
      if (v >= 0.85 && (bO(O[o]) === bN(N[n]) || (v >= 0.95 && oO[o].n >= 4))) cands.push([v, o, n]);
    }
  });
  cands.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, o, n] of cands) if (oTo[o] < 0 && nTo[n] < 0) pair(o, n, 'like');
  // which moved: into a sheet other than the one most of its sheet's items went to (sheets renamed,
  // re-ordered or split are followed), or out of order there against the items round it
  const sk = (x: BoqItem) => x.file + '\u0000' + x.sheet;
  const flow = new Map<string, Map<string, number>>();
  O.forEach((x, o) => { if (oTo[o] < 0) return; const m = flow.get(sk(x)) ?? new Map<string, number>(); const k = sk(N[oTo[o]]); m.set(k, (m.get(k) || 0) + 1); flow.set(sk(x), m); });
  const counterpart = new Map<string, string>();
  for (const [k, m] of flow) counterpart.set(k, [...m].sort((a, b) => b[1] - a[1])[0][0]);
  const paired = O.map((_, o) => o).filter((o) => oTo[o] >= 0);
  const kept = new Set<number>();
  const bySheet = new Map<string, number[]>();
  for (const o of paired) if (counterpart.get(sk(O[o])) === sk(N[oTo[o]])) { const l = bySheet.get(sk(O[o])) ?? []; l.push(o); bySheet.set(sk(O[o]), l); }
  for (const l of bySheet.values()) for (const o of inOrder(l, (x) => oTo[x])) kept.add(o);
  const pairs: BoqPair[] = paired.map((o) => {
    const a = O[o], b = N[oTo[o]];
    const changed: Field[] = [];
    if (!sameVal(a.qty, b.qty)) changed.push('qty');
    if (unitOf(a.unit) !== unitOf(b.unit)) changed.push('unit');
    // (the item's own line, or only the text it is read with - one heading edited for many items;
    //  told on the folded text: signs count)
    const ownCh = fold(own(a)) !== fold(own(b)), groupCh = fold(a.group) !== fold(b.group);
    if (ownCh) changed.push('text');
    else if (groupCh) changed.push('group');
    if (fold(a.section) !== fold(b.section)) changed.push('section');
    if (!samePrice(a.rate, b.rate)) changed.push('rate');
    if (!samePrice(a.amount, b.amount)) changed.push('amount');
    return {
      o, n: oTo[o], changed, how: how[o], like: Math.round(Math.max(likeness(tO[o], tN[oTo[o]]), likeness(oO[o], oN[oTo[o]])) * 100) / 100,
      renumbered: norm(a.ref) !== norm(b.ref),
      moved: !kept.has(o),
    };
  });
  let removed = O.map((_, o) => o).filter((o) => oTo[o] < 0);
  let outside: number[] = [];
  if (opts.partial) {
    // (removed only between two items the new pages have, on the same or the next page there)
    const pageNo = (x: BoqItem) => x.file + '|' + x.sheet + '|' + x.page;
    // (on an old page the new issue has: an item of that page found in it - a page not issued has
    //  none; two items either side of a gap of pages sit next to each other in the new issue)
    const issued = new Set<string>();
    O.forEach((x, o) => { if (oTo[o] >= 0) issued.add(pageNo(x)); });
    const covered = (o: number) => issued.has(pageNo(O[o]));
    outside = removed.filter((o) => !covered(o));
    removed = removed.filter((o) => covered(o));
  }
  return { old, neu, pairs, removed, added: N.map((_, n) => n).filter((n) => nTo[n] < 0), outside };
}

/** the longest run of `xs` (in their order) whose `to` also rises: the ones that kept their order */
export function inOrder(xs: number[], to: (x: number) => number): number[] {
  const tails: number[] = [], prev = new Int32Array(xs.length).fill(-1), at: number[] = [];
  xs.forEach((x, i) => {
    const v = to(x);
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (to(xs[tails[m]]) < v) lo = m + 1; else hi = m; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
    at[i] = lo;
  });
  const out: number[] = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.push(xs[i]);
  return out.reverse();
}

/** equal items in different numbers: paired in order, the extra ones left where they fit worst */
function alignRuns(os: number[], ns: number[], put: (o: number, n: number) => void) {
  // (by relative position in the run - the first stays the first, the last the last)
  const short = os.length < ns.length ? os : ns, long = short === os ? ns : os;
  let j = 0;
  for (let i = 0; i < short.length; i++) {
    const want = (i + 0.5) / short.length;
    while (j + 1 < long.length && Math.abs((j + 1.5) / long.length - want) < Math.abs((j + 0.5) / long.length - want) && long.length - j - 1 >= short.length - i) j++;
    if (short === os) put(short[i], long[j]); else put(long[j], short[i]);
    j++;
  }
}

/** a gap between items kept in order: paired in order, by likeness (best total, each at least `min`) */
export function alignGap(os: number[], ns: number[], like: (o: number, n: number) => number, min: number, put: (o: number, n: number) => void) {
  if (os.length * ns.length > 250_000) {
    // (a big rewrite: best pairs first)
    const c: [number, number, number][] = [];
    for (const o of os) for (const n of ns) { const v = like(o, n); if (v >= min + 0.1) c.push([v, o, n]); }
    c.sort((a, b) => b[0] - a[0]);
    const uo = new Set<number>(), un = new Set<number>();
    for (const [, o, n] of c) if (!uo.has(o) && !un.has(n)) { uo.add(o); un.add(n); put(o, n); }
    return;
  }
  const R = os.length, K = ns.length;
  const S = new Float64Array((R + 1) * (K + 1));
  const W = (i: number, j: number) => i * (K + 1) + j;
  const sim = new Float64Array(R * K);
  for (let i = 0; i < R; i++) for (let j = 0; j < K; j++) sim[i * K + j] = like(os[i], ns[j]);
  for (let i = 1; i <= R; i++) for (let j = 1; j <= K; j++) {
    const v = sim[(i - 1) * K + j - 1];
    // (what a pair is worth: how far it is above `min` - summing plain likeness preferred two weak
    //  pairs to one sure one: a removed item took its edited neighbour's place)
    S[W(i, j)] = Math.max(S[W(i - 1, j)], S[W(i, j - 1)], v >= min ? S[W(i - 1, j - 1)] + v - min + 1e-6 : -Infinity);
  }
  for (let i = R, j = K; i > 0 && j > 0;) {
    const v = sim[(i - 1) * K + j - 1];
    if (v >= min && S[W(i, j)] === S[W(i - 1, j - 1)] + v - min + 1e-6) { put(os[i - 1], ns[j - 1]); i--; j--; }
    else if (S[W(i, j)] === S[W(i - 1, j)]) i--;
    else j--;
  }
}

/** a word as the strict rule has it (DECISIONS 19): lower case, typographic quotes and dashes plain,
 *  punctuation at its two ends taken off (, ; . : ! ? quotes, brackets) - and nothing else: digits and
 *  + - ± ≥ ≤ > < = % ° / × * # stay, inside the word and at its ends ("-5" ≠ "+5", "50%" ≠ "50",
 *  "M-20" ≠ "M20", ">=" ≠ ">"). A quote after a digit is a foot / inch mark, a dot before a digit a
 *  decimal point: kept. When unsure, a difference. Two words alike under this key are the same word. */
export function strictWord(w: string): string {
  return w.toLowerCase()
    .replace(/[\u2018\u2019\u201b`\u00b4]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/^(?:[,;:!?'"()[\]{}]|\.(?!\d))+/, '').replace(/(?:[,;.:!?()[\]{}]|(?<!\d)['"])+$/, '');
}
/** a description's words, what was taken out and put in (for the list and the export): words the same
 *  under `key` (the strict rule by default) are the same */
export function wordDiff(a: string, b: string, key: (w: string) => string = strictWord): { op: '=' | '-' | '+'; t: string }[] {
  const A = a.split(/(\s+)/).filter((x) => x.trim()), B = b.split(/(\s+)/).filter((x) => x.trim());
  const R = A.length, K = B.length;
  if (R * K > 4_000_000) {
    // (a very long paragraph: the same words at both ends kept, only the middle marked - it was all marked, and its
    //  figures paired by place: "10 -> 10"; ritual 17 Nov. Under the limit nothing changes.)
    const kA = A.map(key), kB = B.map(key);
    let s = 0, e = 0;
    while (s < R && s < K && kA[s] === kB[s]) s++;
    while (e < R - s && e < K - s && kA[R - 1 - e] === kB[K - 1 - e]) e++;
    if ((R - s - e) * (K - s - e) > 4_000_000 || s + e === 0) return [{ op: '-', t: a }, { op: '+', t: b }];
    const mid = wordDiff(A.slice(s, R - e).join(' '), B.slice(s, K - e).join(' '), key);
    const out: { op: '=' | '-' | '+'; t: string }[] = [];
    const add = (op: '=' | '-' | '+', t: string) => { if (!t) return; const l = out[out.length - 1]; if (l && l.op === op) l.t += ' ' + t; else out.push({ op, t }); };
    add('=', B.slice(0, s).join(' '));
    for (const x of mid) add(x.op, x.t);
    add('=', B.slice(K - e).join(' '));
    return out;
  }
  const kA = A.map(key), kB = B.map(key);
  const L = new Uint32Array((R + 1) * (K + 1));
  for (let i = R - 1; i >= 0; i--) for (let j = K - 1; j >= 0; j--) L[i * (K + 1) + j] = kA[i] === kB[j] ? L[(i + 1) * (K + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (K + 1) + j], L[i * (K + 1) + j + 1]);
  const out: { op: '=' | '-' | '+'; t: string }[] = [];
  const add = (op: '=' | '-' | '+', t: string) => { const l = out[out.length - 1]; if (l && l.op === op) l.t += ' ' + t; else out.push({ op, t }); };
  let i = 0, j = 0;
  while (i < R && j < K) {
    if (kA[i] === kB[j]) { add('=', B[j]); i++; j++; }
    else if (L[(i + 1) * (K + 1) + j] >= L[i * (K + 1) + j + 1]) add('-', A[i++]);
    else add('+', B[j++]);
  }
  while (i < R) add('-', A[i++]);
  while (j < K) add('+', B[j++]);
  return out;
}

/** (T8) what the list needs besides the pairs: for each pair its group (the same change x N, DECISIONS 25: 3 or
 *  more pairs whose every change is the same - the same description words taken out and put in, the same
 *  rate / quantity / unit change, the same heading words, moved or not; -1 none) and the figures inside its
 *  description (changed words that hold a digit or are a unit, grade, standard or finish code). One pass: a
 *  key per pair, counted in a Map. An amount that only follows a rate or quantity change is no part of the key. */
export function pairMeta(old: BoqItem[], neu: BoqItem[], pairs: BoqPair[]): { rep: number[]; size: number[]; figs: (Fig[] | undefined)[] } {
  const val = (v: number | string | null) => (typeof v === 'number' ? String(v) : v === null ? '' : norm(String(v)));
  const words = (a: string, b: string) => hunksOf(wordDiff(a, b), (w) => !!strictWord(w));
  const figs: (Fig[] | undefined)[] = [];
  const keys = pairs.map((p, i) => {
    figs[i] = undefined;
    if (!p.changed.length) return ''; // (moved only, or only renumbered: nothing was taken out or put in)
    const a = old[p.o], b = neu[p.n];
    const ch = new Set(p.changed);
    const parts: string[] = [];
    if (ch.has('text')) {
      const h = words(a.text, b.text);
      // (only punctuation changed: no words to key on - not one group of them all; Engineer A11)
      if (h.length) parts.push('t:' + repKey(h, strictWord));
      const f = figsOf(h);
      if (f.length) figs[i] = f;
    }
    if (ch.has('qty')) parts.push(`q:${val(a.qty)}>${val(b.qty)}`);
    if (ch.has('unit')) parts.push(`u:${norm(a.unit)}>${norm(b.unit)}`);
    if (ch.has('rate')) parts.push(`r:${val(a.rate)}>${val(b.rate)}`);
    if (ch.has('amount') && !ch.has('rate') && !ch.has('qty')) parts.push(`a:${val(a.amount)}>${val(b.amount)}`);
    if (ch.has('group')) parts.push('g:' + repKey(words(a.group, b.group), strictWord));
    if (ch.has('section')) parts.push('s:' + repKey(words(a.section, b.section), strictWord));
    if (p.moved) parts.push('mv');
    // (a figure change with no words changed - qty 1 -> 2 - is the same change only on the same item: a fire pump set
    //  and a timber door going 1 -> 2 are two changes; Engineer A2)
    if (parts.length && !parts.some((x) => x.startsWith('t:'))) parts.push('d:' + norm(b.text));
    return parts.join('|');
  });
  const { rep, size } = groupKeys(keys);
  return { rep, size, figs };
}
