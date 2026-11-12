// Google sign-in and saved scores (Firebase). Loaded only when someone signs in,
// or when this device was signed in last time. Guests never download Firebase.
//
// Uses the same Firebase project as Wordle Party, Thulla, Guesstimate and The Liar, but only the
// rottenCrews and rottenUsers collections, so the other games' data is never read or written here.

// Same Firebase project as Wordle Party. This config is meant to be public; security rules
// and API-key restrictions protect the project.
export const firebaseConfig = {
  apiKey: 'AIzaSyAzZxF9QMPjN3iMIgjycybnHG7a5Va3Fxo',
  authDomain: 'wordle-party-81870.firebaseapp.com',
  projectId: 'wordle-party-81870',
  storageBucket: 'wordle-party-81870.firebasestorage.app',
  messagingSenderId: '782876412988',
  appId: '1:782876412988:web:dbf115a0f2910e9615c739',
  measurementId: '', // Google Analytics, e.g. 'G-XXXXXXXXXX' (see README: Analytics)
};

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const SIGNED_IN_KEY = 'rotten-signed-in';
const CREWS = 'rottenCrews';
const USERS = 'rottenUsers';

export const isConfigured = () => Boolean(firebaseConfig.apiKey && firebaseConfig.appId);

let fb = null;
let loading = null;
let appPromise = null;

// One shared Firebase app for sign-in, scores and analytics.
function firebaseApp() {
  appPromise ||= import(FB + 'firebase-app.js').then((m) =>
    m.getApps().find((a) => a.name === 'rotten') || m.initializeApp(firebaseConfig, 'rotten'));
  return appPromise;
}
let currentUser = null;
const listeners = new Set();

async function load() {
  if (fb) return fb;
  if (!isConfigured()) throw new Error('Firebase isn’t set up yet. Paste the config into js/cloud.js.');
  loading ||= (async () => {
    const [app, authMod, fsMod] = await Promise.all([
      firebaseApp(),
      import(FB + 'firebase-auth.js'),
      import(FB + 'firebase-firestore.js'),
    ]);
    const auth = authMod.getAuth(app);
    const db = fsMod.getFirestore(app);
    fb = { auth, db, A: authMod, F: fsMod };
    authMod.onAuthStateChanged(auth, (u) => {
      currentUser = u && u.providerData.some((p) => p.providerId === 'google.com') ? u : null;
      if (currentUser) track('login', { method: 'Google' });
      try { currentUser ? localStorage.setItem(SIGNED_IN_KEY, '1') : localStorage.removeItem(SIGNED_IN_KEY); } catch {}
      listeners.forEach((cb) => cb(publicUser()));
    });
    return fb;
  })();
  return loading;
}

function publicUser() {
  if (!currentUser) return null;
  return {
    uid: currentUser.uid,
    name: currentUser.displayName || 'Player',
    email: currentUser.email || '',
    photo: currentUser.photoURL || '',
  };
}

export const getUser = () => publicUser();

/** Call once at startup: restores the session if this device was signed in before. */
export function restore() {
  let was = false;
  try { was = localStorage.getItem(SIGNED_IN_KEY) === '1'; } catch {}
  if (was && isConfigured()) load().catch(() => {});
}

export function onUser(cb) { listeners.add(cb); return () => listeners.delete(cb); }

export async function signIn() {
  const { auth, A } = await load();
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  await A.signInWithPopup(auth, provider);
}

export async function signOutUser() {
  if (!fb) return;
  await fb.A.signOut(fb.auth);
}

export function errorText(err) {
  const code = String(err?.code || '');
  if (code.includes('permission-denied')) return 'Saving was refused. The Firestore rules may need publishing (see README).';
  if (code.includes('unavailable') || code.includes('network')) return 'Couldn’t reach the server. Check your internet.';
  if (code.includes('popup-closed') || code.includes('cancelled-popup')) return 'Sign-in was closed before it finished.';
  if (code.includes('popup-blocked')) return 'The sign-in window was blocked. Allow pop-ups for this site and try again.';
  return err?.message ? String(err.message) : 'Something went wrong. Try again.';
}

// ---------- Personal stats ----------

const emptyStats = () => ({ plays: 0, games: 0, wins: 0, words: 0, splats: 0, longest: 0, dailies: 0, lastDaily: '', bestDaily: 0 });

export async function getMyStats() {
  const u = publicUser();
  if (!u) return null;
  const { db, F } = await load();
  const snap = await F.getDoc(F.doc(db, USERS, u.uid));
  return snap.exists() ? { ...emptyStats(), ...snap.data() } : emptyStats();
}

// Every write adds exactly one play (a room game or a daily), so the rules can check it
async function updateMe(change) {
  const u = publicUser();
  if (!u) return false;
  const { db, F } = await load();
  const ref = F.doc(db, USERS, u.uid);
  await F.runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const old = snap.exists() ? { ...emptyStats(), ...snap.data() } : emptyStats();
    tx.set(ref, { ...old, ...change(old), name: u.name.slice(0, 60), photo: u.photo.slice(0, 500), plays: old.plays + 1, updatedAt: F.serverTimestamp() });
  });
  return true;
}

/**
 * Add one finished room game to my stats.
 * game: { won: bool, words: int, splats: int, longest: int (letters in my longest word) }
 */
export function saveMyGame(game) {
  return updateMe((old) => ({
    games: old.games + 1,
    wins: old.wins + (game.won ? 1 : 0),
    words: old.words + Math.max(0, Math.min(500, game.words | 0)),
    splats: old.splats + Math.max(0, Math.min(10, game.splats | 0)),
    longest: Math.max(old.longest, Math.max(0, Math.min(30, game.longest | 0))),
  }));
}

/** Add today's daily (once per day): day is 'YYYY-MM-DD', ms the total time with penalties. */
export function saveMyDaily(day, ms) {
  return updateMe((old) => {
    if (old.lastDaily === day) throw Object.assign(new Error('Today’s daily is already saved.'), { code: 'already-saved' });
    const t = Math.max(1, Math.min(3600000, Math.round(ms)));
    return { dailies: old.dailies + 1, lastDaily: day, bestDaily: old.bestDaily ? Math.min(old.bestDaily, t) : t };
  });
}

// ---------- Crews ----------

export function crewId(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

const emptyCrew = (name) => ({ name: name.trim(), games: 0, players: {}, history: [] });

export async function getCrew(name) {
  const id = crewId(name);
  if (!publicUser() || id.length < 3) return null;
  const { db, F } = await load();
  const snap = await F.getDoc(F.doc(db, CREWS, id));
  return snap.exists() ? snap.data() : emptyCrew(name);
}

/**
 * Host saves one finished game to the crew.
 * game: { room, winner, players: [{ name, place, words, longest }] }
 */
export async function saveCrewGame(name, game) {
  const id = crewId(name);
  if (!publicUser() || id.length < 3) return null;
  const { db, F } = await load();
  const crewRef = F.doc(db, CREWS, id);
  const gameRef = F.doc(F.collection(crewRef, 'games'));
  let saved = null;
  await F.runTransaction(db, async (tx) => {
    const snap = await tx.get(crewRef);
    const old = snap.exists() ? snap.data() : emptyCrew(name);
    const players = { ...(old.players || {}) };
    for (const p of game.players) {
      const key = p.name.trim().toLowerCase().replace(/[.#$/[\]]/g, '_').slice(0, 40);
      const q = players[key] || { name: p.name, games: 0, wins: 0, words: 0 };
      players[key] = { name: p.name, games: q.games + 1, wins: q.wins + (p.place === 1 ? 1 : 0), words: q.words + p.words };
    }
    const history = [{ winner: game.winner, players: game.players.length, at: Date.now() }]
      .concat(old.history || []).slice(0, 20);
    saved = { name: (old.name || name).slice(0, 40), games: (old.games || 0) + 1, players, history, updatedAt: F.serverTimestamp() };
    tx.set(crewRef, saved);
    tx.set(gameRef, { ...game, at: F.serverTimestamp() });
  });
  return { ...saved, updatedAt: null };
}

// ---------- Analytics (Google Analytics through Firebase) ----------
// Loads for everyone (guests too) once measurementId is set, unless the player turns it off
// in Settings. Page views are automatic; the game logs a few events (see README: Analytics).

let analytics = null;
let analyticsLoading = null;
const queued = [];

export const analyticsConfigured = () => isConfigured() && Boolean(firebaseConfig.measurementId);

export function initAnalytics(enabled = true) {
  if (!enabled || !analyticsConfigured() || analyticsLoading) return;
  analyticsLoading = (async () => {
    const [app, A] = await Promise.all([firebaseApp(), import(FB + 'firebase-analytics.js')]);
    if (!(await A.isSupported())) return null;
    analytics = { A, inst: A.getAnalytics(app) };
    queued.splice(0).forEach(([n, p]) => A.logEvent(analytics.inst, n, p));
    return analytics;
  })().catch(() => null);
}

export function setAnalyticsEnabled(on) {
  if (analytics) analytics.A.setAnalyticsCollectionEnabled(analytics.inst, on);
  else if (on) initAnalytics(true);
}

/** Log a custom event. Safe to call any time; does nothing when analytics is off or not set up. */
export function track(name, params = {}) {
  try {
    if (analytics) analytics.A.logEvent(analytics.inst, name, params);
    else if (analyticsLoading && queued.length < 50) queued.push([name, params]);
  } catch {}
}
