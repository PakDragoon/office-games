import * as E from './engine.js';
import * as cloud from './cloud.js';
import { createRoomLink, quickPlay } from '../../shared/net.js';
import { wirePublic, paintPublic, publicLine } from '../../shared/public.js';

/* =========================================================
   Forehead
   Everyone has a secret card that everyone else can see. On your turn you ask a yes-or-no question about your
   card or guess it, and the others answer your questions. The game runs on the server (server/src/games/forehead.ts):
   it deals the cards, checks every guess and sends each player their OWN view, in which their own card is
   missing until it has been revealed. This page draws that view and passes on what you do.
   ========================================================= */

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ---------- This browser only ---------- */
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`forehead.${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`forehead.${key}`, JSON.stringify(value)); } catch { /* not saved */ }
  },
};
const PREFS = { sound: true, analytics: true, ...store.get('prefs', {}) };
const ROOM_PREFS = { ...E.cleanSettings(store.get('room', {})) };
const savePrefs = () => store.set('prefs', PREFS);
const saveRoomPrefs = () => store.set('room', ROOM_PREFS);

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
   State and the room on the server
   ========================================================= */
const S = {
  myName: '', myId: null, isHost: false, code: '', view: null, reconnecting: false, creating: false,
  turnKey: '', phaseKey: '', myAns: null, ansKey: '', filter: null, answersDeck: '',
  turnEndAt: 0, turnTotal: 0, roundEndAt: 0, giveUpArmed: 0, endArmed: 0, errorTimer: 0,
};

const link = createRoomLink('forehead', {
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
const toHost = (msg) => link.send(msg);

function closeRoom() {
  link.close();
  stopClocks();
  Object.assign(S, {
    view: null, isHost: false, code: '', reconnecting: false, creating: false, turnKey: '', phaseKey: '', myAns: null, ansKey: '', filter: null,
    giveUpArmed: 0, endArmed: 0,
  });
}

function sendSettings() {
  if (S.isHost && S.view && S.view.status === 'lobby') toHost({ t: 'settings', settings: { ...ROOM_PREFS } });
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
    case 'nope':
      showFormError(String(msg.reason || '').slice(0, 80));
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
const who = (v, id) => v.players.find((p) => p.id === id);

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
    stopClocks();
    S.turnKey = '';
    S.filter = null;
    renderLobby(v);
    if ($('lobby').hidden) showScreen('lobby');
    return;
  }
  if ($('game').hidden) showScreen('game');
  renderGame(v);
}

/* =========================================================
   Clocks: the step timer (ring) and the round timer (minutes)
   ========================================================= */
let clockTimer = 0;
function stopClocks() {
  clearInterval(clockTimer);
  clockTimer = 0;
  $('clock').hidden = true;
  $('round-clock').hidden = true;
  S.turnEndAt = 0;
  S.roundEndAt = 0;
}
function tickClocks() {
  const now = performance.now();
  if (S.turnEndAt) {
    const left = Math.max(0, S.turnEndAt - now);
    $('clock-fill').style.strokeDashoffset = String(1 - Math.min(1, left / S.turnTotal));
    $('clock-text').textContent = String(Math.ceil(left / 1000));
    $('clock').classList.toggle('urgent', left <= 5000);
  }
  if (S.roundEndAt) {
    const left = Math.max(0, S.roundEndAt - now);
    const s = Math.ceil(left / 1000);
    $('round-clock-text').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    $('round-clock').classList.toggle('urgent', left <= 30000);
  }
}
function setClocks(v) {
  const play = v.status === 'play';
  const now = performance.now();
  S.roundEndAt = play && v.roundEndsIn > 0 ? now + v.roundEndsIn : 0;
  $('round-clock').hidden = !S.roundEndAt;
  const total = { ask: E.TIMES.askMs, answer: E.TIMES.answerMs, tally: E.TIMES.tallyMs }[v.phase];
  S.turnEndAt = play && total && v.endsIn > 0 ? now + v.endsIn : 0;
  S.turnTotal = total || 1;
  $('clock').hidden = !S.turnEndAt;
  if (S.turnEndAt || S.roundEndAt) {
    tickClocks();
    if (!clockTimer) clockTimer = setInterval(tickClocks, 250);
  } else {
    clearInterval(clockTimer);
    clockTimer = 0;
  }
}

/* =========================================================
   The game screen
   ========================================================= */
const show = (id, on) => { $(id).hidden = !on; };
const answerList = (v) => E.answerList(v.settings.deck);

function renderGame(v) {
  const mine = me(v);
  const play = v.status === 'play';
  const watching = !mine.inGame;
  const myTurn = play && v.asker === S.myId && mine.inGame;
  const asker = who(v, v.asker);
  $('bar-code').textContent = v.code;
  const turnText = v.status === 'result' ? 'Round over' : v.phase === 'wait' ? '' : myTurn ? 'Your turn' : `${asker ? asker.name : ''}’s turn`;
  $('bar-phase').innerHTML = `<span class="rnd">Round ${v.game}${turnText ? ' · ' : ''}</span>${esc(turnText)}`;
  $('spectator-note').hidden = !watching;
  setClocks(v);

  // A new turn for me: fresh boxes and a chime
  const turnKey = `${v.game}:${v.log.length}:${v.asker}:${v.phase === 'ask' ? 'a' : 'b'}`;
  const newTurn = S.turnKey !== turnKey;
  S.turnKey = turnKey;
  if (newTurn) {
    S.myAns = null;
    showFormError('');
  }

  renderSeats(v);
  renderStage(v, { mine, play, myTurn, asker, newTurn });
  renderLog(v);
  renderScores(v);

  // Foot buttons: give up (anyone still guessing) and end the round (host)
  show('giveup-btn', play && mine.inGame && !mine.done);
  show('endround-btn', play && S.isHost);
  if (!(play && mine.inGame && !mine.done)) disarm('giveup-btn');
  if (!(play && S.isHost)) disarm('endround-btn');
}

/* ---------- The table ---------- */
function noteHTML(p, extra = '') {
  const reveal = p.card !== null;
  const len = reveal ? p.card.length : 0;
  const size = len > 22 ? ' l2' : len > 13 ? ' l1' : '';
  const badge = p.done === 'guessed' ? '<i class="badge" aria-label="Got it">✓</i>' : p.done === 'gaveup' ? '<i class="badge no" aria-label="Gave up">–</i>' : '';
  if (reveal) return `<span class="note${size}${p.done === 'gaveup' ? ' gaveup' : ''}${extra}">${esc(p.card)}${badge}</span>`;
  if (p.hasCard) return `<span class="note mine${extra}" aria-label="Your card, hidden"><span class="q">?</span></span>`;
  return `<span class="note l2${extra}">no card</span>`;
}

/** A player as a small head in their colour with a small tilted note on the forehead (the card). */
function headHTML(p) {
  const reveal = p.card !== null;
  const len = reveal ? p.card.length : 0;
  // Smaller text for long cards, and for one long word ("Chameleon") so it never breaks mid-word
  const word = reveal ? Math.max(...p.card.split(/\s+/).map((w) => w.length)) : 0;
  const size = len > 16 || word > 10 ? ' l2' : len > 9 || word > 7 ? ' l1' : '';
  const state = p.done === 'guessed' ? ' ok' : p.done === 'gaveup' ? ' gaveup' : '';
  const label = reveal ? `${p.name}’s card: ${p.card}${p.done === 'guessed' ? ' (got it)' : p.done === 'gaveup' ? ' (gave up)' : ''}` : p.hasCard ? 'Your card is hidden from you' : '';
  const badge = p.done === 'guessed' ? '<i class="badge" aria-hidden="true">✓</i>' : '';
  const note = reveal ? `<span class="fnote${size}${state}" title="${esc(p.card)}" aria-label="${esc(label)}"><span>${esc(p.card)}</span>${badge}</span>`
    : p.hasCard ? `<span class="fnote mine" title="${esc(label)}" aria-label="${esc(label)}"><span>?</span></span>` : '';
  return `<span class="seat-head"><svg viewBox="0 0 100 100" aria-hidden="true"><use href="#fh-face"/></svg>${note}</span>`;
}

function renderSeats(v) {
  const seats = v.players.filter((p) => p.inGame);
  $('seats').style.setProperty('--cols', String(Math.min(4, Math.max(1, seats.length))));
  $('seats').innerHTML = seats.map((p) => {
    const tag = v.status === 'play' && v.asker === p.id ? '<span class="tag">Asking</span>'
      : p.done === 'guessed' ? '<span class="tag good">Got it</span>'
        : p.done === 'gaveup' ? '<span class="tag">Gave up</span>'
          : !p.connected ? '<span class="tag">Left</span>' : p.away ? '<span class="tag">Away</span>' : '';
    const cls = `seat pc${p.color}${v.status === 'play' && v.asker === p.id ? ' asking' : ''}${S.filter === p.id ? ' filtered' : ''}${active(p) ? '' : ' off'}`;
    return `<li><button type="button" class="${cls}" data-pid="${esc(p.id)}" aria-pressed="${S.filter === p.id}" title="Show the questions asked about ${esc(p.name)}">
      ${headHTML(p)}
      <span class="seat-info">
        <span class="seat-name"><span class="nm">${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}</span></span>
        <span class="seat-meta">${tag}<span>${p.asked} Q</span><span>${p.score} pts</span></span>
      </span>
    </button></li>`;
  }).join('');
}
$('seats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pid]');
  if (!b || !S.view) return;
  S.filter = S.filter === b.dataset.pid ? null : b.dataset.pid;
  renderSeats(S.view);
  renderLog(S.view);
});

/* ---------- The stage ---------- */
function showFormError(text) {
  clearTimeout(S.errorTimer);
  $('ask-error').textContent = '';
  if (!text) return;
  $('ask-error').textContent = text;
  S.errorTimer = setTimeout(() => { $('ask-error').textContent = ''; }, 3500);
}

function renderStage(v, { mine, play, myTurn, asker, newTurn }) {
  const result = v.status === 'result';
  const numbers = v.settings.deck === 'numbers';
  show('st-ask-me', play && v.phase === 'ask' && myTurn);
  show('st-ask-other', play && v.phase === 'ask' && !myTurn);
  show('st-answer', play && v.phase === 'answer');
  show('st-tally', play && v.phase === 'tally');
  show('st-wait', play && v.phase === 'wait');
  show('st-result', result);

  // Your own card, once it's out
  const done = $('mine-done');
  done.hidden = !(play && mine.inGame && mine.done);
  if (!done.hidden) {
    done.classList.toggle('good', mine.done === 'guessed');
    done.innerHTML = `${noteHTML(mine, ' inline')}<div><b>${mine.done === 'guessed' ? 'You got it!' : 'You gave up'}</b>
      <span>${mine.done === 'guessed' ? `+${mine.pts} points in ${plural(mine.asked, 'question')}.` : '0 points this round.'} You can still answer everyone’s questions.</span></div>`;
  }

  if (play && v.phase === 'ask') {
    if (myTurn) {
      const input = $('ask-input');
      $('ask-input').placeholder = numbers ? 'Is it more than 50?' : 'Am I an animal?';
      $('ask-hint').textContent = numbers
        ? 'Everyone else can read your number. They’ll answer Yes, No, Higher or Lower.'
        : 'Everyone else can read your card. They’ll answer Yes, No, Sort of or Don’t know.';
      if (newTurn) {
        input.value = '';
        $('guess-input').value = '';
        S.guessing = false;
        paintCount();
        if (mine.inGame) { chime(); setTimeout(() => { if (!$('st-ask-me').hidden) input.focus({ preventScroll: true }); }, 60); }
      }
      paintGuessMode();
      $('ask-send').disabled = false;
    } else {
      $('ask-other-title').textContent = `${asker ? asker.name : 'Someone'} is thinking of a question…`;
      $('ask-other-sub').textContent = v.note || (mine.done ? 'You can still answer their questions.' : 'Their card is on their forehead: have a look and get ready to answer.');
    }
  }

  if (play && (v.phase === 'answer' || v.phase === 'tally')) renderQuestion(v, { mine, asker, numbers });
  if (result) renderResult(v);
}

/** The question on the table, and either the answer buttons or the tally. */
function renderQuestion(v, { mine, asker, numbers }) {
  const from = asker ? `${asker.name} asks${asker.id === S.myId ? ' (you)' : ''}` : '';
  const text = v.question ? v.question.q : null;
  const answering = v.phase === 'answer';
  const pc = asker ? `pc${asker.color}` : '';
  for (const [fromId, textId, block] of [['q-from', 'q-text', 'st-answer'], ['d-from', 'd-text', 'st-tally']]) {
    $(fromId).textContent = from;
    $(textId).textContent = text === null ? 'Hidden: it names your card, so you don’t get the spoiler.' : text;
    $(textId).classList.toggle('hidden', text === null);
    $(block).querySelector('.q-block').className = `q-block ${pc}`;
  }
  if (answering) {
    const asking = asker && asker.id === S.myId;
    const canAnswer = mine.inGame && !asking;
    // Everyone else's view of the asker's card
    const card = asker && !asking ? asker.card : null;
    show('their-card', card !== null);
    if (card !== null) {
      $('their-card-k').textContent = `${asker.name}’s card:`;
      $('their-card-note').textContent = card;
    }
    buildAnswers(v);
    show('answers', canAnswer);
    const picked = S.myAns || v.myAnswer;
    $('answers').querySelectorAll('.answer').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === picked)));
    $('answer-status').textContent = asking ? `Waiting for answers: ${v.answered} of ${v.need}`
      : !mine.inGame ? `You’re watching. ${v.answered} of ${v.need} answered.`
        : `${picked ? 'Answered. You can change it until everyone has.' : 'Tap an answer.'} ${v.answered} of ${v.need} answered.`;
  } else {
    renderTally(v);
    $('tally-next').textContent = 'Next turn in a moment…';
  }
}

function buildAnswers(v) {
  const deck = v.settings.deck;
  if (S.answersDeck === deck) return;
  S.answersDeck = deck;
  $('answers').innerHTML = answerList(v).map(([k, label]) => `<button type="button" class="answer" data-key="${k}" aria-pressed="false">${esc(label)}</button>`).join('');
}
$('answers').addEventListener('click', (e) => {
  const b = e.target.closest('.answer');
  if (!b || !S.view || S.view.phase !== 'answer') return;
  S.myAns = b.dataset.key;
  $('answers').querySelectorAll('.answer').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  toHost({ t: 'answer', a: b.dataset.key });
});

function renderTally(v) {
  const t = v.tally || {};
  const keys = answerList(v);
  const total = keys.reduce((n, [k]) => n + (t[k] || 0), 0);
  $('tally').innerHTML = keys.map(([k, label]) => {
    const n = t[k] || 0;
    return `<li class="${v.top.includes(k) ? 'top' : ''}"><span class="lbl">${esc(label)}</span>
      <span class="bar" aria-hidden="true"><i style="width:${total ? Math.round((n / total) * 100) : 0}%"></i></span><span class="n">${n}</span></li>`;
  }).join('');
}

/* ---------- Asking or guessing (one per turn) ---------- */
/** On your turn the box asks a question, or (after "Guess my card") takes your guess instead. */
function paintGuessMode() {
  const g = Boolean(S.guessing);
  $('ask-form').hidden = g;
  $('ask-hint').hidden = g;
  $('guess-line').hidden = g;
  $('guess-form').hidden = !g;
  $('ask-title').textContent = g ? 'Your turn: what’s on your forehead?' : 'Your turn: ask a yes-or-no question, or guess';
}
function setGuessing(on) {
  S.guessing = on;
  showFormError('');
  paintGuessMode();
  const el = on ? $('guess-input') : $('ask-input');
  setTimeout(() => el.focus({ preventScroll: true }), 30);
}
$('guess-instead').addEventListener('click', () => setGuessing(true));
$('ask-instead').addEventListener('click', () => setGuessing(false));
function paintCount() {
  const n = $('ask-input').value.length;
  $('ask-count').textContent = `${n}/${E.QUESTION_MAX}`;
  $('ask-count').classList.toggle('near', n >= E.QUESTION_MAX - 10);
}
$('ask-input').addEventListener('input', () => { paintCount(); showFormError(''); });
$('ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!S.view || S.view.phase !== 'ask' || S.view.asker !== S.myId) return;
  const q = $('ask-input').value.replace(/\s+/g, ' ').trim();
  if (!q) { showFormError('Type a question first.'); return; }
  toHost({ t: 'ask', q });
});
$('guess-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!S.view || S.view.phase !== 'ask' || S.view.asker !== S.myId) return;
  const text = $('guess-input').value.replace(/\s+/g, ' ').trim();
  if (!text) { showFormError('Type your guess first.'); return; }
  toHost({ t: 'guess', text });
});
$('guess-input').addEventListener('input', () => showFormError(''));

// Two taps to give up or end the round: the first one arms the button for a few seconds
function disarm(id) {
  const b = $(id);
  if (!b.classList.contains('armed')) return;
  b.classList.remove('armed');
  b.textContent = id === 'giveup-btn' ? 'Give up and show my card' : 'End the round now';
}
function twoTap(id, armedText, act) {
  let timer = 0;
  $(id).addEventListener('click', () => {
    const b = $(id);
    if (b.classList.contains('armed')) {
      clearTimeout(timer);
      disarm(id);
      act();
      return;
    }
    b.classList.add('armed');
    b.textContent = armedText;
    clearTimeout(timer);
    timer = setTimeout(() => disarm(id), 4000);
  });
}
twoTap('giveup-btn', 'Tap again to give up (0 points)', () => toHost({ t: 'giveup' }));
twoTap('endround-btn', 'Tap again to end the round', () => { if (S.isHost) toHost({ t: 'endround' }); });

/* ---------- The question log ---------- */
const outcomeHTML = (e, isCurrent, v) => {
  switch (e.outcome) {
    case 'right': return `<span class="out right">Got it: ${esc(e.guess ?? '')}</span>`;
    case 'wrong': return `<span class="out wrong">Not it${e.guess === null ? ' (hidden)' : `: ${esc(e.guess)}`}</span>`;
    case 'pass': return '<span class="out">Passed</span>';
    case 'skip': return '<span class="out">Skipped</span>';
    case 'ended': return '<span class="out">Round ended</span>';
    default: return isCurrent && v.phase === 'answer' ? '<span class="out">Waiting for answers…</span>' : '';
  }
};

function renderLog(v) {
  const players = v.players.filter((p) => p.inGame);
  if (S.filter && !players.some((p) => p.id === S.filter)) S.filter = null;
  const chips = [`<button type="button" class="chip" data-f="" aria-pressed="${!S.filter}">All</button>`]
    .concat(players.map((p) => `<button type="button" class="chip pc${p.color}" data-f="${esc(p.id)}" aria-pressed="${S.filter === p.id}">${esc(p.name)}</button>`));
  $('log-filter').innerHTML = players.length > 1 ? chips.join('') : '';
  const list = v.log.filter((e) => !S.filter || e.pid === S.filter);
  const asked = v.log.filter((e) => !e.guessTurn).length;
  $('log-count').textContent = asked ? plural(asked, 'question') : '';
  const lastN = v.log.length ? v.log[v.log.length - 1].n : -1;
  const open = v.status === 'play' && (v.phase === 'answer' || v.phase === 'tally');
  if (!list.length) {
    $('log').innerHTML = `<li class="log-empty">${v.log.length ? 'Nothing asked about them yet.' : 'Questions and answers will collect here.'}</li>`;
    return;
  }
  $('log').innerHTML = [...list].reverse().map((e) => {
    const p = who(v, e.pid);
    const keys = e.tally ? answerList(v) : [];
    const ans = e.tally ? `<span class="ans">${keys.filter(([k]) => e.tally[k]).map(([k, label]) => `<span class="${e.top.includes(k) ? 'top' : ''}">${esc(label)} ${e.tally[k]}</span>`).join('') || '<span>No answers</span>'}</span>` : '';
    return `<li class="pc${p ? p.color : 0}"><span class="who">${esc(p ? p.name : 'Someone')} · #${e.n}</span>
      ${e.guessTurn ? '<span class="qt">Took a guess</span>' : `<span class="qt${e.q === null ? ' hidden' : ''}">${e.q === null ? 'Hidden, it names your card' : esc(e.q)}</span>`}${ans}${outcomeHTML(e, open && e.n === lastN, v)}</li>`;
  }).join('');
}
$('log-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b || !S.view) return;
  S.filter = b.dataset.f || null;
  renderSeats(S.view);
  renderLog(S.view);
});

function renderScores(v) {
  const list = [...v.players].sort((a, b) => b.score - a.score);
  $('score-list').innerHTML = list.map((p) => `<li class="pc${p.color}${active(p) ? '' : ' off'}">
    <span class="pen-dot"></span><span class="nm">${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}${p.inGame ? '' : ' · watching'}</span><b>${p.score}</b></li>`).join('');
}

/* ---------- The result ---------- */
function renderResult(v) {
  const rows = v.players.filter((p) => p.inGame).sort((a, b) => b.pts - a.pts || b.score - a.score);
  const best = rows.length ? rows[0].pts : 0;
  $('result-title').textContent = best > 0
    ? `${rows.filter((p) => p.pts === best).map((p) => p.name).join(' and ')} led this round`
    : 'Nobody got their card this time';
  $('result-list').innerHTML = rows.map((p) => {
    const line = p.done === 'guessed' ? `Guessed it in ${plural(p.asked, 'question')}${v.first === p.id ? ' (first!)' : ''}`
      : p.done === 'gaveup' ? `Gave up after ${plural(p.asked, 'question')}` : `Ran out of time after ${plural(p.asked, 'question')}`;
    return `<li class="pc${p.color}">${noteHTML(p)}<span class="who"><b>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}</b><span>${esc(line)}</span></span>
      <span class="gain${p.pts > 0 ? ' plus' : ''}">${p.pts > 0 ? `+${p.pts}` : '0'}<small>${p.score} total</small></span></li>`;
  }).join('');
  show('next-round', S.isHost);
  show('to-lobby', S.isHost);
  show('result-wait', !S.isHost);
  $('crew-line').textContent = v.crewName ? `${v.crewName}: ${v.crewStatus}` : '';
}
$('next-round').addEventListener('click', () => { if (S.isHost) toHost({ t: 'begin' }); });
$('to-lobby').addEventListener('click', () => { if (S.isHost) toHost({ t: 'lobby' }); });
$('quit-btn').addEventListener('click', () => { closeRoom(); goHome(); });

/* =========================================================
   Lobby
   ========================================================= */
$('set-deck').innerHTML = E.DECKS.map((d) => `<button type="button" data-value="${d.id}" aria-pressed="false">${esc(d.name)}</button>`).join('');
$('set-deck').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  ROOM_PREFS.deck = b.dataset.value;
  roomSettingsChanged();
});
$('set-minutes').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  ROOM_PREFS.minutes = Number(b.dataset.value);
  roomSettingsChanged();
});

function roomSettingsChanged() {
  saveRoomPrefs();
  paintRoomSettings();
  sendSettings();
}

function paintRoomSettings() {
  $('set-deck').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === ROOM_PREFS.deck)));
  $('set-minutes').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.value) === ROOM_PREFS.minutes)));
}

const deckName = (id) => E.deckInfo(id).name;
const timerLine = (m) => (m ? `${m}-minute round timer` : 'No round timer');

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
    $('settings-summary').innerHTML = `<li><b>Deck: ${esc(deckName(v.settings.deck))}</b></li><li>${esc(timerLine(v.settings.minutes))}</li>`
      + (v.crewName ? `<li>Crew: <b>${esc(v.crewName)}</b></li>` : '') + `<li>${publicLine(v)}</li>`;
  }
}

$('copy-link').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${S.code}`;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); } catch { toast(url); }
});
$('crew-save').addEventListener('click', () => hostSetCrew($('crew-input').value));
wirePublic(toHost);
$('crew-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') hostSetCrew($('crew-input').value); });
$('start-btn').addEventListener('click', () => {
  if (!S.isHost) return;
  const crew = $('crew-input').value.replace(/\s+/g, ' ').trim();
  toHost({ t: 'begin', settings: { ...ROOM_PREFS }, crew });
});
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
  stopClocks();
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
    const code = await quickPlay('forehead');
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
cloud.mountDeleteData($('delete-data'), { onDone: renderSettings });

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
        <div><b>${st.games}</b><span>Rounds</span></div>
        <div><b>${st.wins}</b><span>Wins</span></div>
        <div><b>${st.guessed}</b><span>Cards guessed</span></div>
        <div><b>${st.questions}</b><span>Questions asked</span></div>
        <div><b>${st.fewestQ ? st.fewestQ : '–'}</b><span>Fewest questions</span></div>
        <div><b>${st.points}</b><span>Points</span></div>
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

// Test hook: with ?debug in the address, automated tests can inspect what this player was sent
// (the view, in which their own card is missing until revealed) and talk to the room.
if (new URLSearchParams(location.search).has('debug')) window.__forehead = { S, link };

/* =========================================================
   Start
   ========================================================= */
(function init() {
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
  });
  cloud.initAnalytics(PREFS.analytics !== false);
  cloud.restore();
})();
