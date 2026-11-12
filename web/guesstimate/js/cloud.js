// Sign-in and saved stats for Guesstimate. Sign-in is shared by every game on this site
// (../../shared/cloud.js); stats are written by the server (room games and the daily).
import { api } from '../../shared/cloud.js';
import { KINDS } from './rounds.js';

export {
  getUser, restore, onUser, signIn, signOutUser, errorText, analyticsConfigured, initAnalytics, setAnalyticsEnabled, track, api,
} from '../../shared/cloud.js';

/** My Guesstimate stats (signed in, or this browser's guest id), in the shape the settings sheet shows. */
export async function getMyStats() {
  const { stats } = await api('/api/me/stats?game=guesstimate');
  const n = (k) => stats[k] || 0;
  return {
    games: n('games'), wins: n('wins'), points: n('points'), rounds: n('rounds'),
    dailies: n('dailies'), streak: '–', bestDaily: n('bestDaily'),
    kinds: Object.fromEntries(KINDS.map((k) => [k, { points: n(`${k}Points`), rounds: n(`${k}Rounds`) }])),
  };
}
