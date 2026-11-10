// The banana: an SVG that ripens, bruises, starts to smell and splats.

// Peel colour from fresh to rotten
const STOPS = [
  [0, [184, 212, 70]],
  [0.2, [246, 212, 66]],
  [0.45, [240, 190, 52]],
  [0.65, [205, 146, 50]],
  [0.85, [126, 80, 36]],
  [1, [58, 36, 20]],
];
// Spots on the peel: x, y, rx, ry, rotation, and the age at which each appears
const SPOTS = [
  [66, 74, 3.2, 2.2, 20, 0.3], [112, 84, 3.8, 2.4, 0, 0.34], [150, 70, 3, 2, -25, 0.38], [90, 82, 2.6, 1.8, 10, 0.42],
  [132, 80, 3.4, 2.2, -10, 0.46], [56, 62, 2.4, 1.8, 40, 0.5], [164, 56, 2.6, 1.8, -40, 0.54], [102, 76, 2.2, 1.6, 0, 0.58],
  [78, 88, 3.8, 2.6, 15, 0.6], [124, 92, 3, 2, -5, 0.64], [142, 86, 2.4, 1.8, -20, 0.68], [70, 70, 2.2, 1.6, 30, 0.72],
];
// Bruises: big soft patches late on
const BRUISES = [
  ['M84 80c8-5 20-4 24 2s-4 11-14 11-16-8-10-13z', 0.62],
  ['M128 74c7-3 16-1 17 5s-6 9-13 8-10-9-4-13z', 0.7],
  ['M52 58c5-3 11-1 11 4s-4 8-9 7-7-7-2-11z', 0.78],
  ['M146 58c5-2 10 0 10 4s-4 6-8 6-6-6-2-10z', 0.84],
];

const STAGES = [[0.2, 'Fresh'], [0.45, 'Ripe'], [0.65, 'Spotty'], [0.85, 'Mushy'], [Infinity, 'Rotten!']];

function colour(r) {
  const t = Math.max(0, Math.min(1, r));
  for (let i = 1; i < STOPS.length; i++) {
    const [b, cb] = STOPS[i];
    const [a, ca] = STOPS[i - 1];
    if (t <= b) {
      const k = (t - a) / (b - a);
      return ca.map((c, j) => Math.round(c + (cb[j] - c) * k));
    }
  }
  return STOPS.at(-1)[1];
}
const rgb = (c, f = 1) => `rgb(${c.map((v) => Math.round(v * f)).join(',')})`;

export const stageOf = (r) => STAGES.find(([max]) => r < max)[1];

export function createBanana(host) {
  host.innerHTML = `
    <svg class="banana-svg" viewBox="0 0 200 130" role="img" aria-label="The banana">
      <g class="banana-fruit">
        <g class="stink">
          <path d="M70 30c-4-6 4-9 0-15s4-9 0-14"/><path d="M100 26c-4-6 4-9 0-15s4-9 0-14"/><path d="M130 30c-4-6 4-9 0-15s4-9 0-14"/>
        </g>
        <ellipse class="b-shadow" cx="108" cy="120" rx="62" ry="5"/>
        <g class="banana-body">
          <path class="b-stem" d="M36 44 C30 34 24 28 17 21"/>
          <circle class="b-stem-end" cx="16" cy="20" r="5"/>
          <path class="b-peel" d="M30 46 C36 120 156 128 184 38 C178 40 174 41 171 43 C146 86 62 84 38 42 Z"/>
          <path class="b-face" d="M38 42 C62 84 146 86 171 43 L179 41 C156 106 56 101 35 47 Z"/>
          <path class="b-under" d="M32 52 C44 116 152 122 182 42 C156 110 52 106 32 52 Z"/>
          <path class="b-ridge" d="M35 47 C56 101 156 106 179 41"/>
          <path class="b-shine" d="M60 70 C82 90 128 92 154 70"/>
          <g class="b-bruises">${BRUISES.map(([d]) => `<path d="${d}"/>`).join('')}</g>
          <g class="b-spots">${SPOTS.map(([x, y, rx, ry, rot]) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${x} ${y})"/>`).join('')}</g>
          <path class="b-tip" d="M178 40c3-3 8-3 9 1s-3 6-7 5-4-4-2-6z"/>
          <path class="b-drip" d="M110 104c0 6-3 9-3 13a3 3 0 006 0c0-4-3-7-3-13z"/>
        </g>
        <g class="flies">
          <g class="fly f1"><ellipse class="wing" cx="-2" cy="-3" rx="3" ry="2"/><ellipse class="wing" cx="2" cy="-3" rx="3" ry="2"/><circle r="2.2"/></g>
          <g class="fly f2"><ellipse class="wing" cx="-2" cy="-3" rx="3" ry="2"/><ellipse class="wing" cx="2" cy="-3" rx="3" ry="2"/><circle r="2.2"/></g>
        </g>
      </g>
      <g class="banana-splat">
        <path class="s-blob" d="M100 66c22-18 40-2 34 12 20-4 30 16 14 26 14 12-4 30-22 20-6 18-34 18-38 2-16 12-40 2-32-16-20-4-18-30 4-28-6-20 22-30 40-16z"/>
        <circle class="s-drop" cx="36" cy="62" r="7"/><circle class="s-drop" cx="172" cy="58" r="6"/>
        <circle class="s-drop" cx="52" cy="122" r="5"/><circle class="s-drop" cx="164" cy="120" r="7"/>
        <circle class="s-drop" cx="102" cy="26" r="5"/><circle class="s-drop" cx="20" cy="98" r="4"/>
        <path class="s-peel" d="M82 88c-12-10-22-6-30 2M118 92c12-8 24-4 30 4M100 96c0 12-4 20-12 24"/>
      </g>
    </svg>`;
  const svg = host.firstElementChild;
  const peel = svg.querySelector('.b-peel');
  const stem = svg.querySelector('.b-stem');
  const spots = [...svg.querySelectorAll('.b-spots ellipse')];
  const bruises = [...svg.querySelectorAll('.b-bruises path')];
  let last = -1;

  return {
    // r: 0 fresh to 1 rotten
    setRot(r) {
      const v = Math.round(Math.max(0, Math.min(1, r)) * 200) / 200;
      if (v === last) return;
      last = v;
      const c = colour(v);
      peel.style.fill = rgb(c);
      peel.style.stroke = rgb(c, 0.55);
      stem.style.stroke = rgb(colour(Math.min(1, v + 0.45)), 0.6);
      spots.forEach((s, i) => { s.style.opacity = String(Math.max(0, Math.min(0.9, (v - SPOTS[i][5]) * 6))); });
      bruises.forEach((b, i) => { b.style.opacity = String(Math.max(0, Math.min(0.75, (v - BRUISES[i][1]) * 4))); });
      svg.style.setProperty('--stink', String(Math.max(0, Math.min(1, (v - 0.7) * 5))));
      svg.classList.toggle('flies-on', v >= 0.8);
      svg.classList.toggle('drip-on', v >= 0.9);
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
