import type { Env } from '../env';
import { hmac } from '../auth';
import { rottenDaily } from './rotten';

/**
 * Global daily puzzles. The server shows one step at a time and measures time itself, so a
 * result on the leaderboard is one the server watched happen. One day for everyone: UTC.
 */
export interface DailyGame<S = unknown> {
  id: string;
  /** 'asc': lower score wins (time). 'desc': higher score wins (points). */
  order: 'asc' | 'desc';
  /** Today's puzzle number, as shown in the game. */
  number(day: string): number;
  /** A fresh session for this day. `key` is secret: different from the public date, so nobody can work out tomorrow's puzzle. */
  start(day: string, key: string): S;
  /** What the player may see right now. */
  view(s: S, now: number): Record<string, unknown>;
  /** Apply one action ('next', 'answer', 'skip'...). Returns the new state, or an error to show. */
  act(s: S, action: string, body: Record<string, unknown>, now: number): { state: S; error?: string; extra?: Record<string, unknown> };
  /** The final score once finished, else null. */
  result(s: S): { score: number; detail: string } | null;
}

export const DAILIES: Record<string, DailyGame> = {
  rotten: rottenDaily as DailyGame,
};

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

type PlayerOf = (request: Request, env: Env) => Promise<string | null>;

export async function handleDaily(request: Request, env: Env, game: string, action: string | undefined, playerOf: PlayerOf): Promise<Response> {
  const daily = DAILIES[game];
  if (!daily) return json({ error: 'no daily for this game' }, 404);
  const day = utcDay();
  if (action === 'board' && request.method === 'GET') {
    const asked = new URL(request.url).searchParams.get('day');
    const which = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : day;
    const player = await playerOf(request, env);
    return json(await board(env.DB, daily, which, player));
  }
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const player = await playerOf(request, env);
  if (!player) return json({ error: 'not signed in' }, 401);
  const body = ((await request.json().catch(() => ({}))) || {}) as Record<string, unknown>;
  const now = Date.now();
  const row = await env.DB.prepare('SELECT state FROM daily_sessions WHERE game = ?1 AND day = ?2 AND player_id = ?3')
    .bind(game, day, player)
    .first<{ state: string }>();
  let state: unknown = row ? JSON.parse(row.state) : null;
  if (!state) {
    const key = await hmac(env.SERVER_SECRET || 'dev-only-secret-change-me', `daily:${game}:${day}`);
    state = daily.start(day, key);
  }
  let extra: Record<string, unknown> = {};
  if (action && action !== 'state') {
    const before = daily.result(state);
    if (before) return json({ day, number: daily.number(day), ...daily.view(state, now), done: true });
    const out = daily.act(state, action, body, now);
    if (out.error) return json({ day, number: daily.number(day), error: out.error, ...daily.view(state, now) });
    state = out.state;
    extra = out.extra || {};
  }
  const stmts = [
    env.DB.prepare(
      `INSERT INTO daily_sessions (game, day, player_id, state, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (game, day, player_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    ).bind(game, day, player, JSON.stringify(state), now),
  ];
  const res = daily.result(state);
  if (res) {
    const name = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) : '';
    stmts.push(
      env.DB.prepare(
        `INSERT INTO daily_results (game, day, player_id, name, score, detail, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (game, day, player_id) DO NOTHING`,
      ).bind(game, day, player, name || 'Player', res.score, res.detail, now),
      env.DB.prepare(
        `INSERT INTO player_stats (player_id, game, stat, value) VALUES (?1, ?2, 'dailies', 1)
         ON CONFLICT (player_id, game, stat) DO UPDATE SET value = value + 1`,
      ).bind(player, game),
      env.DB.prepare(
        `INSERT INTO player_stats (player_id, game, stat, value) VALUES (?1, ?2, 'bestDaily', ?3)
         ON CONFLICT (player_id, game, stat) DO UPDATE SET value = ${daily.order === 'asc' ? 'MIN' : 'MAX'}(value, excluded.value)`,
      ).bind(player, game, res.score),
    );
  }
  if (!row || (action && action !== 'state')) await env.DB.batch(stmts);
  return json({ day, number: daily.number(day), ...daily.view(state, now), ...extra, done: Boolean(res) });
}

async function board(db: D1Database, daily: DailyGame, day: string, player: string | null) {
  const dir = daily.order === 'asc' ? 'ASC' : 'DESC';
  const { results } = await db
    .prepare(`SELECT player_id, name, score, detail FROM daily_results WHERE game = ?1 AND day = ?2 ORDER BY score ${dir}, at ASC LIMIT 50`)
    .bind(daily.id, day)
    .all<{ player_id: string; name: string; score: number; detail: string }>();
  const count = await db.prepare('SELECT COUNT(*) AS n FROM daily_results WHERE game = ?1 AND day = ?2').bind(daily.id, day).first<{ n: number }>();
  let me: { rank: number; score: number } | null = null;
  if (player) {
    const mine = await db
      .prepare('SELECT score FROM daily_results WHERE game = ?1 AND day = ?2 AND player_id = ?3')
      .bind(daily.id, day, player)
      .first<{ score: number }>();
    if (mine) {
      const cmp = daily.order === 'asc' ? '<' : '>';
      const better = await db
        .prepare(`SELECT COUNT(*) AS n FROM daily_results WHERE game = ?1 AND day = ?2 AND score ${cmp} ?3`)
        .bind(daily.id, day, mine.score)
        .first<{ n: number }>();
      me = { rank: (better?.n ?? 0) + 1, score: mine.score };
    }
  }
  return {
    day,
    number: daily.number(day),
    players: count?.n ?? 0,
    top: results.map((r, i) => ({ rank: i + 1, name: r.name, score: r.score, detail: r.detail, me: r.player_id === player })),
    me,
  };
}

/** Cron, just after midnight UTC: forget sessions older than a few days (results stay). */
export async function rollDaily(env: Env): Promise<void> {
  const cutoff = utcDay(new Date(Date.now() - 3 * 86400000));
  await env.DB.prepare('DELETE FROM daily_sessions WHERE day < ?1').bind(cutoff).run();
}
