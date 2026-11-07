# Wordle Party

Multiplayer Wordle for up to 5 players. Everyone gets the same word, and you can watch the others' colored tiles fill in live, without seeing their letters.

## How to play

1. One person types their name and clicks **Host a room**. They get a 4-letter room code.
2. They click **Copy invite link** and send it to up to 4 friends (or just tell them the code).
3. Friends open the link, type their name, and click **Join room**.
4. The host clicks **Start game**. The round keeps going until everyone has solved it or run out of guesses. The results then show the word and a ranking. By default the first person to solve it wins; in the lobby the host can switch to **Fewest guesses** instead, where time only breaks ties.
5. Between rounds, the host clicks **Play next round** or **End game**. Ending the game shows the final standings, with **Rematch** (same settings) and **Change settings** (back to the lobby).

After each round, the results show the word's meaning (from the free [Free Dictionary API](https://dictionaryapi.dev/)) and a **Share my result** button that copies an emoji grid.

Before starting, the host picks:

- **Who wins a round:** first to solve it (default), or fewest guesses with time breaking ties.
- **Rounds:** unlimited, 3, 5 or 10. After the last round, the final standings appear automatically.
- **Time limit:** none, or 1, 2, 3 or 5 minutes per round. Anyone still guessing when time runs out is marked "Out of time".
- **Hard mode:** every revealed hint must be used in later guesses.
- **Crew name** (optional): saves all-time scores, see below.

During a round, the host can also click **End round** to stop it for everyone, for example if someone walked away.

Scores carry over for every round played in the same room: wins, rounds solved, average guesses and fastest time, plus a list of past words. On wide screens they show beside your board; on phones and tablets, tap **Scores** in the top bar.

If someone's page refreshes mid-game, they can rejoin with the same code and the same name and get their board and scores back.

## Accounts, stats and saved scores (Firebase)

- **Sign in with Google** from the gear icon (home, lobby or in-game). Guests can play without signing in; their rounds just aren't saved.
- **My stats** (Settings): rounds played, rounds won, average guesses, current and best win streak, fastest solve, a guess-count chart, and your favorite opening word. Each signed-in player saves their own results.
- **Crews:** in the lobby, the host can type a crew name (for example `office-squad`). Every round played under that name is saved and adds up across rooms in the scoreboard's **All time** table. Saving to a crew needs the host to be signed in.
- **Preferences** (this device only): sounds, and high-contrast colors.

Firebase setup for project `wordle-party-81870` (one time, in the [Firebase console](https://console.firebase.google.com)):

1. **Google sign-in:** Build → Authentication → Sign-in method → Google → Enable, pick a support email, Save. (Anonymous sign-in is no longer used and can be turned off.)
2. **Authorized domains:** Authentication → Settings → Authorized domains → make sure `pakdragoon.github.io` is listed.
3. **Database:** Build → Firestore Database, Standard edition, database ID `(default)`, production mode.
4. **Security rules:** Firestore Database → Rules → replace everything with `firestore.rules` → Publish. Do this again whenever `firestore.rules` changes.
5. **Restrict the API key** in the [Google Cloud console](https://console.cloud.google.com/apis/credentials) → Browser key (auto created by Firebase):
   - Application restrictions → Websites: `https://pakdragoon.github.io/*` and `https://wordle-party-81870.firebaseapp.com/*` (the second is needed for the Google sign-in window). Add `http://localhost:8000/*` for local testing.
   - API restrictions → Restrict key → Identity Toolkit API, Token Service API, Cloud Firestore API.

The Firebase config in `js/cloud.js` is meant to be public; the security rules and key restrictions protect the project. Saved rounds can't be edited or deleted from the game. To reset a crew or a profile, delete its document in the Firebase console.

## Deploy on GitHub Pages

1. Put these files in the root of the repo and push:
   ```
   index.html
   style.css
   firestore.rules
   js/app.js
   js/cloud.js
   js/words.js
   ```
2. On GitHub, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`, then **Save**.
4. After a minute or two, the game is live at `https://pakdragoon.github.io/wordle/`.

## Run it locally

Browsers block JavaScript modules on `file://` pages, so double-clicking `index.html` won't work. Start a small local server instead:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`. You can test multiplayer by opening it in a few browser windows. Use different names in each.

## How it works

There's no backend. The host's browser acts as the server:

- It picks the secret word, checks every guess, and works out the colors.
- Other players connect directly to the host's browser using [PeerJS](https://peerjs.com/) (WebRTC). PeerJS's free public server only introduces the browsers to each other, and game data then flows directly between them.
- Players other than the host only ever receive color patterns. Their letters and the secret word aren't sent until the round ends.

Trade-offs to know about:

- **The host has to keep their tab open.** Closing it ends the room for everyone.
- **Some strict networks** (some offices, universities, mobile carriers) can block direct connections. Home Wi-Fi almost always works.
- **The host could find the word** in their browser's developer tools if they went looking.

## Customizing

- **Word list:** when someone hosts a room, their browser downloads the word lists (other players don't need them, since only the host checks guesses). The secret word comes from the official NYT Wordle answer list, about 2,300 common words. A guess is accepted if any of these knows it: the NYT Wordle guess list ([`wordles`](https://www.npmjs.com/package/wordles)), the community Wordle list ([tabatkins/wordle-list](https://github.com/tabatkins/wordle-list)), or the 5-letter words in a general English dictionary ([`an-array-of-english-words`](https://www.npmjs.com/package/an-array-of-english-words)). The lobby shows how many words loaded. If every download fails, the built-in lists in `js/words.js` are used, which you can extend by pasting in more words separated by spaces. Answers don't repeat within a room until every possible answer has been played. Swear words, slurs and other offensive words are never picked as the answer, though they can still be typed as guesses. The game combines `BLOCKED_ANSWERS` in `js/words.js` with the public [LDNOOBW](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) list; add words to `BLOCKED_ANSWERS` to block more. The host can also untick **Only accept words from the word list** in the lobby to allow any 5 letters.
- **Player limit:** change `MAX_PLAYERS` at the top of `js/app.js`. Above 5, add a `--p5` color in `style.css` and a matching `.rival.c5` rule for each extra player.
- **Colors and fonts:** all in the `:root` variables at the top of `style.css`, with separate dark-mode values below them.
