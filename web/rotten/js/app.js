import * as E from './engine.js';
import * as cloud from './cloud.js';
import { createRoomLink, quickPlay } from '../../shared/net.js';
import { wirePublic, paintPublic, publicLine } from '../../shared/public.js';
import { addBotButton, botControls, botTag, levelName, wireBots } from '../../shared/bots.js';
import { createBanana, stageOf } from './banana.js';
import { createKeyboard } from './keys.js';
import { meltingLogo } from './logo.js';

/* =========================================================
   Rotten
   Players sit round a table and pass a banana that's going off. The holder gets 2 or 3
   letters and must type a word containing them to pass it on. The banana splats at a
   random moment nobody can see: whoever holds it loses a life. Last one standing wins.
   The game runs on the server (server/src/games/rotten.ts): it holds the hidden timer, checks
   every word and sends everyone the public view. This page draws it and sends what you type.
   ========================================================= */

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
  myName: '', myId: null, isHost: false, code: '', view: null, creating: false, reconnecting: false,
  gameShown: -1, wordSeen: -1, splatSeen: -1, holderSeen: null, bananaSeat: -1,
  typing: '', typingFor: null, sentTyping: '', pending: '', viewAt: 0, refreshTimer: 0,
};

/* =========================================================
   The room on the server
   ========================================================= */
const link = createRoomLink('rotten', {
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
  clearTimeout(S.refreshTimer);
  Object.assign(S, { view: null, isHost: false, code: '', reconnecting: false, creating: false, gameShown: -1 });
  stopLoop();
}

// The host's buttons. The server only acts on these from whoever is host right now.
function hostStartGame() {
  toHost({ t: 'start', settings: { ...ROOM_PREFS }, crew: $('crew-input').value.replace(/\s+/g, ' ').trim() });
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
const nameOf = (v, id) => (pOf(v, id) || { name: 'Someone' }).name;

function applyState(v) {
  S.view = v;
  S.viewAt = performance.now();
  const mine = me(v);
  if (!mine) return;
  S.isHost = Boolean(mine.isHost);
  S.code = v.code;
  if (S.creating && S.isHost) {
    // A room we just opened: bring this browser's saved settings and crew
    S.creating = false;
    toHost({ t: 'settings', settings: { ...ROOM_PREFS } });
    const savedCrew = store.get('crew', '');
    if (savedCrew) hostSetCrew(savedCrew);
  }
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
  placeBanana();   // the letters may have changed size
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
    const holder = p.id === v.holder;
    const tag = !p.connected ? 'Offline' : p.away ? 'Away' : '';
    const turnTag = holder && v.status === 'play' && !tag ? (p.id === S.myId ? 'Your turn' : 'Turn') : '';
    const initial = esc([...p.name][0] || '?').toUpperCase();
    return `<div class="seat pc${p.color}${holder ? ' holder' : ''}${p.alive ? '' : ' out'}${active(p) ? '' : ' off'}${p.id === S.myId ? ' me' : ''}"
      data-a="${a.toFixed(4)}">
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
  S.bananaSeat = idx;
  if (idx >= 0) spot.hidden = false;
  else if (v.status !== 'over') spot.hidden = true;
  layoutTable();
  $('table').classList.toggle('my-turn', isMyTurn(v));
}

// Seats go round an ellipse sized from the table and each seat's measured size, so faces,
// names and hearts never get cut off at the table's edge.
function layoutTable() {
  const W = $('table').clientWidth, H = $('table').clientHeight;
  for (const seat of $('seats').children) {
    const a = parseFloat(seat.dataset.a);
    const rx = W / 2 - seat.offsetWidth / 2 - 6, ry = H / 2 - seat.offsetHeight / 2 - 6;
    seat.style.left = `${(W / 2 + rx * Math.cos(a)).toFixed(1)}px`;
    seat.style.top = `${(H / 2 + ry * Math.sin(a)).toFixed(1)}px`;
  }
  placeBanana();
}

// Where the banana goes. Big tables: between the centre letters and the holder's seat, as close
// to the seat as it gets without covering it or the letters (it shrinks if the gap is small).
// Phone-sized tables have no such gap, so a small banana sits on the holder's face instead and
// its Fresh/Ripe label moves under the turn label.
function placeBanana() {
  const spot = $('banana-spot');
  const seat = $('seats').children[S.bananaSeat];
  const age = $('banana-age');
  const W = $('table').clientWidth, H = $('table').clientHeight;
  const small = W < 520;
  spot.classList.toggle('badge', small);
  if (small && age.parentElement === spot) $('turn-label').after(age);
  if (!small && age.parentElement !== spot) spot.append(age);
  if (spot.hidden || !seat) return;
  const face = seat.querySelector('.face');
  const sx = parseFloat(seat.style.left), sy = parseFloat(seat.style.top);
  if (small) {
    // bottom-right corner of the face
    spot.style.left = `${(sx + face.offsetLeft + face.offsetWidth - seat.offsetWidth / 2 - 2).toFixed(1)}px`;
    spot.style.top = `${(sy + face.offsetTop + face.offsetHeight - seat.offsetHeight / 2 - 6).toFixed(1)}px`;
    spot.style.setProperty('--k', '1');
    return;
  }
  const table = $('table').getBoundingClientRect();
  const dx = sx - W / 2, dy = sy - H / 2;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  // How far a box reaches along the line from the table's centre towards the seat
  const reach = (w, h) => (w / 2) * Math.abs(ux) + (h / 2) * Math.abs(uy);
  const outer = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width) return 0;
    const cx = r.left + r.width / 2 - table.left - W / 2, cy = r.top + r.height / 2 - table.top - H / 2;
    return cx * ux + cy * uy + reach(r.width, r.height);
  };
  const lettersReach = Math.max(0, outer($('turn-label')), outer($('prompt')), $('timer').hidden ? 0 : outer($('timer')));
  const gap = 8;
  const seatReach = reach(seat.offsetWidth * 1.08, seat.offsetHeight * 1.08);
  const spotReach = reach(spot.offsetWidth, spot.offsetHeight);
  const room = len - seatReach - lettersReach - gap * 2;
  const k = Math.min(1, Math.max(0.5, room / (spotReach * 2)));
  const d = Math.max(0, len - seatReach - gap - spotReach * k);
  spot.style.left = `${(W / 2 + ux * d).toFixed(1)}px`;
  spot.style.top = `${(H / 2 + uy * d).toFixed(1)}px`;
  spot.style.setProperty('--k', k.toFixed(3));
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => layoutTable()).observe($('table'));

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
    : `<span class="pen-dot pc${holder.color}"></span><span class="tn">${esc(holder.name)}</span>’s turn`;
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
    link.sendLatest('type', { t: 'type', text: clean }, 150);
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
  if (!S.isHost || !S.view || S.view.status !== 'lobby') return;
  toHost({ t: 'settings', settings: { ...ROOM_PREFS } });
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
    <li class="pc${p.color}${active(p) ? '' : ' off'}"><span class="pen-dot"></span><span class="nm">${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}${botTag(p)}</span>
      ${p.bot ? (S.isHost ? botControls(p) : `<span class="tag">${levelName(p.botLevel)}</span>`)
      : `<span class="tag">${p.isHost ? 'Host' : !active(p) ? 'Reconnecting' : ''}</span>`}</li>`);
  const missing = Math.max(0, E.MIN_PLAYERS - v.players.length);
  for (let i = 0; i < Math.max(missing, v.players.length < E.MAX_PLAYERS ? 1 : 0); i++) rows.push('<li class="empty">Waiting for a friend to join…</li>');
  $('lobby-players').innerHTML = rows.join('');
  $('bot-add').hidden = !S.isHost || v.players.length >= E.MAX_PLAYERS;
  $('host-settings').hidden = !S.isHost;
  $('guest-settings').hidden = S.isHost;
  if (S.isHost) {
    paintRoomSettings();
    if (document.activeElement !== $('crew-input')) $('crew-input').value = v.crewName;
    $('crew-status').textContent = v.crewStatus;
    paintPublic(v);
    renderStartButton(v);
  } else {
    $('settings-summary').innerHTML = settingsLines(v.settings) + (v.crewName ? `<li>Crew: <b>${esc(v.crewName)}</b></li>` : '') + `<li>${publicLine(v)}</li>`;
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
wirePublic(toHost);
$('crew-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') hostSetCrew($('crew-input').value); });
$('start-btn').addEventListener('click', () => { if (S.isHost) hostStartGame(); });
wireBots($('lobby'), (m) => toHost(m), () => S.isHost);
$('leave-lobby').addEventListener('click', () => { closeRoom(); goHome(); });

/* =========================================================
   On your own: the daily puzzle and practice
   ========================================================= */
const soloBanana = createBanana($('solo-banana'));
const soloKeyboard = createKeyboard($('solo-kbd'), $('solo-answer'), { onEnter: soloSubmit, onType: soloInput });
const SOLO = {
  mode: null, prompts: [], idx: 0, times: [], promptStart: 0, startAt: 0, used: new Set(), lex: null,
  day: '', streak: 0, sentBest: 0, runAt: 0, best: store.get('practiceBest', 0), fuseEnd: 0, fuseMax: 1, pauseUntil: 0, raf: 0, bands: null,
  wordsPlayed: 0, done: false, lastTick: 0, token: 0, words: [],
};

const dailyState = (day) => {
  const s = store.get('daily', null);
  return s && s.day === day ? s : null;
};

// The daily changes at 00:00 UTC for everyone, so there is one global leaderboard
const utcDay = () => new Date().toISOString().slice(0, 10);

function renderDailyCard() {
  const day = utcDay();
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
// The server runs the daily: it shows one prompt at a time and times every answer itself,
// so results on the leaderboard are real. This page keeps the word hints instant.
const dailyApi = (action, body = {}) => cloud.api(`/api/rotten/daily/${action}`, { method: 'POST', body: { name: cleanName($('name-input').value) || store.get('name', '') || 'Player', ...body } });

function applyDaily(d) {
  SOLO.day = d.day;
  SOLO.number = d.number;
  SOLO.prompts = d.prompts || [];
  SOLO.times = d.times || [];
  SOLO.words = (d.words || []).map((w) => w || '');
  SOLO.idx = d.idx;
  SOLO.used = new Set(d.used || []);
  if (d.prompt) SOLO.promptStart = performance.now() - (d.elapsed || 0);
  store.set('daily', { day: d.day, times: SOLO.times, words: SOLO.words, done: Boolean(d.done) });
}

async function startDaily() {
  const token = SOLO.token;
  $('solo-prompt').innerHTML = '<span class="muted small">Loading today’s puzzle…</span>';
  soloEnable(false);
  let d;
  try {
    d = await dailyApi('state');
  } catch (err) {
    if (token !== SOLO.token) return;
    $('solo-prompt').innerHTML = `<span class="muted small">${esc(cloud.errorText(err))}</span>`;
    return;
  }
  if (token !== SOLO.token || $('solo').hidden) return;
  applyDaily(d);
  $('solo-title').textContent = `Daily #${d.number}`;
  $('daily-title').textContent = `Daily #${d.number}`;
  renderDailyList();
  if (d.done) { dailyDone(false); return; }
  if (d.prompt) { showDailyPrompt(); return; }   // came back mid-prompt: its clock kept running
  if (!d.idx) cloud.track('daily_started');
  soloCountdown(dailyNext);
}

async function dailyNext() {
  const token = SOLO.token;
  try {
    const d = await dailyApi('next');
    if (token !== SOLO.token) return;
    applyDaily(d);
    if (d.done) { dailyDone(true); return; }
    showDailyPrompt();
  } catch (err) {
    if (token === SOLO.token) toast(cloud.errorText(err));
  }
}

function showDailyPrompt() {
  soloBanana.reset();
  soloShowPrompt(SOLO.prompts[SOLO.idx]);
  renderDailyList();
  soloLoop();
}

let dailyBusy = false;
async function dailySend(action, body = {}) {
  if (dailyBusy) return;
  dailyBusy = true;
  const token = SOLO.token;
  const prompt = SOLO.prompts[SOLO.idx];
  try {
    const d = await dailyApi(action, body);
    if (token !== SOLO.token) return;
    if (d.error && !d.done) {
      SOUND.nope();
      $('solo-hint').className = 'hint bad';
      $('solo-hint').textContent = E.REASON_TEXT[d.error] || 'Try another word';
      shake($('solo-answer'));
      return;
    }
    if (d.solved) {
      SOUND.ok();
      soloFlash(`${highlight(d.solved.word, prompt)} <span class="muted">${d.solved.time == null ? '' : E.formatMs(d.solved.time)}</span>`);
      soloBanana.hop();
    }
    applyDaily(d);
    if (d.done) { dailyDone(true); return; }
    showDailyPrompt();
  } catch (err) {
    if (token === SOLO.token) toast(cloud.errorText(err));
  } finally {
    dailyBusy = false;
  }
}

function soloSolved(word) {
  if (SOLO.mode === 'practice') return practiceSolved(word);
  dailySend('answer', { word });
}

function soloSkip() {
  if (SOLO.done) return;
  if (SOLO.mode === 'practice') {
    reportPracticeStreak();
    SOLO.streak = 0;
    renderPractice();
    practiceNext();
    return;
  }
  dailySend('skip');
}

function renderDailyList() {
  const now = SOLO.idx;
  const rows = Array.from({ length: E.DAILY_COUNT }, (_, i) => SOLO.prompts[i] || '');
  $('daily-list').innerHTML = rows.map((p, i) => {
    const t = SOLO.times[i];
    const state = i < SOLO.times.length ? (t == null ? 'skipped' : 'done') : i === now ? 'now' : '';
    const word = SOLO.words[i];
    const label = i < SOLO.times.length ? (t == null ? 'skipped' : E.formatMs(t)) : i === now && !SOLO.done ? '…' : '';
    return `<li class="${state}"><span class="sq">${i < SOLO.times.length ? E.dailySquare(t) : ''}</span>
      <span class="p">${p ? esc(p.toUpperCase()) : '··'}</span>
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
  const total = E.dailyTotal(SOLO.times);
  const skips = SOLO.times.filter((t) => t == null).length;
  $('daily-done').hidden = false;
  $('daily-score').textContent = E.formatMs(total);
  $('daily-sub').textContent = skips ? `Including ${plural(skips, 'skip')} (10 s each).` : 'No skips. Lovely.';
  renderDailyList();
  if (fresh) cloud.track('daily_finished', { ms: total, skips });
  renderDailyBoard();
}

async function renderDailyBoard() {
  const el = $('daily-board');
  el.innerHTML = '';
  try {
    const b = await cloud.api('/api/rotten/daily/board');
    if (!SOLO.done || SOLO.mode !== 'daily') return;
    const mine = b.me ? `You’re <b>#${b.me.rank}</b> of ${plural(b.players, 'player')} today.` : '';
    el.innerHTML = (mine ? `<p class="board-me">${mine}</p>` : '')
      + `<ol class="board">${b.top.slice(0, 10).map((r) => `<li class="${r.me ? 'me' : ''}"><span class="rk">${r.rank}</span>`
      + `<span class="nm">${esc(r.name)}</span><span class="sq">${esc(r.detail)}</span><span class="t">${E.formatMs(r.score)}</span></li>`).join('')}</ol>`;
  } catch {
    el.innerHTML = '<p class="muted small">Couldn’t load today’s leaderboard.</p>';
  }
}

function dailyShareText() {
  const total = E.dailyTotal(SOLO.times);
  const skips = SOLO.times.filter((t) => t == null).length;
  return `Rotten #${SOLO.number}: ${E.formatMs(total)}${skips ? ` (${plural(skips, 'skip')})` : ''}\n`
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
  reportPracticeStreak();
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
  if (!SOLO.streak) SOLO.runAt = performance.now();
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
  reportPracticeStreak();
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

// A practice streak that ends (splat, new letters, leaving) goes to my own stats if it beat what was already sent
function reportPracticeStreak() {
  if (SOLO.mode !== 'practice' || SOLO.streak <= SOLO.sentBest) return;
  SOLO.sentBest = SOLO.streak;
  cloud.savePractice(SOLO.streak, Math.round(performance.now() - SOLO.runAt)).catch(() => { /* stats only */ });
}

function leaveSolo() {
  reportPracticeStreak();
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
  $('quick-btn').disabled = busy;
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
    const code = await quickPlay('rotten');
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
cloud.mountDeleteData($('delete-data'), { onDone: renderSettings });

async function renderSettings() {
  const u = cloud.getUser();
  $('account-box').innerHTML = u
    ? `${u.photo ? `<img class="avatar" src="${esc(u.photo)}" alt="">` : ''}<span class="who"><b>${esc(u.name)}</b><span>${esc(u.email)}</span></span><button class="btn ghost" id="sign-out" type="button">Sign out</button>`
    : '<span class="who"><b>Playing as a guest</b><span>Your stats are kept in this browser. Sign in to keep them on any device.</span></span><button class="btn primary" id="sign-in" type="button">Sign in with Google</button>';
  $('sign-in')?.addEventListener('click', signIn);
  $('sign-out')?.addEventListener('click', () => cloud.signOutUser());
  $('sound-toggle').checked = PREFS.sound !== false;
  $('vibrate-toggle').checked = PREFS.vibrate !== false;
  $('typing-toggle').checked = PREFS.typing !== false;
  $('anim-select').value = PREFS.anim;
  $('kbd-select').value = PREFS.kbd;
  $('analytics-row').hidden = !cloud.analyticsConfigured();
  $('analytics-toggle').checked = PREFS.analytics !== false;
  $('my-stats').innerHTML = '<p class="muted">Loading your stats…</p>';
  try {
    const st = await cloud.getMyStats();
    if ((cloud.getUser()?.uid || null) !== (u?.uid || null)) return;
    $('my-stats').innerHTML = `
      <div class="stat-grid">
        <div><b>${st.games}</b><span>Games</span></div>
        <div><b>${st.wins}</b><span>Wins</span></div>
        <div><b>${st.words}</b><span>Words</span></div>
        <div><b>${st.longest || '–'}</b><span>Longest word</span></div>
        <div><b>${st.dailies}</b><span>Dailies</span></div>
        <div><b>${st.bestDaily ? E.formatMs(st.bestDaily) : '–'}</b><span>Best daily</span></div>
        <div><b>${st.practiceBest || '–'}</b><span>Practice best</span></div>
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
if (new URLSearchParams(location.search).has('debug')) window.__rotten = { S, SOLO, WORDS, E, link };

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
  });
  cloud.initAnalytics(PREFS.analytics !== false);
  cloud.restore();
})();
