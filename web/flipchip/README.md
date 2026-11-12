# Flipchip

A two-player chip-flipping board game for colleagues, in the browser. Put a chip down so it traps a line of your opponent's chips between two of yours, and they all flip to your colour. Most chips when nobody can move wins. Play a colleague in a room (others can watch), or play the computer.

Play at `https://pakdragoon.github.io/flipchip/`.

## How to play

1. One person types their name and clicks **Host a room**. They get a 4-letter room code and click **Copy invite link**.
2. Friends open the link, type their name and click **Join room**. The first one to join sits in the empty seat; anyone after that watches.
3. The two seats are **Dark** (goes first) and **Light**. Anyone can **Sit here** in an empty seat or **Stand up and watch**; the host can **Swap colours**. The host picks the settings and clicks **Start game**.

**Your move.** Place a chip on an empty square so that one or more of your opponent's chips sit in a straight line (across, up and down, or diagonal) between your new chip and another of yours. All of them flip, in every direction at once. You can only go where you trap at least one chip.

**Helping you see it.** Faint dots show where you can go (if the room has them on). Hovering over a dot shows a ghost chip, a **+N** badge and a dashed ring round every chip that would flip. On a phone the first tap shows that preview and a second tap places the chip (a player setting). The last move is marked with a gold dot, the middle line says whose turn it is, and your board and player card glow on your turn.

**No move? You pass.** If you can't trap anything, your turn is skipped automatically and everyone is told.

**The end.** When neither player can move (usually a full board), the one with more chips wins. Players can also **Resign** (two taps).

**Watching.** Everyone who isn't sitting watches the same board live and can send reactions (👏 😮 😂 😬 🔥 🤝) that float over the board for everyone.

## Room settings (host)

| Setting | Options (default first) |
| --- | --- |
| Board | **8 × 8**, 6 × 6 (quick), 10 × 10 (long) |
| Time per move | **No limit**, 15 s, 30 s, 60 s (when the time runs out, a random legal move is played) |
| Show where you can go | **On** (dots and previews), Off |
| Colours after each game | **Swap**, Random, Keep |
| Games | **Play until we stop**, Best of 3, Best of 5 |

Each player's own settings (gear icon): sound, vibration on your turn, showing reactions, placing a chip (automatic: phones tap twice; always tap twice; one tap) and flip animation (on, reduced, off).

## Playing the computer

Pick **Easy**, **Normal** or **Hard**, which colour you play (Dark goes first) and the board size. You get **Undo** (takes back your move and the computer's reply), **Hint** (rings the move Hard would play) and **New game**. A game in progress is saved in the browser, so a refresh or a trip back to the home screen offers **Continue**. Your record against each level is kept in the browser.

| Level | How it plays |
| --- | --- |
| Easy | Grabs chips and corners when it sees them, otherwise plays loosely (beats random play, loses to anyone careful) |
| Normal | Looks two moves ahead with a positional score (corners good, squares next to an empty corner bad), with a little randomness |
| Hard | Searches as deep as it can in about a second (corners, mobility, frontier chips), and plays the last 8 to 12 squares perfectly |

The computer thinks in a Web Worker (`js/ai-worker.js`) so the chips keep flipping smoothly; if workers aren't available it thinks on the page instead.

## When connections misbehave

- **Refresh or close and reopen:** rejoin with the same code and name and you get your seat back, mid-game.
- **Two people with the same name:** the second becomes "Sara 2". A seat is only taken over by the same browser tab (after a refresh), the same Google account, or once the original seat has gone offline.
- **Away:** players ping the host every 2 seconds; someone silent for 9 seconds is shown as Away.
- **Opponent left:** the game waits for them. If they're not back within 45 seconds, the other player gets **Claim the win**. With a time limit, their moves are played randomly when their time runs out, so the game can still finish.
- **Dropped connection:** a player who stops hearing from the host reconnects by themselves. Only if the host has really gone do they see "The room closed".
- **Joining mid-game:** you watch and can sit down after the game.
- The host can **End game for everyone** (two taps) to go back to the lobby.

## How it works

There's no server of our own. The host's browser runs the game: it checks every move (whose turn, legal square, not a stale click) and broadcasts the board. Other players connect straight to the host with PeerJS (WebRTC). Playing the computer runs the same host code locally with a bot in one seat, so rooms and solo games share every rule and screen. Nothing in this game is secret, so every browser gets the whole board.

| File | What it does |
| --- | --- |
| `index.html` | Screens and sheets |
| `style.css` | All styling (tokens and font shared with the other games; felt board and two-sided chips) |
| `js/engine.js` | Rules and the computer player: board, flips, legal moves, passes, winner, settings, Easy/Normal/Hard. No DOM or network |
| `js/ai-worker.js` | Runs the computer player off the page's thread |
| `js/app.js` | Rooms (host and players), seats, the board and its animations, the computer games, screens |
| `js/cloud.js` | Firebase: sign-in, `flipchipCrews`, `flipchipUsers`, analytics |
| `firestore.rules` | Security rules for all six games in the Firebase project |
| `test/engine.test.mjs` | Engine tests (`node test/engine.test.mjs`) |

Adding `?debug` to the address exposes `window.__flipchip = { S, H, E, AI, think }` for automated tests.

## Saved scores (optional)

Google sign-in uses the same Firebase project as Wordle Party, Thulla, Guesstimate, The Liar and Rotten (`wordle-party-81870`).

- **Personal stats** (`flipchipUsers/{uid}`): room games, wins, draws, chips, games and wins against the computer, and the hardest level beaten. Each signed-in player saves their own after every game.
- **Crew scores** (`flipchipCrews/{id}`): the host types a crew name in the lobby; each finished game adds games, wins, draws and chips per player.

**Firestore rules:** `firestore.rules` here covers all six games. Firestore has one rules file per project, so publishing a copy that lacks a game's section breaks that game's saving. Publish this file (Firebase console → Firestore Database → Rules → paste → Publish) and keep the copies in the other repos identical.

## Running locally

```
python3 -m http.server 8000
```

Open `http://localhost:8000` in two or more windows with different names to try a room.
