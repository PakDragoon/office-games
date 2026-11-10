import * as E from './engine.js';
import { CATEGORY_NAMES } from './words.js';
import { createSheet } from './sketch.js';
import * as cloud from './cloud.js';

/* =========================================================
   The Liar
   Everyone gets the same secret word except the liar, who only knows the category.
   Players take turns adding to one shared drawing (3 rounds, same order), then vote.
   One player hosts: their browser is the "server". It picks the word and the liar,
   sends each player only their own card, relays the ink live and counts the votes.
   Connections use PeerJS (WebRTC).
   ========================================================= */

const PREFIX = 'theliar-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PEER_OPTIONS = { debug: 1 };
const PING_MS = 2000;
const AWAY_MS = 9000;
const LOST_MS = 12000;
const MAX_STROKES_PER_TURN = 200;

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- This browser only ---------- */
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`theliar.${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`theliar.${key}`, JSON.stringify(value)); } catch { /* not saved */ }
  },
};
const PREFS = { sound: true, analytics: true, ...store.get('prefs', {}) };
const ROOM_PREFS = { mode: 'stroke', seconds: 8, categories: [], ...store.get('room', {}) };
if (!E.FREE_SECONDS.includes(ROOM_PREFS.seconds)) ROOM_PREFS.seconds = 8;
const savePrefs = () => store.set('prefs', PREFS);
const saveRoomPrefs = () => store.set('room', ROOM_PREFS);

// Identifies this tab to the host: survives a refresh, different for every person
const CLIENT_ID = (() => {
  const fresh = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  try {
    let id = sessionStorage.getItem('theliar.client');
    if (!id) { id = fresh(); sessionStorage.setItem('theliar.client', id); }
    return id;
  } catch { return fresh(); }
})();

/* ---------- Screens, sheets, messages ---------- */
const SCREENS = ['home', 'lobby', 'game'];
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

// A short two-note chime and a buzz when it's your turn
let audio = null;
function chime() {
  if (navigator.vibrate) navigator.vibrate(90);
  if (!PREFS.sound) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    [[660, 0], [880, 0.12]].forEach(([f, d]) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.18, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.28);
      o.connect(g).connect(audio.destination);
      o.start(t + d);
      o.stop(t + d + 0.3);
    });
  } catch { /* no sound */ }
}

/* =========================================================
   Hosting
   ========================================================= */
const S = {
  myName: '', myId: null, isHost: false, peer: null, hostConn: null, code: '', view: null, leaving: false,
  heard: 0, reconnecting: false, secret: null, gameShown: -1, turnKey: '', phaseKey: '', savedGame: -1,
  penTimers: [], strokeDone: false,
};
const H = { room: null, conns: new Map(), seen: new Map(), phaseTimer: 0, turnTimer: 0 };

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
    Object.assign(S, { peer, myId: id, isHost: true, code, leaving: false, gameShown: -1, turnKey: '', phaseKey: '' });
    H.conns.clear();
    const u = cloud.getUser();
    H.room = {
      code, status: 'lobby',
      settings: { ...ROOM_PREFS, categories: [...ROOM_PREFS.categories] },
      game: 0,
      players: [newPlayer(id, S.myName, true, 0, u?.uid || null, u?.photo || '')],
      used: new Set(store.get('seen', [])),
      liar: null, word: '', category: '', order: [], round: 0, turn: 0,
      turnStart: 0, deadline: 0, strokeSid: null, turnStrokes: 0, strokes: [],
      votes: {}, options: [], accused: null, guess: null, result: null, delta: {},
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
  return { id, name, isHost, color, uid, photo, clientId: '', connected: true, away: false, inGame: false, ready: false, voteNow: false, score: 0 };
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
    case 'ink': return hostInk(conn.peer, msg.sid, msg.pts, msg.end === true);
    case 'ready': return hostReady(conn.peer);
    case 'votenow': return hostVoteNow(conn.peer, msg.on === true);
    case 'vote': return hostVote(conn.peer, msg.target);
    case 'guess': return hostGuess(conn.peer, msg.word);
    case 'sync': return sendDrawing(conn);
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
    if (room.order.includes(old.id)) room.order = room.order.map((x) => (x === old.id ? conn.peer : x));
    if (room.liar === old.id) room.liar = conn.peer;
    for (const s of room.strokes) if (s.pid === old.id) s.pid = conn.peer;
    if (room.votes[old.id]) { room.votes[conn.peer] = room.votes[old.id]; delete room.votes[old.id]; }
    for (const [v, t] of Object.entries(room.votes)) if (t === old.id) room.votes[v] = conn.peer;
    if (room.accused === old.id) room.accused = conn.peer;
    old.id = conn.peer;
    Object.assign(old, { connected: true, away: false, clientId: clientId || old.clientId, uid: cleanUid || old.uid, photo: cleanPhoto(photo) || old.photo });
    H.conns.set(conn.peer, conn);
    H.seen.set(conn.peer, Date.now());
    send(conn, { t: 'welcome', id: conn.peer, code: room.code });
    if (room.status !== 'lobby') {
      send(conn, secretFor(old));
      sendDrawing(conn);
    }
    hostBroadcast();
    return;
  }
  if (room.players.length >= E.MAX_PLAYERS) room.players = room.players.filter((p) => p.connected);
  if (room.players.length >= E.MAX_PLAYERS) return reject(conn, `This room is full (${E.MAX_PLAYERS} players).`);
  let finalName = name;
  for (let n = 2; room.players.some((p) => p.name.toLowerCase() === finalName.toLowerCase()); n++) finalName = `${name} ${n}`;
  const seat = newPlayer(conn.peer, finalName, false, freeColor(), cleanUid, cleanPhoto(photo));
  seat.clientId = clientId;
  room.players.push(seat);
  H.conns.set(conn.peer, conn);
  H.seen.set(conn.peer, Date.now());
  send(conn, { t: 'welcome', id: conn.peer, code: room.code });
  if (room.status !== 'lobby') {
    send(conn, secretFor(seat));   // joined mid-game: watches until the next game
    sendDrawing(conn);
  }
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
  else p.connected = false;
  hostAfterPresence(p);
  hostBroadcast();
}

const active = (p) => p.connected && !p.away;
const inGame = () => H.room.players.filter((p) => p.inGame);
const byId = (id) => H.room.players.find((p) => p.id === id);

// Someone left or went quiet: don't let them hold the game up
function hostAfterPresence(p) {
  const room = H.room;
  if (room.status === 'role') hostCheckReady();
  if (room.status === 'draw') {
    if (room.order[room.turn] === p.id && !active(p)) hostEndTurn();
    else hostCheckVoteNow();
  }
  if (room.status === 'vote') hostCheckVotes();
}

function hostHeartbeat() {
  const room = H.room;
  if (!room || !S.isHost) return;
  for (const conn of H.conns.values()) send(conn, { t: 'hb' });
  const now = Date.now();
  const changed = [];
  for (const p of room.players) {
    if (p.isHost || !p.connected) continue;
    const away = now - (H.seen.get(p.id) || 0) > AWAY_MS;
    if (away !== p.away) { p.away = away; changed.push(p); }
  }
  if (changed.length) {
    changed.forEach(hostAfterPresence);
    hostBroadcast();
  }
}

/* ---------- A game ---------- */

function secretFor(p) {
  const room = H.room;
  if (!p.inGame) return { t: 'secret', game: room.game, spectator: true, category: room.category };
  if (p.id === room.liar) return { t: 'secret', game: room.game, liar: true, category: room.category };
  return { t: 'secret', game: room.game, liar: false, word: room.word, category: room.category };
}

function hostSendSecrets() {
  for (const p of H.room.players) {
    const msg = secretFor(p);
    if (p.id === S.myId) onMessage(msg);
    else send(H.conns.get(p.id), msg);
  }
}

function sendDrawing(conn) {
  const room = H.room;
  if (!room) return;
  send(conn, { t: 'drawing', game: room.game, strokes: room.strokes.map(({ sid, pid, color, pts }) => ({ sid, pid, color, pts })) });
}

function clearTimers() {
  clearTimeout(H.phaseTimer);
  clearTimeout(H.turnTimer);
}

function hostStartGame() {
  const room = H.room;
  const players = room.players.filter((p) => p.connected);
  if (players.length < E.MIN_PLAYERS) return toast(`You need at least ${E.MIN_PLAYERS} players`);
  const typedCrew = $('crew-input').value.replace(/\s+/g, ' ').trim();
  if (typedCrew !== (room.crew ? room.crew.name : '')) hostSetCrew(typedCrew);
  clearTimers();
  const rnd = E.mulberry32(E.randomSeed());
  room.settings = { ...ROOM_PREFS, categories: [...ROOM_PREFS.categories] };
  room.players = players;
  for (const p of room.players) Object.assign(p, { inGame: true, ready: false, voteNow: false });
  const ids = room.players.map((p) => p.id);
  room.liar = E.pickLiar(ids, room.lastLiar, rnd);
  room.lastLiar = room.liar;
  const pick = E.pickWord(room.settings.categories, room.used, rnd);
  Object.assign(room, { word: pick.word, category: pick.category });
  room.used.add(E.wordKey(pick.category, pick.word));
  store.set('seen', [...room.used].slice(-700));
  room.order = E.turnOrder(ids, room.liar, rnd);
  Object.assign(room, {
    game: room.game + 1, status: 'role', round: 0, turn: 0, strokes: [], strokeSid: null, turnStrokes: 0,
    votes: {}, options: [], accused: null, guess: null, result: null, delta: {},
    deadline: Date.now() + E.TIMES.roleMs,
  });
  H.phaseTimer = setTimeout(hostStartDrawing, E.TIMES.roleMs);
  cloud.track('game_started', { players: ids.length, mode: room.settings.mode, categories: room.settings.categories.length || 0 });
  hostSendSecrets();
  hostBroadcast();
}

function hostReady(pid) {
  const room = H.room;
  const p = byId(pid);
  if (room.status !== 'role' || !p || !p.inGame) return;
  p.ready = true;
  hostCheckReady();
  hostBroadcast();
}

function hostCheckReady() {
  const room = H.room;
  if (room.status !== 'role') return;
  if (inGame().filter(active).every((p) => p.ready)) hostStartDrawing();
}

function hostStartDrawing() {
  const room = H.room;
  if (!room || room.status !== 'role') return;
  clearTimers();
  room.status = 'draw';
  room.round = 0;
  room.turn = 0;
  hostBeginTurn();
}

function hostBeginTurn() {
  const room = H.room;
  const drawer = byId(room.order[room.turn]);
  if (!drawer || !active(drawer)) return hostAdvance();   // skip anyone who's gone
  const now = Date.now();
  room.turnStart = now + E.TIMES.handoffMs;
  room.deadline = room.turnStart + (room.settings.mode === 'stroke' ? E.STROKE.startMs : room.settings.seconds * 1000);
  room.strokeSid = null;
  room.turnStrokes = 0;
  clearTimeout(H.turnTimer);
  H.turnTimer = setTimeout(hostEndTurn, room.deadline - now + 350);
  hostBroadcast();
}

function hostInk(pid, sid, pts, end) {
  const room = H.room;
  if (!room || room.status !== 'draw' || room.order[room.turn] !== pid || typeof sid !== 'string') return;
  if (Date.now() < room.turnStart - 300) return;
  sid = sid.slice(0, 60);
  let stroke = room.strokes.find((s) => s.sid === sid);
  let changed = false;
  if (!stroke) {
    if (room.settings.mode === 'stroke' && room.strokeSid) return;   // one line per turn
    if (room.turnStrokes >= MAX_STROKES_PER_TURN) return;
    const p = byId(pid);
    stroke = { sid, pid, color: p ? p.color : 0, pts: [] };
    room.strokes.push(stroke);
    room.turnStrokes++;
    if (room.settings.mode === 'stroke') {
      // The line has started: it may last up to STROKE.maxMs
      room.strokeSid = sid;
      room.deadline = Date.now() + E.STROKE.maxMs + 400;
      clearTimeout(H.turnTimer);
      H.turnTimer = setTimeout(hostEndTurn, room.deadline - Date.now() + 350);
      changed = true;
    }
  }
  const clean = E.cleanInk(pts, E.MAX_INK - stroke.pts.length);
  stroke.pts.push(...clean);
  const relay = { t: 'ink', pid, sid, color: stroke.color, pts: clean, end };
  for (const [id, conn] of H.conns) if (id !== pid) send(conn, relay);
  if (pid !== S.myId) onMessage(relay);
  if (end && room.settings.mode === 'stroke') return hostEndTurn();
  if (changed) hostBroadcast();
}

function hostEndTurn() {
  const room = H.room;
  if (!room || room.status !== 'draw') return;
  clearTimeout(H.turnTimer);
  room.strokeSid = null;
  hostAdvance();
}

function hostAdvance() {
  const room = H.room;
  room.turn++;
  if (room.turn >= room.order.length) {
    room.turn = 0;
    room.round++;
  }
  if (room.round >= E.ROUNDS) return hostStartVote();
  hostBeginTurn();
}

function hostVoteNow(pid, on) {
  const room = H.room;
  const p = byId(pid);
  if (room.status !== 'draw' || !p || !p.inGame) return;
  p.voteNow = on;
  if (!hostCheckVoteNow()) hostBroadcast();
}

function voteNowCounts() {
  const voters = inGame().filter(active);
  return { have: voters.filter((p) => p.voteNow).length, need: E.voteNeeded(voters.length) };
}

function hostCheckVoteNow() {
  const room = H.room;
  if (room.status !== 'draw') return false;
  const { have, need } = voteNowCounts();
  if (have >= need && have > 0) {
    hostStartVote();
    return true;
  }
  return false;
}

function hostStartVote() {
  const room = H.room;
  clearTimers();
  Object.assign(room, { status: 'vote', votes: {}, strokeSid: null, deadline: Date.now() + E.TIMES.voteMs });
  H.phaseTimer = setTimeout(hostCloseVote, E.TIMES.voteMs + 300);
  hostBroadcast();
}

function hostVote(pid, target) {
  const room = H.room;
  const p = byId(pid), t = byId(target);
  if (room.status !== 'vote' || !p || !p.inGame || !t || !t.inGame || pid === target) return;
  room.votes[pid] = target;
  if (!hostCheckVotes()) hostBroadcast();
}

function hostCheckVotes() {
  const room = H.room;
  if (room.status !== 'vote') return false;
  const voters = inGame().filter(active);
  if (voters.length && voters.every((p) => room.votes[p.id])) {
    hostCloseVote();
    return true;
  }
  return false;
}

function hostCloseVote() {
  const room = H.room;
  if (!room || room.status !== 'vote') return;
  clearTimers();
  room.accused = E.tally(room.votes).accused;
  if (room.accused && room.accused === room.liar) {
    // Caught: one last chance to steal the win by naming the word
    room.status = 'guess';
    room.options = E.liarOptions(room.category, room.word, E.mulberry32(E.randomSeed()));
    room.deadline = Date.now() + E.TIMES.guessMs;
    H.phaseTimer = setTimeout(() => hostFinish(null), E.TIMES.guessMs + 300);
    hostBroadcast();
  } else {
    hostFinish(null);
  }
}

function hostGuess(pid, word) {
  const room = H.room;
  if (room.status !== 'guess' || pid !== room.liar || !room.options.includes(word)) return;
  hostFinish(word);
}

function hostFinish(guess) {
  const room = H.room;
  if (!room || (room.status !== 'vote' && room.status !== 'guess')) return;
  clearTimers();
  room.guess = guess;
  room.result = E.outcome({ liar: room.liar, accused: room.accused, guess, word: room.word });
  const ids = inGame().map((p) => p.id);
  room.delta = E.points({ result: room.result, liar: room.liar, votes: room.votes, players: ids });
  for (const p of inGame()) p.score += room.delta[p.id] || 0;
  room.status = 'result';
  room.deadline = 0;
  cloud.track('game_finished', { result: room.result, players: ids.length });
  hostSaveCrew();
  hostBroadcast();
}

function hostBackToLobby() {
  const room = H.room;
  clearTimers();
  room.status = 'lobby';
  room.players = room.players.filter((p) => p.connected);
  for (const p of room.players) Object.assign(p, { inGame: false, ready: false, voteNow: false });
  hostBroadcast();
}

function hostSaveCrew() {
  const room = H.room;
  if (!room.crew) return;
  if (!cloud.getUser()) {
    room.crewStatus = 'This game wasn’t saved. Sign in with Google (gear icon) to save crew scores.';
    return;
  }
  const crew = room.crew;
  room.crewStatus = 'Saving this game…';
  const liar = byId(room.liar);
  cloud.saveCrewGame(crew.name, {
    room: room.code, word: room.word, category: room.category, liar: liar ? liar.name : '', result: room.result,
    players: inGame().map((p) => ({ name: p.name, points: room.delta[p.id] || 0, liar: p.id === room.liar })),
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

// What everyone may see. The word, the liar and the votes stay hidden until the result.
function publicView() {
  const room = H.room;
  const now = Date.now();
  const reveal = room.status === 'result';
  const { have, need } = room.status === 'draw' ? voteNowCounts() : { have: 0, need: 0 };
  return {
    t: 'state',
    code: room.code, status: room.status, settings: room.settings, game: room.game,
    category: room.status === 'lobby' ? '' : room.category,
    order: room.order, round: room.round, turn: room.turn,
    drawer: room.status === 'draw' ? room.order[room.turn] : null,
    turnStartsIn: room.status === 'draw' ? room.turnStart - now : 0,
    endsIn: room.deadline ? room.deadline - now : 0,
    strokeLive: Boolean(room.strokeSid),
    strokeCount: room.strokes.length,
    voteNowHave: have, voteNowNeed: need,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, isHost: p.isHost, photo: p.photo,
      connected: p.connected, away: p.away, inGame: p.inGame, ready: p.ready, voteNow: p.voteNow,
      voted: Boolean(room.votes[p.id]), score: p.score,
    })),
    accused: room.status === 'guess' || reveal ? room.accused : null,
    options: room.status === 'guess' || reveal ? room.options : [],
    liar: reveal ? room.liar : (room.status === 'guess' ? room.accused : null),
    word: reveal ? room.word : '',
    votes: reveal ? room.votes : {},
    guess: reveal ? room.guess : null,
    result: reveal ? room.result : null,
    delta: reveal ? room.delta : {},
    crewName: room.crew ? room.crew.name : '',
    crewStatus: room.crewStatus,
  };
}

function hostBroadcast() {
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
    if (!quiet) Object.assign(S, { gameShown: -1, turnKey: '', phaseKey: '', secret: null, savedGame: -1 });
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
  if (S.isHost) {
    const fake = { peer: S.myId };
    hostOnMessage(fake, msg);
  } else {
    send(S.hostConn, msg);
  }
}

function closeRoom() {
  if (!S.peer) return;
  S.leaving = true;
  clearTimers();
  stopPen();
  stopClock();
  S.peer.destroy();
  Object.assign(S, { peer: null, hostConn: null, view: null, isHost: false, code: '', secret: null, reconnecting: false, gameShown: -1, turnKey: '', phaseKey: '' });
  H.room = null;
  H.conns.clear();
  H.seen.clear();
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
    case 'secret':
      S.secret = msg;
      renderCard();
      break;
    case 'drawing':
      if (S.view && msg.game !== S.view.game) break;
      sheet.load(msg.strokes || []);
      S.drawingGame = msg.game;
      break;
    case 'ink':
      if (msg.pid !== S.myId) sheet.add(msg.sid, msg.pid, msg.color, msg.pts || []);
      break;
    case 'state':
      applyState(msg);
      break;
    default:
  }
}

const me = (v) => v.players.find((p) => p.id === S.myId);
const nameOf = (v, id) => (v.players.find((p) => p.id === id) || { name: 'Someone' }).name;
const colorOf = (v, id) => (v.players.find((p) => p.id === id) || { color: 0 }).color;

function applyState(v) {
  S.view = v;
  const mine = me(v);
  if (!mine) return;
  if (v.status === 'lobby') {
    stopPen();
    stopClock();
    S.gameShown = -1;
    renderLobby(v);
    if ($('lobby').hidden) showScreen('lobby');
    return;
  }
  if ($('game').hidden) showScreen('game');
  if (v.game !== S.gameShown) {
    // A new game: clean paper
    S.gameShown = v.game;
    S.turnKey = '';
    S.phaseKey = '';
    S.myVote = null;
    S.voteNowOn = false;
    // Keep a drawing that just arrived for this game (joining mid-game); otherwise clean paper
    if (S.drawingGame !== v.game) sheet.clear();
    S.drawingGame = v.game;
    sheet.highlight(null);
    $('replay-btn').disabled = false;
  }
  // Missing strokes (joined late or a hiccup): ask the host for the full drawing
  if (sheet.count < v.strokeCount && !sheet.drawing && !S.isHost && S.syncAsked !== `${v.game}:${v.strokeCount}`) {
    S.syncAsked = `${v.game}:${v.strokeCount}`;
    toHost({ t: 'sync' });
  }
  renderGame(v);
}

/* =========================================================
   The game screen
   ========================================================= */
const sheet = createSheet($('sheet-host'));
let clockTimer = 0;

function stopPen() {
  S.penTimers.forEach(clearTimeout);
  S.penTimers = [];
  sheet.disable();
}

function stopClock() {
  clearInterval(clockTimer);
  $('clock').hidden = true;
}

function runClock(endsAt, totalMs) {
  clearInterval(clockTimer);
  $('clock').hidden = false;
  const tick = () => {
    const left = Math.max(0, endsAt - performance.now());
    $('clock-fill').style.strokeDashoffset = String(1 - Math.min(1, left / totalMs));
    $('clock-text').textContent = String(Math.ceil(left / 1000));
    $('clock').classList.toggle('urgent', left <= 5000);
    if (left <= 0) clearInterval(clockTimer);
  };
  tick();
  clockTimer = setInterval(tick, 200);
}

const PHASE_LABEL = { role: 'Your card', draw: '', vote: 'Vote', guess: 'Last chance', result: 'Result' };

function renderGame(v) {
  const mine = me(v);
  const spectator = !mine.inGame;
  $('bar-code').textContent = v.code;
  $('bar-phase').textContent = v.status === 'draw' ? `Round ${v.round + 1} of ${E.ROUNDS}` : PHASE_LABEL[v.status];
  $('category').textContent = v.category;
  $('spectator-note').hidden = !spectator;
  // Progress: three rounds and the vote
  const stage = v.status === 'role' ? -1 : v.status === 'draw' ? v.round : 3;
  $('progress').innerHTML = [0, 1, 2, 3].map((i) => `<i class="${i < stage ? 'done' : i === stage ? 'now' : ''}${i === 3 ? ' vote' : ''}"></i>`).join('');

  // The clock follows whatever deadline the phase has
  const phaseKey = `${v.game}:${v.status}:${v.round}:${v.turn}:${v.strokeLive}`;
  if (S.phaseKey !== phaseKey) {
    S.phaseKey = phaseKey;
    if (v.endsIn > 0) {
      const total = v.status === 'draw'
        ? (v.settings.mode === 'stroke' ? (v.strokeLive ? E.STROKE.maxMs : E.STROKE.startMs) : v.settings.seconds * 1000)
        : { role: E.TIMES.roleMs, vote: E.TIMES.voteMs, guess: E.TIMES.guessMs }[v.status];
      runClock(performance.now() + v.endsIn, total);
    } else {
      stopClock();
    }
  }

  $('role-overlay').hidden = v.status !== 'role';
  $('draw-panel').hidden = v.status !== 'draw';
  $('vote-panel').hidden = v.status !== 'vote';
  $('guess-panel').hidden = v.status !== 'guess';
  $('result-panel').hidden = v.status !== 'result';
  $('my-card').hidden = spectator || v.status === 'result' || v.status === 'role';
  $('sheet-host').classList.toggle('voting', v.status === 'vote');

  if (v.status === 'role') renderRole(v);
  if (v.status === 'draw') renderDraw(v);
  else { stopPen(); $('handoff').hidden = true; $('sheet-host').classList.remove('my-turn'); }
  if (v.status === 'vote') renderVote(v);
  if (v.status === 'guess') renderGuess(v);
  if (v.status === 'result') renderResult(v);
  if (v.status !== 'vote' && v.status !== 'result') sheet.highlight(null);
  renderScores(v);
  renderCard();
}

/* ---------- Your secret card (hold to peek) ---------- */
function cardHTML(secret) {
  if (!secret) return '';
  if (secret.spectator) return '<span class="card-k">Watching</span><b>You’ll play next game</b>';
  if (secret.liar) return `<span class="card-k">You are</span><b class="liar-word">the liar</b><span class="card-cat">Category: ${esc(secret.category)}</span>`;
  return `<span class="card-k">Your word</span><b>${esc(secret.word)}</b><span class="card-cat">Category: ${esc(secret.category)}</span>`;
}

function renderCard() {
  const html = cardHTML(S.secret);
  $('card-secret').innerHTML = html;
  $('role-secret').innerHTML = html;
  const liarTip = S.secret && S.secret.liar;
  $('role-tip').textContent = liarTip
    ? 'Nobody knows but you. Watch what the others draw and blend in. Don’t get caught.'
    : 'One player doesn’t know this word. Draw enough to show you know it, but not so much the liar can copy you.';
}

function holdToPeek(btn) {
  const on = () => btn.classList.add('peeking');
  const off = () => btn.classList.remove('peeking');
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); on(); });
  ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach((ev) => btn.addEventListener(ev, off));
  btn.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); on(); } });
  btn.addEventListener('keyup', off);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}
holdToPeek($('card-peek'));
holdToPeek($('role-peek'));

/* ---------- Role card ---------- */
function renderRole(v) {
  const mine = me(v);
  const players = v.players.filter((p) => p.inGame);
  const ready = players.filter((p) => p.ready).length;
  $('role-ready').disabled = mine.ready || !mine.inGame;
  $('role-ready').textContent = mine.ready ? 'Ready' : 'I’m ready';
  $('role-count').textContent = `${ready} of ${players.length} ready`;
  $('role-peek').hidden = !mine.inGame;
}
$('role-ready').addEventListener('click', () => toHost({ t: 'ready' }));

/* ---------- Drawing turns ---------- */
function renderDraw(v) {
  const mine = me(v);
  const myTurn = v.drawer === S.myId && mine.inGame;
  const drawer = v.players.find((p) => p.id === v.drawer);
  const single = v.settings.mode === 'stroke';
  const turnKey = `${v.game}:${v.round}:${v.turn}`;

  if (S.turnKey !== turnKey) {
    S.turnKey = turnKey;
    S.strokeDone = false;
    stopPen();
    // Hand-off banner: whose turn it is
    const startsIn = Math.max(0, v.turnStartsIn);
    $('handoff').hidden = false;
    $('handoff').className = `handoff pc${drawer ? drawer.color : 0}`;
    $('handoff-name').textContent = myTurn ? 'Your turn' : `${drawer ? drawer.name : 'Someone'}’s turn`;
    $('handoff-sub').textContent = single ? 'One line' : `${v.settings.seconds} seconds`;
    S.penTimers.push(setTimeout(() => { $('handoff').hidden = true; }, Math.max(600, startsIn)));
    if (myTurn) {
      chime();
      S.penTimers.push(setTimeout(() => {
        sheet.enable({
          pid: S.myId, color: mine.color, single,
          onInk: (sid, pts, end) => toHost({ t: 'ink', sid, pts, end }),
          onStroke: () => { if (single) { S.strokeDone = true; renderTurnStatus(S.view); } },
        });
        renderTurnStatus(S.view);
      }, startsIn));
      if (!single) {
        // Free draw: the pen lifts when time is up (the host also stops accepting ink)
        S.penTimers.push(setTimeout(() => { sheet.disable(); renderTurnStatus(S.view); }, Math.max(0, v.endsIn)));
      }
    }
  }
  renderTurnStatus(v);
  renderOrder(v);
  const vn = $('vote-now');
  vn.hidden = !mine.inGame;
  vn.setAttribute('aria-pressed', String(Boolean(mine.voteNow)));
  vn.querySelector('b').textContent = mine.voteNow ? 'Waiting for the others' : 'Ready to vote';
  $('vote-now-count').textContent = `${v.voteNowHave} of ${v.voteNowNeed} needed`;
}

function renderTurnStatus(v) {
  if (!v || v.status !== 'draw') return;
  const myTurn = v.drawer === S.myId;
  const drawer = v.players.find((p) => p.id === v.drawer);
  const single = v.settings.mode === 'stroke';
  const box = $('turn-status');
  box.className = `turn-status pc${drawer ? drawer.color : 0}${myTurn ? ' mine' : ''}`;
  let title, sub;
  if (myTurn) {
    title = 'Your turn';
    if (single) sub = S.strokeDone ? 'Done. Nice line.' : v.strokeLive ? 'Keep going, lift to finish' : 'Draw one line on the paper';
    else sub = 'Draw until the time runs out';
  } else {
    title = `${drawer ? drawer.name : 'Someone'} is drawing`;
    sub = single ? (v.strokeLive ? 'Drawing their line…' : 'Thinking about their line…') : 'Watch closely';
  }
  $('turn-title').textContent = title;
  $('turn-sub').textContent = sub;
  $('sheet-host').classList.toggle('my-turn', myTurn);
}

function renderOrder(v) {
  $('order-list').innerHTML = v.order.map((id, i) => {
    const p = v.players.find((x) => x.id === id);
    if (!p) return '';
    const dots = [0, 1, 2].map((r) => {
      const done = r < v.round || (r === v.round && i < v.turn);
      return `<i class="${done ? 'done' : r === v.round && i === v.turn ? 'now' : ''}"></i>`;
    }).join('');
    const now = id === v.drawer;
    const next = v.order[(v.turn + 1) % v.order.length] === id && !now;
    const tag = !p.connected ? 'Offline' : p.away ? 'Away' : now ? 'Drawing' : next ? 'Next' : '';
    return `<li class="pc${p.color}${now ? ' now' : ''}${active(p) ? '' : ' off'}">
      <span class="pen-dot"></span><span class="nm">${esc(p.name)}${id === S.myId ? ' (you)' : ''}</span>
      <span class="tag">${tag}</span><span class="rounds">${dots}</span></li>`;
  }).join('');
}

$('vote-now').addEventListener('click', () => {
  const v = S.view;
  if (!v || v.status !== 'draw') return;
  toHost({ t: 'votenow', on: !me(v).voteNow });
});

/* ---------- Voting ---------- */
function renderVote(v) {
  const mine = me(v);
  const players = v.players.filter((p) => p.inGame);
  const voted = players.filter((p) => p.voted).length;
  $('vote-count').textContent = `${voted} of ${players.length} voted`;
  $('vote-title').textContent = mine.inGame ? 'Who is the liar?' : 'The others are voting';
  $('vote-list').innerHTML = players.map((p) => {
    const self = p.id === S.myId;
    const picked = S.myVote === p.id;
    return `<li><button type="button" class="suspect pc${p.color}${picked ? ' picked' : ''}" data-id="${esc(p.id)}" ${self || !mine.inGame ? 'aria-disabled="true"' : ''}>
      <span class="pen-dot"></span><span class="nm">${esc(p.name)}${self ? ' (you)' : ''}</span>
      <span class="tag">${p.voted ? 'Voted' : ''}</span></button></li>`;
  }).join('');
}

$('vote-list').addEventListener('click', (e) => {
  const b = e.target.closest('.suspect');
  const v = S.view;
  if (!b || !v || v.status !== 'vote' || b.getAttribute('aria-disabled') === 'true') return;
  S.myVote = b.dataset.id;
  toHost({ t: 'vote', target: b.dataset.id });
  renderVote(v);
});
// Pointing at a name lights up only their lines
['pointerover', 'focusin'].forEach((ev) => $('vote-list').addEventListener(ev, (e) => {
  const b = e.target.closest('.suspect');
  if (b) sheet.highlight(b.dataset.id);
}));
['pointerleave', 'focusout'].forEach((ev) => $('vote-list').addEventListener(ev, () => sheet.highlight(null)));

/* ---------- The liar's last guess ---------- */
function renderGuess(v) {
  const isLiar = v.liar === S.myId;
  $('guess-title').textContent = isLiar ? 'Caught! Name the word to steal the win' : `${nameOf(v, v.liar)} was the liar!`;
  $('guess-sub').textContent = isLiar ? 'Pick the word everyone was drawing.' : `${nameOf(v, v.liar)} gets one chance to name the word and steal the win.`;
  $('guess-list').innerHTML = v.options.map((w) => `<button type="button" class="option" data-word="${esc(w)}" ${isLiar ? '' : 'disabled'}>${esc(cap(w))}</button>`).join('');
}

$('guess-list').addEventListener('click', (e) => {
  const b = e.target.closest('.option');
  if (!b || b.disabled) return;
  $('guess-list').querySelectorAll('.option').forEach((o) => { o.disabled = true; });
  b.classList.add('picked');
  toHost({ t: 'guess', word: b.dataset.word });
});

/* ---------- Result ---------- */
function renderResult(v) {
  const liarName = nameOf(v, v.liar);
  const isLiar = v.liar === S.myId;
  const mine = me(v);
  const head = {
    caught: ['Caught!', `${liarName} was the liar and couldn’t name the word.`],
    stolen: ['Stolen!', `${liarName} was caught but named the word.`],
    escaped: ['The liar got away', v.accused ? `You voted out ${nameOf(v, v.accused)}. ${liarName} was the liar.` : `The vote was split. ${liarName} was the liar.`],
  }[v.result];
  const won = isLiar ? v.result !== 'caught' : v.result === 'caught';
  $('result-head').className = `result-head ${mine.inGame ? (won ? 'won' : 'lost') : ''}`;
  $('result-title').textContent = head[0];
  $('result-sub').textContent = head[1];
  $('result-word').textContent = cap(v.word);
  $('result-liar').innerHTML = `<span class="pen-dot pc${colorOf(v, v.liar)}"></span>${esc(liarName)}${isLiar ? ' (you)' : ''}`;
  const rows = v.players.filter((p) => p.inGame).map((p) => {
    const target = v.votes[p.id];
    const right = target && target === v.liar;
    const d = v.delta[p.id] || 0;
    return `<li class="pc${p.color}${p.id === v.liar ? ' is-liar' : ''}">
      <span class="pen-dot"></span><span class="nm">${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}</span>
      <span class="voted">${target ? `voted ${esc(nameOf(v, target))}${right ? ' ✓' : ''}` : 'no vote'}</span>
      <span class="gain ${d ? 'plus' : ''}">${d ? `+${d}` : '0'}</span></li>`;
  }).join('');
  $('result-votes').innerHTML = rows;
  $('next-game').hidden = !S.isHost;
  $('to-lobby').hidden = !S.isHost;
  $('result-wait').hidden = S.isHost;
  $('crew-line').textContent = v.crewName ? v.crewStatus : '';

  // Each signed-in player saves their own stats once per game
  if (S.savedGame !== v.game && mine.inGame && cloud.getUser()) {
    S.savedGame = v.game;
    cloud.saveMyGame({ liar: isLiar, won, votedRight: v.votes[S.myId] === v.liar, points: v.delta[S.myId] || 0 })
      .catch((err) => toast(`Your stats weren’t saved. ${cloud.errorText(err)}`));
  }
}

$('replay-btn').addEventListener('click', async () => {
  $('replay-btn').disabled = true;
  sheet.highlight(null);
  await sheet.replay();
  $('replay-btn').disabled = false;
});
$('save-btn').addEventListener('click', async () => {
  try {
    const blob = await sheet.toPNG();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `the-liar-${(S.view && S.view.word ? S.view.word : 'drawing').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch {
    toast('Couldn’t save the picture in this browser.');
  }
});
$('result-votes').addEventListener('pointerover', (e) => {
  const li = e.target.closest('li');
  const v = S.view;
  if (!li || !v) return;
  const p = v.players.filter((x) => x.inGame)[[...li.parentNode.children].indexOf(li)];
  if (p) sheet.highlight(p.id);
});
$('result-votes').addEventListener('pointerleave', () => sheet.highlight(null));
$('next-game').addEventListener('click', () => { if (S.isHost) hostStartGame(); });
$('to-lobby').addEventListener('click', () => { if (S.isHost) hostBackToLobby(); });

function renderScores(v) {
  const list = [...v.players].sort((a, b) => b.score - a.score);
  $('score-list').innerHTML = list.map((p) => `<li class="pc${p.color}${active(p) ? '' : ' off'}">
    <span class="pen-dot"></span><span class="nm">${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}</span><b>${p.score}</b></li>`).join('');
}

$('quit-btn').addEventListener('click', () => { closeRoom(); goHome(); });

/* =========================================================
   Lobby
   ========================================================= */
function segment(container, get, set) {
  const paint = () => container.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === get())));
  container.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    set(b.dataset.value);
    paint();
  });
  paint();
  return paint;
}

const paintMode = segment($('set-mode'), () => ROOM_PREFS.mode, (v) => { ROOM_PREFS.mode = v; roomSettingsChanged(); });
$('set-seconds').addEventListener('change', (e) => { ROOM_PREFS.seconds = Number(e.target.value); roomSettingsChanged(); });
const paintAllCats = segment($('set-cats-all'), () => (ROOM_PREFS.categories.length ? 'pick' : 'all'), (v) => {
  ROOM_PREFS.categories = v === 'all' ? [] : (ROOM_PREFS.categories.length ? ROOM_PREFS.categories : [...CATEGORY_NAMES]);
  roomSettingsChanged();
});
$('cat-picks').innerHTML = CATEGORY_NAMES.map((c) => `<button type="button" class="cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
$('cat-picks').addEventListener('click', (e) => {
  const b = e.target.closest('.cat');
  if (!b) return;
  const set = new Set(ROOM_PREFS.categories.length ? ROOM_PREFS.categories : CATEGORY_NAMES);
  if (set.has(b.dataset.cat)) {
    if (set.size === 1) return toast('Keep at least one category');
    set.delete(b.dataset.cat);
  } else set.add(b.dataset.cat);
  ROOM_PREFS.categories = set.size === CATEGORY_NAMES.length ? [] : CATEGORY_NAMES.filter((c) => set.has(c));
  roomSettingsChanged();
});

function roomSettingsChanged() {
  saveRoomPrefs();
  paintRoomSettings();
  if (!S.isHost || !H.room || H.room.status !== 'lobby') return;
  H.room.settings = { ...ROOM_PREFS, categories: [...ROOM_PREFS.categories] };
  hostBroadcast();
}

function paintRoomSettings() {
  paintMode();
  paintAllCats();
  $('seconds-field').hidden = ROOM_PREFS.mode !== 'free';
  $('set-seconds').value = String(ROOM_PREFS.seconds);
  const picking = ROOM_PREFS.categories.length > 0;
  $('cat-picks').hidden = !picking;
  const on = new Set(ROOM_PREFS.categories);
  $('cat-picks').querySelectorAll('.cat').forEach((b) => b.setAttribute('aria-pressed', String(on.has(b.dataset.cat))));
}

function settingsLines(st) {
  const cats = st.categories.length ? `${plural(st.categories.length, 'category')}: ${st.categories.join(', ')}` : 'All categories';
  return [
    `<li><b>${st.mode === 'stroke' ? 'One line per turn' : `Free draw, ${st.seconds} seconds a turn`}</b></li>`,
    `<li>${esc(cats)}</li>`,
    `<li>${E.ROUNDS} rounds, then the vote</li>`,
  ].join('');
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
    const ready = v.players.filter((p) => p.connected).length;
    $('start-btn').disabled = ready < E.MIN_PLAYERS;
    $('start-note').textContent = ready < E.MIN_PLAYERS ? `Needs ${E.MIN_PLAYERS} players to start (${E.MIN_PLAYERS - ready} more).` : '';
  } else {
    $('settings-summary').innerHTML = settingsLines(v.settings) + (v.crewName ? `<li>Crew: <b>${esc(v.crewName)}</b></li>` : '');
  }
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
  stopPen();
  stopClock();
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
        <div><b>${st.points}</b><span>Points</span></div>
        <div><b>${st.catches}</b><span>Liars caught</span></div>
        <div><b>${st.liarGames}</b><span>Times the liar</span></div>
        <div><b>${st.liarWins}</b><span>Got away</span></div>
        <div><b>${st.correctVotes}</b><span>Right votes</span></div>
      </div>`;
  } catch (err) {
    $('my-stats').innerHTML = `<p class="muted">${esc(cloud.errorText(err))}</p>`;
  }
}
$('sound-toggle').addEventListener('change', (e) => { PREFS.sound = e.target.checked; savePrefs(); if (PREFS.sound) chime(); });
$('analytics-toggle').addEventListener('change', (e) => {
  PREFS.analytics = e.target.checked;
  savePrefs();
  cloud.setAnalyticsEnabled(e.target.checked);
});

// Test hook: with ?debug in the address, automated tests can inspect the state.
if (new URLSearchParams(location.search).has('debug')) window.__theliar = { S, H, sheet };

/* =========================================================
   Start
   ========================================================= */
(function init() {
  $('logo-row').innerHTML = [...'THE'].map((c) => `<span class="tile small">${c}</span>`).join('')
    + '<span class="gap"></span>'
    + [...'LIAR'].map((c) => `<span class="tile${c === 'I' ? ' odd' : ''}">${c}</span>`).join('');
  const saved = store.get('name', '');
  if (saved) $('name-input').value = saved;
  const room = new URLSearchParams(location.search).get('room');
  if (room && /^[A-Za-z]{4}$/.test(room)) {
    $('code-input').value = room.toUpperCase();
    ($('name-input').value ? $('join-btn') : $('name-input')).focus();
  }
  showScreen('home');
  cloud.onUser((u) => {
    renderAccount(u);
    if (S.isHost && H.room && H.room.crew) hostSetCrew(H.room.crew.name);
  });
  cloud.initAnalytics(PREFS.analytics !== false);
  cloud.restore();
})();
