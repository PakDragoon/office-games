# Fast Fingers

A typing race for friends. Everyone in the room gets the same paragraph at the same moment: type it first, type it right. Or practise on your own.

**Play:** https://pakdragoon.github.io/fast-fingers/ · part of the [office games](https://pakdragoon.github.io/office-games/)

⌨️ Game idea by [Junaid](https://www.linkedin.com/in/junaid-salman-9a6662208/).

## How it plays

- **Rooms (1 to 8 players):** one player hosts and shares the 4-letter code or the invite link. After 3, 2, 1 everyone types the same paragraph. Lanes above the text show how far everyone is and how fast they're going.
- **A wrong key doesn't move you on.** The character turns red until you hit the right one, so there's nothing to delete. Every wrong key lowers your accuracy.
- **Speed** is words per minute, where five characters count as one word.
- **The host's choices:** paragraph length (short, about 30 words; medium, about 55; long, about 100), capital letters on or off, punctuation on or off.
- **A race ends** when everyone has finished. Once the first player is done, the others get 1.5 times the winner's time on top (at least 20 seconds). Whoever hasn't finished is ranked by how far they got. The host can also press **End race now**.
- **Latecomers** watch the race in progress and are in the next one.
- **On your own:** practice with the same choices. No countdown: the clock starts on your first key. Your best speed for each combination of settings is kept in the browser. Enter starts the next paragraph.

## How it works

A static site: plain HTML, CSS and ES modules, no build step, no server of its own.

- The host's browser is the "server". It picks the paragraph, runs the countdown, checks every progress report (it can only go forward, and never faster than a person can type) and broadcasts the lanes. Players connect to it directly with [PeerJS](https://peerjs.com/) (WebRTC).
- Each player's own typing is handled in their browser so keys feel instant; progress goes to the host four times a second and straight away on finishing.
- Same reliability layer as the other office games: refresh and you get your seat and your progress back, a closed tab leaves the room, quiet players are marked Away and not waited for, guests reconnect on their own, and they're told if the host has gone.
- Practice runs the same host code locally, with no connection.
- Firebase (the shared `wordle-party-81870` project) is only for optional Google sign-in, saved crew scores and personal stats. Guests never download it.

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | Screens and styling |
| `js/passages.js` | The 24 paragraphs (all original, plain keyboard characters) |
| `js/engine.js` | Settings, cutting a paragraph to length, the capitals and punctuation options, checking keys, speed, accuracy, time limits, ranking. No page or network code |
| `js/app.js` | Rooms, typing, lanes, results, practice |
| `js/cloud.js` | Firebase: sign-in, `fastCrews`, `fastUsers`, analytics |
| `firestore.rules` | Rules for all eight office games (see below) |
| `test/engine.test.mjs` | Engine tests |

## Running it

```
python3 -m http.server 8000
```

Open `http://localhost:8000` in a few windows with different names. Add `?debug` to the address to expose `window.__fastfingers = { S, H, E, R }` for automated tests.

```
node test/engine.test.mjs
```

## Adding paragraphs

Add a string to `js/passages.js`. Keep it to about 100 words in plain keyboard characters, with the first one or two sentences making a good short race (20 to 50 words) and the first few a medium one (45 to 85). The tests check all of this.

## Saved scores (Firestore rules)

Firestore has one rules file for the whole project. `firestore.rules` in this repo covers **all eight games** (the seven earlier sections are unchanged, plus `fastCrews` and `fastUsers`). Publish it in the Firebase console (Firestore Database → Rules → paste → Publish). Until then, signed-in players see "Saving was refused" for crew scores and stats; the game itself works.

## Analytics

Off until a `measurementId` is set in `js/cloud.js`. Events: `room_created`, `room_joined`, `game_started`, `game_finished`, `practice_started`, `login`.
