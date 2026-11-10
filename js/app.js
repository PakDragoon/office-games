import * as E from './engine.js';
import * as cloud from './cloud.js';
import { createBanana, stageOf } from './banana.js';
import { createKeyboard } from './keys.js';
import { meltingLogo } from './logo.js';

/* =========================================================
   Rotten
   Players sit round a table and pass a banana that's going off. The holder gets 2 or 3
   letters and must type a word containing them to pass it on. The banana splats at a
   random moment nobody can see: whoever holds it loses a life. Last one standing wins.
   One player hosts: their browser is the "server". It holds the hidden timer, checks
   every word and broadcasts a public view. Connections use PeerJS (WebRTC).
   ========================================================= */

const PREFIX = 'rotten-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PEER_OPTIONS = { debug: 1 };
const PING_MS = 2000;
const AWAY_MS = 9000;
const LOST_MS = 12000;
const TICK_MS = 520;

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ---------- This browser only ---------- */
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`rotten.${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`rotten.${key}`, JSON.stringify(value)); } catch { /* not saved */ }
  },
};
const PREFS = { sound: true, vibrate: true, typing: true, anim: 'on', kbd: 'auto', analytics: true, ...store.get('prefs', {}) };
let ROOM_PREFS = E.cleanSettings(store.get('room', {}));
const PRACTICE = { difficulty: 'normal', words: 'en', ...store.get('practice', {}) };
const savePrefs = () => store.set('prefs', PREFS);
const saveRoomPrefs = () => store.set('room', ROOM_PREFS);

// Identifies this tab to the host: survives a refresh, different for every person
const CLIENT_ID = (() => {
  const fresh = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  try {
    let id = sessionStorage.getItem('rotten.client');
    if (!id) { id = fresh(); sessionStorage.setItem('rotten.client', id); }
    return id;
  } catch { return fresh(); }
})();

/* ---------- Word lists (everyone loads them: the host checks words, players get hints) ---------- */
const WORDS = { lex: E.makeLexicon(), ready: false, failed: false, promise: null };
function loadWords() {
  WORDS.promise ||= Promise.all([
    fetch('words/en.txt').then((r) => { if (!r.ok) throw new Error('en'); return r.text(); }),
    fetch('words/ur.txt').then((r) => { if (!r.ok) throw new Error('ur'); return r.text(); }),
  ]).then(([en, ur]) => {
    WORDS.lex = E.makeLexicon(en.split('\n').filter(Boolean), ur.split('\n').filter(Boolean));
    WORDS.ready = true;
    WORDS.failed = false;
    wordsLoaded();
  }).catch((err) => {
    console.warn('Word lists failed to load', err);
    WORDS.failed = true;
    WORDS.promise = null;
    wordsLoaded();
  });
  return WORDS.promise;
}

/* ---------- Screens, sheets, messages ---------- */
const SCREENS = ['home', 'lobby', 'game', 'solo'];
function showScreen(name) {
  SCREENS.forEach((s) => { $(s).hidden = s !== name; });
  window.scrollTo(0, 0);
}

let openSheet = null;
function open(id) {
  close();
  openSheet = $(id);
  if (id === 'settings') renderSettings();
  openSheet.hidden = false;
  $('scrim').hidden = false;
  openSheet.querySelector('[data-close]').focus();
}
function close() {
  if (!openSheet) return;
  openSheet.hidden = true;
  $('scrim').hidden = true;
  openSheet = null;
  focusAnswer();
}
document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-open]');
  if (opener) open(opener.dataset.open);
  if (e.target.closest('[data-close]') || e.target === $('scrim')) close();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

let toastTimer = 0;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
}
function showNotice(title, text) {
  $('notice-title').textContent = title;
  $('notice-text').textContent = text;
  $('notice').hidden = false;
  $('notice-ok').focus();
}
$('notice-ok').addEventListener('click', () => { $('notice').hidden = true; });
const homeError = (text) => { $('home-error').textContent = text; };

/* ---------- Sounds (made on the fly, no files) ---------- */
let audio = null;
function ctx() {
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
  return audio;
}
function tone(freq, start, dur, vol = 0.16, type = 'sine') {
  const a = ctx();
  if (!a) return;
  const t = a.currentTime + start;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
const SOUND = {
  turn() {
    if (PREFS.vibrate && navigator.vibrate) navigator.vibrate(90);
    if (PREFS.sound) { tone(660, 0, 0.25); tone(880, 0.11, 0.28); }
  },
  tick() { if (PREFS.sound) tone(1500, 0, 0.03, 0.035, 'square'); },
  ok() { if (PREFS.sound) { tone(520, 0, 0.12, 0.12, 'triangle'); tone(780, 0.06, 0.16, 0.12, 'triangle'); } },
  nope() { if (PREFS.sound) tone(150, 0, 0.18, 0.12, 'sawtooth'); },
  bonus() { if (PREFS.sound) [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.07, 0.2, 0.12, 'triangle')); },
  splat() {
    if (PREFS.vibrate && navigator.vibrate) navigator.vibrate([60, 40, 120]);
    if (!PREFS.sound) return;
    const a = ctx();
    if (!a) return;
    // A wet thud: filtered noise plus a falling low note
    const len = Math.floor(a.sampleRate * 0.35);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = buf;
    f.type = 'lowpass';
    f.frequency.value = 900;
    g.gain.value = 0.5;
    src.connect(f).connect(g).connect(a.destination);
    src.start();
    const o = a.createOscillator(), og = a.createGain(), t = a.currentTime;
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.3);
    og.gain.setValueAtTime(0.3, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(og).connect(a.destination);
    o.start(t);
    o.stop(t + 0.36);
  },
};

/* =========================================================
   Hosting
   ========================================================= */
const S = {
  myName: '', myId: null, isHost: false, peer: null, hostConn: null, code: '', view: null, leaving: false,
  heard: 0, reconnecting: false, gameShown: -1, wordSeen: -1, splatSeen: -1, holderSeen: null, savedGame: -1,
  typing: '', typingFor: null, sentTyping: '', pending: '', viewAt: 0, refreshTimer: 0,
};
const H = { room: null, conns: new Map(), seen: new Map(), fuseTimer: 0, phaseTimer: 0, rnd: Math.random };

function randomCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

function hostCreate(attempt = 0) {
  const code = randomCode();
  const peer = new Peer(PREFIX + code, PEER_OPTIONS);
  let opened = false;
  peer.on('open', (id) => {
    opened = true;
    Object.assign(S, { peer, myId: id, isHost: true, code, leaving: false, gameShown: -1 });
    H.conns.clear();
    H.rnd = E.mulberry32(E.randomSeed());
    const u = cloud.getUser();
    H.room = {
      code, status: 'lobby', settings: { ...ROOM_PREFS }, game: 0,
      players: [newPlayer(id, S.myName, true, 0, u?.uid || null, u?.photo || '')],
      order: [], holder: null, prompt: '', promptSplats: 0, recent: [], bands: null,
      startAt: 0, fuseStart: 0, fuseEnd: 0, pausedUntil: 0,
      wordsPlayed: 0, used: new Set(), roomUsed: new Set(), log: [], wordSeq: 0,
      lastSplat: null, splatSeq: 0, winner: null, matchWinner: null,
      crew: null, crewStatus: '',
    };
    peer.on('connection', hostOnConnection);
    cloud.track('room_created');
    setBusy(false);
    hostBroadcast();
    const savedCrew = store.get('crew', '');
    if (savedCrew) hostSetCrew(savedCrew);
  });
  peer.on('error', (err) => {
    if (!opened && err.type === 'unavailable-id' && attempt < 5) {
      peer.destroy();
      hostCreate(attempt + 1);
      return;
    }
    if (!opened) {
      setBusy(false);
      homeError(peerErrorText(err));
      peer.destroy();
    } else {
      console.warn('PeerJS error', err);
    }
  });
  peer.on('disconnected', () => { if (!S.leaving && !peer.destroyed) peer.reconnect(); });
}

function newPlayer(id, name, isHost, color, uid = null, photo = '') {
  return {
    id, name, isHost, color, uid, photo, clientId: '', connected: true, away: false, offlineAt: 0,
    inGame: false, alive: false, lives: 0, letters: '', words: 0, splats: 0, longest: '', place: 0, wins: 0, matchWins: 0,
  };
}

function cleanPhoto(url) {
  const s = String(url || '');
  return /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(s) ? s.slice(0, 500) : '';
}

function freeColor() {
  const used = new Set(H.room.players.map((p) => p.color));
  for (let c = 0; c < E.MAX_PLAYERS; c++) if (!used.has(c)) return c;
  return 0;
}

function hostOnConnection(conn) {
  conn.on('data', (msg) => hostOnMessage(conn, msg));
  conn.on('close', () => hostOnClose(conn));
  conn.on('error', () => hostOnClose(conn));
}

function hostOnMessage(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  H.seen.set(conn.peer, Date.now());
  const room = H.room;
  if (!room) return;
  const back = room.players.find((p) => p.id === conn.peer && p.away);
  if (back) { back.away = false; hostBroadcast(); }
  switch (msg.t) {
    case 'join': return hostJoin(conn, msg.name, msg.uid, msg.photo, msg.client);
    case 'word': return hostWord(conn.peer, msg.word);
    case 'type': return hostType(conn.peer, msg.text);
    default: return undefined;
  }
}

function hostJoin(conn, rawName, uid, photo, client) {
  const room = H.room;
  const name = cleanName(rawName) || 'Player';
  const cleanUid = typeof uid === 'string' ? uid.slice(0, 128) : null;
  const clientId = typeof client === 'string' ? client.slice(0, 40) : '';
  // Same tab (refresh), same Google account, or an offline seat: take the seat back.
  // A colleague with the same name while the first is still here gets "Name 2".
  const old = room.players.find((p) => !p.isHost && p.name.toLowerCase() === name.toLowerCase()
    && ((clientId && p.clientId === clientId) || (cleanUid && p.uid === cleanUid) || !p.connected));
  if (old) {
    const oldConn = H.conns.get(old.id);
    H.conns.delete(old.id);
    if (oldConn && oldConn !== conn) oldConn.close();
    room.order = room.order.map((x) => (x === old.id ? conn.peer : x));
    if (room.holder === old.id) room.holder = conn.peer;
    if (room.winner === old.id) room.winner = conn.peer;
    if (room.matchWinner === old.id) room.matchWinner = conn.peer;
    for (const w of room.log) if (w.pid === old.id) w.pid = conn.peer;
    if (room.lastSplat && room.lastSplat.pid === old.id) room.lastSplat.pid = conn.peer;
    old.id = conn.peer;
    Object.assign(old, { connected: true, away: false, offlineAt: 0, clientId: clientId || old.clientId, uid: cleanUid || old.uid, photo: cleanPhoto(photo) || old.photo });
    H.conns.set(conn.peer, conn);
    H.seen.set(conn.peer, Date.now());
    send(conn, { t: 'welcome', id: conn.peer, code: room.code });
    hostBroadcast();
    return;
  }
  if (room.players.length >= E.MAX_PLAYERS) room.players = room.players.filter((p) => p.connected);
  if (room.players.length >= E.MAX_PLAYERS) return reject(conn, `This room is full (${E.MAX_PLAYERS} players).`);
  let finalName = name;
  for (let n = 2; room.players.some((p) => p.name.toLowerCase() === finalName.toLowerCase()); n++) finalName = `${name} ${n}`;
  const seat = newPlayer(conn.peer, finalName, false, freeColor(), cleanUid, cleanPhoto(photo));
  seat.clientId = clientId;
  room.players.push(seat);   // joined mid-game: watches until the next game
  H.conns.set(conn.peer, conn);
  H.seen.set(conn.peer, Date.now());
  send(conn, { t: 'welcome', id: conn.peer, code: room.code });
  hostBroadcast();
}

function reject(conn, reason) {
  send(conn, { t: 'reject', reason });
  setTimeout(() => conn.close(), 500);
}

function hostOnClose(conn) {
  const room = H.room;
  if (!room) return;
  const p = room.players.find((x) => x.id === conn.peer);
  H.conns.delete(conn.peer);
  if (!p) return;
  if (room.status === 'lobby') room.players = room.players.filter((x) => x !== p);
  else { p.connected = false; p.offlineAt = Date.now(); }
  hostAfterPresence(p);
  hostBroadcast();
}

const active = (p) => p.connected && !p.away;
const byId = (id) => H.room.players.find((p) => p.id === id);
const canHold = (id) => { const p = byId(id); return Boolean(p && p.inGame && p.alive && active(p)); };

// Someone left or went quiet: if they're holding the banana, it moves on (no life lost)
function hostAfterPresence(p) {
  const room = H.room;
  if (room.status !== 'play' || room.holder !== p.id || active(p)) return;
  const next = E.nextHolder(room.order, p.id, canHold);
  if (next && next !== p.id) {
    room.holder = next;
    hostMinTurn();
  }
}

function hostHeartbeat() {
  const room = H.room;
  if (!room || !S.isHost) return;
  for (const conn of H.conns.values()) send(conn, { t: 'hb' });
  const now = Date.now();
  let changed = false;
  for (const p of room.players) {
    if (p.isHost) continue;
    if (p.connected) {
      const away = now - (H.seen.get(p.id) || 0) > AWAY_MS;
      if (away !== p.away) { p.away = away; changed = true; hostAfterPresence(p); }
    } else if (room.status === 'play' && p.inGame && p.alive && p.offlineAt && now - p.offlineAt > E.TIMES.offlineOutMs) {
      // Gone for good: out of this game, so the others can finish
      eliminate(p);
      changed = true;
      if (hostCheckWinner()) return;
      hostAfterPresence(p);
    }
  }
  if (changed) hostBroadcast();
}

/* ---------- A game ---------- */

function clearTimers() {
  clearTimeout(H.fuseTimer);
  clearTimeout(H.phaseTimer);
}

function hostNewPrompt() {
  const room = H.room;
  const band = E.bandFor(room.settings.difficulty, room.wordsPlayed);
  room.prompt = E.pickPrompt(room.bands, band, room.settings.promptLen, H.rnd, room.recent);
  room.recent = [room.prompt, ...room.recent].slice(0, 40);
  room.promptSplats = 0;
}

function hostScheduleFuse() {
  const room = H.room;
  clearTimeout(H.fuseTimer);
  H.fuseTimer = setTimeout(hostSplat, Math.max(0, room.fuseEnd - Date.now()) + 30);
}

// Everyone's screen changes when a countdown or splat pause ends, so tell them
function hostWakeAt(at) {
  clearTimeout(H.phaseTimer);
  const wait = at - Date.now();
  if (wait > 0) H.phaseTimer = setTimeout(hostBroadcast, wait + 20);
}

// Whoever just got the banana has at least a moment to answer
function hostMinTurn() {
  const room = H.room;
  const min = E.minTurnMs(room.settings);
  if (!min) return;
  const now = Math.max(Date.now(), room.pausedUntil, room.startAt);
  if (room.fuseEnd - now < min) {
    room.fuseEnd = now + min;
    hostScheduleFuse();
  }
}

async function hostStartGame() {
  const room = H.room;
  const players = room.players.filter((p) => p.connected);
  if (players.length < E.MIN_PLAYERS) return toast(`You need at least ${E.MIN_PLAYERS} players`);
  if (!WORDS.ready) {
    toast('Loading the word lists…');
    await loadWords();
    if (!WORDS.ready) return toast('Couldn’t load the word lists. Check your internet and try again.');
    if (H.room !== room) return;
  }
  const typedCrew = $('crew-input').value.replace(/\s+/g, ' ').trim();
  if (room.status === 'lobby' && typedCrew !== (room.crew ? room.crew.name : '')) hostSetCrew(typedCrew);
  clearTimers();
  const st = { ...ROOM_PREFS };
  if (room.matchWinner || st.match !== room.settings.match) {
    for (const p of room.players) p.matchWins = 0;
    room.matchWinner = null;
  }
  room.settings = st;
  room.players = players;
  for (const p of room.players) {
    Object.assign(p, { inGame: true, alive: true, lives: st.lives, letters: '', words: 0, splats: 0, longest: '', place: 0, offlineAt: 0 });
  }
  const ids = room.players.map((p) => p.id);
  room.order = E.shuffle(ids, H.rnd);
  room.holder = room.order[Math.floor(H.rnd() * room.order.length)];
  room.bands = E.promptBands(st.words, WORDS.lex);
  room.used = st.noRepeat === 'room' ? room.roomUsed : new Set();
  Object.assign(room, { log: [], wordsPlayed: 0, recent: [], lastSplat: null, winner: null, pausedUntil: 0 });
  hostNewPrompt();
  const now = Date.now();
  room.status = 'play';
  room.game++;
  room.startAt = now + E.TIMES.countdownMs;
  room.fuseStart = room.startAt;
  room.fuseEnd = room.startAt + E.fuseMs(st, H.rnd);
  hostScheduleFuse();
  hostWakeAt(room.startAt);
  cloud.track('game_started', { players: ids.length, words: st.words, difficulty: st.difficulty, fuse: st.fuse });
  hostBroadcast();
}

function hostType(pid, text) {
  const room = H.room;
  if (room.status !== 'play' || room.holder !== pid) return;
  const clean = E.cleanWord(text);
  const msg = { t: 'type', pid, text: clean };
  for (const [id, conn] of H.conns) if (id !== pid) send(conn, msg);
  if (pid !== S.myId) onMessage(msg);
}

function hostWord(pid, raw) {
  const room = H.room;
  const now = Date.now();
  if (room.status !== 'play' || room.holder !== pid || now < room.startAt || now < room.pausedUntil) return;
  const p = byId(pid);
  if (!p || !p.alive) return;
  const st = room.settings;
  const res = E.checkWord(raw, { prompt: room.prompt, minLen: st.minLen, list: st.words, forms: st.forms, used: room.used, lex: WORDS.lex });
  if (!res.ok) {
    const msg = { t: 'nope', pid, reason: res.reason, word: res.word || '' };
    for (const conn of H.conns.values()) send(conn, msg);
    onMessage(msg);
    return;
  }
  room.used.add(res.key);
  p.words++;
  if (res.word.length > p.longest.length) p.longest = res.word;
  const got = E.addLetters(p.letters, res.word, st.bonus);
  p.letters = got.letters;
  const bonus = got.complete && p.lives < E.maxLivesFor(st);
  if (bonus) p.lives++;
  room.log = [{ pid, word: res.word, prompt: room.prompt, bonus, full: got.complete && !bonus }, ...room.log].slice(0, 40);
  room.wordsPlayed++;
  room.wordSeq++;
  room.holder = E.nextHolder(room.order, pid, canHold) || pid;
  hostNewPrompt();
  hostMinTurn();
  hostBroadcast();
}

function eliminate(p) {
  const room = H.room;
  p.lives = 0;
  p.alive = false;
  p.place = room.players.filter((x) => x.inGame && x.alive).length + 1;
}

// The game ends when one player (or nobody) is left
function hostCheckWinner() {
  const room = H.room;
  const alive = room.players.filter((p) => p.inGame && p.alive);
  if (alive.length > 1) return false;
  hostGameOver(alive[0] || null);
  return true;
}

function hostSplat() {
  const room = H.room;
  if (!room || room.status !== 'play') return;
  const now = Date.now();
  if (now < room.fuseEnd - 5) { hostScheduleFuse(); return; }   // the fuse was extended
  const p = byId(room.holder);
  if (!p) return;
  p.lives--;
  p.splats++;
  room.promptSplats++;
  const out = p.lives <= 0;
  if (out) eliminate(p);
  room.splatSeq++;
  room.lastSplat = { pid: p.id, out, seq: room.splatSeq, lives: p.lives };
  if (hostCheckWinner()) return;
  // Next holder: the next player who's here; if everyone else is away, the next one alive
  room.holder = E.nextHolder(room.order, p.id, canHold)
    || E.nextHolder(room.order, p.id, (id) => { const q = byId(id); return Boolean(q && q.inGame && q.alive); });
  if (room.settings.afterSplat === 'new' || room.promptSplats >= E.PROMPT_MAX_SPLATS) hostNewPrompt();
  room.pausedUntil = now + E.TIMES.splatMs;
  room.fuseStart = room.pausedUntil;
  room.fuseEnd = room.pausedUntil + E.fuseMs(room.settings, H.rnd);
  hostScheduleFuse();
  hostWakeAt(room.pausedUntil);
  hostBroadcast();
}

function hostGameOver(winner) {
  const room = H.room;
  clearTimers();
  room.status = 'over';
  room.winner = winner ? winner.id : null;
  if (winner) {
    winner.place = 1;
    winner.wins++;
    winner.matchWins++;
    const target = E.matchTarget(room.settings);
    if (target && winner.matchWins >= target) room.matchWinner = winner.id;
  }
  cloud.track('game_finished', { players: room.players.filter((p) => p.inGame).length, words: room.wordsPlayed });
  hostSaveCrew();
  hostBroadcast();
}

function hostBackToLobby() {
  const room = H.room;
  clearTimers();
  room.status = 'lobby';
  room.players = room.players.filter((p) => p.connected);
  for (const p of room.players) Object.assign(p, { inGame: false, alive: false });
  hostBroadcast();
}

function hostSaveCrew() {
  const room = H.room;
  if (!room.crew) return;
  if (!cloud.getUser()) {
    room.crewStatus = 'This game wasn’t saved. Sign in with Google (gear icon) to save crew scores.';
    return;
  }
  room.crewStatus = 'Saving this game…';
  const winner = room.winner ? byId(room.winner) : null;
  cloud.saveCrewGame(room.crew.name, {
    room: room.code, winner: winner ? winner.name : '',
    players: room.players.filter((p) => p.inGame).map((p) => ({ name: p.name, place: p.place, words: p.words, longest: p.longest.length })),
  }).then((saved) => {
    if (H.room !== room) return;
    room.crewStatus = `Saved to ${saved.name}. ${plural(saved.games, 'game')} played as this crew.`;
    hostBroadcast();
  }).catch((err) => {
    console.warn('Saving to crew failed', err);
    if (H.room !== room) return;
    room.crewStatus = `This game wasn’t saved. ${cloud.errorText(err)}`;
    hostBroadcast();
  });
}

async function hostSetCrew(rawName) {
  const room = H.room;
  if (!room) return;
  const name = String(rawName || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  store.set('crew', name);
  if (!name) {
    Object.assign(room, { crew: null, crewStatus: '' });
    hostBroadcast();
    return;
  }
  if (cloud.crewId(name).length < 3) return toast('Crew names need at least 3 letters or numbers');
  room.crew = { name };
  if (!cloud.getUser()) {
    room.crewStatus = 'Sign in with Google (gear icon) to save crew scores.';
    hostBroadcast();
    return;
  }
  room.crewStatus = 'Connecting to saved scores…';
  hostBroadcast();
  try {
    const data = await cloud.getCrew(name);
    if (H.room !== room || room.crew?.name !== name) return;
    room.crewStatus = data && data.games ? `${plural(data.games, 'game')} played as this crew so far.` : 'New crew. Scores save after the first game.';
  } catch (err) {
    if (H.room !== room || room.crew?.name !== name) return;
    room.crewStatus = cloud.errorText(err);
  }
  hostBroadcast();
}

// What everyone may see. The moment the banana splats stays hidden unless the room shows the timer.
function publicView() {
  const room = H.room;
  const now = Date.now();
  const playing = room.status === 'play';
  const st = room.settings;
  return {
    t: 'state',
    code: room.code, status: room.status, settings: st, game: room.game,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, isHost: p.isHost, photo: p.photo,
      connected: p.connected, away: p.away, inGame: p.inGame, alive: p.alive, lives: p.lives,
      letters: p.letters, words: p.words, longest: p.longest, splats: p.splats, place: p.place,
      wins: p.wins, matchWins: p.matchWins,
    })),
    order: room.order,
    holder: playing ? room.holder : null,
    prompt: playing && now >= room.startAt ? room.prompt : '',
    startsIn: playing ? room.startAt - now : 0,
    pausedFor: playing ? Math.max(0, room.pausedUntil - now) : 0,
    fuseAge: playing ? now - room.fuseStart : 0,
    fuseLeft: playing && st.showTimer === 'shown' ? room.fuseEnd - now : null,
    log: room.log.slice(0, 14),
    wordsPlayed: room.wordsPlayed, wordSeq: room.wordSeq,
    lastSplat: room.lastSplat,
    used: playing && st.hints === 'on' ? [...room.used] : null,
    winner: room.winner, matchWinner: room.matchWinner,
    crewName: room.crew ? room.crew.name : '',
    crewStatus: room.crewStatus,
  };
}

function hostBroadcast() {
  if (!H.room) return;
  const view = publicView();
  for (const conn of H.conns.values()) send(conn, view);
  onMessage(view);
}

/* =========================================================
   Joining and staying connected
   ========================================================= */
function joinRoom(code, { quiet = false } = {}) {
  const peer = new Peer(PEER_OPTIONS);
  let connected = false;
  let failed = false;
  const fail = (text) => {
    if (failed || connected) return;
    failed = true;
    clearTimeout(timer);
    peer.destroy();
    if (quiet) {
      S.reconnecting = false;
      closeRoom();
      goHome();
      showNotice('The room closed', 'The host left or lost their connection. Ask them to host a new room.');
      return;
    }
    setBusy(false);
    homeError(text);
  };
  const timer = setTimeout(() => fail('Could not reach that room. Check the code, or ask the host to keep their tab open.'), 15000);
  peer.on('open', (id) => {
    Object.assign(S, { peer, myId: id, isHost: false, leaving: false });
    if (!quiet) Object.assign(S, { gameShown: -1, savedGame: -1 });
    const conn = peer.connect(PREFIX + code, { reliable: true });
    conn.on('open', () => {
      connected = true;
      clearTimeout(timer);
      S.hostConn = conn;
      S.code = code;
      S.heard = Date.now();
      const u = cloud.getUser();
      send(conn, { t: 'join', name: S.myName, uid: u?.uid || null, photo: u?.photo || '', client: CLIENT_ID });
    });
    conn.on('data', (msg) => { S.heard = Date.now(); onMessage(msg); });
    conn.on('close', () => {
      if (S.leaving || !connected || S.hostConn !== conn) return;
      reconnect();
    });
  });
  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') fail(`There’s no room ${code} right now. Check the code with your host.`);
    else if (!connected) fail(peerErrorText(err));
    else console.warn('PeerJS error', err);
  });
}

function reconnect() {
  if (S.isHost || !S.code || S.reconnecting) return;
  S.reconnecting = true;
  toast('Connection lost. Reconnecting…');
  const code = S.code;
  S.leaving = true;
  S.hostConn = null;
  S.peer?.destroy();
  S.leaving = false;
  joinRoom(code, { quiet: true });
}

setInterval(() => {
  if (S.isHost) { hostHeartbeat(); return; }
  if (!S.hostConn || S.reconnecting) return;
  send(S.hostConn, { t: 'ping' });
  if (!document.hidden && Date.now() - S.heard > LOST_MS) reconnect();
}, PING_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !S.isHost && S.hostConn && !S.reconnecting && Date.now() - S.heard > LOST_MS) reconnect();
});
window.addEventListener('pagehide', () => {
  if (!S.peer) return;
  S.leaving = true;
  S.peer.destroy();
});

function peerErrorText(err) {
  if (err.type === 'browser-incompatible') return 'This browser can’t do live connections. Try Chrome, Firefox, Edge or Safari.';
  if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error')
    return 'Couldn’t reach the connection server. Check your internet and try again.';
  return `Connection failed (${err.type || 'unknown error'}). Try again.`;
}

function send(conn, msg) {
  if (conn && conn.open) conn.send(msg);
}

// Messages from this player to the host (the host handles its own directly)
function toHost(msg) {
  if (S.isHost) hostOnMessage({ peer: S.myId }, msg);
  else send(S.hostConn, msg);
}

function closeRoom() {
  if (!S.peer) return;
  S.leaving = true;
  clearTimers();
  S.peer.destroy();
  Object.assign(S, { peer: null, hostConn: null, view: null, isHost: false, code: '', reconnecting: false, gameShown: -1 });
  H.room = null;
  H.conns.clear();
  H.seen.clear();
  stopLoop();
}

/* =========================================================
   Messages arriving at this player (host included)
   ========================================================= */
function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'welcome':
      S.myId = msg.id;
      S.code = msg.code;
      if (S.reconnecting) toast('Reconnected');
      else if (!S.isHost) cloud.track('room_joined');
      S.reconnecting = false;
      setBusy(false);
      break;
    case 'reject':
      closeRoom();
      setBusy(false);
      showScreen('home');
      homeError(msg.reason);
      break;
    case 'type':
      if (S.view && msg.pid === S.view.holder && msg.pid !== S.myId) {
        S.typing = String(msg.text || '').slice(0, E.MAX_WORD);
        S.typingFor = msg.pid;
        renderTyping();
      }
      break;
    case 'nope':
      onNope(msg);
      break;
    case 'state':
      applyState(msg);
      break;
    default:
  }
}

const me = (v) => v.players.find((p) => p.id === S.myId);
const pOf = (v, id) => v.players.find((p) => p.id === id);
const nameOf = (v, id) => (pOf(v, id) || { name: 'Someone' }).name;

function applyState(v) {
  S.view = v;
  S.viewAt = performance.now();
  const mine = me(v);
  if (!mine) return;
  if (v.status === 'lobby') {
    stopLoop();
    S.gameShown = -1;
    renderLobby(v);
    if ($('lobby').hidden) showScreen('lobby');
    return;
  }
  if ($('game').hidden) showScreen('game');
  if (v.game !== S.gameShown) {
    // A new game: fresh banana, nothing typed, nothing to replay from the last one
    S.gameShown = v.game;
    S.wordSeen = v.wordSeq;
    S.splatSeen = v.lastSplat ? v.lastSplat.seq : -1;
    S.holderSeen = null;
    S.typing = '';
    S.typingFor = null;
    S.pending = '';
    $('answer').value = '';
    clearTimeout(S.unsplatTimer);
    banana.reset();
    $('flash').textContent = '';
    $('flash').className = 'flash';
  }
  renderGame(v);
  startLoop();
  // Countdowns and splat pauses end without a message from the host: redraw then
  clearTimeout(S.refreshTimer);
  const wait = Math.max(v.startsIn, v.pausedFor);
  if (v.status === 'play' && wait > 0) S.refreshTimer = setTimeout(() => { if (S.view === v) renderGame(v); }, wait + 30);
}

/* =========================================================
   The game screen
   ========================================================= */
const banana = createBanana($('banana-host'));
const keyboard = createKeyboard($('kbd'), $('answer'), { onEnter: submitAnswer, onType: onAnswerInput });

const startedFor = (v) => v.status === 'play' && performance.now() - S.viewAt >= v.startsIn;
const pausedNow = (v) => v.status === 'play' && performance.now() - S.viewAt < v.pausedFor;

function isMyTurn(v) {
  const mine = me(v);
  return Boolean(v.status === 'play' && mine && mine.alive && v.holder === S.myId);
}

function canType(v) {
  return isMyTurn(v) && startedFor(v) && !pausedNow(v);
}

function renderGame(v) {
  const mine = me(v);
  const spectator = !mine.inGame;
  const target = E.matchTarget(v.settings);
  $('bar-code').textContent = v.code;
  $('bar-phase').textContent = v.status === 'over' ? 'Game over'
    : target ? `Best of ${v.settings.match} · game ${v.game}` : `Game ${v.game}`;

  // A word was played: show it, hop the banana to the next player
  if (v.wordSeq !== S.wordSeen) {
    S.wordSeen = v.wordSeq;
    const w = v.log[0];
    if (w) {
      flash(`${esc(nameOf(v, w.pid))}: ${highlight(w.word, w.prompt)}${w.bonus ? ' <span class="bonus-tag">+1 life!</span>' : ''}`, `pc${(pOf(v, w.pid) || { color: 0 }).color}`);
      if (w.pid === S.myId) { w.bonus ? SOUND.bonus() : SOUND.ok(); } else if (w.bonus) SOUND.bonus();
      banana.hop();
    }
    if (S.typingFor !== v.holder) { S.typing = ''; S.typingFor = v.holder; }
  }
  // A splat
  if (v.lastSplat && v.lastSplat.seq !== S.splatSeen) {
    S.splatSeen = v.lastSplat.seq;
    const who = v.lastSplat.pid === S.myId ? 'You' : nameOf(v, v.lastSplat.pid);
    banana.splat(PREFS.anim);
    setAge($('banana-age'), -1);
    SOUND.splat();
    clearTimeout(S.unsplatTimer);
    if (v.status === 'play') S.unsplatTimer = setTimeout(() => banana.reset(), Math.max(300, v.pausedFor));
    flash(v.lastSplat.out ? `Splat! ${esc(who)} ${who === 'You' ? 'are' : 'is'} out` : `Splat! ${esc(who)} lost a life`, 'splat');
    S.typing = '';
    if (v.lastSplat.pid === S.myId) { $('answer').value = ''; S.pending = ''; }
    $('table').classList.remove('shake');
    void $('table').offsetWidth;
    if (PREFS.anim === 'on') $('table').classList.add('shake');
  }
  // The banana came to me
  if (v.holder !== S.holderSeen) {
    S.holderSeen = v.holder;
    if (v.holder === S.myId && v.status === 'play') {
      $('answer').value = '';
      S.pending = '';
      S.sentTyping = '';
      if (startedFor(v)) SOUND.turn();
      else setTimeout(() => { if (S.view && S.view.holder === S.myId && S.view.game === v.game) SOUND.turn(); }, Math.max(0, v.startsIn));
    }
    S.typing = '';
    S.typingFor = v.holder;
  }

  renderSeats(v);
  renderCentre(v);
  renderAnswer(v);
  renderMe(v, spectator);
  renderLog(v);
  renderScores(v);
  $('result-panel').hidden = v.status !== 'over';
  if (v.status === 'over') renderResult(v);
}

function highlight(word, prompt) {
  const w = esc(word);
  if (!prompt) return w;
  const i = word.indexOf(prompt);
  if (i < 0) return w;
  return `${esc(word.slice(0, i))}<b>${esc(prompt)}</b>${esc(word.slice(i + prompt.length))}`;
}

let flashTimer = 0;
function flash(html, cls = '') {
  const el = $('flash');
  el.className = `flash show ${cls}`;
  el.innerHTML = html;
  clearTimeout(flashTimer);
  if (!cls.includes('stay')) flashTimer = setTimeout(() => { el.classList.remove('show'); }, 2200);
}

function hearts(lives, cap) {
  if (lives <= 0) return '<span class="lives-out">out</span>';
  if (lives > 6 || cap > 6) return `<i class="heart"></i><span class="lives-n">×${lives}</span>`;
  let h = '';
  for (let i = 0; i < Math.max(lives, cap); i++) h += `<i class="heart${i < lives ? '' : ' empty'}"></i>`;
  return h;
}

function renderSeats(v) {
  const seated = v.order.map((id) => pOf(v, id)).filter(Boolean);
  const n = seated.length;
  const cap = E.maxLivesFor(v.settings);
  $('seats').innerHTML = seated.map((p, i) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const x = 50 + 41 * Math.cos(a), y = 50 + 39 * Math.sin(a);
    const holder = p.id === v.holder;
    const tag = !p.connected ? 'Offline' : p.away ? 'Away' : '';
    const turnTag = holder && v.status === 'play' && !tag ? (p.id === S.myId ? 'Your turn' : 'Turn') : '';
    const initial = esc([...p.name][0] || '?').toUpperCase();
    return `<div class="seat pc${p.color}${holder ? ' holder' : ''}${p.alive ? '' : ' out'}${active(p) ? '' : ' off'}${p.id === S.myId ? ' me' : ''}"
      style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%">
      <span class="face">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : initial}</span>
      <span class="nm">${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}</span>
      <span class="lives">${v.status === 'over' && p.place === 1 ? '<span class="crown">Winner</span>' : hearts(p.lives, cap)}</span>
      ${tag ? `<span class="seat-tag">${tag}</span>` : turnTag ? `<span class="seat-tag turn">${turnTag}</span>` : ''}
    </div>`;
  }).join('');
  // The banana sits between the table's centre and whoever holds it
  const at = (pausedNow(v) || v.status === 'over') && v.lastSplat ? v.lastSplat.pid : v.holder;
  const idx = seated.findIndex((p) => p.id === at);
  const spot = $('banana-spot');
  if (idx >= 0) {
    const a = -Math.PI / 2 + (idx / n) * Math.PI * 2;
    spot.style.left = `${(50 + 41 * 0.66 * Math.cos(a)).toFixed(2)}%`;
    spot.style.top = `${(50 + 39 * 0.66 * Math.sin(a)).toFixed(2)}%`;
    spot.hidden = false;
  } else if (v.status !== 'over') spot.hidden = true;
  $('table').classList.toggle('my-turn', isMyTurn(v));
}

function renderCentre(v) {
  const started = startedFor(v);
  $('countdown').hidden = !(v.status === 'play' && !started);
  if (v.status === 'play' && !started) runCountdown(v);
  const prompt = v.status === 'play' ? v.prompt : '';
  $('prompt').innerHTML = prompt ? [...prompt].map((c) => `<span class="tile">${esc(c)}</span>`).join('') : '';
  $('prompt').classList.toggle('mine', isMyTurn(v));
  const holder = pOf(v, v.holder);
  const label = $('turn-label');
  label.className = `turn-label${isMyTurn(v) ? ' mine' : ''}`;
  label.innerHTML = v.status !== 'play' || !holder ? ''
    : isMyTurn(v) ? 'Your turn!'
    : `<span class="pen-dot pc${holder.color}"></span>${esc(holder.name)}’s turn`;
  $('timer').hidden = v.fuseLeft == null || v.status !== 'play';
  if (v.status === 'over') {
    const w = v.winner ? pOf(v, v.winner) : null;
    flash(w ? `${esc(w.id === S.myId ? 'You win!' : `${w.name} wins!`)}` : 'Nobody survived', w ? `pc${w.color} big stay` : 'big stay');
  }
  renderTyping();
}

// What the holder is typing, shown under the letters, with the letters picked out
function renderTyping() {
  const v = S.view;
  const el = $('typing-line') || (() => {
    const d = document.createElement('div');
    d.id = 'typing-line';
    d.className = 'typing';
    $('prompt').after(d);
    return d;
  })();
  if (!v || v.status !== 'play') { el.innerHTML = ''; return; }
  const mine = v.holder === S.myId;
  const text = mine ? E.cleanWord($('answer').value) : (PREFS.typing && S.typingFor === v.holder ? S.typing : '');
  const holder = pOf(v, v.holder);
  el.className = `typing pc${holder ? holder.color : 0}`;
  el.innerHTML = text ? highlight(text, v.prompt) : (holder && !mine && startedFor(v) && !pausedNow(v) ? `<span class="muted">${esc(holder.name)} is thinking…</span>` : '');
}

let countdownTimer = 0;
function runCountdown(v) {
  clearInterval(countdownTimer);
  const end = S.viewAt + v.startsIn;
  const tick = () => {
    const left = end - performance.now();
    if (left <= 0) { clearInterval(countdownTimer); $('countdown').hidden = true; return; }
    $('countdown').innerHTML = `<b>${Math.ceil(left / 1000)}</b><span>${esc(v.holder === S.myId ? 'You start' : `${nameOf(v, v.holder)} starts`)}</span>`;
  };
  tick();
  countdownTimer = setInterval(tick, 100);
}

function renderAnswer(v) {
  const mine = me(v);
  const box = $('answer-box');
  box.hidden = !(v.status === 'play' && mine.inGame && mine.alive);
  const myTurn = isMyTurn(v);
  const can = canType(v);
  const input = $('answer');
  input.disabled = !can;
  $('answer-send').disabled = !can;
  keyboard.setEnabled(can);
  box.classList.toggle('mine', myTurn);
  const holder = pOf(v, v.holder);
  $('answer-status').innerHTML = myTurn
    ? (startedFor(v) ? '<b>Your turn!</b> Type a word with the letters' : '<b>You go first</b>')
    : (holder ? `Waiting for <b class="pc${holder.color} who">${esc(holder.name)}</b>` : '');
  input.placeholder = myTurn ? `A word with ${v.prompt ? v.prompt.toUpperCase() : 'the letters'}` : 'Wait for the banana';
  if (!myTurn) { input.value = ''; $('hint').textContent = ''; $('hint').className = 'hint'; }
  else updateHint();
  if (can) focusAnswer();
}

function focusAnswer() {
  const v = S.view;
  if (openSheet || !$('notice').hidden) return;
  if (!$('solo').hidden) { if (!$('solo-answer').disabled && !soloKeyboard.on) $('solo-answer').focus({ preventScroll: true }); return; }
  if (!v || $('game').hidden || !canType(v) || keyboard.on) return;
  if (document.activeElement !== $('answer')) $('answer').focus({ preventScroll: true });
}

// Typing hints, checked against this browser's own copy of the word lists
function updateHint() {
  const v = S.view;
  const el = $('hint');
  if (!v || !isMyTurn(v)) return;
  const word = E.cleanWord($('answer').value);
  if (!word || v.settings.hints !== 'on' || !WORDS.ready) { if (!el.classList.contains('nope')) { el.textContent = ''; el.className = 'hint'; } return; }
  const res = E.checkWord(word, { prompt: v.prompt, minLen: v.settings.minLen, list: v.settings.words, forms: v.settings.forms, used: new Set(v.used || []), lex: WORDS.lex });
  el.className = `hint ${res.ok ? 'good' : 'bad'}`;
  el.textContent = res.ok ? 'Press Enter to pass it on' : E.REASON_TEXT[res.reason];
}

function onAnswerInput() {
  const v = S.view;
  const input = $('answer');
  const clean = E.cleanWord(input.value);
  if (input.value !== clean) input.value = clean;
  $('hint').classList.remove('nope');
  updateHint();
  renderTyping();
  if (v && isMyTurn(v) && clean !== S.sentTyping) {
    S.sentTyping = clean;
    toHost({ t: 'type', text: clean });
  }
}
$('answer').addEventListener('input', onAnswerInput);

function submitAnswer() {
  const v = S.view;
  if (!v || !canType(v)) return;
  const word = E.cleanWord($('answer').value);
  if (!word) return;
  S.pending = word;
  toHost({ t: 'word', word });
}
$('answer-form').addEventListener('submit', (e) => { e.preventDefault(); submitAnswer(); });

function onNope(msg) {
  const v = S.view;
  if (!v) return;
  if (msg.pid === S.myId) {
    SOUND.nope();
    const el = $('hint');
    el.className = 'hint bad nope';
    el.textContent = E.REASON_TEXT[msg.reason] || 'Not accepted';
    shake($('answer'));
  } else {
    shake($('typing-line'));
  }
}

function shake(el) {
  if (!el) return;
  el.classList.remove('shake-x');
  void el.offsetWidth;
  el.classList.add('shake-x');
}

function renderMe(v, spectator) {
  const mine = me(v);
  $('spectator-note').hidden = !spectator;
  $('my-lives').innerHTML = mine.inGame ? hearts(mine.lives, E.maxLivesFor(v.settings)) : '';
  const need = E.bonusLetters(v.settings.bonus);
  $('letters-box').hidden = !need || !mine.inGame;
  if (need) {
    const left = need.length - mine.letters.length;
    $('letters-note').textContent = `Use every letter for a bonus life: ${left} to go`;
    $('letters').innerHTML = [...'abcdefghijklmnopqrstuvwxyz'].map((c) => {
      const cls = !need.includes(c) ? 'skip' : mine.letters.includes(c) ? 'have' : '';
      return `<i class="${cls}">${c}</i>`;
    }).join('');
  }
  keyboard.mark(mine.letters, [...'abcdefghijklmnopqrstuvwxyz'].filter((c) => !need.includes(c)).join(''));
}

function renderLog(v) {
  $('word-count').textContent = v.wordsPlayed ? plural(v.wordsPlayed, 'word') : '';
  $('word-log').innerHTML = v.log.length ? v.log.map((w) => {
    const p = pOf(v, w.pid);
    return `<li class="pc${p ? p.color : 0}"><span class="pen-dot"></span><span class="w">${highlight(w.word, w.prompt)}</span>
      <span class="nm">${esc(p ? p.name : '')}${w.bonus ? ' <span class="bonus-tag">+1</span>' : ''}</span></li>`;
  }).join('') : '<li class="empty muted">Words played appear here.</li>';
}

function renderScores(v) {
  const target = E.matchTarget(v.settings);
  $('scores-title').textContent = target ? `Best of ${v.settings.match}` : 'Wins';
  const list = [...v.players].sort((a, b) => (target ? b.matchWins - a.matchWins : 0) || b.wins - a.wins);
  $('score-list').innerHTML = list.map((p) => `<li class="pc${p.color}${active(p) ? '' : ' off'}">
    <span class="pen-dot"></span><span class="nm">${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}</span><b>${target ? p.matchWins : p.wins}</b></li>`).join('');
}

function renderResult(v) {
  const mine = me(v);
  const w = v.winner ? pOf(v, v.winner) : null;
  const iWon = w && w.id === S.myId;
  const target = E.matchTarget(v.settings);
  let title = w ? (iWon ? 'You win!' : `${w.name} wins!`) : 'Nobody survived';
  let sub = w ? `Last one holding on, with ${plural(w.lives, 'life')} left.` : '';
  if (v.matchWinner) {
    const m = pOf(v, v.matchWinner);
    title = m.id === S.myId ? 'You win the match!' : `${m.name} wins the match!`;
    sub = `First to ${target} games.`;
  } else if (target && w) sub = `${iWon ? 'You have' : `${w.name} has`} ${w.matchWins} of ${target} wins needed.`;
  $('result-head').className = `result-head ${mine.inGame ? (iWon ? 'won' : 'lost') : ''}`;
  $('result-title').textContent = title;
  $('result-sub').textContent = sub;
  const ranked = v.players.filter((p) => p.inGame).sort((a, b) => (a.place || 99) - (b.place || 99));
  $('places').innerHTML = ranked.map((p) => `<li class="pc${p.color}">
      <span class="place">${p.place || '–'}</span><span class="pen-dot"></span>
      <span class="nm">${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}</span>
      <span class="muted small">${plural(p.words, 'word')}${p.longest ? ` · longest <b>${esc(p.longest)}</b>` : ''}</span></li>`).join('');
  $('next-game').hidden = !S.isHost;
  $('next-game').textContent = v.matchWinner ? 'New match' : 'Next game';
  $('to-lobby').hidden = !S.isHost;
  $('result-wait').hidden = S.isHost;
  $('crew-line').textContent = v.crewName ? v.crewStatus : '';

  // Each signed-in player saves their own stats once per game
  if (S.savedGame !== v.game && mine.inGame && cloud.getUser()) {
    S.savedGame = v.game;
    cloud.saveMyGame({ won: Boolean(iWon), words: mine.words, splats: mine.splats, longest: mine.longest.length })
      .catch((err) => toast(`Your stats weren’t saved. ${cloud.errorText(err)}`));
  }
}

$('next-game').addEventListener('click', () => { if (S.isHost) hostStartGame(); });
$('to-lobby').addEventListener('click', () => { if (S.isHost) hostBackToLobby(); });
$('quit-btn').addEventListener('click', () => { closeRoom(); goHome(); });

/* ---------- The banana ages on every screen at once ---------- */
let loopId = 0;
let lastTick = 0;
function startLoop() {
  if (loopId) return;
  const frame = (t) => {
    loopId = requestAnimationFrame(frame);
    const v = S.view;
    if (!v || $('game').hidden) return;
    const since = performance.now() - S.viewAt;
    const live = v.status === 'play' && since >= v.startsIn && since >= v.pausedFor;
    const max = E.FUSES[v.settings.fuse][1];
    if (v.status === 'play' && since >= v.pausedFor) {
      const rot = (v.fuseAge + since) / max;
      banana.setRot(rot);
      setAge($('banana-age'), since >= v.startsIn ? rot : -1);
    } else if (v.status === 'play') setAge($('banana-age'), -1);
    banana.setLive(live);
    if (v.fuseLeft != null && v.status === 'play') {
      const left = Math.max(0, v.fuseLeft - since);
      $('timer').textContent = live || since < v.startsIn ? `${(left / 1000).toFixed(1)}s` : '';
      $('timer').classList.toggle('urgent', left < 3000);
    }
    if (live && me(v) && me(v).inGame && t - lastTick > TICK_MS) { lastTick = t; SOUND.tick(); }
  };
  loopId = requestAnimationFrame(frame);
}
// The rot stage under the banana: Fresh, Ripe, Spotty, Mushy, Rotten!
function setAge(el, rot) {
  const text = rot < 0 ? '' : stageOf(rot);
  if (el.textContent === text) return;
  el.textContent = text;
  el.className = `banana-age ${text.replace('!', '').toLowerCase()}`;
}

function stopLoop() {
  cancelAnimationFrame(loopId);
  loopId = 0;
  clearInterval(countdownTimer);
}

/* =========================================================
   Lobby
   ========================================================= */
function segment(container, get, set) {
  const paint = () => container.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === String(get()))));
  container.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    set(b.dataset.value);
    paint();
  });
  paint();
  return paint;
}

const NUMERIC = new Set(['lives', 'minLen']);
const asSetting = (key, value) => (NUMERIC.has(key) ? Number(value) : value);
const paints = ['lives', 'fuse', 'difficulty', 'words'].map((key) =>
  segment($(`set-${key}`), () => ROOM_PREFS[key], (val) => { ROOM_PREFS[key] = asSetting(key, val); roomSettingsChanged(); }));
const SELECTS = ['showTimer', 'minLen', 'bonus', 'maxLives', 'match', 'promptLen', 'afterSplat', 'minTurn', 'noRepeat', 'forms', 'hints'];
for (const key of SELECTS) {
  $(`set-${key}`).addEventListener('change', (e) => { ROOM_PREFS[key] = asSetting(key, e.target.value); roomSettingsChanged(); });
}

function roomSettingsChanged() {
  ROOM_PREFS = E.cleanSettings(ROOM_PREFS);
  saveRoomPrefs();
  paintRoomSettings();
  if (!S.isHost || !H.room || H.room.status !== 'lobby') return;
  H.room.settings = { ...ROOM_PREFS };
  hostBroadcast();
}

function paintRoomSettings() {
  paints.forEach((p) => p());
  for (const key of SELECTS) $(`set-${key}`).value = String(ROOM_PREFS[key]);
}

const LABELS = {
  fuse: { fast: 'Fast banana (5 to 15 s)', normal: 'Normal banana (10 to 30 s)', relaxed: 'Relaxed banana (20 to 45 s)' },
  difficulty: { easy: 'Easy letters', normal: 'Normal letters', hard: 'Hard letters', ramp: 'Letters get harder' },
  words: { en: 'English words', mix: 'English and Roman Urdu words', ur: 'Roman Urdu words' },
  match: { open: '', 3: 'Best of 3', 5: 'Best of 5' },
  bonus: { off: 'No bonus lives', az: 'Bonus life for using A to Z', easy: 'Bonus life for A to Z (no Q, X, Z)' },
};

function settingsLines(st) {
  return [
    `<b>${plural(st.lives, 'life')}</b> each`,
    LABELS.fuse[st.fuse] + (st.showTimer === 'shown' ? ', timer shown' : ''),
    LABELS.difficulty[st.difficulty],
    `${LABELS.words[st.words]}, ${st.minLen}+ letters`,
    LABELS.bonus[st.bonus],
    LABELS.match[st.match],
  ].filter(Boolean).map((l) => `<li>${l}</li>`).join('');
}

function renderLobby(v) {
  $('lobby-code').textContent = v.code;
  const rows = v.players.map((p) => `
    <li class="pc${p.color}${active(p) ? '' : ' off'}"><span class="pen-dot"></span>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}
      <span class="tag">${p.isHost ? 'Host' : !active(p) ? 'Reconnecting' : ''}</span></li>`);
  const missing = Math.max(0, E.MIN_PLAYERS - v.players.length);
  for (let i = 0; i < Math.max(missing, v.players.length < E.MAX_PLAYERS ? 1 : 0); i++) rows.push('<li class="empty">Waiting for a friend to join…</li>');
  $('lobby-players').innerHTML = rows.join('');
  $('host-settings').hidden = !S.isHost;
  $('guest-settings').hidden = S.isHost;
  if (S.isHost) {
    paintRoomSettings();
    if (document.activeElement !== $('crew-input')) $('crew-input').value = v.crewName;
    $('crew-status').textContent = v.crewStatus;
    renderStartButton(v);
  } else {
    $('settings-summary').innerHTML = settingsLines(v.settings) + (v.crewName ? `<li>Crew: <b>${esc(v.crewName)}</b></li>` : '');
  }
}

function renderStartButton(v = S.view) {
  if (!v || !S.isHost) return;
  const ready = v.players.filter((p) => p.connected).length;
  $('start-btn').disabled = ready < E.MIN_PLAYERS || !WORDS.ready;
  $('start-note').textContent = ready < E.MIN_PLAYERS ? `Needs ${E.MIN_PLAYERS} players to start (${E.MIN_PLAYERS - ready} more).`
    : WORDS.failed ? 'Couldn’t load the word lists. Check your internet and reload.' : !WORDS.ready ? 'Loading the word lists…' : '';
}

function wordsLoaded() {
  if (S.view && S.view.status === 'lobby') renderStartButton();
  if (WORDS.failed && !$('solo').hidden) toast('Couldn’t load the word lists. Check your internet and reload.');
  updateHint();
}

$('copy-link').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${S.code}`;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); } catch { toast(url); }
});
$('crew-save').addEventListener('click', () => hostSetCrew($('crew-input').value));
$('crew-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') hostSetCrew($('crew-input').value); });
$('start-btn').addEventListener('click', () => { if (S.isHost) hostStartGame(); });
$('leave-lobby').addEventListener('click', () => { closeRoom(); goHome(); });

/* =========================================================
   On your own: the daily puzzle and practice
   ========================================================= */
const soloBanana = createBanana($('solo-banana'));
const soloKeyboard = createKeyboard($('solo-kbd'), $('solo-answer'), { onEnter: soloSubmit, onType: soloInput });
const SOLO = {
  mode: null, prompts: [], idx: 0, times: [], promptStart: 0, startAt: 0, used: new Set(), lex: null,
  day: '', streak: 0, best: store.get('practiceBest', 0), fuseEnd: 0, fuseMax: 1, pauseUntil: 0, raf: 0, bands: null,
  wordsPlayed: 0, done: false, lastTick: 0, token: 0, words: [],
};

const dailyState = (day) => {
  const s = store.get('daily', null);
  return s && s.day === day ? s : null;
};

function renderDailyCard() {
  const day = E.dateKey();
  const s = dailyState(day);
  $('daily-tag').textContent = `#${E.dailyNumber(day)}`;
  if (s && s.done) {
    $('daily-note').textContent = `Today’s done: ${E.formatMs(E.dailyTotal(s.times))}. New letters tomorrow.`;
    $('daily-btn').textContent = 'See today’s result';
  } else {
    $('daily-note').textContent = s ? 'You started today’s puzzle. Pick up where you left off.' : 'The same 10 letter sets for everyone today, against the clock.';
    $('daily-btn').textContent = s ? 'Continue daily' : 'Daily puzzle';
  }
}

async function enterSolo(mode) {
  homeError('');
  showScreen('solo');
  SOLO.mode = mode;
  SOLO.token++;
  SOLO.done = false;
  $('daily-done').hidden = true;
  $('solo-answer-box').hidden = false;
  SOLO.used = new Set();
  SOLO.wordsPlayed = 0;
  $('solo-answer').value = '';
  $('solo-hint').textContent = '';
  $('solo-flash').textContent = '';
  $('practice-setup').hidden = mode !== 'practice';
  $('daily-panel').hidden = mode !== 'daily';
  $('solo-skip').textContent = mode === 'daily' ? 'Skip (+10 s)' : 'New letters (ends your streak)';
  soloKeyboard.setOn(useBuiltinKeyboard());
  soloBanana.reset();
  if (!WORDS.ready) {
    $('solo-prompt').innerHTML = '<span class="muted small">Loading words…</span>';
    soloEnable(false);
    await loadWords();
    if (!WORDS.ready || SOLO.mode !== mode || $('solo').hidden) return;
  }
  if (mode === 'daily') startDaily();
  else startPractice();
}

function soloEnable(on) {
  $('solo-answer').disabled = !on;
  $('solo-skip').disabled = !on;
  soloKeyboard.setEnabled(on);
  if (on) focusAnswer();
}

function soloCountdown(then) {
  const end = performance.now() + E.TIMES.countdownMs;
  const token = SOLO.token;
  $('solo-countdown').hidden = false;
  soloEnable(false);
  $('solo-prompt').innerHTML = '';
  const tick = () => {
    if ($('solo').hidden || token !== SOLO.token) return;
    const left = end - performance.now();
    if (left <= 0) { $('solo-countdown').hidden = true; then(); return; }
    $('solo-countdown').innerHTML = `<b>${Math.ceil(left / 1000)}</b><span>Get ready</span>`;
    setTimeout(tick, 100);
  };
  tick();
}

function soloShowPrompt(p) {
  $('solo-prompt').innerHTML = [...p].map((c) => `<span class="tile">${esc(c)}</span>`).join('');
  $('solo-prompt').classList.add('mine');
  $('solo-answer').value = '';
  $('solo-answer').placeholder = `A word with ${p.toUpperCase()}`;
  $('solo-hint').textContent = '';
  soloEnable(true);
}

function soloFlash(html, cls = '') {
  const el = $('solo-flash');
  el.className = `flash show ${cls}`;
  el.innerHTML = html;
  clearTimeout(soloFlash.t);
  soloFlash.t = setTimeout(() => el.classList.remove('show'), 1800);
}

function soloCtx() {
  if (SOLO.mode === 'daily') return { prompt: SOLO.prompts[SOLO.idx], minLen: 4, list: 'en', forms: 'block', used: SOLO.used, lex: WORDS.lex };
  return { prompt: SOLO.prompts[0], minLen: 3, list: PRACTICE.words, forms: 'block', used: SOLO.used, lex: WORDS.lex };
}

function soloInput() {
  const input = $('solo-answer');
  const clean = E.cleanWord(input.value);
  if (input.value !== clean) input.value = clean;
  const el = $('solo-hint');
  if (!clean || SOLO.done) { el.textContent = ''; el.className = 'hint'; return; }
  const res = E.checkWord(clean, soloCtx());
  el.className = `hint ${res.ok ? 'good' : 'bad'}`;
  el.textContent = res.ok ? 'Press Enter' : E.REASON_TEXT[res.reason];
}
$('solo-answer').addEventListener('input', soloInput);

function soloSubmit() {
  if ($('solo-answer').disabled || SOLO.done) return;
  const res = E.checkWord($('solo-answer').value, soloCtx());
  if (!res.ok) {
    if (res.reason === 'empty') return;
    SOUND.nope();
    $('solo-hint').className = 'hint bad';
    $('solo-hint').textContent = E.REASON_TEXT[res.reason];
    shake($('solo-answer'));
    return;
  }
  SOLO.used.add(res.key);
  SOUND.ok();
  soloSolved(res.word);
}
$('solo-form').addEventListener('submit', (e) => { e.preventDefault(); soloSubmit(); });
$('solo-skip').addEventListener('click', () => soloSkip());

/* ---------- Daily ---------- */
function startDaily() {
  const day = E.dateKey();
  SOLO.day = day;
  SOLO.prompts = E.dailyPrompts(day);
  const saved = dailyState(day);
  SOLO.times = saved ? saved.times.slice(0, E.DAILY_COUNT) : [];
  SOLO.words = saved && saved.words ? saved.words : [];
  SOLO.idx = SOLO.times.length;
  $('solo-title').textContent = `Daily #${E.dailyNumber(day)}`;
  $('daily-title').textContent = `Daily #${E.dailyNumber(day)}`;
  renderDailyList();
  if (SOLO.idx >= E.DAILY_COUNT) { dailyDone(false); return; }
  if (!saved) cloud.track('daily_started');
  soloCountdown(dailyNext);
}

function dailyNext() {
  if (SOLO.idx >= E.DAILY_COUNT) { dailyDone(true); return; }
  SOLO.promptStart = performance.now();
  soloBanana.reset();
  soloShowPrompt(SOLO.prompts[SOLO.idx]);
  renderDailyList();
  soloLoop();
}

function saveDaily(done = false) {
  store.set('daily', { day: SOLO.day, times: SOLO.times, words: SOLO.words, done });
}

function soloSolved(word) {
  if (SOLO.mode === 'practice') return practiceSolved(word);
  const ms = Math.round(performance.now() - SOLO.promptStart);
  SOLO.times.push(ms);
  SOLO.words.push(word);
  soloFlash(`${highlight(word, SOLO.prompts[SOLO.idx])} <span class="muted">${E.formatMs(ms)}</span>`);
  SOLO.idx++;
  saveDaily();
  soloBanana.hop();
  dailyNext();
}

function soloSkip() {
  if (SOLO.done) return;
  if (SOLO.mode === 'practice') {
    SOLO.streak = 0;
    renderPractice();
    practiceNext();
    return;
  }
  SOLO.times.push(null);
  SOLO.words.push('');
  SOLO.idx++;
  saveDaily();
  dailyNext();
}

function renderDailyList() {
  const now = SOLO.idx;
  $('daily-list').innerHTML = SOLO.prompts.map((p, i) => {
    const t = SOLO.times[i];
    const state = i < SOLO.times.length ? (t == null ? 'skipped' : 'done') : i === now ? 'now' : '';
    const word = SOLO.words[i];
    const label = i < SOLO.times.length ? (t == null ? 'skipped' : E.formatMs(t)) : i === now && !SOLO.done ? '…' : '';
    return `<li class="${state}"><span class="sq">${i < SOLO.times.length ? E.dailySquare(t) : ''}</span>
      <span class="p">${i <= now || SOLO.done ? esc(p.toUpperCase()) : '··'}</span>
      <span class="w">${word ? highlight(word, p) : ''}</span><span class="t">${label}</span></li>`;
  }).join('');
  $('daily-total').textContent = SOLO.times.length ? E.formatMs(E.dailyTotal(SOLO.times)) : '';
  $('solo-phase').textContent = SOLO.done ? 'Done' : `${Math.min(SOLO.idx + 1, E.DAILY_COUNT)} of ${E.DAILY_COUNT}`;
}

function dailyDone(fresh) {
  SOLO.done = true;
  cancelAnimationFrame(SOLO.raf);
  soloEnable(false);
  $('solo-answer-box').hidden = true;
  $('solo-prompt').innerHTML = '<span class="done-word">Done!</span>';
  $('solo-timer').textContent = '';
  saveDaily(true);
  const total = E.dailyTotal(SOLO.times);
  const skips = SOLO.times.filter((t) => t == null).length;
  $('daily-done').hidden = false;
  $('daily-score').textContent = E.formatMs(total);
  $('daily-sub').textContent = skips ? `Including ${plural(skips, 'skip')} (10 s each).` : 'No skips. Lovely.';
  renderDailyList();
  if (fresh) {
    cloud.track('daily_finished', { ms: total, skips });
    if (cloud.getUser()) {
      cloud.saveMyDaily(SOLO.day, total).catch((err) => { if (err.code !== 'already-saved') toast(`Your daily wasn’t saved. ${cloud.errorText(err)}`); });
    }
  }
}

function dailyShareText() {
  const total = E.dailyTotal(SOLO.times);
  const skips = SOLO.times.filter((t) => t == null).length;
  return `Rotten #${E.dailyNumber(SOLO.day)}: ${E.formatMs(total)}${skips ? ` (${plural(skips, 'skip')})` : ''}\n`
    + `${SOLO.times.map(E.dailySquare).join('')}\n${location.origin}${location.pathname}`;
}
$('daily-share').addEventListener('click', async () => {
  const text = dailyShareText();
  cloud.track('share_result');
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Result copied. Paste it in your chat.'); }
  } catch { /* closed the share sheet */ }
});
$('daily-home').addEventListener('click', () => leaveSolo());

/* ---------- Practice ---------- */
const paintPrDiff = segment($('pr-difficulty'), () => PRACTICE.difficulty, (v) => { PRACTICE.difficulty = v; practiceSettingsChanged(); });
const paintPrWords = segment($('pr-words'), () => PRACTICE.words, (v) => { PRACTICE.words = v; practiceSettingsChanged(); });

function practiceSettingsChanged() {
  store.set('practice', PRACTICE);
  paintPrDiff();
  paintPrWords();
  if (SOLO.mode !== 'practice' || !WORDS.ready) return;
  SOLO.bands = E.promptBands(PRACTICE.words, WORDS.lex);
  SOLO.streak = 0;
  SOLO.wordsPlayed = 0;
  SOLO.token++;
  $('solo-countdown').hidden = true;
  renderPractice();
  practiceNext();
}

function startPractice() {
  $('solo-title').textContent = 'Practice';
  $('daily-done').hidden = true;
  SOLO.bands = E.promptBands(PRACTICE.words, WORDS.lex);
  SOLO.streak = 0;
  SOLO.prompts = [];
  renderPractice();
  cloud.track('practice_started', { words: PRACTICE.words, difficulty: PRACTICE.difficulty });
  soloCountdown(practiceNext);
}

function renderPractice() {
  $('pr-streak').textContent = String(SOLO.streak);
  $('pr-best').textContent = String(SOLO.best);
  $('solo-phase').textContent = SOLO.streak ? `Streak ${SOLO.streak}` : '';
}

function practiceNext() {
  const band = E.bandFor(PRACTICE.difficulty, SOLO.wordsPlayed);
  const p = E.pickPrompt(SOLO.bands, band, 'mix', Math.random, SOLO.prompts);
  SOLO.prompts = [p, ...SOLO.prompts].slice(0, 40);
  const fuse = E.fuseMs({ fuse: 'normal' }, Math.random);
  SOLO.fuseMax = E.FUSES.normal[1];
  SOLO.fuseStart = performance.now();
  SOLO.fuseEnd = SOLO.fuseStart + fuse;
  SOLO.pauseUntil = 0;
  soloBanana.reset();
  soloShowPrompt(p);
  soloLoop();
}

function practiceSolved(word) {
  SOLO.streak++;
  SOLO.wordsPlayed++;
  if (SOLO.streak > SOLO.best) { SOLO.best = SOLO.streak; store.set('practiceBest', SOLO.best); }
  soloFlash(highlight(word, SOLO.prompts[0]));
  soloBanana.hop();
  renderPractice();
  // Like a room: the next letters, but the same banana keeps ageing (with a moment to answer)
  const p = E.pickPrompt(SOLO.bands, E.bandFor(PRACTICE.difficulty, SOLO.wordsPlayed), 'mix', Math.random, SOLO.prompts);
  SOLO.prompts = [p, ...SOLO.prompts].slice(0, 40);
  SOLO.fuseEnd = Math.max(SOLO.fuseEnd, performance.now() + E.minTurnMs({ minTurn: '5' }));
  soloShowPrompt(p);
}

function practiceSplat() {
  soloBanana.splat(PREFS.anim);
  setAge($('solo-age'), -1);
  SOUND.splat();
  soloFlash(SOLO.streak ? `Splat! Streak of ${SOLO.streak} over` : 'Splat!', 'splat');
  SOLO.streak = 0;
  SOLO.wordsPlayed = 0;
  renderPractice();
  soloEnable(false);
  SOLO.pauseUntil = performance.now() + E.TIMES.splatMs;
  const token = SOLO.token;
  setTimeout(() => { if (token === SOLO.token && !$('solo').hidden) practiceNext(); }, E.TIMES.splatMs);
}

function soloLoop() {
  cancelAnimationFrame(SOLO.raf);
  const frame = (t) => {
    if ($('solo').hidden || SOLO.done) return;
    SOLO.raf = requestAnimationFrame(frame);
    const now = performance.now();
    if (SOLO.mode === 'daily') {
      const ms = now - SOLO.promptStart;
      $('solo-timer').textContent = E.formatMs(ms);
      soloBanana.setRot(ms / 30000);
      setAge($('solo-age'), ms / 30000);
      soloBanana.setLive(true);
    } else {
      if (now < SOLO.pauseUntil) return;
      soloBanana.setRot((now - SOLO.fuseStart) / SOLO.fuseMax);
      setAge($('solo-age'), (now - SOLO.fuseStart) / SOLO.fuseMax);
      soloBanana.setLive(true);
      $('solo-timer').textContent = '';
      if (t - SOLO.lastTick > TICK_MS) { SOLO.lastTick = t; SOUND.tick(); }
      if (now >= SOLO.fuseEnd) { cancelAnimationFrame(SOLO.raf); soloBanana.setLive(false); practiceSplat(); }
    }
  };
  SOLO.raf = requestAnimationFrame(frame);
}

function leaveSolo() {
  cancelAnimationFrame(SOLO.raf);
  SOLO.mode = null;
  SOLO.token++;
  $('daily-done').hidden = true;
  goHome();
}
$('solo-quit').addEventListener('click', () => leaveSolo());
$('daily-btn').addEventListener('click', () => enterSolo('daily'));
$('practice-btn').addEventListener('click', () => enterSolo('practice'));

/* =========================================================
   Home
   ========================================================= */
function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

function readName() {
  const name = cleanName($('name-input').value);
  if (!name) {
    homeError('Type your name first so your friends know who’s who.');
    $('name-input').focus();
    return null;
  }
  store.set('name', name);
  return name;
}

function setBusy(busy) {
  $('host-btn').disabled = busy;
  $('join-btn').disabled = busy;
  $('join-btn').textContent = busy ? 'Connecting…' : 'Join room';
}

function goHome() {
  stopLoop();
  renderDailyCard();
  showScreen('home');
}

$('host-btn').addEventListener('click', () => {
  const name = readName();
  if (!name) return;
  homeError('');
  if (typeof Peer === 'undefined') return homeError('Couldn’t load the connection library. Check your internet and reload the page.');
  S.myName = name;
  setBusy(true);
  hostCreate();
});

function join() {
  const name = readName();
  if (!name) return;
  const code = $('code-input').value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) {
    homeError('Room codes are 4 letters.');
    $('code-input').focus();
    return;
  }
  homeError('');
  if (typeof Peer === 'undefined') return homeError('Couldn’t load the connection library. Check your internet and reload the page.');
  S.myName = name;
  setBusy(true);
  joinRoom(code);
}
$('join-btn').addEventListener('click', join);
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

/* =========================================================
   Account and settings
   ========================================================= */
function useBuiltinKeyboard() {
  if (PREFS.kbd === 'builtin') return true;
  if (PREFS.kbd === 'device') return false;
  return matchMedia('(pointer: coarse)').matches;
}

function applyKeyboardPref() {
  keyboard.setOn(useBuiltinKeyboard());
  soloKeyboard.setOn(useBuiltinKeyboard());
}

function renderAccount(u) {
  $('home-account-label').textContent = u ? u.name.split(' ')[0] : 'Sign in';
  $('home-avatar').hidden = !(u && u.photo);
  if (u && u.photo) $('home-avatar').src = u.photo;
  if (openSheet === $('settings')) renderSettings();
}

async function signIn() {
  try { await cloud.signIn(); } catch (err) { toast(cloud.errorText(err)); }
}
$('home-account').addEventListener('click', () => (cloud.getUser() ? open('settings') : signIn()));

async function renderSettings() {
  const u = cloud.getUser();
  $('account-box').innerHTML = u
    ? `${u.photo ? `<img class="avatar" src="${esc(u.photo)}" alt="">` : ''}<span class="who"><b>${esc(u.name)}</b><span>${esc(u.email)}</span></span><button class="btn ghost" id="sign-out" type="button">Sign out</button>`
    : '<span class="who"><b>Playing as a guest</b><span>Sign in to keep your stats and save crew scores.</span></span><button class="btn primary" id="sign-in" type="button">Sign in with Google</button>';
  $('sign-in')?.addEventListener('click', signIn);
  $('sign-out')?.addEventListener('click', () => cloud.signOutUser());
  $('sound-toggle').checked = PREFS.sound !== false;
  $('vibrate-toggle').checked = PREFS.vibrate !== false;
  $('typing-toggle').checked = PREFS.typing !== false;
  $('anim-select').value = PREFS.anim;
  $('kbd-select').value = PREFS.kbd;
  $('analytics-row').hidden = !cloud.analyticsConfigured();
  $('analytics-toggle').checked = PREFS.analytics !== false;
  $('my-stats').innerHTML = '';
  if (!u) return;
  $('my-stats').innerHTML = '<p class="muted">Loading your stats…</p>';
  try {
    const st = await cloud.getMyStats();
    if (cloud.getUser()?.uid !== u.uid) return;
    $('my-stats').innerHTML = `
      <div class="stat-grid">
        <div><b>${st.games}</b><span>Games</span></div>
        <div><b>${st.wins}</b><span>Wins</span></div>
        <div><b>${st.words}</b><span>Words</span></div>
        <div><b>${st.longest || '–'}</b><span>Longest word</span></div>
        <div><b>${st.dailies}</b><span>Dailies</span></div>
        <div><b>${st.bestDaily ? E.formatMs(st.bestDaily) : '–'}</b><span>Best daily</span></div>
      </div>`;
  } catch (err) {
    $('my-stats').innerHTML = `<p class="muted">${esc(cloud.errorText(err))}</p>`;
  }
}
$('sound-toggle').addEventListener('change', (e) => { PREFS.sound = e.target.checked; savePrefs(); if (PREFS.sound) SOUND.ok(); });
$('vibrate-toggle').addEventListener('change', (e) => { PREFS.vibrate = e.target.checked; savePrefs(); });
$('typing-toggle').addEventListener('change', (e) => { PREFS.typing = e.target.checked; savePrefs(); renderTyping(); });
$('anim-select').addEventListener('change', (e) => { PREFS.anim = e.target.value; savePrefs(); });
$('kbd-select').addEventListener('change', (e) => { PREFS.kbd = e.target.value; savePrefs(); applyKeyboardPref(); });
$('analytics-toggle').addEventListener('change', (e) => {
  PREFS.analytics = e.target.checked;
  savePrefs();
  cloud.setAnalyticsEnabled(e.target.checked);
});

// Test hook: with ?debug in the address, automated tests can inspect the state.
if (new URLSearchParams(location.search).has('debug')) window.__rotten = { S, H, SOLO, WORDS, E, hostSplat };

/* =========================================================
   Start
   ========================================================= */
(function init() {
  $('logo-row').innerHTML = meltingLogo();
  const saved = store.get('name', '');
  if (saved) $('name-input').value = saved;
  const room = new URLSearchParams(location.search).get('room');
  if (room && /^[A-Za-z]{4}$/.test(room)) {
    $('code-input').value = room.toUpperCase();
    ($('name-input').value ? $('join-btn') : $('name-input')).focus();
  }
  applyKeyboardPref();
  renderDailyCard();
  showScreen('home');
  loadWords();
  cloud.onUser((u) => {
    renderAccount(u);
    if (S.isHost && H.room && H.room.crew) hostSetCrew(H.room.crew.name);
  });
  cloud.initAnalytics(PREFS.analytics !== false);
  cloud.restore();
})();
