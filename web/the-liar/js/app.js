import * as E from './engine.js';
import { CATEGORY_NAMES } from './words.js';
import { createSheet } from './sketch.js';
import * as cloud from './cloud.js';
import { createRoomLink, quickPlay } from '../../shared/net.js';
import { wirePublic, paintPublic, publicLine } from '../../shared/public.js';

/* =========================================================
   The Liar
   Everyone gets the same secret word except the liar, who only knows the category.
   Players take turns adding to one shared drawing, or (the Words game) saying one word
   about it (3 rounds, same order), then vote. In the Time game everyone stops a hidden
   clock at a secret time (the liar only knows a range), then the times are shown and
   everyone talks it over before the vote.
   The game runs on the server (server/src/games). It It picks the word and the liar,
   sends each player only their own card, relays the ink live and counts the votes.
   This page draws the view it sends and passes on what you do.
   ========================================================= */

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
const ROOM_PREFS = { play: 'draw', mode: 'stroke', seconds: 8, wordSeconds: 30, discussSeconds: 60, categories: [], ...store.get('room', {}) };
if (!E.FREE_SECONDS.includes(ROOM_PREFS.seconds)) ROOM_PREFS.seconds = 8;
if (!E.WORD_SECONDS.includes(ROOM_PREFS.wordSeconds)) ROOM_PREFS.wordSeconds = 30;
if (!E.DISCUSS_SECONDS.includes(ROOM_PREFS.discussSeconds)) ROOM_PREFS.discussSeconds = 60;
if (!['draw', 'words', 'time'].includes(ROOM_PREFS.play)) ROOM_PREFS.play = 'draw';
const wordsGame = (st) => st && st.play === 'words';
const timeGame = (st) => st && st.play === 'time';
const savePrefs = () => store.set('prefs', PREFS);
const saveRoomPrefs = () => store.set('room', ROOM_PREFS);


/* ---------- Screens, sheets, messages ---------- */
const SCREENS = ['home', 'lobby', 'game', 'replay', 'replay-missing'];
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
  myName: '', myId: null, isHost: false, code: '', view: null,
  reconnecting: false, secret: null, gameShown: -1, turnKey: '', phaseKey: '',
  penTimers: [], strokeDone: false, penOn: false, timeStart: null, myStop: null, creating: false,
};

/* =========================================================
   The room on the server
   ========================================================= */
const link = createRoomLink('the-liar', {
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

const active = (p) => p.connected && !p.away;

function toHost(msg) {
  link.send(msg);
}

function closeRoom() {
  link.close();
  stopPen();
  stopClock();
  Object.assign(S, { view: null, isHost: false, code: '', secret: null, reconnecting: false, gameShown: -1, turnKey: '', phaseKey: '', creating: false });
}

// The host's buttons. The server only acts on these from whoever is host right now.
function hostStartGame() {
  toHost({ t: 'begin', settings: { ...ROOM_PREFS, categories: [...ROOM_PREFS.categories] }, crew: $('crew-input') ? $('crew-input').value.replace(/\s+/g, ' ').trim() : undefined });
}

function hostBackToLobby() {
  toHost({ t: 'lobby' });
}

function hostSetCrew(rawName) {
  const name = String(rawName || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (name && name.toLowerCase().replace(/[^a-z0-9]/g, '').length < 3) return toast('Crew names need at least 3 letters or numbers');
  store.set('crew', name);
  toHost({ t: 'crew', name });
}

function sendSettings() {
  if (S.isHost && S.view && S.view.status === 'lobby') toHost({ t: 'settings', settings: { ...ROOM_PREFS, categories: [...ROOM_PREFS.categories] } });
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
    case 'nope':
      S.clueSent = false;
      S.clueError = String(msg.reason || '').slice(0, 80);
      updateClueHint();
      $('clue-send').disabled = false;
      $('clue-input').focus();
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
const nameOf = (v, id) => (v.players.find((p) => p.id === id) || { name: 'Someone' }).name;
const colorOf = (v, id) => (v.players.find((p) => p.id === id) || { color: 0 }).color;

function applyState(v) {
  S.view = v;
  const mine = me(v);
  if (!mine) return;
  S.isHost = Boolean(mine.isHost);
  S.code = v.code;
  if (S.creating && S.isHost) {
    // A room we just opened: bring this browser's saved settings and crew
    S.creating = false;
    sendSettings();
    const savedCrew = store.get('crew', '');
    if (savedCrew) hostSetCrew(savedCrew);
  }
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
    S.timeStart = null;
    S.myStop = null;
    // Keep a drawing that just arrived for this game (joining mid-game); otherwise clean paper
    if (S.drawingGame !== v.game) sheet.clear();
    S.drawingGame = v.game;
    highlight(null);
    $('replay-btn').disabled = false;
  }
  // Missing strokes (joined late or a hiccup): ask the host for the full drawing
  if (sheet.count < v.strokeCount && !sheet.drawing && S.syncAsked !== `${v.game}:${v.strokeCount}`) {
    S.syncAsked = `${v.game}:${v.strokeCount}`;
    toHost({ t: 'sync' });
  }
  renderGame(v);
}

/* =========================================================
   The game screen
   ========================================================= */
const sheet = createSheet($('sheet-host'));
// Pointing at a player lights up only their lines (or their words)
let litId = null;
function highlight(id) {
  litId = id;
  sheet.highlight(id);
  [$('clue-board'), $('time-results')].forEach((board) => board.querySelectorAll('[data-pid]')
    .forEach((el) => el.classList.toggle('dim', Boolean(id) && el.dataset.pid !== id)));
}
let clockTimer = 0;

function stopPen() {
  S.penTimers.forEach(clearTimeout);
  S.penTimers = [];
  S.penOn = false;
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

const PHASE_LABEL = { role: 'Your card', draw: '', time: 'Stop the clock', discuss: 'Talk it over', vote: 'Vote', guess: 'Last chance', result: 'Result' };

function renderGame(v) {
  const mine = me(v);
  const spectator = !mine.inGame;
  $('bar-code').textContent = v.code;
  $('bar-phase').textContent = v.status === 'draw' ? `Round ${v.round + 1} of ${E.ROUNDS}` : PHASE_LABEL[v.status];
  $('category').textContent = v.category;
  $('spectator-note').hidden = !spectator;
  const words = wordsGame(v.settings);
  const timed = timeGame(v.settings);
  // Progress: three rounds and the vote (Time: the clock, the talk and the vote)
  const steps = timed ? 3 : 4;
  const stage = v.status === 'role' ? -1 : v.status === 'draw' ? v.round : v.status === 'time' ? 0 : v.status === 'discuss' ? 1 : steps - 1;
  $('progress').innerHTML = Array.from({ length: steps }, (_, i) => `<i class="${i < stage ? 'done' : i === stage ? 'now' : ''}${i === steps - 1 ? ' vote' : ''}"></i>`).join('');

  // The clock follows whatever deadline the phase has
  const phaseKey = `${v.game}:${v.status}:${v.round}:${v.turn}:${v.strokeLive}`;
  if (S.phaseKey !== phaseKey) {
    S.phaseKey = phaseKey;
    // No clock while people count in their heads: it would give the rhythm away
    if (v.endsIn > 0 && v.status !== 'time') {
      const total = v.status === 'draw'
        ? wordsGame(v.settings) ? v.settings.wordSeconds * 1000 : (v.settings.mode === 'stroke' ? (v.strokeLive ? E.STROKE.maxMs : E.STROKE.startMs) : v.settings.seconds * 1000)
        : { role: E.TIMES.roleMs, vote: E.TIMES.voteMs, guess: E.TIMES.guessMs, discuss: v.settings.discussSeconds * 1000 }[v.status];
      runClock(performance.now() + v.endsIn, total);
    } else {
      stopClock();
    }
  }

  $('role-overlay').hidden = v.status !== 'role';
  $('draw-panel').hidden = !['draw', 'time', 'discuss'].includes(v.status);
  $('vote-panel').hidden = v.status !== 'vote';
  $('guess-panel').hidden = v.status !== 'guess';
  $('result-panel').hidden = v.status !== 'result';
  $('my-card').hidden = spectator || v.status === 'result' || v.status === 'role';
  $('sheet-host').classList.toggle('voting', v.status === 'vote');
  $('sheet-host').hidden = words || timed;
  $('clue-board').hidden = !words;
  $('time-board').hidden = !timed;
  $('result-tools').hidden = words || timed;
  $('vote-tip').textContent = timed ? 'Point at a name to see only their time.' : words ? 'Point at a name to see only their words.' : 'Point at a name to see only their lines.';
  if (words) renderClues(v);
  if (timed) renderTime(v);
  if (!(words && v.status === 'draw' && v.drawer === S.myId)) $('clue-form').hidden = true;

  if (v.status === 'role') renderRole(v);
  if (v.status === 'draw') renderDraw(v);
  else if (v.status === 'time' || v.status === 'discuss') { stopPen(); $('handoff').hidden = true; renderTimePanel(v); }
  else { stopPen(); $('handoff').hidden = true; $('sheet-host').classList.remove('my-turn'); $('clue-board').classList.remove('my-turn'); }
  if (v.status === 'vote') renderVote(v);
  if (v.status === 'guess') renderGuess(v);
  if (v.status === 'result') renderResult(v);
  if (v.status !== 'vote' && v.status !== 'result') highlight(null);
  renderScores(v);
  renderCard();
}

/* ---------- Your secret card (hold to peek) ---------- */
function cardHTML(secret) {
  if (!secret) return '';
  if (secret.spectator) return '<span class="card-k">Watching</span><b>You’ll play next game</b>';
  if (secret.range) return `<span class="card-k">You are</span><b class="liar-word">the liar</b><span class="card-cat">The time is between ${secret.range[0]} and ${secret.range[1]} s</span>`;
  if (typeof secret.time === 'number') return `<span class="card-k">Your time</span><b>${esc(E.fmtSecs(secret.time))}</b><span class="card-cat">Stop the clock exactly then</span>`;
  if (secret.liar) return `<span class="card-k">You are</span><b class="liar-word">the liar</b><span class="card-cat">Category: ${esc(secret.category)}</span>`;
  return `<span class="card-k">Your word</span><b>${esc(secret.word)}</b><span class="card-cat">Category: ${esc(secret.category)}</span>`;
}

function renderCard() {
  const html = cardHTML(S.secret);
  $('card-secret').innerHTML = html;
  $('role-secret').innerHTML = html;
  $('time-secret').innerHTML = html;
  const liarTip = S.secret && S.secret.liar;
  const words = S.view && wordsGame(S.view.settings);
  if (S.view && timeGame(S.view.settings)) {
    $('role-tip').textContent = liarTip
      ? 'Nobody knows but you. You only know the range: stop somewhere believable and blend in when the times go up.'
      : 'One player only knows a rough range. Count carefully: a stop far from the others looks like the liar.';
    return;
  }
  $('role-tip').textContent = liarTip
    ? (words ? 'Nobody knows but you. Listen to the others’ words and blend in. Don’t get caught.' : 'Nobody knows but you. Watch what the others draw and blend in. Don’t get caught.')
    : (words ? 'One player doesn’t know this word. Give a word that shows you know it, but not so obvious the liar can work it out.' : 'One player doesn’t know this word. Draw enough to show you know it, but not so much the liar can copy you.');
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
holdToPeek($('time-peek'));

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
  const words = wordsGame(v.settings);
  const turnKey = `${v.game}:${v.round}:${v.turn}`;

  if (S.turnKey !== turnKey) {
    S.turnKey = turnKey;
    S.strokeDone = false;
    stopPen();
    Object.assign(S, { clueSent: false, clueError: '', clueOpen: false });
    $('clue-form').hidden = true;
    // Hand-off banner: whose turn it is
    const startsIn = Math.max(0, v.turnStartsIn);
    $('handoff').hidden = false;
    $('handoff').className = `handoff pc${drawer ? drawer.color : 0}`;
    $('handoff-name').textContent = myTurn ? 'Your turn' : `${drawer ? drawer.name : 'Someone'}’s turn`;
    $('handoff-sub').textContent = words ? 'Say one word' : single ? 'One line' : `${v.settings.seconds} seconds`;
    S.penTimers.push(setTimeout(() => { $('handoff').hidden = true; }, Math.max(600, startsIn)));
    if (myTurn && words) {
      chime();
      S.penTimers.push(setTimeout(() => {
        S.clueOpen = true;
        $('clue-input').value = '';
        $('clue-send').disabled = false;
        $('clue-form').hidden = false;
        updateClueHint();
        $('clue-input').focus();
        renderTurnStatus(S.view);
      }, startsIn));
      S.penTimers.push(setTimeout(() => { S.clueOpen = false; $('clue-form').hidden = true; renderTurnStatus(S.view); }, Math.max(0, v.endsIn)));
    } else if (myTurn) {
      chime();
      S.penTimers.push(setTimeout(() => {
        sheet.enable({
          pid: S.myId, color: mine.color, single,
          onInk: (sid, pts, end) => toHost({ t: 'ink', sid, pts, end }),
          onStroke: () => { if (single) { S.strokeDone = true; renderTurnStatus(S.view); } },
        });
        S.penOn = true;
        renderTurnStatus(S.view);
      }, startsIn));
      if (!single) {
        // Free draw: the pen lifts when time is up (the host also stops accepting ink)
        S.penTimers.push(setTimeout(() => { sheet.disable(); S.penOn = false; renderTurnStatus(S.view); }, Math.max(0, v.endsIn)));
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
  const words = wordsGame(v.settings);
  let title, sub;
  if (words) {
    title = myTurn ? 'Your turn' : `${drawer ? drawer.name : 'Someone'} is thinking`;
    sub = myTurn ? (S.clueSent ? 'Sent. Over to the next player' : S.clueOpen ? 'Type a word about the secret word' : 'Get ready…') : 'Their word appears on the board';
  } else if (myTurn) {
    title = 'Your turn';
    if (single) sub = S.strokeDone ? 'Done. Nice line.' : v.strokeLive ? 'Keep going, lift to finish' : 'Draw one line on the paper';
    else sub = S.penOn ? 'Draw, then press Done (or let the clock run out)' : 'Done. Over to the next player';
  } else {
    title = `${drawer ? drawer.name : 'Someone'} is drawing`;
    sub = single ? (v.strokeLive ? 'Drawing their line…' : 'Thinking about their line…') : 'Watch closely';
  }
  $('turn-title').textContent = title;
  $('turn-sub').textContent = sub;
  // Free draw: finish early instead of waiting for the clock
  $('turn-done').hidden = !(myTurn && !single && S.penOn);
  $('sheet-host').classList.toggle('my-turn', myTurn && !words);
  $('clue-board').classList.toggle('my-turn', myTurn && words);
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
    const tag = !p.connected ? 'Offline' : p.away ? 'Away' : now ? (wordsGame(v.settings) ? 'Thinking' : 'Drawing') : next ? 'Next' : '';
    return `<li class="pc${p.color}${now ? ' now' : ''}${active(p) ? '' : ' off'}">
      <span class="pen-dot"></span><span class="nm">${esc(p.name)}${id === S.myId ? ' (you)' : ''}</span>
      <span class="tag">${tag}</span><span class="rounds">${dots}</span></li>`;
  }).join('');
}

/* ---------- Words game: the board and your word ---------- */
// Built once per game (and when the order changes); after that only the cells that change are
// touched, so a new word animates in without replaying the others.
function renderClues(v) {
  const board = $('clue-board');
  const order = v.order.length ? v.order : v.players.filter((p) => p.inGame).map((p) => p.id);
  const players = order.map((id) => v.players.find((x) => x.id === id)).filter(Boolean);
  const key = `${v.game}|${players.map((p) => `${p.id}:${p.color}:${p.name}`).join(',')}|${S.myId}`;
  if (board.dataset.key !== key) {
    board.dataset.key = key;
    const cells = ['<span></span>', ...[1, 2, 3].map((r) => `<span class="rh">Round ${r}</span>`)];
    players.forEach((p, i) => {
      cells.push(`<span class="who pc${p.color}" data-pid="${esc(p.id)}"><i class="pen-dot"></i><span>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}</span></span>`);
      for (let r = 0; r < E.ROUNDS; r++) cells.push(`<span class="cell pc${p.color}" data-pid="${esc(p.id)}" data-cell="${r}-${i}"></span>`);
    });
    board.innerHTML = `<div class="clue-grid">${cells.join('')}</div>`;
  }
  players.forEach((p, i) => {
    for (let r = 0; r < E.ROUNDS; r++) {
      const el = board.querySelector(`[data-cell="${r}-${i}"]`);
      if (!el) continue;
      const c = (v.clues || []).find((x) => x.round === r && x.turn === i);
      const now = v.status === 'draw' && v.round === r && v.turn === i;
      const kind = c ? (c.passed ? 'passed' : 'said') : now ? 'now' : '';
      const text = c ? (c.passed ? 'passed' : c.text) : now ? (p.id === S.myId ? 'your turn' : 'thinking…') : '';
      if (el.dataset.kind === kind && el.textContent === text) continue;
      el.dataset.kind = kind;
      el.className = `cell pc${p.color}${kind ? ` ${kind}` : ''}`;
      el.textContent = text;
    }
  });
  highlight(litId);
}

function myClueCheck(text) {
  const v = S.view;
  const secret = S.secret || {};
  return E.clueProblem(text, { word: secret.liar ? '' : secret.word || '', said: (v ? v.clues || [] : []).filter((c) => !c.passed).map((c) => c.text) });
}

function updateClueHint() {
  const el = $('clue-hint');
  const raw = $('clue-input').value;
  let text = '', cls = '';
  if (S.clueError) { text = S.clueError; cls = 'bad'; }
  else if (raw.trim()) {
    const p = myClueCheck(raw);
    if (p) { text = p; cls = 'bad'; } else { text = 'Press Enter to say it'; cls = 'good'; }
  } else text = 'One or two words. Not the word itself.';
  el.textContent = text;
  el.className = `clue-hint ${cls}`;
}

$('clue-input').addEventListener('input', () => { S.clueError = ''; updateClueHint(); });
$('clue-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = S.view;
  if (!v || v.status !== 'draw' || v.drawer !== S.myId || S.clueSent || !S.clueOpen) return;
  const raw = $('clue-input').value;
  const problem = myClueCheck(raw);
  if (problem) { S.clueError = problem; updateClueHint(); return; }
  S.clueSent = true;
  $('clue-send').disabled = true;
  toHost({ t: 'clue', text: E.cleanClue(raw) });
  renderTurnStatus(v);
});

$('turn-done').addEventListener('click', () => {
  const v = S.view;
  if (!v || v.status !== 'draw' || v.drawer !== S.myId || !S.penOn) return;
  S.penTimers.forEach(clearTimeout);
  S.penTimers = [];
  sheet.disable();   // sends the last points of a stroke still in progress first
  S.penOn = false;
  toHost({ t: 'done' });
  renderTurnStatus(v);
});

$('vote-now').addEventListener('click', () => {
  const v = S.view;
  if (!v || (v.status !== 'draw' && v.status !== 'discuss')) return;
  toHost({ t: 'votenow', on: !me(v).voteNow });
});

/* ---------- Time game: the hidden clock and the times ---------- */
function renderTime(v) {
  const mine = me(v);
  const playing = v.status === 'time';
  $('time-play').hidden = !playing;
  $('time-results').hidden = playing;
  $('time-board').classList.toggle('results', !playing);
  if (playing) {
    const stopped = mine.stopped || S.myStop !== null;
    const players = v.players.filter((p) => p.inGame);
    const done = players.filter((p) => p.stopped).length;
    const btn = $('time-btn');
    btn.className = `time-btn pc${mine.color}${S.timeStart !== null && !stopped ? ' running' : ''}`;
    btn.hidden = !mine.inGame;
    $('time-peek').hidden = !mine.inGame;
    btn.disabled = stopped;
    btn.textContent = stopped ? 'Stopped' : S.timeStart !== null ? 'Stop' : 'Start';
    $('time-k').textContent = mine.inGame ? 'Stop the clock at the time on your card' : 'The others are stopping their clocks';
    $('time-status').textContent = !mine.inGame ? `${done} of ${players.length} done`
      : stopped ? `${S.myStop !== null ? `You stopped at ${E.fmtSecs(S.myStop)}. ` : 'Stopped. '}Waiting for ${plural(players.length - done, 'player')}…`
        : S.timeStart !== null ? 'Counting… press Stop when you think it’s time' : 'Press Start, then count in your head. No clock is shown.';
    renderTimeRoster(v, !mine.inGame || stopped);
    return;
  }
  renderTimeResults(v);
}

// Who's counting and who's done. Until you've stopped yourself you only see who has started,
// never who has stopped, so nobody (the liar especially) can stop when the others do.
function renderTimeRoster(v, seeDone) {
  const players = v.players.filter((p) => p.inGame);
  const rows = players.map((p) => {
    const state = !active(p) ? ['off', 'Away'] : p.stopped && (seeDone || p.id === S.myId) ? ['done', 'Done ✓']
      : p.started || (p.id === S.myId && S.timeStart !== null) ? ['going', 'Counting…'] : ['wait', 'Not started'];
    return `<li class="pc${p.color} ${state[0]}"><i class="pen-dot"></i><span class="nm">${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}</span><span class="st">${state[1]}</span></li>`;
  }).join('');
  $('time-roster').innerHTML = rows;
  $('time-roster-note').textContent = seeDone ? '' : 'You’ll see who’s done once you stop.';
}

const VERDICTS = [[0.2, 'Spot on'], [0.5, 'Close'], [1.5, 'A bit off'], [Infinity, 'Way off']];
const verdict = (miss) => VERDICTS.find(([d]) => miss <= d)[1];

// Everyone's stop as a pin on one timeline (a ruler of seconds). At the result the target and
// the liar's range go on the same ruler, and a list ranks everyone by how close they got.
function renderTimeResults(v) {
  const players = v.players.filter((p) => p.inGame);
  const stops = v.stops || {};
  const t = v.time;
  const has = (p) => typeof stops[p.id] === 'number';
  const pinned = players.filter(has).sort((a, b) => stops[a.id] - stops[b.id]);
  const missing = players.filter((p) => !has(p));
  const top = Math.max(2, ...pinned.map((p) => stops[p.id]), ...(t ? [t.target, t.hi] : []));
  const step = top > 14 ? 2 : 1;
  const max = Math.ceil((top * 1.05) / step) * step;
  const x = (n) => Math.max(0, Math.min(100, (n / max) * 100));
  // Stack pins into lanes so labels never overlap: a lane is free once its last pin is far enough left
  const width = $('time-board').clientWidth || 600;
  const gap = Math.min(48, (100 * 96) / width);
  const lanes = [];
  const lane = new Map();
  for (const p of pinned) {
    const px = x(stops[p.id]);
    let i = lanes.findIndex((last) => px - last >= gap);
    if (i < 0) { i = lanes.length; lanes.push(px); } else lanes[i] = px;
    lane.set(p.id, i);
  }
  const LANE = 46;
  const n = Math.max(1, lanes.length);
  const pins = pinned.map((p) => {
    const px = x(stops[p.id]);
    const top = (n - 1 - lane.get(p.id)) * LANE;
    const liar = t && p.id === v.liar;
    return `<div class="tl-pin pc${p.color}${liar ? ' liar' : ''}" data-pid="${esc(p.id)}">
        <i class="tl-stem" style="left:${px}%;top:${top + 38}px"></i>
        <span class="tl-chip" style="left:${px}%;top:${top}px;transform:translateX(-${px}%)"><b>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}${liar ? ' <em>liar</em>' : ''}</b><span>${esc(E.fmtSecs(stops[p.id]))}</span></span>
        <i class="tl-dot" style="left:${px}%"></i></div>`;
  }).join('');
  const ticks = [];
  const every = max / step > 12 ? 2 : 1;
  for (let i = 0; i * step <= max; i++) ticks.push(`<i class="tl-tick${i % every ? ' minor' : ''}" style="left:${x(i * step)}%">${i % every ? '' : `<span>${i * step}</span>`}</i>`);
  const marks = t ? `<i class="tl-range" style="left:${x(t.lo)}%;width:${x(t.hi) - x(t.lo)}%"><span>Liar’s range ${t.lo}–${t.hi} s</span></i>
      <i class="tl-target" style="left:${x(t.target)}%"><span style="transform:translateX(-${x(t.target)}%)">Target ${esc(E.fmtSecs(t.target))}</span></i>` : '';
  const timeline = `<div class="tl${t ? ' with-target' : ''}">
      <div class="tl-lanes" style="height:${n * LANE}px">${marks}${pins}</div>
      <div class="tl-axis">${ticks.join('')}<span class="tl-unit">seconds</span></div></div>`;
  const noStop = missing.length ? `<p class="tl-missing">No stop: ${missing.map((p) => `<span class="pc${p.color}">${esc(p.name)}</span>`).join(', ')}</p>` : '';
  let list = '';
  if (t) {
    // Closest first; nobody who missed the stop is ranked
    const ranked = pinned.map((p) => ({ p, d: stops[p.id] - t.target })).sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
    list = `<ol class="tl-rank">${ranked.map(({ p, d }, i) => {
      const liar = p.id === v.liar;
      const miss = Math.abs(d);
      return `<li class="pc${p.color}${liar ? ' liar' : ''}" data-pid="${esc(p.id)}">
        <span class="rk">${i + 1}</span><i class="pen-dot"></i>
        <span class="nm">${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}${liar ? ` <em>liar · knew ${t.lo}–${t.hi} s</em>` : ''}</span>
        <span class="tm">${esc(E.fmtSecs(stops[p.id]))}</span>
        <span class="off">${miss < 0.005 ? 'exact!' : `${miss.toFixed(2)} s ${d > 0 ? 'late' : 'early'}`}</span>
        <span class="vd v${VERDICTS.findIndex(([m]) => miss <= m)}">${verdict(miss)}</span></li>`;
    }).join('')}</ol>`;
  }
  $('time-results').innerHTML = `<p class="time-k">${t ? `The time was ${esc(E.fmtSecs(t.target))}` : 'Everyone’s stop. Who doesn’t fit?'}</p>
    ${timeline}${noStop}${list}`;
  highlight(litId);
}

function renderTimePanel(v) {
  const mine = me(v);
  const talking = v.status === 'discuss';
  const box = $('turn-status');
  box.className = `turn-status pc${mine.color}`;
  $('turn-title').textContent = talking ? 'Talk it over' : mine.inGame ? 'Stop your clock' : 'Everyone is timing';
  $('turn-sub').textContent = talking ? 'Who stopped like they didn’t know the time? Then vote.'
    : 'The times go up when everyone has stopped';
  $('turn-done').hidden = true;
  $('order-list').innerHTML = '';
  const vn = $('vote-now');
  vn.hidden = !talking || !mine.inGame;
  vn.setAttribute('aria-pressed', String(Boolean(mine.voteNow)));
  vn.querySelector('b').textContent = mine.voteNow ? 'Waiting for the others' : 'Ready to vote';
  $('vote-now-count').textContent = `${v.voteNowHave} of ${v.voteNowNeed} needed`;
}

// Times come from the moment the browser registered the press (event.timeStamp),
// so a busy page can't add delay to anyone's stop.
function timePress(ts) {
  const v = S.view;
  if (!v || v.status !== 'time' || !me(v).inGame || me(v).stopped || S.myStop !== null) return;
  if (S.timeStart === null) {
    S.timeStart = ts;
  } else {
    if (ts - S.timeStart < 120) return;   // ignore an accidental double tap
    S.myStop = Math.round((ts - S.timeStart) / 10) / 100;
    toHost({ t: 'stop', secs: S.myStop });
  }
  if (S.timeStart === ts) toHost({ t: 'start' });
  // The host handles its own message straight away and may already have moved on to the
  // discussion, so redraw from the latest view, never the one this press started with
  renderTime(S.view);
}
$('time-btn').addEventListener('pointerdown', (e) => { e.preventDefault(); timePress(e.timeStamp); });
$('time-btn').addEventListener('keydown', (e) => {
  if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat) return;
  e.preventDefault();
  timePress(e.timeStamp);
});
['pointerover', 'focusin'].forEach((ev) => $('time-results').addEventListener(ev, (e) => {
  const li = e.target.closest('[data-pid]');
  if (li && S.view && ['vote', 'result'].includes(S.view.status)) highlight(li.dataset.pid);
}));
$('time-results').addEventListener('pointerleave', () => highlight(null));
// Label lanes depend on the board's width: redraw when it changes (phone turned, window resized)
let timeResize = 0;
window.addEventListener('resize', () => {
  clearTimeout(timeResize);
  timeResize = setTimeout(() => { if (S.view && timeGame(S.view.settings) && !$('time-results').hidden) renderTimeResults(S.view); }, 150);
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
  if (b) highlight(b.dataset.id);
}));
['pointerleave', 'focusout'].forEach((ev) => $('vote-list').addEventListener(ev, () => highlight(null)));

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
  const timed = timeGame(v.settings);
  const head = {
    caught: ['Caught!', timed ? `${liarName} was the liar.` : `${liarName} was the liar and couldn’t name the word.`],
    stolen: ['Stolen!', `${liarName} was caught but named the word.`],
    escaped: ['The liar got away', v.accused ? `You voted out ${nameOf(v, v.accused)}. ${liarName} was the liar.` : `The vote was split. ${liarName} was the liar.`],
  }[v.result];
  const won = isLiar ? v.result !== 'caught' : v.result === 'caught';
  $('result-head').className = `result-head ${mine.inGame ? (won ? 'won' : 'lost') : ''}`;
  $('result-title').textContent = head[0];
  $('result-sub').textContent = head[1];
  $('result-word-label').textContent = timed ? 'The time' : 'The word';
  $('result-word').textContent = timed ? (v.time ? E.fmtSecs(v.time.target) : '') : cap(v.word);
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
  // The server keeps a replay of Draw and Words games a moment after they end
  $('share-btn').hidden = !v.replayId;
  S.replayId = v.replayId || null;
}

$('share-btn').addEventListener('click', async () => {
  if (!S.replayId) return;
  const url = `${location.origin}${location.pathname}?replay=${S.replayId}`;
  try { await navigator.clipboard.writeText(url); toast('Replay link copied'); } catch { toast(url); }
});

$('replay-btn').addEventListener('click', async () => {
  $('replay-btn').disabled = true;
  highlight(null);
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
  if (p) highlight(p.id);
});
$('result-votes').addEventListener('pointerleave', () => highlight(null));
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

const paintPlay = segment($('set-play'), () => ROOM_PREFS.play, (v) => { ROOM_PREFS.play = v; roomSettingsChanged(); });
const paintMode = segment($('set-mode'), () => ROOM_PREFS.mode, (v) => { ROOM_PREFS.mode = v; roomSettingsChanged(); });
$('set-word-seconds').addEventListener('change', (e) => { ROOM_PREFS.wordSeconds = Number(e.target.value); roomSettingsChanged(); });
$('set-seconds').addEventListener('change', (e) => { ROOM_PREFS.seconds = Number(e.target.value); roomSettingsChanged(); });
$('set-discuss').addEventListener('change', (e) => { ROOM_PREFS.discussSeconds = Number(e.target.value); roomSettingsChanged(); });
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
  sendSettings();
}

function paintRoomSettings() {
  paintPlay();
  paintMode();
  paintAllCats();
  const words = ROOM_PREFS.play === 'words';
  const timed = ROOM_PREFS.play === 'time';
  $('mode-setting').hidden = words || timed;
  $('word-seconds-field').hidden = !words;
  $('set-word-seconds').value = String(ROOM_PREFS.wordSeconds);
  $('discuss-field').hidden = !timed;
  $('set-discuss').value = String(ROOM_PREFS.discussSeconds);
  $('cats-setting').hidden = timed;
  $('seconds-field').hidden = words || timed || ROOM_PREFS.mode !== 'free';
  $('set-seconds').value = String(ROOM_PREFS.seconds);
  const picking = ROOM_PREFS.categories.length > 0;
  $('cat-picks').hidden = !picking;
  const on = new Set(ROOM_PREFS.categories);
  $('cat-picks').querySelectorAll('.cat').forEach((b) => b.setAttribute('aria-pressed', String(on.has(b.dataset.cat))));
}

function settingsLines(st) {
  if (timeGame(st)) {
    return [
      '<li><b>Time: stop a hidden clock at your secret time</b></li>',
      `<li>${st.discussSeconds} seconds to talk, then the vote</li>`,
    ].join('');
  }
  const cats = st.categories.length ? `${plural(st.categories.length, 'category')}: ${st.categories.join(', ')}` : 'All categories';
  return [
    `<li><b>${wordsGame(st) ? `Words: say a word each turn, ${st.wordSeconds} seconds` : st.mode === 'stroke' ? 'Draw: one line per turn' : `Draw: free draw, ${st.seconds} seconds a turn`}</b></li>`,
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
    paintPublic(v);
    const ready = v.players.filter((p) => p.connected).length;
    $('start-btn').disabled = ready < E.MIN_PLAYERS;
    $('start-note').textContent = ready < E.MIN_PLAYERS ? `Needs ${E.MIN_PLAYERS} players to start (${E.MIN_PLAYERS - ready} more).` : '';
  } else {
    $('settings-summary').innerHTML = settingsLines(v.settings) + (v.crewName ? `<li>Crew: <b>${esc(v.crewName)}</b></li>` : '') + `<li>${publicLine(v)}</li>`;
  }
}

$('copy-link').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${S.code}`;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); } catch { toast(url); }
});
$('crew-save').addEventListener('click', () => hostSetCrew($('crew-input').value));
wirePublic(toHost);
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
  $('quick-btn').disabled = busy;
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
  S.myName = name;
  setBusy(true);
  try {
    const code = await quickPlay('the-liar');
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
if (new URLSearchParams(location.search).has('debug')) window.__theliar = { S, sheet, link };

/* =========================================================
   A shared replay (?replay=<id>): read-only, no room, works for guests.
   The server saved it at the end of the game: the drawing line by line (Draw) or the
   words board (Words), who was who, the votes and the outcome.
   ========================================================= */
const R = { sheet: null, data: null, run: 0 };
if (new URLSearchParams(location.search).has('debug')) window.__theliar.R = R;
const REDUCED_MOTION = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

function missingReplay(text) {
  if (text) $('rm-text').textContent = text;
  showScreen('replay-missing');
}

async function loadReplay(id) {
  showScreen('replay');
  $('rp-title').textContent = 'Loading replay…';
  let res;
  try {
    res = await fetch(`/api/the-liar/replay/${encodeURIComponent(id)}`);
  } catch {
    return missingReplay('Couldn’t load this replay. Check your connection and try the link again.');
  }
  if (res.status === 404) return missingReplay();
  if (!res.ok) return missingReplay('Couldn’t load this replay right now. Try again in a minute.');
  const { replay, createdAt } = await res.json();
  if (!replay || !Array.isArray(replay.players)) return missingReplay();
  R.data = replay;
  renderReplay(replay, createdAt);
}

function renderReplay(r, createdAt) {
  const players = r.players;
  const words = r.mode === 'words';
  const liar = players[r.liar];
  const liarName = liar ? liar.name : 'Someone';
  const accused = r.accused === null || r.accused === undefined ? null : players[r.accused];
  $('rp-when').textContent = new Date(createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  $('rp-category').textContent = r.category;
  const head = {
    caught: ['Caught!', `${liarName} was the liar and couldn’t name the word.`],
    stolen: ['Stolen!', `${liarName} was caught but named the word.`],
    escaped: ['The liar got away', accused ? `The group voted out ${accused.name}. ${liarName} was the liar.` : `The vote was split. ${liarName} was the liar.`],
  }[r.result] || ['Replay', ''];
  $('rp-head').className = 'result-head';
  $('rp-title').textContent = head[0];
  $('rp-sub').textContent = head[1];
  $('rp-word').textContent = cap(String(r.word));
  $('rp-liar').innerHTML = `<span class="pen-dot pc${liar ? liar.color : 0}"></span>${esc(liarName)}`;
  $('rp-votes').innerHTML = players.map((p, i) => {
    const target = p.vote === null || p.vote === undefined ? null : players[p.vote];
    const right = target && p.vote === r.liar;
    return `<li class="pc${p.color}${i === r.liar ? ' is-liar' : ''}" data-i="${i}">
      <span class="pen-dot"></span><span class="nm">${esc(p.name)}</span>
      <span class="voted">${target ? `voted ${esc(target.name)}${right ? ' ✓' : ''}` : 'no vote'}</span>
      <span class="gain ${p.points ? 'plus' : ''}">${p.points ? `+${p.points}` : '0'}</span></li>`;
  }).join('');
  $('rp-tip').textContent = words ? 'Point at a name to see only their words.' : 'Point at a name to see only their lines.';
  $('rp-sheet').hidden = words;
  $('rp-clues').hidden = !words;
  if (words) {
    const cells = ['<span></span>', ...Array.from({ length: r.rounds }, (_, i) => `<span class="rh">Round ${i + 1}</span>`)];
    players.forEach((p, i) => {
      cells.push(`<span class="who pc${p.color}" data-pid="${i}"><i class="pen-dot"></i><span>${esc(p.name)}</span></span>`);
      for (let round = 0; round < r.rounds; round++) {
        const c = r.clues.find((x) => x.p === i && x.round === round);
        const kind = c ? (c.passed ? 'passed' : 'said') : '';
        cells.push(`<span class="cell pc${p.color} ${kind}" data-pid="${i}" data-order="${round * players.length + i}">${c ? (c.passed ? 'passed' : esc(c.text)) : ''}</span>`);
      }
    });
    $('rp-clues').innerHTML = `<div class="clue-grid">${cells.join('')}</div>`;
  } else {
    R.sheet ||= createSheet($('rp-sheet'));
    R.sheet.load(r.strokes.map((s, n) => ({ sid: `r${n}`, pid: String(s.p), color: players[s.p] ? players[s.p].color : 0, pts: s.pts })));
  }
  watchAgain(!REDUCED_MOTION);
}

// Draw: the lines are drawn again in order. Words: the words appear in turn order.
async function watchAgain(animate) {
  const run = ++R.run;
  $('rp-again').disabled = true;
  highlightReplay(null);
  if (R.data.mode === 'words') {
    const cells = [...$('rp-clues').querySelectorAll('.cell[data-order]')].sort((a, b) => a.dataset.order - b.dataset.order);
    if (animate) cells.forEach((c) => { c.style.visibility = 'hidden'; });
    for (const c of cells) {
      if (run !== R.run) return;
      if (animate && c.textContent) await new Promise((ok) => setTimeout(ok, 650));
      c.style.visibility = '';
    }
  } else if (animate) {
    await R.sheet.replay();
  }
  if (run === R.run) $('rp-again').disabled = false;
}
$('rp-again').addEventListener('click', () => watchAgain(true));

function highlightReplay(i) {
  if (R.sheet) R.sheet.highlight(i === null ? null : String(i));
  $('rp-clues').querySelectorAll('[data-pid]').forEach((el) => el.classList.toggle('dim', i !== null && el.dataset.pid !== String(i)));
  $('rp-votes').querySelectorAll('li').forEach((li) => li.classList.toggle('dim', i !== null && li.dataset.i !== String(i)));
}
$('rp-votes').addEventListener('pointerover', (e) => {
  const li = e.target.closest('li');
  if (li) highlightReplay(Number(li.dataset.i));
});
$('rp-votes').addEventListener('pointerleave', () => highlightReplay(null));

/* =========================================================
   Start
   ========================================================= */
(function init() {
  $('logo-row').innerHTML = [...'THE'].map((c) => `<span class="tile small">${c}</span>`).join('')
    + '<span class="gap"></span>'
    + [...'LIAR'].map((c) => `<span class="tile${c === 'I' ? ' odd' : ''}">${c}</span>`).join('');
  const saved = store.get('name', '');
  if (saved) $('name-input').value = saved;
  const replay = new URLSearchParams(location.search).get('replay');
  if (replay !== null) {
    if (/^[A-Za-z0-9]{12}$/.test(replay)) loadReplay(replay);
    else missingReplay();
    return;
  }
  const room = new URLSearchParams(location.search).get('room');
  if (room && /^[A-Za-z]{4}$/.test(room)) {
    $('code-input').value = room.toUpperCase();
    ($('name-input').value ? $('join-btn') : $('name-input')).focus();
  }
  showScreen('home');
  cloud.onUser((u) => {
    renderAccount(u);
  });
  cloud.initAnalytics(PREFS.analytics !== false);
  cloud.restore();
})();
