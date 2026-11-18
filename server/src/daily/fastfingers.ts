import * as E from '../../../web/fast-fingers/js/engine.js';
import type { DailyGame } from './index';

interface FastDaily {
  text: string;
  /** Server time the race begins (after the 3-2-1), 0 until the player presses Daily paragraph. */
  startedAt: number;
  done: boolean;
  pos: number;
  err: number;
  ms: number;
}

// One paragraph for everyone today, from a seed derived from the server's secret (not the date).
// The text is only sent once the player starts, and the server times the run itself: it starts the
// clock at the end of the countdown and stops it when the finish arrives. The page's own clock is
// used instead only when it agrees (it has no network delay), so nobody can claim a faster time.
// A wrong key never moves the cursor on, so mistakes already cost time: ranked by speed alone.
export const fastfingersDaily: DailyGame<FastDaily> = {
  id: 'fast-fingers',
  order: 'desc',
  streak: true,
  number: (day) => E.dayNumber(day),
  start(_day, key) {
    return { text: E.dailyText(key), startedAt: 0, done: false, pos: 0, err: 0, ms: 0 };
  },
  view(s, now) {
    const started = s.startedAt > 0;
    const len = s.text.length;
    return {
      started,
      words: E.wordCount(s.text),
      // Nothing of the text before the player starts
      text: started ? s.text : '',
      // Negative during the countdown
      elapsed: started ? now - s.startedAt : 0,
      countdownMs: E.TIMES.countdownMs,
      limit: E.limitMs(s.text),
      pos: s.pos,
      err: s.err,
      ms: s.ms,
      wpm: s.done ? E.wpm(s.pos, s.ms) : 0,
      acc: E.accuracy(s.pos, s.err),
      pct: Math.floor((s.pos / Math.max(1, len)) * 100),
      finished: s.done && s.pos >= len,
    };
  },
  act(s, action, body, now) {
    if (action === 'next') {
      if (s.startedAt) return { state: s };
      return { state: { ...s, startedAt: now + E.TIMES.countdownMs } };
    }
    if (action !== 'finish') return { state: s, error: 'unknown action' };
    if (!s.startedAt || now < s.startedAt) return { state: s, error: 'not started' };
    const len = s.text.length;
    const pos = Math.floor(Number(body.pos));
    const err = Math.floor(Number(body.err));
    if (!(pos >= 0 && pos <= len) || !(err >= 0)) return { state: s, error: 'invalid' };
    const elapsed = now - s.startedAt;
    const errs = Math.min(9999, err);
    if (pos === len) {
      if (!E.plausible(len, elapsed)) return { state: s, error: 'invalid' };
      const mine = Number(body.ms);
      const agrees = Number.isFinite(mine) && mine > 0 && mine <= elapsed + 250 && mine >= elapsed - 1500;
      const ms = Math.max(Math.round(agrees ? mine : elapsed), Math.ceil((len / E.MAX_CPS) * 1000));
      return { state: { ...s, done: true, pos, err: errs, ms } };
    }
    // Not finished: only accepted once the time is up
    const limit = E.limitMs(s.text);
    if (elapsed < limit) return { state: s, error: 'not finished' };
    const most = Math.floor(((limit + 1500) / 1000) * E.MAX_CPS);
    return { state: { ...s, done: true, pos: Math.min(pos, most, len - 1), err: errs, ms: limit } };
  },
  result(s) {
    if (!s.done) return null;
    const len = s.text.length;
    const finished = s.pos >= len;
    const acc = E.accuracy(s.pos, s.err);
    return {
      score: E.dailyScore(s.pos, len, s.ms, finished),
      detail: finished ? `${E.wpm(s.pos, s.ms)} wpm · ${acc}% · ${E.formatMs(s.ms)}` : `ran out of time · ${Math.floor((s.pos / len) * 100)}% typed`,
    };
  },
};
