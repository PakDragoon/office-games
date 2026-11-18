// Fast Fingers: game rules. Pure functions, no network or page code, so they can be tested.
//
// Everyone gets the same paragraph and types it as fast as they can. A wrong key doesn't move
// you on: you have to hit the right one. Speed is words per minute, where a word is 5 characters.
import { PASSAGES } from './passages.js';

export { PASSAGES };
export const MAX_PLAYERS = 8;
export const MAX_CPS = 22;            // characters a second nobody can really type (about 260 wpm)
export const MAX_WPM = 300;
export const TIMES = { countdownMs: 3000, endPauseMs: 800 };

export const DEFAULT_SETTINGS = {
  length: 'medium',   // short | medium | long
  caps: 'on',         // on: capital letters matter. off: everything is lower case
  punct: 'on',        // on: commas, full stops and the rest. off: letters, numbers and spaces only
};
const CHOICES = { length: ['short', 'medium', 'long'], caps: ['on', 'off'], punct: ['on', 'off'] };

export function cleanSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const [key, options] of Object.entries(CHOICES)) {
      const v = String(raw[key]);
      if (options.includes(v)) out[key] = v;
    }
  }
  return out;
}

/* ---------- The paragraph ---------- */

// A race takes whole sentences from the start of a passage until it has this many words
export const TARGET_WORDS = { short: 20, medium: 45, long: 90 };
export const ABOUT_WORDS = { short: 30, medium: 55, long: 105 };

export const wordCount = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);

export function sentences(passage) {
  return (passage.match(/[^.?!]+[.?!]+"?/g) || [passage]).map((s) => s.trim()).filter(Boolean);
}

export function cut(passage, length) {
  const target = TARGET_WORDS[length] || TARGET_WORDS.medium;
  const out = [];
  let words = 0;
  for (const s of sentences(passage)) {
    out.push(s);
    words += wordCount(s);
    if (words >= target) break;
  }
  return out.join(' ');
}

/** Apply the room's options: no punctuation and/or no capitals. */
export function strip(text, st) {
  let t = text;
  if (st.punct === 'off') t = t.replace(/-/g, ' ').replace(/[^A-Za-z0-9 ]/g, '').replace(/ +/g, ' ').trim();
  if (st.caps === 'off') t = t.toLowerCase();
  return t;
}

export const makeText = (index, st) => strip(cut(PASSAGES[index], st.length), st);

/** A passage this room hasn't had yet (or any, once they've all been used). */
export function pickPassage(rnd = Math.random, used = new Set()) {
  const all = PASSAGES.map((_, i) => i);
  const fresh = all.filter((i) => !used.has(i));
  const from = fresh.length ? fresh : all;
  return from[Math.floor(rnd() * from.length)];
}

/* ---------- Typing ---------- */

// Phones like to type curly quotes and long dashes: treat them as the plain keys
const SAME = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', ' ': ' ' };
export const normalKey = (ch) => SAME[ch] || ch;

/** Is `typed` the right key for the character `want`? */
export function hit(want, typed, st) {
  const ch = normalKey(String(typed || ''));
  if (ch.length !== 1 || !want) return false;
  return st.caps === 'off' ? ch.toLowerCase() === want.toLowerCase() : ch === want;
}

/** Words per minute: 5 characters count as a word. */
export function wpm(chars, ms) {
  if (!(ms > 0) || !(chars > 0)) return 0;
  return Math.min(MAX_WPM, Math.round((chars / 5) / (ms / 60000)));
}

/** Right keys out of all keys pressed, as a whole percentage. */
export function accuracy(pos, err) {
  const total = pos + err;
  return total > 0 ? Math.round((pos / total) * 100) : 100;
}

/** Could a person have typed `pos` characters in `elapsedMs`? (stops made-up finishes) */
export const plausible = (pos, elapsedMs) => pos <= ((elapsedMs + 1500) / 1000) * MAX_CPS + 5;

/** The longest a race may last: enough for a slow 15 words a minute, at least 45 seconds. */
export const limitMs = (text) => Math.max(45000, wordCount(text) * 4000);

/** Once the first player finishes, the rest get this much longer. */
export const graceMs = (winnerMs) => Math.max(20000, Math.round(winnerMs * 1.5));

/** Order for the podium: finished first (fastest first), then whoever got furthest. */
export function rank(rows) {
  return rows.slice().sort((a, b) => (b.done - a.done) || (a.done ? a.ms - b.ms : b.pos - a.pos) || (a.err - b.err));
}

/* ---------- The daily paragraph (run by the server: server/src/daily/fastfingers.ts) ---------- */

// One paragraph for everyone each UTC day, always medium length with capitals and punctuation
export const DAILY_SETTINGS = { length: 'medium', caps: 'on', punct: 'on' };
export const DAILY_ONE = '2026-11-18';

export function dayNumber(day) {
  const [y, m, d] = day.split('-').map(Number);
  const [y0, m0, d0] = DAILY_ONE.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y0, m0 - 1, d0)) / 86400000) + 1;
}
export const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Today's paragraph, from the server's secret seed: whole sentences of one passage, starting at a
 * sentence the seed picks and going round to the start if needed, until it has about 45 words.
 * Starting mid-passage means it isn't just the opening of a paragraph you practised.
 */
export function dailyText(seed) {
  const rnd = mulberry32(hashString(`fast-fingers:${seed}`));
  rnd();
  const ss = sentences(PASSAGES[Math.floor(rnd() * PASSAGES.length)]);
  const start = Math.floor(rnd() * ss.length);
  const out = [];
  let words = 0;
  for (let i = 0; i < ss.length && words < TARGET_WORDS.medium; i++) {
    const s = ss[(start + i) % ss.length];
    out.push(s);
    words += wordCount(s);
  }
  return out.join(' ');
}

/**
 * The daily's leaderboard score, higher is better: a finished run scores its speed to a tenth of a
 * wpm; a run that ran out of time scores under 1 (the share typed), so it ranks below every finish.
 */
export function dailyScore(chars, len, ms, done) {
  if (!done) return Math.floor((chars / Math.max(1, len)) * 99) / 100;
  return Math.min(MAX_WPM, Math.round(((chars / 5) / (ms / 60000)) * 10) / 10);
}

/* ---------- Random numbers, formatting ---------- */

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
export const randomSeed = () => Math.floor(Math.random() * 2 ** 31);
export function formatMs(ms) {
  const s = Math.max(0, ms) / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
