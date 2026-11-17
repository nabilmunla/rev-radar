// The comparison's own overlay picture (the instant first look) brought to the slider's fade in the
// window - not drawn again by the engine (a whole dense sheet is 7-9 s there, and every sheet opened
// after the slider was moved waited for it, with the close looks queued behind). Pure: unit-tested.
//
// The preview is not an overlay at some fade: compare.ts previewColours draws the unchanged ink of a
// cell with its own curve (darkness 0.75 * min(1, (2.2 * ink)^0.7) - thin lines stand out on a small
// picture). So its grey is read back to the ink it stands for and drawn as the engine's overlay draws
// that ink at the slider's fade ((1 - fade) * ink): the whole slider works, and the whole sheet has the
// same greys as the sharp pictures drawn when zoomed in (0.3.3 scaled the preview's grey as if it were
// an overlay at 0.55: the lower half of the slider did nothing, and zooming in lightened the drawing).

/** the overlay's colour for unchanged ink (compare.ts defaultPalette.same) */
const SAME = [70, 78, 80] as const;
/** the preview's curve stops telling ink apart here (darkness 0.75 at 2.2 x ink = 1): a cell this dark
 *  or darker is dense ink - read as this much ink, reached smoothly from E0 of the darkness up */
const DENSE = 0.75;
const E0 = 0.93;
const C0 = Math.pow(E0, 1 / 0.7) / 2.2;

/** the ink (0-1, the share of a cell) a preview cell of darkness e (0-1 of the curve's 0.75) stands for */
export function inkOf(e: number): number {
  if (e <= 0) return 0;
  if (e < E0) return Math.pow(e, 1 / 0.7) / 2.2;
  return Math.min(DENSE, C0 + (DENSE - C0) * (e - E0) / (1 - E0));
}

/**
 * The preview's unchanged ink (grey) drawn as the overlay draws it at `fade` (0 = full, 0.9 = faint),
 * in place. Changed ink (red, blue, a mix) and paper are left exactly as they are.
 */
export function refade(px: Uint8ClampedArray, fade: number): void {
  const keep = 1 - fade;
  const dr = 255 - SAME[0], dg = 255 - SAME[1], db = 255 - SAME[2];
  // (everything follows from the red channel: worked out once per value - a whole-sheet preview is
  //  2-3 million pixels, and a pow per pixel cost ~45 ms on every sheet opened)
  const outR = new Uint8ClampedArray(256), outG = new Uint8ClampedArray(256), outB = new Uint8ClampedArray(256);
  const expG = new Float32Array(256), expB = new Float32Array(256);
  for (let r = 0; r < 256; r++) {
    const s = (255 - r) / dr;
    expG[r] = 255 - s * dg; expB[r] = 255 - s * db;
    const t = keep * inkOf(Math.min(1, s / 0.75));
    outR[r] = 255 - t * dr; outG[r] = 255 - t * dg; outB[r] = 255 - t * db;
  }
  for (let j = 0; j < px.length; j += 4) {
    const r = px[j], g = px[j + 1], b = px[j + 2];
    if (r === 255 && g === 255 && b === 255) continue;
    // (unchanged ink only: all three channels the same darkness of the "same" colour - PNG rounding
    //  aside; red / blue / a mix of them is not)
    const eg = g - expG[r], eb = b - expB[r];
    if (eg > 3 || eg < -3 || eb > 3 || eb < -3) continue;
    px[j] = outR[r]; px[j + 1] = outG[r]; px[j + 2] = outB[r];
  }
}
