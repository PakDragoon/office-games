import * as E from '../js/engine.js';
import { CATEGORIES, CATEGORY_NAMES } from '../js/words.js';
import assert from 'node:assert/strict';

// 1. The word list: big, no duplicates, every category big enough for the liar's options
const all = new Map();
let total = 0;
for (const [cat, words] of Object.entries(CATEGORIES)) {
  assert.ok(words.length >= E.OPTION_COUNT, `${cat} has only ${words.length} words`);
  for (const w of words) {
    const k = w.toLowerCase();
    assert.ok(!all.has(k), `"${w}" is in both ${all.get(k)} and ${cat}`);
    assert.ok(w.length >= 2 && w.length <= 32 && w === w.trim(), `odd word "${w}"`);
    all.set(k, cat);
    total++;
  }
}
assert.ok(total >= 1500, `only ${total} words`);
assert.ok(CATEGORY_NAMES.length >= 25);

// 2. Picking words: no repeats until a category runs out, then it starts over
let rnd = E.mulberry32(1);
for (const cat of ['Drinks', 'Space', 'Feelings']) {
  const used = new Set();
  for (let i = 0; i < CATEGORIES[cat].length; i++) {
    const p = E.pickWord([cat], used, rnd);
    assert.equal(p.category, cat);
    const k = E.wordKey(p.category, p.word);
    assert.ok(!used.has(k), `${cat}: repeated ${p.word} before running out`);
    used.add(k);
  }
  const again = E.pickWord([cat], used, rnd);
  assert.ok(CATEGORIES[cat].includes(again.word), 'starts over when a category is used up');
}
const fromAll = new Set();
for (let i = 0; i < 2000; i++) fromAll.add(E.pickWord([], new Set(), rnd).category);
assert.ok(fromAll.size >= CATEGORY_NAMES.length - 2, 'no categories chosen means all of them');
assert.equal(E.pickWord(['Nonsense'], new Set(), rnd) !== undefined, true, 'unknown category falls back to all');

// 3. The liar's options: the real word, 12 different words, all from the category
for (let i = 0; i < 3000; i++) {
  const cat = CATEGORY_NAMES[i % CATEGORY_NAMES.length];
  const word = CATEGORIES[cat][i % CATEGORIES[cat].length];
  const opts = E.liarOptions(cat, word, rnd);
  assert.equal(opts.length, E.OPTION_COUNT);
  assert.equal(new Set(opts).size, opts.length, 'options repeat');
  assert.ok(opts.includes(word), 'real word missing from options');
  assert.ok(opts.every((o) => CATEGORIES[cat].includes(o)), 'option from another category');
}
// The real word lands in different places
const spots = new Set();
for (let s = 0; s < 200; s++) spots.add(E.liarOptions('Drinks', 'chai', E.mulberry32(s)).indexOf('chai'));
assert.ok(spots.size > 8, 'real word always in the same spot');

// 4. Turn order: everyone once, the liar never first, order varies
const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
const firsts = new Set();
for (let s = 0; s < 3000; s++) {
  const liar = ids[s % ids.length];
  const order = E.turnOrder(ids, liar, E.mulberry32(s));
  assert.deepEqual([...order].sort(), [...ids].sort());
  assert.notEqual(order[0], liar, 'liar went first');
  firsts.add(order[0]);
}
assert.equal(firsts.size, ids.length);
assert.deepEqual(E.turnOrder(['solo'], 'solo', rnd), ['solo']);

// Liar: never the same person twice in a row when there's a choice
for (let s = 0; s < 2000; s++) {
  const r = E.mulberry32(s);
  const prev = ids[s % ids.length];
  assert.notEqual(E.pickLiar(ids, prev, r), prev);
}
assert.equal(E.pickLiar(['solo'], 'solo', rnd), 'solo');
const liars = new Set();
for (let s = 0; s < 500; s++) liars.add(E.pickLiar(ids, null, E.mulberry32(s)));
assert.equal(liars.size, ids.length, 'everyone can be the liar');

// 5. Vote now: everyone but one
assert.deepEqual([1, 2, 3, 4, 5, 8].map(E.voteNeeded), [1, 2, 2, 3, 4, 7]);

// 6. Tally: most votes is accused, ties accuse nobody
assert.deepEqual(E.tally({ a: 'b', c: 'b', d: 'a' }), { counts: { b: 2, a: 1 }, accused: 'b' });
assert.equal(E.tally({ a: 'b', b: 'a' }).accused, null, 'tie accuses nobody');
assert.equal(E.tally({}).accused, null);
assert.equal(E.tally({ a: 'c' }).accused, 'c');

// 7. Outcomes and points
assert.equal(E.outcome({ liar: 'x', accused: 'y', guess: null, word: 'chai' }), 'escaped');
assert.equal(E.outcome({ liar: 'x', accused: null, guess: null, word: 'chai' }), 'escaped');
assert.equal(E.outcome({ liar: 'x', accused: 'x', guess: 'chai', word: 'chai' }), 'stolen');
assert.equal(E.outcome({ liar: 'x', accused: 'x', guess: 'coffee', word: 'chai' }), 'caught');
assert.equal(E.outcome({ liar: 'x', accused: 'x', guess: null, word: 'chai' }), 'caught');
const players = ['x', 'a', 'b', 'c'];
assert.deepEqual(E.points({ result: 'caught', liar: 'x', votes: { a: 'x', b: 'x', c: 'a', x: 'a' }, players }), { x: 0, a: 3, b: 3, c: 2 });
assert.deepEqual(E.points({ result: 'escaped', liar: 'x', votes: { a: 'x', b: 'c', c: 'b', x: 'a' }, players }), { x: 3, a: 1, b: 0, c: 0 });
assert.deepEqual(E.points({ result: 'stolen', liar: 'x', votes: { a: 'x', b: 'x', c: 'x', x: 'a' }, players }), { x: 2, a: 1, b: 1, c: 1 });
assert.deepEqual(E.points({ result: 'caught', liar: 'x', votes: { ghost: 'x' }, players }).ghost, undefined, 'votes from non-players ignored');

// 8. Ink from the network is cleaned
assert.deepEqual(E.cleanInk([1.4, 2.6, -5, 9000, 'a', 3, 400, 300, 7]), [1, 3, 0, 600, 400, 300]);
assert.deepEqual(E.cleanInk('nope'), []);
assert.deepEqual(E.cleanInk(null), []);
assert.equal(E.cleanInk(new Array(10000).fill(5)).length, E.MAX_INK);
assert.equal(E.cleanInk(new Array(100).fill(5), 10).length, 10, 'respects remaining room');

console.log(`engine: all checks passed (${total} words in ${CATEGORY_NAMES.length} categories)`);
