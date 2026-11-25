// Numbers typed as text in a BOQ's quantity / rate / amount cells (0.6.1 T39, DECISIONS 141; DeepSeek 7, 8).
// One parser for workbooks (boq.ts) and PDFs (pdftable.ts). The style - dot or comma decimals - is decided per file
// (a workbook sheet; a PDF file) by evidence: comma decimals only when the file shows them and shows no dot decimal;
// otherwise exactly 0.6.0's reading ("1.234" = 1.234, "1,234" = 1234, "12,50" text).
import type { Val } from './sheets';

export type NumStyle = 'dot' | 'comma';

// (spaces as 0.6.0's boq.ts read them: any run of white space - NBSP and narrow NBSP included - is one space; T47 sweep B1)
const sp = (t: string) => t.replace(/\s+/g, ' ').trim();

// (evidence: a token that can only be read one way)
const COMMA_EV = [/^-?\d{1,3}(\.\d{3})+,\d+$/, /^-?\d{1,3}(\.\d{3}){2,}$/, /^-?\d+,(\d{1,2}|\d{4,})$/, /^-?0,\d+$/, /^-?\d{4,},\d+$/, /^-?\d{1,3}( \d{3})+,\d+$/];
const DOT_EV = [/^-?\d{1,3}(,\d{3})+\.\d+$/, /^-?\d{1,3}(,\d{3}){2,}$/, /^-?\d+\.(\d{1,2}|\d{4,})$/, /^-?0\.\d+$/, /^-?\d{4,}\.\d+$/, /^-?\d{1,3}( \d{3})+\.\d+$/, /^-?\.\d+$/];

/** what a token says about the file's style: 'comma', 'dot', or null (an integer, an ambiguous "1.234" / "1,234", text) */
export function evidence(v: Val | undefined): NumStyle | null {
  if (typeof v !== 'string') return null;
  const t = sp(v);
  if (COMMA_EV.some((r) => r.test(t))) return 'comma';
  if (DOT_EV.some((r) => r.test(t))) return 'dot';
  return null;
}

/** a file's style from its number cells: comma only with comma evidence and no dot evidence */
export function styleOf(cells: Iterable<Val | undefined>): NumStyle {
  let comma = false;
  for (const v of cells) { const e = evidence(v); if (e === 'dot') return 'dot'; if (e === 'comma') comma = true; }
  return comma ? 'comma' : 'dot';
}

/** a number cell - also one typed as text - in the file's style; else null (it stays text) */
export function readNum(v: Val | undefined, style: NumStyle = 'dot'): number | null {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const t = sp(v);
  // (both separators: read by its own last one, in either style - "1.234,56", "1,234.56")
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
  if (/^-?\d{1,3}(,\d{3})+\.\d+$/.test(t)) return Number(t.replace(/,/g, ''));
  // (0.6.0's reading, word for word: "1,447", "2 238.50", "-3", ".5")
  if (style === 'dot') return /^-?\d{1,3}([, ]\d{3})+(\.\d+)?$|^-?\d*\.?\d+$/.test(t) ? Number(t.replace(/[, ]/g, '')) : null;
  // (its mirror: "1.447", "2 238,50", "12,50")
  return /^-?\d{1,3}([. ]\d{3})+(,\d+)?$|^-?\d*,?\d+$/.test(t) ? Number(t.replace(/[. ]/g, '').replace(',', '.')) : null;
}
