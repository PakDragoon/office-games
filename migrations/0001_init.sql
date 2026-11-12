-- Players: signed-in ("u:<firebase uid>") or guests ("g:<server-signed guest id>")
CREATE TABLE players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  photo TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per counter, so a new game or a new stat needs no migration
CREATE TABLE player_stats (
  player_id TEXT NOT NULL,
  game TEXT NOT NULL,
  stat TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, game, stat)
);

CREATE TABLE crews (
  id TEXT PRIMARY KEY,            -- "<game>:<crew key>"
  game TEXT NOT NULL,
  name TEXT NOT NULL,
  games INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE crew_stats (
  crew_id TEXT NOT NULL,
  player TEXT NOT NULL,           -- name as shown in the room
  stat TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (crew_id, player, stat)
);

CREATE TABLE matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,
  room TEXT NOT NULL,
  crew_id TEXT,
  winner TEXT,
  players TEXT NOT NULL,          -- JSON
  at INTEGER NOT NULL
);
CREATE INDEX matches_game_at ON matches (game, at);

-- Global daily puzzles: one result per player per day per game
CREATE TABLE daily_results (
  game TEXT NOT NULL,
  day TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  player_id TEXT NOT NULL,
  name TEXT NOT NULL,
  score REAL NOT NULL,            -- lower is better or higher is better: per game (see server/src/daily)
  detail TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  PRIMARY KEY (game, day, player_id)
);
CREATE INDEX daily_board ON daily_results (game, day, score);

-- A daily in progress: the server shows one prompt at a time and times the answers itself
CREATE TABLE daily_sessions (
  game TEXT NOT NULL,
  day TEXT NOT NULL,
  player_id TEXT NOT NULL,
  state TEXT NOT NULL,            -- JSON, game-specific
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (game, day, player_id)
);
