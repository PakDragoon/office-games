import * as E from '../js/engine.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (id) => readFileSync(join(here, '..', 'words', `${id}.txt`), 'utf8');
const deckOf = (id) => E.makeDeck(id, id === 'numbers' ? '' : read(id));
const find = (deck, name) => deck.entries.findIndex((e) => e.name === name);

// 1. The word lists: sorted, big enough, no empty or duplicate spellings, nothing to confuse one card with another
for (const d of E.DECKS.filter((x) => !x.numbers)) {
  const text = read(d.id);
  const lines = text.split('\n').filter(Boolean);
  const sorted = [...lines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));   // plain code-unit order, like LC_ALL=C sort
  assert.deepEqual(lines, sorted, `${d.id}.txt is not sorted with LC_ALL=C sort`);
  assert.ok(lines.length >= 130 && lines.length <= 300, `${d.id} has ${lines.length} cards`);
  const deck = deckOf(d.id);
  assert.equal(deck.entries.length, lines.length);
  const seen = new Map();
  deck.entries.forEach((e, i) => {
    assert.ok(e.name === e.name.trim() && e.name.length >= 2 && e.name.length <= 36, `odd card "${e.name}"`);
    assert.ok(e.keys.length >= 1);
    for (const k of e.keys) {
      assert.ok(!seen.has(k) || seen.get(k) === i, `"${k}" is spelled the same for "${deck.entries[seen.get(k)]?.name}" and "${e.name}" in ${d.id}`);
      seen.set(k, i);
    }
  });
  assert.ok(!text.includes('\r'), `${d.id}.txt has CRs`);
  assert.ok(text.endsWith('\n'), `${d.id}.txt has no final newline`);
}

// 2. Numbers deck: 1..100, with number words, no fuzzy matching
const nums = deckOf('numbers');
assert.equal(nums.entries.length, 100);
assert.equal(nums.entries[0].name, '1');
assert.equal(nums.entries[99].name, '100');
assert.equal(E.numberWords(21), 'twenty one');
assert.equal(E.numberWords(40), 'forty');
assert.equal(E.numberWords(100), 'one hundred');
assert.equal(E.numberWords(13), 'thirteen');
assert.equal(new Set(nums.entries.flatMap((e) => e.keys)).size, 200);

// 3. Text cleaning
assert.equal(E.tokens('  Beyoncé’s  Lemonade!! '), 'beyonce s lemonade');
assert.equal(E.tokens('Tom & Jerry'), 'tom and jerry');
assert.equal(E.squash('The Beatles'), 'beatles');
assert.equal(E.squash('A'), 'a');
assert.equal(E.squash('An  Eagle'), 'eagle');
assert.equal(E.squash('Frying-Pan'), 'fryingpan');
assert.equal(E.cleanQuestion('Am I <b>alive</b>?\n'), 'Am I b alive /b ?');
assert.equal(E.cleanQuestion('  Am   I   alive?  '), 'Am I alive?');
assert.equal(E.cleanQuestion('x'.repeat(300)).length, 100);
assert.equal(E.cleanQuestion(''), '');
assert.equal(E.cleanQuestion('?'), '');
assert.equal(E.cleanQuestion(42), '');
assert.equal(E.cleanQuestion({ a: 1 }), '');
assert.ok(!/[<>\u0000-\u001f]/.test(E.cleanQuestion('<script>alert(1)</script>\u0007bell')));
assert.equal(E.cleanGuess('y'.repeat(100)).length, 40);
assert.equal(E.cleanGuess('   '), '');
assert.equal(E.cleanGuess(null), '');

// 4. Settings are cleaned
assert.deepEqual(E.cleanSettings(undefined), { deck: 'animals', minutes: 8 });
assert.deepEqual(E.cleanSettings(null), { deck: 'animals', minutes: 8 });
assert.deepEqual(E.cleanSettings('x'), { deck: 'animals', minutes: 8 });
assert.deepEqual(E.cleanSettings({ deck: 'famous', minutes: 12 }), { deck: 'famous', minutes: 12 });
assert.deepEqual(E.cleanSettings({ deck: 'numbers', minutes: 0 }), { deck: 'numbers', minutes: 0 });
assert.deepEqual(E.cleanSettings({ deck: 'nope', minutes: 7 }), { deck: 'animals', minutes: 8 });
assert.deepEqual(E.cleanSettings({ deck: ['food'], minutes: '5' }), { deck: 'animals', minutes: 8 });
assert.deepEqual(E.cleanSettings({ deck: 'constructor', minutes: -1, extra: 'x' }), { deck: 'animals', minutes: 8 });
for (const id of E.DECK_IDS) assert.equal(E.cleanSettings({ deck: id }).deck, id);
for (const m of E.ROUND_MINUTES) assert.equal(E.cleanSettings({ minutes: m }).minutes, m);

// 5. Answers: the Numbers deck swaps the two soft answers
assert.deepEqual(E.answerKeys('animals'), ['yes', 'no', 'sort', 'dunno']);
assert.deepEqual(E.answerKeys('famous'), ['yes', 'no', 'sort', 'dunno']);
assert.deepEqual(E.answerKeys('numbers'), ['yes', 'no', 'higher', 'lower']);
assert.deepEqual(E.answerList('numbers').map(([, l]) => l), ['Yes', 'No', 'Higher', 'Lower']);
assert.deepEqual(E.majority({ yes: 3, no: 1, sort: 0, dunno: 0 }, E.answerKeys('animals')), ['yes']);
assert.deepEqual(E.majority({ yes: 2, no: 2, sort: 0, dunno: 1 }, E.answerKeys('animals')), ['yes', 'no']);
assert.deepEqual(E.majority({ yes: 0, no: 0, sort: 0, dunno: 0 }, E.answerKeys('animals')), []);
assert.deepEqual(E.majority({}, E.answerKeys('animals')), []);
assert.deepEqual(E.tallyAnswers({ a: 'yes', b: 'yes', c: 'no', d: 'constructor', e: 'higher' }, E.answerKeys('animals')), { yes: 2, no: 1, sort: 0, dunno: 0 });
assert.deepEqual(E.tallyAnswers({ a: 'higher', b: 'sort' }, E.answerKeys('numbers')), { yes: 0, no: 0, higher: 1, lower: 0 });

// 6. Spelling tolerance: 1 edit for 5+ letters, 2 for 9+, none under 5
assert.deepEqual([3, 4, 5, 8, 9, 20].map(E.tolerance), [0, 0, 1, 1, 2, 2]);
assert.equal(E.editDistance('kitten', 'sitting', 5), 3);
assert.equal(E.editDistance('abc', 'abc'), 0);
assert.equal(E.editDistance('abc', 'acb'), 1, 'a swap of neighbours is one edit');
assert.equal(E.editDistance('abcdef', 'xyzxyz', 2), 3, 'over the limit reports max + 1');
assert.equal(E.editDistance('', 'ab'), 2);
assert.equal(E.editDistance('a', 'abcdefgh', 2), 3);

const animals = deckOf('animals');
const food = deckOf('food');
const famous = deckOf('famous');
const jobs = deckOf('jobs');
const objects = deckOf('objects');
const match = (deck, name, guess) => E.guessMatches(guess, deck, find(deck, name));

// exact, case, accents, spaces, punctuation
assert.ok(match(animals, 'Elephant', 'elephant'));
assert.ok(match(animals, 'Elephant', '  ELEPHANT '));
assert.ok(match(animals, 'Guinea Pig', 'guineapig'));
assert.ok(match(animals, 'Guinea Pig', 'Guinea-Pig!'));
assert.ok(match(famous, 'Beyonce', 'Beyoncé'));
assert.ok(match(famous, 'Kylian Mbappe', 'MBAPPÉ'));
assert.ok(match(famous, 'The Beatles', 'beatles'));
assert.ok(match(famous, 'The Beatles', 'the beatles'));
assert.ok(match(food, 'Mac and Cheese', 'mac & cheese'), '& counts as "and"');
assert.ok(match(food, 'Fish and Chips', 'fish n chips'), '"and" -> "n" is 2 edits on a 12-letter card');
assert.ok(!match(food, 'Fish and Chips', 'fish chips'), '3 letters missing is too many');
// aliases
assert.ok(match(animals, 'Cat', 'kitty'));
assert.ok(match(animals, 'Cat', 'Kitten'));
assert.ok(match(famous, 'Albert Einstein', 'einstein'));
assert.ok(match(famous, 'Lionel Messi', 'Messi'));
assert.ok(match(famous, 'Cristiano Ronaldo', 'CR7'));
assert.ok(match(jobs, 'Firefighter', 'fireman'));
assert.ok(match(objects, 'Bicycle', 'bike'));
assert.ok(match(food, 'Eggplant', 'aubergine'));
// wrong cards
assert.ok(!match(animals, 'Cat', 'dog'));
assert.ok(!match(animals, 'Cat', ''));
assert.ok(!match(animals, 'Cat', '   '));
assert.ok(!match(animals, 'Cat', '???'));
assert.ok(!match(famous, 'Albert Einstein', 'albert'), 'a first name alone is not enough');
assert.ok(!match(famous, 'Lionel Messi', 'Ronaldo'));
// tolerance boundaries: the length of the card's own spelling decides
assert.ok(!match(animals, 'Cat', 'cot'), '3 letters: exact only');
assert.ok(!match(animals, 'Wolf', 'wolv'), '4 letters: exact only');
assert.ok(!match(animals, 'Wolf', 'wolff'));
assert.ok(match(animals, 'Tiger', 'tigre'), '5 letters: a swap is 1 edit');
assert.ok(match(animals, 'Tiger', 'tiger'));
assert.ok(match(animals, 'Tiger', 'tigr'), '5 letters: 1 missing letter');
assert.ok(match(animals, 'Tiger', 'tigger'), '5 letters: 1 extra letter');
assert.ok(match(animals, 'Tiger', 'tiber'), '5 letters: 1 wrong letter');
assert.ok(!match(animals, 'Tiger', 'tibar'), '5 letters: 2 edits is too many');
assert.ok(!match(animals, 'Tiger', 'tgr'), '5 letters: 2 missing');
assert.ok(match(animals, 'Elephant', 'elephent'), '8 letters: 1 edit');
assert.ok(!match(animals, 'Elephant', 'elefant'), '8 letters: "ph" -> "f" is 2 edits, too many');
assert.ok(match(animals, 'Chimpanzee', 'chimpanze'), '10 letters: 1 edit');
assert.ok(match(animals, 'Chimpanzee', 'chimpanzy'), '10 letters: 2 edits');
assert.ok(!match(animals, 'Chimpanzee', 'chimpanzzzz'), '10 letters: 3 edits is too many');
assert.ok(match(animals, 'Hummingbird', 'humingbrd'), '11 letters: 2 edits');
assert.ok(!match(animals, 'Hummingbird', 'humingbr'), '11 letters: 3 edits is too many');
// exactly 9 letters = 2 edits, exactly 8 = 1 edit
assert.equal(E.tolerance(E.squash('Crocodile').length), 2);
assert.ok(match(animals, 'Crocodile', 'crocadilo'));
assert.equal(E.tolerance(E.squash('Platypus').length), 1);
assert.ok(!match(animals, 'Platypus', 'platipas'));
// a near miss that is another card of the deck is never accepted
assert.ok(find(animals, 'Moose') >= 0 && find(animals, 'Mouse') >= 0);
assert.ok(!match(animals, 'Moose', 'mouse'));
assert.ok(find(food, 'Peach') >= 0 && find(food, 'Pear') >= 0);
assert.ok(match(food, 'Peach', 'peech'));
assert.ok(!match(food, 'Peach', 'pear'));
assert.ok(find(animals, 'Walrus') >= 0 && find(animals, 'Wallaby') >= 0);
// aliases are tolerant by their own length
assert.ok(match(famous, 'Albert Einstein', 'einstien'), 'alias: 8 letters, a swap');
assert.ok(!match(famous, 'Albert Einstein', 'einsten x'));
// bad input never throws
for (const bad of [undefined, null, 5, {}, [], 'a'.repeat(5000)]) assert.equal(E.guessMatches(bad, animals, 0), false);
assert.equal(E.guessMatches('cat', animals, 99999), false);
assert.equal(E.guessMatches('cat', animals, -1), false);

// numbers must be exact
const n = (guess, card) => E.guessMatches(guess, nums, card - 1);
assert.ok(n('42', 42));
assert.ok(n(' 42 ', 42));
assert.ok(n('forty two', 42));
assert.ok(n('Forty-Two', 42));
assert.ok(n('one hundred', 100));
assert.ok(n('100', 100));
assert.ok(!n('41', 42));
assert.ok(!n('43', 42));
assert.ok(!n('4', 42));
assert.ok(!n('420', 42));
assert.ok(!n('fourty two', 42), 'no spelling tolerance for numbers');
assert.ok(!n('forty', 42));
assert.ok(!n('forty tw', 42));
assert.ok(!n('042', 42));
assert.ok(!n('', 42));
assert.ok(!n('seven teen', 7));
assert.ok(n('seventeen', 17));
assert.ok(!n('sevenwteen', 17));
for (let i = 1; i <= 100; i++) {
  assert.ok(n(String(i), i));
  assert.ok(n(E.numberWords(i), i));
  assert.ok(!n(String(i === 100 ? 99 : i + 1), i));
}

// 7. Dealing: different cards, never repeating within a room until the deck runs out
let rnd = E.mulberry32(7);
{
  const size = 200;
  let used = [];
  const seen = new Set();
  for (let round = 0; round < 25; round++) {
    const { picks, used: next } = E.deal(size, 8, used, rnd);
    assert.equal(picks.length, 8);
    assert.equal(new Set(picks).size, 8, 'a card was dealt twice in one deal');
    for (const p of picks) {
      assert.ok(Number.isInteger(p) && p >= 0 && p < size);
      assert.ok(!seen.has(p), `card ${p} dealt again before the deck ran out`);
      seen.add(p);
    }
    used = next;
  }
  assert.equal(seen.size, 200);
  // the 26th deal: deck is exhausted, a new pass starts and everything is valid again
  const { picks, used: after } = E.deal(size, 8, used, rnd);
  assert.equal(new Set(picks).size, 8);
  assert.deepEqual([...after].sort((a, b) => a - b), [...picks].sort((a, b) => a - b), 'a new pass starts with the cards just dealt');
}
{
  // The deck runs out part-way through a deal: the last fresh cards first, then a new pass, no duplicates in the deal
  const size = 10;
  let used = [];
  let { picks, used: u } = E.deal(size, 8, used, rnd);
  const first = new Set(picks);
  ({ picks, used: u } = E.deal(size, 8, u, rnd));
  assert.equal(picks.length, 8);
  assert.equal(new Set(picks).size, 8);
  const rest = [...Array(size).keys()].filter((i) => !first.has(i));
  for (const r of rest) assert.ok(picks.includes(r), 'the two cards still unused must be dealt before any repeat');
  assert.equal(u.length, 6, 'the new pass holds the 6 cards dealt after the reset');
}
{
  // Bad "used" input and tiny decks
  assert.equal(E.deal(5, 8, undefined, rnd).picks.length, 5);
  assert.equal(new Set(E.deal(5, 8, [99, -1, 'x', 2.5], rnd).picks).size, 5);
  assert.equal(E.deal(100, 3, [0, 1, 2, 3], rnd).picks.every((p) => p > 3), true);
  // Same seed, same deal
  assert.deepEqual(E.deal(100, 5, [], E.mulberry32(3)), E.deal(100, 5, [], E.mulberry32(3)));
  // Every card of a real deck can come up
  const hit = new Set();
  let u2 = [];
  for (let i = 0; i < 60; i++) { const d = E.deal(animals.entries.length, 8, u2, rnd); d.picks.forEach((p) => hit.add(p)); u2 = d.used; }
  assert.equal(hit.size, animals.entries.length);
}

// 8. Scoring: max(2, 12 - questions asked) + 2 for the first right guess
assert.equal(E.points(1, false), 11);
assert.equal(E.points(1, true), 13);
assert.equal(E.points(5, false), 7);
assert.equal(E.points(10, false), 2);
assert.equal(E.points(10, true), 4);
assert.equal(E.points(11, false), 2, 'never below 2');
assert.equal(E.points(40, false), 2);
assert.equal(E.points(40, true), 4);
assert.equal(E.points(0, false), 12);
assert.equal(E.points(-3, false), 12);

// 9. Hiding text that names someone's card from that player
const card = (deck, name) => deck.entries[find(deck, name)];
assert.ok(E.mentionsCard(E.tokens('Is it a cat?'), card(animals, 'Cat')));
assert.ok(E.mentionsCard(E.tokens('Is it a KITTY'), card(animals, 'Cat')), 'aliases count');
assert.ok(!E.mentionsCard(E.tokens('Is it a category?'), card(animals, 'Cat')), 'only whole words');
assert.ok(!E.mentionsCard(E.tokens('Is it a giant?'), card(animals, 'Ant')));
assert.ok(E.mentionsCard(E.tokens('Is it Albert Einstein?'), card(famous, 'Albert Einstein')));
assert.ok(E.mentionsCard(E.tokens('Is it einstein'), card(famous, 'Albert Einstein')));
assert.ok(E.mentionsCard(E.tokens('Is it a polar bear'), card(animals, 'Polar Bear')));
assert.ok(E.mentionsCard(E.tokens('is it polarbear'), card(animals, 'Polar Bear')), 'spaces removed also counts for long names');
assert.ok(!E.mentionsCard(E.tokens('Is it a bear'), card(animals, 'Polar Bear')));
assert.ok(E.mentionsCard(E.tokens('Is it more than 7?'), nums.entries[6]));
assert.ok(!E.mentionsCard(E.tokens('Is it more than 70?'), nums.entries[6]));
assert.ok(E.mentionsCard(E.tokens('Is it seven'), nums.entries[6]));
assert.ok(!E.mentionsCard('', card(animals, 'Cat')));
assert.ok(!E.mentionsCard('is it a cat', null));

console.log('forehead engine tests passed');
