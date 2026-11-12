// Sign-in and saved stats for Thulla. Sign-in is shared by every game on this site
// (../../shared/cloud.js); stats are written by the server at the end of each round.
import { api } from '../../shared/cloud.js';

export {
  getUser, restore, onUser, signIn, signOutUser, errorText, isConfigured, analyticsConfigured, initAnalytics, setAnalyticsEnabled, track,
} from '../../shared/cloud.js';

const emptyStats = () => ({ rounds: 0, losses: 0, posSum: 0, given: 0, received: 0 });

/** My Thulla stats (signed in, or this browser's guest id). */
export async function getMyStats() {
  const { stats } = await api('/api/me/stats?game=thulla');
  return { ...emptyStats(), ...stats };
}
