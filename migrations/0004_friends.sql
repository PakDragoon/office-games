-- Friends, online status and recent players.
-- Every player_id / owner / other / other_id here is the same key as players.id ('u:<uid>' or 'g:<guest id>').
-- All of these tables are listed in PLAYER_TABLES (server/src/db/stats.ts), so "Delete my data" and a guest ->
-- Google merge cover them. Only Google accounts ('u:') have friends; guests only have recent players.

-- A Google account's public face for friends: a short shareable friend code and the name friends see.
-- req_day / req_count: friend requests sent today (UTC), the daily limit.
CREATE TABLE friend_profiles (
  player_id TEXT PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,         -- 8 letters/numbers (no look-alikes), e.g. K7QX92MD
  name      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  req_day   TEXT NOT NULL DEFAULT '',
  req_count INTEGER NOT NULL DEFAULT 0
);

-- One row per direction, so each person's list is one indexed read:
--   state 'friend'  : both rows exist, both say 'friend'
--   state 'out'/'in': a request I sent / one I received (the other person's row is the mirror image)
--   state 'blocked' : I blocked them (they have no row about me, so they can't tell)
CREATE TABLE friends (
  player_id TEXT NOT NULL,
  other_id  TEXT NOT NULL,
  state     TEXT NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (player_id, other_id)
);
CREATE INDEX friends_other ON friends (other_id);

-- Who is online and where. Written by the player's hub (see server/src/do/Hub.ts) when they connect, change room,
-- every ~100 s while a tab is open, and when the last tab closes (seen = 0). Someone is online while seen is recent.
CREATE TABLE presence (
  player_id TEXT PRIMARY KEY,
  game      TEXT NOT NULL DEFAULT '',
  room      TEXT NOT NULL DEFAULT '',
  seen      INTEGER NOT NULL
);

-- People you finished a room game with (newest first, at most 30 per player; guests can have them too).
-- ref is a random handle the browser uses to "Add" someone without ever seeing their id.
CREATE TABLE recent_players (
  owner TEXT NOT NULL,
  other TEXT NOT NULL,
  name  TEXT NOT NULL,                    -- the name they used in the room
  game  TEXT NOT NULL,
  at    INTEGER NOT NULL,
  ref   TEXT NOT NULL,
  PRIMARY KEY (owner, other)
);
CREATE INDEX recent_players_owner_at ON recent_players (owner, at);
CREATE INDEX recent_players_other ON recent_players (other);
