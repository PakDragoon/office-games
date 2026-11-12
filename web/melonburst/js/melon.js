// The watermelon, drawn in SVG. Every wrong letter snaps a rubber band round its middle: the middle
// pinches in, the ends bulge, the face goes from happy to worried to panicking, cracks and juice
// appear, and one band too many makes it burst. Solving it pings the bands off and the melon
// springs back into shape, keeping its face and cracks.

const NS = 'http://www.w3.org/2000/svg';
const CX = 120, CY = 112, RX = 90, RY = 66;
const BAND_COLOURS = ['#e8453c', '#f2b630', '#3d7fe0', '#9b5de5', '#f07ab0', '#2bb5a8', '#ff8a3d', '#6bbf3a'];

// The rind outline, pinched in the middle by `pinch` (0 to about 0.32)
function bodyPath(pinch, swell) {
  const pts = [];
  const rx = RX * (1 + swell * 0.08), ry = RY * (1 + swell * 0.1);
  for (let k = 0; k < 72; k++) {
    const t = (k / 72) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    const squeeze = 1 - pinch * Math.pow(1 - Math.abs(c), 3);
    pts.push([CX + rx * c, CY + ry * s * squeeze]);
  }
  return `M${pts.map((p) => p.map((n) => n.toFixed(1)).join(' ')).join('L')}Z`;
}

// Half-height of the melon at x, for a band to wrap round
function heightAt(x, pinch, swell) {
  const rx = RX * (1 + swell * 0.08), ry = RY * (1 + swell * 0.1);
  const c = Math.max(-1, Math.min(1, (x - CX) / rx));
  const s = Math.sqrt(1 - c * c);
  return ry * s * (1 - pinch * Math.pow(1 - Math.abs(c), 3));
}

// Where the k-th band (of n) sits: they bunch up in the middle, spreading out as more go on
function bandX(k, n) {
  if (n <= 1) return CX;
  const spread = Math.min(30, 6 + n * 3.4);
  return CX - spread / 2 + (spread * k) / (n - 1);
}

const el = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

const STRIPES = [-52, -30, -9, 12, 33, 54].map((dy, i) => {
  const y = CY + dy;
  const w = i % 2 ? 5 : -5;
  return `M10 ${y} C 50 ${y + w * 2}, 80 ${y - w * 2}, 120 ${y} S 190 ${y + w * 2}, 232 ${y - w}`;
});

// Chunks for the burst: a wedge of red flesh with a strip of rind and a few seeds
function chunk(i, n) {
  const a = (i / n) * Math.PI * 2 + (i % 3) * 0.3;
  const dist = 85 + (i % 4) * 28;
  const g = el('g', { class: 'chunk' });
  g.style.setProperty('--dx', `${(Math.cos(a) * dist).toFixed(0)}px`);
  g.style.setProperty('--dy', `${(Math.sin(a) * dist * 0.75 - 30).toFixed(0)}px`);
  g.style.setProperty('--rot', `${(i % 2 ? 1 : -1) * (160 + i * 23)}deg`);
  g.style.setProperty('--delay', `${(i % 5) * 0.015}s`);
  const s = 20 + (i % 3) * 7;
  g.appendChild(el('path', { class: 'flesh', d: `M${CX} ${CY} l${s} ${-s * 0.4} a${s} ${s} 0 0 1 ${-s * 0.4} ${s * 1.3}z` }));
  g.appendChild(el('path', { class: 'rind-bit', d: `M${CX + s} ${CY - s * 0.4} a${s} ${s} 0 0 1 ${-s * 0.4} ${s * 1.3}`, fill: 'none' }));
  g.appendChild(el('ellipse', { class: 'seed', cx: CX + s * 0.35, cy: CY + s * 0.25, rx: 2, ry: 3.2 }));
  g.appendChild(el('ellipse', { class: 'seed', cx: CX + s * 0.6, cy: CY + s * 0.05, rx: 1.8, ry: 3 }));
  return g;
}

/**
 * Put a melon in `container`. opts.small: a smaller one for other players (no animation flourishes).
 * Returns { set(state, animate), reset() } where state = { wrong, bands, solved, burst }.
 */
export function createMelon(container, opts = {}) {
  const uid = `m${Math.random().toString(36).slice(2, 8)}`;
  const svg = el('svg', { viewBox: '0 0 240 220', class: `melon-svg${opts.small ? ' small' : ''}`, role: 'img' });
  svg.innerHTML = `
    <defs>
      <clipPath id="${uid}-clip"><path class="clip-path"/></clipPath>
      <radialGradient id="${uid}-shade" cx="38%" cy="30%" r="80%">
        <stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/>
        <stop offset="1" stop-color="#000" stop-opacity=".28"/>
      </radialGradient>
    </defs>
    <ellipse class="m-shadow" cx="${CX}" cy="${CY + RY + 16}" rx="${RX * 0.85}" ry="9"/>
    <g class="splat-remains"></g>
    <g class="m-whole">
      <g class="m-wobble">
        <path class="m-body"/>
        <g clip-path="url(#${uid}-clip)">
          <g class="m-stripes">${STRIPES.map((d) => `<path d="${d}"/>`).join('')}</g>
          <path class="m-shade" fill="url(#${uid}-shade)"/>
        </g>
        <path class="m-stem" d="M${CX + RX - 6} ${CY - 6} q 12 -6 16 -16" />
        <g class="m-cracks"></g>
        <g class="m-face" transform="translate(${CX - 48} ${CY - 2}) scale(1.22)">
          <g class="brows"><path class="brow l"/><path class="brow r"/></g>
          <g class="eyes">
            <ellipse class="eye-w" cx="-11" cy="0" rx="7" ry="8"/><ellipse class="eye-w" cx="11" cy="0" rx="7" ry="8"/>
            <circle class="pupil" cx="-10" cy="1" r="3.4"/><circle class="pupil" cx="12" cy="1" r="3.4"/>
          </g>
          <path class="mouth"/>
          <path class="sweat" d="M22 -14 q4 6 0 9 q-4 -3 0 -9z"/>
        </g>
        <g class="m-bands"></g>
        <g class="m-drips"></g>
      </g>
    </g>
    <g class="m-boom"></g>`;
  container.innerHTML = '';
  container.appendChild(svg);
  const $ = (s) => svg.querySelector(s);
  let shown = { wrong: -1, bands: 6, solved: false, burst: false };

  function drawBands(n, pinch, swell, fresh) {
    const g = $('.m-bands');
    g.innerHTML = '';
    for (let k = 0; k < n; k++) {
      const x = bandX(k, n);
      const h = heightAt(x, pinch, swell) + 1.5;
      const bow = 7 + (k % 2);
      const d = `M${x} ${CY - h} C ${x + bow} ${CY - h * 0.55}, ${x + bow} ${CY + h * 0.55}, ${x} ${CY + h}`;
      const band = el('g', { class: `band${fresh && k === n - 1 ? ' snap' : ''}` });
      band.appendChild(el('path', { class: 'band-edge', d }));
      band.appendChild(el('path', { class: 'band-line', d, stroke: BAND_COLOURS[k % BAND_COLOURS.length] }));
      band.appendChild(el('path', { class: 'band-shine', d }));
      g.appendChild(band);
    }
  }

  function drawCracks(level, pinch) {
    const g = $('.m-cracks');
    g.innerHTML = '';
    const top = CY - RY * (1 - pinch) - 2, bottom = CY + RY * (1 - pinch) + 2;
    const cracks = [
      `M${CX - 20} ${top + 4} l-5 9 l6 4 l-6 10`,
      `M${CX + 22} ${bottom - 4} l4 -9 l-6 -4 l5 -10`,
      `M${CX - 26} ${bottom - 6} l-6 -8 l5 -6`,
      `M${CX + 26} ${top + 6} l7 8 l-4 7`,
    ];
    cracks.slice(0, level).forEach((d) => g.appendChild(el('path', { d, class: 'crack' })));
  }

  function drawDrips(on, pinch) {
    const g = $('.m-drips');
    g.innerHTML = '';
    if (!on) return;
    const bottom = CY + RY * (1 - pinch);
    [[CX - 22, 0], [CX + 18, 0.6]].forEach(([x, delay]) => {
      const d = el('path', { class: 'drip', d: `M${x} ${bottom} q4 8 0 12 q-4 -4 0 -12z` });
      d.style.animationDelay = `${delay}s`;
      g.appendChild(d);
    });
  }

  function face(stage) {
    // stage: 0 calm, 1 worried, 2 scared, 3 panic
    const f = $('.m-face');
    f.dataset.stage = String(stage);
    const brows = [
      ['M-17 -12 q6 -4 12 0', 'M5 -12 q6 -4 12 0'],
      ['M-17 -11 l12 -4', 'M5 -15 l12 4'],
      ['M-18 -14 l12 -5', 'M6 -19 l12 5'],
      ['M-18 -16 l12 -6', 'M6 -22 l12 6'],
    ][Math.min(stage, 3)];
    $('.brow.l').setAttribute('d', brows[0]);
    $('.brow.r').setAttribute('d', brows[1]);
    const mouth = ['M-10 15 q10 9 20 0', 'M-9 17 h18', 'M-11 18 q3 -4 6 0 t6 0 t6 0', 'M-6 18 a6 7 0 1 0 12 0 a6 7 0 1 0 -12 0'][Math.min(stage, 3)];
    $('.mouth').setAttribute('d', mouth);
  }

  function burst(animate) {
    svg.classList.add('burst');
    const boom = $('.m-boom');
    boom.innerHTML = '';
    const remains = $('.splat-remains');
    remains.innerHTML = `
      <path class="puddle" d="M${CX - 70} ${CY + RY + 12} q 20 -14 50 -6 q 20 -16 48 -2 q 30 -6 44 8 q -10 12 -40 8 q -30 10 -60 2 q -30 6 -42 -10z"/>
      <path class="rind-left" d="M${CX - 60} ${CY + RY + 8} q 18 -26 46 -10 q -24 4 -46 10z"/>
      <path class="rind-right" d="M${CX + 64} ${CY + RY + 6} q -14 -24 -44 -12 q 24 6 44 12z"/>
      ${[0, 1, 2, 3, 4].map((i) => `<ellipse class="seed" cx="${CX - 50 + i * 24}" cy="${CY + RY + 9 - (i % 2) * 4}" rx="1.8" ry="3" transform="rotate(${i * 37} ${CX - 50 + i * 24} ${CY + RY + 9})"/>`).join('')}`;
    if (!animate || opts.small) return;
    boom.appendChild(el('circle', { class: 'flash-ring', cx: CX, cy: CY, r: 40 }));
    // a star of juice that bursts out and drains away
    const star = [];
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const r = k % 2 ? 34 : 70 + (k % 4) * 12;
      star.push(`${(CX + Math.cos(a) * r).toFixed(1)} ${(CY + Math.sin(a) * r * 0.8).toFixed(1)}`);
    }
    boom.appendChild(el('path', { class: 'juice-star', d: `M${star.join('L')}Z` }));
    for (let i = 0; i < 16; i++) boom.appendChild(chunk(i, 16));
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const s = el('ellipse', { class: 'seed fly', cx: CX, cy: CY, rx: 2, ry: 3.2 });
      s.style.setProperty('--dx', `${(Math.cos(a) * 150).toFixed(0)}px`);
      s.style.setProperty('--dy', `${(Math.sin(a) * 110 - 40).toFixed(0)}px`);
      s.style.setProperty('--rot', `${i * 70}deg`);
      boom.appendChild(s);
    }
    setTimeout(() => { if (svg.isConnected) boom.innerHTML = ''; }, 1700);
  }

  function set(state, animate = true) {
    const bands = Math.max(1, state.bands || 6);
    const wrong = Math.max(0, Math.min(state.wrong || 0, bands + 1));
    const n = Math.min(wrong, bands);
    if (shown.wrong === wrong && shown.solved === state.solved && shown.burst === state.burst && shown.bands === bands) return;
    const fresh = animate && wrong > shown.wrong && shown.wrong >= 0 && !state.burst;
    if (state.burst) {
      if (!shown.burst) burst(animate && shown.wrong >= 0);
      shown = { wrong, bands, solved: false, burst: true };
      svg.setAttribute('aria-label', 'The melon burst');
      return;
    }
    if (shown.burst) reset();
    const strain = n / bands;
    const pinch = 0.06 + strain * 0.34;
    const swell = strain;
    const crackLevel = n >= bands ? 4 : n >= bands - 1 ? 2 : 0;
    const shape = (p, sw) => {
      const body = bodyPath(p, sw);
      $('.m-body').setAttribute('d', body);
      $('.clip-path').setAttribute('d', body);
      $('.m-shade').setAttribute('d', body);
      drawCracks(crackLevel, p);
    };
    const pingNow = state.solved && !shown.solved && animate && shown.wrong >= 0;
    // Solved: the melon gets its round shape back (once the bands have pinged off), but keeps
    // its face and its cracks. The face is the expression it had at the moment it was solved.
    shape(state.solved && !pingNow ? 0.06 : pinch, state.solved && !pingNow ? 0 : swell);
    const stage = strain >= 1 ? 3 : strain > 0.6 ? 2 : strain > 0.25 ? 1 : 0;
    svg.dataset.stage = state.solved ? 'safe' : String(stage);
    drawDrips(!state.solved && n >= bands, pinch);
    face(stage);
    if (pingNow) {
      // the bands ping off, then the melon springs back into shape
      $('.m-bands').querySelectorAll('.band').forEach((b, k) => { b.classList.add('ping'); b.style.animationDelay = `${k * 0.06}s`; });
      setTimeout(() => {
        if (!svg.isConnected || !shown.solved) return;
        drawBands(0, pinch, swell, false);
        shape(0.06, 0);
      }, 700);
      svg.classList.remove('hop');
      void svg.getBoundingClientRect();
      svg.classList.add('hop');
    } else {
      drawBands(state.solved ? 0 : n, pinch, swell, fresh);
    }
    if (fresh && !opts.small) {
      svg.classList.remove('squish');
      void svg.getBoundingClientRect();
      svg.classList.add('squish');
    }
    svg.setAttribute('aria-label', state.solved ? 'The melon is safe' : `${n} of ${bands} rubber bands`);
    shown = { wrong, bands, solved: Boolean(state.solved), burst: false };
  }

  function reset() {
    svg.classList.remove('burst', 'hop', 'squish');
    $('.m-boom').innerHTML = '';
    $('.splat-remains').innerHTML = '';
    shown = { wrong: -1, bands: shown.bands, solved: false, burst: false };
  }

  set({ wrong: 0, bands: 6 }, false);
  shown.wrong = -1;
  return { set, reset, svg };
}
