// Sign-in and saved stats for Lettuce Party. Sign-in is shared by every game on this site
// (../../shared/cloud.js); stats are written by the server at the end of each round.
import { api, getUser, signOutUser } from '../../shared/cloud.js';

export { onUser, restore, signIn, errorText, analyticsConfigured, initAnalytics, setAnalyticsEnabled, track } from '../../shared/cloud.js';

export const currentUser = () => getUser();
export const signOut = () => signOutUser();

/** My stats (signed in, or this browser's guest id), in the shape the settings sheet shows. */
export async function loadProfile() {
  const { stats } = await api('/api/me/stats?game=lettuce-party');
  const n = (k) => stats[k] || 0;
  return {
    games: n('rounds'), wins: n('wins'), solved: n('solved'), guessSum: n('guessSum'),
    streak: '–', bestStreak: '–', bestMs: stats.fastestNeg ? -stats.fastestNeg : null,
    dist: [1, 2, 3, 4, 5, 6].map((i) => n(`dist${i}`)),
    openers: {},
  };
}
