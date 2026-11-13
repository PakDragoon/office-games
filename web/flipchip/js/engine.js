// Flipchip: game rules and the computer player. Pure functions, no network or page code,
// so they can be tested (node test/engine.test.mjs) and run inside a Web Worker.
//
// The board is a flat array of n*n cells: 0 empty, 1 dark, 2 light. Dark moves first.

export const EMPTY = 0;
export const DARK = 1;
export const LIGHT = 2;
export const other = (side) => 3 - side;
export const SIDE_NAME = { 1: 'Dark', 2: 'Light' };

export const MAX_PLAYERS = 8;   // in a room: two play, the rest watch
export const SIZES = [6, 8, 10];
export const LEVELS = ['easy', 'normal', 'hard'];
export const TIMES = { countdownMs: 0, offlineClaimMs: 45000 };
export const REACTIONS = ['👏', '😮', '😂', '😬', '🔥', '🤝'];

export const DEFAULT_SETTINGS = {
  size: 8,          // 6 | 8 | 10
  timer: 'off',     // seconds per move: off | 15 | 30 | 60
  hints: 'on',      // show where you can go: on | off
  colours: 'swap',  // after each game: swap | random | keep
  match: 'open',    // open | 3 | 5 (best of)
};

const CHOICES = {
  size: [6, 8, 10], timer: ['off', '15', '30', '60'], hints: ['on', 'off'],
  colours: ['swap', 'random', 'keep'], match: ['open', '3', '5'],
};

// Settings from storage or a host: anything unknown falls back to the default
export function cleanSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, options] of Object.entries(CHOICES)) {
    const v = typeof options[0] === 'number' ? Number(raw[key]) : String(raw[key]);
    if (options.includes(v)) out[key] = v;
  }
  return out;
}

export const timerMs = (st) => (st.timer === 'off' ? 0 : Number(st.timer) * 1000);
export const matchTarget = (st) => (st.match === 'open' ? 0 : Math.ceil(Number(st.match) / 2));

/* ---------- Board ---------- */

export function newBoard(n) {
  const b = new Array(n * n).fill(EMPTY);
  const h = n / 2;
  b[(h - 1) * n + (h - 1)] = LIGHT;
  b[h * n + h] = LIGHT;
  b[(h - 1) * n + h] = DARK;
  b[h * n + (h - 1)] = DARK;
  return b;
}

const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

/** The chips that placing `who` at cell i would flip (empty list = not a legal move). */
export function flipsFor(b, n, i, who) {
  if (b[i] !== EMPTY) return [];
  const r = Math.floor(i / n), c = i % n, opp = 3 - who;
  const out = [];
  for (const [dr, dc] of DIRS) {
    let rr = r + dr, cc = c + dc;
    const line = [];
    while (rr >= 0 && rr < n && cc >= 0 && cc < n && b[rr * n + cc] === opp) {
      line.push(rr * n + cc);
      rr += dr; cc += dc;
    }
    if (line.length && rr >= 0 && rr < n && cc >= 0 && cc < n && b[rr * n + cc] === who) out.push(...line);
  }
  return out;
}

function flipsAny(b, n, i, who) {
  if (b[i] !== EMPTY) return false;
  const r = Math.floor(i / n), c = i % n, opp = 3 - who;
  for (const [dr, dc] of DIRS) {
    let rr = r + dr, cc = c + dc, seen = 0;
    while (rr >= 0 && rr < n && cc >= 0 && cc < n && b[rr * n + cc] === opp) { rr += dr; cc += dc; seen++; }
    if (seen && rr >= 0 && rr < n && cc >= 0 && cc < n && b[rr * n + cc] === who) return true;
  }
  return false;
}

export function legalMoves(b, n, who) {
  const out = [];
  for (let i = 0; i < b.length; i++) if (flipsAny(b, n, i, who)) out.push(i);
  return out;
}

export function hasMove(b, n, who) {
  for (let i = 0; i < b.length; i++) if (flipsAny(b, n, i, who)) return true;
  return false;
}

function countMoves(b, n, who) {
  let k = 0;
  for (let i = 0; i < b.length; i++) if (flipsAny(b, n, i, who)) k++;
  return k;
}

/** Place a chip. Returns { board, flips } or null when the move isn't legal. */
export function play(b, n, i, who) {
  if (!Number.isInteger(i) || i < 0 || i >= n * n) return null;
  const flips = flipsFor(b, n, i, who);
  if (!flips.length) return null;
  const board = b.slice();
  board[i] = who;
  for (const f of flips) board[f] = who;
  return { board, flips };
}

export function counts(b) {
  const c = { 1: 0, 2: 0, empty: 0 };
  for (const v of b) { if (v === DARK) c[1]++; else if (v === LIGHT) c[2]++; else c.empty++; }
  return c;
}

/**
 * Whose turn after `moved` has played: the other side if they can move, the same side again
 * when the other has to pass, or 0 when nobody can move (game over).
 */
export function nextTurn(b, n, moved) {
  if (hasMove(b, n, 3 - moved)) return 3 - moved;
  if (hasMove(b, n, moved)) return moved;
  return 0;
}

/** Winner by chip count: DARK, LIGHT, or 0 for a draw. */
export function winnerOf(b) {
  const c = counts(b);
  return c[1] > c[2] ? DARK : c[2] > c[1] ? LIGHT : 0;
}

// "d3": column letter then row number, rows counted from the top
export function cellName(i, n) {
  return String.fromCharCode(97 + (i % n)) + (Math.floor(i / n) + 1);
}

/* ---------- Random numbers (seedable for tests) ---------- */

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
export const pick = (list, rnd = Math.random) => list[Math.floor(rnd() * list.length)];

/* =========================================================
   The computer player
   easy:   half random, half "flip the most" (a classic beginner's habit)
   normal: looks two moves ahead with a positional score, with a little randomness
   hard:   searches as deep as it can in the time allowed (corners, mobility, frontier),
           and plays the endgame perfectly once few squares are left
   ========================================================= */

const GEO = new Map();
function geometry(n) {
  if (GEO.has(n)) return GEO.get(n);
  const w = new Array(n * n);
  const neighbours = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const er = Math.min(r, n - 1 - r), ec = Math.min(c, n - 1 - c);
      let v;
      if (er === 0 && ec === 0) v = 100;                                   // corner
      else if (er === 1 && ec === 1) v = -40;                              // X-square
      else if ((er === 0 && ec === 1) || (er === 1 && ec === 0)) v = -15;  // C-square
      else if ((er === 0 && ec === 2) || (er === 2 && ec === 0)) v = 10;
      else if (er === 0 || ec === 0) v = 6;                                // edge
      else if (er === 1 || ec === 1) v = -3;
      else v = 1;
      w[r * n + c] = v;
      const nb = [];
      for (const [dr, dc] of DIRS) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < n && cc >= 0 && cc < n) nb.push(rr * n + cc);
      }
      neighbours.push(nb);
    }
  }
  // Each corner with the squares next to it, which stop being risky once the corner is taken
  const corners = [[0, 0, 1, 1], [0, n - 1, 1, -1], [n - 1, 0, -1, 1], [n - 1, n - 1, -1, -1]].map(([r, c, dr, dc]) => ({
    corner: r * n + c,
    near: [(r + dr) * n + (c + dc), r * n + (c + dc), (r + dr) * n + c],
  }));
  const g = { w, neighbours, corners, endgame: n <= 6 ? 12 : n === 8 ? 10 : 8 };
  GEO.set(n, g);
  return g;
}

const WIN = 100000;

function finalScore(b, who) {
  const c = counts(b);
  const diff = who === DARK ? c[1] - c[2] : c[2] - c[1];
  return diff > 0 ? WIN + diff : diff < 0 ? -WIN + diff : 0;
}

function evaluate(b, n, who) {
  const g = geometry(n);
  const opp = 3 - who;
  let pos = 0, my = 0, op = 0, myF = 0, opF = 0, empties = 0;
  for (let i = 0; i < b.length; i++) {
    const v = b[i];
    if (v === EMPTY) { empties++; continue; }
    const s = v === who ? 1 : -1;
    pos += s * g.w[i];
    if (s > 0) my++; else op++;
    for (const j of g.neighbours[i]) {
      if (b[j] === EMPTY) { if (s > 0) myF++; else opF++; break; }
    }
  }
  if (empties === 0) return finalScore(b, who);
  // Next to a taken corner, the risky squares are safe (cancel their penalty, add a little)
  for (const { corner, near } of g.corners) {
    if (b[corner] === EMPTY) continue;
    for (const j of near) {
      if (b[j] === EMPTY) continue;
      pos += (b[j] === who ? 1 : -1) * (5 - g.w[j]);
    }
  }
  const myM = countMoves(b, n, who), opM = countMoves(b, n, opp);
  if (myM + opM === 0) return finalScore(b, who);
  const mob = (100 * (myM - opM)) / (myM + opM + 2);
  const front = (100 * (opF - myF)) / (myF + opF + 1);
  const phase = empties / (n * n);
  const disc = (100 * (my - op)) / (my + op);
  return pos * 2 + mob * (phase > 0.25 ? 3 : 2) + front + (phase < 0.2 ? disc * 3 : 0);
}

const TIMEOUT = { timeout: true };
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function ordered(b, n, who, first = -1) {
  const g = geometry(n);
  const moves = legalMoves(b, n, who);
  moves.sort((x, y) => (y === first) - (x === first) || g.w[y] - g.w[x]);
  return moves;
}

function apply(b, n, i, who) {
  const nb = b.slice();
  nb[i] = who;
  for (const f of flipsFor(b, n, i, who)) nb[f] = who;
  return nb;
}

function negamax(b, n, who, depth, alpha, beta, ctx) {
  if ((++ctx.nodes & 1023) === 0 && now() > ctx.deadline) throw TIMEOUT;
  const moves = ordered(b, n, who);
  if (!moves.length) {
    if (!hasMove(b, n, 3 - who)) return finalScore(b, who);
    return -negamax(b, n, 3 - who, depth, -beta, -alpha, ctx);   // pass
  }
  if (depth <= 0) return evaluate(b, n, who);
  let best = -Infinity;
  for (const m of moves) {
    const v = -negamax(apply(b, n, m, who), n, 3 - who, depth - 1, -beta, -alpha, ctx);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

// Score every root move at one depth. exact: full window, so every score can be compared;
// otherwise only the best score is exact (the rest are upper bounds), which is faster.
function rootScores(b, n, who, depth, ctx, first, exact = false, only = null) {
  const out = [];
  let alpha = -Infinity;
  for (const m of only || ordered(b, n, who, first)) {
    const v = -negamax(apply(b, n, m, who), n, 3 - who, depth - 1, -Infinity, exact ? Infinity : -alpha, ctx);
    out.push({ m, v });
    if (v > alpha) alpha = v;
  }
  return out;
}

const bestOf = (scored) => scored.reduce((a, s) => (s.v > a.v ? s : a));

/**
 * Pick a move for `who`. Returns a cell index, or -1 when there is no legal move.
 * opts: { rnd: () => number, ms: time budget for hard (default 1100), maxRoot: cap on the moves 'normal' searches (rooms) }
 */
export function chooseMove(b, n, who, level = 'normal', opts = {}) {
  const rnd = opts.rnd || Math.random;
  const moves = legalMoves(b, n, who);
  if (!moves.length) return -1;
  if (moves.length === 1) return moves[0];

  if (level === 'random') return pick(moves, rnd);

  if (level === 'easy') {
    // Grabs chips and corners when it sees them, otherwise plays loosely
    if (rnd() < 0.3) return pick(moves, rnd);
    const g = geometry(n);
    let best = -1, bestV = -Infinity;
    for (const m of moves) {
      const v = flipsFor(b, n, m, who).length * 4 + g.w[m] + rnd() * 50;
      if (v > bestV) { bestV = v; best = m; }
    }
    return best;
  }

  if (level === 'normal') {
    const ctx = { nodes: 0, deadline: Infinity };
    // A room's computer player has a tiny CPU budget (opts.maxRoot): it looks two moves ahead at the few
    // moves that look best after one, instead of at all of them. Same idea, a fraction of the work.
    let only = null;
    if (opts.maxRoot && moves.length > opts.maxRoot) {
      only = moves.map((m) => ({ m, v: evaluate(apply(b, n, m, who), n, who) }))
        .sort((x, y) => y.v - x.v).slice(0, opts.maxRoot).map((x) => x.m);
    }
    const scored = rootScores(b, n, who, 2, ctx, -1, true, only).map((s) => ({ m: s.m, v: s.v + (rnd() - 0.5) * 24 }));
    scored.sort((x, y) => y.v - x.v);
    // Now and then it settles for its second choice, unless that throws away a corner
    if (scored.length > 1 && rnd() < 0.15 && scored[0].v - scored[1].v < 60) return scored[1].m;
    return scored[0].m;
  }

  // hard
  const g = geometry(n);
  const empties = counts(b).empty;
  const start = now();
  const budget = opts.ms ?? 1100;
  let best = bestOf(rootScores(b, n, who, 1, { nodes: 0, deadline: Infinity }, -1)).m;
  if (empties <= g.endgame) {
    try {
      const ctx = { nodes: 0, deadline: start + budget * 2.5 };
      return bestOf(rootScores(b, n, who, empties, ctx, best)).m;
    } catch (e) { if (e !== TIMEOUT) throw e; }
  }
  // Deeper and deeper until time runs out. Odd depths end on our own move and are too
  // hopeful, so the answer comes from the deepest even depth (odd ones only order the moves).
  const ctx = { nodes: 0, deadline: start + budget };
  let order = best;
  for (let depth = 2; depth <= empties; depth++) {
    try {
      order = bestOf(rootScores(b, n, who, depth, ctx, order)).m;
      if (depth % 2 === 0 || depth === empties) best = order;
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      break;
    }
    if (now() - start > budget * 0.3) break;   // the next depth would not finish in time
  }
  return best;
}
