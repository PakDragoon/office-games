# Wordle Trio

Multiplayer Wordle for up to 3 friends. Everyone gets the same word, and you can watch the others' colored tiles fill in live, without seeing their letters.

## How to play

1. One person types their name and clicks **Host a room**. They get a 4-letter room code.
2. They click **Copy invite link** and send it to two friends (or just tell them the code).
3. Friends open the link, type their name, and click **Join room**.
4. The host clicks **Start game**. When everyone has solved it or run out of guesses, the results show the word and a ranking: fewest guesses first, then fastest time.
5. The host clicks **Play another round** for a new word.

If someone's page refreshes mid-game, they can rejoin with the same code and the same name and get their board back.

## Deploy on GitHub Pages

1. Put these files in the root of the repo and push:
   ```
   index.html
   style.css
   js/app.js
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

Then open `http://localhost:8000`. You can test multiplayer by opening it in two or three browser windows. Use different names in each.

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

- **Word list:** `js/words.js` has `ANSWERS` (possible secret words) and `EXTRA_GUESSES` (other words accepted as guesses). Add words by pasting them into those strings, separated by spaces. The host can also untick **Only accept words from the word list** in the lobby to allow any 5 letters.
- **Player limit:** change `MAX_PLAYERS` at the top of `js/app.js`. Add a `--p3` color in `style.css` and a matching `.rival.c3` rule if you go above 3.
- **Colors and fonts:** all in the `:root` variables at the top of `style.css`, with separate dark-mode values below them.
