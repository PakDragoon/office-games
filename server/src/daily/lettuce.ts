import * as E from '../../../web/lettuce-party/js/engine.js';
import { LADDERS_TEXT, ladderWord, words } from '../games/lettuce';
import type { DailyGame } from './index';

type Mode = 'classic' | 'counts' | 'ladder';
interface Ladder { start: string; target: string; par: number; path: string[] }

interface LettuceDaily {
  mode: Mode;
  /** Classic and Counts: the secret word. Ladder: the target (public). */
  word: string;
  ladder?: Ladder;
  /** Ladder: the player stopped without reaching the target. */
  gaveUp?: boolean;
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
 * Word ladder: today's start and target are public; every step is checked (one letter changed, a real
 * word; going back to an earlier word is allowed, as in rooms by default) and counted.
 * Untimed, but the server's clock breaks ties: fewest guesses (steps) first, then fastest. The ladder can
 * be given up ('giveup'), which ranks below every finish.
 */
export function lettuceDaily(mode: Mode): DailyGame<LettuceDaily> {
  const attempts = E.DAILY_ATTEMPTS[mode];
  const row = (s: LettuceDaily, word: string) => (mode === 'ladder' ? { word }
    : mode === 'counts' ? { word, counts: E.countsFor(word, s.word) } : { word, pattern: E.score(word, s.word) });
  return {
    id: `lettuce-party:${mode}`,
    order: 'asc',
    stats: { game: 'lettuce-party', key: `daily${mode[0].toUpperCase()}${mode.slice(1)}` },
    number: (day) => E.dayNumber(day),
    start(_day, key) {
      if (mode === 'ladder') {
        const ladder = (E.dailyLadder(LADDERS_TEXT, key) ?? E.parsePair('crane glaze 3 craze graze')) as Ladder;
        return { mode, word: ladder.target, ladder, guesses: [], startedAt: 0, solved: false, done: false, ms: 0 };
      }
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
        patterns: s.done && mode !== 'ladder' ? s.guesses.map((w) => E.score(w, s.word)) : null,
        // The ladder's start and target are public once started; one shortest path only at the end
        ladder: s.ladder && s.startedAt ? { start: s.ladder.start, target: s.ladder.target, par: s.ladder.par, path: s.done ? s.ladder.path : null } : null,
        gaveUp: Boolean(s.gaveUp),
      };
    },
    act(s, action, body, now) {
      if (action === 'next') return { state: s.startedAt ? s : { ...s, startedAt: now } };
      if (action === 'giveup' && mode === 'ladder' && s.startedAt) return { state: { ...s, done: true, gaveUp: true, ms: now - s.startedAt } };
      if (action !== 'guess') return { state: s, error: 'unknown action' };
      if (!s.startedAt) return { state: s, error: 'not started' };
      const word = String(body.word ?? '').toLowerCase();
      if (mode === 'ladder' && s.ladder) {
        const problem = E.ladderStepProblem([s.ladder.start, ...s.guesses], word, ladderWord, true);
        if (problem) return { state: s, error: problem };
        const guesses = [...s.guesses, word];
        const solved = word === s.ladder.target;
        // A cap keeps the saved session small; reaching it ends the ladder unsolved
        const done = solved || guesses.length >= attempts;
        return { state: { ...s, guesses, solved, done, ms: done ? now - s.startedAt : 0 }, extra: { last: { word } } };
      }
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
      if (mode === 'ladder' && s.ladder) {
        const n = s.guesses.length;
        return {
          score: E.dailyScore(s.solved, n, attempts, s.ms),
          detail: s.solved ? `${n} step${n === 1 ? '' : 's'} (par ${s.ladder.par}) · ${fmt(s.ms)}` : 'didn’t reach it',
        };
      }
      return {
        score: E.dailyScore(s.solved, s.guesses.length, attempts, s.ms),
        detail: `${s.solved ? s.guesses.length : 'X'}/${attempts} · ${fmt(s.ms)}`,
      };
    },
  };
}
