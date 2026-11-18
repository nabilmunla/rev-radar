// T13 (DECISIONS 78): a repeated text is "Moved" only when it moved. Fails on 0.5.0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareParas, type Para } from '../src/engine/docs';

const P = (t: string, num = ''): Para => ({ i: 0, file: 'f.pdf', page: 1, num, text: t, head: '' });
/** a schedule of a kind: the same heading and the same short lines in every schedule, its own figures */
const schedule = (k: number) => [
  P('Schedule of finishes - general requirements of this schedule apply to every room listed in it'),
  P('Floor:'), P('Walls:'), P('Ceiling:'),
  P(`Room ${k}0${k} floor finish porcelain tile type T${k} laid on screed to falls where shown`),
  P(`Room ${k}0${k} wall finish emulsion paint colour C${k} two coats on plaster`),
  P('Test documents:'),
];
const say = (r: ReturnType<typeof compareParas>, O: Para[], N: Para[]) =>
  [...r.pairs.filter((p) => p.moved).map((p) => `moved: ${O[p.o].text.slice(0, 30)}`), ...r.removed.map((o) => `removed: ${O[o].text.slice(0, 30)}`), ...r.added.map((n) => `added: ${N[n].text.slice(0, 30)}`)].join(' / ');

test('six schedules with the same heading and short lines; one moved whole to another section, a clause added before the third: only the moved one is "Moved"', () => {
  const sec = (t: string) => P(`SECTION ${t} - the requirements of this section are set out below in full`);
  const O = [sec('09 30 00'), ...schedule(1), ...schedule(2), ...schedule(3), ...schedule(4), ...schedule(5), sec('09 90 00'), P('Painting work to be carried out by an approved specialist painting subcontractor only'), ...schedule(6)];
  // the new issue: schedule 2 moved under 09 90 00 (after the painting clause), a clause added before schedule 3
  const added = P('Tiles shall be from one production batch for each room so that the shade does not vary across the floor');
  const N = [sec('09 30 00'), ...schedule(1), added, ...schedule(3), ...schedule(4), ...schedule(5), sec('09 90 00'), P('Painting work to be carried out by an approved specialist painting subcontractor only'), ...schedule(2), ...schedule(6)];
  const r = compareParas(O, N);
  const moved = r.pairs.filter((p) => p.moved).map((p) => p.o);
  const s2 = O.findIndex((p) => p.text.startsWith('Room 202'));
  const block = new Set(Array.from({ length: 7 }, (_, i) => s2 - 4 + i));
  assert.ok(moved.every((o) => block.has(o)), 'only schedule 2 moved: ' + say(r, O, N));
  assert.ok(moved.length >= 2, 'schedule 2 is moved: ' + say(r, O, N));
  assert.deepEqual(r.removed, [], say(r, O, N));
  assert.deepEqual(r.added.map((n) => N[n].text), [added.text], say(r, O, N));
});

test('short repeated lines left over between paragraphs paired with each other are paired where they are (no removed + added)', () => {
  // a block that moved whole: its long paragraphs pair (moved); the six short lines inside it are said a different
  // number of times elsewhere (one more in the new issue), so no count pairs them - 0.5.0 listed them removed + added
  const shorts = ['Floor:', 'Walls:', 'Ceiling:', 'Test documents:', 'Submittals:', 'Warranty:'];
  const blk = shorts.flatMap((t, k) => [P(`Clause ${k + 1} of the moved block: requirements for item ${k + 1} as the room data sheets describe them`), P(t)]);
  const pre = [P('General: the requirements below apply to all of the finishes work in the project'), P('Floor:'), P('Walls:'), P('Ceiling:'), P('Test documents:'), P('Submittals:'), P('Warranty:')];
  // (what is between is bigger than the block, so the block is the one that moved)
  const mid = Array.from({ length: 14 }, (_, k) => P(`Painting clause ${k + 1}: work by an approved specialist painting subcontractor, colours as schedule ${k + 1}`));
  const extra = shorts.map((t) => P(t));
  const O = [...pre, ...blk, ...mid, P('End of the section and its appendices for the finishes work')];
  const N = [...pre, ...mid, ...blk, ...extra, P('End of the section and its appendices for the finishes work')];
  const r = compareParas(O, N);
  assert.deepEqual(r.removed, [], say(r, O, N));
  assert.deepEqual(r.added.map((n) => N[n].text).sort(), [...shorts].sort(), say(r, O, N));
});

test('a section said twice in each issue with another between them (a 3,000-page MEP spec): the smaller block is the one "Moved"', () => {
  // old: Telephone copy A, copy B, Public Address; new: copy, Public Address, copy. Moving PA (2 paragraphs) explains it;
  // 0.5.0 moved a whole Telephone copy (6)
  const tel = () => [P('Telephone and data cabling: horizontal cabling runs from the floor distributor to each outlet'), P('Test documents:'), P('Category 6A permanent link tests: every link tested and the results handed over in the original format'), P('Horizontal Cabling System'), P('Labels at both ends of every cable printed and fixed as the labelling standard requires'), P('Backbone cabling between the main and the floor distributors in single mode optical fibre')];
  const pa = [P('Public address and background music: zones as the schedule, amplifiers in the main equipment room'), P('Loudspeakers ceiling mounted in the common areas and wall mounted in the plant rooms throughout')];
  const intro = P('Division 27 communications: the sections below apply to the whole of the project');
  const end = P('End of the communications division specification for the project and its appendices');
  const O = [intro, ...tel(), ...tel(), ...pa, end], N = [intro, ...tel(), ...pa, ...tel(), end];
  const r = compareParas(O, N);
  assert.deepEqual(r.removed, [], say(r, O, N));
  assert.deepEqual(r.added, [], say(r, O, N));
  const moved = r.pairs.filter((p) => p.moved).map((p) => O[p.o].text.slice(0, 20));
  assert.equal(moved.length, 2, say(r, O, N));
  assert.ok(moved.every((t) => /^(Public|Loudspeakers)/.test(t)), say(r, O, N));
});

