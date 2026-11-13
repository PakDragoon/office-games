// Sign-in and saved stats for A to Zap. Sign-in is shared by every game on this site (../../shared/cloud.js);
// stats are written by the server at the end of each game.
import { api } from '../../shared/cloud.js';

export {
  getUser, restore, onUser, signIn, signOutUser, errorText, analyticsConfigured, initAnalytics, setAnalyticsEnabled, track, mountDeleteData,
} from '../../shared/cloud.js';

/** My A to Zap stats from the server (signed in, or this browser's guest id). */
export async function getMyStats() {
  const { stats } = await api('/api/me/stats?game=a-to-zap');
  const n = (k) => stats[k] || 0;
  return { games: n('games'), wins: n('wins'), rounds: n('rounds'), points: n('points'), unique: n('unique'), bestRound: n('bestRound') };
}
