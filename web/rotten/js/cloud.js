// Sign-in and saved stats for Rotten. Sign-in is shared by every game on this site
// (../../shared/cloud.js); stats are written by the server at the end of each game.
import { api, getUser } from '../../shared/cloud.js';

export {
  getUser, restore, onUser, signIn, signOutUser, errorText, analyticsConfigured, initAnalytics, setAnalyticsEnabled, track,
} from '../../shared/cloud.js';
export { api };

const emptyStats = () => ({ plays: 0, games: 0, wins: 0, words: 0, splats: 0, longest: 0, dailies: 0, bestDaily: 0 });

/** My Rotten stats (signed in, or this browser's guest id). */
export async function getMyStats() {
  const { stats } = await api('/api/me/stats?game=rotten');
  return { ...emptyStats(), ...stats };
}

export const signedIn = () => Boolean(getUser());
