/* =========================================================
   Saved all-time scores ("crews") in Firebase Firestore.
   Only the host's browser uses this. Firebase is loaded on demand,
   the first time a crew is used, so other players never download it.

   Firestore layout:
     crews/{crewId}                running totals for the crew (one document)
     crews/{crewId}/rounds/{id}    one record per finished round
   ========================================================= */

const FIREBASE_VERSION = '10.12.2';

// This config is public by design. The security rules in firestore.rules protect the data.
const firebaseConfig = {
  apiKey: 'AIzaSyAzZxF9QMPjN3iMIgjycybnHG7a5Va3Fxo',
  authDomain: 'wordle-party-81870.firebaseapp.com',
  projectId: 'wordle-party-81870',
  storageBucket: 'wordle-party-81870.firebasestorage.app',
  messagingSenderId: '782876412988',
  appId: '1:782876412988:web:dbf115a0f2910e9615c739',
};

let connecting = null;

function connect() {
  if (!connecting) {
    connecting = (async () => {
      const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
      const [appSdk, authSdk, fs] = await Promise.all([
        import(`${base}/firebase-app.js`),
        import(`${base}/firebase-auth.js`),
        import(`${base}/firebase-firestore.js`),
      ]);
      const app = appSdk.initializeApp(firebaseConfig);
      await authSdk.signInAnonymously(authSdk.getAuth(app));
      return { fs, db: fs.getFirestore(app) };
    })();
    // If it fails, let the next attempt start fresh.
    connecting.catch(() => { connecting = null; });
  }
  return connecting;
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

function playerKey(name) {
  return String(name).trim().toLowerCase();
}

/** Keep only plain data, so it can be sent to the other players. */
function clean(crew) {
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

/** Add one finished round to the crew's running totals. */
function addRound(crew, round) {
  crew.rounds = (crew.rounds || 0) + 1;
  crew.players ||= {};
  for (const p of round.players) {
    const s = (crew.players[playerKey(p.name)] ||= {
      name: p.name, played: 0, wins: 0, solved: 0, guessSum: 0, bestMs: null, streak: 0, bestStreak: 0,
    });
    s.name = p.name;
    s.played += 1;
    if (p.solved) {
      s.solved += 1;
      s.guessSum += p.guesses;
      if (s.bestMs == null || p.ms < s.bestMs) s.bestMs = p.ms;
    }
    if (round.winner && playerKey(round.winner) === playerKey(p.name)) {
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

/** Read a crew's totals. Returns null for a crew that has no rounds yet. */
export async function loadCrew(id) {
  const { fs, db } = await connect();
  const snap = await fs.getDoc(fs.doc(db, 'crews', id));
  return snap.exists() ? clean(snap.data()) : null;
}

/**
 * Save a finished round and update the crew's totals in one transaction,
 * so two rooms finishing at the same moment can't overwrite each other.
 * round = { word, winRule, winner, room, players: [{ name, solved, guesses, ms }] }
 */
export async function saveRound(id, name, round) {
  const { fs, db } = await connect();
  const crewRef = fs.doc(db, 'crews', id);
  const roundRef = fs.doc(fs.collection(db, 'crews', id, 'rounds'));
  const crew = await fs.runTransaction(db, async (tx) => {
    const snap = await tx.get(crewRef);
    const data = snap.exists() ? snap.data() : { players: {}, history: [], rounds: 0 };
    const next = addRound(
      { name, rounds: data.rounds || 0, players: data.players || {}, history: data.history || [] },
      round,
    );
    tx.set(crewRef, { ...next, updatedAt: fs.serverTimestamp() });
    tx.set(roundRef, { ...round, at: fs.serverTimestamp() });
    return next;
  });
  return clean(crew);
}

/** Turn a Firebase error into something a person can act on. */
export function errorText(err) {
  const code = String(err?.code || '');
  if (code.includes('operation-not-allowed') || code.includes('admin-restricted'))
    return 'Anonymous sign-in is turned off in Firebase. See the README to turn it on.';
  if (code.includes('unauthorized-domain'))
    return 'This website isn’t on Firebase’s authorized domains list. See the README.';
  if (code.includes('permission-denied'))
    return 'Firebase refused access. Check the Firestore security rules (see the README).';
  if (code.includes('not-found') || code.includes('failed-precondition'))
    return 'The Firestore database hasn’t been created yet. See the README.';
  if (code.includes('unavailable') || code.includes('network') || err instanceof TypeError)
    return 'Couldn’t reach Firebase. Check your internet connection.';
  return `Couldn’t use the crew (${code || err?.message || 'unknown error'}).`;
}
