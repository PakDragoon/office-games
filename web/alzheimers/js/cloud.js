// Sign-in and saved stats for Alzheimer's. Sign-in is shared by every game on this site
// (../../shared/cloud.js); stats are written by the server at the end of each round.
import { api } from '../../shared/cloud.js';

export {
  getUser, restore, onUser, signIn, signOutUser, errorText, analyticsConfigured, initAnalytics, setAnalyticsEnabled, track, mountDeleteData,
} from '../../shared/cloud.js';

const emptyStats = () => ({ games: 0, wins: 0, points: 0, perfect: 0, best: 0 });

/** My stats in Alzheimer's (signed in, or this browser's guest id). */
export async function getMyStats() {
  const { stats } = await api('/api/me/stats?game=alzheimers');
  return { ...emptyStats(), ...stats };
}
