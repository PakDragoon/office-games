// The Ludo board: an SVG drawn from the rules file's geometry, the tokens on it and every animation
// (hops along the track, knock-backs, home bursts, move previews). It knows nothing about the network:
// app.js tells it what to show and hears back which token the player picked.
import * as E from './engine.js';

const NS = 'http://www.w3.org/2000/svg';
const U = 40;                        // one cell, in board units (the board is 15 × 15 cells = 600 × 600)
const R = 13.5;                      // token radius
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.append(n);
  return n;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * createBoard(host, { onPick(c, i), sound }) → board API. `rotation` turns the board so a chosen colour sits at the
 * bottom left (the player's own yard), without turning any shapes (everything is placed from rotated points).
 */
export function createBoard(host, { onPick, sound }) {
  let rot = 0;
  let tokens = {};                   // what's drawn: colour -> positions
  let colours = [];
  let settings = E.DEFAULT_SETTINGS;
  const tokEls = {};                 // `${c}:${i}` -> <g>
  let legal = [];
  let selected = null;               // touch: the token previewed, waiting for a second tap
  const hover = window.matchMedia('(hover: hover)').matches;

  const svg = el('svg', { viewBox: '-14 -14 628 628', class: 'board', role: 'img', 'aria-label': 'Ludo board' });
  const defs = el('defs', {}, svg);
  const gFrame = el('g', {}, svg);
  const gBoard = el('g', { class: 'board-face' }, svg);
  const gHi = el('g', { class: 'hi' }, svg);
  const gTok = el('g', { class: 'toks' }, svg);
  const gFx = el('g', { class: 'fx' }, svg);
  host.append(svg);

  // ---------- Paint (gradients take the colours from CSS variables) ----------
  for (let c = 0; c < 4; c++) {
    const dome = el('radialGradient', { id: `dome${c}`, cx: '0.36', cy: '0.3', r: '0.85' }, defs);
    el('stop', { offset: '0', style: `stop-color: color-mix(in srgb, var(--c${c}) 30%, #fff)` }, dome);
    el('stop', { offset: '0.5', style: `stop-color: var(--c${c})` }, dome);
    el('stop', { offset: '1', style: `stop-color: color-mix(in srgb, var(--c${c}) 62%, #000)` }, dome);
    const yard = el('linearGradient', { id: `yard${c}`, x1: '0', y1: '0', x2: '1', y2: '1' }, defs);
    el('stop', { offset: '0', style: `stop-color: color-mix(in srgb, var(--c${c}) 82%, #fff)` }, yard);
    el('stop', { offset: '1', style: `stop-color: color-mix(in srgb, var(--c${c}) 88%, #000)` }, yard);
    const lane = el('linearGradient', { id: `lane${c}`, x1: '0', y1: '0', x2: '1', y2: '1' }, defs);
    el('stop', { offset: '0', style: `stop-color: color-mix(in srgb, var(--c${c}) 70%, var(--cell))` }, lane);
    el('stop', { offset: '1', style: `stop-color: var(--c${c})` }, lane);
  }
  const pocket = el('radialGradient', { id: 'pocket', cx: '0.5', cy: '0.38', r: '0.65' }, defs);
  el('stop', { offset: '0', style: 'stop-color: var(--pocket-hi)' }, pocket);
  el('stop', { offset: '1', style: 'stop-color: var(--pocket)' }, pocket);
  const frame = el('linearGradient', { id: 'frame', x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
  el('stop', { offset: '0', style: 'stop-color: var(--frame-hi)' }, frame);
  el('stop', { offset: '1', style: 'stop-color: var(--frame)' }, frame);
  const glow = el('radialGradient', { id: 'centre-glow', cx: '0.5', cy: '0.5', r: '0.5' }, defs);
  el('stop', { offset: '0', style: 'stop-color: #fff; stop-opacity: 0.85' }, glow);
  el('stop', { offset: '1', style: 'stop-color: #fff; stop-opacity: 0' }, glow);
  const dots = el('pattern', { id: 'weave', width: '8', height: '8', patternUnits: 'userSpaceOnUse' }, defs);
  el('circle', { cx: '2', cy: '2', r: '0.9', class: 'weave-dot' }, dots);
  el('circle', { cx: '6', cy: '6', r: '0.9', class: 'weave-dot' }, dots);

  // ---------- Geometry helpers ----------
  const P = ([x, y]) => E.rotPoint([x, y], rot).map((v) => v * U);
  const cellRect = (cell) => {
    const [cx, cy] = E.rotCell(cell, rot);
    return { x: cx * U, y: cy * U };
  };
  /** Board-unit box of a canonical rectangle (cell units) after turning. */
  const box = (x1, y1, x2, y2, c) => {
    const a = P(E.rotPoint([x1, y1], c));
    const b = P(E.rotPoint([x2, y2], c));
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
  };
  const star = (cx, cy, r) => {
    let d = '';
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      const rr = k % 2 ? r * 0.45 : r;
      d += `${k ? 'L' : 'M'}${(cx + Math.cos(a) * rr).toFixed(1)} ${(cy + Math.sin(a) * rr).toFixed(1)}`;
    }
    return `${d}Z`;
  };

  // ---------- Drawing the board ----------
  function drawBoard() {
    gFrame.replaceChildren();
    gBoard.replaceChildren();
    el('rect', { x: -12, y: -12, width: 624, height: 624, rx: 26, class: 'frame', fill: 'url(#frame)' }, gFrame);
    el('rect', { x: -3, y: -3, width: 606, height: 606, rx: 18, class: 'face' }, gFrame);
    el('rect', { x: -3, y: -3, width: 606, height: 606, rx: 18, fill: 'url(#weave)', class: 'face-weave' }, gFrame);

    for (let c = 0; c < 4; c++) {
      const g = el('g', { class: `yard c${c}`, 'data-c': c }, gBoard);
      const b = box(0.15, 0.15, 5.85, 5.85, c);
      el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 20, fill: `url(#yard${c})`, class: 'yard-bg' }, g);
      el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 20, class: 'yard-glow' }, g);
      const inner = box(0.85, 0.85, 5.15, 5.15, c);
      el('rect', { x: inner.x, y: inner.y, width: inner.w, height: inner.h, rx: 16, class: 'yard-in' }, g);
      for (let i = 0; i < 4; i++) {
        const [x, y] = P(E.spot(c, E.BASE, i));
        el('circle', { cx: x, cy: y, r: 23, class: 'pocket', fill: 'url(#pocket)' }, g);
        el('circle', { cx: x, cy: y, r: 23, class: 'pocket-rim', stroke: `var(--c${c})` }, g);
      }
    }
    // Track squares
    for (let a = 0; a < E.TRACK; a++) {
      const { x, y } = cellRect(E.trackCell(a));
      const startOf = E.STARTS.indexOf(a);
      el('rect', {
        x: x + 1.5, y: y + 1.5, width: U - 3, height: U - 3, rx: 7,
        class: startOf >= 0 ? `cell start c${startOf}` : 'cell', ...(startOf >= 0 ? { style: `fill: url(#lane${startOf})` } : {}),
      }, gBoard);
      if (E.STARS.includes(a) && settings.safe === 'stars') el('path', { d: star(x + U / 2, y + U / 2, 12), class: 'star' }, gBoard);
      if (startOf >= 0) {
        // An arrow on each start square, pointing the way round
        const [nx, ny] = E.rotCell(E.trackCell((a + 1) % E.TRACK), rot);
        const [sx, sy] = E.rotCell(E.trackCell(a), rot);
        const ang = (Math.atan2(ny - sy, nx - sx) * 180) / Math.PI;
        el('path', { d: 'M-8 -6 L4 0 L-8 6', transform: `translate(${x + U / 2} ${y + U / 2}) rotate(${ang})`, class: 'start-arrow' }, gBoard);
        if (settings.safe !== 'none') el('circle', { cx: x + U / 2, cy: y + U / 2, r: 14.5, class: 'safe-ring' }, gBoard);
      }
    }
    // Home lanes, and an arrow into each one
    for (let c = 0; c < 4; c++) {
      for (let j = 0; j < 5; j++) {
        const { x, y } = cellRect(E.laneCell(c, j));
        el('rect', { x: x + 1.5, y: y + 1.5, width: U - 3, height: U - 3, rx: 7, class: `cell lane c${c}`, style: `fill: url(#lane${c}); fill-opacity: ${0.6 + j * 0.1}` }, gBoard);
      }
      const { x, y } = cellRect(E.trackCell(E.absOf(c, E.LAST_TRACK)));
      const [lx, ly] = E.rotCell(E.laneCell(c, 0), rot);
      const [tx, ty] = E.rotCell(E.trackCell(E.absOf(c, E.LAST_TRACK)), rot);
      const ang = (Math.atan2(ly - ty, lx - tx) * 180) / Math.PI;
      el('path', { d: 'M-9 -7 L5 0 L-9 7', transform: `translate(${x + U / 2} ${y + U / 2}) rotate(${ang})`, class: `lane-arrow c${c}`, stroke: `var(--c${c})` }, gBoard);
    }
    // Home: four triangles meeting in the middle
    const centre = el('g', { class: 'centre' }, gBoard);
    for (let c = 0; c < 4; c++) {
      const pts = [[6, 6], [6, 9], [7.5, 7.5]].map((p) => P(E.rotPoint(p, c)));
      el('polygon', { points: pts.map((p) => p.join(',')).join(' '), class: `tri c${c}`, fill: `url(#yard${c})`, 'data-c': c }, centre);
    }
    el('circle', { cx: 300, cy: 300, r: 30, fill: 'url(#centre-glow)', class: 'centre-glow' }, centre);
    el('path', { d: 'M286 306 L290 292 L295 300 L300 288 L305 300 L310 292 L314 306 Z', class: 'crown' }, centre);
    el('circle', { cx: 300, cy: 300, r: 6, class: 'centre-dot' }, centre);
  }

  // ---------- Tokens ----------
  function tokenEl(c, i) {
    const key = `${c}:${i}`;
    if (tokEls[key]) return tokEls[key];
    const g = el('g', { class: `tok c${c}`, 'data-c': c, 'data-i': i, tabindex: '-1', role: 'button', 'aria-label': `${E.COLOUR_NAMES[c]} token ${i + 1}` }, gTok);
    el('ellipse', { cx: 0, cy: 9, rx: R * 0.95, ry: R * 0.42, class: 'tok-shadow' }, g);
    const body = el('g', { class: 'tok-body' }, g);
    el('circle', { cx: 0, cy: 0, r: R + 6, class: 'tok-ring', stroke: `var(--c${c})` }, body);
    el('circle', { cx: 0, cy: 2.5, r: R, class: 'tok-base', fill: `color-mix(in srgb, var(--c${c}) 55%, #000)` }, body);
    el('circle', { cx: 0, cy: 0, r: R, class: 'tok-dome', fill: `url(#dome${c})` }, body);
    el('circle', { cx: 0, cy: 0, r: R * 0.52, class: 'tok-top' }, body);
    el('ellipse', { cx: -4, cy: -5.5, rx: 5, ry: 3, class: 'tok-shine' }, body);
    tokEls[key] = g;
    return g;
  }

  const posOf = (c, p, i) => P(E.spot(c, p, i));
  const stackKey = (c, p) => (p === E.BASE ? `b${c}` : p === E.HOME ? `h${c}` : p >= E.LANE ? `l${c}:${p}` : `t${E.absOf(c, p)}`);
  // Small offsets for tokens sharing a square
  const FAN = { 1: [[0, 0]], 2: [[-6, -3], [6, 3]], 3: [[-6, 4], [6, 4], [0, -6]], 4: [[-6, -6], [6, -6], [-6, 6], [6, 6]] };

  /** Where every token stands now (centre, scale), given who shares which square. */
  function layout() {
    const groups = {};
    for (const c of colours) (tokens[c] || []).forEach((p, i) => {
      if (p === E.BASE || p === E.HOME) return;
      (groups[stackKey(c, p)] ||= []).push([c, i]);
    });
    const out = {};
    for (const c of colours) (tokens[c] || []).forEach((p, i) => {
      const [x, y] = posOf(c, p, i);
      if (p === E.BASE) out[`${c}:${i}`] = { x, y, s: 1 };
      else if (p === E.HOME) out[`${c}:${i}`] = { x, y, s: 0.72 };
      else {
        const g = groups[stackKey(c, p)];
        const n = Math.min(4, g.length);
        const k = g.findIndex(([gc, gi]) => gc === c && gi === i);
        const [dx, dy] = n > 1 ? FAN[n][k % 4] : [0, 0];
        out[`${c}:${i}`] = { x: x + dx, y: y + dy, s: n > 1 ? 0.78 : 1 };
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
      g.classList.toggle('home', p === E.HOME);
      put(g, at[`${c}:${i}`]);
    });
    for (const [k, g] of Object.entries(tokEls)) if (!live.has(k)) { g.remove(); delete tokEls[k]; }
    // Draw lower tokens first so overlapping stacks read top to bottom
    [...gTok.children].sort((a, b) => parseFloat(a.style.transform.split(',')[1]) - parseFloat(b.style.transform.split(',')[1])).forEach((n) => gTok.append(n));
  }

  // ---------- Legal moves: pulse, preview, pick ----------
  function clearPreview() {
    gHi.replaceChildren();
    svg.querySelectorAll('.tok.target').forEach((n) => n.classList.remove('target'));
  }
  function preview(m) {
    clearPreview();
    if (!m) return;
    const pts = m.path.map((p) => posOf(m.c, p, m.i));
    const from = m.from === E.BASE ? posOf(m.c, m.from, m.i) : posOf(m.c, m.from, m.i);
    let d = `M${from[0]} ${from[1]}`;
    for (const [x, y] of pts) d += ` L${x} ${y}`;
    el('path', { d, class: 'trail', stroke: `var(--c${m.c})`, 'stroke-linecap': 'round' }, gHi);
    pts.forEach(([x, y], k) => el('circle', { cx: x, cy: y, r: k === pts.length - 1 ? 0 : 3.2, class: 'trail-dot', fill: `var(--c${m.c})` }, gHi));
    const [tx, ty] = pts[pts.length - 1];
    if (!m.home) el('rect', { x: tx - U / 2 + 1.5, y: ty - U / 2 + 1.5, width: U - 3, height: U - 3, rx: 8, class: 'dest', fill: `var(--c${m.c})`, stroke: `var(--c${m.c})` }, gHi);
    const ghost = el('g', { class: 'ghost', transform: `translate(${tx} ${ty})`, 'data-c': m.c, 'data-i': m.i }, gHi);
    el('circle', { r: R + 3, class: 'ghost-ring', stroke: `var(--c${m.c})` }, ghost);
    el('circle', { r: R, class: 'ghost-dome', fill: `url(#dome${m.c})` }, ghost);
    if (m.home) el('path', { d: 'M-6 1 L-2 5 L6 -4', class: 'ghost-tick' }, ghost);
    for (const v of m.cap) tokEls[`${v.c}:${v.i}`]?.classList.add('target');
    if (m.cap.length) {
      const cross = el('g', { class: 'crosshair', transform: `translate(${tx} ${ty})` }, gHi);
      el('circle', { r: R + 9 }, cross);
      el('path', { d: `M0 ${-R - 14}V${-R - 4}M0 ${R + 4}V${R + 14}M${-R - 14} 0H${-R - 4}M${R + 4} 0H${R + 14}` }, cross);
    }
  }

  let legalKey = '';
  function setLegal(list) {
    // The same choices again (another update arrived): keep the preview and a touch player's first tap
    const key = (list || []).map((m) => `${m.c}:${m.i}:${m.to}`).join('|');
    if (key === legalKey && key) return;
    legalKey = key;
    legal = list || [];
    selected = null;
    clearPreview();
    for (const g of Object.values(tokEls)) {
      g.classList.remove('can');
      g.setAttribute('tabindex', '-1');
    }
    // One pulsing token per distinct move; tapping any yard token works when they all come out the same
    for (const m of legal) {
      const g = tokEls[`${m.c}:${m.i}`];
      if (!g) continue;
      g.classList.add('can');
      g.setAttribute('tabindex', '0');
    }
    svg.classList.toggle('picking', legal.length > 0);
  }
  const moveOf = (c, i) => legal.find((m) => m.c === c && m.i === i);

  function pick(c, i) {
    const m = moveOf(c, i);
    if (!m) return;
    legalKey = '';
    clearPreview();
    onPick(c, i);
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
    const ghost = e.target.closest('.ghost');
    if (ghost) return pick(Number(ghost.dataset.c), Number(ghost.dataset.i));
    const t = e.target.closest('.tok.can');
    if (!t) {
      if (selected) { selected = null; clearPreview(); }
      return;
    }
    const c = Number(t.dataset.c), i = Number(t.dataset.i);
    // Touch screens: the first tap shows where it goes, the second moves (a single choice moves straight away)
    if (!hover && legal.length > 1 && selected !== `${c}:${i}`) {
      selected = `${c}:${i}`;
      preview(moveOf(c, i));
      sound('tick', 2);
      return;
    }
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

  // ---------- Animations ----------
  let speed = 1;
  const ms = (n) => (reduced() ? 0 : n * speed);

  /** A token hops square by square along its path. */
  async function hop(c, i, from, path) {
    const g = tokenEl(c, i);
    const body = g.querySelector('.tok-body');
    const shadow = g.querySelector('.tok-shadow');
    g.classList.add('no-ease', 'moving');
    gTok.append(g);   // on top while it moves
    const start = from === E.BASE ? posOf(c, E.BASE, i) : posOf(c, from, i);
    let [px, py] = start;
    const stepMs = from === E.BASE ? ms(340) : ms(150);
    for (let k = 0; k < path.length; k++) {
      const [x, y] = posOf(c, path[k], i);
      if (stepMs) {
        const lift = from === E.BASE ? 26 : 13;
        g.animate([{ transform: `translate(${px}px, ${py}px)` }, { transform: `translate(${x}px, ${y}px)` }], { duration: stepMs, easing: 'cubic-bezier(.45,.05,.55,.95)', fill: 'forwards' });
        body.animate([
          { transform: 'translateY(0) scale(1, 1)' },
          { transform: `translateY(${-lift}px) scale(1.08, 1.08)`, offset: 0.5 },
          { transform: 'translateY(0) scale(1.12, 0.86)', offset: 0.88 },
          { transform: 'translateY(0) scale(1, 1)' },
        ], { duration: stepMs, easing: 'ease-out' });
        shadow.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0.45, transform: 'scale(.7)', offset: 0.5 }, { opacity: 1, transform: 'scale(1)' }], { duration: stepMs });
        sound('hop', k);
        await wait(stepMs);
      }
      [px, py] = [x, y];
    }
    g.getAnimations().forEach((a) => a.cancel());
    put(g, { x: px, y: py, s: 1 });
    g.classList.remove('moving');
    tokens[c][i] = path[path.length - 1];
    void g.getBoundingClientRect();
    g.classList.remove('no-ease');
  }

  /** Rival tokens hit at (x, y): a burst, then each flies back to its yard. */
  async function knock(victims, x, y) {
    if (!victims.length) return;
    sound('capture');
    burst(x, y, victims.map((v) => `var(--c${v.c})`), 18);
    shake();
    const flights = victims.map(async (v, k) => {
      const g = tokenEl(v.c, v.i);
      const [hx, hy] = posOf(v.c, E.BASE, v.i);
      const [sx, sy] = [x, y];
      g.classList.add('no-ease', 'moving');
      gTok.append(g);
      const midX = (sx + hx) / 2, midY = Math.min(sy, hy) - 120 - k * 20;
      const d = ms(720);
      if (d) {
        g.animate([
          { transform: `translate(${sx}px, ${sy}px) scale(1) rotate(0deg)` },
          { transform: `translate(${midX}px, ${midY}px) scale(1.5) rotate(320deg)`, offset: 0.45 },
          { transform: `translate(${hx}px, ${hy}px) scale(1) rotate(720deg)` },
        ], { duration: d, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' });
        await wait(d);
      }
      g.getAnimations().forEach((a) => a.cancel());
      tokens[v.c][v.i] = E.BASE;
      put(g, { x: hx, y: hy, s: 1 });
      g.classList.remove('moving');
      ring(hx, hy, `var(--c${v.c})`);
      void g.getBoundingClientRect();
      g.classList.remove('no-ease');
    });
    await Promise.all(flights);
  }

  function shake() {
    if (reduced()) return;
    svg.classList.remove('shake');
    void svg.getBoundingClientRect();
    svg.classList.add('shake');
  }
  function ring(x, y, colour) {
    if (reduced()) return;
    const r = el('circle', { cx: x, cy: y, r: R, class: 'fx-ring', stroke: colour }, gFx);
    r.animate([{ r: R, opacity: 0.9, strokeWidth: 5 }, { r: R * 3, opacity: 0, strokeWidth: 1 }], { duration: 600, easing: 'ease-out' }).onfinish = () => r.remove();
  }
  /** Little pieces flying out from a point (captures, home). */
  function burst(x, y, palette, count = 22) {
    if (reduced()) return;
    for (let k = 0; k < count; k++) {
      const a = (Math.PI * 2 * k) / count + Math.random() * 0.4;
      const dist = 30 + Math.random() * 55;
      const p = el(Math.random() < 0.5 ? 'circle' : 'rect', {}, gFx);
      const size = 3 + Math.random() * 4;
      if (p.tagName === 'circle') { p.setAttribute('r', size / 1.6); p.setAttribute('cx', 0); p.setAttribute('cy', 0); } else { p.setAttribute('width', size); p.setAttribute('height', size * 0.6); p.setAttribute('x', -size / 2); p.setAttribute('y', -size / 4); p.setAttribute('rx', 1); }
      p.setAttribute('fill', palette[k % palette.length]);
      const tx = x + Math.cos(a) * dist, ty = y + Math.sin(a) * dist + 18;
      p.animate([
        { transform: `translate(${x}px, ${y}px) rotate(0deg)`, opacity: 1 },
        { transform: `translate(${tx}px, ${ty}px) rotate(${Math.random() * 540}deg)`, opacity: 0 },
      ], { duration: 650 + Math.random() * 350, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => p.remove();
    }
    ring(x, y, palette[0]);
  }

  /** A word floating up over a colour's yard ("No move", "Three 6s!", "+1 roll"). */
  function label(c, text, cls = '') {
    const [x, y] = P(E.rotPoint([3, 3], c));
    const g = el('g', { class: `fx-label ${cls}`, transform: `translate(${x} ${y})` }, gFx);
    const w = 22 + text.length * 10.5;
    el('rect', { x: -w / 2, y: -19, width: w, height: 38, rx: 19 }, g);
    el('text', { x: 0, y: 7, 'text-anchor': 'middle' }, g).textContent = text;
    g.animate([
      { transform: `translate(${x}px, ${y + 14}px) scale(.7)`, opacity: 0 },
      { transform: `translate(${x}px, ${y}px) scale(1.05)`, opacity: 1, offset: 0.18 },
      { transform: `translate(${x}px, ${y - 4}px) scale(1)`, opacity: 1, offset: 0.75 },
      { transform: `translate(${x}px, ${y - 22}px) scale(.95)`, opacity: 0 },
    ], { duration: reduced() ? 900 : 1300, easing: 'ease-out', fill: 'forwards' }).onfinish = () => g.remove();
  }

  /** A move from the room's log: hop, knock rivals back, burst at home. */
  async function playMove(e) {
    await hop(e.c, e.i, e.from, e.path);
    const [x, y] = posOf(e.c, e.path[e.path.length - 1], e.i);
    if (e.cap.length) await knock(e.cap, x, y);
    if (e.home) {
      sound('home');
      burst(300, 300, [`var(--c${e.c})`, '#fff', `var(--c${e.c})`], 30);
      svg.querySelector(`.tri.c${e.c}`)?.classList.add('lit');
      setTimeout(() => svg.querySelector(`.tri.c${e.c}`)?.classList.remove('lit'), 900);
    }
    place(true);
  }

  function setTurn(c) {
    svg.querySelectorAll('.yard').forEach((y) => y.classList.toggle('active', Number(y.dataset.c) === c));
    svg.querySelectorAll('.tri').forEach((y) => y.classList.toggle('active', Number(y.dataset.c) === c));
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
      drawBoard();
      place(false);
      svg.classList.toggle('few', colours.length < 4);
      svg.querySelectorAll('.yard').forEach((y) => y.classList.toggle('empty', !colours.includes(Number(y.dataset.c))));
    },
    /** Show these positions now (after a refresh, or when the animations have caught up). */
    snap(t) {
      tokens = JSON.parse(JSON.stringify(t));
      place(true);
    },
    get tokens() { return tokens; },
    get rotation() { return rot; },
    /** Which corner (0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left) a colour's yard is drawn in. */
    corner: (c) => (c + rot) % 4,
    setLegal,
    setTurn,
    playMove,
    label,
    burst,
    setSpeed(s) { speed = s; },
    focusFirst() { svg.querySelector('.tok.can')?.focus(); },
  };
}
