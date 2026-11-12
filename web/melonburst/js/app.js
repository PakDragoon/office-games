import * as E from './engine.js';
import * as cloud from './cloud.js';
import { createRoomLink, quickPlay } from '../../shared/net.js';
import { wirePublic, paintPublic, publicLine } from '../../shared/public.js';
import { createMelon } from './melon.js';

/* =========================================================
   Melon Burst
   Guess a hidden word letter by letter; every wrong letter snaps a rubber band round your
   watermelon, and one band too many bursts it.
   Race: the computer picks a word and 2-8 players race on it, each on their own melon.
   Pick words: two sides (1 vs 1 or 2 vs 2) pick words for each other, then guess.
   One player hosts: their browser is the "server". It holds the words, checks every guess and
   sends each player their own view (nobody gets letters they shouldn't see). Connections use
   PeerJS (WebRTC). The daily word and practice run the same host code locally, alone.
   ========================================================= */

const SOLO_ID = 'me';
const SIDES = ['A', 'B'];
const otherSide = (t) => (t === 'A' ? 'B' : 'A');

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ---------- This browser only ---------- */
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`melonburst.${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`melonburst.${key}`, JSON.stringify(value)); } catch { /* not saved */ }
  },
};
const PREFS = { sound: true, vibrate: true, anim: 'on', analytics: true, ...store.get('prefs', {}) };
let ROOM_PREFS = E.cleanSettings(store.get('room', {}));
const PRACTICE = { length: 'medium', ...store.get('practice', {}) };
if (!E.LENGTHS[PRACTICE.length]) PRACTICE.length = 'medium';
const savePrefs = () => store.set('prefs', PREFS);
const saveRoomPrefs = () => store.set('room', ROOM_PREFS);


/* ---------- Word lists ---------- */
// common + more (the computer's words) load first; valid (what players may pick) is big and loads after
const WORDS = { lex: E.makeLexicon(), base: false, full: false, failed: false, basePromise: null, fullPromise: null };
const fetchList = (f) => fetch(`words/${f}`).then((r) => { if (!r.ok) throw new Error(f); return r.text(); }).then((t) => t.split('\n').filter(Boolean));
function loadBase() {
  WORDS.basePromise ||= Promise.all([fetchList('common.txt'), fetchList('more.txt')]).then(([common, more]) => {
    WORDS.lex = E.makeLexicon(common, more, WORDS.full ? [...WORDS.lex.valid] : []);
    WORDS.base = true;
    wordsChanged();
  }).catch((err) => { console.warn('Word lists failed to load', err); WORDS.failed = true; WORDS.basePromise = null; wordsChanged(); });
  return WORDS.basePromise;
}
function loadFull() {
  WORDS.fullPromise ||= Promise.all([loadBase(), fetchList('valid.txt')]).then(([, valid]) => {
    WORDS.lex = E.makeLexicon(WORDS.lex.common, WORDS.lex.more, valid);
    WORDS.full = true;
    wordsChanged();
  }).catch((err) => { console.warn('Dictionary failed to load', err); WORDS.failed = true; WORDS.fullPromise = null; wordsChanged(); });
  return WORDS.fullPromise;
}

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

let flashTimer = 0;
function flash(html, cls = '', ms = 2000) {
  const el = $('flash');
  el.innerHTML = html;
  el.className = `flash show ${cls}`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.className = 'flash'; }, ms);
}

/* ---------- Sounds (made on the fly, no files) ---------- */
let audio = null;
function ctx() {
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
  return audio;
}
function tone(freq, start, dur, vol = 0.16, type = 'sine', slide = 0) {
  const a = ctx();
  if (!a) return;
  const t = a.currentTime + start;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
function noise(dur, vol, cutoff) {
  const a = ctx();
  if (!a) return;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = buf;
  f.type = 'lowpass';
  f.frequency.value = cutoff;
  g.gain.value = vol;
  src.connect(f).connect(g).connect(a.destination);
  src.start();
}
const SOUND = {
  hit() { if (PREFS.sound) { tone(660, 0, 0.12, 0.12, 'triangle'); tone(990, 0.06, 0.16, 0.1, 'triangle'); } },
  // the twang of a rubber band
  snap() {
    if (PREFS.vibrate && navigator.vibrate) navigator.vibrate(60);
    if (PREFS.sound) { tone(320, 0, 0.32, 0.18, 'sawtooth', 0.45); tone(160, 0, 0.25, 0.1, 'square', 0.6); }
  },
  burst() {
    if (PREFS.vibrate && navigator.vibrate) navigator.vibrate([80, 40, 160]);
    if (!PREFS.sound) return;
    noise(0.6, 0.7, 1400);
    tone(140, 0, 0.5, 0.35, 'sine', 0.25);
  },
  solved() { if (PREFS.sound) [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.08, 0.24, 0.12, 'triangle')); },
  tick() { if (PREFS.sound) tone(1500, 0, 0.03, 0.035, 'square'); },
  go() { if (PREFS.sound) tone(880, 0, 0.18, 0.12); },
  nope() { if (PREFS.sound) tone(150, 0, 0.16, 0.1, 'sawtooth'); },
  win() { if (PREFS.sound) [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.09, 0.3, 0.12, 'triangle')); },
};

/* =========================================================
   The daily word and practice run the game here, in this browser (rooms run on the server,
   server/src/games/melonburst.ts, from the same code)
   ========================================================= */
const S = {
  myName: '', myId: null, isHost: false, code: '', view: null, creating: false,
  reconnecting: false, viewAt: 0, focus: null, sent: new Set(), roundKey: '',
  myPrev: null, overSeen: -1, pickDraft: '', pickError: '', meaningFor: '', streak: 0,
};
const H = { room: null, timer: 0, rnd: Math.random };


function newRoom(code, solo, settings) {
  return {
    code, solo, status: 'lobby', settings: { ...settings }, game: 0, players: [],
    teams: { A: [null, null], B: [null, null] },
    round: 0, phase: '', phaseEnd: 0, guessStart: 0,
    word: '', picks: { A: '', B: '' }, auto: { A: false, B: false }, pickers: { A: null, B: null },
    guesses: {}, solvedOrder: [], used: new Set(), last: null, standings: null, winners: [],
    crew: null, crewStatus: '', day: '',
  };
}


function newPlayer(id, name, isHost, color, uid = null, photo = '') {
  return {
    id, name, isHost, color, uid, photo, clientId: '', connected: true, away: false, offlineAt: 0,
    inGame: false, score: 0, solved: 0, ms: 0, wins: 0,
  };
}




// Solo only: this browser's own moves
function hostOnMessage(msg) {
  if (!msg || typeof msg !== 'object' || !H.room) return;
  if (msg.t === 'guess') hostGuess(SOLO_ID, msg.ch);
}





const active = (p) => p.connected && !p.away;
const byId = (id) => H.room.players.find((p) => p.id === id);
const perSide = () => E.seatsFor(H.room.settings);
const sideOf = (id) => SIDES.find((t) => H.room.teams[t].slice(0, perSide()).includes(id)) || null;
const isSeated = (id) => Boolean(sideOf(id));

// Who is guessing this round
function participants() {
  const room = H.room;
  if (room.solo) return [SOLO_ID];
  if (room.settings.mode === 'pick') return SIDES.flatMap((t) => room.teams[t].slice(0, perSide())).filter(Boolean);
  return room.players.filter((p) => p.inGame).map((p) => p.id);
}


// Someone left or went quiet: the round may not need to wait for them any more
function hostAfterPresence() {
  const room = H.room;
  if (room.status !== 'play') return;
  if (room.phase === 'guess') hostCheckRoundDone();
  if (room.phase === 'pick') {
    for (const t of SIDES) {
      const p = room.pickers[t] && byId(room.pickers[t]);
      if (!room.picks[t] && (!p || !p.connected)) hostAutoPick(t);
    }
    hostCheckPicks();
  }
}

/* ---------- Seats for "Pick words" (in the lobby) ---------- */

// Empty seats are filled by whoever isn't sitting yet, in the order they joined
function hostAutoSeat() {
  const room = H.room;
  if (room.solo || room.status !== 'lobby') return;
  const n = perSide();
  for (const t of SIDES) for (let k = n; k < 2; k++) room.teams[t][k] = null;
  for (const t of SIDES) room.teams[t] = room.teams[t].map((x) => (x && byId(x) ? x : null));
  if (room.settings.mode !== 'pick') return;
  const order = [['A', 0], ['B', 0], ['A', 1], ['B', 1]].filter(([, k]) => k < n);
  for (const p of room.players) {
    if (!p.connected || isSeated(p.id)) continue;
    const free = order.find(([t, k]) => !room.teams[t][k]);
    if (!free) break;
    room.teams[free[0]][free[1]] = p.id;
  }
}




/* ---------- A game ---------- */

function setTimer(ms, fn) {
  clearTimeout(H.timer);
  H.timer = setTimeout(fn, Math.max(0, ms));
}

const totalRounds = (room) => (room.solo === 'practice' ? Infinity : room.solo === 'daily' ? 1 : room.settings.rounds);

function startProblem(room) {
  if (room.solo) return '';
  const st = room.settings;
  if (st.mode === 'race') {
    const n = room.players.filter((p) => p.connected).length;
    if (n < 2) return 'Needs at least 2 players. Copy the invite link and send it round.';
    if (!WORDS.base) return WORDS.failed ? 'Couldn’t load the word lists. Check your internet and reload.' : 'Loading the word lists…';
    return '';
  }
  const empty = [];
  for (const t of SIDES) for (let k = 0; k < perSide(); k++) {
    const p = room.teams[t][k] && byId(room.teams[t][k]);
    if (!p || !p.connected) empty.push(t);
  }
  if (empty.length) {
    const need = perSide() * 2;
    return room.players.filter((p) => p.connected).length < need
      ? `Needs ${need} players for ${st.teams === '2v2' ? '2 vs 2' : '1 vs 1'}. Copy the invite link and send it round.`
      : 'Every seat needs a player.';
  }
  if (!WORDS.full) return WORDS.failed ? 'Couldn’t load the dictionary. Check your internet and reload.' : 'Loading the dictionary…';
  return '';
}

function hostStartGame() {
  const room = H.room;
  const problem = startProblem(room);
  if (problem) { toast(problem); return; }
  room.players = room.players.filter((p) => p.connected || isSeated(p.id));
  for (const p of room.players) {
    Object.assign(p, { score: 0, solved: 0, ms: 0, inGame: room.settings.mode === 'race' ? p.connected : isSeated(p.id) });
  }
  Object.assign(room, { status: 'play', game: room.game + 1, round: 0, last: null, standings: null, winners: [] });
  cloud.track('game_started', { mode: room.solo || room.settings.mode, players: participants().length });
  hostStartRound();
}

function hostStartRound() {
  const room = H.room;
  const st = room.settings;
  room.guesses = {};
  room.solvedOrder = [];
  room.word = '';
  room.picks = { A: '', B: '' };
  room.auto = { A: false, B: false };
  if (!room.solo && st.mode === 'race') {
    // Latecomers join in from the next round
    for (const p of room.players) if (p.connected && !p.inGame) p.inGame = true;
  }
  if (!room.solo && st.mode === 'pick') {
    const k = E.pickerIndex(room.round, perSide());
    for (const t of SIDES) room.pickers[t] = room.teams[t][k] || room.teams[t][0];
    room.phase = 'pick';
    room.phaseEnd = Date.now() + E.TIMES.pickMs;
    setTimer(E.TIMES.pickMs, hostPickTimeout);
    hostAfterPresence();
    hostBroadcast();
    return;
  }
  if (room.solo === 'daily') room.word = E.dailyWord(WORDS.lex, room.day);
  else if (room.solo === 'practice') room.word = E.pickWord(WORDS.lex, { length: PRACTICE.length, words: 'all' }, H.rnd, room.used);
  else room.word = E.pickWord(WORDS.lex, st, H.rnd, room.used);
  room.used.add(room.word);
  hostCountdown();
}

function hostCountdown() {
  const room = H.room;
  const ms = room.solo === 'practice' && room.round > 0 ? 0 : room.solo ? 1500 : E.TIMES.countdownMs;
  room.phase = 'countdown';
  room.phaseEnd = Date.now() + ms;
  setTimer(ms, hostBeginGuess);
  hostBroadcast();
}

function targetWord(pid) {
  const room = H.room;
  if (room.solo || room.settings.mode === 'race') return room.word;
  const t = sideOf(pid);
  return t ? room.picks[otherSide(t)] : '';
}

function hostBeginGuess() {
  const room = H.room;
  if (room.status !== 'play') return;
  room.phase = 'guess';
  room.guessStart = Date.now();
  for (const pid of participants()) room.guesses[pid] = E.newGuess(targetWord(pid));
  // The daily word picks up where you left off after a refresh
  if (room.solo === 'daily') {
    const saved = store.get('daily', null);
    if (saved && saved.day === room.day && Array.isArray(saved.guessed)) {
      let g = room.guesses[SOLO_ID];
      for (const ch of saved.guessed) { const r = E.guess(g, ch, room.settings.bands); if (r) g = r.g; }
      g.ms = saved.ms || 0;
      room.guesses[SOLO_ID] = g;
    }
  }
  const ms = room.solo ? 0 : E.timeMs(room.settings);
  room.phaseEnd = ms ? Date.now() + ms : 0;
  if (ms) setTimer(ms, () => hostEndRound());
  else clearTimeout(H.timer);
  hostBroadcast();
  hostCheckRoundDone();
}

function hostPick(pid, raw) {
  const room = H.room;
  if (room.status !== 'play' || room.phase !== 'pick') return;
  const t = SIDES.find((s) => room.pickers[s] === pid);
  if (!t || room.picks[t]) return;
  const problem = E.pickProblem(raw, WORDS.lex);
  if (problem) { tell(pid, { t: 'nope', reason: problem }); return; }
  room.picks[t] = E.cleanWord(raw);
  room.used.add(room.picks[t]);
  hostCheckPicks();
  hostBroadcast();
}

function hostAutoPick(t) {
  const room = H.room;
  if (room.picks[t]) return;
  room.picks[t] = E.pickWord(WORDS.lex, { length: 'any', words: 'common' }, H.rnd, room.used);
  room.auto[t] = true;
  room.used.add(room.picks[t]);
}

function hostPickTimeout() {
  const room = H.room;
  if (room.status !== 'play' || room.phase !== 'pick') return;
  for (const t of SIDES) hostAutoPick(t);
  hostCheckPicks();
  hostBroadcast();
}

function hostCheckPicks() {
  const room = H.room;
  if (room.phase === 'pick' && room.picks.A && room.picks.B) hostCountdown();
}

function hostGuess(pid, ch) {
  const room = H.room;
  if (room.status !== 'play' || room.phase !== 'guess') return;
  const g = room.guesses[pid];
  if (!g) return;
  const r = E.guess(g, ch, room.settings.bands);
  if (!r) return;
  const next = r.g;
  if (E.isDone(next)) {
    next.ms = Date.now() - room.guessStart;
    const p = byId(pid);
    if (next.solved) {
      const race = !room.solo && room.settings.mode === 'race';
      if (race) room.solvedOrder.push(pid);
      next.place = race ? room.solvedOrder.length : 0;
      next.pts = E.points(next, room.settings.bands, next.place);
      if (p) { p.score += next.pts; p.solved++; p.ms += next.ms; }
    } else next.pts = 0;
  }
  room.guesses[pid] = next;
  if (room.solo === 'daily') store.set('daily', { day: room.day, guessed: next.guessed, ms: next.ms || 0, done: E.isDone(next) });
  hostBroadcast();
  hostCheckRoundDone();
}

// The round ends when everyone still here has solved or burst (or time runs out)
function hostCheckRoundDone() {
  const room = H.room;
  if (room.phase !== 'guess') return;
  const waiting = participants().filter((pid) => {
    const p = byId(pid);
    const g = room.guesses[pid];
    return g && !E.isDone(g) && p && (room.solo || active(p));
  });
  const anyDone = participants().some((pid) => room.guesses[pid] && E.isDone(room.guesses[pid]));
  if (!waiting.length && (anyDone || participants().length)) setTimer(1200, () => hostEndRound());
}

function hostEndRound() {
  const room = H.room;
  if (room.status !== 'play' || room.phase !== 'guess') return;
  const rows = participants().map((pid) => {
    const g = room.guesses[pid] || E.newGuess(targetWord(pid));
    return { id: pid, word: g.word, solved: g.solved, burst: g.burst, wrong: g.wrong, pts: g.pts || 0, ms: g.ms || 0, place: g.place || 0, side: sideOf(pid) };
  });
  room.last = { round: room.round, word: room.word, picks: { ...room.picks }, auto: { ...room.auto }, pickers: { ...room.pickers }, rows };
  if (room.solo === 'practice') {
    const mine = rows[0];
    S.streak = mine.solved ? S.streak + 1 : 0;
    const best = store.get('best', 0);
    if (S.streak > best) store.set('best', S.streak);
  }
  if (room.round + 1 >= totalRounds(room)) { hostGameOver(); return; }
  room.phase = 'reveal';
  if (room.solo) { room.phaseEnd = 0; clearTimeout(H.timer); }
  else { room.phaseEnd = Date.now() + E.TIMES.revealMs; setTimer(E.TIMES.revealMs, hostNextRound); }
  hostBroadcast();
}

function hostNextRound() {
  const room = H.room;
  if (room.status !== 'play' || room.phase !== 'reveal') return;
  room.round++;
  hostStartRound();
}

function hostGameOver() {
  const room = H.room;
  clearTimeout(H.timer);
  room.status = 'over';
  room.phase = '';
  if (room.solo) { hostBroadcast(); return; }
  const st = room.settings;
  if (st.mode === 'pick') {
    const teams = SIDES.map((t) => {
      const ids = room.teams[t].slice(0, perSide()).filter(Boolean);
      const members = ids.map(byId).filter(Boolean);
      return { side: t, ids, score: members.reduce((s, p) => s + p.score, 0), solved: members.reduce((s, p) => s + p.solved, 0), ms: members.reduce((s, p) => s + p.ms, 0) };
    });
    const ranked = E.rank(teams);
    const tie = ranked[0].score === ranked[1].score && ranked[0].solved === ranked[1].solved;
    room.standings = { teams: ranked, tie };
    room.winners = tie ? [] : ranked[0].ids;
  } else {
    const ranked = E.rank(room.players.filter((p) => p.inGame).map((p) => ({ id: p.id, score: p.score, solved: p.solved, ms: p.ms })));
    room.standings = { players: ranked };
    const top = ranked[0];
    room.winners = top && top.score > 0 ? ranked.filter((r) => r.score === top.score && r.solved === top.solved && r.ms === top.ms).map((r) => r.id) : [];
  }
  for (const id of room.winners) { const p = byId(id); if (p) p.wins++; }
  hostBroadcast();
}

function hostBackToLobby() {
  const room = H.room;
  if (room.solo) return;
  clearTimeout(H.timer);
  room.status = 'lobby';
  room.phase = '';
  room.players = room.players.filter((p) => p.connected);
  for (const p of room.players) p.inGame = false;
  hostAutoSeat();
  hostBroadcast();
}

/* ---------- Solo: the daily word and practice ---------- */

async function startSolo(kind) {
  closeRoom();
  if (!WORDS.base) {
    toast('Loading the words…');
    await loadBase();
    if (!WORDS.base) { toast('Couldn’t load the word lists. Check your internet and try again.'); return; }
  }
  Object.assign(S, { myId: SOLO_ID, isHost: true, code: '', overSeen: -1, roundKey: '' });
  if (kind === 'practice') S.streak = 0;
  H.rnd = E.mulberry32(E.randomSeed());
  const room = newRoom('', kind, { ...E.DEFAULT_SETTINGS, bands: E.DAILY_BANDS, time: 'off' });
  room.day = E.todayStr();
  room.players.push({ ...newPlayer(SOLO_ID, S.myName || 'You', true, 0), inGame: true });
  H.room = room;
  cloud.track(kind === 'daily' ? 'daily_started' : 'practice_started');
  // A finished daily goes straight to its result
  const saved = store.get('daily', null);
  if (kind === 'daily' && saved && saved.day === room.day && saved.done) {
    room.status = 'play';
    room.game = 1;
    room.word = E.dailyWord(WORDS.lex, room.day);
    hostBeginGuess();
    return;
  }
  hostStartGame();
}

/* ---------- Crews ---------- */



/* ---------- What each player may see ---------- */

// Can `viewer` see the letters `target` has guessed (and the word they're on)?
function canSeeDetail(viewer, target) {
  const room = H.room;
  if (viewer === target) return 'own';
  if (room.phase === 'reveal' || room.status === 'over') return 'all';
  if (room.solo || room.settings.mode === 'race') return '';
  const vs = sideOf(viewer), ts = sideOf(target);
  if (!vs) return 'all';                       // watching a pick game: see everything
  if (vs !== ts) return 'all';                 // they're guessing your side's word
  return '';
}

function guessView(viewer, target) {
  const room = H.room;
  const g = room.guesses[target];
  if (!g) return null;
  const out = { len: g.word.length, wrong: g.wrong, solved: g.solved, burst: g.burst, done: E.isDone(g), revealed: E.revealed(g), pts: g.pts || 0, place: g.place || 0, ms: g.ms || 0 };
  const see = canSeeDetail(viewer, target);
  if (see) {
    out.mask = E.mask(g.word, g.guessed);
    out.guessed = g.guessed;
    if (see === 'all' || out.done) out.word = g.word;
  }
  return out;
}

function viewFor(viewer) {
  const room = H.room;
  const now = Date.now();
  const mySide = sideOf(viewer);
  const pickMode = !room.solo && room.settings.mode === 'pick';
  const showWords = room.phase === 'reveal' || room.status === 'over';
  return {
    t: 'state',
    code: room.code, solo: room.solo, status: room.status, settings: room.settings, game: room.game,
    round: room.round, rounds: totalRounds(room) === Infinity ? 0 : totalRounds(room), phase: room.phase,
    phaseLeft: room.phaseEnd ? room.phaseEnd - now : 0,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, isHost: p.isHost, photo: p.photo, connected: p.connected, away: p.away,
      inGame: p.inGame, score: p.score, solved: p.solved, ms: p.ms, wins: p.wins, side: sideOf(p.id), g: guessView(viewer, p.id),
    })),
    teams: { A: room.teams.A.slice(0, perSide()), B: room.teams.B.slice(0, perSide()) },
    pickers: pickMode ? room.pickers : null,
    picked: pickMode ? { A: Boolean(room.picks.A), B: Boolean(room.picks.B) } : null,
    // Your side's own word (your teammates and people watching can see it), never the other side's
    sideWord: pickMode && room.status === 'play' ? (mySide ? room.picks[mySide] : null) : null,
    watchWords: pickMode && !mySide && room.status === 'play' ? { ...room.picks } : null,
    last: showWords ? room.last : null,
    standings: room.status === 'over' ? room.standings : null,
    winners: room.status === 'over' ? room.winners : [],
    streak: room.solo === 'practice' ? S.streak : 0,
    day: room.solo === 'daily' ? room.day : '',
    crewName: room.crew ? room.crew.name : '',
    crewStatus: room.crewStatus,
  };
}

function hostBroadcast() {
  if (!H.room) return;
  onMessage(viewFor(S.myId));
}

function tell(pid, msg) {
  if (pid === S.myId) onMessage(msg);
}

/* =========================================================
   Rooms on the server
   ========================================================= */
const link = createRoomLink('melonburst', {
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

// In a room the server runs the game; the daily word and practice run it here
const playingSolo = () => Boolean(H.room && H.room.solo);

function toHost(msg) {
  if (playingSolo()) hostOnMessage(msg);
  else link.send(msg);
}

function closeRoom() {
  link.close();
  clearTimeout(H.timer);
  Object.assign(S, { view: null, isHost: false, code: '', reconnecting: false, creating: false, roundKey: '', focus: null });
  H.room = null;
  for (const el of rowEls.values()) el.remove();
  rowEls.clear();
  miniMelons.clear();
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
    case 'nope':
      S.pickError = String(msg.reason || '').slice(0, 80);
      S.pickSent = false;
      SOUND.nope();
      if (S.view) renderPick(S.view);
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
const youTag = (p) => (p.id === S.myId && p.name !== 'You' ? ' (you)' : '');
const pOf = (v, id) => v.players.find((p) => p.id === id);
const nameOf = (v, id) => { const p = pOf(v, id); return p ? (p.id === S.myId ? 'You' : p.name) : 'Someone'; };
const isPick = (v) => !v.solo && v.settings.mode === 'pick';
const myGuess = (v) => me(v)?.g || null;
const sideName = (v, t) => {
  const ids = v.teams[t].filter(Boolean);
  if (ids.length === 1) return nameOf(v, ids[0]);
  return ids.map((id) => nameOf(v, id)).join(' & ') || `Side ${t}`;
};

function applyState(v) {
  const prev = S.view;
  S.view = v;
  S.viewAt = performance.now();
  const mine = me(v);
  if (!mine) return;
  if (!v.solo) {
    S.isHost = Boolean(mine.isHost);
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
  const key = `${v.game}:${v.round}`;
  if (key !== S.roundKey) {
    // A new round: fresh melon, keys, nothing pending
    S.roundKey = key;
    S.sent.clear();
    S.myPrev = null;
    S.pickDraft = '';
    S.pickError = '';
    S.pickSent = false;
    S.meaningFor = '';
    bigMelon.reset();
    S.focus = null;
  }
  // Sounds and effects for my own guesses
  const g = myGuess(v);
  const was = S.myPrev;
  if (g && was && v.phase === 'guess') {
    if (g.wrong > was.wrong) { if (g.burst) onMyBurst(); else SOUND.snap(); }
    else if ((g.guessed || []).length > (was.guessed || []).length) { if (g.solved) SOUND.solved(); else SOUND.hit(); }
    if (g.solved && !was.solved) flash(`Solved! +${g.pts}`, 'good', 2200);
  }
  S.myPrev = g ? { wrong: g.wrong, guessed: g.guessed || [], solved: g.solved, burst: g.burst } : null;
  if (prev && prev.phase !== 'guess' && v.phase === 'guess') SOUND.go();
  renderGame(v);
}

function onMyBurst() {
  SOUND.burst();
  if (PREFS.anim !== 'on') return;
  const layer = $('screen-splat');
  layer.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const b = document.createElement('i');
    const size = 40 + Math.random() * 120;
    Object.assign(b.style, { width: `${size}px`, height: `${size * (0.7 + Math.random() * 0.5)}px`, left: `${Math.random() * 90}%`, top: `${Math.random() * 80}%`, animationDelay: `${Math.random() * 0.15}s` });
    layer.appendChild(b);
  }
  setTimeout(() => { layer.innerHTML = ''; }, 1900);
}

/* =========================================================
   The game screen
   ========================================================= */
const bigMelon = createMelon($('melon-host'));
const miniMelons = new Map();

function renderGame(v) {
  $('bar-code').textContent = v.solo === 'daily' ? `Daily #${E.dayNumber(v.day)}` : v.solo === 'practice' ? 'Practice' : v.code;
  $('bar-phase').textContent = v.solo ? `${v.settings.bands} bands` : isPick(v) ? (v.settings.teams === '2v2' ? 'Pick words · 2 vs 2' : 'Pick words · 1 vs 1') : 'Race';
  renderRoundLine(v);
  const playing = v.status === 'play';
  $('pick-view').hidden = !(playing && v.phase === 'pick');
  // On your own the melon stays in view with the result; in rooms the round's results take over
  $('guess-view').hidden = !((playing && (v.phase === 'guess' || v.phase === 'countdown')) || (v.solo && (v.phase === 'reveal' || v.status === 'over')));
  $('reveal-view').hidden = !((playing && v.phase === 'reveal') || v.status === 'over');
  if (!$('pick-view').hidden) renderPick(v);
  if (!$('guess-view').hidden) renderGuess(v);
  if (!$('reveal-view').hidden) renderReveal(v);
  $('play').classList.toggle('solo-done', Boolean(v.solo) && (v.phase === 'reveal' || v.status === 'over'));
  renderCountdown(v);
  renderPlayers(v);
  $('host-actions').hidden = !(S.isHost && !v.solo && playing);
  $('end-round').hidden = v.phase !== 'guess';
}

function phaseLeft(v) { return Math.max(0, v.phaseLeft - (performance.now() - S.viewAt)); }

function renderRoundLine(v) {
  const parts = [];
  if (v.solo === 'practice') parts.push(`<span>Streak <b class="who-word">${v.streak}</b> · best ${Math.max(v.streak, store.get('best', 0))}</span>`);
  else if (v.solo === 'daily') parts.push('<span>Today’s word</span>');
  else parts.push(`<span>Round <b class="who-word">${Math.min(v.round + 1, v.rounds)}</b> of ${v.rounds}</span>`);
  if (isPick(v) && v.phase === 'guess' && myGuess(v)) {
    const mySide = me(v).side;
    const picker = v.pickers && v.pickers[mySide === 'A' ? 'B' : 'A'];
    if (picker) parts.push(`<span>Word from <b class="who-word">${esc(nameOf(v, picker))}</b></span>`);
  }
  if ((v.phase === 'guess' || v.phase === 'pick') && v.phaseLeft > 0) parts.push(`<span class="timer-chip" id="timer-chip">${Math.ceil(phaseLeft(v) / 1000)}s</span>`);
  $('round-line').innerHTML = parts.join('');
  $('round-tag').textContent = v.status === 'over' ? 'Final' : '';
}

/* ---------- Guessing ---------- */

// The melon in the middle: yours, or (when you're watching) whoever you've picked in the list
function focusTarget(v) {
  const mine = me(v);
  // Still guessing: always your own melon. Finished or watching: whoever you tapped in the list.
  if (mine && mine.g && !mine.g.done) return mine;
  const playing = v.players.filter((p) => p.g);
  return playing.find((p) => p.id === S.focus) || (mine && mine.g ? mine : null) || playing[0] || null;
}

function renderGuess(v) {
  const target = focusTarget(v);
  const g = target ? target.g : null;
  const isMine = target && target.id === S.myId;
  const bands = v.settings.bands;
  if (!g) {
    bigMelon.set({ wrong: 0, bands }, false);
    $('word').innerHTML = '';
    $('wrong-letters').innerHTML = '';
    $('band-count').innerHTML = '';
    $('guess-note').textContent = v.phase === 'countdown' ? '' : 'You’re watching this round. You’ll play from the next one.';
    renderKeyboard(v, null);
    return;
  }
  bigMelon.set({ wrong: g.wrong, bands, solved: g.solved, burst: g.burst }, v.phase === 'guess');
  // Band meter: one bar per band you can survive, the burst slot dashed at the end
  const used = Math.min(g.wrong, bands + 1);
  $('band-count').innerHTML = Array.from({ length: bands + 1 }, (_, k) =>
    `<i class="${k < used ? 'on' : ''}${k === bands ? ' last' : ''}"></i>`).join('');
  // The word
  const letters = g.mask ? g.mask.split('') : Array.from({ length: g.len }, () => '_');
  const full = g.word || '';
  const prevMask = S.lastMask && S.lastMask.key === `${S.roundKey}:${target.id}` ? S.lastMask.mask : '';
  $('word').className = `word${g.solved ? ' solved' : ''}${g.len > 9 ? ' long' : ''}`;
  $('word').innerHTML = letters.map((ch, i) => {
    if (ch !== '_') return `<span class="ch${prevMask && prevMask[i] === '_' ? ' got' : ''}">${ch}</span>`;
    if (g.done && full) return `<span class="ch missed">${full[i]}</span>`;
    return '<span class="ch">&nbsp;</span>';
  }).join('');
  S.lastMask = { key: `${S.roundKey}:${target.id}`, mask: g.mask || '' };
  const wrongs = (g.guessed || []).filter((ch) => !(g.mask || '').includes(ch));
  $('wrong-letters').innerHTML = wrongs.length ? `<span class="label">Not in it:</span>${wrongs.map((ch) => `<s>${ch}</s>`).join('')}` : '';
  let note = '';
  if (!isMine) {
    note = g.word && !g.done ? `Watching ${esc(target.name)} · their word is <b>${esc(g.word.toUpperCase())}</b>`
      : g.mask ? `Watching ${esc(target.name)}` : `Watching ${esc(target.name)}: ${g.revealed} of ${g.len} letters found`;
    if (me(v)?.g) note += ' · <button class="btn link" type="button" id="back-to-me">Back to mine</button>';
  } else if (g.solved) note = v.solo ? `+${g.pts} points` : `Solved! +${g.pts} points. Waiting for the others… (tap a player to watch them)`;
  else if (g.burst) note = v.solo ? '' : `Burst! The word was ${esc((full || '').toUpperCase())}. Waiting for the others… (tap a player to watch them)`;
  else if (v.phase === 'guess') note = g.wrong === bands ? 'One more wrong letter and it bursts!' : `${plural(bands - g.wrong, 'band')} before it bursts`;
  $('guess-note').innerHTML = note;
  $('guess-note').classList.toggle('muted', !(isMine && g.wrong === bands && !g.done));
  renderKeyboard(v, isMine ? g : null);
}

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
$('kbd').innerHTML = ROWS.map((r) => `<div class="kbd-row">${r.split('').map((ch) => `<button class="key" type="button" data-k="${ch}" aria-label="${ch}">${ch}</button>`).join('')}</div>`).join('');

function renderKeyboard(v, g) {
  const canGuess = Boolean(g) && v.phase === 'guess' && !g.done;
  $('kbd').classList.toggle('off', !canGuess);
  $('kbd').hidden = (!g && v.phase !== 'countdown') || (v.phase !== 'guess' && v.phase !== 'countdown');
  const guessed = new Set(g ? g.guessed || [] : []);
  const mask = g ? g.mask || '' : '';
  $('kbd').querySelectorAll('.key').forEach((k) => {
    const ch = k.dataset.k;
    const done = guessed.has(ch);
    k.classList.toggle('hit', done && mask.includes(ch));
    k.classList.toggle('miss', done && !mask.includes(ch));
    k.disabled = !canGuess || done || S.sent.has(ch);
  });
}

function sendGuess(ch) {
  const v = S.view;
  const g = v && myGuess(v);
  if (!g || v.phase !== 'guess' || g.done || (g.guessed || []).includes(ch) || S.sent.has(ch)) return;
  S.sent.add(ch);
  setTimeout(() => { S.sent.delete(ch); if (S.view) renderKeyboard(S.view, myGuess(S.view)); }, 2500);
  toHost({ t: 'guess', ch });
  renderKeyboard(v, g);
}
$('kbd').addEventListener('click', (e) => {
  const k = e.target.closest('.key');
  if (k) sendGuess(k.dataset.k);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { close(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || openSheet || $('game').hidden) return;
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  const ch = e.key.toLowerCase();
  if (ch.length === 1 && ch >= 'a' && ch <= 'z') { e.preventDefault(); sendGuess(ch); }
  else if (e.key === 'Enter' && S.view && S.view.solo === 'practice' && S.view.phase === 'reveal') hostNextRound();
});

/* ---------- Picking a word ---------- */

function renderPick(v) {
  const box = $('pick-view');
  if (v.phase !== 'pick' || v.status !== 'play') return;
  const mine = me(v);
  const side = mine.side;
  const pickerFor = side && v.pickers ? v.pickers[side] : null;
  const imPicker = pickerFor === S.myId;
  const left = Math.ceil(phaseLeft(v) / 1000);
  const opp = side ? otherSide(side) : null;
  const status = (t) => (v.picked[t] ? `<b>${esc(nameOf(v, v.pickers[t]))}</b> has picked` : `<b>${esc(nameOf(v, v.pickers[t]))}</b> is picking…`);
  let html;
  if (imPicker && !v.picked[side]) {
    const forWho = sideName(v, opp);
    html = `<h2>Pick a word for ${esc(forWho)}</h2>
      <p>A real English word, 4 to 12 letters. They’ll get ${plural(v.settings.bands, 'band')} to spare. <span class="pick-left">${left}</span>s left (then the computer picks one for you).</p>
      <form class="pick-row" id="pick-form" autocomplete="off">
        <input id="pick-input" maxlength="16" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Your word" value="${esc(S.pickDraft)}">
        <button class="btn primary" type="submit" ${S.pickSent ? 'disabled' : ''}>Use it</button>
      </form>
      <p class="pick-hint" id="pick-hint"></p>
      <button class="btn link" type="button" id="suggest-btn">Suggest one</button>
      <p class="small-note">${status(opp)}</p>`;
  } else if (side) {
    const sideWord = v.sideWord;
    html = `<h2>${v.picked[side] ? 'Your side’s word is in' : `${esc(nameOf(v, pickerFor))} is picking your side’s word`}</h2>
      ${sideWord ? `<p>For ${esc(sideName(v, opp))}:</p><div class="picked-word">${esc(sideWord)}</div>` : '<p>You’ll see it once it’s picked.</p>'}
      <p class="small-note">${status(opp)}</p>
      <p class="small-note muted">Then you’ll guess theirs. <span class="pick-left">${left}</span>s left to pick.</p>`;
  } else {
    html = `<h2>Picking words</h2><p>${status('A')}</p><p>${status('B')}</p>`;
  }
  // Keep the input (and the cursor) when only the timer changed
  const hasInput = $('pick-input');
  if (hasInput && imPicker && !v.picked[side]) {
    box.querySelector('.small-note').innerHTML = status(opp);
    box.querySelector('p').innerHTML = `A real English word, 4 to 12 letters. They’ll get ${plural(v.settings.bands, 'band')} to spare. <span class="pick-left">${left}</span>s left (then the computer picks one for you).`;
    box.querySelector('button[type="submit"]').disabled = S.pickSent;
    updatePickHint();
    return;
  }
  box.innerHTML = html;
  if (imPicker && !v.picked[side]) {
    $('pick-input').focus();
    updatePickHint();
  }
}

function updatePickHint() {
  const el = $('pick-hint');
  if (!el) return;
  const raw = $('pick-input').value;
  S.pickDraft = raw;
  let text = '', cls = '';
  if (S.pickError) { text = S.pickError; cls = 'bad'; }
  else if (raw.trim()) {
    const p = WORDS.full ? E.pickProblem(raw, WORDS.lex) : (E.cleanWord(raw).length < E.MIN_LEN ? `At least ${E.MIN_LEN} letters` : '');
    if (p) { text = p; cls = 'bad'; } else { text = WORDS.full ? `${E.cleanWord(raw).toUpperCase()} works: ${E.cleanWord(raw).length} letters` : 'Checking the dictionary…'; cls = WORDS.full ? 'good' : ''; }
  }
  el.textContent = text;
  el.className = `pick-hint ${cls}`;
}

$('pick-view').addEventListener('input', (e) => {
  if (e.target.id === 'pick-input') { S.pickError = ''; updatePickHint(); }
});
$('pick-view').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $('pick-input').value;
  const p = WORDS.full ? E.pickProblem(raw, WORDS.lex) : '';
  if (p) { S.pickError = p; SOUND.nope(); updatePickHint(); return; }
  S.pickSent = true;
  toHost({ t: 'pick', word: E.cleanWord(raw) });
  setTimeout(() => { S.pickSent = false; if (S.view) renderPick(S.view); }, 3000);
});
$('pick-view').addEventListener('click', (e) => {
  if (e.target.id !== 'suggest-btn' || !WORDS.base) return;
  const w = E.pickWord(WORDS.lex, { length: 'any', words: 'all' });
  $('pick-input').value = w;
  S.pickError = '';
  updatePickHint();
  $('pick-input').focus();
});

/* ---------- Between rounds, and the end ---------- */

const MEANINGS = new Map();
function meaning(word) {
  if (!word) return Promise.resolve('');
  if (MEANINGS.has(word)) return MEANINGS.get(word);
  const p = fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`)
    .then((r) => (r.ok ? r.json() : []))
    .then((data) => {
      const m = Array.isArray(data) && data[0] && data[0].meanings && data[0].meanings[0];
      const d = m && m.definitions && m.definitions[0] && m.definitions[0].definition;
      return d ? `<i>${esc(m.partOfSpeech || '')}</i> ${esc(String(d).slice(0, 220))}` : '';
    }).catch(() => { MEANINGS.delete(word); return ''; });   // try again next time
  MEANINGS.set(word, p);
  return p;
}

function wordBlock(word, label) {
  const id = `mean-${word}`;
  meaning(word).then((html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; });
  return `${label ? `<p>${label}</p>` : ''}<div class="big-word">${esc(word)}</div><p class="meaning" id="${id}"></p>`;
}

function spareText(v, g) {
  const spare = v.settings.bands - g.wrong;
  return g.wrong === 0 ? 'Solved without a single band!' : `Solved with ${plural(spare, 'band')} to spare!`;
}

function meaningLine(word) {
  const id = `mean-${word}`;
  meaning(word).then((html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; });
  return `<p class="meaning" id="${id}"></p>`;
}

function rowLine(v, r) {
  const p = pOf(v, r.id);
  const nm = p ? esc(p.name) + (p.id === S.myId ? ' (you)' : '') : 'Someone';
  const res = r.solved ? `solved, ${plural(r.wrong, 'band')}${r.place ? ` · ${['1st', '2nd', '3rd'][r.place - 1] || ''}` : ''}` : r.burst ? 'burst' : 'ran out of time';
  return `<li class="pc${p ? p.color : 0}"><span class="place"><span class="pen-dot"></span></span><span class="nm">${nm} <span class="muted small">${res}</span></span><span class="pts">+${r.pts}</span></li>`;
}

function renderReveal(v) {
  const box = $('reveal-view');
  const last = v.last;
  const mine = last ? last.rows.find((r) => r.id === S.myId) : null;
  let html = '';
  if (v.solo === 'daily') {
    const g = myGuess(v);
    if (!g) { box.innerHTML = ''; return; }
    html = `<div class="result-banner ${g.solved ? 'good' : 'bad'}">${g.solved ? spareText(v, g) : `It burst! The word was ${esc((g.word || '').toUpperCase())}`}</div>
      ${meaningLine(g.word || '')}
      <div class="result-actions"><button class="btn primary" type="button" id="share-btn">Share result</button><button class="btn ghost" type="button" id="home-btn">Back to home</button></div>
      <p class="small-note muted">A new word tomorrow.</p>`;
    box.innerHTML = html;
    return;
  }
  if (v.solo === 'practice') {
    const r = last.rows[0];
    html = `<div class="result-banner ${r.solved ? 'good' : 'bad'}">${r.solved ? spareText(v, r) : `It burst! The word was ${esc(r.word.toUpperCase())}`}</div>
      ${meaningLine(r.word)}
      <p class="next-in">Streak: ${v.streak} · best ${store.get('best', 0)}</p>
      <div class="result-actions"><button class="btn primary" type="button" id="next-word">Next word</button><button class="btn ghost" type="button" id="home-btn">Back to home</button></div>`;
    box.innerHTML = html;
    $('next-word').focus();
    return;
  }
  // Rooms
  const over = v.status === 'over';
  if (last) {
    if (isPick(v)) {
      const mySide = me(v).side;
      const blocks = SIDES.map((t) => {
        const word = last.picks[t];
        const by = last.auto[t] ? 'the computer' : nameOf(v, last.pickers[t]);
        const forWho = sideName(v, otherSide(t));
        const lc = (n) => n.replace(/\bYou\b/g, 'you');
        return `<p><b>${esc(word.toUpperCase())}</b>: picked by ${esc(lc(by))} for ${esc(lc(forWho))}</p>`;
      });
      const myWord = mySide ? last.picks[otherSide(mySide)] : '';
      html += mine ? `<div class="result-banner ${mine.solved ? 'good' : 'bad'}">${mine.solved ? `You solved it! +${mine.pts}` : 'Your melon burst'}</div>` : '';
      html += myWord ? wordBlock(myWord, mine ? 'Your word was' : '') : '';
      html += blocks.join('');
    } else {
      html += mine ? `<div class="result-banner ${mine.solved ? 'good' : 'bad'}">${mine.solved ? `You solved it! +${mine.pts}` : mine.burst ? 'Your melon burst' : 'Out of time'}</div>` : '';
      html += wordBlock(last.word, 'The word was');
    }
    html += `<ol class="standings">${last.rows.slice().sort((a, b) => b.pts - a.pts).map((r) => rowLine(v, r)).join('')}</ol>`;
  }
  if (!over) {
    html += `<p class="next-in" id="next-in"></p>`;
    if (S.isHost) html += '<button class="btn ghost" type="button" id="next-now">Next round now</button>';
  } else {
    html = renderStandings(v) + `<details class="more"><summary>Last round</summary><div style="padding:0 0.9rem 0.9rem;display:grid;gap:0.5rem;justify-items:center">${html}</div></details>`;
    const missing = isPick(v) && SIDES.some((t) => v.teams[t].some((id) => { const p = id && pOf(v, id); return !p || !p.connected; }));
    html += S.isHost ? `<div class="result-actions"><button class="btn primary" type="button" id="again-btn" ${missing ? 'disabled' : ''}>Play again</button><button class="btn ghost" type="button" id="lobby-btn">Change settings</button></div>
      ${missing ? '<p class="small-note muted">Someone has left. Change settings to fill their seat.</p>' : ''}`
      : '<p class="small-note muted">The host can start another game.</p>';
    if (v.crewName) html += `<p class="small-note muted">${esc(v.crewStatus)}</p>`;
    if (S.overSeen !== v.game) {
      S.overSeen = v.game;
      if (v.winners.includes(S.myId)) setTimeout(SOUND.win, 300);
      saveMyGame(v);
    }
  }
  box.innerHTML = html;
  updateNextIn();
}

function renderStandings(v) {
  const st = v.standings;
  if (!st) return '';
  const iWon = v.winners.includes(S.myId);
  if (st.teams) {
    const title = st.tie ? 'It’s a draw!' : iWon ? (v.settings.teams === '2v2' ? 'Your side wins!' : 'You win!') : `${esc(sideName(v, st.teams[0].side))} ${st.teams[0].ids.length > 1 ? 'win' : 'wins'}!`;
    return `<div class="result-banner ${iWon ? 'good' : ''}">${title}</div>
      <ol class="standings">${st.teams.map((t, i) => `<li><span class="place">${st.tie ? '=' : i + 1}</span><span class="nm">${esc(sideName(v, t.side))} <span class="muted small">${plural(t.solved, 'word')} solved</span></span><span class="pts">${t.score}</span></li>`).join('')}</ol>`;
  }
  const winners = v.winners.map((id) => nameOf(v, id));
  const title = !winners.length ? 'Nobody scored!' : iWon ? (winners.length > 1 ? 'A shared win!' : 'You win!') : `${esc(winners.join(' & '))} ${winners.length > 1 ? 'share the win' : 'wins'}!`;
  return `<div class="result-banner ${iWon ? 'good' : ''}">${title}</div>
    <ol class="standings">${st.players.map((r, i) => {
      const p = pOf(v, r.id);
      return `<li class="pc${p ? p.color : 0}"><span class="place">${i + 1}</span><span class="nm">${esc(p ? p.name : 'Someone')}${r.id === S.myId ? ' (you)' : ''} <span class="muted small">${plural(r.solved, 'word')}</span></span><span class="pts">${r.score}</span></li>`;
    }).join('')}</ol>`;
}

function saveMyGame(v) {
  const mine = me(v);
}

function updateNextIn() {
  const el = $('next-in');
  const v = S.view;
  if (!el || !v) return;
  const s = Math.ceil(phaseLeft(v) / 1000);
  el.textContent = v.round + 1 >= v.rounds ? '' : `Next round in ${s}s`;
}

$('reveal-view').addEventListener('click', async (e) => {
  const id = e.target.id;
  if ((id === 'next-now' || id === 'next-word') && S.isHost) { if (playingSolo()) hostNextRound(); else toHost({ t: 'next' }); }
  if (id === 'again-btn' && S.isHost) { if (playingSolo()) hostStartGame(); else roomStart(); }
  if (id === 'lobby-btn' && S.isHost) toHost({ t: 'lobby' });
  if (id === 'home-btn') { closeRoom(); goHome(); }
  if (id === 'share-btn') {
    const v = S.view;
    const g = myGuess(v);
    const text = E.shareText(E.dayNumber(v.day), { ...g, word: g.word || '' }, v.settings.bands);
    try { await navigator.clipboard.writeText(`${text}\n${location.origin}${location.pathname}`); toast('Copied. Paste it to your team.'); } catch { toast(text); }
  }
});

function renderCountdown(v) {
  const el = $('countdown');
  const on = v.status === 'play' && v.phase === 'countdown' && v.phaseLeft > 200;
  el.hidden = !on;
  if (!on) return;
  const s = Math.ceil(phaseLeft(v) / 1000);
  el.innerHTML = `<b>${s || 1}</b><span>${v.round === 0 ? 'Get ready' : `Round ${v.round + 1}`}</span>`;
}

/* ---------- Players down the side ---------- */

function playerStatus(v, p) {
  const g = p.g;
  if (!p.connected) return 'left · reconnecting';
  if (p.away) return 'away';
  if (v.phase === 'pick' && v.pickers) {
    const t = SIDES.find((s) => v.pickers[s] === p.id);
    if (t) return v.picked[t] ? '<span class="good">picked a word</span>' : 'picking a word…';
  }
  if (!g) return p.inGame || p.side ? 'waiting' : 'watching';
  if (g.solved) return `<span class="good">solved</span>${g.place ? ` · ${['1st', '2nd', '3rd'][g.place - 1] || ''}` : ''} · ${plural(g.wrong, 'band')}`;
  if (g.burst) return '<span class="bad">burst!</span>';
  if (g.mask) return `<b>${g.mask.replace(/_/g, '·')}</b> · ${plural(g.wrong, 'band')}`;
  return `${g.revealed}/${g.len} letters · ${plural(g.wrong, 'band')}`;
}

// Rows are kept (keyed by player) and reordered with CSS order, so the mini melons are never
// detached: moving an SVG in the DOM would replay its animations on every update.
const rowEls = new Map();
function rowEl(key, cls) {
  let el = rowEls.get(key);
  if (!el) {
    el = document.createElement('li');
    el.dataset.key = key;
    if (cls === 'team-head') el.innerHTML = '<span class="t"></span><b class="tot"></b>';
    else el.innerHTML = '<span class="mini"></span><span class="who"><span class="nm"></span><span class="st"></span></span><span class="pts"></span>';
    rowEls.set(key, el);
    $('players').appendChild(el);
  }
  return el;
}

function fillPlayerRow(v, p, order) {
  const el = rowEl(`p:${p.id}`);
  const isMe = p.id === S.myId;
  const playing = Boolean(p.g) || p.inGame || Boolean(p.side) || Boolean(v.solo);
  el.className = `pc${p.color}${isMe ? ' me' : ''}${p.connected ? '' : ' off'}${playing ? '' : ' watching'}`;
  el.dataset.id = p.id;
  el.style.order = order;
  el.querySelector('.nm').textContent = p.name + youTag(p);
  el.querySelector('.st').innerHTML = playerStatus(v, p);
  el.querySelector('.pts').innerHTML = `${p.score}${p.g && p.g.pts && v.phase !== 'pick' ? `<small>+${p.g.pts}</small>` : ''}`;
  const spot = el.querySelector('.mini');
  spot.hidden = !playing;
  let m = miniMelons.get(p.id);
  if (playing && !m) {
    m = createMelon(spot, { small: true });
    miniMelons.set(p.id, m);
  }
  if (m) {
    const g = p.g;
    if (!g) m.reset();
    m.set({ wrong: g ? g.wrong : 0, bands: v.settings.bands, solved: g && g.solved, burst: g && g.burst }, true);
  }
}

function renderPlayers(v) {
  const keep = new Set();
  let order = 0;
  const add = (p) => { fillPlayerRow(v, p, order++); keep.add(`p:${p.id}`); };
  if (isPick(v)) {
    for (const t of SIDES) {
      if (v.settings.teams === '2v2') {
        const ids = v.teams[t].filter(Boolean);
        const head = rowEl(`h:${t}`, 'team-head');
        head.className = 'team-head';
        head.style.order = order++;
        head.querySelector('.t').textContent = `Side ${t}`;
        head.querySelector('.tot').textContent = ids.reduce((s, id) => s + (pOf(v, id)?.score || 0), 0);
        keep.add(`h:${t}`);
      }
      v.teams[t].filter(Boolean).map((id) => pOf(v, id)).filter(Boolean).forEach(add);
    }
    $('players-title').textContent = v.settings.teams === '2v2' ? 'Sides' : 'Players';
  } else {
    v.players.filter((p) => p.inGame || p.g || v.solo).sort((a, b) => b.score - a.score).forEach(add);
    $('players-title').textContent = v.solo ? 'You' : 'Players';
  }
  for (const [key, el] of rowEls) {
    if (keep.has(key)) continue;
    el.remove();
    rowEls.delete(key);
    if (key.startsWith('p:')) miniMelons.delete(key.slice(2));
  }
  const watchers = v.players.filter((p) => p.connected && !(p.inGame || p.g || p.side) && !v.solo);
  $('watching').textContent = watchers.length ? `Watching: ${watchers.map((p) => p.name + (p.id === S.myId ? ' (you)' : '')).join(', ')}` : '';
}

$('players').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  const mine = S.view && myGuess(S.view);
  if (!li || !S.view || (mine && !mine.done)) return;
  S.focus = li.dataset.id;
  renderGuess(S.view);
});
$('guess-note').addEventListener('click', (e) => {
  if (e.target.id !== 'back-to-me') return;
  S.focus = S.myId;
  if (S.view) renderGuess(S.view);
});

$('end-round').addEventListener('click', () => { if (S.isHost) toHost({ t: 'endRound' }); });
$('end-game').addEventListener('click', () => { if (S.isHost) toHost({ t: 'lobby' }); });
$('quit-btn').addEventListener('click', () => { closeRoom(); goHome(); });

// Timers tick on every screen without waiting for the host
setInterval(() => {
  const v = S.view;
  if (!v || $('game').hidden) return;
  const s = Math.ceil(phaseLeft(v) / 1000);
  const chip = $('timer-chip');
  if (chip) {
    chip.textContent = `${s}s`;
    chip.classList.toggle('urgent', s <= 10);
    if (s <= 5 && s > 0 && S.lastTick !== s && v.phase === 'guess' && myGuess(v) && !myGuess(v).done) { S.lastTick = s; SOUND.tick(); }
  }
  if (v.phase === 'countdown') renderCountdown(v);
  if (v.phase === 'reveal') updateNextIn();
  if (v.phase === 'pick') document.querySelectorAll('.pick-left').forEach((el) => { el.textContent = s; });
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

const NUMERIC = new Set(['bands', 'rounds']);
const asSetting = (key, value) => (NUMERIC.has(key) ? Number(value) : value);
const paints = ['bands', 'length', 'teams', 'rounds'].map((key) =>
  segment($(`set-${key}`), () => ROOM_PREFS[key], (val) => { ROOM_PREFS[key] = asSetting(key, val); roomSettingsChanged(); }));
for (const key of ['time', 'words']) {
  $(`set-${key}`).addEventListener('change', (e) => { ROOM_PREFS[key] = asSetting(key, e.target.value); roomSettingsChanged(); });
}
$('mode-cards').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b || !S.isHost) return;
  ROOM_PREFS.mode = b.dataset.mode;
  roomSettingsChanged();
});

function roundsButtons(mode) {
  const label = mode === 'pick' ? 'Words each side picks' : 'Rounds';
  $('rounds-label').textContent = label;
  $('set-rounds').setAttribute('aria-label', label);
  const html = E.ROUND_CHOICES[mode].map((n) => `<button type="button" data-value="${n}"><b>${n}</b></button>`).join('');
  if ($('set-rounds').dataset.mode !== mode) { $('set-rounds').innerHTML = html; $('set-rounds').dataset.mode = mode; }
}

function roomSettingsChanged() {
  ROOM_PREFS = E.cleanSettings(ROOM_PREFS);
  saveRoomPrefs();
  if (ROOM_PREFS.mode === 'pick') loadFull();
  if (!S.isHost || playingSolo() || !S.view || S.view.status !== 'lobby') { paintRoomSettings(); return; }
  toHost({ t: 'settings', settings: { ...ROOM_PREFS } });
}

function paintRoomSettings(st = ROOM_PREFS) {
  roundsButtons(st.mode);
  paints.forEach((p) => p());
  $('set-time').value = st.time;
  $('set-words').value = st.words;
  $('mode-cards').querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === st.mode)));
  $('length-setting').hidden = st.mode !== 'race';
  $('words-field').hidden = st.mode !== 'race';
}

function settingsLines(st) {
  return [
    st.mode === 'pick' ? `<b>Pick words</b>, ${st.teams === '2v2' ? '2 vs 2' : '1 vs 1'}, ${plural(st.rounds, 'word')} each side` : `<b>Race</b>, ${plural(st.rounds, 'round')}`,
    `${plural(st.bands, 'band')} before it bursts`,
    st.mode === 'race' ? `${{ any: 'Any length', short: 'Short words (4–6)', medium: 'Medium words (6–8)', long: 'Long words (8–12)' }[st.length]}, ${st.words === 'common' ? 'everyday words' : 'everyday and more'}` : '',
    st.time === 'off' ? 'No time limit' : `${st.time} seconds to guess`,
  ].filter(Boolean).map((l) => `<li>${l}</li>`).join('');
}

function renderLobby(v) {
  $('lobby-code').textContent = v.code;
  const st = v.settings;
  const pick = st.mode === 'pick';
  const rows = v.players.map((p) => {
    const tag = pick ? (p.side ? `Side ${p.side}` : 'Watching') : 'Playing';
    return `<li class="pc${p.color}${active(p) ? '' : ' off'}"><span class="pen-dot"></span>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}
      <span class="tag">${!active(p) ? 'Reconnecting' : `<b>${tag}</b>${p.isHost ? ' · Host' : ''}`}</span></li>`;
  });
  if (v.players.length < 2) rows.push('<li class="empty">Waiting for someone to join…</li>');
  $('lobby-players').innerHTML = rows.join('');

  // Mode and sides are visible to everyone; only the host can change them
  roundsButtons(st.mode);
  $('mode-cards').querySelectorAll('[data-mode]').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.mode === st.mode)); b.disabled = !S.isHost; });
  $('set-teams').querySelectorAll('button').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.value === st.teams)); b.disabled = !S.isHost; });
  $('teams-box').hidden = !pick;
  if (pick) {
    const n = E.seatsFor(st);
    const mine = me(v);
    $('team-cards').innerHTML = SIDES.map((t) => {
      const slots = Array.from({ length: n }, (_, k) => {
        const id = v.teams[t][k];
        const p = id && pOf(v, id);
        const isMe = p && p.id === S.myId;
        if (p && p.connected) {
          return `<div class="slot-row pc${p.color}"><span class="pen-dot"></span>${esc(p.name)}${isMe ? ' (you)' : ''}${isMe ? '<button class="btn ghost" type="button" data-stand>Stand up</button>' : ''}</div>`;
        }
        return `<div class="slot-row empty">Empty seat<button class="btn ${mine && mine.side ? 'ghost' : 'primary'}" type="button" data-sit="${t}" data-slot="${k}">${mine && mine.side ? 'Move here' : 'Sit here'}</button></div>`;
      }).join('');
      return `<div class="team-card"><h3>${n > 1 ? `Side ${t}` : t === 'A' ? 'Player 1' : 'Player 2'}</h3>${slots}</div>`;
    }).join('') + (S.isHost ? '<button class="btn link team-swap" type="button" data-swap>Swap sides</button>' : '');
  }
  $('host-settings').hidden = !S.isHost;
  $('guest-settings').hidden = S.isHost;
  if (S.isHost) {
    paintRoomSettings(st);
    if (document.activeElement !== $('crew-input')) $('crew-input').value = v.crewName;
    $('crew-status').textContent = v.crewStatus;
    paintPublic(v);
    renderStartButton();
  } else {
    $('settings-summary').innerHTML = settingsLines(st) + (v.crewName ? `<li>Crew: <b>${esc(v.crewName)}</b></li>` : '') + `<li>${publicLine(v)}</li>`;
  }
}

function renderStartButton() {
  if (!S.isHost || !S.view || S.view.status !== 'lobby') return;
  const problem = S.view.startProblem || '';
  $('start-btn').disabled = Boolean(problem);
  $('start-note').textContent = problem;
}

function wordsChanged() {
  renderStartButton();
  if ($('pick-input')) updatePickHint();
}

$('team-cards').addEventListener('click', (e) => {
  const sit = e.target.closest('[data-sit]');
  if (sit) toHost({ t: 'sit', side: sit.dataset.sit, slot: Number(sit.dataset.slot) });
  if (e.target.closest('[data-stand]')) toHost({ t: 'stand' });
  if (e.target.closest('[data-swap]') && S.isHost) toHost({ t: 'swap' });
});
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
  // MEL, a wedge of watermelon for the O, N; then BURST with melon bits, seeds, juice and wind
  // flying out from behind it
  const slice = `<svg class="logo-slice" viewBox="0 0 100 110" aria-hidden="true">
    <path class="sl-rind" d="M50 4 L96 84 A54 54 0 0 1 4 84 Z"/>
    <path class="sl-light" d="M50 11 L89 80 A47 47 0 0 1 11 80 Z"/>
    <path class="sl-white" d="M50 15 L85 77 A42 42 0 0 1 15 77 Z"/>
    <path class="sl-flesh" d="M50 19 L82 74 A38 38 0 0 1 18 74 Z"/>
    <g class="sl-seeds">${[[50, 42], [40, 58], [60, 58], [31, 73], [50, 74], [69, 73]].map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="2.8" ry="5"/>`).join('')}</g>
    <path class="sl-shine" d="M44 30 L30 54"/></svg>`;
  const rnd = E.mulberry32(7);
  const bits = [];
  const N = 30;
  for (let i = 0; i < N; i++) {
    // All pop together (with a little jitter) when the word punches; they fly out sideways and up,
    // only a short way down so they don't cover the line underneath
    const a = (i / N) * Math.PI * 2 + rnd() * 0.3;
    const reach = 0.55 + rnd() * 0.6;
    const c = Math.cos(a), sn = Math.sin(a);
    const dx = c * (c < 0 ? 62 : 96) * reach;
    const dy = sn * (sn > 0 ? 16 : 46) * reach;
    const style = `--dx:${dx.toFixed(0)}px;--dy:${dy.toFixed(0)}px;--rot:${((rnd() - 0.5) * 540).toFixed(0)}deg;--d:${(rnd() * 0.18).toFixed(2)}s`;
    const kind = i % 4;
    if (kind === 0) bits.push(`<path class="lb-bit lb-chunk" style="${style}" d="M0 -7 L7 5 A8 8 0 0 1 -7 5 Z"/>`);
    else if (kind === 1) bits.push(`<ellipse class="lb-bit lb-seed" style="${style}" rx="1.8" ry="3.2"/>`);
    else if (kind === 2) bits.push(`<circle class="lb-bit lb-drop" style="${style}" r="${(2 + rnd() * 2.2).toFixed(1)}"/>`);
    else bits.push(`<path class="lb-bit lb-rind" style="${style}" d="M-6 0 Q0 -5 6 0"/>`);
  }
  // Wind: streaks shooting out from the middle
  const wind = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2 + 0.13;
    const sq = Math.sin(a) > 0 ? 0.45 : 1;
    const x1 = Math.cos(a) * 46, y1 = Math.sin(a) * 18 * sq, x2 = Math.cos(a) * 118, y2 = Math.sin(a) * 52 * sq;
    return `<line class="lb-wind" style="--d:${(0.02 + (i % 3) * 0.05).toFixed(2)}s" x1="${x1.toFixed(0)}" y1="${y1.toFixed(0)}" x2="${x2.toFixed(0)}" y2="${y2.toFixed(0)}"/>`;
  }).join('');
  const boom = `<svg class="logo-boom" viewBox="-130 -70 260 140" aria-hidden="true">${wind}${bits.join('')}</svg>`;
  return `<span class="logo-melon">MEL${slice}N</span><span class="logo-burst">${boom}<span class="burst-word">BURST</span></span>`;
}

const paintPrLength = segment($('pr-length'), () => PRACTICE.length, (v) => { PRACTICE.length = v; store.set('practice', PRACTICE); }, () => true);

function renderDailyCard() {
  const day = E.todayStr();
  const n = E.dayNumber(day);
  $('daily-tag').textContent = `#${n}`;
  const saved = store.get('daily', null);
  const done = saved && saved.day === day && saved.done;
  $('daily-btn').textContent = done ? 'See today’s result' : saved && saved.day === day ? 'Continue today’s word' : 'Daily word';
  const best = store.get('best', 0);
  $('daily-note').textContent = `One word for everyone today, ${E.DAILY_BANDS} bands to spare. Or practise as long as you like${best ? ` (best streak ${best})` : ''}.`;
  paintPrLength();
}

function soloName() {
  const name = cleanName($('name-input').value);
  if (name) store.set('name', name);
  return name || 'You';
}
$('daily-btn').addEventListener('click', () => { S.myName = soloName(); startSolo('daily'); });
$('practice-btn').addEventListener('click', () => { S.myName = soloName(); startSolo('practice'); });

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
  renderDailyCard();
  showScreen('home');
}

$('host-btn').addEventListener('click', () => {
  const name = readName();
  if (!name) return;
  homeError('');
  S.myName = name;
  setBusy(true);
  loadFull();
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
  loadFull();
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
  loadFull();
  try {
    const code = await quickPlay('melonburst');
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
  $('vibrate-toggle').checked = PREFS.vibrate !== false;
  $('anim-select').value = PREFS.anim;
  $('analytics-row').hidden = !cloud.analyticsConfigured();
  $('analytics-toggle').checked = PREFS.analytics !== false;
  $('my-stats').innerHTML = '<p class="muted">Loading your stats…</p>';
  try {
    const st = await cloud.getMyStats();
    if ((cloud.getUser()?.uid || null) !== (u?.uid || null)) return;
    $('my-stats').innerHTML = `
      <div class="stat-grid">
        <div><b>${st.games}</b><span>Room games</span></div>
        <div><b>${st.wins}</b><span>Wins</span></div>
        <div><b>${st.solved}</b><span>Words solved</span></div>
        <div><b>${st.points}</b><span>Points</span></div>
        <div><b>${st.dailies}</b><span>Dailies</span></div>
        <div><b>${st.dailySolved}</b><span>Dailies solved</span></div>
      </div>`;
  } catch (err) {
    $('my-stats').innerHTML = `<p class="muted">${esc(cloud.errorText(err))}</p>`;
  }
}
$('sound-toggle').addEventListener('change', (e) => { PREFS.sound = e.target.checked; savePrefs(); if (PREFS.sound) SOUND.hit(); });
$('vibrate-toggle').addEventListener('change', (e) => { PREFS.vibrate = e.target.checked; savePrefs(); });
$('anim-select').addEventListener('change', (e) => { PREFS.anim = e.target.value; savePrefs(); document.body.dataset.anim = PREFS.anim; });
$('analytics-toggle').addEventListener('change', (e) => {
  PREFS.analytics = e.target.checked;
  savePrefs();
  cloud.setAnalyticsEnabled(e.target.checked);
});

// Test hook: with ?debug in the address, automated tests can inspect the state.
if (new URLSearchParams(location.search).has('debug')) window.__melonburst = { S, H, link, E, WORDS };

/* =========================================================
   Start
   ========================================================= */
(function init() {
  $('logo-row').innerHTML = logoHtml();
  document.body.dataset.anim = PREFS.anim;
  const saved = store.get('name', '');
  if (saved) $('name-input').value = saved;
  const room = new URLSearchParams(location.search).get('room');
  if (room && /^[A-Za-z]{4}$/.test(room)) {
    $('code-input').value = room.toUpperCase();
    ($('name-input').value ? $('join-btn') : $('name-input')).focus();
  }
  paintRoomSettings();
  renderDailyCard();
  showScreen('home');
  loadBase();
  cloud.onUser((u) => {
    renderAccount(u);
  });
  cloud.initAnalytics(PREFS.analytics !== false);
  cloud.restore();
})();
