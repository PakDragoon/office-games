/* =========================================================
   Firebase: Google sign-in, crews (all-time scores for a group)
   and personal profiles. Loaded on demand, so guests who never
   sign in never download Firebase.

   Firestore layout:
     crews/{crewId}                running totals for a crew (written by the host)
     crews/{crewId}/rounds/{id}    one record per round played as that crew
     users/{uid}                   a signed-in player's own totals (written by that player)
     users/{uid}/games/{id}        one record per round that player played
   ========================================================= */

const FIREBASE_VERSION = '10.12.2';

// This config is public by design. Security rules and API key restrictions protect the project.
const firebaseConfig = {
  apiKey: 'AIzaSyAzZxF9QMPjN3iMIgjycybnHG7a5Va3Fxo',
  authDomain: 'wordle-party-81870.firebaseapp.com',
  projectId: 'wordle-party-81870',
  storageBucket: 'wordle-party-81870.firebasestorage.app',
  messagingSenderId: '782876412988',
  appId: '1:782876412988:web:dbf115a0f2910e9615c739',
};

let loading = null;
let user = null;
const listeners = new Set();

function load() {
  if (!loading) {
    loading = (async () => {
      const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
      const [appSdk, authSdk, fs] = await Promise.all([
        import(`${base}/firebase-app.js`),
        import(`${base}/firebase-auth.js`),
        import(`${base}/firebase-firestore.js`),
      ]);
      const app = appSdk.initializeApp(firebaseConfig);
      const auth = authSdk.getAuth(app);
      await new Promise((resolve) => {
        let first = true;
        authSdk.onAuthStateChanged(auth, (u) => {
          user = u ? { uid: u.uid, name: u.displayName || 'Player', email: u.email || '', photo: u.photoURL || '' } : null;
          try { localStorage.setItem('wordleparty-signedin', user ? '1' : ''); } catch {}
          for (const fn of listeners) fn(user);
          if (first) { first = false; resolve(); }
        });
      });
      return { authSdk, auth, fs, db: fs.getFirestore(app) };
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/** Call fn(user) now and whenever sign-in changes. user is null when signed out. */
export function onUser(fn) {
  listeners.add(fn);
  fn(user);
}

/** Restore a previous sign-in when the page opens (only loads Firebase if they signed in before). */
export function restore() {
  let was = '';
  try { was = localStorage.getItem('wordleparty-signedin') || ''; } catch {}
  if (was) load().catch((e) => console.warn('Restoring sign-in failed', e));
}

export function currentUser() {
  return user;
}

export async function signIn() {
  const { authSdk, auth } = await load();
  const provider = new authSdk.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  await authSdk.signInWithPopup(auth, provider);
}

export async function signOut() {
  const { authSdk, auth } = await load();
  await authSdk.signOut(auth);
}

async function signedIn() {
  const sdk = await load();
  if (!user) throw Object.assign(new Error('Not signed in'), { code: 'wp/not-signed-in' });
  return sdk;
}

/** "Office Squad!" -> "office-squad" */
export function crewId(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const key = (name) => String(name).trim().toLowerCase();

/* ---------------- crews ---------------- */

function cleanCrew(crew) {
  if (!crew) return null;
  return {
    name: crew.name,
    rounds: crew.rounds || 0,
    players: Object.values(crew.players || {}).map((p) => ({
      name: p.name,
      played: p.played || 0,
      wins: p.wins || 0,
      solved: p.solved || 0,
      guessSum: p.guessSum || 0,
      bestMs: p.bestMs ?? null,
      streak: p.streak || 0,
      bestStreak: p.bestStreak || 0,
    })),
    history: (crew.history || []).map((h) => ({ word: h.word, winner: h.winner ?? null, at: h.at || 0 })),
  };
}

function addRoundToCrew(crew, round) {
  crew.rounds = (crew.rounds || 0) + 1;
  crew.players ||= {};
  for (const p of round.players) {
    const s = (crew.players[key(p.name)] ||= {
      name: p.name, played: 0, wins: 0, solved: 0, guessSum: 0, bestMs: null, streak: 0, bestStreak: 0,
    });
    s.name = p.name;
    s.played += 1;
    if (p.solved) {
      s.solved += 1;
      s.guessSum += p.guesses;
      if (s.bestMs == null || p.ms < s.bestMs) s.bestMs = p.ms;
    }
    if (round.winner && key(round.winner) === key(p.name)) {
      s.wins += 1;
      s.streak += 1;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
    } else {
      s.streak = 0;
    }
  }
  crew.history = [{ word: round.word, winner: round.winner, at: Date.now() }, ...(crew.history || [])].slice(0, 20);
  return crew;
}

export async function loadCrew(id) {
  const { fs, db } = await signedIn();
  const snap = await fs.getDoc(fs.doc(db, 'crews', id));
  return snap.exists() ? cleanCrew(snap.data()) : null;
}

/** round = { word, winRule, hard, winner, room, players: [{ name, uid, solved, guesses, ms }] } */
export async function saveRound(id, name, round) {
  const { fs, db } = await signedIn();
  const crewRef = fs.doc(db, 'crews', id);
  const roundRef = fs.doc(fs.collection(db, 'crews', id, 'rounds'));
  const crew = await fs.runTransaction(db, async (tx) => {
    const snap = await tx.get(crewRef);
    const data = snap.exists() ? snap.data() : {};
    const next = addRoundToCrew(
      { name, rounds: data.rounds || 0, players: data.players || {}, history: data.history || [] },
      round,
    );
    tx.set(crewRef, { ...next, updatedAt: fs.serverTimestamp() });
    tx.set(roundRef, { ...round, at: fs.serverTimestamp() });
    return next;
  });
  return cleanCrew(crew);
}

/* ---------------- personal profiles ---------------- */

function cleanProfile(p) {
  return {
    games: p?.games || 0,
    wins: p?.wins || 0,
    solved: p?.solved || 0,
    guessSum: p?.guessSum || 0,
    bestMs: p?.bestMs ?? null,
    streak: p?.streak || 0,
    bestStreak: p?.bestStreak || 0,
    dist: Array.from({ length: 6 }, (_, i) => (p?.dist && p.dist[i]) || 0),
    openers: p?.openers || {},
  };
}

export async function loadProfile() {
  const { fs, db } = await signedIn();
  const snap = await fs.getDoc(fs.doc(db, 'users', user.uid));
  return cleanProfile(snap.exists() ? snap.data() : null);
}

/** game = { word, room, solved, guesses, ms, won, opener } */
export async function saveGame(game) {
  const { fs, db } = await signedIn();
  const me = user;
  const userRef = fs.doc(db, 'users', me.uid);
  const gameRef = fs.doc(fs.collection(db, 'users', me.uid, 'games'));
  return fs.runTransaction(db, async (tx) => {
    const snap = await tx.get(userRef);
    const p = cleanProfile(snap.exists() ? snap.data() : null);
    p.games += 1;
    if (game.solved) {
      p.solved += 1;
      p.guessSum += game.guesses;
      p.dist[game.guesses - 1] += 1;
      if (p.bestMs == null || game.ms < p.bestMs) p.bestMs = game.ms;
    }
    if (game.won) {
      p.wins += 1;
      p.streak += 1;
      p.bestStreak = Math.max(p.bestStreak, p.streak);
    } else {
      p.streak = 0;
    }
    if (game.opener) p.openers[game.opener] = (p.openers[game.opener] || 0) + 1;
    tx.set(userRef, { ...p, name: me.name, photo: me.photo, updatedAt: fs.serverTimestamp() });
    tx.set(gameRef, { ...game, at: fs.serverTimestamp() });
    return p;
  });
}

/* ---------------- errors ---------------- */

export function errorText(err) {
  const code = String(err?.code || '');
  if (code === 'wp/not-signed-in') return 'Sign in with Google (in Settings) to save scores.';
  if (code.includes('popup-closed') || code.includes('cancelled-popup')) return 'Sign-in was cancelled.';
  if (code.includes('popup-blocked')) return 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';
  if (code.includes('operation-not-allowed')) return 'Google sign-in is turned off in Firebase. See the README.';
  if (code.includes('unauthorized-domain')) return 'This website isn’t on Firebase’s authorized domains list. See the README.';
  if (code.includes('api-key') || code.includes('requests-from-referer') || code.includes('referer'))
    return 'The Firebase API key restrictions block this site. See the README.';
  if (code.includes('permission-denied')) return 'Firebase refused access. Check the Firestore security rules (see the README).';
  if (code.includes('not-found') || code.includes('failed-precondition'))
    return 'The Firestore database hasn’t been set up yet. See the README.';
  if (code.includes('unavailable') || code.includes('network') || err instanceof TypeError)
    return 'Couldn’t reach Firebase. Check your internet connection.';
  return `Something went wrong with Firebase (${code || err?.message || 'unknown error'}).`;
}
