// The number helpers the sheet reader (sheets.ts, the PDF Editor's copy) imports. They are Rev Radar's own
// (pairing.ts / titleblock.ts); this file only re-exports them (DECISIONS 74).
export { drawingNo, drawingNoBare, noZeros, sheetNo, cleanTitle, normName } from './pairing';
export { rightStrip, bottomStrip, sizeKey, inTitleBand } from './titleblock';
