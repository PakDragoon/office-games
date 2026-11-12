// Sign-in and saved stats for Melon Burst. Sign-in is shared by every game on this site
// (../../shared/cloud.js); room stats are written by the server at the end of each game.
import { api } from '../../shared/cloud.js';
import { dailyParts, formatMs } from './engine.js';

export {
  api, getUser, restore, onUser, signIn, signOutUser, errorText, analyticsConfigured, initAnalytics, setAnalyticsEnabled, track,
} from '../../shared/cloud.js';

/** My Melon Burst stats (signed in, or this browser's guest id). */
export async function getMyStats() {
  const { stats } = await api('/api/me/stats?game=melonburst');
  const n = (k) => stats[k] || 0;
  return { games: n('games'), wins: n('wins'), solved: n('solved'), points: n('points'), dailies: n('dailies'), bestDaily: bestDaily(n('bestDaily')) };
}

// bestDaily is the board score (see engine.dailyScore); 0 means no daily yet
function bestDaily(score) {
  if (!score) return '–';
  const p = dailyParts(score);
  return p.solved ? `${p.wrong} wrong, ${formatMs(p.ms)}` : 'burst';
}
