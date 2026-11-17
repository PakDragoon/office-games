// Hot & Cold tests: node test/hotcold.test.mjs (reads the built data in server/src/data)
import { readFileSync } from 'node:fs';
import * as E from '../js/engine.js';
import * as H from '../js/hotcold.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { failed++; console.log(`✗ ${name}\n  ${err.message}`); }
}
function eq(a, b, msg = '') {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg} expected ${y}, got ${x}`);
}
function ok(v, msg = 'expected true') { if (!v) throw new Error(msg); }

const data = (f) => readFileSync(new URL(`../../../server/src/data/${f}`, import.meta.url));
const buffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
const WORDS = data('hotcold-words.txt').toString('utf8');
const VEC = H.readVectors(buffer(data('hotcold.bin')));
const TARGETS = buffer(data('hotcold-targets.bin'));
const SECRET = data('hotcold-targets.txt').toString('utf8').split('\n').filter(Boolean);
const index = (w) => H.indexOfWord(WORDS, w);
const target = (w) => { for (let t = 0; t < H.targetCount(TARGETS); t++) { const x = H.readTarget(TARGETS, t); if (H.wordAt(WORDS, x.index) === w) return x; } return null; };

/* ---------- the data files ---------- */
test('word list: sorted, padded, and every word found by the binary search', () => {
  const n = WORDS.length / H.WIDTH;
  eq(n, VEC.count, 'one vector per word:');
  let prev = '';
  for (let i = 0; i < n; i++) {
    const w = H.wordAt(WORDS, i);
    ok(/^[a-z]{2,14}$/.test(w), `bad word "${w}"`);
    ok(w > prev, `not sorted at ${w}`);
    if (i % 97 === 0) eq(index(w), i, w);
    prev = w;
  }
  eq(index('qzxv'), -1);
  eq(index(''), -1);
  eq(index('a'.repeat(20)), -1);
});

test('every secret word is guessable and has its own entry', () => {
  eq(H.targetCount(TARGETS), SECRET.length);
  for (const w of SECRET) ok(target(w), `${w} has no entry`);
});

test('no offensive word can be guessed', () => {
  for (const w of ['fuck', 'shit', 'cunt', 'nigger', 'porn']) eq(index(w), -1, w);
});

/* ---------- ranks ---------- */
test('the word itself is 1, its closest words are 2, 3, 4…, and closer always ranks better', () => {
  for (const w of ['pizza', 'dog', 'guitar', 'mountain', 'doctor']) {
    const t = target(w);
    const pr = H.probe(VEC, t.index);
    eq(H.rankOf(VEC, t, pr, t.index), 1, w);
    for (let k = 0; k < 5; k++) eq(H.rankOf(VEC, t, pr, t.near[k]), k + 2, `${w} near ${k}`);
    // Beyond the list: closeness order and rank order agree
    const sample = Array.from({ length: 400 }, (_, i) => (i * 7919 + 13) % VEC.count).filter((i) => i !== t.index);
    const by = sample.map((i) => [H.closeness(VEC, i, pr), H.rankOf(VEC, t, pr, i)]).sort((a, b) => b[0] - a[0]);
    for (let i = 1; i < by.length; i++) ok(by[i][1] >= by[i - 1][1], `${w}: a further word ranked better`);
    ok(by.every(([, r]) => r >= 1 && r <= VEC.count), 'ranks stay in range');
  }
});

test('ranks make sense: pizza is near burger and far from democracy', () => {
  const t = target('pizza');
  const pr = H.probe(VEC, t.index);
  ok(H.rankOf(VEC, t, pr, index('burger')) < 20);
  ok(H.rankOf(VEC, t, pr, index('cheese')) < 50);
  ok(H.rankOf(VEC, t, pr, index('democracy')) > 5000);
});

test('ranks by table land near the truth (within 15% of the exact rank)', () => {
  const t = target('dog');
  const pr = H.probe(VEC, t.index);
  const all = Array.from({ length: VEC.count }, (_, i) => [i, H.closeness(VEC, i, pr)]).filter(([i]) => i !== t.index).sort((a, b) => b[1] - a[1]);
  for (const truth of [150, 700, 3000, 9000, 18000]) {
    const r = H.rankOf(VEC, t, pr, all[truth - 2][0]);
    ok(Math.abs(r - truth) <= truth * 0.15, `exact ${truth}, table says ${r}`);
  }
});

/* ---------- rules ---------- */
test('typed words are tidied or refused', () => {
  eq(E.cleanHotWord('  Pizza '), 'pizza');
  eq(E.cleanHotWord('ice cream'), '');
  eq(E.cleanHotWord('x'), '');
  eq(E.cleanHotWord(42), '');
});

test('best rank ignores hints', () => {
  eq(E.bestRank([]), null);
  eq(E.bestRank([{ rank: 40 }, { rank: 9, hint: true }, { rank: 120 }]), 40);
});

test('a hint aims halfway to the word, starts at 1000, and stops near the end', () => {
  eq(E.hintRank(null), 1000);
  eq(E.hintRank(800), 400);
  eq(E.hintRank(5), 2);
  eq(E.hintRank(3), null);
});

test('temperatures', () => {
  eq([1, 7, 60, 300, 1500, 9000].map(E.temperature), ['found', 'burning', 'hot', 'warm', 'cool', 'cold']);
});

test('standings: found first (fastest), then best rank, then fewer guesses; no guess, no place', () => {
  const order = E.hotOrder([
    { id: 'a', best: 12, solved: false, used: 9 },
    { id: 'b', best: 1, solved: true, finishMs: 90000, used: 30 },
    { id: 'c', best: null, solved: false, used: 0 },
    { id: 'd', best: 12, solved: false, used: 4 },
    { id: 'e', best: 1, solved: true, finishMs: 40000, used: 50 },
  ]).map((p) => p.id);
  eq(order, ['e', 'b', 'd', 'a']);
});

test('settings: its own time limit and hint switch, always timed', () => {
  const s = E.cleanSettings({ mode: 'hotcold' }, null);
  eq([s.hotTime, s.hotHints, E.effectiveTimer(s)], [180, true, 180]);
  eq(E.cleanSettings({ mode: 'hotcold', hotTime: 0 }, null).hotTime, 180, 'no "no timer" in Hot & Cold');
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
