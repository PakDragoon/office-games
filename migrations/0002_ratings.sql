-- Glicko-2 skill ratings, one row per player per game (Flipchip and Thulla for now).
-- player_id is the same key as players.id ("u:<uid>" or "g:<guest id>").
-- rating/rd/volatility are the Glicko-2 numbers on the familiar 1500 scale; games counts rated games;
-- updated_at (ms) lets the deviation grow back after a long break.
CREATE TABLE ratings (
  player_id TEXT NOT NULL,
  game TEXT NOT NULL,
  rating REAL NOT NULL DEFAULT 1500,
  rd REAL NOT NULL DEFAULT 350,
  volatility REAL NOT NULL DEFAULT 0.06,
  games INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, game)
);
