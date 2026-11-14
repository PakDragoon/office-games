// The old GitHub Pages addresses (pakdragoon.github.io/<game>) now redirect here and bring the
// player's saved names and settings along in the address: #carry=<base64url JSON of localStorage>.
// Imported first by every game, so it runs before anything reads localStorage. It writes only
// keys this browser doesn't have yet (something saved here is newer) and clears the fragment.

const KEEP = ['fastfingers.', 'flipchip.', 'guesstimate.', 'melonburst.', 'rotten.', 'theliar.', 'thulla-', 'wordleparty-'];
// Daily progress came from the old in-browser dailies; today's daily runs on the server
const DROP = /^(guesstimate|melonburst|rotten)\.daily|^wordleparty-signedin$/;

function decode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

(function carry() {
  const m = /^#carry=([A-Za-z0-9_-]{1,200000})$/.exec(location.hash);
  if (!m) return;
  history.replaceState(history.state, '', location.pathname + location.search);
  try {
    const data = JSON.parse(decode(m[1]));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== 'string' || value.length > 100000) continue;
      if (!KEEP.some((p) => key.startsWith(p)) || DROP.test(key)) continue;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    }
  } catch { /* storage blocked or a damaged link: start fresh */ }
})();
