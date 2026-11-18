// Ludo's die and sounds. The die is a flat square of pips; sounds are made on the fly (nothing to download).

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* =========================================================
   The die: a flat square with pips. Rolling flicks through a few faces and settles on the number.
   ========================================================= */
const PIPS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

export function createDie(node) {
  node.classList.add('die');
  node.innerHTML = Array.from({ length: 9 }, () => '<i></i>').join('');
  const cells = [...node.children];
  let value = 0;
  let timer = 0;
  const face = (v) => cells.forEach((c, k) => c.classList.toggle('pip', v > 0 && PIPS[v].includes(k + 1)));
  face(0);
  return {
    get value() { return value; },
    /** Flick through faces, then land on v; resolves when it has landed. */
    roll(v, ms = 480) {
      clearInterval(timer);
      value = v;
      if (reduced() || ms < 60) { face(v); return Promise.resolve(); }
      node.classList.add('rolling');
      let last = 0;
      timer = setInterval(() => {
        let f;
        do f = 1 + Math.floor(Math.random() * 6); while (f === last);
        last = f;
        face(f);
      }, 70);
      return new Promise((resolve) => setTimeout(() => {
        clearInterval(timer);
        node.classList.remove('rolling');
        face(v);
        resolve();
      }, ms));
    },
    /** Show v without rolling (0: blank). */
    set(v) {
      clearInterval(timer);
      node.classList.remove('rolling');
      value = v;
      face(v);
    },
    /** Waiting for the server's number after pressing Roll. */
    shake(on) {
      if (!on) { clearInterval(timer); node.classList.remove('rolling'); face(value); return; }
      node.classList.add('rolling');
      clearInterval(timer);
      timer = setInterval(() => face(1 + Math.floor(Math.random() * 6)), 70);
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
