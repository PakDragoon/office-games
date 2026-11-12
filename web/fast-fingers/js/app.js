import * as E from './engine.js';
import * as cloud from './cloud.js';
import { createRoomLink, quickPlay } from '../../shared/net.js';
import { wirePublic, paintPublic, publicLine } from '../../shared/public.js';

/* =========================================================
   Fast Fingers
   A typing race: everyone gets the same paragraph at the same moment; first to the end wins.
   One player hosts: their browser is the "server". It picks the paragraph, starts the countdown,
   checks everyone's progress and broadcasts the lanes. Connections use PeerJS (WebRTC).
   Practice runs the same host code locally, alone.
   ========================================================= */

const SOLO_ID = 'me';

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ordinal = (n) => ['1st', '2nd', '3rd'][n - 1] || `${n}th`;

/* ---------- This browser only ---------- */
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`fastfingers.${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`fastfingers.${key}`, JSON.stringify(value)); } catch { /* not saved */ }
  },
};
const PREFS = { sound: true, analytics: true, ...store.get('prefs', {}) };
let ROOM_PREFS = E.cleanSettings(store.get('room', {}));
let PRACTICE = E.cleanSettings(store.get('practice', {}));
const savePrefs = () => store.set('prefs', PREFS);


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
  tick() { if (PREFS.sound) tone(520, 0, 0.09, 0.09); },
  go() { if (PREFS.sound) tone(880, 0, 0.22, 0.13); },
  nope() { if (PREFS.sound) tone(170, 0, 0.07, 0.05, 'square'); },
  done() { if (PREFS.sound) [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.08, 0.24, 0.12, 'triangle')); },
  win() { if (PREFS.sound) [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.09, 0.3, 0.12, 'triangle')); },
};

/* =========================================================
   Hosting (rooms, and practice on your own)
   ========================================================= */
const S = {
  myName: '', myId: null, isHost: false, code: '', view: null, creating: false,
  reconnecting: false, viewAt: 0, overSeen: -1, lastCount: 0, resent: 0,
};
const H = { room: null, timer: 0, soon: 0, rnd: Math.random };

// My own typing. The page keeps it (so keys feel instant) and reports progress to the server.
const R = { key: '', text: '', pos: 0, err: 0, bad: false, done: false, ms: 0, goAt: 0, started: false, els: [], lineTop: -1, sendT: 0 };


function newRoom(code, solo, settings) {
  return {
    code, solo, status: 'lobby', settings: { ...settings }, game: 0, players: [],
    phase: '', phaseEnd: 0, raceStart: 0, passage: -1, text: '', runs: {}, order: [],
    used: new Set(), results: null, winners: [], crew: null, crewStatus: '',
  };
}


function newPlayer(id, name, isHost, color, uid = null, photo = '') {
  return { id, name, isHost, color, uid, photo, clientId: '', connected: true, away: false, inGame: false, wins: 0, best: 0 };
}




// Practice only: this browser's own progress
function hostOnMessage(msg) {
  if (!msg || typeof msg !== 'object' || !H.room) return;
  if (msg.t === 'prog') hostProgress(SOLO_ID, msg);
}





const active = (p) => p.connected && !p.away;
const byId = (id) => H.room.players.find((p) => p.id === id);


// Someone left or went quiet: the race may not need to wait for them any more
function hostAfterPresence() {
  if (H.room.status === 'play' && H.room.phase === 'race') hostCheckDone();
}

/* ---------- A race ---------- */

function setTimer(ms, fn) {
  clearTimeout(H.timer);
  H.timer = setTimeout(fn, Math.max(0, ms));
}

function hostStartGame(samePassage = false) {
  const room = H.room;
  if (!room || room.status === 'play') return;
  room.players = room.players.filter((p) => p.connected);
  for (const p of room.players) p.inGame = true;
  if (!samePassage || room.passage < 0) room.passage = E.pickPassage(H.rnd, room.used);
  room.used.add(room.passage);
  room.text = E.makeText(room.passage, room.settings);
  room.runs = {};
  room.order = [];
  for (const p of room.players) room.runs[p.id] = { pos: 0, err: 0, done: false, ms: 0, place: 0 };
  Object.assign(room, { status: 'play', game: room.game + 1, results: null, winners: [] });
  cloud.track('game_started', { mode: room.solo || 'room', players: room.players.length, length: room.settings.length });
  if (room.solo) {
    // On your own there's no countdown: the clock starts on the first key
    room.phase = 'race';
    room.phaseEnd = 0;
    room.raceStart = Date.now();
    clearTimeout(H.timer);
  } else {
    room.phase = 'countdown';
    room.phaseEnd = Date.now() + E.TIMES.countdownMs;
    setTimer(E.TIMES.countdownMs, hostGo);
  }
  hostBroadcast();
}

function hostGo() {
  const room = H.room;
  if (!room || room.status !== 'play' || room.phase !== 'countdown') return;
  room.phase = 'race';
  room.raceStart = Date.now();
  room.phaseEnd = room.raceStart + E.limitMs(room.text);
  setTimer(room.phaseEnd - Date.now(), hostEndRace);
  hostBroadcast();
  hostCheckDone();
}

function hostProgress(pid, msg) {
  const room = H.room;
  if (room.status !== 'play' || room.phase !== 'race') return;
  const run = room.runs[pid];
  if (!run || run.done) return;
  const len = room.text.length;
  const elapsed = Date.now() - room.raceStart;
  const pos = Math.min(len, Math.floor(Number(msg.pos)));
  const err = Math.floor(Number(msg.err));
  if (!(pos >= run.pos) || !(err >= 0)) return;
  if (!room.solo && !E.plausible(pos, elapsed)) return;      // nobody types that fast
  run.pos = pos;
  run.err = Math.min(9999, Math.max(run.err, err));
  if (pos >= len) {
    const mine = Number(msg.ms);
    // The player's own clock is used when it agrees with the host's (it's free of network delay)
    const agrees = Number.isFinite(mine) && mine > 0 && (room.solo || (mine <= elapsed + 250 && mine >= elapsed - 2500));
    run.ms = Math.max(Math.round(agrees ? mine : elapsed), Math.ceil((len / E.MAX_CPS) * 1000));
    run.done = true;
    room.order.push(pid);
    run.place = room.order.length;
    if (!room.solo && run.place === 1) {
      // The first finish starts the clock on everyone else
      room.phaseEnd = Math.min(room.phaseEnd, Date.now() + E.graceMs(run.ms));
      setTimer(room.phaseEnd - Date.now(), hostEndRace);
    }
    hostBroadcast();
    hostCheckDone();
    return;
  }
  hostBroadcastSoon();
}

// The race ends when everyone still here has finished (or time runs out)
function hostCheckDone() {
  const room = H.room;
  if (room.status !== 'play' || room.phase !== 'race') return;
  const racers = room.players.filter((p) => room.runs[p.id]);
  const waiting = racers.filter((p) => !room.runs[p.id].done && (room.solo || active(p)));
  if (!waiting.length) setTimer(room.solo ? 0 : E.TIMES.endPauseMs, hostEndRace);
}

function hostEndRace() {
  const room = H.room;
  if (!room || room.status !== 'play' || room.phase !== 'race') return;
  clearTimeout(H.timer);
  const elapsed = Date.now() - room.raceStart;
  const len = room.text.length;
  const rows = room.players.filter((p) => room.runs[p.id]).map((p) => {
    const r = room.runs[p.id];
    const ms = r.done ? r.ms : elapsed;
    return { id: p.id, pos: r.pos, err: r.err, done: r.done, ms, wpm: E.wpm(r.pos, ms), acc: E.accuracy(r.pos, r.err), pct: Math.floor((r.pos / len) * 100) };
  });
  room.results = E.rank(rows);
  const top = room.results[0];
  room.winners = top && top.pos > 0 ? [top.id] : [];
  for (const r of room.results) {
    const p = byId(r.id);
    if (!p) continue;
    if (room.winners.includes(p.id)) p.wins++;
    if (r.done) p.best = Math.max(p.best, r.wpm);
  }
  room.status = 'over';
  room.phase = '';
  room.phaseEnd = 0;
  hostBroadcast();
}


/* ---------- Practice ---------- */

function startSolo(samePassage = false) {
  // "Next paragraph" stays in the same solo room, so paragraphs don't repeat until all are used
  if (!(H.room && H.room.solo)) {
    closeRoom();
    Object.assign(S, { myId: SOLO_ID, isHost: true, code: '', overSeen: -1 });
    H.rnd = E.mulberry32(E.randomSeed());
    const room = newRoom('', 'practice', PRACTICE);
    room.players.push(newPlayer(SOLO_ID, S.myName || 'You', true, 0));
    H.room = room;
    cloud.track('practice_started');
  }
  hostStartGame(samePassage);
}

const bestKey = (st) => `${st.length}-${st.caps}-${st.punct}`;

/* ---------- Crews ---------- */



/* ---------- What everyone sees (there are no secrets in a typing race) ---------- */

function hostView() {
  const room = H.room;
  const now = Date.now();
  const playing = room.status !== 'lobby';
  return {
    t: 'state',
    code: room.code, solo: room.solo, status: room.status, settings: room.settings, game: room.game, phase: room.phase,
    phaseLeft: room.phaseEnd ? room.phaseEnd - now : 0,
    elapsed: room.phase === 'race' ? now - room.raceStart : 0,
    text: playing ? room.text : '',
    players: room.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, isHost: p.isHost, photo: p.photo, connected: p.connected, away: p.away,
      inGame: p.inGame, wins: p.wins, best: p.best, g: playing && room.runs[p.id] ? room.runs[p.id] : null,
    })),
    results: room.status === 'over' ? room.results : null,
    winners: room.status === 'over' ? room.winners : [],
    crewName: room.crew ? room.crew.name : '',
    crewStatus: room.crewStatus,
  };
}

function hostBroadcast() {
  if (!H.room) return;
  clearTimeout(H.soon);
  H.soon = 0;
  onMessage(hostView());
}

// Progress arrives several times a second from every player: send it on in batches
function hostBroadcastSoon() {
  H.soon ||= setTimeout(hostBroadcast, 200);
}

/* =========================================================
   Rooms on the server
   ========================================================= */
const link = createRoomLink('fast-fingers', {
  hello: () => {
    const u = cloud.getUser();
    return { name: S.myName, photo: u?.photo || '' };
  },
  message: onMessage,
  reconnecting: () => {
    S.reconnecting = true;
    toast('Connection lost. Reconnecting…');
  },
  gone: (reason) => {
    closeRoom();
    goHome();
    showNotice('The room closed', reason || 'Everyone left, so the room was closed. Host a new one.');
  },
  failed: (text) => {
    closeRoom();
    setBusy(false);
    showScreen('home');
    homeError(text);
  },
});

// In a room the server runs the race; practice runs it here
const playingSolo = () => Boolean(H.room && H.room.solo);

function toHost(msg) {
  if (playingSolo()) hostOnMessage(msg);
  else link.send(msg);
}

function closeRoom() {
  link.close();
  clearTimeout(H.timer);
  clearTimeout(H.soon);
  clearTimeout(R.sendT);
  H.soon = 0;
  Object.assign(S, { view: null, isHost: false, code: '', reconnecting: false, creating: false });
  Object.assign(R, { key: '', sendT: 0 });
  H.room = null;
  for (const el of laneEls.values()) el.remove();
  laneEls.clear();
}

// The host's buttons in a room (the server only acts on them from whoever is host right now)
function roomStart() {
  toHost({ t: 'start', settings: { ...ROOM_PREFS }, crew: $('crew-input').value.replace(/\s+/g, ' ').trim() });
}

function roomSetCrew(rawName) {
  const name = String(rawName || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (name && name.toLowerCase().replace(/[^a-z0-9]/g, '').length < 3) return toast('Crew names need at least 3 letters or numbers');
  store.set('crew', name);
  toHost({ t: 'crew', name });
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
      else cloud.track('room_joined');
      S.reconnecting = false;
      setBusy(false);
      break;
    case 'reject':
      closeRoom();
      setBusy(false);
      showScreen('home');
      homeError(msg.reason);
      break;
    case 'toast':
      toast(String(msg.text || ''));
      break;
    case 'state':
      applyState(msg);
      break;
    default:
  }
}

const me = (v) => v.players.find((p) => p.id === S.myId);
const pOf = (v, id) => v.players.find((p) => p.id === id);
const racing = (v) => v.status === 'play' && v.phase === 'race';
const canType = () => Boolean(S.view && racing(S.view) && me(S.view)?.g && !R.done && R.key === String(S.view.game) && !openSheet);
// The typing box can be focused from the countdown on, so a phone's keyboard is up before "go"
const canFocus = () => Boolean(S.view && S.view.status === 'play' && me(S.view)?.g && !R.done);
const elapsedNow = (v) => v.elapsed + (performance.now() - S.viewAt);
const phaseLeft = (v) => Math.max(0, v.phaseLeft - (performance.now() - S.viewAt));

function applyState(v) {
  if (!v || !Array.isArray(v.players)) return;
  const prev = S.view;
  S.view = v;
  S.viewAt = performance.now();
  const seat = me(v);
  if (!seat) return;
  if (!v.solo) {
    S.isHost = Boolean(seat.isHost);
    S.code = v.code;
    if (S.creating && S.isHost) {
      // A room we just opened: bring this browser's saved settings and crew
      S.creating = false;
      toHost({ t: 'settings', settings: { ...ROOM_PREFS } });
      const savedCrew = store.get('crew', '');
      if (savedCrew) roomSetCrew(savedCrew);
    }
  }
  if (v.status === 'lobby') {
    renderLobby(v);
    if ($('lobby').hidden) showScreen('lobby');
    return;
  }
  if ($('game').hidden) showScreen('game');
  if (String(v.game) !== R.key) newRun(v);
  const mine = me(v).g;
  const go = racing(v) && (!prev || !racing(prev) || prev.game !== v.game);
  if (go) {
    // Go! (or this tab was refreshed in the middle of a race)
    if (!v.solo) R.goAt = performance.now() - v.elapsed;
    if (prev && prev.phase === 'countdown') SOUND.go();
  }
  // My finish didn't reach the host (a dropped connection): tell it again
  if (R.done && mine && !mine.done && racing(v) && performance.now() - S.resent > 1000) {
    S.resent = performance.now();
    sendProgress(true);
  }
  renderGame(v);
  if ((go || (v.phase === 'countdown' && (!prev || prev.phase !== 'countdown'))) && canFocus()) focusInput();
}

/* =========================================================
   Typing
   ========================================================= */

// A new race: lay the paragraph out one character at a time
function newRun(v) {
  const g = me(v)?.g;
  clearTimeout(R.sendT);
  Object.assign(R, {
    key: String(v.game), text: String(v.text || ''), pos: g ? g.pos : 0, err: g ? g.err : 0, bad: false,
    done: Boolean(g && g.done), ms: g ? g.ms : 0, goAt: performance.now() - (v.elapsed || 0), started: false,
    els: [], lineTop: -1, sendT: 0,
  });
  S.lastCount = 0;
  const box = $('type-text');
  box.innerHTML = '';
  box.scrollTop = 0;
  let word = null;
  for (const ch of R.text) {
    if (!word) {
      word = document.createElement('span');
      word.className = 'w';
      box.appendChild(word);
    }
    const c = document.createElement('span');
    c.className = 'c';
    c.textContent = ch;
    word.appendChild(c);
    R.els.push(c);
    if (ch === ' ') word = null;
  }
  $('type-input').value = '';
  paintText();
}

function paintText() {
  const showCaret = Boolean(S.view && me(S.view)?.g) && !R.done;
  R.els.forEach((el, i) => {
    el.className = i < R.pos ? 'c ok' : i === R.pos && showCaret ? `c cur${R.bad ? ' bad' : ''}` : 'c';
  });
  followCaret();
}

// Keep the line being typed near the top of the box
function followCaret() {
  const el = R.els[Math.min(R.pos, R.els.length - 1)];
  if (!el) return;
  const top = el.offsetTop;
  if (top === R.lineTop) return;
  R.lineTop = top;
  $('type-text').scrollTop = Math.max(0, top - el.offsetHeight * 1.4);
}

function typeChar(ch) {
  if (!canType() || ch === '\n' || ch === '\r') return;
  const v = S.view;
  if (v.solo && !R.started) { R.started = true; R.goAt = performance.now(); }
  if (E.hit(R.text[R.pos], ch, v.settings)) {
    R.els[R.pos].className = 'c ok';
    R.pos++;
    R.bad = false;
    if (R.pos >= R.text.length) {
      R.done = true;
      R.ms = Math.round(performance.now() - R.goAt);
      SOUND.done();
      sendProgress(true);
      renderGame(S.view);
      return;
    }
    R.els[R.pos].className = 'c cur';
    followCaret();
  } else {
    R.err++;
    R.bad = true;
    const el = R.els[R.pos];
    el.className = 'c cur';
    void el.offsetWidth;               // restart the little shake
    el.className = 'c cur bad';
    SOUND.nope();
  }
  sendProgress();
  renderStats(v);
}

function sendProgress(now = false) {
  if (!now) {
    R.sendT ||= setTimeout(() => { R.sendT = 0; sendProgress(true); }, 500);
    return;
  }
  clearTimeout(R.sendT);
  R.sendT = 0;
  toHost({ t: 'prog', pos: R.pos, err: R.err, ms: R.done ? R.ms : Math.round(performance.now() - R.goAt) });
}

// The (invisible) box that takes the typing. Works with phone keyboards too, which may send a
// word at a time or hold letters in a "composition" before committing them.
const input = $('type-input');
let composed = 0;
input.addEventListener('input', (e) => {
  const type = e.inputType || '';
  if (type === 'insertFromPaste' || type === 'insertFromDrop') { input.value = ''; composed = 0; return; }
  if (e.isComposing || type === 'insertCompositionText') {
    const val = input.value;
    if (val.length < composed) composed = val.length;
    const fresh = val.slice(composed);
    composed = val.length;
    typeChars(fresh);
    return;
  }
  const data = input.value;
  input.value = '';
  composed = 0;
  if (!type.startsWith('delete')) typeChars(data);
});
input.addEventListener('compositionend', () => { input.value = ''; composed = 0; });
input.addEventListener('paste', (e) => e.preventDefault());
input.addEventListener('drop', (e) => e.preventDefault());
input.addEventListener('focus', () => { $('type-box').classList.add('focus'); renderFocusHint(); });
input.addEventListener('blur', () => { $('type-box').classList.remove('focus'); renderFocusHint(); });

function typeChars(str) {
  if (!str || str.length > 12) return;         // a whole pasted or auto-filled chunk doesn't count
  for (const ch of str) typeChar(ch);
}

function focusInput() {
  if (document.activeElement !== input) input.focus({ preventScroll: true });
}

function renderFocusHint() {
  $('focus-hint').hidden = !(canFocus() && !openSheet && document.activeElement !== input);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { close(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || openSheet || $('game').hidden) return;
  const v = S.view;
  if (!v) return;
  if (v.status === 'over') {
    if (e.key === 'Enter' && !e.target.closest('button')) {
      if (v.solo) { e.preventDefault(); startSolo(); } else if (S.isHost) { e.preventDefault(); roomStart(); }
    }
    return;
  }
  // Any key lands in the typing box, wherever the focus was
  if (canFocus() && document.activeElement !== input && e.key.length === 1) focusInput();
});

/* =========================================================
   The game screen
   ========================================================= */
function settingsLabel(st) {
  return `${{ short: 'Short', medium: 'Medium', long: 'Long' }[st.length]} · ${st.caps === 'on' ? 'capitals' : 'no capitals'} · ${st.punct === 'on' ? 'punctuation' : 'no punctuation'}`;
}

function renderGame(v) {
  $('bar-code').textContent = v.solo ? 'Practice' : v.code;
  $('bar-phase').textContent = settingsLabel(v.settings);
  const over = v.status === 'over';
  const mine = me(v).g;
  $('type-box').hidden = over;
  $('stat-row').hidden = over || !mine;
  $('result-view').hidden = !over;
  $('lanes').hidden = Boolean(v.solo);
  $('type-box').classList.toggle('waiting', v.phase === 'countdown');
  input.disabled = !canFocus();
  if (!over) {
    if (R.done || !mine) paintText();
    renderStats(v);
  } else renderResult(v);
  renderStatus(v);
  renderLanes(v);
  renderFocusHint();
  const watchers = v.solo ? [] : v.players.filter((p) => p.connected && !p.g);
  $('watching').textContent = watchers.length ? `Watching: ${watchers.map((p) => p.name + (p.id === S.myId ? ' (you)' : '')).join(', ')}` : '';
  $('host-actions').hidden = !(S.isHost && !v.solo && !over);
  $('end-race').hidden = !racing(v);
}

function renderStatus(v) {
  const el = $('status-line');
  const mine = me(v).g;
  let html = '';
  if (v.status === 'over') html = '';
  else if (v.phase === 'countdown') {
    const s = Math.max(1, Math.ceil(phaseLeft(v) / 1000));
    if (s !== S.lastCount) { S.lastCount = s; SOUND.tick(); }
    html = `<span>${mine ? 'Get ready' : 'Race starting'}</span><b class="count-num">${s}</b>`;
  } else if (v.solo) {
    html = R.started ? '' : '<span>The clock starts on your first key</span>';
  } else {
    const left = phaseLeft(v);
    const chip = v.phaseLeft > 0 ? `<span class="timer-chip${left <= 10000 ? ' urgent' : ''}">${E.formatMs(left).replace(/\.\d/, '')}</span>` : '';
    if (!mine) html = `<span>You’re watching this race. You’ll be in the next one.</span>${chip}`;
    else if (R.done) {
      const place = mine.place ? ` · ${ordinal(mine.place)}` : '';
      html = `<span class="go">Finished${place}!</span><span>Waiting for the others…</span>${chip}`;
    } else html = `<span class="go">Go!</span>${chip}`;
  }
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderStats(v) {
  const mine = me(v)?.g;
  if (!mine) return;
  const going = racing(v) && (!v.solo || R.started);
  const ms = R.done ? R.ms : going ? performance.now() - R.goAt : 0;
  $('stat-wpm').innerHTML = `${E.wpm(R.pos, ms)}<small> wpm</small>`;
  $('stat-acc').textContent = `${E.accuracy(R.pos, R.err)}%`;
  $('stat-time').textContent = E.formatMs(ms);
}

/* ---------- The lanes ---------- */

// Rows are kept (keyed by player) so the runners slide instead of jumping
const laneEls = new Map();
function renderLanes(v) {
  if (v.solo) return;
  const len = Math.max(1, v.text.length);
  const keep = new Set();
  for (const p of v.players) {
    if (!p.g) continue;
    keep.add(p.id);
    let el = laneEls.get(p.id);
    if (!el) {
      el = document.createElement('li');
      el.innerHTML = '<span class="nm"></span><span class="track"><span class="runner"></span></span><span class="num"></span>';
      laneEls.set(p.id, el);
      $('lanes').appendChild(el);
    }
    const isMe = p.id === S.myId;
    const pos = isMe ? Math.max(R.pos, p.g.pos) : p.g.pos;
    const done = isMe ? R.done || p.g.done : p.g.done;
    const ms = done ? (isMe && R.done ? R.ms : p.g.ms) : racing(v) ? (isMe ? performance.now() - R.goAt : elapsedNow(v)) : 0;
    el.className = `pc${p.color}${isMe ? ' me' : ''}${p.connected && !p.away ? '' : ' off'}${done ? ' done' : ''}`;
    el.querySelector('.nm').textContent = p.name;
    const runner = el.querySelector('.runner');
    runner.textContent = p.name.slice(0, 1);
    runner.style.left = `calc((100% - 26px) * ${(pos / len).toFixed(3)})`;
    const speed = E.wpm(pos, ms);
    el.querySelector('.num').innerHTML = !p.connected ? '<small>left</small>' : p.away && !done ? '<small>away</small>'
      : `${speed}<small>wpm</small>`;
  }
  for (const [id, el] of laneEls) {
    if (keep.has(id)) continue;
    el.remove();
    laneEls.delete(id);
  }
}

/* ---------- The result ---------- */

function renderResult(v) {
  const box = $('result-view');
  const rows = v.results || [];
  const mine = rows.find((r) => r.id === S.myId);
  const tiles = (r) => `<div class="stat-row">
      <div><b>${r.wpm}<small> wpm</small></b><span>Speed</span></div>
      <div><b>${r.acc}%</b><span>Accuracy</span></div>
      <div><b>${r.done ? E.formatMs(r.ms) : `${r.pct}%`}</b><span>${r.done ? 'Time' : 'Typed'}</span></div>
    </div>`;
  let html = '';
  if (v.solo) {
    if (!mine) { box.innerHTML = ''; return; }
    const key = bestKey(v.settings);
    const bests = store.get('best', {});
    const old = bests[key] || 0;
    if (S.overSeen !== v.game) {
      S.overSeen = v.game;
      S.newBest = mine.wpm > old;
      if (S.newBest) { bests[key] = mine.wpm; store.set('best', bests); }
    }
    const best = Math.max(old, mine.wpm);
    html = `<div class="result-banner good">${S.newBest && old ? 'A new best!' : 'Finished!'}</div>
      ${tiles(mine)}
      <p>${S.newBest ? (old ? `Your best with these settings was ${old} wpm.` : 'Your first run with these settings. That’s the speed to beat.') : `Your best with these settings: ${best} wpm`}</p>
      <div class="result-actions"><button class="btn primary" type="button" id="next-btn">Next paragraph</button><button class="btn ghost" type="button" id="retry-btn">Same one again</button></div>
      <button class="btn link" type="button" id="home-btn">Back to home</button>
      <p class="small-note muted">Press Enter for the next paragraph.</p>`;
    box.innerHTML = html;
    return;
  }
  const iWon = v.winners.includes(S.myId);
  const winner = v.winners.length ? pOf(v, v.winners[0]) : null;
  const title = !winner ? 'Nobody typed a thing!' : iWon ? 'You win!' : `${esc(winner.name)} wins!`;
  html = `<div class="result-banner ${iWon ? 'good' : ''}">${title}</div>`;
  if (mine) html += tiles(mine);
  html += `<ol class="standings">${rows.map((r, i) => {
    const p = pOf(v, r.id);
    const detail = r.done ? `${r.acc}% · ${E.formatMs(r.ms)}` : `${r.pct}% typed · ${r.acc}%`;
    return `<li class="pc${p ? p.color : 0}${r.id === S.myId ? ' me' : ''}"><span class="place">${i + 1}</span><span class="nm">${esc(p ? p.name : 'Someone')}${r.id === S.myId ? ' (you)' : ''} <span class="muted small">${detail}</span></span><span class="pts">${r.wpm} wpm</span></li>`;
  }).join('')}</ol>`;
  const tally = v.players.filter((p) => p.wins > 0).sort((a, b) => b.wins - a.wins);
  if (v.game > 1 && tally.length) html += `<p class="small-note muted">Wins in this room: ${tally.map((p) => `${esc(p.name)} ${p.wins}`).join(' · ')}</p>`;
  html += S.isHost
    ? '<div class="result-actions"><button class="btn primary" type="button" id="again-btn">Race again</button><button class="btn ghost" type="button" id="lobby-btn">Change settings</button></div>'
    : '<p class="small-note muted">The host can start another race.</p>';
  if (v.crewName) html += `<p class="small-note muted">${esc(v.crewStatus)}</p>`;
  if (S.overSeen !== v.game) {
    S.overSeen = v.game;
    if (iWon) setTimeout(SOUND.win, 300);
  }
  box.innerHTML = html;
}


$('result-view').addEventListener('click', (e) => {
  const id = e.target.id;
  if (id === 'again-btn' && S.isHost) { if (playingSolo()) startSolo(); else roomStart(); }
  if (id === 'lobby-btn' && S.isHost) toHost({ t: 'lobby' });
  if (id === 'next-btn') startSolo();
  if (id === 'retry-btn') startSolo(true);
  if (id === 'home-btn') { closeRoom(); goHome(); }
});

$('end-race').addEventListener('click', () => { if (S.isHost) toHost({ t: 'endRace' }); });
$('end-game').addEventListener('click', () => { if (S.isHost) toHost({ t: 'lobby' }); });
$('quit-btn').addEventListener('click', () => { closeRoom(); goHome(); });

// Clocks, speeds and lanes tick on every screen without waiting for the host
setInterval(() => {
  const v = S.view;
  if (!v || $('game').hidden || v.status !== 'play' || !me(v)) return;
  renderStatus(v);
  renderStats(v);
  renderLanes(v);
}, 250);

/* =========================================================
   Lobby
   ========================================================= */
// guard: who may change it (room settings: only the host)
function segment(container, get, set, guard = () => S.isHost) {
  const paint = () => container.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === String(get()))));
  container.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !guard()) return;
    set(b.dataset.value);
    paint();
  });
  paint();
  return paint;
}

const paintLength = segment($('set-length'), () => ROOM_PREFS.length, (val) => { ROOM_PREFS.length = val; roomSettingsChanged(); });
for (const key of ['caps', 'punct']) {
  $(`set-${key}`).addEventListener('change', (e) => {
    if (!S.isHost) return;
    ROOM_PREFS[key] = e.target.checked ? 'on' : 'off';
    roomSettingsChanged();
  });
}

function roomSettingsChanged() {
  ROOM_PREFS = E.cleanSettings(ROOM_PREFS);
  store.set('room', ROOM_PREFS);
  if (!S.isHost || playingSolo() || !S.view || S.view.status !== 'lobby') { paintRoomSettings(); return; }
  toHost({ t: 'settings', settings: { ...ROOM_PREFS } });
}

const includeNote = (st) => (st.caps === 'off' && st.punct === 'off' ? 'Only lower-case letters, numbers and spaces.'
  : st.caps === 'off' ? 'Everything in lower case.' : st.punct === 'off' ? 'No commas, full stops or other marks.' : '');

function paintRoomSettings(st = ROOM_PREFS) {
  paintLength();
  $('set-caps').checked = st.caps === 'on';
  $('set-punct').checked = st.punct === 'on';
  $('include-note').textContent = includeNote(st);
}

function settingsLines(st) {
  return [
    `<b>${{ short: 'Short', medium: 'Medium', long: 'Long' }[st.length]} paragraph</b>, about ${E.ABOUT_WORDS[st.length]} words`,
    st.caps === 'on' ? 'Capital letters count' : 'No capital letters',
    st.punct === 'on' ? 'With punctuation' : 'No punctuation',
  ].map((l) => `<li>${l}</li>`).join('');
}

function renderLobby(v) {
  $('lobby-code').textContent = v.code;
  const st = v.settings;
  const rows = v.players.map((p) => `<li class="pc${p.color}${active(p) ? '' : ' off'}"><span class="pen-dot"></span>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}
      <span class="tag">${!active(p) ? 'Reconnecting' : [p.isHost ? 'Host' : '', p.wins ? plural(p.wins, 'win') : '', p.best ? `best ${p.best} wpm` : ''].filter(Boolean).join(' · ')}</span></li>`);
  if (v.players.length < 2) rows.push('<li class="empty">Waiting for someone to join…</li>');
  $('lobby-players').innerHTML = rows.join('');
  $('host-settings').hidden = !S.isHost;
  $('guest-settings').hidden = S.isHost;
  if (S.isHost) {
    paintRoomSettings(st);
    if (document.activeElement !== $('crew-input')) $('crew-input').value = v.crewName;
    $('crew-status').textContent = v.crewStatus;
    paintPublic(v);
    $('start-note').textContent = v.players.length < 2 ? 'You can start alone, but it’s a race: copy the invite link and send it round.' : '';
  } else {
    $('settings-summary').innerHTML = settingsLines(st) + (v.crewName ? `<li>Crew: <b>${esc(v.crewName)}</b></li>` : '') + `<li>${publicLine(v)}</li>`;
  }
}

$('copy-link').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${S.code}`;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); } catch { toast(url); }
});
$('crew-save').addEventListener('click', () => roomSetCrew($('crew-input').value));
wirePublic(toHost);
$('crew-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') roomSetCrew($('crew-input').value); });
$('start-btn').addEventListener('click', () => { if (S.isHost) roomStart(); });
$('leave-lobby').addEventListener('click', () => { closeRoom(); goHome(); });

/* =========================================================
   Home
   ========================================================= */
function logoHtml() {
  const keys = 'FINGERS'.split('').map((ch, i) => `<span class="keycap" style="--i:${i}">${ch}</span>`).join('');
  return `<span class="logo-fast"><span class="logo-lines"><i></i><i></i><i></i></span>FAST</span><span class="logo-keys">${keys}</span>`;
}

const paintPrLength = segment($('pr-length'), () => PRACTICE.length, (val) => { PRACTICE.length = val; practiceChanged(); }, () => true);
for (const key of ['caps', 'punct']) {
  $(`pr-${key}`).addEventListener('change', (e) => { PRACTICE[key] = e.target.checked ? 'on' : 'off'; practiceChanged(); });
}
function practiceChanged() {
  PRACTICE = E.cleanSettings(PRACTICE);
  store.set('practice', PRACTICE);
  renderSoloCard();
}

function renderSoloCard() {
  paintPrLength();
  $('pr-caps').checked = PRACTICE.caps === 'on';
  $('pr-punct').checked = PRACTICE.punct === 'on';
  const best = store.get('best', {})[bestKey(PRACTICE)] || 0;
  $('best-line').textContent = best ? `Your best with these settings: ${best} wpm` : '';
}

function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

$('practice-btn').addEventListener('click', () => {
  const name = cleanName($('name-input').value);
  if (name) store.set('name', name);
  S.myName = name || 'You';
  homeError('');
  startSolo();
});

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
  $('quick-btn').disabled = busy;
  $('join-btn').disabled = busy;
  $('join-btn').textContent = busy ? 'Connecting…' : 'Join room';
}

function goHome() {
  renderSoloCard();
  showScreen('home');
}

$('host-btn').addEventListener('click', () => {
  const name = readName();
  if (!name) return;
  homeError('');
  closeRoom();
  S.myName = name;
  setBusy(true);
  S.creating = true;
  link.host(false);
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
  closeRoom();
  S.myName = name;
  setBusy(true);
  link.join(code);
}
$('join-btn').addEventListener('click', join);

// Quick Play: a public room that's waiting for players, or a new public one
$('quick-btn').addEventListener('click', async () => {
  const name = readName();
  if (!name) return;
  homeError('');
  closeRoom();
  S.myName = name;
  setBusy(true);
  try {
    const code = await quickPlay('fast-fingers');
    if (code) link.join(code);
    else { S.creating = true; link.host(true); }
  } catch (err) {
    setBusy(false);
    homeError(err.message);
  }
});
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
    : '<span class="who"><b>Playing as a guest</b><span>Your stats are kept in this browser. Sign in to keep them on any device.</span></span><button class="btn primary" id="sign-in" type="button">Sign in with Google</button>';
  $('sign-in')?.addEventListener('click', signIn);
  $('sign-out')?.addEventListener('click', () => cloud.signOutUser());
  $('sound-toggle').checked = PREFS.sound !== false;
  $('analytics-row').hidden = !cloud.analyticsConfigured();
  $('analytics-toggle').checked = PREFS.analytics !== false;
  $('my-stats').innerHTML = '<p class="muted">Loading your stats…</p>';
  try {
    const st = await cloud.getMyStats();
    if ((cloud.getUser()?.uid || null) !== (u?.uid || null)) return;
    $('my-stats').innerHTML = `
      <div class="stat-grid">
        <div><b>${st.bestWpm}</b><span>Best wpm</span></div>
        <div><b>${st.games}</b><span>Room races</span></div>
        <div><b>${st.wins}</b><span>Wins</span></div>
        <div><b>${st.solos}</b><span>Practice runs</span></div>
        <div><b>${st.chars}</b><span>Characters typed</span></div>
      </div>`;
  } catch (err) {
    $('my-stats').innerHTML = `<p class="muted">${esc(cloud.errorText(err))}</p>`;
  }
}
$('sound-toggle').addEventListener('change', (e) => { PREFS.sound = e.target.checked; savePrefs(); if (PREFS.sound) SOUND.go(); });
$('analytics-toggle').addEventListener('change', (e) => {
  PREFS.analytics = e.target.checked;
  savePrefs();
  cloud.setAnalyticsEnabled(e.target.checked);
});

// Test hook: with ?debug in the address, automated tests can inspect the state.
if (new URLSearchParams(location.search).has('debug')) window.__fastfingers = { S, H, E, R, link };

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
  paintRoomSettings();
  renderSoloCard();
  showScreen('home');
  cloud.onUser((u) => {
    renderAccount(u);
  });
  cloud.initAnalytics(PREFS.analytics !== false);
  cloud.restore();
})();
