# Guesstimate

A perception game for the office, in the browser. No rulers, no counting on your fingers: everyone gets the same puzzle at the same moment, then the reveal measures whose eye was sharpest.

Play at `https://pakdragoon.github.io/guesstimate/`.

## The tests

| Test | What you do |
| --- | --- |
| **Count** | Dots flash for a moment. Guess how many there were. |
| **Track** | A ball flies right, bouncing off the top and bottom, and vanishes into the hatched zone. Mark where it hits the right wall. |
| **Angle** | Drag the coloured arm until the angle between it and the grey arm matches the target. Either side of the grey arm works. |
| **Split** | Slide the marker to the point that sits the given fraction (1/3, 37%, 5/7...) of the way along the bar, starting from the round end. |
| **Timing** | Press Start, count in your head, and press Stop when you think the target time (e.g. 3.0 s) has passed. No clock is shown and nothing on screen moves. Pressing Stop locks your guess in. |

During a round the board is plain paper. The reveal turns it into a measured drawing: a grid fades in, the ball's flight draws itself, and rulers, a protractor and dimension lines show the real answer in green next to every player's guess in their own colour.

| | Easy | Normal | Hard |
| --- | --- | --- | --- |
| Count | 8 to 30 dots, 2.5 s | 20 to 80 smaller dots, 1.6 s | 50 to 160 small dots, 1.1 s |
| Track | Slow, gentle angle, more of the flight visible | About 2 bounces | Fast, steep, about 4 bounces, little visible |
| Angle | Multiples of 15°, grey arm flat | Any angle, tilted | Any angle, tilted, short grey arm |
| Split | Halves, thirds, quarters, fifths | Percentages | Percentages or fractions like 5/7, on a tilted bar |
| Timing | Whole seconds, 1 to 6 s | Tenths, 1.0 to 10.0 s | Tenths, 1.0 to 20.0 s |

## Three ways to play

**Rooms (2 to 8 players).**

1. One person types their name and clicks **Host a room**. They get a 4-letter room code.
2. They click **Copy invite link** and send it round (or just say the code).
3. Friends open the link, type their name and click **Join room**.
4. The host picks the difficulty, tests, rounds of each test, time to answer and an optional crew name, then clicks **Start game**.
5. Each round starts with a 3-second countdown for everyone. Players lock in a guess; the scoreboard shows who has locked in, but nobody sees a guess until the reveal. The round ends when everyone has answered or the time runs out (the host can also click **End round now**).
6. The host clicks **Next round** after each reveal. At the end everyone sees the standings; the host can **Rematch** or **Change settings**.

Someone new can join mid-game and plays from the current round.

Timing rounds get extra time to answer when the room has a limit (the target × 1.5 + 8 s, if that's longer), and the countdown clock is hidden during them so nobody can time it off the screen.

**When connections misbehave** (office Wi-Fi, laptops going to sleep):

- **Refresh or close and reopen:** rejoin with the same code and name and you get your seat and points back. A guess you had already locked in still counts.
- **Two people with the same name:** the second becomes "Sara 2". A seat is only taken over by the same browser tab (after a refresh), the same Google account, or once the original seat has gone offline, so nobody can take your seat by typing your name.
- **Closing the tab** leaves the room straight away.
- **Away:** players ping the host every 2 seconds. Someone silent for 9 seconds is shown as Away and the round stops waiting for them; they keep their seat and come back as soon as their connection does.
- **Dropped connection:** a player who stops hearing from the host reconnects by themselves to the same seat and round. A lock-in lost in the drop is sent again. Only if the host has really gone do they see "The room closed".
- **Time running out:** a guess you've placed but not locked in is locked in for you just before the time limit.

**Daily puzzle.** One puzzle of each test (normal), the same for everyone, new at midnight. One go per day; **Share result** copies a spoiler-free summary for your chat:

```
Guesstimate #12: 74/100
🟩🟨🟩🟨🟩
Count 88 · Track 61 · Angle 93 · Split 54 · Timing 84
```

**Practice.** Pick a difficulty and any tests, one of each. Your best average per difficulty is kept in your browser.

## Scoring

Every round is scored from 0 to 100: `100 × 0.5 ^ ((miss ÷ 50-point miss) ^ 1.5)`. Exact is 100 and the 50-point miss scores 50. The curve is flat near the answer, so tiny misses (hand jitter) cost little, and steep further out, so close and sloppy rounds are clearly apart:

| Miss, as a share of the 50-point miss | ¼ | ½ | 1 | 1½ | 2 | 3 |
| --- | --- | --- | --- | --- | --- | --- |
| Points | 92 | 78 | 50 | 28 | 14 | 3 |

| Test | Scores 50 when you're off by |
| --- | --- |
| Count | 20% (double or half the dots are equally wrong) |
| Track | 8% of the wall's height |
| Angle | 6° |
| Split | 3% of the line |
| Timing | 15% of (target + 2 s): 1 s off scores 53 on a 5 s target, 69 on 8 s, 84 on 15 s |

Verdicts: 95+ Spot on!, 80+ Sharp, 60+ Close, 35+ Ballpark, under 35 Way off. In a room, the highest total wins; a tie on total is broken by the best single round.

## How it works

Neither the game nor the rooms need a server of our own. Every puzzle is built from a number (a seed) by `js/rounds.js`, and the same seed draws exactly the same puzzle in every browser. In a room, the host's browser picks the seed and runs the game; other players connect straight to it with PeerJS (WebRTC). Only the seed, the guesses and the scores travel. The host checks each guess before scoring it, since it comes from another browser.

Puzzles are drawn in a fixed 400 × 300 box and scaled to the screen, so a phone and a monitor see the same geometry.

| File | What it does |
| --- | --- |
| `index.html` | Screens and sheets |
| `style.css` | All styling (tokens and font shared with Thulla and Wordle Party) |
| `js/rounds.js` | Seeded puzzle generators, scoring, guess checks and the daily seed. No network or DOM |
| `js/play.js` | Drawing, input and the measured reveal for each test |
| `js/app.js` | Practice, daily, PeerJS rooms (host and players), screens |
| `js/cloud.js` | Firebase sign-in, crew scores, personal stats, analytics |
| `firestore.rules` | Rules for all three games (see below) |
| `test/rounds.test.mjs` | Engine tests: `node test/rounds.test.mjs` |

## Firebase: sign-in, crews and stats

Guesstimate uses the same Firebase project as Wordle Party and Thulla (`wordle-party-81870`), with its own collections. Sign-in is Google only and optional; guests never download Firebase.

| Collection | Written by | Holds |
| --- | --- | --- |
| `guessCrews/{id}` + `/games` | Signed-in host | Crew totals (games, wins, points per player), one record per game |
| `guessUsers/{uid}` | That player | Room games, wins, points per test, daily count, streak and best daily |

- **Crews:** the host types a crew name in the lobby. When a game ends, a signed-in host saves it to the crew.
- **Personal stats:** each signed-in player saves their own stats when a room game ends or they finish the daily. Practice isn't saved.

The domain `pakdragoon.github.io` and the API key's website restriction already cover this game, so sign-in works without console changes.

**Security rules:** Firestore has one rules file for the whole project. The same `firestore.rules` is kept in the Thulla, Guesstimate and The Liar repos and covers all four games (Wordle Party, Thulla, Guesstimate, The Liar). After a change, publish it in Firebase console → Firestore Database → Rules, and keep every repo's copy identical, so publishing any of them keeps every game saving.

## Analytics

Built into `js/cloud.js` like the other games, and off until a `measurementId` is pasted into `firebaseConfig`. Players can opt out in Settings. Events: `room_created`, `room_joined`, `game_started`, `round_finished`, `game_finished`, `daily_finished`, `practice_finished`, `share_result`, `login`. No names, room codes or guesses are sent.

## Testing

- Engine: `node test/rounds.test.mjs` (or `npm test`). It checks that puzzles are deterministic, stay inside the box and that dots never overlap; simulates the Track ball step by step against the formula; checks scoring (exact is 100, closer is never worse, either side counts on Angle); rejects bad guesses from the network; and checks the daily seed and day numbers.
- Locally: `python3 -m http.server 8000`, then open `http://localhost:8000` in several windows with different names. Sign-in on localhost needs `http://localhost:8000/*` on the API key and `localhost` in authorized domains.
- Real check after each deploy: one short room on two phones.

Browser tests (multi-player, via Playwright) covered: joining (bad code, missing room, invite link, same names, full room of 8), lobby settings sync, full games on every difficulty with puzzles, scores and standings identical in every browser, rematch and change settings, the timer with automatic lock-in, End round now, ties, a player leaving mid-round and returning, refresh after locking in and during the reveal, a latecomer, a silent (Away) player, a lost lock-in, a dropped connection reconnecting, the host leaving, forged guesses (ignored), HTML in names (not rendered), keyboard-only play, the daily puzzle, storage blocked (private windows) and phones down to 360px. Open the game with `?debug` to expose its state as `window.__guesstimate` for such tests.

## Known limitations

- **The host's browser runs the room.** Closing or refreshing the host's tab ends it; other players can refresh and rejoin.
- **The host's browser knows the answers** (they're built from the seed), and anyone could work them out in developer tools. It's a game among colleagues.
- **Strict networks** (some offices, universities, mobile carriers) can block the direct PeerJS connection.
- **Crew scores are keyed by player name;** use the same name each time.
- **Daily results** live in this browser; play on the same device to keep your "played today" status. Signed-in players also get a streak in their stats.
