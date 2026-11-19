// Engine tests: node test/engine.test.mjs
import * as E from '../js/engine.js';
import assert from 'node:assert/strict';

let n = 0;
const ok = (name, fn) => {
  try { fn(); } catch (err) { console.error(`✗ ${name}`); throw err; }
  n++;
};
const seeded = (seed) => { let a = seed; return () => ((a = (a * 16807) % 2147483647) / 2147483647); };
// Most rule tests play each 6 before rolling again ('move'); the 'stack' default has tests of its own below
const game = (settings = {}, colours = [0, 1, 2, 3], first = 0) => E.newGame({ sixRule: 'move', ...settings }, colours, first);
/** Put tokens where a test needs them: { 0: [p, p, ...], 2: [...] }. */
const place = (g, at) => { for (const [c, list] of Object.entries(at)) list.forEach((p, i) => { g.tokens[c][i] = p; }); return g; };
const rollMove = (g, v, c, i) => { assert.ok(E.roll(g, v), 'roll accepted'); return E.move(g, c, i); };

ok('settings: only the offered choices, defaults otherwise', () => {
  assert.deepEqual(E.cleanSettings(null), E.DEFAULT_SETTINGS);
  assert.equal(E.DEFAULT_SETTINGS.sixRule, 'stack');
  assert.equal(E.cleanSettings({ sixRule: 'move' }).sixRule, 'move');
  assert.equal(E.cleanSettings({ sixRule: 'later' }).sixRule, 'stack');
  const s = E.cleanSettings({ tokens: 2, leave: 'oneSix', timer: 30, safe: 'none', blocks: true, teams: true, end: 'all', exact: false });
  assert.equal(s.tokens, 2); assert.equal(s.leave, 'oneSix'); assert.equal(s.timer, 30); assert.equal(s.safe, 'none');
  assert.equal(s.blocks, true); assert.equal(s.teams, true); assert.equal(s.end, 'all'); assert.equal(s.exact, false);
  const bad = E.cleanSettings({ tokens: 9, leave: 'any', timer: 7, safe: 'x', blocks: 'yes', threeSixes: 1, end: 'never' });
  assert.equal(bad.tokens, 4); assert.equal(bad.leave, 'six'); assert.equal(bad.timer, 15); assert.equal(bad.safe, 'stars');
  assert.equal(bad.blocks, false); assert.equal(bad.threeSixes, 'lose'); assert.equal(bad.end, 'first');
});

ok('board: 52 different track squares, lanes and yards never overlap the track', () => {
  const key = ([c, r]) => `${c},${r}`;
  const track = new Set();
  for (let a = 0; a < 52; a++) {
    const [c, r] = E.trackCell(a);
    assert.ok(c >= 0 && c < 15 && r >= 0 && r < 15);
    // On the cross: row or column 6, 7 or 8, never inside a yard or the centre
    assert.ok((c >= 6 && c <= 8) || (r >= 6 && r <= 8));
    assert.ok(!(c >= 6 && c <= 8 && r >= 6 && r <= 8));
    track.add(key([c, r]));
    // Neighbouring squares touch (the track cuts each inner corner diagonally, as on every Ludo board)
    const [c2, r2] = E.trackCell((a + 1) % 52);
    assert.equal(Math.max(Math.abs(c - c2), Math.abs(r - r2)), 1, `squares ${a} and ${a + 1} touch`);
  }
  assert.equal(track.size, 52);
  for (let col = 0; col < 4; col++) {
    for (let j = 0; j < 5; j++) assert.ok(!track.has(key(E.laneCell(col, j))));
    // The lane starts next to the square in front of it
    const [c, r] = E.trackCell(E.absOf(col, E.LAST_TRACK));
    const [lc, lr] = E.laneCell(col, 0);
    assert.equal(Math.abs(c - lc) + Math.abs(r - lr), 1);
    // A colour's start square is in its own arm, next to its own yard
    assert.equal(E.absOf(col, 0), E.STARTS[col]);
  }
  // Colour 0 starts at the top-left arm, colour 2 at the bottom-right
  assert.deepEqual(E.trackCell(0), [1, 6]);
  assert.deepEqual(E.trackCell(26), [13, 8]);
});

ok('a token leaves the yard only on a 6 (or a 1 too, when the room allows it)', () => {
  const g = game();
  E.roll(g, 3);
  assert.equal(g.phase, 'pass');
  assert.equal(g.passWhy, 'nomove');
  E.pass(g);
  assert.equal(g.turn, 1);
  E.roll(g, 6);
  assert.equal(g.phase, 'move');
  assert.equal(E.distinctMoves(g.legal).length, 1);
  E.move(g, 1, 2);
  assert.equal(g.tokens[1][2], 0);
  assert.equal(g.turn, 1, 'a 6 rolls again');
  const g2 = game({ leave: 'oneSix' });
  E.roll(g2, 1);
  assert.equal(g2.phase, 'move');
});

ok('moves count squares, and a token turns into its own lane', () => {
  const g = place(game(), { 0: [10, E.BASE, E.BASE, E.BASE] });
  const m = rollMove(g, 4, 0, 0);
  assert.deepEqual(m.path, [11, 12, 13, 14]);
  assert.equal(g.tokens[0][0], 14);
  const h = place(game(), { 0: [48] });
  const m2 = rollMove(h, 5, 0, 0);
  assert.deepEqual(m2.path, [49, 50, 52, 53, 54]);
});

ok('exact roll to get home (or not, when the room turns it off)', () => {
  const g = place(game(), { 0: [55, E.BASE, E.BASE, E.BASE] });
  E.roll(g, 3);
  assert.equal(g.phase, 'pass');
  const g2 = place(game(), { 0: [55, E.BASE, E.BASE, E.BASE] });
  const m = rollMove(g2, 2, 0, 0);
  assert.equal(m.home, true);
  const g3 = place(game({ exact: false }), { 0: [55, E.BASE, E.BASE, E.BASE] });
  const m3 = rollMove(g3, 5, 0, 0);
  assert.equal(m3.to, E.HOME);
  assert.deepEqual(m3.path, [56, 57]);
});

ok('landing on a rival sends it back to its yard and gives another roll', () => {
  // Red at its square 10 (abs 10); green token at abs 14 = green's p 1
  const g = place(game(), { 0: [10], 1: [1] });
  const m = rollMove(g, 4, 0, 0);
  assert.equal(m.cap.length, 1);
  assert.equal(g.tokens[1][0], E.BASE);
  assert.equal(g.stats[0].captures, 1);
  assert.equal(g.stats[1].captured, 1);
  assert.equal(g.turn, 0, 'capture bonus');
  const ev = g.events.at(-1);
  assert.equal(ev.k, 'move');
  assert.deepEqual(ev.cap, [{ c: 1, i: 0, from: 1 }]);
  // Without the capture bonus the turn moves on
  const g2 = place(game({ bonusCapture: false }), { 0: [10], 1: [1] });
  rollMove(g2, 4, 0, 0);
  assert.equal(g2.turn, 1);
});

ok('safe squares: start squares and stars, or start squares only, or none', () => {
  // Green token on abs 21 (a star) = green p 8
  const star = () => place(game(), { 0: [17], 1: [8] });
  const g = star();
  const m = rollMove(g, 4, 0, 0);
  assert.equal(m.cap.length, 0);
  assert.equal(g.tokens[1][0], 8, 'both share the star');
  const g2 = place(game({ safe: 'starts' }), { 0: [17], 1: [8] });
  assert.equal(rollMove(g2, 4, 0, 0).cap.length, 1);
  // Start squares stay safe under 'starts'; nothing is safe under 'none'
  const g3 = place(game({ safe: 'starts' }), { 0: [9], 1: [0] });
  assert.equal(rollMove(g3, 4, 0, 0).cap.length, 0);
  const g4 = place(game({ safe: 'none' }), { 0: [9], 1: [0] });
  assert.equal(rollMove(g4, 4, 0, 0).cap.length, 1);
});

ok('blocks: two rival tokens on a square stop others passing or landing', () => {
  const at = { 0: [10, 20, E.BASE, E.BASE], 1: [1, 1] };   // green pair on abs 14
  const g = place(game({ blocks: true }), at);
  E.roll(g, 5);
  // Token 0 (abs 10) can't pass abs 14; token 1 can move
  assert.deepEqual(g.legal.map((m) => m.i), [1]);
  // Without the rule both move, and landing on the pair takes both
  const g2 = place(game({ blocks: false }), at);
  const m = rollMove(g2, 4, 0, 0);
  assert.equal(m.cap.length, 2);
  // A block on your start square keeps you in the yard
  const g3 = place(game({ blocks: true, safe: 'none' }), { 0: [E.BASE, E.BASE], 3: [13, 13] });   // blue p 13 = abs 0
  E.roll(g3, 6);
  assert.equal(g3.phase, 'pass');
});

ok('must capture first: the token goes round again until its colour has sent someone home', () => {
  const g = place(game({ mustCapture: true }), { 0: [48] });
  const m = rollMove(g, 5, 0, 0);
  assert.deepEqual(m.path, [49, 50, 51, 0, 1]);
  const g2 = place(game({ mustCapture: true }), { 0: [48] });
  g2.killed[0] = true;
  assert.deepEqual(rollMove(g2, 5, 0, 0).path, [49, 50, 52, 53, 54]);
});

ok('three 6s in a row lose the turn (unless allowed); the count starts again each turn', () => {
  const g = place(game(), { 0: [5, E.BASE, E.BASE, E.BASE] });
  rollMove(g, 6, 0, 0);
  rollMove(g, 6, 0, 0);
  E.roll(g, 6);
  assert.equal(g.phase, 'pass');
  assert.equal(g.passWhy, 'sixes');
  E.pass(g);
  assert.equal(g.turn, 1);
  const g2 = place(game({ threeSixes: 'allow' }), { 0: [5, E.BASE, E.BASE, E.BASE] });
  rollMove(g2, 6, 0, 0); rollMove(g2, 6, 0, 0);
  E.roll(g2, 6);
  assert.equal(g2.phase, 'move');
  // Without the 6 bonus a 6 ends the turn like any roll
  const g3 = place(game({ bonusSix: false }), { 0: [5] });
  rollMove(g3, 6, 0, 0);
  assert.equal(g3.turn, 1);
});

ok('roll all first: a 6 rolls again straight away, then every roll is used in any order', () => {
  const g = E.newGame({}, [0, 1, 2, 3], 0);
  assert.ok(E.roll(g, 6));
  assert.equal(g.phase, 'roll');
  assert.deepEqual(g.rolls, [6]);
  assert.ok(E.roll(g, 3));
  assert.equal(g.phase, 'move');
  assert.deepEqual(g.rolls, [6, 3]);
  // Only the 6 can bring a token out; the 3 has nothing to move yet
  assert.deepEqual([...new Set(g.legal.map((m) => m.v))], [6]);
  const out = E.move(g, 0, 0);
  assert.equal(out.v, 6);
  assert.deepEqual(g.rolls, [3]);
  assert.equal(g.phase, 'move');
  assert.deepEqual(g.legal.map((m) => [m.i, m.v]), [[0, 3]]);
  E.move(g, 0, 0);
  assert.equal(g.tokens[0][0], 3);
  assert.equal(g.turn, 1, 'all rolls used, no capture: next player');
  // Two 6s and a 4: three moves, the player picks which roll each token uses
  const h = place(E.newGame({}, [0, 2], 0), { 0: [10, 20, E.BASE, E.BASE] });
  E.roll(h, 6); E.roll(h, 6); E.roll(h, 4);
  assert.deepEqual(h.rolls, [6, 6, 4]);
  E.move(h, 0, 1, h.legal.find((m) => m.i === 1 && m.v === 4).r);
  assert.equal(h.tokens[0][1], 24);
  assert.deepEqual(h.rolls, [6, 6]);
  E.move(h, 0, 0); E.move(h, 0, 0);
  assert.equal(h.tokens[0][0], 22);
  assert.equal(h.turn, 2);
});

ok('roll all first: a third 6 loses every waiting roll; unusable rolls are dropped; a capture rolls again at the end', () => {
  const g = place(E.newGame({}, [0, 1, 2, 3], 0), { 0: [10] });
  E.roll(g, 6); E.roll(g, 6); E.roll(g, 6);
  assert.equal(g.phase, 'pass');
  assert.deepEqual(g.rolls, []);
  E.pass(g);
  assert.equal(g.turn, 1);
  // Exact roll needed: the 6 can't be used once the 1 is spent, so it is dropped and the turn moves on
  const h = place(E.newGame({}, [0, 1], 0), { 0: [55, E.HOME, E.HOME, E.HOME] });
  E.roll(h, 6); E.roll(h, 1);
  assert.deepEqual(h.legal.map((m) => m.v), [1]);
  E.move(h, 0, 0);
  assert.equal(h.turn, 1);
  assert.deepEqual(h.rolls, []);
  // A capture with the first roll: the second roll is still played, then the same player rolls again
  const k = place(E.newGame({}, [0, 1, 2, 3], 0), { 0: [10, 30], 1: [1] });   // green on abs 14
  E.roll(k, 6); E.roll(k, 4);
  E.move(k, 0, 0, k.legal.find((m) => m.i === 0 && m.v === 4).r);
  assert.equal(k.tokens[1][0], E.BASE);
  assert.equal(k.phase, 'move');
  E.move(k, 0, 1);
  assert.equal(k.turn, 0);
  assert.equal(k.phase, 'roll');
  // With the 6 bonus off, 'stack' changes nothing: a 6 is played like any roll
  const m = E.newGame({ bonusSix: false }, [0, 1], 0);
  E.roll(m, 6);
  assert.equal(m.phase, 'move');
});

ok('reaching home gives another roll (when on); the first one home wins', () => {
  const g = place(game({ tokens: 2 }), { 0: [55, 56] });
  rollMove(g, 2, 0, 0);
  assert.equal(g.turn, 0);
  rollMove(g, 1, 0, 1);
  assert.equal(g.phase, 'over');
  assert.deepEqual(g.result.winners, [0]);
  assert.equal(g.result.places[0], 1);
  assert.equal(g.events.some((e) => e.k === 'done' && e.c === 0), true);
});

ok('play on for every place: finished colours are skipped until one is left', () => {
  const g = place(game({ tokens: 2, end: 'all' }, [0, 1, 2]), { 0: [56, E.HOME] });
  rollMove(g, 1, 0, 0);
  assert.notEqual(g.phase, 'over');
  assert.equal(g.turn, 1);
  assert.deepEqual(E.controls(g, 0), []);
  place(g, { 1: [E.HOME, 56] });
  rollMove(g, 1, 1, 1);
  assert.equal(g.phase, 'over');
  assert.deepEqual(g.result.order, [0, 1, 2]);
});

ok('teams: partners never capture each other, a finished player moves their partner, both home wins', () => {
  const g = place(game({ teams: true, tokens: 2 }), { 0: [10, E.BASE], 2: [E.BASE, E.BASE] });
  // Yellow (2) token at abs 14 = yellow p 40
  place(g, { 2: [40] });
  const m = rollMove(g, 4, 0, 0);
  assert.equal(m.cap.length, 0, 'partner not captured');
  // Red finishes; on red's turn red moves yellow's tokens
  const h = place(game({ teams: true, tokens: 2 }), { 0: [E.HOME, 56], 2: [3, E.BASE] });
  rollMove(h, 1, 0, 1);
  assert.equal(h.phase, 'roll');
  assert.deepEqual(E.controls(h, 0), [2]);
  h.turn = 0;
  E.roll(h, 2);
  assert.deepEqual(h.legal.map((x) => x.c), [2]);
  E.move(h, 2, 0);
  assert.equal(h.tokens[2][0], 5);
  place(h, { 2: [56, E.HOME] });
  h.turn = 2; h.phase = 'roll';
  rollMove(h, 1, 2, 0);
  assert.equal(h.phase, 'over');
  assert.deepEqual(h.result.winners.sort(), [0, 2]);
  assert.equal(h.result.places[1], 2);
  // Teams need all four colours
  assert.equal(game({ teams: true }, [0, 2]).settings.teams, false);
});

ok('stale or wrong moves are refused', () => {
  const g = place(game(), { 0: [5, E.BASE] });
  assert.equal(E.move(g, 0, 0), null, 'not before rolling');
  E.roll(g, 2);
  assert.equal(E.roll(g, 3), false, 'one roll at a time');
  assert.equal(E.move(g, 0, 1), null, 'a token in the yard on a 2');
  assert.equal(E.move(g, 1, 0), null, 'another colour');
  assert.ok(E.move(g, 0, 0));
});

ok('spots: every position has a place on the board, all inside it', () => {
  for (let c = 0; c < 4; c++) {
    for (let p = -1; p <= 57; p++) {
      const [x, y] = E.spot(c, p, 0);
      assert.ok(x > 0 && x < 15 && y > 0 && y < 15, `${c}:${p}`);
    }
    // Yard spots sit inside the colour's yard
    const [x, y] = E.spot(c, E.BASE, 3);
    const [yc, yr] = E.rotCell([0, 0], c);
    assert.ok(Math.abs(x - (yc < 7 ? 3 : 12)) < 2 && Math.abs(y - (yr < 7 ? 3 : 12)) < 2);
  }
});

// Random games with random rules: invariants after every step, and every game ends
ok('thousands of random games keep the rules and always finish', () => {
  const rnd = seeded(12345);
  const pickOf = (list) => list[Math.floor(rnd() * list.length)];
  let games = 0;
  let caps = 0;
  for (let k = 0; k < 1200; k++) {
    const settings = {
      tokens: pickOf(E.TOKENS), leave: pickOf(['six', 'oneSix']), bonusSix: rnd() < 0.8, sixRule: pickOf(['stack', 'move']), bonusCapture: rnd() < 0.7, bonusHome: rnd() < 0.7,
      threeSixes: pickOf(['lose', 'allow']), safe: pickOf(['stars', 'starts', 'none']), blocks: rnd() < 0.3, mustCapture: rnd() < 0.25,
      exact: rnd() < 0.7, end: pickOf(['first', 'all']), teams: rnd() < 0.25,
    };
    const colours = pickOf([[0, 2], [0, 1, 2], [0, 1, 2, 3], [1, 3], [0, 1], [1, 2, 3]]);
    const g = E.newGame(settings, colours, pickOf(colours));
    let steps = 0;
    while (g.phase !== 'over') {
      assert.ok(++steps < 20000, 'game ends');
      const before = g.seq;
      if (g.phase === 'roll') E.roll(g, E.die(rnd()));
      else if (g.phase === 'pass') E.pass(g);
      else {
        const m = E.chooseMove(g, rnd() < 0.5 ? 'easy' : 'normal', rnd);
        assert.ok(E.move(g, m.c, m.i, m.r));
        caps += m.cap.length;
      }
      assert.ok(g.seq === before + 1);
      // Invariants: positions in range, the colour to play can play, no rival tokens share an unsafe square
      for (const c of g.colours) for (const p of g.tokens[c]) assert.ok(p === -1 || (p >= 0 && p <= 57));
      if (g.phase !== 'over') assert.ok(E.controls(g, g.turn).length > 0, 'the player to move has tokens to move');
      if (g.settings.blocks === false && steps % 5 === 0) {
        for (let a = 0; a < 52; a++) {
          if (E.isSafe(g.settings, a)) continue;
          const here = E.tokensAt(g, a);
          const cols = new Set(here.map((t) => (g.settings.teams ? t.c % 2 : t.c)));
          assert.ok(cols.size <= 1, `rivals sharing unsafe square ${a}`);
        }
      }
    }
    assert.ok(g.result.order.length === g.colours.length);
    games++;
  }
  assert.equal(games, 1200);
  assert.ok(caps > 500);
});

ok('the careful computer beats the random one', () => {
  const rnd = seeded(99);
  let wins = 0;
  const N = 300;
  for (let k = 0; k < N; k++) {
    const g = E.newGame({}, [0, 2], k % 2 ? 0 : 2);
    while (g.phase !== 'over') {
      if (g.phase === 'roll') E.roll(g, E.die(rnd()));
      else if (g.phase === 'pass') E.pass(g);
      else {
        const m = E.chooseMove(g, g.turn === 0 ? 'normal' : 'easy', rnd);
        E.move(g, m.c, m.i, m.r);
      }
    }
    if (g.result.winners[0] === 0) wins++;
  }
  assert.ok(wins / N > 0.62, `normal won ${wins} of ${N}`);
});

console.log(`ludo engine: ${n} tests passed`);
