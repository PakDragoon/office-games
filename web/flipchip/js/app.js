import * as E from './engine.js';
import * as cloud from './cloud.js';

/* =========================================================
   Flipchip
   Two players take turns placing two-sided chips. A chip must trap a straight line of the
   opponent's chips between itself and another of yours; the trapped chips flip. Most chips
   when nobody can move wins.
   Rooms: one player hosts; their browser is the "server". It checks every move and
   broadcasts the board. Two people sit (Dark and Light), everyone else watches. Connections
   use PeerJS (WebRTC). Playing the computer runs the same host code locally, with a bot in
   one seat, so rooms and solo games share every rule and screen.
   ========================================================= */

const PREFIX = 'flipchip-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PEER_OPTIONS = { debug: 1 };
const PING_MS = 2000;
const AWAY_MS = 9000;
const LOST_MS = 12000;
const BOT_ID = 'cpu';
const SOLO_ID = 'me';
const LEVEL_NAME = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
const { DARK, LIGHT } = E;

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const chipHtml = (s) => `<span class="chip${s === LIGHT ? ' is-l' : ''}"><i class="f d"></i><i class="f l"></i></span>`;
const miniChip = (s) => `<span class="mini-chip">${chipHtml(s)}</span>`;
const tinyChip = (s) => `<span class="mini-chip sm">${chipHtml(s)}</span>`;

/* ---------- This browser only ---------- */
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`flipchip.${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`flipchip.${key}`, JSON.stringify(value)); } catch { /* not saved */ }
  },
};
const PREFS = { sound: true, vibrate: true, reactions: true, confirm: 'auto', anim: 'on', analytics: true, ...store.get('prefs', {}) };
let ROOM_PREFS = E.cleanSettings(store.get('room', {}));
const CPU_PREFS = { level: 'normal', side: '1', size: 8, ...store.get('cpu', {}) };
if (!E.LEVELS.includes(CPU_PREFS.level)) CPU_PREFS.level = 'normal';
if (!['1', '2', 'random'].includes(String(CPU_PREFS.side))) CPU_PREFS.side = '1';
if (!E.SIZES.includes(Number(CPU_PREFS.size))) CPU_PREFS.size = 8;
const savePrefs = () => store.set('prefs', PREFS);
const saveRoomPrefs = () => store.set('room', ROOM_PREFS);

// Identifies this tab to the host: survives a refresh, different for every person
const CLIENT_ID = (() => {
  const fresh = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  try {
    let id = sessionStorage.getItem('flipchip.client');
    if (!id) { id = fresh(); sessionStorage.setItem('flipchip.client', id); }
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
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
const SOUND = {
  place() { if (PREFS.sound) { tone(190, 0, 0.09, 0.22, 'triangle'); tone(95, 0, 0.12, 0.12, 'sine'); } },
  flips(groups) {
    if (!PREFS.sound) return;
    groups.slice(0, 8).forEach((delay, k) => tone(1100 + k * 70, 0.12 + delay / 1000, 0.045, 0.05, 'square'));
  },
  turn() {
    if (PREFS.vibrate && navigator.vibrate) navigator.vibrate(70);
    if (PREFS.sound) { tone(660, 0, 0.22); tone(880, 0.1, 0.26); }
  },
  pass() { if (PREFS.sound) { tone(392, 0, 0.16, 0.12, 'triangle'); tone(294, 0.12, 0.22, 0.12, 'triangle'); } },
  nope() { if (PREFS.sound) tone(150, 0, 0.16, 0.1, 'sawtooth'); },
  tick() { if (PREFS.sound) tone(1500, 0, 0.03, 0.035, 'square'); },
  win() { if (PREFS.sound) [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.26, 0.13, 'triangle')); },
  lose() { if (PREFS.sound) [440, 370, 311].forEach((f, i) => tone(f, i * 0.13, 0.3, 0.11, 'triangle')); },
  pop() { if (PREFS.sound) tone(1250, 0, 0.05, 0.05); },
};

/* ---------- The computer thinks in a Web Worker (or here, if workers aren't available) ---------- */
const AI = { worker: null, broken: false, seq: 0, pending: new Map() };
function think(board, n, who, level, ms = 1100) {
  const seed = E.randomSeed();
  const local = () => new Promise((resolve) => setTimeout(() => {
    resolve(E.chooseMove(board, n, who, level, { rnd: E.mulberry32(seed), ms }));
  }, 0));
  if (AI.broken || typeof Worker === 'undefined') return local();
  try {
    if (!AI.worker) {
      AI.worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
      AI.worker.onmessage = (e) => {
        const done = AI.pending.get(e.data.id);
        AI.pending.delete(e.data.id);
        if (done) done.resolve(e.data.move);
      };
      AI.worker.onerror = (e) => {
        e.preventDefault?.();
        console.warn('The computer player’s worker failed; thinking on the page instead.', e.message);
        AI.broken = true;
        AI.worker?.terminate();
        AI.worker = null;
        const waiting = [...AI.pending.values()];
        AI.pending.clear();
        waiting.forEach((w) => w.fallback().then(w.resolve));
      };
    }
    const id = ++AI.seq;
    return new Promise((resolve) => {
      AI.pending.set(id, { resolve, fallback: local });
      AI.worker.postMessage({ id, board, n, who, level, seed, ms });
    });
  } catch (err) {
    console.warn(err);
    AI.broken = true;
    return local();
  }
}

/* =========================================================
   Hosting (rooms, and solo games against the computer)
   ========================================================= */
const S = {
  myName: '', myId: null, isHost: false, peer: null, hostConn: null, code: '', view: null, leaving: false,
  heard: 0, reconnecting: false, viewAt: 0, gameShown: -1, moveSeen: -1, sizeBuilt: 0, savedGame: -1,
  preview: -1, hint: null, sentSeq: -1, sentAt: 0, pointer: 'mouse', focus: -1, passSeen: -1, reactAt: 0, overSeen: -1,
};
const H = { room: null, conns: new Map(), seen: new Map(), turnTimer: 0, botToken: 0, reactAt: new Map(), rnd: Math.random };

function randomCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

function newRoom(code, solo, settings) {
  return {
    code, solo, status: 'lobby', settings: { ...settings }, game: 0, players: [],
    seats: { 1: null, 2: null }, board: null, size: settings.size, turn: 0, moveSeq: 0,
    last: null, pass: null, log: [], history: [], turnEnd: 0, result: null, matchWinner: null,
    level: null, crew: null, crewStatus: '',
  };
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
    H.room = newRoom(code, false, ROOM_PREFS);
    H.room.players.push(newPlayer(id, S.myName, true, 0, u?.uid || null, u?.photo || ''));
    H.room.seats[DARK] = id;
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
    id, name, isHost, isBot: false, color, uid, photo, clientId: '', connected: true, away: false, offlineAt: 0,
    games: 0, wins: 0, draws: 0, matchWins: 0,
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
  // Everything except joining needs a seat in the room
  if (msg.t !== 'join' && !byId(conn.peer)) return;
  switch (msg.t) {
    case 'join': return hostJoin(conn, msg.name, msg.uid, msg.photo, msg.client);
    case 'move': return hostMove(conn.peer, msg.i, msg.seq);
    case 'sit': return hostSit(conn.peer, Number(msg.side));
    case 'stand': return hostStand(conn.peer);
    case 'resign': return hostResign(conn.peer);
    case 'claim': return hostClaim(conn.peer);
    case 'react': return hostReact(conn.peer, msg.e);
    default: return undefined;
  }
}

function hostJoin(conn, rawName, uid, photo, client) {
  const room = H.room;
  if (room.solo) return;
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
    renameId(old.id, conn.peer);
    Object.assign(old, { connected: true, away: false, offlineAt: 0, clientId: clientId || old.clientId, uid: cleanUid || old.uid, photo: cleanPhoto(photo) || old.photo });
    H.conns.set(conn.peer, conn);
    H.seen.set(conn.peer, Date.now());
    send(conn, { t: 'welcome', id: conn.peer, code: room.code });
    hostBroadcast();
    return;
  }
  if (room.players.length >= E.MAX_PLAYERS) {
    const gone = room.players.filter((p) => !p.connected && !isSeated(p.id));
    room.players = room.players.filter((p) => !gone.includes(p));
  }
  if (room.players.length >= E.MAX_PLAYERS) return reject(conn, `This room is full (${E.MAX_PLAYERS} people).`);
  let finalName = name;
  for (let n = 2; room.players.some((p) => p.name.toLowerCase() === finalName.toLowerCase()); n++) finalName = `${name} ${n}`;
  const seat = newPlayer(conn.peer, finalName, false, freeColor(), cleanUid, cleanPhoto(photo));
  seat.clientId = clientId;
  room.players.push(seat);
  // In the lobby a newcomer takes an empty seat; mid-game they watch
  if (room.status === 'lobby') {
    if (!room.seats[DARK]) room.seats[DARK] = conn.peer;
    else if (!room.seats[LIGHT]) room.seats[LIGHT] = conn.peer;
  }
  H.conns.set(conn.peer, conn);
  H.seen.set(conn.peer, Date.now());
  send(conn, { t: 'welcome', id: conn.peer, code: room.code });
  hostBroadcast();
}

// A player came back on a new connection: everything that pointed at the old id follows
function renameId(from, to) {
  const room = H.room;
  const p = byId(from);
  if (p) p.id = to;
  for (const s of [DARK, LIGHT]) if (room.seats[s] === from) room.seats[s] = to;
  if (room.result?.ids) for (const s of [DARK, LIGHT]) if (room.result.ids[s] === from) room.result.ids[s] = to;
  if (room.matchWinner === from) room.matchWinner = to;
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
  if (room.status === 'lobby') {
    room.players = room.players.filter((x) => x !== p);
    for (const s of [DARK, LIGHT]) if (room.seats[s] === p.id) room.seats[s] = null;
  } else {
    p.connected = false;
    p.offlineAt = Date.now();
  }
  hostBroadcast();
}

const active = (p) => p.connected && !p.away;
const byId = (id) => H.room.players.find((p) => p.id === id);
const isSeated = (id) => H.room.seats[DARK] === id || H.room.seats[LIGHT] === id;
const seatOf = (id) => (H.room.seats[DARK] === id ? DARK : H.room.seats[LIGHT] === id ? LIGHT : 0);

function hostHeartbeat() {
  const room = H.room;
  if (!room || !S.isHost || room.solo) return;
  for (const conn of H.conns.values()) send(conn, { t: 'hb' });
  const now = Date.now();
  let changed = false;
  for (const p of room.players) {
    if (p.isHost || !p.connected) continue;
    const away = now - (H.seen.get(p.id) || 0) > AWAY_MS;
    if (away !== p.away) { p.away = away; changed = true; }
  }
  if (changed) hostBroadcast();
}

/* ---------- Seats (in the lobby) ---------- */

function hostSit(pid, side) {
  const room = H.room;
  if (room.solo || room.status !== 'lobby' || ![DARK, LIGHT].includes(side)) return;
  const holder = room.seats[side] ? byId(room.seats[side]) : null;
  if (holder && holder.id !== pid && holder.connected) return;
  for (const s of [DARK, LIGHT]) if (room.seats[s] === pid) room.seats[s] = null;
  room.seats[side] = pid;
  hostBroadcast();
}

function hostStand(pid) {
  const room = H.room;
  if (room.solo || room.status !== 'lobby') return;
  for (const s of [DARK, LIGHT]) if (room.seats[s] === pid) room.seats[s] = null;
  hostBroadcast();
}

function hostSwapSeats() {
  const room = H.room;
  if (room.solo || room.status !== 'lobby') return;
  [room.seats[DARK], room.seats[LIGHT]] = [room.seats[LIGHT], room.seats[DARK]];
  hostBroadcast();
}

/* ---------- A game ---------- */

function clearTimers() {
  clearTimeout(H.turnTimer);
  H.botToken++;
}

function seatsReady(room) {
  return [DARK, LIGHT].every((s) => {
    const p = room.seats[s] && byId(room.seats[s]);
    return p && p.connected;
  });
}

function hostStartGame() {
  const room = H.room;
  if (!seatsReady(room)) {
    toast(room.status === 'lobby' ? 'Both seats need a player' : 'A player has left. Change settings to pick who plays.');
    return;
  }
  if (room.status === 'lobby' && !room.solo) {
    const typedCrew = $('crew-input').value.replace(/\s+/g, ' ').trim();
    if (typedCrew !== (room.crew ? room.crew.name : '')) hostSetCrew(typedCrew);
    room.settings = { ...ROOM_PREFS };
  }
  // A rematch: colours swap (or not) as the room chose
  if (room.status === 'over' && !room.solo) {
    const c = room.settings.colours;
    if (c === 'swap' || (c === 'random' && H.rnd() < 0.5)) [room.seats[DARK], room.seats[LIGHT]] = [room.seats[LIGHT], room.seats[DARK]];
  }
  if (room.matchWinner) {
    for (const p of room.players) p.matchWins = 0;
    room.matchWinner = null;
  }
  clearTimers();
  room.size = room.settings.size;
  Object.assign(room, {
    status: 'play', board: E.newBoard(room.size), turn: DARK, moveSeq: 0, last: null, pass: null,
    log: [], history: [], result: null, game: room.game + 1,
  });
  cloud.track('game_started', { size: room.size, vs: room.solo ? room.level : 'room' });
  hostAfterTurn();
}

// After every move (or at the start): the move timer, and the computer's turn
function hostAfterTurn() {
  const room = H.room;
  clearTimeout(H.turnTimer);
  H.botToken++;
  room.turnEnd = 0;
  if (room.status !== 'play') { hostBroadcast(); return; }
  const ms = room.solo ? 0 : E.timerMs(room.settings);
  if (ms) {
    room.turnEnd = Date.now() + ms;
    H.turnTimer = setTimeout(hostTimeUp, ms + 60);
  }
  hostBroadcast();
  if (room.seats[room.turn] === BOT_ID) hostBotMove();
}

function hostTimeUp() {
  const room = H.room;
  if (!room || room.status !== 'play' || !room.turnEnd) return;
  if (Date.now() < room.turnEnd - 30) { H.turnTimer = setTimeout(hostTimeUp, room.turnEnd - Date.now() + 30); return; }
  const m = E.chooseMove(room.board, room.size, room.turn, 'random', { rnd: H.rnd });
  hostMove(room.seats[room.turn], m, room.moveSeq, true);
}

function hostBotMove() {
  const room = H.room;
  const token = H.botToken;
  const seq = room.moveSeq;
  const started = performance.now();
  // Let the last move's chips finish flipping, and look like it's thinking
  const minWait = (room.moveSeq === 0 ? 700 : 950) + (room.level === 'hard' ? 0 : 250);
  think(room.board.slice(), room.size, room.turn, room.level, 1100).then((m) => {
    const wait = Math.max(0, minWait - (performance.now() - started));
    setTimeout(() => {
      if (H.room !== room || H.botToken !== token || room.moveSeq !== seq || room.status !== 'play') return;
      hostMove(BOT_ID, m, seq);
    }, wait);
  });
}

function hostMove(pid, i, seq, auto = false) {
  const room = H.room;
  if (room.status !== 'play' || room.seats[room.turn] !== pid) return;
  if (seq !== undefined && seq !== room.moveSeq) return;   // a stale click from before the last move
  const side = room.turn;
  const r = E.play(room.board, room.size, i, side);
  if (!r) return;
  if (room.solo && pid !== BOT_ID) {
    room.history.push({ board: room.board, turn: room.turn, moveSeq: room.moveSeq, last: room.last, pass: room.pass, log: room.log.length });
    if (room.history.length > 80) room.history.shift();
  }
  room.board = r.board;
  room.moveSeq++;
  room.last = { i, side, flips: r.flips, auto };
  room.log.push({ side, i });
  const next = E.nextTurn(room.board, room.size, side);
  if (!next) return hostGameOver('count');
  if (next === side) {
    room.pass = { side: E.other(side), seq: room.moveSeq };
    room.log.push({ side: E.other(side), pass: true });
  } else room.pass = null;
  room.turn = next;
  hostAfterTurn();
}

function hostResign(pid) {
  const room = H.room;
  const side = seatOf(pid);
  if (room.status !== 'play' || !side || pid === BOT_ID) return;
  hostGameOver('resign', E.other(side));
}

function hostClaim(pid) {
  const room = H.room;
  const side = seatOf(pid);
  if (room.status !== 'play' || !side || room.solo) return;
  const opp = byId(room.seats[E.other(side)]);
  if (!opp || opp.connected || Date.now() - opp.offlineAt < E.TIMES.offlineClaimMs) return;
  hostGameOver('forfeit', side);
}

function hostGameOver(reason, winnerSide) {
  const room = H.room;
  clearTimers();
  const winner = reason === 'count' ? E.winnerOf(room.board) : winnerSide;
  room.status = 'over';
  room.turn = 0;
  room.turnEnd = 0;
  room.result = {
    reason, winner, counts: E.counts(room.board),
    ids: { 1: room.seats[DARK], 2: room.seats[LIGHT] },
  };
  for (const s of [DARK, LIGHT]) {
    const p = byId(room.seats[s]);
    if (!p) continue;
    p.games++;
    if (!winner) p.draws++;
    else if (winner === s) { p.wins++; p.matchWins++; }
  }
  const target = E.matchTarget(room.settings);
  const w = winner && byId(room.seats[winner]);
  if (!room.solo && target && w && w.matchWins >= target) room.matchWinner = w.id;
  if (room.solo) {
    const mySide = seatOf(SOLO_ID);
    const rec = store.get('record', {});
    const r = { w: 0, l: 0, d: 0, ...rec[room.level] };
    if (!winner) r.d++; else if (winner === mySide) r.w++; else r.l++;
    rec[room.level] = r;
    store.set('record', rec);
  }
  cloud.track('game_finished', { reason, vs: room.solo ? room.level : 'room', size: room.size });
  if (!room.solo) hostSaveCrew();
  hostBroadcast();
}

function hostBackToLobby() {
  const room = H.room;
  if (room.solo) return;
  clearTimers();
  room.status = 'lobby';
  room.players = room.players.filter((p) => p.connected);
  for (const s of [DARK, LIGHT]) if (room.seats[s] && !byId(room.seats[s])) room.seats[s] = null;
  hostBroadcast();
}

function hostReact(pid, e) {
  const room = H.room;
  if (room.solo || !E.REACTIONS.includes(e)) return;
  const now = Date.now();
  if (now - (H.reactAt.get(pid) || 0) < 900) return;
  H.reactAt.set(pid, now);
  const msg = { t: 'react', pid, e };
  for (const conn of H.conns.values()) send(conn, msg);
  onMessage(msg);
}

/* ---------- Solo: the computer ---------- */

function startSolo(resume = null) {
  closeRoom();
  const level = resume ? resume.level : CPU_PREFS.level;
  const size = resume ? resume.size : Number(CPU_PREFS.size);
  const side = resume ? resume.mySide
    : CPU_PREFS.side === 'random' ? (Math.random() < 0.5 ? DARK : LIGHT) : Number(CPU_PREFS.side);
  Object.assign(S, { myId: SOLO_ID, isHost: true, code: '', leaving: false, gameShown: -1, savedGame: -1 });
  H.rnd = E.mulberry32(E.randomSeed());
  const u = cloud.getUser();
  const room = newRoom('', true, { ...E.DEFAULT_SETTINGS, size, colours: 'keep' });
  room.level = level;
  room.players.push(newPlayer(SOLO_ID, S.myName || 'You', true, 0, u?.uid || null, u?.photo || ''));
  room.players.push({ ...newPlayer(BOT_ID, `Computer (${LEVEL_NAME[level]})`, false, 1), isBot: true });
  room.seats[side] = SOLO_ID;
  room.seats[E.other(side)] = BOT_ID;
  H.room = room;
  if (resume) {
    Object.assign(room, {
      status: 'play', board: resume.board, turn: resume.turn, moveSeq: resume.moveSeq, last: resume.last,
      pass: resume.pass, log: resume.log, history: resume.history || [], game: 1,
    });
    hostAfterTurn();
  } else {
    cloud.track('cpu_started', { level, size });
    hostStartGame();
  }
}

// Solo games survive a refresh or a trip back to the home screen
function saveSolo() {
  const room = H.room;
  if (!room?.solo) return;
  if (room.status !== 'play') { store.set('solo', null); return; }
  store.set('solo', {
    level: room.level, size: room.size, mySide: seatOf(SOLO_ID), board: room.board, turn: room.turn,
    moveSeq: room.moveSeq, last: room.last, pass: room.pass, log: room.log, history: room.history.slice(-40),
  });
}

function validSave(sv) {
  if (!sv || typeof sv !== 'object' || !E.LEVELS.includes(sv.level) || !E.SIZES.includes(sv.size)) return null;
  if (![DARK, LIGHT].includes(sv.mySide) || ![DARK, LIGHT].includes(sv.turn)) return null;
  if (!Array.isArray(sv.board) || sv.board.length !== sv.size * sv.size || !sv.board.every((v) => v === 0 || v === 1 || v === 2)) return null;
  if (!E.hasMove(sv.board, sv.size, sv.turn)) return null;
  return { ...sv, log: Array.isArray(sv.log) ? sv.log : [], history: Array.isArray(sv.history) ? sv.history : [] };
}

function soloUndo() {
  const room = H.room;
  if (!room?.solo || !room.history.length) return;
  const snap = room.history.pop();
  clearTimers();
  Object.assign(room, {
    status: 'play', board: snap.board, turn: snap.turn, moveSeq: snap.moveSeq, last: snap.last, pass: snap.pass,
    log: room.log.slice(0, snap.log), result: null,
  });
  // An undo after the end takes the result back out of the record too
  if (S.overSeen === room.game) {
    const rec = store.get('record', {});
    const r = rec[room.level];
    const v = S.view?.result;
    if (r && v) {
      const mySide = seatOf(SOLO_ID);
      const key = !v.winner ? 'd' : v.winner === mySide ? 'w' : 'l';
      r[key] = Math.max(0, (r[key] || 0) - 1);
      store.set('record', rec);
    }
    S.overSeen = -1;   // (stats already saved online stay saved: S.savedGame isn't reset)
  }
  hostAfterTurn();
}

/* ---------- Crews ---------- */

function hostSaveCrew() {
  const room = H.room;
  if (!room.crew) return;
  if (!cloud.getUser()) {
    room.crewStatus = 'This game wasn’t saved. Sign in with Google (gear icon) to save crew scores.';
    return;
  }
  room.crewStatus = 'Saving this game…';
  const r = room.result;
  const dark = byId(r.ids[DARK]), light = byId(r.ids[LIGHT]);
  if (!dark || !light) return;
  cloud.saveCrewGame(room.crew.name, {
    room: room.code, size: room.size, dark: dark.name, light: light.name,
    winner: r.winner ? (r.winner === DARK ? dark.name : light.name) : '',
    darkCount: r.counts[1], lightCount: r.counts[2],
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
  if (!room || room.solo) return;
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

// What everyone may see (in this game nothing is secret)
function publicView() {
  const room = H.room;
  const now = Date.now();
  return {
    t: 'state',
    code: room.code, solo: room.solo, level: room.level, status: room.status, settings: room.settings, game: room.game,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, isHost: p.isHost, isBot: p.isBot, photo: p.photo,
      connected: p.connected, away: p.away, games: p.games, wins: p.wins, draws: p.draws, matchWins: p.matchWins,
      offlineFor: p.connected ? 0 : now - p.offlineAt,
    })),
    seats: { ...room.seats },
    size: room.size, board: room.board, turn: room.turn, moveSeq: room.moveSeq,
    last: room.last, pass: room.pass, log: room.log,
    turnLeft: room.turnEnd ? room.turnEnd - now : null,
    turnMs: room.solo ? 0 : E.timerMs(room.settings),
    result: room.result, matchWinner: room.matchWinner,
    canUndo: room.solo && room.history.length > 0,
    crewName: room.crew ? room.crew.name : '',
    crewStatus: room.crewStatus,
  };
}

function hostBroadcast() {
  if (!H.room) return;
  const view = publicView();
  for (const conn of H.conns.values()) send(conn, view);
  saveSolo();
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
  if (!S.peer && !H.room) return;
  S.leaving = true;
  clearTimers();
  S.peer?.destroy();
  Object.assign(S, { peer: null, hostConn: null, view: null, isHost: false, code: '', reconnecting: false, gameShown: -1, preview: -1, hint: null });
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
    case 'react':
      showReaction(msg.pid, msg.e);
      break;
    case 'state':
      applyState(msg);
      break;
    default:
  }
}

const me = (v) => v.players.find((p) => p.id === S.myId);
const pOf = (v, id) => v.players.find((p) => p.id === id);
const mySide = (v) => (v.seats[DARK] === S.myId ? DARK : v.seats[LIGHT] === S.myId ? LIGHT : 0);
const seatPlayer = (v, s) => pOf(v, v.seats[s]);
const isMyTurn = (v) => v.status === 'play' && v.turn && v.seats[v.turn] === S.myId;
const pActive = (p) => p && (p.isBot || (p.connected && !p.away));

function applyState(v) {
  const prev = S.view;
  S.view = v;
  S.viewAt = performance.now();
  if (!me(v)) return;
  if (v.status === 'lobby') {
    S.gameShown = -1;
    renderLobby(v);
    if ($('lobby').hidden) showScreen('lobby');
    return;
  }
  if ($('game').hidden) showScreen('game');
  if (v.game !== S.gameShown) {
    S.gameShown = v.game;
    S.moveSeen = v.moveSeq;
    S.passSeen = v.pass ? v.pass.seq : -1;
    S.preview = -1;
    S.hint = null;
    S.sentSeq = -1;
    buildBoard(v.size);
    paintBoard(v, null);
    announceGame(v);
  } else if (v.moveSeq === S.moveSeen + 1 && v.last) {
    S.moveSeen = v.moveSeq;
    S.preview = -1;
    paintBoard(v, v.last);
    if (v.last.auto) flash(v.seats[v.last.side] === S.myId ? 'Time’s up: a random move was played for you' : `Time’s up: a random move for ${esc(nameOfSeat(v, v.last.side))}`);
  } else if (v.moveSeq !== S.moveSeen) {
    S.moveSeen = v.moveSeq;
    S.preview = -1;
    paintBoard(v, null);
  } else {
    paintBoard(v, false);
  }
  // A pass: tell everyone
  if (v.pass && v.pass.seq === v.moveSeq && S.passSeen !== v.pass.seq && v.status === 'play') {
    S.passSeen = v.pass.seq;
    const stuck = v.pass.side;
    const mine = mySide(v);
    const text = stuck === mine ? `You have no moves. ${esc(nameOfSeat(v, E.other(stuck)))} goes again.`
      : E.other(stuck) === mine ? `${esc(nameOfSeat(v, stuck))} has no moves. Your turn again!`
      : `${esc(nameOfSeat(v, stuck))} has no moves and passes.`;
    const seq = v.moveSeq, game = v.game;
    setTimeout(() => {
      const now = S.view;
      if (!now || now.status !== 'play' || now.game !== game || now.moveSeq !== seq) return;
      flash(text, 'big', 2600);
      SOUND.pass();
    }, 500);
  }
  if (isMyTurn(v) && !(prev && isMyTurn(prev) && prev.moveSeq === v.moveSeq && prev.game === v.game)) {
    setTimeout(() => { if (S.view && isMyTurn(S.view)) SOUND.turn(); }, v.moveSeq ? 450 : 0);
  }
  renderGame(v);
}

function nameOfSeat(v, s) {
  const p = seatPlayer(v, s);
  if (!p) return E.SIDE_NAME[s];
  return p.id === S.myId ? 'You' : p.name;
}

function announceGame(v) {
  const side = mySide(v);
  if (v.status !== 'play') return;
  if (side === DARK) flash('You’re Dark: you go first', 'big', 2200);
  else if (side === LIGHT) flash(`You’re Light: ${esc(nameOfSeat(v, DARK))} goes first`, 'big', 2200);
  else flash(`${esc(nameOfSeat(v, DARK))} (Dark) vs ${esc(nameOfSeat(v, LIGHT))} (Light)`, 'big', 2200);
}

/* =========================================================
   The board
   ========================================================= */
const cells = [];
function buildBoard(n) {
  if (S.sizeBuilt === n) return;
  S.sizeBuilt = n;
  const board = $('board');
  board.style.setProperty('--n', n);
  $('board-frame').style.setProperty('--n', n);
  board.innerHTML = '';
  cells.length = 0;
  for (let i = 0; i < n * n; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cell';
    b.dataset.i = i;
    b.tabIndex = -1;
    b.setAttribute('role', 'gridcell');
    b.innerHTML = `<span class="slot" hidden>${chipHtml(DARK)}</span>`;
    board.appendChild(b);
    cells.push({ el: b, slot: b.firstChild, chip: b.firstChild.firstChild, v: 0 });
  }
  $('cols').innerHTML = Array.from({ length: n }, (_, c) => `<span>${String.fromCharCode(97 + c)}</span>`).join('');
  $('rows').innerHTML = Array.from({ length: n }, (_, r) => `<span>${r + 1}</span>`).join('');
  S.focus = -1;
}

/**
 * Draw the chips. move: the move to animate (chip drops in, trapped chips flip outwards
 * one step at a time), null to jump straight to the board, false when nothing changed.
 */
function paintBoard(v, move) {
  if (!v.board) return;
  const n = v.size;
  if (move === false) { decorate(v); return; }
  const animate = Boolean(move) && PREFS.anim !== 'off';
  const step = PREFS.anim === 'reduced' ? 30 : 75;
  const r0 = move ? Math.floor(move.i / n) : 0, c0 = move ? move.i % n : 0;
  const flipSet = new Set(move ? move.flips : []);
  const groups = new Set();
  const fresh = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const val = v.board[i];
    if (!animate) cell.chip.style.transition = 'none';
    if (val === 0) {
      cell.slot.hidden = true;
    } else {
      const wasEmpty = cell.slot.hidden;
      cell.slot.hidden = false;
      // A chip that just arrived shows its side straight away (no spin from an old game)
      if (wasEmpty && animate) { cell.chip.style.transition = 'none'; fresh.push(cell); }
      let delay = 0;
      if (animate && flipSet.has(i)) {
        const d = Math.max(Math.abs(Math.floor(i / n) - r0), Math.abs((i % n) - c0));
        delay = 110 + (d - 1) * step;
        groups.add(delay);
        cell.chip.classList.remove('lift');
        void cell.chip.offsetWidth;
        cell.chip.classList.add('lift');
        cell.chip.style.animationDelay = `${delay}ms`;
      }
      cell.chip.style.transitionDelay = `${delay}ms`;
      cell.chip.classList.toggle('is-l', val === LIGHT);
      if (animate && i === move.i && wasEmpty) {
        cell.slot.classList.remove('pop');
        void cell.slot.offsetWidth;
        cell.slot.classList.add('pop');
      }
    }
    cell.v = val;
  }
  if (!animate || fresh.length) {
    void $('board').offsetWidth;
    for (const cell of animate ? fresh : cells) cell.chip.style.transition = '';
  }
  if (move) {
    SOUND.place();
    SOUND.flips([...groups].sort((a, b) => a - b));
  }
  decorate(v);
}

// Dots, the last move, previews and hints: everything on the board that isn't a chip
function decorate(v) {
  const n = v.size;
  const myTurn = isMyTurn(v);
  const showDots = myTurn && v.settings.hints === 'on';
  const legal = myTurn ? new Set(E.legalMoves(v.board, n, v.turn)) : new Set();
  const board = $('board');
  board.classList.toggle('mine', myTurn);
  board.classList.toggle('turn-d', v.turn === DARK);
  board.classList.toggle('turn-l', v.turn === LIGHT);
  $('board-frame').classList.toggle('my-turn', myTurn);
  document.body.classList.toggle('anim-reduced', PREFS.anim === 'reduced');
  document.body.classList.toggle('anim-off', PREFS.anim === 'off');
  if (S.preview >= 0 && !legal.has(S.preview)) S.preview = -1;
  const previewFlips = S.preview >= 0 ? new Set(E.flipsFor(v.board, n, S.preview, v.turn)) : new Set();
  const hint = S.hint && S.hint.seq === v.moveSeq && S.hint.game === v.game ? S.hint.i : -1;
  if (S.focus < 0 || S.focus >= cells.length) S.focus = legal.size ? [...legal][0] : Math.floor(cells.length / 2);
  for (let i = 0; i < cells.length; i++) {
    const { el } = cells[i];
    const val = v.board[i];
    el.classList.toggle('can', showDots && legal.has(i));
    el.classList.toggle('last', Boolean(v.last) && v.last.i === i);
    el.classList.toggle('will-flip', previewFlips.has(i));
    el.classList.toggle('hinted', hint === i);
    const isPreview = S.preview === i;
    el.classList.toggle('preview', isPreview);
    const ghost = el.querySelector('.ghost-chip');
    const gain = el.querySelector('.gain');
    if (isPreview && !ghost) {
      el.insertAdjacentHTML('beforeend', `<span class="ghost-chip">${chipHtml(v.turn)}</span><span class="gain">+${previewFlips.size}</span>`);
    } else if (!isPreview) { ghost?.remove(); gain?.remove(); }
    el.tabIndex = i === S.focus ? 0 : -1;
    const name = E.cellName(i, n);
    el.setAttribute('aria-label', val ? `${name}, ${E.SIDE_NAME[val].toLowerCase()}`
      : legal.has(i) ? `${name}, you can go here, flips ${E.flipsFor(v.board, n, i, v.turn).length}` : `${name}, empty`);
  }
}

function setPreview(i) {
  if (S.preview === i) return;
  S.preview = i;
  if (S.view) decorate(S.view);
}

function cellFrom(e) {
  const el = e.target.closest('.cell');
  return el ? Number(el.dataset.i) : -1;
}

$('board').addEventListener('pointerdown', (e) => { S.pointer = e.pointerType || 'mouse'; });
$('board').addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  const v = S.view;
  const i = cellFrom(e);
  if (!v || i < 0 || !isMyTurn(v) || v.settings.hints !== 'on') return;
  setPreview(E.flipsFor(v.board, v.size, i, v.turn).length ? i : -1);
});
$('board').addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') setPreview(-1); });
$('board').addEventListener('click', (e) => {
  const i = cellFrom(e);
  if (i >= 0) tryMove(i, e.detail === 0 ? 'keyboard' : S.pointer);
});
$('board').addEventListener('keydown', (e) => {
  const v = S.view;
  if (!v || !v.board) return;
  const n = v.size;
  const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -n, ArrowDown: n };
  if (!(e.key in moves)) return;
  e.preventDefault();
  const cur = S.focus < 0 ? 0 : S.focus;
  let next = cur + moves[e.key];
  if ((e.key === 'ArrowLeft' && cur % n === 0) || (e.key === 'ArrowRight' && cur % n === n - 1)) next = cur;
  if (next < 0 || next >= n * n) next = cur;
  S.focus = next;
  decorate(v);
  cells[next].el.focus();
});

function tryMove(i, how) {
  const v = S.view;
  if (!v || v.status !== 'play') return;
  if (!mySide(v)) return;
  if (!isMyTurn(v)) {
    flash(`It’s ${esc(nameOfSeat(v, v.turn))}’s turn`);
    return;
  }
  // One move per turn (a lost message can be sent again after a moment)
  if (S.sentSeq === v.moveSeq && performance.now() - S.sentAt < 2500) return;
  S.focus = i;
  const flips = E.flipsFor(v.board, v.size, i, v.turn);
  if (!flips.length) {
    const el = cells[i].el;
    el.classList.remove('nope');
    void el.offsetWidth;
    el.classList.add('nope');
    SOUND.nope();
    flash(v.board[i] ? 'That square is taken' : 'You can only go where you trap a chip', '', 1800);
    setPreview(-1);
    return;
  }
  const confirmNeeded = PREFS.confirm === 'always' || (PREFS.confirm === 'auto' && how === 'touch');
  if (confirmNeeded && S.preview !== i) {
    setPreview(i);
    flash(`Tap again to place (flips ${flips.length})`, '', 1600);
    return;
  }
  S.sentSeq = v.moveSeq;
  S.sentAt = performance.now();
  S.hint = null;
  setPreview(-1);
  toHost({ t: 'move', i, seq: v.moveSeq });
}

/* =========================================================
   The rest of the game screen
   ========================================================= */
let flashTimer = 0;
function flash(html, cls = '', ms = 2000) {
  const el = $('flash');
  el.innerHTML = html;
  el.className = `flash show ${cls}`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.className = 'flash'; }, ms);
}

function renderGame(v) {
  $('bar-code').textContent = v.solo ? 'vs Computer' : v.code;
  const side = mySide(v);
  $('bar-phase').textContent = v.solo ? `${LEVEL_NAME[v.level]} · ${v.size} × ${v.size}`
    : side ? `You’re ${E.SIDE_NAME[side]}` : 'Watching';
  renderDuel(v);
  renderTurnLine(v);
  renderResult(v);
  renderActions(v);
  renderLog(v);
  renderScores(v);
  $('reactions-panel').hidden = v.solo;
}

function renderDuel(v) {
  const c = E.counts(v.board);
  for (const s of [DARK, LIGHT]) {
    const p = seatPlayer(v, s);
    const turn = v.status === 'play' && v.turn === s;
    const isMe = p && p.id === S.myId;
    let tag = E.SIDE_NAME[s];
    if (turn) tag = isMe ? 'Your turn' : p?.isBot ? 'Thinking…' : mySide(v) ? 'Their turn' : 'To move';
    else if (p && !p.isBot && !p.connected) tag = 'Left · reconnecting';
    else if (p && p.away) tag = 'Away';
    if (v.status === 'over' && v.result) tag = !v.result.winner ? 'Draw' : v.result.winner === s ? 'Winner' : E.SIDE_NAME[s];
    const el = $(`card-${s}`);
    const prevCount = Number(el.dataset.count || -1);
    el.className = `player-card s${s}${turn ? ' turn' : ''}${p && !pActive(p) ? ' off' : ''}${v.status === 'over' && v.result?.winner === s ? ' won' : ''}`;
    el.innerHTML = `${miniChip(s)}
      <span class="who"><span class="nm">${p ? esc(p.name) + (isMe ? '<span class="you"> (you)</span>' : '') : 'Empty seat'}</span><span class="tag">${tag}</span></span>
      <b class="count${prevCount >= 0 && prevCount !== c[s] ? ' bump' : ''}">${c[s]}</b>
      ${turn && v.turnMs ? '<span class="clock"></span>' : ''}`;
    el.dataset.count = c[s];
  }
  $('bar-d').style.flexGrow = c[1];
  $('bar-l').style.flexGrow = c[2];
  updateClock();
}

function renderTurnLine(v) {
  const el = $('turn-line');
  el.className = 'turn-line';
  if (v.status === 'over') { el.innerHTML = resultLine(v); return; }
  const p = seatPlayer(v, v.turn);
  const opp = seatPlayer(v, E.other(v.turn));
  if (isMyTurn(v)) {
    el.classList.add('mine');
    el.innerHTML = `${miniChip(v.turn)}<span class="pulse">Your turn</span>`;
  } else if (p && p.isBot) {
    el.innerHTML = `${miniChip(v.turn)}<span class="thinking-dots">${esc(p.name.replace(/ \(.*\)$/, ''))} is thinking</span>`;
  } else if (p && !p.connected) {
    el.innerHTML = `${miniChip(v.turn)}<span>${esc(p.name)} left. Waiting for them to come back…</span>`;
  } else if (p) {
    const mine = mySide(v);
    el.innerHTML = `${miniChip(v.turn)}<span>${mine ? `${esc(p.name)}’s turn` : `${esc(p.name)}’s turn (${E.SIDE_NAME[v.turn]})`}</span>`;
  }
  if (mySide(v) && opp && opp.id !== S.myId && !opp.isBot && !opp.connected && p && p.id === S.myId) {
    el.innerHTML += ` <span class="muted">· ${esc(opp.name)} left</span>`;
  }
}

function resultLine(v) {
  const r = v.result;
  if (!r) return '';
  const c = r.counts;
  return `${miniChip(DARK)} ${c[1]} – ${c[2]} ${miniChip(LIGHT)}`;
}

function resultText(v) {
  const r = v.result;
  const side = mySide(v);
  const winName = r.winner ? nameOfSeat(v, r.winner) : '';
  const loseName = r.winner ? nameOfSeat(v, E.other(r.winner)) : '';
  let title, sub;
  const iWon = side && r.winner === side;
  if (!r.winner) title = 'A draw!';
  else if (iWon) title = 'You win!';
  else title = `${winName} ${winName === 'You' ? 'win' : 'wins'}!`;
  const score = `${Math.max(r.counts[1], r.counts[2])} to ${Math.min(r.counts[1], r.counts[2])}`;
  if (r.reason === 'resign') sub = side && r.winner !== side ? 'You resigned.' : `${loseName} resigned.`;
  else if (r.reason === 'forfeit') sub = `${loseName} left the game.`;
  else if (!r.winner) sub = `${r.counts[1]} chips each.`;
  else sub = `${score} in chips.`;
  if (v.matchWinner) {
    const m = pOf(v, v.matchWinner);
    title = m.id === S.myId ? 'You win the match!' : `${m.name} wins the match!`;
    sub = `First to ${E.matchTarget(v.settings)} games. ${sub}`;
  } else if (!v.solo && E.matchTarget(v.settings) && r.winner) {
    const w = pOf(v, r.ids[r.winner]);
    if (w) sub += ` ${w.id === S.myId ? 'You have' : `${w.name} has`} ${w.matchWins} of ${E.matchTarget(v.settings)} wins needed.`;
  }
  return { title, sub, iWon, lost: side && r.winner && r.winner !== side };
}

function renderResult(v) {
  const over = v.status === 'over' && v.result;
  $('result-panel').hidden = !over;
  if (!over) return;
  const { title, sub, iWon, lost } = resultText(v);
  $('result-head').className = `result-head${iWon ? ' won' : ''}`;
  $('result-title').textContent = title;
  $('result-sub').textContent = sub;
  if (S.overSeen !== v.game) {
    S.overSeen = v.game;
    $('flash').className = 'flash';
    setTimeout(() => { if (iWon) SOUND.win(); else if (lost) SOUND.lose(); else SOUND.pass(); }, 500);
  }
  const ready = [DARK, LIGHT].every((s) => pActive(seatPlayer(v, s)));
  if (v.solo) {
    $('next-game').textContent = 'Play again';
    $('next-game').hidden = false;
    $('next-game').disabled = false;
    $('to-lobby').textContent = 'Change settings';
    $('to-lobby').hidden = false;
    $('result-wait').textContent = v.canUndo ? 'Or press Undo to take your last move back.' : '';
  } else {
    $('next-game').textContent = v.matchWinner ? 'New match' : 'Rematch';
    $('next-game').hidden = !S.isHost;
    $('next-game').disabled = !ready;
    $('to-lobby').textContent = 'Change settings';
    $('to-lobby').hidden = !S.isHost;
    const swap = v.settings.colours === 'swap' ? ' Colours swap.' : v.settings.colours === 'random' ? ' Colours are picked at random.' : '';
    $('result-wait').textContent = !ready ? (S.isHost ? 'A player has left. Change settings to pick who plays next.' : 'A player has left. The host can pick who plays next.')
      : (S.isHost ? `Rematch keeps the same two players.${swap}` : `The host starts the next game.${swap}`);
  }
  $('crew-line').textContent = v.crewName ? v.crewStatus : '';

  // Each signed-in player saves their own result once per game
  const side = mySide(v);
  if (S.savedGame !== v.game && side && cloud.getUser()) {
    S.savedGame = v.game;
    const r = v.result;
    cloud.saveMyGame({
      result: !r.winner ? 'draw' : r.winner === side ? 'win' : 'loss',
      chips: r.counts[side], vs: v.solo ? v.level : 'room',
    }).catch((err) => toast(`Your stats weren’t saved. ${cloud.errorText(err)}`));
  }
}

$('next-game').addEventListener('click', () => {
  const v = S.view;
  if (!v || !S.isHost) return;
  if (v.solo) startSolo();
  else hostStartGame();
});
$('to-lobby').addEventListener('click', () => {
  const v = S.view;
  if (!v || !S.isHost) return;
  if (v.solo) { closeRoom(); goHome(); } else hostBackToLobby();
});
$('quit-btn').addEventListener('click', () => {
  const solo = S.view?.solo;
  closeRoom();
  goHome();
  if (solo && store.get('solo', null)) toast('Game saved. Continue it from the home screen.');
});

// Two-step buttons: the first press asks, the second does it
function twoStep(btn, ask, act) {
  let armed = 0;
  const label = btn.textContent;
  btn.addEventListener('click', () => {
    if (armed) {
      clearTimeout(armed);
      armed = 0;
      btn.classList.remove('confirm');
      btn.textContent = label;
      act();
      return;
    }
    btn.classList.add('confirm');
    btn.textContent = ask;
    armed = setTimeout(() => { armed = 0; btn.classList.remove('confirm'); btn.textContent = label; }, 3000);
  });
}
twoStep($('resign-btn'), 'Tap again to resign', () => toHost({ t: 'resign' }));
twoStep($('end-btn'), 'Tap again to end it', () => { if (S.isHost) hostBackToLobby(); });
$('claim-btn').addEventListener('click', () => toHost({ t: 'claim' }));
$('undo-btn').addEventListener('click', () => { S.hint = null; soloUndo(); });
$('new-cpu').addEventListener('click', () => startSolo());
$('hint-btn').addEventListener('click', async () => {
  const v = S.view;
  if (!v || !v.solo || !isMyTurn(v)) return;
  $('hint-btn').disabled = true;
  const i = await think(v.board.slice(), v.size, v.turn, 'hard', 500);
  if (S.view && S.view.game === v.game && S.view.moveSeq === v.moveSeq && i >= 0) {
    S.hint = { i, seq: v.moveSeq, game: v.game };
    decorate(S.view);
    flash(`Try ${E.cellName(i, v.size)}`, '', 1600);
  }
  renderActions(S.view);
});

function claimable(v) {
  const side = mySide(v);
  if (v.solo || v.status !== 'play' || !side) return false;
  const opp = seatPlayer(v, E.other(side));
  return Boolean(opp && !opp.connected && opp.offlineFor + (performance.now() - S.viewAt) >= E.TIMES.offlineClaimMs);
}

function renderActions(v) {
  if (!v) return;
  const side = mySide(v);
  const playing = v.status === 'play';
  $('cpu-actions').hidden = !v.solo;
  $('undo-btn').disabled = !v.canUndo;
  $('hint-btn').disabled = !isMyTurn(v);
  $('resign-btn').hidden = !(playing && side);
  $('end-btn').hidden = !(playing && S.isHost && !v.solo);
  $('claim-btn').hidden = !claimable(v);
  const opp = side ? seatPlayer(v, E.other(side)) : null;
  $('action-note').textContent = playing && opp && !opp.isBot && !opp.connected && !claimable(v)
    ? `${opp.name} left. If they’re not back within ${Math.round(E.TIMES.offlineClaimMs / 1000)} seconds, you can claim the win.`
    : playing && v.solo ? 'Undo takes back your last move (and the computer’s reply).' : '';
  $('actions').hidden = !(v.solo || (playing && (side || S.isHost)));
}

function renderLog(v) {
  const n = v.size;
  let k = 0;
  const items = v.log.map((m) => {
    if (m.pass) return `<li class="pass">${tinyChip(m.side)}pass</li>`;
    k++;
    return `<li><span class="n">${k}</span>${tinyChip(m.side)}${E.cellName(m.i, n)}</li>`;
  });
  $('move-log').innerHTML = items.length ? items.join('') : '<li class="empty">Dark goes first.</li>';
  $('move-count').textContent = k ? plural(k, 'move') : '';
  $('move-log').scrollTop = $('move-log').scrollHeight;
}

function renderScores(v) {
  if (v.solo) {
    const r = { w: 0, l: 0, d: 0, ...store.get('record', {})[v.level] };
    $('scores-title').textContent = `You vs ${LEVEL_NAME[v.level]}`;
    $('score-list').innerHTML = `<li><span class="mini-chip">${chipHtml(mySide(v))}</span><span class="nm">${plural(r.w, 'win')} · ${r.l === 1 ? '1 loss' : `${r.l} losses`}${r.d ? ` · ${plural(r.d, 'draw')}` : ''}</span><b></b></li>`;
    $('watching').textContent = '';
    return;
  }
  $('scores-title').textContent = 'Wins in this room';
  const rows = v.players.filter((p) => p.games > 0).sort((a, b) => b.wins - a.wins || b.draws - a.draws);
  $('score-list').innerHTML = rows.length ? rows.map((p) => `<li class="pc${p.color}${p.connected ? '' : ' off'}">
      <span class="pen-dot"></span><span class="nm">${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}</span>
      <b>${p.wins}${p.draws ? ` <span class="muted">+${p.draws} drawn</span>` : ''}</b></li>`).join('')
    : '<li><span></span><span class="muted">No games finished yet.</span><b></b></li>';
  const watchers = v.players.filter((p) => p.connected && v.seats[DARK] !== p.id && v.seats[LIGHT] !== p.id);
  $('watching').textContent = watchers.length ? `Watching: ${watchers.map((p) => p.name + (p.id === S.myId ? ' (you)' : '')).join(', ')}` : '';
}

/* ---------- The clock (and anything else that changes with time) ---------- */
let lastTickSec = -1;
function updateClock() {
  const v = S.view;
  if (!v || v.status !== 'play') return;
  if (v.turnMs && v.turnLeft !== null) {
    const left = Math.max(0, v.turnLeft - (performance.now() - S.viewAt));
    const el = document.querySelector(`#card-${v.turn} .clock`);
    if (el) {
      el.style.setProperty('--left', String(left / v.turnMs));
      el.classList.toggle('urgent', left < 5000);
    }
    const sec = Math.ceil(left / 1000);
    if (isMyTurn(v) && sec <= 5 && sec > 0 && sec !== lastTickSec) { lastTickSec = sec; SOUND.tick(); }
  }
}
setInterval(() => {
  const v = S.view;
  if (!v || $('game').hidden) return;
  updateClock();
  if (v.status === 'play' && !v.solo) {
    const claim = claimable(v);
    if (claim === $('claim-btn').hidden) renderActions(v);
  }
}, 200);

/* ---------- Reactions ---------- */
$('reactions').innerHTML = E.REACTIONS.map((e) => `<button type="button" data-e="${e}" aria-label="React ${e}">${e}</button>`).join('');
$('reactions').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || !S.view) return;
  const now = performance.now();
  if (now - S.reactAt < 1000) return;
  S.reactAt = now;
  toHost({ t: 'react', e: b.dataset.e });
});

function showReaction(pid, e) {
  const v = S.view;
  if (!v || $('game').hidden || !E.REACTIONS.includes(e)) return;
  if (pid !== S.myId && !PREFS.reactions) return;
  const p = pOf(v, pid);
  const el = document.createElement('span');
  el.className = `bubble pc${p ? p.color : 0}`;
  el.style.left = `${8 + Math.random() * 58}%`;
  el.innerHTML = `<span class="e">${e}</span>${esc(p ? (p.id === S.myId ? 'You' : p.name) : 'Someone')}`;
  $('reaction-layer').appendChild(el);
  SOUND.pop();
  setTimeout(() => el.remove(), 2700);
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

const NUMERIC = new Set(['size']);
const asSetting = (key, value) => (NUMERIC.has(key) ? Number(value) : value);
const paints = ['size', 'timer', 'hints'].map((key) =>
  segment($(`set-${key}`), () => ROOM_PREFS[key], (val) => { ROOM_PREFS[key] = asSetting(key, val); roomSettingsChanged(); }));
const SELECTS = ['colours', 'match'];
for (const key of SELECTS) {
  $(`set-${key}`).addEventListener('change', (e) => { ROOM_PREFS[key] = asSetting(key, e.target.value); roomSettingsChanged(); });
}

function roomSettingsChanged() {
  ROOM_PREFS = E.cleanSettings(ROOM_PREFS);
  saveRoomPrefs();
  paintRoomSettings();
  if (!S.isHost || !H.room || H.room.solo || H.room.status !== 'lobby') return;
  H.room.settings = { ...ROOM_PREFS };
  hostBroadcast();
}

function paintRoomSettings() {
  paints.forEach((p) => p());
  for (const key of SELECTS) $(`set-${key}`).value = String(ROOM_PREFS[key]);
}

function settingsLines(st) {
  return [
    `<b>${st.size} × ${st.size}</b> board`,
    st.timer === 'off' ? 'No time limit' : `${st.timer} seconds per move`,
    st.hints === 'on' ? 'Dots show where you can go' : 'No dots: find your moves yourself',
    { swap: 'Colours swap after each game', random: 'Random colours after each game', keep: 'Colours stay the same' }[st.colours],
    { open: '', 3: 'Best of 3', 5: 'Best of 5' }[st.match],
  ].filter(Boolean).map((l) => `<li>${l}</li>`).join('');
}

function renderLobby(v) {
  $('lobby-code').textContent = v.code;
  const rows = v.players.map((p) => {
    const seat = v.seats[DARK] === p.id ? 'Dark' : v.seats[LIGHT] === p.id ? 'Light' : 'Watching';
    return `<li class="pc${p.color}${active(p) ? '' : ' off'}"><span class="pen-dot"></span>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}
      <span class="tag">${!active(p) ? 'Reconnecting' : `<b>${seat}</b>${p.isHost ? ' · Host' : ''}`}</span></li>`;
  });
  if (v.players.length < 2) rows.push('<li class="empty">Waiting for someone to join…</li>');
  $('lobby-players').innerHTML = rows.join('');

  const mine = mySide(v);
  $('seat-cards').innerHTML = [DARK, LIGHT].map((s) => {
    const p = seatPlayer(v, s);
    const isMe = p && p.id === S.myId;
    const free = !p || !p.connected;
    const btn = isMe ? `<button class="btn ghost" type="button" data-stand>Stand up and watch</button>`
      : free ? `<button class="btn ${mine ? 'ghost' : 'primary'}" type="button" data-sit="${s}">${mine ? 'Switch to this seat' : 'Sit here'}</button>` : '';
    return `<div class="seat-card${free ? ' empty' : ''}${isMe ? ' me' : ''}">
      <span class="seat-side">${miniChip(s)}${E.SIDE_NAME[s]}${s === DARK ? ' · goes first' : ''}</span>
      <span class="seat-name">${p && p.connected ? esc(p.name) + (isMe ? ' (you)' : '') : 'Empty seat'}</span>${btn}</div>`;
  }).join('') + (S.isHost && (v.seats[DARK] || v.seats[LIGHT]) ? '<button class="btn link seat-swap" type="button" data-swap>Swap colours</button>' : '');

  $('host-settings').hidden = !S.isHost;
  $('guest-settings').hidden = S.isHost;
  if (S.isHost) {
    paintRoomSettings();
    if (document.activeElement !== $('crew-input')) $('crew-input').value = v.crewName;
    $('crew-status').textContent = v.crewStatus;
    const ready = [DARK, LIGHT].every((s) => { const p = seatPlayer(v, s); return p && p.connected; });
    $('start-btn').disabled = !ready;
    const empty = [DARK, LIGHT].filter((s) => !seatPlayer(v, s));
    $('start-note').textContent = ready ? ''
      : v.players.length < 2 ? 'Needs a second player. Copy the invite link and send it to a colleague.'
      : `Someone needs to sit in the ${empty.map((s) => E.SIDE_NAME[s]).join(' and ')} seat${empty.length > 1 ? 's' : ''}.`;
  } else {
    $('settings-summary').innerHTML = settingsLines(v.settings) + (v.crewName ? `<li>Crew: <b>${esc(v.crewName)}</b></li>` : '');
  }
}

$('seat-cards').addEventListener('click', (e) => {
  const sit = e.target.closest('[data-sit]');
  if (sit) toHost({ t: 'sit', side: Number(sit.dataset.sit) });
  if (e.target.closest('[data-stand]')) toHost({ t: 'stand' });
  if (e.target.closest('[data-swap]') && S.isHost) hostSwapSeats();
});
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
function logoHtml() {
  // "Flip" in plain type, then CHIP on chips flipping in a wave
  const chips = 'CHIP'.split('').map((ch, k) => {
    const s = k % 2 === 0 ? DARK : LIGHT;
    return `<span class="logo-chip" style="--k:${k}"><span class="chip${s === LIGHT ? ' is-l' : ''}"><i class="f d">${ch}</i><i class="f l">${ch}</i></span></span>`;
  }).join('');
  return `<span class="logo-word">Flip</span>${chips}`;
}

const paintCpuLevel = segment($('cpu-level'), () => CPU_PREFS.level, (v) => { CPU_PREFS.level = v; store.set('cpu', CPU_PREFS); renderCpuCard(); });
const paintCpuSide = segment($('cpu-side'), () => String(CPU_PREFS.side), (v) => { CPU_PREFS.side = v; store.set('cpu', CPU_PREFS); });
const paintCpuSize = segment($('cpu-size'), () => String(CPU_PREFS.size), (v) => { CPU_PREFS.size = Number(v); store.set('cpu', CPU_PREFS); });

function renderCpuCard() {
  paintCpuLevel(); paintCpuSide(); paintCpuSize();
  const r = { w: 0, l: 0, d: 0, ...store.get('record', {})[CPU_PREFS.level] };
  $('cpu-record').textContent = r.w + r.l + r.d ? `vs ${LEVEL_NAME[CPU_PREFS.level]}: ${r.w} W · ${r.l} L${r.d ? ` · ${r.d} D` : ''}` : '';
  const saved = validSave(store.get('solo', null));
  $('cpu-continue').hidden = !saved;
  if (saved) $('cpu-continue').textContent = `Continue (${LEVEL_NAME[saved.level]}, ${saved.size} × ${saved.size})`;
}

$('cpu-btn').addEventListener('click', () => {
  S.myName = cleanName($('name-input').value) || 'You';
  if (S.myName !== 'You') store.set('name', S.myName);
  homeError('');
  startSolo();
});
$('cpu-continue').addEventListener('click', () => {
  const saved = validSave(store.get('solo', null));
  if (!saved) { renderCpuCard(); return; }
  S.myName = cleanName($('name-input').value) || 'You';
  startSolo(saved);
});

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
  renderCpuCard();
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
  $('vibrate-toggle').checked = PREFS.vibrate !== false;
  $('react-toggle').checked = PREFS.reactions !== false;
  $('confirm-select').value = PREFS.confirm;
  $('anim-select').value = PREFS.anim;
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
        <div><b>${st.games}</b><span>Room games</span></div>
        <div><b>${st.wins}</b><span>Room wins</span></div>
        <div><b>${st.draws}</b><span>Draws</span></div>
        <div><b>${st.cpuGames}</b><span>vs Computer</span></div>
        <div><b>${st.cpuWins}</b><span>Beat it</span></div>
        <div><b>${['–', 'Easy', 'Normal', 'Hard'][st.cpuBest] || '–'}</b><span>Hardest beaten</span></div>
      </div>`;
  } catch (err) {
    $('my-stats').innerHTML = `<p class="muted">${esc(cloud.errorText(err))}</p>`;
  }
}
$('sound-toggle').addEventListener('change', (e) => { PREFS.sound = e.target.checked; savePrefs(); if (PREFS.sound) SOUND.place(); });
$('vibrate-toggle').addEventListener('change', (e) => { PREFS.vibrate = e.target.checked; savePrefs(); });
$('react-toggle').addEventListener('change', (e) => { PREFS.reactions = e.target.checked; savePrefs(); });
$('confirm-select').addEventListener('change', (e) => { PREFS.confirm = e.target.value; savePrefs(); setPreview(-1); });
$('anim-select').addEventListener('change', (e) => { PREFS.anim = e.target.value; savePrefs(); if (S.view) decorate(S.view); });
$('analytics-toggle').addEventListener('change', (e) => {
  PREFS.analytics = e.target.checked;
  savePrefs();
  cloud.setAnalyticsEnabled(e.target.checked);
});

// Test hook: with ?debug in the address, automated tests can inspect the state.
if (new URLSearchParams(location.search).has('debug')) window.__flipchip = { S, H, E, AI, think };

/* =========================================================
   Start
   ========================================================= */
(function init() {
  $('logo-row').innerHTML = logoHtml();
  const saved = store.get('name', '');
  if (saved) $('name-input').value = saved;
  const room = new URLSearchParams(location.search).get('room');
  if (room && /^[A-Za-z]{4}$/.test(room)) {
    $('code-input').value = room.toUpperCase();
    ($('name-input').value ? $('join-btn') : $('name-input')).focus();
  }
  renderCpuCard();
  showScreen('home');
  cloud.onUser((u) => {
    renderAccount(u);
    if (S.isHost && H.room && H.room.crew) hostSetCrew(H.room.crew.name);
  });
  cloud.initAnalytics(PREFS.analytics !== false);
  cloud.restore();
})();
