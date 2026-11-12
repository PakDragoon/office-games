// Guesstimate round engine. Pure functions: no DOM, no network.
// Every puzzle is built from a seed, so every browser given the same seed
// draws exactly the same puzzle. Multiplayer only has to share the seed.

export const KINDS = ['count', 'track', 'angle', 'split', 'time'];
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

// ---------- Rounds and scoring ----------

const MAKERS = { count: makeCount, track: makeTrack, angle: makeAngle, split: makeSplit, time: makeTime };

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
    default: throw new Error(`Unknown test: ${pz.kind}`);
  }
}

// The error that scores 50, per test.
export const HALF = { count: Math.log(1.2), track: 0.08, angle: 6, split: 0.03, time: 0.15 };
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
  if (typeof guess !== 'number' || !Number.isFinite(guess)) return false;
  switch (pz.kind) {
    case 'count': return Number.isInteger(guess) && guess >= 0 && guess <= 999;
    case 'track': return guess >= 0 && guess <= BOX.h;
    case 'angle': return guess >= -180 && guess <= 180;
    case 'split': return guess >= 0 && guess <= 1;
    case 'time': return guess > 0 && guess <= 60;
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
    default: return String(guess);
  }
}

// ---------- Daily puzzle ----------

// Everyone gets the same daily set, built from the date. Day 1 is launch day.
export const LAUNCH_DAY = '2026-11-10';
export const DAILY = { kinds: KINDS, laps: 1, difficulty: 'normal' };
// Day 1 was played with four tests before Timing existed; keep it the same for everyone.
const dailyKinds = (key) => (dayNumber(key) <= 1 ? KINDS.filter((k) => k !== 'time') : DAILY.kinds);

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
