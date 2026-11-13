// Sign-in and saved stats for Lettuce Party. Sign-in is shared by every game on this site
// (../../shared/cloud.js); stats are written by the server at the end of each round.
import { api, getUser, signOutUser } from '../../shared/cloud.js';

export { onUser, restore, signIn, errorText, analyticsConfigured, initAnalytics, setAnalyticsEnabled, track, mountDeleteData } from '../../shared/cloud.js';

export const currentUser = () => getUser();
export const signOut = () => signOutUser();

/** One mode's numbers: plays, wins, solved, fastest (ms), and for Counts the guesses used, for Word ladder steps and steps over par. */
function modeStats(stats, mode) {
  const n = (k) => stats[`${mode}:${k}`] || 0;
  const fast = stats[`${mode}FastestNeg`];
  return {
    plays: n('plays'), wins: n('wins'), solved: n('solved'), guessSum: n('guessSum'), steps: n('steps'), overPar: n('overPar'),
    fastest: fast ? -fast : null,
    // -0 and "no row" look alike once negated: only a stored number means a best exists
    bestOver: typeof stats.ladderBestOverNeg === 'number' && mode === 'ladder' ? -stats.ladderBestOverNeg : null,
  };
}

/** My stats (signed in, or this browser's guest id), in the shape the settings sheet shows. */
export async function loadProfile() {
  const { stats } = await api('/api/me/stats?game=lettuce-party');
  const n = (k) => stats[k] || 0;
  return {
    games: n('rounds'), wins: n('wins'), solved: n('solved'), guessSum: n('guessSum'),
    streak: n('streak'), bestStreak: Math.max(n('bestStreak'), n('streak')), bestMs: stats.fastestNeg ? -stats.fastestNeg : null,
    // Guesses needed when solved, 1 to 10 (the host can set 4 to 10 guesses a round); older stats only have 1 to 6
    dist: Array.from({ length: 10 }, (_, i) => n(`dist${i + 1}`)),
    // Counts and Word ladder keep their own numbers, apart from Classic's
    counts: modeStats(stats, 'counts'),
    ladder: modeStats(stats, 'ladder'),
    // "opener:<word>" counters, one per different first guess
    openers: Object.fromEntries(Object.entries(stats).filter(([k]) => k.startsWith('opener:')).map(([k, v]) => [k.slice(7), v])),
  };
}
