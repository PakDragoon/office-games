// Skill ratings in D1: read for display and Quick Play, written after every rated game.
// The maths is in core/glicko2.ts; this file only decides who is rated and stores the result.
import type { RatedEntry, RatingChange, RatingInfo } from '../core/game';
import { growRd, isProvisional, rateRanking, START, type Rating } from '../core/glicko2';
import { playerKey } from './stats';

/** Games that have ratings. Everything else is never rated. */
export const RATED_GAMES = new Set(['flipchip', 'thulla']);

interface Row {
  rating: number;
  rd: number;
  volatility: number;
  games: number;
  updated_at: number;
}

const FRESH: Row = { rating: START.rating, rd: START.rd, volatility: START.vol, games: 0, updated_at: 0 };

const asRating = (r: Row, now: number): Rating => ({ rating: r.rating, rd: r.games ? growRd({ rating: r.rating, rd: r.rd, vol: r.volatility }, now - r.updated_at) : r.rd, vol: r.volatility });

/** What anyone may see about a rating: rounded, with the deviation grown for time spent away. */
export function toInfo(row: Row | undefined, now: number): RatingInfo {
  const r = row ?? FRESH;
  const rd = asRating(r, now).rd;
  return { rating: Math.round(r.rating), rd: Math.round(rd), games: r.games, provisional: isProvisional(rd) };
}

async function readRows(db: D1Database, game: string, keys: string[]): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  if (!keys.length) return out;
  const marks = keys.map((_, i) => `?${i + 2}`).join(',');
  const { results } = await db
    .prepare(`SELECT player_id, rating, rd, volatility, games, updated_at FROM ratings WHERE game = ?1 AND player_id IN (${marks})`)
    .bind(game, ...keys)
    .all<Row & { player_id: string }>();
  for (const r of results) out.set(r.player_id, r);
  return out;
}

/** One player's rating for display (null when the game isn't rated or there is no id). */
export async function ratingFor(db: D1Database, game: string, key: string | null): Promise<RatingInfo | null> {
  if (!key || !RATED_GAMES.has(game)) return null;
  const rows = await readRows(db, game, [key]);
  return toInfo(rows.get(key), Date.now());
}

/** Ratings for a list of people, in the same order (null for someone without an id). */
export async function ratingsFor(db: D1Database, game: string, who: Array<{ uid: string | null; guest: string | null }>): Promise<Array<RatingInfo | null>> {
  if (!RATED_GAMES.has(game)) return who.map(() => null);
  const keys = who.map((w) => playerKey(w.uid, w.guest));
  const rows = await readRows(db, game, [...new Set(keys.filter((k): k is string => Boolean(k)))]);
  const now = Date.now();
  return keys.map((k) => (k ? toInfo(rows.get(k), now) : null));
}

/**
 * Rate one finished game. Nothing is rated (every result is null) when the game isn't a rated
 * one, a seat is a bot, fewer than two people have an id, or one person holds two seats.
 * Ratings are judged on what they were before the game, so the order of `entries` never matters.
 */
export async function rateGame(db: D1Database, game: string, entries: RatedEntry[]): Promise<Array<RatingChange | null>> {
  const none = entries.map(() => null);
  if (!RATED_GAMES.has(game) || entries.some((e) => e.bot)) return none;
  const keys = entries.map((e) => playerKey(e.uid, e.guest));
  const keyed = keys.filter((k): k is string => Boolean(k));
  if (keyed.length < 2 || new Set(keyed).size !== keyed.length) return none;

  const results: Array<RatingChange | null> = entries.map(() => null);
  const pending = new Set(keyed);
  for (let attempt = 0; attempt < 3 && pending.size; attempt++) {
    const now = Date.now();
    const rows = await readRows(db, game, keyed);
    const idx = entries.map((_, i) => i).filter((i) => keys[i]);
    const next = rateRanking(idx.map((i) => ({ rating: asRating(rows.get(keys[i] as string) ?? FRESH, now), place: entries[i].place })));
    const stmts: D1PreparedStatement[] = [];
    const todo: number[] = [];
    idx.forEach((i, n) => {
      const key = keys[i] as string;
      if (!pending.has(key)) return;
      const old = rows.get(key);
      const r = next[n];
      todo.push(i);
      // Only write if nobody else rated this player since we read (a second room finishing at the same moment)
      stmts.push(
        old
          ? db
              .prepare('UPDATE ratings SET rating = ?3, rd = ?4, volatility = ?5, games = games + 1, updated_at = ?6 WHERE player_id = ?1 AND game = ?2 AND games = ?7 AND updated_at = ?8')
              .bind(key, game, r.rating, r.rd, r.vol, now, old.games, old.updated_at)
          : db
              .prepare('INSERT INTO ratings (player_id, game, rating, rd, volatility, games, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6) ON CONFLICT (player_id, game) DO NOTHING')
              .bind(key, game, r.rating, r.rd, r.vol, now),
      );
    });
    const done = await db.batch(stmts);
    todo.forEach((i, n) => {
      if (!done[n].meta.changes) return;
      const key = keys[i] as string;
      const old = rows.get(key);
      const r = next[idx.indexOf(i)];
      const after = toInfo({ rating: r.rating, rd: r.rd, volatility: r.vol, games: (old?.games ?? 0) + 1, updated_at: now }, now);
      const before = Math.round((old ?? FRESH).rating);
      results[i] = { ...after, before, delta: after.rating - before };
      pending.delete(key);
    });
  }
  return results;
}
