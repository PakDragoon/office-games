// The banana: an SVG that browns and gets spots as it ages, and splats.

// Peel colour from fresh to rotten (light theme; dark theme uses the same fruit)
const STOPS = [
  [0, [190, 214, 78]],
  [0.18, [243, 212, 74]],
  [0.5, [233, 185, 60]],
  [0.78, [168, 108, 44]],
  [1, [62, 38, 22]],
];
// Spots: x, y, rx, ry, and the age at which each one appears
const SPOTS = [
  [70, 82, 4, 3, 0.32], [118, 101, 5, 3.5, 0.38], [154, 92, 3.5, 2.5, 0.44], [95, 96, 3, 2.2, 0.5],
  [138, 104, 4.5, 3, 0.55], [60, 70, 3, 2.4, 0.6], [172, 78, 3.5, 2.6, 0.64], [108, 88, 2.5, 2, 0.68],
  [84, 90, 5, 3.5, 0.72], [128, 95, 3, 2, 0.76], [148, 100, 2.6, 2, 0.8], [76, 76, 2.4, 1.8, 0.84],
];

function mix(r) {
  const t = Math.max(0, Math.min(1, r));
  for (let i = 1; i < STOPS.length; i++) {
    const [b, cb] = STOPS[i];
    const [a, ca] = STOPS[i - 1];
    if (t <= b) {
      const k = (t - a) / (b - a);
      return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * k)).join(',')})`;
    }
  }
  return `rgb(${STOPS.at(-1)[1].join(',')})`;
}

export function createBanana(host) {
  host.innerHTML = `
    <svg class="banana-svg" viewBox="0 0 220 150" role="img" aria-label="The banana">
      <g class="banana-fruit">
        <g class="banana-body">
          <path class="b-stem" d="M38 42 L24 22"/>
          <path class="b-peel" d="M30 44 C44 118 168 130 198 40 L191 37 C163 96 70 94 40 38 Z"/>
          <path class="b-shade" d="M36 50 C56 112 164 120 194 46 C166 108 64 104 36 50 Z"/>
          <path class="b-shine" d="M54 56 C80 92 146 98 176 62"/>
          <g class="b-spots">${SPOTS.map(([x, y, rx, ry]) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}"/>`).join('')}</g>
          <circle class="b-tip" cx="196" cy="39" r="4"/>
        </g>
      </g>
      <g class="banana-splat">
        <path class="s-blob" d="M110 70c22-18 40-2 34 12 20-4 30 16 14 26 14 12-4 30-22 20-6 18-34 18-38 2-16 12-40 2-32-16-20-4-18-30 4-28-6-20 22-30 40-16z"/>
        <circle class="s-drop" cx="46" cy="66" r="7"/><circle class="s-drop" cx="182" cy="62" r="6"/>
        <circle class="s-drop" cx="62" cy="128" r="5"/><circle class="s-drop" cx="174" cy="126" r="7"/>
        <circle class="s-drop" cx="112" cy="30" r="5"/><circle class="s-drop" cx="30" cy="104" r="4"/>
        <path class="s-peel" d="M92 92c-12-10-22-6-30 2M128 96c12-8 24-4 30 4M110 100c0 12-4 20-12 24"/>
      </g>
    </svg>`;
  const svg = host.firstElementChild;
  const peel = svg.querySelector('.b-peel');
  const spots = [...svg.querySelectorAll('.b-spots ellipse')];
  let last = -1;

  return {
    // r: 0 fresh to 1 rotten
    setRot(r) {
      const v = Math.round(Math.max(0, Math.min(1, r)) * 200) / 200;
      if (v === last) return;
      last = v;
      peel.style.fill = mix(v);
      spots.forEach((s, i) => { s.style.opacity = String(Math.max(0, Math.min(1, (v - SPOTS[i][4]) * 6))); });
    },
    // mode: on | reduced | off
    splat(mode = 'on') {
      svg.classList.remove('splatting', 'splat-soft', 'splat-flash');
      void svg.getBoundingClientRect();
      svg.classList.add(mode === 'on' ? 'splatting' : mode === 'reduced' ? 'splat-soft' : 'splat-flash');
    },
    reset() {
      svg.classList.remove('splatting', 'splat-soft', 'splat-flash');
      last = -1;
      this.setRot(0);
    },
    // A little hop when the banana is passed on
    hop() {
      svg.classList.remove('hop');
      void svg.getBoundingClientRect();
      svg.classList.add('hop');
    },
    setLive(on) { svg.classList.toggle('live', on); },
  };
}

