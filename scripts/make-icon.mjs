import { createRequire } from 'node:module'; const { chromium } = createRequire(import.meta.url)('playwright');
import fs from 'node:fs';
const svg = fs.readFileSync('public/icon.svg', 'utf8');
const b = await chromium.launch();
const p = await b.newPage({ deviceScaleFactor: 1 });
for (const s of [256, 64, 48, 32, 24, 16]) {
  await p.setViewportSize({ width: s, height: s });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="256" height="256"', `width="${s}" height="${s}"`)}</body></html>`);
  await p.screenshot({ path: `public/icon${s}.png`, omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } });
}
await b.close();
