// Parts of the comparison that can be switched off (PLAN: a part that misses its gate ships off by
// default). RR_OFF=tables,picocr switches parts off; RR_ON=<part> turns a part that ships off back on.
// Read at call time in the engine process (the app passes its environment on). `docxpdf` (hide the Word /
// LibreOffice converter: Word files are read as text) is read by the main process, electron/wordpdf.cjs.

/** parts shipped off (a missed gate, said in PROGRESS and the release notes) */
export const DEFAULT_OFF: readonly string[] = [
  // T6.5b (OCR of the words in changed pictures): its gate's peak (T0 + 150 MB) missed after one round of
  // fixes - the Tesseract engine it starts on a set without scans costs 180-210 MB. Flag and boxes only;
  // RR_ON=picocr turns it on.
  'picocr',
];

const list = (s: string | undefined) => (s ?? '').split(/[,\s]+/).filter(Boolean);
export function isOff(part: string): boolean {
  const env = typeof process !== 'undefined' ? process.env : {};
  if (list(env.RR_ON).includes(part)) return false;
  return list(env.RR_OFF).includes(part) || DEFAULT_OFF.includes(part);
}
