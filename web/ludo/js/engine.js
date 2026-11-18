// Ludo: game rules. Pure functions, no network or page code, so the server, the page and the tests share them.
//
// 2 to 4 players (or 2 vs 2 in teams) race their tokens once round a 52-square track and up their own home
// lane. A token leaves its yard on a 6 (or a 1 or 6), lands on rivals to send them back, and squares with a
// star are safe. The host picks the house rules (see DEFAULT_SETTINGS). The server owns the dice and runs
// these functions; the page uses the same file to draw the board and preview moves.
//
// Geometry: a 15 × 15 grid. Colour 0 has the top-left yard and the others follow clockwise (1 top-right,
// 2 bottom-right, 3 bottom-left); every colour's board is colour 0's turned by a quarter per colour.
//
// A token's position `p` is counted from its own start square:
//   -1        in the yard
//   0 … 50    on the track (0 = its start square, 50 = the square in front of its home lane)
//   51        the square just before its start (only reached when it has to go round again, see mustCapture)
//   52 … 56   its home lane
//   57        home

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;   // people in the room (4 play, the rest watch)
export const SEATS = 4;
export const BASE = -1;
export const LAST_TRACK = 50;
export const LANE = 52;
export const HOME = 57;
export const TRACK = 52;
export const COLOUR_NAMES = ['Red', 'Green', 'Yellow', 'Blue'];
/** Seats filled in this order, so two players sit opposite each other. */
export const SEAT_ORDER = [0, 2, 1, 3];
export const STARTS = [0, 13, 26, 39];
export const STARS = [8, 21, 34, 47];

export const TIMERS = [0, 10, 15, 30];
export const TOKENS = [2, 3, 4];
export const DEFAULT_SETTINGS = {
  tokens: 4,            // tokens per player
  leave: 'six',         // 'six' | 'oneSix': the rolls that bring a token out of the yard
  bonusSix: true,       // a 6 gives another roll
  bonusCapture: true,   // sending a rival home gives another roll
  bonusHome: true,      // getting a token home gives another roll
  threeSixes: 'lose',   // 'lose': a third 6 in a row ends the turn with no move | 'allow'
  safe: 'stars',        // 'stars' (start squares and stars) | 'starts' (start squares only) | 'none'
  blocks: false,        // two tokens of one colour on a square can't be passed or landed on by rivals
  mustCapture: false,   // a colour must send a rival home before its tokens may enter the home lane
  exact: true,          // a token needs the exact roll to get home
  timer: 15,            // seconds per roll or move (0: no timer; a player who stops for TIMES.idleMs is played for)
  end: 'first',         // 'first': the game ends when the first player is home | 'all': play on for every place
  teams: false,         // 2 vs 2, partners opposite (Red + Yellow against Green + Blue); needs four players
};

export const TIMES = {
  idleMs: 60000,        // no timer: a person who does nothing this long is played for
  idleStrikes: 3,       // played for this many times in a row: the computer keeps playing for them until they act
  passMs: 1400,         // "no move" / "three sixes" stays on screen this long before the turn moves on
  autoMoveMs: 900,      // only one possible move: it is played for you after this long (after the die lands)
  offlineOutMs: 60000,  // gone this long mid-game: the computer plays for them
};

const pick = (v, list, d) => (list.includes(v) ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

export function cleanSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    tokens: pick(r.tokens, TOKENS, d.tokens),
    leave: pick(r.leave, ['six', 'oneSix'], d.leave),
    bonusSix: bool(r.bonusSix, d.bonusSix),
    bonusCapture: bool(r.bonusCapture, d.bonusCapture),
    bonusHome: bool(r.bonusHome, d.bonusHome),
    threeSixes: pick(r.threeSixes, ['lose', 'allow'], d.threeSixes),
    safe: pick(r.safe, ['stars', 'starts', 'none'], d.safe),
    blocks: bool(r.blocks, d.blocks),
    mustCapture: bool(r.mustCapture, d.mustCapture),
    exact: bool(r.exact, d.exact),
    timer: pick(r.timer, TIMERS, d.timer),
    end: pick(r.end, ['first', 'all'], d.end),
    teams: bool(r.teams, d.teams),
  };
}

export const timerMs = (s) => (s.timer ? s.timer * 1000 : 0);
export const leaveRolls = (s) => (s.leave === 'oneSix' ? [1, 6] : [6]);
export const partner = (c) => (c + 2) % 4;

/* =========================================================
   Board geometry (cell [col, row] on the 15 × 15 grid)
   ========================================================= */

// Colour 0's quarter of the track: from its start square, along to just past the top of the board
const QUARTER = [[1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0], [7, 0], [8, 0]];
const LANE_CELLS = [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]];

/** A cell turned k quarter turns clockwise round the centre. */
export function rotCell([c, r], k) {
  let x = c, y = r;
  for (let n = 0; n < ((k % 4) + 4) % 4; n++) [x, y] = [14 - y, x];
  return [x, y];
}
/** A point (in cell units, 0 … 15) turned k quarter turns clockwise round the centre. */
export function rotPoint([px, py], k) {
  let x = px, y = py;
  for (let n = 0; n < ((k % 4) + 4) % 4; n++) [x, y] = [15 - y, x];
  return [x, y];
}

export const trackCell = (abs) => rotCell(QUARTER[abs % 13], Math.floor(abs / 13));
export const laneCell = (c, j) => rotCell(LANE_CELLS[j], c);
/** The track square (0 … 51) a token is on, or -1 in the yard, the lane or home. */
export const absOf = (c, p) => (p >= 0 && p <= 51 ? (STARTS[c] + p) % TRACK : -1);

/** Centre (in cell units) of where a token at `p` stands; yard and home slots use the token's index. */
export function spot(c, p, i) {
  if (p === BASE) return rotPoint([[2, 4, 2, 4][i % 4], [2, 2, 4, 4][i % 4]], c);
  if (p === HOME) return rotPoint([[6.5, 6.5, 7.05, 6.5][i % 4], [6.9, 8.1, 7.5, 7.5][i % 4]], c);
  const [x, y] = p >= LANE ? laneCell(c, p - LANE) : trackCell(absOf(c, p));
  return [x + 0.5, y + 0.5];
}

export function isSafe(s, abs) {
  if (abs < 0) return true;
  if (s.safe === 'none') return false;
  if (STARTS.includes(abs)) return true;
  return s.safe === 'stars' && STARS.includes(abs);
}

/* =========================================================
   A game
   ========================================================= */

/**
 * A new game for these colours (seat numbers, 0 … 3). `first` is the colour that rolls first.
 * Everything a game needs is in the returned object, so the room can save it as it is.
 */
export function newGame(settings, colours, first) {
  const s = cleanSettings(settings);
  const cols = [...new Set(colours)].filter((c) => c >= 0 && c < SEATS).sort((a, b) => a - b);
  const tokens = {};
  const stats = {};
  for (const c of cols) {
    tokens[c] = Array(s.tokens).fill(BASE);
    stats[c] = { rolls: 0, sixes: 0, captures: 0, captured: 0, home: 0 };
  }
  // Teams only with all four colours
  if (cols.length !== 4) s.teams = false;
  return {
    settings: s, colours: cols, tokens, stats,
    turn: cols.includes(first) ? first : cols[0],
    phase: 'roll',        // 'roll' | 'move' | 'pass' | 'over'
    roll: 0,
    sixes: 0,             // 6s in a row this turn
    passWhy: '',          // 'nomove' | 'sixes' while phase is 'pass'
    legal: [],            // the moves the roll allows (phase 'move')
    killed: {},           // colour -> has sent a rival home (mustCapture)
    done: [],             // colours in the order they got every token home
    seq: 0,               // goes up with every roll and move (stale messages are ignored)
    events: [],           // the last few things that happened, for the page's animations
    result: null,
  };
}

export const finished = (g, c) => Boolean(g.tokens[c]) && g.tokens[c].every((p) => p === HOME);
const enemy = (g, a, b) => a !== b && !(g.settings.teams && partner(a) === b);

/** The colours whose tokens colour c moves now: its own, or (in teams, once it is home) its partner's. */
export function controls(g, c) {
  if (!g.tokens[c]) return [];
  if (!finished(g, c)) return [c];
  if (g.settings.teams && g.tokens[partner(c)] && !finished(g, partner(c))) return [partner(c)];
  return [];
}

/** Every token on a track square: [{ c, i }]. */
export function tokensAt(g, abs) {
  const out = [];
  for (const c of g.colours) g.tokens[c].forEach((p, i) => { if (absOf(c, p) === abs) out.push({ c, i }); });
  return out;
}

/** A rival block (two or more tokens of one rival colour) stands on this square. Blocks only exist when the rule is on. */
function blocked(g, abs, c) {
  if (!g.settings.blocks || abs < 0) return false;
  const count = {};
  for (const t of tokensAt(g, abs)) if (enemy(g, c, t.c)) count[t.c] = (count[t.c] || 0) + 1;
  return Object.values(count).some((n) => n >= 2);
}

const canEnterLane = (g, c) => !g.settings.mustCapture || Boolean(g.killed[c]);

/** One square on from p for a token of colour c. */
function nextPos(g, c, p) {
  if (p >= LANE) return p + 1;
  if (p === LAST_TRACK && canEnterLane(g, c)) return LANE;
  return (p + 1) % TRACK;
}

/**
 * Where token i of colour c goes on this roll: { c, i, from, to, path, cap, home }, or null when it can't move.
 * `path` lists every position it steps on (for the animation); `cap` the rival tokens it sends home.
 */
export function moveFor(g, c, i, roll) {
  const s = g.settings;
  const p = g.tokens[c]?.[i];
  if (p === undefined || p === HOME) return null;
  let to, path;
  if (p === BASE) {
    if (!leaveRolls(s).includes(roll)) return null;
    if (blocked(g, absOf(c, 0), c)) return null;
    to = 0;
    path = [0];
  } else {
    path = [];
    let q = p;
    for (let k = 0; k < roll; k++) {
      if (q === HOME) {
        if (s.exact) return null;
        break;
      }
      q = nextPos(g, c, q);
      if (q <= 51 && blocked(g, absOf(c, q), c)) return null;   // a rival block can't be passed or landed on
      path.push(q);
    }
    to = q;
  }
  const abs = absOf(c, to);
  const cap = abs >= 0 && !isSafe(s, abs) ? tokensAt(g, abs).filter((t) => enemy(g, c, t.c)) : [];
  return { c, i, from: p, to, path, cap, home: to === HOME };
}

/** Every move the roll allows the colour whose turn it is. */
export function legalMoves(g, roll) {
  const out = [];
  for (const tc of controls(g, g.turn)) g.tokens[tc].forEach((_, i) => { const m = moveFor(g, tc, i, roll); if (m) out.push(m); });
  return out;
}

/** Moves that really differ (four tokens in the yard on a 6 are one choice, not four). */
export function distinctMoves(list) {
  const seen = new Set();
  return list.filter((m) => {
    const k = `${m.c}:${m.from}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function addEvent(g, e) {
  g.events.push({ s: g.seq, ...e });
  if (g.events.length > 16) g.events.splice(0, g.events.length - 16);
}

/** The colour whose turn it is rolls `value` (1 … 6). Returns false if it isn't time to roll. */
export function roll(g, value) {
  if (g.phase !== 'roll' || !(value >= 1 && value <= 6)) return false;
  const c = g.turn;
  g.seq++;
  g.roll = value;
  g.stats[c].rolls++;
  if (value === 6) {
    g.sixes++;
    g.stats[c].sixes++;
  } else g.sixes = 0;
  addEvent(g, { k: 'roll', c, v: value });
  if (value === 6 && g.settings.threeSixes === 'lose' && g.sixes >= 3) {
    g.phase = 'pass';
    g.passWhy = 'sixes';
    g.legal = [];
    return true;
  }
  g.legal = legalMoves(g, value);
  if (!g.legal.length) {
    g.phase = 'pass';
    g.passWhy = 'nomove';
    return true;
  }
  g.phase = 'move';
  return true;
}

/** After "no move" or "three sixes": the turn moves on. */
export function pass(g) {
  if (g.phase !== 'pass') return false;
  g.seq++;
  addEvent(g, { k: 'pass', c: g.turn, why: g.passWhy });
  endTurn(g, false);
  return true;
}

/** Move token i of colour c (one of g.legal). Returns the move, or null if it isn't allowed. */
export function move(g, c, i) {
  if (g.phase !== 'move') return null;
  const m = g.legal.find((x) => x.c === c && x.i === i);
  if (!m) return null;
  const s = g.settings;
  const by = g.turn;
  g.seq++;
  const capFrom = m.cap.map((v) => ({ c: v.c, i: v.i, from: g.tokens[v.c][v.i] }));
  g.tokens[c][i] = m.to;
  for (const v of m.cap) {
    g.tokens[v.c][v.i] = BASE;
    g.stats[v.c].captured++;
  }
  if (m.cap.length) {
    g.killed[c] = true;
    g.stats[by].captures += m.cap.length;
  }
  if (m.home) g.stats[by].home++;
  addEvent(g, { k: 'move', c, i, by, from: m.from, path: m.path, cap: capFrom, home: m.home });
  if (finished(g, c) && !g.done.includes(c)) {
    g.done.push(c);
    addEvent(g, { k: 'done', c, place: g.done.length });
  }
  if (checkOver(g)) return m;
  const extra = (g.roll === 6 && s.bonusSix) || (m.cap.length > 0 && s.bonusCapture) || (m.home && s.bonusHome);
  endTurn(g, extra);
  return m;
}
function endTurn(g, extra) {
  g.legal = [];
  g.roll = 0;
  g.passWhy = '';
  if (extra && controls(g, g.turn).length) {
    g.phase = 'roll';
    return;
  }
  g.sixes = 0;
  g.phase = 'roll';
  g.turn = nextColour(g, g.turn);
}

function nextColour(g, from) {
  const order = g.colours;
  const at = order.indexOf(from);
  for (let k = 1; k <= order.length; k++) {
    const c = order[(at + k) % order.length];
    if (controls(g, c).length) return c;
  }
  return from;
}

/** How far a colour has got (for ranking players who didn't finish). */
export function progress(g, c) {
  return (g.tokens[c] || []).reduce((n, p) => n + (p === BASE ? 0 : p === HOME ? 58 : p + 1), 0);
}

/** Colours from first place to last: finished in order, then by how far they got. */
export function standings(g) {
  if (g.settings.teams) {
    const teamDone = (t) => finished(g, t) && finished(g, partner(t));
    const win = [0, 1].find(teamDone);
    const team = (t) => [t, partner(t)];
    if (win !== undefined) return [...team(win), ...team(1 - win)];
    const prog = (t) => progress(g, t) + progress(g, partner(t));
    return prog(0) >= prog(1) ? [0, 2, 1, 3] : [1, 3, 0, 2];
  }
  const rest = g.colours.filter((c) => !g.done.includes(c)).sort((a, b) => progress(g, b) - progress(g, a));
  return [...g.done, ...rest];
}

function checkOver(g) {
  let over = false;
  if (g.settings.teams) over = [0, 1].some((t) => finished(g, t) && finished(g, partner(t)));
  else {
    const left = g.colours.filter((c) => !finished(g, c));
    over = g.settings.end === 'first' ? g.done.length >= 1 : left.length <= 1;
  }
  if (!over) return false;
  finish(g);
  return true;
}

/** End the game now (also used when the host stops it). result: { order: colours best first, winners: colours }. */
export function finish(g) {
  const order = standings(g);
  const teams = g.settings.teams;
  const anyHome = g.done.length > 0;
  const winners = !anyHome ? [] : teams ? [order[0], order[1]] : [order[0]];
  g.phase = 'over';
  g.legal = [];
  g.result = { order, winners, places: placesOf(g, order) };
  return g.result;
}

function placesOf(g, order) {
  const places = {};
  if (g.settings.teams) order.forEach((c, k) => { places[c] = k < 2 ? 1 : 2; });
  else order.forEach((c, k) => { places[c] = k + 1; });
  return places;
}

/* =========================================================
   The computer player (bots, and anyone the computer plays for)
   ========================================================= */

/** Rival tokens that could land on this track square with one roll (1 … 6) from behind. */
function threats(g, c, abs) {
  if (abs < 0 || isSafe(g.settings, abs)) return 0;
  let n = 0;
  for (const e of g.colours) {
    if (!enemy(g, c, e)) continue;
    g.tokens[e].forEach((p) => {
      const ea = absOf(e, p);
      if (ea >= 0) {
        const d = (abs - ea + TRACK) % TRACK;
        if (d >= 1 && d <= 6 && p + d <= LAST_TRACK) n++;
      } else if (p === BASE && abs === STARTS[e] && !isSafe(g.settings, abs)) n += 0.5;
    });
  }
  return n;
}

/** How good a move looks to a careful player (higher is better). */
export function scoreMove(g, m) {
  let score = 0;
  const steps = m.from === BASE ? 0 : m.to - m.from;
  for (const v of m.cap) score += 60 + progress(g, v.c) / 8 + (g.tokens[v.c][v.i] + 1) * 0.6;
  if (m.home) score += 45;
  else if (m.to >= LANE && m.from < LANE) score += 28;
  if (m.from === BASE) score += 32;
  const toAbs = absOf(m.c, m.to);
  const fromAbs = absOf(m.c, m.from);
  if (toAbs >= 0 && isSafe(g.settings, toAbs)) score += 12;
  score -= threats(g, m.c, toAbs) * 20;
  if (fromAbs >= 0) score += threats(g, m.c, fromAbs) * 16;
  if (g.settings.blocks && toAbs >= 0 && tokensAt(g, toAbs).some((t) => t.c === m.c)) score += 8;
  score += Math.max(0, steps) * 0.4 + Math.max(0, m.from) * 0.05;
  return score;
}

/** The computer's pick from g.legal: 'easy' takes any move, 'normal' weighs them up. */
export function chooseMove(g, level, rnd = Math.random) {
  const list = g.legal;
  if (!list.length) return null;
  if (level === 'easy') return list[Math.floor(rnd() * list.length)];
  let best = null;
  let bestScore = -Infinity;
  for (const m of list) {
    const sc = scoreMove(g, m) + rnd() * 3;
    if (sc > bestScore) { best = m; bestScore = sc; }
  }
  return best;
}

/** A die: 1 … 6 from a random number in [0, 1). */
export const die = (r) => Math.min(6, Math.floor(r * 6) + 1);

/** Which colours a set of seated players plays, in seat order. */
export const playing = (seats) => [0, 1, 2, 3].filter((c) => seats[c]);
