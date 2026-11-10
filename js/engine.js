// The Liar: game rules. Pure functions, no network or page code, so they can be tested.
import { CATEGORIES, CATEGORY_NAMES } from './words.js';

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;
export const ROUNDS = 3;
// The drawing is a fixed 4:3 sheet, scaled to each screen
export const BOARD = { w: 800, h: 600 };
// One-stroke mode: time to start your line, and the longest a line may last
export const STROKE = { startMs: 15000, maxMs: 10000 };
export const FREE_SECONDS = [5, 8, 12];
export const TIMES = { roleMs: 15000, handoffMs: 1400, voteMs: 45000, guessMs: 30000 };
export const OPTION_COUNT = 12;
export const MAX_INK = 4000;   // numbers (x, y pairs) allowed in one stroke

// ---------- Randomness ----------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomSeed = () => Math.floor(Math.random() * 4294967296) >>> 0;

export function shuffle(list, rnd) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Words ----------

export const wordKey = (category, word) => `${category}|${word}`.toLowerCase();

// A word from the chosen categories (all if none chosen) that hasn't been used yet.
// When everything has been used, it starts over rather than failing.
export function pickWord(categories, used, rnd) {
  const cats = (categories && categories.length ? categories : CATEGORY_NAMES).filter((c) => CATEGORIES[c]);
  const pool = [];
  for (const c of cats.length ? cats : CATEGORY_NAMES) for (const w of CATEGORIES[c]) pool.push({ category: c, word: w });
  const fresh = pool.filter((p) => !used.has(wordKey(p.category, p.word)));
  const from = fresh.length ? fresh : pool;
  return from[Math.floor(rnd() * from.length)];
}

// The words the liar chooses from at the end: the real word plus others from its category.
export function liarOptions(category, word, rnd, n = OPTION_COUNT) {
  const others = shuffle(CATEGORIES[category].filter((w) => w !== word), rnd).slice(0, n - 1);
  return shuffle([word, ...others], rnd);
}

// ---------- Turns ----------

// Pick the liar at random, but not the same person two games running (when there's a choice)
export function pickLiar(ids, previous, rnd) {
  const pool = ids.length > 1 ? ids.filter((id) => id !== previous) : ids;
  return pool[Math.floor(rnd() * pool.length)];
}

// Random order for round 1 (kept for rounds 2 and 3). The liar never goes first,
// so there is always something on the paper before they draw.
export function turnOrder(ids, liar, rnd) {
  const order = shuffle(ids, rnd);
  if (order.length > 1 && order[0] === liar) {
    const j = 1 + Math.floor(rnd() * (order.length - 1));
    [order[0], order[j]] = [order[j], order[0]];
  }
  return order;
}

// "Vote now" needs everyone but one, so a single holdout can't stall the game.
export const voteNeeded = (active) => (active <= 2 ? Math.max(1, active) : active - 1);

// ---------- Voting and points ----------

// votes: { voterId: suspectId }. The most-voted player is accused; a tie accuses nobody.
export function tally(votes) {
  const counts = {};
  for (const target of Object.values(votes)) counts[target] = (counts[target] || 0) + 1;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const accused = ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
  return { counts, accused };
}

// escaped: the liar wasn't the one accused (or the vote was split)
// caught: the liar was accused and didn't guess the word
// stolen: the liar was accused but guessed the word
export function outcome({ liar, accused, guess, word }) {
  if (accused !== liar) return 'escaped';
  return guess === word ? 'stolen' : 'caught';
}

export const POINTS = { catch: 2, correctVote: 1, escape: 3, steal: 2 };

// Points for one game. Everyone who voted for the liar gets a point whatever happens.
export function points({ result, liar, votes, players }) {
  const delta = Object.fromEntries(players.map((id) => [id, 0]));
  for (const [voter, target] of Object.entries(votes)) {
    if (target === liar && voter in delta) delta[voter] += POINTS.correctVote;
  }
  if (result === 'caught') {
    for (const id of players) if (id !== liar) delta[id] += POINTS.catch;
  } else if (liar in delta) {
    delta[liar] += result === 'escaped' ? POINTS.escape : POINTS.steal;
  }
  return delta;
}

// ---------- Ink from the network ----------

// Points arrive from other browsers: keep whole numbers inside the sheet, in x,y pairs.
export function cleanInk(pts, room = MAX_INK) {
  if (!Array.isArray(pts)) return [];
  const out = [];
  const n = Math.min(pts.length - (pts.length % 2), Math.max(0, room));
  for (let i = 0; i < n; i += 2) {
    const x = Number(pts[i]), y = Number(pts[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push(Math.max(0, Math.min(BOARD.w, Math.round(x))), Math.max(0, Math.min(BOARD.h, Math.round(y))));
  }
  return out;
}
