// T8: figures and "the same change x N". Pure, shared by Documents (docs.ts), BOQ (boq.ts) and the tests.
//
// A figure change is a changed word pair (the words taken out and put in, paired in order inside one
// stretch of changed words) where either side holds a digit, or is a unit, a grade, a standard or a finish
// code. The lists of those codes are FIG_CODES - one constant, used by the engine and the test.
// The same change x N (DECISIONS 25): the exact words taken out and put in, as one key; 3 or more entries
// with the key are one group.

/** what counts as a figure besides a digit: units (alone, or as "kg/m3", "N/mm2"), grade words and codes,
 *  standards bodies, finish codes. Lower case; matched after the strict word rule (ends stripped). */
export const FIG_CODES = {
  /** units written alone (a single letter is a unit only inside a compound: "m/s", "N/mm2") */
  units: ['mm', 'cm', 'km', 'm2', 'm3', 'm²', 'm³', 'sqm', 'sq.m', 'cum', 'lm', 'rm', 'kg', 'kgs', 'gm', 'mg', 'kn', 'knm', 'mpa', 'gpa', 'kpa', 'pa', 'bar', 'psi', 'ml', 'lps', 'cfm', 'kw', 'kva', 'mva', 'mw', 'kv', 'ka', 'hz', 'db', 'dba', 'lux', 'lumen', 'lumens', '°c', '°f', '°', '%', 'hr', 'hrs', 'nr', 'nos', 'pcs', 'ltr', 'ltrs', 'litre', 'litres', 'ton', 'tons', 'tonne', 'tonnes', 'ft', 'inch', 'inches', 'mins', 'secs', 'aed', 'usd', 'eur', 'gbp', 'sar', 'dhs', 'dh', 'gpm', 'btu', 'ppm', 'rpm', 'awg', 'kcmil', 'm/s', 'l/s', 'm/h', 'l/h', 'l/min'],
  /** the single letters, units only inside a compound ("m/s", "kg/m", "W/m2K", "N/mm2") */
  single: ['m', 'l', 't', 'g', 'a', 'v', 'w', 'n', 'h', 'k', 'c', 's', 'j'],
  /** a grade / class word: it and the short code after it ("Grade A" -> "Grade B") are figures */
  grades: ['grade', 'grades', 'class', 'series', 'rating', 'gauge', 'schedule', 'sch', 'ral', 'ncs', 'pantone'],
  /** standards bodies and their marks */
  standards: ['astm', 'aashto', 'bs', 'en', 'iso', 'din', 'ansi', 'aci', 'aisc', 'aws', 'nfpa', 'ul', 'iec', 'ieee', 'sasa', 'saso', 'esma', 'asme', 'ashrae', 'smacna', 'cibse', 'nema', 'ecs', 'fm', 'ce', 'jis', 'gost', 'tema', 'api', 'awwa', 'asce', 'ibc', 'ipc', 'dm', 'kahramaa', 'dewa', 'dcd'],
  /** finish codes (what is put on the surface) */
  finishes: ['matt', 'matte', 'satin', 'gloss', 'semi-gloss', 'eggshell', 'brushed', 'polished', 'honed', 'anodised', 'anodized', 'galvanised', 'galvanized', 'chrome', 'powder-coated', 'textured', 'sandblasted', 'epoxy', 'pvdf', 'ptfe'],
} as const;

const SET = {
  units: new Set<string>(FIG_CODES.units), single: new Set<string>(FIG_CODES.single), grades: new Set<string>(FIG_CODES.grades),
  standards: new Set<string>(FIG_CODES.standards), finishes: new Set<string>(FIG_CODES.finishes),
};
/** a word as the lists know it: lower case, punctuation at its ends off */
const plain = (w: string) => w.toLowerCase().replace(/^[([{"'“‘]+|[)\]}"'”’,;:!?]+$/g, '').replace(/\.$/, '');

/** is it a unit: alone ("kg"), or compound ("kg/m3", "N/mm2": every part a unit, a single letter allowed inside) */
export function isUnit(w: string): boolean {
  const p = plain(w);
  if (!p) return false;
  if (SET.units.has(p)) return true;
  if (!p.includes('/') && !p.includes('·')) return false;
  // (every part a unit, a single letter allowed; at least one strong - "m3/h", "kg/m", "N/mm2" - so "n/a" and "a/c" are not)
  const parts = p.split(/[/·]/).filter(Boolean);
  if (parts.length < 2) return false;
  let strong = false;
  for (const x of parts) {
    const b = x.replace(/\d+$/, '');
    if (!SET.units.has(b) && !SET.units.has(x) && !SET.single.has(b)) return false;
    if (b.length > 1 || b !== x) strong = true;
  }
  return strong;
}
/** a grade, standard or finish word */
export function isCode(w: string): boolean {
  const p = plain(w);
  return SET.grades.has(p) || SET.standards.has(p) || SET.finishes.has(p);
}
/** a changed word that counts as a figure: holds a digit, or is a unit, grade, standard or finish code */
export function isFigWord(w: string): boolean {
  return /\d/.test(w) || isUnit(w) || isCode(w) || NUMBER_WORDS.has(plain(w));
}
/** numbers written as words ("two coats" -> "three coats" is a figure change; Engineer A9) */
export const NUMBER_WORDS = new Set(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'fifteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'hundred', 'thousand', 'half', 'quarter', 'single', 'double', 'triple', 'once', 'twice']);

/** one stretch of changed words between two unchanged stretches: the words taken out, the words put in,
 *  the unchanged word before it and after it - where its unit ("41 kg/m3") or its grade word ("Grade A") is */
export interface Hunk { o: string[]; n: string[]; prev?: string; next?: string; /** a table row's cell it is in (T6) */ cell?: number }
/** the changed stretches of a word diff (`d`: wordDiff's ops); words that are only punctuation (`keep` says no) are not words */
export function hunksOf(d: { op: '=' | '-' | '+'; t: string }[], keep: (w: string) => boolean): Hunk[] {
  const out: Hunk[] = [];
  const words = (t: string) => t.split(/\s+/).filter(Boolean);
  let cur: Hunk | null = null;
  let prevWord = '';
  for (const x of d) {
    if (x.op === '=') {
      const ws = words(x.t);
      if (cur) { cur.next = ws[0]; out.push(cur); cur = null; }
      prevWord = ws[ws.length - 1] ?? prevWord;
      continue;
    }
    if (!cur) cur = { o: [], n: [], ...(prevWord ? { prev: prevWord } : {}) };
    for (const w of words(x.t)) if (keep(w)) (x.op === '-' ? cur.o : cur.n).push(w);
  }
  if (cur) out.push(cur);
  return out.filter((h) => h.o.length || h.n.length);
}

/** one figure changed: the word out, the word in (either may be empty), the unit beside it */
export interface Fig { o: string; n: string; unit?: string }
const trim = (w: string) => w.replace(/[,;:]+$/, '').replace(/(?<=\D)\.$|(?<=\d)\.$/, '');
/** the figures of changed stretches: the words paired in order inside a stretch; a pair is a figure when
 *  either word is one. The unit: the unchanged word beside the stretch when it is a unit and neither word is. */
export function figsOf(hunks: Hunk[]): Fig[] {
  const out: Fig[] = [];
  for (const h of hunks) {
    // (a short code after a grade word: "Grade A" -> "Grade B")
    const code = (w: string, at: number) => at === 0 && !!w && !!h.prev && SET.grades.has(plain(h.prev)) && /^[A-Za-z]\d{0,2}$/.test(trim(w));
    // (figure words paired with figure words, in order: "not 25" -> "30" is 25 -> 30, not "not" -> 30; Engineer A13)
    const fo = h.o.filter((w, i) => isFigWord(w) || code(w, i)), fn = h.n.filter((w, i) => isFigWord(w) || code(w, i));
    const k = Math.max(fo.length, fn.length);
    for (let i = 0; i < k; i++) {
      const o = fo[i] ?? '', n = fn[i] ?? '';
      const f: Fig = { o: trim(o), n: trim(n) };
      if (!isUnit(o) && !isUnit(n)) { const u = [h.next, h.prev].find((x) => x && isUnit(x)); if (u) f.unit = trim(u); }
      out.push(f);
    }
  }
  return out;
}
/** the key of a change: the exact words taken out and put in (`fold`: the strict word rule), as the set of
 *  distinct stretches - "Elevator Contractor" put in twice in one paragraph is the same change as put in once */
export function repKey(hunks: Hunk[], fold: (w: string) => string): string {
  // (a figure, or one word a side, means nothing alone: "25 -> 30" in a cover, a curing time and a count of spare
  //  lamps is three different changes - its words beside it are part of the key, and a table cell's column; Engineer A1)
  const one = (h: Hunk) => {
    let k = h.o.map(fold).join(' ') + '\u0001' + h.n.map(fold).join(' ');
    if ([...h.o, ...h.n].some(isFigWord) || (h.o.length <= 1 && h.n.length <= 1)) k += '\u0003' + fold(h.prev ?? '') + ' ' + fold(h.next ?? '');
    if (h.cell !== undefined) k += '\u0004' + h.cell;
    return k;
  };
  return [...new Set(hunks.map(one))].sort().join('\u0002');
}
/** groups of the same key: `keys[i]` the key of item i ('' none); a key shared by `min` or more items is a
 *  group, numbered in order of first appearance. One pass (a Map), no pairwise comparing. Returns the group
 *  of each item (-1 none) and each group's size. */
export function groupKeys(keys: string[], min = 3): { rep: number[]; size: number[] } {
  const count = new Map<string, number>();
  for (const k of keys) if (k) count.set(k, (count.get(k) ?? 0) + 1);
  const id = new Map<string, number>(), size: number[] = [];
  const rep = keys.map((k) => {
    if (!k || (count.get(k) ?? 0) < min) return -1;
    let g = id.get(k);
    if (g === undefined) { g = size.length; id.set(k, g); size.push(count.get(k)!); }
    return g;
  });
  return { rep, size };
}
