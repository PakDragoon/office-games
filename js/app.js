import { ANSWERS, EXTRA_GUESSES, BLOCKED_ANSWERS } from './words.js';
import * as cloud from './cloud.js';

/* =========================================================
   Wordle Party
   One player hosts. Their browser is the "server": it picks the
   word, checks every guess and sends everyone the colour patterns.
   Other players connect to the host directly with PeerJS (WebRTC).
   Non-host players never receive the word or anyone's letters.
   ========================================================= */

const PREFIX = 'wordleparty-v1-';      // namespaces our room ids on the PeerJS server
const MAX_PLAYERS = 5;
const ROWS = 6;
const COLS = 5;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';  // no I or O, easy to read out loud

/* ---------- Word lists ----------
   Only the host's browser checks guesses, so only the host downloads these.
   Possible answers: the official NYT Wordle answer list (about 2,300 common words).
   Accepted guesses: everything from every dictionary below that loads, so a real
   word is only rejected if none of them knows it. Each dictionary has a backup
   address, and if everything fails the built-in lists in words.js are used. */
const WORD_SOURCES = {
  answers: [
    'https://cdn.jsdelivr.net/npm/wordles@1.0.0/wordles.json',
    'https://raw.githubusercontent.com/stuartpb/wordles/main/wordles.json',
  ],
  // Public list of offensive words, added on top of the built-in BLOCKED_ANSWERS.
  blocked: [
    'https://cdn.jsdelivr.net/gh/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words@master/en',
    'https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en',
  ],
  dictionaries: [
    // NYT Wordle: words accepted as guesses (about 10,600)
    [
      'https://cdn.jsdelivr.net/npm/wordles@1.0.0/nonwordles.json',
      'https://raw.githubusercontent.com/stuartpb/wordles/main/nonwordles.json',
    ],
    // Community Wordle list (about 14,800, includes words NYT added later)
    [
      'https://cdn.jsdelivr.net/gh/tabatkins/wordle-list@main/words',
      'https://raw.githubusercontent.com/tabatkins/wordle-list/main/words',
    ],
    // General English dictionary (about 275,000 words; the 5-letter ones are kept)
    [
      'https://cdn.jsdelivr.net/npm/an-array-of-english-words@2.0.0/index.json',
      'https://raw.githubusercontent.com/words/an-array-of-english-words/master/index.json',
    ],
  ],
};
// Never picked as the secret word, though they can still be typed as guesses.
const BLOCKED = new Set(BLOCKED_ANSWERS);
const notBlocked = (w) => !BLOCKED.has(w);

const WORDS = {
  answers: ANSWERS.filter(notBlocked),
  valid: new Set([...ANSWERS, ...EXTRA_GUESSES]),
  ready: false,
  big: false,
};
const WIN_RULES = {
  first: 'First to solve it wins.',
  fewest: 'Fewest guesses wins, and the faster time breaks ties.',
};
const CLASS = { h: 'hit', n: 'near', m: 'miss' };
const RANK = { miss: 1, near: 2, hit: 3 };
const PEER_OPTIONS = { debug: 1 };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);

/* ---------- state every player keeps ---------- */
const S = {
  myId: null,
  myName: '',
  isHost: false,
  code: null,
  peer: null,
  hostConn: null,
  leaving: false,
  view: null,          // latest room state from the host
  roundShown: 0,       // which round my board was built for
  guesses: [],         // my guesses: [{ word, pattern }]
  current: '',
  pending: false,      // waiting for the host to score my guess
  keyState: {},
  seenRows: {},        // rival id -> rows already drawn (for the pop animation)
  localStart: 0,
  localStartRound: 0,
  resultsClosedRound: 0,
};

/* ---------- state only the host keeps ---------- */
const H = { room: null, conns: new Map() };

/* =========================================================
   Scoring
   ========================================================= */
function score(guess, answer) {
  const out = Array(COLS).fill('m');
  const left = {};
  for (let i = 0; i < COLS; i++) {
    if (guess[i] === answer[i]) out[i] = 'h';
    else left[answer[i]] = (left[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < COLS; i++) {
    if (out[i] !== 'h' && left[guess[i]] > 0) {
      out[i] = 'n';
      left[guess[i]]--;
    }
  }
  return out.join('');
}

/* =========================================================
   Host
   ========================================================= */
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
    S.peer = peer;
    S.myId = id;
    S.isHost = true;
    S.code = code;
    H.conns.clear();
    H.room = {
      code,
      status: 'lobby',
      round: 0,
      strict: true,
      word: null,
      lastWord: null,
      startedAt: 0,
      players: [newPlayer(id, S.myName, true, 0)],
      winRule: 'first',
      crew: null,      // { id, name } when all-time scores are saved to Firebase
      crewStatus: '',
      allTime: null,   // the crew's saved totals
      used: [],        // answers already played in this room
      stats: {},       // lower-case name -> totals across rounds in this room
      history: [],     // [{ round, word, winner }]
    };
    peer.on('connection', hostOnConnection);
    setBusy(false);
    hostBroadcast();
    const savedCrew = readSavedCrew();
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

function newPlayer(id, name, isHost, color) {
  return { id, name, isHost, color, connected: true, guesses: [], solved: false, done: false, finishMs: null };
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
  if (msg.t === 'join') hostJoin(conn, msg.name);
  if (msg.t === 'guess') hostGuess(conn.peer, msg.word);
}

function hostJoin(conn, rawName) {
  const room = H.room;
  const name = cleanName(rawName) || 'Player';

  // Someone who refreshed or dropped out and comes back with the same name gets their seat
  // (and their guesses) back. A dropped connection can take a few seconds to be noticed,
  // so this also takes over a seat that still looks connected.
  const old = room.players.find((p) => !p.isHost && p.name.toLowerCase() === name.toLowerCase());
  if (old) {
    const oldConn = H.conns.get(old.id);
    H.conns.delete(old.id);
    if (oldConn && oldConn !== conn) oldConn.close();
    old.id = conn.peer;
    old.connected = true;
    H.conns.set(conn.peer, conn);
    send(conn, { t: 'welcome', id: conn.peer, code: room.code });
    if (room.status !== 'lobby') send(conn, { t: 'board', round: room.round, guesses: old.guesses });
    hostBroadcast();
    return;
  }

  if (room.status === 'playing') {
    return reject(conn, 'This round has already started. Join again when it ends.');
  }
  if (room.players.length >= MAX_PLAYERS) {
    room.players = room.players.filter((p) => p.connected);
  }
  if (room.players.length >= MAX_PLAYERS) {
    return reject(conn, `This room is full (${MAX_PLAYERS} players).`);
  }

  let finalName = name;
  let n = 2;
  while (room.players.some((p) => p.name.toLowerCase() === finalName.toLowerCase())) {
    finalName = `${name} ${n++}`;
  }

  room.players.push(newPlayer(conn.peer, finalName, false, freeColor()));
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
  if (H.room.status === 'lobby') {
    H.room.players = H.room.players.filter((x) => x !== p);
  } else {
    p.connected = false;
  }
  hostCheckEnd();
  hostBroadcast();
}

function hostStart() {
  const room = H.room;
  room.players = room.players.filter((p) => p.connected);
  // No repeats within a room until every possible answer has been played.
  const used = new Set(room.used);
  let pool = WORDS.answers.filter((w) => !used.has(w) && notBlocked(w));
  if (pool.length === 0) {
    room.used = [];
    pool = WORDS.answers.filter((w) => w !== room.lastWord && notBlocked(w));
  }
  const word = pool[Math.floor(Math.random() * pool.length)];
  room.used.push(word);
  room.word = word;
  room.lastWord = word;
  room.round += 1;
  room.status = 'playing';
  room.startedAt = Date.now();
  for (const p of room.players) {
    p.guesses = [];
    p.solved = false;
    p.done = false;
    p.finishMs = null;
  }
  hostBroadcast();
}

function hostGuess(pid, rawWord) {
  const room = H.room;
  const p = room.players.find((x) => x.id === pid);
  if (!p) return;
  const reply = (m) => (pid === S.myId ? onMessage(m) : send(H.conns.get(pid), m));

  const word = String(rawWord || '').toLowerCase();
  if (room.status !== 'playing' || p.done) return reply({ t: 'invalid', reason: 'This round is over' });
  if (!/^[a-z]{5}$/.test(word)) return reply({ t: 'invalid', reason: 'Not enough letters' });
  if (room.strict && !WORDS.valid.has(word)) return reply({ t: 'invalid', reason: 'Not in word list' });

  const pattern = score(word, room.word);
  p.guesses.push({ word, pattern });
  if (pattern === 'hhhhh') {
    p.solved = true;
    p.done = true;
    p.finishMs = Date.now() - room.startedAt;
  } else if (p.guesses.length >= ROWS) {
    p.done = true;
    p.finishMs = Date.now() - room.startedAt;
  }
  reply({ t: 'result', round: room.round, word, pattern });
  hostCheckEnd();
  hostBroadcast();
}

function hostCheckEnd() {
  const room = H.room;
  if (room.status === 'playing' && room.players.every((p) => p.done || !p.connected)) {
    room.status = 'ended';
    hostRecordRound();
  }
}

// Add the finished round to the room's running scores. Scores are keyed by name,
// so they survive someone refreshing and rejoining.
function hostRecordRound() {
  const room = H.room;
  const players = publicView().players;
  const order = ranked(players, room.winRule);
  const winner = order[0] && order[0].solved ? order[0] : null;
  for (const p of players) {
    const key = p.name.toLowerCase();
    const st = (room.stats[key] ||= { name: p.name, color: p.color, played: 0, wins: 0, solved: 0, guessSum: 0, bestMs: null });
    st.name = p.name;
    st.color = p.color;
    st.played += 1;
    if (p.solved) {
      st.solved += 1;
      st.guessSum += p.patterns.length;
      if (st.bestMs == null || p.finishMs < st.bestMs) st.bestMs = p.finishMs;
    }
    if (winner && p.id === winner.id) st.wins += 1;
  }
  room.history.push({ round: room.round, word: room.word, winner: winner ? winner.name : null });

  if (room.crew) {
    const crew = room.crew;
    const record = {
      word: room.word,
      winRule: room.winRule,
      winner: winner ? winner.name : null,
      room: room.code,
      players: players.map((p) => ({
        name: p.name,
        solved: p.solved,
        guesses: p.patterns.length,
        ms: p.solved ? p.finishMs : null,
      })),
    };
    room.crewStatus = 'Saving this round…';
    cloud.saveRound(crew.id, crew.name, record)
      .then((saved) => {
        if (H.room !== room || room.crew?.id !== crew.id) return;
        room.allTime = saved;
        room.crewStatus = `Saved. ${saved.rounds.toLocaleString('en-US')} rounds played as this crew.`;
        hostBroadcast();
      })
      .catch((err) => {
        console.warn('Saving to crew failed', err);
        if (H.room !== room) return;
        room.crewStatus = `This round wasn’t saved. ${cloud.errorText(err)}`;
        hostBroadcast();
      });
  }
}

/* ---------- crews: all-time scores saved in Firebase (host only) ---------- */
function readSavedCrew() {
  try { return localStorage.getItem('wordleparty-crew') || ''; } catch { return ''; }
}

async function hostSetCrew(rawName) {
  const room = H.room;
  if (!room) return;
  const name = String(rawName || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  try { localStorage.setItem('wordleparty-crew', name); } catch {}
  if (!name) {
    room.crew = null;
    room.allTime = null;
    room.crewStatus = '';
    hostBroadcast();
    return;
  }
  const id = cloud.crewId(name);
  if (id.length < 3) {
    toast('Crew names need at least 3 letters or numbers');
    return;
  }
  room.crew = { id, name };
  room.allTime = null;
  room.crewStatus = 'Connecting to saved scores…';
  hostBroadcast();
  try {
    const data = await cloud.loadCrew(id);
    if (H.room !== room || room.crew?.id !== id) return;
    room.allTime = data;
    room.crewStatus = data
      ? `${data.rounds.toLocaleString('en-US')} rounds played as this crew so far.`
      : 'New crew. Scores start saving after the first round.';
  } catch (err) {
    console.warn('Loading crew failed', err);
    if (H.room !== room || room.crew?.id !== id) return;
    room.crewStatus = cloud.errorText(err);
  }
  hostBroadcast();
}

function publicView() {
  const room = H.room;
  return {
    t: 'state',
    code: room.code,
    status: room.status,
    round: room.round,
    strict: room.strict,
    winRule: room.winRule,
    elapsed: room.startedAt ? Date.now() - room.startedAt : 0,
    // Only colour patterns go out. Letters stay on the host.
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      isHost: p.isHost,
      connected: p.connected,
      patterns: p.guesses.map((g) => g.pattern),
      solved: p.solved,
      done: p.done,
      finishMs: p.finishMs,
    })),
    word: room.status === 'ended' ? room.word : null,
    stats: Object.values(room.stats),
    crew: room.crew ? room.crew.name : null,
    crewStatus: room.crewStatus,
    allTime: room.allTime,
    history: room.history.slice(-10),
  };
}

function hostBroadcast() {
  const view = publicView();
  for (const conn of H.conns.values()) send(conn, view);
  onMessage(view);
}

/* =========================================================
   Joining
   ========================================================= */
function joinRoom(code) {
  const peer = new Peer(PEER_OPTIONS);
  let connected = false;
  let failed = false;

  const fail = (text) => {
    if (failed || connected) return;
    failed = true;
    clearTimeout(timer);
    setBusy(false);
    homeError(text);
    peer.destroy();
  };
  const timer = setTimeout(() => fail('Could not reach that room. Check the code, or ask the host to keep their tab open.'), 15000);

  peer.on('open', (id) => {
    S.peer = peer;
    S.myId = id;
    S.isHost = false;
    const conn = peer.connect(PREFIX + code, { reliable: true });
    conn.on('open', () => {
      connected = true;
      clearTimeout(timer);
      S.hostConn = conn;
      send(conn, { t: 'join', name: S.myName });
    });
    conn.on('data', onMessage);
    conn.on('close', () => {
      if (S.leaving || !connected) return;
      showNotice('The room closed', 'The host left or lost their connection. Ask them to host a new room.');
    });
  });

  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') fail(`There’s no room ${code} right now. Check the code with your host.`);
    else if (!connected) fail(peerErrorText(err));
    else console.warn('PeerJS error', err);
  });
}

function peerErrorText(err) {
  if (err.type === 'browser-incompatible') return 'This browser can’t do live connections. Try Chrome, Firefox, Edge or Safari.';
  if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error')
    return 'Couldn’t reach the connection server. Check your internet and try again.';
  return `Connection failed (${err.type || 'unknown error'}). Try again.`;
}

function send(conn, msg) {
  if (conn && conn.open) conn.send(msg);
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
      setBusy(false);
      break;
    case 'reject':
      S.leaving = true;
      setBusy(false);
      S.peer?.destroy();
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
  $('game-round').textContent = `Round ${v.round}`;
  renderRivals(v);
  renderScores(v);
  announceRivals(prev, v);
  tickClock();

  $('results-btn').hidden = v.status !== 'ended';
  if (v.status === 'ended') {
    if (S.resultsClosedRound !== v.round) showResults(v);
  } else {
    $('results').hidden = true;
  }
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
    if (msg.pattern === 'hhhhh') toast(winLine(S.guesses.length));
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
  if (S.isHost) hostGuess(S.myId, S.current);
  else send(S.hostConn, { t: 'guess', word: S.current });
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
  if (p.done) return 'Out of guesses';
  if (S.view.status === 'ended') return `${n} of 6 used`;
  return n === 0 ? 'Thinking…' : `${n} of 6 guesses`;
}

function announceRivals(prev, v) {
  if (!prev || prev.round !== v.round) return;
  for (const p of v.players) {
    if (p.id === S.myId) continue;
    const before = prev.players.find((x) => x.id === p.id || x.name === p.name);
    if (before && !before.solved && p.solved) toast(`${label(p.name)} solved it in ${p.patterns.length}!`);
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
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = [p.isHost ? 'host' : '', p.id === S.myId ? 'you' : ''].filter(Boolean).join(', ');
    li.append(dot, name, tag);
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
  $('lobby-rules').textContent = WIN_RULES[v.winRule] || '';
  $('lobby-rules').hidden = S.isHost;
  $('word-status').textContent = wordStatusText();
  $('word-status').hidden = !S.isHost;
  const crewLine = $('crew-status');
  crewLine.textContent = v.crew
    ? `Crew “${v.crew}”: ${v.crewStatus}`
    : S.isHost ? 'All-time scores aren’t being saved. Add a crew name to save them.' : '';
  crewLine.hidden = !crewLine.textContent;
  if (S.isHost && document.activeElement !== $('crew-input')) $('crew-input').value = v.crew || '';
  if (S.isHost) {
    $('strict-toggle').checked = v.strict;
    for (const r of document.querySelectorAll('input[name="win-rule"]')) r.checked = r.value === v.winRule;
    $('start-btn').disabled = !WORDS.ready;
    const n = v.players.length;
    $('start-btn').textContent = !WORDS.ready
      ? 'Loading words…'
      : n === 1 ? 'Start solo (for testing)' : `Start game with ${n} players`;
  } else {
    const host = v.players.find((p) => p.isHost);
    $('lobby-wait').textContent = `Waiting for ${host ? label(host.name) : 'the host'} to start the game.`;
  }
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
  return `<h3 class="scores-sub">This room</h3>${roomScoresHTML(v)}${crewScoresHTML(v)}`;
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

function roomScoresHTML(v) {
  const stats = v.stats || [];
  if (stats.length === 0) {
    return '<p class="scores-empty">Wins and times show up here once the first round ends. They carry over for every round you play in this room.</p>';
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
    ${history ? `<p class="history-title">Past words</p><ul class="history">${history}</ul>` : ''}`;
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
    else if (p.patterns.length === 0 && !p.done) how.textContent = 'Joined late';
    else how.textContent = 'X/6';
    li.append(dot, who, how);
    list.appendChild(li);
  });

  const winner = order[0];
  $('results-title').textContent = !winner?.solved
    ? 'Nobody got it'
    : winner.id === S.myId
      ? 'You win!'
      : `${label(winner.name)} wins`;

  $('again-btn').hidden = !S.isHost;
  $('again-wait').hidden = S.isHost;
  $('results').hidden = false;
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
  let ms;
  if (m && m.done) ms = m.finishMs;
  else if (v.status === 'ended') ms = null;
  else ms = Date.now() - S.localStart;
  $('game-clock').textContent = ms == null ? '–' : fmtTime(ms);
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
  $('join-btn').disabled = busy;
  $('host-btn').textContent = busy && S.isHostingAttempt ? 'Creating room…' : 'Host a room';
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
  S.peer = null;
  S.hostConn = null;
  S.view = null;
  S.isHost = false;
  S.code = null;
  S.roundShown = 0;
  S.localStartRound = 0;
  H.room = null;
  H.conns.clear();
}

function leaveRoom() {
  S.leaving = true;
  try { S.peer?.destroy(); } catch {}
  resetLocal();
  $('notice').hidden = true;
  homeError('');
  showScreen('home');
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
  S.leaving = false;
  S.isHostingAttempt = true;
  setBusy(true);
  loadWords();
  hostCreate();
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
  S.leaving = false;
  S.isHostingAttempt = false;
  setBusy(true);
  joinRoom(code);
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
  if (!S.isHost) return;
  H.room.strict = e.target.checked;
  hostBroadcast();
});

for (const r of document.querySelectorAll('input[name="win-rule"]')) {
  r.addEventListener('change', (e) => {
    if (!S.isHost || !e.target.checked) return;
    H.room.winRule = e.target.value;
    hostBroadcast();
  });
}

$('crew-btn').addEventListener('click', () => S.isHost && hostSetCrew($('crew-input').value));
$('crew-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('crew-btn').click();
});

$('start-btn').addEventListener('click', () => S.isHost && hostStart());
$('again-btn').addEventListener('click', () => S.isHost && hostStart());

$('leave-btn').addEventListener('click', () => {
  if (S.isHost && H.conns.size > 0 && !confirm('Leaving closes the room for everyone. Leave anyway?')) return;
  leaveRoom();
});

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
  if ($('screen-game').hidden || !$('results').hidden || !$('notice').hidden || !$('scores-sheet').hidden) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'Enter') { e.preventDefault(); pressKey('enter'); }
  else if (e.key === 'Backspace') pressKey('back');
  else if (/^[a-zA-Z]$/.test(e.key)) pressKey(e.key.toLowerCase());
});

// Close connections cleanly on refresh/close so the others find out straight away.
window.addEventListener('pagehide', () => {
  S.leaving = true;
  try { S.peer?.destroy(); } catch {}
});

window.addEventListener('beforeunload', (e) => {
  if (S.isHost && H.conns.size > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ---------- word list loading ---------- */
async function fetchWordList(urls, minWords = 500) {
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        clearTimeout(timer);
        continue;
      }
      const text = await res.text();
      clearTimeout(timer);
      // Lists come either as a JSON array or as plain text with one word per line.
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = text.split(/\s+/);
      }
      const list = (Array.isArray(raw) ? raw : [])
        .map((w) => String(w).trim().toLowerCase())
        .filter((w) => /^[a-z]{5}$/.test(w));
      if (list.length >= minWords) return list;
    } catch {
      // try the next source
    }
  }
  return null;
}

let wordsLoading = null;
function loadWords() {
  wordsLoading ||= (async () => {
    const [blocked, answers, ...dicts] = await Promise.all([
      fetchWordList(WORD_SOURCES.blocked, 1),
      fetchWordList(WORD_SOURCES.answers),
      ...WORD_SOURCES.dictionaries.map((urls) => fetchWordList(urls)),
    ]);
    for (const w of blocked || []) BLOCKED.add(w);
    WORDS.answers = [...new Set([...(answers || []), ...ANSWERS])].filter(notBlocked);
    for (const list of [answers, ...dicts]) {
      for (const w of list || []) WORDS.valid.add(w);
    }
    WORDS.loaded = dicts.filter(Boolean).length;
    WORDS.big = WORDS.loaded > 0;
    WORDS.ready = true;
    if (S.view && S.view.status === 'lobby') renderLobby(S.view);
  })();
  return wordsLoading;
}

function wordStatusText() {
  if (!WORDS.ready) return 'Loading the word list…';
  const n = (x) => x.toLocaleString('en-US');
  if (WORDS.big) {
    const missing = WORD_SOURCES.dictionaries.length - WORDS.loaded;
    return `${n(WORDS.valid.size)} words accepted as guesses, ${n(WORDS.answers.length)} can be the answer.` +
      (missing ? ` (${missing} of the ${WORD_SOURCES.dictionaries.length} dictionaries didn’t load.)` : '');
  }
  return `Couldn’t download the full word list, so the built-in ${n(WORDS.valid.size)} words are in use.`;
}

/* ---------- start-up ---------- */
(function init() {
  if (typeof Peer === 'undefined') {
    homeError('Couldn’t load the connection library. Check your internet and reload the page.');
  }
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
})();
