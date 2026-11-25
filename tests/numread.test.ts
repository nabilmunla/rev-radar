// 0.6.1 T39 (DECISIONS 141; DeepSeek 7, 8): numbers typed as text read in the file's own style - comma decimals only
// where the file shows them, else exactly 0.6.0's reading; the same parser for workbooks and PDFs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readItems, compareBoq } from '../src/engine/boq';
import { pdfBook } from '../src/engine/pdftable';
import type { Book, Val } from '../src/engine/sheets';
import type { Word } from '../src/engine/pdfium';

const book = (cells: [string, string, Val, string, Val, Val][]): Book => ({ sheets: [{ name: 'Bill 1', hidden: false, hiddenCols: [], rows: [
  { r: 1, hidden: false, c: ['Item', 'Description', 'Qty', 'Unit', 'Rate', 'Amount'] },
  ...cells.map((c, k) => ({ r: k + 2, hidden: false, c: c as Val[] })) ] }] });
const items = (b: Book) => readItems(b, 'x.xlsx', 0, '').items.map((x) => [x.ref, x.qty, x.rate, x.amount]);

test('T39: an English workbook reads as 0.6.0 - "1.234" is 1.234, "1,234" is 1234, "12,50" text', () => {
  assert.deepEqual(items(book([['A', 'Steel reinforcement', '1.234', 't', '3,100.00', '3,825.40'], ['B', 'Concrete', '1,234', 'm3', '450', '555,300'], ['C', 'Paint', '12,50', 'm2', '12.50', '156.25']])),
    [['A', 1.234, 3100, 3825.4], ['B', 1234, 450, 555300], ['C', '12,50', 12.5, 156.25]]);
});

test('T39: a comma-decimal workbook (it shows "12,50") - "1.234" is 1234, "1,234" is 1.234, "1.234,56" is 1234.56', () => {
  assert.deepEqual(items(book([['A', 'Steel reinforcement', '1,234', 't', '3.100,00', '3.825,40'], ['B', 'Concrete', '1.234', 'm3', '450', '555.300'], ['C', 'Paint', '12,50', 'm2', '12,50', '156,25']])),
    [['A', 1.234, 3100, 3825.4], ['B', 1234, 450, 555300], ['C', 12.5, 12.5, 156.25]]);
});

test('T39: mixed evidence ("12,50" and "3.75") is read as 0.6.0 reads it', () => {
  assert.deepEqual(items(book([['A', 'Paint', '12,50', 'm2', '3.75', '46.88']])), [['A', '12,50', 3.75, 46.88]]);
});

test('T39: old dot-decimal against new comma-decimal, the same values - nothing changed', () => {
  const old = readItems(book([['A', 'Steel reinforcement', '1.234', 't', '3,100.00', '3,825.40'], ['B', 'Paint', '12.50', 'm2', '12.50', '156.25']]), 'o.xlsx', 0, '');
  const neu = readItems(book([['A', 'Steel reinforcement', '1,234', 't', '3.100,00', '3.825,40'], ['B', 'Paint', '12,50', 'm2', '12,50', '156,25']]), 'n.xlsx', 0, '');
  const r = compareBoq(old, neu);
  assert.equal(r.pairs.filter((p) => p.changed.length).length + r.added.length + r.removed.length, 0, JSON.stringify(r.pairs.map((p) => p.changed)));
});

test('T39: a PDF row - "12,50" is never 1250; a comma-decimal PDF reads "1.234,56"', () => {
  const line = (y: number, ...ws: [string, number][]) => ws.map(([s, x]) => ({ s, x0: x, x1: x + s.length * 4.5, y0: y, y1: y + 7 } as Word));
  const head = line(80, ['Item', 36], ['Description', 154], ['Qty', 314], ['Unit', 356], ['Rate', 403], ['Amount', 480]);
  const row = (y: number, ref: string, d: string, q: string, u: string, r: string, a: string) => line(y, [ref, 41], [d, 59], [q, 325], [u, 359], [r, 405], [a, 482]);
  const read = (ws: Word[]) => readItems(pdfBook('x.pdf', 1, () => ws), 'x.pdf', 0, '').items.map((x) => [x.ref, x.qty, x.rate, x.amount]);
  assert.deepEqual(read([...head, ...row(100, 'A', 'Paint', '12,50', 'm2', '12.50', '156.25'), ...row(120, 'B', 'Tiles', '3', 'm2', '40.00', '120.00')])[0], ['A', '12,50', 12.5, 156.25]);
  assert.deepEqual(read([...head, ...row(100, 'A', 'Paint', '12,50', 'm2', '1.234,56', '15.432,00'), ...row(120, 'B', 'Tiles', '3', 'm2', '40,00', '120,00')]),
    [['A', 12.5, 1234.56, 15432], ['B', 3, 40, 120]]);
});
test('E3 (DECISIONS 161): a PDF cell holding two numbers ("1,200 50") is no comma evidence - "1,447" stays 1447', () => {
  const line = (y: number, ...ws: [string, number][]) => ws.map(([s, x]) => ({ s, x0: x, x1: x + s.length * 4.5, y0: y, y1: y + 7 } as Word));
  const head = line(80, ['Item', 36], ['Description', 154], ['Qty', 314], ['Unit', 356], ['Rate', 403], ['Amount', 480]);
  const ws = [...head, ...line(100, ['A', 41], ['Blockwork', 59], ['1,447', 325], ['m2', 359]), ...line(120, ['B', 41], ['Plaster', 59], ['3', 325], ['m2', 359], ['1,200', 470], ['50', 497]), ...line(140, ['C', 41], ['Paint', 59], ['2,310', 325], ['m2', 359])];
  const it = readItems(pdfBook('x.pdf', 1, () => ws), 'x.pdf', 0, '').items;
  assert.equal(it.find((x) => x.ref === 'A')!.qty, 1447);
  assert.equal(it.find((x) => x.ref === 'C')!.qty, 2310);
});
test('T47 sweep B1: a workbook number with a run of spaces ("2  238.50", NBSP + space) reads as 0.6.0 read it', () => {
  const it = readItems(book([['A', 'Tiles', '2  238.50', 'm2', '10', '22385'], ['B', 'Paint', '1\u00a0 447', 'm2', '2', '2894']]), 'x', 0, '').items;
  assert.equal(it[0].qty, 2238.5);
  assert.equal(it[1].qty, 1447);
});
