import * as E from '../../../web/lettuce-party/js/engine.js';
import { words } from '../games/lettuce';
import type { DailyGame } from './index';

type Mode = 'classic' | 'counts';

interface LettuceDaily {
  mode: Mode;
  word: string;
  guesses: string[];
  /** Server time the player began, 0 until then. The clock keeps running through a refresh. */
  startedAt: number;
  solved: boolean;
  done: boolean;
  ms: number;
}

const fmt = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/**
 * Lettuce Party's daily for one mode: the same word for everyone today, from a seed derived from the
 * server's secret. The server checks every guess and sends back only what the mode shows (Classic: the
 * colours, Counts: the three numbers); the word goes out once the player has solved it or run out.
 * Untimed, but the server's clock breaks ties: fewest guesses first, then fastest.
 */
export function lettuceDaily(mode: Mode): DailyGame<LettuceDaily> {
  const attempts = E.DAILY_ATTEMPTS[mode];
  const row = (s: LettuceDaily, word: string) => (mode === 'counts' ? { word, counts: E.countsFor(word, s.word) } : { word, pattern: E.score(word, s.word) });
  return {
    id: `lettuce-party:${mode}`,
    order: 'asc',
    stats: { game: 'lettuce-party', key: `daily${mode[0].toUpperCase()}${mode.slice(1)}` },
    number: (day) => E.dayNumber(day),
    start(_day, key) {
      return { mode, word: E.dailyWord(words().answers, key, mode), guesses: [], startedAt: 0, solved: false, done: false, ms: 0 };
    },
    view(s, now) {
      return {
        mode,
        attempts,
        started: s.startedAt > 0,
        guesses: s.guesses.map((w) => row(s, w)),
        solved: s.solved,
        done: s.done,
        ms: s.done ? s.ms : s.startedAt ? now - s.startedAt : 0,
        // Only once it's over: the word, and in Counts the colours of every guess
        word: s.done ? s.word : null,
        patterns: s.done ? s.guesses.map((w) => E.score(w, s.word)) : null,
      };
    },
    act(s, action, body, now) {
      if (action === 'next') return { state: s.startedAt ? s : { ...s, startedAt: now } };
      if (action !== 'guess') return { state: s, error: 'unknown action' };
      if (!s.startedAt) return { state: s, error: 'not started' };
      const word = String(body.word ?? '').toLowerCase();
      if (!/^[a-z]{5}$/.test(word)) return { state: s, error: 'Not enough letters' };
      if (!words().valid.has(word)) return { state: s, error: 'Not in word list' };
      const guesses = [...s.guesses, word];
      const solved = word === s.word;
      const done = solved || guesses.length >= attempts;
      const next: LettuceDaily = { ...s, guesses, solved, done, ms: done ? now - s.startedAt : 0 };
      return { state: next, extra: { last: row(s, word) } };
    },
    result(s) {
      if (!s.done) return null;
      return {
        score: E.dailyScore(s.solved, s.guesses.length, attempts, s.ms),
        detail: `${s.solved ? s.guesses.length : 'X'}/${attempts} · ${fmt(s.ms)}`,
      };
    },
  };
}
