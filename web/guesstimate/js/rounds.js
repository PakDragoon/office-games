// Guesstimate round engine. Pure functions: no DOM, no network.
import { THINGS } from './weights.js';
// Every puzzle is built from a seed, so every browser given the same seed
// draws exactly the same puzzle. Multiplayer only has to share the seed.

export const KINDS = ['count', 'track', 'angle', 'split', 'time', 'cut', 'balance'];
export const DIFFICULTIES = ['easy', 'normal', 'hard'];
// Puzzles live in a fixed 4:3 box and are scaled to the screen, so a phone
// and a monitor see the same geometry.
export const BOX = { w: 400, h: 300 };

// ---------- Seeded randomness ----------

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

// Mixes a game seed with a round number and test, so each round gets its own stream.
export function roundSeed(gameSeed, index, kind) {
  let h = (gameSeed ^ 0x9e3779b9) >>> 0;
  const s = `${index}:${kind}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

export const randomSeed = () => Math.floor(Math.random() * 4294967296) >>> 0;

const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const between = (r, lo, hi) => lo + r() * (hi - lo);
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const fix = (x) => Math.round(x * 10) / 10;
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// ---------- Count: how many dots? ----------

const COUNT = {
  easy: { min: 8, max: 30, showMs: 2500, r: [6.5, 6.5] },
  normal: { min: 20, max: 80, showMs: 1600, r: [5, 5] },
  hard: { min: 50, max: 160, showMs: 1100, r: [4, 4] },
};

function makeCount(r, difficulty) {
  const c = COUNT[difficulty];
  const want = int(r, c.min, c.max);
  const dots = [];
  for (let tries = 0; dots.length < want && tries < 40000; tries++) {
    const rad = fix(between(r, c.r[0], c.r[1]));
    const x = fix(between(r, rad + 8, BOX.w - rad - 8));
    const y = fix(between(r, rad + 8, BOX.h - rad - 8));
    if (dots.every((d) => (d.x - x) ** 2 + (d.y - y) ** 2 >= (d.r + rad + 3) ** 2)) dots.push({ x, y, r: rad });
  }
  return { kind: 'count', difficulty, dots, showMs: c.showMs, answer: dots.length };
}

// ---------- Track: where does the ball hit the right wall? ----------

const TRACK = {
  easy: { slope: 0.4, visible: [0.5, 0.6], speed: 140 },
  normal: { slope: 1.2, visible: [0.35, 0.5], speed: 180 },
  hard: { slope: 2.4, visible: [0.25, 0.4], speed: 240 },
};
const BALL = 8;

function makeTrack(r, difficulty) {
  const c = TRACK[difficulty];
  const y0 = fix(between(r, 40, BOX.h - 40));
  const slope = Math.round(between(r, 0.15, c.slope) * 1000) / 1000 * (r() < 0.5 ? -1 : 1);
  const pz = {
    kind: 'track', difficulty,
    x0: BALL, y0, slope, ballR: BALL, wallX: BOX.w - BALL,
    visibleX: fix(between(r, c.visible[0], c.visible[1]) * BOX.w),
    speed: c.speed,
  };
  pz.answer = fix(trackY(pz, pz.wallX));
  return pz;
}

// Ball centre at x: a straight line folded back off the top and bottom walls.
export function trackY(pz, x) {
  const lo = pz.ballR, span = BOX.h - 2 * pz.ballR;
  let u = (pz.y0 - lo + pz.slope * (x - pz.x0)) % (2 * span);
  if (u < 0) u += 2 * span;
  return lo + (u <= span ? u : 2 * span - u);
}

// Corner points of the full path, for drawing it on the reveal.
export function trackPath(pz) {
  const pts = [[pz.x0, pz.y0]];
  const lo = pz.ballR, hi = BOX.h - pz.ballR;
  let x = pz.x0, y = pz.y0, s = pz.slope;
  while (x < pz.wallX) {
    const toWall = s > 0 ? (hi - y) / s : (lo - y) / s;
    if (x + toWall >= pz.wallX) { pts.push([pz.wallX, trackY(pz, pz.wallX)]); break; }
    x += toWall; y = s > 0 ? hi : lo; s = -s;
    pts.push([x, y]);
  }
  return pts.map(([a, b]) => [fix(a), fix(b)]);
}

// ---------- Angle: make the angle ----------

const ANGLE = {
  easy: { step: 15, lo: 15, hi: 165, tilt: false },
  normal: { step: 1, lo: 8, hi: 172, tilt: true },
  hard: { step: 1, lo: 3, hi: 177, tilt: true },
};

function makeAngle(r, difficulty) {
  const c = ANGLE[difficulty];
  const target = c.step * int(r, Math.ceil(c.lo / c.step), Math.floor(c.hi / c.step));
  let start;
  do start = int(r, 5, 175); while (Math.abs(start - target) < 30);
  return {
    kind: 'angle', difficulty,
    target, start,
    baseline: c.tilt ? int(r, 0, 359) : 0,
    pivot: { x: BOX.w / 2, y: BOX.h / 2 },
    answer: target,
  };
}

// Either side of the dark line counts: a guess is the signed turn from it, -180..180.
export function angleDiff(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(d, 360 - d);
}

// ---------- Split: mark a fraction of the line ----------

const SPLIT = {
  easy: { tilt: 0, len: [300, 340] },
  normal: { tilt: 0, len: [240, 340] },
  hard: { tilt: 35, len: [180, 320] },
};
const EASY_FRACS = [[1, 2], [1, 3], [2, 3], [1, 4], [3, 4], [1, 5], [4, 5]];

function makeSplit(r, difficulty) {
  const c = SPLIT[difficulty];
  let label, p;
  if (difficulty === 'easy') {
    const [a, b] = pick(r, EASY_FRACS);
    label = `${a}/${b}`; p = a / b;
  } else if (difficulty === 'normal' || r() < 0.5) {
    let pct;
    do pct = int(r, 5, 95); while (pct % 25 === 0);
    label = `${pct}%`; p = pct / 100;
  } else {
    let a, b;
    do { b = int(r, 5, 9); a = int(r, 1, b - 1); } while (gcd(a, b) !== 1);
    label = `${a}/${b}`; p = a / b;
  }
  const len = int(r, c.len[0], c.len[1]);
  const tilt = c.tilt ? int(r, -c.tilt, c.tilt) : 0;
  const rad = (tilt * Math.PI) / 180;
  const cx = BOX.w / 2 + int(r, -20, 20), cy = BOX.h / 2 + int(r, -30, 30);
  const dx = (Math.cos(rad) * len) / 2, dy = (Math.sin(rad) * len) / 2;
  return {
    kind: 'split', difficulty,
    label, percent: label.endsWith('%'),
    a: { x: fix(cx - dx), y: fix(cy + dy) },
    b: { x: fix(cx + dx), y: fix(cy - dy) },
    answer: p,
  };
}

// ---------- Timing: stop the hidden clock at the target ----------

// Targets in tenths of a second. Easy: whole seconds 1-6. Normal: 1.0-10.0. Hard: 1.0-20.0.
const TIME = {
  easy: { lo: 10, hi: 60, step: 10 },
  normal: { lo: 10, hi: 100, step: 1 },
  hard: { lo: 10, hi: 200, step: 1 },
};
// The miss is measured against the target plus this much, so short targets aren't
// judged harder than long ones (0.3 s off a 1 s target isn't a "30%" disaster).
export const TIME_CUSHION = 2;

// Seconds allowed to answer a round: Timing gets room to count past long targets
export function answerSeconds(pz, timer) {
  if (!timer) return 0;
  return pz.kind === 'time' ? Math.max(timer, Math.ceil(pz.target * 1.5 + 8)) : timer;
}

function makeTime(r, difficulty) {
  const c = TIME[difficulty];
  const tenths = c.step * int(r, Math.ceil(c.lo / c.step), Math.floor(c.hi / c.step));
  return { kind: 'time', difficulty, target: tenths / 10, answer: tenths / 10 };
}

// ---------- Cut: slice the shape into two equal halves ----------

// Every shape is a polygon (curves drawn with many short sides), so its area and each
// piece's are exact. No shape is the same when turned upside down (no circles, squares or
// hexagons), so a line through the middle is never a free half. Each difficulty draws from
// its own families: easy ones are round and convex, hard ones have arms, bites and points.
const CUT = {
  easy: ['triangle', 'pentagon', 'egg', 'drop', 'blob'],
  normal: ['egg', 'drop', 'heart', 'ell', 'tee', 'bite', 'arrow', 'blob', 'triangle'],
  hard: ['star', 'moon', 'cross', 'ell', 'tee', 'arrow', 'bite', 'heart', 'blob'],
};
const WOBBLE = { easy: { waves: [2, 3], amp: 0.12 }, normal: { waves: [2, 3, 4], amp: 0.2 }, hard: { waves: [2, 3, 4, 5, 6], amp: 0.26 } };
const CURVE = 72;   // sides used for a curved outline
const ring = (n, f) => Array.from({ length: n }, (_, i) => f((i / n) * Math.PI * 2));

// Each maker draws round (0, 0) at about 100 across; makeCut turns it and fits it to the paper.
const SHAPES = {
  // A smooth blob: a radius that wobbles with a few waves round the centre
  blob(r, d) {
    const c = WOBBLE[d];
    const waves = c.waves.map((k) => ({ k, a: between(r, 0.3, 1) * c.amp, ph: between(r, 0, Math.PI * 2) }));
    const sy = between(r, 0.65, 0.95);
    return ring(CURVE, (t) => {
      const rad = 100 * Math.max(0.4, 1 + waves.reduce((n, w) => n + w.a * Math.sin(w.k * t + w.ph), 0));
      return [Math.cos(t) * rad, Math.sin(t) * rad * sy];
    });
  },
  // Three corners, never too thin and never even-sided
  triangle(r) {
    const a = [0, between(r, 1.7, 2.4), between(r, 3.6, 4.6)];
    return a.map((t) => { const rad = between(r, 80, 110); return [Math.cos(t) * rad, Math.sin(t) * rad]; });
  },
  // Five uneven corners round a circle (still convex)
  pentagon(r) {
    return ring(5, (t) => { const rad = between(r, 78, 108), tt = t + between(r, -0.25, 0.25); return [Math.cos(tt) * rad, Math.sin(tt) * rad]; });
  },
  // Fat at one end, narrow at the other
  egg(r) {
    const k = between(r, 0.18, 0.3), sy = between(r, 0.62, 0.78);
    return ring(CURVE, (t) => [Math.cos(t) * 105, Math.sin(t) * 105 * sy * (1 + k * Math.cos(t))]);
  },
  // A raindrop: round at one end, a point at the other
  drop(r) {
    const m = between(r, 1, 1.8);
    return ring(CURVE, (t) => [Math.cos(t) * 105, Math.sin(t) * 75 * Math.abs(Math.sin(t / 2)) ** m]);
  },
  heart() {
    return ring(CURVE, (t) => [16 * Math.sin(t) ** 3 * 6.2, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * 6.2]);
  },
  // An L: two arms of different lengths and thicknesses
  ell(r) {
    const w = between(r, 150, 200), h = between(r, 140, 180), a = between(r, 45, 75), b = between(r, 45, 75);
    return [[0, 0], [a, 0], [a, h - b], [w, h - b], [w, h], [0, h]];
  },
  // A T with its stem off centre
  tee(r) {
    const w = between(r, 170, 210), h = between(r, 140, 180), bar = between(r, 40, 60), stem = between(r, 45, 70);
    const sx = between(r, 0.2, 0.55) * (w - stem);
    return [[0, 0], [w, 0], [w, bar], [sx + stem, bar], [sx + stem, h], [sx, h], [sx, bar], [0, bar]];
  },
  // A plus with arms of different lengths
  cross(r) {
    const t = between(r, 42, 58), [L, R, U, D] = [0, 1, 2, 3].map(() => between(r, 45, 95)), h = t / 2;
    return [[-h, -h - U], [h, -h - U], [h, -h], [h + R, -h], [h + R, h], [h, h], [h, h + D], [-h, h + D], [-h, h], [-h - L, h], [-h - L, -h], [-h, -h]];
  },
  // A round thing with a wedge bitten out
  bite(r) {
    const gap = between(r, 0.7, 1.6), n = CURVE;
    const pts = [[0, 0]];
    for (let i = 0; i <= n; i++) { const t = gap / 2 + (i / n) * (Math.PI * 2 - gap); pts.push([Math.cos(t) * 100, Math.sin(t) * 100]); }
    return pts;
  },
  // A thick arrow: a shaft and a head
  arrow(r) {
    const len = between(r, 120, 160), sh = between(r, 22, 32), head = between(r, 55, 75), hl = between(r, 55, 75);
    return [[0, -sh], [len, -sh], [len, -head], [len + hl, 0], [len, head], [len, sh], [0, sh]];
  },
  // Points round a centre, an odd number so no two face each other
  star(r) {
    const n = pick(r, [5, 7]), inner = between(r, 0.42, 0.58);
    return ring(n * 2, (t) => { const rad = (Math.round((t / (Math.PI * 2)) * n * 2) % 2 ? inner : 1) * between(r, 92, 108); return [Math.cos(t) * rad, Math.sin(t) * rad]; });
  },
  // A crescent: a circle with a smaller circle taken out of one side
  moon(r) {
    const R = 105, rr = between(r, 82, 96), dd = between(r, 38, 55);
    const x0 = (R * R - rr * rr + dd * dd) / (2 * dd), y0 = Math.sqrt(R * R - x0 * x0);
    const a0 = Math.atan2(y0, x0), b0 = Math.atan2(y0, x0 - dd), n = 48, pts = [];
    for (let i = 0; i <= n; i++) { const t = a0 + (i / n) * (Math.PI * 2 - 2 * a0); pts.push([Math.cos(t) * R, Math.sin(t) * R]); }
    for (let i = 1; i < n; i++) { const t = Math.PI * 2 - b0 - (i / n) * (Math.PI * 2 - 2 * b0); pts.push([dd + Math.cos(t) * rr, Math.sin(t) * rr]); }
    return pts;
  },
};
export const CUT_SHAPES = CUT;

function makeCut(r, difficulty) {
  const family = pick(r, CUT[difficulty]);
  const raw = SHAPES[family](r, difficulty);
  // Turned any way, sometimes mirrored, then scaled to fill most of the paper
  const turn = between(r, 0, Math.PI * 2), flip = r() < 0.5 ? -1 : 1;
  const pts = raw.map(([x, y]) => [x * flip * Math.cos(turn) - y * Math.sin(turn), x * flip * Math.sin(turn) + y * Math.cos(turn)]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
  // (a strip is left at the bottom for the hint under the shape)
  const sc = Math.min((BOX.w - 60) / bw, (BOX.h - 76) / bh) * between(r, 0.78, 0.95);
  const mx = (Math.max(...xs) + Math.min(...xs)) / 2, my = (Math.max(...ys) + Math.min(...ys)) / 2;
  const ox = BOX.w / 2 + between(r, -12, 12), oy = BOX.h / 2 - 10 + between(r, -5, 5);
  const shape = pts.map(([x, y]) => [fix(ox + (x - mx) * sc), fix(oy + (y - my) * sc)]);
  return { kind: 'cut', difficulty, family, shape, answer: 0.5 };
}

const area = (poly) => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
};

// The part of a polygon on one side of the line a→b (Sutherland–Hodgman against one edge);
// swapping a and b gives the other side.
// A concave shape can come out as several pieces; their total area is still right.
export function clipLeft(poly, [ax, ay, bx, by]) {
  const side = ([x, y]) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const sp = side(p), sq = side(q);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

// What share of the shape falls on one side of the cut, 0..1 (0.5 is a perfect half).
export function cutShare(pz, line) {
  const total = area(pz.shape);
  const left = clipLeft(pz.shape, line);
  return left.length < 3 ? 0 : area(left) / total;
}

// The perfect cut at a given angle (degrees), as a line through the board: found by
// sliding the line across the shape until both sides weigh the same.
export function perfectCut(pz, deg) {
  const a = (deg * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
  const nx = -dy, ny = dx;
  const line = (off) => [BOX.w / 2 + nx * off - dx * 400, BOX.h / 2 + ny * off - dy * 400, BOX.w / 2 + nx * off + dx * 400, BOX.h / 2 + ny * off + dy * 400];
  let lo = -260, hi = 260;
  const f = (off) => cutShare(pz, line(off));
  const up = f(hi) > f(lo);
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if ((f(mid) < 0.5) === up) lo = mid; else hi = mid;
  }
  return line((lo + hi) / 2);
}

// ---------- Balance: how many of these weigh as much as one of those? ----------

// How many light things one heavy thing is worth, per difficulty: easy stays in numbers you
// can picture, hard goes all the way to ants against a whale.
const BALANCE = { easy: [5, 40], normal: [10, 3000], hard: [300, 1e9] };
export const BALANCE_MAX = 1e10;

// The answer to two significant figures (28,000 apples, not 27,778): the weights are typical, not exact
export function roughly(x) {
  if (x < 10) return Math.max(1, Math.round(x));
  const p = 10 ** (Math.floor(Math.log10(x)) - 1);
  return Math.round(x / p) * p;
}

function makeBalance(r, difficulty) {
  const [lo, hi] = BALANCE[difficulty];
  const thing = ([one, many, emoji, kg]) => ({ one, many, emoji, kg });
  let heavy, light;
  for (let tries = 0; tries < 10000; tries++) {
    heavy = THINGS[Math.floor(r() * THINGS.length)];
    light = THINGS[Math.floor(r() * THINGS.length)];
    const ratio = heavy[3] / light[3];
    if (ratio >= lo && ratio <= hi) break;
  }
  return { kind: 'balance', difficulty, heavy: thing(heavy), light: thing(light), answer: roughly(heavy[3] / light[3]) };
}

// ---------- Rounds and scoring ----------

const MAKERS = { count: makeCount, track: makeTrack, angle: makeAngle, split: makeSplit, time: makeTime, cut: makeCut, balance: makeBalance };

export function makeRound(kind, seed, difficulty = 'normal') {
  if (!MAKERS[kind]) throw new Error(`Unknown test: ${kind}`);
  if (!COUNT[difficulty]) throw new Error(`Unknown difficulty: ${difficulty}`);
  return { seed, ...MAKERS[kind](mulberry32(seed), difficulty) };
}

// The round list for a game: each chosen test once per lap.
export function makeSet(gameSeed, kinds, laps, difficulty) {
  const list = [];
  for (let lap = 0; lap < laps; lap++) {
    for (const kind of kinds) {
      const index = list.length;
      list.push(makeRound(kind, roundSeed(gameSeed, index, kind), difficulty));
    }
  }
  return list;
}

// How far off the guess was, in each test's own unit.
export function error(pz, guess) {
  switch (pz.kind) {
    case 'count': return Math.abs(Math.log((Math.max(0, guess) + 1) / (pz.answer + 1)));
    case 'track': return Math.abs(guess - pz.answer) / BOX.h;
    case 'angle': return Math.abs(Math.abs(angleDiff(guess, 0)) - pz.answer);
    case 'split': return Math.abs(guess - pz.answer);
    case 'time': return Math.abs(guess - pz.answer) / (pz.answer + TIME_CUSHION);
    case 'cut': return Math.abs(cutShare(pz, guess) - 0.5);
    case 'balance': return Math.abs(Math.log(guess / pz.answer));
    default: throw new Error(`Unknown test: ${pz.kind}`);
  }
}

// The error that scores 50, per test.
export const HALF = { count: Math.log(1.2), track: 0.08, angle: 6, split: 0.03, time: 0.15, cut: 0.035, balance: Math.log(1.6) };
// Curve shape: above 1 the top is flatter (tiny misses, like hand jitter, cost little) and
// bigger misses fall away faster. Half the 50-point error scores 78, double scores 14.
export const SHAPE = 1.5;

export function score(pz, guess) {
  if (guess === null || guess === undefined || Number.isNaN(guess)) return 0;
  return Math.round(100 * Math.pow(0.5, Math.pow(error(pz, guess) / HALF[pz.kind], SHAPE)));
}

export function verdict(points) {
  if (points >= 95) return 'Spot on!';
  if (points >= 80) return 'Sharp';
  if (points >= 60) return 'Close';
  if (points >= 35) return 'Ballpark';
  return 'Way off';
}

// ---------- Guesses from the network ----------

// Guesses arrive from other players' browsers, so the host checks them before scoring.
export function validGuess(pz, guess) {
  // Cut: the line as [x1, y1, x2, y2], two points on the board far enough apart to give a direction
  if (pz.kind === 'cut') {
    return Array.isArray(guess) && guess.length === 4 && guess.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= -50 && n <= BOX.w + 50)
      && Math.hypot(guess[2] - guess[0], guess[3] - guess[1]) >= 10;
  }
  if (typeof guess !== 'number' || !Number.isFinite(guess)) return false;
  switch (pz.kind) {
    case 'count': return Number.isInteger(guess) && guess >= 0 && guess <= 999;
    case 'track': return guess >= 0 && guess <= BOX.h;
    case 'angle': return guess >= -180 && guess <= 180;
    case 'split': return guess >= 0 && guess <= 1;
    case 'time': return guess > 0 && guess <= 60;
    case 'balance': return Number.isInteger(guess) && guess >= 1 && guess <= BALANCE_MAX;
    default: return false;
  }
}

// A guess (or the answer, when guess is omitted) written for people.
export function describe(pz, guess = pz.answer) {
  if (guess === null || guess === undefined) return '–';
  switch (pz.kind) {
    case 'count': return String(Math.round(guess));
    case 'track': return guess === pz.answer ? 'impact' : `${Math.round(error(pz, guess) * 100)}% off`;
    case 'angle': return `${Math.round(Math.abs(guess))}°`;
    case 'split': return `${Math.round(guess * 100)}%`;
    case 'time': return guess === pz.answer ? `${pz.answer.toFixed(1)} s` : `${guess.toFixed(2)} s`;
    case 'cut': return guess === pz.answer ? '50/50' : halves(cutShare(pz, guess));
    case 'balance': return Math.round(guess).toLocaleString('en-US');
    default: return String(guess);
  }
}

// A cut written as its two pieces, bigger first: "53/47". Close to half it keeps a decimal
// ("50.4/49.6"), so a near miss never reads as a perfect "50/50".
export function halves(share) {
  const big = Math.max(share, 1 - share) * 100;
  return Math.round(big) === 50 ? `${big.toFixed(1)}/${(100 - big).toFixed(1)}` : `${Math.round(big)}/${100 - Math.round(big)}`;
}

// ---------- Daily puzzle ----------

// Everyone gets the same daily set, built from the date. Day 1 is launch day.
export const LAUNCH_DAY = '2026-11-10';
export const DAILY = { kinds: KINDS, laps: 1, difficulty: 'normal' };
// Tests join the daily on the day after they launch, so a day already started never changes:
// day 1 had no Timing, days up to 8 (2026-11-17) had no Cut or Balance.
const DAILY_FROM = { time: 2, cut: 9, balance: 9 };
export const dailyKinds = (key) => DAILY.kinds.filter((k) => dayNumber(key) >= (DAILY_FROM[k] || 1));

export function dayKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function dayNumber(key) {
  const utc = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((utc(key) - utc(LAUNCH_DAY)) / 86400000) + 1;
}

export function daySeed(key) {
  let h = 0x811c9dc5;
  for (const ch of `guesstimate:${key}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h >>> 0;
}

export const dailySet = (key) => makeSet(daySeed(key), dailyKinds(key), DAILY.laps, DAILY.difficulty);
