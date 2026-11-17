// Telling title block / revision table changes from drawing changes (pure: unit-tested).

const MM_ = 72 / 25.4;
/**
 * Where title strips start: the right fifth / bottom 15 % of the sheet, but at least 120 / 60 mm
 * of paper (a title block keeps its real size: on an A3 it takes far more of the sheet than on an A0)
 */
export const rightStrip = (w: number) => w - Math.max(0.2 * w, 120 * MM_);
export const bottomStrip = (h: number) => h - Math.max(0.15 * h, 60 * MM_);

const REV_WORDS = new Set(['REV', 'REV.', 'REVISION', 'REVISED', 'REVISIONS', 'CLOUDED', 'ISSUE', 'ISSUED', 'CONSTRUCTION', 'TENDER', 'SUBMISSION', 'APPROVAL', 'PRELIMINARY', 'DETAILED', 'DESIGN', 'STATUS', 'PURPOSE', 'DRAWN', 'CHECKED', 'APPROVED', 'DATE', 'DESCRIPTION', 'INFORMATION', 'COMMENTS', 'COMMENT', 'AS', 'PER', 'FOR', 'OF', 'THE', 'AND', '&', 'BY', 'TO', 'NOT', 'QUANTIFICATION', 'IFC', 'IFT', 'IFA', 'DD', 'SD', 'CD', 'TD', 'SUBMITTAL', 'ADDENDUM', 'GENERAL', 'UPDATED', 'UPDATE', 'AMENDED']);
const DATE = /^(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[- ]?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*[- ]?\d{2,4})$/i;
const REVCODE = /^(REV\.?)?[A-Z]{1,3}[-_.]?\d{1,3}[A-Z]?$/i;
const STRONG = /^(REV\.?|REVISION|REVISED|CLOUDED|ISSUED?|CONSTRUCTION|TENDER|SUBMISSION|APPROVAL|PRELIMINARY|IFC|IFT|ADDENDUM)$/i;

/**
 * A change area that only touches revision-table / issue-status wording near the right or bottom
 * edge of the sheet (where title blocks sit): "DD-03 -> IFC-00", "22.06.2026", "REVISED AS CLOUDED".
 */
export function isRevisionText(a: { box: number[]; text: { kind: string; from?: string; to?: string }[] }, w: number, h: number, weakOk = false): boolean {
  const cx = (a.box[0] + a.box[2]) / 2, cy = (a.box[1] + a.box[3]) / 2;
  const inBand = cx > rightStrip(w) || cy > bottomStrip(h);
  if (!inBand || !a.text.length) return false;
  const words = a.text.filter((t) => t.kind !== 'moved').flatMap((t) => `${t.from || ''} ${t.to || ''}`.split(/\s+/)).map((x) => x.replace(/^[(\[]|[)\],:;]$/g, '')).filter(Boolean);
  if (!words.length) return false;
  let ok = 0, strong = false;
  for (const x of words) {
    const u = x.toUpperCase();
    if (DATE.test(u)) { ok++; strong = true; }
    else if (STRONG.test(u)) { ok++; strong = true; }
    else if (REV_WORDS.has(u) || REVCODE.test(u) || /^\d{1,3}%$/.test(u) || /^[A-Z]$/.test(u)) ok++;
  }
  return (strong || weakOk) && ok / words.length >= 0.7;
}

type TArea = { box: number[]; text: { kind: string; from?: string; to?: string; box?: number[] }[]; shift?: unknown };
const MM = 72 / 25.4;
const gapBetween = (a: number[], b: number[]) => Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]), Math.max(a[1], b[1]) - Math.min(a[3], b[3]));

/** the area's changed pixels are only its words: the box hardly reaches past the words' boxes */
export function textExplains(a: TArea, padMM = 5): boolean {
  const bs = a.text.filter((t) => t.kind !== 'moved' && t.box).map((t) => t.box!);
  if (!bs.length) return false;
  const u = [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];
  const p = padMM * MM;
  return a.box[0] >= u[0] - p && a.box[1] >= u[1] - p && a.box[2] <= u[2] + p && a.box[3] <= u[3] + p;
}

/**
 * Per sheet: which areas are title block changes by their wording. A clear revision-table change
 * (a date, "REVISED", "ISSUED FOR ...") counts on its own, if it is not big. Areas holding only
 * revision codes ("A -> B", "DD-03") count only when they are nothing but those words and sit in
 * the same title block - next to a clear one, or in the title strip it heads (a door tag
 * "D01 -> D02" or a column mark "C1 -> C2" out in the drawing never does).
 */
export function revisionAreas(areas: TArea[], w: number, h: number): boolean[] {
  // a revision row can run the width of the table; a block much taller than a few rows is a drawing
  const big = (a: TArea) => a.box[2] - a.box[0] > 320 * MM || a.box[3] - a.box[1] > 70 * MM;
  const inStripC = (a: TArea) => (a.box[0] + a.box[2]) / 2 > rightStrip(w) || (a.box[1] + a.box[3]) / 2 > bottomStrip(h);
  const cand = areas.map((a) => !big(a) && isRevisionText(a, w, h) && inStripC(a));
  const x0s = areas.filter((a, i) => cand[i] && textExplains(a, 10)).map((a) => a.box[0]);
  const colX = x0s.length ? Math.min(...x0s) - 10 * MM : Infinity;
  // a date / "ISSUED FOR" area that is more than its words (row lines, a stamp frame) only as a table row or in the column of the rows its words explain
  const strong = areas.map((a, i) => cand[i] && (textExplains(a, 10) || a.box[3] - a.box[1] <= 20 * MM || a.box[0] >= colX));
  const heads = areas.filter((_, i) => strong[i]);
  if (!heads.length) return strong;
  const colTop = Math.min(...heads.filter((s) => (s.box[0] + s.box[2]) / 2 > rightStrip(w) && (s.box[1] + s.box[3]) / 2 <= bottomStrip(h)).map((s) => s.box[1]));
  return areas.map((a, i) => {
    if (strong[i]) return true;
    if (big(a) || !isRevisionText(a, w, h, true) || !textExplains(a)) return false;
    const cx = (a.box[0] + a.box[2]) / 2, cy = (a.box[1] + a.box[3]) / 2;
    return heads.some((s) => gapBetween(a.box, s.box) <= 30 * MM
      // the same row of the revision table (rev | description | date | by run across)
      || (Math.min(a.box[3], s.box[3]) - Math.max(a.box[1], s.box[1]) > 0.5 * Math.min(a.box[3] - a.box[1], s.box[3] - s.box[1]) && gapBetween(a.box, s.box) <= 150 * MM && cx > w - Math.max(0.4 * w, 250 * MM))
      || ((s.box[0] + s.box[2]) / 2 > rightStrip(w) && (s.box[1] + s.box[3]) / 2 <= bottomStrip(h) && cx >= s.box[0] - 30 * MM && cx > rightStrip(w) && a.box[1] >= colTop - 30 * MM)
      || ((s.box[1] + s.box[3]) / 2 > bottomStrip(h) && cy >= s.box[1] - 30 * MM && cy > bottomStrip(h) && a.box[0] >= s.box[0] - 150 * MM));
  });
}


// ---------------------------------------------------------------- set-level: where most sheets changed

export interface SheetAreas { size: { w: number; h: number }; areas: TArea[] }
export interface Zone { group: string; box: number[] }
export const sizeKey = (s: { w: number; h: number }) => `${Math.round(s.w / 10) * 10}x${Math.round(s.h / 10) * 10}`;
const G = 48;
function cells(b: number[], w: number, h: number, f: (k: number) => void) {
  const c0 = Math.max(0, Math.floor((b[0] / w) * G)), c1 = Math.min(G - 1, Math.floor((b[2] / w) * G));
  const r0 = Math.max(0, Math.floor((b[1] / h) * G)), r1 = Math.min(G - 1, Math.floor((b[3] / h) * G));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) f(r * G + c);
}
function insideShare(a: number[], z: number[]): number {
  const ix = Math.max(0, Math.min(a[2], z[2]) - Math.max(a[0], z[0])), iy = Math.max(0, Math.min(a[3], z[3]) - Math.max(a[1], z[1]));
  return (ix * iy) / Math.max(1e-6, (a[2] - a[0]) * (a[3] - a[1]));
}

/**
 * The strip along the sheet edge where title blocks sit (right fifth, bottom 15% - at least 120 / 60
 * mm of paper - and the outer margin).
 * Kept narrow: a notes column or key plan that changed on most sheets is a real change.
 */
export function inTitleBand(b: number[], w: number, h: number): boolean {
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  return cx > rightStrip(w) || cy > bottomStrip(h) || cx < w * 0.035 || cy < h * 0.035;
}

/**
 * For every sheet: which change areas are title block / common (where most sheets of the same
 * size changed, or revision-table wording) and which sit in spots the user left out.
 */
export function classifyAreas(sheets: SheetAreas[], zones: Zone[]): { common: boolean[]; ignored: boolean[] }[] {
  const groups = new Map<string, number[]>();
  sheets.forEach((s, i) => { const g = sizeKey(s.size); if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push(i); });
  const out: { common: boolean[]; ignored: boolean[] }[] = sheets.map(() => ({ common: [], ignored: [] }));
  for (const [g, idx] of groups) {
    const counts = new Uint16Array(G * G);
    const withAreas = idx.filter((i) => sheets[i].areas.length);
    for (const i of withAreas) {
      const seen = new Uint8Array(G * G);
      const { w, h } = sheets[i].size;
      for (const a of sheets[i].areas) if (!a.shift) cells(a.box, w, h, (k) => { if (!seen[k]) { seen[k] = 1; counts[k]++; } });
    }
    // a clear majority: changes repeated on a group of similar sheets (typical floors) are real.
    // And clearly more often than inside the drawings: in a big revision most of every sheet
    // changed, so 65 % says nothing about the title strip (a dimension near the bottom edge of
    // most details is still a dimension)
    const need0 = Math.max(3, Math.ceil(withAreas.length * 0.65));
    const inner: number[] = [];
    if (withAreas.length) {
      const { w, h } = sheets[withAreas[0]].size;
      for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) { const x = (c + 0.5) / G * w, y = (r + 0.5) / G * h; if (!inTitleBand([x, y, x, y], w, h)) inner.push(counts[r * G + c]); }
    }
    inner.sort((a, b) => a - b);
    const need = Math.max(need0, (inner[Math.floor(inner.length * 0.75)] || 0) + Math.max(2, Math.ceil(withAreas.length * 0.25)));
    const zs = zones.filter((z) => z.group === g || z.group === '*');
    const first = idx.map((i) => {
      const { w, h } = sheets[i].size;
      const byText = revisionAreas(sheets[i].areas, w, h);
      return sheets[i].areas.map((a, k) => {
        // only in the band along the edge where title blocks, revision tables and issue stamps sit
        if (withAreas.length >= 3 && inTitleBand(a.box, w, h) && !measures(a)) {
          let n = 0, c = 0;
          cells(a.box, w, h, (q) => { n++; if (counts[q] >= need) c++; });
          if (n > 0 && c / n >= 0.6) return true;
        }
        return byText[k];
      });
    });
    // the title strip of this sheet size, learnt from where its title block changes are: a logo,
    // stamp or line (no words) changed inside it is title block too, even on few sheets
    const strip = titleStrip(idx.map((i, n) => ({ s: sheets[i], common: first[n] })));
    idx.forEach((i, n) => {
      const { w, h } = sheets[i].size;
      // (a view moved on the sheet is never hidden: see job.ts)
      out[i].common = sheets[i].areas.map((a, k) => !a.shift && (first[n][k] || (!!strip && inStrip(a, strip, w, h)) || onBorder(a, w, h)));
      out[i].ignored = sheets[i].areas.map((a) => !a.shift && zs.some((z) => insideShare(a.box, [z.box[0] * w, z.box[1] * h, z.box[2] * w, z.box[3] * h]) >= 0.6));
    });
  }
  return out;
}

/**
 * Where the title strip starts (fractions of the page): the left edge of a right-hand strip and/or
 * the top of a bottom strip, from the title block changes found (at least two, from the right fifth
 * or bottom 15%). null when there is nothing to learn from.
 */
export interface Strip { x?: number; y?: number; top?: number }
export function titleStrip(list: { s: SheetAreas; common: boolean[] }[]): Strip | null {
  const xs: number[] = [], ys: number[] = [], tops: number[] = [];
  for (const { s, common } of list) {
    const { w, h } = s.size;
    s.areas.forEach((a, k) => {
      if (!common[k]) return;
      const cx = (a.box[0] + a.box[2]) / 2 / w, cy = (a.box[1] + a.box[3]) / 2 / h;
      if (cx * w > rightStrip(w) && cy * h <= bottomStrip(h)) { xs.push(a.box[0] / w); tops.push(a.box[1] / h - 30 * MM / h); }
      else if (cy * h > bottomStrip(h)) ys.push(a.box[1] / h);
    });
  }
  const q10 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length * 0.1)];
  const out: Strip = {};
  const { w, h } = list[0]?.s.size || { w: 1, h: 1 };
  // the right column from the top of its revision rows down (notes, legend, key plan above it are drawing)
  if (xs.length >= 1) { out.x = Math.max(rightStrip(w) / w, q10(xs) - 0.004); out.top = q10(tops); }
  if (ys.length >= 2) out.y = Math.max(bottomStrip(h) / h, q10(ys) - 0.004);
  return out.x != null || out.y != null ? out : null;
}

/** a change of no words (logo, stamp, line) wholly inside the title strip */
function inStrip(a: TArea, st: Strip, w: number, h: number): boolean {
  if (a.text.some((t) => t.kind !== 'moved')) return false;
  if (a.box[2] - a.box[0] > 320 * MM || a.box[3] - a.box[1] > 120 * MM) return false;
  return (st.x != null && a.box[0] >= st.x * w && a.box[1] >= (st.top ?? 0) * h) || (st.y != null && a.box[1] >= st.y * h);
}

/**
 * Wholly within 10 mm of the paper edge: the sheet border and its ticks (no words), or a plot
 * stamp (a date / time / file path printed along the edge)
 */
export function onBorder(a: TArea, w: number, h: number): boolean {
  const words = a.text.filter((t) => t.kind !== 'moved');
  if (words.length && !words.every((t) => STAMP.test(`${t.from || ''} ${t.to || ''}`))) return false;
  const e = 10 * MM;
  return a.box[2] <= e || a.box[3] <= e || a.box[0] >= w - e || a.box[1] >= h - e;
}

const STAMP = /\d{1,4}[./-]\d{1,2}[./-]\d{1,4}|\d{1,2}:\d{2}|[\\/][^\s]*\.(dwg|dgn|rvt|pdf)\b/i;

/** a number changed to another number (a dimension, a level, a quantity) - not a date or a code */
const NUM = /^[-+]?\d[\d,.]*$/;
export function measures(a: TArea): boolean {
  return a.text.some((t) => t.kind === 'changed' && NUM.test(t.from || '') && NUM.test(t.to || '') && !DATE.test(t.from || '') && !DATE.test(t.to || ''));
}
