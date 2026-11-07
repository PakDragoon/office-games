# Thulla

The Pakistani card game, for 2 to 8 friends in the browser. Get rid of all your cards. If you can't follow suit, hit someone with a thulla and they pick up the whole trick. The last player holding cards loses.

Play at `https://pakdragoon.github.io/thulla/`.

## How to play

Everyone sits around the table with their own colour, and you're always at the bottom. Cards land in front of whoever played them; a glowing ring shows whose turn it is (and counts down if the timer is on). Your playable cards are outlined green, cards you can play early are outlined amber, and the rest are dimmed.

1. One person types their name and clicks **Host a room**. They get a 4-letter room code.
2. They click **Copy invite link** and send it to up to 7 friends (or just tell them the code).
3. Friends open the link, type their name, and click **Join room**.
4. The host picks the settings and clicks **Start game**.
5. After each round, the host clicks **Play next round** or **End game**. Ending the game shows the final standings, with **Rematch** (same settings) and **Change settings** (back to the lobby).

During a round, the host can click **End round** to stop it for everyone (nobody loses that round).

If someone's page refreshes mid-game, they rejoin automatically, or can rejoin with the same code and name, and get their cards back. Someone who joins while a round is running watches it and is dealt in next round.

## Rules

- One standard 52-card deck is dealt out completely, one card at a time starting with the player after the dealer. When it doesn't divide evenly, the players right after the dealer get one card more. The dealer moves one seat each round.
- Whoever holds the **Ace of Spades** leads the first trick, and must lead it. This happens every round.
- Play goes clockwise. You must follow the suit that was led if you can. Ace is high.
- **First trick:** if you have no spades, play any card. It isn't a thulla; the trick is just discarded.
- **Everyone follows suit:** the trick is discarded face down, and whoever played the highest card of the led suit leads next.
- **Thulla:** after the first trick, if you can't follow suit you play any card. The trick stops right there (players after you don't play), and whoever played the highest card of the led suit picks up every card in the trick and leads next.
- **Getting out:** you're safe once a trick is finished and you have no cards left. Players are ranked in the order they get out.
  - If you play your last card and it's the highest of the led suit, and then someone gives a thulla, you pick the trick up and you're back in.
  - If your thulla is your last card, you're safe.
  - If the player who should lead next is already safe, the next player clockwise who still has cards leads.
- **Losing:** the last player still holding cards loses the round. If the final clean trick empties everyone's hands at once, whoever played the highest card loses, since they would have had to lead.

### Optional: play early

If the host turns this on in the lobby: once a trick has been led, anyone can throw in a card of the led suit before their turn comes (you can't give a thulla early). Your card shows on the table with an "early" tag, and the turn carries on in order, skipping you.

The risk: if a player you jumped ahead of (someone seated before you who hadn't played yet) then gives a thulla, **you** pick up the trick instead of whoever played the highest card. If several people jumped that player, the first one to jump picks it up. Players seated after you aren't affected by your early card.

### Optional: taking the next player's cards

If the host turns this on in the lobby: on any of your turns, before you play your card, you can ask the next player for their whole hand. They have 15 seconds to answer.

- **Give my cards:** all their cards go into your hand, they're safe in the next finishing position, and you still play your turn (following suit with your new hand if a trick is under way).
- **Decline** (or no answer in time): nothing changes and you play normally. You can ask once per turn.

You can't ask when only two players are left, or if the next player already played early in this trick.

### Settings (host, in the lobby)

- **Rounds:** unlimited, 3, 5 or 10. After the last round the final standings appear automatically.
- **Turn timer:** off, 15, 30 or 60 seconds. When time runs out, a card is played for you: the lowest card of the led suit if you can follow, your lowest card if you're leading, or your highest card if you can't follow (a thulla).
- **Play early** and **Take the next player's cards:** see above.
- **Crew name** (optional): saves all-time scores, see below.

If the timer is off and it's an offline player's turn, the host gets a **Play for them** button after 30 seconds.

### Scoring

Each game counts how many times each player lost a round and their finishing positions. **Fewest losses wins the game**; ties go to the better average finishing position. The scoreboard (beside the table on wide screens, behind **Scores** on phones and tablets) also shows thullas given and a list of past rounds.

Players named JD or Junaid get a 🍌 after their name everywhere.

## Accounts, stats and saved scores (Firebase)

- **Sign in with Google** from the gear icon. Guests can play without signing in; their rounds just aren't saved.
- **My stats** (Settings): rounds played, times lost, loss rate, average finishing position, thullas given and received. Each signed-in player saves their own results after every round.
- **Crews:** in the lobby, the host can type a crew name (for example `office-squad`) and click **Use**. Every round played under that name is saved and adds up across rooms in the scoreboard's **All time** table. Saving to a crew needs the host to be signed in.
- **Preferences** (this device only): sounds, high-contrast colors (which also switches to a four-color deck: blue diamonds, green clubs), and single-tap play on phones. By default, on a touch screen the first tap raises a card and a second tap (or the **Play** button) plays it, so a stray tap doesn't throw a card. With a mouse, one click plays.

Tap **?** in the game bar (or **How to play** on the home screen) for a rules summary that matches the room's settings.

Thulla uses the same Firebase project as Wordle Party (`wordle-party-81870`), in separate collections: `thullaCrews` and `thullaUsers`. It never reads or writes Wordle Party's `crews` or `users`.

## Setup

### 1. Firebase config (one time)

Open `js/cloud.js` in the Wordle Party repo, copy its whole `firebaseConfig` object, and paste it over the `firebaseConfig` object near the top of Thulla's `js/cloud.js`. The config is meant to be public; the security rules and API-key restrictions protect the project.

### 2. Security rules (one time, and whenever `firestore.rules` changes)

Firestore has a single set of rules per database, shared by both games. Thulla's `firestore.rules` contains Wordle Party's rules unchanged, plus the Thulla rules.

Firebase console → Firestore Database → **Rules** → replace everything with the contents of Thulla's `firestore.rules` → **Publish**.

From now on, if you change Wordle Party's rules, make the same change in this file too (and the other way round), or publishing one will undo the other.

Nothing else needs changing in Firebase: Google sign-in is already on, `pakdragoon.github.io` is already an authorized domain, and the API key's `https://pakdragoon.github.io/*` restriction already covers `/thulla/`.

### 3. Deploy on GitHub Pages

1. Put these files in the root of `PakDragoon/thulla` and push:
   ```
   index.html
   style.css
   firestore.rules
   README.md
   js/app.js
   js/cloud.js
   js/engine.js
   test/engine.test.mjs
   ```
2. On GitHub, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`, then **Save**.
4. After a minute or two, the game is live at `https://pakdragoon.github.io/thulla/`.

## Run it locally

Browsers block JavaScript modules on `file://` pages, so start a small local server:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a few browser windows with different names. Sign-in on localhost needs `http://localhost:8000/*` in the API key's website restrictions and `localhost` in Firebase's authorized domains.

The rules engine has its own tests (no browser needed): `node test/engine.test.mjs`.

## How it works

There's no backend. The host's browser is the game server:

- It shuffles, deals, holds every hand, checks every move and decides each trick (`js/engine.js` has the rules; `js/app.js` runs the room).
- Other players connect directly to the host's browser using [PeerJS](https://peerjs.com/) 1.5.4 (WebRTC). PeerJS's free public server only introduces the browsers to each other; game data then flows directly between them.
- Each player only ever receives their own cards plus public information: cards on the table, everyone's card count, and whose turn it is.

## Known limitations

- **The host's browser knows every hand.** Someone who opens the developer tools while hosting could look. Play with people you trust, or let a different person host each time.
- **The host has to keep their tab open.** Closing or refreshing it ends the room for everyone (the host's browser warns before leaving).
- **Some strict networks** (some offices, universities, mobile carriers) can block direct connections. Home Wi-Fi almost always works.
- Personal stats are saved by each player's own browser, so a player who closes their tab before a round ends doesn't get that round saved.
- Crew scores are keyed by player name, so use the same name each time.

## Customizing

- **Player limit:** `MAX_PLAYERS` at the top of `js/app.js` (8 colors exist, `--p0` to `--p7` in `style.css`).
- **Timings:** `RESOLVE_MS` (how long a finished trick stays on the table), `TAKE_MS` and `STUCK_MS` at the top of `js/app.js`.
- **Colors and fonts:** the `:root` variables at the top of `style.css`, with dark-mode values below them. Card colors are the `--card-*` and `--suit-*` variables.
