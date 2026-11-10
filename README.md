# Rotten

A word game for 2 to 8 colleagues, in the browser. You get a few letters; type a word that has them to pass the banana on. Nobody knows when it will splat, so be quick, and don't be holding it when it does.

Play at `https://pakdragoon.github.io/rotten/`.

## How to play

1. One person types their name and clicks **Host a room**. They get a 4-letter room code and click **Copy invite link**.
2. Friends open the link, type their name and click **Join room**. The game needs at least 2 players.
3. The host picks the settings and clicks **Start game**. A 3-2-1 countdown starts it.

**Your turn.** Players sit round a table and one of them holds the banana. The holder gets 2 or 3 letters, like **AN**, and types any word with those letters together (b**an**ana, pl**an**et). A good word passes the banana to the next player with new letters. Everyone sees the holder type live, with the letters picked out.

**Splat.** The banana splats at a random moment the room can't see. It browns and gets spots as it ages, which is a clue, not a clock. Whoever holds it loses a life; the banana moves on to the next player. At 0 lives you're out and watch. The last player standing wins.

**Bonus life.** Use every letter of the alphabet across your words and you get a life back. The **You** panel (and the built-in keyboard) shows which letters you've used.

**Words.** A word can only be played once. Plurals and *-ing* / *-ed* forms count as the same word (banana then bananas is a repeat) unless the host changes it.

## Room settings (host)

| Setting | Options (default first) |
| --- | --- |
| Lives | **3**, 1, 2, 5 |
| The banana lasts | **Normal (10 to 30 s)**, Fast (5 to 15 s), Relaxed (20 to 45 s) |
| Letters | **Normal**, Easy, Hard, Ramp up (easy for the first 8 words, normal to 20, then hard) |
| Words | **English**, English + Roman Urdu, Roman Urdu |
| Show the timer | **Hidden (the colour is the clue)**, Show the countdown |
| Shortest word | **4 letters**, 3, 5 |
| Bonus life | **A to Z**, A to Z without Q, X, Z, Off |
| Most lives | **Start + 1**, Same as start, No limit |
| Games | **Play until we stop**, Best of 3, Best of 5 |
| Letter length | **2 or 3 letters**, 2, 3 |
| After a splat | **Keep the same letters**, New letters (letters always change after 2 splats in a row) |
| At least 2 s per turn | **On**, Off (when the banana is passed with under 2 seconds left, the holder gets 2) |
| No repeated words | **Within a game**, For the whole room |
| Plurals and -ing forms | **Count as a repeat**, Count as new words |
| Typing hints | **Say "not a word" while typing**, Off (find out when you send) |

Each player's own settings (gear icon): sound (ticking, splats, your turn), vibration on your turn, showing what others type, splat animation (on, reduced, off) and keyboard (automatic: built-in on phones; your device's keyboard; built-in).

## On your own

- **Daily puzzle:** the same 10 letter sets for everyone each day (normal letters, English, 4+ letters), seeded from the date. Your score is your total time; each skip adds 10 seconds. **Share result** copies e.g. `Rotten #3: 41.2s` plus a square per letter set (🍌 under 5 s, 🟨 under 15 s, 🟫 slower, ⬛ skipped). One try per day; leaving halfway keeps your progress. Day 1 is 2026-11-10.
- **Practice:** endless letters with a banana and no lives. A splat ends your streak; the best streak is kept in the browser.

## Words

| File | What it is |
| --- | --- |
| `words/en.txt` | 274,813 English words ([an-array-of-english-words](https://www.npmjs.com/package/an-array-of-english-words)), a-z only |
| `words/ur.txt` | 3,613 Roman Urdu words, built from `tools/urdu-source.txt` (common words, plus verb roots expanded into forms like karo, karna, karega) |
| `js/prompts.js` | English letter prompts by difficulty, and the blocked-word list |

Roman Urdu has no fixed spelling, so words are compared loosely: doubled letters, ee/i, oo/u, w/v, q/k and an *h* after a consonant are folded together, so khana, khaana and kana (or theek and thik) all count, and count as the same word for repeats.

A prompt's difficulty is how many common English words (Google's 20k list, 5+ letters) contain it, so every prompt has answers normal people know. Easy is 300+ words for 2 letters or 70+ for 3; normal is 80 to 300 or 22 to 70; hard is 15 to 80 or 7 to 22. Roman Urdu prompts are split into thirds by how common they are in the Urdu list. Swear words from the [LDNOOBW list](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) are never accepted.

To change the lists, edit `tools/urdu-source.txt` (or the settings at the top of `tools/build-words.mjs`) and run `node tools/build-words.mjs`. It downloads the source lists once into `tools/.cache/` (git-ignored) and rewrites the three files above. Then run the tests.

## When connections misbehave

- **Refresh or close and reopen:** rejoin with the same code and name and you get your seat and lives back.
- **Two people with the same name:** the second becomes "Sara 2". A seat is only taken over by the same browser tab (after a refresh), the same Google account, or once the original seat has gone offline.
- **Away:** players ping the host every 2 seconds. Someone silent for 9 seconds is shown as Away and skipped; if they're holding the banana it moves on without costing a life. They come back as soon as their connection does.
- **Left the game:** someone whose tab has been closed for 20 seconds is out of that game, so the others can finish.
- **Dropped connection:** a player who stops hearing from the host reconnects by themselves to the same seat. Only if the host has really gone do they see "The room closed".
- **Joining mid-game:** you watch and play from the next game.

## How it works

There's no server of our own. The host's browser runs the game: it holds the hidden splat time, picks the letters, checks every word against its copy of the word lists and broadcasts a public view. The splat time is never sent to other players (unless the room shows the timer); they only get how old the banana is, which drives its colour. Other players connect straight to the host with PeerJS (WebRTC). Everyone downloads the word lists (about 700 KB compressed) so typing hints work without asking the host.

| File | What it does |
| --- | --- |
| `index.html` | Screens and sheets |
| `style.css` | All styling (tokens and font shared with the other games) |
| `js/engine.js` | Game rules: settings, checking words, Roman Urdu spelling, repeats, prompts, turn order, bonus letters, the daily. No network or DOM |
| `js/prompts.js` | Generated prompt lists (see Words) |
| `js/banana.js` | The banana: ageing colour and spots, the splat |
| `js/keys.js` | The built-in keyboard |
| `js/app.js` | Rooms (host and players), screens, daily and practice |
| `js/cloud.js` | Firebase sign-in, crew scores, personal stats, analytics |
| `firestore.rules` | Rules for all five games (see below) |
| `tools/build-words.mjs` | Builds the word files |
| `test/engine.test.mjs` | Rules tests: `node test/engine.test.mjs` |

## Firebase: sign-in, crews and stats

Same Firebase project as the other games (`wordle-party-81870`), with its own collections. Sign-in is optional; guests never download Firebase.

| Collection | Written by | Holds |
| --- | --- | --- |
| `rottenCrews/{id}` + `/games` | Signed-in host | Crew totals (games, wins and words per player), one record per game |
| `rottenUsers/{uid}` | That player | Plays, games, wins, words, splats, longest word, dailies, best daily time |

**Security rules:** Firestore has one rules file for the whole project. The same `firestore.rules` is kept in the Thulla, Guesstimate, The Liar and Rotten repos; it covers all five games. After a change, publish it in Firebase console → Firestore Database → Rules, and keep every repo's copy identical. Until the version with the Rotten section is published, Rotten's saving shows "Saving was refused" (the game itself works).

## Testing

- Rules: `node test/engine.test.mjs` (or `npm test`). It checks the word lists, settings, the fuse ranges, every way a word can be refused, plurals and stems, Roman Urdu spellings, prompt bands (every hard prompt has 30+ answers), turn order, bonus letters, the daily, and 2,000 random games ending with one survivor.
- Browser tests (multi-player, via Playwright) covered: hosting and joining, settings syncing to guests, valid, invalid and repeated words, live typing, hints, splats and elimination, game over and best-of-3 counts, refreshing mid-game, a late joiner watching, the holder closing their tab (banana moves on) and being removed after 20 seconds, Roman Urdu rooms, the daily (tapping the built-in keyboard, skipping, sharing) and practice, phones and dark mode. Open the game with `?debug` to expose its state as `window.__rotten`.
- Locally: `python3 -m http.server 8000`, then open `http://localhost:8000` in two windows with different names.

## Known limitations

- **The host's browser runs the room** and knows the splat time (visible in developer tools). Closing or refreshing the host's tab ends the room. If the host's tab sits in the background, browsers slow its timers, so splats can be late; the host should keep the tab in front.
- **Strict networks** (some offices, universities, mobile carriers) can block the direct PeerJS connection.
- **The Roman Urdu list is small** next to the English one, so some real words will be refused. Add them to `tools/urdu-source.txt`.
- **Crew scores are keyed by player name;** use the same name each time.
