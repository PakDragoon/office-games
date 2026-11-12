// Sign-in and saved stats for Fast Fingers. Sign-in is shared by every game on this site
// (../../shared/cloud.js); room race stats are written by the server at the end of each race.
// Practice stays in this browser.
import { api } from '../../shared/cloud.js';

export {
  getUser, restore, onUser, signIn, signOutUser, errorText, analyticsConfigured, initAnalytics, setAnalyticsEnabled, track, mountDeleteData,
} from '../../shared/cloud.js';

/** My Fast Fingers stats: room races from the server, practice bests from this browser. */
export async function getMyStats() {
  const { stats } = await api('/api/me/stats?game=fast-fingers');
  const n = (k) => stats[k] || 0;
  let practiceBest = 0;
  try { practiceBest = Math.max(0, ...Object.values(JSON.parse(localStorage.getItem('fastfingers.best')) || {})); } catch { /* nothing saved */ }
  return { bestWpm: Math.max(n('bestWpm'), practiceBest), games: n('games'), wins: n('wins'), solos: '–', chars: n('chars') };
}
