import * as cloud from './cloud.js';
import { createRoomLink, quickPlay } from '../../shared/net.js';
import { wirePublic, paintPublic, publicLine } from '../../shared/public.js';
import * as E from './engine.js';

/* =========================================================
   Lettuce Party
   The game runs on the server (server/src/games/lettuce.ts): it picks the
   word, checks every guess and sends everyone the colour patterns (Classic),
   the three counts (Counts) or step counts (Word ladder).
   Nobody receives the word or anyone else's letters until the round ends.
   ========================================================= */

const MAX_PLAYERS = 5;
const COLS = 5;
const LADDER_STEPS_SHOWN = 5;   // the ladder board shows the start, your latest steps, and the target
const LADDER_ROWS = LADDER_STEPS_SHOWN + 2;

const MODE_NAMES = { classic: 'Classic', counts: 'Counts', ladder: 'Word ladder' };
const MODE_BLURBS = {
  classic: 'Everyone gets the same secret word. Tiles turn green, yellow or grey after each guess.',
  counts: 'Same secret word, but no tile colors: after each guess you only get three numbers, how many letters are in the right place, in the wrong place, and not in the word.',
  ladder: 'Everyone gets the same start word and target word. Change one letter at a time, every step a real word, until you reach the target.',
};

/* ---------- Preferences (this device only) ---------- */
const PREFS = { sound: true, contrast: false, analytics: true };
try { Object.assign(PREFS, JSON.parse(localStorage.getItem('wordleparty-prefs') || '{}')); } catch {}
function savePrefs() {
  try { localStorage.setItem('wordleparty-prefs', JSON.stringify(PREFS)); } catch {}
  document.body.classList.toggle('contrast', PREFS.contrast);
}

let audio = null;
function sfx(kind) {
  if (!PREFS.sound) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const notes = { rival: [660], win: [523, 659, 784], tick: [880], over: [440, 330] }[kind] || [];
    notes.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      const t = audio.currentTime + i * 0.12;
      o.frequency.value = f;
      o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + 0.2);
    });
  } catch {}
}

const WIN_RULES = {
  first: 'First to solve it wins.',
  fewest: 'Fewest guesses wins, and the faster time breaks ties.',
};
const LADDER_WIN_RULES = {
  first: 'First to reach the target wins.',
  fewest: 'Fewest steps wins, and the faster time breaks ties.',
};
const winRules = (v) => (v.mode === 'ladder' ? LADDER_WIN_RULES : WIN_RULES);
const rowsOf = (mode, attempts) => (mode === 'ladder' ? LADDER_ROWS : attempts || E.ATTEMPTS.default);
const CLASS = { h: 'hit', n: 'near', m: 'miss' };
const RANK = { miss: 1, near: 2, hit: 3 };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);

/* ---------- state every player keeps ---------- */
const S = {
  myId: null,
  myName: '',
  isHost: false,
  code: null,
  creating: false,
  view: null,          // latest room state from the server
  roundShown: 0,       // which round my board was built for
  mode: 'classic',     // the mode my board was built for
  attempts: 6,
  guesses: [],         // my guesses: [{ word, pattern }] (Classic), [{ word, counts }] (Counts), [{ word }] (Ladder)
  current: '',
  pending: false,      // waiting for the server to score my guess
  keyState: {},
  seenRows: {},        // rival id -> rows already drawn (for the pop animation)
  localStart: 0,
  localStartRound: 0,
  resultsClosedRound: 0,
};

/* =========================================================
   The room on the server
   ========================================================= */
const link = createRoomLink('lettuce-party', {
  hello: () => {
    const u = cloud.currentUser();
    return { name: S.myName, photo: u?.photo || '' };
  },
  message: onMessage,
  reconnecting: () => toast('Connection lost. Reconnecting…'),
  gone: (reason) => {
    resetLocal();
    showScreen('home');
    showNotice('The room closed', reason || 'Everyone left, so the room was closed. Host a new one.');
  },
  failed: (text) => {
    resetLocal();
    setBusy(false);
    showScreen('home');
    homeError(text);
  },
});

const send = (msg) => link.send(msg);

// The host's controls: the server only acts on them from whoever is host right now
const hostSettings = (patch) => send({ t: 'settings', patch });
function hostSetCrew(rawName) {
  const name = String(rawName || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (name && name.toLowerCase().replace(/[^a-z0-9]/g, '').length < 3) return toast('Crew names need at least 3 letters or numbers');
  try { localStorage.setItem('wordleparty-crew', name); } catch {}
  send({ t: 'crew', name });
}
function hostStartGame() {
  send({ t: 'start', crew: $('crew-input').value.replace(/\s+/g, ' ').trim() });
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
      cloud.track('room_joined');
      setBusy(false);
      break;
    case 'toast':
      toast(String(msg.text || ''));
      break;
    case 'reject':
      setBusy(false);
      link.close();
      resetLocal();
      showScreen('home');
      homeError(msg.reason);
      break;
    case 'board':
      // Coming back after a disconnect: redraw my earlier guesses.
      S.roundShown = msg.round;
      S.mode = MODE_NAMES[msg.mode] ? msg.mode : 'classic';
      S.attempts = msg.attempts || E.ATTEMPTS.default;
      S.guesses = msg.guesses;
      S.current = '';
      S.pending = false;
      buildBoard();
      buildKeyboard();
      S.guesses.forEach((g, r) => paintGuess(r, g, false));
      renderMarks();
      updateKeyboard();
      drawLadder();
      break;
    case 'state':
      applyState(msg);
      break;
    case 'result':
      onResult(msg);
      break;
    case 'invalid':
      S.pending = false;
      shakeRow(S.guesses.length);
      toast(msg.reason);
      drawLadder();
      break;
  }
}

function applyState(v) {
  const prev = S.view;
  S.view = v;
  const mine = v.players.find((p) => p.id === S.myId);
  S.isHost = Boolean(mine && mine.isHost);
  S.code = v.code;
  if (S.creating && S.isHost) {
    // A room we just opened: bring this browser's saved crew
    S.creating = false;
    let savedCrew = '';
    try { savedCrew = localStorage.getItem('wordleparty-crew') || ''; } catch {}
    if (savedCrew) hostSetCrew(savedCrew);
  }

  if (v.status === 'lobby') {
    showScreen('lobby');
    renderLobby(v);
    return;
  }

  if (v.round !== S.roundShown) startLocalRound(v);
  if (S.localStartRound !== v.round) {
    S.localStart = Date.now() - v.elapsed;
    S.localStartRound = v.round;
  }

  showScreen('game');
  drawLadder();
  renderMarks();
  $('game-code').textContent = v.code;
  $('game-round').textContent = v.maxRounds ? `Round ${v.matchRound} of ${v.maxRounds}` : `Round ${v.matchRound}`;
  renderRivals(v);
  renderScores(v);
  announceRivals(prev, v);
  tickClock();

  const roundOver = v.status === 'ended' || v.status === 'over';
  $('results-btn').hidden = !roundOver;
  $('endround-btn').hidden = !(S.isHost && v.status === 'playing');
  if (prev && prev.status === 'playing' && roundOver && prev.round === v.round) {
    const m = me();
    if (m && m.timedOut) toast('Time’s up!');
    else if (m && m.stopped) toast('The host ended the round.');
  }
  if (roundOver && prev && prev.status === 'playing') sfx('over');
  if (roundOver) trackMyRound(v);
  if (roundOver) {
    if (S.resultsClosedRound !== v.round || (v.status === 'over' && prev && prev.status !== 'over')) showResults(v);
  } else {
    $('results').hidden = true;
  }
}

// Every player (signed in or not) logs their own round once, for analytics.
function trackMyRound(v) {
  const m = me();
  if (!m || S.trackedRound === v.round || !v.word) return;
  if (!m.done && m.used === 0) return;
  S.trackedRound = v.round;
  cloud.track('round_played', { solved: m.solved ? 1 : 0, guesses: m.used, mode: v.mode });
}


function startLocalRound(v) {
  S.roundShown = v.round;
  S.mode = v.mode;
  S.attempts = v.attempts;
  forgetMarks(S.marksKey);
  S.guesses = [];
  S.current = '';
  S.pending = false;
  S.seenRows = {};
  S.resultsClosedRound = 0;
  buildBoard();
  buildKeyboard();
}

function me() {
  return S.view?.players.find((p) => p.id === S.myId);
}

/* =========================================================
   My board
   ========================================================= */
function buildBoard() {
  const board = $('my-board');
  const rows = rowsOf(S.mode, S.attempts);
  board.innerHTML = '';
  board.className = `board ${S.mode}`;
  const arena = $('screen-game').querySelector('.arena');
  arena.style.setProperty('--rows', String(rows));
  // Past six rows the tiles are allowed to get smaller so the board and keyboard still fit without scrolling
  arena.style.setProperty('--tile-min', rows > 6 ? '20px' : '');
  arena.style.setProperty('--note', S.mode === 'classic' ? '0px' : '30px');
  arena.classList.toggle('many', rows > 6);
  arena.classList.remove('classic', 'counts', 'ladder');
  arena.classList.add(S.mode);
  paintBoardNote();
  if (S.mode === 'ladder') return drawLadder();
  loadMarks();
  for (let r = 0; r < rows; r++) {
    const row = document.createElement('div');
    row.className = `row ${S.mode}`;
    for (let c = 0; c < COLS; c++) {
      // Counts: each tile is a button once its row is submitted (my own letter notes); until then it is disabled
      const t = document.createElement(S.mode === 'counts' ? 'button' : 'div');
      if (S.mode === 'counts') Object.assign(t, { type: 'button', disabled: true });
      t.className = 'tile';
      row.appendChild(t);
    }
    if (S.mode === 'counts') {
      const boxes = document.createElement('div');
      boxes.className = 'cboxes';
      for (const kind of COUNT_KINDS) boxes.appendChild(countBox(kind, null));
      row.appendChild(boxes);
    }
    board.appendChild(row);
  }
}

/* ---------- Counts: three boxes beside each row ---------- */
const COUNT_KINDS = [
  { cls: 'hit', one: 'right place', title: (n) => `${n} right place` },
  { cls: 'near', one: 'wrong place', title: (n) => `${n} wrong place` },
  { cls: 'red', one: 'not in the word', title: (n) => `${n} not in the word` },
];

/** One count box. The number is inside, and the title / aria label say what it means (never colour alone). */
function countBox(kind, n) {
  const b = document.createElement('span');
  b.className = `cbox ${kind.cls}` + (n == null ? ' empty' : '');
  if (n == null) {
    b.setAttribute('aria-hidden', 'true');
  } else {
    b.textContent = String(n);
    b.title = kind.title(n);
    b.setAttribute('aria-label', kind.title(n));
  }
  return b;
}

function paintBoardNote() {
  const note = $('board-note');
  note.innerHTML = '';
  note.hidden = S.mode === 'classic';
  if (S.mode === 'counts') {
    note.className = 'board-note legend';
    for (const k of COUNT_KINDS) {
      const item = document.createElement('span');
      const sw = document.createElement('i');
      sw.className = k.cls;
      sw.setAttribute('aria-hidden', 'true');
      item.append(sw, k.one);
      note.appendChild(item);
    }
  }
}

function rowEl(r) {
  return $('my-board').children[r];
}

function drawCurrent() {
  if (S.mode === 'ladder') return drawLadder();
  const row = rowEl(S.guesses.length);
  if (!row) return;
  [...row.querySelectorAll('.tile')].forEach((t, i) => {
    const ch = S.current[i] || '';
    t.textContent = ch;
    t.className = 'tile' + (ch ? ' filled' : '');
  });
}

/** Draw one of my guesses on its row. Classic: coloured tiles. Counts: plain tiles plus the three boxes. */
function paintGuess(r, g, animate) {
  if (S.mode === 'ladder') return;
  if (S.mode === 'counts') return paintCounts(r, g.word, g.counts, animate);
  paintRow(r, g.word, g.pattern, animate);
}

function paintRow(r, word, pattern, animate) {
  const row = rowEl(r);
  if (!row) return;
  [...row.children].forEach((t, i) => {
    t.textContent = word[i];
    const cls = CLASS[pattern[i]];
    if (!animate || reduceMotion) {
      t.className = `tile ${cls}`;
      return;
    }
    setTimeout(() => t.classList.add('flip'), i * 250);
    setTimeout(() => (t.className = `tile flip ${cls}`), i * 250 + 250);
  });
}

function paintCounts(r, word, counts, animate) {
  const row = rowEl(r);
  if (!row) return;
  const tiles = [...row.querySelectorAll('.tile')];
  tiles.forEach((t, i) => {
    t.textContent = word[i];
    t.className = 'tile locked';
  });
  const boxes = row.querySelector('.cboxes');
  boxes.innerHTML = '';
  COUNT_KINDS.forEach((k, i) => {
    const b = countBox(k, counts[i]);
    if (animate && !reduceMotion) b.style.animation = `pop 0.35s ease ${i * 0.08}s both`;
    boxes.appendChild(b);
  });
  row.setAttribute('aria-label', `${word.toUpperCase()}: ${counts[0]} right place, ${counts[1]} wrong place, ${counts[2]} not in the word`);
}

/* ---------- Word ladder board: start word, my steps, target ---------- */
function ladderRow(word, kind, target, label, current) {
  const row = document.createElement('div');
  row.className = `row ladder-row ${kind}`;
  for (let c = 0; c < COLS; c++) {
    const t = document.createElement('div');
    const ch = word[c] || '';
    t.textContent = ch;
    // Letters already in the right place for the target are green: the target is public, so this reveals nothing
    const inPlace = ch && target && ch === target[c];
    t.className = 'tile' + (ch ? (kind === 'draft' ? ' filled' : ' locked') : '') + (inPlace && kind !== 'draft' ? ' hit' : '');
    row.appendChild(t);
  }
  const tag = document.createElement('span');
  tag.className = 'row-tag';
  tag.textContent = label;
  row.appendChild(tag);
  if (word && kind !== 'draft') row.setAttribute('aria-label', `${label ? `${label}: ` : ''}${word.toUpperCase()}`);
  return row;
}

function drawLadder() {
  if (S.mode !== 'ladder') return;
  const board = $('my-board');
  const lad = S.view?.ladder;
  board.innerHTML = '';
  const note = $('board-note');
  note.hidden = false;
  note.className = 'board-note';
  if (!lad) {
    note.textContent = 'Waiting for the words…';
    return;
  }
  const steps = S.guesses.map((g) => g.word);
  const reached = steps[steps.length - 1] === lad.target;
  note.textContent = `Par ${lad.par}: ${lad.par} step${lad.par === 1 ? '' : 's'} is the fewest. You: ${steps.length} step${steps.length === 1 ? '' : 's'}.`;
  board.appendChild(ladderRow(lad.start, 'start', lad.target, 'Start'));
  const m = me();
  const drafting = !reached && S.view?.status === 'playing' && Boolean(m) && !m.done;
  const first = Math.max(0, steps.length - (drafting ? LADDER_STEPS_SHOWN - 1 : LADDER_STEPS_SHOWN));
  for (let i = first; i < steps.length; i++) board.appendChild(ladderRow(steps[i], 'step', lad.target, `Step ${i + 1}`));
  if (drafting) board.appendChild(ladderRow(S.current, 'draft', lad.target, `Step ${steps.length + 1}`));
  // Keep the board the same height whether you are on step 1 or step 12
  while (board.children.length < LADDER_ROWS - 1) {
    const blank = ladderRow('', 'blank', lad.target, '');
    blank.setAttribute('aria-hidden', 'true');
    board.appendChild(blank);
  }
  board.appendChild(ladderRow(lad.target, 'goal', lad.target, 'Target'));
}

function shakeRow(r) {
  if (S.mode === 'ladder') {
    const draft = $('my-board').querySelector('.draft');
    if (draft) { draft.classList.remove('shake'); void draft.offsetWidth; draft.classList.add('shake'); }
    return;
  }
  const row = rowEl(r);
  if (!row) return;
  row.classList.remove('shake');
  void row.offsetWidth;
  row.classList.add('shake');
}

function onResult(msg) {
  if (msg.round !== S.roundShown) return;
  const r = S.guesses.length;
  const g = { word: msg.word };
  if (msg.pattern) g.pattern = msg.pattern;
  if (msg.counts) g.counts = msg.counts;
  S.guesses.push(g);
  S.current = '';
  S.pending = false;
  if (S.mode === 'ladder') {
    drawLadder();
    if (msg.word === S.view?.ladder?.target) {
      toast(`You reached the target in ${S.guesses.length} step${S.guesses.length === 1 ? '' : 's'}!`);
      sfx('win');
    }
    return;
  }
  paintGuess(r, g, true);
  renderMarks();
  const wait = reduceMotion ? 0 : S.mode === 'counts' ? 600 : COLS * 250 + 250;
  const solved = S.mode === 'counts' ? g.counts[0] === COLS : g.pattern === 'hhhhh';
  setTimeout(() => {
    updateKeyboard();
    if (solved) {
      toast(winLine(S.guesses.length));
      sfx('win');
    }
    else if (S.guesses.length >= S.attempts) toast('Out of guesses. Waiting for the others.');
  }, wait);
}

function winLine(n) {
  return ['Unreal!', 'Brilliant!', 'Great!', 'Nice!', 'Solid!', 'Phew!'][n - 1] || 'Solved!';
}

/* ---------- typing ---------- */
function canType() {
  const v = S.view;
  const m = me();
  return v && v.status === 'playing' && m && !m.done && !S.pending && (S.mode === 'ladder' || S.guesses.length < S.attempts);
}

function pressKey(k) {
  if (!canType()) return;
  if (k === 'enter') return submit();
  if (k === 'back') {
    S.current = S.current.slice(0, -1);
    return drawCurrent();
  }
  if (/^[a-z]$/.test(k) && S.current.length < COLS) {
    S.current += k;
    drawCurrent();
  }
}

function submit() {
  if (S.current.length < COLS) {
    shakeRow(S.guesses.length);
    return toast('Not enough letters');
  }
  S.pending = true;
  send({ t: 'guess', word: S.current });
}

/* ---------- on-screen keyboard ---------- */
function buildKeyboard() {
  S.keyState = {};
  const kb = $('keyboard');
  kb.innerHTML = '';
  const rows = ['qwertyuiop', 'asdfghjkl', ['enter', ...'zxcvbnm', 'back']];
  for (const keys of rows) {
    const row = document.createElement('div');
    row.className = 'krow';
    for (const k of keys) {
      const b = document.createElement('button');
      b.className = 'key' + (k.length > 1 ? ' wide' : '');
      b.dataset.key = k;
      b.textContent = k === 'back' ? '⌫' : k === 'enter' ? 'Enter' : k;
      if (k === 'back') b.setAttribute('aria-label', 'Delete letter');
      row.appendChild(b);
    }
    kb.appendChild(row);
  }
}

/* =========================================================
   Counts: my own letter notes. Tap a letter of a row I already sent: green, yellow, red, plain.
   Purely a visual aid in this page: never sent anywhere, kept in sessionStorage for this room and round.
   ========================================================= */
const MARK_NAMES = ['', 'right place', 'wrong place', 'not in the word'];
S.marks = {};      // "row,col" -> { m: 1..3, t: when it was tapped (a counter, so the latest tap wins) }
S.markTick = 0;
S.marksKey = '';

const marksActive = () => S.mode === 'counts' && S.view?.status === 'playing';

function forgetMarks(key) {
  if (!key) return;
  try { sessionStorage.removeItem(key); } catch {}
}
function loadMarks() {
  S.marksKey = `lettuce-marks:${S.code}:${S.roundShown}`;
  S.marks = {};
  S.markTick = 0;
  if (S.mode !== 'counts') return;
  try {
    const saved = JSON.parse(sessionStorage.getItem(S.marksKey) || 'null');
    if (saved && typeof saved === 'object') {
      for (const [k, v] of Object.entries(saved.marks || {})) {
        if (/^\d+,\d$/.test(k) && v && v.m >= 1 && v.m <= 3 && Number.isFinite(v.t)) S.marks[k] = { m: v.m, t: v.t };
      }
      S.markTick = Number(saved.tick) || 0;
    }
  } catch {}
}
function saveMarks() {
  try { sessionStorage.setItem(S.marksKey, JSON.stringify({ marks: S.marks, tick: S.markTick })); } catch {}
}

/** Paint my notes on the submitted tiles (and switch the tiles on or off), then the keyboard. */
function renderMarks() {
  if (S.mode !== 'counts') return;
  const on = marksActive();
  [...$('my-board').children].forEach((row, r) => {
    [...row.querySelectorAll('button.tile')].forEach((t, c) => {
      const submitted = r < S.guesses.length;
      const m = submitted && on ? S.marks[`${r},${c}`]?.m || 0 : 0;
      t.disabled = !(submitted && on);
      t.tabIndex = submitted && on ? 0 : -1;
      t.classList.remove('mk1', 'mk2', 'mk3');
      if (m) t.classList.add(`mk${m}`);
      if (submitted && on) {
        const letter = S.guesses[r].word[c].toUpperCase();
        t.setAttribute('aria-pressed', m ? 'true' : 'false');
        t.setAttribute('aria-label', m ? `${letter} marked ${MARK_NAMES[m]}` : `${letter} unmarked`);
        t.title = m ? `Your note: ${MARK_NAMES[m]}. Tap to change.` : 'Tap to note this letter';
      } else {
        t.removeAttribute('aria-pressed');
        t.removeAttribute('aria-label');
        t.removeAttribute('title');
      }
    });
  });
  updateKeyboard();
}

function cycleMark(r, c) {
  const k = `${r},${c}`;
  const next = ((S.marks[k]?.m || 0) + 1) % 4;
  if (next === 0) delete S.marks[k];
  else S.marks[k] = { m: next, t: ++S.markTick };
  saveMarks();
  renderMarks();
}

// Per letter: the mark from the most recently tapped tile that still has one (none left = plain key)
function letterMarks() {
  const best = {};
  for (const [k, v] of Object.entries(S.marks)) {
    const [r, c] = k.split(',').map(Number);
    const ch = S.guesses[r]?.word[c];
    if (ch && (!best[ch] || v.t > best[ch].t)) best[ch] = v;
  }
  return best;
}

$('my-board').addEventListener('mousedown', (e) => {
  if (e.target.closest('button.tile')) e.preventDefault();   // a tap on a note must not take focus from typing
});
$('my-board').addEventListener('click', (e) => {
  const t = e.target.closest('button.tile');
  if (!t || t.disabled) return;
  const row = t.parentElement;
  cycleMark([...$('my-board').children].indexOf(row), [...row.querySelectorAll('button.tile')].indexOf(t));
  // A mouse or touch tap leaves no focus behind, so Enter still sends the word; a keyboard press (detail 0) keeps it
  if (e.detail !== 0) t.blur();
});

function updateKeyboard() {
  if (S.mode === 'counts') {
    const marks = letterMarks();
    const on = marksActive();
    for (const b of $('keyboard').querySelectorAll('.key')) {
      const m = on ? marks[b.dataset.key]?.m || 0 : 0;
      b.className = 'key' + (b.dataset.key.length > 1 ? ' wide' : '') + (m ? ` mk${m}` : '');
      if (b.dataset.key.length === 1) {
        if (m) b.setAttribute('aria-label', `${b.dataset.key.toUpperCase()}, your note: ${MARK_NAMES[m]}`);
        else b.removeAttribute('aria-label');
      }
    }
    return;
  }
  // Only Classic colours the keys: Ladder never tells you which letters are right
  for (const g of S.mode === 'classic' ? S.guesses : []) {
    [...g.word].forEach((ch, i) => {
      const cls = CLASS[g.pattern[i]];
      if (!S.keyState[ch] || RANK[cls] > RANK[S.keyState[ch]]) S.keyState[ch] = cls;
    });
  }
  for (const b of $('keyboard').querySelectorAll('.key')) {
    const st = S.keyState[b.dataset.key];
    b.className = 'key' + (b.dataset.key.length > 1 ? ' wide' : '') + (st ? ` ${st}` : '');
  }
}

/* =========================================================
   Rivals (the live colour boards)
   ========================================================= */
function renderRivals(v) {
  const box = $('rivals');
  box.innerHTML = '';
  for (const p of v.players) {
    if (p.id !== S.myId) box.appendChild(rivalCard(p));
  }
}

function rivalCard(p) {
  const v = S.view;
  const card = document.createElement('div');
  card.className = `rival c${p.color}` + (p.solved ? ' solved' : '') + (p.connected ? '' : ' offline');

  const mini = document.createElement('div');
  mini.className = `mini ${v.mode}`;
  mini.setAttribute('aria-hidden', 'true');
  const rows = rowsOf(v.mode, v.attempts);
  mini.style.setProperty('--rows', String(rows));
  const seen = S.seenRows[p.id] || 0;
  if (v.mode === 'ladder') {
    // Ladder words stay secret: five pips show how many letters of their current word match the target in place
    const row = document.createElement('div');
    row.className = 'mrow';
    for (let c = 0; c < COLS; c++) {
      const cell = document.createElement('i');
      if (p.match != null && c < p.match) cell.className = 'hit';
      row.appendChild(cell);
    }
    mini.appendChild(row);
  } else {
    for (let r = 0; r < rows; r++) {
      const row = document.createElement('div');
      const isNew = r >= seen && !reduceMotion;
      if (v.mode === 'counts') {
        const c3 = p.counts[r];
        row.className = 'mrow cnt' + (c3 && isNew ? ' new' : '');
        COUNT_KINDS.forEach((k, i) => {
          const cell = document.createElement('i');
          if (c3) {
            cell.className = k.cls;
            cell.textContent = String(c3[i]);
          }
          row.appendChild(cell);
        });
      } else {
        const pat = p.patterns[r];
        row.className = 'mrow' + (pat && isNew ? ' new' : '');
        for (let c = 0; c < COLS; c++) {
          const cell = document.createElement('i');
          if (pat) cell.className = CLASS[pat[c]];
          row.appendChild(cell);
        }
      }
      mini.appendChild(row);
    }
  }
  S.seenRows[p.id] = p.used;

  const name = document.createElement('div');
  name.className = 'rival-name';
  name.textContent = label(p.name);

  const status = document.createElement('div');
  status.className = 'rival-status';
  status.textContent = rivalStatus(p);

  let detail = status.textContent;
  if (v.mode === 'counts' && p.counts.length) {
    const last = p.counts[p.counts.length - 1];
    detail += `. Last guess: ${last[0]} right place, ${last[1]} wrong place, ${last[2]} not in the word`;
  }
  card.setAttribute('aria-label', `${label(p.name)}: ${detail}`);
  card.append(mini, name, status);
  return card;
}

function rivalStatus(p) {
  const v = S.view;
  const n = p.used;
  if (!p.connected) return 'Disconnected';
  if (v.mode === 'ladder') {
    if (p.solved) return `Reached it in ${n} (${fmtTime(p.finishMs)})`;
    if (p.timedOut) return `Out of time, ${n} step${n === 1 ? '' : 's'}`;
    if (p.stopped) return 'Round ended';
    if (v.status !== 'playing') return `${n} step${n === 1 ? '' : 's'}`;
    return n === 0 ? 'Thinking…' : `${n} step${n === 1 ? '' : 's'}, ${p.match} of 5 match`;
  }
  if (p.solved) return `Solved in ${n} (${fmtTime(p.finishMs)})`;
  if (p.timedOut) return 'Out of time';
  if (p.stopped) return 'Round ended';
  if (p.done) return 'Out of guesses';
  if (v.status !== 'playing') return `${n} of ${v.attempts} used`;
  return n === 0 ? 'Thinking…' : `${n} of ${v.attempts} guesses`;
}

function announceRivals(prev, v) {
  if (!prev || prev.round !== v.round) return;
  for (const p of v.players) {
    if (p.id === S.myId) continue;
    const before = prev.players.find((x) => x.id === p.id || x.name === p.name);
    if (before && !before.solved && p.solved) {
      toast(v.mode === 'ladder' ? `${label(p.name)} reached the target in ${p.used}!` : `${label(p.name)} solved it in ${p.used}!`);
      sfx('rival');
    }
  }
}

/* =========================================================
   Lobby
   ========================================================= */
function renderLobby(v) {
  $('lobby-code').textContent = v.code;
  const list = $('lobby-players');
  list.innerHTML = '';
  for (const p of v.players) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = `var(--p${p.color})`;
    const name = document.createElement('span');
    name.textContent = label(p.name);
    let avatar = null;
    if (p.photo) {
      avatar = document.createElement('img');
      avatar.className = 'avatar';
      avatar.alt = '';
      avatar.referrerPolicy = 'no-referrer';
      avatar.onerror = () => avatar.remove();
      avatar.src = p.photo;
    }
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = [p.isHost ? 'host' : '', p.id === S.myId ? 'you' : ''].filter(Boolean).join(', ');
    li.append(dot, ...(avatar ? [avatar] : []), name, tag);
    list.appendChild(li);
  }
  if (v.players.length < MAX_PLAYERS) {
    const li = document.createElement('li');
    li.className = 'empty';
    const free = MAX_PLAYERS - v.players.length;
    li.textContent = `Waiting for friends to join (${free} more can join)`;
    list.appendChild(li);
  }

  $('host-controls').hidden = !S.isHost;
  document.querySelector('.lobby-inner').classList.toggle('host', S.isHost);
  $('lobby-wait').hidden = S.isHost;
  $('lobby-rules').textContent = settingsSummary(v);
  $('lobby-rules').hidden = S.isHost;
  $('public-state').hidden = S.isHost;
  $('public-state').innerHTML = publicLine(v);
  $('word-status').hidden = true;
  const crewLine = $('crew-status');
  crewLine.textContent = v.crew
    ? `Crew “${v.crew}”: ${v.crewStatus}`
    : S.isHost ? 'All-time scores aren’t being saved. Add a crew name to save them.' : '';
  crewLine.hidden = !crewLine.textContent;
  if (S.isHost && document.activeElement !== $('crew-input')) $('crew-input').value = v.crew || '';
  if (S.isHost) {
    $('strict-toggle').checked = v.strict;
    paintPublic(v);
    $('winrule-select').value = v.winRule;
    for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === v.mode;
    $('mode-blurb').textContent = MODE_BLURBS[v.mode] || '';
    const ladder = v.mode === 'ladder';
    $('rule-first-text').textContent = ladder ? 'First to reach the target' : 'First to solve it';
    $('rule-fewest-text').textContent = ladder ? 'Fewest steps' : 'Fewest guesses';
    $('rounds-select').value = String(v.maxRounds);
    $('attempts-field').hidden = ladder;
    $('attempts-select').value = String(v.attempts);
    $('strict-label').hidden = ladder;
    // Hard mode needs revealed hints, which only Classic has
    $('hard-toggle').checked = v.hard;
    $('hard-toggle').disabled = v.mode !== 'classic';
    $('hard-label').classList.toggle('disabled', v.mode !== 'classic');
    $('hard-note').hidden = v.mode === 'classic';
    paintTimerOptions(ladder);
    $('timer-select').value = String(ladder ? v.ladderTime : v.timer);
    const n = v.players.length;
    $('start-btn').textContent = n === 1 ? 'Start solo (for testing)' : `Start game with ${n} players`;
  } else {
    const host = v.players.find((p) => p.isHost);
    $('lobby-wait').textContent = `Waiting for ${host ? label(host.name) : 'the host'} to start the game.`;
  }
}

// The time limit list: Word ladder always has a limit (1, 2, 3 or 5 minutes); the others can have none
function paintTimerOptions(ladder) {
  const sel = $('timer-select');
  if (sel.dataset.ladder === String(ladder)) return;
  sel.dataset.ladder = String(ladder);
  sel.innerHTML = '';
  for (const secs of ladder ? E.LADDER_TIMES : E.TIMERS) {
    const o = document.createElement('option');
    o.value = String(secs);
    o.textContent = secs === 0 ? 'No timer' : `${secs / 60} minute${secs === 60 ? '' : 's'}`;
    sel.appendChild(o);
  }
}

function settingsSummary(v) {
  const rounds = v.maxRounds ? `${v.maxRounds} rounds` : 'Unlimited rounds';
  const limit = E.effectiveTimer(v);
  const timer = limit ? `${limit / 60} minute${limit === 60 ? '' : 's'} per round` : 'no timer';
  const attempts = v.mode === 'ladder' ? '' : `, ${v.attempts} guesses`;
  return `${MODE_NAMES[v.mode] || 'Classic'}. ${winRules(v)[v.winRule] || ''} ${rounds}${attempts}, ${timer}.${v.hard ? ' Hard mode.' : ''}`;
}

/* =========================================================
   Room scores (across rounds)
   ========================================================= */
function renderScores(v) {
  const html = scoresHTML(v);
  $('scoreboard-body').innerHTML = html;
  $('scores-sheet-body').innerHTML = html;
}

function esc(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function scoresHTML(v) {
  return `<h3 class="scores-sub">This game</h3>${roomScoresHTML(v)}${crewScoresHTML(v)}`;
}

function crewScoresHTML(v) {
  if (!v.crew) return '';
  const head = `<h3 class="scores-sub">All time: ${esc(v.crew)}</h3>`;
  const all = v.allTime;
  if (!all || !all.players.length) return `${head}<p class="scores-empty">${esc(v.crewStatus || 'No saved rounds yet.')}</p>`;
  const here = new Map(v.players.map((p) => [p.name.toLowerCase(), p]));
  const rows = all.players
    .map((p) => ({ ...p, avg: p.solved ? p.guessSum / p.solved : null, me: here.get(p.name.toLowerCase())?.id === S.myId }))
    .sort((a, b) => b.wins - a.wins || (b.wins / b.played || 0) - (a.wins / a.played || 0) || (a.avg ?? 99) - (b.avg ?? 99));
  const body = rows.map((r) => {
    const color = here.get(r.name.toLowerCase())?.color;
    const dot = color == null ? 'var(--line)' : `var(--p${color})`;
    return `
    <tr>
      <td><span class="pname"><span class="dot" style="background: ${dot}"></span><span>${esc(label(r.name))}${r.me ? ' (you)' : ''}</span></span></td>
      <td class="wins">${r.wins}</td>
      <td>${r.played}</td>
      <td>${r.avg == null ? '–' : r.avg.toFixed(1)}</td>
      <td title="Best streak: ${r.bestStreak}">${r.streak}</td>
    </tr>`;
  }).join('');
  return `${head}
    <table class="scores">
      <thead><tr><th scope="col">Player</th><th scope="col">Wins</th><th scope="col" title="Rounds played">Played</th><th scope="col" title="Average guesses when solved">Avg</th><th scope="col" title="Current win streak (hover a number for the best)">Streak</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="scores-note">${esc(v.crewStatus || '')}</p>`;
}

function roomScoresHTML(v, withHistory = true) {
  const stats = v.stats || [];
  if (stats.length === 0) {
    return '<p class="scores-empty">Wins and times show up here once the first round ends. They add up over every round of this game.</p>';
  }
  const here = new Map(v.players.map((p) => [p.name.toLowerCase(), p]));
  const rows = stats.map((st) => ({
    ...st,
    avg: st.solved ? st.guessSum / st.solved : null,
    present: here.has(st.name.toLowerCase()) && here.get(st.name.toLowerCase()).connected,
    me: here.get(st.name.toLowerCase())?.id === S.myId,
  }));
  // Players who joined after the last round ended have no scores yet.
  for (const p of v.players) {
    if (!rows.some((r) => r.name.toLowerCase() === p.name.toLowerCase())) {
      rows.push({ name: p.name, color: p.color, played: 0, wins: 0, solved: 0, avg: null, bestMs: null, present: p.connected, me: p.id === S.myId });
    }
  }
  rows.sort((a, b) =>
    b.wins - a.wins ||
    b.solved - a.solved ||
    (a.avg ?? 99) - (b.avg ?? 99) ||
    (a.bestMs ?? 1e12) - (b.bestMs ?? 1e12));

  const body = rows.map((r) => `
    <tr class="${r.present ? '' : 'gone'}">
      <td><span class="pname"><span class="dot" style="background: var(--p${r.color})"></span><span>${esc(label(r.name))}${r.me ? ' (you)' : ''}</span></span></td>
      <td class="wins">${r.wins}</td>
      <td>${r.solved}/${r.played}</td>
      <td>${r.avg == null ? '–' : r.avg.toFixed(1)}</td>
      <td>${r.bestMs == null ? '–' : fmtTime(r.bestMs)}</td>
    </tr>`).join('');

  const history = (v.history || []).slice().reverse().map((h) =>
    `<li>Round ${h.round}: <b>${esc(h.word)}</b>, ${h.winner ? `won by ${esc(label(h.winner))}` : 'nobody got it'}</li>`).join('');

  return `
    <table class="scores">
      <thead><tr><th scope="col">Player</th><th scope="col">Wins</th><th scope="col">Solved</th><th scope="col" title="Average guesses (or ladder steps) when solved">Avg</th><th scope="col" title="Fastest solve">Best</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${history && withHistory ? `<p class="history-title">Past words</p><ul class="history">${history}</ul>` : ''}`;
}

/* =========================================================
   Results
   ========================================================= */
function ranked(players, rule = 'first') {
  // How close an unsolved player got: green tiles (Classic), the green count (Counts), letters matching the target (Ladder)
  const greens = (p) => {
    if (p.match != null) return p.match;
    if (p.counts.length) return p.counts[p.counts.length - 1][0];
    const last = p.patterns[p.patterns.length - 1] || '';
    return [...last].filter((c) => c === 'h').length;
  };
  return [...players].sort((a, b) => {
    if (a.solved !== b.solved) return a.solved ? -1 : 1;
    if (a.solved && rule === 'fewest') return a.used - b.used || a.finishMs - b.finishMs;
    if (a.solved) return a.finishMs - b.finishMs || a.used - b.used;
    return greens(b) - greens(a);
  });
}

function showResults(v) {
  const ladder = v.mode === 'ladder';
  $('results-sheet').classList.toggle('wide', v.mode !== 'classic');
  const word = $('results-word');
  word.innerHTML = '';
  for (const ch of (ladder ? v.ladder?.target : v.word) || '') {
    const i = document.createElement('i');
    i.textContent = ch;
    word.appendChild(i);
  }

  const list = $('results-list');
  list.innerHTML = '';
  const order = ranked(v.players, v.winRule);
  $('results-rule').textContent = `${MODE_NAMES[v.mode]}. ${winRules(v)[v.winRule] || ''}${ladder && v.ladder ? ` Par was ${v.ladder.par}.` : ''}`;
  order.forEach((p, idx) => {
    const li = document.createElement('li');
    if (idx === 0 && p.solved) li.className = 'first';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = `var(--p${p.color})`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = label(p.name) + (p.id === S.myId ? ' (you)' : '');
    const how = document.createElement('span');
    how.className = 'how';
    if (p.solved) how.textContent = ladder ? `${p.used} steps in ${fmtTime(p.finishMs)}` : `${p.used}/${v.attempts} in ${fmtTime(p.finishMs)}`;
    else if (!p.connected) how.textContent = 'Left';
    else if (p.timedOut) how.textContent = ladder ? `Out of time (${p.used} steps)` : 'Out of time';
    else if (p.stopped) how.textContent = 'Round ended';
    else if (p.used === 0 && !p.done) how.textContent = 'Joined late';
    else how.textContent = ladder ? `${p.used} steps` : `X/${v.attempts}`;
    li.append(dot, who, how);
    list.appendChild(li);
  });

  const winner = order[0];
  const over = v.status === 'over';
  const roundTitle = !winner?.solved
    ? (ladder ? 'Nobody reached the target' : 'Nobody got it')
    : winner.id === S.myId
      ? 'You win the round!'
      : `${label(winner.name)} wins the round`;

  // Final standings when the game is over.
  $('final-block').hidden = !over;
  if (over) {
    $('final-standings').innerHTML = roomScoresHTML(v, false);
    const champ = gameWinner(v);
    $('results-title').textContent = !champ
      ? 'Game over: it’s a tie!'
      : champ.me ? 'You win the game!' : `${label(champ.name)} wins the game!`;
    const lastRound = !winner?.solved ? (ladder ? 'nobody reached it' : 'nobody got it') : winner.id === S.myId ? 'you won it' : `${label(winner.name)} won it`;
    $('results-round-label').textContent = `Last round: ${lastRound}. ${ladder ? 'The target was' : 'The word was'}`;
  } else {
    $('results-title').textContent = roundTitle;
    $('results-round-label').textContent = (v.maxRounds ? `Round ${v.matchRound} of ${v.maxRounds}` : `Round ${v.matchRound}`) + (ladder ? '. The target was' : '. The word was');
  }
  renderResultBoards(v, order);

  $('again-btn').hidden = !S.isHost || over;
  $('end-btn').hidden = !S.isHost || over;
  $('rematch-btn').hidden = !S.isHost || !over;
  $('newgame-btn').hidden = !S.isHost || !over;
  $('share-btn').hidden = !me() || me().used === 0;
  showMeaning(ladder ? v.ladder?.target : v.word);
  $('again-wait').hidden = S.isHost;
  $('again-wait').textContent = over
    ? 'Waiting for the host to set up a new game.'
    : 'Waiting for the host to start the next round.';
  $('results').hidden = false;
}

/* ---------- Counts and Word ladder: everyone's board, revealed once the round is over ---------- */
function renderResultBoards(v, order) {
  const box = $('results-boards');
  box.innerHTML = '';
  box.hidden = v.mode === 'classic';
  if (v.mode === 'classic') return;
  const title = (text) => {
    const h = document.createElement('h3');
    h.className = 'scores-sub';
    h.textContent = text;
    return h;
  };
  if (v.mode === 'ladder' && v.ladder?.path) {
    const path = document.createElement('div');
    path.className = 'ladder-path';
    path.append(title(`One shortest way (${v.ladder.par} steps)`), chain(v.ladder.path, v.ladder.target));
    box.appendChild(path);
  }
  box.appendChild(title(v.mode === 'ladder' ? 'Everyone’s ladder' : 'Everyone’s guesses'));
  for (const p of order) {
    if (!p.rows || !p.rows.length) continue;
    const item = document.createElement('div');
    item.className = 'result-board';
    const name = document.createElement('div');
    name.className = 'rb-name';
    name.innerHTML = `<span class="dot" style="background: var(--p${p.color})"></span>`;
    const who = document.createElement('span');
    who.textContent = label(p.name) + (p.id === S.myId ? ' (you)' : '');
    name.appendChild(who);
    item.appendChild(name);
    if (v.mode === 'ladder') {
      item.appendChild(chain([v.ladder.start, ...p.rows.map((r) => r.word)], v.ladder.target));
    } else {
      for (const r of p.rows) item.appendChild(resultRow(r));
    }
    box.appendChild(item);
  }
}

/** A ladder as words joined by arrows; the target is picked out if it was reached. */
function chain(words, target) {
  const el = document.createElement('p');
  el.className = 'chain';
  words.forEach((w, i) => {
    if (i) el.append(document.createTextNode(' › '));
    const b = document.createElement('b');
    b.textContent = w;
    if (w === target && i > 0) b.className = 'reached';
    el.appendChild(b);
  });
  el.setAttribute('aria-label', words.join(', then '));
  return el;
}

/** One Counts guess with its tile colors, shown at the end of the round. */
function resultRow(r) {
  const row = document.createElement('div');
  row.className = 'rrow';
  const tiles = document.createElement('span');
  tiles.className = 'rtiles';
  [...r.word].forEach((ch, i) => {
    const t = document.createElement('i');
    t.textContent = ch;
    t.className = CLASS[r.pattern[i]];
    tiles.appendChild(t);
  });
  const [g, y, red] = E.counts(r.pattern);
  const nums = document.createElement('span');
  nums.className = 'rnums';
  nums.setAttribute('aria-label', `${g} right place, ${y} wrong place, ${red} not in the word`);
  COUNT_KINDS.forEach((k, i) => nums.appendChild(countBox(k, [g, y, red][i])));
  row.append(tiles, nums);
  return row;
}

/* ---------- word meaning (free dictionary API, no key) ---------- */
const meanings = new Map();
async function showMeaning(word) {
  const el = $('results-meaning');
  if (!word) { el.hidden = true; return; }
  const look = `https://www.google.com/search?q=define+${encodeURIComponent(word)}`;
  const render = (m) => {
    if ($('results-word').textContent.toLowerCase() !== word) return;
    el.innerHTML = m
      ? `<i>${esc(m.part)}</i> ${esc(m.text)}`
      : `<a href="${look}" target="_blank" rel="noopener">Look up “${esc(word.toUpperCase())}”</a>`;
    el.hidden = false;
  };
  if (meanings.has(word)) return render(meanings.get(word));
  el.hidden = true;
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    const data = res.ok ? await res.json() : null;
    const first = data?.[0]?.meanings?.[0];
    const def = first?.definitions?.[0]?.definition;
    const m = def ? { part: first.partOfSpeech || '', text: def.length > 160 ? `${def.slice(0, 157)}…` : def } : null;
    meanings.set(word, m);
    render(m);
  } catch {
    render(null);
  }
}

/* ---------- share my result ---------- */
async function shareResult() {
  cloud.track('share_result');
  const v = S.view;
  const m = me();
  if (!v || !m) return;
  const roundLabel = v.maxRounds ? `round ${v.matchRound} of ${v.maxRounds}` : `round ${v.matchRound}`;
  const time = m.solved ? ` in ${fmtTime(m.finishMs)}` : '';
  let text;
  if (v.mode === 'ladder') {
    const par = v.ladder?.par;
    const head = m.solved
      ? `reached the target in ${m.used} step${m.used === 1 ? '' : 's'} (par ${par})${time}`
      : `didn’t reach the target (${m.used} step${m.used === 1 ? '' : 's'}, par ${par})`;
    // One row per step, a green square for every letter already in the target's place (the words stay secret)
    const target = v.ladder?.target || '';
    const squares = PREFS.contrast ? '🟧' : '🟩';
    const grid = (m.rows || []).map((r) => [...r.word].map((ch, i) => (ch === target[i] ? squares : '⬛')).join('')).join('\n');
    text = `Lettuce Party, word ladder, ${roundLabel}: ${head}\n\n${grid}`;
  } else if (v.mode === 'counts') {
    const score = m.solved ? `${m.used}/${v.attempts}` : `X/${v.attempts}`;
    const boxes = PREFS.contrast ? ['🟧', '🟦', '🟥'] : ['🟩', '🟨', '🟥'];
    const grid = (m.rows || []).map((r) => E.counts(r.pattern).map((n, i) => `${boxes[i]}${n}`).join(' ')).join('\n');
    text = `Lettuce Party, counts, ${roundLabel}: ${score}${time}\n\n${grid}`;
  } else {
    const squares = PREFS.contrast ? { h: '🟧', n: '🟦', m: '⬛' } : { h: '🟩', n: '🟨', m: '⬛' };
    const score = m.solved ? `${m.patterns.length}/${v.attempts}` : `X/${v.attempts}`;
    const grid = m.patterns.map((p) => [...p].map((c) => squares[c]).join('')).join('\n');
    text = `Lettuce Party, ${roundLabel}${v.hard ? ' (hard)' : ''}: ${score}${time}\n\n${grid}`;
  }
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ text });
    } else {
      await navigator.clipboard.writeText(text);
      toast('Result copied. Paste it anywhere.');
    }
  } catch (err) {
    if (err?.name !== 'AbortError') prompt('Copy your result:', text);
  }
}

// The game winner: most round wins, then rounds solved, then fewest average guesses.
function gameWinner(v) {
  const rows = (v.stats || []).map((st) => ({ ...st, avg: st.solved ? st.guessSum / st.solved : 99 }));
  if (!rows.length) return null;
  rows.sort((a, b) => b.wins - a.wins || b.solved - a.solved || a.avg - b.avg);
  const [a, b] = rows;
  if (b && a.wins === b.wins && a.solved === b.solved && a.avg === b.avg) return null;
  if (a.wins === 0 && a.solved === 0) return null;
  const p = v.players.find((x) => x.name.toLowerCase() === a.name.toLowerCase());
  return { name: a.name, me: p?.id === S.myId };
}

/* =========================================================
   Screens, clock, toasts, notices
   ========================================================= */
function showScreen(name) {
  for (const s of ['home', 'lobby', 'game']) $(`screen-${s}`).hidden = s !== name;
  if (name !== 'game') {
    $('results').hidden = true;
    $('scores-sheet').hidden = true;
  }
}

function fmtTime(ms) {
  if (ms == null) return '–';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function tickClock() {
  const v = S.view;
  if (!v || v.status === 'lobby') return;
  const m = me();
  const clock = $('game-clock');
  const limit = E.effectiveTimer(v);
  if (limit && v.status === 'playing') {
    const left = Math.max(0, limit * 1000 - (Date.now() - S.localStart));
    clock.textContent = fmtTime(left + 999);
    clock.classList.toggle('urgent', left < 10000);
    if (left < 10000 && left > 0 && S.tickedRound !== v.round) {
      S.tickedRound = v.round;
      sfx('tick');
    }
    clock.setAttribute('aria-label', 'Time left in this round');
    return;
  }
  clock.classList.remove('urgent');
  clock.setAttribute('aria-label', 'Round time');
  let ms;
  if (m && m.done) ms = m.finishMs;
  else if (v.status !== 'playing') ms = null;
  else ms = Date.now() - S.localStart;
  clock.textContent = ms == null ? '–' : fmtTime(ms);
}
setInterval(tickClock, 500);

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function showNotice(title, text) {
  $('notice-title').textContent = title;
  $('notice-text').textContent = text;
  $('notice').hidden = false;
}

function homeError(text) {
  $('home-error').textContent = text || '';
}

function setBusy(busy) {
  $('host-btn').disabled = busy;
  $('quick-btn').disabled = busy;
  $('join-btn').disabled = busy;
  $('host-btn').textContent = busy && S.isHostingAttempt ? 'Creating room…' : 'Host a private room';
  $('join-btn').textContent = busy && !S.isHostingAttempt ? 'Joining…' : 'Join room';
}

// Inside joke: JD and Junaid get a banana wherever their name is shown.
function label(name) {
  return /^(jd|junaid)( \d+)?$/i.test(String(name).trim()) ? `${name} 🍌` : name;
}

function cleanName(n) {
  return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 14);
}

function resetLocal() {
  S.view = null;
  S.isHost = false;
  S.creating = false;
  S.code = null;
  S.roundShown = 0;
  S.localStartRound = 0;
}

function leaveRoom() {
  link.close();
  resetLocal();
  $('notice').hidden = true;
  homeError('');
  showScreen('home');
}

/* =========================================================
   Settings: account, my stats, preferences
   ========================================================= */
function renderAccount(u) {
  for (const chip of document.querySelectorAll('.account-chip')) {
    const img = chip.querySelector('img');
    chip.querySelector('.account-label').textContent = u ? u.name.split(' ')[0] : 'Sign in';
    img.hidden = !(u && u.photo);
    if (u && u.photo) {
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.hidden = true; };
      img.src = u.photo;
    }
  }
  $('account-out').hidden = Boolean(u);
  $('account-in').hidden = !u;
  if (u) {
    $('account-name').textContent = u.name;
    $('account-email').textContent = u.email;
    $('account-photo').hidden = !u.photo;
    if (u.photo) {
      $('account-photo').referrerPolicy = 'no-referrer';
      $('account-photo').onerror = () => { $('account-photo').hidden = true; };
      $('account-photo').src = u.photo;
    }
    if (!$('name-input').value.trim()) $('name-input').value = u.name.split(' ')[0].slice(0, 14);
  }
}

async function openSettings() {
  $('settings-sheet').hidden = false;
  $('account-error').textContent = '';
  $('pref-sound').checked = PREFS.sound;
  $('pref-contrast').checked = PREFS.contrast;
  $('pref-analytics').checked = PREFS.analytics !== false;
  $('pref-analytics').closest('label').hidden = !cloud.analyticsConfigured();
  renderAccount(cloud.currentUser());
  loadMyStats();
}

async function loadMyStats() {
  const box = $('my-stats');
  box.innerHTML = '<p class="stats-note">Loading your stats…</p>';
  try {
    const st = await cloud.loadProfile();
    box.innerHTML = myStatsHTML(st);
  } catch (err) {
    box.innerHTML = `<p class="stats-note">${esc(cloud.errorText(err))}</p>`;
  }
}

const stat = (n, t) => `<div class="stat"><b>${n}</b><span>${t}</span></div>`;
const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '–');

function myStatsHTML(st) {
  const others = st.counts.plays + st.ladder.plays;
  if (!st.games && !others) return '<p class="stats-note">Play a round and your stats will show up here.</p>';
  return [
    st.games ? classicStatsHTML(st, Boolean(others)) : '',
    st.counts.plays ? countsStatsHTML(st.counts) : '',
    st.ladder.plays ? ladderStatsHTML(st.ladder) : '',
  ].join('');
}

function classicStatsHTML(st, withTitle) {
  const avg = st.solved ? (st.guessSum / st.solved).toFixed(1) : '–';
  // The distribution shows 1 to 6 as it always did, and grows to the longest game the player has solved (up to 10)
  const last = st.dist.reduce((m, n, i) => (n > 0 ? i + 1 : m), 0);
  const dist = st.dist.slice(0, Math.max(6, last));
  const max = Math.max(1, ...dist);
  const opener = Object.entries(st.openers).sort((a, b) => b[1] - a[1])[0];
  const bars = dist.map((n, i) =>
    `<div class="dist-row"><span>${i + 1}</span><span class="dist-bar ${n === max && n > 0 ? 'top' : ''}" style="width: ${Math.max(8, (n / max) * 100)}%">${n}</span></div>`).join('');
  return `
    ${withTitle ? '<h4 class="stats-mode">Classic</h4>' : ''}
    <div class="stat-grid">
      ${stat(st.games, 'Played')}${stat(pct(st.wins, st.games), 'Rounds won')}${stat(avg, 'Avg guesses')}
      ${stat(st.streak, 'Win streak')}${stat(st.bestStreak, 'Best streak')}${stat(st.bestMs == null ? '–' : fmtTime(st.bestMs), 'Fastest')}
    </div>
    <p class="stats-note">Guesses needed when solved</p>
    <div class="dist">${bars}</div>
    ${opener ? `<p class="stats-note">Favorite opener: <b>${esc(opener[0].toUpperCase())}</b>, used ${opener[1]} time${opener[1] === 1 ? '' : 's'}</p>` : ''}`;
}

function countsStatsHTML(c) {
  return `
    <h4 class="stats-mode">Counts</h4>
    <div class="stat-grid">
      ${stat(c.plays, 'Played')}${stat(pct(c.wins, c.plays), 'Rounds won')}${stat(c.solved ? (c.guessSum / c.solved).toFixed(1) : '–', 'Avg guesses')}
      ${stat(c.wins, 'Wins')}${stat(c.solved, 'Solved')}${stat(c.fastest == null ? '–' : fmtTime(c.fastest), 'Fastest')}
    </div>`;
}

function ladderStatsHTML(l) {
  return `
    <h4 class="stats-mode">Word ladder</h4>
    <div class="stat-grid">
      ${stat(l.plays, 'Played')}${stat(pct(l.wins, l.plays), 'Rounds won')}${stat(pct(l.solved, l.plays), 'Reached target')}
      ${stat(l.solved ? (l.steps / l.solved).toFixed(1) : '–', 'Avg steps')}${stat(l.bestOver == null ? '–' : l.bestOver === 0 ? 'Par' : `+${l.bestOver}`, 'Best vs par')}${stat(l.fastest == null ? '–' : fmtTime(l.fastest), 'Fastest')}
    </div>`;
}

/* =========================================================
   Wiring
   ========================================================= */
function readName() {
  const name = cleanName($('name-input').value);
  if (!name) {
    homeError('Type your name first so your friends know who’s who.');
    $('name-input').focus();
    return null;
  }
  try { localStorage.setItem('wordleparty-name', name); } catch {}
  return name;
}

$('host-btn').addEventListener('click', () => {
  const name = readName();
  if (!name) return;
  homeError('');
  S.myName = name;
  S.isHostingAttempt = true;
  setBusy(true);
  S.creating = true;
  link.host(false);
});

// Quick Play: a public room that's waiting for players, or a new public one
$('quick-btn').addEventListener('click', async () => {
  const name = readName();
  if (!name) return;
  homeError('');
  S.myName = name;
  S.isHostingAttempt = false;
  setBusy(true);
  try {
    const code = await quickPlay('lettuce-party');
    if (code) link.join(code);
    else { S.creating = true; link.host(true); }
  } catch (err) {
    setBusy(false);
    homeError(err.message);
  }
});

$('join-btn').addEventListener('click', () => {
  const name = readName();
  if (!name) return;
  const code = $('code-input').value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) {
    homeError('Room codes are 4 letters. Ask the host for theirs.');
    $('code-input').focus();
    return;
  }
  homeError('');
  S.myName = name;
  S.isHostingAttempt = false;
  setBusy(true);
  link.join(code);
});

$('code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('join-btn').click();
});
$('code-input').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
});

$('copy-link-btn').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${S.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied');
  } catch {
    prompt('Copy this invite link:', url);
  }
});

$('strict-toggle').addEventListener('change', (e) => {
  if (S.isHost) hostSettings({ strict: e.target.checked });
});

$('winrule-select').addEventListener('change', (e) => {
  if (S.isHost) hostSettings({ winRule: e.target.value });
});

wirePublic(send);
$('crew-btn').addEventListener('click', () => S.isHost && hostSetCrew($('crew-input').value));
$('crew-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('crew-btn').click();
});
// Apply the crew as soon as the host leaves the field, so a typed name is never forgotten.
$('crew-input').addEventListener('change', () => {
  if (!S.isHost) return;
  const typed = $('crew-input').value.replace(/\s+/g, ' ').trim();
  if (typed !== (S.view?.crew || '')) hostSetCrew(typed);
});

$('start-btn').addEventListener('click', () => S.isHost && hostStartGame());
$('rematch-btn').addEventListener('click', () => S.isHost && hostStartGame());
$('share-btn').addEventListener('click', shareResult);
$('hard-toggle').addEventListener('change', (e) => {
  if (S.isHost) hostSettings({ hard: e.target.checked });
});
for (const b of document.querySelectorAll('[data-open-settings]')) b.addEventListener('click', openSettings);
$('settings-close-btn').addEventListener('click', () => ($('settings-sheet').hidden = true));
$('signin-btn').addEventListener('click', async () => {
  $('account-error').textContent = '';
  $('signin-btn').disabled = true;
  try {
    await cloud.signIn();
    loadMyStats();
  } catch (err) {
    console.warn('Sign-in failed', err);
    $('account-error').textContent = cloud.errorText(err);
  } finally {
    $('signin-btn').disabled = false;
  }
});
$('signout-btn').addEventListener('click', async () => {
  try { await cloud.signOut(); } catch (err) { $('account-error').textContent = cloud.errorText(err); }
});
$('pref-sound').addEventListener('change', (e) => { PREFS.sound = e.target.checked; savePrefs(); if (PREFS.sound) sfx('rival'); });
$('pref-contrast').addEventListener('change', (e) => { PREFS.contrast = e.target.checked; savePrefs(); });
$('pref-analytics').addEventListener('change', (e) => { PREFS.analytics = e.target.checked; savePrefs(); cloud.setAnalyticsEnabled(PREFS.analytics); });
$('again-btn').addEventListener('click', () => S.isHost && send({ t: 'next' }));
$('end-btn').addEventListener('click', () => S.isHost && send({ t: 'endGame' }));
$('newgame-btn').addEventListener('click', () => S.isHost && send({ t: 'lobby' }));
$('endround-btn').addEventListener('click', () => {
  if (S.isHost && confirm('End this round now for everyone? Anyone still guessing won’t get the word.')) send({ t: 'endRound' });
});
$('results-leave-btn').addEventListener('click', () => leaveRoom());
for (const id of ['rounds-select', 'timer-select', 'attempts-select']) {
  $(id).addEventListener('change', () => {
    if (!S.isHost || !S.view) return;
    const patch = { maxRounds: Number($('rounds-select').value) };
    if ($('timer-select').dataset.ladder === 'true') patch.ladderTime = Number($('timer-select').value);
    else Object.assign(patch, { timer: Number($('timer-select').value), attempts: Number($('attempts-select').value) });
    hostSettings(patch);
  });
}
for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener('change', (e) => {
    if (S.isHost && e.target.checked) hostSettings({ mode: e.target.value });
  });
}

$('leave-btn').addEventListener('click', () => leaveRoom());

$('see-boards-btn').addEventListener('click', () => {
  S.resultsClosedRound = S.view?.round || 0;
  $('results').hidden = true;
});
$('results-btn').addEventListener('click', () => S.view && showResults(S.view));
$('notice-btn').addEventListener('click', leaveRoom);

$('scores-btn').addEventListener('click', () => ($('scores-sheet').hidden = false));
$('scores-close-btn').addEventListener('click', () => ($('scores-sheet').hidden = true));
$('results-scores-btn').addEventListener('click', () => {
  S.resultsClosedRound = S.view?.round || 0;
  $('results').hidden = true;
  $('scores-sheet').hidden = false;
});

$('keyboard').addEventListener('click', (e) => {
  const b = e.target.closest('.key');
  if (b) pressKey(b.dataset.key);
});

document.addEventListener('keydown', (e) => {
  if ($('screen-game').hidden || !$('results').hidden || !$('notice').hidden || !$('scores-sheet').hidden || !$('settings-sheet').hidden) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement) return;
  const onNote = e.target instanceof HTMLElement && e.target.matches('button.tile');
  // Enter or Space on a focused note cycles that note; typing a letter or Backspace hands the keys back to the word
  if (onNote && (e.key === 'Enter' || e.key === ' ')) return;
  if (onNote && (e.key === 'Backspace' || /^[a-zA-Z]$/.test(e.key))) e.target.blur();
  if (e.key === 'Enter') { e.preventDefault(); pressKey('enter'); }
  else if (e.key === 'Backspace') pressKey('back');
  else if (/^[a-zA-Z]$/.test(e.key)) pressKey(e.key.toLowerCase());
});


/* ---------- start-up ---------- */
(function init() {
  try {
    const saved = localStorage.getItem('wordleparty-name');
    if (saved) $('name-input').value = saved;
  } catch {}

  const room = new URLSearchParams(location.search).get('room');
  if (room && /^[A-Za-z]{4}$/.test(room)) {
    $('code-input').value = room.toUpperCase();
    ($('name-input').value ? $('join-btn') : $('name-input')).focus();
  }
  buildKeyboard();
  showScreen('home');
  savePrefs();
  cloud.onUser((u) => {
    renderAccount(u);
    if (u && !$('settings-sheet').hidden) loadMyStats();   // e.g. the guest's stats just merged into the account
  });
  cloud.mountDeleteData($('delete-data'), { btnClass: 'btn ghost small', onDone: () => renderAccount(cloud.currentUser()) });
  cloud.initAnalytics(PREFS.analytics !== false);
  cloud.restore();
})();
