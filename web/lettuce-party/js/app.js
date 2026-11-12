import * as cloud from './cloud.js';
import { createRoomLink, quickPlay } from '../../shared/net.js';

/* =========================================================
   Lettuce Party
   The game runs on the server (server/src/games/lettuce.ts): it picks the
   word, checks every guess and sends everyone the colour patterns.
   Nobody receives the word or anyone else's letters until the round ends.
   ========================================================= */

const MAX_PLAYERS = 5;
const ROWS = 6;
const COLS = 5;

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
  guesses: [],         // my guesses: [{ word, pattern }]
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
      S.guesses = msg.guesses;
      S.current = '';
      S.pending = false;
      buildBoard();
      buildKeyboard();
      S.guesses.forEach((g, r) => paintRow(r, g.word, g.pattern, false));
      updateKeyboard();
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
  if (!m.done && m.patterns.length === 0) return;
  S.trackedRound = v.round;
  cloud.track('round_played', { solved: m.solved ? 1 : 0, guesses: m.patterns.length });
}


function startLocalRound(v) {
  S.roundShown = v.round;
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
  board.innerHTML = '';
  for (let r = 0; r < ROWS; r++) {
    const row = document.createElement('div');
    row.className = 'row';
    for (let c = 0; c < COLS; c++) {
      const t = document.createElement('div');
      t.className = 'tile';
      row.appendChild(t);
    }
    board.appendChild(row);
  }
}

function rowEl(r) {
  return $('my-board').children[r];
}

function drawCurrent() {
  const row = rowEl(S.guesses.length);
  if (!row) return;
  [...row.children].forEach((t, i) => {
    const ch = S.current[i] || '';
    t.textContent = ch;
    t.className = 'tile' + (ch ? ' filled' : '');
  });
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

function shakeRow(r) {
  const row = rowEl(r);
  if (!row) return;
  row.classList.remove('shake');
  void row.offsetWidth;
  row.classList.add('shake');
}

function onResult(msg) {
  if (msg.round !== S.roundShown) return;
  const r = S.guesses.length;
  S.guesses.push({ word: msg.word, pattern: msg.pattern });
  S.current = '';
  S.pending = false;
  paintRow(r, msg.word, msg.pattern, true);
  const wait = reduceMotion ? 0 : COLS * 250 + 250;
  setTimeout(() => {
    updateKeyboard();
    if (msg.pattern === 'hhhhh') {
      toast(winLine(S.guesses.length));
      sfx('win');
    }
    else if (S.guesses.length >= ROWS) toast('Out of guesses. Waiting for the others.');
  }, wait);
}

function winLine(n) {
  return ['Unreal!', 'Brilliant!', 'Great!', 'Nice!', 'Solid!', 'Phew!'][n - 1] || 'Solved!';
}

/* ---------- typing ---------- */
function canType() {
  const v = S.view;
  const m = me();
  return v && v.status === 'playing' && m && !m.done && !S.pending && S.guesses.length < ROWS;
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

function updateKeyboard() {
  for (const g of S.guesses) {
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
  const card = document.createElement('div');
  card.className = `rival c${p.color}` + (p.solved ? ' solved' : '') + (p.connected ? '' : ' offline');

  const mini = document.createElement('div');
  mini.className = 'mini';
  mini.setAttribute('aria-hidden', 'true');
  const seen = S.seenRows[p.id] || 0;
  for (let r = 0; r < ROWS; r++) {
    const row = document.createElement('div');
    const pat = p.patterns[r];
    row.className = 'mrow' + (pat && r >= seen && !reduceMotion ? ' new' : '');
    for (let c = 0; c < COLS; c++) {
      const cell = document.createElement('i');
      if (pat) cell.className = CLASS[pat[c]];
      row.appendChild(cell);
    }
    mini.appendChild(row);
  }
  S.seenRows[p.id] = p.patterns.length;

  const name = document.createElement('div');
  name.className = 'rival-name';
  name.textContent = label(p.name);

  const status = document.createElement('div');
  status.className = 'rival-status';
  status.textContent = rivalStatus(p);

  card.setAttribute('aria-label', `${label(p.name)}: ${status.textContent}`);
  card.append(mini, name, status);
  return card;
}

function rivalStatus(p) {
  const n = p.patterns.length;
  if (!p.connected) return 'Disconnected';
  if (p.solved) return `Solved in ${n} (${fmtTime(p.finishMs)})`;
  if (p.timedOut) return 'Out of time';
  if (p.stopped) return 'Round ended';
  if (p.done) return 'Out of guesses';
  if (S.view.status !== 'playing') return `${n} of 6 used`;
  return n === 0 ? 'Thinking…' : `${n} of 6 guesses`;
}

function announceRivals(prev, v) {
  if (!prev || prev.round !== v.round) return;
  for (const p of v.players) {
    if (p.id === S.myId) continue;
    const before = prev.players.find((x) => x.id === p.id || x.name === p.name);
    if (before && !before.solved && p.solved) {
      toast(`${label(p.name)} solved it in ${p.patterns.length}!`);
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
  $('lobby-wait').hidden = S.isHost;
  $('lobby-rules').textContent = settingsSummary(v);
  $('lobby-rules').hidden = S.isHost;
  $('word-status').hidden = true;
  const crewLine = $('crew-status');
  crewLine.textContent = v.crew
    ? `Crew “${v.crew}”: ${v.crewStatus}`
    : S.isHost ? 'All-time scores aren’t being saved. Add a crew name to save them.' : '';
  crewLine.hidden = !crewLine.textContent;
  if (S.isHost && document.activeElement !== $('crew-input')) $('crew-input').value = v.crew || '';
  if (S.isHost) {
    $('strict-toggle').checked = v.strict;
    for (const r of document.querySelectorAll('input[name="win-rule"]')) r.checked = r.value === v.winRule;
    $('rounds-select').value = String(v.maxRounds);
    $('hard-toggle').checked = v.hard;
    $('timer-select').value = String(v.timer);
    const n = v.players.length;
    $('start-btn').textContent = n === 1 ? 'Start solo (for testing)' : `Start game with ${n} players`;
  } else {
    const host = v.players.find((p) => p.isHost);
    $('lobby-wait').textContent = `Waiting for ${host ? label(host.name) : 'the host'} to start the game.`;
  }
}

function settingsSummary(v) {
  const rounds = v.maxRounds ? `${v.maxRounds} rounds` : 'Unlimited rounds';
  const timer = v.timer ? `${v.timer / 60} minute${v.timer === 60 ? '' : 's'} per round` : 'no timer';
  return `${WIN_RULES[v.winRule] || ''} ${rounds}, ${timer}.${v.hard ? ' Hard mode.' : ''}`;
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
      <thead><tr><th scope="col">Player</th><th scope="col">Wins</th><th scope="col">Solved</th><th scope="col" title="Average guesses when solved">Avg</th><th scope="col" title="Fastest solve">Best</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${history && withHistory ? `<p class="history-title">Past words</p><ul class="history">${history}</ul>` : ''}`;
}

/* =========================================================
   Results
   ========================================================= */
function ranked(players, rule = 'first') {
  const greens = (p) => {
    const last = p.patterns[p.patterns.length - 1] || '';
    return [...last].filter((c) => c === 'h').length;
  };
  return [...players].sort((a, b) => {
    if (a.solved !== b.solved) return a.solved ? -1 : 1;
    if (a.solved && rule === 'fewest') return a.patterns.length - b.patterns.length || a.finishMs - b.finishMs;
    if (a.solved) return a.finishMs - b.finishMs || a.patterns.length - b.patterns.length;
    return greens(b) - greens(a);
  });
}

function showResults(v) {
  const word = $('results-word');
  word.innerHTML = '';
  for (const ch of v.word || '') {
    const i = document.createElement('i');
    i.textContent = ch;
    word.appendChild(i);
  }

  const list = $('results-list');
  list.innerHTML = '';
  const order = ranked(v.players, v.winRule);
  $('results-rule').textContent = WIN_RULES[v.winRule] || '';
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
    if (p.solved) how.textContent = `${p.patterns.length}/6 in ${fmtTime(p.finishMs)}`;
    else if (!p.connected) how.textContent = 'Left';
    else if (p.timedOut) how.textContent = 'Out of time';
    else if (p.stopped) how.textContent = 'Round ended';
    else if (p.patterns.length === 0 && !p.done) how.textContent = 'Joined late';
    else how.textContent = 'X/6';
    li.append(dot, who, how);
    list.appendChild(li);
  });

  const winner = order[0];
  const over = v.status === 'over';
  const roundTitle = !winner?.solved
    ? 'Nobody got it'
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
    const lastRound = !winner?.solved ? 'nobody got it' : winner.id === S.myId ? 'you won it' : `${label(winner.name)} won it`;
    $('results-round-label').textContent = `Last round: ${lastRound}. The word was`;
  } else {
    $('results-title').textContent = roundTitle;
    $('results-round-label').textContent = (v.maxRounds ? `Round ${v.matchRound} of ${v.maxRounds}` : `Round ${v.matchRound}`) + '. The word was';
  }

  $('again-btn').hidden = !S.isHost || over;
  $('end-btn').hidden = !S.isHost || over;
  $('rematch-btn').hidden = !S.isHost || !over;
  $('newgame-btn').hidden = !S.isHost || !over;
  $('share-btn').hidden = !me() || me().patterns.length === 0;
  showMeaning(v.word);
  $('again-wait').hidden = S.isHost;
  $('again-wait').textContent = over
    ? 'Waiting for the host to set up a new game.'
    : 'Waiting for the host to start the next round.';
  $('results').hidden = false;
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
  const squares = PREFS.contrast ? { h: '🟧', n: '🟦', m: '⬛' } : { h: '🟩', n: '🟨', m: '⬛' };
  const score = m.solved ? `${m.patterns.length}/6` : 'X/6';
  const time = m.solved ? ` in ${fmtTime(m.finishMs)}` : '';
  const roundLabel = v.maxRounds ? `round ${v.matchRound} of ${v.maxRounds}` : `round ${v.matchRound}`;
  const grid = m.patterns.map((p) => [...p].map((c) => squares[c]).join('')).join('\n');
  const text = `Lettuce Party, ${roundLabel}${v.hard ? ' (hard)' : ''}: ${score}${time}\n\n${grid}`;
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
  if (v.timer && v.status === 'playing') {
    const left = Math.max(0, v.timer * 1000 - (Date.now() - S.localStart));
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
  $('stats-section').hidden = !u;
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

function myStatsHTML(st) {
  if (!st.games) return '<p class="stats-note">Play a round and your stats will show up here.</p>';
  const winPct = Math.round((st.wins / st.games) * 100);
  const avg = st.solved ? (st.guessSum / st.solved).toFixed(1) : '–';
  const max = Math.max(1, ...st.dist);
  const opener = Object.entries(st.openers).sort((a, b) => b[1] - a[1])[0];
  const stat = (n, t) => `<div class="stat"><b>${n}</b><span>${t}</span></div>`;
  const bars = st.dist.map((n, i) =>
    `<div class="dist-row"><span>${i + 1}</span><span class="dist-bar ${n === max && n > 0 ? 'top' : ''}" style="width: ${Math.max(8, (n / max) * 100)}%">${n}</span></div>`).join('');
  return `
    <div class="stat-grid">
      ${stat(st.games, 'Played')}${stat(`${winPct}%`, 'Rounds won')}${stat(avg, 'Avg guesses')}
      ${stat(st.streak, 'Win streak')}${stat(st.bestStreak, 'Best streak')}${stat(st.bestMs == null ? '–' : fmtTime(st.bestMs), 'Fastest')}
    </div>
    <p class="stats-note">Guesses needed when solved</p>
    <div class="dist">${bars}</div>
    ${opener ? `<p class="stats-note">Favorite opener: <b>${esc(opener[0].toUpperCase())}</b>, used ${opener[1]} time${opener[1] === 1 ? '' : 's'}</p>` : ''}`;
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

for (const r of document.querySelectorAll('input[name="win-rule"]')) {
  r.addEventListener('change', (e) => {
    if (S.isHost && e.target.checked) hostSettings({ winRule: e.target.value });
  });
}

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
for (const id of ['rounds-select', 'timer-select']) {
  $(id).addEventListener('change', () => {
    if (S.isHost) hostSettings({ maxRounds: Number($('rounds-select').value), timer: Number($('timer-select').value) });
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
  });
  cloud.initAnalytics(PREFS.analytics !== false);
  cloud.restore();
})();
