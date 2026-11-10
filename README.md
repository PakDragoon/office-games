# The Liar

A drawing game for 3 to 8 colleagues, in the browser. Everyone draws the same secret word, one line at a time. One of you doesn't know it and is bluffing with every stroke. Find the liar.

Play at `https://pakdragoon.github.io/the-liar/`.

## How to play

1. One person types their name and clicks **Host a room**. They get a 4-letter room code and click **Copy invite link**.
2. Friends open the link, type their name and click **Join room**. The game needs at least 3 players.
3. The host picks the settings and clicks **Start game**.

**Your card.** Everyone gets a secret word and its category, except one player: **the liar**, who only sees the category. Cards are hidden behind **Hold to see your card**, so the person next to you can't read your screen. Press **I'm ready** (or wait 15 seconds).

**Drawing.** Players take turns adding to one shared drawing, in a random order that stays the same for all 3 rounds. The liar is never first, so there's always something on the paper before they draw. Everyone draws in their own colour and watches each line appear live. You get a chime and a buzz when it's your turn.

- **One line** (host setting): pen down, draw, lift. You have 15 seconds to start and 10 seconds for the line.
- **Free draw** (host setting): as many strokes as you like for 5, 8, 12, 15, 20 or 30 seconds.

Draw enough to prove you know the word, but not so much that the liar can work it out.

**Ready to vote.** Anyone can press it at any time. When everyone but one has pressed it, the drawing stops and the vote starts. Otherwise the vote starts after round 3.

**The vote.** Pick who you think the liar is (45 seconds). Point at a name to see only that player's lines. The most votes is accused; a tie accuses nobody.

**Last chance.** If the liar is accused, they pick the secret word from 12 options in its category (30 seconds). Pick right, and they steal the win.

**Points.**

| What happened | Points |
| --- | --- |
| Liar caught (and can't name the word) | 2 to everyone else |
| Liar gets away (wrong person accused, or a split vote) | 3 to the liar |
| Liar caught but names the word | 2 to the liar |
| You voted for the liar | 1 extra, whatever happens |

After each game everyone sees the word, the liar, who voted for whom and the points, and can **Replay drawing** (line by line, in the order it was drawn) or **Save picture** as a PNG. The host clicks **Next game** (a new word and liar, never the same liar twice running) or **Change settings**.

## Words

1,584 words in 31 categories, all things you can draw: Food, Desi food, Drinks, Fruit & veg, Animals, Birds, Sea life, Bugs, Office, Home, Kitchen, Clothing, Sports, Cricket, Transport, Jobs, Places, Pakistan, Nature, Tech, Music, Tools, School, Fantasy, Space, Celebrations, Body, Feelings, Toys, Actions and Symbols. The host can play all of them or pick categories.

A room never repeats a word, and the host's browser remembers the last 700 words it used, so repeats are rare even across days. Words live in `js/words.js`; add a word to the right category and the tests check it for duplicates.

## When connections misbehave

- **Refresh or close and reopen:** rejoin with the same code and name and you get your seat, your card and the drawing back.
- **Two people with the same name:** the second becomes "Sara 2". A seat is only taken over by the same browser tab (after a refresh), the same Google account, or once the original seat has gone offline.
- **Closing the tab** leaves the room straight away. If it was your turn, the turn moves on.
- **Away:** players ping the host every 2 seconds. Someone silent for 9 seconds is shown as Away: their turns are skipped and they don't count towards "Ready to vote" or the vote. They come back as soon as their connection does.
- **Dropped connection:** a player who stops hearing from the host reconnects by themselves to the same seat. Only if the host has really gone do they see "The room closed".
- **Joining mid-game:** you watch the drawing (no card, no vote) and play from the next game.

## How it works

There's no server of our own. The host's browser runs the game: it picks the word and the liar, sends each player only their own card, relays every line live and counts the votes. Other players connect straight to it with PeerJS (WebRTC). The host checks everything that arrives: only the current drawer's ink counts (cleaned and kept inside the sheet), votes must be for another player in the game, and only the accused liar can guess, from the 12 options.

The drawing is an 800 × 600 sheet scaled to each screen, so lines land in the same place on a phone and a monitor.

| File | What it does |
| --- | --- |
| `index.html` | Screens and sheets |
| `style.css` | All styling (tokens and font shared with the other games) |
| `js/words.js` | The word list |
| `js/engine.js` | Game rules: picking words and the liar, turn order, "Ready to vote", tally, points, cleaning ink. No network or DOM |
| `js/sketch.js` | The drawing: pen, live strokes, highlighting a player, replay, PNG export |
| `js/app.js` | Rooms (host and players), phases and screens |
| `js/cloud.js` | Firebase sign-in, crew scores, personal stats, analytics |
| `firestore.rules` | Rules for all four games (see below) |
| `test/engine.test.mjs` | Rules tests: `node test/engine.test.mjs` |

## Firebase: sign-in, crews and stats

Same Firebase project as the other games (`wordle-party-81870`), with its own collections. Sign-in is optional; guests never download Firebase.

| Collection | Written by | Holds |
| --- | --- | --- |
| `liarCrews/{id}` + `/games` | Signed-in host | Crew totals (games, points, times as liar, liar wins per player), one record per game |
| `liarUsers/{uid}` | That player | Games, points, liars caught, times as the liar, times got away, right votes |

**Security rules:** Firestore has one rules file for the whole project. The same `firestore.rules` is kept in the Thulla, Guesstimate and The Liar repos; it covers all four games. After a change, publish it in Firebase console → Firestore Database → Rules, and keep every repo's copy identical.

## Testing

- Rules: `node test/engine.test.mjs` (or `npm test`). It checks the word list (size, no duplicates, every category big enough), word picking without repeats, the liar's options, turn order (liar never first), the liar never repeating, the vote threshold, tallies and ties, every outcome and its points, and cleaning ink from the network.
- Browser tests (multi-player, via Playwright) covered: joining and the 3-player minimum, one-line and free-draw turns, the drawing being identical in every browser, hold to peek, vote now, all three outcomes, replay and save, next game, refresh mid-game, the drawer leaving mid-turn, rejoining, joining mid-game as a spectator, forged ink, votes and guesses (ignored), a dropped connection, Away players being skipped, same names, the host leaving, light and dark themes, and phones. Open the game with `?debug` to expose its state as `window.__theliar` for such tests.
- Locally: `python3 -m http.server 8000`, then open `http://localhost:8000` in three windows with different names.

## Known limitations

- **The host's browser runs the room** and knows the word and the liar (visible in developer tools). Closing or refreshing the host's tab ends the room.
- **Strict networks** (some offices, universities, mobile carriers) can block the direct PeerJS connection.
- **Crew scores are keyed by player name;** use the same name each time.
