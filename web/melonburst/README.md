# Melon Burst

A word-guessing party game for colleagues, in the browser. Guess a hidden word one letter at a time. Every wrong letter snaps another rubber band round your watermelon; one band too many and it bursts.

Play at `https://pakdragoon.github.io/melonburst/`.

Game idea by [Rijja](https://www.linkedin.com/in/rijja-farhan-011381214/). Thank you!

## Ways to play

| Mode | Players | Who picks the word |
| --- | --- | --- |
| **Race** (room) | 2 to 8 | The computer picks one word; everyone races to solve it, each on their own melon |
| **Pick words** (room) | 1 vs 1, or 2 vs 2 | Each side picks a secret word for the other side every round, then everyone guesses the other side's word |
| **Daily word** | You | The same everyday word for everyone today (server-run, UTC day, secret seed); one go, global leaderboard, then share |
| **Practice** | You | Word after word (short, medium, long or any length); keep your streak going |

### The melon

Every wrong letter adds a rubber band round the middle. The melon gets squeezed into a peanut shape, its face goes from happy to worried to scared to panicking, it trembles harder, cracks appear one band before the end and juice drips on the last band. One band too many and it bursts (wedges, seeds and juice everywhere; turn the juice off under Settings). Solve it and the bands ping off.

### Points

Solving a word is worth **10**, plus **1 for every band you had to spare**. In a race, the first three to solve get **3, 2 and 1** extra. A burst melon (or running out of time) scores nothing. Most points wins; ties go to most words solved, then the fastest total time. In Pick words, a side's points are its players' points added up.

### Race

The host picks the rounds (3, 5 or 10), word length (short 4–6, medium 6–8, long 8–12 or any) and the word list (everyday words only, or everyday and more). Everyone guesses the same word at the same time. You see how the others are doing (letters found and bands, as mini melons) but not their letters. The round ends when everyone has solved or burst, or time runs out. Latecomers join in from the next round.

### Pick words

Two sides: **1 vs 1**, or **2 vs 2** where teammates take turns picking. Players sit in the lobby (the first to join fill the seats; others watch). Each round:

1. **Pick (60 s):** each side's picker types a secret word for the other side: a real English word of 4 to 12 letters (checked as you type; **Suggest one** if you're stuck). If time runs out, or the picker has left, the computer picks one.
2. **Guess:** everyone guesses the other side's word on their own melon. You can watch the other side guess *your* word, letters and all; your teammate sees your side's word as soon as it's picked. People watching see everything.
3. **Results:** both words, who solved what, and the meaning of the word.

The host chooses how many words each side picks (2, 4 or 6).

### Settings (host)

| Setting | Options (default first) |
| --- | --- |
| Mode | **Race**, Pick words (1 vs 1 / 2 vs 2) |
| Bands before it bursts | **6**, 8 (easy), 5 (tense) |
| Rounds | Race: **5**, 3, 10. Pick words: **4**, 2, 6 words per side |
| Word length (race) | **Any**, Short, Medium, Long |
| Time to guess | **2 minutes**, no limit, 60 s, 90 s, 3 minutes |
| The computer's words | **Everyday and more** (26,000), Everyday only (8,000) |

The host can also **End round now** and **End game** (back to the lobby).

## Words

| File | What it is |
| --- | --- |
| `words/common.txt` | 7,995 everyday words the computer picks (SCOWL sizes 10 and 20) |
| `words/more.txt` | 18,474 more common words it can also pick (SCOWL size 35) |
| `words/valid.txt` | 237,825 words a player may pick for someone else (an-array-of-english-words plus the above) |
| `js/blocked.js` | Words never accepted or picked (the LDNOOBW list; longer bad words also block words containing them) |

SCOWL ([wordlist-english](https://www.npmjs.com/package/wordlist-english)) is split by how common a word is and keeps names in separate lists, so the computer only picks real, reasonably well-known words. Plurals whose singular is on the list are left out of the computer's lists. All words are 4 to 12 letters, a to z only. Rebuild with `node tools/build-words.mjs` (downloads into the git-ignored `tools/.cache/`), then run the tests. Meanings come from the free [dictionaryapi.dev](https://dictionaryapi.dev) when it answers; the game works without it.

## When connections misbehave

- **Refresh or close and reopen:** rejoin with the same code and name and you get your seat, score and guesses back.
- **Two people with the same name:** the second becomes "Sara 2". A seat is only taken over by the same browser tab, the same Google account, or once the original seat has gone offline.
- **Away / left:** a player silent for 9 seconds is shown as Away; rounds stop waiting for players who are away or have left.
- **Dropped connection:** a player who stops hearing from the host reconnects by themselves. Only if the host has really gone do they see "The room closed".
- **The daily word** runs on the server: it keeps your session (a refresh carries on, the clock keeps running) and never sends the word until you've solved or burst. Ranked: solved first, then fewest wrong letters, then fastest time.

## How it works

There's no server of our own. The host's browser runs the game: it holds the words, checks every guess and pick, and sends **each player their own view**, so nobody's browser receives letters or words they shouldn't see (the host's own browser does know them; see Known limits). Other players connect straight to the host with PeerJS (WebRTC). Practice runs the same host code locally; the daily word runs on the server (`server/src/daily/melonburst.ts`).

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | Screens and styling (tokens and font shared with the other games) |
| `js/engine.js` | Rules: settings, word checks, the computer's word picks, guessing, points, ranking, pickers, daily word, share text. No DOM or network |
| `js/melon.js` | The SVG watermelon: bands, squeeze, face, cracks, drips, burst |
| `js/app.js` | Rooms (host and players), per-player views, screens, daily and practice |
| `js/cloud.js` | Firebase: sign-in, `melonCrews`, `melonUsers`, analytics |
| `tools/build-words.mjs` | Builds the word files |
| `firestore.rules` | Security rules for all seven games in the Firebase project |
| `test/engine.test.mjs` | Engine tests (`node test/engine.test.mjs`) |

Adding `?debug` to the address exposes `window.__melonburst = { S, H, E, WORDS }` for automated tests.

**Known limits:** the host's tab must stay open; the host's browser knows the words (visible in developer tools); strict networks can block WebRTC.

## Saved scores (optional)

Google sign-in uses the same Firebase project as the other office games (`wordle-party-81870`).

- **Personal stats** (`melonUsers/{uid}`): room games, wins, rounds, words solved, points, dailies played and solved.
- **Crew scores** (`melonCrews/{id}`): the host types a crew name in the lobby; each finished game adds games, wins, points and words solved per player.

**Firestore rules:** `firestore.rules` here covers all seven games. Firestore has one rules file per project, so publishing a copy that lacks a game's section breaks that game's saving. Publish this file (Firebase console → Firestore Database → Rules → paste → Publish) and keep the copies in the other repos identical.

## Running locally

```
python3 -m http.server 8000
```

Open `http://localhost:8000` in two or more windows with different names to try a room.
