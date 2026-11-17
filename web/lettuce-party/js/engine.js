// Lettuce Party: game rules. Pure functions, no network or page code, so the server and the tests share them.
//
// Four modes:
//   classic  every guess is coloured tile by tile (green right place, yellow wrong place, grey not in the word)
//   counts   no tile colours: each guess only reports HOW MANY letters are green, yellow and red
//   ladder   everyone gets the same start and target word; change one letter at a time, every step a real word
//   hotcold  any word of any length: each guess gets a rank for how close its MEANING is (1 = the word);
//            timed, the closest guess when time runs out wins (ranks come from js/hotcold.js on the server)

export const COLS = 5;
export const MODES = ['classic', 'counts', 'ladder', 'hotcold'];
export const ATTEMPTS = { min: 4, max: 10, default: 6 };
export const ROUND_LIMITS = [0, 3, 5, 10];            // rounds per game (0 = unlimited)
export const TIMERS = [0, 60, 120, 180, 300];         // seconds per round in classic and counts (0 = no timer)
export const LADDER_TIMES = [60, 120, 180, 300];      // seconds per ladder round (always a time limit)
export const HOT_TIMES = [120, 180, 300];             // seconds per Hot & Cold round (always a time limit)
export const HOT = { maxGuesses: 300, maxHints: 3 };

export const DEFAULT_SETTINGS = {
  strict: true,         // guesses must be in the word list
  winRule: 'first',     // first | fewest
  hard: false,          // classic only
  maxRounds: 0,
  timer: 0,
  mode: 'classic',
  attempts: ATTEMPTS.default,   // classic and counts only
  ladderTime: 180,              // ladder only
  ladderReuse: true,            // ladder only: a word already in your ladder may be typed again (go back a step)
  hotTime: 180,                 // hotcold only
  hotHints: true,               // hotcold only: players may ask for up to HOT.maxHints hints a round
};

function apply(into, raw) {
  if (!raw || typeof raw !== 'object') return into;
  if (typeof raw.strict === 'boolean') into.strict = raw.strict;
  if (raw.winRule === 'first' || raw.winRule === 'fewest') into.winRule = raw.winRule;
  if (typeof raw.hard === 'boolean') into.hard = raw.hard;
  if (ROUND_LIMITS.includes(raw.maxRounds)) into.maxRounds = raw.maxRounds;
  if (TIMERS.includes(raw.timer)) into.timer = raw.timer;
  if (MODES.includes(raw.mode)) into.mode = raw.mode;
  if (Number.isInteger(raw.attempts) && raw.attempts >= ATTEMPTS.min && raw.attempts <= ATTEMPTS.max) into.attempts = raw.attempts;
  if (LADDER_TIMES.includes(raw.ladderTime)) into.ladderTime = raw.ladderTime;
  if (typeof raw.ladderReuse === 'boolean') into.ladderReuse = raw.ladderReuse;
  if (HOT_TIMES.includes(raw.hotTime)) into.hotTime = raw.hotTime;
  if (typeof raw.hotHints === 'boolean') into.hotHints = raw.hotHints;
  return into;
}

/**
 * The room's settings after a host's patch: `current` is what the room has now (or a saved snapshot, which may be
 * from before modes existed: anything missing falls back to the defaults, so an old room is a classic one), `patch`
 * is whatever the browser sent. Everything unexpected is thrown away. Hard mode only exists in classic.
 */
export function cleanSettings(patch, current) {
  const out = apply(apply({ ...DEFAULT_SETTINGS }, current), patch);
  if (out.mode !== 'classic') out.hard = false;
  return out;
}

/** The time limit in seconds that applies to a round in this mode (0 = none). */
export const effectiveTimer = (s) => (s.mode === 'ladder' ? s.ladderTime : s.mode === 'hotcold' ? s.hotTime : s.timer);

/* ---------- Classic and counts: scoring a guess ---------- */

/** Pattern of 'h' (right place), 'n' (in the word, wrong place) and 'm' (not in the word); duplicates handled like Wordle. */
export function score(guess, answer) {
  const out = Array(COLS).fill('m');
  const left = {};
  for (let i = 0; i < COLS; i++) {
    if (guess[i] === answer[i]) out[i] = 'h';
    else left[answer[i]] = (left[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < COLS; i++) {
    if (out[i] !== 'h' && left[guess[i]] > 0) {
      out[i] = 'n';
      left[guess[i]]--;
    }
  }
  return out.join('');
}

/** [green, yellow, red] for a pattern: right place, in the word but misplaced, not in the word. */
export function counts(pattern) {
  let g = 0;
  let y = 0;
  for (const c of pattern) {
    if (c === 'h') g++;
    else if (c === 'n') y++;
  }
  return [g, y, COLS - g - y];
}

/** The three counts for a guess against the answer. */
export const countsFor = (guess, answer) => counts(score(guess, answer));

/* ---------- Word ladder ---------- */

/** How many positions the two words differ in. */
export function diffCount(a, b) {
  let n = 0;
  for (let i = 0; i < COLS; i++) if (a[i] !== b[i]) n++;
  return n;
}

/** How many letters of `word` are in the same place in `target`. */
export const matchCount = (word, target) => COLS - diffCount(word, target);

/**
 * Why `word` can't be the next step of this ladder (the start word followed by the steps so far), or null if it can.
 * `isWord(w)` says whether w is in the word list. With `allowReuse` a word already in the ladder (the start word
 * included) may come round again, as a new step; without it (the default here) a repeat is refused.
 */
export function ladderStepProblem(ladder, word, isWord, allowReuse = false) {
  if (typeof word !== 'string' || !/^[a-z]{5}$/.test(word)) return 'Not enough letters';
  if (diffCount(ladder[ladder.length - 1], word) !== 1) return 'Change exactly one letter';
  if (!allowReuse && ladder.includes(word)) return 'Already used';
  if (!isWord(word)) return 'Not a word';
  return null;
}

/**
 * Ladder pairs live in words/ladders.txt, one line each: `start target par step step ...` (par = fewest steps, then the
 * words of one shortest path between start and target). Built by tools/build-ladders.mjs, never searched at runtime.
 */
export function parsePair(line) {
  const f = String(line).trim().split(' ');
  const par = Number(f[2]);
  if (f.length < 5 || !/^[a-z]{5}$/.test(f[0]) || !/^[a-z]{5}$/.test(f[1]) || !Number.isInteger(par) || f.length !== par + 2) return null;
  const path = [f[0], ...f.slice(3), f[1]];
  return { start: f[0], target: f[1], par, path };
}

/**
 * A random pair from the file's text without splitting it: jump to a random place and take the line around it.
 * `skip(key)` gets "start target" and can refuse pairs already played; after a few misses the next one is simply accepted.
 */
export function pickPair(text, random, skip = (_key) => false) {
  const lines = text.length;
  let found = null;
  for (let tries = 0; tries < 12 && !found; tries++) {
    const at = Math.floor(random() * lines);
    const from = text.lastIndexOf('\n', at - 1) + 1;
    let to = text.indexOf('\n', from);
    if (to < 0) to = text.length;
    const line = text.slice(from, to);
    const pair = parsePair(line);
    if (pair && (!skip(`${pair.start} ${pair.target}`) || tries === 11)) found = pair;
  }
  return found;
}

/* ---------- Hot & Cold ---------- */

/** A typed guess tidied up: lower case letters only, or '' when it can't be a word. */
export function cleanHotWord(raw) {
  const w = String(raw ?? '').trim().toLowerCase();
  return /^[a-z]{2,14}$/.test(w) ? w : '';
}

/** Your best rank from the words you typed yourself (hints never count), or null before any guess. */
export function bestRank(guesses) {
  let best = null;
  for (const g of guesses) if (!g.hint && typeof g.rank === 'number' && (best === null || g.rank < best)) best = g.rank;
  return best;
}

/**
 * The rank a hint aims for: halfway from your best to the word. Before any guess it starts at 1000;
 * at rank 3 or better there is nothing left to give away (null).
 */
export function hintRank(best) {
  if (best === null) return 1000;
  if (best <= 3) return null;
  return Math.max(2, Math.floor(best / 2));
}

/** How warm a rank is, for colours and words on screen. */
export function temperature(rank) {
  if (rank === 1) return 'found';
  if (rank <= 10) return 'burning';
  if (rank <= 100) return 'hot';
  if (rank <= 500) return 'warm';
  if (rank <= 2000) return 'cool';
  return 'cold';
}

/**
 * Hot & Cold standings: whoever found the word first, then the best rank, then fewer guesses.
 * Players are { best, solved, finishMs, used }; nobody without a guess is ranked.
 */
export function hotOrder(players) {
  return players.filter((p) => p.best !== null).sort((a, b) => (a.solved !== b.solved ? (a.solved ? -1 : 1) : 0)
    || (a.solved && b.solved ? (a.finishMs ?? 0) - (b.finishMs ?? 0) : 0)
    || a.best - b.best || a.used - b.used);
}
