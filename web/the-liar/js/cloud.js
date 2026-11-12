// Sign-in and saved stats for The Liar. Sign-in is shared by every game on this site
// (../../shared/cloud.js); stats are written by the server at the end of each game.
import { api } from '../../shared/cloud.js';

export {
  getUser, restore, onUser, signIn, signOutUser, errorText, analyticsConfigured, initAnalytics, setAnalyticsEnabled, track, mountDeleteData,
} from '../../shared/cloud.js';

const emptyStats = () => ({ games: 0, points: 0, catches: 0, liarGames: 0, liarWins: 0, correctVotes: 0 });

/** My stats in The Liar (signed in, or this browser's guest id). */
export async function getMyStats() {
  const { stats } = await api('/api/me/stats?game=the-liar');
  return { ...emptyStats(), ...stats };
}
