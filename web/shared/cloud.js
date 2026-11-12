// Google sign-in (Firebase Auth) and the games' own API, shared by every game on this site.
// Firebase is loaded only when someone signs in, or when this browser was signed in last time:
// guests never download it. Scores and stats live on our server now, not in Firestore.

// This config is meant to be public; Auth's authorized domains and API-key restrictions protect it.
export const firebaseConfig = {
  apiKey: 'AIzaSyAzZxF9QMPjN3iMIgjycybnHG7a5Va3Fxo',
  authDomain: 'wordle-party-81870.firebaseapp.com',
  projectId: 'wordle-party-81870',
  storageBucket: 'wordle-party-81870.firebasestorage.app',
  messagingSenderId: '782876412988',
  appId: '1:782876412988:web:dbf115a0f2910e9615c739',
  measurementId: '', // Google Analytics, e.g. 'G-XXXXXXXXXX'
};

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const SIGNED_IN_KEY = 'og.signedIn';
const GUEST_KEY = 'og.guest';

export const isConfigured = () => Boolean(firebaseConfig.apiKey && firebaseConfig.appId);

let appPromise = null;
let fb = null;
let loading = null;
let currentUser = null;
const listeners = new Set();
let analytics = null;
let analyticsLoading = null;
const queued = [];

// One Firebase app for every game, so signing in once signs you in everywhere on this site
function firebaseApp() {
  appPromise ||= import(FB + 'firebase-app.js').then((m) =>
    m.getApps().find((a) => a.name === 'office-games') || m.initializeApp(firebaseConfig, 'office-games'));
  return appPromise;
}

async function load() {
  if (fb) return fb;
  if (!isConfigured()) throw new Error('Sign-in isn’t set up.');
  loading ||= (async () => {
    const [app, A] = await Promise.all([firebaseApp(), import(FB + 'firebase-auth.js')]);
    const auth = A.getAuth(app);
    fb = { auth, A };
    A.onAuthStateChanged(auth, (u) => {
      currentUser = u && u.providerData.some((p) => p.providerId === 'google.com') ? u : null;
      if (currentUser) track('login', { method: 'Google' });
      try { currentUser ? localStorage.setItem(SIGNED_IN_KEY, '1') : localStorage.removeItem(SIGNED_IN_KEY); } catch {}
      listeners.forEach((cb) => cb(publicUser()));
      // A guest who just signed in keeps their stats. Listeners hear about the user again once the merge is done,
      // so every game's stats panel redraws with the merged numbers.
      if (currentUser) mergeGuest().then((merged) => { if (merged) listeners.forEach((cb) => cb(publicUser())); });
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

/** Call once at startup: restores the session if this browser was signed in before. */
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

/** A fresh Firebase ID token for the server to check, or null for guests. */
export async function getIdToken() {
  if (!currentUser) return null;
  try { return await currentUser.getIdToken(); } catch { return null; }
}

// ---------- Guests ----------
// The server hands every guest a signed id the first time they join a room; it identifies
// their stats from then on, across all the games on this site.

export function getGuest() {
  try { return localStorage.getItem(GUEST_KEY) || ''; } catch { return ''; }
}

export function setGuest(token) {
  try { localStorage.setItem(GUEST_KEY, String(token)); } catch {}
}

export function clearGuest() {
  try { localStorage.removeItem(GUEST_KEY); } catch {}
}

// ---------- Guest -> Google merge ----------
// After a Google sign-in, if this browser holds a guest token, the server moves that guest's stats, daily results
// and sessions onto the account (POST /api/me/merge needs both the Google token and the guest token).
// On success the guest token is DROPPED: its rows no longer exist, and a signed-in browser should have exactly one
// identity. If the account is signed out later, the next call simply makes a brand-new guest. If the merge fails
// (offline, server error) the token is kept and the merge is tried again on the next page load while signed in.
// A guest token the server rejects as invalid (e.g. SERVER_SECRET was rotated) is useless, so it is dropped too.
let merging = null;

function mergeGuest() {
  merging ||= (async () => {
    const guest = getGuest();
    if (!currentUser || !guest) return false;
    try {
      await api('/api/me/merge', { method: 'POST' });
    } catch (err) {
      if (err.code === 'bad-guest' && getGuest() === guest) clearGuest();
      return false;
    }
    if (getGuest() === guest) clearGuest();
    return true;
  })().finally(() => { merging = null; });
  return merging;
}

// ---------- Our API ----------

async function ensureGuest() {
  if (getGuest()) return;
  const res = await fetch('/api/guest', { method: 'POST' });
  if (res.ok) setGuest((await res.json()).token);
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = await getIdToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  else await ensureGuest();
  const guest = getGuest();
  if (guest) headers['X-Guest'] = guest;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data && data.code;
    throw err;
  }
  return data;
}

export function errorText(err) {
  const code = String(err?.code || '');
  if (err?.status === 401) return 'Play a room game first, or sign in, to start saving stats.';
  if (code.includes('unavailable') || code.includes('network') || err instanceof TypeError) return 'Couldn’t reach the server. Check your internet.';
  if (code.includes('popup-closed') || code.includes('cancelled-popup')) return 'Sign-in was closed before it finished.';
  if (code.includes('popup-blocked')) return 'The sign-in window was blocked. Allow pop-ups for this site and try again.';
  return err?.message ? String(err.message) : 'Something went wrong. Try again.';
}

// ---------- Analytics (off until a measurementId is set) ----------

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


// ---------- Delete my data ----------
// One helper for every game's Settings sheet. The server deletes this player (the account and/or the guest this
// browser holds) from every table; then this browser forgets the guest token, the saved names, crews and local
// stats/progress of ALL the games on this site (they share one origin), and signs out of Google.
// Settings (sound, animations...) are kept: they aren't about you. Crew scoreboards are shared tables keyed by the
// names typed in the room, so they keep those names (the Settings text says so).

/** Everything the games save in this browser about the player. Add a game's new stats/progress key here. */
const LOCAL_DATA_KEYS = [
  'fastfingers.name', 'fastfingers.crew', 'fastfingers.best',
  'melonburst.name', 'melonburst.crew', 'melonburst.best', 'melonburst.daily',
  'flipchip.name', 'flipchip.crew', 'flipchip.record', 'flipchip.solo',
  'rotten.name', 'rotten.crew', 'rotten.daily', 'rotten.practiceBest',
  'theliar.name', 'theliar.crew',
  'guesstimate.name', 'guesstimate.crew', 'guesstimate.best',
  'thulla-name',
  'wordleparty-name', 'wordleparty-crew',
];

/** Delete everything held about this player, here and on the server. Throws (and changes nothing) if the server can't. */
export async function deleteMyData() {
  const wasSignedIn = Boolean(currentUser);
  // Never delete only the guest while the person believes their account is going: no token, no delete.
  if (wasSignedIn && !(await getIdToken())) throw new Error('Couldn’t confirm your sign-in. Sign in again, then retry.');
  try {
    await api('/api/me', { method: 'DELETE' });
  } catch (err) {
    // A guest token the server no longer recognises (the secret was rotated) can't be tied to any stored rows,
    // so there's nothing the server could delete for it: carry on and forget it here.
    if (!(err.code === 'bad-guest' && !wasSignedIn)) throw err;
  }
  clearGuest();
  for (const k of LOCAL_DATA_KEYS) { try { localStorage.removeItem(k); } catch {} }
  if (wasSignedIn) { try { await signOutUser(); } catch {} }
  return { wasSignedIn };
}

const DELETE_COPY = {
  idle: 'Deletes your stats and daily results from every Office Games game, and wipes the names and records this browser saved. Crew scoreboards keep the names typed in them: they aren’t tied to you.',
  armed: 'This can’t be undone. Leave any room first, or a game still running will save its stats again. Tap the button again to delete, or wait a few seconds to cancel.',
};

/**
 * Fill `el` with the "Delete my data" control: a button that needs two taps (never window.confirm) and a plain-English
 * result line. `onDone()` runs after a successful delete so the game can redraw its stats and account box.
 * `btnClass` is that game's own button style ("btn ghost", "btn ghost small"...); the red outline comes from `.delete-data`.
 */
export function mountDeleteData(el, { onDone, btnClass = 'btn ghost' } = {}) {
  el.classList.add('delete-data');
  el.textContent = '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `${btnClass} delete-data-btn`;
  const note = document.createElement('p');
  note.className = 'small-note muted delete-data-note';
  note.setAttribute('role', 'status');
  el.append(btn, note);
  let timer = 0;
  const idle = () => {
    clearTimeout(timer);
    btn.classList.remove('sure');
    btn.disabled = false;
    btn.textContent = 'Delete my data';
    btn.dataset.armed = '';
  };
  const arm = () => {
    btn.classList.add('sure');
    btn.textContent = 'Tap again to delete everything';
    btn.dataset.armed = '1';
    note.textContent = DELETE_COPY.armed;
    timer = setTimeout(() => { idle(); note.textContent = DELETE_COPY.idle; }, 7000);
  };
  btn.addEventListener('click', async () => {
    if (!btn.dataset.armed) { arm(); return; }
    clearTimeout(timer);
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      const { wasSignedIn } = await deleteMyData();
      idle();
      note.textContent = wasSignedIn
        ? 'Done. Your stats and daily results are deleted, this browser has forgotten you, and you’re signed out.'
        : 'Done. The stats and daily results saved for this browser are deleted, and it has forgotten you.';
      if (onDone) onDone();
    } catch (err) {
      idle();
      note.textContent = `Nothing was deleted. ${err.status === 401 ? 'Your sign-in didn’t check out. Sign in again, then retry.' : errorText(err)}`;
    }
  });
  idle();
  note.textContent = DELETE_COPY.idle;
}
