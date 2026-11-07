// Thulla slap: a cartoon cat or hippo pops up and slaps.
// Full screen for the player who picks up the trick; a mini slap at their seat for everyone else.

const INK = '#1b1e3a';

const CAT = `
<svg viewBox="0 0 240 270" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g stroke="${INK}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">
    <path d="M190 236 q52 -6 36 -66" fill="none" stroke-width="20"/>
    <path d="M190 236 q52 -6 36 -66" fill="none" stroke="#f2a65a" stroke-width="11"/>
    <ellipse cx="120" cy="232" rx="86" ry="58" fill="#f2a65a"/>
    <ellipse cx="120" cy="244" rx="46" ry="34" fill="#fde7c8" stroke="none"/>
    <ellipse cx="58" cy="226" rx="18" ry="26" fill="#f2a65a"/>
    <path d="M62 92 L56 26 L110 62 Z" fill="#f2a65a"/>
    <path d="M178 92 L184 26 L130 62 Z" fill="#f2a65a"/>
    <path d="M70 80 L67 44 L96 64 Z" fill="#f7b6c2" stroke="none"/>
    <path d="M170 80 L173 44 L144 64 Z" fill="#f7b6c2" stroke="none"/>
    <circle cx="120" cy="122" r="70" fill="#f2a65a"/>
    <path d="M103 58 q17 13 34 0 M110 72 q10 7 20 0" fill="none" stroke="#c9741f" stroke-width="5"/>
    <path d="M52 118 q10 4 14 0 M188 118 q-10 4 -14 0" fill="none" stroke="#c9741f" stroke-width="5"/>
    <ellipse cx="95" cy="120" rx="14" ry="15" fill="#fff"/>
    <ellipse cx="145" cy="120" rx="14" ry="15" fill="#fff"/>
    <circle cx="99" cy="124" r="6.5" fill="${INK}" stroke="none"/>
    <circle cx="141" cy="124" r="6.5" fill="${INK}" stroke="none"/>
    <path d="M78 98 L110 110 M162 98 L130 110" stroke-width="6"/>
    <path d="M113 140 h14 l-7 8 z" fill="#f48aa2"/>
    <path d="M120 148 q-8 11 -18 4 M120 148 q8 11 18 4" fill="none"/>
    <path d="M70 142 L28 134 M70 150 L26 156 M170 142 L212 134 M170 150 L214 156" stroke-width="3"/>
    <g class="arm">
      <path d="M168 210 C 186 176, 204 140, 214 110" fill="none" stroke-width="36"/>
      <path d="M168 210 C 186 176, 204 140, 214 110" fill="none" stroke="#f2a65a" stroke-width="27"/>
      <circle cx="217" cy="100" r="25" fill="#f2a65a"/>
      <ellipse cx="217" cy="106" rx="10" ry="8" fill="#f7b6c2" stroke="none"/>
      <circle cx="206" cy="91" r="5" fill="#f7b6c2" stroke="none"/>
      <circle cx="217" cy="86" r="5" fill="#f7b6c2" stroke="none"/>
      <circle cx="228" cy="91" r="5" fill="#f7b6c2" stroke="none"/>
    </g>
  </g>
</svg>`;

const HIPPO = `
<svg viewBox="0 0 240 270" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g stroke="${INK}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">
    <ellipse cx="120" cy="234" rx="98" ry="60" fill="#a99bd6"/>
    <ellipse cx="54" cy="228" rx="22" ry="28" fill="#a99bd6"/>
    <ellipse cx="74" cy="54" rx="14" ry="12" fill="#a99bd6"/>
    <ellipse cx="166" cy="54" rx="14" ry="12" fill="#a99bd6"/>
    <ellipse cx="74" cy="55" rx="6" ry="5" fill="#f4a3b8" stroke="none"/>
    <ellipse cx="166" cy="55" rx="6" ry="5" fill="#f4a3b8" stroke="none"/>
    <ellipse cx="120" cy="100" rx="64" ry="56" fill="#a99bd6"/>
    <circle cx="96" cy="84" r="11" fill="#fff"/>
    <circle cx="144" cy="84" r="11" fill="#fff"/>
    <circle cx="99" cy="87" r="5.5" fill="${INK}" stroke="none"/>
    <circle cx="141" cy="87" r="5.5" fill="${INK}" stroke="none"/>
    <path d="M80 66 L108 76 M160 66 L132 76" stroke-width="6"/>
    <ellipse cx="120" cy="152" rx="80" ry="48" fill="#c8bdf0"/>
    <ellipse cx="96" cy="136" rx="8" ry="6" fill="${INK}" stroke="none"/>
    <ellipse cx="144" cy="136" rx="8" ry="6" fill="${INK}" stroke="none"/>
    <circle cx="60" cy="152" r="10" fill="#f4a3b8" stroke="none" opacity="0.7"/>
    <circle cx="180" cy="152" r="10" fill="#f4a3b8" stroke="none" opacity="0.7"/>
    <path d="M70 170 q50 26 100 0" fill="none"/>
    <rect x="98" y="172" width="12" height="12" rx="2" fill="#fff" stroke-width="3"/>
    <rect x="130" y="172" width="12" height="12" rx="2" fill="#fff" stroke-width="3"/>
    <g class="arm">
      <path d="M172 214 C 190 180, 206 146, 214 118" fill="none" stroke-width="44"/>
      <path d="M172 214 C 190 180, 206 146, 214 118" fill="none" stroke="#a99bd6" stroke-width="35"/>
      <circle cx="216" cy="104" r="30" fill="#a99bd6"/>
      <path d="M200 84 q4 -6 8 0 M212 80 q4 -6 8 0 M224 84 q4 -6 8 0" fill="none" stroke-width="4"/>
    </g>
  </g>
</svg>`;

const CAT_PRINT = `
<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g fill="#f4a3b8" stroke="${INK}" stroke-width="6">
    <path d="M100 92 c34 0 58 34 50 58 c-6 20 -28 22 -50 22 c-22 0 -44 -2 -50 -22 c-8 -24 16 -58 50 -58 z"/>
    <ellipse cx="44" cy="80" rx="18" ry="24" transform="rotate(-20 44 80)"/>
    <ellipse cx="80" cy="44" rx="18" ry="25" transform="rotate(-6 80 44)"/>
    <ellipse cx="122" cy="44" rx="18" ry="25" transform="rotate(6 122 44)"/>
    <ellipse cx="158" cy="80" rx="18" ry="24" transform="rotate(20 158 80)"/>
  </g>
</svg>`;

const HIPPO_PRINT = `
<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g fill="#a99bd6" stroke="${INK}" stroke-width="6">
    <path d="M100 58 c48 0 74 30 72 66 c-2 38 -34 58 -72 58 c-38 0 -70 -20 -72 -58 c-2 -36 24 -66 72 -66 z"/>
    <ellipse cx="52" cy="48" rx="20" ry="17"/>
    <ellipse cx="86" cy="30" rx="20" ry="17"/>
    <ellipse cx="122" cy="30" rx="20" ry="17"/>
    <ellipse cx="154" cy="48" rx="20" ry="17"/>
  </g>
</svg>`;

export const CRITTERS = { cat: { art: CAT, print: CAT_PRINT }, hippo: { art: HIPPO, print: HIPPO_PRINT } };

export function pickCritter(pref) {
  if (pref === 'off') return null;
  if (pref === 'cat' || pref === 'hippo') return pref;
  return Math.random() < 0.5 ? 'cat' : 'hippo';
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const IMPACT_MS = 740;

/** Full-screen slap aimed at you. Returns the impact delay in ms (for sounds). */
export function slapMe(kind, title, sub, onImpact) {
  if (reduced()) { onImpact && onImpact(); return 0; }
  const c = CRITTERS[kind];
  const el = document.createElement('div');
  el.className = `slap ${kind}`;
  el.innerHTML = `
    <div class="slap-flash"></div>
    <div class="slap-print">${c.print}</div>
    <div class="slap-burst"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div>
    <div class="critter">${c.art}</div>`;
  document.body.appendChild(el);
  setTimeout(() => {
    document.body.classList.remove('slapped'); void document.body.offsetWidth;
    document.body.classList.add('slapped');
    onImpact && onImpact();
    if (navigator.vibrate) { try { navigator.vibrate([60, 30, 40]); } catch {} }
  }, IMPACT_MS);
  setTimeout(() => document.body.classList.remove('slapped'), IMPACT_MS + 500);
  setTimeout(() => el.remove(), 2600);
  return IMPACT_MS;
}

/** Mini slap next to someone's seat, for everyone watching. */
export function slapSeat(kind, seatEl, onImpact) {
  if (reduced() || !seatEl) { onImpact && onImpact(); return; }
  const ring = seatEl.querySelector('.ring') || seatEl;
  const r = ring.getBoundingClientRect();
  const flip = r.left + r.width / 2 > window.innerWidth * 0.6; // stand on the left of seats on the right side
  const el = document.createElement('div');
  el.className = `slap-mini ${kind}${flip ? ' flip' : ''}`;
  const size = Math.max(70, r.height * 1.9);
  Object.assign(el.style, {
    width: size + 'px',
    left: (flip ? r.left - size * 0.78 : r.right - size * 0.22) + 'px',
    top: (r.top + r.height / 2 - size * 0.62) + 'px',
  });
  el.innerHTML = `<div class="critter">${CRITTERS[kind].art}</div>`;
  document.body.appendChild(el);
  setTimeout(() => {
    ring.classList.remove('slapped'); void ring.offsetWidth; ring.classList.add('slapped');
    onImpact && onImpact();
  }, IMPACT_MS);
  setTimeout(() => ring.classList.remove('slapped'), IMPACT_MS + 600);
  setTimeout(() => el.remove(), 2300);
}
