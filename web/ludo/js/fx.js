// Ludo's dice, sounds and confetti. The die is a CSS 3D cube that tumbles and lands on the number the
// server rolled; sounds are made on the fly (nothing to download); confetti is one canvas over the page.

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* =========================================================
   The die
   ========================================================= */
const PIPS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
// Which way the cube turns to show each number at the front (opposite faces add up to 7)
const FACE = { 1: [0, 0], 6: [0, 180], 3: [0, -90], 4: [0, 90], 2: [-90, 0], 5: [90, 0] };
const SIDES = [['front', 1], ['back', 6], ['right', 3], ['left', 4], ['top', 2], ['bottom', 5]];

export function createDie() {
  const wrap = document.createElement('div');
  wrap.className = 'die-wrap';
  wrap.innerHTML = `<div class="die-shadow"></div><div class="die">${SIDES.map(([side, n]) =>
    `<div class="face ${side}">${Array.from({ length: 9 }, (_, k) => `<i${PIPS[n].includes(k + 1) ? ' class="pip"' : ''}></i>`).join('')}</div>`).join('')}</div>`;
  const cube = wrap.querySelector('.die');
  let ax = -18, ay = 24;   // keep turning the same way: the angles only ever grow
  let value = 1;
  const show = (v, animate) => {
    const [fx, fy] = FACE[v];
    if (animate) {
      ax = Math.ceil(ax / 360) * 360 + 720 + fx;
      ay = Math.ceil(ay / 360) * 360 + 360 * (1 + Math.round(Math.random())) + fy;
    } else {
      ax = Math.round(ax / 360) * 360 + fx;
      ay = Math.round(ay / 360) * 360 + fy;
    }
    cube.style.transform = `rotateX(${ax}deg) rotateY(${ay}deg)`;
  };
  show(1, false);
  return {
    el: wrap,
    get value() { return value; },
    /** Tumble and land on v; resolves when it has landed. */
    roll(v, ms = 720) {
      value = v;
      if (reduced()) { show(v, false); return Promise.resolve(); }
      wrap.classList.remove('landed');
      wrap.classList.add('rolling');
      cube.style.transitionDuration = `${ms}ms`;
      show(v, true);
      return new Promise((resolve) => setTimeout(() => {
        wrap.classList.remove('rolling');
        void wrap.offsetWidth;
        wrap.classList.add('landed');
        resolve();
      }, ms));
    },
    set(v) {
      value = v;
      cube.style.transitionDuration = '0ms';
      show(v, false);
    },
  };
}

/* =========================================================
   Sounds
   ========================================================= */
let audio = null;
let enabled = true;
export const setSound = (on) => { enabled = on; };

function ctx() {
  if (!enabled) return null;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    return audio;
  } catch { return null; }
}
function tone(freq, at, dur, { type = 'sine', vol = 0.14, slide = 0 } = {}) {
  const a = ctx();
  if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
function noise(at, dur, vol = 0.12, hp = 1800) {
  const a = ctx();
  if (!a) return;
  const t = a.currentTime + at;
  const buf = a.createBuffer(1, Math.max(1, Math.floor(a.sampleRate * dur)), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let k = 0; k < d.length; k++) d[k] = (Math.random() * 2 - 1) * (1 - k / d.length) ** 2;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = hp;
  const g = a.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(a.destination);
  src.start(t);
}

/** sound(name, n): rattle, land, hop (n = step), capture, home, turn, win, tick, nope */
export function sound(name, n = 0) {
  if (!enabled) return;
  switch (name) {
    case 'rattle':
      for (let k = 0; k < 6; k++) noise(k * 0.085 + Math.random() * 0.03, 0.035, 0.09, 2500);
      break;
    case 'land':
      tone(180, 0, 0.09, { type: 'triangle', vol: 0.18, slide: -60 });
      noise(0, 0.05, 0.1, 1200);
      break;
    case 'hop':
      tone(520 + n * 45, 0, 0.07, { type: 'triangle', vol: 0.08 });
      break;
    case 'capture':
      tone(220, 0, 0.18, { type: 'square', vol: 0.07, slide: -150 });
      noise(0, 0.16, 0.16, 600);
      tone(660, 0.08, 0.12, { type: 'triangle', vol: 0.08, slide: 400 });
      break;
    case 'home':
      [660, 830, 990, 1320].forEach((f, k) => tone(f, k * 0.07, 0.22, { vol: 0.1 }));
      break;
    case 'turn':
      tone(880, 0, 0.12, { vol: 0.09 });
      tone(1175, 0.1, 0.18, { vol: 0.09 });
      break;
    case 'win':
      [523, 659, 784, 1047, 784, 1047].forEach((f, k) => tone(f, k * 0.11, 0.3, { type: 'triangle', vol: 0.11 }));
      break;
    case 'tick':
      tone(1400, 0, 0.03, { vol: 0.05 });
      break;
    case 'nope':
      tone(300, 0, 0.16, { type: 'triangle', vol: 0.09, slide: -120 });
      break;
    default:
  }
}

/* =========================================================
   Confetti
   ========================================================= */
let canvas = null;
let pieces = [];
let raf = 0;

/** Confetti from (x, y) in page pixels (default: across the top), in these colours. */
export function confetti(colours, { x = null, y = null, count = 140 } = {}) {
  if (reduced()) return;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'confetti';
    document.body.append(canvas);
  }
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  for (let k = 0; k < count; k++) {
    const fromTop = x === null;
    pieces.push({
      x: fromTop ? Math.random() * innerWidth : x,
      y: fromTop ? -20 - Math.random() * innerHeight * 0.3 : y,
      vx: fromTop ? (Math.random() - 0.5) * 2 : (Math.random() - 0.5) * 12,
      vy: fromTop ? 2 + Math.random() * 3 : -6 - Math.random() * 8,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      w: 6 + Math.random() * 6,
      h: 3 + Math.random() * 4,
      c: colours[k % colours.length],
      life: 0,
    });
  }
  if (!raf) raf = requestAnimationFrame(frame);
}
function frame() {
  const g = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  // The window was resized (a phone turned round): keep the canvas the size of the window
  if (canvas.width !== Math.round(innerWidth * dpr) || canvas.height !== Math.round(innerHeight * dpr)) {
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, innerWidth, innerHeight);
  pieces = pieces.filter((p) => p.y < innerHeight + 30 && p.life < 360);
  for (const p of pieces) {
    p.life++;
    p.vy += 0.18;
    p.vx *= 0.99;
    p.x += p.vx;
    p.y += p.vy;
    p.r += p.vr;
    g.save();
    g.translate(p.x, p.y);
    g.rotate(p.r);
    g.scale(1, Math.cos(p.life / 6));
    g.fillStyle = p.c;
    g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    g.restore();
  }
  raf = pieces.length ? requestAnimationFrame(frame) : 0;
  if (!raf) g.clearRect(0, 0, innerWidth, innerHeight);
}
