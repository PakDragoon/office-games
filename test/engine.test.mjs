// Engine tests: node test/engine.test.mjs
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

test('settings: defaults and cleaning', () => {
  eq(E.cleanSettings(null), E.DEFAULT_SETTINGS);
  eq(E.cleanSettings({ length: 'long', caps: 'off', punct: 'off', x: 1 }), { length: 'long', caps: 'off', punct: 'off' });
  eq(E.cleanSettings({ length: 'huge', caps: true, punct: 0 }), E.DEFAULT_SETTINGS);
});

test('passages: plenty, plain keys only, no repeats', () => {
  ok(E.PASSAGES.length >= 20, `only ${E.PASSAGES.length}`);
  eq(new Set(E.PASSAGES).size, E.PASSAGES.length);
  for (const p of E.PASSAGES) {
    const bad = p.match(/[^A-Za-z0-9 .,?!:;"'-]/);
    if (bad) throw new Error(`"${bad[0]}" in: ${p.slice(0, 40)}`);
    ok(!/ {2}/.test(p) && p === p.trim(), `spacing in: ${p.slice(0, 40)}`);
    ok(/[.?!]$/.test(p), `no ending: ${p.slice(0, 40)}`);
  }
});

test('lengths: short, medium and long are the sizes they say', () => {
  const range = { short: [20, 50], medium: [45, 85], long: [90, 135] };
  for (const [i, p] of E.PASSAGES.entries()) {
    for (const length of ['short', 'medium', 'long']) {
      const text = E.cut(p, length);
      const n = E.wordCount(text);
      const [lo, hi] = range[length];
      ok(n >= lo && n <= hi, `passage ${i} ${length}: ${n} words`);
      ok(p.startsWith(text), `passage ${i} ${length} isn't the start of the passage`);
      ok(/[.?!]"?$/.test(text), `passage ${i} ${length} ends mid-sentence`);
    }
    ok(E.cut(p, 'short').length < E.cut(p, 'medium').length && E.cut(p, 'medium').length < E.cut(p, 'long').length, `passage ${i} sizes don't grow`);
  }
});

test('options: capitals and punctuation can be switched off', () => {
  const raw = 'Wait, what? It is sixty-four: "check" and the 1870s.';
  eq(E.strip(raw, { caps: 'on', punct: 'on' }), raw);
  eq(E.strip(raw, { caps: 'off', punct: 'on' }), 'wait, what? it is sixty-four: "check" and the 1870s.');
  eq(E.strip(raw, { caps: 'on', punct: 'off' }), 'Wait what It is sixty four check and the 1870s');
  eq(E.strip(raw, { caps: 'off', punct: 'off' }), 'wait what it is sixty four check and the 1870s');
  for (const i of E.PASSAGES.keys()) {
    for (const length of ['short', 'medium', 'long']) {
      const plain = E.makeText(i, { length, caps: 'off', punct: 'off' });
      ok(/^[a-z0-9]+( [a-z0-9]+)*$/.test(plain), `passage ${i} ${length} plain: ${plain.slice(0, 50)}`);
      const full = E.makeText(i, { length, caps: 'on', punct: 'on' });
      eq(E.wordCount(plain) >= E.wordCount(full), true, 'word count');
      ok(/[A-Z]/.test(full) && /[.,]/.test(full));
    }
  }
});

test('passage picking avoids repeats until all are used', () => {
  const rnd = E.mulberry32(5);
  const used = new Set();
  for (let k = 0; k < E.PASSAGES.length; k++) {
    const i = E.pickPassage(rnd, used);
    ok(!used.has(i), 'repeat');
    used.add(i);
  }
  const again = E.pickPassage(rnd, used);
  ok(again >= 0 && again < E.PASSAGES.length);
});

test('keys: right, wrong, capitals, curly quotes', () => {
  const on = { caps: 'on' }, off = { caps: 'off' };
  ok(E.hit('a', 'a', on));
  ok(!E.hit('a', 'b', on));
  ok(!E.hit('A', 'a', on), 'capitals matter when on');
  ok(E.hit('a', 'A', off), 'caps lock is fine when off');
  ok(E.hit(' ', ' ', on));
  ok(E.hit(' ', ' ', on));
  ok(E.hit("'", '’', on) && E.hit('"', '“', on) && E.hit('-', '—', on));
  ok(!E.hit('a', '', on) && !E.hit('a', 'ab', on) && !E.hit('', 'a', on) && !E.hit(undefined, 'a', on));
});

test('speed and accuracy', () => {
  eq(E.wpm(300, 60000), 60);
  eq(E.wpm(250, 30000), 100);
  eq(E.wpm(0, 1000), 0);
  eq(E.wpm(100, 0), 0);
  eq(E.wpm(5000, 1000), E.MAX_WPM, 'capped');
  eq(E.accuracy(0, 0), 100);
  eq(E.accuracy(95, 5), 95);
  eq(E.accuracy(0, 3), 0);
});

test('made-up progress is refused, real typing is not', () => {
  ok(E.plausible(0, 0));
  ok(E.plausible(100, 10000), '120 wpm');
  ok(E.plausible(180, 10000), '216 wpm');
  ok(!E.plausible(600, 2000), 'a whole paragraph in two seconds');
  ok(!E.plausible(400, 10000));
});

test('time limits', () => {
  eq(E.limitMs('one two three'), 45000);
  eq(E.limitMs(Array(100).fill('word').join(' ')), 400000);
  eq(E.graceMs(10000), 20000);
  eq(E.graceMs(60000), 90000);
});

test('ranking: finishers by time, then the furthest along', () => {
  const rows = [
    { id: 'a', done: false, pos: 90, err: 1, ms: 0 },
    { id: 'b', done: true, pos: 100, err: 9, ms: 31000 },
    { id: 'c', done: true, pos: 100, err: 0, ms: 28000 },
    { id: 'd', done: false, pos: 95, err: 0, ms: 0 },
    { id: 'e', done: false, pos: 95, err: 4, ms: 0 },
  ];
  eq(E.rank(rows).map((r) => r.id), ['c', 'b', 'd', 'e', 'a']);
});

test('formatting', () => {
  eq(E.formatMs(12340), '12.3s');
  eq(E.formatMs(75000), '1:15');
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
