import type { GameReport } from '../core/game';

export const playerKey = (uid: string | null, guest: string | null): string | null =>
  uid ? `u:${uid}` : guest ? `g:${guest}` : null;

/** Same idea as the old Firestore crew ids: letters and numbers only, lower case. */
export const crewKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Write one finished game: player stats, crew totals and the match log, in one batch. */
export async function recordGame(db: D1Database, r: GameReport): Promise<string> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const upsertPlayer = db.prepare(
    `INSERT INTO players (id, name, photo, created_at, updated_at) VALUES (?1, ?2, '', ?3, ?3)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
  );
  const addStat = db.prepare(
    `INSERT INTO player_stats (player_id, game, stat, value) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (player_id, game, stat) DO UPDATE SET value = value + excluded.value`,
  );
  const maxStat = db.prepare(
    `INSERT INTO player_stats (player_id, game, stat, value) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (player_id, game, stat) DO UPDATE SET value = MAX(value, excluded.value)`,
  );
  for (const p of r.players) {
    const id = playerKey(p.uid, p.guest);
    if (!id) continue;
    stmts.push(upsertPlayer.bind(id, p.name, now));
    for (const [k, v] of Object.entries(p.stats)) if (Number.isFinite(v) && v !== 0) stmts.push(addStat.bind(id, r.game, k, v));
    for (const [k, v] of Object.entries(p.max || {})) if (Number.isFinite(v)) stmts.push(maxStat.bind(id, r.game, k, v));
  }
  let crewId: string | null = null;
  if (r.crew && crewKey(r.crew).length >= 3) {
    crewId = `${r.game}:${crewKey(r.crew)}`;
    stmts.push(
      db
        .prepare(
          `INSERT INTO crews (id, game, name, games, created_at, updated_at) VALUES (?1, ?2, ?3, 1, ?4, ?4)
           ON CONFLICT (id) DO UPDATE SET games = games + 1, updated_at = excluded.updated_at`,
        )
        .bind(crewId, r.game, r.crew, now),
    );
    const addCrew = db.prepare(
      `INSERT INTO crew_stats (crew_id, player, stat, value) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (crew_id, player, stat) DO UPDATE SET value = value + excluded.value`,
    );
    for (const p of r.players) {
      for (const [k, v] of Object.entries({ games: 1, wins: p.won ? 1 : 0, ...p.stats })) {
        if (Number.isFinite(v) && v !== 0) stmts.push(addCrew.bind(crewId, p.name, k, v));
      }
    }
  }
  stmts.push(
    db
      .prepare('INSERT INTO matches (game, room, crew_id, winner, players, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(
        r.game,
        r.room,
        crewId,
        r.winner,
        JSON.stringify(r.players.map((p) => ({ name: p.name, place: p.place, won: p.won, ...p.stats }))),
        now,
      ),
  );
  await db.batch(stmts);
  if (!crewId) return '';
  const row = await db.prepare('SELECT games FROM crews WHERE id = ?1').bind(crewId).first<{ games: number }>();
  return `Saved to ${r.crew}. ${plural(row?.games ?? 1, 'game')} played as this crew.`;
}

export async function crewInfo(db: D1Database, game: string, name: string): Promise<{ games: number } | null> {
  if (crewKey(name).length < 3) return null;
  return db.prepare('SELECT games FROM crews WHERE id = ?1').bind(`${game}:${crewKey(name)}`).first<{ games: number }>();
}

export async function crewTable(db: D1Database, game: string, name: string) {
  const id = `${game}:${crewKey(name)}`;
  const crew = await db.prepare('SELECT name, games FROM crews WHERE id = ?1').bind(id).first<{ name: string; games: number }>();
  if (!crew) return null;
  const { results } = await db
    .prepare('SELECT player, stat, value FROM crew_stats WHERE crew_id = ?1')
    .bind(id)
    .all<{ player: string; stat: string; value: number }>();
  const players: Record<string, Record<string, number>> = {};
  for (const r of results) (players[r.player] ||= {})[r.stat] = r.value;
  return { name: crew.name, games: crew.games, players };
}

export async function playerStats(db: D1Database, playerId: string, game: string): Promise<Record<string, number>> {
  const { results } = await db
    .prepare('SELECT stat, value FROM player_stats WHERE player_id = ?1 AND game = ?2')
    .bind(playerId, game)
    .all<{ stat: string; value: number }>();
  return Object.fromEntries(results.map((r) => [r.stat, r.value]));
}

// ---------- Account data: merging a guest into a Google account, and deleting a player ----------

/**
 * THE rule for stats that are not simple counters. Every other player_stats row is a counter and is ADDED when
 * a guest is merged into an account. Keys are "<game>:<stat>". A new best-of stat must be listed here or a merge
 * would add two bests together.
 *
 * 'max': the higher value wins. 'min': the lower value wins (a time).
 * Kept in step with how each stat is written: `max` in a game's GameReport (rotten, fast-fingers, lettuce-party)
 * and `bestDaily` in server/src/daily/index.ts (MIN when the daily's order is 'asc', else MAX).
 */
export const BEST_STATS: Record<string, 'max' | 'min'> = {
  'rotten:longest': 'max', // longest word
  'fast-fingers:bestWpm': 'max', // words per minute
  'lettuce-party:fastestNeg': 'max', // the fastest solve in ms, stored NEGATED so that MAX = fastest
  'rotten:bestDaily': 'min', // the daily's score is a time (order 'asc')
  'guesstimate:bestDaily': 'max', // the daily's score is points (order 'desc')
};

const keysOf = (kind: 'max' | 'min') => Object.keys(BEST_STATS).filter((k) => BEST_STATS[k] === kind);
const marks = (from: number, n: number) => Array.from({ length: n }, (_, i) => `?${from + i}`).join(',');

/**
 * Move everything a guest ("g:...") earned into a Google account ("u:..."), in ONE D1 batch (all or nothing),
 * then remove the guest's rows. Safe to run twice: the second run finds nothing left to move.
 *  - counters are added, best-of stats keep the better value (BEST_STATS);
 *  - a daily result moves only if the account has none for that (game, day); the account's own result always wins,
 *    and the account's `dailies` counter is corrected so a day played both ways counts once;
 *  - a daily session moves only if the account has none for that (game, day). If the guest already finished a day
 *    that the account only started, the guest's finished result replaces the account's unfinished session.
 * Not touched: crew_stats and matches (they only hold display names, never player ids).
 */
export async function mergePlayer(db: D1Database, fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const max = keysOf('max');
  const min = keysOf('min');
  const all = [...max, ...min];
  const tail = (expr: string) => `ON CONFLICT (player_id, game, stat) DO UPDATE SET value = ${expr}`;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO players (id, name, photo, created_at, updated_at)
         SELECT ?2, name, photo, created_at, updated_at FROM players WHERE id = ?1
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(fromId, toId),
    // counters: add
    db
      .prepare(
        `INSERT INTO player_stats (player_id, game, stat, value)
         SELECT ?2, game, stat, value FROM player_stats WHERE player_id = ?1 AND (game || ':' || stat) NOT IN (${marks(3, all.length)})
         ${tail('value + excluded.value')}`,
      )
      .bind(fromId, toId, ...all),
    // best-of: higher wins
    db
      .prepare(
        `INSERT INTO player_stats (player_id, game, stat, value)
         SELECT ?2, game, stat, value FROM player_stats WHERE player_id = ?1 AND (game || ':' || stat) IN (${marks(3, max.length)})
         ${tail('MAX(value, excluded.value)')}`,
      )
      .bind(fromId, toId, ...max),
    // best-of: lower wins
    db
      .prepare(
        `INSERT INTO player_stats (player_id, game, stat, value)
         SELECT ?2, game, stat, value FROM player_stats WHERE player_id = ?1 AND (game || ':' || stat) IN (${marks(3, min.length)})
         ${tail('MIN(value, excluded.value)')}`,
      )
      .bind(fromId, toId, ...min),
    // a day played both as guest and as the account counts once in `dailies`
    db
      .prepare(
        `UPDATE player_stats SET value = MAX(0, value - (
           SELECT COUNT(*) FROM daily_results g JOIN daily_results u ON u.game = g.game AND u.day = g.day AND u.player_id = ?2
           WHERE g.player_id = ?1 AND g.game = player_stats.game))
         WHERE player_id = ?2 AND stat = 'dailies'`,
      )
      .bind(fromId, toId),
    // the guest's finished day beats the account's unfinished session for the same day
    db
      .prepare(
        `DELETE FROM daily_sessions WHERE player_id = ?2
           AND EXISTS (SELECT 1 FROM daily_results g WHERE g.player_id = ?1 AND g.game = daily_sessions.game AND g.day = daily_sessions.day)
           AND NOT EXISTS (SELECT 1 FROM daily_results u WHERE u.player_id = ?2 AND u.game = daily_sessions.game AND u.day = daily_sessions.day)`,
      )
      .bind(fromId, toId),
    db
      .prepare(
        `INSERT OR IGNORE INTO daily_results (game, day, player_id, name, score, detail, at)
         SELECT game, day, ?2, name, score, detail, at FROM daily_results WHERE player_id = ?1`,
      )
      .bind(fromId, toId),
    db
      .prepare(
        `INSERT OR IGNORE INTO daily_sessions (game, day, player_id, state, updated_at)
         SELECT game, day, ?2, state, updated_at FROM daily_sessions WHERE player_id = ?1`,
      )
      .bind(fromId, toId),
    ...PLAYER_TABLES.map(([table, column]) => db.prepare(`DELETE FROM ${table} WHERE ${column} = ?1`).bind(fromId)),
  ];
  await db.batch(stmts);
}

/**
 * EVERY table that holds rows about one player (keyed by a player id). deletePlayer() and mergePlayer() both work
 * from this list.
 *
 * !! A new table that stores a player id (ratings, replays, anything per player) MUST be added here, or "Delete my
 * !! data" will leave that data behind and a merge will strand it on the guest. !!
 *
 * Deliberately NOT here: crew_stats (keyed by the display name typed in the room, shared with the rest of the crew, so
 * it can't be tied to one player) and matches (a log whose players JSON only holds display names). Both hold names
 * only, no player id, no Google account. The Delete my data text says so.
 */
const PLAYER_TABLES: ReadonlyArray<readonly [table: string, column: string]> = [
  ['player_stats', 'player_id'],
  ['daily_results', 'player_id'],
  ['daily_sessions', 'player_id'],
  ['players', 'id'],
];

/** Delete everything held for these player ids (e.g. ["u:abc", "g:xyz"]), in one batch. Returns how many rows went. */
export async function deletePlayer(db: D1Database, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const stmts = ids.flatMap((id) => PLAYER_TABLES.map(([table, column]) => db.prepare(`DELETE FROM ${table} WHERE ${column} = ?1`).bind(id)));
  const results = await db.batch(stmts);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}
