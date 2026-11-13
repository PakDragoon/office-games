import * as E from './engine.js';
import * as cloud from './cloud.js';
import { createRoomLink, quickPlay } from '../../shared/net.js';
import { wirePublic, paintPublic, publicLine } from '../../shared/public.js';

/* =========================================================
   A to Zap
   The page only draws what the server sends and says what the player did. The server picks the letter when the
   picker is too slow, keeps the clock, judges every answer, runs the vote and adds up the points; the rules
   it uses are in engine.js.
   ========================================================= */

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ---------- This browser only ---------- */
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`atozap.${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`atozap.${key}`, JSON.stringify(value)); } catch { /* not saved */ }
  },
  remove(key) {
    try { localStorage.removeItem(`atozap.${key}`); } catch { /* nothing to remove */ }
  },
};
const PREFS = { sound: true, analytics: true, ...store.get('prefs', {}) };
let ROOM_PREFS = E.cleanSettings(store.get('room', {}));
const savePrefs = () => store.set('prefs', PREFS);

/* ---------- Screens, sheets, messages ---------- */
const SCREENS = ['home', 'lobby', 'game'];
function showScreen(name) {
  SCREENS.forEach((s) => { $(s).hidden = s !== name; });
  window.scrollTo(0, 0);
}
const STAGES = ['pick', 'play', 'review', 'results', 'over'];
function showStage(name) {
  STAGES.forEach((s) => { $(`v-${s}`).hidden = s !== name; });
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
function audioCtx() {
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
  return audio;
}
function tone(freq, start, dur, vol = 0.14, type = 'sine') {
  const a = audioCtx();
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
  tick() { if (PREFS.sound) tone(560, 0, 0.08, 0.08); },
  zap() { if (PREFS.sound) [880, 1320, 660].forEach((f, i) => tone(f, i * 0.06, 0.16, 0.12, 'sawtooth')); },
  lock() { if (PREFS.sound) tone(330, 0, 0.25, 0.1, 'triangle'); },
};

/* =========================================================
   State
   ========================================================= */
const S = {
  myName: '', myId: null, isHost: false, code: '', view: null, creating: false,
  reconnecting: false, viewAt: 0, zapSeen: '', lastZapN: -1, endArm: 0, lockSound: '',
};
// My own answers for the round on screen: the page keeps them (so typing feels instant) and sends them in batches.
const A = { key: '', cats: [], answers: {}, dirty: false, finalSent: false, inputs: new Map() };

const me = (v) => v.players.find((p) => p.id === S.myId);
const left = (ms) => Math.max(0, ms - (performance.now() - S.viewAt));
const clock = (ms) => `${Math.floor(Math.ceil(ms / 1000) / 60)}:${String(Math.ceil(ms / 1000) % 60).padStart(2, '0')}`;
const active = (p) => p.connected && !p.away;
const colorOf = (v, name) => (v.players.find((p) => p.name === name) || { color: 0 }).color;

/* =========================================================
   The room (a WebSocket to the server)
   ========================================================= */
const link = createRoomLink('a-to-zap', {
  hello: () => ({ name: S.myName, photo: cloud.getUser()?.photo || '' }),
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
const toHost = (msg) => link.send(msg);

function closeRoom() {
  link.close();
  Object.assign(S, { view: null, isHost: false, code: '', reconnecting: false, creating: false, zapSeen: '', lastZapN: -1, lockSound: '' });
  Object.assign(A, { key: '', answers: {}, dirty: false, finalSent: false });
}

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

function applyState(v) {
  if (!v || !Array.isArray(v.players)) return;
  const prev = S.view;
  S.view = v;
  S.viewAt = performance.now();
  const seat = me(v);
  if (!seat) return;
  S.isHost = Boolean(seat.isHost);
  S.code = v.code;
  if (S.creating && S.isHost) {
    // A room we just opened: bring this browser's saved settings and crew
    S.creating = false;
    toHost({ t: 'settings', patch: { ...ROOM_PREFS } });
    const savedCrew = store.get('crew', '');
    if (savedCrew) roomSetCrew(savedCrew);
  }
  if (v.status === 'lobby') {
    renderLobby(v);
    if ($('lobby').hidden) showScreen('lobby');
    return;
  }
  if ($('game').hidden) showScreen('game');
  renderGame(v, prev);
}

/* =========================================================
   The game screen
   ========================================================= */
function renderGame(v, prev) {
  $('bar-code').textContent = v.code;
  $('bar-phase').textContent = v.status === 'over' ? 'Game over' : `Round ${v.round} of ${v.totalRounds}`;
  showStage(v.status === 'review' ? 'review' : v.status);
  if (v.status === 'pick') renderPick(v);
  else if (v.status === 'play') renderPlay(v);
  else if (v.status === 'review') renderReview(v);
  else if (v.status === 'results') renderResults(v);
  else if (v.status === 'over') renderOver(v);
  if (prev && prev.status === 'play' && v.status !== 'play') SOUND.lock();
}

/* ---------- Picking the letter ---------- */
const grid = $('letter-grid');
grid.innerHTML = [...E.LETTERS].map((l) => `<button type="button" data-l="${l}" aria-label="Letter ${l}">${l}</button>`).join('');
grid.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-l]');
  const v = S.view;
  if (!b || !v || v.status !== 'pick' || v.pickerId !== S.myId || b.disabled) return;
  b.classList.add('chosen');
  toHost({ t: 'pick', letter: b.dataset.l });
});

function renderPick(v) {
  const mine = v.pickerId === S.myId;
  $('pick-title').textContent = mine ? 'Your turn: pick a letter' : `${v.pickerName || 'Someone'} is picking a letter…`;
  grid.classList.toggle('watching', !mine);
  for (const b of grid.children) {
    const l = b.dataset.l;
    const used = v.used.includes(l);
    const off = !used && E.HARD_LETTERS.includes(l) && !v.settings.hard;
    b.className = `${used ? 'used' : ''}${off ? 'off' : ''}`.trim();
    b.disabled = !mine || used || off;
    b.title = used ? 'Already used this game' : off ? 'Hard letter (switched off)' : '';
  }
  const parts = [];
  if (v.used.length) parts.push('Struck-out letters have been used already.');
  if (!v.settings.hard) parts.push('Q, X and Z are off (hard letters).');
  parts.push(mine ? 'If you don\'t pick, the game picks one for you.' : '');
  $('pick-note').textContent = parts.filter(Boolean).join(' ');
  paintTimers(v);
}

/* ---------- Answering ---------- */
const form = $('answers');

/** One input per category, built once per round (so a typing player is never interrupted by a new view). */
function buildInputs(v) {
  A.cats = v.settings.categories;
  A.inputs.clear();
  form.innerHTML = '';
  const letter = v.letter;
  for (const cat of A.cats) {
    const wrap = document.createElement('label');
    wrap.className = 'cat';
    wrap.innerHTML = `<span class="cat-name">${esc(E.labelOf(cat))}<i hidden>not ${esc(letter)}</i></span>`;
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.cat = cat;
    input.maxLength = E.MAX_ANSWER_CHARS;
    input.placeholder = `${letter}…`;
    input.autocomplete = 'off';
    input.autocapitalize = 'words';
    input.spellcheck = false;
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('enterkeyhint', 'next');
    input.setAttribute('aria-label', `${E.labelOf(cat)} starting with ${letter}`);
    wrap.appendChild(input);
    form.appendChild(wrap);
    A.inputs.set(cat, input);
  }
}

function renderPlay(v) {
  const playing = Boolean(v.mine);
  const key = `${v.game}:${v.round}`;
  if (A.key !== key) {
    // A new round (or this page just loaded in the middle of one): lay the boxes out and put back what the server holds
    Object.assign(A, { key, answers: {}, dirty: false, finalSent: false });
    buildInputs(v);
    if (v.mine) for (const [cat, text] of Object.entries(v.mine.answers || {})) if (A.inputs.has(cat)) { A.inputs.get(cat).value = text; A.answers[cat] = text; }
    S.zapSeen = '';
    S.lastZapN = -1;
    if (playing && !v.mine.submitted && !openSheet && !matchMedia('(pointer: coarse)').matches) A.inputs.values().next().value?.focus();
  }
  $('big-letter').textContent = v.letter;
  $('round-label').textContent = v.zap ? 'Time is running out' : 'Time left';
  const submitted = Boolean(v.mine && v.mine.submitted);
  const zapped = Boolean(v.zap);
  for (const input of A.inputs.values()) input.disabled = !playing || submitted;
  paintAnswerState();
  $('zap-btn').hidden = zapped || !playing;
  $('done-btn').hidden = !playing || submitted;
  const note = !playing ? 'You joined in the middle of a game, so you\'re watching this round. You\'ll play the next game.'
    : submitted ? (v.players.filter((p) => p.inGame && !p.submitted && active(p)).length ? 'Handed in. Waiting for the others…' : 'Handed in.')
    : '';
  $('play-note').textContent = note;
  renderSide(v);
  paintTimers(v);
  if (zapped && S.zapSeen !== key) { S.zapSeen = key; SOUND.zap(); }
}

/** Zap! lights up when every box has something; wrong first letters are marked (a hint: the server decides). */
function paintAnswerState() {
  const v = S.view;
  if (!v) return;
  const letter = v.letter || '';
  for (const input of A.inputs.values()) {
    const norm = E.normalize(input.value);
    input.classList.toggle('filled', norm !== '');
    const wrong = norm !== '' && !E.startsWith(norm, letter);
    input.classList.toggle('wrong', wrong);
    const tag = input.parentElement.querySelector('i');
    if (tag) tag.hidden = !wrong;
  }
  const filled = E.allFilled(A.cats, A.answers);
  const submitted = Boolean(v.mine && v.mine.submitted);
  $('zap-btn').disabled = !filled || submitted || !v.mine;
  $('zap-btn').title = filled ? '' : 'Fill in every box first';
  // "I'm done" also needs every box (the server checks it too)
  $('done-btn').disabled = !filled || submitted || !v.mine;
  $('done-btn').title = filled ? '' : 'Fill in every box first';
}

form.addEventListener('input', (e) => {
  const input = e.target.closest('input[data-cat]');
  if (!input) return;
  A.answers[input.dataset.cat] = input.value;
  A.dirty = true;
  paintAnswerState();
  // Batched: at most one message every 1.5 seconds, never one per keystroke
  link.sendLatest('answers', { t: 'answers', a: { ...A.answers } }, 1500);
});
form.addEventListener('submit', (e) => e.preventDefault());
form.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const inputs = [...A.inputs.values()];
  const i = inputs.indexOf(e.target);
  if (i >= 0 && i < inputs.length - 1) inputs[i + 1].focus();
  else if (!$('zap-btn').disabled && !$('zap-btn').hidden) $('zap-btn').focus();
  else $('done-btn').focus();
});

$('zap-btn').addEventListener('click', () => {
  if ($('zap-btn').disabled) return;
  A.dirty = false;
  toHost({ t: 'zap', a: { ...A.answers } });
});
$('done-btn').addEventListener('click', () => {
  if ($('done-btn').disabled) return;
  $('done-btn').disabled = true;
  A.dirty = false;
  toHost({ t: 'submit', a: { ...A.answers } });
});

function renderSide(v) {
  const total = v.settings.categories.length;
  const players = v.players.filter((p) => p.inGame);
  const rows = players.map((p) => {
    const isMe = p.id === S.myId;
    const filled = isMe ? E.filledCount(A.cats, A.answers) : p.filled;
    const zapper = v.zap && v.zap.by === p.name;
    const state = !p.connected ? 'left' : p.away ? 'away' : zapper ? 'ZAP!' : p.submitted ? 'done' : `${filled} of ${total}`;
    const cls = zapper ? 'zap' : p.submitted ? 'done' : '';
    return `<li class="pc${p.color}${isMe ? ' me' : ''}${active(p) ? '' : ' off'}">
      <span class="pen-dot"></span>
      <span class="nm">${esc(p.name)}${isMe ? ' (you)' : ''}<span class="st ${cls}">${state}</span><span class="bar"><i style="width:${Math.round(((p.submitted ? total : filled) / total) * 100)}%"></i></span></span>
      <span class="pts">${p.score}</span></li>`;
  });
  $('play-side').innerHTML = `<h3>Players</h3><ul class="pl">${rows.join('')}</ul>`;
}

/* ---------- The clocks ---------- */
function paintTimers(v = S.view) {
  if (!v) return;
  if (v.status === 'pick') {
    const ms = left(v.pickLeft);
    $('pick-timer').textContent = `${Math.ceil(ms / 1000)}`;
    $('pick-timer').classList.toggle('urgent', ms <= 3000);
  } else if (v.status === 'play') {
    const ms = left(v.playLeft);
    $('clock').textContent = clock(ms);
    $('clock').classList.toggle('urgent', ms <= 10000);
    const zapBox = $('zap-box');
    zapBox.hidden = !v.zap;
    if (v.zap) {
      $('zap-who').textContent = v.zap.mine ? 'You hit Zap!' : `${v.zap.by} hit Zap!`;
      const n = Math.ceil(ms / 1000);
      $('zap-count').textContent = String(n);
      zapBox.classList.toggle('last', n <= 3);
      if (n !== S.lastZapN) { S.lastZapN = n; if (n <= 3 && n > 0) SOUND.tick(); }
    }
    // The last moment: send what is typed, so a word typed in the final second still counts
    if (A.dirty && !A.finalSent && ms < 450 && v.mine && !v.mine.submitted) {
      A.finalSent = true;
      A.dirty = false;
      toHost({ t: 'answers', a: { ...A.answers } });
    }
  } else if (v.status === 'review') {
    const ms = left(v.voteLeft);
    $('review-timer').textContent = `${Math.ceil(ms / 1000)}`;
    $('review-timer').classList.toggle('urgent', ms <= 5000);
  } else if (v.status === 'results') {
    const ms = left(v.nextLeft);
    $('next-timer').textContent = v.results && v.results.last ? '' : `Next round in ${Math.ceil(ms / 1000)}`;
  }
}
setInterval(() => paintTimers(), 200);

/* ---------- The vote ---------- */
function renderReview(v) {
  const r = v.review;
  const seat = me(v);
  const canVoteAny = r.items.some((i) => i.canVote);
  $('review-help').textContent = `Thumbs up if it's a real word for that category and it starts with ${v.letter}. A majority of 👍, or a tie, accepts it.`;
  const list = $('review-list');
  const scroll = list.scrollTop;
  list.innerHTML = r.items.map((i) => `<li class="${i.mine ? 'mine' : ''}">
      <div><span class="cat-tag">${esc(E.labelOf(i.cat))}</span><div class="word">${esc(i.text)}</div><div class="by">by ${esc(i.owners.join(' and '))}</div></div>
      ${i.canVote
    ? `<div class="vote-btns"><button type="button" class="yes" data-i="${i.i}" data-v="1" aria-pressed="${i.vote === 1}" aria-label="Accept ${esc(i.text)}">👍</button><button type="button" class="no" data-i="${i.i}" data-v="-1" aria-pressed="${i.vote === -1}" aria-label="Reject ${esc(i.text)}">👎</button></div>`
    : `<span class="own-note">${i.mine ? 'Your answer' : ''}</span>`}</li>`).join('');
  list.scrollTop = scroll;
  const pending = r.items.filter((i) => i.canVote && i.vote === 0).length;
  const parts = [];
  if (!seat || !seat.inGame) parts.push('You\'re watching this vote.');
  else if (!canVoteAny) parts.push('These are all yours, so the others decide.');
  else if (pending) parts.push(`${plural(pending, 'answer')} left for you to vote on.`);
  else parts.push('Your votes are in.');
  if (r.waiting) parts.push(`Waiting for ${plural(r.waiting, 'player')}.`);
  $('review-note').textContent = parts.join(' ');
  paintTimers(v);
}
$('review-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b || !S.view || S.view.status !== 'review') return;
  const item = S.view.review.items[Number(b.dataset.i)];
  const val = Number(b.dataset.v);
  // Tapping your choice again takes the vote back
  toHost({ t: 'vote', item: Number(b.dataset.i), v: item && item.vote === val ? 0 : val });
});

/* ---------- Results ---------- */
const NOTE = { voted: 'voted in', rejected: 'voted out', blank: '' };
function renderResults(v) {
  const r = v.results;
  if (!r) return;
  $('results-title').textContent = `Round ${r.round} · ${r.letter}`;
  const head = `<thead><tr><th class="pname">Player</th>${r.categories.map((c) => `<th>${esc(E.labelOf(c))}</th>`).join('')}<th>Round</th></tr></thead>`;
  const seat = me(v);
  const body = r.rows.map((row) => {
    const player = v.players.find((p) => p.name === row.name);
    const cells = r.categories.map((c) => {
      const x = row.cells[c];
      const blank = x.st === 'blank';
      const cls = blank ? 'p0 blank' : x.pts === 10 ? 'p10' : x.pts === 5 ? 'p5' : 'p0';
      const note = x.st === 'letter' ? `not ${r.letter}` : NOTE[x.st] || '';
      const extra = x.pts === 5 ? 'shared' : '';
      return `<td class="c ${cls}"><b>${blank ? '—' : esc(x.raw)}</b><small><span class="pts">+${x.pts}</span><span>${[extra, note].filter(Boolean).map(esc).join(' · ')}</span></small></td>`;
    }).join('');
    return `<tr class="pc${player ? player.color : 0}${seat && seat.name === row.name ? ' me' : ''}"><th class="pname">${esc(row.name)}</th>${cells}<td class="tot"><b>+${row.total}</b><small>${player ? player.score : ''} total</small></td></tr>`;
  }).join('');
  $('results-table').innerHTML = `${head}<tbody>${body}</tbody>`;
  $('results-votes').innerHTML = r.items.map((i) => `<span class="${i.ok ? 'ok' : 'no'}">${esc(i.shown)} (${esc(E.labelOf(i.cat))}): 👍 ${i.up} · 👎 ${i.down} ${i.ok ? 'accepted' : 'turned down'}</span>`).join('');
  $('next-btn').hidden = !S.isHost;
  $('next-btn').textContent = r.last ? 'Final standings' : 'Next round';
  $('end-btn').hidden = !S.isHost || r.last;
  $('end-btn').textContent = 'End game';
  $('next-note').textContent = S.isHost ? '' : (r.last ? 'The host shows the final standings.' : 'The host starts the next round, or it starts by itself.');
  paintTimers(v);
}
$('next-btn').addEventListener('click', () => { if (S.isHost) toHost({ t: 'next' }); });
// Ending a game is two taps (it can't be undone), and the second must come within a few seconds
$('end-btn').addEventListener('click', () => {
  if (!S.isHost) return;
  const btn = $('end-btn');
  if (Date.now() - S.endArm < 4000) { S.endArm = 0; toHost({ t: 'endGame' }); return; }
  S.endArm = Date.now();
  btn.textContent = 'Tap again to end the game';
  setTimeout(() => { if (S.endArm && Date.now() - S.endArm >= 3900) { S.endArm = 0; btn.textContent = 'End game'; } }, 4000);
});

/* ---------- The end ---------- */
const CROWN = '<svg class="crown" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18 2 7l5.5 4.5L12 4l4.5 7.5L22 7l-1 11z"/></svg>';
function renderOver(v) {
  const st = v.standings;
  const winners = st.filter((s) => s.place === 1);
  const iWon = winners.some((w) => w.id === S.myId);
  const title = !v.results ? 'Game over' : winners.length === 1 ? (iWon ? 'You win!' : `${winners[0].name} wins!`) : `${winners.map((w) => w.name).join(' and ')} tie`;
  const rows = st.map((s) => `<li class="${s.place === 1 ? 'first ' : ''}${s.id === S.myId ? 'me ' : ''}pc${colorOf(v, s.name)}">
      <span class="place">${s.place === 1 ? CROWN : s.place}</span>
      <span class="nm">${esc(s.name)}${s.id === S.myId ? ' (you)' : ''}<small>${plural(s.unique, 'unique answer')} · best round ${s.best}</small></span>
      <span class="pts">${s.score}</span></li>`).join('');
  const tally = v.wins.filter((w) => w.n > 0).sort((a, b) => b.n - a.n);
  let html = `<h2>${esc(title)}</h2><ol class="standings">${rows}</ol>`;
  if (tally.length && v.game > 1) html += `<p class="small-note muted">Wins in this room: ${tally.map((w) => `${esc(w.name)} ${w.n}`).join(' · ')}</p>`;
  html += S.isHost
    ? '<div class="over-actions"><button class="btn primary" type="button" id="again-btn">Play again</button><button class="btn ghost" type="button" id="lobby-btn">Change settings</button></div>'
    : '<p class="small-note muted">The host can start another game.</p>';
  if (v.crew) html += `<p class="small-note muted">${esc(v.crewStatus)}</p>`;
  $('over-card').innerHTML = html;
}
$('over-card').addEventListener('click', (e) => {
  if (!S.isHost) return;
  if (e.target.id === 'again-btn') toHost({ t: 'start' });
  if (e.target.id === 'lobby-btn') toHost({ t: 'lobby' });
});
$('quit-btn').addEventListener('click', () => { closeRoom(); goHome(); });

/* =========================================================
   Lobby
   ========================================================= */
const catGrid = $('set-cats');
catGrid.innerHTML = E.CATEGORIES.map((c) => `<button type="button" data-cat="${c.id}" aria-pressed="false">${esc(c.label)}</button>`).join('');

function sendSettings(patch) {
  ROOM_PREFS = E.cleanSettings(patch, ROOM_PREFS);
  store.set('room', ROOM_PREFS);
  if (S.isHost && S.view && S.view.status === 'lobby') toHost({ t: 'settings', patch });
}

catGrid.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cat]');
  const v = S.view;
  if (!b || !S.isHost || !v) return;
  const now = new Set(v.settings.categories);
  const id = b.dataset.cat;
  if (now.has(id)) {
    if (now.size <= E.MIN_CATEGORIES) return toast(`Keep at least ${E.MIN_CATEGORIES} categories`);
    now.delete(id);
  } else {
    if (now.size >= E.MAX_CATEGORIES) return toast(`At most ${E.MAX_CATEGORIES} categories`);
    now.add(id);
  }
  sendSettings({ categories: [...now] });
});

function segment(container, key, parse) {
  container.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !S.isHost) return;
    sendSettings({ [key]: parse(b.dataset.value) });
  });
}
segment($('set-time'), 'time', Number);
segment($('set-rounds'), 'rounds', Number);
$('set-hard').addEventListener('change', (e) => { if (S.isHost) sendSettings({ hard: e.target.checked }); });

function paintSegment(container, value) {
  container.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.value) === value)));
}

function settingsLines(st) {
  return [
    `<b>${st.categories.length} categories</b>: ${st.categories.map((c) => esc(E.labelOf(c))).join(', ')}`,
    `${st.time} seconds a round`,
    st.rounds === 26 ? 'Until all the letters are used' : `${st.rounds} rounds`,
    st.hard ? 'Hard letters on (Q, X, Z)' : 'No Q, X or Z',
  ].map((l) => `<li>${l}</li>`).join('');
}

function renderLobby(v) {
  $('lobby-code').textContent = v.code;
  const st = v.settings;
  const rows = v.players.map((p) => {
    const w = v.wins.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
    return `<li class="pc${p.color}${active(p) ? '' : ' off'}"><span class="pen-dot"></span>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}
      <span class="tag">${!active(p) ? 'Reconnecting' : [p.isHost ? 'Host' : '', w ? plural(w.n, 'win') : ''].filter(Boolean).join(' · ')}</span></li>`;
  });
  if (v.players.length < 2) rows.push('<li class="empty">Waiting for someone to join…</li>');
  $('lobby-players').innerHTML = rows.join('');
  $('host-settings').hidden = !S.isHost;
  $('guest-settings').hidden = S.isHost;
  if (S.isHost) {
    for (const b of catGrid.children) b.setAttribute('aria-pressed', String(st.categories.includes(b.dataset.cat)));
    $('cat-count').textContent = `(${st.categories.length} picked)`;
    paintSegment($('set-time'), st.time);
    paintSegment($('set-rounds'), st.rounds);
    $('set-hard').checked = st.hard;
    if (document.activeElement !== $('crew-input')) $('crew-input').value = v.crew || '';
    $('crew-status').textContent = v.crewStatus;
    paintPublic(v);
    const ready = v.players.filter(active).length;
    $('start-btn').disabled = ready < 2;
    $('start-note').textContent = ready < 2 ? 'You need at least 2 players. Copy the invite link and send it round.' : '';
  } else {
    $('settings-summary').innerHTML = settingsLines(st) + (v.crew ? `<li>Crew: <b>${esc(v.crew)}</b></li>` : '') + `<li>${publicLine(v)}</li>`;
  }
}

$('copy-link').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${S.code}`;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); } catch { toast(url); }
});
function roomSetCrew(rawName) {
  const name = String(rawName || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (name && name.toLowerCase().replace(/[^a-z0-9]/g, '').length < 3) return toast('Crew names need at least 3 letters or numbers');
  store.set('crew', name);
  toHost({ t: 'crew', name });
}
$('crew-save').addEventListener('click', () => roomSetCrew($('crew-input').value));
$('crew-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') roomSetCrew($('crew-input').value); });
wirePublic(toHost);
$('start-btn').addEventListener('click', () => {
  if (S.isHost) toHost({ t: 'start', crew: $('crew-input').value.replace(/\s+/g, ' ').trim() });
});
$('leave-lobby').addEventListener('click', () => { closeRoom(); goHome(); });

/* =========================================================
   Home
   ========================================================= */
const BOLT = '<path d="M13 2 3 14h7l-1 8 10-12h-7z"/>';
function logoHtml() {
  const tile = (ch, i, lit) => `<span class="lg-tile${lit ? ' lit' : ''}" style="--i:${i}">${ch}</span>`;
  return `${tile('A', 0)}<span class="lg-to">to</span>${tile('Z', 2, true)}${tile('A', 3)}${tile('P', 4)}<svg class="lg-bolt" viewBox="0 0 24 24">${BOLT}</svg>`;
}

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
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
// Quick Play: a public room that's waiting for players, or a new public one
$('quick-btn').addEventListener('click', async () => {
  const name = readName();
  if (!name) return;
  homeError('');
  closeRoom();
  S.myName = name;
  setBusy(true);
  try {
    const code = await quickPlay('a-to-zap');
    if (code) link.join(code);
    else { S.creating = true; link.host(true); }
  } catch (err) {
    setBusy(false);
    homeError(err.message);
  }
});

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
// Delete my data clears the shared things itself; the names and crews this game saved in the browser go too
cloud.mountDeleteData($('delete-data'), { onDone: () => { store.remove('name'); store.remove('crew'); $('name-input').value = ''; renderSettings(); } });

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
        <div><b>${st.wins}</b><span>Wins</span></div>
        <div><b>${st.rounds}</b><span>Rounds</span></div>
        <div><b>${st.points}</b><span>Points</span></div>
        <div><b>${st.unique}</b><span>10-point answers</span></div>
        <div><b>${st.bestRound}</b><span>Best round</span></div>
      </div>`;
  } catch (err) {
    $('my-stats').innerHTML = `<p class="muted">${esc(cloud.errorText(err))}</p>`;
  }
}
$('sound-toggle').addEventListener('change', (e) => { PREFS.sound = e.target.checked; savePrefs(); if (PREFS.sound) SOUND.tick(); });
$('analytics-toggle').addEventListener('change', (e) => {
  PREFS.analytics = e.target.checked;
  savePrefs();
  cloud.setAnalyticsEnabled(e.target.checked);
});

// Test hook: with ?debug in the address, automated tests can inspect the state.
if (new URLSearchParams(location.search).has('debug')) window.__atozap = { S, A, E, link };

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
  showScreen('home');
  cloud.onUser((u) => { renderAccount(u); });
  cloud.initAnalytics(PREFS.analytics !== false);
  cloud.restore();
})();
