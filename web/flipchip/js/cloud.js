// Sign-in and saved stats for Flipchip. Sign-in is shared by every game on this site
// (../../shared/cloud.js); room stats are written by the server at the end of each game.
// Games against the computer stay in this browser (they never reach a leaderboard).
import { api } from '../../shared/cloud.js';

export {
  getUser, restore, onUser, signIn, signOutUser, errorText, analyticsConfigured, initAnalytics, setAnalyticsEnabled, track, mountDeleteData,
} from '../../shared/cloud.js';

function cpuRecord() {
  let rec = {};
  try { rec = JSON.parse(localStorage.getItem('flipchip.record')) || {}; } catch { /* nothing saved */ }
  const levels = ['easy', 'normal', 'hard'];
  let games = 0;
  let wins = 0;
  let best = 0;
  levels.forEach((l, i) => {
    const r = rec[l] || {};
    games += (r.w || 0) + (r.l || 0) + (r.d || 0);
    wins += r.w || 0;
    if (r.w) best = i + 1;
  });
  return { cpuGames: games, cpuWins: wins, cpuBest: best };
}

/** My Flipchip stats: room games from the server, games against the computer from this browser. */
export async function getMyStats() {
  const { stats, rating } = await api('/api/me/stats?game=flipchip');
  const n = (k) => stats[k] || 0;
  return { games: n('games'), wins: n('wins'), draws: n('draws'), rating: rating || null, ...cpuRecord() };
}
