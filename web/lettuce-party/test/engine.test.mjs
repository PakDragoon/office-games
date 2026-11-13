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

const text = (f) => readFileSync(new URL(`../words/${f}`, import.meta.url), 'utf8');
const VALID = new Set([...text('valid.txt').split('\n'), ...text('answers.txt').split('\n')].filter(Boolean));
const isWord = (w) => VALID.has(w);

/* ---------- classic scoring (unchanged rules) ---------- */
test('score: plain cases', () => {
  eq(E.score('crane', 'crane'), 'hhhhh');
  eq(E.score('crane', 'ghost'), 'mmmmm');
  eq(E.score('slate', 'crane'), 'mmhmh');
});

test('score: duplicate letters are used up one by one', () => {
  // LEVEL has two E at 1 and 3. EERIE: the E at 1 is green, the first E takes the E at 3, the last E has none left
  eq(E.score('eerie', 'level'), 'nhmmm');
  eq(E.score('speed', 'abide'), 'mmnmn');
  eq(E.score('lever', 'level'), 'hhhhm');
});

/* ---------- counts ---------- */
test('counts: EERIE against LEVEL', () => {
  eq(E.countsFor('eerie', 'level'), [1, 1, 3]);
  eq(E.countsFor('level', 'eerie'), [1, 1, 3]);
});

test('counts: green + yellow + red is always 5, solved is 5 green', () => {
  eq(E.countsFor('crane', 'crane'), [5, 0, 0]);
  eq(E.countsFor('crane', 'ghost'), [0, 0, 5]);
  eq(E.countsFor('slate', 'crane'), [2, 0, 3]);
  for (const [a, b] of [['llama', 'lilac'], ['geese', 'elate'], ['sassy', 'asses'], ['array', 'rarer'], ['mamma', 'manga']]) {
    const [g, y, r] = E.countsFor(a, b);
    eq(g + y + r, 5, `${a}/${b}`);
  }
});

test('counts: a repeated guess letter is yellow only as often as the answer has it', () => {
  // answer ALLOY has two L; guess LLAMA has two L (one green at index 1? no: ALLOY = a,l,l,o,y; LLAMA = l,l,a,m,a)
  eq(E.score('llama', 'alloy'), 'nhnmm');
  eq(E.countsFor('llama', 'alloy'), [1, 2, 2]);
  // answer has one A, guess has A twice: only the first non-green A counts
  eq(E.countsFor('mamma', 'crane'), [0, 1, 4]);
});

test('counts: counts() reads a pattern directly', () => {
  eq(E.counts('hnmmh'), [2, 1, 2]);
  eq(E.counts('mmmmm'), [0, 0, 5]);
});

/* ---------- settings ---------- */
test('settings: defaults', () => {
  eq(E.cleanSettings(null), E.DEFAULT_SETTINGS);
  eq(E.DEFAULT_SETTINGS.mode, 'classic');
  eq(E.DEFAULT_SETTINGS.attempts, 6);
  eq(E.DEFAULT_SETTINGS.ladderTime, 180);
});

test('settings: old saved settings with no mode are a classic room', () => {
  const old = { strict: false, winRule: 'fewest', hard: true, maxRounds: 5, timer: 120 };
  const s = E.cleanSettings(null, old);
  eq(s.mode, 'classic');
  eq(s.attempts, 6);
  eq(s.hard, true);          // hard mode survives in a classic room
  eq(s.timer, 120);
  eq(s.winRule, 'fewest');
});

test('settings: bad mode, attempts and times are ignored', () => {
  const base = E.cleanSettings({ mode: 'counts', attempts: 8, ladderTime: 300 });
  eq(base.mode, 'counts');
  for (const bad of ['hard', 3, null, undefined, {}, [], 'ladder ', 'COUNTS']) {
    eq(E.cleanSettings({ mode: bad }, base).mode, 'counts', `mode ${JSON.stringify(bad)}`);
  }
  for (const bad of [3, 11, 0, -1, 6.5, '7', NaN, Infinity, null, [], {}]) {
    eq(E.cleanSettings({ attempts: bad }, base).attempts, 8, `attempts ${String(bad)}`);
  }
  for (const bad of [0, 30, 90, 600, '120', null]) {
    eq(E.cleanSettings({ ladderTime: bad }, base).ladderTime, 300, `ladderTime ${String(bad)}`);
  }
  for (const bad of [45, -60, '60', null]) eq(E.cleanSettings({ timer: bad }, base).timer, 0);
  eq(E.cleanSettings('nonsense', base), base);
  eq(E.cleanSettings(42, base), base);
  eq(E.cleanSettings({ mode: 'ladder', extra: 1, __proto__: { mode: 'classic' } }, base).mode, 'ladder');
});

test('settings: attempts 4 to 10 and the ladder times are accepted', () => {
  for (let a = 4; a <= 10; a++) eq(E.cleanSettings({ attempts: a }).attempts, a);
  for (const t of [60, 120, 180, 300]) eq(E.cleanSettings({ ladderTime: t }).ladderTime, t);
});

test('settings: hard mode only exists in classic', () => {
  eq(E.cleanSettings({ hard: true }).hard, true);
  eq(E.cleanSettings({ mode: 'counts', hard: true }).hard, false);
  eq(E.cleanSettings({ mode: 'ladder', hard: true }).hard, false);
  const hardClassic = E.cleanSettings({ hard: true });
  eq(E.cleanSettings({ mode: 'counts' }, hardClassic).hard, false);   // switching away turns it off
  eq(E.cleanSettings({ mode: 'classic', hard: true }, E.cleanSettings({ mode: 'ladder' })).hard, true);
});

test('settings: the time limit that applies depends on the mode', () => {
  eq(E.effectiveTimer(E.cleanSettings({ timer: 120, ladderTime: 60 })), 120);
  eq(E.effectiveTimer(E.cleanSettings({ mode: 'counts', timer: 0 })), 0);
  eq(E.effectiveTimer(E.cleanSettings({ mode: 'ladder', timer: 0, ladderTime: 60 })), 60);
  eq(E.effectiveTimer(E.cleanSettings({ mode: 'ladder' })), 180);
});

/* ---------- word ladder ---------- */
test('ladder step: one letter changed, real word, not used before', () => {
  const ladder = ['crane', 'crate'];
  eq(E.ladderStepProblem(ladder, 'irate', isWord), null);
  eq(E.ladderStepProblem(ladder, 'grate', isWord), null);
});

test('ladder step: rejected steps give a clear message', () => {
  const ladder = ['crane', 'crate'];
  eq(E.ladderStepProblem(ladder, 'crate', isWord), 'Change exactly one letter');   // same word
  eq(E.ladderStepProblem(ladder, 'slate', isWord), 'Change exactly one letter');   // two letters
  eq(E.ladderStepProblem(ladder, 'ghost', isWord), 'Change exactly one letter');
  eq(E.ladderStepProblem(ladder, 'crane', isWord), 'Already used');                // one letter, but already in my ladder
  eq(E.ladderStepProblem(ladder, 'qrate', isWord), 'Not a word');                  // one letter, not a word
  eq(E.ladderStepProblem(ladder, 'cra', isWord), 'Not enough letters');
  eq(E.ladderStepProblem(ladder, 'crates', isWord), 'Not enough letters');
  eq(E.ladderStepProblem(ladder, 'CRATE', isWord), 'Not enough letters');          // the server lower-cases first
  eq(E.ladderStepProblem(ladder, 5, isWord), 'Not enough letters');
});

test('ladder step: going back to an earlier word is a repeat', () => {
  eq(E.ladderStepProblem(['crane', 'crate', 'irate'], 'crate', isWord), 'Already used');
  eq(E.ladderStepProblem(['crane', 'crate', 'crape'], 'crane', isWord), 'Already used');
  eq(E.ladderStepProblem(['crane', 'crate', 'irate', 'orate'], 'crane', isWord), 'Change exactly one letter');
});

test('ladder: matchCount and diffCount', () => {
  eq(E.diffCount('crane', 'crate'), 1);
  eq(E.matchCount('crane', 'crate'), 4);
  eq(E.matchCount('abcde', 'vwxyz'), 0);
  eq(E.matchCount('crane', 'crane'), 5);
});

/* ---------- ladder pairs file ---------- */
const PAIRS = text('ladders.txt').split('\n').filter(Boolean);

test('ladders.txt: sorted, one pair per line, no duplicates', () => {
  ok(PAIRS.length >= 1000 && PAIRS.length <= 4000, `${PAIRS.length} pairs`);
  const sorted = [...PAIRS].sort();
  eq(PAIRS, sorted);
  eq(new Set(PAIRS.map((l) => l.split(' ').slice(0, 2).join(' '))).size, PAIRS.length);
});

test('ladders.txt: every line is a real shortest-looking path of 3 to 6 steps through real words', () => {
  const answers = new Set(text('answers.txt').split('\n').filter(Boolean));
  const par = { 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const line of PAIRS) {
    const p = E.parsePair(line);
    ok(p, `unparseable: ${line}`);
    ok(p.par >= 3 && p.par <= 6, `par ${p.par}: ${line}`);
    ok(answers.has(p.start) && answers.has(p.target), `ends must be common words: ${line}`);
    eq(p.path.length, p.par + 1, line);
    for (let i = 1; i < p.path.length; i++) {
      eq(E.diffCount(p.path[i - 1], p.path[i]), 1, `step ${i} of ${line}`);
      ok(isWord(p.path[i]), `${p.path[i]} is not a word (${line})`);
    }
    eq(new Set(p.path).size, p.path.length, `repeated word in ${line}`);
    // A path of par steps can't be shorter than the letters that differ
    ok(E.diffCount(p.start, p.target) <= p.par, line);
    par[p.par]++;
  }
  for (const k of [3, 4, 5, 6]) ok(par[k] > 50, `par ${k} has only ${par[k]} pairs`);
});

test('ladders.txt: no blocked word anywhere in a path', async () => {
  const { BLOCKED_ANSWERS } = await import('../js/words.js');
  const blocked = new Set(BLOCKED_ANSWERS);
  for (const line of PAIRS) for (const w of line.split(' ').filter((x) => /^[a-z]{5}$/.test(x))) ok(!blocked.has(w), `${w} in ${line}`);
});

test('parsePair: rejects broken lines', () => {
  eq(E.parsePair('crane slate 3 crate'), null);          // wrong number of words for the par
  eq(E.parsePair('crane slate x crate irate'), null);
  eq(E.parsePair('crane slate 2 crate'), null);          // par under 3 is never used
  eq(E.parsePair('crane slate 3 crate irate').path, ['crane', 'crate', 'irate', 'slate']);
});

test('pickPair: any random number gives a whole line, and skipped lines are avoided', () => {
  for (const r of [0, 0.0001, 0.3, 0.5, 0.77, 0.9999999]) {
    const p = E.pickPair(PAIRS.join('\n') + '\n', () => r);
    ok(p && p.path.length === p.par + 1, `r=${r}`);
  }
  const two = 'aaaaa bbbbb 3 aaaab aaabb\nccccc ddddd 3 cccce ccdde\n';
  for (let i = 0; i < 40; i++) {
    let k = i;
    const rnd = () => ((k++ * 0.37 + 0.11) % 1);
    eq(E.pickPair(two, rnd, (l) => l.startsWith('aaaaa')).start, 'ccccc');
  }
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
