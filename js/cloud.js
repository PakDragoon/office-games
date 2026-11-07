// Google sign-in and saved scores (Firebase). Loaded only when someone signs in,
// or when this device was signed in last time. Guests never download Firebase.
//
// Uses the same Firebase project as Wordle Party, but only the thullaCrews and
// thullaUsers collections, so Wordle's data is never read or written here.

// Paste the firebaseConfig object from Wordle Party's js/cloud.js here (it's meant
// to be public; security rules and API-key restrictions protect the project).
export const firebaseConfig = {
  apiKey: '',
  authDomain: 'wordle-party-81870.firebaseapp.com',
  projectId: 'wordle-party-81870',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
  measurementId: 'G-AB12CD34EF', // Google Analytics, e.g. 'G-XXXXXXXXXX' (see README: Analytics)
};

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const SIGNED_IN_KEY = 'thulla-signed-in';
const CREWS = 'thullaCrews';
const USERS = 'thullaUsers';

export const isConfigured = () => Boolean(firebaseConfig.apiKey && firebaseConfig.appId);

let fb = null;
let loading = null;
let appPromise = null;

// One shared Firebase app for sign-in, scores and analytics.
function firebaseApp() {
  appPromise ||= import(FB + 'firebase-app.js').then((m) =>
    m.getApps().find((a) => a.name === 'thulla') || m.initializeApp(firebaseConfig, 'thulla'));
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

// ---------- Personal stats ----------

const emptyStats = () => ({
  rounds: 0, losses: 0, posSum: 0, playersSum: 0, given: 0, received: 0,
});

export async function getMyStats() {
  const u = publicUser();
  if (!u) return null;
  const { db, F } = await load();
  const snap = await F.getDoc(F.doc(db, USERS, u.uid));
  return snap.exists() ? { ...emptyStats(), ...snap.data() } : emptyStats();
}

/**
 * Add one finished round to my stats.
 * r: { pos, players, lost, given, received }
 */
export async function saveMyRound(r) {
  const u = publicUser();
  if (!u) return false;
  const { db, F } = await load();
  const ref = F.doc(db, USERS, u.uid);
  await F.runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const old = snap.exists() ? { ...emptyStats(), ...snap.data() } : emptyStats();
    tx.set(ref, {
      name: u.name.slice(0, 60),
      photo: u.photo.slice(0, 500),
      rounds: old.rounds + 1,
      losses: old.losses + (r.lost ? 1 : 0),
      posSum: old.posSum + r.pos,
      playersSum: old.playersSum + r.players,
      given: old.given + r.given,
      received: old.received + r.received,
      updatedAt: F.serverTimestamp(),
    });
  });
  return true;
}

// ---------- Crews ----------

export function crewId(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export async function getCrew(name) {
  const id = crewId(name);
  if (!publicUser() || id.length < 3) return null;
  const { db, F } = await load();
  const snap = await F.getDoc(F.doc(db, CREWS, id));
  return snap.exists() ? snap.data() : { name: name.trim(), rounds: 0, players: {}, history: [] };
}

/**
 * Host saves one finished round to the crew.
 * round: { room, loser, players: [{ name, pos, lost, given, received }] }
 */
export async function saveCrewRound(name, round) {
  const id = crewId(name);
  if (!publicUser() || id.length < 3) return null;
  const { db, F } = await load();
  const crewRef = F.doc(db, CREWS, id);
  const roundRef = F.doc(F.collection(crewRef, 'rounds'));
  let saved = null;
  await F.runTransaction(db, async (tx) => {
    const snap = await tx.get(crewRef);
    const old = snap.exists() ? snap.data() : { name: name.trim(), rounds: 0, players: {}, history: [] };
    const players = { ...(old.players || {}) };
    for (const p of round.players) {
      const key = p.name.trim().toLowerCase().replace(/[.#$/[\]]/g, '_').slice(0, 40);
      const q = players[key] || { name: p.name, rounds: 0, losses: 0, posSum: 0, given: 0, received: 0 };
      players[key] = {
        name: p.name,
        rounds: q.rounds + 1,
        losses: q.losses + (p.lost ? 1 : 0),
        posSum: q.posSum + p.pos,
        given: q.given + p.given,
        received: q.received + p.received,
      };
    }
    const history = [{ loser: round.loser, players: round.players.length, at: Date.now() }]
      .concat(old.history || []).slice(0, 20);
    saved = {
      name: (old.name || name).slice(0, 40),
      rounds: (old.rounds || 0) + 1,
      players,
      history,
      updatedAt: F.serverTimestamp(),
    };
    tx.set(crewRef, saved);
    tx.set(roundRef, {
      room: round.room,
      loser: round.loser,
      players: round.players,
      at: F.serverTimestamp(),
    });
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
