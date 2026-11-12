import * as E from '../js/engine.js';
import assert from 'node:assert/strict';

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function totalCards(st) {
  return Object.values(st.hands).reduce((n, h) => n + h.length, 0) + st.trick.length;
}

// 1. Random full rounds for every table size
let thullas = 0, discards = 0, takes = 0, allEmpty = 0, rounds = 0, earlyPlays = 0, jumpedPickups = 0, midTakes = 0;
for (let n = 2; n <= 8; n++) {
  for (let g = 0; g < 600; g++) {
    const seats = Array.from({ length: n }, (_, i) => 'p' + i);
    const st = E.createRound({ seats, dealer: g % n, rnd, allowTake: g % 3 === 0, earlyPlay: g % 2 === 0 });
    const sizes = seats.map((s) => st.hands[s].length);
    assert.equal(sizes.reduce((a, b) => a + b), 52);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
    assert.ok(st.hands[st.turn].includes('S14'));
    assert.deepEqual(E.legalCards(st, st.turn), ['S14']);
    let discardedCards = 0, steps = 0;
    while (!st.over) {
      assert.ok(++steps < 20000, 'round never ended');
      // sometimes someone plays early
      if (st.earlyPlay && rnd() < 0.25) {
        const others = seats.filter((x) => E.earlyCards(st, x).length);
        if (others.length) {
          const x = others[Math.floor(rnd() * others.length)];
          const ec = E.earlyCards(st, x);
          const off = st.hands[x].find((c) => !ec.includes(c));
          if (off) assert.equal(E.play(st, x, off).ok, false, 'early thulla must be rejected');
          const r = E.play(st, x, ec[0]);
          assert.ok(r.ok, r.error); earlyPlays++;
          continue;
        }
      }
      const id = st.turn;
      const t = E.takeTarget(st, id);
      if (t.target && rnd() < 0.05) {
        E.markTakeAsked(st);
        if (rnd() < 0.5) { if (st.trick.length) midTakes++; E.applyTake(st, id, t.target); takes++; }
        continue;
      }
      const legal = E.legalCards(st, id);
      assert.ok(legal.length > 0, 'player on turn has no legal card');
      // illegal card must be rejected
      const illegal = st.hands[id].find((c) => !legal.includes(c));
      if (illegal) assert.equal(E.play(st, id, illegal).ok, false);
      const card = rnd() < 0.3 ? E.autoCard(st, id) : legal[Math.floor(rnd() * legal.length)];
      const before = totalCards(st);
      const r = E.play(st, id, card);
      assert.ok(r.ok, r.error);
      for (const e of r.events) {
        if (e.type === 'thulla') { thullas++; if (e.jumped) jumpedPickups++; }
        if (e.type === 'discard') { discards++; discardedCards += e.count; }
      }
      const disc = r.events.find((e) => e.type === 'discard');
      assert.equal(totalCards(st), before - 1 + 1 - (disc ? disc.count : 0));
    }
    rounds++;
    assert.equal(totalCards(st) + discardedCards, 52);
    assert.ok(st.loser);
    assert.equal(st.out.length + 1, n);
    assert.ok(!st.out.includes(st.loser));
    const pos = E.positions(st);
    assert.deepEqual(Object.values(pos).sort((a, b) => a - b), seats.map((_, i) => i + 1));
    for (const id of st.out) assert.equal(st.hands[id].length, 0);
    if (st.hands[st.loser].length === 0) allEmpty++;
  }
}
console.log({ rounds, thullas, discards, takes, midTakes, earlyPlays, jumpedPickups, allEmpty });
assert.ok(earlyPlays > 0 && jumpedPickups > 0 && midTakes > 0);

// 2. Scripted scenarios with a fixed deck (3 players, dealer = p2 so p0 gets cards first)
function rig(handsBySeat) {
  // build a deck so that dealing from seat 0 round-robin gives these hands (equal sizes)
  const n = handsBySeat.length, deck = [];
  for (let i = 0; i < handsBySeat[0].length; i++) for (let s = 0; s < n; s++) deck.push(handsBySeat[s][i]);
  return deck;
}
const seats3 = ['a', 'b', 'c'];

// 2a. First trick: off-suit is NOT a thulla, trick is discarded, A♠ holder leads next
{
  const st = E.createRound({ seats: seats3, dealer: 2, deck: rig([['S14', 'H2'], ['S2', 'H3'], ['C5', 'H4']]) });
  assert.equal(st.turn, 'a');
  E.play(st, 'a', 'S14'); E.play(st, 'b', 'S2');
  const r = E.play(st, 'c', 'C5');
  assert.ok(r.events.some((e) => e.type === 'discard'));
  assert.ok(!r.events.some((e) => e.type === 'thulla'));
  assert.equal(st.turn, 'a');
  console.log('ok first trick no thulla');
}

// 2b. Thulla stops the trick; highest of led suit picks up and leads; later players keep their cards
{
  const st = E.createRound({ seats: seats3, dealer: 2, deck: rig([['S14', 'H2', 'D9'], ['S2', 'H9', 'D2'], ['S3', 'C5', 'D3']]) });
  E.play(st, 'a', 'S14'); E.play(st, 'b', 'S2'); E.play(st, 'c', 'S3');
  assert.equal(st.turn, 'a');
  E.play(st, 'a', 'H2'); E.play(st, 'b', 'H9');
  const r = E.play(st, 'c', 'C5');
  const t = r.events.find((e) => e.type === 'thulla');
  assert.deepEqual([t.giver, t.receiver, t.count], ['c', 'b', 3]);
  assert.deepEqual(st.hands.b.slice().sort(), ['C5', 'D2', 'H2', 'H9'].sort());
  assert.equal(st.turn, 'b');
  assert.equal(st.stats.c.given, 1); assert.equal(st.stats.b.received, 1);
  console.log('ok thulla pickup');
}

// 2c. Thulla stops the trick before later players: b gives thulla, c never plays
{
  const st = E.createRound({ seats: seats3, dealer: 2, deck: rig([['S14', 'H5', 'D9'], ['S2', 'C9', 'D2'], ['S3', 'H4', 'D3']]) });
  E.play(st, 'a', 'S14'); E.play(st, 'b', 'S2'); E.play(st, 'c', 'S3');
  E.play(st, 'a', 'H5');
  const r = E.play(st, 'b', 'C9');
  assert.ok(r.events.some((e) => e.type === 'thulla' && e.receiver === 'a'));
  assert.deepEqual(st.hands.c.sort(), ['D3', 'H4']);
  console.log('ok trick stops at thulla');
}

// 2d. Player plays last card as the highest, then a thulla arrives: they pick up and are back in
{
  const st = E.createRound({ seats: seats3, dealer: 2, deck: rig([['S14', 'H14'], ['S2', 'C2'], ['S3', 'H3']]) });
  E.play(st, 'a', 'S14'); E.play(st, 'b', 'S2'); E.play(st, 'c', 'S3');
  E.play(st, 'a', 'H14');                 // a's last card, highest heart
  const r = E.play(st, 'b', 'C2');        // b's last card, thulla → b safe
  assert.ok(r.events.some((e) => e.type === 'thulla' && e.receiver === 'a'));
  assert.ok(r.events.some((e) => e.type === 'finish' && e.id === 'b' && e.pos === 1));
  assert.equal(st.hands.a.length, 2);
  assert.ok(!E.isOut(st, 'a'));
  assert.equal(st.turn, 'a');
  console.log('ok last card then thulla → picks up');
}

// 2e. Player finishes on a clean trick they win → next active clockwise leads
{
  const st = E.createRound({ seats: seats3, dealer: 2, deck: rig([['S14', 'H14'], ['S2', 'H2', ], ['S3', 'H3']].map((h, i) => i === 0 ? h : h)) });
  // give b and c an extra card each so they continue
}
{
  const deck = ['S14', 'S2', 'S3', 'H14', 'H2', 'H3', 'D2', 'D3', 'D4'];
  // a: S14,H14,D2  b: S2,H2,D3  c: S3,H3,D4 -> make a finish: remove D2 from a by custom
  const st = E.createRound({ seats: seats3, dealer: 2, deck });
  st.hands.a = ['H14', 'S14']; st.hands.b = ['S2', 'H2', 'D3']; st.hands.c = ['S3', 'H3', 'D4'];
  E.play(st, 'a', 'S14'); E.play(st, 'b', 'S2'); E.play(st, 'c', 'S3');
  E.play(st, 'a', 'H14'); E.play(st, 'b', 'H2');
  const r = E.play(st, 'c', 'H3');
  assert.ok(r.events.some((e) => e.type === 'finish' && e.id === 'a'));
  assert.equal(st.turn, 'b');
  console.log('ok finisher wins clean trick → next clockwise leads');
}

// 2f. Everyone empties on the final clean trick → highest card loses
{
  const st = E.createRound({ seats: ['a', 'b'], dealer: 1, deck: ['S14', 'S2', 'H5', 'H9'] });
  E.play(st, 'a', 'S14'); E.play(st, 'b', 'S2');
  E.play(st, 'a', 'H5');
  const r = E.play(st, 'b', 'H9');
  assert.ok(st.over); assert.equal(st.loser, 'b'); assert.deepEqual(st.out, ['a']);
  assert.ok(r.events.find((e) => e.type === 'finish' && e.id === 'b').cancelled);
  console.log('ok all-empty final trick → highest loses');
}

// 2g. Take the next player's hand
{
  const deck = E.makeDeck();
  const st = E.createRound({ seats: ['a', 'b', 'c', 'd'], dealer: 3, deck, allowTake: true });
  // play out the first trick
  while (st.first) E.play(st, st.turn, E.autoCard(st, st.turn));
  const leader = st.turn;
  const t = E.takeTarget(st, leader);
  assert.ok(t.target);
  const before = st.hands[leader].length + st.hands[t.target].length;
  E.markTakeAsked(st);
  const ev = E.applyTake(st, leader, t.target);
  assert.equal(st.hands[leader].length, before);
  assert.ok(E.isOut(st, t.target));
  assert.equal(st.turn, leader);
  assert.ok(!st.trickSeats.includes(t.target));
  assert.equal(E.takeTarget(st, leader).target, null);
  assert.ok(ev.some((e) => e.type === 'finish'));
  console.log('ok take hand');
}

// 2h. Auto-play choices
{
  const st = E.createRound({ seats: seats3, dealer: 2, deck: rig([['S14', 'H2', 'H9'], ['S2', 'H5', 'C9'], ['S3', 'C4', 'D3']]) });
  assert.equal(E.autoCard(st, 'a'), 'S14');
  E.play(st, 'a', 'S14'); E.play(st, 'b', 'S2'); E.play(st, 'c', 'S3');
  assert.equal(E.autoCard(st, 'a'), 'H2');            // leading → lowest
  E.play(st, 'a', 'H9');
  assert.equal(E.autoCard(st, 'b'), 'H5');            // following → lowest of suit
  E.play(st, 'b', 'H5');
  assert.equal(E.autoCard(st, 'c'), 'C4');            // can't follow → highest (C4 > D3)
  console.log('ok auto-play');
}
// 3. Play early: a jumper picks up when someone they jumped gives a thulla
{
  const four = ['a', 'b', 'c', 'd'];
  const deck = [];
  const hands = [['S14', 'H14', 'D9'], ['S2', 'C5', 'D2'], ['S3', 'H3', 'D3'], ['S4', 'H4', 'D4']];
  for (let i = 0; i < 3; i++) for (let s2 = 0; s2 < 4; s2++) deck.push(hands[s2][i]);
  const st = E.createRound({ seats: four, dealer: 3, deck, earlyPlay: true });
  // first trick: c jumps ahead of b (spades)
  E.play(st, 'a', 'S14');
  assert.deepEqual(E.earlyCards(st, 'c'), ['S3']);
  assert.ok(E.play(st, 'c', 'S3').ok);
  assert.equal(st.turn, 'b');
  E.play(st, 'b', 'S2');
  assert.equal(st.turn, 'd', 'c already played, so d is next');
  E.play(st, 'd', 'S4');
  assert.equal(st.turn, 'a');
  // a leads hearts, d jumps ahead of b and c; b has no hearts → thulla → d picks up, not a
  E.play(st, 'a', 'H14');
  assert.equal(E.play(st, 'd', 'C5').ok, false, 'no thulla early (d has no clubs anyway)');
  assert.ok(E.play(st, 'd', 'H4').ok);
  const r = E.play(st, 'b', 'C5');
  const t = r.events.find((e) => e.type === 'thulla');
  assert.deepEqual([t.giver, t.receiver, t.jumped], ['b', 'd', true]);
  assert.equal(st.turn, 'd');
  console.log('ok play-early jumper picks up');
}
// 3b. An early player seated BEFORE the giver isn't punished
{
  const four = ['a', 'b', 'c', 'd'];
  const hands = [['S14', 'H14', 'D9'], ['S2', 'H2', 'D2'], ['S3', 'H3', 'D3'], ['S4', 'C4', 'D4']];
  const deck = []; for (let i = 0; i < 3; i++) for (let s2 = 0; s2 < 4; s2++) deck.push(hands[s2][i]);
  const st = E.createRound({ seats: four, dealer: 3, deck, earlyPlay: true });
  E.play(st, 'a', 'S14'); E.play(st, 'b', 'S2'); E.play(st, 'c', 'S3'); E.play(st, 'd', 'S4');
  E.play(st, 'a', 'H14');
  E.play(st, 'c', 'H3');        // c jumps b
  E.play(st, 'b', 'H2');        // b follows, then turn skips c → d
  assert.equal(st.turn, 'd');
  const r = E.play(st, 'd', 'C4');
  const t = r.events.find((e) => e.type === 'thulla');
  assert.deepEqual([t.receiver, t.jumped], ['a', false]);
  console.log('ok early player before the giver is not punished');
}
// 3c. Take on a non-leading turn
{
  const st = E.createRound({ seats: ['a', 'b', 'c', 'd'], dealer: 3, deck: E.makeDeck(), allowTake: true });
  while (st.first) E.play(st, st.turn, E.autoCard(st, st.turn));
  E.play(st, st.turn, E.legalCards(st, st.turn)[0]);   // lead
  const asker = st.turn;
  const { target } = E.takeTarget(st, asker);
  assert.ok(target);
  const total = st.hands[asker].length + st.hands[target].length;
  E.markTakeAsked(st);
  E.applyTake(st, asker, target);
  assert.equal(st.turn, asker);
  assert.equal(st.hands[asker].length, total);
  assert.ok(!st.trickSeats.includes(target));
  const r = E.play(st, asker, E.legalCards(st, asker)[0]);
  assert.ok(r.ok);
  console.log('ok take mid-trick');
}
// 4. Give up with two players left
{
  const st = E.createRound({ seats: ['a', 'b', 'c'], dealer: 2, deck: E.makeDeck() });
  assert.equal(E.canGiveUp(st, 'a'), false, 'not with three players');
  st.out.push('c'); st.hands.c = [];
  // make sure the trick list matches the two players still in
  assert.equal(E.canGiveUp(st, 'a'), true);
  const r = E.giveUp(st, 'a');
  assert.ok(r.ok);
  assert.ok(st.over); assert.equal(st.loser, 'a'); assert.deepEqual(st.out, ['c', 'b']);
  assert.deepEqual(E.positions(st), { c: 1, b: 2, a: 3 });
  assert.equal(E.giveUp(st, 'b').ok, false);
  console.log('ok give up');
}
console.log('ALL ENGINE TESTS PASSED');
