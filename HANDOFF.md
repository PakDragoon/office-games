# Handoff: Office Games

Updated Nov 25, 2026 · Hassan Ali (PakDragoon)

Twelve free, real-time multiplayer browser games plus one page that links them all. **Since Nov 13 they all run on a server**: one Cloudflare Worker serves the pages, and every room is a Durable Object that holds the game, checks every move and writes the stats to Cloudflare D1. Everything is in **one monorepo**, `PakDragoon/office-games`, and every push to `main` is tested and deployed automatically. Firebase is only used for Google sign-in now.

The old GitHub Pages addresses (pakdragoon.github.io/<game>) redirect to play.orcavalley.com since Nov 14, carrying each player's saved names and settings (§3).

**Starting a new coding session.** Read `HANDOFF.md`, especially §2 for development rules and §4 for setup.

The migration summary is in §3 and the current server architecture is in §5.

---

## 1. At a glance

**Live: https://play.orcavalley.com** (since Nov 13; the old https://play.officegames.workers.dev still serves the same Worker but fails on networks that block ECH, see §3)

| | Live address (server) | Old address (now redirects here, §3) | Players |
| --- | --- | --- | --- |
| **Games page** | [/](https://play.orcavalley.com/) | [pakdragoon.github.io/office-games](https://pakdragoon.github.io/office-games/) (now served from the `pages` branch) | – |
| **Ludo** (BETA, live Nov 19) | [/ludo/](https://play.orcavalley.com/ludo/) | – | 2–4 (or 2 vs 2, + watchers) |
| **Alzheimer’s** (BETA, Nov 17) | [/alzheimers/](https://play.orcavalley.com/alzheimers/) | – | 2–8 |
| **Forehead** | [/forehead/](https://play.orcavalley.com/forehead/) | – | 2–8 |
| **A to Zap** | [/a-to-zap/](https://play.orcavalley.com/a-to-zap/) | – | 2–8 |
| **Fast Fingers** | [/fast-fingers/](https://play.orcavalley.com/fast-fingers/) | pakdragoon.github.io/fast-fingers | 1–8 |
| **Melon Burst** | [/melonburst/](https://play.orcavalley.com/melonburst/) | pakdragoon.github.io/melonburst | 1–8 |
| **Flipchip** | [/flipchip/](https://play.orcavalley.com/flipchip/) | pakdragoon.github.io/flipchip | 1–2 (+ watchers) |
| **Rotten** | [/rotten/](https://play.orcavalley.com/rotten/) | pakdragoon.github.io/rotten | 2–8 |
| **The Liar** | [/the-liar/](https://play.orcavalley.com/the-liar/) | pakdragoon.github.io/the-liar | 3–8 |
| **Guesstimate** | [/guesstimate/](https://play.orcavalley.com/guesstimate/) | pakdragoon.github.io/guesstimate | 1–8 |
| **Thulla** | [/thulla/](https://play.orcavalley.com/thulla/) | pakdragoon.github.io/thulla | 2–8 |
| **Lettuce Party** | [/lettuce-party/](https://play.orcavalley.com/lettuce-party/) | pakdragoon.github.io/lettuce-party | up to 5 |

| What | Where |
| --- | --- |
| Code (everything) | **[PakDragoon/office-games](https://github.com/PakDragoon/office-games)**, branch `main` (the 8 game repos were imported with full history under `web/<game>/`) |
| Hosting | Cloudflare Worker **`play`**, workers.dev subdomain **`officegames`** |
| Database | Cloudflare D1 **`office-games`** |
| Sign-in | Firebase project `wordle-party-81870` (Auth only; the id keeps Wordle Party's old name and can't change) |
| Deploys | GitHub Actions on every push to `main`: tests, then D1 migrations, then `wrangler deploy` (secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) |
| Old repos | `PakDragoon/{rotten,the-liar,thulla,melonburst,guesstimate,flipchip,fast-fingers,lettuce-party}`: **don't develop in them any more**; they only get the redirect page later (§3) |

What each game runs where:

| Game | On the server | In the browser |
| --- | --- | --- |
| Rotten | rooms, Quick Play, **global daily** | practice |
| The Liar | rooms, Quick Play | – |
| Thulla | rooms, Quick Play | – |
| Guesstimate | rooms, Quick Play, **global daily** | practice |
| Melon Burst | rooms, Quick Play, **global daily** | practice |
| Flipchip | rooms, Quick Play | games vs the computer |
| Fast Fingers | rooms, Quick Play, **global daily** (Nov 18) | practice |
| Lettuce Party | rooms, Quick Play, **4 global dailies** (Nov 18) | – |
| Ludo | rooms, Quick Play, bots | – |

Shared across all games: Bricolage Grotesque font, the same colour tokens, light and dark themes following the device, the same home layout (logo, name field, **Play now** card with **Quick Play** and **Host a private room**, Join card, an **All games** link back to the games page), 4-letter room codes and invite links, optional Google sign-in, crew scores.

---

## 2. How every change is made from now on

These rules apply to **every** change in any game. Follow them so nothing drifts back to the old host-in-the-browser way.

1. **Work only in the monorepo** `PakDragoon/office-games`. Never commit features to the 8 old game repos (they only get the redirect page, §3).
2. **The server owns every room.** Anything that decides the game (picking words, dealing, checking moves, timers, scoring, who sees what) goes in **`server/src/games/<game>.ts`**. The browser never decides anything in a room; it draws the view and sends what the player did.
3. **Rules live in `web/<game>/js/engine.js`** (pure: no DOM, no network). The server imports it, and the browser's solo modes use the same file. Change a rule there once and both follow.
4. **Room messages:** the browser sends with `toHost({ t: '...' })` / `link.send(...)` (from `web/shared/net.js`); the server answers with a `state` view (or one view per player when the game hides things per player). Host-only actions go in the game module's `hostMessage`; the server checks `isHost` itself, so never trust the browser for it.
5. **Secrets never leave the server** unless the player is allowed to see them. Check the `view()` of the game module whenever you add a field.
6. **Timers:** use `ctx.setTimer(name, at)` / `clearTimer`, never `setTimeout` on the server (rooms sleep between messages; Alarms wake them). Changes worth surviving a restart call `ctx.dirty()` (the base class does it on every broadcast).
7. **Stats and crews go to D1 through the server only** (`saveGame` / `reportPlayer` in `server/src/core/seats.ts`, keys are free-form counters). **Never add Firestore or any other browser-side saving.** New stat names need no migration (one row per counter).
8. **Changing a message format** that old open tabs would misread: bump `PROTOCOL` in `server/src/core/game.ts` **and** `web/shared/net.js` together; old tabs then reload themselves.
9. **Message budget** (free plan: 100k requests a day, incoming WebSocket messages count 1 per 20): don't send something every keystroke or every frame; batch (ink every 150 ms, Fast Fingers progress every 500 ms, Rotten typing every 150 ms). Keep-alive is `'ping'`, answered by the runtime for free.
10. **Free plan limits to respect:** 10 ms CPU per request (no building big Sets or loops over big lists per message: word lists are searched in place with `SortedWords`), Worker bundle 3 MB compressed (currently ~2.43 MB since Nov 17: Hot & Cold's word data is ~0.75 MB of it, the other word lists most of the rest; about 0.57 MB is left, so check `npx wrangler deploy --dry-run --outdir /tmp/x` before adding big data).
11. **Solo modes** (practice, Flipchip vs computer) may keep running in the browser, but never reach a leaderboard. Practice may add to the player's *own* stats through `POST /api/<game>/practice` (plausibility-checked). Anything on a leaderboard runs on the server (see `server/src/daily/`).
12. **Test before pushing:** `npm test` (every engine test + server tests), `npm run typecheck`, `npx tsc --noEmit -p server/test`, and a real multi-tab browser round on `npm run dev` for anything a player can see (§16). Then push to `main`; CI deploys.
13. Look, wording and docs follow the existing games (plain English, the family look). Commit messages: plain conventional, no AI co-author lines.

**Adding a feature to a room game:** engine.js (rules) → `server/src/games/<game>.ts` (state, messages, view) → `web/<game>/js/app.js` (UI and `toHost` calls) → server test in `server/test/` → engine test → browser round → push.

**Adding a new game:** copy the shape of a recent one: `web/<game>/` (index.html, style.css, js/engine.js, js/app.js using `createRoomLink`, js/cloud.js re-exporting `web/shared/cloud.js`), a module in `server/src/games/<game>.ts` extending `SeatRoom`, register it in `server/src/games/index.ts`, add a card to `web/index.html`. Word lists go in `web/<game>/words/*.txt`, sorted with `LC_ALL=C sort`, imported as text.

---

## 3. Open to-dos

| | What | Who |
| --- | --- | --- |
| ☑ | **Rooms failed in Chrome on some Pakistani ISPs → fixed Nov 13 by moving to `play.orcavalley.com`.** Hassan's ISP (Zong) resets TLS connections naming `cloudflare-ech.com`, which Chrome sends for Cloudflare sites with Encrypted Client Hello. Pages loaded over HTTP/3 (UDP) but WebSockets (TCP only) never reached the Worker: "Couldn't reach the game server". `workers.dev` always has ECH on. orcavalley.com's DNS moved from Namecheap to Cloudflare (all 10 records copied, every one DNS only/grey: Vercel `@`, AWS `agents`/`api`/`app`, Zoho MX/SPF/DKIM); ECH turned OFF on the zone through the API (works on the Free plan: setting `ech`, needs a token with Zone Settings Edit); `play.orcavalley.com` attached as a Workers custom domain through the API (not in `wrangler.jsonc`, so CI's token needs no zone permission; survives deploys, checked). Proven: Chrome on that line joins a room on the new address, TCP-only and normal; the workers.dev address fails. Check on any network: `openssl s_client -connect <cf ip>:443 -servername cloudflare-ech.com` resets where ECH is blocked; `dig HTTPS play.orcavalley.com` must show no `ech=`. **Never turn ECH back on and never put a game hostname behind a zone with ECH on.** | – |
| ☑ | **Feedback round, Nov 13 (from Hassan playing on play.orcavalley.com): all shipped in `ef48715`.** Flipchip's idle timer and strikes apply only to rooms WITHOUT a move timer (timed rooms auto-move randomly on timeout as before, never remove anyone); untimed: 90 s → Easy auto-move, 3rd in a row = forfeit (rated like a resign, seat freed, stays as spectator), tests in `server/test/flipchip-idle.test.ts`. Melon Burst/Rotten's "flash" was a bug (countdown re-rendered every tick, restarting the animation): `paintCountdown` + `count-fade`. Lettuce ladder `ladderReuse` default true. Flaky under load: `bots.test.ts` CPU test (passes alone). | – |
| ☑ | ↳ **Fast Fingers:** the 3-2-1 countdown is too small, so people start typing before it's done. Show it as a big overlay over the paragraph (3, 2, 1, Go) so it's impossible to miss. | Claude |
| ☑ | ↳ **Melon Burst:** the 3-2-1 countdown is too flashy. Make it simple: 3 fades in and out, then 2, then 1. | Claude |
| ☑ | ↳ **Rotten:** same as Melon Burst, tone the countdown flash down to a plain fade. | Claude |
| ☑ | ↳ **Flipchip:** no turn timer, so a player who stops moving leaves the other waiting forever. Add an inactivity timer: after ~1–2 min without a move the server plays a move for them (reuse the bot move logic); after 2–3 auto-moves in a row, the idle player is removed and the other wins. Server-side (`ctx.setTimer`), shown as a countdown to both players. | Claude |
| ☑ | ↳ **The Liar:** the caught liar's time to guess the word is too long; make it 10 s. | Claude |
| ☑ | ↳ **Lettuce Party:** (1) no ✕ / leave button in the room like the other games have; add one. (2) Word ladder: a word already used can't be used again ("Already used"), so a player who wants to go back and try another branch from an earlier word is stuck. Today there's NO setting for this (the rule is fixed in `E.ladderStepProblem`). Add a host setting "Allow reusing words", **default ON**: when on, any earlier word in your ladder (including the start) can be typed again to continue from it. Decide how the step count and par compare then (likely count every step typed). | Claude |
| ☑ | **Feedback round, Nov 14:** (1) **Guesstimate** "See final standings" did nothing: `standings()` was deleted in the move to the server while `renderOver` still called it, so every room game threw at the end (`203478a`). A `no-undef` ESLint pass over every `web/*/js/*.js` and `web/shared/*.js` found no other leftover; run one after any big move (§16). (2) **Invite links, every game:** with `?room=` the Join card moves first, gets an outline and "You're invited to room ABCD…", Join room becomes the main (primary) button and Quick Play turns plain; Enter in the name box joins (Thulla already did). Shared `web/shared/invite.js` `markInvite(code)`, which relies on the common ids `#name-input #code-input #quick-btn #join-btn` and `.choice` cards; a new game calls it in its `?room=` branch. Checked on all 10 games at 1280 light and 375 dark (`ca56793`). (3) **A to Zap** vote is up to 60 s (`VOTE_MS`), still ending as soon as everyone who may vote has voted (`ae9d3f5`). | – |
| ☐ | **Next session, start here (Nov 19):** **new game Ludo** (§21) is **pushed and live** at `5a444ab` (CI green Nov 19; commits `6b18f2a` game, `9f559f8`/`118f652`/`3538f6b` look, `5a444ab` roll-all-6s-first + lane-coloured safe squares); checked live: hosted a room with a bot on play.orcavalley.com, rolled and moved, no page errors. Engine 17 tests, server 10 (`server/test/ludo.test.ts`), full suite 371 green, both type checks clean, games page checked at 1280/375 (Ludo card first, BETA). Browser rounds done: 2 people + 2 bots (laptop light + phone dark, touch two-tap), host vs bot to the result screen. Still open for Ludo: a real-people round (then drop BETA), and a timed full 4-player game on the live site. Older items below still stand. |
| ☐ | ~~Next session, start here (Nov 18, later):~~ (superseded by Nov 19 row) **dailies for Fast Fingers and all 4 Lettuce Party modes** are pushed and live (last commit `19b99a6`): Fast Fingers `e572e73` (§15), Lettuce Classic + Counts `75c247d` (also: one game can hold several dailies, `?mode=`), Word ladder `5a2905a`, Hot & Cold `19b99a6` (§14 "Dailies"); day 1 of both = 2026-11-18. Still open: everything in the rows below. Earlier Nov 18: everything below is pushed and live at `a97d708` (CI green; the cut-drawing change came after `8a9130b`). Nov 18 batch: Lettuce Party mode picker three to a row from the left with a **BETA** chip on Hot & Cold (`0650f92`, §14); Guesstimate **Cut** has 13 shape families and a slide/turn knife, **Balance** shows one thing per pan and four vague names were made specific (`8a9130b`, §12); `PROTOCOL` is now **4**; the daily-streak test in `server/test/stats.test.ts` sent Cut's `answer` (0.5) instead of a line and broke CI from day 9 on, fixed in `97a5a7c` (any test that answers a daily must send a line for Cut). Deployed mid-day Nov 18, so that day's daily Cut was a blob for early players and a new shape after. Still open from Nov 17: the items in the row below (real-network round, Alzheimer's real-people test, Firebase authorized domain, Lettuce card text, Hot & Cold obscure hints). | Claude |
| ☐ | ~~Next session, start here (Nov 17 end):~~ (superseded by Nov 18 row) all of the Nov 17 work below is pushed and live, Alzheimer’s included (latest: typed-answer test `e288715`, 2–8 players `f3dfcf2`, flash-hide fix `602a7ea`) (last commit `97ad076` test fix on top of `d96d48b`; BETA badge on its games-page card and next to its logo). Still open: real-network round with colleagues (now including Hot & Cold, Cut, Balance, Liar turn-by-turn, Alzheimer's), real-people test of Alzheimer's (then drop BETA), confirm `play.orcavalley.com` is in Firebase Auth → Authorized domains, Lettuce games-page card still says "five-letter word" (Hot & Cold isn't), Hot & Cold hints beyond the top 100 can be obscure words (no word frequency at runtime). Flaky under CI/full-suite load only (pass alone): `bots.test.ts` CPU test, `flipchip-idle.test.ts` lobby test, `a-to-zap.test.ts` CPU test, `replays.test.ts` "does not show a replay link before the result" (The Liar; failed CI once Nov 17, passed on rerun). The `forehead.test.ts` seat-order race was fixed Nov 17 (`f3b240e`). Re-run a failed CI job with `gh run rerun <id> --failed` (no new push needed). Pushes to `main` need Hassan's explicit OK each time. |
| ☑ | **Nov 17 batch** (all in the sections below): The Liar Time game **turn by turn** option (`c5e680d`, §11); BETA dropped from Forehead + A to Zap (`ea67a1f`); Forehead seat-order test race fixed (`f3b240e`); Guesstimate **Cut** test (`0a944e0`) and **Balance** test (`e5ba14b`), both in the daily from day 9 (§12); Lettuce Party **Hot & Cold** mode (`c26124a`, §14; `PROTOCOL` was then 3, now 4 since Nov 18); new game **Alzheimer’s** (`d96d48b` + a test fix: the secrecy test now only checks messages from the drawing phase, since a random fill can repeat a player's own word; §20, BETA, live). | – |
| ☑ | ~~Next session, start here (Nov 14 end):~~ (superseded) | everything is pushed and live at `ca56793`; old sites redirect. Still open: real-network round with colleagues, real-people test of Forehead + A to Zap (then drop BETA), confirm `play.orcavalley.com` is in Firebase Auth → Authorized domains, A to Zap voting in 1v1 (kept as is), Lettuce "how close?" mode and human-like bots (ideas below). Flaky under CI/full-suite load only (pass alone): `bots.test.ts` CPU test, `flipchip-idle.test.ts` lobby test, and `forehead.test.ts` "goes round in seat order" (line ~350: an early answer from a second socket can land after the ask, `answered` 1 not 0; failed CI once Nov 14, passed on rerun; fix by awaiting the ask before sending the stray answer). Pushes to `main` need Hassan's explicit OK each time. | – |
| ☐ | **Real-network round** of every game on the new site with 2–3 colleagues, at least one on mobile data. | You |
| ☑ | **Old GitHub Pages sites redirect to play.orcavalley.com (live Nov 14).** New site side (`ca56793`): `web/shared/carry.js`, imported first by the 8 older games, reads `#carry=<base64url JSON>`, writes only keys this browser doesn't have yet (prefixes `fastfingers.` `flipchip.` `guesstimate.` `melonburst.` `rotten.` `theliar.` `thulla-` `wordleparty-`), drops the old local daily progress (`*.daily*`; dailies run on the server now) and `wordleparty-signedin`, then clears the fragment. Old side: one `index.html` + `404.html` per old repo (built from a template, packs only that game's keys, keeps `?room=`, `location.replace` to `https://play.orcavalley.com/<game>/`, noscript fallback), and the `office-games` `pages` branch redirects to `/`. Checked end to end locally (unicode name, newer key kept, daily dropped, other games' keys not packed). Pushed in the right order (monorepo deployed first, then the old repos) and checked live: pakdragoon.github.io/rotten/?room=WXYZ lands on play.orcavalley.com/rotten/?room=WXYZ with the saved name filled in. Any future change to the redirect pages: same order. Old PeerJS room links then show "room not found" (fine, rooms are short-lived). Shipped before the real-network round, by Hassan's choice. | – |
| ☐ | **Archive the 8 old repos** a few months after the redirects (redirects live since Nov 14) (archive, don't delete; code and history are already in the monorepo). | You |
| ☐ | **Lock Firestore** once no old version writes to it: rules that deny everything; keep Firebase Auth. Optionally rename the Firebase project's display name. | You + Claude |
| ☑ | **Visitor counts: Cloudflare Web Analytics** (Nov 13), turned on by Hassan in the dashboard (Analytics & Logs → Web Analytics → play.orcavalley.com, automatic setup). Cloudflare injects its beacon into every HTML page served on the custom domain (checked on `/`, `/lettuce-party/`, `/fast-fingers/`); nothing in the repo. Cookieless, so no consent banner needed for it. It counts only play.orcavalley.com, not the workers.dev address. Shows visitors, page views per game path, countries, devices, referrers. | – |
| ☐ | **Firebase / Google Analytics events** (later, with the consent banner before AdSense): the code already sends `room_created`, `game_started`, `round_finished`, `share_result`, `login`… through `track()` in `web/shared/cloud.js`, but it's OFF because `measurementId` is empty. To turn on: enable Google Analytics in the Firebase project, put the `G-…` id in `firebaseConfig.measurementId`, and gate it behind consent. Players who finish a game are also countable from D1 (`players`: `g:` guests / `u:` signed in, `created_at`; `matches` per game). | You, then Claude |
| ☐ | **Analytics Engine** (optional, server-side events): enable it in the Cloudflare dashboard (Workers → Analytics Engine), then un-comment the binding in `wrangler.jsonc`. | You, then Claude |
| ☐ | **Domain follow-ups** (phase 13): the games are on **play.orcavalley.com** (done Nov 13, see the ECH row above and §17); a separate brand domain (≈ $10/yr, Cloudflare Registrar) is optional, only if the games get their own name. Still to do: Turnstile on room create and Quick Play, a WAF rate-limit rule, content pages (How to play per game, About, Privacy, Terms, Contact), consent banner, ad slots (lobby, between games, content pages, never during play), a redirect workers.dev → play.orcavalley.com, a custom Firebase sign-in domain, then apply for AdSense. | You, then Claude |
| ☐ | **Firebase Auth record on Delete my data:** Delete my data removes every D1 row and the browser's data, but not the Google account's record in Firebase Authentication (uid, email, name, photo). Delete it in the Firebase console on request, or add a client-side `deleteUser` (needs a recent sign-in). The privacy policy should say crew scoreboards keep the names typed in them. | You / Claude |
| ☐ | **R2 for replays** (optional): enable R2 in the Cloudflare dashboard (needs a payment method; the free tier stays free). Then Claude writes an R2 `ReplayStore` in `server/src/db/replays.ts` and changes one line. Until then replays live in D1. | You, then Claude |
| ☑ | **Flipchip Quick Play counts only the two seats** (Nov 14, `c7bdd13`): rooms report their fullness through `listingSeats()` in `server/src/core/seats.ts`; Flipchip counts connected people in the Dark/Light seats out of 2, so watchers never fill it and a bot's seat counts as free (a joiner takes it). A room whose host is standing with both seats empty reports 0 and isn't offered (Lobby needs players > 0). Tests: `server/test/flipchip-quick.test.ts`. | – |
| ☐ | **Rating start swing:** a new player moves about ±160 on their first rated game (normal Glicko-2 at RD 350). Lower the starting RD if colleagues find it jumpy. | Decide |
| ☐ | **Friends follow-ups:** an "appear offline" switch, a custom display name (today the Google name), a Friends chip on the games page `/` (it has no JavaScript), and a real-network check of invites. | Claude |
| ☐ | **Bot follow-ups:** Rotten bots send no typing preview; humans' stats and crew totals still count games with a bot (decide if they shouldn't); a cold-start CPU check of the Flipchip bot on the live site (10×10 search narrowed to 2 root moves to be safe). | Decide / Claude |
| ☐ | **Turn-based games over days** (Flipchip one move a day) with "your turn" push. | Claude |
| ☐ | **Lettuce Party visual refresh** (optional): bring it to the newer hairline / greyish-black look. | Claude |
| ☐ | **Retire the New tags** on the games page when they're no longer new: delete `<span class="new">NEW</span>` in `web/index.html`. | Either |
| ☐ | **New game idea A (Nov 13): Forehead** (name chosen by Hassan; check app stores/trademarks before launch). Everyone has a secret card everyone else can see but them (a famous person, an animal, an object, a food, a job, or a number); players ask yes/no questions about their own card and the others answer, until they guess it. Best as a **new game** (not a mode): it needs per-player hidden views like The Liar's. Sketch: server deals each player a card from a host-picked category deck (word lists in `web/<game>/words/`, with aliases); each view shows every card except your own. Turns: the asker types a question (or asks out loud on a call), everyone else taps Yes / No / Sort of / Don't know, the majority is shown; then the asker may guess or pass. Guess check: aliases + light spelling tolerance on the server, or the others confirm it (avoids spelling fights; The Liar picks from 12 options for the same reason). Score: guessed in fewer questions = more points; round ends when all have guessed or the timer runs out. Number deck variant: secret 1–100, answers can also be "higher/lower". Open questions: typed vs spoken questions, celebrity deck (real people's names are fine as answers, but keep the list mainstream and kind), turn order vs free-for-all. | Decide, then Claude |
| ☐ | **Lettuce Party mode idea (Nov 13): "how close?"** (not to build yet). Everyone has the same secret word; you type any word and get a number for how close its MEANING is (1 = the word itself, 17 = very close, 8091 = far), then keep guessing towards it. Hassan has seen this elsewhere (the genre exists: give it its own name and look). Not limited to five letters. Execution: meaning-closeness needs word embeddings, and ranking a guess against the whole vocabulary at runtime is too heavy for 10 ms CPU, so precompute offline: for a curated list of target words (e.g. a few hundred), rank every vocabulary word (~10–20k) by embedding similarity (Workers AI embedding model or a local model in a `tools/` script) and store each target's ranking in D1 (≈ 10–20k rows per target; D1's 5 GB is plenty); a guess is then one indexed lookup. Unknown words: "I don't know that word". Multiplayer: others see your best rank (not your words) live; results show everyone's closest words. Hints (e.g. reveal a word ranked ~300) optional. | Decide, then Claude |
| ☐ | **New game idea B (Nov 13): A to Zap** (name chosen by Hassan; was "name, place, animal, thing"; check app stores/trademarks before launch). Each round one player (rotating) picks a letter; everyone fills categories starting with it: person's name, place, animal, fruit/vegetable, thing… (host picks the categories, 4–8). New game. Sketch: timer per round, or the first to fill everything presses **Stop!** and the rest get ~10 s; server scores classic style: 10 for a unique valid answer, 5 if someone else wrote the same, 0 for blank or invalid. Validation: server lists per category (places, animals, fruits/veg, common first names incl. Pakistani names) plus a quick thumbs-up/down vote from the room for anything not on a list, so local spellings and Urdu names aren't unfairly rejected. Letters that are too hard (X, Z, Q) left out or host-toggled. Watch the Worker bundle size (3 MB) when adding lists. | Decide, then Claude |
| ☑ | **Forehead + A to Zap live (Nov 13)**: Forehead `7fe9a89`, A to Zap `0f4ec07`; both carry a **BETA** badge (yellow-orange, top-right corner of the card over the picture, `.beta` in `web/index.html`) until tested with real people; NEW tags retired on every card except Fast Fingers. Forehead redrawn (head with the note on the forehead only; small avatar heads with forehead notes in game) and turns are now **ask OR guess** (tally shows 3.5 s then the next turn starts; Guess my card is its own turn; no decide/pass step), `a6a9f8a`. Both new games sit FIRST on the games page (a scripted reorder once broke the live homepage, fixed in `b60d6ff`: after ANY edit to `web/index.html`, screenshot the whole page at 1280 and 375 and check every card has its Play button). Sticky notes enlarged on the card art, logo and players' foreheads (`1229233`). A to Zap: I'm done needs every box filled (server-checked). Voting kept as is by Hassan's choice (in 1v1 the opponent alone decides unknown answers; options discussed: 2-thumbs-down rule + 5 pts unopposed, or a Workers AI referee). A to Zap rules to confirm with players: a tied or empty vote accepts; Zap! always gives exactly 10 s; no grace for answers in the last ~450 ms; the Thing list is auto-built and noisy. | – |
| ☐ | **Idea: human-like bots learned from real play (Nov 13, "RAG").** Goal: bots in every game that decide like people (hesitate, make human mistakes, pick human-style words/moves), learned from live players' data. Note: RAG means retrieving examples for an LLM at answer time, not training; two workable routes: (1) **retrieval of real situations**: log anonymised decisions (game state summary → what the person did, time taken) to D1, and at bot time look up the most similar logged situations and copy what people did (cheap, no ML training, fits the 10 ms CPU budget if the lookup is a keyed query); (2) **learned policy**: train small per-game models offline on the logs (imitation learning), ship weights or run on Workers AI. Word games (Rotten, A to Zap, Lettuce) can sample real people's answers per prompt/letter; Flipchip/Thulla moves can be matched by board/hand features. Prerequisites: a privacy-policy line and opt-out (Delete my data must also delete logs), never log names/chat, cap storage (D1 5 GB), and enough players first (today ~6). Start with logging only, decide the model later. | Decide |
| ☐ | **Ideas discussed, not built:** "Banana for Scale" and "Ripeness" as new Guesstimate tests; a banana category in The Liar; "Bunch" (greed/bluff game); Flipchip daily puzzle or same-screen mode; AI liar with Workers AI; voice chat (Cloudflare Realtime). CrazyGames publishing as another earner. | – |
| ☐ | **Move to AWS later** (when traffic and AdSense pay for it): ECS Fargate room servers + Redis + DynamoDB/RDS; the game modules talk only to `RoomCtx`, so the AWS side is a new adapter (estimated 1–2 weeks). Until then use Cloudflare features fully (decision D2). | Later |
| ☑ | **Lettuce Party modes** (Nov 13, `87077ab`): Counts mode, Word ladder, host setting for the number of guesses (§14). `PROTOCOL` is now 2. Known: with 5 players on a 667 px-tall phone the page scrolls 2–9 px (it scrolled ~11 px before). | – |
| ☑ | **Nov 13 batch:** guest → Google merge, Delete my data, Melon Burst daily on the server, restored stats (streaks, favourite opener, practice), Glicko-2 ratings + rating-aware Quick Play (Flipchip, Thulla), shareable replays (The Liar, Flipchip; in D1), Open to Quick Play toggle in every lobby, Fast Fingers documented (§15). | – |
| ☑ | **Nov 13, second wave:** bots (Flipchip, Rotten, Thulla) and friends (codes, requests, block, online status via a per-player Hub, invites across games, recent players). | – |
| ☑ | **Firebase:** `play.officegames.workers.dev` added to Auth → Authorized domains (Nov 13). | – |
| ☑ | **Cloudflare backend, all 8 games, Quick Play, global dailies (Rotten, Guesstimate), D1 stats, CI deploys** (Nov 12–13). | – |
| ☑ | ~~Publish / sync the 7-game Firestore rules~~: obsolete for the new site. Only the legacy GitHub Pages versions still use Firestore (melonburst's 7-game file is the right one if ever needed again). | – |

---

## 4. Working on the repo (for a new session)

**GitHub workflow.** Clone `PakDragoon/office-games` over HTTPS and verify the clone's Git author and GitHub permissions before committing. Push an isolated branch for review. GitHub Actions runs checks on pull requests and deploys approved changes after they reach `main`.

**Node:** the machine default is Node 20, but wrangler needs **Node 22.12+**. Prefix commands with
`export PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH`. npm 10 hits an `edgesOut` bug on this repo: install with **`npx -y npm@11 install`** (npm 11 also wants `npx npm@11 install-scripts approve workerd esbuild` then `npx npm@11 rebuild`). `@cloudflare/vitest-plugin` is pinned to the version matching the installed wrangler.

**Cloudflare login.** For authorized manual Cloudflare work, check the active account with `npx wrangler whoami`. CI uses repository secrets for production.

| Task | Command |
| --- | --- |
| Install | `npx -y npm@11 install` |
| Local database | `npx wrangler d1 migrations apply office-games --local` |
| Run locally | `npm run dev` → http://127.0.0.1:8787 (rooms, API and pages, with a local D1) |
| All tests | `npm test` (every `web/*/test/*.test.mjs` + vitest server tests in the Workers runtime) |
| Type checks | `npm run typecheck` and `npx tsc --noEmit -p server/test` |
| Deploy by hand | `npx wrangler deploy` (normally CI does it on push to `main`) |
| Remote database | `npx wrangler d1 migrations apply office-games --remote` (CI runs it before each deploy) |
| New table / column | add `migrations/000N_name.sql` (CI applies it) |
| Logs | Cloudflare dashboard → Workers → `play` → Logs (observability is on) |
| CI status | `gh run list -R PakDragoon/office-games -L 3` |

Worker secret: `SERVER_SECRET` (signs guest ids and daily seeds; set with `wrangler secret put SERVER_SECRET`; changing it invalidates every guest's id and today's daily sessions). Var: `FIREBASE_PROJECT`.

**Repo layout:**

| Path | What it is |
| --- | --- |
| `web/` | Served as-is (no build step): `index.html` (games page), `web/<game>/` (each game), `web/shared/net.js` (WebSocket room client: hello + protocol, tab id, ping, rejoin, Quick Play), `web/shared/cloud.js` (Google sign-in, guest token, `api()` helper, analytics). `web/.assetsignore` keeps READMEs, tests and tools private |
| `web/shared/` (more) | `public.js` (Open to Quick Play box), `rating.js` (rating chips), plus in `cloud.js`: the guest → Google merge after sign-in and `mountDeleteData` (the shared Delete my data control) |
| `web/shared/invite.js`, `carry.js` | Invite-link look on the home screen (`markInvite`); the one-time import of settings carried from the old GitHub Pages addresses (imported first by the 8 older games) |
| `web/shared/bots.js`, `friends.js`, `friends.css` | Bot lobby controls (Flipchip, Rotten, Thulla); the Friends panel, the chips next to All games and in lobbies, and invite toasts (every game gets them through `shared/net.js`; a game needs no code of its own) |
| `server/src/index.ts` | Worker entry: `/<game>/ws` → room, `/api/*` → API, else static files; nightly cron |
| `server/src/do/GameRoom.ts` | One Durable Object per room |
| `server/src/do/Lobby.ts` | One per game: public rooms + Quick Play |
| `server/src/core/` | `game.ts` (contract, `PROTOCOL`), `seats.ts` (shared seat logic: rejoin, host hand-over, Away, crews, saving), `util.ts` (codes, names, rude-name filter, rate limiter), `words.ts` (`SortedWords`) |
| `server/src/games/` | One module per game (`rotten.ts`, `liar.ts`, `thulla.ts`, `guesstimate.ts`, `melonburst.ts`, `flipchip.ts`, `fastfingers.ts`, `lettuce.ts`, `forehead.ts`, `atozap.ts`, `alzheimers.ts`, `ludo.ts`), registered in `index.ts` |
| `server/src/daily/` | Server-run global dailies (`rotten.ts`, `guesstimate.ts`, `melonburst.ts`, `fastfingers.ts`, `lettuce.ts` = one module for the 4 Lettuce modes). `index.ts`: `DAILIES` keyed by game or `<game>:<mode>` (asked with `?mode=`); a daily with `stats: { game, key }` writes `<key>Plays` / `<key>Best` under that game instead of `dailies` / `bestDaily` (`dailyStats()`; `BEST_STATS` must list the best, a test checks) |
| `server/src/data/` | Server-only data files (never served to browsers): Hot & Cold's `hotcold-words.txt`, `hotcold.bin`, `hotcold-targets.bin` (built) and `hotcold-targets.txt` (hand-picked secret words, the input). `.bin` files import as `ArrayBuffer` (wrangler's default Data rule; typed in `server/src/types.d.ts`) |
| `server/src/practice.ts` | `POST /api/<game>/practice`: solo practice runs added to the player's own stats (Rotten, Fast Fingers), plausibility-checked, never a leaderboard |
| `server/src/db/stats.ts`, `migrations/` | D1 access and schema. `stats.ts` also holds `BEST_STATS`, `PLAYER_TABLES`, `mergePlayer`, `deletePlayer` (§6). `ratings.ts` (Glicko-2 writes), `replays.ts` (replay store) |
| `server/src/core/glicko2.ts` | Pure Glicko-2 (tested against Glickman's example) |
| `server/src/core/bots.ts` | Shared bot seat logic (names, levels, the `bot` room timer with planned time and key in the snapshot) |
| `server/src/do/Hub.ts` | One per signed-in player: their open tabs hold a hibernating WebSocket to it; writes online status (`presence`) and delivers invites and "your friends list changed" pushes. `wrangler.jsonc` declares it (`HUB`, migration `v2`) and `server/src/index.ts` must `export { Hub }` (without it every hub call is a 500) |
| `server/src/friends-api.ts`, `server/src/db/friends.ts` | `/api/friends/*` (codes, requests, block, recent players, hub ticket and socket) and the D1 logic behind it |
| `server/src/auth.ts` | Firebase ID token check (jose + Google keys), guest tokens (HMAC) |
| `server/test/` | vitest tests (rooms, The Liar, words, dailies) |
| `.github/workflows/deploy.yml` | CI: test → migrate → deploy |

---

## 5. How every game works now

1. **Host a private room** or **Quick Play**: the browser opens `wss://…/<game>/ws?create=1` (Quick Play first asks `/api/<game>/quick` for a public room waiting for players). The Worker picks a free 4-letter code and hands the connection to that room's Durable Object. Joining uses `?code=XXXX`.
2. The first message is a hello: `{ t: 'join', v: PROTOCOL, name, client: <tab id>, token?: <Firebase ID token>, guest?: <guest token> }`. The server checks the token (or the guest id), sends a new signed guest id if needed, and seats the player. The first player is the host.
3. The room holds the real game state, checks everything players send, runs the timers and sends a view: one public view, or one per player where the game hides things (Melon Burst, Thulla's hands, The Liar's cards, Lettuce Party's letters). Secret data never goes to players who shouldn't see it, host included.
4. Finished games are written to D1 by the server: each player's stats, the crew's totals when the room has a crew, and a match log row.

**Open to Quick Play (all eight games):** every room starts private (hosted with the code) or public (opened by Quick Play). In the lobby the host sees an **Open to Quick Play** box with one line under it; everyone else sees a read-only "Open to Quick Play" or "Private room" line. The browser sends `{ t: 'public', on }` (helper `web/shared/public.js`: `wirePublic`, `paintPublic`, `publicLine`) and every game's view carries `public`. The server accepts it only from the host, only in the lobby, only as a real true/false; it's frozen during a game. `room.public` is the single source of truth for the Lobby (public list, Quick Play) and the view. A new game needs `public` in its view, the box in its lobby and `wirePublic(...)`. Tests: `server/test/public-toggle.test.ts`.

**Skill ratings (Flipchip, Thulla):** Glicko-2 (`server/src/core/glicko2.ts`), written in `server/src/db/ratings.ts` through `ctx.rate()` after a game (Flipchip) or round (Thulla). Start 1500, RD 350, one rating period = a week; a "?" after the number while RD > 110 (provisional). Only server-side, only for players with an id, never for spectators, host-ended games or games with a bot seat (`bot: true`). Flipchip counts finished games plus resigns and claimed wins once each side has made 2 moves. Thulla: pairwise from the finishing order, each player's round weighted to count as one game in total. Rating shows next to names, in the stats panel, and as "+12" at the end. To rate another game: add it to `RATED_GAMES` and call `ctx.rate()`.

**Quick Play matching:** for Flipchip and Thulla the browser asks with its identity (`cloud.api()`), and `Lobby.pickRoom` prefers a waiting public room whose seated players' average rating is within 100 + ½ × the caller's RD + 8 per second the room has waited; otherwise the nearest room, so nobody is sent away. Other games unchanged.

**Replays:** finished Draw/Words games of The Liar and every finished Flipchip room game keep a replay (saved by the server via `ctx.saveReplay`, in the background); the result screen shows **Share replay**, which copies `/<game>/?replay=<id>`, a read-only viewer that works for anyone.

**Signing in with Google** merges the browser's guest stats into the account once (`POST /api/me/merge`; the guest token is then dropped; a failed merge retries on the next load). **Delete my data** is in every game's Settings sheet (two taps, disarms after 7 s): deletes the server rows, clears this browser's guest token and all games' saved names, crews and local stats/progress (settings kept), and signs out. A game still running in a room when you sign in or delete saves its final stats under the old guest id (the button text says to leave rooms first).

**Bots (Flipchip, Rotten, Thulla):** in the lobby the host can **Add a bot** ("🤖 Sara"), set each to Easy or Normal, and remove it. A bot is a seat the server plays for: no connection, no uid or guest id, never host, never counts as a person for Quick Play or for keeping the room alive (a room with only bots is offered nowhere and deleted after the usual 10 minutes), and never written to D1 (`recordGame` drops players flagged `bot`: no stats, crew rows, match log, recent players). Games with a bot are never rated; humans still get their own stats. Bots act on the room timer `bot` (planned time and key in the snapshot, so a restart or refresh doesn't lose or double a move) and go through the same `move()`/`play()`/`word()` as a person. In a full lobby a joining person takes the latest bot's seat. **Rule for any future work: nothing keyed by a player id may ever get a bot, and every new per-player write must skip `bot` seats.**

**Friends:** Google accounts only (a guest id lives in one browser); guests get recent players and a sign-in explainer. Mutual (request, accept; crossing requests auto-accept); remove, block (silent: the blocked person can't tell). Add by 8-character code (`K7QX-92MD`), link `/<game>/?friend=CODE`, or from recent players (the browser only sees a random `ref`, never an id). Each signed-in tab keeps a WebSocket to its player's Hub (60 s ticket from `POST /api/friends/ticket`, then `/api/friends/ws?t=`), tells it which room it's in (from `net.js`) and sends a `beat` about every 100 s; the Hub writes one `presence` row, and someone is online while `seen` is under ~250 s old. The friends list is one D1 query (never wakes other hubs). Invites go through the Hub, which checks the sender is really seated in that room (`GameRoom.seated`), that both are friends and that the friend is online; nothing is stored. Recent players are written in `recordGame`, 30 per player. Limits: 100 friends, 50 in / 20 out requests, 30 requests a day, invites 1 per 3 s per hub, 8 tabs per hub.

**Reliability (all games):**

- **Seat takeover by tab id:** a private id per tab in `sessionStorage` (survives a refresh). A seat is taken back by the same tab, the same Google account, or once the seat is offline. A colleague with the same name gets "Sara 2".
- **Keep-alive:** the browser sends `'ping'` every 3 s and the runtime answers `'pong'` without waking the room. A player silent for 9 s is **Away** (checked every 3 s while a game is on) and the game stops waiting for them.
- **Auto-reconnect:** a browser that hears nothing for 12 s (tab visible) or loses its socket reconnects with backoff and the same tab id, and gets its seat back. If the room is gone it says so.
- **The host can leave:** the host role passes to the longest-seated player; the room keeps going. A room is deleted 10 minutes after everyone has left (3 minutes if nobody ever joined).
- **Restarts:** the room saves a snapshot after every change and reloads it when it wakes; deploys disconnect sockets, browsers reconnect and keep their seats.
- **Protection:** per-connection rate limit and message size cap (dropped after repeated abuse), names cleaned (HTML stripped, 16 characters, rude names in English and romanised Urdu become "Player"), host-only messages ignored from anyone else, everything validated against the rules.
- **`?debug`:** exposes state for browser tests: `window.__rotten`, `__theliar`, `__guesstimate`, `__melonburst`, `__flipchip`, `__fastfingers` (each with `S` and `link`, plus game extras), `window.thullaDebug`. In rooms the real state is on the server; the client's `S.view` is the view it received.

**Free plan:** 100k requests/day (WebSocket messages 1 per 20), 10 ms CPU per request, D1 5 GB. If traffic outgrows it, Workers Paid ($5/month) changes nothing in the code.

---

## 6. Data: D1, Firebase and the legacy Firestore

**D1 `office-games`** (schema in `migrations/0001_init.sql`):

| Table | Holds |
| --- | --- |
| `players` | `u:<firebase uid>` or `g:<guest id>`, name, timestamps |
| `player_stats` | one row per (player, game, stat): counters added per game (`games`, `wins`, `plays`, `points`, `words`, `splats`, `rounds`, per-test points in Guesstimate, guess distribution in Lettuce Party…) and best-ofs kept with MAX/MIN (`longest`, `bestDaily`, `bestWpm`…) |
| `crews`, `crew_stats` | crew id `<game>:<crew key>`, games played, per-player totals by name |
| `matches` | every finished game (game, room, crew, winner, players JSON) |
| `daily_results`, `daily_sessions` | global dailies: one result per player per day per game (leaderboard) and the in-progress state the server times; sessions older than 3 days are deleted by the nightly cron |
| `ratings` | one row per player per game (Flipchip, Thulla): `rating`, `rd`, `volatility`, `games`, `updated_at` (migration `0002`) |
| `replays`, `replay_players` | shareable replays (migration `0003`): 12-character random id (the link), game, created_at, size, gzip JSON (capped 128 KB raw / 64 KB stored); `replay_players` links the players (`u:`/`g:`). Nightly cron deletes replays older than 90 days |
| `friend_profiles`, `friends`, `presence`, `recent_players` | friends (migration `0004`): code and display name; one row per direction (`friend`, `in`, `out`, `blocked`); online status and room; 30 recent players per player with a random `ref`. All in `PLAYER_TABLES`; merge moves a guest's recent players; Delete my data also disconnects the player's Hub |

API: `GET /api/me/stats?game=<id>` (Bearer Firebase token or `X-Guest` header; also returns `rating` for rated games), `GET /api/<game>/crew?name=`, `GET /api/<game>/rooms`, `POST /api/<game>/quick`, `POST /api/guest`, `POST /api/<game>/daily/{state,next,answer,skip}` (Melon Burst: `{state,next,guess}`), `GET /api/<game>/daily/board`, `GET /api/<game>/replay/<id>` (404 if unknown or expired; cached 5 min), `POST /api/<game>/practice` (Rotten `{streak, ms}`, Fast Fingers `{chars, ms}`; 512-byte body, one per player every 3 s per Worker instance), `POST /api/me/merge` (needs a valid Firebase Bearer AND X-Guest; safe to repeat), `DELETE /api/me` (Bearer and/or X-Guest; both deleted if both sent; a bad Bearer is refused). Friends: `GET/POST /api/friends/…` (list, request, accept, decline, cancel, remove, block, unblock, ticket), `GET /api/friends/recent` (guests too), `GET /api/friends/ws?t=` (hub socket).

**Player rows.** Every table keyed by a player id is listed once in `PLAYER_TABLES` in `server/src/db/stats.ts` (player_stats, daily_results, daily_sessions, ratings, replay_players, players). A new per-player table MUST be added there and handled in `mergePlayer`, or Delete my data leaves it behind and a sign-in merge strands it on the guest. Delete also removes every replay the player appears in (a replay shows everyone's names). `crew_stats` and `matches` hold display names only and are deliberately not deleted. Merge rules: counters add; ratings keep the row with more games; replay links move.

**Best-of stats.** `BEST_STATS` in the same file is the one list of stats that aren't counters (MAX: rotten:longest, fast-fingers:bestWpm, lettuce-party:fastestNeg (stored negated), guesstimate:bestDaily, rotten:practiceBest, the best streaks, and the running streaks/lastDay; MIN: rotten:bestDaily, melonburst:bestDaily). A new best-of stat must be added there, or a merge adds two bests together; a test checks the dailies agree.

**Stat names beyond counters:** `streak` / `bestStreak` (running streak that resets to 0, with its best: reported with `streaks: { streak: won }` in `reportPlayer`), `opener:<word>` (Lettuce Party: how often each first guess was used, at most 40 words per player, reported with `tally: { opener: word }`), `practiceBest` (Rotten), `solos` (Fast Fingers practice runs). A daily can keep a day streak with `streak: true` (Guesstimate does: `streak`, `bestStreak`, `lastDay` as a UTC day number). Daily sessions are saved only if unchanged since read (optimistic check in `server/src/daily/index.ts`): parallel requests get `error: 'busy'` and write nothing, so firing every answer at once can't leak answers.

**Firebase `wordle-party-81870`:** Google sign-in only. Authorized domains: `pakdragoon.github.io`, `play.officegames.workers.dev` (added Nov 13). **Check that `play.orcavalley.com` is on the list too**, or Google sign-in fails on the live address. The browser config lives once in `web/shared/cloud.js` (public by design). One Firebase app (`office-games`) for every game, so signing in once signs you in everywhere on the site.

**Legacy Firestore** (only the old GitHub Pages versions still write here; nothing was copied to D1 by decision: stats started fresh): collections `crews`/`users` (Lettuce Party), `thullaCrews`/`thullaUsers`, `guessCrews`/`guessUsers`, `liarCrews`/`liarUsers`, `rottenCrews`/`rottenUsers`, `flipchipCrews`/`flipchipUsers`, `melonCrews`/`melonUsers`. The right rules file for them is the 7-game copy in `web/melonburst/firestore.rules`. Lock it down once the redirects are live (§3).

---

## 7. The games page (`web/index.html`)

`web/index.html` in the monorepo (inline CSS, no JavaScript), served at `/` by the Worker; the old copy still serves pakdragoon.github.io/office-games from the `pages` branch. Header "office games" plus a short "how it works" line, then twelve cards in this order: **Ludo** (BETA, since Nov 19), **Alzheimer’s** (BETA, since Nov 17), **Forehead**, **A to Zap** (both lost their BETA badge Nov 17), **Fast Fingers** (NEW, credit to Junaid in the corner), **Melon Burst** (credit to Rijja in the corner), **Flipchip**, **Rotten**, **The Liar**, **Guesstimate**, **Thulla**, **Lettuce Party** (renamed from Wordle Party in `9dbf936`). The BETA badge (`.beta`) stays until a game has been tested with real people; Fast Fingers is the only card still tagged NEW. After ANY edit to this file, screenshot the whole page at 1280 and 375 and check every card has its Play button (a scripted reorder once broke the live page, `b60d6ff`). Each card shows a small version of that game's look (Melon Burst: a flipbook of the game's real melon stages generated with the same geometry as `js/melon.js`; each band snaps on as the melon pinches in a step, the face goes calm → worried → scared → panic, then the bands ping off and it relaxes, on a 4.8 s CSS loop (no explosion: it looked out of proportion on the card); Flipchip: a scrap of felt with chips, two of them flipping; Rotten: dripping ROTTEN tiles and a spotty banana), a description, facts chips and a Play button; the whole card is a link. Light and dark themes; one column on phones. Every game's home screen links back here with the **All games** chip (top-left, `.all-games` at the end of each `style.css`; just the icon under 330 px).

To add a game, copy an `<li>` card (links are relative: `/<game>/`). To remove a NEW tag, delete its `<span class="new">NEW</span>`; a BETA badge is `<span class="beta">BETA</span>`.

---

## 8. Melon Burst

Game idea by [Rijja](https://www.linkedin.com/in/rijja-farhan-011381214/), credited on the Melon Burst home screen, at the bottom of How to play, in the README, and in the bottom-right corner of its card on the games page (a separate link laid over the card, since the card itself is a link).

Hangman with a watermelon instead of a hanged man: guess a hidden word letter by letter; every wrong letter snaps another rubber band round your melon, and one band too many bursts it. Server: `server/src/games/melonburst.ts`. Full rules in the repo's README.

**Modes:**

| Mode | Players | Words |
| --- | --- | --- |
| **Race** (room) | 2–8 | The computer picks one word per round; everyone guesses it on their own melon. Latecomers join from the next round |
| **Pick words** (room) | 1 vs 1 or 2 vs 2 | Each round each side's picker types a word for the other side (60 s, then the computer picks; also if the picker has left). In 2 vs 2 teammates take turns picking. Everyone guesses the other side's word on their own melon; team score = sum |
| **Daily word** | solo | Run by the server (`server/src/daily/melonburst.ts`): the same everyday 5–9-letter word for everyone, from a seed derived from the server's secret (not the date), one day = UTC, day 1 = 2026-11-11, 6 bands, one try. The browser sends one letter at a time; the server keeps the session, answers with the masked word, bands used and time, and only sends the word once you've solved or burst. The clock starts after the countdown and keeps running through a refresh. Global leaderboard under the result (top 10), share text with 🟩/🟥 per guess. Old in-browser progress (`localStorage melonburst.daily`) is ignored and deleted; the home card tells players today's word is a new one |
| **Practice** | solo | Endless words of the chosen length (short 4–6, medium 6–8, long 8–12, any); streak and best streak in the browser; Enter for the next word |

**Flow (the server's state machine):** `lobby → play (pick → countdown → guess → reveal, per round) → over`. Race skips `pick`. The round ends when every active guesser has solved or burst, or the time limit runs out, or the host presses **End round now**; reveal lasts 9 s (host can skip). Away/left players aren't waited for.

**Host settings:** mode, sides (1 vs 1 / 2 vs 2), bands before it bursts (6 default, 8 easy, 5 tense), rounds (race 3/5/10, pick 2/4/6 words per side), word length (race), time to guess (2 min default; off/60/90/180 s), the computer's words (everyday + more 26k default, or everyday 8k), crew. Lobby seats for pick mode: Side A/B slots filled in join order; anyone can sit, move or stand; host can swap sides.

**Points (`engine.points`):** solved = 10 + 1 per spare band; race adds 3/2/1 for the first three solvers; burst or timeout = 0. Ranking: points, then words solved, then total time.

**Daily ranking (`engine.dailyScore`):** one number, lower is better: solved first, then fewest wrong letters, then fastest; bursts rank below every solve, by fewest letters still hidden then time. The same number is the stored `bestDaily` (decoded with `engine.dailyParts`, shown in Settings as "2 wrong, 10.9s"). The board's detail column holds only "N wrong" or "burst", never the hit/miss pattern, because the board is public before you finish.

**Who sees what (`view()` in `server/src/games/melonburst.ts`; the browser's `viewFor` is only used for solo):** each player gets their own state. Your own guesses always; race opponents only as "letters found / bands"; in pick mode you see the full progress (letters and word) of the side guessing *your* side's word, your teammate sees your side's word as soon as it's picked, and people watching a pick game see everything. Everything is revealed at the round's end. Verified in tests: the word never appears in a guesser's state.

**The melon (`js/melon.js`):** SVG; bands bunch in the middle and pinch it into a peanut shape (`d` transitions), the face goes calm → worried → scared (sweat) → panic, it trembles harder, cracks one band before the end, drips juice on the last band; burst = juice star, ring, 16 flying wedges with seeds, puddle and rind remains (plus red splats on your own screen; Settings → Burst animation on/reduced/off). Solving pings the bands off.

**Words (`tools/build-words.mjs`):** computer picks from SCOWL ([wordlist-english](https://www.npmjs.com/package/wordlist-english)) sizes 10+20 (`words/common.txt`, 7,995) and 35 (`words/more.txt`, 18,474), 4–12 letters, no names, plurals dropped when the singular is listed; players may pick from `words/valid.txt` (237,825; an-array-of-english-words + those); LDNOOBW blocked (`js/blocked.js`). Meanings after each round come from dictionaryapi.dev when it answers (it sometimes 500s; failures aren't cached).

**Logo:** MEL + a watermelon wedge for the O + N in rind green; BURST in red that punches every 2.4 s while melon wedges, rind bits, seeds, juice drops and wind streaks pop out behind it.

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | Screens and styling |
| `js/engine.js` | Settings, word checks, computer picks, guessing, points, ranking, pickers, daily word, share text. No DOM or network |
| `js/melon.js` | The SVG watermelon |
| `js/app.js` | Screens, the room link (rooms run on the server), the daily (via the API) and practice (runs here) |
| `js/cloud.js` | Re-exports the shared sign-in (`web/shared/cloud.js`) and loads my stats from `/api/me/stats` |
| `js/blocked.js`, `words/*.txt`, `tools/build-words.mjs` | Word lists and their builder |
| `test/engine.test.mjs` | Engine tests (15) |

Tested with real multi-tab rooms: race (scores, no leaks), pick 1 vs 1 (dictionary refusals, forged picks ignored, visibility), 2 vs 2 with a watcher (picker rotation, refresh mid-guess, computer picks when a picker leaves, team totals, Play again blocked with a note when a seat is empty), time limit, End round now, host leaving, daily resume, practice, phone 375 px dark.

---

## 9. Flipchip

A two-player chip-flipping board game (the reversi mechanic, with its own name and look): place a chip so it traps a straight line of your opponent's chips between two of yours; they all flip. Most chips when nobody can move wins. Server: `server/src/games/flipchip.ts`.

**Rooms:** two seats, **Dark** (goes first) and **Light**; everyone else watches and can send reactions (👏 😮 😂 😬 🔥 🤝, rate-limited, floating over the board). In the lobby anyone can sit, switch seats or stand up; the host can swap colours; joiners fill empty seats. Settings: board 6×6 / **8×8** / 10×10, time per move (**none**/15/30/60 s; a random legal move is played when it runs out), dots showing where you can go (on/off), colours after each game (**swap**/random/keep), games (open / best of 3 / best of 5), crew. Resign (two taps), host **End game for everyone** (two taps), and **Claim the win** if the opponent has been gone 45 s.

**Vs computer:** Easy / Normal / Hard, choose your colour (or random) and board size. Undo (takes back your move and the computer's reply), Hint (rings the move Hard would play), New game; a game in progress is saved in the browser (Continue on the home card); record per level in the browser. The computer thinks in a Web Worker (`js/ai-worker.js`), falling back to the page if workers fail. Easy = loose greedy/positional with noise; Normal = 2-ply positional search with a little randomness; Hard = iterative-deepening alpha-beta (~1.1 s, answers from even depths only, corners/mobility/frontier evaluation) with a perfect endgame for the last 8–12 squares. Tests check each level beats the one below.

**Making it intuitive:** hint dots in the mover's colour, hover preview (ghost chip, **+N** badge, dashed ring on every chip that would flip), tap-twice on phones (player setting), keyboard play (arrow keys + Enter), gold dot on the last move, chips flip outwards one step at a time, passes announced, your board and card glow on your turn, move log with coordinates (a–h, 1–8).

**Rating and replays:** skill rating next to names in the lobby, seat cards and player cards, "Skill rating +12 now 1512" on the result panel (players only), rating in the stats panel (§5). **Share replay** on the result panel for players and watchers.

**Bots:** a bot takes one of the two seats ("Computer · Easy/Normal" on the table; result says games with a computer player aren't rated). It uses the engine's computer player with `maxRoot` (Normal weighs only the 2/4/5 best moves on 10×10/8×8/6×6, two moves deep). Hard isn't offered (~1.1 s of CPU).

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | Screens and styling (felt board, poker-style chips in 3D) |
| `js/engine.js` | Board, flips, legal moves, passes, winner, settings, the computer player. No DOM or network |
| `js/ai-worker.js` | Runs the computer player off the page's thread |
| `js/app.js` | Screens, board animations, the room link (rooms run on the server), computer games (run here) |
| `js/cloud.js` | Re-exports the shared sign-in (`web/shared/cloud.js`) and loads my stats from `/api/me/stats` |
| `js/replay.js` | The read-only replay viewer (`?replay=<id>`): rebuilds each position from the saved moves with the engine; play/pause, prev/next, first/last, slider, clickable move list, arrow keys |
| `test/engine.test.mjs` | Engine tests (17) |

Tested: computer games on every level and size (hint, undo, passes, result, record, continue after leaving), rooms with host + guest + spectator (identical boards and DOM on all three, forged moves and seat grabs ignored, refresh mid-game keeps the seat, resign, colour swap on rematch, claim after leaving, move timer auto-move, host leaving), tap-twice, keyboard, phone 375 px, 1024×700 with no scroll, dark mode.

---

## 10. Rotten

A pass-the-banana word game (the BombParty idea, with its own name, look and rules). Players sit round a table; the holder gets 2 or 3 letters and types a word containing them to pass the banana on. It splats at a hidden random moment: the holder loses a life; last one standing wins. Server: `server/src/games/rotten.ts`. Full rules and settings are in the repo's README.

**Flow (the server's state machine):** `lobby → play → over`. `play` starts with a 3-2-1 countdown; each splat pauses 1.8 s (the banana stays at the splatted seat, then moves on).

- **The hidden timer:** the room picks the fuse (Fast 5–15 s, Normal 10–30, Relaxed 20–45) and never sends the splat time unless the room shows the timer; players only get the banana's age, which drives its look. The fuse keeps running across passes; a new random fuse starts after each splat.
- **Shortest turn** (default 5 s; 3, 8 or off): if the banana arrives with less time left, the holder gets that long.
- **Words:** the server checks every word (`engine.checkWord`): contains the letters, long enough (3/4/5), in the list, not blocked, not already played. Plurals/-ing/-ed count as repeats by default (`stemKey`). Repeats are per game or per room.
- **Letters:** after a splat the same letters stay (default) but change after 2 splats in a row. Bonus life for using A–Z (or A–Z without Q, X, Z), capped at start+1 by default. Best of 3 / 5 or open play.
- **Presence:** an Away holder (9 s silent) passes the banana on without losing a life; a closed tab is out of the game after 20 s.
- **Whose turn:** the banana sits beside the holder's seat and slides round; the centre says "Sara's turn" / pulsing "YOUR TURN!"; the holder's seat is tagged; your table glows on your turn.
- **The banana** (`js/banana.js`): drawn SVG; ages Fresh → Ripe → Spotty → Mushy → Rotten! (label under it): spots, then bruises and stink lines, then flies and a drip; splat animation (player setting: on, reduced, off).
- **Logo** (`js/logo.js`): SVG tiles melting more from left to right (wax drips, warped letters, acid drops on E and N).
- **Daily puzzle (global, run by the server, `server/src/daily/rotten.ts`):** 10 letter sets from a seed derived from the server's secret (not the date, so nobody can work them out ahead), the same for everyone, one day = UTC. The server shows one set at a time and times each answer itself; score = total time + 10 s per skip, share squares 🍌🟨🟫⬛, one try per day, a global leaderboard under the result. Day 1 is 2026-11-10. **Practice:** endless letters, no lives, best streak kept in the browser and on the server (stats sheet "Practice best", via `POST /api/rotten/practice`).
- **Phones:** built-in keyboard (player setting: automatic = built-in on touch screens) that also marks collected bonus letters.
- **Bots:** read `words/bot.txt` (built by `tools/build-words.mjs`: up to 24 everyday words for each of 2,252 prompts, 129 KB gzipped) because scanning the 274k list costs ~38 ms of CPU per turn; they think 2.5–8 s, miss 10% (Normal) or 30% (Easy) of turns, Easy only knows the 8 most common words per prompt, and follow the same word rules.

**Words:** `words/en.txt` (274,813 words, an-array-of-english-words), `words/ur.txt` (3,613 Roman Urdu words from `tools/urdu-source.txt`, verb roots expanded into forms), `js/prompts.js` (English prompt bands by how many of Google's 20k common words contain them, plus the LDNOOBW blocked list). Roman Urdu spelling is matched loosely (`normalUrdu`: khana = khaana = kana, theek = thik). Rebuild with `node tools/build-words.mjs` (downloads sources into the git-ignored `tools/.cache/`). Everyone downloads the lists (~700 KB gzipped) so typing hints work locally; the server bundles the same files and is the one that decides. Known gap: the Urdu list is small, so some real words get refused; add them to `tools/urdu-source.txt`.

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | Screens and styling |
| `js/engine.js` | Rules: settings, checkWord, Roman Urdu spelling, stems, prompts, nextHolder, bonus letters, daily. No DOM or network |
| `js/prompts.js` | Generated prompt lists and blocked words |
| `js/banana.js`, `js/logo.js`, `js/keys.js` | The banana, the melting logo, the built-in keyboard |
| `js/app.js` | Screens, the room link, the daily (via the API) and practice (runs here) |
| `js/cloud.js` | Re-exports the shared sign-in (`web/shared/cloud.js`) and loads my stats from `/api/me/stats` |
| `tools/build-words.mjs`, `tools/urdu-source.txt` | Word list builder and Urdu source |
| `test/engine.test.mjs` | Engine tests (81) |

The settings selects inside **More settings** overflowed their box (Chrome `::details-content` box-sizing, see §16); fixed Nov 11 (`723eadb`).

Fixed by the move to the server: the fuse runs on the server, so a background tab no longer makes splats late.

---

## 11. The Liar

A bluffing game with three modes: everyone gets the same secret (a word, or in Time mode a time) except one player, the liar, who only knows the category (or a range). Server: `server/src/games/liar.ts`.

**Modes (host setting "Game"):**

| Mode | Each player does | Liar knows |
| --- | --- | --- |
| **Draw** | Takes turns adding to one shared drawing (3 rounds) | The category |
| **Words** (Nov 11) | Takes turns typing one or two words about the secret word (3 rounds, words on a board) | The category |
| **Time** (Nov 12) | Stops a hidden clock at a secret time, all at once, then a timed discussion | A 6-second range around the time |

**Flow (the server's state machine):** Draw and Words: `lobby → role → draw → vote → (guess) → result`. Time: `lobby → role → time → discuss → vote → result` (no guess).

- **Lobby:** host settings are **Game: Draw / Words / Time**; for Draw, **Each turn: One line / Free draw** (free draw: 5, 8, 12, 15, 20 or 30 s); for Words, **seconds to type** (20/30/45/60); for Time, **Time to talk before the vote** (60/120/180 s, default 60); **Words from: All categories / Pick categories** (hidden in Time), and crew name. Start needs **at least 3** connected players (max 8). Saved in `localStorage theliar.room` (`play`, `mode`, `seconds`, `wordSeconds`, `discussSeconds`, `categories`).
- **Role (15 s, or until all press I'm ready):** each player gets a private card behind **Hold to see your card** (press and hold to reveal, so neighbours can't read it): the word and category, or "You are the liar" with the category. Time mode: "Your time 6.71 s", or "the liar, the time is between 3 and 9 s". The liar is never the same person two games running.
- **Draw (3 rounds):** a random order in round 1, the same order in rounds 2 and 3, and **the liar is never first**. A 1.4 s hand-off banner shows whose turn it is, with a chime and vibration for the drawer. One-line mode: 15 s to start the line, up to 10 s to draw it, and lifting the pen ends the turn. Free-draw mode: unlimited strokes for the chosen seconds (5, 8, 12, 15, 20 or 30); the drawer can press **Done drawing** to end the turn early (the server accepts `done` only from the current drawer in free mode). Every player draws in their own colour (8 pen colours tuned for both themes). Ink streams live: the drawer sends points every 150 ms (`FLUSH_MS` in `js/sketch.js`), and the server checks and relays them. Late or missing ink triggers a resync of the full drawing.
- **Words (same turns and rounds as Draw):** the player whose turn it is types a word (at most 2 words, 24 letters). The server checks it (`engine.clueProblem`): not the word itself, a word made from it (*teapot* for *tea*) or the main part of a two-word answer (*cricket* for *cricket bat*), and not a repeat. The liar's words are never checked against the secret word, so a refusal tells them nothing. Out of time = **passed**, shown on the board (rows per player, columns per round).
- **Who stops (Time only, Nov 17, `c5e680d`):** host setting `timeTurns`: **All at once** (`all`, default, as below) or **Turn by turn** (`turns`): one player at a time in the game's random order (`room.order`, the liar never first), a 1.4 s hand-off banner and a chime for the one whose turn it is, only that player's Start/Stop shows; each turn lasts `engine.timeTurnMs(hi)` = 1.5 × range top + 8 s (range-based, gives nothing away); every stop goes up on a "Stops so far" timeline straight away (the view sends `stops` during `time` in this mode, plus `timer` = whose turn); no stop in time or leaving on your turn = skipped with no stop; the last stop opens the discussion. Server: `beginTimeTurn` / `nextTimeTurn` / `mayTime` in `liar.ts` (the `turn` timer is shared with Draw/Words). Old rooms without the setting are `all`. Tests: `server/test/liar-time-turns.test.ts`.
- **Time:** the host picks a target (`engine.pickTime`: 3.01–11.99 s, never a whole second) and a whole-second range 6 s wide that holds it anywhere inside (e.g. 6.71 → 3–9 or 6–12). Each player presses **Start** and **Stop** at their own pace (timed from `event.timeStamp`; no clock shown; double taps under 120 ms ignored) and sends only the stop time; the server checks it (`cleanStop`: a number, 0.12–60 s) and accepts one per player. Stops stay on the server until **everyone active has stopped** or the limit runs out (`timeLimitMs(hi)` = 1.5 × range top + 15 s, based on the range so the deadline gives nothing away). Name chips show each player as **Not started / Counting… / Done ✓ / Away** (a `start` message tells the server who has started); **Done** shows only once you've stopped yourself, so nobody can stop when the others do. Then **discuss**: everyone's stop as a pin on one timeline of seconds (labels stack into lanes sized from the board width, redrawn on resize; no target), "No stop" for anyone who didn't, the chosen 60/120/180 s clock, and **Ready to vote** to end it early.
- **Ready to vote:** anyone can press it any time (Draw/Words during the turns, Time during the discussion); when **everyone active except one** has pressed it, the vote starts. Otherwise after round 3 (or when the discussion time ends).
- **Vote (45 s):** pick a suspect (not yourself). Pointing at a name highlights only that player's lines, words or time bar. The most votes is accused; **a tie accuses nobody**.
- **Guess (30 s, Draw and Words only):** if the liar is accused, they pick the word from **12 options** in its category. Others see the options greyed out. Time mode skips it: the visible stops already show roughly where the target is.
- **Result:** "Caught!", "Stolen!" or "The liar got away", with the word (or the time), the liar, who voted for whom, points; Draw adds **Replay drawing** (line by line) and **Save picture** (PNG); Time adds the target line and the liar's range to the timeline and ranks everyone by closeness (seconds early/late plus Spot on ≤0.2 s / Close ≤0.5 / A bit off ≤1.5 / Way off). The host chooses **Next game** or **Change settings**.
- **Share replay** (Draw and Words): copies `/the-liar/?replay=<id>`, a read-only page that redraws the drawing line by line, or reveals the words board in turn order, with the word, liar, votes and points; hovering a player highlights their lines or words. Time mode saves no replay (its result is a handful of numbers). Files: `js/app.js` (`loadReplay`, `renderReplay`), `js/sketch.js` (each sheet has its own dot-pattern id).

- **The liar doesn't know (Nov 25):** host setting `liarKnows` (lobby "The liar: **Knows** / **Doesn't know**", every mode, default Knows; rooms without it are Knows). When off, the liar gets a **decoy** instead of "You are the liar": a close word from the same group in **`js/pairs.js`** (`DECOY_GROUPS`, every one of the 1,584 words is in a group of 2–5 look-alikes, e.g. *chai / doodh patti / karak chai / kashmiri chai*; tested: same category, each word once) via `E.pickDecoy`, or in Time a target 1.5–3 s away (`E.pickDecoyTime`, still 3.01–11.99, never whole) and no range. The liar's `secret` message has **exactly the same fields** as everyone else's (`liar: false` + `word`/`time`), so nothing in the page or devtools tells them; the role tip is the same for everyone. Anyone may go first (`E.turnOrder(..., liarKnows=false)`: "never first" would clear the first player). Words: the liar's clues are checked against their own decoy, like everyone's. Caught → the usual guess, titled "Surprise: you were the liar!", and the decoy is never one of the 12 options (`liarOptions(..., skip)`). The result (and the replay) shows **The liar's word** / **The liar's time** (`decoy` in the view, `time.decoy`; the timeline draws the liar's time as a dashed line instead of the range). Points unchanged. Stat `unknowingLiarGames`. `PROTOCOL` is now **5** (an old tab as host would drop the setting). Tests: engine (groups, decoys, options, 5,000 decoy times, liar can go first) and `server/test/liar-hidden.test.ts` (identical cards in Words and Time, nothing leaks before the result, decoy clue check, guess options, default still Knows). Browser rounds: 3 players Words (laptop + phone dark) to Caught via the guess, and Time to the result.

**Points (`js/engine.js` → `points()`):**

| Outcome | Liar | Each other player |
| --- | --- | --- |
| Caught (can't name the word) | 0 | 2, plus 1 if they voted for the liar |
| Caught but names the word ("stolen") | 2 | 1 if they voted for the liar |
| Gets away (wrong person or a split vote) | 3 | 1 if they voted for the liar |

**Words:** `js/words.js`, **1,584 words in 31 categories**, all drawable (Food, Desi food, Drinks, Fruit & veg, Animals, Birds, Sea life, Bugs, Office, Home, Kitchen, Clothing, Sports, Cricket, Transport, Jobs, Places, Pakistan, Nature, Tech, Music, Tools, School, Fantasy, Space, Celebrations, Body, Feelings, Toys, Actions, Symbols). No duplicates (tested); every category has at least 12 words for the liar's options. A room never repeats a word (it remembers its last 700).

**Spectators:** someone who joins mid-game watches (no card, no vote) and plays from the next game.

| File | What it does |
| --- | --- |
| `index.html` | Screens and sheets |
| `style.css` | All styling |
| `js/words.js` | Word list |
| `js/pairs.js` | Decoy groups for "The liar doesn't know" (close words per category), `closeWords()` |
| `js/engine.js` | Rules: pickWord, liarOptions, turnOrder, pickLiar, voteNeeded, tally, outcome, points, cleanInk; Words: cleanClue, clueProblem; Time: pickTime, timeLimitMs, cleanStop, fmtSecs. No DOM or network |
| `js/sketch.js` | The drawing: 800 × 600 SVG sheet, smoothed paths, the local pen (one-line or free), live strokes, highlight, replay, PNG export |
| `js/app.js` | The room link, phases, screens, the Words board, the Time board (`renderTime`, `renderTimeRoster`, `renderTimeResults`). Host start message is `begin` (`start` is the Time-mode stopwatch) |
| `js/cloud.js` | Re-exports the shared sign-in (`web/shared/cloud.js`) and loads my stats from `/api/me/stats` |
| `test/engine.test.mjs` | Engine tests (incl. 20,000 random time targets and ranges) |

Time mode was tested in multi-tab rooms (3–5 players): a full game, a split vote, forged and duplicate stops (ignored), refresh after stopping (keeps "Stopped"), a tab closed mid-timing, a player who never stops (limit runs out, "no stop"), the discussion timer running into the vote, a mid-game joiner, Next game, and switching Time → Draw → Words; phone 375 px dark.

---

## 12. Guesstimate

A perception game: everyone gets the same puzzle at the same moment and the reveal measures how close each guess was. Server: `server/src/games/guesstimate.ts`.

**Seven tests** (`js/rounds.js` builds puzzles from a seed; `js/play.js` draws them):

| Test | What you do | Easy | Normal | Hard | Scores 50 when off by |
| --- | --- | --- | --- | --- | --- |
| Count | Dots flash; guess how many | 8–30 dots, 2.5 s | 20–80, 1.6 s | 50–160, 1.1 s | 20% |
| Track | Ball bounces into a hatched zone; mark where it hits the right wall | slow, gentle | ~2 bounces | fast, ~4 bounces | 8% of the wall |
| Angle | Drag an arm to make the target angle (either side counts) | multiples of 15° | any, tilted | any, tilted, short grey arm | 6° |
| Split | Slide a marker to a fraction of a bar | halves to fifths | percentages | % or fractions like 5/7, tilted | 3% of the bar |
| Timing | Press Start, count in your head, press Stop at the target (no clock shown) | 1–6 s whole | 1.0–10.0 s | 1.0–20.0 s | 15% of (target + 2 s) |
| Cut (Nov 17) | Drag one straight line across a random blob to cut it into two equal halves (drag again to move it; keys: ←/→ slide, ↑/↓ turn) | gentle wobble | more lobes | concave, bumpy | 3.5% off half (53.5/46.5) |
| Balance (Nov 17) | "How many pineapples weigh as much as 1 goat?" Type a whole number; scored on how many TIMES off you are | ratios 5–40 | 10–3,000 | 300–1,000,000,000 | 1.6× off |

**Cut** (`makeCut`, Nov 18 `8a9130b`): one of 13 shape families picked per difficulty (`CUT_SHAPES` in `rounds.js`: easy triangle, pentagon, egg, drop, blob; normal adds heart, L (`ell`), off-centre T (`tee`), wedge-bitten circle (`bite`), arrow; hard adds star (5 or 7 points), crescent (`moon`), uneven plus (`cross`)), each a polygon (curves = 72 sides) so areas are exact, none centrally symmetric, turned randomly, mirrored half the time, scaled to fill the paper with a strip left at the bottom for the hint; the puzzle carries `family`. Engine test: every family turns up per difficulty and no outline crosses itself. **Knife UI** (`TESTS.cut.mount` in `play.js`): both pieces shaded live in the player's colour; drag on empty paper = new cut, drag the line (wide invisible hit stroke) = slide, drag a round handle = turn round the other handle; handles sit where the line meets a frame 16 px inside the paper (`frameEnds`); a hint on the paper moves to the edge the line doesn't cross (hidden if it crosses both); arrows still slide/turn; a new cut is drawn, not dropped in (`a97d708`): while dragging only a trail from the press point to a blade dot shows (old cut, pieces and handles hidden), on release the line runs to both frame ends in 200 ms and the pieces fade in (`.fresh`); a drag under 12 px keeps the previous cut; reduced motion skips the run-out; the guess is a line `[x1, y1, x2, y2]` (`validGuess`: 4 numbers within −50…450, ≥ 10 apart); `cutShare` clips the polygon to one side of the line (Sutherland–Hodgman, works for concave shapes) and divides areas; `perfectCut(pz, deg)` slides a line at that angle to exactly half (used for the reveal's dashed green line and tests). Labels via `halves()` ("53/47", a decimal near half: "50.4/49.6"). Reveal: solo shows your two pieces tinted with their %; rooms label each player's line. 51/49 scores 90, 52/48 74, 53/47 58, 55/45 31.
**Balance** (`makeBalance`): 71 things with typical weights in `js/weights.js` (`[one, many, emoji, kg]`, ant to blue whale; edit there). Audited Nov 18 against typical published figures: all fine as rounded typical values; vague names made specific (great white shark, emperor penguin, labrador, brown bear; weights unchanged so no answer changed). Keep names specific enough to have one weight. The scale shows one item on each pan (Nov 18; was a pyramid of six on the right), the label under the right pan says how many. A pair is drawn until heavy/light falls in the difficulty's range; the answer is `roughly()` (2 significant figures, whole numbers below 10). Guess: a whole number 1…1e10. Error = |ln(guess/answer)|, so double and half are equally wrong; 10× off = 0. The board is a balance scale (emoji on the pans): it leans toward the heavy thing while you guess; on the reveal it swings and settles where your guess puts it (level = right) over a log-scale ruler with the answer and everyone's guesses.
**Daily:** `dailyKinds(day)` adds a test only from the day after it launched (`DAILY_FROM`: Timing day 2, Cut and Balance day 9 = 2026-11-18), so a day already being played never changes; the server's daily (`server/src/daily/guesstimate.ts`) and the home text ("seven puzzles") use it. Saved prefs `version: 3` switch Cut and Balance on once. The test pickers are a 4-column grid. Tests: engine (`test/rounds.test.mjs`, sections 5–6) and `server/test/guesstimate-new-tests.test.ts`.

**Scoring curve:** `score = round(100 × 0.5 ^ ((miss ÷ 50-point miss) ^ 1.5))`, a softer top, so tiny misses (hand jitter) cost little and big misses drop fast. Half the 50-point miss scores 78, double scores 14. Timing measures the miss against target + 2 s so short targets aren't judged harder (1 s off: 53 on 5 s, 69 on 8 s, 84 on 15 s). Verdicts: 95+ Spot on!, 80+ Sharp, 60+ Close, 35+ Ballpark, else Way off. Colours: green 80+, amber 35+, red below.

**Modes:**

- **Rooms (1–8):** host picks difficulty, tests, rounds of each (1–3), time to answer (none/20/30/45 s) and crew. Only the seed travels; each browser builds the same puzzles, and the server checks and scores every guess. 3-2-1 countdown, guesses hidden until the reveal, auto lock-in of a placed guess just before the time limit, End round now, rematch, change settings. **Timing rounds** get max(limit, target × 1.5 + 8) seconds, and the countdown clock is hidden during them (otherwise people could time it off the clock). Highest total wins; a tie on total goes to the best single round.
- **Daily puzzle (global, run by the server, `server/src/daily/guesstimate.ts`):** one of each test on Normal from a seed derived from the server's secret, the same for everyone, one day = UTC, one try; every guess is scored on the server, global leaderboard on the summary. Day 1 is 2026-11-10. **Share result** copies e.g. `Guesstimate #12: 74/100` plus coloured squares and per-test scores.
- **Practice:** pick difficulty and tests; best average per difficulty is kept in the browser.
- **Stats:** the streak tile is a day streak (days in a row with a finished daily, best shown beside it), 0 once a day is missed. A room-win streak was never part of Guesstimate; adding one is `streaks: { streak: won }` in its `reportPlayer`.

**Look:** technical-drawing style. Plain paper during play (no grid, so nobody can measure); the reveal adds a grid, rulers, protractor and dimension lines with everyone's guesses labelled in their colour. The board sits left with a side panel right; the board is sized from the window height so nothing scrolls on laptops (tested at 1024×700 up to 1920×1080).

**Settings migration:** saved prefs carry `version: 2`; older saved settings get Timing switched on once.

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | Screens and styling |
| `js/rounds.js` | Seeded generators, scoring, `validGuess`, `describe`, `answerSeconds`, daily seed and set |
| `js/play.js` | Drawing, input and reveal per test; `icon()`; `blank()` (empty board before a round) |
| `js/app.js` | Practice (runs here), the daily (via the API), the room link, screens |
| `js/cloud.js` | Re-exports the shared sign-in (`web/shared/cloud.js`) and loads my stats from `/api/me/stats` |
| `test/rounds.test.mjs` | Engine tests |

---

## 13. Thulla

The Pakistani card game, 2–8 players. Complete and tested; full rules and setup are in the repo's README. The server runs the rules engine (`server/src/games/thulla.ts` using `js/engine.js`, pure, tested with `node test/engine.test.mjs`: thousands of random rounds plus edge cases). Seats keep stable ids (`p1`, `p2`…); each player only receives their own hand.

**Rules as built:** all 52 cards dealt (players after the dealer get the extras; the dealer rotates). The Ace of Spades holder leads it every round. Follow suit if you can; Ace high. No thulla on the first trick (off-suit cards are just discarded). Thulla: can't follow → play any card; the trick stops and the highest card of the led suit picks it all up and leads. You're safe once a trick resolves with your hand empty (if your last card was the highest and someone then thullas, you pick up and are back in). If everyone empties on the final clean trick, the highest card loses. With two left, either can give up. Game winner: fewest losses, ties broken by average finishing position.

**Lobby settings:** rounds (unlimited/3/5/10), turn timer (off/15/30/60 s, auto-plays the lowest legal card, or the highest when thullaing), play early (throw a card of the led suit before your turn), take the next player's cards (ask for their whole hand, 15 s to answer), crew name. The host role passes on if the host leaves (no more "the host closed the room").

**Rating:** rated per round (§5): rating next to names in the lobby and scores table, +N/−N on every round result and the game-over ranking, and in the stats panel.

**Bots:** `botCard` in `js/engine.js`: Easy plays a random legal card; Normal leads low, dumps its highest card that can't take the trick, throws its highest on a thulla, plays loosely 1 turn in 10; always accepts a take-cards request.

**Features:** felt table with player-colour faces that react to card count, turn glow and timer ring, danger bar, quick chat phrases, cat or hippo "smack" animation on a thulla (Settings: Random/Cat/Hippo/Off), tap-to-raise then tap-to-play on phones, rejoin after refresh.

Files: `index.html`, `style.css`, `js/engine.js`, `js/app.js`, `js/slap.js` (smack animation), `js/cloud.js`, `firestore.rules` (legacy, see §6), `test/engine.test.mjs`.

Optional ideas never built: a Rive version of the cat and hippo (needs an animator's `.riv` file to replace `js/slap.js`).

---

## 14. Lettuce Party (was Wordle Party)

Multiplayer five-letter word game, up to 5 players. **Renamed from Wordle Party on Nov 11** (`47866a9`) ahead of any public or AdSense launch, because Wordle is an NYT trademark. You renamed the GitHub repo yourself to `lettuce-party`; it's live at [pakdragoon.github.io/lettuce-party](https://pakdragoon.github.io/lettuce-party/). The old `/wordle/` address now gives a 404 (no redirect, your choice). Server: `server/src/games/lettuce.ts`. Look: leaf-shaped logo tiles and a 🥬 favicon.

Same word for everyone; other players' boards show as live coloured tiles (no letters). Host settings: win rule (first to solve or fewest guesses), rounds, time limit, hard mode, crew name. Results show the word's meaning and a Share button. Scores carry over within a room; refresh and rejoin keeps your board.

**Words:** the NYT lists were replaced with its own: `words/answers.txt` (1,913 answers from SCOWL sizes 10/20/35, plurals and other forms stripped) and `words/valid.txt` (12,655 allowed guesses), built by `tools/build-words.mjs`.

**Kept on purpose:** the Firebase project id `wordle-party-81870` and the `localStorage` keys `wordleparty-*`. Players never see them, and renaming them would lose saved names, settings and scores.

Files: `index.html`, `style.css`, `js/app.js` (screens and the room link; no word lists in the browser any more), `js/cloud.js`, `js/words.js` (only `BLOCKED_ANSWERS` is still used, by the server), `words/answers.txt`, `words/valid.txt` (bundled by the server), `tools/build-words.mjs`, `firestore.rules` (**legacy single-game copy, never publish**). Newcomers can't join mid-round (they're told to join when it ends); a refresh mid-round gets the board back. Analytics events are wired in (`room_created`, `room_joined`, `game_started`, `round_finished`, `round_played`, `game_finished`, `share_result`, `login`) but off until a `measurementId` is set.

**Stats sheet** (visible to guests too now): played, wins, win streak, best streak, guess distribution, and favourite opener (the most used first guess).

**Hot & Cold (Nov 17, `c26124a`):** a fourth mode (`mode: 'hotcold'`). Everyone hunts the same secret word of any length; any word gets a **rank** for how close its MEANING is (1 = the word; Burning ≤10, Hot ≤100, Warm ≤500, Cool ≤2000, Cold). Timed (`hotTime` 2/3/5 min, default 3, always on); the **closest guess when time runs out wins**, finding the word wins outright (fastest first), then best rank, then fewer guesses (`E.hotOrder`). Others see only your best rank and word count (`best`, `used`, `hints` in the view), never words; the results show everyone's closest words and the secret word's 10 nearest (`nearest`). **Hints** (host setting `hotHints`, default on): up to 3 a round, each a word about halfway from your best rank to 1 (1000 before any guess; none at rank ≤ 3); a hint is listed (dashed, "hint") but never counts as your best and can't be re-typed. The UI is a word box + list sorted by rank with a bar; no on-screen keyboard in this mode. Share text = coloured squares only.
- **Data** (`web/lettuce-party/tools/build-hotcold.mjs`, run from `web/lettuce-party`; caches downloads in `tools/.cache/`, git-ignored): GloVe 100-d (Wikipedia+Gigaword, public domain, via gensim-data), 22,000 words = the 8,000 most frequent dictionary words + everyday SCOWL 10–35 words + every secret word, no LDNOOBW words; centred, PCA to 64 numbers, 4 bits each (measured: keeps more of each word's top-20 neighbours than 48 × 8 bits, in less space). Output in `server/src/data/` (see §4), never under `web/` (the vectors would let a browser work the answer out). Secret words: `server/src/data/hotcold-targets.txt` (278, hand-picked; words whose neighbours are taken over by another meaning, like party/cup/key, and feelings like happy/love were removed); rebuild after editing it.
- **Why precomputed:** ranking all 22k words live costs ~20 ms CPU on a cold room (free plan: 10). The build stores per secret word its 100 closest words (exact ranks 2–101) and a closeness → rank table at fixed ranks; a guess = 1 binary search on the padded word list + 1 dot product (~0.2 ms). Shared maths in `web/lettuce-party/js/hotcold.js` (build and server use the same code, so ranks agree exactly).
- Proper nouns aren't guessable ("I don't know that word"). Stats: `hotcold:plays|wins|solved|guessSum` + `hotcoldFastestNeg` (MAX). Tests: `web/lettuce-party/test/hotcold.test.mjs` (12, reads the built data), `server/test/lettuce-hotcold.test.ts` (6).

**Dailies (Nov 18, `75c247d` `5a2905a` `19b99a6`):** a **Daily** card on the home page (below Play now / Join, full width) with one button per mode; each is its own daily (`lettuce-party:<mode>` in `DAILIES`, one module `server/src/daily/lettuce.ts`), its own word/pair from the secret seed (`E.dailyRandom(seed, mode)`), its own leaderboard and share text, one try a day, untimed but the server's clock breaks ties; stats `dailyClassicPlays/Best` etc. under `lettuce-party` (never touch Classic's room wins/streak/openers; no day streak, because `streak` is Classic's win streak). Classic 6 guesses, Counts 8 (only the three numbers until the end), both must be in the word list; score = `E.dailyScore` (guesses × 1e7 + ms, a miss below every solve). Word ladder: pair from `ladders.txt`, start/target public once started, steps checked with reuse allowed, shortest path only at the end, ranked by steps then time. Hot & Cold: rank per word, up to 3 hints each counting `DAILY_HINT_COST` = 5 words (`findHint` in `games/lettuce.ts`, shared with rooms; seeded by word + hint count), word and its 10 nearest only at the end, `E.hotDailyScore`. Ladder and Hot & Cold have a **Give up** button in the game bar (two taps, 4 s) ranking below every finish (Hot & Cold by closest word). The page plays a daily on the normal game screen: `dailyView()` builds a one-player room view from the server's answer (scores column and rivals hidden via `.arena.daily`), guesses/hints go through `dailyGuess` instead of the socket, results show today's top 10 (`#daily-board`). Progress per mode kept in `localStorage lettuce-daily` for the card. Tests: `server/test/lettuce-daily.test.ts` (8), engine tests.

**Mode picker (Nov 18, `0650f92`):** `.mode-pick` is a left-aligned flex row: Classic, Counts, Word ladder on the first row, Hot & Cold alone on the second (`label:has(input[value="hotcold"])` takes the full row), 2 by 2 under 380 px; Hot & Cold carries a `.beta-chip` (same yellow-orange as the games page) until tested with real people.

**Modes (Nov 13, `8e9be40`..`87077ab`):** the host picks a mode in the lobby (`mode` in the room settings and view): **Classic** (as before), **Counts** and **Word ladder**. Rules live in `web/lettuce-party/js/engine.js` (new; `score` moved there from `lettuce.ts`); the server cleans every setting with `E.cleanSettings`, and settings only change in the lobby (before, a host could change them mid-round). Guesses per round (4–10, default 6) apply to Classic and Counts and are enforced by the server; hard mode exists only in Classic.
- **Counts:** the guesser and everyone else get only three numbers per guess (right place, wrong place, not in the word; duplicates counted like the colours). Colours, letters and the answer are revealed at the round's end. The keyboard isn't coloured.
- **Word ladder:** everyone gets the same start and target (public) from `words/ladders.txt` (2,100 lines `start target par path…`, ~17 KB gzipped), built offline by `tools/build-ladders.mjs`: each pair has a 3–6 step shortest path through answer-list words, blocked words excluded. The server never searches: `E.pickPair` jumps to a random byte offset and reads that line; pairs don't repeat in a room (last 300 kept in `usedPairs`, compared as `"start target"`). Steps must be valid words (blocked words refused as "Not a word", or they could beat par), differ by one letter and not repeat; capped at 60 steps. Time limit 1/2/3/5 minutes (always on). Others see only step counts and a letters-matching-the-target count; results show everyone's ladder plus one shortest path, and par.
- **Stats:** Counts and Ladder write their own (`counts:plays|wins|solved|guessSum`, `ladder:plays|wins|solved|steps|overPar`, plus `countsFastestNeg`, `ladderFastestNeg`, `ladderBestOverNeg` in `BEST_STATS` as MAX, negated) and pass `wins: 0` so Classic's wins, streak, openers and distribution are untouched. The Classic guess distribution now spans `dist1`–`dist10` (the sheet shows 1–6, growing to the longest solved game).
- **Lobby, notes, results (Nov 13, `68c2041`):** host lobby is two columns on laptops (players left; mode, a 2-column grid of selects, More settings with strict/hard, Quick Play, crew, Start right); fits 1280×720 and 1024×600 with 5 players, the phone host lobby still scrolls ~330 px. In Counts, tapping your own submitted letters cycles a private note (✓ right place, ~ wrong place, ✕ not in the word, plain; dashed style so it never looks like a real result) and the keyboard key takes the latest note for that letter; browser-only, sessionStorage `lettuce-marks:<code>:<round>`, cleared on a new round. Results modal 560 px (Classic) / 720 px (Counts, Ladder) with players' boards in a grid and the actions pinned at the bottom.
- Tests: `server/test/lettuce-modes.test.ts` (26) and 21 engine tests in `web/lettuce-party/test/engine.test.mjs`. A real Durable Object restart isn't tested (`restore()` on an old snapshot is).

---

## 15. Fast Fingers

Game idea by [Junaid](https://www.linkedin.com/in/junaid-salman-9a6662208/), credited on the games page (corner of its card), in the README, and on the Fast Fingers home screen.

A typing race. Everyone in the room gets the same paragraph at the same moment; type it first, type it right. A wrong key doesn't move you on: the character turns red and stays under the cursor until you hit the right one, so there's nothing to delete, and every wrong key lowers your accuracy. Speed is words per minute (5 characters = 1 word). Server: `server/src/games/fastfingers.ts`. Full rules in the repo's README.

**Modes:**

| Mode | Players | What happens |
| --- | --- | --- |
| **Room race** | 1–8 | After a 3-2-1 countdown everyone types the same paragraph; lanes above the text show how far everyone is and how fast. Latecomers join as watchers and race next time |
| **Daily paragraph** (Nov 18, `e572e73`) | solo | One ~45-word paragraph for everyone each UTC day (`E.dailyText(seed)`: whole sentences of one passage from a seed-picked sentence, wrapping round), medium with capitals and punctuation, run by `server/src/daily/fastfingers.ts`: the text is sent only on start, 3 s countdown, the server starts the clock after it and times the finish (the page's clock only when within −1.5 s/+0.25 s of the server's; impossible speeds refused). Ranked by speed (score = wpm to a tenth); running out of time (`limitMs`) is accepted after the limit and scores under 1. A refresh resumes (position in `localStorage fastfingers.dailyRun`, clock keeps running). Day streak + Dailies + Best daily wpm in the stats sheet (`fast-fingers:streak/bestStreak/lastDay/bestDaily` in `BEST_STATS`). Day 1 = 2026-11-18. Tests: `server/test/fastfingers-daily.test.ts` (5) |
| **Practice** | solo | Runs in the browser with the same settings. No countdown: the clock starts on your first key. Best speed per combination of settings kept in `localStorage fastfingers.best` (key `length-caps-punct`); Enter for the next paragraph, "Same one again" repeats it. Each finished paragraph also adds to your own stats (Practice runs, characters, best wpm) through `POST /api/fast-fingers/practice`; the server works out the wpm itself. Never reaches a leaderboard |

**Flow (the server's state machine):** `lobby → play (countdown → race) → over`, then **Race again** (new paragraph, same settings) or **Change settings** (back to `lobby`). Countdown is 3 s (`TIMES.countdownMs`). A race ends when everyone still here has finished (0.8 s pause, `TIMES.endPauseMs`), or when the clock runs out, or when the host presses **End race now**. Away or left players aren't waited for. The longest a race can last is `limitMs`: 4 s per word (a slow 15 wpm), at least 45 s. After the first finish, everyone else gets `graceMs` = 1.5 × the winner's time, at least 20 s (never longer than the race limit). If nobody typed a character, the screen says "Nobody typed a thing!" and nobody wins.

**Host settings (lobby only; `engine.cleanSettings` throws away anything unexpected):** paragraph length (short about 30 words, medium about 55, long about 100; the race takes whole sentences from the start of a paragraph until it has 20 / 45 / 90 words, `engine.cut`), capital letters on/off (off = everything lower case and caps lock is fine), punctuation on/off (off = letters, numbers and spaces only, hyphens become spaces), crew, and **Open to Quick Play** (§5). The host's own choices are remembered in the browser (`fastfingers.room`, `fastfingers.crew`). Paragraphs: 24 original paragraphs of about 100 words in plain keyboard characters (`js/passages.js`); a room doesn't get the same paragraph twice until it has used all of them. Phones' curly quotes and long dashes count as the plain keys (`engine.normalKey`).

**Scoring and ranking (`engine.rank`, `wpm`, `accuracy`):** finished players first, fastest finish time first; then everyone who didn't finish, by how far they got; ties go to fewer errors. Speed = (characters / 5) per minute, capped at 300 wpm (`MAX_WPM`). Accuracy = right keys / (right keys + wrong keys), as a whole percent. The player who ranks first and has typed at least one character wins; the room keeps a tally of wins and each player's best wpm for the "Wins in this room" line.

**Who sees what:** there are no secrets in a typing race. Everyone gets the same view: the paragraph (empty in the lobby), the phase and timers, every lane (`pos`, `err`, `done`, `ms`, `place`), and the results. Each player's own cursor is kept in their own page so keys feel instant; the lane shows the larger of the page's position and the server's.

**Server checks (`progress()` in `fastfingers.ts`):** only a seated player who has a lane in this race can report; progress only goes forward; it can never be faster than `MAX_CPS` (22 characters a second, about 260 wpm, with 1.5 s slack, `engine.plausible`), so a made-up finish is ignored; the error count can only go up and is capped at 9999. On finishing, the player's own clock is used when it agrees with the server's (not more than 250 ms ahead and not more than 2.5 s behind), because it has no network delay; otherwise the server's time is used. A finish time can never be below the minimum a person could type the paragraph in. Only the host's `start`, `endRace`, `lobby`, `settings`, `crew` and `public` are acted on; settings and public only in the lobby. Watchers' and forged messages are ignored. Paste and drop into the typing box are ignored in the page, and a chunk of more than 12 characters at once doesn't count.

**Message budget:** the page reports progress every 500 ms while typing (and straight away on the last key); the server collects reports and sends the lanes on in batches (`BATCH_MS` = 200 ms, one `state` per player per batch, via `ctx.setTimer('soon', ...)`). Message cap 512 bytes, rate limit 8 per second with a burst of 24. The finish and the start/end of a phase broadcast immediately.

**Crews and stats:** at the end of each race the server writes, per player, `games`, `plays`, `wins`, `finished` (1 if they reached the end), `chars` and `bestWpm` (kept as a maximum, finished runs only), plus the crew totals and a match row. Practice adds `solos`, `plays`, `chars` and `bestWpm`. The settings sheet shows best wpm, room races, wins, practice runs and characters typed (`js/cloud.js`).

**The screen:** a lane per racer (a coloured runner that slides, name, live wpm; "left" or "away" when they aren't there), a stats row for me (wpm, accuracy, time), a status line (Get ready / Go! / Finished, 2nd... / "You're watching this race"), a countdown chip in the last 10 s, and the paragraph laid out one character at a time with a caret that follows the line being typed. An invisible input takes the typing so phone keyboards work (including ones that send a word at a time or hold letters in a "composition"); the sounds (tick, go, wrong key, finish, win) are made on the fly and can be switched off in Settings.

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | Screens and styling |
| `js/engine.js` | Settings, cutting a paragraph to length, the capitals and punctuation options, checking keys, wpm, accuracy, plausibility, time limits, ranking. No DOM or network |
| `js/passages.js` | The 24 paragraphs |
| `js/app.js` | Screens, own typing, lanes, results, the room link (the race runs on the server), and practice (runs here) |
| `js/cloud.js` | Re-exports the shared sign-in and loads my stats from `/api/me/stats` |
| `server/src/games/fastfingers.ts` | The room: countdown, progress checks, finish clock, ranking, saving |
| `test/engine.test.mjs` | Engine tests (11) |
| `server/test/fastfingers.test.ts` | Server checks: only the host starts, impossible progress refused, backwards moves ignored, forged finish clock replaced, latecomer ignored, ranking |

Tested: engine tests (settings, paragraph lengths and endings, options, passage picking, keys incl. curly quotes, speed and accuracy, plausibility, time limits, ranking); a server race with three players plus a latecomer; the Open to Quick Play box in the lobby (light and dark, 375 px); two real practice paragraphs adding to the stats panel. A full typed multi-tab race was not repeated after the move to the server: do one in the real-network round.

## 16. Testing approach (what "tested" meant)

Hassan's bar: **no bug in front of colleagues**. For any room change, test every edge case with real multi-player browser sessions, not just unit tests:

- **Server tests** (`server/test/*.test.ts`, vitest with `@cloudflare/vitest-plugin`, real Durable Objects, Alarms and D1 in the Workers runtime): `server/test/helpers.ts` has `TestClient` (a WebSocket that records messages), `hostRoom()` and `room(game, names)`. Reach into a live room with `runInDurableObject(stub, (i) => i.game.room)` to skip countdowns or force timers (`i.timers.<name> = Date.now()` then `runDurableObjectAlarm`).
- **Browser rounds** against `npm run dev` (http://127.0.0.1:8787) with Playwright, several pages in one context; drive moves through the real UI, or `window.__<game>.link.send({...})` for speed. Test on the live site after deploying too.

- Use Playwright with several pages in one browser context. `sessionStorage` (the tab id) is per page, but `localStorage` is shared, so always type the name before joining.
- Covered so far: joining errors, same names, full room, settings sync, full games on every difficulty with identical tables and standings in every browser, timers and automatic lock-in, End round now, ties, refresh mid-round and during the reveal, leaving and returning, latecomers and spectators, Away players, lost lock-ins, dropped connections, the host leaving, forged messages (ignored), HTML in names, keyboard-only play, storage blocked (private windows), phones down to 360 px, light and dark themes, no scrolling on laptops.
- **Gotchas found while testing** (the PeerJS ones only matter for the legacy GitHub Pages versions):
  - PeerJS 1.5 doesn't call `RTCDataChannel.prototype.send`. To simulate lost messages, patch the connection instance instead: `window.__theliar.S.hostConn.send = () => {}` (restore with `delete …send`).
  - Chrome's DevTools "frozen" lifecycle state doesn't stop the pings, so it can't simulate a sleeping laptop.
  - `pkill -f "<pattern>"` can match and kill the shell that runs it; stop test servers by PID instead (`ss -ltnp | grep :PORT`).
  - Stopping `wrangler dev` by its port can leave its parent wrangler alive, which restarts `workerd` on the inspector port (next start: "Address already in use"). Kill the workerd's parent too (`ps -o ppid= -p <pid>`).
  - Browsers cache ES modules even across reloads: use a no-cache server or a fresh port.
  - Rotten: force a splat in a server room by setting the room's `fuseEnd` and the `fuse` timer to now in a server test (see `server/test/rotten.test.ts`); in practice, `window.__rotten.SOLO.fuseEnd = performance.now()`. Peek at rot stages on one screen by editing `S.view.fuseAge` locally.
  - The Playwright MCP can only save screenshots under the Relay folder (`.playwright-mcp/`), not the scratchpad.
  - An empty GitHub repo clones onto `master`: run `git branch -M main` before the first push, then enable Pages with `gh api -X POST repos/PakDragoon/<repo>/pages -f "source[branch]=main" -f "source[path]=/"`.
  - **`<details>` and box-sizing:** in current Chrome the inside of a `<details>` sits in a `::details-content` box that `*, *::before, *::after { box-sizing: inherit }` can't reach, so everything in **More settings** fell back to content-box and the selects overflowed. Every game's CSS needs `details * { box-sizing: border-box; }` (added to Flipchip, Melon Burst and Rotten; The Liar, Guesstimate and Thulla have no select grid).
  - **Moving an SVG in the DOM replays its CSS animations.** Melon Burst's player list keeps keyed rows and reorders them with CSS `order` instead of re-appending (otherwise every update re-snapped the bands on the mini melons).
  - **Headless screenshots lag CSS animations.** To judge an animation, pause it at a set time: `document.getAnimations().forEach(a => { a.pause(); a.currentTime = 600; })`.
  - **The free PeerJS server rate-limits** after many test rooms in a row ("Couldn't reach the connection server"). Wait a while, or test layout by un-hiding the lobby screen directly.
  - **When the PeerJS cloud is blocked** (Claude Code's sandbox resets the WebSocket with `ERR_CONNECTION_RESET`): `npm install peer@1` in the scratchpad, run `node_modules/.bin/peerjs --port 9123 --path /myapp`, and in Playwright `addInitScript` a `window.Peer` setter that wraps the real class to add `{ host: '127.0.0.1', port: 9123, path: '/myapp', secure: false, config: { iceServers: [] } }`. No game code changes; tabs in one browser connect directly.
  - **Playwright `fullPage` screenshots resize the viewport**, which fires resize listeners (The Liar redraws its Time timeline on resize) and restarts entry animations mid-capture, so elements look missing. Use a tall `setViewportSize` and a plain screenshot instead.
  - Flipchip and Melon Burst rooms keep their state on the server (in solo it's `window.__<game>.H.room`). Thulla's fanned cards overlap, so Playwright clicks get intercepted: click with `el.click()` in `evaluate`.
  - Pages with `confirm()` (Lettuce Party's End round) block Playwright scripts: register `page.on('dialog', d => d.accept())` before clicking.
  - The local `wrangler dev` started from Claude Code stops when its background time limit runs out; restart it with a long timeout.
  - **Background lobby updates and vitest teardown:** rooms tell their Lobby about changes with `ctx.waitUntil`; `server/test/setup.ts` waits 500 ms after each file so a pending call can't fail the run with `EnvironmentTeardownError` (it failed CI once with every test green).
  - **Wait for the view you expect** in server tests (`c.state((s) => ...)`), not just the next view: rated games send an extra view once ratings load, timing-based checks (the flood test) should poll, not `sleep` a fixed time. The machine with several agents running hits load 12–19.
  - Signed-in server paths are tested without Google: `server/test/account.test.ts` signs Firebase-shaped tokens with its own key and answers the Google keys URL from a mocked `fetch`, so the real `verifyFirebase` runs (no test hook in production). In browser rounds, fake `firebase-app.js`/`firebase-auth.js` with Playwright routes.
  - Each player in a browser round needs its **own browser context** when stats or ratings matter: the guest id lives in `localStorage` (one context = one account; a game against yourself is never rated).
  - The per-connection rate limit (8 messages a second, burst 20–24) is hit by a test that plays two games back to back very fast; pause between games.
  - In lobby-only host actions, a host refresh drops their seat (lobby seats go on disconnect) and passes host on; the room's settings survive.
  - **Undefined leftovers after a big move:** run ESLint with only `no-undef` (browser globals, ES modules) over `web/*/js/*.js web/shared/*.js`; the Guesstimate standings bug (Nov 14) was one function deleted while still called.
  - `web/<game>/js/cloud.js` re-exports only what it lists; a page calling a new shared helper (e.g. `api`, `mountDeleteData`) needs it added there.
  - Delete my data's button disarms 7 s after the first tap; a test script must tap twice within that.
  - Parallel agents: give each its own clone, port (`wrangler dev --port N --inspector-port N+100`) and headless Chrome via `playwright-core` (the Playwright MCP browser is shared).
  - Signed-in browser rounds: run the Worker from a scratch copy whose Google key URL in `server/src/auth.ts` points at a local stand-in serving your own public key (never in the repo), fake the Firebase modules with Playwright routes, and sign tokens with the matching private key; each browser context is a separate player. `innerText` returns upper case for CSS-uppercased headings.
  - Server tests that play full games fast on one connection (Thulla rounds) must pace their messages under the rate limit or the room drops the socket when the machine is loaded.

---

## 17. Decisions worth remembering

- **Guesstimate's look:** the first flat version was rejected ("not detailed or polished, HD, geometryish"). What worked was the family home layout, technical-drawing boards with the measured reveal, then a hairline restyle and greyish-black dark theme modelled on screenshots you liked (the idea, not a copy).
- **Scoring:** the halving curve felt luck-based near zero, so it was switched to the softer top (exponent 1.5). Timing was too harsh (1 s off on 8 s scored 25), so it was made gentler with the +2 s cushion.
- **The Liar:** a shared canvas with turns, one liar who knows only the category, "Ready to vote" at everyone but one (so a single holdout can't stall), the caught liar picks from 12 options (no spelling arguments), a steal pays the liar 2 and correct voters still get 1.
- **The Liar's Time mode** (Nov 12): the timing round from Guesstimate, but as a bluff. Everyone stops at once (no turns), the liar gets a 6 s whole-second range, the stops are revealed together for a discussion (60/120/180 s, host's choice) and then the vote. Choices made without your input, easy to change: no last chance (the stops give the target away), targets 3.01–11.99 s, the target can sit anywhere in the range (not always the middle), and who is done only shows once you've stopped (who has started is always visible, at your request). Bug fixed Nov 12 (`f28cb2e`): when the host stopped last, the host's own message moved the room on synchronously and the press handler then redrew the stale timing view, so the host never saw the times. Lesson for every game: after `toHost(...)`, re-render from `S.view`, never a view captured before the call.
- **Same-name seats:** a seat is taken over only by the same tab, the same account or an offline seat, never just by typing someone's name.
- **Games page** at `/office-games`, not the bare domain (kept free for a portfolio).
- **Rotten:** original name and look over a copy of BombParty; Twists (long-word bonus, peel skip, reverse, sudden death) deliberately left out of v1. Your feedback on the first version: the banana wasn't intuitive and nothing showed whose turn it was, so the banana now travels to the holder with rot stages and a turn label; the 2 s shortest turn felt too short (now 5 s by default); the logo should look rotten, melting or acid-dropped, not the plain family tiles.
- **Flipchip:** original name and look (felt board, poker-style two-sided chips) over a copy of any branded version; modes chosen: 2-player rooms with spectators plus vs computer (no same-screen, no winner-stays). Logo feedback: "Flip" as plain text, chips only for CHIP.
- **Melon Burst:** hangman with a watermelon and rubber bands instead of a hanged man; name picked by you. Modes: race (computer picks, 2-8), pick words in both 1 vs 1 and 2 vs 2 (each player has their own melon; in 2 vs 2 teammates alternate as picker and team score is the sum), daily and practice. Letters only (no whole-word solve). Plain English words from a large list. Logo feedback: MEL + a wedge slice for the O + N; BURST must not sit on a single solid explosion shape, but pop with pieces, seeds and wind flying outwards.
- **Move to a server** (Nov 12): browser-to-browser kept the games to the office network. Everything moved to Cloudflare (Workers + Durable Objects + D1, free plan) in one monorepo; AWS later once AdSense can pay for it. Use Cloudflare features fully, keep portability only where it costs nothing (game modules talk only to `RoomCtx`). Stats started fresh in D1; Firebase kept for sign-in only. Working name `office-games` on the free workers.dev address until a brand + domain. Old GitHub Pages versions stay as the fallback until each game passes a real round, then become redirects.
- **Solo stays in the browser** (practice, Flipchip vs computer) and never reaches a leaderboard; dailies on a leaderboard run on the server with a secret seed and one UTC day for everyone.
- **orcavalley.com** (Nov 13, replaces the earlier "stay on workers.dev" call): the whole domain's DNS moved to Cloudflare (Namecheap stays the registrar; every existing record copied as DNS only), ECH turned off on the zone, and the Worker answers on `play.orcavalley.com` as a custom domain. Forced by the ISP ECH block (§3). The workers.dev address still works but is no longer the one to share.

- **Nov 13 batch decisions:** replays in D1 (R2 not enabled); Melon Burst's daily moved to UTC days and a secret seed, old local progress dropped; Guesstimate's restored "streak" is the old day streak; Lettuce Party's stats sheet shown to guests; ratings per round in Thulla with each round counting as one game; bots and friends were the second wave.

---

## 18. Forehead

Everyone has a secret card all the others can see but they can't, like a sticky note on their forehead. `/forehead/`, 2–8 players, server `server/src/games/forehead.ts`, rules `web/forehead/js/engine.js`, decks `web/forehead/words/*.txt` (`Name|alias`; Animals, Food, Everyday objects, Jobs, Famous people, Numbers 1–100 generated). Host settings: deck, round timer (5/8/12 min or off), crew, Open to Quick Play.

Turns in seat order; on your turn do ONE thing (45 s, else skipped): **ask** (typed, max 100 chars) → others **answer** (20 s: Yes / No / Sort of / Don't know, or Yes / No / Higher / Lower for Numbers; only the tally is sent) → **tally** shown to all for 3.5 s (`TIMES.tallyMs`), then the next turn starts by itself; **or Guess my card** (a turn of its own, log entry `guessTurn`, never counts as a question; right = done, wrong = "Not it"). Rooms saved in the old `decide` phase restore as `tally`. Give up any time (two taps, 0 points). Offline 60 s = gave up. Points: `max(2, 12 − questions asked)` + 2 for the round's first right guess (guessing straight away = 14). Guess check: aliases, accents, leading the/a/an, 1 typo at 5+ letters / 2 at 9+, refused if it exactly matches another card; numbers exact (digits or words).

**Ask or guess.** The current player chooses **Ask a question** or **Guess my card** above a shared input. Switching modes keeps the draft and updates the submit button and character limit. A wrong guess still ends the turn. The guesser sees their own submitted text and may see a private **Very close** badge. For word decks, the badge applies to a wrong guess that adds one short word to the complete answer or an alias, such as `IT Support head` for `IT Support`. The scoring and correct-answer matcher are unchanged.

**Room chat.** Text is available in the lobby, during play and after the round. Quick reactions are available during play. The server stores the most recent 30 messages, caps text at 180 characters and rate-limits each sender to one message or reaction per second. Open in-game chat uses more of the available vertical space on taller desktops. Message history scrolls independently and the input and **Send** button stay below it.

**Who sees what.** The server sends a view for each player and withholds their unrevealed card, including when they host or reconnect. It hides questions and other players' wrong guesses that name the viewer's unrevealed card or an alias. In chat, it silently omits matching messages from other players from both live delivery and room history for that viewer. The sender still sees their own message. The filter lifts for a player once their card is revealed. The server tests cover outgoing messages, history and private guess feedback.

**Stats.** `games, plays, wins, guessed, questions, points` plus `fewestQ` (best-of MIN through `GameReport.min` and `statWrites`). Use `?debug` for `window.__forehead`.

**Nov 24 releases.** [Ask/guess and chat](https://github.com/PakDragoon/office-games/pull/1), [chat input spacing](https://github.com/PakDragoon/office-games/pull/2) and [taller chat](https://github.com/PakDragoon/office-games/pull/3).

## 19. A to Zap (Nov 13, BETA)

Letter race. `/a-to-zap/`, 2–8 players, server `server/src/games/atozap.ts`, rules `web/a-to-zap/js/engine.js`, lists `web/a-to-zap/words/*.txt` (name, place, animal, produce, thing, food, job, colour, sport, body; rebuild with `node web/a-to-zap/tools/build-lists.mjs`; Thing is generated from WordNet + common words, the rest hand-written incl. Pakistani names, cities and dishes).

Flow `lobby → pick → play → (review) → results → … → over`: the next player picks a letter (10 s, then random; used letters out; Q/X/Z only with Hard letters) → everyone fills the host's 4–8 categories (60/90/120 s; answers batched every 1.5 s; others see only how many boxes you filled) → **Zap!** (every box filled) gives everyone exactly 10 s more; all submitted locks early; late answers ignored → list answers auto-accepted, unknown ones go to a room vote of up to 60 s (👍/👎; ends as soon as everyone who may vote has voted; not on your own; tie or no votes accepts; `VOTE_MS`, was 20 s until Nov 14) → 10 unique / 5 shared / 0 blank or rejected → results auto-advance after 40 s → standings (points, then 10-pointers). Host settings: categories, time, rounds (5/10/All letters), Hard letters, crew, Open to Quick Play. Stats: `games, wins, plays, rounds, points, unique` + `bestRound` (MAX). Tests: engine 40, `server/test/a-to-zap.test.ts` 48. `?debug` → `window.__atozap`.

## 20. Alzheimer’s (Nov 17, BETA)

Name chosen by Hassan (Claude flagged that a game named after a disease may upset players and AdSense/app-store review; Hassan kept it). `/alzheimers/`, **2 to 8 players in a circle** (`MIN_PLAYERS`/`MAX_PLAYERS`; was 1 vs 1 until `f3dfcf2`): everyone writes 12 things for the next player in seat order, and the circle shifts one more place each round so you write for someone new (`E.circle(ids, game)`, stored as `room.writesFor`; the view sends `writeFor`/`writtenBy`; rooms saved under 1 vs 1 get a circle on restore). Ink cap per player is 10,000 numbers so 8 players' drawings stay cheap to save after every stroke. server `server/src/games/alzheimers.ts`, rules `web/alzheimers/js/engine.js`. Host settings: a new word every **3 / 5 / 8 s** (`pace`, default 5; was 5/8/12 with default 8 until `41cc89c`, an old 12 falls back to 5), each word shows for **1 / 1.5 / 2 s** (`flash`, default 1.5), crew, Open to Quick Play.

Flow `lobby → write → draw → test → result`:
- **write** (2 min): each player types 12 things for the other (`cleanWord`: ≤ 3 words, ≤ 24 chars; repeats refused, `wordsProblem`). Drafts are saved as you type (`{t:'words', list, ready:false}`); **I'm ready** needs 12 different things; **Fill the rest for me** adds random drawable things. When both are ready or time runs out, blanks are filled from The Liar's word list (`fillWords`, imported from `web/the-liar/js/words.js`).
- **draw**: 3-2-1, then word *i* of the list written for you flashes for `flash` ms while box *i* lights up, a new word every `pace` s; after the last word, 10 s more (`drawLength`). You may draw in any box until then; strokes are kept inside the box they start in (`cleanStroke`), sent on pen-up, stored on the server (16,000 numbers per player cap), Undo removes your last stroke. A line still being drawn when the next word arrives stays on screen (`drawMine` re-appends the pen's path after redrawing; before `5ec344d` it vanished until the word after next). The server books a `word` timer for each reveal and sends a word only to the player drawing it and only while it is on screen (`showing`); the page hides it after `shownFor`, and `drawTick` (5× a second) also hides it at that moment, when the next box lights up or when drawing ends, because phones can delay a one-off timer while you draw (`602a7ea`; before, a late timer left the word up until the next word).
- **test** (90 s, switched Nov 17 `e288715` at Hassan's request; it used to be "word shown, tap the box"): your doodles stay, the words don't; your boxes light up one at a time in a random order (`order`, per player) and you **type what you drew there** (`{t:'name', q, text}`; empty = I don't know). The view sends only the box number (`question: { q, box }`), never its word until answered. `nameMatches` (rules file, built on Forehead's `squash`/`tolerance`/`editDistance`): capitals, accents, spaces, punctuation and a leading the/a/an don't matter, plurals count (cat/cats, box/boxes, berry/berries), typos forgiven (1 at 5+ letters, 2 at 9+; 3–4 letter words exact), and an answer that is exactly another of that player's 12 words never counts (no "house" for "mouse"). The server replies `named` with right/wrong and the real word; answered boxes show their word with ✓/✗.
- **result**: 1 point per right box; ties go to the faster test (sum of answer times; not finishing = the full 90 s); a full tie at the top has no winner (`standings`); D1 places follow the same order. Every sheet is shown, ranked (place numbers with 3+ players, "words by …" on each) with the word under each box and ✓/✗ (sent once as a `drawings` message, and again to anyone rejoining). Host: Play again / Change settings. Room score = rounds won.
Stats: `games, wins, plays, points, perfect, drawn` + `best` (MAX, `BEST_STATS 'alzheimers:best'`). Added to `web/shared/friends.js` game names. Tests: engine 13 (`web/alzheimers/test/engine.test.mjs`, incl. the circle for 2–8 players), server 7 (`server/test/alzheimers.test.ts`: a 3-player circle over two rounds, 2-player start, word validation and fill, words only during their flash and only to their drawer, ink clamping/undo, naming boxes leniently with the word never sent first, another of your words never counting, both drawings at the end). `?debug` → `window.__alzheimers`. Played end to end in headless Chrome (1280 light + 375 dark): 12/12 for the player who remembered, no page errors.

## 21. Ludo (Nov 19, BETA)

The traditional board game (generic, public-domain name; our own board and look, nothing taken from the branded apps). `/ludo/`, **2–4 players in four coloured seats** (Red 0, Green 1, Yellow 2, Blue 3, clockwise), anyone else in the room watches (room holds 8). Server `server/src/games/ludo.ts`, rules `web/ludo/js/engine.js`, page `web/ludo/js/app.js` + `board.js` (SVG board, tokens, animations) + `fx.js` (3D die, sounds, confetti). `?debug` → `window.__ludo` (`S`, `link`, `board`).

**Rules engine** (pure, shared by server, page and tests): 15 × 15 grid; colour 0's quarter of the track is written out once and every other colour is a quarter turn of it (`rotCell` / `rotPoint`). A token's `p`: −1 yard, 0–50 track from its own start, 51 only when going round again (capture-before-home), 52–56 home lane, 57 home. `newGame(settings, colours, first)` returns one plain object saved in the room snapshot as is; `roll(g, v)` → phase `move` (with `g.legal`: every move with its `path`, `cap` and the roll it uses, `r` index into `g.rolls` and `v`), or `roll` again (a 6 under `stack`), or `pass` (`passWhy` `nomove` / `sixes`); `pass(g)`; `move(g, c, i, r)`; `standings` / `finish`. `g.events` keeps the last 16 rolls/moves/passes/finishes with `seq` numbers: the page plays them back as animations. Bot: `chooseMove(g, level)`: Easy = any legal move, Normal = `scoreMove` (captures, getting home, entering the lane, leaving the yard, safe squares, threats from rival tokens 1–6 behind). Normal beats Easy ~65%+ (tested).

**Host settings** (`cleanSettings`, defaults in bold): tokens 2/3/**4**; out of the yard on **a 6** / a 1 or 6; another roll for **6**, **capture**, **getting home** (each on/off); **after a 6** (`sixRule`): **roll again first** (`stack`: keep rolling while you get 6s, the rolls wait in `g.rolls`, then use every one, picking which roll each token uses; three 6s lose every waiting roll; rolls with no legal move are dropped; a capture/home earns one more roll once the rolls are used, `g.extra`) / move first (`move`: play each 6 before rolling again); three 6s in a row **lose the turn** / keep rolling; safe squares **stars + starts** / starts / none; **exact roll** on/off; blocks (two of one colour can't be passed or landed on by rivals) **off**; capture before home **off**; time per turn off/10/**15**/30 s; game ends **first home** / every place; **everyone** / 2 vs 2 (partners opposite: Red + Yellow v Green + Blue; needs all four seats; partners never capture each other; a finished player rolls for and moves their partner; a team wins when both are home). The page groups the less common ones under **House rules** with a "the usual / blocks, …" summary and a reset link.

**Room flow**: lobby seat board laid out like the yards (2 × 2): click a free colour to sit (newcomers fill 0, 2, 1, 3 so two players face each other), host adds a bot into a chosen colour, moves/swaps anyone (`seat` host message), bots Easy/Normal/Remove as in other games. Start needs 2 seated (people or bots), first player random. The **server rolls** (`E.die(ctx.random())`); `roll` / `move` carry `seq` so stale clicks are ignored. Timers: `turn` (turn timer, or 60 s idle when the timer is off) → the computer plays that step for them and counts a strike; **3 in a row → `autoplay`** (the computer keeps playing for them, shown as "Computer playing", until they press **I'm back** / act); `step` (1.4 s pause after "no move" / "three 6s"); `bot` (bots, Away players, players offline > 6 s, and a person's **only possible move**, auto-played 0.9 s after the die lands). Offline 60 s mid-game → autoplay. Host: Play again (same seats), Change settings, **End game for everyone** (two taps). Reactions as in Flipchip. Stats per player: `games, plays, wins, captures, captured, home, sixes, rolls` (no best-ofs). Not rated (luck), no daily, no replays.

**The page: look "A, tech no glow"** (Nov 19, Hassan picked it from a mockup of two looks after rejecting both the first glowy tabletop and a plain flat version): crisp hairlines, small radii (`--r: 4px`), the four colours as outlines (yards, lanes, centre) with solid start squares, monospace caps (JetBrains Mono, `--mono`) for codes, labels, statuses and numbers in the game screen (home cards and lobby settings use the other games' fonts, Hassan's call); a small die next to the Ludo title on the home screen rolls every 2.8 s; **no glow, blur, gradients or shadows**; **no stars and no arrows** ("everyone knows the path"): a safe square is tinted like the home lane in its arm (`sq safe c<(floor(abs/13)+1)%4>`). Palette per theme in `:root` (light: `--c0` #f0204a, `--c1` #00b67a, `--c2` #f0a800, `--c3` #1677ff; dark on near-black: #ff3b5c, #19d99a, #ffc928, #3a9bff). Board turned so **your yard is bottom-left** (watchers: the first colour); tokens in the yard drawn 1.35× (`YARD_SCALE` in `board.js`). Highlights only on what you can act on: a dashed ring on tokens that can move (solid on hover/focus/tap), dots along the way and a dashed outline where it lands, a cross on any token it would send home; a dashed outline round the yard whose turn it is. Tokens slide square by square; a captured token slides back to its yard. Layout: a **card per player at the board's corners** (swatch, name, home pips, `2/4 · AUTO|AWAY|1ST`, **its own die showing that player's last roll**, a 2 px timer line, red under 5 s; cards are built once per game in `buildCorners` and updated in place by `renderCorners`, so a rolling die is never re-attached), the board, the **waiting rolls, Roll and the status line** between the bottom cards (waiting rolls are small dice; on your move, tap one to pick which roll the lit tokens use, `S.pickV`; clicking your own die rolls too), and a **side panel** (React, Room, This game's rules, Log with mm:ss times, End game) that becomes **tabs under the board on phones**. The **die** is a flat square of pips edged in the roller's colour: it flicks through faces for ~0.5 s and lands on the server's number (the first 3D cube broke because every update re-attached it mid-roll; never re-parent an animating element on update). Keyboard: Space/Enter (or clicking the die) rolls, 1–4 move that token. Result: a card over the board with places. Home, lobby (a list, one row per colour) and the games-page card use the same look. If states arrive faster than moves play, playback speeds up; a gap longer than the log jumps to the present.

**Gotchas found while testing**: SVG `fill` set by CSS (`.cell`) beats a `fill=` attribute, so gradient fills on lanes/start squares go in `style`; `setLegal` must ignore identical re-sends (every state update called it and wiped a touch player's first tap); Space after clicking a token must still roll (focus stays on the token). Tests: `web/ludo/test/engine.test.mjs` (19, incl. roll-all-first, incl. 1,200 random games under random rules checking invariants), `server/test/ludo.test.ts` (11: picking a waiting roll and a forged roll index, seating, host-only start, teams need 4, server dice and stale/forged rolls, legal moves and capture, no-move pass, single move auto-played, timeouts → autoplay → back, bot timer, full game to the end with wins counted, host seat swap).
