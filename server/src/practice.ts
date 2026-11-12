import * as FF from '../../web/fast-fingers/js/engine.js';
import { type StatWrites, writeStats } from './db/stats';

/**
 * Practice runs happen in the browser (solo, no leaderboard), but a player's own stats page keeps
 * the results. The browser reports a finished run; the server only accepts numbers a person could
 * really have produced, and adds them to the player's OWN counters. Nothing here can reach a
 * leaderboard, a crew or another player.
 */
type Body = Record<string, unknown>;

/** A whole number in [min, max], else null. */
const whole = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;

export const PRACTICE: Record<string, (b: Body) => StatWrites | null> = {
  // Words in a row without a splat. A word takes at least ~1.2 s, so a streak can't outrun its clock.
  rotten(b) {
    const streak = whole(b.streak, 1, 500);
    const ms = whole(b.ms, 0, 3 * 3600 * 1000);
    if (streak === null || ms === null || ms < (streak - 1) * 1200) return null;
    return { max: { practiceBest: streak } };
  },
  // One finished paragraph. Speed is worked out here from characters and time, never taken from the browser.
  'fast-fingers'(b) {
    const chars = whole(b.chars, 20, 1500);
    const ms = whole(b.ms, 1000, 30 * 60 * 1000);
    if (chars === null || ms === null || !FF.plausible(chars, ms)) return null;
    return { stats: { solos: 1, plays: 1, chars }, max: { bestWpm: FF.wpm(chars, ms) } };
  },
};

/** One report per player every few seconds, per Worker instance (a run can't be shorter than that anyway). */
const MIN_GAP_MS = 3000;
const last = new Map<string, number>();

export function practiceAllowed(player: string, now = Date.now()): boolean {
  if (last.size > 2000) {
    for (const [k, t] of last) if (now - t > MIN_GAP_MS) last.delete(k);
    if (last.size > 2000) last.clear();
  }
  const prev = last.get(player);
  if (prev !== undefined && now - prev < MIN_GAP_MS) return false;
  last.set(player, now);
  return true;
}

export async function recordPractice(db: D1Database, player: string, game: string, body: Body): Promise<'ok' | 'invalid'> {
  const writes = PRACTICE[game]?.(body);
  if (!writes) return 'invalid';
  await writeStats(db, player, game, writes);
  return 'ok';
}
