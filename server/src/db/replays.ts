// Shareable replays. The rest of the server only talks to ReplayStore (put / get / delete), so
// switching from D1 to R2 later means writing a second implementation of this interface and
// changing one line in replayStore(). Nothing else knows where the bytes live.
//
// Stored: gzip-compressed JSON, an unguessable id, a creation time and the ids of the players who
// took part (replay_players.player_id = players.id: 'u:<uid>' or 'g:<guest>') for "delete my data".

export const REPLAY_MAX_RAW = 128 * 1024;      // JSON bytes before compressing (gzip of this is ~5 ms of CPU, inside the 10 ms budget)
export const REPLAY_MAX_STORED = 64 * 1024;    // bytes kept in the database after compressing
export const REPLAY_KEEP_DAYS = 90;
const ID_RE = /^[A-Za-z0-9]{12}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export interface StoredReplay {
  game: string;
  createdAt: number;
  payload: unknown;
}

export interface ReplayStore {
  /** Save a replay; null when it is too big to keep. */
  put(game: string, payload: unknown, playerIds: string[]): Promise<string | null>;
  /** The replay with this id for this game, or null (never saved, expired, deleted, or another game's). */
  get(game: string, id: string): Promise<StoredReplay | null>;
  delete(id: string): Promise<void>;
  /** The nightly clean-up: remove replays created before `cutoff` (ms). Returns how many. */
  deleteOlderThan(cutoff: number): Promise<number>;
  /** "Delete my data": remove every replay this player took part in. Returns how many. */
  deleteForPlayer(playerId: string): Promise<number>;
}

export const isReplayId = (id: string): boolean => ID_RE.test(id);

/** 12 characters from a 54-letter alphabet: about 69 bits, from crypto.getRandomValues. */
export function newReplayId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let id = '';
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Response(bytes).body;
  if (!body) throw new Error('no body');
  const out = new Response(body.pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const gzip = (bytes: Uint8Array) => pipe(bytes, new CompressionStream('gzip'));
export const gunzip = (bytes: Uint8Array) => pipe(bytes, new DecompressionStream('gzip'));

export function replayStore(db: D1Database): ReplayStore {
  return {
    async put(game, payload, playerIds) {
      const raw = new TextEncoder().encode(JSON.stringify(payload));
      if (raw.length > REPLAY_MAX_RAW) return null;
      const packed = await gzip(raw);
      if (packed.length > REPLAY_MAX_STORED) return null;
      const id = newReplayId();
      const stmts = [
        db.prepare('INSERT INTO replays (id, game, created_at, size, data) VALUES (?1, ?2, ?3, ?4, ?5)')
          .bind(id, game, Date.now(), packed.length, packed),
        ...[...new Set(playerIds)].map((p) =>
          db.prepare('INSERT INTO replay_players (replay_id, player_id) VALUES (?1, ?2)').bind(id, p)),
      ];
      await db.batch(stmts);
      return id;
    },

    async get(game, id) {
      if (!isReplayId(id)) return null;
      const row = await db.prepare('SELECT game, created_at, data FROM replays WHERE id = ?1 AND game = ?2')
        .bind(id, game).first<{ game: string; created_at: number; data: ArrayBuffer | number[] }>();
      if (!row) return null;
      const bytes = Array.isArray(row.data) ? Uint8Array.from(row.data) : new Uint8Array(row.data);
      return { game: row.game, createdAt: row.created_at, payload: JSON.parse(new TextDecoder().decode(await gunzip(bytes))) };
    },

    async delete(id) {
      await db.batch([
        db.prepare('DELETE FROM replay_players WHERE replay_id = ?1').bind(id),
        db.prepare('DELETE FROM replays WHERE id = ?1').bind(id),
      ]);
    },

    async deleteOlderThan(cutoff) {
      const [, res] = await db.batch([
        db.prepare('DELETE FROM replay_players WHERE replay_id IN (SELECT id FROM replays WHERE created_at < ?1)').bind(cutoff),
        db.prepare('DELETE FROM replays WHERE created_at < ?1').bind(cutoff),
      ]);
      return res.meta.changes ?? 0;
    },

    async deleteForPlayer(playerId) {
      const { results } = await db.prepare('SELECT replay_id FROM replay_players WHERE player_id = ?1').bind(playerId).all<{ replay_id: string }>();
      for (let i = 0; i < results.length; i += 40) {
        const ids = results.slice(i, i + 40).map((r) => r.replay_id);
        const marks = ids.map((_, n) => `?${n + 1}`).join(',');
        await db.batch([
          db.prepare(`DELETE FROM replay_players WHERE replay_id IN (${marks})`).bind(...ids),
          db.prepare(`DELETE FROM replays WHERE id IN (${marks})`).bind(...ids),
        ]);
      }
      return results.length;
    },
  };
}

/** Called by the nightly cron. */
export const pruneReplays = (db: D1Database, now = Date.now()) =>
  replayStore(db).deleteOlderThan(now - REPLAY_KEEP_DAYS * 86400000);
