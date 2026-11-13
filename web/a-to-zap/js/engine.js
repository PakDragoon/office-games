// A to Zap: the rules. Pure (no DOM, no network, no clock): the server imports this file, and the tests run it
// on its own. Anything that decides a round (what an answer is worth, which letters may be picked, which
// settings are legal) lives here once.

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Left out unless the host turns "Hard letters" on. */
export const HARD_LETTERS = 'QXZ';

/** The categories a host can pick from, in the order they are always shown. `id` is also the word list's file name. */
export const CATEGORIES = [
  { id: 'name', label: 'Name' },
  { id: 'place', label: 'Place' },
  { id: 'animal', label: 'Animal' },
  { id: 'produce', label: 'Fruit or vegetable' },
  { id: 'thing', label: 'Thing' },
  { id: 'food', label: 'Food' },
  { id: 'job', label: 'Job' },
  { id: 'colour', label: 'Colour' },
  { id: 'sport', label: 'Sport' },
  { id: 'body', label: 'Body part' },
];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
export const labelOf = (id) => (CATEGORIES.find((c) => c.id === id) || { label: id }).label;
export const MIN_CATEGORIES = 4;
export const MAX_CATEGORIES = 8;

export const TIMES = [60, 90, 120];
/** 26 means "all letters": the game ends when every letter that may be picked has been used. */
export const ROUNDS = [5, 10, 26];

export const DEFAULT_SETTINGS = Object.freeze({
  categories: ['name', 'place', 'animal', 'produce', 'thing'],
  time: 90,
  rounds: 10,
  hard: false,
});

/** Server clocks, in milliseconds. */
export const PICK_MS = 10000;       // the picker has this long to tap a letter, then the server picks one
export const ZAP_MS = 10000;        // after Zap! everyone else has exactly this long
export const VOTE_MS = 20000;       // the room's vote on answers that aren't on a list
export const RESULTS_MS = 40000;    // results stay up this long, then the next round starts by itself
export const MAX_ANSWER_CHARS = 40;

export const POINTS_UNIQUE = 10;
export const POINTS_SHARED = 5;

/* ---------- Settings ---------- */

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The host's settings, cleaned: anything illegal is dropped and the old value kept, so a forged message can
 * never put the room in a state the UI can't show. `base` is the current settings (the defaults at first).
 */
export function cleanSettings(patch, base = DEFAULT_SETTINGS) {
  const out = { ...base, categories: [...base.categories] };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  if (Array.isArray(patch.categories) && patch.categories.length <= 20) {
    const picked = new Set(patch.categories.filter((c) => typeof c === 'string' && CATEGORY_IDS.includes(c)));
    const ordered = CATEGORY_IDS.filter((id) => picked.has(id));   // always shown in the same order
    if (ordered.length >= MIN_CATEGORIES && ordered.length <= MAX_CATEGORIES) out.categories = ordered;
  }
  if (TIMES.includes(patch.time)) out.time = patch.time;
  if (ROUNDS.includes(patch.rounds)) out.rounds = patch.rounds;
  if (typeof patch.hard === 'boolean') out.hard = patch.hard;
  return out;
}

export const sameCategories = same;

/* ---------- Letters ---------- */

/** Letters that may still be picked: not used in this game, and not Q, X, Z unless hard letters are on. */
export function availableLetters(used, hard) {
  return [...LETTERS].filter((l) => !used.includes(l) && (hard || !HARD_LETTERS.includes(l)));
}

export const letterAllowed = (letter, used, hard) => typeof letter === 'string' && availableLetters(used, hard).includes(letter);

/** A random letter from those still available (null when none are left). `rnd` is a 0..1 generator. */
export function pickLetter(used, hard, rnd) {
  const left = availableLetters(used, hard);
  return left.length ? left[Math.floor(rnd() * left.length)] : null;
}

/** How many rounds this game really has: the host's number, but never more than there are letters to pick. */
export function roundsFor(settings) {
  return Math.min(settings.rounds, LETTERS.length - (settings.hard ? 0 : HARD_LETTERS.length));
}

/* ---------- Answers ---------- */

/** What a player typed, cleaned for storing: no control characters, one space between words, at most 40 characters. */
export function cleanAnswer(raw) {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_ANSWER_CHARS);
}

/**
 * The form two answers are compared in: lower case, accents removed, hyphens and slashes as spaces, other marks
 * dropped, one space between words, and a leading "the" removed ("The Nile" is an N). Letters outside a-z
 * (other scripts) disappear, so an answer in them normalizes to nothing.
 */
export function normalize(raw) {
  let s = String(raw ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ø/g, 'o').replace(/đ/g, 'd').replace(/ł/g, 'l').replace(/ı/g, 'i');
  s = s.replace(/&/g, ' and ').replace(/[-_/]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  if (s.startsWith('the ') && s.length > 4) s = s.slice(4);
  return s;
}

/** Does this normalized answer start with the round's letter (given in any case)? */
export function startsWith(norm, letter) {
  return norm.length > 0 && typeof letter === 'string' && letter.length === 1 && norm[0] === letter.toLowerCase();
}

/** The spellings tried against a list: as typed, and the singular of a plural (cats, boxes, berries). */
export function listForms(norm) {
  const forms = [norm];
  if (norm.length > 3) {
    if (norm.endsWith('ies')) forms.push(`${norm.slice(0, -3)}y`);
    if (norm.endsWith('es')) forms.push(norm.slice(0, -2));
    if (norm.endsWith('s')) forms.push(norm.slice(0, -1));
  }
  return forms;
}

/**
 * What one answer is: 'blank' (nothing typed), 'letter' (doesn't start with the round's letter), 'list' (on the
 * server's word list for the category, so accepted at once) or 'unknown' (goes to the room's vote).
 * `has(categoryId, normalized)` asks the word list.
 */
export function judge(letter, categoryId, raw, has) {
  const norm = normalize(raw);
  if (!norm) return { norm, status: 'blank' };
  if (!startsWith(norm, letter)) return { norm, status: 'letter' };
  if (norm.length < 2) return { norm, status: 'unknown' };
  return { norm, status: listForms(norm).some((f) => has(categoryId, f)) ? 'list' : 'unknown' };
}

/** The room's vote on one answer: a majority of thumbs-up or a tie (including nobody voting) accepts it. */
export const voteAccepted = (up, down) => up >= down;

/**
 * The answers that need a vote: one item per different unknown answer in a category, with everyone who gave it
 * (they may not vote on it). `rows` is [{ id, cells: { [categoryId]: { raw, norm, status } } }].
 */
export function pendingVotes(categories, rows) {
  const items = [];
  for (const cat of categories) {
    const byNorm = new Map();
    for (const row of rows) {
      const cell = row.cells[cat];
      if (!cell || cell.status !== 'unknown') continue;
      let item = byNorm.get(cell.norm);
      if (!item) {
        item = { cat, norm: cell.norm, shown: cell.raw, owners: [] };
        byNorm.set(cell.norm, item);
        items.push(item);
      }
      item.owners.push(row.id);
    }
  }
  return items;
}

/**
 * Points for a round. 10 for a valid answer nobody else gave, 5 when another player gave the same valid answer
 * (same after normalizing), 0 for blank or rejected. `accepted(categoryId, normalized)` says whether the room
 * accepted an unknown answer. Returns { [playerId]: { total, unique, cells: { [categoryId]: { raw, norm, status, ok, pts, shared } } } }.
 */
export function scoreRound(categories, rows, accepted) {
  const out = {};
  for (const row of rows) {
    const cells = {};
    for (const cat of categories) {
      const c = row.cells[cat] || { raw: '', norm: '', status: 'blank' };
      cells[cat] = { raw: c.raw, norm: c.norm, status: c.status, ok: c.norm !== '' && (c.status === 'list' || (c.status === 'unknown' && accepted(cat, c.norm))), pts: 0, shared: false };
    }
    out[row.id] = { total: 0, unique: 0, cells };
  }
  for (const cat of categories) {
    const counts = new Map();
    for (const row of rows) {
      const c = out[row.id].cells[cat];
      if (c.ok) counts.set(c.norm, (counts.get(c.norm) || 0) + 1);
    }
    for (const row of rows) {
      const c = out[row.id].cells[cat];
      if (!c.ok) continue;
      c.shared = counts.get(c.norm) > 1;
      c.pts = c.shared ? POINTS_SHARED : POINTS_UNIQUE;
      out[row.id].total += c.pts;
      if (!c.shared) out[row.id].unique += 1;
    }
  }
  return out;
}

/** Has this player filled every category (so they may press Zap!)? `answers` is { [categoryId]: text }. */
export const allFilled = (categories, answers) => categories.every((c) => normalize(answers && answers[c]) !== '');

/** How many categories have something in them. */
export const filledCount = (categories, answers) => categories.filter((c) => normalize(answers && answers[c]) !== '').length;

/** Final order: more points first, then more unique answers; equal on both shares a place. Returns places 1, 2, 2, 4... */
export function rank(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score || b.unique - a.unique);
  let place = 0;
  return sorted.map((p, i) => {
    if (i === 0 || p.score !== sorted[i - 1].score || p.unique !== sorted[i - 1].unique) place = i + 1;
    return { ...p, place };
  });
}
