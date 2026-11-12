// Drawing and input for each test, in a technical-drawing style.
// mount() shows the puzzle and collects one guess. reveal() redraws it as a measured
// drawing: grid, rulers and dimension lines, with everyone's guesses on it.
import { BOX, trackY, trackPath, error } from './rounds.js';

const NS = 'http://www.w3.org/2000/svg';
const rad = (deg) => (deg * Math.PI) / 180;
const pct = (x) => `${Math.round(x * 100)}%`;

function el(tag, attrs, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

// ---------- The drawing sheet ----------

let sheets = 0;

// One board: paper, crop marks and shared defs. Content drawn into b.inside is clipped
// to the rounded paper; b.over sits on top, unclipped. Ids are suffixed per board.
function board(stage, { w = BOX.w, h = BOX.h, cls = '' } = {}) {
  const id = `s${++sheets}`;
  const svg = el('svg', { viewBox: `-14 -14 ${w + 28} ${h + 28}`, class: `board ${cls}`, role: 'img' });
  const defs = el('defs', {}, svg);
  const paper = { x: 0, y: 0, width: w, height: h, rx: 10 };
  el('rect', paper, el('clipPath', { id: `${id}-clip` }, defs));

  const g10 = el('pattern', { id: `${id}-g10`, width: 10, height: 10, patternUnits: 'userSpaceOnUse' }, defs);
  el('path', { d: 'M10 0H0V10', class: 'grid-minor' }, g10);
  const g50 = el('pattern', { id: `${id}-g50`, width: 50, height: 50, patternUnits: 'userSpaceOnUse' }, defs);
  el('rect', { width: 50, height: 50, fill: `url(#${id}-g10)` }, g50);
  el('path', { d: 'M50 0H0V50', class: 'grid-major' }, g50);

  const hatch = el('pattern', { id: `${id}-hatch`, width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  el('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'hatch' }, hatch);

  const fogEdge = el('linearGradient', { id: `${id}-fogedge`, x1: 0, x2: 1, y1: 0, y2: 0 }, defs);
  el('stop', { offset: '0', class: 'fog-0' }, fogEdge);
  el('stop', { offset: '1', class: 'fog-1' }, fogEdge);

  el('rect', { ...paper, class: 'paper' }, svg);
  const inside = el('g', { 'clip-path': `url(#${id}-clip)` }, svg);
  el('rect', { ...paper, class: 'paper-edge' }, svg);
  // Crop marks at the corners, as on a printed drawing sheet
  const crop = el('g', { class: 'crop' }, svg);
  for (const [x, y, dx, dy] of [[0, 0, -1, -1], [w, 0, 1, -1], [0, h, -1, 1], [w, h, 1, 1]]) {
    el('path', { d: `M${x + dx * 4} ${y}h${dx * 8}M${x} ${y + dy * 4}v${dy * 8}` }, crop);
  }
  stage.append(svg);
  return { svg, inside, id, w, h, over: el('g', {}, svg) };
}

// The measurement grid only appears on the reveal, so it can't be used to measure.
function grid(b) {
  el('rect', { x: 0, y: 0, width: b.w, height: b.h, fill: `url(#${b.id}-g50)`, class: 'grid' }, b.inside);
}

// Pointer position in board units, whatever size the board is drawn at.
function toBoard(svg, e) {
  return new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
}

// Calls onPoint while the pointer is pressed (or on a tap); arrow keys call onKey(step).
function drag(svg, onPoint, onKey) {
  let down = false;
  svg.addEventListener('pointerdown', (e) => {
    down = true;
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    onPoint(toBoard(svg, e));
  });
  svg.addEventListener('pointermove', (e) => { if (down) onPoint(toBoard(svg, e)); });
  svg.addEventListener('pointerup', () => { down = false; });
  svg.addEventListener('pointercancel', () => { down = false; });
  svg.tabIndex = 0;
  svg.addEventListener('keydown', (e) => {
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (step) { e.preventDefault(); onKey(e.shiftKey ? step * 10 : step); }
  });
}

// ---------- Annotation helpers ----------

// Text with a paper-coloured halo, so labels stay readable over lines and grid.
function label(parent, x, y, text, { cls = '', anchor = 'middle', color = null } = {}) {
  const t = el('text', { x, y, class: `lbl ${cls}${color !== null ? ` pc${color}` : ''}`, 'text-anchor': anchor }, parent);
  t.textContent = text;
  return t;
}

function arrowHead(parent, x, y, angle) {
  const a = 9, s = 3.6;
  const bx = x - Math.cos(angle) * a, by = y - Math.sin(angle) * a;
  const nx = -Math.sin(angle) * s, ny = Math.cos(angle) * s;
  el('path', { d: `M${x} ${y}L${bx + nx} ${by + ny}L${bx - nx} ${by - ny}Z`, class: 'head' }, parent);
}

// Dimension line between two points: arrowheads at both ends, label along the line.
function dimension(parent, x1, y1, x2, y2, text) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1) return;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const g = el('g', { class: 'dim reveal-late' }, parent);
  el('line', { x1, y1, x2, y2 }, g);
  if (len > 22) {
    arrowHead(g, x2, y2, ang);
    arrowHead(g, x1, y1, ang + Math.PI);
  }
  // Keep the text upright and on the outer side of the line
  let deg = (ang * 180) / Math.PI;
  const flip = deg > 90 || deg < -90;
  if (flip) deg += 180;
  const off = flip ? 9 : -9;
  const mx = (x1 + x2) / 2 - Math.sin(ang) * off, my = (y1 + y2) / 2 + Math.cos(ang) * off;
  const t = label(g, mx, my, text, { cls: 'dim-lbl' });
  t.setAttribute('dominant-baseline', 'middle');
  t.setAttribute('transform', `rotate(${deg} ${mx} ${my})`);
}

// Spreads label positions along one axis so they don't overlap, keeping their order.
function spread(values, min, max, gap) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = order.map(([v]) => Math.min(max, Math.max(min, v)));
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap);
  const over = out.length ? out[out.length - 1] - max : 0;
  if (over > 0) for (let i = 0; i < out.length; i++) out[i] -= over;
  for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - gap);
  const res = new Array(values.length);
  order.forEach(([, i], k) => { res[i] = out[k]; });
  return res;
}

const tag = (e) => (e.me ? 'You' : e.name);
const guessedOnly = (entries) => entries.filter((e) => e.guess !== null && e.guess !== undefined);

// A player's guess, in their colour.
function pin(parent, x, y, color, r = 5) {
  const g = el('g', { class: `pin pc${color}` }, parent);
  el('circle', { cx: x, cy: y, r: r + 2.5, class: 'pin-halo' }, g);
  el('circle', { cx: x, cy: y, r, class: 'pin-dot' }, g);
  return g;
}

// The real answer: a green ring with crosshairs.
function answerMark(parent, x, y) {
  const g = el('g', { class: 'answer' }, parent);
  el('circle', { cx: x, cy: y, r: 9, class: 'answer-ring' }, g);
  el('path', { d: `M${x - 15} ${y}h7M${x + 8} ${y}h7M${x} ${y - 15}v7M${x} ${y + 8}v7`, class: 'answer-cross' }, g);
  el('circle', { cx: x, cy: y, r: 2.4, class: 'answer-dot' }, g);
  return g;
}

function niceStep(range) {
  const raw = range / 6;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw);
}

const ANGLE_LEN = { easy: 120, normal: 120, hard: 125 };
// On hard the dark line is shorter, so you can't just compare line ends.
const baseLen = (pz) => (pz.difficulty === 'hard' ? 64 : ANGLE_LEN[pz.difficulty]);

// ---------- Tests ----------
// entries for reveal(): [{ name, color, guess, me }], color is the player's colour index.

export const TESTS = {
  count: {
    name: 'Count',
    how: 'Dots flash for a moment. Guess how many there were.',
    ask: (pz) => `How many dots? You get ${(pz.showMs / 1000).toFixed(1)} seconds.`,
    mount(stage, pz, { ready, submit, controls }) {
      const b = board(stage);
      const dots = el('g', {}, b.inside);
      for (const d of pz.dots) el('circle', { cx: d.x, cy: d.y, r: d.r, class: 'dot' }, dots);
      // Exposure bar along the top edge, running out with the time
      const bar = el('rect', { x: 0, y: 0, width: b.w, height: 4, class: 'exposure' }, b.inside);
      bar.style.animationDuration = `${pz.showMs}ms`;
      const form = document.createElement('form');
      form.className = 'count-form';
      form.innerHTML = '<label class="sr-only" for="count-guess">Your guess</label><input id="count-guess" class="count-input" type="number" inputmode="numeric" min="0" max="999" placeholder="…" disabled autocomplete="off"><span class="count-unit">dots</span>';
      (controls || stage).append(form);
      const input = form.querySelector('input');
      const timer = setTimeout(() => {
        dots.remove();
        bar.remove();
        const q = el('g', { class: 'hidden-mark' }, b.inside);
        el('circle', { cx: b.w / 2, cy: b.h / 2, r: 46 }, q);
        label(q, b.w / 2, b.h / 2 + 2, '?', { cls: 'q' }).setAttribute('dominant-baseline', 'middle');
        input.disabled = false;
        input.placeholder = '0';
        input.focus();
      }, pz.showMs);
      const value = () => (/^\d{1,3}$/.test(input.value) ? Number(input.value) : null);
      input.addEventListener('input', () => ready(value() !== null));
      form.addEventListener('submit', (e) => { e.preventDefault(); if (value() !== null) submit(); });
      return { guess: value, destroy: () => clearTimeout(timer) };
    },
    reveal(stage, pz, entries) {
      const b = board(stage);
      grid(b);
      for (const d of pz.dots) el('circle', { cx: d.x, cy: d.y, r: d.r, class: 'dot dimmed' }, b.inside);
      // Number line in a band across the bottom of the drawing, with the answer and every guess
      const H = 92, top0 = b.h - H, base = top0 + 40;
      el('rect', { x: 0, y: top0, width: b.w, height: H, class: 'band-strip' }, b.inside);
      el('line', { x1: 0, y1: top0, x2: b.w, y2: top0, class: 'band-edge' }, b.inside);
      const guessed = guessedOnly(entries);
      const top = Math.max(pz.answer, ...guessed.map((e) => e.guess)) * 1.15 + 5;
      const step = niceStep(top);
      const max = Math.ceil(top / step) * step;
      const x = (v) => 24 + (v / max) * (b.w - 48);
      const ruler = el('g', { class: 'ruler reveal-late' }, b.inside);
      el('line', { x1: x(0), y1: base, x2: x(max), y2: base, class: 'rule' }, ruler);
      for (let i = 0; i <= Math.round((max / step) * 2); i++) {
        const v = (i * step) / 2;
        el('line', { x1: x(v), y1: base, x2: x(v), y2: base - (i % 2 ? 4.5 : 8), class: 'tick' }, ruler);
        // The answer's own label sits above the line, so skip tick labels right next to it
        if (i % 2 === 0 && Math.abs(x(v) - x(pz.answer)) > 16) label(ruler, x(v), base - 13, String(Math.round(v)), { cls: 'tick-lbl' });
      }
      const ax = x(pz.answer);
      el('path', { d: `M${ax} ${base}l-6 -11h12z`, class: 'answer-tri' }, b.over);
      label(b.over, ax, base - 15, `${pz.answer}`, { cls: 'answer-lbl' });
      const lx = spread(guessed.map((e) => x(e.guess)), 30, b.w - 30, 54);
      guessed.forEach((e, i) => {
        const gx = x(e.guess);
        el('path', { d: `M${gx} ${base + 4}V${base + 16}L${lx[i]} ${base + 25}`, class: `leader pc${e.color}` }, b.inside);
        pin(b.inside, gx, base, e.color, 4.5);
        label(b.inside, lx[i], base + 38, `${tag(e)} ${e.guess}`, { color: e.color, cls: 'who' });
      });
    },
  },

  track: {
    name: 'Track',
    how: 'A ball flies right, bouncing off the top and bottom, and vanishes into the hatched zone. Mark where it hits the right wall.',
    ask: () => 'Where will the ball hit the right wall?',
    mount(stage, pz, { ready, hint, color }) {
      const b = board(stage);
      el('rect', { x: pz.visibleX, y: 0, width: b.w - pz.visibleX, height: b.h, fill: `url(#${b.id}-hatch)`, class: 'fog' }, b.inside);
      el('rect', { x: pz.visibleX, y: 0, width: 26, height: b.h, fill: `url(#${b.id}-fogedge)` }, b.inside);
      el('line', { x1: pz.visibleX, y1: 0, x2: pz.visibleX, y2: b.h, class: 'fog-line' }, b.inside);
      rail(b);
      // Launcher on the left wall
      el('path', { d: `M0 ${pz.y0 - 11}h5v22h-5`, class: 'launcher' }, b.inside);
      const trail = [0.28, 0.16, 0.08].map((o) => el('circle', { r: pz.ballR, cx: pz.x0, cy: pz.y0, class: 'trail', opacity: o }, b.inside));
      const ball = el('circle', { cx: pz.x0, cy: pz.y0, r: pz.ballR, class: 'dot' }, b.inside);
      const mark = reticle(b.over, color);
      mark.setAttribute('visibility', 'hidden');
      let y = null, armed = false, raf = 0;
      const begin = performance.now() + 700;
      const frame = (now) => {
        const x = pz.x0 + (pz.speed * Math.max(0, now - begin)) / 1000;
        if (x >= pz.visibleX) {
          ball.remove();
          trail.forEach((t) => t.remove());
          armed = true;
          b.svg.classList.add('aim');
          hint('Tap the right wall where it lands, then lock in.');
          return;
        }
        ball.setAttribute('cx', x);
        ball.setAttribute('cy', trackY(pz, x));
        trail.forEach((t, i) => {
          const tx = Math.max(pz.x0, x - (i + 1) * 7);
          t.setAttribute('cx', tx);
          t.setAttribute('cy', trackY(pz, tx));
        });
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      const place = (v) => {
        if (!armed) return;
        y = Math.min(BOX.h - pz.ballR, Math.max(pz.ballR, v));
        mark.setAttribute('transform', `translate(${pz.wallX} ${y})`);
        mark.setAttribute('visibility', 'visible');
        ready(true);
      };
      drag(b.svg, (p) => place(p.y), (step) => place((y ?? BOX.h / 2) - step));
      return { guess: () => (y === null ? null : Math.round(y * 10) / 10), destroy: () => cancelAnimationFrame(raf) };
    },
    reveal(stage, pz, entries) {
      const b = board(stage);
      grid(b);
      rail(b);
      el('line', { x1: pz.visibleX, y1: 0, x2: pz.visibleX, y2: b.h, class: 'fog-line' }, b.inside);
      const path = trackPath(pz);
      el('polyline', { points: path.map((p) => p.join(',')).join(' '), class: 'flight draw', pathLength: 1 }, b.inside);
      path.slice(1, -1).forEach(([x, y]) => el('circle', { cx: x, cy: y, r: 3, class: 'bounce reveal-late' }, b.inside));
      el('circle', { cx: pz.x0, cy: pz.y0, r: pz.ballR, class: 'dot dimmed' }, b.inside);
      const guessed = guessedOnly(entries);
      guessed.forEach((e) => reticle(b.over, e.color).setAttribute('transform', `translate(${pz.wallX} ${e.guess})`));
      answerMark(b.over, pz.wallX, pz.answer);
      if (entries.length === 1 && guessed.length) {
        const g = guessed[0].guess;
        if (Math.abs(g - pz.answer) > 6) dimension(b.over, pz.wallX - 52, g, pz.wallX - 52, pz.answer, pct(error(pz, g)));
      } else {
        const ly = spread(guessed.map((e) => e.guess), 12, b.h - 12, 16);
        guessed.forEach((e, i) => {
          el('path', { d: `M${pz.wallX - 32} ${e.guess}L${pz.wallX - 46} ${ly[i]}H${pz.wallX - 52}`, class: `leader pc${e.color}` }, b.over);
          label(b.over, pz.wallX - 56, ly[i] + 4, tag(e), { anchor: 'end', color: e.color, cls: 'who' });
        });
      }
    },
  },

  angle: {
    name: 'Angle',
    how: 'Drag the coloured arm until the angle between it and the grey arm matches the target. Either side works.',
    ask: (pz) => `Make a ${pz.target}° angle`,
    mount(stage, pz, { ready, color }) {
      const b = board(stage);
      const len = ANGLE_LEN[pz.difficulty];
      const sweep = el('path', { class: `sweep pc${color}` }, b.inside);
      arm(b.inside, pz.pivot, pz.baseline, baseLen(pz), 'base');
      let a = pz.start;
      const mine = arm(b.inside, pz.pivot, pz.baseline + a, len, `pc${color}`, true);
      rivet(b.inside, pz.pivot);
      const draw = () => {
        const signed = a > 180 ? a - 360 : a;
        mine.turn(pz.baseline + a);
        sweep.setAttribute('d', arcPath(pz.pivot, pz.baseline, signed, 30));
      };
      draw();
      b.svg.classList.add('aim');
      drag(b.svg, (p) => {
        if (Math.hypot(p.x - pz.pivot.x, p.y - pz.pivot.y) < 8) return;
        const world = (Math.atan2(pz.pivot.y - p.y, p.x - pz.pivot.x) * 180) / Math.PI;
        a = (((world - pz.baseline) % 360) + 360) % 360;
        draw();
        ready(true);
      }, (step) => { a = (((a + step) % 360) + 360) % 360; draw(); ready(true); });
      return { guess: () => Math.round((a > 180 ? a - 360 : a) * 10) / 10, destroy() {} };
    },
    reveal(stage, pz, entries) {
      const b = board(stage);
      grid(b);
      const len = ANGLE_LEN[pz.difficulty];
      const guessed = guessedOnly(entries);
      // Show the answer on each side somebody used
      const sides = [...new Set(guessed.map((e) => (e.guess < 0 ? -1 : 1)))];
      if (!sides.length) sides.push(1);
      if (entries.length === 1 && guessed.length) {
        el('path', { d: arcPath(pz.pivot, pz.baseline, guessed[0].guess, 30), class: `sweep pc${guessed[0].color}` }, b.inside);
      }
      for (const side of sides) protractor(b.inside, pz, side);
      arm(b.inside, pz.pivot, pz.baseline, baseLen(pz), 'base');
      for (const side of sides) ray(b.inside, pz.pivot, pz.baseline + side * pz.target, len + 16, 'answer-arm');
      guessed.forEach((e) => arm(b.inside, pz.pivot, pz.baseline + e.guess, len, `thin pc${e.color}`, true));
      rivet(b.inside, pz.pivot);
      guessed.forEach((e) => {
        const w = rad(pz.baseline + e.guess);
        const lx = pz.pivot.x + Math.cos(w) * (len + 22), ly = pz.pivot.y - Math.sin(w) * (len + 22);
        const anchor = Math.cos(w) > 0.3 ? 'start' : Math.cos(w) < -0.3 ? 'end' : 'middle';
        label(b.over, lx, ly + 4, `${tag(e)} ${Math.round(Math.abs(e.guess))}°`, { color: e.color, cls: 'who', anchor });
      });
    },
  },

  split: {
    name: 'Split',
    how: 'Slide the marker to the point that sits the given fraction of the way along the bar, starting from the round end.',
    ask: (pz) => `Mark ${pz.label} of the way along`,
    mount(stage, pz, { ready, color }) {
      const b = board(stage);
      const s = slider(b.inside, pz);
      const fill = el('line', { x1: 0, y1: 0, x2: 0, y2: 0, class: `slide-fill pc${color}` }, s.g);
      s.caps();
      const thumb = el('g', { class: `thumb pc${color}`, visibility: 'hidden' }, s.g);
      el('line', { x1: 0, y1: -13, x2: 0, y2: 13, class: 'thumb-line' }, thumb);
      el('circle', { cx: 0, cy: -13, r: 4, class: 'thumb-knob' }, thumb);
      let t = null;
      const ux = pz.b.x - pz.a.x, uy = pz.b.y - pz.a.y, uu = ux * ux + uy * uy;
      const place = (v) => {
        t = Math.min(1, Math.max(0, v));
        fill.setAttribute('x2', t * s.len);
        thumb.setAttribute('transform', `translate(${t * s.len} 0)`);
        thumb.setAttribute('visibility', 'visible');
        ready(true);
      };
      b.svg.classList.add('aim');
      drag(b.svg, (p) => place(((p.x - pz.a.x) * ux + (p.y - pz.a.y) * uy) / uu), (step) => place((t ?? 0.5) + step / 200));
      return { guess: () => (t === null ? null : Math.round(t * 1000) / 1000), destroy() {} };
    },
    reveal(stage, pz, entries) {
      const b = board(stage);
      grid(b);
      const s = slider(b.inside, pz);
      const guessed = guessedOnly(entries);
      if (entries.length === 1 && guessed.length) {
        el('line', { x1: 0, y1: 0, x2: guessed[0].guess * s.len, y2: 0, class: `slide-fill soft pc${guessed[0].color}` }, s.g);
      }
      s.caps();
      // Ruler scale above the bar, in the bar's own frame
      const scale = el('g', { class: 'ruler reveal-late' }, s.g);
      for (let i = 0; i <= 20; i++) {
        const x = (i / 20) * s.len;
        const long = i % 5 === 0 ? 12 : i % 2 === 0 ? 7 : 4.5;
        el('line', { x1: x, y1: -12, x2: x, y2: -12 - long, class: 'tick' }, scale);
        if (i % 5 === 0 && i > 0 && i < 20) label(scale, x, -30, `${i * 5}%`, { cls: 'tick-lbl' });
      }
      const ang = Math.atan2(pz.b.y - pz.a.y, pz.b.x - pz.a.x);
      const nx = Math.sin(ang), ny = -Math.cos(ang);   // unit normal pointing up from the bar
      const at = (t) => [pz.a.x + (pz.b.x - pz.a.x) * t, pz.a.y + (pz.b.y - pz.a.y) * t];
      const [tx, ty] = at(pz.answer);
      el('line', { x1: tx + nx * 8, y1: ty + ny * 8, x2: tx + nx * 56, y2: ty + ny * 56, class: 'ext reveal-late' }, b.over);
      el('line', { x1: pz.a.x + nx * 12, y1: pz.a.y + ny * 12, x2: pz.a.x + nx * 56, y2: pz.a.y + ny * 56, class: 'ext reveal-late' }, b.over);
      dimension(b.over, pz.a.x + nx * 50, pz.a.y + ny * 50, tx + nx * 50, ty + ny * 50,
        pz.percent ? pz.label : `${pz.label} = ${pct(pz.answer)}`);
      answerMark(b.over, tx, ty);
      const lt = spread(guessed.map((e) => e.guess), -0.04, 1.04, 58 / s.len);
      guessed.forEach((e, i) => {
        const [gx, gy] = at(e.guess);
        const [lx, ly] = at(lt[i]);
        el('path', { d: `M${gx - nx * 12} ${gy - ny * 12}L${lx - nx * 30} ${ly - ny * 30}`, class: `leader pc${e.color}` }, b.over);
        pin(b.over, gx, gy, e.color, 4.5);
        label(b.over, lx - nx * 41, ly - ny * 41 + 4, `${tag(e)} ${pct(e.guess)}`, { color: e.color, cls: 'who' });
      });
    },
  },

  time: {
    name: 'Timing',
    how: 'Press Start, count in your head, and press Stop when you think the target time has passed. No clock is shown.',
    ask: (pz) => `Stop the clock at exactly ${secs(pz.target)}`,
    selfLock: true,   // pressing Stop locks the guess in; there's no separate Lock in
    mount(stage, pz, { ready, submit, controls, color }) {
      const b = board(stage);
      label(b.inside, b.w / 2, 92, 'Stop at', { cls: 'time-k' });
      label(b.inside, b.w / 2, 158, secs(pz.target), { cls: 'time-target' });
      const status = label(b.inside, b.w / 2, 232, 'Press Start, then count in your head', { cls: 'time-status' });
      // Nothing on screen moves while the clock runs: any animation would give the rhythm away
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `time-btn pc${color}`;
      btn.textContent = 'Start';
      (controls || stage).append(btn);
      let started = null, done = false;
      // Times come from the moment the browser registered the press (event.timeStamp),
      // so a busy page can't add delay to anyone's guess.
      const press = (ts) => {
        if (done) return;
        if (started === null) {
          started = ts;
          btn.textContent = 'Stop';
          btn.classList.add('running');
          b.svg.classList.add('timing');
          status.textContent = 'Counting… press Stop when you think it’s time';
          return;
        }
        if (ts - started < 120) return;   // ignore an accidental double tap
        done = true;
        guess = Math.round((ts - started) / 10) / 100;
        btn.disabled = true;
        btn.textContent = 'Stopped';
        ready(true);
        submit();
      };
      let guess = null;
      const onBtn = (e) => { e.preventDefault(); press(e.timeStamp); };
      const onBoard = (e) => { e.preventDefault(); press(e.timeStamp); };
      const onKey = (e) => {
        if (e.key !== ' ' || e.repeat || e.target.tagName === 'INPUT') return;
        e.preventDefault();
        press(e.timeStamp);
      };
      btn.addEventListener('pointerdown', onBtn);
      btn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); press(e.timeStamp); } });
      b.svg.addEventListener('pointerdown', onBoard);
      document.addEventListener('keydown', onKey);
      btn.focus({ preventScroll: true });
      return {
        guess: () => guess,
        destroy() { document.removeEventListener('keydown', onKey); },
      };
    },
    reveal(stage, pz, entries) {
      const b = board(stage);
      grid(b);
      const guessed = guessedOnly(entries);
      const top = Math.max(pz.answer, ...guessed.map((e) => e.guess)) * 1.15 + 0.3;
      const step = niceStep(top);
      const max = Math.ceil(top / step) * step;
      const x = (v) => 30 + (v / max) * (b.w - 60);
      const base = 178;
      label(b.inside, b.w / 2, 52, `Target ${secs(pz.target)}`, { cls: 'answer-lbl big' });
      const ruler = el('g', { class: 'ruler reveal-late' }, b.inside);
      el('line', { x1: x(0), y1: base, x2: x(max), y2: base, class: 'rule' }, ruler);
      for (let i = 0; i <= Math.round((max / step) * 2); i++) {
        const v = (i * step) / 2;
        el('line', { x1: x(v), y1: base, x2: x(v), y2: base - (i % 2 ? 4.5 : 8), class: 'tick' }, ruler);
        if (i % 2 === 0 && Math.abs(x(v) - x(pz.answer)) > 18) label(ruler, x(v), base - 13, `${+v.toFixed(2)} s`, { cls: 'tick-lbl' });
      }
      const ax = x(pz.answer);
      el('line', { x1: ax, y1: base - 2, x2: ax, y2: 96, class: 'ext answer-ext reveal-late' }, b.over);
      el('path', { d: `M${ax} ${base}l-6 -11h12z`, class: 'answer-tri' }, b.over);
      if (entries.length === 1 && guessed.length) {
        // Just you: a dimension line between your stop and the target, early or late
        const g = guessed[0].guess, d = g - pz.answer;
        if (Math.abs(x(g) - ax) > 14) dimension(b.over, ax, 120, x(g), 120, `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(2)} s ${d > 0 ? 'late' : 'early'}`);
      }
      const lx = spread(guessed.map((e) => x(e.guess)), 40, b.w - 40, 66);
      guessed.forEach((e, i) => {
        const gx = x(e.guess);
        el('path', { d: `M${gx} ${base + 5}V${base + 26}L${lx[i]} ${base + 40}`, class: `leader pc${e.color}` }, b.inside);
        pin(b.inside, gx, base, e.color, 5);
        label(b.inside, lx[i], base + 55, `${tag(e)} ${e.guess.toFixed(2)} s`, { color: e.color, cls: 'who' });
      });
    },
  },
};

const secs = (t) => (Number.isInteger(t) ? `${t} s` : `${t.toFixed(1)} s`);

// ---------- Pieces ----------

function rail(b) {
  const g = el('g', { class: 'rail' }, b.inside);
  el('rect', { x: b.w - 7, y: 0, width: 7, height: b.h, class: 'rail-bed' }, g);
  el('line', { x1: b.w - 7, y1: 0, x2: b.w - 7, y2: b.h, class: 'rail-edge' }, g);
}

function reticle(parent, color) {
  const g = el('g', { class: `reticle pc${color}` }, parent);
  el('circle', { r: 7, class: 'ret-ring' }, g);
  el('path', { d: 'M-28 0H-11', class: 'ret-line' }, g);
  el('circle', { r: 1.8, class: 'ret-dot' }, g);
  return g;
}

function ray(parent, pivot, worldDeg, len, cls) {
  const x = pivot.x + Math.cos(rad(worldDeg)) * len, y = pivot.y - Math.sin(rad(worldDeg)) * len;
  return el('line', { x1: pivot.x, y1: pivot.y, x2: x, y2: y, class: cls }, parent);
}

const armAt = (p, worldDeg) => `translate(${p.x} ${p.y}) rotate(${-worldDeg})`;

// An arm: one clean line from the pivot, with a small ring handle on the one you drag.
function arm(parent, p, worldDeg, len, cls, grip = false) {
  const thin = cls.includes('thin');
  const g = el('g', { class: `arm ${cls}` }, parent);
  el('line', { x1: 0, y1: 0, x2: len, y2: 0, class: 'arm-line' }, g);
  if (grip) el('circle', { cx: len, cy: 0, r: thin ? 3.2 : 7.5, class: thin ? 'arm-end' : 'arm-handle' }, g);
  g.turn = (deg) => g.setAttribute('transform', armAt(p, deg));
  g.turn(worldDeg);
  return g;
}

function rivet(parent, p) {
  el('circle', { cx: p.x, cy: p.y, r: 3.4, class: 'pivot-dot' }, parent);
}

function arcPath(p, base, deg, r) {
  if (Math.abs(deg) < 0.5) return '';
  const a = rad(base), b = rad(base + deg);
  return `M${p.x + Math.cos(a) * r} ${p.y - Math.sin(a) * r}A${r} ${r} 0 0 ${deg > 0 ? 0 : 1} ${p.x + Math.cos(b) * r} ${p.y - Math.sin(b) * r}`;
}

// Protractor band from the dark arm round to the answer, with a tick every 5°.
function protractor(parent, pz, side) {
  const r0 = 46, r1 = 60;
  const g = el('g', { class: 'protractor reveal-late' }, parent);
  const from = pz.baseline, to = pz.baseline + side * pz.target;
  const p = (deg, r) => [pz.pivot.x + Math.cos(rad(deg)) * r, pz.pivot.y - Math.sin(rad(deg)) * r];
  const [ax, ay] = p(from, r1), [bx, by] = p(to, r1);
  const [cx, cy] = p(to, r0), [dx, dy] = p(from, r0);
  const sweep = side > 0 ? 0 : 1;
  el('path', { d: `M${ax} ${ay}A${r1} ${r1} 0 0 ${sweep} ${bx} ${by}L${cx} ${cy}A${r0} ${r0} 0 0 ${1 - sweep} ${dx} ${dy}Z`, class: 'band' }, g);
  for (let d = 0; d <= pz.target; d += 5) {
    const deg = from + side * d;
    const [x1, y1] = p(deg, r1), [x2, y2] = p(deg, r1 - (d % 15 === 0 ? 9 : 4.5));
    el('line', { x1, y1, x2, y2, class: 'tick' }, g);
  }
  const [lx, ly] = p(from + (side * pz.target) / 2, r1 + 17);
  label(g, lx, ly + 4, `${pz.target}°`, { cls: 'answer-lbl' });
}

// The Split bar, drawn in its own frame: x runs from 0 (round end) to len along the bar.
function slider(parent, pz) {
  const len = Math.hypot(pz.b.x - pz.a.x, pz.b.y - pz.a.y);
  const deg = (Math.atan2(pz.b.y - pz.a.y, pz.b.x - pz.a.x) * 180) / Math.PI;
  const g = el('g', { transform: `translate(${pz.a.x} ${pz.a.y}) rotate(${deg})` }, parent);
  el('line', { x1: 0, y1: 0, x2: len, y2: 0, class: 'slide-line' }, g);
  const caps = () => {
    el('line', { x1: len, y1: -9, x2: len, y2: 9, class: 'slide-cap' }, g);
    el('line', { x1: 0, y1: -9, x2: 0, y2: 9, class: 'slide-cap' }, g);
    el('circle', { cx: 0, cy: 0, r: 4.5, class: 'slide-start' }, g);
  };
  return { g, len, caps };
}

// An empty sheet, shown before a round starts so the board keeps its size (and the
// countdown has somewhere to sit).
export function blank(stage) {
  board(stage);
}

// Small line-art icons for each test (logo tiles, pickers, tables).
export function icon(kind) {
  const paths = {
    count: '<circle cx="7" cy="8" r="2.6"/><circle cx="16" cy="6.5" r="2.6"/><circle cx="11.5" cy="15" r="2.6"/><circle cx="18" cy="16.5" r="2.6"/><circle cx="5.5" cy="17" r="2"/>',
    track: '<path d="M3 15 L10 21 L21 5" fill="none" stroke-dasharray="2.5 2.5"/><circle cx="21" cy="5" r="2.8"/>',
    angle: '<path d="M4 19H21M4 19L16 5" fill="none"/><path d="M11 19a7 7 0 0 0 -2.4 -5.3" fill="none"/>',
    split: '<path d="M3 13H21" fill="none"/><circle cx="3.5" cy="13" r="2.2"/><path d="M13 5v4.5M10.5 6.5L13 9.5L15.5 6.5" fill="none"/>',
    time: '<circle cx="12" cy="13.5" r="7.5" fill="none"/><path d="M12 13.5V9.5M9.5 3h5M12 3v3M18.3 7.2l1.4-1.4" fill="none"/>',
  };
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${paths[kind]}</svg>`;
}
