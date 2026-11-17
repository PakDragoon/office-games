import * as E from './engine.js';
import * as cloud from './cloud.js';
import { createRoomLink, quickPlay } from '../../shared/net.js';
import { markInvite } from '../../shared/invite.js';
import { wirePublic, paintPublic, publicLine } from '../../shared/public.js';

/* =========================================================
   Alzheimer's
   1 vs 1. You each write 12 things for the other; their words flash one at a time and you doodle each in
   its own box; then the words come back in a random order and you tap the box you drew each one in.
   The game runs on the server (server/src/games/alzheimers.ts): it sends you a word only while it is on
   screen, keeps your drawing and scores every tap. This page draws what it is sent and passes on what you do.
   ========================================================= */

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  if (parent) parent.append(n);
  return n;
};
const secs = (ms) => `${Math.round(ms / 100) / 10} s`;

/* ---------- This browser only ---------- */
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`alzheimers.${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`alzheimers.${key}`, JSON.stringify(value)); } catch { /* not saved */ }
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

// A short blip when a word appears
let audio = null;
function blip() {
  if (!PREFS.sound) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 760;
    o.type = 'sine';
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.22);
  } catch { /* no sound */ }
}

/* =========================================================
   State and the room on the server
   ========================================================= */
const S = {
  myName: '', myId: null, isHost: false, code: '', view: null, reconnecting: false, creating: false,
  game: 0,            // which round the local state belongs to
  mine: [],           // my strokes this round: [{ b, pts }]
  wordsSent: '',      // the last draft of my 12 words sent to the server
  drawStartAt: 0,     // performance.now() when the first word appears
  flashKey: '',       // the word on screen right now (round:index)
  picking: false,     // a tap is on its way to the server
  revealed: {},       // test: box -> the word that turned out to be in it
  boards: null,       // result: both drawings with their words
  endAt: 0,
};

const link = createRoomLink('alzheimers', {
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
  stopTimers();
  Object.assign(S, { view: null, isHost: false, code: '', reconnecting: false, creating: false, game: 0, mine: [], boards: null, revealed: {} });
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
      $('write-error').textContent = String(msg.reason || '').slice(0, 80);
      break;
    case 'toast':
      toast(String(msg.text || ''));
      break;
    case 'drawing':
      // Back after a refresh (this arrives just before the room's state): my own strokes so far
      S.game = msg.game;
      S.mine = Array.isArray(msg.mine) ? msg.mine : [];
      drawMine();
      break;
    case 'picked':
      onPicked(msg);
      break;
    case 'drawings':
      S.boards = msg;
      if (S.view && S.view.status === 'result') renderResult(S.view);
      break;
    case 'state':
      applyState(msg);
      break;
    default:
  }
}

const me = (v) => v.players.find((p) => p.id === S.myId);
const opponent = (v) => v.players.find((p) => p.id !== S.myId && p.inGame) || v.players.find((p) => p.id !== S.myId);

function applyState(v) {
  const prev = S.view;
  S.view = v;
  const mine = me(v);
  if (!mine) return;
  S.isHost = Boolean(mine.isHost);
  S.code = v.code;
  if (S.creating && S.isHost) {
    S.creating = false;
    sendSettings();
    const savedCrew = store.get('crew', '');
    if (savedCrew) hostSetCrew(savedCrew);
  }
  if (v.game !== S.game) {
    // A new round: a clean sheet
    Object.assign(S, { game: v.game, mine: [], wordsSent: '', flashKey: '', picking: false, revealed: {}, boards: null });
    $('write-error').textContent = '';
    writeInputs().forEach((i) => { i.value = ''; });
  }
  if (v.status === 'lobby') {
    stopTimers();
    renderLobby(v);
    if ($('lobby').hidden) showScreen('lobby');
    return;
  }
  if ($('game').hidden) showScreen('game');
  renderGame(v, prev);
}

/* =========================================================
   Clock in the bar
   ========================================================= */
let clockTimer = 0;
function stopTimers() {
  clearInterval(clockTimer);
  clockTimer = 0;
  $('round-clock').hidden = true;
  S.endAt = 0;
}
function tick() {
  if (S.endAt) {
    const left = Math.max(0, S.endAt - performance.now());
    const s = Math.ceil(left / 1000);
    $('round-clock-text').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    $('round-clock').classList.toggle('urgent', left <= 10000);
  }
  if (S.view && S.view.status === 'draw') drawTick();
}
function setClock(v) {
  S.endAt = v.endsIn > 0 && v.status !== 'result' ? performance.now() + v.endsIn : 0;
  $('round-clock').hidden = !S.endAt;
  if (!clockTimer) clockTimer = setInterval(tick, 200);
  tick();
}

/* =========================================================
   The sheet of 12 boxes (SVG, 800 × 600, scaled to the screen)
   ========================================================= */
function makeBoard(host, { numbers = true } = {}) {
  host.querySelectorAll('svg.board').forEach((n) => n.remove());
  const svg = svgEl('svg', { viewBox: `0 0 ${E.BOARD.w} ${E.BOARD.h}`, class: 'board', role: 'img' });
  const hl = svgEl('g', {}, svg);
  for (let c = 1; c < E.COLS; c++) svgEl('line', { x1: c * E.BOARD.box, y1: 0, x2: c * E.BOARD.box, y2: E.BOARD.h, class: 'grid-line' }, svg);
  for (let r = 1; r < E.ROWS; r++) svgEl('line', { x1: 0, y1: r * E.BOARD.box, x2: E.BOARD.w, y2: r * E.BOARD.box, class: 'grid-line' }, svg);
  if (numbers) {
    for (let i = 0; i < E.BOXES; i++) {
      const { x, y } = E.boxXY(i);
      svgEl('text', { x: x + 12, y: y + 26, class: 'box-n' }, svg).textContent = String(i + 1);
    }
  }
  const ink = svgEl('g', {}, svg);
  const over = svgEl('g', {}, svg);
  const hits = svgEl('g', {}, svg);
  host.prepend(svg);
  return { svg, hl, ink, over, hits };
}

const pathOf = (pts) => {
  if (pts.length < 2) return '';
  let d = `M${pts[0]} ${pts[1]}`;
  for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
  if (pts.length === 2) d += `l0.1 0`;   // a dot
  return d;
};
function inkStrokes(layer, strokes) {
  layer.replaceChildren();
  for (const s of strokes) svgEl('path', { d: pathOf(s.pts), class: 'ink' }, layer);
}
function boxRect(layer, i, cls) {
  const { x, y } = E.boxXY(i);
  return svgEl('rect', { x: x + 4, y: y + 4, width: E.BOARD.box - 8, height: E.BOARD.box - 8, rx: 10, class: cls }, layer);
}
function boxLabel(layer, i, text, mark) {
  const { x, y } = E.boxXY(i);
  const w = Math.min(E.BOARD.box - 16, 22 + text.length * 9.5);
  svgEl('rect', { x: x + (E.BOARD.box - w) / 2, y: y + E.BOARD.box - 36, width: w, height: 28, rx: 8, class: 'label-bg' }, layer);
  svgEl('text', { x: x + E.BOARD.box / 2, y: y + E.BOARD.box - 16, 'text-anchor': 'middle', class: 'label' }, layer).textContent = text.length > 16 ? `${text.slice(0, 15)}…` : text;
  if (mark) svgEl('text', { x: x + E.BOARD.box - 14, y: y + 30, 'text-anchor': 'end', class: `mark ${mark}` }, layer).textContent = mark === 'right' ? '✓' : '✗';
}
const toBoard = (svg, e) => new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());

/* =========================================================
   The game screen
   ========================================================= */
const PHASE = { write: 'Write 12 things', draw: 'Draw', test: 'Remember', result: 'Result' };

function renderGame(v, prev) {
  const mine = me(v);
  const playing = mine.inGame;
  $('bar-code').textContent = v.code;
  $('bar-phase').textContent = playing ? PHASE[v.status] || '' : 'Watching';
  ['write', 'draw', 'test', 'result'].forEach((s) => { $(`st-${s}`).hidden = v.status !== s; });
  setClock(v);
  renderSide(v);
  if (v.status === 'write') renderWrite(v);
  if (v.status === 'draw') renderDraw(v, prev);
  if (v.status === 'test') renderTest(v, prev);
  if (v.status === 'result') renderResult(v);
}

function renderSide(v) {
  const status = (p) => {
    if (!active(p)) return ['', 'Away'];
    if (!p.inGame) return ['', 'Watching'];
    if (v.status === 'write') return p.ready ? ['done', 'Ready ✓'] : ['', `${p.written} of 12`];
    if (v.status === 'draw') return ['', 'Drawing'];
    if (v.status === 'test') return p.answered >= E.BOXES ? ['done', 'Done ✓'] : ['', `${p.answered} of 12`];
    return ['', `${p.points} right`];
  };
  $('who-list').innerHTML = v.players.map((p) => {
    const [cls, text] = status(p);
    return `<li class="pc${p.color}${active(p) ? '' : ' off'}"><span class="pen-dot"></span>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}<span class="st ${cls}">${esc(text)}</span></li>`;
  }).join('');
  $('score-list').innerHTML = [...v.players].sort((a, b) => b.score - a.score)
    .map((p) => `<li class="pc${p.color}"><span class="pen-dot"></span>${esc(p.name)}<b>${p.score}</b></li>`).join('');
}

/* ---------- Writing the 12 words ---------- */
$('write-grid').innerHTML = Array.from({ length: E.BOXES }, (_, i) =>
  `<label><span class="sr-only">Thing ${i + 1}</span><input class="text-input" maxlength="${E.WORD.maxChars}" autocomplete="off" autocapitalize="off" spellcheck="false" data-i="${i}"></label>`).join('');
const writeInputs = () => [...$('write-grid').querySelectorAll('input')];
const writeList = () => writeInputs().map((i) => i.value);

function renderWrite(v) {
  const mine = me(v);
  const opp = opponent(v);
  $('write-for').textContent = opp ? opp.name : 'your opponent';
  const ready = Boolean(mine.ready);
  // After a refresh, put back the draft the server kept (never over what's being typed)
  if (writeInputs().every((i) => !i.value) && v.myWords?.some(Boolean)) writeInputs().forEach((i, k) => { i.value = v.myWords[k] || ''; });
  writeInputs().forEach((i) => { i.disabled = ready || !mine.inGame; });
  $('fill-btn').disabled = ready || !mine.inGame;
  $('ready-btn').textContent = ready ? 'Edit my words' : 'I’m ready';
  $('ready-btn').disabled = !mine.inGame;
  markDuplicates();
}

function markDuplicates() {
  const keys = writeList().map(E.wordKey);
  writeInputs().forEach((i, k) => i.classList.toggle('dup', Boolean(keys[k]) && keys.indexOf(keys[k]) !== k));
}

let draftTimer = 0;
function sendDraft(ready = false) {
  const list = writeList();
  const key = JSON.stringify([list, ready]);
  if (key === S.wordsSent) return;
  S.wordsSent = key;
  toHost({ t: 'words', list, ready });
}
$('write-grid').addEventListener('input', () => {
  $('write-error').textContent = '';
  markDuplicates();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => sendDraft(false), 700);
});
$('write-grid').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const inputs = writeInputs();
  const next = inputs[inputs.indexOf(e.target) + 1];
  if (next) next.focus();
  else $('ready-btn').click();
});
$('fill-btn').addEventListener('click', () => {
  const list = writeList();
  const extra = E.suggestions(Math.random, E.BOXES, list.filter(Boolean));
  writeInputs().forEach((i) => { if (!E.cleanWord(i.value)) i.value = extra.shift(); });
  markDuplicates();
  sendDraft(false);
});
$('ready-btn').addEventListener('click', () => {
  const mine = S.view && me(S.view);
  if (!mine) return;
  clearTimeout(draftTimer);
  if (mine.ready) return sendDraft(false);
  const problem = E.wordsProblem(writeList());
  if (problem) { $('write-error').textContent = problem; return; }
  sendDraft(true);
});

/* ---------- Drawing as the words flash ---------- */
let drawBoard = null;
let pen = null;   // the stroke being drawn: { b, pts, el }

function drawWindowOpen() {
  const v = S.view;
  return Boolean(v && v.status === 'draw' && me(v)?.inGame && performance.now() >= S.drawStartAt);
}

function renderDraw(v, prev) {
  if (!drawBoard || !drawBoard.svg.isConnected || (prev && prev.status !== 'draw')) {
    drawBoard = makeBoard($('draw-wrap'));
    drawBoard.svg.classList.add('drawing');
    wirePen(drawBoard.svg);
    $('progress').innerHTML = Array.from({ length: E.BOXES }, () => '<i></i>').join('');
  }
  S.drawStartAt = performance.now() + v.drawStartsIn;
  drawMine();
  // A word on screen: show it until its moment is over
  if (v.word && v.index >= 0) {
    const key = `${v.game}:${v.index}`;
    if (S.flashKey !== key) {
      S.flashKey = key;
      $('flash-k').textContent = `Box ${v.index + 1}`;
      $('flash-word').textContent = v.word;
      $('flash').hidden = false;
      $('flash').classList.remove('pop');
      void $('flash').offsetWidth;
      $('flash').classList.add('pop');
      blip();
      clearTimeout(S.flashTimer);
      S.flashTimer = setTimeout(() => { $('flash').hidden = true; }, Math.max(200, v.shownFor));
    }
  }
  drawTick();
}

function drawMine() {
  if (drawBoard) inkStrokes(drawBoard.ink, S.mine);
}

// Runs a few times a second while drawing: the 3-2-1, which box is lit, the progress bar and the status line
function drawTick() {
  const v = S.view;
  if (!v || !drawBoard) return;
  const since = performance.now() - S.drawStartAt;
  const idx = E.wordIndex(since, v.settings.pace);
  $('countdown').hidden = since >= 0;
  if (since < 0) $('countdown').textContent = String(Math.ceil(-since / 1000));
  drawBoard.hl.replaceChildren();
  if (idx >= 0) boxRect(drawBoard.hl, idx, 'box-hl');
  $('progress').querySelectorAll('i').forEach((el, i) => { el.className = i < idx ? 'done' : i === idx ? 'now' : ''; });
  const left = E.drawLength(v.settings.pace) - since;
  $('draw-status').textContent = since < 0 ? 'Get ready…'
    : idx < E.BOXES - 1 ? `Word ${idx + 1} of ${E.BOXES}`
      : left > 0 ? `Last word: ${Math.ceil(left / 1000)} s to finish` : 'Pens down!';
  if (left <= 0 && pen) endStroke();
}

function wirePen(svg) {
  svg.addEventListener('pointerdown', (e) => {
    if (!drawWindowOpen()) return;
    const p = toBoard(svg, e);
    const b = E.boxAt(p.x, p.y);
    if (b < 0) return;
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const pts = E.cleanStroke(b, [p.x, p.y]);
    pen = { b, pts, el: svgEl('path', { d: pathOf(pts), class: 'ink' }, drawBoard.ink) };
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pen) return;
    const p = toBoard(svg, e);
    const [x, y] = E.cleanStroke(pen.b, [p.x, p.y]);
    const lx = pen.pts[pen.pts.length - 2], ly = pen.pts[pen.pts.length - 1];
    if (Math.hypot(x - lx, y - ly) < 3 || pen.pts.length >= E.INK.perStroke) return;
    pen.pts.push(x, y);
    pen.el.setAttribute('d', pathOf(pen.pts));
  });
  const up = () => endStroke();
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
}

function endStroke() {
  if (!pen) return;
  const s = { b: pen.b, pts: pen.pts };
  pen = null;
  S.mine.push(s);
  toHost({ t: 'stroke', b: s.b, pts: s.pts });
}

$('undo-btn').addEventListener('click', () => {
  if (!S.view || S.view.status !== 'draw' || !S.mine.length) return;
  S.mine.pop();
  drawMine();
  toHost({ t: 'undo' });
});

/* ---------- The memory test ---------- */
let testBoard = null;

function renderTest(v, prev) {
  if (!testBoard || !testBoard.svg.isConnected || (prev && prev.status !== 'test')) {
    testBoard = makeBoard($('test-wrap'));
    testBoard.svg.classList.add('picking');
    for (let i = 0; i < E.BOXES; i++) {
      const r = boxRect(testBoard.hits, i, 'box-hit');
      r.dataset.b = String(i);
    }
    testBoard.svg.addEventListener('click', (e) => {
      const r = e.target.closest('.box-hit');
      if (r) pick(Number(r.dataset.b));
    });
    $('feedback').textContent = '';
    $('feedback').className = 'feedback';
  }
  inkStrokes(testBoard.ink, S.mine);
  // Words already placed: their right box gets its label, so you can rule it out
  for (const a of v.myAnswers) S.revealed[a.box] ??= null;
  paintRevealed();
  const q = v.question;
  const mine = me(v);
  if (!mine.inGame) {
    $('test-word').textContent = '';
    $('test-n').textContent = '';
    $('feedback').textContent = 'You’re watching this round.';
  } else if (q) {
    $('test-word').textContent = q.word;
    $('test-n').textContent = `${q.q + 1} of ${E.BOXES}`;
  } else {
    $('test-word').textContent = 'all done';
    $('test-n').textContent = '';
    const right = v.myAnswers.filter((a) => a.right).length;
    $('feedback').textContent = `${right} of ${E.BOXES} right. Waiting for ${opponent(v)?.name || 'the other player'}…`;
    $('feedback').className = 'feedback';
  }
}

function paintRevealed() {
  if (!testBoard) return;
  testBoard.over.replaceChildren();
  for (const [b, word] of Object.entries(S.revealed)) {
    boxRect(testBoard.over, Number(b), 'box-used');
    if (word) boxLabel(testBoard.over, Number(b), word);
  }
}

function pick(b) {
  const v = S.view;
  if (!v || v.status !== 'test' || !v.question || S.picking || !me(v).inGame) return;
  S.picking = true;
  toHost({ t: 'pick', q: v.question.q, b });
}

function onPicked(msg) {
  S.picking = false;
  S.revealed[msg.box] = msg.word;
  paintRevealed();
  $('feedback').textContent = msg.right ? `Right! “${msg.word}” was in box ${msg.box + 1}.` : `No, “${msg.word}” was in box ${msg.box + 1}.`;
  $('feedback').className = `feedback ${msg.right ? 'right' : 'wrong'}`;
  if (testBoard) {
    const flash = boxRect(testBoard.over, msg.box, msg.right ? 'box-right' : 'box-wrong');
    setTimeout(() => flash.remove(), 800);
  }
}

/* ---------- The result ---------- */
function renderResult(v) {
  const players = v.players.filter((p) => p.inGame);
  const winner = players.find((p) => p.id === v.winner);
  $('result-title').textContent = winner ? (winner.id === S.myId ? 'You win the round!' : `${winner.name} wins the round`) : 'It’s a tie!';
  $('result-sub').textContent = players.map((p) => `${p.name}: ${p.points} of ${E.BOXES} right, ${p.answers.length < E.BOXES ? 'ran out of time' : `in ${secs(p.ms)}`}`).join(' · ');
  const boards = S.boards?.game === v.game ? S.boards.boards : [];
  const host = $('result-boards');
  host.innerHTML = '';
  for (const p of [...players].sort((a, b) => (a.id === S.myId ? -1 : b.id === S.myId ? 1 : 0))) {
    const fig = document.createElement('figure');
    fig.innerHTML = `<figcaption class="pc${p.color}"><span class="pen-dot"></span>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}<span class="pts">${p.points} right</span></figcaption>`;
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    fig.appendChild(wrap);
    host.appendChild(fig);
    const board = makeBoard(wrap, { numbers: false });
    const b = boards.find((x) => x.id === p.id);
    if (b) {
      inkStrokes(board.ink, b.strokes);
      const tapped = Object.fromEntries((p.answers || []).map((a) => [a.i, a.b]));
      b.words.forEach((w, i) => boxLabel(board.over, i, w, tapped[i] === i ? 'right' : 'wrong'));
    }
  }
  $('again-btn').hidden = !S.isHost;
  $('to-lobby').hidden = !S.isHost;
  $('result-wait').hidden = S.isHost;
  $('crew-line').textContent = v.crewName ? `${v.crewName}: ${v.crewStatus}` : '';
}
$('again-btn').addEventListener('click', () => { if (S.isHost) toHost({ t: 'begin' }); });
$('to-lobby').addEventListener('click', () => { if (S.isHost) toHost({ t: 'lobby' }); });
$('quit-btn').addEventListener('click', () => { closeRoom(); goHome(); });

/* =========================================================
   Lobby
   ========================================================= */
for (const [id, key] of [['set-pace', 'pace'], ['set-flash', 'flash']]) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    ROOM_PREFS[key] = Number(b.dataset.value);
    roomSettingsChanged();
  });
}
function roomSettingsChanged() {
  saveRoomPrefs();
  paintRoomSettings();
  sendSettings();
}
function paintRoomSettings() {
  $('set-pace').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.value) === ROOM_PREFS.pace)));
  $('set-flash').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.value) === ROOM_PREFS.flash)));
}

function renderLobby(v) {
  $('lobby-code').textContent = v.code;
  const rows = v.players.map((p) => `
    <li class="pc${p.color}${active(p) ? '' : ' off'}"><span class="pen-dot"></span>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}
      <span class="tag">${p.isHost ? 'Host' : !active(p) ? 'Reconnecting' : ''}</span></li>`);
  if (v.players.length < E.PLAYERS) rows.push('<li class="empty">Waiting for a friend to join…</li>');
  $('lobby-players').innerHTML = rows.join('');
  $('host-settings').hidden = !S.isHost;
  $('guest-settings').hidden = S.isHost;
  if (S.isHost) {
    paintRoomSettings();
    if (document.activeElement !== $('crew-input')) $('crew-input').value = v.crewName;
    $('crew-status').textContent = v.crewStatus;
    paintPublic(v);
    const ready = v.players.filter((p) => p.connected).length;
    $('start-btn').disabled = ready !== E.PLAYERS;
    $('start-note').textContent = ready < E.PLAYERS ? 'Needs 2 players to start.' : '';
  } else {
    $('settings-summary').innerHTML = `<li><b>A new word every ${v.settings.pace} s</b></li><li>Each word shows for ${v.settings.flash / 1000} s</li>`
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
    homeError('Type your name first so your opponent knows who you are.');
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
  stopTimers();
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
$('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && $('code-input').value.trim()) join(); });

// Quick Play: a public room waiting for a second player, or a new public one
$('quick-btn').addEventListener('click', async () => {
  const name = readName();
  if (!name) return;
  homeError('');
  S.myName = name;
  setBusy(true);
  try {
    const code = await quickPlay('alzheimers');
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
        <div><b>${st.best || '–'}</b><span>Best (of 12)</span></div>
        <div><b>${st.perfect}</b><span>Perfect rounds</span></div>
        <div><b>${st.points}</b><span>Boxes right</span></div>
        <div><b>${st.games ? Math.round((st.points / st.games) * 10) / 10 : '–'}</b><span>Average</span></div>
      </div>`;
  } catch (err) {
    $('my-stats').innerHTML = `<p class="muted">${esc(cloud.errorText(err))}</p>`;
  }
}
$('sound-toggle').addEventListener('change', (e) => { PREFS.sound = e.target.checked; savePrefs(); if (PREFS.sound) blip(); });
$('analytics-toggle').addEventListener('change', (e) => {
  PREFS.analytics = e.target.checked;
  savePrefs();
  cloud.setAnalyticsEnabled(e.target.checked);
});

// Test hook: with ?debug in the address, automated tests can inspect what this player was sent and talk to the room
if (new URLSearchParams(location.search).has('debug')) window.__alzheimers = { S, link };

/* =========================================================
   Start
   ========================================================= */
(function init() {
  const saved = store.get('name', '');
  if (saved) $('name-input').value = saved;
  const room = new URLSearchParams(location.search).get('room');
  if (room && /^[A-Za-z]{4}$/.test(room)) {
    $('code-input').value = room.toUpperCase();
    markInvite(room.toUpperCase());
    ($('name-input').value ? $('join-btn') : $('name-input')).focus();
  }
  showScreen('home');
  cloud.onUser((u) => renderAccount(u));
  cloud.initAnalytics(PREFS.analytics !== false);
  cloud.restore();
})();
