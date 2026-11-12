import { describe, expect, it } from 'vitest';
import { growRd, isProvisional, PERIOD_MS, rateRanking, START, update, type Rating } from '../src/core/glicko2';

const R = (rating: number, rd: number, vol = 0.06): Rating => ({ rating, rd, vol });

describe('Glicko-2 (Glickman paper example)', () => {
  it('matches the published worked example', () => {
    const out = update(R(1500, 200), [
      { opp: R(1400, 30), score: 1 },
      { opp: R(1550, 100), score: 0 },
      { opp: R(1700, 300), score: 0 },
    ]);
    expect(out.rating).toBeCloseTo(1464.06, 1);
    expect(out.rd).toBeCloseTo(151.52, 1);
    expect(out.vol).toBeCloseTo(0.05999, 4);
  });

  it('only grows the deviation with no games', () => {
    const out = update(R(1500, 200), []);
    expect(out.rating).toBe(1500);
    expect(out.rd).toBeGreaterThan(200);
    expect(out.rd).toBeLessThan(201);
  });

  it('a win raises, a loss lowers, a draw between equals changes nothing but certainty', () => {
    const win = update(START, [{ opp: START, score: 1 }]);
    const loss = update(START, [{ opp: START, score: 0 }]);
    const draw = update(START, [{ opp: START, score: 0.5 }]);
    expect(win.rating).toBeGreaterThan(1500);
    expect(loss.rating).toBeLessThan(1500);
    expect(draw.rating).toBeCloseTo(1500, 6);
    expect(draw.rd).toBeLessThan(350);
  });

  it('beating a stronger player is worth more than beating a weaker one', () => {
    const up = update(R(1500, 80), [{ opp: R(1800, 80), score: 1 }]).rating - 1500;
    const down = update(R(1500, 80), [{ opp: R(1200, 80), score: 1 }]).rating - 1500;
    expect(up).toBeGreaterThan(down);
  });

  it('never goes above the maximum deviation', () => {
    expect(update(R(1500, 349), []).rd).toBeLessThanOrEqual(350);
    expect(growRd(R(1500, 340), 500 * PERIOD_MS)).toBe(350);
  });
});

describe('inactivity and provisional', () => {
  it('deviation grows by whole idle weeks only', () => {
    expect(growRd(R(1500, 60), PERIOD_MS - 1)).toBe(60);
    expect(growRd(R(1500, 60), 4 * PERIOD_MS)).toBeGreaterThan(60);
  });
  it('flags a high deviation as provisional', () => {
    expect(isProvisional(350)).toBe(true);
    expect(isProvisional(110)).toBe(false);
    expect(isProvisional(60)).toBe(false);
  });
  it('settles: a new player stops being provisional after a handful of games', () => {
    let me = START;
    let n = 0;
    while (isProvisional(me.rd) && n < 100) {
      me = update(me, [{ opp: R(1500, 60), score: n % 2 }]);
      n++;
    }
    expect(n).toBeLessThan(20);
  });
});

describe('rateRanking (pairwise, many players)', () => {
  it('two players is a plain head-to-head game', () => {
    const [a, b] = rateRanking([{ rating: START, place: 1 }, { rating: START, place: 2 }]);
    expect(a.rating).toBeCloseTo(update(START, [{ opp: START, score: 1 }]).rating, 9);
    expect(b.rating).toBeCloseTo(update(START, [{ opp: START, score: 0 }]).rating, 9);
  });

  it('orders results by place and does not depend on list order', () => {
    const base = [R(1500, 100), R(1600, 100), R(1400, 100), R(1500, 100)];
    const places = [3, 1, 4, 2];
    const out = rateRanking(base.map((rating, i) => ({ rating, place: places[i] })));
    expect(out[1].rating).toBeGreaterThan(base[1].rating);   // won
    expect(out[2].rating).toBeLessThan(base[2].rating);      // came last
    const rev = rateRanking(base.map((rating, i) => ({ rating, place: places[i] })).reverse()).reverse();
    out.forEach((o, i) => expect(rev[i].rating).toBeCloseTo(o.rating, 9));
  });

  it('a many-player round counts as one game per player, not one per opponent', () => {
    const solo = update(START, [{ opp: START, score: 1 }]);
    const eight = rateRanking([1, 2, 3, 4, 5, 6, 7, 8].map((place) => ({ rating: START, place })));
    // The winner of 8 moves about as much as the winner of a 2-player game, and the middle stays put
    expect(eight[0].rating).toBeGreaterThan(1500);
    expect(eight[0].rating).toBeLessThan(solo.rating + 40);
    expect(eight[0].rd).toBeGreaterThan(solo.rd - 15);
    expect(Math.abs(eight[3].rating - 1500) + Math.abs(eight[4].rating - 1500)).toBeLessThan(80);
  });

  it('a weight of 1 is the published update, a smaller weight moves less', () => {
    const full = update(R(1500, 200), [{ opp: R(1400, 30), score: 1, weight: 1 }]);
    expect(full.rating).toBeCloseTo(update(R(1500, 200), [{ opp: R(1400, 30), score: 1 }]).rating, 9);
    const half = update(R(1500, 200), [{ opp: R(1400, 30), score: 1, weight: 0.5 }]);
    expect(half.rating - 1500).toBeLessThan(full.rating - 1500);
    expect(half.rating).toBeGreaterThan(1500);
  });

  it('equal places draw', () => {
    const [a, b] = rateRanking([{ rating: START, place: 1 }, { rating: START, place: 1 }]);
    expect(a.rating).toBeCloseTo(1500, 6);
    expect(b.rating).toBeCloseTo(1500, 6);
  });

  it('is roughly zero-sum for equally rated players', () => {
    const out = rateRanking([1, 2, 3, 4, 5].map((place) => ({ rating: R(1500, 80), place })));
    const total = out.reduce((n, r) => n + (r.rating - 1500), 0);
    expect(Math.abs(total)).toBeLessThan(1);
  });
});
