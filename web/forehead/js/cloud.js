// Sign-in and saved stats for Forehead. Sign-in is shared by every game on this site
// (../../shared/cloud.js); stats are written by the server at the end of each round.
import { api } from '../../shared/cloud.js';

export {
  getUser, restore, onUser, signIn, signOutUser, errorText, analyticsConfigured, initAnalytics, setAnalyticsEnabled, track, mountDeleteData,
} from '../../shared/cloud.js';

const emptyStats = () => ({ games: 0, wins: 0, guessed: 0, questions: 0, points: 0 });

/** My stats in Forehead (signed in, or this browser's guest id). `fewestQ` is missing until a first right guess. */
export async function getMyStats() {
  const { stats } = await api('/api/me/stats?game=forehead');
  return { ...emptyStats(), ...stats };
}
