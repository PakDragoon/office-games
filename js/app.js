// Thulla: real-time multiplayer in the browser. No backend.
// The host's browser is the game server: it deals, holds every hand, checks every
// move and decides tricks. Other players connect to it directly with PeerJS and only
// ever receive their own cards plus public information.

import * as E from './engine.js';
import * as cloud from './cloud.js';
import { pickCritter, slapMe, slapSeat } from './slap.js';

const MAX_PLAYERS = 8;
const PEER_PREFIX = 'thulla-pk-';
const DEBUG = new URLSearchParams(location.search).has('debug');
const FAST = DEBUG && new URLSearchParams(location.search).has('fast'); // test runs only
const RESOLVE_MS = FAST ? 150 : 1700;   // how long a finished trick stays on the table
const TAKE_MS = 15000;                  // time to answer a take-cards request
const STUCK_MS = FAST ? 3000 : 30000;   // offline player's turn (no timer): host can play for them after this
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CHAT_PHRASES = ['Shabash!', 'Uff yaar', 'Jaldi khelo', 'Ye lo thulla!', 'Bach gaya!', 'Wah wah', 'Sorry 😅', 'GG'];

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isBanana = (n) => /^(jd|junaid)$/i.test(String(n || '').trim());
const disp = (n) => String(n || '') + (isBanana(n) ? ' 🍌' : '');
const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16);

// ---------------------------------------------------------------------------
// Preferences (this device only)
// ---------------------------------------------------------------------------
const prefs = (() => {
  const base = { sound: true, contrast: false, tapOnce: false, slapper: 'random' };
  try { return { ...base, ...JSON.parse(localStorage.getItem('thulla-prefs') || '{}') }; }
  catch { return base; }
})();
function savePrefs() { try { localStorage.setItem('thulla-prefs', JSON.stringify(prefs)); } catch {} }
function applyPrefs() { document.body.classList.toggle('contrast', !!prefs.contrast); }

const cid = (() => {
  try {
    let v = sessionStorage.getItem('thulla-cid');
    if (!v) { v = Math.random().toString(36).slice(2, 12); sessionStorage.setItem('thulla-cid', v); }
    return v;
  } catch { return Math.random().toString(36).slice(2, 12); }
})();

// ---------------------------------------------------------------------------
// Sounds (generated, no files)
// ---------------------------------------------------------------------------
let actx = null;
function audio() {
  if (!prefs.sound) return null;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  } catch { return null; }
}
function tone(freq, dur, type = 'sine', vol = 0.12, delay = 0, endFreq) {
  const a = audio(); if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator(); const g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}
const sfx = {
  card: () => tone(420, 0.05, 'triangle', 0.07),
  turn: () => { tone(660, 0.08, 'sine', 0.09); tone(880, 0.12, 'sine', 0.09, 0.09); },
  thulla: () => { tone(220, 0.38, 'sawtooth', 0.16, 0, 55); tone(110, 0.45, 'square', 0.08, 0.04, 40); },
  finish: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.16, 'triangle', 0.1, i * 0.08)),
  lose: () => [392, 330, 262].forEach((f, i) => tone(f, 0.22, 'triangle', 0.1, i * 0.14)),
  ask: () => { tone(520, 0.1, 'square', 0.06); tone(520, 0.1, 'square', 0.06, 0.16); },
  slap: (big = true) => noise(big ? 0.22 : 0.12, big ? 0.5 : 0.25),
  meow: () => { tone(620, 0.16, 'sawtooth', 0.05, 0, 980); tone(980, 0.28, 'sawtooth', 0.05, 0.15, 520); },
  grunt: () => { tone(110, 0.32, 'sawtooth', 0.12, 0, 70); tone(82, 0.36, 'square', 0.06, 0.03, 55); },
};
function noise(dur, vol) {
  const a = audio(); if (!a) return;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = a.createBufferSource(); src.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 0.7;
  const g = a.createGain(); g.gain.value = vol;
  src.connect(f).connect(g).connect(a.destination); src.start();
}
document.addEventListener('pointerdown', () => audio(), { once: true });

// ---------------------------------------------------------------------------
// Toast and stamp
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
let stampTimer;
function stamp(big, sub, kind = '') {
  const s = $('#stamp');
  s.className = 'stamp ' + kind;
  s.innerHTML = `<b>${esc(big)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}`;
  s.hidden = false;
  // restart animations
  s.querySelectorAll('b, span').forEach((el) => { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; });
  clearTimeout(stampTimer); stampTimer = setTimeout(() => { s.hidden = true; }, 1950);
}

// ===========================================================================
// HOST: the game server
// ===========================================================================
let H = null;

function newHost(code) {
  return {
    code,
    peer: null,
    players: [],          // { id, name, cid, conn, online, left, isHost, color, uid, photo }
    nextId: 1,
    settings: { rounds: 0, timer: 0, allowTake: false, earlyPlay: false, crew: '' },
    phase: 'lobby',       // lobby | playing | between | over
    roundNo: 0,
    dealer: -1,
    round: null,
    resolving: null,
    take: null,
    stuck: null,
    scores: {},           // id -> { rounds, losses, posSum, given, received }
    history: [],
    lastResult: null,
    final: null,
    turnDeadline: 0,
    timers: {},
    allTime: null,
    crewNote: '',
    seq: 0,
  };
}

const byId = (id) => H.players.find((p) => p.id === id);
const nameOf = (id) => (byId(id) || {}).name || '?';

function freeColor() {
  const used = new Set(H.players.filter((p) => !p.left).map((p) => p.color));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return 0;
}

function clearTimer(key) { clearTimeout(H.timers[key]); delete H.timers[key]; }
function clearAllTimers() { Object.keys(H.timers).forEach(clearTimer); }

function hostStart(name) {
  const code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
  setBusy(true);
  const peer = new window.Peer(PEER_PREFIX + code);
  let opened = false;
  peer.on('open', () => {
    opened = true;
    H = newHost(code);
    H.peer = peer;
    const u = cloud.getUser();
    const p = { id: 'p' + H.nextId++, name, cid, conn: null, online: true, left: false, isHost: true, color: 0, uid: u?.uid || '', photo: u?.photo || '' };
    H.players.push(p);
    me.role = 'host'; me.id = p.id; me.code = code; me.name = name;
    saveSession({ code, name, role: 'host' });
    setBusy(false);
    broadcast();
  });
  peer.on('connection', (conn) => {
    conn.on('data', (msg) => hostReceive(conn, msg));
    conn.on('close', () => hostConnClosed(conn));
    conn.on('error', () => hostConnClosed(conn));
  });
  peer.on('disconnected', () => { if (!peer.destroyed) try { peer.reconnect(); } catch {} });
  peer.on('error', (err) => {
    if (!opened && err.type === 'unavailable-id') { peer.destroy(); hostStart(name); return; }
    if (!opened) { setBusy(false); showHomeError(networkError(err)); peer.destroy(); }
    else if (DEBUG) console.warn('host peer error', err);
  });
}

function networkError(err) {
  if (err?.type === 'peer-unavailable') return 'No room with that code. Check the code with your host.';
  if (err?.type === 'browser-incompatible') return 'This browser can’t make direct connections. Try Chrome, Safari or Firefox.';
  if (err?.type === 'network' || err?.type === 'server-error' || err?.type === 'socket-error') return 'Couldn’t reach the connection server. Check your internet and try again.';
  return 'Couldn’t connect. Try again in a moment.';
}

/** Messages from guests (conn) or from the host's own UI (conn = null). */
function hostReceive(conn, msg) {
  if (!H || !msg || typeof msg !== 'object') return;
  if (msg.t === 'hello') return hostHello(conn, msg);
  const p = conn ? byId(conn._pid) : byId(me.id);
  if (!p || (conn && p.conn !== conn)) return;
  switch (msg.t) {
    case 'play': return hostPlay(p, String(msg.card || ''));
    case 'take': return hostTakeAsk(p);
    case 'chat': return hostChat(p, msg.i);
    case 'takeReply': return hostTakeReply(p, !!msg.accept);
    case 'leave': return hostLeave(p);
    default: return undefined;
  }
}

function hostHello(conn, msg) {
  const name = cleanName(msg.name);
  const reply = (m) => { try { conn.send(m); } catch {} };
  if (!name) return reply({ t: 'error', msg: 'Type your name first.' });
  let p = H.players.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (p) {
    if (p.isHost) return reply({ t: 'error', msg: `${name} is the host’s name. Pick another name.` });
    const stillThere = p.online && p.conn && p.conn.open && p.cid !== msg.cid;
    if (stillThere) return reply({ t: 'error', msg: `Someone called ${name} is already in this room. Pick another name.` });
    if (p.left) {
      if (H.players.filter((x) => !x.left).length >= MAX_PLAYERS) return reply({ t: 'error', msg: `This room is full (${MAX_PLAYERS} players).` });
      if (H.players.some((x) => x !== p && !x.left && x.color === p.color)) p.color = freeColor();
    }
    if (p.conn && p.conn !== conn) { try { p.conn._pid = null; p.conn.close(); } catch {} }
    Object.assign(p, { conn, online: true, left: false, cid: msg.cid || p.cid });
  } else {
    const count = H.players.filter((x) => !x.left).length;
    if (count >= MAX_PLAYERS) return reply({ t: 'error', msg: `This room is full (${MAX_PLAYERS} players).` });
    p = { id: 'p' + H.nextId++, name, cid: msg.cid || '', conn, online: true, left: false, isHost: false, color: freeColor(), uid: '', photo: '' };
    H.players.push(p);
  }
  p.uid = String(msg.uid || '').slice(0, 128);
  p.photo = /^https:\/\//.test(msg.photo || '') ? String(msg.photo).slice(0, 500) : '';
  conn._pid = p.id;
  reply({ t: 'welcome', id: p.id, code: H.code });
  const inRound = H.round && H.phase === 'playing' && H.round.seats.includes(p.id);
  if (H.phase === 'playing' && !inRound) reply({ t: 'note', msg: 'A round is in progress. You’ll be dealt in next round.' });
  fxAll({ kind: 'joined', name: p.name, back: Boolean(inRound) }, p.id);
  refreshStuck();
  broadcast();
}

function hostConnClosed(conn) {
  if (!H || !conn._pid) return;
  const p = byId(conn._pid);
  if (!p || p.conn !== conn) return;
  p.conn = null;
  p.online = false;
  if (H.phase === 'lobby') {
    H.players = H.players.filter((x) => x !== p);
  } else {
    fxAll({ kind: 'offline', name: p.name });
    if (H.take && (H.take.to === p.id || H.take.from === p.id)) hostTakeResolve(false, 'offline');
  }
  refreshStuck();
  broadcast();
}

function hostLeave(p) {
  if (p.isHost) return;
  try { p.conn && p.conn.close(); } catch {}
  p.conn = null; p.online = false; p.left = true;
  if (H.phase === 'lobby') H.players = H.players.filter((x) => x !== p);
  else {
    fxAll({ kind: 'left', name: p.name });
    if (H.take && (H.take.to === p.id || H.take.from === p.id)) hostTakeResolve(false, 'offline');
  }
  refreshStuck();
  broadcast();
}

// ---------- Settings & flow (host UI calls these directly) ----------

function hostSetSettings(patch) {
  if (!H || H.phase !== 'lobby') return;
  Object.assign(H.settings, patch);
  broadcast();
}

async function hostUseCrew(raw) {
  const name = String(raw || '').trim();
  if (!name) { H.settings.crew = ''; H.allTime = null; H.crewNote = ''; broadcast(); return; }
  if (cloud.crewId(name).length < 3) { H.crewNote = 'Use at least 3 letters or numbers.'; broadcast(); return; }
  if (!cloud.getUser()) { H.crewNote = 'Sign in with Google (gear icon) to save crew scores.'; broadcast(); return; }
  H.settings.crew = name;
  H.crewNote = 'Loading crew scores…';
  broadcast();
  try {
    H.allTime = await cloud.getCrew(name);
    H.crewNote = H.allTime.rounds ? `Saving to “${name}”. ${H.allTime.rounds} rounds saved so far.` : `Saving to new crew “${name}”.`;
  } catch (e) {
    H.crewNote = 'Couldn’t load that crew. Check your connection and try again.';
    if (DEBUG) console.warn(e);
  }
  broadcast();
}

function hostStartRound() {
  if (!H) return;
  const seats = H.players.filter((p) => !p.left && p.online).map((p) => p.id);
  if (seats.length < 2) { toast('You need at least 2 players to start.'); return; }
  clearAllTimers();
  H.dealer = (H.dealer + 1) % seats.length;
  H.round = E.createRound({ seats, dealer: H.dealer, allowTake: H.settings.allowTake, earlyPlay: H.settings.earlyPlay });
  for (const id of seats) H.scores[id] ||= { rounds: 0, losses: 0, posSum: 0, given: 0, received: 0 };
  H.roundNo++;
  H.phase = 'playing';
  H.resolving = null; H.take = null; H.stuck = null; H.lastResult = null; H.final = null;
  fxAll({ kind: 'roundStart', no: H.roundNo, leader: nameOf(H.round.turn) });
  startTurnClock();
  broadcast();
}

function hostEndRoundEarly() {
  if (!H || H.phase !== 'playing') return;
  clearAllTimers();
  H.history.unshift({ no: H.roundNo, ended: true });
  H.lastResult = { no: H.roundNo, ended: true, results: [] };
  H.round = null; H.resolving = null; H.take = null; H.stuck = null;
  H.phase = H.settings.rounds && H.roundNo >= H.settings.rounds ? 'over' : 'between';
  if (H.phase === 'over') H.final = standings();
  broadcast();
}

function hostEndGame() {
  if (!H) return;
  clearAllTimers();
  H.round = null; H.resolving = null; H.take = null;
  H.phase = 'over';
  H.final = standings();
  broadcast();
}

function hostResetGame() {
  H.scores = {}; H.history = []; H.roundNo = 0; H.lastResult = null; H.final = null; H.round = null;
  // Forget players who left; keep everyone else in their seats.
  H.players = H.players.filter((p) => !p.left && (p.online || p.isHost));
}
function hostRematch() { hostResetGame(); hostStartRound(); }
function hostChangeSettings() { hostResetGame(); H.phase = 'lobby'; broadcast(); }

function hostCloseRoom() {
  if (!H) return;
  clearAllTimers();
  for (const p of H.players) if (p.conn) { try { p.conn.send({ t: 'closed' }); } catch {} }
  const peer = H.peer;
  H = null;
  setTimeout(() => { try { peer.destroy(); } catch {} }, 300);
}

// ---------- Playing ----------

function canAct(pid) {
  const r = H.round;
  return H.phase === 'playing' && r && !r.over && !H.resolving && !H.take && r.turn === pid;
}

function canEarly(pid) {
  const r = H.round;
  return H.phase === 'playing' && r && !r.over && !H.resolving && !H.take && E.earlyCards(r, pid).length > 0;
}

function hostPlay(p, card) {
  const r = H.round;
  if (!canAct(p.id) && !canEarly(p.id)) { sendTo(p, { t: 'error', msg: H.take ? 'Wait for the answer to the card request.' : 'Wait for your turn.' }); broadcast(); return; }
  const res = E.play(r, p.id, card);
  if (!res.ok) { sendTo(p, { t: 'error', msg: res.error }); broadcast(); return; }
  if (res.events.length === 1 && res.events[0].early) { broadcast(); return; } // turn and timer carry on
  afterEvents(res.events);
}

function afterEvents(events) {
  const r = H.round;
  for (const e of events) {
    if (e.type === 'thulla') fxAll({ kind: 'thulla', giver: nameOf(e.giver), receiver: nameOf(e.receiver), receiverId: e.receiver, count: e.count, jumped: e.jumped });
    if (e.type === 'finish' && !e.cancelled) fxAll({ kind: 'finish', id: e.id, name: nameOf(e.id), pos: e.pos });
    if (e.type === 'take') fxAll({ kind: 'take', from: nameOf(e.from), to: nameOf(e.to), count: e.count });
  }
  clearTimer('turn');
  if (events.some((e) => e.type === 'discard' || e.type === 'thulla')) {
    H.resolving = { seq: ++H.seq, ...r.lastTrick };
    H.stuck = null;
    broadcast();
    H.timers.resolve = setTimeout(() => {
      H.resolving = null;
      if (r.over) hostFinishRound();
      else { startTurnClock(); broadcast(); }
    }, RESOLVE_MS);
    return;
  }
  startTurnClock();
  broadcast();
}

function startTurnClock() {
  clearTimer('turn');
  const r = H.round;
  H.turnDeadline = 0;
  if (!r || r.over || H.resolving || H.take || H.phase !== 'playing') { refreshStuck(); return; }
  if (H.settings.timer) {
    const ms = H.settings.timer * 1000;
    const turnNo = r.turnNo;
    H.turnDeadline = Date.now() + ms;
    H.timers.turn = setTimeout(() => hostAutoPlay(turnNo), ms + 150);
  }
  refreshStuck();
}

function hostAutoPlay(turnNo) {
  const r = H?.round;
  if (!r || r.over || r.turnNo !== turnNo || H.resolving || H.take) return;
  const id = r.turn;
  const card = E.autoCard(r, id);
  if (!card) return;
  const res = E.play(r, id, card);
  if (!res.ok) return;
  fxAll({ kind: 'auto', id, name: nameOf(id), card });
  afterEvents(res.events);
}

function refreshStuck() {
  if (!H) return;
  clearTimer('stuck');
  const r = H.round;
  if (!r || r.over || H.phase !== 'playing' || H.settings.timer || H.resolving || H.take) { H.stuck = null; return; }
  const p = byId(r.turn);
  if (p && !p.online) {
    if (!H.stuck || H.stuck.turnNo !== r.turnNo) H.stuck = { turnNo: r.turnNo, since: Date.now() };
    const wait = H.stuck.since + STUCK_MS - Date.now();
    if (wait > 0) H.timers.stuck = setTimeout(broadcast, wait + 50);
  } else {
    H.stuck = null;
  }
}

function hostPlayFor() {
  const r = H?.round;
  if (!r || !H.stuck || r.turnNo !== H.stuck.turnNo) return;
  hostAutoPlay(r.turnNo);
}

// ---------- Quick chat (fixed phrases only) ----------

function hostChat(p, i) {
  if (!Number.isInteger(i) || i < 0 || i >= CHAT_PHRASES.length) return;
  const now = Date.now();
  if (now - (p.lastChat || 0) < 1500) return;   // no spamming
  p.lastChat = now;
  fxAll({ kind: 'chat', id: p.id, i });
}

// ---------- Taking the next player's cards ----------

function hostTakeAsk(p) {
  const r = H.round;
  if (!canAct(p.id)) return sendTo(p, { t: 'error', msg: 'You can only ask on your turn, before you lead.' });
  const { target, reason } = E.takeTarget(r, p.id);
  if (!target) return sendTo(p, { t: 'error', msg: reason });
  const t = byId(target);
  if (!t || !t.online) return sendTo(p, { t: 'error', msg: `${nameOf(target)} is offline right now.` });
  E.markTakeAsked(r);
  clearTimer('turn');
  H.turnDeadline = 0;
  H.take = { from: p.id, to: target, until: Date.now() + TAKE_MS };
  H.timers.take = setTimeout(() => hostTakeResolve(false, 'timeout'), TAKE_MS);
  fxAll({ kind: 'takeAsk', from: p.name, to: t.name, toId: t.id });
  refreshStuck();
  broadcast();
}

function hostTakeReply(p, accept) {
  if (!H.take || H.take.to !== p.id) return;
  hostTakeResolve(accept, 'answer');
}

function hostTakeResolve(accept, why) {
  const tk = H.take;
  if (!tk) return;
  clearTimer('take');
  H.take = null;
  const r = H.round;
  if (accept && r && !r.over && r.turn === tk.from) {
    afterEvents(E.applyTake(r, tk.from, tk.to));
    return;
  }
  fxAll({ kind: 'takeNo', from: nameOf(tk.from), to: nameOf(tk.to), why });
  startTurnClock();
  broadcast();
}

// ---------- Round end and scores ----------

function hostFinishRound() {
  const r = H.round;
  clearAllTimers();
  const pos = E.positions(r);
  const results = r.seats.map((id) => ({
    id, name: nameOf(id), pos: pos[id], lost: id === r.loser,
    given: r.stats[id].given, received: r.stats[id].received,
  })).sort((a, b) => a.pos - b.pos);
  for (const x of results) {
    const s = H.scores[x.id];
    s.rounds++; s.losses += x.lost ? 1 : 0; s.posSum += x.pos; s.given += x.given; s.received += x.received;
  }
  H.history.unshift({ no: H.roundNo, loser: nameOf(r.loser), players: r.seats.length });
  H.lastResult = { no: H.roundNo, ended: false, loser: r.loser, results };
  const gameOver = Boolean(H.settings.rounds && H.roundNo >= H.settings.rounds);
  H.phase = gameOver ? 'over' : 'between';
  H.round = null;
  if (gameOver) H.final = standings();
  fxAll({ kind: 'roundOver', loser: nameOf(r.loser), loserId: r.loser });

  // Each signed-in player saves their own stats.
  for (const x of results) {
    const p = byId(x.id);
    if (p) sendTo(p, { t: 'roundEnd', key: `${H.code}-${H.roundNo}-${H.seq}`, mine: { pos: x.pos, players: results.length, lost: x.lost, given: x.given, received: x.received } });
  }
  // Host saves the round to the crew.
  if (H.settings.crew && cloud.getUser()) {
    const crewName = H.settings.crew;
    cloud.saveCrewRound(crewName, {
      room: H.code,
      loser: nameOf(r.loser),
      players: results.map(({ name, pos, lost, given, received }) => ({ name, pos, lost, given, received })),
    }).then((saved) => {
      if (!H || H.settings.crew !== crewName) return;
      H.allTime = saved;
      H.crewNote = `Saved to “${crewName}”.`;
      broadcast();
    }).catch((e) => {
      if (!H) return;
      H.crewNote = 'Couldn’t save this round to the crew. Check your connection.';
      if (DEBUG) console.warn(e);
      broadcast();
    });
  } else if (H.settings.crew) {
    H.crewNote = 'Not saved: the host isn’t signed in.';
  }
  broadcast();
}

function standings() {
  const rows = Object.entries(H.scores).map(([id, s]) => {
    const p = byId(id);
    return {
      id, name: p ? p.name : '?', color: p ? p.color : 0, gone: !p || p.left || !p.online,
      rounds: s.rounds, losses: s.losses, avg: s.rounds ? s.posSum / s.rounds : 0,
      given: s.given, received: s.received,
    };
  });
  const avgKey = (x) => (x.rounds ? x.avg : Infinity);
  rows.sort((a, b) => a.losses - b.losses || avgKey(a) - avgKey(b) || b.rounds - a.rounds || a.name.localeCompare(b.name));
  return rows;
}

function allTimeRows() {
  if (!H.allTime) return null;
  const rows = Object.values(H.allTime.players || {}).map((p) => ({
    name: p.name, rounds: p.rounds, losses: p.losses, avg: p.rounds ? p.posSum / p.rounds : 0, given: p.given,
  }));
  rows.sort((a, b) => (a.losses / (a.rounds || 1)) - (b.losses / (b.rounds || 1)) || a.avg - b.avg || b.rounds - a.rounds);
  return { name: H.allTime.name || H.settings.crew, rounds: H.allTime.rounds || 0, rows: rows.slice(0, 20) };
}

// ---------- Views (what each player is allowed to see) ----------

function buildView(pid) {
  const r = H.round;
  const now = Date.now();
  const inGame = (p) => (r && r.seats.includes(p.id)) || H.scores[p.id];
  const players = H.players.filter((p) => !p.left || inGame(p)).map((p) => ({
    id: p.id, name: p.name, color: p.color, online: p.online, left: p.left, isHost: p.isHost, photo: p.photo,
    inRound: Boolean(r && r.seats.includes(p.id)),
    count: r && r.hands[p.id] ? r.hands[p.id].length : null,
    safe: r ? r.out.indexOf(p.id) + 1 : 0,
  }));
  let round = null;
  if (r && H.phase === 'playing') {
    const take = E.takeTarget(r, pid);
    const stuckReady = H.stuck && now - H.stuck.since >= STUCK_MS;
    round = {
      seats: r.seats,
      turn: r.turn,
      first: r.first,
      ledSuit: H.resolving ? null : r.ledSuit,
      trick: H.resolving ? H.resolving.cards : r.trick,
      resolving: H.resolving ? { seq: H.resolving.seq, kind: H.resolving.kind, winner: H.resolving.winner, giver: H.resolving.giver } : null,
      discarded: r.tricks > 0,
      hand: r.hands[pid] ? r.hands[pid].slice() : null,
      legal: canAct(pid) ? E.legalCards(r, pid) : [],
      early: canEarly(pid) ? E.earlyCards(r, pid) : [],
      myTurn: canAct(pid),
      timer: H.settings.timer,
      turnMs: H.turnDeadline ? Math.max(0, H.turnDeadline - now) : 0,
      take: H.take ? { from: H.take.from, to: H.take.to, ms: Math.max(0, H.take.until - now) } : null,
      canTake: canAct(pid) && Boolean(take.target),
      takeTarget: take.target,
      playFor: pid === hostId() && stuckReady ? r.turn : null,
      stuck: H.stuck ? r.turn : null,
    };
  }
  return {
    code: H.code,
    phase: H.phase,
    you: pid,
    hostId: hostId(),
    settings: { ...H.settings },
    roundNo: H.roundNo,
    players,
    round,
    standings: standings(),
    history: H.history.slice(0, 15),
    result: H.lastResult,
    final: H.final,
    allTime: allTimeRows(),
    crewNote: pid === hostId() ? H.crewNote : '',
  };
}

const hostId = () => H.players.find((p) => p.isHost)?.id;

function sendTo(p, msg) {
  if (p.isHost) { clientMessage(msg); return; }
  if (p.conn && p.online) { try { p.conn.send(msg); } catch {} }
}

let broadcastQueued = false;
function broadcast() {
  if (!H || broadcastQueued) return;
  broadcastQueued = true;
  queueMicrotask(() => {
    broadcastQueued = false;
    if (!H) return;
    for (const p of H.players) {
      if (p.isHost || (p.online && p.conn)) sendTo(p, { t: 'state', v: buildView(p.id) });
    }
  });
}

function fxAll(fx, exceptId) {
  for (const p of H.players) if (p.id !== exceptId && (p.isHost || p.online)) sendTo(p, { t: 'fx', fx });
}

// ===========================================================================
// CLIENT: every player, including the host's own screen
// ===========================================================================
const me = { role: null, id: null, code: null, name: '', peer: null, conn: null, view: null, joining: false, closedByHost: false };

function send(msg) {
  if (me.role === 'host') hostReceive(null, msg);
  else if (me.conn && me.conn.open) me.conn.send(msg);
  else toast('Not connected to the host.');
}

function saveSession(s) { try { sessionStorage.setItem('thulla-session', JSON.stringify(s)); } catch {} }
function loadSession() { try { return JSON.parse(sessionStorage.getItem('thulla-session') || 'null'); } catch { return null; } }
function clearSession() { try { sessionStorage.removeItem('thulla-session'); } catch {} }

function joinRoom(code, name) {
  if (me.joining) return;
  me.joining = true;
  me.closedByHost = false;
  setBusy(true);
  showHomeError('');
  const peer = new window.Peer();
  me.peer = peer;
  let done = false;
  const fail = (msg) => {
    if (done) return;
    done = true; me.joining = false; setBusy(false);
    try { peer.destroy(); } catch {}
    if (me.view) showClosed(msg, true); else { showScreen('home'); showHomeError(msg); }
  };
  const timeout = setTimeout(() => fail('Couldn’t reach that room. Check the code, and that the host still has the game open.'), 15000);
  peer.on('open', () => {
    const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
    conn.on('open', () => {
      const u = cloud.getUser();
      conn.send({ t: 'hello', name, cid, uid: u?.uid || '', photo: u?.photo || '' });
    });
    conn.on('data', (msg) => {
      if (msg?.t === 'welcome') {
        clearTimeout(timeout);
        done = true; me.joining = false; setBusy(false);
        me.role = 'guest'; me.id = msg.id; me.code = code; me.name = name; me.conn = conn;
        saveSession({ code, name, role: 'guest' });
        const url = new URL(location.href); url.searchParams.set('room', code); history.replaceState(null, '', url);
        $('#closed-overlay').hidden = true;
        return;
      }
      if (msg?.t === 'error' && !done) { clearTimeout(timeout); fail(msg.msg); return; }
      clientMessage(msg);
    });
    conn.on('close', () => {
      if (me.conn !== conn) return;
      me.conn = null;
      if (me.closedByHost) return;
      showClosed('Lost the connection to the host. If they still have the game open, rejoin to get your cards back.', true);
    });
  });
  peer.on('error', (err) => {
    clearTimeout(timeout);
    if (!done) fail(networkError(err));
    else if (err.type === 'peer-unavailable' || err.type === 'network') {
      if (me.view && !me.closedByHost) showClosed('Lost the connection to the host. If they still have the game open, rejoin to get your cards back.', true);
    }
  });
}

function leaveRoom() {
  if (me.role === 'host') {
    hostCloseRoom();
  } else if (me.conn) {
    try { me.conn.send({ t: 'leave' }); } catch {}
    const conn = me.conn; me.conn = null;
    setTimeout(() => { try { conn.close(); } catch {} }, 150);
  }
  const peer = me.peer;
  setTimeout(() => { try { peer && peer.destroy(); } catch {} }, 400);
  Object.assign(me, { role: null, id: null, code: null, peer: null, conn: null, view: null });
  clearSession();
  const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url);
  ['#round-overlay', '#over-overlay', '#scores-overlay', '#take-overlay', '#closed-overlay'].forEach((s) => { $(s).hidden = true; });
  showScreen('home');
}

function showClosed(text, canRetry) {
  $('#closed-text').textContent = text;
  $('#closed-retry').hidden = !canRetry;
  $('#closed-overlay').hidden = false;
}

function clientMessage(msg) {
  if (!msg) return;
  switch (msg.t) {
    case 'state': applyView(msg.v); break;
    case 'fx': onFx(msg.fx); break;
    case 'error': toast(msg.msg, 3200); if (me.view?.phase === 'lobby') $('#lobby-error').textContent = msg.msg; break;
    case 'note': toast(msg.msg, 3500); break;
    case 'roundEnd': savePersonalRound(msg); break;
    case 'closed':
      me.closedByHost = true;
      showClosed('The host closed the room.', false);
      clearSession();
      break;
    default: break;
  }
}

async function savePersonalRound(msg) {
  if (!cloud.getUser()) return;
  try {
    const key = 'thulla-saved-' + msg.key;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
    await cloud.saveMyRound(msg.mine);
  } catch (e) { if (DEBUG) console.warn('stats save failed', e); }
}

// ---------- Effects ----------

function onFx(fx) {
  const v = me.view;
  switch (fx.kind) {
    case 'thulla': {
      shockedUntil[fx.receiverId] = Date.now() + 1800;
      setTimeout(() => { if (me.view?.round) renderSeats(me.view); }, 1850);
      const mine = fx.receiverId === me.id;
      const who = mine ? 'you pick' : disp(fx.receiver) + ' picks';
      const sub = fx.jumped
        ? `${disp(fx.giver)} hit back: ${who} up ${fx.count} for playing early`
        : `${disp(fx.giver)} → ${who} up ${fx.count} card${fx.count === 1 ? '' : 's'}`;
      const critter = pickCritter(prefs.slapper);
      const shakeTable = () => {
        const t = $('#table'); t.classList.remove('shake'); void t.offsetWidth; t.classList.add('shake');
        setTimeout(() => t.classList.remove('shake'), 500);
      };
      if (critter) (critter === 'cat' ? sfx.meow : sfx.grunt)();
      else sfx.thulla();
      if (mine && critter) {
        slapMe(critter, 'Thulla!', esc(sub), () => { sfx.slap(true); sfx.thulla(); });
      } else {
        stamp('Thulla!', sub);
        if (critter) slapSeat(critter, document.querySelector(`[data-seat="${fx.receiverId}"]`), () => { sfx.slap(false); shakeTable(); });
        else shakeTable();
      }
      break;
    }
    case 'finish':
      sfx.finish();
      if (fx.id === me.id) stamp('You’re safe!', `${ordinal(fx.pos)} out`, 'finish');
      else toast(`${disp(fx.name)} is safe, ${ordinal(fx.pos)} out 🎉`);
      break;
    case 'roundOver': if (fx.loserId === me.id) sfx.lose(); else sfx.finish(); break;
    case 'roundStart': toast(`Round ${fx.no}. ${disp(fx.leader)} has the Ace of Spades.`); break;
    case 'take': toast(`${disp(fx.from)} took ${disp(fx.to)}’s ${fx.count} cards. ${disp(fx.to)} is safe.`, 3200); break;
    case 'takeAsk': sfx.ask(); if (fx.toId !== me.id) toast(`${disp(fx.from)} asked ${disp(fx.to)} for their cards`); break;
    case 'takeNo': toast(fx.why === 'timeout' ? `${disp(fx.to)} didn’t answer in time` : fx.why === 'offline' ? `Card request cancelled: ${disp(fx.to)} went offline` : `${disp(fx.to)} kept their cards`); break;
    case 'auto': toast(fx.id === me.id ? `Time’s up. Played ${E.cardLabel(fx.card)} for you.` : `${disp(fx.name)} ran out of time: ${E.cardLabel(fx.card)}`); break;
    case 'chat': {
      const text = CHAT_PHRASES[fx.i];
      if (!text) break;
      chatBubbles[fx.id] = { text, until: Date.now() + 2600 };
      tone(880, 0.06, 'sine', 0.05);
      if (me.view?.round) renderSeats(me.view);
      else toast(`${disp(player(me.view, fx.id)?.name || '')}: ${text}`);
      setTimeout(() => { if (me.view?.round) renderSeats(me.view); }, 2650);
      break;
    }
    case 'joined': if (v && v.phase !== 'lobby') toast(fx.back ? `${disp(fx.name)} is back` : `${disp(fx.name)} joined`); break;
    case 'offline': toast(`${disp(fx.name)} went offline`); break;
    case 'left': toast(`${disp(fx.name)} left the room`); break;
    default: break;
  }
}

// ===========================================================================
// Rendering
// ===========================================================================
let prevView = null;
let animatedSeq = 0;
let shownTrick = new Set();
let turnEndsAt = 0;
let takeEndsAt = 0;

function showScreen(name) {
  for (const s of ['home', 'lobby', 'game']) $('#' + s).hidden = s !== name;
  document.body.classList.toggle('in-game', name === 'game');
}

function applyView(v) {
  prevView = me.view;
  me.view = v;
  turnEndsAt = v.round?.turnMs ? Date.now() + v.round.turnMs : 0;
  takeEndsAt = v.round?.take ? Date.now() + v.round.take.ms : 0;
  if (v.round?.myTurn && !(prevView?.round?.myTurn)) sfx.turn();
  else if (v.round && prevView?.round && v.round.trick.length > (prevView.round.trick?.length || 0) && !v.round.resolving) sfx.card();
  render();
}

function render() {
  const v = me.view;
  if (!v) return;
  if (v.phase === 'lobby') {
    showScreen('lobby');
    ['#round-overlay', '#over-overlay', '#take-overlay'].forEach((s) => { $(s).hidden = true; });
    renderLobby(v);
  } else {
    showScreen('game');
    renderGame(v);
  }
}

const player = (v, id) => v.players.find((p) => p.id === id);
const pname = (v, id) => (id === v.you ? 'You' : disp(player(v, id)?.name || '?'));

function renderLobby(v) {
  const isHost = v.you === v.hostId;
  $('#lobby-code').textContent = v.code;
  const list = v.players.filter((p) => !p.left);
  $('#lobby-players').innerHTML = list.map((p) => `
    <li class="${p.online ? '' : 'offline'}">
      <span class="dot c${p.color}"></span>
      ${p.photo ? `<img class="avatar" src="${esc(p.photo)}" alt="" referrerpolicy="no-referrer">` : ''}
      <span>${esc(disp(p.name))}</span>
      <span class="tag">${[p.isHost && 'Host', p.id === v.you && 'You', !p.online && 'Offline'].filter(Boolean).join(', ')}</span>
    </li>`).join('') + (list.length < MAX_PLAYERS
    ? `<li class="empty">${list.length < 2 ? 'Waiting for at least one more player…' : `Room for ${MAX_PLAYERS - list.length} more`}</li>` : '');

  $('#host-settings').hidden = !isHost;
  $('#guest-settings').hidden = isHost;
  $('#start-btn').hidden = !isHost;
  $('#lobby-wait').hidden = isHost;
  const s = v.settings;
  if (isHost) {
    $('#set-rounds').value = String(s.rounds);
    $('#set-timer').value = String(s.timer);
    $('#set-take').checked = !!s.allowTake;
    $('#set-early').checked = !!s.earlyPlay;
    if (document.activeElement !== $('#set-crew')) $('#set-crew').value = s.crew || '';
    $('#crew-note').textContent = v.crewNote || (cloud.getUser() ? 'Signed-in hosts can save rounds to a crew.' : 'Sign in (gear icon) to save crew scores.');
    const online = list.filter((p) => p.online).length;
    $('#start-btn').disabled = online < 2;
    $('#start-btn').textContent = online < 2 ? 'Waiting for players' : `Start game (${online} players)`;
  } else {
    $('#guest-settings').innerHTML = `
      <li>Rounds: <b>${s.rounds ? s.rounds : 'Unlimited'}</b></li>
      <li>Turn timer: <b>${s.timer ? s.timer + ' seconds' : 'Off'}</b></li>
      <li>Play early: <b>${s.earlyPlay ? 'On' : 'Off'}</b></li>
      <li>Take the next player’s cards: <b>${s.allowTake ? 'Allowed' : 'Off'}</b></li>
      ${s.crew ? `<li>Crew: <b>${esc(s.crew)}</b></li>` : ''}`;
  }
}

function renderGame(v) {
  const isHost = v.you === v.hostId;
  const r = v.round;
  $('#game-code').textContent = v.code;
  $('#game-round').textContent = v.settings.rounds ? `Round ${v.roundNo} of ${v.settings.rounds}` : `Round ${v.roundNo}`;
  $('#end-round-btn').hidden = !(isHost && v.phase === 'playing');

  renderSeats(v);
  renderTrick(v);
  renderHand(v);
  renderScores(v);
  renderOverlays(v);
  tickClock();

  if (r?.resolving && r.resolving.seq !== animatedSeq) {
    animatedSeq = r.resolving.seq;
    setTimeout(() => animateTrickAway(r.resolving), 650);
  }
}

// Seat angles: me at the bottom, then clockwise (left, top, right), evenly spaced.
function seatLayout(v) {
  const r = v.round;
  const order = r ? r.seats : v.players.filter((p) => !p.left).map((p) => p.id);
  const myIdx = order.indexOf(v.you);
  const rot = myIdx >= 0 ? order.slice(myIdx).concat(order.slice(0, myIdx)) : order.slice();
  const n = rot.length;
  const pos = {};
  rot.forEach((id, i) => {
    const a = Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1);
    pos[id] = { cx: Math.cos(a), cy: Math.sin(a) };
  });
  return { order: rot, pos };
}

// Faces: the expression follows how many cards a player holds.
const FACE_EYES = '<circle cx="20" cy="24" r="3.6"/><circle cx="36" cy="24" r="3.6"/>';
const FACES = {
  cool: { label: 'safe', svg: '<path class="fill" d="M11 20h14v6.5a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3zM31 20h14v6.5a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3z"/><path d="M25 22h6"/><path d="M19 37q9 6 18 0"/>' },
  thrilled: { label: 'thrilled', svg: FACE_EYES + '<path class="fill" d="M16 32q12 15 24 0z"/>' },
  happy: { label: 'happy', svg: FACE_EYES + '<path d="M18 34q10 9 20 0"/>' },
  unsure: { label: 'unsure', svg: FACE_EYES + '<path d="M19 37h18"/>' },
  nervous: { label: 'nervous', svg: FACE_EYES + '<path d="M18 40q10-9 20 0"/><path class="sweat" d="M45 10q4.5 6.5 0 9.5q-4.5-3 0-9.5z"/>' },
  shocked: { label: 'shocked', svg: '<circle cx="20" cy="23" r="5.5" class="hollow"/><circle cx="36" cy="23" r="5.5" class="hollow"/><circle cx="20" cy="23" r="2"/><circle cx="36" cy="23" r="2"/><ellipse class="hollow" cx="28" cy="38" rx="5" ry="6"/>' },
};
function moodFor(p, r) {
  if ((shockedUntil[p.id] || 0) > Date.now()) return 'shocked';
  if (r && p.safe) return 'cool';
  const n = r && p.inRound ? p.count : null;
  if (n === null) return 'happy';
  if (n <= 3) return 'thrilled';
  if (n <= 7) return 'happy';
  if (n <= 12) return 'unsure';
  return 'nervous';
}
const dangerOf = (n) => (n <= 7 ? 'ok' : n <= 12 ? 'warn' : 'bad');
function faceHTML(mood) {
  return `<span class="av face-${mood}"><svg viewBox="0 0 56 56" aria-hidden="true">${FACES[mood].svg}</svg></span>`;
}
const shockedUntil = {};
const chatBubbles = {}; // player id -> { text, until }

function renderSeats(v) {
  const r = v.round;
  const { order, pos } = seatLayout(v);
  $('#seats').innerHTML = order.map((id) => {
    const p = player(v, id); if (!p) return '';
    const { cx, cy } = pos[id];
    const isTurn = r && r.turn === id && !r.resolving;
    const lost = v.result && !v.result.ended && v.result.loser === id && v.phase !== 'playing';
    let flag = '';
    if (r && !p.inRound) flag = '<span class="seat-flag wait">Next round</span>';
    else if (r && p.safe) flag = `<span class="seat-flag safe">Safe · ${ordinal(p.safe)}</span>`;
    else if (!p.online) flag = '<span class="seat-flag">Offline</span>';
    else if (r?.take && r.take.to === id) flag = '<span class="seat-flag wait">Deciding…</span>';
    else if (lost) flag = '<span class="seat-flag lost">Lost</span>';
    const count = r && p.inRound ? `<span class="cnt" aria-label="${p.count} cards">${p.count}</span>` : '';
    const mood = moodFor(p, r);
    const danger = r && p.inRound && !p.safe
      ? `<span class="danger ${dangerOf(p.count)}" aria-hidden="true"><i style="width:${Math.min(100, Math.round((p.count / 16) * 100))}%"></i></span>` : '';
    const chat = chatBubbles[id] && chatBubbles[id].until > Date.now() ? `<span class="bubble">${esc(chatBubbles[id].text)}</span>` : '';
    const cls = ['seat', 'c' + p.color, isTurn && 'turn', p.safe && 'safe', !p.online && 'offline', id === v.you && 'me', cy > 0.6 && 'low'].filter(Boolean).join(' ');
    const tag = `<span class="seat-tag"><span class="nm">${esc(id === v.you ? 'You' : disp(p.name))}</span>${count}</span>`;
    return `<div class="${cls}" data-seat="${id}" style="--cx:${cx.toFixed(3)};--cy:${cy.toFixed(3)}" title="${esc(disp(p.name))}, ${FACES[mood].label}">
      ${chat}<span class="ring">${faceHTML(mood)}</span>${tag}${danger}${flag}</div>`;
  }).join('');
}

function cardTilt(c) {
  let h = 0; for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return (h % 15) - 7;
}

function renderTrick(v) {
  const r = v.round;
  const trickEl = $('#trick');
  const pile = $('#discard-pile');
  pile.classList.toggle('empty', !r?.discarded);
  pile.hidden = !r;
  if (!r) { trickEl.innerHTML = ''; $('#table-note').textContent = ''; shownTrick = new Set(); return; }
  const { pos } = seatLayout(v);
  const led = r.trick.length ? E.suitOf(r.trick[0].card) : null;
  let topIdx = -1;
  r.trick.forEach((t, i) => {
    if (E.suitOf(t.card) === led && (topIdx < 0 || E.rankOf(t.card) > E.rankOf(r.trick[topIdx].card))) topIdx = i;
  });
  trickEl.innerHTML = r.trick.map((t, i) => {
    const { cx, cy } = pos[t.id] || { cx: 0, cy: 0 };
    const off = E.suitOf(t.card) !== led && !r.first;
    const cls = ['tcard', !shownTrick.has(t.card) && 'new', off && 'offsuit', i === topIdx && r.trick.length > 1 && !off && 'top'].filter(Boolean).join(' ');
    return `<div class="${cls}" style="--cx:${cx.toFixed(3)};--cy:${cy.toFixed(3)};--r:${(0.56 - 0.08 * Math.abs(cy)).toFixed(2)};--tilt:${cardTilt(t.card)}deg;--fx:${(cx * 70).toFixed(0)}px;--fy:${(cy * 70).toFixed(0)}px;z-index:${i + 1}" title="${esc(pname(v, t.id))}">
      ${cardHTML(t.card)}${t.early ? '<span class="early">early</span>' : ''}</div>`;
  }).join('');
  shownTrick = new Set(r.trick.map((t) => t.card));

  let note = '';
  const ledChip = (s) => `<span class="led ${s}">${E.SUIT_SYMBOL[s]} led</span>`;
  if (r.resolving) {
    note = r.resolving.kind === 'pickup'
      ? `${esc(pname(v, r.resolving.winner))} ${r.resolving.winner === v.you ? 'pick' : 'picks'} up`
      : `Discarded. ${esc(pname(v, r.resolving.winner))} ${r.resolving.winner === v.you ? 'lead' : 'leads'}`;
  } else if (r.take) {
    note = `${esc(pname(v, r.take.from))} asked ${esc(pname(v, r.take.to))} for their cards`;
  } else if (r.turn) {
    const who = r.turn === v.you ? 'Your turn' : `${esc(disp(player(v, r.turn)?.name))}’s turn`;
    note = (led ? ledChip(led) + '<br>' : '') + who + (r.first && !led ? '<br>A♠ leads' : '') + (r.stuck && r.turn !== v.you ? ' (offline)' : '');
  }
  $('#table-note').innerHTML = note;
}

function cardHTML(c, extra = '', tag = 'div', attrs = '') {
  const s = E.suitOf(c), sym = E.SUIT_SYMBOL[s], r = E.rankOf(c), rank = E.rankLabel(r);
  const long = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack' }[rank] || rank;
  const face = r >= 11 && r <= 13;
  const pip = face ? `<span class="pip">${rank}<small>${sym}</small></span>` : `<span class="pip">${sym}</span>`;
  const ix = `<span class="ix" aria-hidden="true">${rank}<i>${sym}</i></span>`;
  return `<${tag} class="card ${s}${face ? ' face' : ''}${r === 14 ? ' ace' : ''} ${extra}" data-card="${c}" aria-label="${long} of ${E.SUIT_NAME[s]}" ${attrs}>${ix}<span aria-hidden="true">${pip}</span>${ix.replace('class="ix"', 'class="ix b"')}</${tag}>`;
}

let selectedCard = null;

function renderHand(v) {
  const r = v.round;
  const handEl = $('#hand');
  const status = $('#hand-status');
  const me_ = player(v, v.you);
  $('#take-btn').hidden = true; $('#playfor-btn').hidden = true; $('#take-bar').hidden = true; $('#play-sel-btn').hidden = true;
  const early = new Set(r?.early || []);
  const legal = new Set(r?.legal || []);
  const active = Boolean(r?.myTurn || early.size);
  handEl.classList.toggle('active', active);
  status.className = 'pill';
  status.hidden = !r;

  if (!r) { handEl.innerHTML = ''; status.textContent = ''; selectedCard = null; return; }
  if (!r.hand) {
    handEl.innerHTML = '<p class="hand-empty">You’ll be dealt in next round.</p>';
    status.textContent = 'Watching this round';
    return;
  }
  const ledSuit = r.trick.length ? E.suitOf(r.trick[0].card) : null;
  if (me_?.safe) {
    status.classList.add('safe');
    status.textContent = `You’re safe, ${ordinal(me_.safe)} out`;
  } else if (r.myTurn) {
    status.classList.add('go');
    status.textContent = !ledSuit
      ? (r.first ? 'Your turn · lead the A♠' : 'Your turn · lead any card')
      : r.legal.some((c) => E.suitOf(c) === ledSuit)
        ? `Your turn · follow ${E.SUIT_SYMBOL[ledSuit]}`
        : `No ${E.SUIT_SYMBOL[ledSuit]} · give a thulla!`;
  } else if (early.size) {
    status.classList.add('early');
    status.textContent = `You can play a ${E.SUIT_SYMBOL[ledSuit]} early`;
  } else if (r.take && r.take.from === v.you) {
    status.textContent = 'Waiting for an answer…';
  } else if (r.resolving) {
    status.textContent = `You have ${r.hand.length} card${r.hand.length === 1 ? '' : 's'}`;
  } else {
    status.textContent = `${disp(player(v, r.turn)?.name || '')}’s turn · you have ${r.hand.length}`;
  }

  if (r.canTake && r.takeTarget) {
    const t = player(v, r.takeTarget);
    $('#take-btn').hidden = false;
    $('#take-btn').textContent = `Ask ${disp(t?.name)} for their cards`;
  }
  if (r.playFor) {
    $('#playfor-btn').hidden = false;
    $('#playfor-btn').textContent = `Play for ${disp(player(v, r.playFor)?.name)}`;
  }
  if (r.take && r.take.to !== v.you) {
    $('#take-bar').hidden = false;
    $('#take-bar').innerHTML = `<span>${esc(pname(v, r.take.from))} asked ${esc(pname(v, r.take.to))} for their cards.</span> <span class="muted" data-take-clock></span>`;
  }

  const hand = E.sortHand(r.hand);
  if (selectedCard && !legal.has(selectedCard) && !early.has(selectedCard)) selectedCard = null;
  if (selectedCard) {
    $('#play-sel-btn').hidden = false;
    $('#play-sel-btn').textContent = `Play ${E.cardLabel(selectedCard)}`;
  }
  if (!hand.length) { handEl.innerHTML = `<p class="hand-empty">${me_?.safe ? 'No cards left. Enjoy the show.' : 'No cards left.'}</p>`; return; }
  const card = (c) => {
    const kind = legal.has(c) ? 'legal' : early.has(c) ? 'early' : active ? 'dim' : '';
    const playable = kind === 'legal' || kind === 'early';
    return cardHTML(c, kind + (c === selectedCard ? ' selected' : ''), 'button',
      `type="button" ${playable ? '' : 'tabindex="-1" aria-disabled="true"'}`);
  };
  // Lay out: one fanned row, or two if the cards would overlap too much.
  const cw = parseFloat(getComputedStyle(handEl).getPropertyValue('--cw')) || 84;
  const tiltPad = cw * 1.4 * Math.sin((7 * Math.PI) / 180) + 4;
  const avail = Math.max(200, handEl.clientWidth - 16 - 2 * tiltPad);
  const tooTight = (n) => (avail - cw) / Math.max(1, n - 1) < cw * 0.34;
  const half = Math.ceil(hand.length / 2);
  const rows = hand.length > 8 && tooTight(hand.length) ? [hand.slice(0, half), hand.slice(half)] : [hand];
  handEl.innerHTML = rows.map((row) => `<div class="hand-row">${row.map(card).join('')}</div>`).join('');
  handEl.querySelectorAll('.hand-row').forEach((rowEl, ri) => {
    const cards = [...rowEl.children];
    const n = cards.length;
    const step = n > 1 ? Math.min(cw + 6, (avail - cw) / (n - 1)) : 0;
    const overlap = step - cw;
    const maxTilt = Math.min(7, n * 0.8);
    cards.forEach((el, i) => {
      const t = n > 1 ? (i - (n - 1) / 2) / ((n - 1) / 2) : 0;
      el.style.setProperty('--overlap', `${overlap}px`);
      el.style.setProperty('--rot', `${(t * maxTilt).toFixed(2)}deg`);
      el.style.setProperty('--arc', `${(-(1 - t * t) * Math.min(12, n * 1.2)).toFixed(1)}px`);
      el.style.zIndex = String(i + 1);
    });
    if (ri > 0) rowEl.style.marginTop = `-${cw * 0.62}px`;
  });
}

function scoresHTML(v) {
  const rows = v.standings;
  const total = rows.reduce((n, x) => n + x.rounds, 0);
  let html = '<h2>Scores</h2><p class="scores-sub">This game</p>';
  if (!total) html += '<p class="scores-empty">Scores appear after the first round.</p>';
  else {
    html += `<table class="scores"><thead><tr><th>Player</th><th title="Times lost">Lost</th><th title="Average finishing position">Avg</th><th title="Thullas given">Thullas</th></tr></thead><tbody>${
      rows.map((x) => `<tr class="${x.gone ? 'gone' : ''}"><td><span class="pname"><span class="dot c${x.color}"></span><span>${esc(disp(x.name))}</span></span></td>
        <td class="losses">${x.losses}</td><td>${x.rounds ? x.avg.toFixed(1) : '–'}</td><td>${x.given}</td></tr>`).join('')
    }</tbody></table><p class="scores-note">Fewest losses wins. Ties go to the better average finish.</p>`;
  }
  if (v.history.length) {
    html += `<p class="history-title">Rounds</p><ul class="history">${v.history.map((h) =>
      `<li>Round ${h.no}: ${h.ended ? 'ended early' : `<b>${esc(disp(h.loser))}</b> lost`}</li>`).join('')}</ul>`;
  }
  if (v.allTime) {
    html += `<p class="scores-sub">All time: ${esc(v.allTime.name)}</p>`;
    html += v.allTime.rows.length
      ? `<table class="scores"><thead><tr><th>Player</th><th>Rounds</th><th>Lost</th><th>Avg</th></tr></thead><tbody>${
        v.allTime.rows.map((x) => `<tr><td><span class="pname"><span>${esc(disp(x.name))}</span></span></td><td>${x.rounds}</td><td class="losses">${x.losses}</td><td>${x.avg.toFixed(1)}</td></tr>`).join('')
      }</tbody></table><p class="scores-note">${v.allTime.rounds} rounds saved. Sorted by how often each player loses.</p>`
      : '<p class="scores-empty">No rounds saved to this crew yet.</p>';
  }
  return html;
}

function renderScores(v) {
  $('#scoreboard').innerHTML = scoresHTML(v);
  if (!$('#scores-overlay').hidden) $('#scores-sheet-body').innerHTML = scoresHTML(v);
}

function renderOverlays(v) {
  const isHost = v.you === v.hostId;
  // Round result
  const showRound = v.phase === 'between';
  $('#round-overlay').hidden = !showRound;
  if (showRound && v.result) {
    const res = v.result;
    if (res.ended) {
      $('#round-title').textContent = `Round ${res.no} ended early`;
      $('#round-sub').textContent = 'Nobody lost this one.';
      $('#round-ranking').innerHTML = '';
    } else {
      const loser = res.results.find((x) => x.lost);
      $('#round-title').textContent = loser.id === v.you ? 'You lost this round' : `${disp(loser.name)} lost round ${res.no}`;
      const thullas = res.results.filter((x) => x.given).sort((a, b) => b.given - a.given);
      $('#round-sub').textContent = thullas.length ? `Most thullas: ${disp(thullas[0].name)} (${thullas[0].given})` : 'No thullas this round.';
      $('#round-ranking').innerHTML = rankingHTML(v, res.results.map((x) => ({
        id: x.id, name: x.name, how: x.lost ? 'Lost' : `Safe, ${ordinal(x.pos)}`, last: x.lost,
      })));
    }
  }
  $('#round-host').hidden = !isHost;
  $('#round-wait').hidden = isHost;

  // Game over
  const showOver = v.phase === 'over';
  $('#over-overlay').hidden = !showOver;
  if (showOver) {
    const fin = (v.final || []).filter((x) => x.rounds);
    const top = fin[0];
    $('#over-title').textContent = top ? (top.id === v.you ? 'You win!' : `${disp(top.name)} wins!`) : 'Game over';
    $('#over-sub').textContent = top ? `After ${v.roundNo} round${v.roundNo === 1 ? '' : 's'}. Fewest losses wins.` : 'No rounds were finished.';
    $('#over-ranking').innerHTML = rankingHTML(v, fin.map((x, i) => ({
      id: x.id, name: x.name, how: `${x.losses} lost · avg ${x.avg.toFixed(1)}`, first: i === 0, last: i === fin.length - 1 && fin.length > 1,
    })));
  }
  $('#over-host').hidden = !isHost;
  $('#over-wait').hidden = isHost;

  // Take request aimed at me
  const tk = v.round?.take;
  const mine = tk && tk.to === v.you;
  $('#take-overlay').hidden = !mine;
  if (mine) {
    const from = player(v, tk.from);
    const myCount = v.round.hand?.length || 0;
    $('#take-text').innerHTML = `<b>${esc(disp(from?.name))}</b> wants your ${myCount} card${myCount === 1 ? '' : 's'}. If you give them, you’re safe and ${esc(disp(from?.name))} holds them.`;
  }
}

function rankingHTML(v, items) {
  return items.map((x) => {
    const p = player(v, x.id);
    return `<li class="${x.first ? 'first' : ''}${x.last ? ' last' : ''}"><span class="dot c${p?.color ?? 0}"></span><span class="who">${esc(x.id === v.you ? 'You' : disp(x.name))}</span><span class="how">${esc(x.how)}</span></li>`;
  }).join('');
}

function tickClock() {
  const v = me.view;
  const clock = $('#clock');
  if (!v?.round) { clock.textContent = ''; clock.classList.remove('urgent'); }
  else if (turnEndsAt) {
    const left = Math.max(0, turnEndsAt - Date.now());
    const s = Math.ceil(left / 1000);
    clock.textContent = `${s}s`;
    clock.classList.toggle('urgent', s <= 5 && v.round.myTurn);
    const ring = document.querySelector('.seat.turn .ring');
    if (ring && v.round.timer) ring.style.setProperty('--pct', (left / (v.round.timer * 1000)).toFixed(3));
  } else { clock.textContent = ''; clock.classList.remove('urgent'); }
  if (takeEndsAt) {
    const s = Math.max(0, Math.ceil((takeEndsAt - Date.now()) / 1000));
    $('#take-clock').textContent = `Answer in ${s}s, or you keep your cards.`;
    const tc = document.querySelector('[data-take-clock]'); if (tc) tc.textContent = `${s}s`;
  }
}
setInterval(tickClock, 250);

// Trick leaving the table: flipped onto the discard pile, or flying to whoever picks it up.
function animateTrickAway(res) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cards = [...document.querySelectorAll('#trick .tcard')];
  if (!cards.length) return;
  let target;
  if (res.kind === 'pickup') {
    target = res.winner === me.id ? $('#hand') : document.querySelector(`[data-seat="${res.winner}"] .ring`);
  } else {
    target = $('#discard-pile');
  }
  if (!target) return;
  const tr = target.getBoundingClientRect();
  const tx = tr.left + tr.width / 2, ty = tr.top + tr.height / 2;
  cards.forEach((el, i) => {
    const rc = el.getBoundingClientRect();
    const clone = el.cloneNode(true);
    clone.classList.add('fly');
    Object.assign(clone.style, { left: rc.left + 'px', top: rc.top + 'px', width: rc.width + 'px' });
    document.body.appendChild(clone);
    el.style.visibility = 'hidden';
    const dx = tx - (rc.left + rc.width / 2), dy = ty - (rc.top + rc.height / 2);
    const frames = res.kind === 'pickup'
      ? [{ transform: 'none' }, { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 30}px) scale(0.85) rotate(${(i - cards.length / 2) * 8}deg)` }, { transform: `translate(${dx}px, ${dy}px) scale(0.4)`, opacity: 0.2 }]
      : [{ transform: 'none' }, { transform: `translate(${dx * 0.5}px, ${dy * 0.5}px) rotateY(90deg) scale(0.9)` }, { transform: `translate(${dx}px, ${dy}px) rotateY(0deg) scale(0.7)`, opacity: 0.6 }];
    const anim = clone.animate(frames, { duration: 650, delay: i * 45, easing: 'cubic-bezier(.4,.1,.3,1)', fill: 'forwards' });
    if (res.kind === 'discard') setTimeout(() => { const c = clone.querySelector('.card'); if (c) { c.classList.add('back'); } }, 325 + i * 45);
    if (res.kind === 'discard') setTimeout(() => $('#discard-pile').classList.remove('empty'), 650);
    anim.onfinish = () => clone.remove();
    setTimeout(() => clone.remove(), 1500);
  });
}

// ===========================================================================
// Home, lobby and game controls
// ===========================================================================
function setBusy(b) { $('#host-btn').disabled = b; $('#join-btn').disabled = b; $('#join-btn').textContent = b ? 'Connecting…' : 'Join room'; }
function showHomeError(m) { $('#home-error').textContent = m || ''; }

function readName() {
  const n = cleanName($('#name-input').value);
  if (!n) { showHomeError('Type your name first.'); $('#name-input').focus(); return null; }
  try { localStorage.setItem('thulla-name', n); } catch {}
  return n;
}

$('#host-btn').addEventListener('click', () => {
  const n = readName(); if (!n) return;
  if (!window.Peer) { showHomeError('Couldn’t load the connection library. Check your internet and reload.'); return; }
  showHomeError('');
  hostStart(n);
});

function doJoin() {
  const n = readName(); if (!n) return;
  const code = $('#code-input').value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) { showHomeError('Room codes are 4 letters.'); $('#code-input').focus(); return; }
  if (!window.Peer) { showHomeError('Couldn’t load the connection library. Check your internet and reload.'); return; }
  joinRoom(code, n);
}
$('#join-btn').addEventListener('click', doJoin);
$('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
$('#code-input').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
$('#name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('#code-input').value ? doJoin() : $('#host-btn').click()); });

$('#copy-link').addEventListener('click', async () => {
  const url = new URL(location.href); url.search = ''; url.searchParams.set('room', me.code);
  try { await navigator.clipboard.writeText(url.toString()); toast('Invite link copied'); }
  catch { prompt('Copy this link:', url.toString()); }
});

$('#set-rounds').addEventListener('change', (e) => hostSetSettings({ rounds: Number(e.target.value) }));
$('#set-timer').addEventListener('change', (e) => hostSetSettings({ timer: Number(e.target.value) }));
$('#set-take').addEventListener('change', (e) => hostSetSettings({ allowTake: e.target.checked }));
$('#set-early').addEventListener('change', (e) => hostSetSettings({ earlyPlay: e.target.checked }));
$('#crew-save').addEventListener('click', () => hostUseCrew($('#set-crew').value));
$('#set-crew').addEventListener('keydown', (e) => { if (e.key === 'Enter') hostUseCrew(e.target.value); });
$('#start-btn').addEventListener('click', () => { $('#lobby-error').textContent = ''; hostStartRound(); });

function confirmLeave() {
  const msg = me.role === 'host'
    ? 'Leave and close the room? The game ends for everyone.'
    : 'Leave the room? You can rejoin later with the same name.';
  if (confirm(msg)) leaveRoom();
}
$('#lobby-leave').addEventListener('click', confirmLeave);
$('#game-leave').addEventListener('click', confirmLeave);
$('#over-leave').addEventListener('click', confirmLeave);

function playCard(c) {
  selectedCard = null;
  const el = document.querySelector(`#hand .card[data-card="${c}"]`);
  if (el) el.classList.add('playing');
  $('#play-sel-btn').hidden = true;
  send({ t: 'play', card: c });
}
$('#hand').addEventListener('click', (e) => {
  const el = e.target.closest('.card.legal, .card.early');
  if (!el) { if (selectedCard) { selectedCard = null; renderHand(me.view); } return; }
  const c = el.dataset.card;
  const touch = e.pointerType ? e.pointerType !== 'mouse' : window.matchMedia('(pointer: coarse)').matches;
  if (!touch || prefs.tapOnce || selectedCard === c) playCard(c);
  else { selectedCard = c; renderHand(me.view); }
});
$('#play-sel-btn').addEventListener('click', () => { if (selectedCard) playCard(selectedCard); });
$('#take-btn').addEventListener('click', () => send({ t: 'take' }));
$('#chat-bar').innerHTML = CHAT_PHRASES.map((t, i) => `<button class="chip" type="button" data-chat="${i}">${esc(t)}</button>`).join('');
$('#chat-btn').addEventListener('click', () => {
  const bar = $('#chat-bar');
  bar.hidden = !bar.hidden;
  $('#chat-btn').setAttribute('aria-expanded', String(!bar.hidden));
});
$('#chat-bar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-chat]');
  if (!b) return;
  send({ t: 'chat', i: Number(b.dataset.chat) });
  $('#chat-bar').hidden = true;
  $('#chat-btn').setAttribute('aria-expanded', 'false');
});
$('#take-accept').addEventListener('click', () => { send({ t: 'takeReply', accept: true }); $('#take-overlay').hidden = true; });
$('#take-decline').addEventListener('click', () => { send({ t: 'takeReply', accept: false }); $('#take-overlay').hidden = true; });
$('#playfor-btn').addEventListener('click', () => hostPlayFor());

$('#end-round-btn').addEventListener('click', () => { if (confirm('End this round for everyone? Nobody loses it.')) hostEndRoundEarly(); });
$('#next-round-btn').addEventListener('click', () => hostStartRound());
$('#end-game-btn').addEventListener('click', () => hostEndGame());
$('#rematch-btn').addEventListener('click', () => hostRematch());
$('#change-settings-btn').addEventListener('click', () => hostChangeSettings());

function openScores() {
  if (!me.view) return;
  $('#scores-sheet-body').innerHTML = scoresHTML(me.view);
  $('#scores-overlay').hidden = false;
}
$('#scores-btn').addEventListener('click', openScores);
$('#round-scores').addEventListener('click', openScores);
$('#over-scores').addEventListener('click', openScores);

function rulesHTML() {
  const s = me.view?.settings;
  const opt = (on) => (s ? (on ? '<span class="on">On in this room</span>' : '') : '');
  const li = (t) => `<li>${t}</li>`;
  let h = '<p class="muted">Get rid of all your cards. The last player holding cards loses the round.</p>';
  h += '<h3>Each trick</h3><ul>' + [
    'Whoever has the A♠ leads it to start every round.',
    'Play goes clockwise. Follow the suit that was led if you can.',
    'Everyone followed? The trick is discarded and the highest card leads next.',
    'Can’t follow? Play any card: that’s a <b>thulla</b>. The trick stops, and the highest card of the led suit picks up the whole trick and leads.',
    'No thullas on the first trick: if you have no spades, play anything.',
  ].map(li).join('') + '</ul>';
  h += '<h3>Getting out</h3><ul>' + [
    'You’re safe once a trick ends and your hand is empty.',
    'If your last card was the highest and someone gives a thulla, you pick it up and you’re back in.',
    'Fewest losses across the game wins.',
  ].map(li).join('') + '</ul>';
  if (!s || s.earlyPlay) h += `<h3>Play early ${opt(s?.earlyPlay)}</h3><ul>` + [
    'After a trick is led, you can throw in a card of that suit before your turn.',
    'Careful: if anyone you skipped gives a thulla, you pick up the trick instead of the highest card.',
  ].map(li).join('') + '</ul>';
  if (!s || s.allowTake) h += `<h3>Taking cards ${opt(s?.allowTake)}</h3><ul>` + [
    'On your turn, before you play, you can ask the next player for their whole hand.',
    'If they agree, they’re safe and you hold their cards. Not allowed with two players left.',
  ].map(li).join('') + '</ul>';
  if (!s) h += '<p class="muted">Play early and taking cards are optional; the host turns them on in the lobby.</p>';
  return h;
}
$$('[data-open-rules]').forEach((b) => b.addEventListener('click', () => {
  $('#rules-body').innerHTML = rulesHTML();
  $('#rules-overlay').hidden = false;
}));

$$('[data-close]').forEach((b) => b.addEventListener('click', () => { b.closest('.overlay').hidden = true; }));
$$('.overlay').forEach((o) => o.addEventListener('click', (e) => {
  if (e.target === o && ['scores-overlay', 'settings-overlay', 'rules-overlay'].includes(o.id)) o.hidden = true;
}));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ['#scores-overlay', '#settings-overlay', '#rules-overlay'].forEach((s) => { $(s).hidden = true; });
});

$('#closed-home').addEventListener('click', () => { $('#closed-overlay').hidden = true; leaveRoom(); });
$('#closed-retry').addEventListener('click', () => {
  const code = me.code, name = me.name;
  $('#closed-overlay').hidden = true;
  try { me.peer && me.peer.destroy(); } catch {}
  joinRoom(code, name);
});

window.addEventListener('resize', () => { if (me.view?.round) renderHand(me.view); });
window.addEventListener('beforeunload', (e) => {
  if (me.role === 'host' && H && H.players.some((p) => !p.isHost && p.online)) { e.preventDefault(); e.returnValue = ''; }
});

// ===========================================================================
// Settings, account and stats
// ===========================================================================
function openSettings() {
  $('#pref-sound').checked = !!prefs.sound;
  $('#pref-contrast').checked = !!prefs.contrast;
  $('#pref-tap').checked = !!prefs.tapOnce;
  $('#pref-slapper').value = prefs.slapper || 'random';
  renderAccount();
  $('#settings-overlay').hidden = false;
  loadStats();
}
$$('[data-open-settings]').forEach((b) => b.addEventListener('click', openSettings));
$('#home-account').addEventListener('click', openSettings);
$('#pref-sound').addEventListener('change', (e) => { prefs.sound = e.target.checked; savePrefs(); if (prefs.sound) sfx.card(); });
$('#pref-contrast').addEventListener('change', (e) => { prefs.contrast = e.target.checked; savePrefs(); applyPrefs(); });
$('#pref-tap').addEventListener('change', (e) => { prefs.tapOnce = e.target.checked; savePrefs(); });
$('#pref-slapper').addEventListener('change', (e) => { prefs.slapper = e.target.value; savePrefs(); });
$('#slap-test').addEventListener('click', () => {
  const kind = pickCritter(prefs.slapper === 'off' ? 'random' : prefs.slapper);
  $('#settings-overlay').hidden = true;
  (kind === 'cat' ? sfx.meow : sfx.grunt)();
  slapMe(kind, 'Thulla!', 'This is what a thulla feels like', () => sfx.slap(true));
});

$('#sign-in-btn').addEventListener('click', async () => {
  $('#account-error').textContent = '';
  if (!cloud.isConfigured()) { $('#account-error').textContent = 'Sign-in isn’t set up yet: the Firebase config is missing from js/cloud.js.'; return; }
  try { await cloud.signIn(); }
  catch (e) {
    if (e?.code === 'auth/popup-closed-by-user' || e?.code === 'auth/cancelled-popup-request') return;
    $('#account-error').textContent = e?.code === 'auth/popup-blocked'
      ? 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.'
      : 'Sign-in didn’t work. Try again.';
  }
});
$('#sign-out-btn').addEventListener('click', () => cloud.signOutUser());

function renderAccount() {
  const u = cloud.getUser();
  $('#account-out').hidden = !!u;
  $('#account-in').hidden = !u;
  $('#stats-section').hidden = !u;
  $('#home-account-label').textContent = u ? u.name.split(' ')[0] : 'Sign in';
  $('#home-avatar').hidden = !(u && u.photo);
  if (u) {
    $('#account-name').textContent = u.name;
    $('#account-email').textContent = u.email;
    $('#account-avatar').src = u.photo || '';
    $('#account-avatar').hidden = !u.photo;
    if (u.photo) $('#home-avatar').src = u.photo;
    if (!$('#name-input').value) $('#name-input').value = cleanName(u.name.split(' ')[0]);
  }
}

async function loadStats() {
  if (!cloud.getUser()) return;
  const grid = $('#stat-grid');
  grid.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const s = await cloud.getMyStats();
    const avg = s.rounds ? (s.posSum / s.rounds).toFixed(1) : '–';
    const pct = s.rounds ? Math.round((100 * s.losses) / s.rounds) + '%' : '–';
    const cell = (b, l) => `<div class="stat"><b>${b}</b><span>${l}</span></div>`;
    grid.innerHTML = cell(s.rounds, 'Rounds played') + cell(s.losses, 'Times lost') + cell(pct, 'Loss rate')
      + cell(avg, 'Avg finish') + cell(s.given, 'Thullas given') + cell(s.received, 'Thullas received');
    $('#stats-note').textContent = s.rounds ? 'Saved from every round you finish while signed in.' : 'Finish a round while signed in to start your stats.';
  } catch {
    grid.innerHTML = '';
    $('#stats-note').textContent = 'Couldn’t load your stats. Check your connection.';
  }
}

cloud.onUser(() => {
  renderAccount();
  if (!$('#settings-overlay').hidden) loadStats();
  if (me.view?.phase === 'lobby') render();
});

// ===========================================================================
// Start up
// ===========================================================================
applyPrefs();
cloud.restore();
renderAccount();
try { $('#name-input').value = localStorage.getItem('thulla-name') || $('#name-input').value; } catch {}
{
  const params = new URLSearchParams(location.search);
  const room = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  const sess = loadSession();
  if (sess?.role === 'host') {
    clearSession();
    showHomeError('Your room closed when this page reloaded. Host a new room to play again.');
  }
  if (room) {
    $('#code-input').value = room;
    if (sess && sess.role === 'guest' && sess.code === room && sess.name && window.Peer) {
      $('#name-input').value = sess.name;
      joinRoom(room, sess.name);
    } else {
      $('#name-input').focus();
    }
  }
}

if (DEBUG) window.thullaDebug = { me, get host() { return H; }, E, onFx };
