// Small PNG writer (RGBA, 8 bit) - thumbnails and previews leave the engine as PNG files.
import { zlibSync } from 'fflate';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RGB (alpha dropped: our pictures are opaque) PNG */
export function encodePNG(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0, o = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0, i = y * w * 4; x < w; x++, i += 4) { raw[o++] = rgba[i]; raw[o++] = rgba[i + 1]; raw[o++] = rgba[i + 2]; }
  }
  const idat = zlibSync(raw, { level });
  const chunks: [string, Uint8Array][] = [];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(['IHDR', ihdr], ['IDAT', idat], ['IEND', new Uint8Array(0)]);
  let len = 8;
  for (const [, d] of chunks) len += 12 + d.length;
  const out = new Uint8Array(len);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let p = 8;
  const odv = new DataView(out.buffer);
  for (const [type, d] of chunks) {
    odv.setUint32(p, d.length); p += 4;
    const ts = p;
    for (let k = 0; k < 4; k++) out[p++] = type.charCodeAt(k);
    out.set(d, p); p += d.length;
    odv.setUint32(p, crc32(out, ts, p)); p += 4;
  }
  return out;
}

/** grey picture -> PNG */
export function grayPNG(px: Uint8Array, w: number, h: number): Uint8Array {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) { rgba[j] = rgba[j + 1] = rgba[j + 2] = px[i]; rgba[j + 3] = 255; }
  return encodePNG(rgba, w, h);
}
