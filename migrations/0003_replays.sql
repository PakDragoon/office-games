-- Shareable replays of finished games (The Liar drawings and words, Flipchip games).
-- The payload is gzip-compressed JSON kept in D1 for now (R2 needs a payment method); only
-- server/src/db/replays.ts touches these tables, so moving to R2 later changes nothing else.
CREATE TABLE replays (
  id         TEXT PRIMARY KEY,          -- short random unguessable id (the link)
  game       TEXT NOT NULL,             -- 'the-liar' | 'flipchip'
  created_at INTEGER NOT NULL,          -- ms since epoch; the nightly cron deletes rows older than 90 days
  size       INTEGER NOT NULL,          -- stored (compressed) bytes
  data       BLOB NOT NULL              -- gzip(JSON)
);
CREATE INDEX replays_created ON replays (created_at);

-- Who took part, so a future "delete my data" can remove (or anonymise) their replays.
-- player_id is the same key as players.id: 'u:<firebase uid>' or 'g:<guest id>'.
CREATE TABLE replay_players (
  replay_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  PRIMARY KEY (replay_id, player_id)
);
CREATE INDEX replay_players_player ON replay_players (player_id);
