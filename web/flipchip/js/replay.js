// A shared replay (?replay=<id>): read-only, no room, works for guests. The server saved the
// board size, the players, every move (passes included) and the result at the end of the game;
// the engine rebuilds each position from the moves.
import * as E from './engine.js';

const { DARK, LIGHT } = E;
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const chipHtml = (s) => `<span class="chip${s === LIGHT ? ' is-l' : ''}"><i class="f d"></i><i class="f l"></i></span>`;
const miniChip = (s) => `<span class="mini-chip">${chipHtml(s)}</span>`;
const tinyChip = (s) => `<span class="mini-chip sm">${chipHtml(s)}</span>`;
const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

const R = { data: null, steps: [], k: 0, cells: [], timer: 0, playing: false };

function show(id) {
  for (const s of ['home', 'lobby', 'game', 'replay', 'replay-missing']) $(s).hidden = s !== id;
  window.scrollTo(0, 0);
}
function missing(text) {
  if (text) $('rm-text').textContent = text;
  show('replay-missing');
}

export async function startReplay(id) {
  if (!/^[A-Za-z0-9]{12}$/.test(id || '')) return missing();
  show('replay');
  $('rp-title').textContent = 'Loading replay…';
  let res;
  try {
    res = await fetch(`/api/flipchip/replay/${encodeURIComponent(id)}`);
  } catch {
    return missing('Couldn’t load this replay. Check your connection and try the link again.');
  }
  if (res.status === 404) return missing();
  if (!res.ok) return missing('Couldn’t load this replay right now. Try again in a minute.');
  const { replay, createdAt } = await res.json();
  if (!build(replay, createdAt)) return missing();
  if (reduced) document.body.classList.add('anim-reduced');
  go(0, false);
  if (!reduced) play();
}

// One position per log entry (index 0 = the empty start). Bad data means "not found".
function build(r, createdAt) {
  if (!r || !E.SIZES.includes(r.size) || !Array.isArray(r.moves) || !r.players) return false;
  const n = r.size;
  let board = E.newBoard(n);
  const steps = [{ board, move: null, entry: null }];
  for (const m of r.moves) {
    if (m.pass) { steps.push({ board, move: null, entry: m }); continue; }
    const res = E.play(board, n, m.i, m.side);
    if (!res) return false;
    board = res.board;
    steps.push({ board, move: { i: m.i, side: m.side, flips: res.flips }, entry: m });
  }
  R.data = r;
  R.steps = steps;
  $('rp-when').textContent = new Date(createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ` · ${n} × ${n}`;
  buildBoard(n);
  const range = $('rp-range');
  range.max = String(steps.length - 1);
  renderResult(r);
  let k = 0;
  $('rp-log').innerHTML = r.moves.map((m, i) => {
    if (m.pass) return `<li class="pass" data-k="${i + 1}">${tinyChip(m.side)}pass</li>`;
    k++;
    return `<li data-k="${i + 1}"><span class="n">${k}</span>${tinyChip(m.side)}${E.cellName(m.i, n)}</li>`;
  }).join('');
  $('rp-count').textContent = k ? `${k} move${k === 1 ? '' : 's'}` : '';
  return true;
}

function buildBoard(n) {
  const board = $('rp-board');
  board.style.setProperty('--n', n);
  $('rp-board').closest('.board-frame').style.setProperty('--n', n);
  board.innerHTML = '';
  R.cells = [];
  for (let i = 0; i < n * n; i++) {
    const el = document.createElement('div');
    el.className = 'cell';
    el.innerHTML = `<span class="slot" hidden>${chipHtml(DARK)}</span>`;
    board.appendChild(el);
    R.cells.push({ el, slot: el.firstChild, chip: el.firstChild.firstChild });
  }
  $('rp-cols').innerHTML = Array.from({ length: n }, (_, c) => `<span>${String.fromCharCode(97 + c)}</span>`).join('');
  $('rp-rows').innerHTML = Array.from({ length: n }, (_, r) => `<span>${r + 1}</span>`).join('');
}

function renderResult(r) {
  const dark = r.players.dark, light = r.players.light;
  const name = (s) => (s === DARK ? dark : light);
  const c = r.counts;
  let title, sub;
  if (!r.winner) { title = 'A draw!'; sub = `${c.dark} chips each.`; }
  else {
    title = `${esc(name(r.winner))} wins!`;
    const loser = name(E.other(r.winner));
    sub = r.reason === 'resign' ? `${loser} resigned.` : r.reason === 'forfeit' ? `${loser} left the game.` : r.reason === 'idle' ? `${loser} didn’t move for too long.`
      : `${Math.max(c.dark, c.light)} to ${Math.min(c.dark, c.light)} in chips.`;
  }
  $('rp-head').className = 'result-head won';
  $('rp-title').innerHTML = title;
  $('rp-sub').textContent = sub;
}

function paint(k, animateMove) {
  const step = R.steps[k];
  const n = R.data.size;
  const move = animateMove ? step.move : null;
  const flipSet = new Set(move ? move.flips : []);
  const r0 = move ? Math.floor(move.i / n) : 0, c0 = move ? move.i % n : 0;
  const gap = reduced ? 30 : 75;
  R.cells.forEach((cell, i) => {
    const val = step.board[i];
    if (!move) cell.chip.style.transition = 'none';
    cell.chip.style.transitionDelay = '0ms';
    if (!val) cell.slot.hidden = true;
    else {
      const wasEmpty = cell.slot.hidden;
      cell.slot.hidden = false;
      if (wasEmpty && move) cell.chip.style.transition = 'none';
      if (move && flipSet.has(i)) {
        const d = Math.max(Math.abs(Math.floor(i / n) - r0), Math.abs((i % n) - c0));
        cell.chip.style.transitionDelay = `${110 + (d - 1) * gap}ms`;
      }
      cell.chip.classList.toggle('is-l', val === LIGHT);
      if (move && i === move.i && wasEmpty) {
        cell.slot.classList.remove('pop');
        void cell.slot.offsetWidth;
        cell.slot.classList.add('pop');
      }
    }
    cell.el.classList.toggle('last', Boolean(step.move) && step.move.i === i);
  });
  void $('rp-board').offsetWidth;
  if (!move) for (const cell of R.cells) cell.chip.style.transition = '';
  else for (const cell of R.cells) if (cell.chip.style.transition === 'none') cell.chip.style.transition = '';
}

function cards(k) {
  const c = E.counts(R.steps[k].board);
  const r = R.data;
  for (const s of [DARK, LIGHT]) {
    const win = k === R.steps.length - 1 && r.winner === s;
    $(`rp-card-${s}`).className = `player-card s${s}${win ? ' won' : ''}`;
    $(`rp-card-${s}`).innerHTML = `${miniChip(s)}<span class="who"><span class="nm">${esc(s === DARK ? r.players.dark : r.players.light)}</span><span class="tag">${E.SIDE_NAME[s]}${win ? ' · Winner' : ''}</span></span><b class="count">${c[s]}</b>`;
  }
  $('rp-bar-d').style.flexGrow = c[1];
  $('rp-bar-l').style.flexGrow = c[2];
}

function go(k, animate) {
  k = Math.max(0, Math.min(R.steps.length - 1, k));
  const forward = animate && k === R.k + 1;
  R.k = k;
  paint(k, forward);
  cards(k);
  $('rp-range').value = String(k);
  const total = R.steps.length - 1;
  const e = R.steps[k].entry;
  $('rp-line').innerHTML = k === 0 ? `${miniChip(DARK)}<span>Start · ${esc(R.data.players.dark)} goes first</span>`
    : e.pass ? `${miniChip(E.other(e.side))}<span>${esc(e.side === DARK ? R.data.players.dark : R.data.players.light)} has no moves and passes (${k} of ${total})</span>`
    : `${miniChip(e.side)}<span>${esc(e.side === DARK ? R.data.players.dark : R.data.players.light)} plays ${E.cellName(e.i, R.data.size)} (${k} of ${total})</span>`;
  $('rp-log').querySelectorAll('li').forEach((li) => li.classList.toggle('now', Number(li.dataset.k) === k));
  const cur = $('rp-log').querySelector('li.now');
  if (cur) {
    const log = $('rp-log');
    log.scrollTop += cur.getBoundingClientRect().top - log.getBoundingClientRect().top - log.clientHeight / 2;
  }
  $('rp-first').disabled = $('rp-prev').disabled = k === 0;
  $('rp-next').disabled = $('rp-last').disabled = k === total;
  $('rp-play').textContent = R.playing ? 'Pause' : k === total ? 'Replay' : 'Play';
}

function pause() {
  clearInterval(R.timer);
  R.playing = false;
  go(R.k, false);
}
function play() {
  if (R.k >= R.steps.length - 1) go(0, false);
  R.playing = true;
  go(R.k, false);
  clearInterval(R.timer);
  R.timer = setInterval(() => {
    if (R.k >= R.steps.length - 1) return pause();
    go(R.k + 1, true);
    if (R.k >= R.steps.length - 1) pause();
  }, 1100);
}
const stopAnd = (fn) => () => { if (R.playing) { clearInterval(R.timer); R.playing = false; } fn(); };

$('rp-play').addEventListener('click', () => (R.playing ? pause() : play()));
$('rp-next').addEventListener('click', stopAnd(() => go(R.k + 1, true)));
$('rp-prev').addEventListener('click', stopAnd(() => go(R.k - 1, false)));
$('rp-first').addEventListener('click', stopAnd(() => go(0, false)));
$('rp-last').addEventListener('click', stopAnd(() => go(R.steps.length - 1, false)));
$('rp-range').addEventListener('input', stopAnd(() => go(Number($('rp-range').value), false)));
$('rp-log').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-k]');
  if (li) stopAnd(() => go(Number(li.dataset.k), false))();
});
document.addEventListener('keydown', (e) => {
  if ($('replay').hidden || e.target.matches('input')) return;
  if (e.key === 'ArrowRight') $('rp-next').click();
  else if (e.key === 'ArrowLeft') $('rp-prev').click();
  else if (e.key === ' ' && !e.target.matches('button, a')) { e.preventDefault(); $('rp-play').click(); }
});
if (new URLSearchParams(location.search).has('debug')) window.__flipreplay = R;
