import * as R from '../../../web/guesstimate/js/rounds.js';
import type { DailyGame } from './index';

interface GuessDaily {
  seed: number;
  kinds: string[];
  idx: number;
  results: Array<{ kind: string; points: number }>;
}

// Everyone gets the same puzzles today, built from a seed derived from the server's secret
// (not from the date, so tomorrow's can't be worked out). The server scores every guess.
export const guesstimateDaily: DailyGame<GuessDaily> = {
  id: 'guesstimate',
  order: 'desc',
  number: (day) => R.dayNumber(day),
  start(_day, key) {
    return { seed: R.daySeed(key), kinds: [...R.DAILY.kinds], idx: 0, results: [] };
  },
  view(s) {
    return { seed: s.seed, kinds: s.kinds, idx: s.idx, count: s.kinds.length, results: s.results };
  },
  act(s, action, body) {
    if (action === 'next') return { state: s };
    if (action !== 'answer') return { state: s, error: 'unknown action' };
    if (body.index !== s.idx) return { state: s, error: 'stale' };
    const pz = R.makeSet(s.seed, s.kinds, R.DAILY.laps, R.DAILY.difficulty)[s.idx];
    if (!R.validGuess(pz, body.guess)) return { state: s, error: 'invalid' };
    const points = R.score(pz, body.guess);
    return {
      state: { ...s, idx: s.idx + 1, results: [...s.results, { kind: pz.kind, points }] },
      extra: { points },
    };
  },
  result(s) {
    if (s.idx < s.kinds.length) return null;
    const avg = Math.round(s.results.reduce((n, r) => n + r.points, 0) / s.results.length);
    return { score: avg, detail: s.results.map((r) => (r.points >= 80 ? '🟩' : r.points >= 35 ? '🟨' : '🟥')).join('') };
  },
};
