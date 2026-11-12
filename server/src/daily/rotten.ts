import * as E from '../../../web/rotten/js/engine.js';
import { lexicon } from '../games/rotten';
import type { DailyGame } from './index';

/** A prompt left open longer than this (a tab forgotten overnight) is scored as a skip. */
const MAX_PROMPT_MS = 10 * 60 * 1000;

interface RottenDaily {
  prompts: string[];
  idx: number;
  /** Server time the current prompt was shown, 0 before the first one. */
  shownAt: number;
  times: Array<number | null>;
  words: Array<string | null>;
  used: string[];
}

export const rottenDaily: DailyGame<RottenDaily> = {
  id: 'rotten',
  order: 'asc',
  number: (day) => E.dailyNumber(day),
  start(_day, key) {
    return { prompts: E.dailyPrompts(key), idx: 0, shownAt: 0, times: [], words: [], used: [] };
  },
  view(s, now) {
    const done = s.idx >= E.DAILY_COUNT;
    return {
      idx: s.idx,
      count: E.DAILY_COUNT,
      times: s.times,
      words: s.words,
      // Only prompts already played, plus the current one once it has been asked for
      prompts: done ? s.prompts : s.prompts.slice(0, s.shownAt ? s.idx + 1 : s.idx),
      prompt: !done && s.shownAt ? s.prompts[s.idx] : null,
      elapsed: !done && s.shownAt ? now - s.shownAt : 0,
      total: E.dailyTotal(s.times),
      used: s.used,
    };
  },
  act(s, action, body, now) {
    const next = (state: RottenDaily): RottenDaily => ({ ...state, shownAt: state.idx < E.DAILY_COUNT ? now : 0 });
    if (action === 'next') {
      if (s.shownAt) return { state: s };
      return { state: next(s) };
    }
    if (!s.shownAt) return { state: s, error: 'not started' };
    const spent = Math.min(now - s.shownAt, MAX_PROMPT_MS);
    if (action === 'skip') {
      return { state: next({ ...s, idx: s.idx + 1, times: [...s.times, null], words: [...s.words, null] }), extra: { skipped: true } };
    }
    if (action === 'answer') {
      const used = new Set(s.used);
      const res = E.checkWord(body.word, { prompt: s.prompts[s.idx], minLen: 4, list: 'en', forms: 'block', used, lex: lexicon() });
      if (!res.ok) return { state: s, error: res.reason as string };
      used.add(res.key as string);
      const time = spent >= MAX_PROMPT_MS ? null : spent;
      return {
        state: next({ ...s, idx: s.idx + 1, times: [...s.times, time], words: [...s.words, res.word as string], used: [...used] }),
        extra: { solved: { word: res.word, time } },
      };
    }
    return { state: s, error: 'unknown action' };
  },
  result(s) {
    if (s.idx < E.DAILY_COUNT) return null;
    return { score: E.dailyTotal(s.times), detail: s.times.map((t) => E.dailySquare(t)).join('') };
  },
};
