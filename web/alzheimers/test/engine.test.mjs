// Engine tests: node test/engine.test.mjs
import * as E from '../js/engine.js';
import assert from 'node:assert/strict';

let n = 0;
const ok = (name, fn) => { fn(); n++; };
const rnd = (() => { let a = 7; return () => ((a = (a * 16807) % 2147483647) / 2147483647); })();

ok('settings: only the offered paces and flashes', () => {
  assert.deepEqual(E.cleanSettings(null), { pace: 8, flash: 1500 });
  assert.deepEqual(E.cleanSettings({ pace: 12, flash: 1000 }), { pace: 12, flash: 1000 });
  assert.deepEqual(E.cleanSettings({ pace: 3, flash: 99 }), { pace: 8, flash: 1500 });
});

ok('words are tidied, refused when too long, compared without case or punctuation', () => {
  assert.equal(E.cleanWord('  ice   cream! '), 'ice cream');
  assert.equal(E.cleanWord('<b>cat</b>'), 'b cat b');
  assert.equal(E.cleanWord('one two three four'), '');
  assert.equal(E.cleanWord('x'.repeat(25)), '');
  assert.equal(E.cleanWord(''), '');
  assert.equal(E.wordKey('Ice-Cream'), E.wordKey('ice cream'));
});

ok('a finished list needs 12 different things', () => {
  const twelve = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'];
  assert.equal(E.wordsProblem(twelve), '');
  assert.equal(E.wordsProblem(twelve.slice(0, 11)), 'Write 12 things');
  assert.equal(E.wordsProblem([...twelve.slice(0, 11), 'A1']), 'Each thing only once');
  assert.equal(E.wordsProblem([...twelve.slice(0, 11), '  ']), 'Fill in all 12 boxes');
});

ok('filling keeps what was typed (no repeats) and tops it up to 12 different drawable things', () => {
  const out = E.fillWords(['kite', 'Kite', '', 'drum', 42], rnd);
  assert.equal(out.length, 12);
  assert.deepEqual(out.slice(0, 3), ['kite', 'drum', '42']);
  assert.equal(new Set(out.map(E.wordKey)).size, 12);
  assert.equal(E.fillWords(null, rnd).length, 12);
});

ok('the timeline: a word every pace seconds, shown for the flash, then 10 s after the last', () => {
  assert.equal(E.revealAt(3, 8), 24000);
  assert.equal(E.drawLength(8), 11 * 8000 + 10000);
  assert.equal(E.wordIndex(-1, 8), -1);
  assert.equal(E.wordIndex(7999, 8), 0);
  assert.equal(E.wordIndex(8000, 8), 1);
  assert.equal(E.wordIndex(10 ** 7, 8), 11);
  assert.ok(E.showing(1, 8000, 8, 1500) && E.showing(1, 9499, 8, 1500));
  assert.ok(!E.showing(1, 9500, 8, 1500) && !E.showing(1, 7999, 8, 1500) && !E.showing(-1, 0, 8, 1500));
});

ok('boxes: left to right, top to bottom, on an 800 × 600 sheet', () => {
  assert.deepEqual(E.boxXY(0), { x: 0, y: 0 });
  assert.deepEqual(E.boxXY(5), { x: 200, y: 200 });
  assert.deepEqual(E.boxXY(11), { x: 600, y: 400 });
  assert.equal(E.boxAt(250, 250), 5);
  assert.equal(E.boxAt(799, 599), 11);
  assert.equal(E.boxAt(800, 10), -1);
  assert.equal(E.boxAt(-1, 10), -1);
});

ok('ink stays inside its box, in whole numbers, with a cap', () => {
  assert.deepEqual(E.cleanStroke(5, [0, 0, 999, 999, 250.4, 260.6]), [202, 202, 398, 398, 250, 261]);
  assert.deepEqual(E.cleanStroke(12, [1, 1]), []);
  assert.deepEqual(E.cleanStroke(0, 'x'), []);
  assert.deepEqual(E.cleanStroke(0, [10, NaN, 20, 20, 30]), [20, 20]);
  assert.equal(E.cleanStroke(0, Array(5000).fill(50)).length, E.INK.perStroke);
  assert.equal(E.cleanStroke(0, Array(100).fill(50), 10).length, 10);
});

ok('points and standings: most right boxes, then the faster test; a full tie has no winner', () => {
  assert.equal(E.points([{ i: 1, right: true }, { i: 2, right: false }, { i: 4, right: true }]), 2);
  assert.equal(E.standings([{ id: 'a', points: 9, ms: 50000 }, { id: 'b', points: 10, ms: 80000 }]).winner, 'b');
  assert.equal(E.standings([{ id: 'a', points: 9, ms: 50000 }, { id: 'b', points: 9, ms: 40000 }]).winner, 'b');
  assert.equal(E.standings([{ id: 'a', points: 9, ms: 40000 }, { id: 'b', points: 9, ms: 40000 }]).winner, null);
  assert.equal(E.standings([{ id: 'a', points: 0, ms: 1 }]).winner, 'a');
  assert.equal(E.standings([]).winner, null);
});

ok('naming a box: close is good enough, another of your words is not', () => {
  for (const [said, word] of [['cat', 'cat'], ['Cats', 'cat'], ['the elephant', 'elephant'], ['berries', 'berry'], ['boxes', 'box'],
    ['ice-cream', 'ice cream'], ['hous', 'house'], ['Shalwar kamez', 'shalwar kameez'], ['guittar', 'guitar']]) {
    assert.ok(E.nameMatches(said, word), `"${said}" should count for "${word}"`);
  }
  for (const [said, word] of [['dgo', 'dog'], ['caat', 'cat'], ['tree', 'house'], ['', 'cat'], ['   ', 'cat'], ['elefant', 'elephant']]) {
    assert.ok(!E.nameMatches(said, word), `"${said}" should not count for "${word}"`);
  }
  // One letter off "mouse", but "house" is one of the player's other words: not accepted
  assert.ok(E.nameMatches('house', 'mouse'));
  assert.ok(!E.nameMatches('house', 'mouse', ['house', 'tree']));
  assert.ok(E.nameMatches('mouse', 'mouse', ['house']));
});

ok('typed answers are tidied and capped', () => {
  assert.equal(E.cleanAnswer('  a  <b>cat</b>\n'), 'a b cat /b');
  assert.equal(E.cleanAnswer(42), '');
  assert.equal(E.cleanAnswer('x'.repeat(60)).length, E.ANSWER_MAX);
});

ok('suggestions avoid what is already written', () => {
  const s = E.suggestions(rnd, 30, ['pizza']);
  assert.equal(s.length, 30);
  assert.ok(!s.includes('pizza'));
});

console.log(`${n} passed, 0 failed`);
