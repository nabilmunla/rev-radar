// Which sheet of the new issue is which sheet of the old one.
//  1. file names: the drawing number in the name (revision marks such as "Rev B", "_C02",
//     "(1)" ignored) - the usual case: one PDF per sheet;
//  2. what the sheets say: for combined PDFs (a whole issue in one file) and names that don't
//     match, pages are paired by their words (rare words such as the drawing number weigh
//     most, words every sheet has - the title block - weigh nothing);
//  3. left over: new sheets / removed sheets. Every pair can be changed by hand.

export interface SheetRef {
  file: string;
  /** path relative to the chosen folder (or file name) */
  rel: string;
  page: number;
  pages: number;
  size: number;
  mtime: number;
  /** page size in points (as shown) */
  w: number; h: number;
  label?: string;
  /** the file could not be read (damaged, password): still listed, as a problem */
  bad?: string;
  /** the sheet number and title read off the sheet's title block (T11; pages of combined PDFs and
   *  renamed files) - how it is listed */
  read?: { no: string; title: string };
}

export interface PairPlan { old: SheetRef | null; neu: SheetRef | null; how: 'name' | 'number' | 'sheet' | 'content' | 'order' | 'hand' | 'none'; score?: number }

const stripExt = (s: string) => s.replace(/\.pdf$/i, '');
const baseName = (p: string) => stripExt(p.split(/[\\/]/).pop() || p);

/**
 * Revision marks at the end of a name: "Rev B", "REV.03", "_R2", "(1)", "- Copy". Each needs a
 * separator in front, and a bare R needs digits ("Tower A", "Floor 2", "Interior" stay whole).
 */
const REV_TAIL = /([\s_\-.(]+(rev(ision)?[\s_\-.]*[a-z]?\d{0,3}[a-z]?|r\d{1,3}[a-z]?)\)?)$|([\s_-]*\(\d+\))$|([\s_-]*-?\s*copy)$/i;

export function normName(name: string): string {
  let s = stripExt(name).toUpperCase().trim();
  for (let k = 0; k < 3; k++) {
    const m = REV_TAIL.exec(s);
    const t = s.replace(REV_TAIL, '').trim();
    // (a bare "R1" with no other number in the name is the sheet's own code - a roof level - not
    //  a revision: "PRJ-AR-GA-R1" and "-R2" are two sheets)
    if (t === s || t.length < 3 || (m && /^[\s_\-.(]+R\d/i.test(m[0]) && !/\d/.test(t))) break;
    s = t;
  }
  return s.replace(/[\s_\-.,()[\]]+/g, ' ').trim();
}

/**
 * The drawing number in a name: the longest run of parts joined by - _ . that ends with a
 * part holding digits ("F109-ARG-DWG-AR-10140 - GA L04" -> "F109-ARG-DWG-AR-10140").
 */
const DATE_RUN = /^(\d{4}[-_.]\d{1,2}[-_.]\d{1,2}|\d{1,2}[-_.]\d{1,2}[-_.]\d{2,4})$/;
export function drawingNo(name: string, asWritten = false): string {
  const raw = stripExt(name), s = raw.toUpperCase();
  let best = '', bestRaw = '';
  for (const m of s.matchAll(/[A-Z0-9]+(?:[-_.][A-Z0-9]+)+/g)) {
    const r = m[0];
    if (DATE_RUN.test(r)) continue; // an issue date in the name is not the sheet's number
    let parts = r.split(/[-_.]/), skip = 0;
    // (an issue date in front, "20261001_A-101": not part of the number)
    if (parts.length > 2 && /^(19|20)\d\d(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(parts[0]) && parts.slice(1).some((q) => /\d/.test(q))) { skip = parts[0].length + 1; parts = parts.slice(1); }
    let end = -1;
    for (let i = parts.length - 1; i >= 0; i--) if (/\d/.test(parts[i]) && !/^(REV|R)\d*$/.test(parts[i])) { end = i; break; }
    if (end < 0) continue;
    const key = parts.slice(0, end + 1).join('-');
    if (key.replace(/-/g, '').length > best.replace(/-/g, '').length) {
      best = key;
      // (as written: "F111.1-AE7-DWG-AR-100101", not the "F111-1-..." the pairing compares)
      const len = parts.slice(0, end + 1).reduce((t, q) => t + q.length, 0) + end;
      bestRaw = raw.length === s.length ? raw.substr(m.index! + skip, len) : key;
    }
  }
  // (no run: a short code - "A101" anywhere, "AR 101" only at the start: "PART 01", "LEVEL 02",
  //  "SECTION 10" are counters, not sheet numbers)
  if (!best) { const m = s.match(/^[A-Z]{1,4}\s?\d{2,5}[A-Z]?\b/) || s.match(/\b[A-Z]{1,4}\d{2,5}[A-Z]?\b/); best = bestRaw = m ? m[0].replace(/\s/g, '') : ''; }
  return asWritten ? bestRaw : best;
}

/**
 * The drawing number without last parts that are revision / status codes (P02, C03, T1, S2-P03,
 * "A101_C02"); level and zone codes stay (L01, B2, R1, GF are different sheets).
 */
const REV_CODE = /^(P|C|T|D|S|IFC|IFT|IFA|REV)\d{1,2}[A-Z]?$/;
export function drawingNoBare(key: string): string {
  const parts = key.split('-');
  let n = parts.length;
  for (let k = 0; k < 2 && n >= 2 && REV_CODE.test(parts[n - 1]) && parts.slice(0, n - 1).some((p) => /\d/.test(p)); k++) n--;
  return parts.slice(0, n).join('-');
}

/** the drawing number with leading zeros dropped ("AR-0101" / "AR-101", "GA-L01" / "GA-L1") */
export function noZeros(key: string): string {
  return key ? key.split('-').map((p) => p.replace(/^([A-Z]*)0+(?=\d)/, '$1')).join('-') : '';
}

/** a name that is the sheet number alone - "100101", "100101_C02", "100101 Rev B" - as a number */
export function bareNumber(name: string): string {
  const d = drawingNoBare(drawingNo(name));
  if (d && /^\d{3,}$/.test(d)) return String(+d);
  const s = normName(name);
  return /^\d{3,}$/.test(s) ? String(+s) : '';
}

/** the sheet's own number at the end of a full drawing number: "F111.1-AE7-DWG-AR-100101" -> 100101 */
export function numberTail(name: string): string {
  const d = drawingNoBare(drawingNo(name));
  if (!d || !/[A-Z]/.test(d) || !d.includes('-')) return '';
  const last = d.split('-').pop() || '';
  return /^\d{3,}$/.test(last) ? String(+last) : '';
}

/**
 * One issue names a sheet by its number alone ("100101.pdf"), the other in full
 * ("F111.1-AE7-DWG-AR-100101.pdf"): paired by that number - only where one of the two IS the bare
 * number (two full numbers that merely end alike - PRJ-AR-GA-01001 / PRJ-ST-GA-01001 - are different
 * drawings) and the number is unique in both issues (AR-100101 next to ID-100101 pairs neither).
 */
function byBareNumber(olds: SheetRef[], news: SheetRef[], allO: SheetRef[], allN: SheetRef[], out: PairPlan[]) {
  const num = (s: SheetRef) => { const b = bareNumber(baseName(s.rel)); return b ? { k: b, bare: true } : { k: numberTail(baseName(s.rel)), bare: false }; };
  const tally = (list: SheetRef[]) => { const m = new Map<string, number>(); for (const x of list) { const { k } = num(x); if (k) m.set(k, (m.get(k) || 0) + 1); } return m; };
  const ta = tally(allO), tb = tally(allN);
  const usedO = new Set<SheetRef>(), usedN = new Set<SheetRef>();
  for (const o of olds) {
    const a = num(o);
    if (!a.k || ta.get(a.k) !== 1 || tb.get(a.k) !== 1) continue;
    const n = news.find((x) => !usedN.has(x) && num(x).k === a.k);
    if (!n || (!a.bare && !num(n).bare)) continue;
    out.push({ old: o, neu: n, how: 'number' }); usedO.add(o); usedN.add(n);
  }
  return { olds: olds.filter((s) => !usedO.has(s)), news: news.filter((s) => !usedN.has(s)) };
}

/**
 * One issue's number with a project prefix added in front ("GA-L04" / "F111.1-AE7-DWG-AR-GA-L04"):
 * paired where the short number (two parts or more, with a digit) is the end of exactly one number
 * in the other issue, at a "-", and nothing else there ends with it - both ways round. Two full
 * numbers that merely end alike (PRJ-AR-GA-01001 / PRJ-ST-GA-01001) are not one the end of the other.
 */
function byPrefixAdded(olds: SheetRef[], news: SheetRef[], allO: SheetRef[], allN: SheetRef[], out: PairPlan[]) {
  const key = (s: SheetRef) => noZeros(drawingNoBare(drawingNo(baseName(s.rel))));
  const ends = (long: string, short: string) => long.length > short.length && long.endsWith('-' + short);
  const ok = (k: string) => k.split('-').length >= 2 && /\d/.test(k);
  const kO = allO.map(key), kN = allN.map(key);
  const usedO = new Set<SheetRef>(), usedN = new Set<SheetRef>();
  for (const o of olds) {
    const a = key(o);
    if (!a) continue;
    // the other issue's sheets this one is the end of (or that are the end of this one)
    const hits = news.filter((n) => { const b = key(n); return !!b && !usedN.has(n) && ((ok(a) && ends(b, a)) || (ok(b) && ends(a, b))); });
    if (hits.length !== 1) continue;
    const b = key(hits[0]), short = a.length < b.length ? a : b, long = a.length < b.length ? b : a;
    // (unique: no other sheet in either issue ends with the short number or is it, or is the long one)
    const same = (list: string[], k: string) => list.filter((x) => x === k || ends(x, k)).length;
    if (same(kO, short) + same(kN, short) !== 2 || kO.filter((x) => x === long).length + kN.filter((x) => x === long).length !== 1) continue;
    out.push({ old: o, neu: hits[0], how: 'number' }); usedO.add(o); usedN.add(hits[0]);
  }
  return { olds: olds.filter((s) => !usedO.has(s)), news: news.filter((s) => !usedN.has(s)) };
}

/**
 * pair by one key function: only keys that are unique on both sides - in the whole issue (allO /
 * allN), not just among the sheets still unpaired: "GA-L01" and "GA-L02" would otherwise share a
 * short key the moment one of them has found its partner
 */
function byKey(olds: SheetRef[], news: SheetRef[], key: (s: SheetRef) => string, how: PairPlan['how'], out: PairPlan[], allO: SheetRef[] = olds, allN: SheetRef[] = news) {
  const tally = (list: SheetRef[]) => { const m = new Map<string, number>(); for (const x of list) { const k = key(x); if (k) m.set(k, (m.get(k) || 0) + 1); } return m; };
  const ta = tally(allO), tb = tally(allN);
  const count = (list: SheetRef[]) => { const m = new Map<string, SheetRef[]>(); for (const s of list) { const k = key(s); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k)!.push(s); } return m; };
  const a = count(olds), b = count(news);
  const usedO = new Set<SheetRef>(), usedN = new Set<SheetRef>();
  for (const [k, ol] of a) {
    const nl = b.get(k);
    if (!nl) continue;
    if (ol.length === 1 && nl.length === 1 && ta.get(k) === 1 && tb.get(k) === 1) { out.push({ old: ol[0], neu: nl[0], how }); usedO.add(ol[0]); usedN.add(nl[0]); }
    else {
      // the same name more than once (sub folders): only where the folder path matches too
      const dirOf = (s: SheetRef) => s.rel.split(/[\\/]/).slice(0, -1).join('/').toUpperCase();
      for (const o of ol) {
        const same = nl.filter((x) => !usedN.has(x) && dirOf(x) === dirOf(o));
        if (same.length === 1 && ol.filter((y) => dirOf(y) === dirOf(o)).length === 1) { out.push({ old: o, neu: same[0], how }); usedO.add(o); usedN.add(same[0]); }
      }
    }
  }
  return { olds: olds.filter((s) => !usedO.has(s)), news: news.filter((s) => !usedN.has(s)) };
}

/** pairs by name; what's left needs the sheets' words (multi-page files and odd names) */
export function pairByNames(olds: SheetRef[], news: SheetRef[]): { pairs: PairPlan[]; olds: SheetRef[]; news: SheetRef[] } {
  const pairs: PairPlan[] = [];
  const single = (s: SheetRef) => s.pages === 1;
  let o = olds.filter(single), n = news.filter(single);
  const allO = o, allN = n;
  ({ olds: o, news: n } = byKey(o, n, (s) => normName(baseName(s.rel)), 'name', pairs));
  ({ olds: o, news: n } = byKey(o, n, (s) => drawingNo(baseName(s.rel)), 'number', pairs, allO, allN));
  ({ olds: o, news: n } = byKey(o, n, (s) => drawingNoBare(drawingNo(baseName(s.rel))), 'number', pairs, allO, allN));
  ({ olds: o, news: n } = byKey(o, n, (s) => noZeros(drawingNoBare(drawingNo(baseName(s.rel)))), 'number', pairs, allO, allN));
  ({ olds: o, news: n } = byBareNumber(o, n, allO, allN, pairs));
  ({ olds: o, news: n } = byPrefixAdded(o, n, allO, allN, pairs));
  return { pairs, olds: [...o, ...olds.filter((s) => !single(s))], news: [...n, ...news.filter((s) => !single(s))] };
}

export interface Fingerprint { ref: SheetRef; words: string[] }

/**
 * Pair pages by their words (tf-idf cosine, greedy best first). Pages that share the rare
 * words - drawing number, title, room names - pair; the title block every sheet carries
 * cancels out.
 */
export function pairByContent(olds: Fingerprint[], news: Fingerprint[], minScore = 0.35, bySheet: [number, number, boolean?][] = []): { pairs: PairPlan[]; olds: SheetRef[]; news: SheetRef[] } {
  // single sheets whose file names carry different drawing numbers: typical floors read alike
  // (GA L04 / GA L09) - only a near copy is the same sheet renumbered
  const nameNo = (r: SheetRef) => (r.pages === 1 ? drawingNoBare(drawingNo(baseName(r.rel))) : '');
  const need = (i: number, j: number) => { const a = nameNo(olds[i].ref), b = nameNo(news[j].ref); return a && b && a !== b ? 0.8 : minScore; };
  const all = [...olds, ...news];
  const df = new Map<string, number>();
  const bags = all.map((f) => {
    const m = new Map<string, number>();
    for (const w of f.words) if (/[A-Z0-9]/.test(w)) m.set(w, (m.get(w) || 0) + 1);
    for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
    return m;
  });
  const N = all.length;
  const vec = bags.map((m) => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [w, c] of m) {
      const idf = Math.log((N + 1) / (df.get(w)! + 0.5));
      if (idf <= 0.05) continue;
      // drawing-number-like words count extra
      const boost = /\d/.test(w) && /[A-Z]/.test(w) && w.length >= 4 ? 2 : 1;
      const x = (1 + Math.log(c)) * idf * boost;
      v.set(w, x); norm += x * x;
    }
    return { v, norm: Math.sqrt(norm) || 1 };
  });
  const cand: { i: number; j: number; s: number }[] = [];
  for (let i = 0; i < olds.length; i++) {
    const a = vec[i];
    for (let j = 0; j < news.length; j++) {
      const b = vec[olds.length + j];
      let dot = 0;
      const [small, big] = a.v.size < b.v.size ? [a.v, b.v] : [b.v, a.v];
      for (const [w, x] of small) { const y = big.get(w); if (y) dot += x * y; }
      const s = dot / (a.norm * b.norm);
      if (s >= 0.1) cand.push({ i, j, s });
    }
  }
  cand.sort((p, q) => q.s - p.s);
  const usedO = new Set<number>(), usedN = new Set<number>();
  const pairs: PairPlan[] = [];
  const take = (i: number, j: number, how: PairPlan['how'], s?: number) => {
    usedO.add(i); usedN.add(j);
    pairs.push({ old: olds[i].ref, neu: news[j].ref, how, score: s == null ? undefined : +s.toFixed(3) });
  };
  // the pages paired by the sheet number read off them (T11, DECISIONS 76) - first, unless what the
  // pages say contradicts it: the two score under 0.35 while one of them has another partner at 0.8
  // or more (a false number on a spec page). A number read at a spot whose numbers repeat (a set holding
  // some sheets twice; third value, 0.6.0 DECISIONS 93) needs the 0.35 itself: that spot is the weaker
  // proof. The words are scored over all the pages either way, so the content pairing of the rest is as
  // without them.
  if (bySheet.length) {
    const score = new Map<number, number>(), bestO = new Map<number, [number, number][]>(), bestN = new Map<number, [number, number][]>();
    for (const c of cand) {
      score.set(c.i * news.length + c.j, c.s);
      if (c.s >= 0.8) { (bestO.get(c.i) || bestO.set(c.i, []).get(c.i)!).push([c.j, c.s]); (bestN.get(c.j) || bestN.set(c.j, []).get(c.j)!).push([c.i, c.s]); }
    }
    for (const [i, j, repeats] of bySheet) {
      if (usedO.has(i) || usedN.has(j)) continue;
      const s = score.get(i * news.length + j) ?? 0;
      const elsewhere = (bestO.get(i) || []).some(([k]) => k !== j) || (bestN.get(j) || []).some(([k]) => k !== i);
      if (s < 0.35 && (repeats || elsewhere)) continue;
      take(i, j, 'sheet', s || undefined);
    }
  }
  for (const c of cand) {
    if (usedO.has(c.i) || usedN.has(c.j) || c.s < need(c.i, c.j)) continue;
    take(c.i, c.j, 'content', c.s);
  }
  // pages with few words of their own (a schedule, a cover): among those left, each other's best
  for (let again = true; again;) {
    again = false;
    const bestO = new Map<number, { j: number; s: number }>(), bestN = new Map<number, { i: number; s: number }>();
    for (const c of cand) {
      if (usedO.has(c.i) || usedN.has(c.j) || need(c.i, c.j) > minScore) continue;
      if (!bestO.has(c.i)) bestO.set(c.i, { j: c.j, s: c.s });
      if (!bestN.has(c.j)) bestN.set(c.j, { i: c.i, s: c.s });
    }
    for (const [i, b] of bestO) if (bestN.get(b.j)?.i === i && !usedO.has(i) && !usedN.has(b.j)) { take(i, b.j, 'content', b.s); again = true; }
  }
  // a page with no words (a scan) in two issues of one combined PDF each with the same page count:
  // by its place, where its neighbours paired place for place
  const fileOf = (r: SheetRef) => r.file + '|' + r.pages;
  const at = new Map<string, number>();
  news.forEach((f, j) => { if (!usedN.has(j)) at.set(f.ref.file + '#' + f.ref.page, j); });
  const pairedAt = new Set(pairs.map((p) => `${fileOf(p.old!)}#${p.old!.page}>${fileOf(p.neu!)}#${p.neu!.page}`));
  for (let i = 0; i < olds.length; i++) {
    if (usedO.has(i)) continue;
    const o = olds[i].ref;
    if (o.pages <= 1) continue;
    for (const nf of new Set(news.filter((f) => f.ref.pages === o.pages).map((f) => f.ref.file))) {
      const j = at.get(nf + '#' + o.page);
      if (j == null || usedN.has(j)) continue;
      const nb = (d: number) => pairedAt.has(`${fileOf(o)}#${o.page + d}>${nf}|${o.pages}#${o.page + d}`);
      if ((o.page === 0 || nb(-1)) && (o.page === o.pages - 1 || nb(1))) { take(i, j, 'order'); break; }
    }
  }
  return { pairs, olds: olds.filter((_, i) => !usedO.has(i)).map((f) => f.ref), news: news.filter((_, j) => !usedN.has(j)).map((f) => f.ref) };
}

/** the drawing number as written in the name, without a revision / status code after it
 *  ("PRJ-AR-GA-01005_C02" -> "PRJ-AR-GA-01005", "F111.1-AE7-DWG-AR-100101" as it is) */
export function sheetNo(name: string): string {
  const w = drawingNo(name, true), d = drawingNo(name), bare = drawingNoBare(d);
  if (!w || bare === d) return w;
  // (the first parts, as many as the bare number has, with their separators as written)
  const n = bare.split('-').length;
  let out = '', k = 0;
  for (const m of w.matchAll(/[^-_.]+|[-_.]/g)) {
    if (/^[-_.]$/.test(m[0])) { if (k >= n) break; out += m[0]; } else { if (k >= n) break; out += m[0]; k++; }
  }
  return out.replace(/[-_.]+$/, '') || w;
}

/** what is left of a file name for a title once the number is taken: nothing if that is only a
 *  revision mark, a copy number, a date or punctuation ("(1)", "2026-10-28", "RevB", "_C02") */
export function cleanTitle(t: string): string {
  let s = t.trim();
  for (let k = 0; k < 3; k++) {
    const u = s.replace(/^[\s_\-.]*(rev(ision)?[\s_\-.]*[a-z]?\d{0,3}[a-z]?|\(\d+\)|copy|[pctds]\d{1,2}[a-z]?|\d{4}[-_.]?\d{2}[-_.]?\d{2}|\d{1,2}[-_.]\d{1,2}[-_.]\d{2,4})(?=$|[\s_\-.(])/i, '')
      .replace(/[\s_\-.(]+(rev(ision)?[\s_\-.]*[a-z]?\d{0,3}[a-z]?|\(\d+\)|copy|\d{4}[-_.]?\d{2}[-_.]?\d{2})\)?$/i, '').trim();
    if (u === s) break;
    s = u;
  }
  // (a letter of any script - Arabic, Cyrillic, Greek, CJK titles were erased by an ASCII-only test,
  //  RR-033; only numbers / marks / punctuation are not a title)
  return /\p{L}/u.test(s) ? s.replace(/^[\s_\-.]+|[\s_\-.]+$/g, '') : '';
}

/** a short name for a sheet: the drawing number, else the file name (+ page) */
export function sheetName(s: SheetRef): string {
  const b = baseName(s.rel);
  return s.pages > 1 ? `${b} · p.${s.page + 1}` : b;
}
/** the sheet as listed: its drawing number (else the file name, with its folder) - and for a
 *  page of a combined PDF its page label when that looks like a drawing number, else "file p.N" */
export function sheetKeyOf(s: SheetRef): string {
  if (s.read?.no) return s.read.no;
  const d = sheetNo(baseName(s.rel));
  const named = d || stripExt(s.rel).replace(/\\/g, '/');
  if (s.pages <= 1) return named;
  return s.label && /[A-Z]/i.test(s.label) && /\d/.test(s.label) && s.label.length >= 4 ? s.label : `${stripExt(s.rel).replace(/\\/g, '/')} p.${s.page + 1}`;
}
