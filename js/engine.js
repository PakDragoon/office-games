// Rotten: game rules. Pure functions, no network or page code, so they can be tested.
import { PROMPTS, BLOCKED } from './prompts.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
// How long the banana lasts before it splats, picked at random from the room's range (ms)
export const FUSES = { fast: [5000, 15000], normal: [10000, 30000], relaxed: [20000, 45000] };
export const TIMES = { countdownMs: 3000, splatMs: 1800, offlineOutMs: 20000 };
// After this many splats on the same letters, they change even when the room keeps them
export const PROMPT_MAX_SPLATS = 2;
export const MAX_WORD = 30;

export const DEFAULT_SETTINGS = {
  lives: 3,            // 1, 2, 3, 5
  maxLives: 'plus1',   // start | plus1 | none
  bonus: 'az',         // off | az | easy (A-Z without Q, X, Z)
  match: 'open',       // open | 3 | 5 (best of)
  fuse: 'normal',      // fast | normal | relaxed
  showTimer: 'hidden', // hidden | shown
  minTurn: '5',        // seconds the holder always gets: 3 | 5 | 8 | off
  difficulty: 'normal',// easy | normal | hard | ramp
  promptLen: 'mix',    // mix | 2 | 3
  afterSplat: 'keep',  // keep | new
  words: 'en',         // en | mix | ur
  minLen: 4,           // 3, 4, 5
  noRepeat: 'game',    // game | room
  forms: 'block',      // block (bananas after banana is a repeat) | allow
  hints: 'on',         // on | off
};

const CHOICES = {
  lives: [1, 2, 3, 5], maxLives: ['start', 'plus1', 'none'], bonus: ['off', 'az', 'easy'], match: ['open', '3', '5'],
  fuse: ['fast', 'normal', 'relaxed'], showTimer: ['hidden', 'shown'], minTurn: ['3', '5', '8', 'off'],
  difficulty: ['easy', 'normal', 'hard', 'ramp'], promptLen: ['mix', '2', '3'], afterSplat: ['keep', 'new'],
  words: ['en', 'mix', 'ur'], minLen: [3, 4, 5], noRepeat: ['game', 'room'], forms: ['block', 'allow'], hints: ['on', 'off'],
};

// Settings from storage or a host: anything unknown falls back to the default
export function cleanSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, list] of Object.entries(CHOICES)) if (list.includes(raw[k])) out[k] = raw[k];
  return out;
}

export function maxLivesFor(st) {
  if (st.maxLives === 'start') return st.lives;
  if (st.maxLives === 'plus1') return st.lives + 1;
  return 99;
}

// The least time a player gets when the banana reaches them (0 = no minimum)
export const minTurnMs = (st) => (st.minTurn === 'off' ? 0 : (Number(st.minTurn) || 5) * 1000);

export const matchTarget = (st) => (st.match === '3' ? 2 : st.match === '5' ? 3 : 0);

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

export function fuseMs(st, rnd) {
  const [lo, hi] = FUSES[st.fuse] || FUSES.normal;
  return Math.round(lo + rnd() * (hi - lo));
}

// ---------- Words ----------

export const BLOCKED_SET = new Set(BLOCKED.split(' '));

// Roman Urdu has no fixed spelling: khaana, khana and kana, or theek and thik, should all count.
// Both the list and the typed word are folded to this key before comparing.
export function normalUrdu(word) {
  return String(word).toLowerCase()
    .replace(/ee/g, 'i').replace(/oo/g, 'u')
    .replace(/w/g, 'v').replace(/q/g, 'k')
    .replace(/([bcdgjkprstv])h/g, '$1')
    .replace(/(.)\1+/g, '$1')
    .replace(/(ay|ae|ai|ey)$/, 'e')
    .replace(/(.)h$/, '$1');
}

// "bananas" after "banana", or "making" after "make", is the same word for the no-repeat rule
export function stemKey(word) {
  let s = word;
  if (s.length > 4 && s.endsWith('ies')) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && /(ss|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
  else if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ied')) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  if (s.length > 3 && /([bdfgklmnprtz])\1$/.test(s)) s = s.slice(0, -1);
  if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

// The word lists, once loaded: en is a Set of words, ur a Set of normalUrdu keys
export function makeLexicon(enWords = [], urWords = []) {
  return { en: new Set(enWords), ur: new Set(urWords.map(normalUrdu)), urWords };
}

export const cleanWord = (raw) => String(raw || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, MAX_WORD);

// Which list a word counts under for this room, or null if it's not a word here
export function wordSource(word, list, lex) {
  if (list !== 'ur' && lex.en.has(word)) return 'en';
  if (list !== 'en' && lex.ur.has(normalUrdu(word))) return 'ur';
  return null;
}

// The key a played word is remembered by, so repeats can be spotted
export function usedKey(word, source, forms) {
  if (source === 'ur') return `u:${normalUrdu(word)}`;
  return forms === 'allow' ? word : stemKey(word);
}

/**
 * Is this word a valid answer?
 * ctx: { prompt, minLen, list ('en'|'mix'|'ur'), forms, used (Set of usedKey), lex }
 * Returns { ok: true, key, source } or { ok: false, reason } where reason is one of
 * empty | short | prompt | unknown | blocked | used
 */
export function checkWord(raw, ctx) {
  const word = cleanWord(raw);
  if (!word) return { ok: false, reason: 'empty' };
  if (!word.includes(ctx.prompt)) return { ok: false, reason: 'prompt', word };
  if (word.length < ctx.minLen) return { ok: false, reason: 'short', word };
  if (BLOCKED_SET.has(word)) return { ok: false, reason: 'blocked', word };
  const source = wordSource(word, ctx.list, ctx.lex);
  if (!source) return { ok: false, reason: 'unknown', word };
  const key = usedKey(word, source, ctx.forms);
  if (ctx.used.has(key)) return { ok: false, reason: 'used', word };
  return { ok: true, word, key, source };
}

export const REASON_TEXT = {
  empty: 'Type a word',
  prompt: 'Must contain the letters',
  short: 'Too short',
  blocked: 'Not allowed',
  unknown: 'Not in the word list',
  used: 'Already played',
};

// ---------- Prompts ----------

const EN_BANDS = Object.fromEntries(Object.entries(PROMPTS).map(([band, lens]) =>
  [band, Object.fromEntries(Object.entries(lens).map(([len, s]) => [len, s.split(' ').filter(Boolean)]))]));

/**
 * Prompt bands from a word list (used for Roman Urdu, which is too small for fixed thresholds):
 * letters that appear in at least `min` words, split into thirds by how common they are.
 */
export function bandsFromWords(words, minLen = 4, min = 3) {
  const counts = new Map();
  for (const w of words) {
    if (w.length < Math.max(4, minLen)) continue;
    const seen = new Set();
    for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= w.length; i++) seen.add(w.slice(i, i + n));
    for (const k of seen) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const bands = { easy: { 2: [], 3: [] }, normal: { 2: [], 3: [] }, hard: { 2: [], 3: [] } };
  for (const len of [2, 3]) {
    const ranked = [...counts].filter(([k, c]) => k.length === len && c >= min && !BLOCKED_SET.has(k))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
    const third = Math.ceil(ranked.length / 3);
    bands.easy[len] = ranked.slice(0, third);
    bands.normal[len] = ranked.slice(third, third * 2);
    bands.hard[len] = ranked.slice(third * 2);
  }
  return bands;
}

export function promptBands(list, lex) {
  if (list === 'ur') return bandsFromWords(lex.urWords);
  return EN_BANDS;
}

// "Ramp up" starts easy and gets harder as the game goes on
export function bandFor(difficulty, wordsPlayed) {
  if (difficulty !== 'ramp') return difficulty;
  if (wordsPlayed < 8) return 'easy';
  if (wordsPlayed < 20) return 'normal';
  return 'hard';
}

// A prompt for the given band and length setting, avoiding recently used ones
export function pickPrompt(bands, band, promptLen, rnd, recent = []) {
  const lens = promptLen === '2' ? [2] : promptLen === '3' ? [3] : [2, 3];
  const len = lens[Math.floor(rnd() * lens.length)];
  let pool = (bands[band] && bands[band][len]) || [];
  if (!pool.length) pool = lens.flatMap((l) => (bands.normal && bands.normal[l]) || []);
  const fresh = pool.filter((p) => !recent.includes(p));
  const from = fresh.length ? fresh : pool;
  return from[Math.floor(rnd() * from.length)] || 'an';
}

// ---------- Turns ----------

// The next player after `fromId` (in seat order) who can take the banana. If nobody else
// can, the banana stays with fromId (when they can still hold it) or goes to nobody.
export function nextHolder(order, fromId, canHold) {
  const n = order.length;
  const start = order.indexOf(fromId);
  for (let step = 1; step <= n; step++) {
    const id = order[(start + step + n) % n];
    if (id !== fromId && canHold(id)) return id;
  }
  return canHold(fromId) ? fromId : null;
}

// ---------- Bonus letters ----------

export function bonusLetters(bonus) {
  if (bonus === 'off') return '';
  const all = 'abcdefghijklmnopqrstuvwxyz';
  return bonus === 'easy' ? all.replace(/[qxz]/g, '') : all;
}

// Adds a word's letters to what the player has collected. When they've got them all,
// they earn a life (if below the cap) and start collecting again.
export function addLetters(have, word, bonus) {
  const need = bonusLetters(bonus);
  if (!need) return { letters: have, complete: false };
  const set = new Set(have);
  for (const c of word) if (need.includes(c)) set.add(c);
  const complete = [...need].every((c) => set.has(c));
  return { letters: complete ? '' : [...need].filter((c) => set.has(c)).join(''), complete };
}

// ---------- Daily ----------

export const DAILY_EPOCH = '2026-11-10';
export const DAILY_COUNT = 10;
export const DAILY_SKIP_MS = 10000;

export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dailyNumber(key) {
  const [y, m, d] = key.split('-').map(Number);
  const [ey, em, ed] = DAILY_EPOCH.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ey, em - 1, ed)) / 86400000) + 1;
}

function hashString(s) {
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// The same 10 letter sets for everyone on a given date (normal difficulty, English)
export function dailyPrompts(key) {
  const rnd = mulberry32(hashString(`rotten-daily-${key}`));
  const out = [];
  while (out.length < DAILY_COUNT) out.push(pickPrompt(EN_BANDS, 'normal', 'mix', rnd, out));
  return out;
}

// Daily score: total time, plus a penalty for every skip
export const dailyTotal = (times) => times.reduce((sum, t) => sum + (t == null ? DAILY_SKIP_MS : t), 0);

export function dailySquare(ms) {
  if (ms == null) return '⬛';
  if (ms < 5000) return '🍌';
  if (ms < 15000) return '🟨';
  return '🟫';
}

export function formatMs(ms) {
  const s = Math.max(0, Math.round(ms / 100) / 10);
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
