// A BOQ issued as PDF read back into rows and columns: the words of each page (PDFium), lines by
// height, columns by the header line (Item / Description / Qty / Unit / Rate / Amount), a
// description wrapped over several lines joined - then read like a spreadsheet (boq.ts). Less sure
// than a workbook: the results say so ("from a PDF - check").
import type { Book, Sheet, SheetRow, Val } from './sheets';
import type { Word } from './pdfium';
import { knownUnit } from './boq';

const HEAD: [Exclude<keyof Cols, 'other'>, RegExp][] = [
  ['item', /^(item|items|ref\.?|no\.?|s\.?no\.?|sr\.?)$/i], ['desc', /^description$/i], ['qty', /^(qty\.?|quantity|quantities)$/i],
  ['unit', /^units?\.?$/i], ['rate', /^(rate|price)$/i], ['amount', /^(amount|total)$/i],
];
interface Cols { item?: Word; desc?: Word; qty?: Word; unit?: Word; rate?: Word; amount?: Word; other?: Word[] }

/** lines of a page: words whose middles are within half a line of each other, left to right */
export function lines(ws: Word[]): Word[][] {
  const sorted = [...ws].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const out: Word[][] = [];
  for (const w of sorted) {
    const cy = (w.y0 + w.y1) / 2, h = w.y1 - w.y0;
    const l = out[out.length - 1];
    if (l) { const ly = l.reduce((s, x) => s + (x.y0 + x.y1) / 2, 0) / l.length; const lh = l.reduce((s, x) => s + x.y1 - x.y0, 0) / l.length; if (Math.abs(cy - ly) < Math.max(h, lh) * 0.5) { l.push(w); continue; } }
    out.push([w]);
  }
  for (const l of out) l.sort((a, b) => a.x0 - b.x0);
  return out;
}

/**
 * The pages of a PDF BOQ as one sheet. `pages(i)` gives page i's words (top-down page points).
 * Pages before the first header line (covers, notes) are left out; a page without one carries on
 * with the columns of the page before.
 */
export function pdfBook(name: string, pageCount: number, pageWords: (i: number) => Word[], ocrPages?: Set<number>): Book {
  // (a sheet per bill, as the workbook it was printed from: "Bill No 10 - Wooden Doors" over the
  //  header line starts one - a heading read in one bill is not carried into the next)
  const sheets: Sheet[] = [];
  let rows: SheetRow[] = [], sheetName = name, billKey = '';
  const flush = () => { if (rows.length) sheets.push({ name: sheetName, hidden: false, rows, hiddenCols: [] }); rows = []; };
  const taken = new Set<string>();
  let cols: Cols | null = null;
  let r = 0;
  // page furniture: a line found on most pages (footer, classification, project name) - numbers aside
  const all = Array.from({ length: pageCount }, (_, p) => lines(pageWords(p)));
  // (a revision mark is no part of it: "Sec A/Page 9/R4" on the pages re-issued, "/R3" on the rest)
  const key = (l: Word[]) => l.map((w) => w.s).join(' ').toLowerCase().replace(/[\d/.-]+/g, '#').replace(/#r(ev)?#$/, '#');
  // (in the top or bottom eighth of a page's text, on half the pages of 3 or more: an item line
  //  repeated on short pages - "Plaster to walls 55 m2" / "60 m2" - is never one)
  // (min / max by a loop: a spread of a page of 70,000 words' heights throws - 0.6.0 T24)
  const band = all.map((ls) => { let lo = Infinity, hi = -Infinity; for (const l of ls) for (const w of l) { if (w.y0 < lo) lo = w.y0; if (w.y1 > hi) hi = w.y1; } return [lo + (hi - lo) * 0.125, hi - (hi - lo) * 0.125]; });
  const inBand = (l: Word[], p: number) => { const y = (l[0].y0 + l[0].y1) / 2; return y < band[p][0] || y > band[p][1]; };
  const onPages = new Map<string, number>();
  all.forEach((ls, p) => { for (const k of new Set(ls.filter((l) => inBand(l, p)).map(key))) onPages.set(k, (onPages.get(k) || 0) + 1); });
  // (3 pages are enough in a long BOQ: a bill's own title is on its pages only - but never a line
  //  that carries a quantity: a figure under the Qty heading - "Page 12", "PTC 2" are furniture)
  // (nor a heading carried over the page - "Wooden Joinery Work (Cont'd)": it says what the items under
  //  it are under, as the workbook's own row does)
  const furniture = (l: Word[], p: number, qtyR = Infinity) => (inBand(l, p) && PAGE_LINE.test(l.map((w) => w.s).join(' ').trim()))
    || (pageCount >= 3 && !CONTD_LINE.test(l.map((w) => w.s).join(' ')) && inBand(l, p) && (onPages.get(key(l)) || 0) >= 3 && !/description/i.test(key(l)) && !l.some((w) => /^\d[\d,]*(\.\d+)?$/.test(w.s) && Math.abs(w.x1 - qtyR) < 30));
  const text = (l: Word[]) => l.map((w) => w.s).join(' ');
  const where = (C: Cols) => {
    // where the columns are: the item column ends a little right of its heading; the description
    // runs up to the first number column; number columns are known by their headings' middles
    const right = [...(['qty', 'unit', 'rate', 'amount'] as const).filter((k) => C[k]).map((k) => ({ k: k as typeof k | 'x', w: C[k]! })), ...(C.other ?? []).map((w) => ({ k: 'x' as const, w }))].sort((a, b) => a.w.x0 - b.w.x0);
    return { right, descEnd: right.length ? right[0].w.x0 - 3 : Infinity, itemEnd: C.item ? C.item.x1 + Math.max(6, (C.item.x1 - C.item.x0) * 0.6) : C.desc!.x0 - 2 };
  };
  const NUMW = /^[-+]?[\d,]*\.?\d+%?$/;
  const headish = (w: Word) => HEAD.some(([, re]) => re.test(w.s.replace(/[:]$/, ''))) || /^\(?(aed|usd|dhs?|qar|sar|omr|egp|kwd|bhd|nr\.?|no\.?|%)\)?$/i.test(w.s);
  let lastTop = true;
  /** where the headings and descriptions start (the item column ends short of it) */
  let textX = Infinity;
  const startBill = (bl: Word[], title: string) => {
    const m = BILL_LINE.exec(text(bl))!, k = (m[1] || m[2]).toLowerCase().replace(/^0+(?=\d)/, '');
    if (k === billKey) return;
    flush(); billKey = k;
    const t = title.replace(/\s+/g, ' ').trim().slice(0, 60) || text(bl).slice(0, 60);
    let nm = t, n = 2;
    while (taken.has(nm.toLowerCase())) nm = `${t} (${n++})`;
    taken.add(nm.toLowerCase()); sheetName = nm;
  };
  for (let p = 0; p < pageCount; p++) {
    const ls = all[p];
    // the header line: Description + Qty or Unit; a header of another table (Description and Total,
    // no Qty / Unit) is a summary or a collection - no items on it
    let hl = -1, other = false;
    for (let i = 0; i < ls.length && hl < 0; i++) {
      const c: Cols = {};
      for (const w of ls[i]) for (const [k, re] of HEAD) if (re.test(w.s.replace(/[:]$/, '')) && !c[k]) c[k] = w;
      // ("ITEM DESCRIPTION" as one heading, centred over the description: its "ITEM" is no item
      //  column - that is the "ITEM / NO." on the lines above and under it)
      if (c.item && c.desc && /^items?$/i.test(c.item.s) && c.item.x1 <= c.desc.x0 && c.desc.x0 - c.item.x1 < Math.max(4, (c.item.y1 - c.item.y0) * 0.9)) delete c.item;
      if (c.desc && (c.qty || c.unit)) {
        // (a column of the header line the BOQ does not need - "Remarks" right of the quantity: what
        //  is under it is left out, as in a workbook; "(AED)" beside "Rate" is part of its heading)
        const known = [c.item, c.desc, c.qty, c.unit, c.rate, c.amount].filter(Boolean) as Word[];
        c.other = ls[i].filter((w) => !known.includes(w) && w.x0 > Math.max(...[c.qty, c.unit].filter(Boolean).map((k) => k!.x0)) && /^[A-Za-z]{3,}/.test(w.s) && known.every((k) => w.x0 - k.x1 > 15 || k.x0 - w.x1 > 15));
        cols = c; hl = i;
      } else if (c.desc && (c.amount || c.rate || /\bpage\s+no\b/i.test(text(ls[i])))) other = true; // (a bill's summary: "Description ... Page No. ... Amount")
    }
    // (a heading wrapped over two lines - "AMOUNT" above the header line, "(AED)" under it: Excel
    //  prints a cell's text to the bottom - its words join the header; a line of nothing but such
    //  words under it is no item)
    let below = 0;
    if (hl >= 0 && cols) {
      const top = (l: Word[]) => Math.min(...l.map((w) => w.y0)), bot = (l: Word[]) => Math.max(...l.map((w) => w.y1));
      const lh = bot(ls[hl]) - top(ls[hl]);
      const near = [hl - 1, hl + 1].filter((j) => ls[j] && (j < hl ? top(ls[hl]) - bot(ls[j]) : top(ls[j]) - bot(ls[hl])) <= lh * 1.5 && ls[j].every(headish));
      // ("Unit" over "Rate" in one cell is the rate's heading, not a Unit column)
      const pool = [hl, ...near].flatMap((j) => ls[j]);
      const stackedUnit = (w: Word) => /^unit$/i.test(w.s) && pool.some((v) => /^rate$/i.test(v.s) && v.x0 < w.x1 && w.x0 < v.x1 && v !== w);
      if (cols.unit && stackedUnit(cols.unit)) delete cols.unit;
      for (const j of near) {
        for (const w of ls[j]) for (const [k, re] of HEAD) if (re.test(w.s.replace(/[:]$/, '')) && !cols[k] && !(k === 'unit' && stackedUnit(w))) cols[k] = w;
        if (j > hl) below = 1;
      }
      if (!cols.qty && !cols.unit) { cols = null; hl = -1; }
    }
    const bl = ls.slice(0, hl < 0 ? ls.length : hl).find((l) => BILL_LINE.test(text(l)));
    if (hl < 0) {
      if (!cols) continue;
      // (a page without a header line carries on with the columns of the page before - unless it is
      //  a page of another kind: a summary, or a bill's cover - "BILL NO 1 / GENERAL REQUIREMENTS",
      //  a few lines and no quantity; the pages after it hold items again under a header line)
      const W = where(cols);
      const qtyR = cols.qty ? cols.qty.x1 : Infinity;
      const body = ls.filter((l) => !furniture(l, p, qtyR));
      // (a page with nothing on it - a scan OCR could not read - is no cover: the pages after it
      //  carry on)
      if (!body.length) continue;
      const hasQty = body.some((l) => !BILL_LINE.test(text(l)) && l.some((w) => NUMW.test(w.s) && Math.abs(w.x1 - qtyR) < 30 && w.x0 > W.descEnd - 40));
      if (other || (!hasQty && body.length <= 6 && (bl || body.every((l) => !/[a-z]/.test(text(l)))))) {
        // (a bill's cover starts its sheet: "BILL NO 20 / VERTICAL TRANSPORTATION")
        if (bl && !other) startBill(bl, body.slice(body.indexOf(bl), body.indexOf(bl) + 2).map(text).join(' '));
        cols = null; continue;
      }
    } else {
      // (or the bill's title just under the header line - "BILL NO. 3 - TOWER 01, (CONT'D.)" on every page of it)
      const under = bl ? null : ls.slice(hl + 1 + below, hl + 4 + below).find((l) => BILL_LINE.test(text(l)));
      const b = bl ?? under;
      if (b) startBill(b, b.filter((w) => w.x1 <= where(cols!).descEnd).map((w) => w.s).join(' ').replace(CONTD_LINE, ''));
    }
    rows.push({ r: r++, hidden: false, c: ['Item', 'Description', 'Qty', 'Unit', 'Rate', 'Amount'], pg: p });
    const C: Cols = cols!;
    const { right, descEnd } = where(C);
    let { itemEnd } = where(C);
    // (the item column ends where the headings and descriptions start, if that is short of the
    //  heading's own margin: "3" of "3mm thick protection board" is no item number)
    {
      const xs = ls.slice(hl + 1 + below).map((l) => l[0]).filter((w) => w && (/^[A-Za-z][a-z]{3,}/.test(w.s) || /^[A-Z]{4,}/.test(w.s))).map((w) => w.x0).sort((a, b) => a - b);
      // (a page with few such lines: as the page before - the same columns)
      const med = xs.length >= 2 ? xs[xs.length >> 1] : hl < 0 ? textX : Infinity;
      if (xs.length >= 2 || hl >= 0) textX = med;
      if (C.item && med > C.item.x0 + 4 && med < itemEnd) itemEnd = med - 1;
    }
    // the lines with their cells
    // (cx: each cell's left and right on the page - the side-by-side view marks a changed cell on the PDF)
    const L: { cells: (string | null)[]; cx: number[]; x0: number; x1: number; y0: number; y1: number; h: number; furn: boolean; dx: number }[] = [];
    for (let i = hl + 1 + below; i < ls.length; i++) {
      const l = ls[i];
      const cells: (string | null)[] = [null, null, null, null, null, null];
      const cx: number[] = [];
      for (let k = 0; k < 6; k++) cx.push(Infinity, -Infinity);
      let dx = Infinity;
      let w: Word;
      const put = (k: number, s: string) => { cells[k] = cells[k] ? cells[k] + ' ' + s : s; cx[2 * k] = Math.min(cx[2 * k], w.x0); cx[2 * k + 1] = Math.max(cx[2 * k + 1], w.x1); };
      for (w of l) {
        const cx = (w.x0 + w.x1) / 2;
        // (a number set right under a narrow "Qty" heading starts left of it: read by its right edge)
        const numeric = NUMW.test(w.s);
        if (w.x1 <= itemEnd && cx < itemEnd) put(0, w.s);
        else if (cx < descEnd && !(numeric && w.x1 > descEnd)) { if (!cells[1]) dx = w.x0; put(1, w.s); }
        else if (!numeric && !C.unit && knownUnit(w.s)) put(3, w.s); // (a unit with no Unit column of its own: "m3" beside the quantity)
        else {
          // (the number column whose heading is nearest - numbers by their right edge, words by their middle)
          let best = right[0], bd = Infinity;
          // (a word is never a quantity: "Refer to plan" beside it is in the next column)
          for (const c of right) { if (!numeric && c.k === 'qty' && right.length > 1) continue; const d = numeric ? Math.abs(w.x1 - c.w.x1) : Math.abs(cx - (c.w.x0 + c.w.x1) / 2); if (d < bd) { bd = d; best = c; } }
          if (best.k !== 'x') put(({ qty: 2, unit: 3, rate: 4, amount: 5 } as const)[best.k], w.s);
        }
      }
      // (a heading set from the page's left edge - "IDENTITY SIGN TYPES" - starts in the item column:
      //  a word with no figure in it is no item number)
      // (nor a word in small letters - "of" of a sentence wrapped to the margin)
      if (cells[0] && !/\d/.test(cells[0]) && (cells[0].replace(/[^A-Za-z]/g, '').length > 3 || /^[a-z]+[.,;:]?$/.test(cells[0]))) { cells[1] = cells[1] ? cells[0] + ' ' + cells[1] : cells[0]; cells[0] = null; cx[2] = Math.min(cx[0], cx[2]); cx[3] = Math.max(cx[1], cx[3]); cx[0] = Infinity; cx[1] = -Infinity; }
      // (a title in capitals set wide - "SITE WORKS", "BILL NO 13 - FOH FINISHES TOTAL CARRIED TO
      //  SUMMARY" - runs into the number columns: no number there and no unit, it is one line of text)
      const spill = [2, 3, 4, 5].some((k) => cells[k]) && [2, 3, 4, 5].every((k) => !cells[k] || !cells[k]!.split(' ').some((x) => NUMW.test(x)))
        && !(cells[3] && knownUnit(cells[3])) && !/[a-z]/.test(text(l));
      const x0 = Math.min(...l.map((w) => w.x0)), x1 = Math.max(...l.map((w) => w.x1));
      if (spill) { cells.fill(null); cells[1] = text(l); for (let k = 0; k < 12; k += 2) { cx[k] = Infinity; cx[k + 1] = -Infinity; } cx[2] = x0; cx[3] = x1; }
      const y0 = Math.min(...l.map((w) => w.y0)), y1 = Math.max(...l.map((w) => w.y1));
      L.push({ cells, cx, x0, x1, y0, y1, h: y1 - y0, furn: furniture(l, p, C.qty ? C.qty.x1 : Infinity), dx });
    }
    // blocks: lines set tight under each other (a description wrapped in its cell); items and
    // headings are apart (a blank line, a row's padding)
    let blocks: (typeof L)[] = [];
    for (const l of L) {
      const b = blocks[blocks.length - 1], last = b?.[b.length - 1];
      if (last && l.y0 - last.y1 < Math.max(l.h, last.h) * 0.6) b.push(l); else blocks.push([l]);
    }
    // (page furniture goes - but not a line wrapped in an item: "2200mm" under "Type D2.2; Single
    //  leaf hinged door of size 1000mm x ... 6 nr" is in the same place on many pages)
    //  - one set where the item's description lines start, not a page code centred under it: "B2/G/2/5")
    blocks = blocks.map((b) => {
      if (!b.some((l) => !l.furn && [2, 3, 4, 5].some((k) => l.cells[k]))) return b.filter((l) => !l.furn);
      const xs = b.filter((l) => !l.furn && l.dx < Infinity).map((l) => l.dx);
      return b.filter((l) => !l.furn || xs.some((x) => Math.abs(x - l.dx) < 8));
    }).filter((b) => b.length);
    const numbered = (l: (typeof L)[0]) => !!(l.cells[0] || l.cells[2] || l.cells[3] || l.cells[4] || l.cells[5]);
    const caps = (t: string | null) => !!t && /^[^a-z]*[A-Z]{3}[^a-z]*$/.test(t);
    // where the quantity sits in a wrapped item on this page: on its first line or its last (Excel
    // printed with the cell's text set to the top or the bottom) - from the blocks with one item
    let top = 0, bottom = 0;
    for (const b of blocks) { const k = b.map(numbered); if (b.length > 1 && k.filter(Boolean).length === 1) { if (k[0]) top++; else if (k[k.length - 1]) bottom++; } }
    // (a page with no block to tell by: as the page before)
    const atTop: boolean = top > bottom ? true : bottom > top ? false : lastTop;
    lastTop = atTop;
    // (a BOQ written all in capitals: its wrapped description lines are no headings)
    const itemLines = L.filter((l) => numbered(l) && l.cells[1]);
    const allCaps = itemLines.length >= 3 && itemLines.filter((l) => caps(l.cells[1])).length >= itemLines.length * 0.5;
    const fromScan = !!ocrPages?.has(p);
    // a row out of its lines: the cells, and where it is on the page (the box round its lines, each cell's left / right)
    const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : NaN);
    const emit = (ls2: typeof L) => {
      const c: (string | null)[] = [null, null, null, null, null, null];
      for (const l of ls2) l.cells.forEach((v, k) => { if (v) c[k] = k === 1 && c[1] ? c[1] + ' ' + v : c[k] ?? v; });
      const cx: number[] = [];
      for (let k = 0; k < 12; k += 2) cx.push(r1(Math.min(...ls2.map((l) => l.cx[k]))), r1(Math.max(...ls2.map((l) => l.cx[k + 1]))));
      const bx = [r1(Math.min(...ls2.map((l) => l.x0))), r1(Math.min(...ls2.map((l) => l.y0))), r1(Math.max(...ls2.map((l) => l.x1))), r1(Math.max(...ls2.map((l) => l.y1))), ...cx];
      rows.push({ r: r++, hidden: false, c: c.map((v, k) => (v === null ? null : k >= 2 && k !== 3 ? numOr(v) : v)), pg: p, bx, ...(fromScan ? { ocr: true } : {}) });
    };
    for (const b of blocks) {
      // (a heading in capitals stays a line of its own - it is the section the items are read under)
      const parts: (typeof L)[] = [];
      let cur: typeof L = [];
      for (const l of b) { if (!allCaps && caps(l.cells[1]) && !numbered(l)) { if (cur.length) parts.push(cur); parts.push([l]); cur = []; } else cur.push(l); }
      if (cur.length) parts.push(cur);
      for (const part of parts) {
        const idx = part.map((l, i) => (numbered(l) ? i : -1)).filter((i) => i >= 0);
        // (one item's cells set at different heights - its number and unit on the first line, the
        //  quantity centred on the next: a line without a number filling cells the line before left
        //  empty is the same item)
        const groups: { a: number; z: number; has: Set<number>; desc: boolean }[] = [];
        for (const k of idx) {
          const g = groups[groups.length - 1], l = part[k], n = [0, 2, 3, 4, 5].filter((x) => l.cells[x]);
          // (or the item number alone, centred: "D" between "Type P-05; ... 876 m2" and "surface; to pool")
          //  - or its number set low, beside the last line of its description: "Type H1A ... 90min" /
          //  "no. 21" / "B  fire rated" - a number alone and words, after a quantity with no number, is
          //  the same item)
          if (g && n.every((x) => !g.has.has(x)) && (!(l.cells[0] && l.cells[1]) || (n.length === 1 && n[0] === 0 && !g.has.has(0)))) { g.z = k; n.forEach((x) => g.has.add(x)); g.desc ||= !!l.cells[1]; continue; }
          groups.push({ a: k, z: k, has: new Set(n), desc: !!l.cells[1] });
        }
        if (groups.length <= 1) { emit(part); continue; }
        if (groups.every((g) => !g.desc)) {
          // (the numbers of each item centred on its description - "R  1  m2" between "ST-05; Quartz
          //  stone, ... 20mm" and "thickness": every line goes with the nearest)
          const mid = groups.map((g) => (part[g.a].y0 + part[g.z].y1) / 2);
          const own: (typeof L)[] = groups.map(() => []);
          part.forEach((l, i) => { const c = (l.y0 + l.y1) / 2; let j = 0; for (let x = 1; x < mid.length; x++) if (Math.abs(mid[x] - c) < Math.abs(mid[j] - c)) j = x; const g = groups.findIndex((g) => i >= g.a && i <= g.z); own[g >= 0 ? g : j].push(l); });
          own.forEach((ls2) => emit(ls2));
          continue;
        }
        // several items in one block: each takes the description lines on its side
        if (atTop) groups.forEach((g, j) => emit(part.slice(j === 0 ? 0 : g.a, j + 1 < groups.length ? groups[j + 1].a : part.length)));
        else groups.forEach((g, j) => emit(part.slice(j === 0 ? 0 : groups[j - 1].z + 1, j + 1 < groups.length ? g.z + 1 : part.length)));
      }
    }
  }
  flush();
  return { sheets: sheets.length ? sheets : [{ name, hidden: false, rows: [], hiddenCols: [] }] };
}

/** a bill's title line over the header: "Bill No 10 - Wooden Doors", "BILL NO. 3" (its number kept) */
const BILL_LINE = /^(?:bill\s*(?:no\.?|nr\.?|number)?\s*[:.-]?\s*(\d+[a-z]?|[a-z]\d*)\b|b(\d{1,2})\s*[-–]\s)/i;

const CONTD_LINE = /[,;:\s-]*\(?\b(cont['*\u2019]?d|continued|cont(?=\.))\.?\)?\.?\s*$/i;
/** a page's own reference, as a footer: "Sec J/Page 10/R3" (a page re-issued: /R4 on it alone), "P/23", "Page 4 of 9" */
const PAGE_LINE = /^(?:sec(?:tion)?\.?\s*[a-z0-9]{1,4}\s*\/\s*page\s*\d+(?:\s*[-\u2013]\s*\d+)?(?:\s*\/\s*r(?:ev)?\.?\s*\d+)?|p\s*\/\s*\d+|page\s*\d+(?:\s*of\s*\d+)?)$/i;
const numOr = (s: string): Val => (/^-?[\d,]*\.?\d+$/.test(s.replace(/\s/g, '')) ? Number(s.replace(/[\s,]/g, '')) : s);
