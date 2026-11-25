// (0.6.1 T40) a generated rewritten BOQ gap for the alignGap index tests: every item reworded in place, no anchors
// generated rewritten BOQ gap: N items, every one reworded in place (no description survives), no anchors
export function gen(N: number, seed: number, harsh = process.env.HARSH === '1') {
  let s = seed >>> 0 || 1; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const V = 4000, common = ['supply', 'install', 'concrete', 'including', 'all', 'works', 'and', 'the', 'to', 'of', 'with', 'complete', 'as', 'per', 'drawings', 'specification'];
  // (letter words - "w123" splits into "w" and a number under norm, every item then shared a word 7 times)
  const SY = ['ba', 'ke', 'ri', 'tor', 'lan', 'mu', 'sen', 'di', 'pra', 'vo', 'gel', 'zu', 'han', 'ost', 'fi', 'cre'];
  const lw = (k: number) => { let w = ''; do { w += SY[k % 16]; k = Math.floor(k / 16); } while (k > 0); return w + 'x'; };
  const word = () => (rnd() < 0.35 ? common[Math.floor(rnd() * common.length)] : harsh ? 'w' + Math.floor(V * Math.pow(rnd(), 1.6)) : lw(Math.floor(V * Math.pow(rnd(), 1.6))));
  const units = ['m2', 'm3', 'nr', 'm', 't', 'item'];
  const mk = (i: number, file: string, text: string, unit: string, qty: number) => ({ i, file, bill: '', sheet: 'S', row: i + 2, page: '', ref: String.fromCharCode(65 + (i % 26)), mark: false, section: '', group: '', text, unit, qty, rate: null, amount: null });
  const O: any[] = [], Nw: any[] = [];
  for (let i = 0; i < N; i++) {
    const ws = Array.from({ length: 6 + Math.floor(rnd() * 7) }, word);
    const unit = units[Math.floor(rnd() * units.length)], qty = Math.floor(rnd() * 900) + 2;
    O.push(mk(i, 'o.xlsx', ws.join(' '), unit, qty));
    const nw = ws.slice(); const k = 2 + Math.floor(rnd() * 3);
    for (let j = 0; j < k; j++) nw[Math.floor(rnd() * nw.length)] = word();
    if (rnd() < 0.2) nw.push(word());
    Nw.push(mk(i, 'n.xlsx', nw.join(' ') + ' rev', rnd() < 0.9 ? unit : units[Math.floor(rnd() * units.length)], rnd() < 0.7 ? qty : qty + 1));
  }
  return { o: { items: O, notes: [], sheets: [] }, n: { items: Nw, notes: [], sheets: [] } };
}
