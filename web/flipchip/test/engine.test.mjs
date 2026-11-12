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

const { DARK: D, LIGHT: L, EMPTY: _ } = E;
// Board from rows of '.', 'd', 'l'
const parse = (rows) => rows.join('').split('').map((ch) => (ch === 'd' ? D : ch === 'l' ? L : _));

/* ---------- Settings ---------- */
test('settings: defaults and cleaning', () => {
  eq(E.cleanSettings(null), E.DEFAULT_SETTINGS);
  eq(E.cleanSettings({ size: '6', timer: 30, hints: 'off', colours: 'nope', match: '3', extra: 1 }),
    { size: 6, timer: '30', hints: 'off', colours: 'swap', match: '3' });
  eq(E.cleanSettings({ size: 7 }).size, 8);
  eq(E.timerMs({ timer: 'off' }), 0);
  eq(E.timerMs({ timer: '15' }), 15000);
  eq(E.matchTarget({ match: 'open' }), 0);
  eq(E.matchTarget({ match: '3' }), 2);
  eq(E.matchTarget({ match: '5' }), 3);
});

/* ---------- Board ---------- */
test('start position for every size', () => {
  for (const n of E.SIZES) {
    const b = E.newBoard(n);
    eq(b.length, n * n);
    const c = E.counts(b);
    eq([c[1], c[2], c.empty], [2, 2, n * n - 4], `n=${n}`);
    eq(E.legalMoves(b, n, D).length, 4, `n=${n} dark moves`);
    eq(E.legalMoves(b, n, L).length, 4, `n=${n} light moves`);
  }
});

test('the four opening moves on 8x8 are d3 c4 f5 e6', () => {
  const b = E.newBoard(8);
  eq(E.legalMoves(b, 8, D).map((i) => E.cellName(i, 8)).sort(), ['c4', 'd3', 'e6', 'f5']);
});

test('a move flips the trapped chip and nothing else', () => {
  const b = E.newBoard(8);
  const i = 2 * 8 + 3; // d3
  const r = E.play(b, 8, i, D);
  ok(r, 'legal');
  eq(r.flips, [3 * 8 + 3]);
  const c = E.counts(r.board);
  eq([c[1], c[2]], [4, 1]);
  eq(b[i], _, 'original board untouched');
});

test('illegal moves are refused', () => {
  const b = E.newBoard(8);
  eq(E.play(b, 8, 0, D), null, 'corner at start');
  eq(E.play(b, 8, 27, D), null, 'occupied');
  eq(E.play(b, 8, -1, D), null, 'off the board');
  eq(E.play(b, 8, 64, D), null, 'off the board');
  eq(E.play(b, 8, 1.5, D), null, 'not an integer');
  eq(E.play(b, 8, '19', D), null, 'a string');
});

test('flips in several directions at once', () => {
  const b = parse([
    'd...d...',
    '.l..l...',
    '..l.l...',
    '...lll..',
    'dlll.lld',
    '...lll..',
    '..l.l.l.',
    '.d..d..d',
  ]);
  const i = 4 * 8 + 4;
  const flips = E.flipsFor(b, 8, i, D).sort((a, b) => a - b);
  // up (3), up-left (3), left (3), right (2), down (2), down-right (2), down-left: ends at (6,2) l then (7,1) d -> 2; up-right: (3,5) l then (2,6) empty -> 0
  eq(flips.length, 3 + 3 + 3 + 2 + 2 + 2 + 2);
  ok(!flips.includes(3 * 8 + 5), 'up-right is not trapped');
});

test('a line that runs off the board does not flip', () => {
  const b = parse([
    'lll.....',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
  ]);
  eq(E.flipsFor(b, 8, 3, D), []);
  b[3] = _;
  b[0] = D;
  eq(E.flipsFor(b, 8, 3, D).sort(), [1, 2]);
});

test('no wrapping round the edge of a row', () => {
  // dark at the end of row 0, light at the start of row 1: placing next to it must not wrap
  const b = parse([
    '.......d',
    'l.......',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
  ]);
  eq(E.flipsFor(b, 8, 9, D), [], 'b2 does not trap a1 through the row break');
  eq(E.legalMoves(b, 8, D), []);
});

test('pass: the other side goes again when one has no move', () => {
  // Light has no move anywhere, dark still does
  const b = parse([
    'dddddddd',
    'dddddddd',
    'dddddddd',
    'dddddddd',
    'dddddddd',
    'dddddddd',
    'ddddddl.',
    'dddddd..',
  ]);
  ok(!E.hasMove(b, 8, L), 'light stuck');
  ok(E.hasMove(b, 8, D), 'dark can go');
  eq(E.nextTurn(b, 8, D), D, 'dark again');
  eq(E.nextTurn(b, 8, L), D, 'dark next');
});

test('game over when nobody can move, even with empty squares', () => {
  const b = parse([
    'dddddddd',
    'dddddddd',
    'dddddddd',
    'dddddddd',
    'dddddddd',
    'dddddddd',
    'dddddddd',
    'ddddddd.',
  ]);
  eq(E.nextTurn(b, 8, D), 0);
  eq(E.winnerOf(b), D);
});

test('winner and draw', () => {
  eq(E.winnerOf(parse(['dl', 'l.'])), L);
  eq(E.winnerOf(parse(['dl', '..'])), 0);
});

test('cell names', () => {
  eq(E.cellName(0, 8), 'a1');
  eq(E.cellName(63, 8), 'h8');
  eq(E.cellName(2 * 8 + 3, 8), 'd3');
  eq(E.cellName(99, 10), 'j10');
});

/* ---------- Random full games keep the rules ---------- */
function randomGame(n, rnd) {
  let b = E.newBoard(n), turn = D, moves = 0, passes = 0;
  while (turn) {
    const legal = E.legalMoves(b, n, turn);
    if (!legal.length) throw new Error('turn given to a side with no move');
    const m = E.pick(legal, rnd);
    const r = E.play(b, n, m, turn);
    const before = E.counts(b), after = E.counts(r.board);
    if (after[turn] !== before[turn] + 1 + r.flips.length) throw new Error('chip count off');
    if (after.empty !== before.empty - 1) throw new Error('empty count off');
    const next = E.nextTurn(r.board, n, turn);
    if (next === turn) passes++;
    b = r.board; turn = next; moves++;
  }
  return { b, moves, passes };
}

test('2000 random games on every size end cleanly', () => {
  const rnd = E.mulberry32(7);
  let passes = 0;
  for (let k = 0; k < 2000; k++) {
    const n = E.SIZES[k % 3];
    const g = randomGame(n, rnd);
    ok(!E.hasMove(g.b, n, D) && !E.hasMove(g.b, n, L), 'nobody can move at the end');
    ok(g.moves <= n * n - 4, 'never more moves than squares');
    passes += g.passes;
  }
  ok(passes > 0, 'some games had passes');
});

/* ---------- Computer player ---------- */
test('every level always returns a legal move (or -1 when stuck)', () => {
  const rnd = E.mulberry32(11);
  for (const level of ['random', 'easy', 'normal', 'hard']) {
    for (const n of E.SIZES) {
      let b = E.newBoard(n), turn = D, plies = 0;
      while (turn && plies < 14) {
        const m = E.chooseMove(b, n, turn, level, { rnd, ms: 60 });
        ok(E.legalMoves(b, n, turn).includes(m), `${level} n=${n} legal`);
        b = E.play(b, n, m, turn).board;
        turn = E.nextTurn(b, n, turn);
        plies++;
      }
    }
  }
  const stuck = parse(['dddddddd', 'dddddddd', 'dddddddd', 'dddddddd', 'dddddddd', 'dddddddd', 'ddddddl.', 'dddddd..']);
  eq(E.chooseMove(stuck, 8, L, 'hard'), -1);
});

test('normal takes an open corner (hard may save a corner nobody can steal for later)', () => {
  // Dark can take a1 by trapping b2..g7? Simple setup: a1 empty, light on b2, dark on c3.
  const b = parse([
    '........',
    '.l......',
    '..d.....',
    '...dl...',
    '...ld...',
    '........',
    '........',
    '........',
  ]);
  for (const level of ['normal']) {
    let corner = 0;
    for (let s = 0; s < 10; s++) if (E.chooseMove(b, 8, D, level, { rnd: E.mulberry32(s), ms: 150 }) === 0) corner++;
    ok(corner >= 9, `${level} took the corner ${corner}/10`);
  }
});

test('hard finds a forced endgame win', () => {
  // Small endgame: hard must play perfectly with few empties
  const rnd = E.mulberry32(3);
  let wins = 0, games = 0;
  for (let k = 0; k < 6; k++) {
    // random opening to an endgame, then hard vs hard-random check: hard result >= random play result
    let b = E.newBoard(6), turn = D;
    while (turn && E.counts(b).empty > 10) {
      b = E.play(b, 6, E.pick(E.legalMoves(b, 6, turn), rnd), turn).board;
      turn = E.nextTurn(b, 6, turn);
    }
    if (!turn) continue;
    games++;
    // Best achievable for `turn` by exhaustive search vs hard's choice
    const side = turn;
    const solve = (bb, t) => {
      const legal = E.legalMoves(bb, 6, t);
      if (!legal.length) {
        if (!E.hasMove(bb, 6, 3 - t)) { const c = E.counts(bb); return c[side] - c[3 - side]; }
        return solve(bb, 3 - t);
      }
      const vals = legal.map((m) => solve(E.play(bb, 6, m, t).board, 3 - t));
      return t === side ? Math.max(...vals) : Math.min(...vals);
    };
    const best = solve(b, side);
    const m = E.chooseMove(b, 6, side, 'hard', { ms: 2000 });
    const after = E.play(b, 6, m, side).board;
    const next = E.nextTurn(after, 6, side);
    const got = next ? solve(after, next) : (() => { const c = E.counts(after); return c[side] - c[3 - side]; })();
    if (got === best) wins++;
  }
  ok(games > 0, 'reached an endgame');
  eq(wins, games, 'hard played the perfect move every time');
});

function match(levelA, levelB, games, n = 8, seed = 1) {
  const rnd = E.mulberry32(seed);
  let a = 0, b = 0;
  for (let k = 0; k < games; k++) {
    const aSide = k % 2 ? L : D;
    let board = E.newBoard(n), turn = D;
    while (turn) {
      const level = turn === aSide ? levelA : levelB;
      const m = E.chooseMove(board, n, turn, level, { rnd, ms: 80 });
      board = E.play(board, n, m, turn).board;
      turn = E.nextTurn(board, n, turn);
    }
    const w = E.winnerOf(board);
    if (w === aSide) a++; else if (w) b++;
  }
  return [a, b];
}

test('levels are stronger in order', () => {
  const [e, r] = match('easy', 'random', 40, 6, 5);
  ok(e > r, `easy beats random (${e}-${r})`);
  const [nm, ez] = match('normal', 'easy', 20, 6, 6);
  ok(nm >= 15, `normal beats easy (${nm}-${ez})`);
  const [h, nm2] = match('hard', 'normal', 10, 8, 8);
  ok(h >= 7, `hard beats normal (${h}-${nm2})`);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
