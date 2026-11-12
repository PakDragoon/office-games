// How skill ratings look, the same in every game that has them.
// A "?" after the number means it is still settling (the first handful of games, or a long break).

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const ratingLabel = (rating, provisional) => (rating == null ? '' : `${rating}${provisional ? '?' : ''}`);

export const deltaLabel = (d) => (d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '±0');

/** A small muted rating next to a name; empty when this player has none. */
export function ratingChip(rating, provisional) {
  if (rating == null) return '';
  return `<span class="rt" title="Skill rating${provisional ? ' (still settling)' : ''}">${esc(ratingLabel(rating, provisional))}</span>`;
}

/** "+12" in green or "−8" in red. */
export function deltaChip(d) {
  if (d == null) return '';
  return `<span class="rt-delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${deltaLabel(d)}</span>`;
}

/** The line in a stats panel. */
export function myRatingHTML(info) {
  if (!info) return '';
  const n = info.games;
  return `<p class="my-rating"><b>${esc(ratingLabel(info.rating, info.provisional))}</b><span>Skill rating · ${n ? `${n} rated game${n === 1 ? '' : 's'}` : 'no rated games yet'}</span></p>
    <p class="rating-note">${info.provisional ? 'The ? means it is still settling. It firms up over your first games. ' : ''}Only finished games with other people count; games against the computer never do.</p>`;
}
