// The ROTTEN logo: the family's letter tiles, melting more from left to right as if
// someone dropped acid on them. Drips hang off the tiles, letters warp and sag,
// and acid drops keep falling on the last two.

const LETTERS = 'ROTTEN';
const MELT = [0, 0.12, 0.3, 0.5, 0.78, 1];
const SIZE = 60, GAP = 9, TOP = 22, R = 9;
// Drips under each tile: [position across the tile 0-1, length at full melt, width]
const DRIPS = [
  [],
  [[0.7, 10, 7]],
  [[0.25, 14, 8], [0.72, 22, 7]],
  [[0.2, 22, 8], [0.55, 12, 6], [0.8, 30, 8]],
  [[0.25, 30, 9], [0.47, 46, 8], [0.74, 24, 9]],
  [[0.24, 40, 9], [0.42, 22, 7], [0.6, 58, 9], [0.78, 34, 8]],
];

function tilePath(x, y, melt, drips) {
  const w = SIZE, h = SIZE;
  const sag = melt * 5;   // the bottom edge bows down as it melts
  let d = `M${x + R},${y} H${x + w - R} Q${x + w},${y} ${x + w},${y + R} V${y + h - R + sag} Q${x + w},${y + h + sag} ${x + w - R},${y + h + sag}`;
  for (const [at, len, wd] of [...drips].sort((a, b) => b[0] - a[0])) {
    // Keep each drip clear of the rounded corners
    const cx = Math.min(x + w - R - 5 - wd / 2, Math.max(x + R + 5 + wd / 2, x + at * w));
    const l = Math.max(wd, len * melt), a = cx + wd / 2, b = cx - wd / 2, base = y + h + sag;
    d += ` L${a + 5},${base} C${a},${base} ${a},${base + l * 0.35} ${a - 0.5},${base + l - wd / 2}`
      + ` A${wd / 2 + 0.6},${wd / 2 + 0.6} 0 0 1 ${b + 0.5},${base + l - wd / 2}`
      + ` C${b},${base + l * 0.35} ${b},${base} ${b - 5},${base}`;
  }
  d += ` H${x + R} Q${x},${y + h + sag} ${x},${y + h - R + sag} V${y + R} Q${x},${y} ${x + R},${y} Z`;
  return d;
}

export function meltingLogo() {
  const width = LETTERS.length * SIZE + (LETTERS.length - 1) * GAP + 8;
  const height = TOP + SIZE + 70;
  const defs = MELT.map((m, i) => `
    <filter id="melt${i}" x="-20%" y="-20%" width="140%" height="160%">
      <feTurbulence type="fractalNoise" baseFrequency="0.06 0.015" numOctaves="1" seed="${i + 3}"/>
      <feDisplacementMap in="SourceGraphic" scale="${(m * 5).toFixed(1)}" xChannelSelector="R" yChannelSelector="G"/>
    </filter>`).join('');
  const tiles = [...LETTERS].map((c, i) => {
    const m = MELT[i];
    const x = 4 + i * (SIZE + GAP), y = TOP;
    const cx = x + SIZE / 2;
    const ink = i >= 4 ? 'var(--rot)' : 'var(--ink)';
    // Ink trickling out of the letter itself
    const trickles = m > 0.4 ? [[-6, 10], [7, 16]].slice(0, m > 0.7 ? 2 : 1).map(([dx, len]) =>
      `<path class="trickle" d="M${cx + dx},${y + 44} v${(len * m).toFixed(1)}" stroke="${ink}"/>`).join('') : '';
    return `<g class="lt lt${i}" style="--m:${m}">
      <path class="lt-tile${i >= 4 ? ' rotten' : ''}" d="${tilePath(x, y, m, DRIPS[i])}"/>
      <g filter="url(#melt${i})">
        <text x="${cx}" y="${y + SIZE / 2 + 1}" transform="translate(0 ${(m * 3).toFixed(1)}) skewX(${(-m * 5).toFixed(1)}) scale(1 ${(1 + m * 0.22).toFixed(2)})" transform-origin="${cx} ${y + 14}"
          fill="${ink}">${c}</text>
        ${trickles}
      </g>
      ${m >= 0.75 ? `<ellipse class="puddle" cx="${cx + 4}" cy="${y + SIZE + 64}" rx="${18 + m * 8}" ry="3.5"/>` : ''}
    </g>`;
  }).join('');
  // Acid drops falling onto the most melted tiles, and drops falling off the longest drips
  const acidX = (i) => 4 + i * (SIZE + GAP) + SIZE * 0.55;
  const acid = [4, 5].map((i, k) => `<circle class="acid a${k}" cx="${acidX(i)}" cy="2" r="4"/>`).join('');
  const fall = [[4, 0.47, 46], [5, 0.6, 58]].map(([i, at, len], k) =>
    `<circle class="falling f${k}" cx="${4 + i * (SIZE + GAP) + at * SIZE}" cy="${TOP + SIZE + 5 + len * MELT[i]}" r="3.5"/>`).join('');
  return `<svg class="melt-logo" viewBox="0 0 ${width} ${height}" aria-hidden="true">
    <defs>${defs}</defs>${tiles}${acid}${fall}
  </svg>`;
}
