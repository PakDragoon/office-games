// Engine tests: node test/engine.test.mjs
import { readFileSync } from 'node:fs';
import * as E from '../js/engine.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { failed++; console.log(`✗ ${name}\n  ${err.message}`); }
}
function eq(a, b, msg = '') {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg} expected ${y}, got ${x}`);
}
function ok(v, msg = 'expected true') { if (!v) throw new Error(msg); }

/* ---------- normalizing ---------- */
test('normalize: case, spaces, accents, marks', () => {
  eq(E.normalize('  Zébra  '), 'zebra');
  eq(E.normalize('ÉCLAIR'), 'eclair');
  eq(E.normalize('New   York'), 'new york');
  eq(E.normalize('ice-cream'), 'ice cream');
  eq(E.normalize("Côte d'Ivoire"), 'cote divoire');
  eq(E.normalize('St. Lucia'), 'st lucia');
  eq(E.normalize('Rock & Roll'), 'rock and roll');
  eq(E.normalize('Straße'), 'strasse');
  eq(E.normalize('Ørsted'), 'orsted');
});
test('normalize: empty, junk and other scripts become nothing', () => {
  eq(E.normalize(''), '');
  eq(E.normalize(null), '');
  eq(E.normalize(undefined), '');
  eq(E.normalize('   '), '');
  eq(E.normalize('!!!'), '');
  eq(E.normalize('علی'), '');
});
test('normalize: a leading "the" does not count ("The Nile" is an N)', () => {
  eq(E.normalize('The Nile'), 'nile');
  eq(E.normalize('the'), 'the');
  eq(E.normalize('Theodore'), 'theodore');
  eq(E.normalize('them'), 'them');
});
test('cleanAnswer: control characters, angle brackets, long text', () => {
  eq(E.cleanAnswer('  a\n\tb  c '), 'a b c');
  eq(E.cleanAnswer('<b>x</b>'), 'bx/b');
  eq(E.cleanAnswer('x'.repeat(100)).length, E.MAX_ANSWER_CHARS);
  eq(E.cleanAnswer(12), '12');
  eq(E.cleanAnswer(null), '');
});

/* ---------- starts with ---------- */
test('startsWith: letter in any case, never on an empty answer', () => {
  ok(E.startsWith('apple', 'A'));
  ok(E.startsWith('apple', 'a'));
  ok(!E.startsWith('apple', 'B'));
  ok(!E.startsWith('', 'A'));
  ok(!E.startsWith('apple', ''));
  ok(!E.startsWith('apple', 'AB'));
  ok(!E.startsWith('apple', undefined));
});

/* ---------- judging ---------- */
const has = (cat, norm) => cat === 'animal' && ['zebra', 'lion', 'cat', 'fox', 'berry'].includes(norm) || cat === 'place' && norm === 'paris';
test('judge: blank, wrong letter, on the list, unknown', () => {
  eq(E.judge('Z', 'animal', '', has), { norm: '', status: 'blank' });
  eq(E.judge('Z', 'animal', '   ', has), { norm: '', status: 'blank' });
  eq(E.judge('Z', 'animal', 'Lion', has).status, 'letter');
  eq(E.judge('Z', 'animal', 'Zebra', has), { norm: 'zebra', status: 'list' });
  eq(E.judge('Z', 'animal', ' ZÉBRA ', has).status, 'list', 'accents and spaces');
  eq(E.judge('Z', 'animal', 'Zorblax', has).status, 'unknown');
  eq(E.judge('P', 'place', 'Paris', has).status, 'list');
  eq(E.judge('P', 'animal', 'Paris', has).status, 'unknown', 'a list is per category');
});
test('judge: plurals are checked against the singular', () => {
  eq(E.judge('C', 'animal', 'cats', has).status, 'list');
  eq(E.judge('F', 'animal', 'foxes', has).status, 'list');
  eq(E.judge('B', 'animal', 'berries', has).status, 'list');
  eq(E.judge('Z', 'animal', 'zs', has).status, 'unknown');
});
test('judge: a single letter is never taken from a list', () => {
  eq(E.judge('A', 'animal', 'a', () => true).status, 'unknown');
});
test('judge: the leading "the" is ignored for the letter too', () => {
  eq(E.judge('N', 'place', 'The Netherlands', () => false).status, 'unknown');
  eq(E.judge('T', 'place', 'The Netherlands', () => false).status, 'letter');
});

/* ---------- scoring ---------- */
const row = (id, cells) => ({ id, cells });
const cell = (raw, status = 'list') => ({ raw, norm: E.normalize(raw), status });
test('scoreRound: 10 for a unique valid answer, 5 when another player gave the same', () => {
  const rows = [
    row('a', { animal: cell('Zebra'), place: cell('Zurich') }),
    row('b', { animal: cell('Zebra'), place: cell('Zagreb') }),
    row('c', { animal: cell('Zorilla'), place: cell('', 'blank') }),
  ];
  const s = E.scoreRound(['animal', 'place'], rows, () => false);
  eq(s.a.cells.animal.pts, 5); eq(s.b.cells.animal.pts, 5); eq(s.c.cells.animal.pts, 10);
  eq(s.a.cells.place.pts, 10); eq(s.b.cells.place.pts, 10);
  eq([s.a.total, s.b.total, s.c.total], [15, 15, 10]);
  eq([s.a.unique, s.b.unique, s.c.unique], [1, 1, 1]);
});
test('scoreRound: the same answer after normalizing counts as a duplicate', () => {
  const rows = [row('a', { animal: cell('Zebra') }), row('b', { animal: cell('  zébra ') }), row('c', { animal: cell('ZEBRA') })];
  const s = E.scoreRound(['animal'], rows, () => false);
  eq([s.a.total, s.b.total, s.c.total], [5, 5, 5]);
  ok(s.a.cells.animal.shared);
});
test('scoreRound: blank and wrong-letter answers score 0 and never make a duplicate', () => {
  const rows = [
    row('a', { animal: cell('', 'blank') }),
    row('b', { animal: cell('', 'blank') }),
    row('c', { animal: { raw: 'Lion', norm: 'lion', status: 'letter' } }),
    row('d', { animal: { raw: 'Lion', norm: 'lion', status: 'letter' } }),
    row('e', { animal: cell('Zebra') }),
  ];
  const s = E.scoreRound(['animal'], rows, () => true);
  eq([s.a.total, s.b.total, s.c.total, s.d.total, s.e.total], [0, 0, 0, 0, 10]);
  eq(s.e.unique, 1);
});
test('scoreRound: a missing cell is a blank', () => {
  const s = E.scoreRound(['animal', 'place'], [row('a', { animal: cell('Zebra') })], () => false);
  eq(s.a.cells.place.pts, 0);
  eq(s.a.total, 10);
});
test('scoreRound: unknown answers score only when the room accepted them', () => {
  const rows = [
    row('a', { name: { raw: 'Zorblax', norm: 'zorblax', status: 'unknown' } }),
    row('b', { name: { raw: 'Zeppo', norm: 'zeppo', status: 'unknown' } }),
    row('c', { name: { raw: 'Zorblax', norm: 'zorblax', status: 'unknown' } }),
  ];
  const s = E.scoreRound(['name'], rows, (cat, norm) => norm === 'zorblax');
  eq([s.a.total, s.b.total, s.c.total], [5, 0, 5], 'accepted and shared, rejected');
  eq(s.b.cells.name.ok, false);
});
test('scoreRound: a list answer and an accepted vote of the same word are the same word', () => {
  const rows = [row('a', { name: cell('Zara') }), row('b', { name: { raw: 'zara', norm: 'zara', status: 'unknown' } })];
  eq(E.scoreRound(['name'], rows, () => true).a.total, 5);
});

/* ---------- votes ---------- */
test('pendingVotes: one item per different unknown answer, with everyone who wrote it', () => {
  const unk = (raw) => ({ raw, norm: E.normalize(raw), status: 'unknown' });
  const rows = [
    row('a', { name: unk('Zorblax'), place: cell('Zagreb') }),
    row('b', { name: unk('zorblax'), place: unk('Zimville') }),
    row('c', { name: cell('Zara'), place: unk('Zimville') }),
    row('d', { name: unk('Zeppo'), place: cell('', 'blank') }),
  ];
  const items = E.pendingVotes(['name', 'place'], rows);
  eq(items.map((i) => [i.cat, i.norm, i.owners]), [['name', 'zorblax', ['a', 'b']], ['name', 'zeppo', ['d']], ['place', 'zimville', ['b', 'c']]]);
  eq(items[0].shown, 'Zorblax');
});
test('voteAccepted: majority thumbs-up or a tie accepts', () => {
  ok(E.voteAccepted(2, 1));
  ok(E.voteAccepted(1, 1), 'a tie');
  ok(E.voteAccepted(0, 0), 'nobody voted');
  ok(!E.voteAccepted(1, 2));
  ok(!E.voteAccepted(0, 1));
});

/* ---------- settings ---------- */
test('settings: defaults', () => {
  eq(E.cleanSettings(null), E.DEFAULT_SETTINGS);
  eq(E.DEFAULT_SETTINGS, { categories: ['name', 'place', 'animal', 'produce', 'thing'], time: 90, rounds: 10, hard: false });
});
test('settings: legal values are taken', () => {
  eq(E.cleanSettings({ categories: ['food', 'job', 'colour', 'sport'], time: 60, rounds: 5, hard: true }), { categories: ['food', 'job', 'colour', 'sport'], time: 60, rounds: 5, hard: true });
  eq(E.cleanSettings({ time: 120 }).time, 120);
  eq(E.cleanSettings({ rounds: 26 }).rounds, 26);
});
test('settings: categories are 4 to 8, known, unique and always in the same order', () => {
  const base = E.DEFAULT_SETTINGS;
  eq(E.cleanSettings({ categories: ['body', 'food', 'name', 'job'] }, base).categories, ['name', 'food', 'job', 'body']);
  eq(E.cleanSettings({ categories: ['name', 'place', 'animal'] }, base).categories, base.categories, 'too few');
  eq(E.cleanSettings({ categories: E.CATEGORY_IDS }, base).categories, base.categories, 'too many (10)');
  eq(E.cleanSettings({ categories: E.CATEGORY_IDS.slice(0, 8) }, base).categories.length, 8);
  eq(E.cleanSettings({ categories: ['name', 'name', 'name', 'name', 'name'] }, base).categories, base.categories, 'duplicates do not count');
  eq(E.cleanSettings({ categories: ['name', 'place', 'animal', 'produce', 'bogus', '__proto__'] }, base).categories, ['name', 'place', 'animal', 'produce'], 'unknown ids dropped');
  eq(E.cleanSettings({ categories: 'name' }, base).categories, base.categories);
  eq(E.cleanSettings({ categories: Array(50).fill('name') }, base).categories, base.categories);
  eq(E.cleanSettings({ categories: [1, 2, 3, 4] }, base).categories, base.categories);
});
test('settings: bad time, rounds and hard are ignored; unknown keys never get in', () => {
  const s = E.cleanSettings({ time: 61, rounds: 7, hard: 'yes', evil: 1 });
  eq(s, E.DEFAULT_SETTINGS);
  eq(E.cleanSettings({ time: '60' }).time, 90, 'a string is not a number');
  eq(E.cleanSettings([1, 2]), E.DEFAULT_SETTINGS);
  eq(E.cleanSettings('x'), E.DEFAULT_SETTINGS);
  eq('evil' in E.cleanSettings({ evil: 1 }), false);
});
test('settings: one bad key does not stop the good ones, and the base is never changed', () => {
  const base = { ...E.DEFAULT_SETTINGS, categories: [...E.DEFAULT_SETTINGS.categories] };
  const s = E.cleanSettings({ time: 60, rounds: 99 }, base);
  eq([s.time, s.rounds], [60, 10]);
  eq(base, E.DEFAULT_SETTINGS);
  s.categories.push('x');
  eq(base.categories.length, 5, 'categories are copied');
});

/* ---------- letters ---------- */
test('letters: Q, X and Z are off unless hard letters are on', () => {
  eq(E.availableLetters([], false).length, 23);
  ok(!E.availableLetters([], false).some((l) => 'QXZ'.includes(l)));
  eq(E.availableLetters([], true).length, 26);
  ok(E.letterAllowed('Z', [], true));
  ok(!E.letterAllowed('Z', [], false));
});
test('letters: used letters are not available again', () => {
  ok(!E.availableLetters(['A', 'B'], true).includes('A'));
  eq(E.availableLetters(['A', 'B'], true).length, 24);
  ok(!E.letterAllowed('A', ['A'], true));
  ok(!E.letterAllowed('a', [], true), 'letters are capitals');
  ok(!E.letterAllowed('AB', [], true));
  ok(!E.letterAllowed(5, [], true));
});
test('letters: a random pick is always an available letter, and null when none are left', () => {
  const used = ['A', 'B', 'C'];
  for (let i = 0; i < 200; i++) {
    const l = E.pickLetter(used, false, Math.random);
    ok(E.letterAllowed(l, used, false), `picked ${l}`);
  }
  eq(E.pickLetter([...E.LETTERS], true, Math.random), null);
  eq(E.pickLetter(['A'], true, () => 0), 'B');
  eq(E.pickLetter(['A'], true, () => 0.999999), 'Z');
});
test('letters: the game never has more rounds than letters', () => {
  eq(E.roundsFor({ rounds: 10, hard: false }), 10);
  eq(E.roundsFor({ rounds: 26, hard: false }), 23);
  eq(E.roundsFor({ rounds: 26, hard: true }), 26);
  eq(E.roundsFor({ rounds: 5, hard: true }), 5);
});

/* ---------- filling in ---------- */
test('allFilled / filledCount', () => {
  const cats = ['name', 'place'];
  ok(E.allFilled(cats, { name: 'Zed', place: 'Zug' }));
  ok(!E.allFilled(cats, { name: 'Zed', place: '  ' }));
  ok(!E.allFilled(cats, { name: 'Zed' }));
  ok(!E.allFilled(cats, null));
  eq(E.filledCount(cats, { name: 'Zed', place: '' }), 1);
  eq(E.filledCount(cats, { name: '!!', place: '' }), 0, 'marks alone are not an answer');
});

/* ---------- ranking ---------- */
test('rank: points first, unique answers break a tie, equal on both shares a place', () => {
  const r = E.rank([{ k: 'a', score: 50, unique: 2 }, { k: 'b', score: 80, unique: 1 }, { k: 'c', score: 50, unique: 3 }, { k: 'd', score: 50, unique: 3 }]);
  eq(r.map((x) => [x.k, x.place]), [['b', 1], ['c', 2], ['d', 2], ['a', 4]]);
});

/* ---------- the word lists ---------- */
const listFor = (id) => readFileSync(new URL(`../words/${id}.txt`, import.meta.url), 'utf8').split('\n').filter(Boolean);
for (const id of E.CATEGORY_IDS) {
  test(`list ${id}: sorted in code-unit order, no duplicates, already normalized`, () => {
    const words = listFor(id);
    ok(words.length > 300, `only ${words.length} words`);
    for (let i = 0; i < words.length; i++) {
      if (E.normalize(words[i]) !== words[i]) throw new Error(`not normalized: ${JSON.stringify(words[i])}`);
      if (i && !(words[i - 1] < words[i])) throw new Error(`out of order or duplicate at ${JSON.stringify(words[i])}`);
    }
  });
}
test('lists: every main category has something for every letter except Z-type gaps', () => {
  for (const id of ['name', 'place', 'animal', 'produce', 'thing']) {
    const words = listFor(id);
    for (const l of E.LETTERS.toLowerCase()) {
      if (!words.some((w) => w[0] === l)) throw new Error(`${id} has nothing for ${l}`);
    }
  }
});
test('lists: Pakistani names, places and dishes are there', () => {
  ok(listFor('name').includes('hassan') && listFor('name').includes('ayesha') && listFor('name').includes('zubair'));
  ok(listFor('place').includes('lahore') && listFor('place').includes('hunza') && listFor('place').includes('gulshan e iqbal'));
  ok(listFor('food').includes('biryani') && listFor('food').includes('nihari') && listFor('food').includes('haleem'));
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
