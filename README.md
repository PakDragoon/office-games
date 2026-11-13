# Office games

Free real-time multiplayer browser games, served by one Cloudflare Worker:
**https://play.orcavalley.com** (also https://play.officegames.workers.dev, which fails on networks that block Encrypted Client Hello)

| Path | Game | On the server | In the browser |
| --- | --- | --- | --- |
| `/` | Games page | – | static |
| `/rotten/` | Rotten | rooms, Quick Play, global daily | practice |
| `/the-liar/` | The Liar | rooms, Quick Play | – |
| `/thulla/` | Thulla | rooms, Quick Play | – |
| `/guesstimate/` | Guesstimate | rooms, Quick Play, global daily | practice |
| `/melonburst/` | Melon Burst | rooms, Quick Play | daily word, practice |
| `/flipchip/` | Flipchip | rooms, Quick Play | vs the computer |
| `/fast-fingers/` | Fast Fingers | rooms, Quick Play | practice |
| `/lettuce-party/` | Lettuce Party | rooms, Quick Play | – |

Every room is a Durable Object: the server holds the secrets, checks every move, runs the timers,
passes the host role on when the host leaves, and writes the stats. Solo modes run the same rules
in the browser and stay off the leaderboards (except the dailies marked above, which the server runs).

## How it works

- **`web/`** is served as-is (no build step): the games page, each game's `index.html`/`style.css`/`js/`, word lists,
  and `web/shared/` (the WebSocket room client `net.js` and Google sign-in + API helper `cloud.js`).
- **`server/src/`** is the Worker (TypeScript):
  - `index.ts` routes `/<game>/ws` to a room, `/api/*` to the API, everything else to the static files.
  - `do/GameRoom.ts`: one Durable Object per room. Keeps the game in memory, saves a snapshot to its own storage
    after every meaningful change, runs the game's timers with one Alarm, lets the runtime answer keep-alive pings
    so idle rooms hibernate, rate-limits each connection, and deletes itself 10 minutes after everyone has left.
  - `do/Lobby.ts`: one per game; the public room list and Quick Play.
  - `core/game.ts`: the contract between a room and a game (`RoomCtx`, `GameModule`). Game modules never touch
    Cloudflare APIs directly.
  - `core/seats.ts`: what room games share (seats, taking a seat back after a refresh, host hand-over, Away, crews).
  - `games/<game>.ts`: each game's host logic (moved from the old host-in-the-browser code). The rules stay in
    `web/<game>/js/engine.js`, shared with the browser's solo modes.
  - `daily/`: global daily puzzles run by the server (one prompt at a time, timed on the server, UTC day).
  - `db/stats.ts` + `migrations/`: D1 (players, per-game stats, crews, match log, daily results).
  - `auth.ts`: Firebase ID tokens checked against Google's keys; guests get a server-signed id.
- Word lists are bundled into the Worker as text and searched in place (`core/words.ts`), which fits the free
  plan's 10 ms CPU limit.

## Develop

Node 22+.

```
npm install
npx wrangler d1 migrations apply office-games --local
npm run dev            # http://localhost:8787
npm test               # each game's engine tests + server tests (vitest in the Workers runtime)
npm run typecheck
```

Add `?debug` to a game's address to expose its state on `window.__<game>` for browser tests.

## Deploy

Pushing to `main` runs the tests, applies D1 migrations and deploys (GitHub Actions, secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`). By hand: `npx wrangler deploy`.

Secrets on the Worker: `SERVER_SECRET` (signs guest ids and daily seeds): `npx wrangler secret put SERVER_SECRET`.

The old GitHub Pages games page lives on the `pages` branch (pakdragoon.github.io/office-games).
