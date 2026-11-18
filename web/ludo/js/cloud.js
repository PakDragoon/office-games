// Sign-in and saved stats for Ludo. Sign-in is shared by every game on this site
// (../../shared/cloud.js); stats are written by the server at the end of each game.
import { api } from '../../shared/cloud.js';

export {
  getUser, restore, onUser, signIn, signOutUser, errorText, analyticsConfigured, initAnalytics, setAnalyticsEnabled, track, mountDeleteData,
} from '../../shared/cloud.js';

const emptyStats = () => ({ games: 0, wins: 0, captures: 0, captured: 0, home: 0, sixes: 0, rolls: 0 });

/** My stats in Ludo (signed in, or this browser's guest id). */
export async function getMyStats() {
  const { stats } = await api('/api/me/stats?game=ludo');
  return { ...emptyStats(), ...stats };
}
