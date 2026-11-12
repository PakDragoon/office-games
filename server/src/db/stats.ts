import type { GameReport } from '../core/game';

export const playerKey = (uid: string | null, guest: string | null): string | null =>
  uid ? `u:${uid}` : guest ? `g:${guest}` : null;

/** Same idea as the old Firestore crew ids: letters and numbers only, lower case. */
export const crewKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);

/** Most different choices a player keeps per tally group (their openers, say): keeps the rows bounded. */
export const TALLY_MAX = 40;
const TALLY_KEY = /^[a-z0-9_-]{1,24}$/;
const GROUP = /^[a-z][a-zA-Z0-9]{0,15}$/;
const best = (name: string) => `best${name[0].toUpperCase()}${name.slice(1)}`;

export interface StatWrites {
  /** Added to the counter. */
  stats?: Record<string, number>;
  /** Kept at the highest value seen. */
  max?: Record<string, number>;
  /** Overwritten. */
  set?: Record<string, number>;
  /** Running streaks (see GameReport). */
  streaks?: Record<string, boolean>;
  /** Count per choice (see GameReport). */
  tally?: Record<string, string>;
}

/** The D1 statements that apply one player's stat changes. No reads, so they fit in one batch. */
export function statWrites(db: D1Database, id: string, game: string, w: StatWrites): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  const upsert = (tail: string) =>
    db.prepare(`INSERT INTO player_stats (player_id, game, stat, value) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (player_id, game, stat) DO UPDATE SET ${tail}`);
  const addStat = upsert('value = value + excluded.value');
  const maxStat = upsert('value = MAX(value, excluded.value)');
  const setStat = upsert('value = excluded.value');
  for (const [k, v] of Object.entries(w.stats || {})) if (Number.isFinite(v) && v !== 0) out.push(addStat.bind(id, game, k, v));
  for (const [k, v] of Object.entries(w.max || {})) if (Number.isFinite(v)) out.push(maxStat.bind(id, game, k, v));
  for (const [k, v] of Object.entries(w.set || {})) if (Number.isFinite(v)) out.push(setStat.bind(id, game, k, v));
  for (const [name, hit] of Object.entries(w.streaks || {})) {
    if (!GROUP.test(name)) continue;
    out.push(hit ? addStat.bind(id, game, name, 1) : setStat.bind(id, game, name, 0));
    // The best is read back inside the same batch, after the line above has run
    out.push(
      db
        .prepare(
          `INSERT INTO player_stats (player_id, game, stat, value)
           SELECT player_id, game, ?4, value FROM player_stats WHERE player_id = ?1 AND game = ?2 AND stat = ?3
           ON CONFLICT (player_id, game, stat) DO UPDATE SET value = MAX(value, excluded.value)`,
        )
        .bind(id, game, name, best(name)),
    );
  }
  for (const [group, key] of Object.entries(w.tally || {})) {
    if (!GROUP.test(group) || !TALLY_KEY.test(key)) continue;
    // A new choice is only added while the player has fewer than TALLY_MAX in this group
    out.push(
      db
        .prepare(
          `INSERT INTO player_stats (player_id, game, stat, value)
           SELECT ?1, ?2, ?3, 1
           WHERE EXISTS (SELECT 1 FROM player_stats WHERE player_id = ?1 AND game = ?2 AND stat = ?3)
              OR (SELECT COUNT(*) FROM player_stats WHERE player_id = ?1 AND game = ?2 AND stat >= ?4 AND stat < ?5) < ?6
           ON CONFLICT (player_id, game, stat) DO UPDATE SET value = value + 1`,
        )
        .bind(id, game, `${group}:${key}`, `${group}:`, `${group};`, TALLY_MAX),
    );
  }
  return out;
}

/** Apply stat changes outside a finished room game (practice runs). */
export async function writeStats(db: D1Database, id: string, game: string, w: StatWrites): Promise<void> {
  const stmts = statWrites(db, id, game, w);
  if (stmts.length) await db.batch(stmts);
}

/**
 * Statements for a daily puzzle finished on `day` (YYYY-MM-DD): the day streak goes up when the
 * last daily was yesterday, restarts at 1 otherwise. Reads two counters first.
 */
export async function dailyStreakWrites(db: D1Database, id: string, game: string, day: string): Promise<D1PreparedStatement[]> {
  const today = Math.floor(Date.parse(day) / 86400000);
  const { results } = await db
    .prepare(`SELECT stat, value FROM player_stats WHERE player_id = ?1 AND game = ?2 AND stat IN ('streak', 'lastDay')`)
    .bind(id, game)
    .all<{ stat: string; value: number }>();
  const old = Object.fromEntries(results.map((r) => [r.stat, r.value]));
  if (old.lastDay === today) return [];
  const streak = old.lastDay === today - 1 ? (old.streak || 0) + 1 : 1;
  return statWrites(db, id, game, { set: { streak, lastDay: today }, max: { bestStreak: streak } });
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Write one finished game: player stats, crew totals and the match log, in one batch. */
export async function recordGame(db: D1Database, r: GameReport): Promise<string> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const upsertPlayer = db.prepare(
    `INSERT INTO players (id, name, photo, created_at, updated_at) VALUES (?1, ?2, '', ?3, ?3)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
  );
  for (const p of r.players) {
    const id = playerKey(p.uid, p.guest);
    if (!id) continue;
    stmts.push(upsertPlayer.bind(id, p.name, now));
    stmts.push(...statWrites(db, id, r.game, p));
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
