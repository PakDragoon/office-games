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
