import * as R from './rounds.js';
import { TESTS, icon, blank } from './play.js';
import * as cloud from './cloud.js';

/* =========================================================
   Guesstimate
   Practice and the daily puzzle run entirely in this browser.
   Rooms: one player hosts and their browser is the "server". It picks a seed,
   and every browser builds the same puzzles from it, so only the seed travels.
   Players send their guesses to the host, who checks and scores them; nobody
   sees anyone else's guess until the reveal. Connections use PeerJS (WebRTC).
   ========================================================= */

const PREFIX = 'guesstimate-v1-';     // namespaces our room ids on the PeerJS server
const MAX_PLAYERS = 8;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';  // no I or O, easy to read out loud
const PEER_OPTIONS = { debug: 1 };
const COUNTDOWN_MS = 3000;
const PING_MS = 2000;       // players ping the host, and the host pings back
const AWAY_MS = 9000;       // no ping for this long: the round stops waiting for that player
const LOST_MS = 12000;      // a player who hears nothing from the host this long reconnects
const LEVEL = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Score colours line up with the verdicts: Sharp and up green, Close and Ballpark amber.
const band = (p) => (p >= 80 ? 'good' : p >= 35 ? 'okay' : 'poor');
const sum = (arr) => arr.reduce((n, x) => n + (x || 0), 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ---------- This browser only (private windows may block it) ---------- */
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`guesstimate.${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`guesstimate.${key}`, JSON.stringify(value)); } catch { /* not saved */ }
  },
};
const PREFS = { difficulty: 'normal', kinds: [...R.KINDS], analytics: true, ...store.get('prefs', {}) };
const ROOM_PREFS = { difficulty: 'normal', kinds: [...R.KINDS], laps: 1, timer: 30, ...store.get('room', {}) };
const savePrefs = () => store.set('prefs', PREFS);

// Identifies this tab to the host. It survives a refresh (so you get your seat back) but is
// different for every person, so a colleague with the same name can't take your seat.
const CLIENT_ID = (() => {
  const fresh = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  try {
    let id = sessionStorage.getItem('guesstimate.client');
    if (!id) { id = fresh(); sessionStorage.setItem('guesstimate.client', id); }
    return id;
  } catch { return fresh(); }
})();
const saveRoomPrefs = () => store.set('room', ROOM_PREFS);
// Settings saved before Timing existed: switch the new test on once
for (const [prefs, save] of [[PREFS, savePrefs], [ROOM_PREFS, saveRoomPrefs]]) {
  if ((prefs.version || 1) < 2) {
    if (!prefs.kinds.includes('time')) prefs.kinds = R.KINDS.filter((k) => prefs.kinds.includes(k) || k === 'time');
    prefs.version = 2;
    save();
  }
}

/* ---------- Screens, sheets and messages ---------- */
const SCREENS = ['home', 'lobby', 'play', 'over', 'summary'];
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

function kindPicks(container, getKinds, setKinds) {
  container.innerHTML = R.KINDS.map((k) => `<button type="button" class="kind-pick k-${k}" data-kind="${k}">${icon(k)}${TESTS[k].name}</button>`).join('');
  const paint = () => container.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(getKinds().includes(b.dataset.kind))));
  container.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const on = new Set(getKinds());
    if (on.has(b.dataset.kind)) {
      if (on.size === 1) return toast('Pick at least one test');
      on.delete(b.dataset.kind);
    } else on.add(b.dataset.kind);
    setKinds(R.KINDS.filter((k) => on.has(k)));
    paint();
  });
  paint();
  return paint;
}

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

/* =========================================================
   The play screen, shared by every mode
   ========================================================= */
let live = null;          // the mounted test's controller
let countdownTimer = 0;
let clockTimer = 0;

function stopLive() {
  if (live) live.destroy();
  live = null;
  clearInterval(countdownTimer);
  $('countdown').hidden = true;
}

function stopClock() {
  clearInterval(clockTimer);
  $('clock').hidden = true;
}

// Bar, progress, header and title block for one round.
function frame({ mode, index, total, pz, ref, points }) {
  $('bar-mode').textContent = mode;
  $('bar-round').textContent = `Round ${index + 1} of ${total}`;
  $('progress').innerHTML = Array.from({ length: total }, (_, i) => {
    const p = points[i];
    return `<i class="${p !== undefined && p !== null ? band(p) : i === index ? 'now' : ''}"></i>`;
  }).join('');
  $('kind-badge').className = `kind-badge k-${pz.kind}`;
  $('kind-badge').innerHTML = icon(pz.kind);
  $('play-ask').textContent = TESTS[pz.kind].ask(pz);
  $('brief').hidden = false;
  $('brief-badge').className = `kind-badge k-${pz.kind}`;
  $('brief-badge').innerHTML = icon(pz.kind);
  $('brief-name').textContent = TESTS[pz.kind].name;
  $('brief-how').textContent = TESTS[pz.kind].how;
  $('tb-kind').textContent = TESTS[pz.kind].name;
  $('tb-level').textContent = LEVEL[pz.difficulty];
  $('tb-sheet').textContent = `${index + 1} / ${total}`;
  $('tb-ref').textContent = ref;
  $('stage').replaceChildren();
  blank($('stage'));
  $('controls').replaceChildren();
  $('result').hidden = true;
  $('waiting').textContent = '';
  $('end-round-btn').hidden = true;
  $('go-btn').hidden = true;
  $('lock-btn').hidden = true;
  $('play-hint').textContent = '';
}

function mount(pz, color, onLock) {
  $('countdown').hidden = true;
  // Timing locks in when you press Stop, so it has no Lock in button
  $('lock-btn').hidden = Boolean(TESTS[pz.kind].selfLock);
  $('lock-btn').disabled = true;
  $('play-hint').textContent = '';
  $('stage').replaceChildren();
  $('controls').replaceChildren();
  const lock = () => {
    if (!live || $('lock-btn').disabled) return;
    const guess = live.guess();
    live.destroy();
    live = null;
    $('lock-btn').hidden = true;
    $('play-hint').textContent = '';
    $('controls').querySelectorAll('input').forEach((i) => { i.disabled = true; });
    onLock(guess);
  };
  live = TESTS[pz.kind].mount($('stage'), pz, {
    color,
    controls: $('controls'),
    ready: (ok) => { $('lock-btn').disabled = !ok; },
    hint: (msg) => { $('play-hint').textContent = msg; },
    submit: lock,
  });
  live.lock = lock;
}
$('lock-btn').addEventListener('click', () => live && live.lock());

function countdown(ms, then) {
  clearInterval(countdownTimer);
  const end = performance.now() + ms;
  $('countdown').hidden = false;
  const tick = () => {
    const left = end - performance.now();
    if (left <= 0) {
      clearInterval(countdownTimer);
      $('countdown').hidden = true;
      then();
      return;
    }
    $('countdown-n').textContent = String(Math.ceil(left / 1000));
  };
  tick();
  countdownTimer = setInterval(tick, 100);
}

function runClock(endsAt, totalMs, onAlmostOut) {
  clearInterval(clockTimer);
  $('clock').hidden = false;
  let warned = false;
  const tick = () => {
    const left = Math.max(0, endsAt - performance.now());
    if (!warned && left <= 350 && onAlmostOut) { warned = true; onAlmostOut(); }
    $('clock-fill').style.strokeDashoffset = String(1 - Math.min(1, left / totalMs));
    $('clock-text').textContent = String(Math.ceil(left / 1000));
    $('clock').classList.toggle('urgent', left <= 5000);
    if (left <= 0) clearInterval(clockTimer);
  };
  tick();
  clockTimer = setInterval(tick, 200);
}

function answerLine(pz, guess) {
  const none = guess === null || guess === undefined;
  switch (pz.kind) {
    case 'count': return `${pz.answer} dots${none ? '' : `, you said ${guess}`}`;
    case 'track': return none ? 'No guess' : `Off by ${R.describe(pz, guess).replace(' off', '')} of the wall`;
    case 'angle': return `Target ${pz.target}°${none ? '' : `, you made ${R.describe(pz, guess)}`}`;
    case 'split': return `Target ${pz.label}${none ? '' : `, you marked ${R.describe(pz, guess)}`}`;
    case 'time': return `Target ${R.describe(pz)}${none ? '' : `, you stopped at ${R.describe(pz, guess)}`}`;
    default: return '';
  }
}

function showResultHead(pz, guess, points) {
  $('result-score').textContent = points;
  $('result-score').className = `result-score ${band(points)}`;
  $('result-verdict').textContent = guess === null || guess === undefined ? 'No guess' : R.verdict(points);
  $('result-answer').textContent = answerLine(pz, guess);
  $('result').hidden = false;
  $('brief').hidden = true;
}

/* =========================================================
   Practice and the daily puzzle
   ========================================================= */
let G = null;   // { mode, rounds, index, results, day }

function startSolo(mode) {
  closeRoom();
  const day = R.dayKey();
  const rounds = mode === 'daily' ? R.dailySet(day) : R.makeSet(R.randomSeed(), PREFS.kinds, 1, PREFS.difficulty);
  G = { mode, rounds, index: 0, results: [], day, ref: mode === 'daily' ? `Day ${R.dayNumber(day)}` : `#${rounds[0].seed.toString(16).slice(0, 4).toUpperCase()}` };
  $('arena').classList.remove('with-scores');
  $('scoreboard').hidden = true;
  stopClock();
  showScreen('play');
  soloIntro();
}

function soloIntro() {
  const pz = G.rounds[G.index];
  stopLive();
  frame({ mode: G.mode === 'daily' ? 'Daily' : 'Practice', index: G.index, total: G.rounds.length, pz, ref: G.ref, points: G.results.map((r) => r.points) });
  $('go-btn').hidden = false;
  $('go-btn').focus();
}

$('go-btn').addEventListener('click', () => {
  if (!G) return;
  $('go-btn').hidden = true;
  const pz = G.rounds[G.index];
  mount(pz, 0, (guess) => soloReveal(pz, guess));
});

function soloReveal(pz, guess) {
  const points = R.score(pz, guess);
  G.results.push({ kind: pz.kind, guess, points });
  $('stage').replaceChildren();
  $('controls').replaceChildren();
  TESTS[pz.kind].reveal($('stage'), pz, [{ name: 'You', color: 0, guess, me: true }]);
  showResultHead(pz, guess, points);
  $('round-table').hidden = true;
  const last = G.index === G.rounds.length - 1;
  $('next-btn').hidden = false;
  $('next-btn').textContent = last ? 'See results' : 'Next round';
  $('next-note').textContent = '';
  frameProgress(G.rounds.length, G.index, G.results.map((r) => r.points));
  $('next-btn').focus({ preventScroll: true });
}

function frameProgress(total, index, points) {
  [...$('progress').children].forEach((el, i) => {
    el.className = points[i] !== undefined && points[i] !== null ? band(points[i]) : i === index ? 'now' : '';
  });
}

function soloNext() {
  if (G.index < G.rounds.length - 1) {
    G.index++;
    soloIntro();
  } else {
    soloFinish();
  }
}

function soloFinish() {
  const avg = Math.round(sum(G.results.map((r) => r.points)) / G.results.length);
  if (G.mode === 'daily') {
    const saved = { day: G.day, results: G.results.map(({ kind, points }) => ({ kind, points })), avg };
    store.set(`daily.${G.day}`, saved);
    cloud.track('daily_finished', { avg });
    if (cloud.getUser()) {
      const y = new Date(); y.setDate(y.getDate() - 1);
      cloud.saveMyPlay({ type: 'daily', rounds: saved.results, day: G.day, yesterday: R.dayKey(y) })
        .catch((err) => toast(`Your stats weren’t saved. ${cloud.errorText(err)}`));
    }
    showSummary({ mode: 'daily', results: saved.results, avg, day: G.day, fresh: true });
  } else {
    const best = store.get('best', {});
    const isBest = !best[PREFS.difficulty] || avg > best[PREFS.difficulty];
    if (isBest) store.set('best', { ...best, [PREFS.difficulty]: avg });
    cloud.track('practice_finished', { avg, difficulty: PREFS.difficulty });
    showSummary({ mode: 'practice', results: G.results, avg, note: isBest ? `New personal best on ${PREFS.difficulty}` : `Your best on ${PREFS.difficulty}: ${best[PREFS.difficulty]}` });
  }
  renderDailyCard();
}

function showSummary({ mode, results, avg, day, note }) {
  stopLive();
  $('sum-sub').textContent = mode === 'daily' ? `Daily puzzle, day ${R.dayNumber(day)}` : 'Practice average';
  const dash = 0.75;   // the dial is a 270° arc
  $('sum-dial').className = `sum-dial ${band(avg)}`;
  $('sum-dial').innerHTML = `<svg viewBox="0 0 120 120" aria-hidden="true"><circle class="dial-track" cx="60" cy="60" r="50" pathLength="1" stroke-dasharray="${dash} 1"/><circle class="dial-fill" id="dial-fill" cx="60" cy="60" r="50" pathLength="1" stroke-dasharray="${dash} 1" stroke-dashoffset="${dash}"/></svg><b>${avg}</b>`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $('dial-fill').style.strokeDashoffset = String(dash - (dash * avg) / 100);
  }));
  $('sum-verdict').textContent = R.verdict(avg);
  $('sum-note').textContent = mode === 'daily' ? `A new puzzle arrives at midnight.` : note;
  $('sum-rounds').innerHTML = results.map((r) => `
    <li class="k-${r.kind}">${icon(r.kind)}<span>${TESTS[r.kind].name}</span>
      <span class="bar-meter ${band(r.points)}"><i style="--w:${r.points}%"></i></span><b>${r.points}</b></li>`).join('');
  $('share-btn').hidden = mode !== 'daily';
  $('share-btn').onclick = () => shareDaily(day, results, avg);
  $('again-btn').hidden = mode === 'daily';
  showScreen('summary');
}

async function shareDaily(day, results, avg) {
  const squares = results.map((r) => ({ good: '🟩', okay: '🟨', poor: '🟥' })[band(r.points)]).join('');
  const lines = results.map((r) => `${TESTS[r.kind].name} ${r.points}`).join(' · ');
  const text = `Guesstimate #${R.dayNumber(day)}: ${avg}/100\n${squares}\n${lines}\n${location.origin}${location.pathname}`;
  cloud.track('share_result');
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Result copied. Paste it in your chat.'); }
  } catch { /* closed the share sheet */ }
}

$('again-btn').addEventListener('click', () => startSolo('practice'));
$('home-btn').addEventListener('click', goHome);

function goHome() {
  stopLive();
  stopClock();
  G = null;
  renderDailyCard();
  showScreen('home');
}

/* =========================================================
   Rooms: hosting
   ========================================================= */
const S = { myName: '', myId: null, isHost: false, peer: null, hostConn: null, code: '', view: null, leaving: false, roundKey: '', revealKey: '', locked: false, savedGame: '', heard: 0, reconnecting: false, pending: null };
const H = { room: null, conns: new Map(), deadline: 0, seen: new Map() };
const sets = new Map();

// Every browser builds the round list from the seed and settings.
function roundsFor(seed, st) {
  const key = `${seed}:${st.difficulty}:${st.kinds.join(',')}:${st.laps}`;
  if (!sets.has(key)) sets.set(key, R.makeSet(seed, st.kinds, st.laps, st.difficulty));
  return sets.get(key);
}

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
    Object.assign(S, { peer, myId: id, isHost: true, code, leaving: false, roundKey: '', revealKey: '', savedGame: '' });
    H.conns.clear();
    const u = cloud.getUser();
    H.room = {
      code,
      status: 'lobby',
      settings: { difficulty: ROOM_PREFS.difficulty, kinds: [...ROOM_PREFS.kinds], laps: ROOM_PREFS.laps, timer: ROOM_PREFS.timer },
      gameSeed: 0, index: 0, total: 0, startAt: 0, deadline: 0,
      players: [newPlayer(id, S.myName, true, 0, u?.uid || null, u?.photo || '')],
      crew: null, crewStatus: '', allTime: null,
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
  peer.on('disconnected', () => {
    // Lost the PeerJS server (not the players). Reconnect so new people can still join.
    if (!S.leaving && !peer.destroyed) peer.reconnect();
  });
}

function newPlayer(id, name, isHost, color, uid = null, photo = '') {
  return { id, name, isHost, color, uid, photo, connected: true, away: false, guesses: {}, points: {} };
}

function cleanPhoto(url) {
  const s = String(url || '');
  return /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(s) ? s.slice(0, 500) : '';
}

function freeColor() {
  const used = new Set(H.room.players.map((p) => p.color));
  for (let c = 0; c < MAX_PLAYERS; c++) if (!used.has(c)) return c;
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
  const back = H.room && H.room.players.find((p) => p.id === conn.peer && p.away);
  if (back) {
    back.away = false;
    hostBroadcast();
  }
  if (msg.t === 'ping') return;
  if (msg.t === 'join') hostJoin(conn, msg.name, msg.uid, msg.photo, msg.client);
  if (msg.t === 'guess') hostGuess(conn.peer, msg.index, msg.guess);
}

function hostJoin(conn, rawName, uid, photo, client) {
  const room = H.room;
  const name = cleanName(rawName) || 'Player';
  const cleanUid = typeof uid === 'string' ? uid.slice(0, 128) : null;
  const clientId = typeof client === 'string' ? client.slice(0, 40) : '';

  // Someone who refreshed or dropped out and comes back with the same name gets their seat
  // (and their scores) back: the same tab (after a refresh) or the same Google account may take
  // the seat over at once; anyone else only once that seat has gone offline. A colleague who
  // happens to have the same name while the first is still playing gets "Name 2" instead.
  const old = room.players.find((p) => !p.isHost && p.name.toLowerCase() === name.toLowerCase()
    && ((clientId && p.clientId === clientId) || (cleanUid && p.uid === cleanUid) || !p.connected));
  if (old) {
    old.clientId = clientId || old.clientId;
    const oldConn = H.conns.get(old.id);
    H.conns.delete(old.id);
    if (oldConn && oldConn !== conn) oldConn.close();
    old.id = conn.peer;
    old.connected = true;
    old.away = false;
    H.seen.set(conn.peer, Date.now());
    old.uid = cleanUid || old.uid;
    old.photo = cleanPhoto(photo) || old.photo;
    H.conns.set(conn.peer, conn);
    send(conn, { t: 'welcome', id: conn.peer, code: room.code });
    hostBroadcast();
    return;
  }
  if (room.players.length >= MAX_PLAYERS) room.players = room.players.filter((p) => p.connected);
  if (room.players.length >= MAX_PLAYERS) return reject(conn, `This room is full (${MAX_PLAYERS} players).`);

  let finalName = name;
  for (let n = 2; room.players.some((p) => p.name.toLowerCase() === finalName.toLowerCase()); n++) finalName = `${name} ${n}`;
  const seat = newPlayer(conn.peer, finalName, false, freeColor(), cleanUid, cleanPhoto(photo));
  seat.clientId = clientId;
  room.players.push(seat);
  H.seen.set(conn.peer, Date.now());
  H.conns.set(conn.peer, conn);
  send(conn, { t: 'welcome', id: conn.peer, code: room.code });
  hostBroadcast();
}

function reject(conn, reason) {
  send(conn, { t: 'reject', reason });
  setTimeout(() => conn.close(), 500);
}

function hostOnClose(conn) {
  if (!H.room) return;
  const p = H.room.players.find((x) => x.id === conn.peer);
  H.conns.delete(conn.peer);
  if (!p) return;
  if (H.room.status === 'lobby') H.room.players = H.room.players.filter((x) => x !== p);
  else p.connected = false;
  hostCheckRound();
  hostBroadcast();
}

const hostRounds = () => roundsFor(H.room.gameSeed, H.room.settings);

function hostStartGame() {
  const room = H.room;
  const typedCrew = $('crew-input').value.replace(/\s+/g, ' ').trim();
  if (typedCrew !== (room.crew ? room.crew.name : '')) hostSetCrew(typedCrew);
  room.settings = { difficulty: ROOM_PREFS.difficulty, kinds: [...ROOM_PREFS.kinds], laps: ROOM_PREFS.laps, timer: ROOM_PREFS.timer };
  room.gameSeed = R.randomSeed();
  room.total = room.settings.kinds.length * room.settings.laps;
  room.index = 0;
  room.players = room.players.filter((p) => p.connected);
  for (const p of room.players) { p.guesses = {}; p.points = {}; }
  cloud.track('game_started', { players: room.players.length, rounds: room.total, difficulty: room.settings.difficulty, timer: room.settings.timer, crew: room.crew ? 1 : 0 });
  hostStartRound();
}

function hostStartRound() {
  const room = H.room;
  clearTimeout(H.deadline);
  room.status = 'playing';
  room.startAt = Date.now() + COUNTDOWN_MS;
  // Timing rounds get extra room so a long target can still be counted out
  const limit = R.answerSeconds(hostRounds()[room.index], room.settings.timer);
  room.deadline = limit ? room.startAt + limit * 1000 : 0;
  if (room.deadline) H.deadline = setTimeout(hostReveal, room.deadline - Date.now() + 900);
  hostBroadcast();
}

function hostGuess(pid, index, guess) {
  const room = H.room;
  if (!room || room.status !== 'playing' || index !== room.index) return;
  const p = room.players.find((x) => x.id === pid);
  if (!p || p.guesses[index] !== undefined) return;
  if (!R.validGuess(hostRounds()[index], guess)) return;
  p.guesses[index] = guess;
  hostCheckRound();
  hostBroadcast();
}

// The round ends as soon as every connected player has locked in.
function hostCheckRound() {
  const room = H.room;
  if (room.status !== 'playing') return;
  const waiting = room.players.filter((p) => p.connected && !p.away && p.guesses[room.index] === undefined);
  if (!waiting.length) hostReveal();
}

function hostReveal() {
  const room = H.room;
  if (!room || room.status !== 'playing') return;
  clearTimeout(H.deadline);
  const pz = hostRounds()[room.index];
  for (const p of room.players) p.points[room.index] = R.score(pz, p.guesses[room.index] ?? null);
  room.status = 'reveal';
  cloud.track('round_finished', { kind: pz.kind, round: room.index + 1, players: room.players.length });
  hostBroadcast();
}

function hostNext() {
  const room = H.room;
  if (room.status !== 'reveal') return;
  if (room.index < room.total - 1) {
    room.index++;
    hostStartRound();
  } else {
    hostFinish();
  }
}

function standings(players) {
  return [...players].sort((a, b) => b.total - a.total || Math.max(...b.points, 0) - Math.max(...a.points, 0));
}

function hostFinish() {
  const room = H.room;
  room.status = 'over';
  const view = publicView();
  const order = standings(view.players);
  const winner = order[0] && (order.length === 1 || order[0].total > order[1].total) ? order[0].name : '';
  cloud.track('game_finished', { rounds: room.total, players: order.length });
  if (room.crew && !cloud.getUser()) {
    room.crewStatus = 'This game wasn’t saved. Sign in with Google (gear icon) to save crew scores.';
  } else if (room.crew) {
    const crew = room.crew;
    room.crewStatus = 'Saving this game…';
    cloud.saveCrewGame(crew.name, {
      room: room.code,
      difficulty: room.settings.difficulty,
      winner,
      players: order.map((p) => ({ name: p.name, points: p.total, rounds: room.total })),
    }).then((saved) => {
      if (H.room !== room || room.crew?.name !== crew.name) return;
      room.allTime = saved;
      room.crewStatus = `Saved to ${saved.name}. ${plural(saved.games, 'game')} played as this crew.`;
      hostBroadcast();
    }).catch((err) => {
      console.warn('Saving to crew failed', err);
      if (H.room !== room) return;
      room.crewStatus = `This game wasn’t saved. ${cloud.errorText(err)}`;
      hostBroadcast();
    });
  }
  hostBroadcast();
}

function hostBackToLobby() {
  const room = H.room;
  clearTimeout(H.deadline);
  room.status = 'lobby';
  room.players = room.players.filter((p) => p.connected);
  hostBroadcast();
}

// Crews: all-time scores saved in Firebase by the host.
async function hostSetCrew(rawName) {
  const room = H.room;
  if (!room) return;
  const name = String(rawName || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  store.set('crew', name);
  if (!name) {
    Object.assign(room, { crew: null, allTime: null, crewStatus: '' });
    hostBroadcast();
    return;
  }
  if (cloud.crewId(name).length < 3) return toast('Crew names need at least 3 letters or numbers');
  room.crew = { name };
  room.allTime = null;
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
    room.allTime = data;
    room.crewStatus = data && data.games ? `${plural(data.games, 'game')} played as this crew so far.` : 'New crew. Scores save after the first game.';
  } catch (err) {
    console.warn('Loading crew failed', err);
    if (H.room !== room || room.crew?.name !== name) return;
    room.crewStatus = cloud.errorText(err);
  }
  hostBroadcast();
}

// What every player is allowed to see. Guesses stay hidden until the reveal.
function publicView() {
  const room = H.room;
  const now = Date.now();
  const shown = room.status === 'lobby' ? 0 : room.status === 'playing' ? room.index : room.index + 1;
  const players = room.players.map((p) => {
    const points = Array.from({ length: shown }, (_, i) => p.points[i] ?? 0);
    return {
      id: p.id, name: p.name, color: p.color, isHost: p.isHost, photo: p.photo, connected: p.connected,
      away: p.away,
      locked: p.guesses[room.index] !== undefined,
      guess: room.status === 'reveal' || room.status === 'over' ? p.guesses[room.index] ?? null : undefined,
      points,
      total: sum(points),
    };
  });
  return {
    t: 'state',
    code: room.code, status: room.status, settings: room.settings,
    gameSeed: room.gameSeed, index: room.index, total: room.total,
    startsIn: room.status === 'playing' ? room.startAt - now : 0,
    endsIn: room.status === 'playing' && room.deadline ? room.deadline - now : 0,
    players,
    crewName: room.crew ? room.crew.name : '',
    crewStatus: room.crewStatus,
  };
}

// Every couple of seconds: ping everyone, and mark players we haven't heard from as away.
// Away players don't hold up a round, but keep their seat and can still answer.
function hostHeartbeat() {
  const room = H.room;
  if (!room || !S.isHost) return;
  for (const conn of H.conns.values()) send(conn, { t: 'hb' });
  const now = Date.now();
  let changed = false;
  for (const p of room.players) {
    if (p.isHost || !p.connected) continue;
    const away = now - (H.seen.get(p.id) || 0) > AWAY_MS;
    if (away !== p.away) { p.away = away; changed = true; }
  }
  if (changed) {
    hostCheckRound();
    hostBroadcast();
  }
}

function hostBroadcast() {
  const view = publicView();
  for (const conn of H.conns.values()) send(conn, view);
  onMessage(view);
}

/* =========================================================
   Rooms: joining
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
      // Reconnecting after a drop didn't work: the host has gone
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
    // A fresh join starts clean; a reconnect keeps the round where it was (no second look at the dots)
    if (!quiet) Object.assign(S, { roundKey: '', revealKey: '', savedGame: '', pending: null });
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

// Lost the host (Wi-Fi blip, laptop asleep): rejoin quietly with the same name and tab id,
// which gets the same seat back. If the host has really gone, joinRoom shows a notice.
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
  // A lock-in the host hasn't confirmed yet (lost in a blip) is sent again
  const v = S.view, mine = v && me(v);
  if (S.pending && S.locked && v && v.status === 'playing' && mine && !mine.locked && S.pending.key === `${v.gameSeed}:${v.index}`) {
    send(S.hostConn, { t: 'guess', index: S.pending.index, guess: S.pending.guess });
  }
  if (!document.hidden && Date.now() - S.heard > LOST_MS) reconnect();
}, PING_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !S.isHost && S.hostConn && !S.reconnecting && Date.now() - S.heard > LOST_MS) reconnect();
});
// Closing the tab leaves the room straight away, instead of the host noticing much later
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

function sendGuess(index, guess) {
  S.pending = { key: S.roundKey, index, guess };
  if (S.isHost) hostGuess(S.myId, index, guess);
  else send(S.hostConn, { t: 'guess', index, guess });
}

function closeRoom() {
  if (!S.peer) return;
  S.leaving = true;
  clearTimeout(H.deadline);
  stopLive();
  stopClock();
  S.peer.destroy();
  Object.assign(S, { peer: null, hostConn: null, view: null, isHost: false, code: '', roundKey: '', revealKey: '', reconnecting: false, pending: null });
  H.seen.clear();
  H.room = null;
  H.conns.clear();
}

/* =========================================================
   Messages arriving at this player (host included)
   ========================================================= */
function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'welcome') {
    S.myId = msg.id;
    S.code = msg.code;
    if (S.reconnecting) toast('Reconnected');
    else if (!S.isHost) cloud.track('room_joined');
    S.reconnecting = false;
    setBusy(false);
  } else if (msg.t === 'reject') {
    closeRoom();
    setBusy(false);
    showScreen('home');
    homeError(msg.reason);
  } else if (msg.t === 'state') {
    applyState(msg);
  }
}

const me = (v) => v.players.find((p) => p.id === S.myId);

function applyState(v) {
  S.view = v;
  if (!me(v)) return;   // not seated yet
  if (v.status === 'lobby') {
    stopLive();
    stopClock();
    S.roundKey = '';
    S.revealKey = '';
    renderLobby(v);
    if ($('lobby').hidden) showScreen('lobby');
  } else if (v.status === 'playing') {
    renderRoomRound(v);
  } else if (v.status === 'reveal') {
    renderRoomReveal(v);
  } else if (v.status === 'over') {
    renderOver(v);
  }
}

/* ---------- Lobby ---------- */
const paintRoomDifficulty = segment($('room-difficulty'), () => ROOM_PREFS.difficulty, (v) => { ROOM_PREFS.difficulty = v; roomSettingsChanged(); });
const paintRoomKinds = kindPicks($('room-kinds'), () => ROOM_PREFS.kinds, (k) => { ROOM_PREFS.kinds = k; roomSettingsChanged(); });
$('set-laps').addEventListener('change', (e) => { ROOM_PREFS.laps = Number(e.target.value); roomSettingsChanged(); });
$('set-timer').addEventListener('change', (e) => { ROOM_PREFS.timer = Number(e.target.value); roomSettingsChanged(); });

function roomSettingsChanged() {
  saveRoomPrefs();
  if (!S.isHost || !H.room || H.room.status !== 'lobby') return;
  H.room.settings = { difficulty: ROOM_PREFS.difficulty, kinds: [...ROOM_PREFS.kinds], laps: ROOM_PREFS.laps, timer: ROOM_PREFS.timer };
  hostBroadcast();
}

function settingsLines(st) {
  return [
    `<li><b>${LEVEL[st.difficulty]}</b>: ${st.kinds.map((k) => TESTS[k].name).join(', ')}</li>`,
    `<li><b>${plural(st.kinds.length * st.laps, 'round')}</b>${st.laps > 1 ? `, ${st.laps} of each test` : ''}</li>`,
    `<li><b>${st.timer ? `${st.timer} seconds` : 'No time limit'}</b> to answer</li>`,
  ].join('');
}

function renderLobby(v) {
  $('lobby-code').textContent = v.code;
  const rows = v.players.map((p) => `
    <li class="pc${p.color}${p.connected && !p.away ? '' : ' offline'}"><span class="swatch"></span>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}
      <span class="tag">${p.isHost ? 'Host' : !p.connected || p.away ? 'Reconnecting' : ''}</span></li>`);
  for (let i = v.players.length; i < Math.max(2, v.players.length + 1) && i < MAX_PLAYERS; i++) rows.push('<li class="empty">Waiting for a friend to join…</li>');
  $('lobby-players').innerHTML = rows.join('');
  $('host-settings').hidden = !S.isHost;
  $('guest-settings').hidden = S.isHost;
  if (S.isHost) {
    paintRoomDifficulty();
    paintRoomKinds();
    $('set-laps').value = String(ROOM_PREFS.laps);
    $('set-timer').value = String(ROOM_PREFS.timer);
    if (document.activeElement !== $('crew-input')) $('crew-input').value = v.crewName;
    $('crew-status').textContent = v.crewStatus;
    $('start-btn').textContent = v.players.length > 1 ? 'Start game' : 'Start game (just you so far)';
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

/* ---------- A round in a room ---------- */
function renderScoreboard(v) {
  const sorted = [...v.players].sort((a, b) => b.total - a.total);
  $('score-list').innerHTML = sorted.map((p) => {
    let st = '';
    if (v.status === 'playing') st = p.locked ? '<small class="done">Locked in</small>' : !p.connected ? '<small>Offline</small>' : p.away ? '<small>Away</small>' : '<small>Thinking…</small>';
    return `<li class="pc${p.color}${p.connected && !p.away ? '' : ' offline'}${v.status === 'playing' && p.locked ? ' done-now' : ''}">
      <span class="swatch"></span><span class="nm">${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}${st}</span><span class="pts">${p.total}</span></li>`;
  }).join('');
}

function waitingLine(v) {
  const left = v.players.filter((p) => p.connected && !p.away && !p.locked && p.id !== S.myId).map((p) => p.name);
  if (!left.length) return 'Locked in.';
  const names = left.length > 3 ? `${left.slice(0, 3).join(', ')} and ${left.length - 3} more` : left.join(left.length === 2 ? ' and ' : ', ');
  return `Locked in. Waiting for ${names}…`;
}

function renderRoomRound(v) {
  const rounds = roundsFor(v.gameSeed, v.settings);
  const pz = rounds[v.index];
  const mine = me(v);
  const key = `${v.gameSeed}:${v.index}`;
  $('arena').classList.add('with-scores');
  $('scoreboard').hidden = false;
  renderScoreboard(v);
  if ($('play').hidden) showScreen('play');

  if (S.roundKey !== key) {
    S.roundKey = key;
    S.revealKey = '';
    S.locked = mine.locked;
    stopLive();
    frame({ mode: v.code, index: v.index, total: v.total, pz, ref: `Room ${v.code}`, points: mine.points });
    // When time is nearly up, a guess that's been placed but not locked in still counts
    // No visible countdown in Timing rounds: ticking seconds would let anyone time it off the clock
    if (v.endsIn > 0 && pz.kind !== 'time') runClock(performance.now() + v.endsIn, R.answerSeconds(pz, v.settings.timer) * 1000, () => { if (live && !$('lock-btn').disabled) live.lock(); });
    else stopClock();
    if (S.locked) {
      $('play-hint').textContent = 'You already locked in this round.';
    } else {
      const start = () => mount(pz, mine.color, (guess) => {
        S.locked = true;
        $('stage').querySelector('.board')?.classList.add('locked');
        sendGuess(v.index, guess);
      });
      if (v.startsIn > 150) countdown(v.startsIn, start);
      else start();
    }
  }
  // A lock-in that got lost in a dropped connection is sent again
  if (S.locked && !mine.locked && S.pending && S.pending.key === key && !S.isHost) {
    send(S.hostConn, { t: 'guess', index: S.pending.index, guess: S.pending.guess });
  }
  $('waiting').textContent = S.locked ? waitingLine(v) : '';
  $('end-round-btn').hidden = !S.isHost;
}

$('end-round-btn').addEventListener('click', () => { if (S.isHost) hostReveal(); });

function renderRoomReveal(v) {
  const rounds = roundsFor(v.gameSeed, v.settings);
  const pz = rounds[v.index];
  const mine = me(v);
  const key = `${v.gameSeed}:${v.index}`;
  $('arena').classList.add('with-scores');
  $('scoreboard').hidden = false;
  renderScoreboard(v);
  if ($('play').hidden) showScreen('play');
  if (S.roundKey !== key) {
    S.roundKey = key;
    frame({ mode: v.code, index: v.index, total: v.total, pz, ref: `Room ${v.code}`, points: mine.points });
  }
  if (S.revealKey !== key) {
    S.revealKey = key;
    stopLive();
    stopClock();
    $('lock-btn').hidden = true;
    $('waiting').textContent = '';
    $('end-round-btn').hidden = true;
    $('play-hint').textContent = '';
    $('stage').replaceChildren();
    $('controls').replaceChildren();
    TESTS[pz.kind].reveal($('stage'), pz, v.players.map((p) => ({ name: p.name, color: p.color, guess: p.guess, me: p.id === S.myId })));
    showResultHead(pz, mine.guess, mine.points[v.index] ?? 0);
    frameProgress(v.total, v.index, mine.points);
  }
  const rows = [...v.players].sort((a, b) => (b.points[v.index] ?? 0) - (a.points[v.index] ?? 0));
  $('round-rows').innerHTML = rows.map((p) => `
    <tr class="pc${p.color}${p.id === S.myId ? ' me' : ''}">
      <td><span class="who-cell"><span class="swatch"></span>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}</span></td>
      <td>${p.guess === null ? '–' : esc(R.describe(pz, p.guess))}</td>
      <td><b class="${band(p.points[v.index] ?? 0)}">${p.points[v.index] ?? 0}</b></td>
      <td>${p.total}</td></tr>`).join('');
  $('round-table').hidden = false;
  const last = v.index === v.total - 1;
  $('next-btn').hidden = !S.isHost;
  $('next-btn').textContent = last ? 'See final standings' : 'Next round';
  $('next-note').textContent = S.isHost ? '' : 'Waiting for the host to start the next round.';
}

$('next-btn').addEventListener('click', () => {
  if (G) soloNext();
  else if (S.isHost && H.room) hostNext();
});

/* ---------- Final standings ---------- */
function renderOver(v) {
  stopLive();
  stopClock();
  const order = standings(v.players);
  const rounds = roundsFor(v.gameSeed, v.settings);
  const tie = order.length > 1 && order[0].total === order[1].total;
  $('over-title').textContent = order.length === 1 ? `${order[0].total} points` : tie ? 'It’s a tie' : `${order[0].name} wins`;
  $('over-sub').textContent = `Final standings, ${plural(v.total, 'round')} on ${LEVEL[v.settings.difficulty].toLowerCase()}`;
  let rank = 0, prev = null;
  $('standings').innerHTML = order.map((p, i) => {
    if (p.total !== prev) rank = i + 1;
    prev = p.total;
    return `<li class="pc${p.color}${rank === 1 && !tie ? ' first' : ''}">
      <span class="rk">${rank}</span>
      <span><span class="nm"><span class="swatch"></span>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}</span>
        <span class="per">${p.points.map((x, r) => `<i class="${band(x)}" title="${TESTS[rounds[r].kind].name}: ${x}"></i>`).join('')}</span></span>
      <span class="tot">${p.total}</span></li>`;
  }).join('');
  $('over-crew').textContent = v.crewName ? v.crewStatus : '';
  $('over-host').hidden = !S.isHost;
  $('over-guest').hidden = S.isHost;
  if ($('over').hidden) showScreen('over');

  // Each player saves their own stats once per game
  const mine = me(v);
  if (S.savedGame !== String(v.gameSeed) && cloud.getUser()) {
    S.savedGame = String(v.gameSeed);
    cloud.saveMyPlay({
      type: 'room',
      rounds: rounds.map((pz, i) => ({ kind: pz.kind, points: mine.points[i] ?? 0 })),
      won: !tie && order[0].id === mine.id && order.length > 1,
    }).catch((err) => toast(`Your stats weren’t saved. ${cloud.errorText(err)}`));
  }
}

$('rematch-btn').addEventListener('click', () => { if (S.isHost) hostStartGame(); });
$('lobby-btn').addEventListener('click', () => { if (S.isHost) hostBackToLobby(); });
$('leave-over').addEventListener('click', () => { closeRoom(); goHome(); });
$('quit-btn').addEventListener('click', () => { closeRoom(); goHome(); });

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

$('host-btn').addEventListener('click', () => {
  const name = readName();
  if (!name) return;
  homeError('');
  if (typeof Peer === 'undefined') return homeError('Couldn’t load the connection library. Check your internet and reload the page.');
  S.myName = name;
  G = null;
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
  G = null;
  setBusy(true);
  joinRoom(code);
}
$('join-btn').addEventListener('click', join);
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

function renderDailyCard() {
  const day = R.dayKey();
  $('day-no').textContent = `#${R.dayNumber(day)}`;
  const done = store.get(`daily.${day}`, null);
  if (done) {
    $('daily-status').innerHTML = `You scored <span class="daily-score">${done.avg}</span> today. A new puzzle arrives at midnight.`;
    $('daily-btn').textContent = 'See today’s result';
  } else {
    const n = ['', 'one', 'two', 'three', 'four', 'five', 'six'][R.dailySet(day).length] || String(R.dailySet(day).length);
    $('daily-status').textContent = `The same ${n} puzzles for everyone today. One go each.`;
    $('daily-btn').textContent = 'Play today’s puzzle';
  }
}

$('daily-btn').addEventListener('click', () => {
  const day = R.dayKey();
  const done = store.get(`daily.${day}`, null);
  if (done) showSummary({ mode: 'daily', results: done.results, avg: done.avg, day });
  else startSolo('daily');
});
$('practice-btn').addEventListener('click', () => startSolo('practice'));
segment($('difficulty'), () => PREFS.difficulty, (v) => { PREFS.difficulty = v; savePrefs(); });
kindPicks($('practice-kinds'), () => PREFS.kinds, (k) => { PREFS.kinds = k; savePrefs(); });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || $('play').hidden || openSheet || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
  // One Enter does one thing: stop it also "clicking" the button that gets focus next
  // (locking in moves focus to Next, which would otherwise skip the result)
  e.preventDefault();
  if (!$('go-btn').hidden) $('go-btn').click();
  else if (live && !$('lock-btn').disabled) live.lock();
  else if (!$('result').hidden && !$('next-btn').hidden) $('next-btn').click();
});

/* =========================================================
   Account, settings and stats
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
  $('analytics-row').hidden = !cloud.analyticsConfigured();
  $('analytics-toggle').checked = PREFS.analytics !== false;
  $('my-stats').innerHTML = '';
  if (!u) return;
  $('my-stats').innerHTML = '<p class="muted">Loading your stats…</p>';
  try {
    const st = await cloud.getMyStats();
    if (cloud.getUser()?.uid !== u.uid) return;
    const avg = (pts, n) => (n ? Math.round(pts / n) : '–');
    $('my-stats').innerHTML = `
      <div class="stat-grid">
        <div><b>${st.games}</b><span>Room games</span></div>
        <div><b>${st.wins}</b><span>Wins</span></div>
        <div><b>${avg(st.points, st.rounds)}</b><span>Average</span></div>
        <div><b>${st.dailies}</b><span>Dailies</span></div>
        <div><b>${st.streak}</b><span>Streak</span></div>
        <div><b>${st.bestDaily || '–'}</b><span>Best daily</span></div>
      </div>
      <div class="kind-stats">${R.KINDS.map((k) => {
        const a = avg(st.kinds[k].points, st.kinds[k].rounds);
        return `<div class="k-${k}">${icon(k)}<span>${TESTS[k].name}</span><span class="bar-meter ${a === '–' ? '' : band(a)}"><i style="--w:${a === '–' ? 0 : a}%"></i></span><b>${a}</b></div>`;
      }).join('')}</div>`;
  } catch (err) {
    $('my-stats').innerHTML = `<p class="muted">${esc(cloud.errorText(err))}</p>`;
  }
}

$('analytics-toggle').addEventListener('change', (e) => {
  PREFS.analytics = e.target.checked;
  savePrefs();
  cloud.setAnalyticsEnabled(e.target.checked);
});

// Test hook: with ?debug in the address, automated tests can inspect the connection state.
if (new URLSearchParams(location.search).has('debug')) window.__guesstimate = { S, H };

/* =========================================================
   Start
   ========================================================= */
(function init() {
  $('logo-row').innerHTML = R.KINDS.map((k) => `<span class="tile k-${k}">${icon(k)}</span>`).join('');
  $('rules-tests').innerHTML = R.KINDS.map((k) => `<div><span class="kind-badge k-${k}">${icon(k)}</span><span><b>${TESTS[k].name}</b><p>${TESTS[k].how}</p></span></div>`).join('');
  const saved = store.get('name', '');
  if (saved) $('name-input').value = saved;
  const room = new URLSearchParams(location.search).get('room');
  if (room && /^[A-Za-z]{4}$/.test(room)) {
    $('code-input').value = room.toUpperCase();
    ($('name-input').value ? $('join-btn') : $('name-input')).focus();
  }
  renderDailyCard();
  showScreen('home');
  cloud.onUser((u) => {
    renderAccount(u);
    // A host who signs in mid-room starts saving to their crew straight away.
    if (S.isHost && H.room && H.room.crew && !H.room.allTime) hostSetCrew(H.room.crew.name);
  });
  cloud.initAnalytics(PREFS.analytics !== false);
  cloud.restore();
})();
