// The Ludo board: a flat SVG drawn from the rules file's geometry, the tokens on it and their moves.
// Plain on purpose: hairline squares, solid colour yards, flat tokens. The only highlights are the ones you
// can act on (tokens that can move, and where the one you point at would land).
// It knows nothing about the network: app.js tells it what to show and hears back which token was picked.
import * as E from './engine.js';

const NS = 'http://www.w3.org/2000/svg';
const U = 40;          // one cell, in board units (the board is 15 × 15 cells = 600 × 600)
const R = 12.5;        // token radius
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.append(n);
  return n;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * createBoard(host, { onPick(c, i) }) → board API. The board is turned so a chosen colour's yard sits at the
 * bottom left (the player's own), without turning any shapes (everything is placed from turned points).
 */
export function createBoard(host, { onPick }) {
  let rot = 0;
  let tokens = {};
  let colours = [];
  let settings = E.DEFAULT_SETTINGS;
  const tokEls = {};
  let legal = [];
  let legalKey = '';
  let selected = '';
  const hover = window.matchMedia('(hover: hover)').matches;

  const svg = el('svg', { viewBox: '-2 -2 604 604', class: 'board', role: 'img', 'aria-label': 'Ludo board' });
  const gBoard = el('g', {}, svg);
  const gHi = el('g', { class: 'hi' }, svg);
  const gTok = el('g', {}, svg);
  host.append(svg);

  const P = (pt) => E.rotPoint(pt, rot).map((v) => v * U);
  const cellAt = (cell) => {
    const [cx, cy] = E.rotCell(cell, rot);
    return { x: cx * U, y: cy * U };
  };
  const box = (x1, y1, x2, y2, c) => {
    const a = P(E.rotPoint([x1, y1], c));
    const b = P(E.rotPoint([x2, y2], c));
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
  };
  const square = (cell, cls) => {
    const { x, y } = cellAt(cell);
    return el('rect', { x, y, width: U, height: U, class: cls }, gBoard);
  };

  function drawBoard() {
    gBoard.replaceChildren();
    el('rect', { x: 0, y: 0, width: 600, height: 600, class: 'b-bg' }, gBoard);
    for (let c = 0; c < 4; c++) {
      const y = box(0, 0, 6, 6, c);
      el('rect', { x: y.x, y: y.y, width: y.w, height: y.h, class: `yard c${c}${colours.includes(c) ? '' : ' off'}` }, gBoard);
      const inner = box(1, 1, 5, 5, c);
      el('rect', { x: inner.x, y: inner.y, width: inner.w, height: inner.h, rx: 6, class: 'yard-in' }, gBoard);
      for (let i = 0; i < 4; i++) {
        const [x, yy] = P(E.spot(c, E.BASE, i));
        el('circle', { cx: x, cy: yy, r: R + 4, class: 'slot' }, gBoard);
      }
    }
    for (let a = 0; a < E.TRACK; a++) {
      const start = E.STARTS.indexOf(a);
      const safe = start < 0 && settings.safe === 'stars' && E.STARS.includes(a);
      square(E.trackCell(a), start >= 0 ? `sq start c${start}` : safe ? 'sq safe' : 'sq');
    }
    for (let c = 0; c < 4; c++) for (let j = 0; j < 5; j++) square(E.laneCell(c, j), `sq lane c${c}`);
    for (let c = 0; c < 4; c++) {
      const pts = [[6, 6], [6, 9], [7.5, 7.5]].map((p) => P(E.rotPoint(p, c)));
      el('polygon', { points: pts.map((p) => p.join(',')).join(' '), class: `tri c${c}` }, gBoard);
    }
    el('rect', { x: 0, y: 0, width: 600, height: 600, class: 'b-edge' }, gBoard);
  }

  // ---------- Tokens ----------
  function tokenEl(c, i) {
    const key = `${c}:${i}`;
    if (tokEls[key]) return tokEls[key];
    const g = el('g', { class: `tok c${c}`, 'data-c': c, 'data-i': i, tabindex: '-1', role: 'button', 'aria-label': `${E.COLOUR_NAMES[c]} token ${i + 1}` }, gTok);
    el('circle', { r: R + 5.5, class: 'tok-ring' }, g);
    el('circle', { r: R, class: 'tok-disc' }, g);
    tokEls[key] = g;
    return g;
  }

  const posOf = (c, p, i) => P(E.spot(c, p, i));
  const stackKey = (c, p) => (p >= E.LANE ? `l${c}:${p}` : `t${E.absOf(c, p)}`);
  const FAN = { 2: [[-5, -4], [5, 4]], 3: [[-6, 4], [6, 4], [0, -6]], 4: [[-6, -6], [6, -6], [-6, 6], [6, 6]] };

  /** Where every token stands, with small offsets for tokens sharing a square. */
  function layout() {
    const groups = {};
    for (const c of colours) (tokens[c] || []).forEach((p, i) => {
      if (p !== E.BASE && p !== E.HOME) (groups[stackKey(c, p)] ||= []).push(`${c}:${i}`);
    });
    const out = {};
    for (const c of colours) (tokens[c] || []).forEach((p, i) => {
      const [x, y] = posOf(c, p, i);
      const id = `${c}:${i}`;
      if (p === E.BASE) out[id] = { x, y, s: 1 };
      else if (p === E.HOME) out[id] = { x, y, s: 0.66 };
      else {
        const g = groups[stackKey(c, p)];
        const n = Math.min(4, g.length);
        const [dx, dy] = n > 1 ? FAN[n][g.indexOf(id) % 4] : [0, 0];
        out[id] = { x: x + dx, y: y + dy, s: n > 1 ? 0.78 : 1 };
      }
    });
    return out;
  }
  const put = (g, { x, y, s }) => { g.style.transform = `translate(${x}px, ${y}px) scale(${s})`; };

  function place(animate = true) {
    const at = layout();
    const live = new Set();
    for (const c of colours) (tokens[c] || []).forEach((p, i) => {
      const g = tokenEl(c, i);
      live.add(`${c}:${i}`);
      g.classList.toggle('no-ease', !animate);
      put(g, at[`${c}:${i}`]);
    });
    for (const [k, g] of Object.entries(tokEls)) if (!live.has(k)) { g.remove(); delete tokEls[k]; }
  }

  // ---------- What you can do ----------
  const moveOf = (c, i) => legal.find((m) => m.c === c && m.i === i);
  const clearPreview = () => gHi.replaceChildren();

  /** Where a token would go: small dots along the way and an outline where it lands (a cross on anyone it sends home). */
  function preview(m) {
    clearPreview();
    if (!m) return;
    m.path.slice(0, -1).forEach((p) => {
      const [x, y] = posOf(m.c, p, m.i);
      el('circle', { cx: x, cy: y, r: 2.5, class: 'step' }, gHi);
    });
    const [tx, ty] = posOf(m.c, m.path[m.path.length - 1], m.i);
    el('circle', { cx: tx, cy: ty, r: R, class: `land c${m.c}`, 'data-c': m.c, 'data-i': m.i }, gHi);
    for (const v of m.cap) {
      const [vx, vy] = posOf(v.c, tokens[v.c][v.i], v.i);
      el('path', { d: `M${vx - 6} ${vy - 6}L${vx + 6} ${vy + 6}M${vx + 6} ${vy - 6}L${vx - 6} ${vy + 6}`, class: 'cap-x' }, gHi);
    }
  }

  function setLegal(list) {
    const key = (list || []).map((m) => `${m.c}:${m.i}:${m.to}`).join('|');
    if (key === legalKey && key) return;   // the same choices again (another update): keep what's previewed
    legalKey = key;
    legal = list || [];
    selected = '';
    clearPreview();
    for (const g of Object.values(tokEls)) {
      g.classList.remove('can', 'sel');
      g.setAttribute('tabindex', '-1');
    }
    for (const m of legal) {
      const g = tokEls[`${m.c}:${m.i}`];
      if (!g) continue;
      g.classList.add('can');
      g.setAttribute('tabindex', '0');
      gTok.append(g);   // movable tokens on top of a stack
    }
    svg.classList.toggle('picking', legal.length > 0);
  }

  function pick(c, i) {
    if (!moveOf(c, i)) return;
    legalKey = '';
    clearPreview();
    onPick(c, i);
  }
  function select(c, i) {
    selected = `${c}:${i}`;
    for (const g of Object.values(tokEls)) g.classList.toggle('sel', g === tokEls[selected]);
    preview(moveOf(c, i));
  }

  svg.addEventListener('pointerover', (e) => {
    if (!hover) return;
    const t = e.target.closest('.tok.can');
    if (t) preview(moveOf(Number(t.dataset.c), Number(t.dataset.i)));
  });
  svg.addEventListener('pointerout', (e) => {
    if (!hover || selected) return;
    const t = e.target.closest('.tok.can');
    if (t && !t.contains(e.relatedTarget)) clearPreview();
  });
  svg.addEventListener('click', (e) => {
    const land = e.target.closest('.land');
    if (land) return pick(Number(land.dataset.c), Number(land.dataset.i));
    const t = e.target.closest('.tok.can');
    if (!t) {
      if (selected) {
        selected = '';
        clearPreview();
        svg.querySelectorAll('.tok.sel').forEach((n) => n.classList.remove('sel'));
      }
      return;
    }
    const c = Number(t.dataset.c), i = Number(t.dataset.i);
    // Touch screens: the first tap shows where it goes, the second (or a tap on that spot) moves
    if (!hover && E.distinctMoves(legal).length > 1 && selected !== `${c}:${i}`) return select(c, i);
    pick(c, i);
  });
  svg.addEventListener('focusin', (e) => {
    const t = e.target.closest('.tok.can');
    if (t) preview(moveOf(Number(t.dataset.c), Number(t.dataset.i)));
  });
  svg.addEventListener('keydown', (e) => {
    const t = e.target.closest('.tok.can');
    if (t && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      pick(Number(t.dataset.c), Number(t.dataset.i));
    }
  });

  // ---------- Moves ----------
  let speed = 1;
  const ms = (n) => (reduced() ? 0 : Math.round(n * speed));

  async function slide(g, from, to, dur) {
    if (!dur) return;
    const a = g.animate([{ transform: `translate(${from[0]}px, ${from[1]}px)` }, { transform: `translate(${to[0]}px, ${to[1]}px)` }], { duration: dur, easing: 'ease-in-out', fill: 'forwards' });
    await wait(dur);
    a.cancel();
  }

  /** A move from the room's log: the token steps square by square; anyone it lands on slides back to their yard. */
  async function playMove(e) {
    const g = tokenEl(e.c, e.i);
    g.classList.add('no-ease');
    gTok.append(g);
    let at = posOf(e.c, e.from, e.i);
    const step = e.from === E.BASE ? ms(260) : ms(120);
    for (const p of e.path) {
      const next = posOf(e.c, p, e.i);
      put(g, { x: next[0], y: next[1], s: 1 });
      await slide(g, at, next, step);
      at = next;
    }
    tokens[e.c][e.i] = e.path[e.path.length - 1];
    if (e.cap.length) {
      await Promise.all(e.cap.map(async (v) => {
        const vg = tokenEl(v.c, v.i);
        const home = posOf(v.c, E.BASE, v.i);
        vg.classList.add('no-ease');
        put(vg, { x: home[0], y: home[1], s: 1 });
        await slide(vg, at, home, ms(380));
        tokens[v.c][v.i] = E.BASE;
      }));
    }
    void svg.getBoundingClientRect();
    for (const t of Object.values(tokEls)) t.classList.remove('no-ease');
    place(true);
  }

  return {
    svg,
    /** A fresh game: draw the board for these rules, turned so `bottom` sits at the bottom left. */
    setup(g, bottom) {
      settings = g.settings;
      colours = g.colours;
      rot = (((3 - bottom) % 4) + 4) % 4;
      for (const k of Object.keys(tokEls)) { tokEls[k].remove(); delete tokEls[k]; }
      tokens = JSON.parse(JSON.stringify(g.tokens));
      legalKey = '';
      drawBoard();
      place(false);
    },
    /** Show these positions now (after a refresh, or when the animations have caught up). */
    snap(t) {
      tokens = JSON.parse(JSON.stringify(t));
      place(true);
    },
    setLegal,
    playMove,
    setSpeed(s) { speed = s; },
  };
}
