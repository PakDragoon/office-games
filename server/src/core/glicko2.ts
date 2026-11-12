// Glicko-2 (Mark Glickman, 2013: http://www.glicko.net/glicko/glicko2.pdf). Pure maths, no
// dependencies, no I/O. Ratings are on the familiar scale (1500 = average); the paper's
// internal scale (mu / phi) stays inside this file.

export interface Rating {
  /** Skill estimate, 1500 for a new player. */
  rating: number;
  /** Rating deviation: how unsure we are. 350 = never played, around 50 = very settled. */
  rd: number;
  /** Volatility: how erratic the player's results are. */
  vol: number;
}

export interface Outcome {
  /** The opponent's rating before this game. */
  opp: Rating;
  /** 1 win, 0.5 draw, 0 loss. */
  score: number;
  /** How much this game counts, 1 = a full game (the paper). Used to split one multi-player result over several opponents. */
  weight?: number;
}

export const START: Rating = { rating: 1500, rd: 350, vol: 0.06 };
/** How fast volatility may change. Glickman suggests 0.3 to 1.2; lower is steadier. */
export const TAU = 0.5;
export const MAX_RD = 350;
/** Below this deviation a rating is trusted; above it we show it as provisional. */
export const PROVISIONAL_RD = 110;
/** One rating period is a week without playing: the deviation creeps back up by one step per week idle. */
export const PERIOD_MS = 7 * 24 * 3600 * 1000;

const SCALE = 173.7178;
const EPS = 0.000001;

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/**
 * One rating period for one player: all of the `outcomes` happened in the same period, each
 * judged against the opponent's rating from before the period. With no outcomes only the
 * deviation grows (step 6 of the paper).
 */
export function update(player: Rating, outcomes: Outcome[], tau = TAU): Rating {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;
  if (!outcomes.length) {
    return { rating: player.rating, rd: Math.min(MAX_RD, Math.sqrt(phi * phi + sigma * sigma) * SCALE), vol: sigma };
  }
  const opp = outcomes.map((o) => ({ mu: (o.opp.rating - 1500) / SCALE, phi: o.opp.rd / SCALE, s: o.score, w: o.weight ?? 1 }));

  // Step 3: estimated variance of the rating from the games alone
  let vInv = 0;
  for (const o of opp) {
    const e = expected(mu, o.mu, o.phi);
    vInv += o.w * g(o.phi) ** 2 * e * (1 - e);
  }
  const v = 1 / vInv;

  // Step 4: the improvement in rating the games suggest
  let sum = 0;
  for (const o of opp) sum += o.w * g(o.phi) * (o.s - expected(mu, o.mu, o.phi));
  const delta = v * sum;

  // Step 5: the new volatility (Illinois algorithm)
  const a = Math.log(sigma * sigma);
  const f = (x: number) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; Math.abs(B - A) > EPS && i < 100; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else fA /= 2;
    B = C;
    fB = fC;
  }
  const newSigma = Math.exp(A / 2);

  // Steps 6 and 7
  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * sum;
  return { rating: newMu * SCALE + 1500, rd: Math.min(MAX_RD, newPhi * SCALE), vol: newSigma };
}

/** The deviation of a rating last updated `idleMs` ago: unsure again after a long break. */
export function growRd(r: Rating, idleMs: number): number {
  const periods = Math.max(0, Math.floor(idleMs / PERIOD_MS));
  if (!periods) return r.rd;
  const phi = r.rd / SCALE;
  return Math.min(MAX_RD, Math.sqrt(phi * phi + periods * r.vol * r.vol) * SCALE);
}

export const isProvisional = (rd: number): boolean => rd > PROVISIONAL_RD;

export interface Ranked {
  rating: Rating;
  /** Finishing place, 1 = best. Equal places are a tie. */
  place: number;
}

/**
 * A game with any number of players, as the standard "pairwise" decomposition: every pair of
 * players is one game that the better place wins (equal places draw). Each player is then
 * updated once against all the others, all judged on the ratings from before the game, so the
 * order of the list never matters. With two players it is a plain head-to-head game.
 *
 * One refinement: the pairs of one player are not independent (one finishing place decides all
 * of them), so counting each as a full game would make an 8-player round look like seven games
 * and swing ratings far too hard. Each player's round therefore counts as one game in total,
 * split evenly over the opponents (weight 1/(n-1) each). For two players the weight is 1.
 */
export function rateRanking(players: Ranked[]): Rating[] {
  const weight = 1 / Math.max(1, players.length - 1);
  return players.map((me, i) => {
    const outcomes: Outcome[] = [];
    players.forEach((other, j) => {
      if (i === j) return;
      outcomes.push({ opp: other.rating, score: me.place < other.place ? 1 : me.place === other.place ? 0.5 : 0, weight });
    });
    return update(me.rating, outcomes);
  });
}
