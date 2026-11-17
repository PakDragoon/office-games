// Alzheimer's: game rules. Pure functions, no network or page code, so the server and the tests share them.
//
// 2 to 8 players in a circle. Each player writes 12 things for the next player round the table (the circle
// shifts one place every round). Then the words written for you flash one at a
// time, each for a moment, and you doodle each one in its own box of a 4 × 3 grid as it comes. When drawing
// is over the words are gone: your boxes light up one by one in a random order and you type what you drew
// in each (close is good enough). One point per right box; equal scores go to whoever was faster.
import { CATEGORIES, CATEGORY_NAMES } from '../../the-liar/js/words.js';
import { editDistance, squash, tolerance } from '../../forehead/js/engine.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const BOXES = 12;
export const COLS = 4;
export const ROWS = 3;
// The drawing is a fixed 800 × 600 sheet of twelve 200 × 200 boxes, scaled to each screen
export const BOARD = { w: 800, h: 600, box: 200 };
export const PACES = [5, 8, 12];                 // seconds between words while drawing
export const FLASHES = [1000, 1500, 2000];       // how long each word stays on screen, ms
export const DEFAULT_SETTINGS = { pace: 8, flash: 1500 };
export const TIMES = {
  writeMs: 120000,     // to write your 12 words
  countdownMs: 3000,   // 3, 2, 1 before the first word
  tailMs: 10000,       // after the last word comes, to finish drawing
  testMs: 90000,       // for the whole memory test
};
export const WORD = { maxChars: 24, maxWords: 3 };
export const ANSWER_MAX = 40;   // characters in a typed answer
// Numbers (x, y pairs) kept per stroke and per player: 8 players' ink must stay small enough to save after every stroke
export const INK = { perStroke: 800, perPlayer: 10000 };

export function cleanSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    pace: PACES.includes(r.pace) ? r.pace : DEFAULT_SETTINGS.pace,
    flash: FLASHES.includes(r.flash) ? r.flash : DEFAULT_SETTINGS.flash,
  };
}

// ---------- Randomness ----------

export function shuffle(list, rnd) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Words ----------

/** A typed word tidied up: letters, numbers, spaces, ' and -; at most 3 words and 24 characters. '' if nothing's left. */
export function cleanWord(raw) {
  const w = String(raw ?? '').normalize('NFKC').replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' -]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!w || w.length > WORD.maxChars || w.split(' ').length > WORD.maxWords) return '';
  return w;
}

/** How two words are compared for repeats: lower case, letters and numbers only. */
export const wordKey = (w) => String(w ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * A list of 12 from what someone typed: cleaned, repeats and blanks dropped and the gaps filled with random things
 * that are easy to draw (The Liar's word list), never one already in the list.
 */
export function fillWords(raw, rnd) {
  const out = [];
  const seen = new Set();
  for (const w of Array.isArray(raw) ? raw.slice(0, BOXES) : []) {
    const c = cleanWord(w);
    const k = wordKey(c);
    if (c && !seen.has(k)) { out.push(c); seen.add(k); }
  }
  const pool = CATEGORY_NAMES.flatMap((c) => CATEGORIES[c]).filter((w) => !seen.has(wordKey(w)));
  for (const w of shuffle(pool, rnd)) {
    if (out.length >= BOXES) break;
    if (!seen.has(wordKey(w))) { out.push(w); seen.add(wordKey(w)); }
  }
  return out;
}

/** Why a finished list of words can't be used ('' when it's fine): 12 words, none repeated. */
export function wordsProblem(raw) {
  if (!Array.isArray(raw) || raw.length !== BOXES) return `Write ${BOXES} things`;
  const keys = raw.map((w) => wordKey(cleanWord(w)));
  if (keys.some((k) => !k)) return `Fill in all ${BOXES} boxes`;
  if (new Set(keys).size !== keys.length) return 'Each thing only once';
  return '';
}

/** Suggestions for an empty box: a few random things to draw. */
export function suggestions(rnd, n = BOXES, avoid = []) {
  const skip = new Set(avoid.map(wordKey));
  return shuffle(CATEGORY_NAMES.flatMap((c) => CATEGORIES[c]).filter((w) => !skip.has(wordKey(w))), rnd).slice(0, n);
}

// ---------- The drawing timeline ----------

/** When word i appears, counting from the first word (ms). */
export const revealAt = (i, pace) => i * pace * 1000;
/** How long drawing lasts from the first word: until the last word, then TIMES.tailMs more. */
export const drawLength = (pace) => revealAt(BOXES - 1, pace) + TIMES.tailMs;
/** Which word is the current one `ms` after the first word (-1 before it, at most BOXES - 1). */
export const wordIndex = (ms, pace) => (ms < 0 ? -1 : Math.min(BOXES - 1, Math.floor(ms / (pace * 1000))));
/** Whether word i is on screen `ms` after the first word. */
export const showing = (i, ms, pace, flash) => i >= 0 && ms >= revealAt(i, pace) && ms < revealAt(i, pace) + flash;

// ---------- Boxes and ink ----------

/** The top-left corner of box i (0 to 11, left to right, top to bottom). */
export const boxXY = (i) => ({ x: (i % COLS) * BOARD.box, y: Math.floor(i / COLS) * BOARD.box });

/** Which box a point is in, or -1 off the sheet. */
export function boxAt(x, y) {
  if (!(x >= 0 && x < BOARD.w && y >= 0 && y < BOARD.h)) return -1;
  return Math.floor(y / BOARD.box) * COLS + Math.floor(x / BOARD.box);
}

/** A stroke from a browser: whole numbers in x, y pairs, kept inside its own box, at most `room` numbers. */
export function cleanStroke(box, pts, room = INK.perStroke) {
  if (!Number.isInteger(box) || box < 0 || box >= BOXES || !Array.isArray(pts)) return [];
  const { x, y } = boxXY(box);
  const out = [];
  const n = Math.min(pts.length - (pts.length % 2), Math.max(0, Math.min(room, INK.perStroke)));
  for (let i = 0; i < n; i += 2) {
    const px = Number(pts[i]), py = Number(pts[i + 1]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    out.push(Math.max(x + 2, Math.min(x + BOARD.box - 2, Math.round(px))), Math.max(y + 2, Math.min(y + BOARD.box - 2, Math.round(py))));
  }
  return out;
}

// ---------- The memory test ----------

/** A typed answer, one line, at most ANSWER_MAX characters ('' = I don't know). */
export const cleanAnswer = (raw) => (typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ANSWER_MAX).trim() : '');

// The same word with or without a plural ending: cat / cats, box / boxes, berry / berries
function forms(w) {
  const out = new Set([w, `${w}s`, `${w}es`]);
  if (w.endsWith('ies')) out.add(`${w.slice(0, -3)}y`);
  if (w.endsWith('y')) out.add(`${w.slice(0, -1)}ies`);
  if (w.endsWith('es')) out.add(w.slice(0, -2));
  if (w.endsWith('s')) out.add(w.slice(0, -1));
  return out;
}

/**
 * Does a typed answer name this word? Capitals, accents, spaces, punctuation and a leading "the/a/an" don't
 * matter, plurals count, and small typos are forgiven (1 for words of 5+ letters, 2 for 9+, as in Forehead).
 * An answer that is exactly one of the player's OTHER words never counts (no "house" for "mouse").
 */
export function nameMatches(raw, word, others = []) {
  const g = squash(raw);
  const w = squash(word);
  if (!g || !w) return false;
  if (forms(w).has(g)) return true;
  if (others.some((o) => { const k = squash(o); return k && k !== w && forms(k).has(g); })) return false;
  const tol = tolerance(w.length);
  return tol > 0 && [...forms(w)].some((f) => editDistance(g, f, tol) <= tol);
}

/** How many boxes a player got right: answers are { i: box, right }. */
export const points = (answers) => answers.filter((a) => a.right).length;

/**
 * Who writes for whom this round: the players in seat order, each writing for the one `shift` places on.
 * The shift is 1 in the first round, then 2, … and back to 1, so you write for someone new each round.
 * Returns { writer: id -> the id they write for }.
 */
export function circle(ids, game) {
  const n = ids.length;
  const shift = n > 1 ? ((Math.max(1, game) - 1) % (n - 1)) + 1 : 0;
  return Object.fromEntries(ids.map((id, i) => [id, ids[(i + shift) % n]]));
}

/**
 * Standings: most right boxes first, then the faster test. Players are { id, points, ms }.
 * Returns the order and the winner's id (null on a full tie or with nobody).
 */
export function standings(players) {
  const order = [...players].sort((a, b) => b.points - a.points || a.ms - b.ms);
  const [a, b] = order;
  const winner = a && (!b || a.points > b.points || (a.points === b.points && a.ms < b.ms)) ? a.id : null;
  return { order, winner };
}
