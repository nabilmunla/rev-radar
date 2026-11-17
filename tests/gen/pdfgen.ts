// A small PDF writer for the generated fixtures (gen_spec_table.ts, gen_pics.ts): pages of Helvetica
// text, ruled lines and pictures, written through MuPDF. Coordinates are page space as the engine
// reads it: origin top-left, points.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mu = any;
let mu: Mu = null;
export async function loadMu(): Promise<Mu> { if (!mu) mu = await import('mupdf'); return mu; }

export const W = 595, H = 842;

export class PdfGen {
  doc: Mu; font: Mu; fontRef: Mu; pages: { ops: string[]; imgs: Map<string, Mu>; w: number; h: number }[] = [];
  private imgSeq = 0;
  constructor(private m: Mu) {
    this.doc = new m.PDFDocument();
    this.font = new m.Font('Helvetica');
    this.fontRef = this.doc.addSimpleFont(this.font, 'Latin');
  }
  page(w = W, h = H) { this.pages.push({ ops: [], imgs: new Map(), w, h }); return this; }
  private get cur() { return this.pages[this.pages.length - 1]; }
  /** text width in points */
  width(s: string, size: number): number { let t = 0; for (const ch of s) t += this.font.advanceGlyph(this.font.encodeCharacter(ch)); return t * size; }
  /** words wrapped into lines no wider than w */
  wrap(s: string, w: number, size: number): string[] {
    const out: string[] = [];
    let line = '';
    for (const word of s.split(/\s+/).filter(Boolean)) {
      const t = line ? line + ' ' + word : word;
      if (line && this.width(t, size) > w) { out.push(line); line = word; } else line = t;
    }
    if (line) out.push(line);
    return out;
  }
  /** text with its top at y */
  text(x: number, y: number, s: string, size = 9): this {
    const esc = s.replace(/[\\()]/g, (c) => '\\' + c);
    this.cur.ops.push(`BT /F1 ${size} Tf ${x.toFixed(2)} ${(this.cur.h - y - size * 0.8).toFixed(2)} Td (${esc}) Tj ET`);
    return this;
  }
  line(x0: number, y0: number, x1: number, y1: number, lw = 0.6): this {
    this.cur.ops.push(`${lw} w ${x0.toFixed(2)} ${(this.cur.h - y0).toFixed(2)} m ${x1.toFixed(2)} ${(this.cur.h - y1).toFixed(2)} l S`);
    return this;
  }
  /** a filled rectangle (rgb 0-1) */
  fill(x0: number, y0: number, x1: number, y1: number, rgb: number[]): this {
    this.cur.ops.push(`q ${rgb.map((v) => v.toFixed(3)).join(' ')} rg ${x0.toFixed(2)} ${(this.cur.h - y1).toFixed(2)} ${(x1 - x0).toFixed(2)} ${(y1 - y0).toFixed(2)} re f Q`);
    return this;
  }
  /** a raw drawing operator string in PDF space (vector art) */
  raw(op: string): this { this.cur.ops.push(op); return this; }
  /** a picture (a MuPDF Image) drawn into the box x0, y0 - x1, y1 */
  image(img: Mu, x0: number, y0: number, x1: number, y1: number): this {
    const name = 'Im' + ++this.imgSeq;
    this.cur.imgs.set(name, this.doc.addImage(img));
    this.cur.ops.push(`q ${(x1 - x0).toFixed(2)} 0 0 ${(y1 - y0).toFixed(2)} ${x0.toFixed(2)} ${(this.cur.h - y1).toFixed(2)} cm /${name} Do Q`);
    return this;
  }
  /** the same image object drawn again (same bytes: one XObject) */
  imageRef(ref: Mu, x0: number, y0: number, x1: number, y1: number): this {
    const name = 'Im' + ++this.imgSeq;
    this.cur.imgs.set(name, ref);
    this.cur.ops.push(`q ${(x1 - x0).toFixed(2)} 0 0 ${(y1 - y0).toFixed(2)} ${x0.toFixed(2)} ${(this.cur.h - y1).toFixed(2)} cm /${name} Do Q`);
    return this;
  }
  addImage(img: Mu): Mu { return this.doc.addImage(img); }
  bytes(): Uint8Array {
    for (const p of this.pages) {
      const res = this.doc.newDictionary();
      const fonts = this.doc.newDictionary();
      fonts.put('F1', this.fontRef);
      res.put('Font', fonts);
      if (p.imgs.size) { const xo = this.doc.newDictionary(); for (const [k, v] of p.imgs) xo.put(k, v); res.put('XObject', xo); }
      const pg = this.doc.addPage([0, 0, p.w, p.h], 0, res, p.ops.join('\n'));
      this.doc.insertPage(-1, pg);
    }
    return this.doc.saveToBuffer('compress').asUint8Array();
  }
}
