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
