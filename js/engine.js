// Thulla rules engine. Pure functions and plain data, no DOM and no network,
// so the host can run it and it can be tested on its own.
//
// Cards are strings: suit letter + rank, for example "S14" is the Ace of Spades,
// "H10" the ten of hearts. Ranks run 2..14 (11 J, 12 Q, 13 K, 14 A).

export const SUITS = ['S', 'H', 'C', 'D'];          // hand sort order: alternating colors
export const SUIT_SYMBOL = { S: '♠', H: '♥', C: '♣', D: '♦' };
export const SUIT_NAME = { S: 'spades', H: 'hearts', C: 'clubs', D: 'diamonds' };
export const ACE_OF_SPADES = 'S14';

export const suitOf = (c) => c[0];
export const rankOf = (c) => Number(c.slice(1));
export const rankLabel = (r) => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[r] || String(r));
export const cardLabel = (c) => rankLabel(rankOf(c)) + SUIT_SYMBOL[suitOf(c)];

export function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push(s + r);
  return deck;
}

export function shuffle(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function sortHand(hand) {
  return hand.slice().sort((a, b) =>
    SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b)) || rankOf(a) - rankOf(b));
}

/**
 * Start a round.
 * seats: player ids in clockwise order. dealer: index into seats.
 * Cards are dealt one at a time starting with the player after the dealer,
 * so when 52 doesn't divide evenly the players right after the dealer get one more.
 */
export function createRound({ seats, dealer = 0, allowTake = false, rnd = Math.random, deck }) {
  if (seats.length < 2) throw new Error('Need at least 2 players');
  const cards = deck ? deck.slice() : shuffle(makeDeck(), rnd);
  const hands = Object.fromEntries(seats.map((id) => [id, []]));
  for (let i = 0; i < cards.length; i++) {
    hands[seats[(dealer + 1 + i) % seats.length]].push(cards[i]);
  }
  for (const id of seats) hands[id] = sortHand(hands[id]);
  const leader = seats.find((id) => hands[id].includes(ACE_OF_SPADES));
  const st = {
    seats: seats.slice(),
    dealer,
    allowTake,
    hands,
    out: [],              // finishing order (safe players)
    loser: null,
    over: false,
    first: true,          // first trick: must lead the Ace of Spades, no thullas
    trick: [],            // [{ id, card }] in play order
    trickSeats: [],       // who plays in the current trick, in order
    ledSuit: null,
    turn: leader,
    turnNo: 0,            // increases every time the turn moves (used for timers / take limits)
    takeAskedTurn: -1,    // turnNo when the current leader last asked to take cards
    lastTrick: null,      // { kind: 'discard'|'pickup', cards, winner, giver }
    stats: Object.fromEntries(seats.map((id) => [id, { given: 0, received: 0, taken: 0, gaveHand: 0 }])),
    tricks: 0,
  };
  startTrick(st, leader);
  return st;
}

export const isOut = (st, id) => st.out.includes(id) || st.loser === id;
export const activeIds = (st) => st.seats.filter((id) => !isOut(st, id));

function nextActiveFrom(st, id) {
  const n = st.seats.length;
  const start = st.seats.indexOf(id);
  for (let k = 1; k <= n; k++) {
    const cand = st.seats[(start + k) % n];
    if (!isOut(st, cand)) return cand;
  }
  return null;
}

function startTrick(st, leader) {
  st.trick = [];
  st.ledSuit = null;
  const order = [];
  const n = st.seats.length;
  const start = st.seats.indexOf(leader);
  for (let k = 0; k < n; k++) {
    const id = st.seats[(start + k) % n];
    if (!isOut(st, id)) order.push(id);
  }
  st.trickSeats = order;
  setTurn(st, leader);
}

function setTurn(st, id) {
  st.turn = id;
  st.turnNo++;
}

export function legalCards(st, id) {
  if (st.over || st.turn !== id) return [];
  const hand = st.hands[id];
  if (st.trick.length === 0) {
    if (st.first && hand.includes(ACE_OF_SPADES)) return [ACE_OF_SPADES];
    return hand.slice();
  }
  const follow = hand.filter((c) => suitOf(c) === st.ledSuit);
  return follow.length ? follow : hand.slice();
}

function highestOfLed(st) {
  let best = null;
  for (const p of st.trick) {
    if (suitOf(p.card) !== st.ledSuit) continue;
    if (!best || rankOf(p.card) > rankOf(best.card)) best = p;
  }
  return best;
}

/**
 * Play a card. Returns { ok, error?, events }.
 * events: { type: 'play' | 'discard' | 'thulla' | 'finish' | 'roundOver', ... }
 * After a resolved trick, st.trick is empty and st.lastTrick describes what happened.
 */
export function play(st, id, card) {
  if (st.over) return { ok: false, error: 'The round is over.' };
  if (st.turn !== id) return { ok: false, error: "It's not your turn." };
  if (!st.hands[id].includes(card)) return { ok: false, error: "You don't have that card." };
  if (!legalCards(st, id).includes(card)) {
    return { ok: false, error: st.trick.length === 0
      ? 'You must lead the Ace of Spades.'
      : `You must follow ${SUIT_NAME[st.ledSuit]}.` };
  }
  const events = [];
  st.hands[id] = st.hands[id].filter((c) => c !== card);
  if (st.trick.length === 0) st.ledSuit = suitOf(card);
  const offSuit = suitOf(card) !== st.ledSuit;
  st.trick.push({ id, card });
  events.push({ type: 'play', id, card });

  if (offSuit && !st.first) {
    // Thulla: the trick stops now. Highest card of the led suit picks everything up.
    const winner = highestOfLed(st).id;
    const cards = st.trick.slice();
    st.hands[winner] = sortHand(st.hands[winner].concat(cards.map((p) => p.card)));
    st.stats[id].given++;
    st.stats[winner].received++;
    st.lastTrick = { kind: 'pickup', cards, winner, giver: id };
    events.push({ type: 'thulla', giver: id, receiver: winner, count: cards.length });
    resolveFinishes(st, cards, winner, events);
    return { ok: true, events };
  }

  if (st.trick.length === st.trickSeats.length) {
    const winner = highestOfLed(st).id;
    const cards = st.trick.slice();
    st.lastTrick = { kind: 'discard', cards, winner, giver: null };
    events.push({ type: 'discard', winner, count: cards.length });
    resolveFinishes(st, cards, winner, events);
    return { ok: true, events };
  }

  setTurn(st, st.trickSeats[st.trick.length]);
  return { ok: true, events };
}

// After a trick resolves: anyone who played and now holds no cards is safe,
// in the order they played. Then check whether the round is over.
function resolveFinishes(st, cards, winner, events) {
  st.tricks++;
  st.first = false;
  for (const p of cards) {
    if (st.hands[p.id].length === 0 && !st.out.includes(p.id)) {
      st.out.push(p.id);
      events.push({ type: 'finish', id: p.id, pos: st.out.length });
    }
  }
  st.trick = [];
  st.ledSuit = null;
  const left = activeIds(st);
  if (left.length <= 1) {
    if (left.length === 1) {
      st.loser = left[0];
    } else {
      // Everyone emptied their hand on the same clean trick: whoever played the
      // highest card would have had to lead, so they lose.
      st.out = st.out.filter((x) => x !== winner);
      events.forEach((e) => { if (e.type === 'finish' && e.id === winner) e.cancelled = true; });
      st.loser = winner;
    }
    st.over = true;
    st.turn = null;
    events.push({ type: 'roundOver', loser: st.loser });
    return;
  }
  const leader = isOut(st, winner) ? nextActiveFrom(st, winner) : winner;
  startTrick(st, leader);
}

/** Finishing position for every seat: 1..n, loser is n. */
export function positions(st) {
  const pos = {};
  st.out.forEach((id, i) => { pos[id] = i + 1; });
  if (st.loser) pos[st.loser] = st.seats.length;
  return pos;
}

// ---------- Taking the next player's hand (optional rule) ----------

/** Who you'd ask, or null with a reason when you can't ask right now. */
export function takeTarget(st, id) {
  if (!st.allowTake) return { target: null, reason: 'Taking cards is turned off.' };
  if (st.over || st.turn !== id) return { target: null, reason: "It's not your turn." };
  if (st.trick.length) return { target: null, reason: 'You can only ask before you lead.' };
  if (st.first) return { target: null, reason: 'Not on the first trick.' };
  if (activeIds(st).length <= 2) return { target: null, reason: 'Not with only two players left.' };
  if (st.takeAskedTurn === st.turnNo) return { target: null, reason: 'You already asked this turn.' };
  return { target: nextActiveFrom(st, id), reason: null };
}

export function markTakeAsked(st) { st.takeAskedTurn = st.turnNo; }

/** Next player accepted: their whole hand moves to the asker, and they're safe. */
export function applyTake(st, from, to) {
  const events = [];
  const cards = st.hands[to];
  st.hands[from] = sortHand(st.hands[from].concat(cards));
  st.hands[to] = [];
  st.stats[from].taken++;
  st.stats[to].gaveHand++;
  st.out.push(to);
  events.push({ type: 'take', from, to, count: cards.length });
  events.push({ type: 'finish', id: to, pos: st.out.length });
  // The asker still leads, but the trick's player list must drop the safe player.
  startTrick(st, from);
  st.takeAskedTurn = st.turnNo; // can't ask again on this same lead
  return events;
}

// ---------- Timer auto-play ----------

/**
 * The card played when time runs out:
 * following suit → lowest of that suit; leading → lowest card;
 * can't follow → highest card (the thulla).
 */
export function autoCard(st, id) {
  const legal = legalCards(st, id);
  if (!legal.length) return null;
  const byRank = (a, b) => rankOf(a) - rankOf(b) || SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b));
  const sorted = legal.slice().sort(byRank);
  if (st.trick.length && !legal.some((c) => suitOf(c) === st.ledSuit)) return sorted[sorted.length - 1];
  return sorted[0];
}
