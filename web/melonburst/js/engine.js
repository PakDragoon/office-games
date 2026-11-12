// Melon Burst: game rules. Pure functions, no network or page code, so they can be tested.
//
// Guess a hidden word one letter at a time. Every wrong letter snaps another rubber band round
// your watermelon; when it gets one band too many, it bursts.
import { BLOCKED } from './blocked.js';

export const MIN_LEN = 4;
export const MAX_LEN = 12;
export const MAX_PLAYERS = 8;
export const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
export const TIMES = { countdownMs: 3000, pickMs: 60000, revealMs: 9000, offlineOutMs: 20000 };
export const DAY_ONE = '2026-11-11';

// mode: race (the computer picks one word, 2-8 players race on it)
//       pick (two sides pick words for each other: 1 vs 1 or 2 vs 2)
export const DEFAULT_SETTINGS = {
  mode: 'race',
  teams: '1v1',       // pick mode: 1v1 | 2v2
  bands: 6,           // wrong letters you survive: the next one bursts it. 5 | 6 | 8
  length: 'any',      // computer's words: any | short (4-6) | medium (6-8) | long (8-12)
  words: 'all',       // computer's words: common (everyday) | all (everyday + more)
  rounds: 5,          // race: 3 | 5 | 10. pick: words each side picks: 2 | 4 | 6
  time: '120',        // seconds to guess: off | 60 | 90 | 120 | 180
};

const CHOICES = {
  mode: ['race', 'pick'], teams: ['1v1', '2v2'], bands: [5, 6, 8], length: ['any', 'short', 'medium', 'long'],
  words: ['common', 'all'], rounds: [2, 3, 4, 5, 6, 10], time: ['off', '60', '90', '120', '180'],
};
export const ROUND_CHOICES = { race: [3, 5, 10], pick: [2, 4, 6] };

export function cleanSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const [key, options] of Object.entries(CHOICES)) {
      const v = typeof options[0] === 'number' ? Number(raw[key]) : String(raw[key]);
      if (options.includes(v)) out[key] = v;
    }
  }
  // Rounds must suit the mode (race 3/5/10, pick 2/4/6)
  if (!ROUND_CHOICES[out.mode].includes(out.rounds)) out.rounds = out.mode === 'race' ? 5 : 4;
  return out;
}

export const timeMs = (st) => (st.time === 'off' ? 0 : Number(st.time) * 1000);
export const LENGTHS = { any: [MIN_LEN, MAX_LEN], short: [4, 6], medium: [6, 8], long: [8, 12] };
export const seatsFor = (st) => (st.teams === '2v2' ? 2 : 1);

/* ---------- Words ---------- */

const BLOCKED_SET = new Set(BLOCKED);
const BLOCKED_LONG = BLOCKED.filter((b) => b.length >= 4);
export const isBlocked = (w) => BLOCKED_SET.has(w) || BLOCKED_LONG.some((b) => w.includes(b));

export function cleanWord(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, MAX_LEN + 4);
}

/**
 * The word lists. common/more: what the computer picks from. valid: what players may pick.
 * Any list can be empty while it loads; checks fall back to the others.
 */
export function makeLexicon(common = [], more = [], valid = []) {
  return {
    common, more,
    valid: new Set([...valid, ...common, ...more]),
    ready: valid.length > 0,
  };
}

/** Can a player pick this word for someone else? Returns '' when it's fine, or the reason. */
export function pickProblem(raw, lex) {
  const w = cleanWord(raw);
  if (!w) return 'Type a word';
  if (w.length < MIN_LEN) return `At least ${MIN_LEN} letters`;
  if (w.length > MAX_LEN) return `At most ${MAX_LEN} letters`;
  if (isBlocked(w)) return 'Pick something kinder';
  if (!lex.valid.has(w)) return 'Not in the dictionary';
  return '';
}

/** The computer picks a word: the right length, from the room's lists, not used in this room yet. */
export function pickWord(lex, st, rnd = Math.random, used = new Set()) {
  const [lo, hi] = LENGTHS[st.length] || LENGTHS.any;
  const pool = (st.words === 'common' ? lex.common : lex.common.concat(lex.more))
    .filter((w) => w.length >= lo && w.length <= hi);
  const fresh = pool.filter((w) => !used.has(w));
  const from = fresh.length ? fresh : pool;
  return from.length ? from[Math.floor(rnd() * from.length)] : '';
}

/* ---------- One player guessing one word ---------- */

export const newGuess = (word) => ({ word, guessed: [], wrong: 0, solved: false, burst: false, ms: 0 });
export const isDone = (g) => g.solved || g.burst;

export function mask(word, guessed) {
  return word.split('').map((ch) => (guessed.includes(ch) ? ch : '_')).join('');
}

/**
 * Guess a letter. Returns { g, hit, count } with the new state (the old one is untouched), or
 * null when the guess doesn't count (not a letter, already guessed, already finished).
 * bands: how many wrong letters the melon survives; one more bursts it.
 */
export function guess(g, raw, bands) {
  const ch = String(raw || '').toLowerCase();
  if (!g || isDone(g) || ch.length !== 1 || !LETTERS.includes(ch) || g.guessed.includes(ch)) return null;
  const count = g.word.split('').filter((c) => c === ch).length;
  const next = { ...g, guessed: [...g.guessed, ch] };
  if (count) {
    if (!mask(g.word, next.guessed).includes('_')) next.solved = true;
  } else {
    next.wrong = g.wrong + 1;
    if (next.wrong > bands) next.burst = true;
  }
  return { g: next, hit: count > 0, count };
}

export const revealed = (g) => mask(g.word, g.guessed).split('').filter((c) => c !== '_').length;

/* ---------- Points ---------- */

// Solving is worth 10, plus 1 for every band you had to spare. Racing on the same word, the first
// three to solve get 3, 2 and 1 more. A burst melon scores nothing.
export const SPEED_BONUS = [3, 2, 1];
export function points(g, bands, place = 0) {
  if (!g || !g.solved) return 0;
  return 10 + Math.max(0, bands - g.wrong) + (place > 0 ? SPEED_BONUS[place - 1] || 0 : 0);
}

/** Order players for a podium: most points, then most rounds solved, then least total time. */
export function rank(rows) {
  return rows.slice().sort((a, b) => b.score - a.score || b.solved - a.solved || a.ms - b.ms);
}

/* ---------- Pick mode: who picks when ---------- */

// Round r (0-based): with 2 a side, teammates take turns picking; with 1, the same player picks.
export const pickerIndex = (round, perSide) => round % perSide;

/* ---------- Daily word ---------- */

export function dayNumber(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [y0, m0, d0] = DAY_ONE.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y0, m0 - 1, d0)) / 86400000) + 1;
}
export function todayStr(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
/** Everyone gets the same everyday word, 5 to 9 letters, on the same local date. */
export function dailyWord(lex, dateStr) {
  const pool = lex.common.filter((w) => w.length >= 5 && w.length <= 9);
  if (!pool.length) return '';
  const rnd = mulberry32(hashString(`melonburst:${dateStr}`));
  rnd(); rnd();
  return pool[Math.floor(rnd() * pool.length)];
}
export const DAILY_BANDS = 6;

/** 🍉 Melon Burst #3 · 2 bands … then one square per guess, in order. */
export function shareText(day, g, bands) {
  const head = g.solved ? `🍉 Melon Burst #${day}: solved with ${g.wrong}/${bands} bands` : `💥 Melon Burst #${day}: burst`;
  const row = g.guessed.map((ch) => (g.word.includes(ch) ? '🟩' : '🟥')).join('');
  return `${head}\n${row}`;
}

/* ---------- Random numbers ---------- */

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
export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const randomSeed = () => Math.floor(Math.random() * 2 ** 31);
export function shuffle(list, rnd = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export function formatMs(ms) {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
