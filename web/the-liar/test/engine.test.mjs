import * as E from '../js/engine.js';
import { CATEGORIES, CATEGORY_NAMES } from '../js/words.js';
import { DECOY_GROUPS, closeWords } from '../js/pairs.js';
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

assert.equal(E.TIMES.guessMs, 10000, "the caught liar's last chance is 10 seconds");

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

// 9. Words game: clues
assert.equal(E.cleanClue('  hot   <b>drink</b> '), 'hot b drink b');
assert.equal(E.cleanClue('it’s'), "it's");
assert.equal(E.clueProblem(''), 'Type a word');
assert.equal(E.clueProblem('!!!'), 'Type a word');
assert.equal(E.clueProblem('morning'), '');
assert.equal(E.clueProblem('ice cream'), '', 'two words are fine');
assert.equal(E.clueProblem('very hot drink'), 'At most 2 words');
assert.equal(E.clueProblem('supercalifragilisticexpialidocious'), 'At most 24 letters');
assert.equal(E.clueProblem('Tea', { word: 'tea' }), 'That gives the word away');
assert.equal(E.clueProblem('teapot', { word: 'tea' }), 'That gives the word away', 'made from the word');
assert.equal(E.clueProblem('cricket', { word: 'cricket bat' }), 'That gives the word away', 'part of the word');
assert.equal(E.clueProblem('ice-cream', { word: 'ice cream' }), 'That gives the word away', 'spacing and hyphens');
assert.equal(E.clueProblem('ox', { word: 'box' }), '', 'short clues inside the word are fine');
assert.equal(E.clueProblem('steam', { word: 'tea' }), '', 'only contains it: fine');
assert.equal(E.clueProblem('teas', { word: 'tea' }), 'That gives the word away');
assert.equal(E.clueProblem('bats', { word: 'cricket bat' }), '', 'short part of the answer is not checked');
assert.equal(E.clueProblem('green tea', { word: 'tea' }), 'That gives the word away');
assert.equal(E.clueProblem('Leaves', { said: ['leaves'] }), 'Someone already said that');
assert.equal(E.clueProblem('leaf', { said: ['leaves'] }), '');
assert.equal(E.clueProblem('teapot', { word: '' }), '', 'the liar is not checked against the word');
assert.ok(E.WORD_SECONDS.includes(30));

// 10. Time game: the target sits strictly inside the liar's whole-second range
const seenLo = new Set(), seenPos = new Set();
for (let s = 0; s < 20000; s++) {
  const t = E.pickTime(E.mulberry32(s));
  assert.ok(t.target >= 3.01 && t.target <= 11.99, `target ${t.target}`);
  assert.equal(Math.round(t.target * 100) % 100 === 0, false, 'whole-second target');
  assert.equal(Math.round(t.target * 100) / 100, t.target, 'more than two decimals');
  assert.ok(Number.isInteger(t.lo) && t.lo >= 1 && t.hi === t.lo + E.TIME_GAME.span);
  assert.ok(t.lo < t.target && t.target < t.hi, `${t.target} outside ${t.lo}-${t.hi}`);
  seenLo.add(t.lo);
  if (t.target >= 7) seenPos.add(Math.floor(t.target) - t.lo);
}
assert.ok(seenLo.size >= 10, 'ranges vary');
assert.equal(seenPos.size, E.TIME_GAME.span, 'the target can be anywhere in the range');
assert.equal(E.cleanStop(6.7149), 6.71);
assert.equal(E.cleanStop(0.05), null, 'too quick');
assert.equal(E.cleanStop(61), null, 'too long');
assert.equal(E.cleanStop('6.5'), null, 'numbers only');
assert.equal(E.cleanStop(NaN), null);
assert.equal(E.cleanStop(null), null);
assert.equal(E.timeLimitMs(9), 29000);
// Turn by turn: one player's turn is shorter than everyone at once, still based on the range
assert.equal(E.timeTurnMs(9), 22000);
assert.ok(E.timeTurnMs(12) < E.timeLimitMs(12));
assert.deepEqual(E.TIME_TURNS, ['all', 'turns']);
assert.equal(E.fmtSecs(6.7), '6.70 s');
assert.deepEqual(E.DISCUSS_SECONDS, [60, 120, 180]);
assert.equal(E.outcome({ liar: 'x', accused: 'x', guess: null, word: '' }), 'caught', 'time game: no steal');

// "The liar doesn't know": decoy groups, the decoy word and time, options and turn order
for (const [cat, groups] of Object.entries(DECOY_GROUPS)) {
  assert.ok(CATEGORIES[cat], `decoy groups for unknown category ${cat}`);
  const seen = new Set();
  for (const g of groups) {
    const ws = g.split(',').map((w) => w.trim()).filter(Boolean);
    assert.ok(ws.length >= 2, `${cat}: a group needs at least 2 words (${g})`);
    for (const w of ws) {
      assert.ok(CATEGORIES[cat].includes(w), `${cat}: decoy word "${w}" isn't in the category`);
      assert.ok(!seen.has(w), `${cat}: "${w}" is in two decoy groups`);
      seen.add(w);
    }
  }
}
for (const [cat, words] of Object.entries(CATEGORIES)) {
  for (const w of words) {
    for (let s = 0; s < 3; s++) {
      const d = E.pickDecoy(cat, w, E.mulberry32(s * 7919 + w.length));
      assert.notEqual(d, w, `decoy for ${w} is the word itself`);
      assert.ok(words.includes(d), `decoy ${d} for ${w} is in the same category`);
      if (closeWords(cat, w).length) assert.ok(closeWords(cat, w).includes(d), `decoy for ${w} comes from its group`);
    }
  }
}
assert.ok(closeWords('Drinks', 'chai').includes('karak chai'));
assert.deepEqual(closeWords('Nope', 'chai'), []);
for (let s = 0; s < 300; s++) {
  const opts = E.liarOptions('Drinks', 'chai', E.mulberry32(s), E.OPTION_COUNT, 'karak chai');
  assert.equal(opts.length, E.OPTION_COUNT);
  assert.ok(opts.includes('chai') && !opts.includes('karak chai'), 'the decoy is never an option');
}
for (let s = 0; s < 5000; s++) {
  const t = E.pickTime(E.mulberry32(s));
  const d = E.pickDecoyTime(t.target, E.mulberry32(s + 1));
  const gap = Math.round(Math.abs(d - t.target) * 100);
  assert.ok(gap >= E.DECOY_TIME.min && gap <= E.DECOY_TIME.max, `decoy ${d} is 1.5 to 3 s from ${t.target}`);
  assert.ok(d * 100 >= E.TIME_GAME.lo && d * 100 <= E.TIME_GAME.hi + 0.001, `decoy ${d} is a usual target`);
  assert.notEqual(Math.round(d * 100) % 100, 0, 'never a whole second');
}
let liarFirst = 0;
for (let s = 0; s < 400; s++) if (E.turnOrder(['a', 'b', 'c', 'd'], 'a', E.mulberry32(s), false)[0] === 'a') liarFirst++;
assert.ok(liarFirst > 50, 'a liar who doesn\'t know can go first');

// Room chat: tidy text and the "your own word" check
assert.equal(E.cleanChat('  hi\n\tthere  '), 'hi there');
assert.equal(E.cleanChat(42), '');
assert.equal(E.cleanChat('x'.repeat(500)).length, E.CHAT_MAX);
assert.ok(E.chatGivesAway('I love tea', 'tea'));
assert.ok(E.chatGivesAway('teas please', 'tea'));
assert.ok(!E.chatGivesAway('team work', 'tea'), 'words that only start the same are fine');
assert.ok(!E.chatGivesAway('steam', 'tea'));
assert.ok(E.chatGivesAway('karak chai is great', 'karak chai'));
assert.ok(E.chatGivesAway('chai time', 'karak chai'), 'a main part of a two-word word');
assert.ok(E.chatGivesAway('a babyelephant', 'elephant'), 'a longer word written anywhere');
assert.ok(!E.chatGivesAway('category?', 'cat'));
assert.ok(!E.chatGivesAway('Bob is sus', 'cricket bat'));
assert.ok(!E.chatGivesAway('anything', ''), 'a liar who knows has no word to give away');
assert.deepEqual(E.CHAT_PHASES, ['lobby', 'draw', 'discuss', 'vote', 'result']);

console.log(`engine: all checks passed (${total} words in ${CATEGORY_NAMES.length} categories)`);
