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

const lines = (f) => readFileSync(new URL(`../words/${f}`, import.meta.url), 'utf8').split('\n').filter(Boolean);
const common = lines('common.txt'), more = lines('more.txt'), valid = lines('valid.txt');
const lex = E.makeLexicon(common, more, valid);

/* ---------- Settings ---------- */
test('settings: defaults, cleaning, rounds follow the mode', () => {
  eq(E.cleanSettings(null), E.DEFAULT_SETTINGS);
  const s = E.cleanSettings({ mode: 'pick', teams: '2v2', bands: '8', length: 'long', words: 'common', rounds: 6, time: 90, x: 1 });
  eq(s, { mode: 'pick', teams: '2v2', bands: 8, length: 'long', words: 'common', rounds: 6, time: '90' });
  eq(E.cleanSettings({ mode: 'pick', rounds: 5 }).rounds, 4, 'race rounds in pick mode reset');
  eq(E.cleanSettings({ mode: 'race', rounds: 6 }).rounds, 5, 'pick rounds in race mode reset');
  eq(E.cleanSettings({ bands: 7 }).bands, 6);
  eq(E.timeMs({ time: 'off' }), 0);
  eq(E.timeMs({ time: '90' }), 90000);
  eq(E.seatsFor({ teams: '2v2' }), 2);
  eq(E.seatsFor({ teams: '1v1' }), 1);
});

/* ---------- Word lists ---------- */
test('word lists: big, clean, right lengths, no overlap', () => {
  ok(common.length > 7000, `common ${common.length}`);
  ok(more.length > 15000, `more ${more.length}`);
  ok(valid.length > 200000, `valid ${valid.length}`);
  for (const w of common.concat(more)) {
    if (!/^[a-z]{4,12}$/.test(w)) throw new Error(`bad word ${w}`);
    if (E.isBlocked(w)) throw new Error(`blocked word in list: ${w}`);
  }
  const c = new Set(common);
  ok(!more.some((w) => c.has(w)), 'more overlaps common');
  ok(common.every((w) => lex.valid.has(w)), 'every computer word is pickable');
});

test('pick checks', () => {
  eq(E.pickProblem('', lex), 'Type a word');
  eq(E.pickProblem('cat', lex), 'At least 4 letters');
  eq(E.pickProblem('incomprehensibilities', lex), 'At most 12 letters');
  eq(E.pickProblem('zzzzqx', lex), 'Not in the dictionary');
  eq(E.pickProblem('fuck', lex), 'Pick something kinder');
  eq(E.pickProblem('Banana!', lex), '', 'cleans case and symbols');
  eq(E.pickProblem('rhythm', lex), '');
  eq(E.cleanWord(' Wa-ter Melon '), 'watermelon');
});

test('the computer picks the right lengths and avoids repeats', () => {
  const rnd = E.mulberry32(1);
  for (const length of ['short', 'medium', 'long', 'any']) {
    const [lo, hi] = E.LENGTHS[length];
    for (let k = 0; k < 200; k++) {
      const w = E.pickWord(lex, { length, words: 'all' }, rnd);
      ok(w.length >= lo && w.length <= hi, `${length}: ${w}`);
    }
  }
  const cset = new Set(common);
  for (let k = 0; k < 200; k++) ok(cset.has(E.pickWord(lex, { length: 'any', words: 'common' }, rnd)), 'common only');
  const used = new Set();
  const tiny = E.makeLexicon(['apple', 'grape', 'lemon'], [], []);
  for (let k = 0; k < 3; k++) used.add(E.pickWord(tiny, { length: 'any', words: 'all' }, rnd, used));
  eq(used.size, 3, 'no repeats until the list runs out');
  ok(['apple', 'grape', 'lemon'].includes(E.pickWord(tiny, { length: 'any', words: 'all' }, rnd, used)), 'then repeats rather than nothing');
  eq(E.pickWord(E.makeLexicon(), { length: 'any', words: 'all' }, rnd), '', 'empty list');
});

/* ---------- Guessing ---------- */
test('guessing: hits, misses, repeats, solve', () => {
  let g = E.newGuess('melon');
  eq(E.mask(g.word, g.guessed), '_____');
  let r = E.guess(g, 'e', 6);
  ok(r.hit); eq(r.count, 1); g = r.g;
  eq(E.mask(g.word, g.guessed), '_e___');
  eq(E.guess(g, 'e', 6), null, 'repeat ignored');
  eq(E.guess(g, 'E', 6), null, 'repeat ignored (case)');
  eq(E.guess(g, '1', 6), null, 'not a letter');
  eq(E.guess(g, 'ab', 6), null, 'one letter only');
  r = E.guess(g, 'z', 6); ok(!r.hit); g = r.g;
  eq(g.wrong, 1);
  for (const ch of 'mlon') g = E.guess(g, ch, 6).g;
  ok(g.solved && !g.burst, 'solved');
  eq(E.guess(g, 'q', 6), null, 'finished: no more guesses');
  eq(E.revealed(g), 5);
});

test('repeated letters count once and fill every spot', () => {
  let g = E.newGuess('banana');
  const r = E.guess(g, 'a', 6);
  eq(r.count, 3);
  g = r.g;
  eq(E.mask(g.word, g.guessed), '_a_a_a');
});

test('bursting: survives `bands` wrong letters, the next one bursts it', () => {
  for (const bands of [5, 6, 8]) {
    let g = E.newGuess('melon');
    const wrongs = 'qwrtyuipasdfg'.split('');
    for (let k = 0; k < bands; k++) { g = E.guess(g, wrongs[k], bands).g; ok(!g.burst, `alive after ${k + 1}`); }
    g = E.guess(g, wrongs[bands], bands).g;
    ok(g.burst, `burst at ${bands + 1}`);
    eq(g.wrong, bands + 1);
  }
});

test('the old state is never changed', () => {
  const g = E.newGuess('melon');
  E.guess(g, 'm', 6);
  eq(g.guessed, []);
});

/* ---------- Points ---------- */
test('points', () => {
  const solved = { solved: true, wrong: 2 };
  eq(E.points(solved, 6), 14);
  eq(E.points(solved, 6, 1), 17);
  eq(E.points(solved, 6, 2), 16);
  eq(E.points(solved, 6, 3), 15);
  eq(E.points(solved, 6, 4), 14);
  eq(E.points({ solved: false, burst: true, wrong: 7 }, 6, 1), 0);
  eq(E.points({ solved: false, wrong: 1 }, 6), 0, 'unfinished scores nothing');
  eq(E.points(null, 6), 0);
});

test('ranking: points, then solved rounds, then time', () => {
  const r = E.rank([
    { id: 'a', score: 20, solved: 2, ms: 9000 },
    { id: 'b', score: 25, solved: 2, ms: 9999 },
    { id: 'c', score: 20, solved: 2, ms: 5000 },
    { id: 'd', score: 20, solved: 1, ms: 1000 },
  ]);
  eq(r.map((x) => x.id), ['b', 'c', 'a', 'd']);
});

test('pickers take turns in 2 vs 2', () => {
  eq([0, 1, 2, 3].map((r) => E.pickerIndex(r, 2)), [0, 1, 0, 1]);
  eq([0, 1, 2].map((r) => E.pickerIndex(r, 1)), [0, 0, 0]);
});

/* ---------- Daily ---------- */
test('daily: same word all day, everyday word, 5-9 letters, changes by day', () => {
  eq(E.dayNumber('2026-11-11'), 1);
  eq(E.dayNumber('2026-12-11'), 31);
  eq(E.dailyWord(lex, '2026-11-11'), E.dailyWord(lex, '2026-11-11'));
  const seen = new Set();
  const cset = new Set(common);
  for (let d = 1; d <= 60; d++) {
    const day = `2027-01-${String(Math.min(d, 28)).padStart(2, '0')}`;
    const w = E.dailyWord(lex, d <= 28 ? day : `2027-02-${String(d - 28).padStart(2, '0')}`);
    ok(cset.has(w) && w.length >= 5 && w.length <= 9, w);
    seen.add(w);
  }
  ok(seen.size > 50, `varied: ${seen.size}`);
  eq(E.todayStr(new Date(2026, 10, 5)), '2026-11-05');
});

test('share text', () => {
  let g = E.newGuess('melon');
  for (const ch of 'ezmlon') g = E.guess(g, ch, 6).g;
  eq(E.shareText(3, g, 6), '🍉 Melon Burst #3: solved with 1/6 bands\n🟩🟥🟩🟩🟩🟩');
  eq(E.shareText(3, { ...g, ms: 42300 }, 6), '🍉 Melon Burst #3: solved with 1/6 bands in 42.3s\n🟩🟥🟩🟩🟩🟩');
  let b = E.newGuess('melon');
  for (const ch of 'zxqwjk') b = E.guess(b, ch, 5)?.g || b;
  b = { ...b, ms: 75000 };
  ok(b.burst);
  eq(E.shareText(4, b, 5), '💥 Melon Burst #4: burst in 1:15\n🟥🟥🟥🟥🟥🟥');
});

test('daily: the seed can be any string, the word depends only on it', () => {
  eq(E.dailyWord(lex, 'abc'), E.dailyWord(lex, 'abc'));
  const words = new Set(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'].map((k) => E.dailyWord(lex, k)));
  ok(words.size >= 6, `seeds give different words: ${words.size}`);
  eq(E.utcDayStr(new Date('2026-11-13T23:59:59Z')), '2026-11-13');
  eq(E.utcDayStr(new Date('2026-11-14T00:00:00Z')), '2026-11-14');
});

test('daily score: solved beats burst, then fewer wrong, then faster; reads back', () => {
  const played = (word, letters, ms, bands = 6) => {
    let g = E.newGuess(word);
    for (const ch of letters) { const r = E.guess(g, ch, bands); if (r) g = r.g; }
    return { ...g, ms };
  };
  const clean = played('melon', 'melon', 30000);
  const slowClean = played('melon', 'melon', 90000);
  const twoWrong = played('melon', 'zxmelon', 10000);
  const burstClose = played('melon', 'melzxqwjkv', 5000);       // 7 wrong, two letters hidden
  const burstFar = played('melon', 'zxqwjkv', 5000);           // 7 wrong, nothing found
  ok(clean.solved && twoWrong.solved && burstClose.burst && burstFar.burst, 'setup');
  ok(E.dailyScore(clean) < E.dailyScore(slowClean), 'faster wins a tie');
  ok(E.dailyScore(slowClean) < E.dailyScore(twoWrong), 'fewer wrong beats faster');
  ok(E.dailyScore(twoWrong) < E.dailyScore(burstClose), 'any solve beats any burst');
  ok(E.dailyScore(burstClose) < E.dailyScore(burstFar), 'closer burst ranks higher');
  eq(E.dailyParts(E.dailyScore(clean)), { solved: true, wrong: 0, hidden: 0, ms: 30000 });
  eq(E.dailyParts(E.dailyScore(twoWrong)), { solved: true, wrong: 2, hidden: 0, ms: 10000 });
  eq(E.dailyParts(E.dailyScore(burstClose)), { solved: false, wrong: null, hidden: 2, ms: 5000 });
  // A forgotten tab can't overflow into the next column
  const huge = played('melon', 'melon', 1e12);
  eq(E.dailyParts(E.dailyScore(huge)).wrong, 0);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
