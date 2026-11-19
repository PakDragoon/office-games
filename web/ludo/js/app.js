import * as E from './engine.js';
import * as cloud from './cloud.js';
import { createBoard } from './board.js';
import { createDie, sound, setSound } from './fx.js';
import { createRoomLink, quickPlay } from '../../shared/net.js';
import { markInvite } from '../../shared/invite.js';
import { wirePublic, paintPublic, publicLine } from '../../shared/public.js';
import { botTag, botControls, wireBots } from '../../shared/bots.js';

/* =========================================================
   Ludo
   2 to 4 players (or 2 vs 2). The game runs on the server (server/src/games/ludo.ts): it rolls every die and
   checks every move. This page draws what it's sent, plays the room's log back as animations (a tumbling die,
   tokens hopping square by square, knock-backs, home bursts) and sends what the player picked.
   ========================================================= */

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const NAMES = E.COLOUR_NAMES;

/* ---------- This browser only ---------- */
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`ludo.${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`ludo.${key}`, JSON.stringify(value)); } catch { /* not saved */ }
  },
};
const PREFS = { sound: true, fast: false, analytics: true, ...store.get('prefs', {}) };
let ROOM_PREFS = E.cleanSettings(store.get('room', {}));
const savePrefs = () => store.set('prefs', PREFS);
const saveRoomPrefs = () => store.set('room', ROOM_PREFS);
setSound(PREFS.sound !== false);

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

/* =========================================================
   State and the room on the server
   ========================================================= */
const S = {
  myName: '', myId: null, isHost: false, code: '', view: null, reconnecting: false, creating: false,
  boardGame: -1,      // the game the board is drawn for
  seen: 0,            // the last room log entry played back
  queue: [],          // log entries waiting to be animated
  busy: false,        // an animation is playing
  rolling: false,     // I pressed Roll and wait for the die
  turnSoundFor: '',   // the turn I've already chimed for
  celebrated: -1,     // the game whose win was celebrated
  endAt: 0,           // when the turn timer runs out (performance.now())
  endMs: 0,
  moving: null,       // host: the seated player being moved to another colour
  botWant: null,      // host: a bot was just asked for this colour ({ want, before })
  endArmed: 0,
  startedAt: 0,       // when this game began here (log times)
  tab: 'log',         // phones: the open panel
  pickV: 0,           // the waiting roll picked to move with (when there are several)
  note: '',           // what the last move did ("Sara sent you home"), shown with the next status
};

const link = createRoomLink('ludo', {
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
const toHost = (msg) => link.send(msg);
const active = (p) => p.connected && !p.away;

function closeRoom() {
  link.close();
  Object.assign(S, { view: null, isHost: false, code: '', reconnecting: false, creating: false, boardGame: -1, seen: 0, queue: [], busy: false, rolling: false, moving: null });
  $('result').hidden = true;
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
    case 'react':
      showReaction(msg.pid, msg.e);
      break;
    case 'state':
      applyState(msg);
      break;
    default:
  }
}

const me = (v) => v.players.find((p) => p.id === S.myId);
const playerAt = (v, c) => v.players.find((p) => p.id === v.seats[c]);
const nameAt = (v, c) => playerAt(v, c)?.name || NAMES[c];
const mySeat = (v) => (me(v) ? me(v).seat : -1);

function applyState(v) {
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
  if (v.status === 'lobby') {
    S.boardGame = -1;
    S.queue = [];
    $('result').hidden = true;
    renderLobby(v);
    if ($('lobby').hidden) showScreen('lobby');
    return;
  }
  if ($('game').hidden) showScreen('game');
  renderGame(v);
}

/* =========================================================
   The game screen: a card per player at the board's corners (each with its own die showing that player's
   last roll), the board, the status line and Roll under it, and a side panel (reactions, room, this game's rules, log) that becomes tabs on phones
   ========================================================= */
const board = createBoard($('board-wrap'), {
  onPick: (c, i) => {
    const v = S.view;
    if (!v?.g) return;
    const m = v.g.legal.find((x) => x.c === c && x.i === i && x.v === S.pickV) || v.g.legal.find((x) => x.c === c && x.i === i);
    if (!m) return;
    board.setLegal([]);
    toHost({ t: 'move', c, i, r: m.r, seq: v.g.seq });
  },
});
// One die per colour, inside that player's card. Cards are built once per game and then only updated, so a
// die that is rolling is never pulled out of the page mid-roll.
let dice = {};

function renderGame(v) {
  const g = v.g;
  $('bar-code').textContent = v.code;
  if (!g) return;
  if (S.boardGame !== v.game) {
    // A new game (or this page just arrived): draw it as it is now, no catching up
    S.boardGame = v.game;
    const seat = mySeat(v);
    board.setup(g, g.colours.includes(seat) ? seat : g.colours[0]);
    S.seen = g.seq;
    S.queue = [];
    S.rolling = false;
    S.note = '';
    S.startedAt = Date.now();
    $('log').innerHTML = '';
    $('result').hidden = true;
    buildCorners(v);
    for (const c of g.colours) {
      const last = [...g.events].reverse().find((e) => e.k === 'roll' && e.c === c);
      dice[c].set(last ? last.v : 0);
    }
    renderRulesNow(g.settings);
  } else {
    const fresh = g.events.filter((e) => e.s > S.seen);
    // Missed more than the log keeps (a long sleep): jump to the present
    if (fresh.length && fresh[0].s > S.seen + 1 && g.events[0].s > S.seen + 1) {
      S.queue = [];
      board.snap(g.tokens);
    } else S.queue.push(...fresh);
    S.seen = g.seq;
  }
  $('end-btn').hidden = !(S.isHost && v.status === 'play');
  renderCorners(v);
  renderRoom(v);
  pump();
}

/** Play the room's log back one entry at a time; when it has caught up, show what's possible now. */
async function pump() {
  if (S.busy) return;
  const e = S.queue.shift();
  const v = S.view;
  if (!e) {
    if (v?.g) settle(v);
    return;
  }
  S.busy = true;
  board.setLegal([]);
  $('roll-btn').hidden = true;
  const speed = (PREFS.fast ? 0.6 : 1) * (S.queue.length > 2 ? 0.45 : S.queue.length ? 0.75 : 1);
  board.setSpeed(speed);
  try {
    await playEvent(v, e, speed);
  } catch (err) {
    console.error(err);
  }
  S.busy = false;
  pump();
}

async function playEvent(v, e, speed) {
  if (e.k === 'roll') {
    S.rolling = false;
    status(`${whoName(v, e.c)} rolled`);
    sound('rattle');
    await dice[e.c]?.roll(e.v, Math.round(480 * speed));
    sound('land');
    status(`${whoName(v, e.c)} rolled ${e.v}`);
    log(v, e.c, `rolled ${e.v}`);
    await wait(150 * speed);
  } else if (e.k === 'move') {
    await board.playMove(e);
    if (e.cap.length) {
      sound('capture');
      S.note = `${whoName(v, e.by)} sent ${e.cap.map((x) => colourName(v, x.c)).join(' and ')} home`;
      log(v, e.by, `sent ${e.cap.map((x) => colourName(v, x.c)).join(' and ')} home`);
    } else if (e.home) {
      sound('home');
      S.note = `${whoName(v, e.by)} got a token home`;
      log(v, e.by, 'got a token home');
    } else if (e.from === E.BASE) log(v, e.by, 'came out of the yard');
  } else if (e.k === 'pass') {
    sound('nope');
    status(e.why === 'sixes' ? 'Three 6s in a row: turn over' : `${whoName(v, e.c)}: no move`);
    log(v, e.c, e.why === 'sixes' ? 'rolled three 6s, turn over' : 'had no move');
    await wait(650 * speed);
  } else if (e.k === 'done') {
    sound('home');
    const place = PLACES[e.place - 1] || `${e.place}th`;
    S.note = `${whoName(v, e.c)} finished ${place}`;
    log(v, e.c, `finished ${place}`);
  }
}
const PLACES = ['1st', '2nd', '3rd', '4th'];

const colourName = (v, c) => {
  const p = playerAt(v, c);
  return p ? (p.id === S.myId ? 'you' : p.name) : NAMES[c];
};
const whoName = (v, c) => (v.seats[c] === S.myId ? 'You' : nameAt(v, c));
const status = (text) => { $('status').textContent = text; };

/** Caught up: the real positions, whose turn it is, and what this player may do now. */
function settle(v) {
  const g = v.g;
  board.snap(g.tokens);
  board.setTurn(v.status === 'play' ? g.turn : -1);
  renderCorners(v);
  const myself = me(v);
  const mine = v.seats[g.turn] === S.myId && v.status === 'play';
  $('back-btn').hidden = !(myself && myself.autoplay && v.status === 'play');
  $('roll-btn').hidden = true;
  board.setLegal([]);
  $('bar-phase').textContent = v.status === 'over' ? 'Game over' : myself?.seat >= 0 && g.colours.includes(myself.seat) ? `You are ${NAMES[myself.seat]}` : 'Watching';
  if (v.status === 'over') {
    status('');
    renderResult(v);
    return;
  }
  $('result').hidden = true;
  const note = S.note ? `${S.note} · ` : '';
  const rolls = g.rolls || [];
  renderPending(v, mine && g.phase === 'move');
  if (g.phase === 'roll') {
    if (mine) {
      $('roll-btn').hidden = false;
      $('roll-btn').disabled = S.rolling;
      $('roll-btn').style.setProperty('--pc', `var(--c${g.turn})`);
      status(`${note}${rolls.length ? 'Rolled a 6 · roll again' : g.sixes ? 'Roll again' : 'Your turn'}`);
      const key = `${v.game}:${g.seq}`;
      if (S.turnSoundFor !== key) {
        S.turnSoundFor = key;
        sound('turn');
        if (!document.activeElement || document.activeElement === document.body) $('roll-btn').focus({ preventScroll: true });
      }
    } else status(`${note}${nameAt(v, g.turn)}${forPartner(g)} ${rolls.length ? 'rolls again' : 'to roll'}`);
  } else if (g.phase === 'move') {
    if (mine) {
      board.setLegal(g.legal.filter((m) => m.v === S.pickV));
      const several = new Set(g.legal.map((m) => m.v)).size > 1;
      status(E.distinctMoves(g.legal).length === 1 ? `You rolled ${rolls.join(', ')}`
        : several ? `You rolled ${rolls.join(', ')} · pick a die, then a token` : `You rolled ${rolls.join(', ')} · pick a token`);
    } else status(`${nameAt(v, g.turn)}${forPartner(g)} rolled ${rolls.join(', ') || g.roll}`);
  }
  S.note = '';
}
/**
 * The rolls waiting to be used this turn, as small dice by the status line. On your own move, the dice that
 * can move something are buttons: the one picked (S.pickV) decides which tokens light up.
 */
function renderPending(v, choosing) {
  const g = v.g;
  const rolls = v.status === 'play' ? g.rolls || [] : [];
  const usable = new Set(choosing ? g.legal.map((m) => m.v) : []);
  if (choosing && !usable.has(S.pickV)) S.pickV = [...usable][0] ?? 0;
  const show = rolls.length > 1 || (rolls.length === 1 && g.phase === 'roll');
  $('pending').innerHTML = show ? rolls.map((n, r) => {
    const can = usable.has(n);
    const on = can && n === S.pickV && rolls.indexOf(n) === r;
    const cls = !choosing ? ' idle' : can ? '' : ' used';
    return `<button type="button" class="pd${cls}" data-v="${n}" aria-pressed="${on}" ${can ? '' : 'disabled'} aria-label="${choosing ? `Use the ${n}` : `Rolled ${n}`}">${pipsHtml(n)}</button>`;
  }).join('') : '';
  $('pending').style.setProperty('--pc', `var(--c${g.turn})`);
}
const PIPS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
const pipsHtml = (n) => Array.from({ length: 9 }, (_, k) => `<i${PIPS[n].includes(k + 1) ? ' class="pip"' : ''}></i>`).join('');
$('pending').addEventListener('click', (e) => {
  const b = e.target.closest('.pd:not(.used)');
  const v = S.view;
  if (!b || !v?.g || v.g.phase !== 'move' || v.seats[v.g.turn] !== S.myId || S.busy) return;
  S.pickV = Number(b.dataset.v);
  settle(v);
});

const forPartner = (g) => {
  const ctl = E.controls(g, g.turn);
  return ctl.length && ctl[0] !== g.turn ? ` (for ${NAMES[ctl[0]]})` : '';
};

$('roll-btn').addEventListener('click', roll);
// Clicking your own die rolls too
$('table').addEventListener('click', (e) => { if (e.target.closest('.card.me .die')) roll(); });
function roll() {
  const v = S.view;
  if (!v?.g || v.status !== 'play' || v.g.phase !== 'roll' || v.seats[v.g.turn] !== S.myId || S.busy || S.rolling) return;
  S.rolling = true;
  $('roll-btn').disabled = true;
  const myDie = dice[v.g.turn];
  myDie?.shake(true);
  toHost({ t: 'roll', seq: v.g.seq });
  setTimeout(() => {
    if (!S.rolling) return;
    S.rolling = false;
    myDie?.shake(false);
    if (S.view) settle(S.view);
  }, 2500);
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') close();
  if ($('game').hidden || openSheet || e.target.closest('input, textarea, select')) return;
  const v = S.view;
  if (!v?.g) return;
  // Space / Enter roll, unless they're pressing a button or a token that can move (those act themselves)
  if ((e.key === ' ' || e.key === 'Enter') && (!e.target.closest('button, .tok.can') || e.target === $('roll-btn'))) {
    e.preventDefault();
    roll();
  }
  // 1 … 4 moves that token (yours, or your partner's in teams)
  if (/^[1-4]$/.test(e.key) && v.g.phase === 'move' && v.seats[v.g.turn] === S.myId && !S.busy) {
    const m = v.g.legal.find((x) => x.i === Number(e.key) - 1 && x.v === S.pickV) || v.g.legal.find((x) => x.i === Number(e.key) - 1);
    if (m) { board.setLegal([]); toHost({ t: 'move', c: m.c, i: m.i, r: m.r, seq: v.g.seq }); }
  }
});
$('back-btn').addEventListener('click', () => { toHost({ t: 'back' }); $('back-btn').hidden = true; });

/* ---------- A card per player, in the corner of their yard ---------- */
/** Build the four corners for a new game: each playing colour gets a card with its own die. */
function buildCorners(v) {
  const g = v.g;
  dice = {};
  for (let k = 0; k < 4; k++) {
    const host = $(`corner-${k}`);
    const c = [0, 1, 2, 3].find((x) => board.corner(x) === k);
    host.className = `corner k${k}${g.colours.includes(c) ? '' : ' empty'}`;
    host.innerHTML = '';
    if (!g.colours.includes(c)) continue;
    host.innerHTML = `<div class="card c${c}" data-c="${c}">
      <span class="sw" aria-hidden="true"></span>
      <span class="who"><b class="nm"></b><span class="meta"><span class="pips"></span><span class="st"></span></span></span>
      <div class="die" role="img" aria-label="${NAMES[c]}’s last roll"></div>
      <i class="timer"></i></div>`;
    dice[c] = createDie(host.querySelector('.die'));
  }
}

/** Names, home pips, state and whose turn it is; the dice are left alone. */
function renderCorners(v) {
  const g = v.g;
  for (const c of g.colours) {
    const card = document.querySelector(`.corner .card[data-c="${c}"]`);
    if (!card) continue;
    const p = playerAt(v, c);
    const home = g.tokens[c].filter((x) => x === E.HOME).length;
    const done = g.done.indexOf(c);
    const state = done >= 0 ? PLACES[done] : !p ? 'left' : p.autoplay ? 'auto' : !active(p) ? 'away' : '';
    const team = g.settings.teams ? ` · T${c % 2 ? 2 : 1}` : '';
    card.classList.toggle('turn', g.turn === c && v.status === 'play');
    card.classList.toggle('me', p?.id === S.myId);
    card.querySelector('.nm').innerHTML = `${esc(p ? p.name : NAMES[c])}${p?.id === S.myId ? ' (you)' : ''}${botTag(p)}`;
    card.querySelector('.pips').innerHTML = g.tokens[c].map((x) => `<i class="${x === E.HOME ? 'in' : ''}"></i>`).join('');
    card.querySelector('.pips').title = `${home} of ${g.tokens[c].length} home`;
    card.querySelector('.st').textContent = `${home}/${g.tokens[c].length}${team}${state ? ` · ${state.toUpperCase()}` : ''}`;
    card.title = `${NAMES[c]}${p ? `: ${p.name}` : ''}`;
  }
  const left = v.turnLeft ?? v.idleLeft;
  S.endMs = v.turnLeft != null ? v.turnMs : v.idleLeft != null ? 60000 : 0;
  S.endAt = left != null && v.status === 'play' ? performance.now() + left : 0;
}

setInterval(() => {
  const bar = document.querySelector('.corner .card.turn .timer');
  if (!bar || $('game').hidden) return;
  if (!S.endAt || !S.endMs) { bar.style.transform = 'scaleX(0)'; return; }
  const left = Math.max(0, S.endAt - performance.now());
  bar.style.transform = `scaleX(${Math.min(1, left / S.endMs)})`;
  bar.classList.toggle('low', left < 5000 && S.view?.turnLeft != null);
}, 100);

/* ---------- Side panel ---------- */
function renderRoom(v) {
  $('who-list').innerHTML = [...v.players].sort((a, b) => b.wins - a.wins).map((p) => {
    const colour = p.seat >= 0 ? `style="--pc: var(--c${p.seat})"` : '';
    const st = !active(p) && !p.bot ? 'away' : p.seat < 0 || !p.inGame ? 'watching' : `${p.wins} win${p.wins === 1 ? '' : 's'}`;
    return `<li class="${active(p) || p.bot ? '' : 'off'}" ${colour}><span class="d"></span><span class="nm">${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}${p.bot ? ' · bot' : ''}</span><span class="v">${esc(st)}</span></li>`;
  }).join('');
}

function renderRulesNow(s) {
  const items = [
    `${s.tokens} tokens`,
    s.leave === 'six' ? 'Out on a 6' : 'Out on a 1 or 6',
    s.timer ? `${s.timer} s turns` : 'No timer',
    s.teams ? '2 vs 2' : s.end === 'all' ? 'Every place' : 'First home wins',
    s.safe === 'stars' ? 'Stars + starts safe' : s.safe === 'starts' ? 'Starts safe' : 'Nowhere safe',
  ];
  const extra = [s.bonusSix && '6', s.bonusCapture && 'capture', s.bonusHome && 'home'].filter(Boolean);
  items.push(extra.length ? `Extra roll: ${extra.join(' · ')}` : 'No extra rolls');
  if (s.bonusSix) items.push(s.sixRule === 'stack' ? 'Roll all 6s first' : 'Move each 6 first');
  if (s.threeSixes === 'lose') items.push('Three 6s end the turn');
  if (s.blocks) items.push('Blocks');
  if (s.mustCapture) items.push('Capture before home');
  items.push(s.exact ? 'Exact roll home' : 'No exact roll');
  $('rules-now').innerHTML = items.map((t) => `<span>${esc(t)}</span>`).join('');
}

function log(v, c, text) {
  const li = document.createElement('li');
  li.style.setProperty('--pc', `var(--c${c})`);
  const secs = Math.max(0, Math.round((Date.now() - (S.startedAt || Date.now())) / 1000));
  const who = colourName(v, c);
  li.innerHTML = `<span class="t">${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}</span><span class="d"></span><span>${esc(who === 'you' ? 'You' : who)} ${esc(text)}</span>`;
  $('log').prepend(li);
  while ($('log').children.length > 40) $('log').lastChild.remove();
}

const REACTIONS = ['👏', '😮', '😂', '😬', '🔥', '🤝'];
$('reacts').innerHTML = REACTIONS.map((e) => `<button type="button" data-react="${e}" aria-label="React ${e}">${e}</button>`).join('');
$('reacts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-react]');
  if (b) toHost({ t: 'react', e: b.dataset.react });
});
/** A reaction rises from the player's card (or the panel, for someone watching). */
function showReaction(pid, emoji) {
  const v = S.view;
  if (!v || !REACTIONS.includes(emoji)) return;
  const p = v.players.find((x) => x.id === pid);
  let host = $('reacts');
  if (v.g && p && p.seat >= 0 && v.g.colours.includes(p.seat)) host = $(`corner-${board.corner(p.seat)}`);
  const n = document.createElement('span');
  n.className = 'float-react';
  n.textContent = emoji;
  host.append(n);
  setTimeout(() => n.remove(), 1500);
}

// Phones: the four panels are tabs under the board
function showTab(tab) {
  S.tab = tab;
  $('ptabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
  document.querySelectorAll('.side .panel').forEach((sec) => sec.classList.toggle('on', sec.dataset.sec === tab));
}
$('ptabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) showTab(b.dataset.tab);
});
showTab('log');

$('end-btn').addEventListener('click', () => {
  if (!S.isHost) return;
  if (Date.now() - S.endArmed < 4000) { toHost({ t: 'lobby' }); return; }
  S.endArmed = Date.now();
  $('end-btn').textContent = 'Tap again to end';
  setTimeout(() => { $('end-btn').textContent = 'End game'; }, 4000);
});

/* ---------- The result ---------- */
function renderResult(v) {
  const r = v.result;
  if (!r) return;
  const g = v.g;
  const winners = r.winners;
  const iWon = winners.some((c) => v.seats[c] === S.myId);
  $('result-title').textContent = !winners.length ? 'No winner'
    : iWon ? (g.settings.teams ? 'Your team wins' : 'You win')
      : `${winners.map((c) => r.names[c]).join(' & ')} win${winners.length > 1 ? '' : 's'}`;
  $('podium').innerHTML = r.order.map((c) => {
    const st = g.stats[c];
    return `<li style="--pc: var(--c${c})"><span class="place">${r.places[c]}</span><span class="d"></span><b>${esc(r.names[c])}</b>
      <span class="facts">${g.tokens[c].filter((x) => x === E.HOME).length}/${g.tokens[c].length} HOME · ${st.captures} SENT BACK · ${st.sixes} SIXES</span></li>`;
  }).join('');
  $('again-btn').hidden = !S.isHost;
  $('to-lobby').hidden = !S.isHost;
  $('result-wait').hidden = S.isHost;
  $('crew-line').textContent = v.crewName ? `${v.crewName}: ${v.crewStatus}` : '';
  $('result').hidden = false;
  if (S.celebrated !== v.game) {
    S.celebrated = v.game;
    if (winners.length) sound(iWon ? 'win' : 'home');
  }
}
$('again-btn').addEventListener('click', () => { if (S.isHost) toHost({ t: 'start' }); });
$('to-lobby').addEventListener('click', () => { if (S.isHost) toHost({ t: 'lobby' }); });
$('quit-btn').addEventListener('click', () => { closeRoom(); goHome(); });
function paintSoundBtn() {
  $('sound-btn').textContent = PREFS.sound !== false ? '♪' : '–';
  $('sound-btn').setAttribute('aria-label', PREFS.sound !== false ? 'Sound on' : 'Sound off');
}
$('sound-btn').addEventListener('click', () => {
  PREFS.sound = PREFS.sound === false;
  setSound(PREFS.sound);
  savePrefs();
  paintSoundBtn();
  if (PREFS.sound) sound('tick');
});

/* =========================================================
   Lobby
   ========================================================= */
const SEGS = ['tokens', 'timer', 'end', 'teams', 'leave', 'sixRule', 'threeSixes', 'safe'];
const CHECKS = ['bonusSix', 'bonusCapture', 'bonusHome', 'exact', 'blocks', 'mustCapture'];
const parseVal = (key, raw) => (key === 'tokens' || key === 'timer' ? Number(raw) : key === 'teams' ? raw === 'true' : raw);

for (const key of SEGS) {
  $(`set-${key}`).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    ROOM_PREFS = E.cleanSettings({ ...ROOM_PREFS, [key]: parseVal(key, b.dataset.value) });
    roomSettingsChanged();
  });
}
for (const key of CHECKS) {
  $(`set-${key}`).addEventListener('change', (e) => {
    ROOM_PREFS = E.cleanSettings({ ...ROOM_PREFS, [key]: e.target.checked });
    roomSettingsChanged();
  });
}
$('rules-default').addEventListener('click', () => {
  const keep = { tokens: ROOM_PREFS.tokens, timer: ROOM_PREFS.timer, end: ROOM_PREFS.end, teams: ROOM_PREFS.teams };
  ROOM_PREFS = E.cleanSettings({ ...E.DEFAULT_SETTINGS, ...keep });
  roomSettingsChanged();
});
function roomSettingsChanged() {
  saveRoomPrefs();
  paintRoomSettings();
  sendSettings();
}
function houseSummary(s) {
  const d = E.DEFAULT_SETTINGS;
  const diff = [];
  if (s.leave !== d.leave) diff.push('1 or 6 out');
  if (s.bonusSix !== d.bonusSix || s.bonusCapture !== d.bonusCapture || s.bonusHome !== d.bonusHome) diff.push('extra rolls');
  if (s.sixRule !== d.sixRule) diff.push('move each 6 first');
  if (s.threeSixes !== d.threeSixes) diff.push('three 6s ok');
  if (s.safe !== d.safe) diff.push(s.safe === 'none' ? 'nowhere safe' : 'starts safe');
  if (s.exact !== d.exact) diff.push('no exact roll');
  if (s.blocks) diff.push('blocks');
  if (s.mustCapture) diff.push('capture first');
  return diff.length ? diff.join(', ') : 'the usual';
}
function paintRoomSettings() {
  for (const key of SEGS) {
    $(`set-${key}`).querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(parseVal(key, b.dataset.value) === ROOM_PREFS[key])));
  }
  for (const key of CHECKS) $(`set-${key}`).checked = ROOM_PREFS[key];
  $('house-sum').textContent = houseSummary(ROOM_PREFS);
}

function renderLobby(v) {
  afterBotAdded(v);
  $('lobby-code').textContent = v.code;
  const mine = me(v);
  if (S.moving && !v.players.some((p) => p.id === S.moving)) S.moving = null;
  $('seat-board').innerHTML = [0, 1, 2, 3].map((c) => {
    const p = playerAt(v, c);
    const ctl = [];
    let who;
    if (p) {
      who = `<b>${esc(p.name)}${p.id === S.myId ? ' (you)' : ''}</b>${botTag(p)}${p.isHost ? ' <span class="muted">host</span>' : ''}${!p.bot && !active(p) ? ' <span class="muted">reconnecting</span>' : ''}`;
      if (S.isHost && p.bot) ctl.push(botControls(p));
      if (p.id === S.myId) ctl.push('<button type="button" class="seat-link" data-stand>Stand up</button>');
      if (S.isHost && !S.moving) ctl.push(`<button type="button" class="seat-link" data-move="${p.id}">Move</button>`);
      if (S.isHost && S.moving && S.moving !== p.id) ctl.push(`<button type="button" class="seat-link strong" data-move-to="${c}">Swap here</button>`);
      if (S.isHost && S.moving === p.id) ctl.push('<button type="button" class="seat-link" data-move-cancel>Cancel</button>');
    } else {
      who = '<span class="muted">Free</span>';
      if (S.isHost && S.moving) ctl.push(`<button type="button" class="btn small" data-move-to="${c}">Move here</button>`);
      else {
        ctl.push(`<button type="button" class="btn small" data-sit="${c}">${mine && mine.seat >= 0 ? 'Move here' : 'Sit'}</button>`);
        if (S.isHost) ctl.push(`<button type="button" class="btn small ghost" data-bot-seat="${c}">Add bot</button>`);
      }
    }
    return `<div class="seat${p ? '' : ' free'}${p?.id === S.myId ? ' me' : ''}${S.moving && p?.id === S.moving ? ' moving' : ''}" style="--pc: var(--c${c})">
      <span class="dot"></span><span class="seat-colour">${NAMES[c]}</span><span class="seat-who">${who}</span><span class="seat-ctl">${ctl.join('')}</span></div>`;
  }).join('');
  const watchers = v.players.filter((p) => p.seat < 0);
  $('watchers').innerHTML = watchers.length ? `<li class="muted">Watching: ${watchers.map((p) => esc(p.name) + (p.id === S.myId ? ' (you)' : '')).join(', ')}</li>` : '';
  const seated = v.seats.filter(Boolean).length;
  $('seat-note').textContent = v.settings.teams ? 'Teams: Red & Yellow against Green & Blue.' : seated < 2 ? 'Pick a colour. Add bots to fill the board.' : '';
  $('host-settings').hidden = !S.isHost;
  $('guest-settings').hidden = S.isHost;
  if (S.isHost) {
    paintRoomSettings();
    if (document.activeElement !== $('crew-input')) $('crew-input').value = v.crewName;
    $('crew-status').textContent = v.crewStatus;
    paintPublic(v);
    const teamsShort = ROOM_PREFS.teams && seated < 4;
    $('start-btn').disabled = seated < 2 || teamsShort;
    $('start-note').textContent = seated < 2 ? 'Needs 2 players (people or bots) in seats.' : teamsShort ? '2 vs 2 needs all four colours filled.' : `${seated} players. Who goes first is picked at random.`;
  } else {
    const s = v.settings;
    $('settings-summary').innerHTML = `<li><b>${s.tokens} tokens each</b> · ${s.timer ? `${s.timer} s a turn` : 'no turn timer'}</li>`
      + `<li>${s.teams ? '2 vs 2, partners opposite' : s.end === 'all' ? 'Play on for every place' : 'First one home wins'}</li>`
      + `<li>House rules: ${esc(houseSummary(s))}</li>`
      + (v.crewName ? `<li>Crew: <b>${esc(v.crewName)}</b></li>` : '') + `<li>${publicLine(v)}</li>`;
  }
}

$('seat-board').addEventListener('click', (e) => {
  const v = S.view;
  if (!v) return;
  const sit = e.target.closest('[data-sit]');
  if (sit) return toHost({ t: 'sit', seat: Number(sit.dataset.sit) });
  if (e.target.closest('[data-stand]')) return toHost({ t: 'stand' });
  const bot = e.target.closest('[data-bot-seat]');
  if (bot && S.isHost) {
    // A bot sits in the first free colour; move it to the one chosen when the room puts it elsewhere
    const want = Number(bot.dataset.botSeat);
    const before = new Set(v.players.map((p) => p.id));
    S.botWant = { want, before };
    return toHost({ t: 'addBot', level: 'normal' });
  }
  const mv = e.target.closest('[data-move]');
  if (mv && S.isHost) { S.moving = mv.dataset.move; return renderLobby(v); }
  if (e.target.closest('[data-move-cancel]')) { S.moving = null; return renderLobby(v); }
  const to = e.target.closest('[data-move-to]');
  if (to && S.isHost && S.moving) {
    toHost({ t: 'seat', id: S.moving, seat: Number(to.dataset.moveTo) });
    S.moving = null;
  }
});
wireBots($('seat-board'), toHost, () => S.isHost);
// A bot just added for a chosen colour: put it there
function afterBotAdded(v) {
  if (!S.botWant || !S.isHost) return;
  const fresh = v.players.find((p) => p.bot && !S.botWant.before.has(p.id));
  if (!fresh) return;
  const { want } = S.botWant;
  S.botWant = null;
  if (fresh.seat !== want && !v.seats[want]) toHost({ t: 'seat', id: fresh.id, seat: want });
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
  toHost({ t: 'start', settings: { ...ROOM_PREFS }, crew });
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
    homeError('Type your name first so the others know who you are.');
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
$('quick-btn').addEventListener('click', async () => {
  const name = readName();
  if (!name) return;
  homeError('');
  S.myName = name;
  setBusy(true);
  try {
    const code = await quickPlay('ludo');
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
  $('fast-toggle').checked = Boolean(PREFS.fast);
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
        <div><b>${st.games ? `${Math.round((st.wins / st.games) * 100)}%` : '–'}</b><span>Win rate</span></div>
        <div><b>${st.captures}</b><span>Captures</span></div>
        <div><b>${st.captured}</b><span>Times sent home</span></div>
        <div><b>${st.home}</b><span>Tokens home</span></div>
        <div><b>${st.sixes}</b><span>Sixes rolled</span></div>
        <div><b>${st.rolls ? `${Math.round((st.sixes / st.rolls) * 1000) / 10}%` : '–'}</b><span>Sixes per roll</span></div>
        <div><b>${st.rolls}</b><span>Rolls</span></div>
      </div>`;
  } catch (err) {
    $('my-stats').innerHTML = `<p class="muted">${esc(cloud.errorText(err))}</p>`;
  }
}
$('sound-toggle').addEventListener('change', (e) => { PREFS.sound = e.target.checked; setSound(PREFS.sound); savePrefs(); paintSoundBtn(); if (PREFS.sound) sound('tick'); });
$('fast-toggle').addEventListener('change', (e) => { PREFS.fast = e.target.checked; savePrefs(); });
$('analytics-toggle').addEventListener('change', (e) => {
  PREFS.analytics = e.target.checked;
  savePrefs();
  cloud.setAnalyticsEnabled(e.target.checked);
});

// Test hook: with ?debug in the address, automated tests can inspect what this player was sent and talk to the room
if (new URLSearchParams(location.search).has('debug')) window.__ludo = { S, link, board };

/* =========================================================
   Start
   ========================================================= */
// The die next to the title on the home screen rolls every few seconds while the home screen is showing
const logoDie = createDie($('logo-die'));
logoDie.set(6);
setInterval(() => {
  if (!$('home').hidden && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) logoDie.roll(1 + Math.floor(Math.random() * 6), 600);
}, 2800);

(function init() {
  const saved = store.get('name', '');
  if (saved) $('name-input').value = saved;
  paintSoundBtn();
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
