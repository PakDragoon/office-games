// Sign-in and saved stats for Melon Burst. Sign-in is shared by every game on this site
// (../../shared/cloud.js); room stats are written by the server at the end of each game.
import { api } from '../../shared/cloud.js';

export {
  getUser, restore, onUser, signIn, signOutUser, errorText, analyticsConfigured, initAnalytics, setAnalyticsEnabled, track,
} from '../../shared/cloud.js';

/** My Melon Burst stats (signed in, or this browser's guest id). */
export async function getMyStats() {
  const { stats } = await api('/api/me/stats?game=melonburst');
  const n = (k) => stats[k] || 0;
  return { games: n('games'), wins: n('wins'), solved: n('solved'), points: n('points'), dailies: '–', dailySolved: '–' };
}
