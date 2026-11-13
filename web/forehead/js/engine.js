// Forehead: game rules. Pure functions, no network or page code, so they can be tested.
// The server imports this file (server/src/games/forehead.ts); the page uses the labels and limits.

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const QUESTION_MAX = 100;
export const GUESS_MAX = 40;
// How long each step of a turn may take
export const TIMES = { askMs: 45000, answerMs: 20000, decideMs: 30000 };
// Host's round timer in minutes (0 = no timer)
export const ROUND_MINUTES = [5, 8, 12, 0];
export const DEFAULT_MINUTES = 8;
// Questions asked so far take points off the top prize, but a guess is never worth less than this
export const TOP_POINTS = 12;
export const MIN_POINTS = 2;
export const FIRST_BONUS = 2;

export const DECKS = [
  { id: 'animals', name: 'Animals', fuzzy: true },
  { id: 'food', name: 'Food', fuzzy: true },
  { id: 'objects', name: 'Everyday objects', fuzzy: true },
  { id: 'jobs', name: 'Jobs', fuzzy: true },
  { id: 'famous', name: 'Famous people', fuzzy: true },
  { id: 'numbers', name: 'Numbers (1 to 100)', fuzzy: false, numbers: true },
];
export const DECK_IDS = DECKS.map((d) => d.id);
export const DEFAULT_DECK = 'animals';
export const deckInfo = (id) => DECKS.find((d) => d.id === id) || DECKS[0];

// What the others can answer. The Numbers deck swaps the two soft answers for Higher / Lower.
export const ANSWERS = {
  words: [['yes', 'Yes'], ['no', 'No'], ['sort', 'Sort of'], ['dunno', 'Don’t know']],
  numbers: [['yes', 'Yes'], ['no', 'No'], ['higher', 'Higher'], ['lower', 'Lower']],
};
export const answerList = (deckId) => (deckInfo(deckId).numbers ? ANSWERS.numbers : ANSWERS.words);
export const answerKeys = (deckId) => answerList(deckId).map(([k]) => k);

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

export function shuffle(list, rnd) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Settings ----------

/** The host's settings, whatever the browser sent: anything unknown falls back to the default. */
export function cleanSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    deck: DECK_IDS.includes(r.deck) ? r.deck : DEFAULT_DECK,
    minutes: ROUND_MINUTES.includes(r.minutes) ? r.minutes : DEFAULT_MINUTES,
  };
}

// ---------- Text ----------

const ARTICLES = new Set(['the', 'a', 'an']);

/** Lower case, no accents, punctuation turned into spaces: "Beyoncé's  Lemonade!" -> "beyonce s lemonade". */
export function tokens(raw) {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The form a guess is compared in: tokens without a leading "the/a/an" and without spaces ("The Beatles" -> "beatles"). */
export function squash(raw) {
  const words = tokens(raw).split(' ').filter(Boolean);
  if (words.length > 1 && ARTICLES.has(words[0])) words.shift();
  return words.join('');
}

/** A question as it will be shown: no control characters or angle brackets, one line, at most QUESTION_MAX characters. Empty if unusable. */
export function cleanQuestion(raw) {
  if (typeof raw !== 'string') return '';
  const q = raw.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, QUESTION_MAX).trim();
  return squash(q).length >= 2 ? q : '';
}

/** A typed guess, trimmed to GUESS_MAX. Empty if there is nothing to compare. */
export function cleanGuess(raw) {
  if (typeof raw !== 'string') return '';
  const g = raw.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, GUESS_MAX).trim();
  return squash(g) ? g : '';
}

// ---------- Decks ----------

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 1 to 100 in English words ("forty two"). */
export function numberWords(n) {
  if (n === 100) return 'one hundred';
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
}

function entryOf(name, aliases) {
  const names = [name, ...aliases];
  return { name, aliases, keys: [...new Set(names.map(squash).filter(Boolean))], toks: [...new Set(names.map(tokens).filter(Boolean))] };
}

/**
 * A deck from a word-list file: one card per line, `Name|alias|alias`. Numbers is built, not read.
 * `index` maps every spelling (name and aliases, squashed) to its card so a near-miss can be checked against the others.
 */
export function makeDeck(id, text = '') {
  const info = deckInfo(id);
  const entries = [];
  if (info.numbers) {
    for (let n = 1; n <= 100; n++) entries.push(entryOf(String(n), [numberWords(n)]));
  } else {
    for (const line of String(text).replace(/\r/g, '').split('\n')) {
      const [name, ...aliases] = line.split('|').map((s) => s.trim());
      if (name) entries.push(entryOf(name, aliases.filter(Boolean)));
    }
  }
  const index = new Map();
  entries.forEach((e, i) => { for (const k of e.keys) if (!index.has(k)) index.set(k, i); });
  return { id: info.id, name: info.name, fuzzy: info.fuzzy, numbers: Boolean(info.numbers), entries, index };
}

// ---------- Dealing ----------

/**
 * Give `count` players a card each from a deck of `size`, all different, and none that this room has already
 * dealt (`used` = indexes dealt so far in the current pass through the deck). When the deck runs out the
 * unused cards are dealt first and a new pass starts. Returns the picks in player order and the new `used`.
 */
export function deal(size, count, used, rnd) {
  const n = Math.min(count, size);
  const taken = new Set((used || []).filter((i) => Number.isInteger(i) && i >= 0 && i < size));
  const fresh = [];
  for (let i = 0; i < size; i++) if (!taken.has(i)) fresh.push(i);
  if (fresh.length >= n) {
    const picks = shuffle(fresh, rnd).slice(0, n);
    for (const p of picks) taken.add(p);
    return { picks, used: [...taken] };
  }
  // Not enough fresh cards: use up the rest, then start a new pass with the others
  const picks = shuffle(fresh, rnd);
  const rest = [];
  for (let i = 0; i < size; i++) if (!picks.includes(i)) rest.push(i);
  const more = shuffle(rest, rnd).slice(0, n - picks.length);
  return { picks: [...picks, ...more], used: more };
}

// ---------- Guessing ----------

/** How many typos a guess may have, by the length of the answer it is compared with. */
export function tolerance(len) {
  return len >= 9 ? 2 : len >= 5 ? 1 : 0;
}

/** Edits (insert, delete, change, or swap two neighbours) needed to turn a into b; stops counting above `max`. */
export function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let prevBest = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < best) best = v;
    }
    // A swap looks two rows back, so only give up once two rows in a row are over the limit
    if (best > max && prevBest > max) return max + 1;
    prevBest = best;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Is this the card? Case, accents, spaces and punctuation don't matter, and the card's aliases count.
 * Words allow a typo (1 edit for answers of 5+ letters, 2 for 9+), except when the guess is exactly another
 * card of the same deck (so "maple" is never accepted for "apple" if "maple" is a card). Numbers must be exact.
 */
export function guessMatches(raw, deck, cardIndex) {
  const card = deck.entries[cardIndex];
  if (!card) return false;
  const g = squash(raw);
  if (!g) return false;
  if (card.keys.includes(g)) return true;
  if (!deck.fuzzy) return false;
  const other = deck.index.get(g);
  if (other !== undefined && other !== cardIndex) return false;
  return card.keys.some((k) => {
    const tol = tolerance(k.length);
    return tol > 0 && editDistance(g, k, tol) <= tol;
  });
}

/** Does a piece of text name this card? Used to hide a message from the one player it would spoil. */
export function mentionsCard(textTokens, card) {
  if (!textTokens || !card) return false;
  const padded = ` ${textTokens} `;
  const squashed = textTokens.replace(/ /g, '');
  return card.toks.some((t) => {
    if (t.length < 1 || (t.length < 2 && !/^\d$/.test(t))) return false;
    if (padded.includes(` ${t} `)) return true;
    const sq = t.replace(/ /g, '');
    return sq.length >= 6 && squashed.includes(sq);
  });
}

// ---------- Answers and points ----------

/** The most-picked answers in a tally ({ yes: 2, no: 1 }): more than one if tied, none if nobody answered. */
export function majority(tally, keys) {
  let top = 0;
  for (const k of keys) top = Math.max(top, tally[k] || 0);
  return top ? keys.filter((k) => (tally[k] || 0) === top) : [];
}

/** Count the answers that are valid for this deck. */
export function tallyAnswers(answers, keys) {
  const out = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const a of Object.values(answers)) if (Object.hasOwn(out, a)) out[a]++;
  return out;
}

/** Points for a right guess: fewer questions is better, never under 2, plus 2 for the first right guess of the round. */
export function points(questionsAsked, first) {
  return Math.max(MIN_POINTS, TOP_POINTS - Math.max(0, questionsAsked)) + (first ? FIRST_BONUS : 0);
}
