import * as E from '../../../web/melonburst/js/engine.js';
import { lexicon } from '../games/melonburst';
import type { DailyGame } from './index';

interface MelonDaily {
  word: string;
  guessed: string[];
  wrong: number;
  solved: boolean;
  burst: boolean;
  ms: number;
  /** Server time the player began (after the countdown), 0 until then. The clock keeps running through a refresh. */
  startedAt: number;
}

// One everyday word (5-9 letters) for everyone today, picked from a seed derived from the server's
// secret (not from the date, so tomorrow's can't be worked out). The browser sends one letter at a
// time; the server keeps the session and only ever sends the masked word, until the end.
// Ranking: solved first, then fewest wrong letters, then fastest (see engine.dailyScore). Lower is better.
export const melonburstDaily: DailyGame<MelonDaily> = {
  id: 'melonburst',
  order: 'asc',
  number: (day) => E.dayNumber(day),
  start(_day, key) {
    return { ...E.newGuess(E.dailyWord(lexicon(), key)), startedAt: 0 };
  },
  view(s, now) {
    const done = E.isDone(s);
    const started = s.startedAt > 0;
    return {
      started,
      bands: E.DAILY_BANDS,
      // Nothing about the word (not even its length) before the clock starts
      len: started ? s.word.length : null,
      mask: started ? E.mask(s.word, s.guessed) : '',
      guessed: s.guessed,
      wrong: s.wrong,
      solved: s.solved,
      burst: s.burst,
      ms: done ? s.ms : started ? now - s.startedAt : 0,
      points: s.solved ? E.points(s, E.DAILY_BANDS) : 0,
      // Revealed only once it is over
      word: done ? s.word : null,
    };
  },
  act(s, action, body, now) {
    if (action === 'next') {
      if (s.startedAt) return { state: s };
      return { state: { ...s, startedAt: now } };
    }
    if (action !== 'guess') return { state: s, error: 'unknown action' };
    if (!s.startedAt) return { state: s, error: 'not started' };
    const ch = typeof body.ch === 'string' ? body.ch.toLowerCase() : '';
    if (ch.length !== 1 || !E.LETTERS.includes(ch)) return { state: s, error: 'invalid' };
    if (s.guessed.includes(ch)) return { state: s, error: 'repeat' };
    const r = E.guess(s, ch, E.DAILY_BANDS);
    if (!r) return { state: s, error: 'invalid' };
    const next: MelonDaily = { ...r.g, guessed: [...r.g.guessed] as string[], startedAt: s.startedAt };
    if (E.isDone(next)) next.ms = now - s.startedAt;
    return { state: next, extra: { hit: r.hit } };
  },
  result(s) {
    if (!E.isDone(s)) return null;
    return { score: E.dailyScore(s), detail: s.solved ? `${s.wrong} wrong` : 'burst' };
  },
};
