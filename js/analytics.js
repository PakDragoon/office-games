// Wordle Party: Google Analytics through Firebase.
// Drop this file into js/ and add ONE line to index.html, just before </head>:
//   <script type="module" src="js/analytics.js"></script>
//
// It works on its own (it doesn't touch the game code), so it tracks visits, users,
// countries, devices and time on site. To log game events too, call from anywhere:
//   window.trackEvent('game_started', { players: 3 })
// Players can turn it off with: localStorage.setItem('wordle-analytics', 'off')

// Paste the same firebaseConfig as in js/cloud.js, including measurementId (G-...).
const firebaseConfig = {
  apiKey: '',
  authDomain: 'wordle-party-81870.firebaseapp.com',
  projectId: 'wordle-party-81870',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
  measurementId: '',
};

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const queue = [];
let ready = null;

window.trackEvent = (name, params = {}) => {
  try {
    if (ready) ready.logEvent(ready.inst, name, params);
    else if (queue.length < 50) queue.push([name, params]);
  } catch {}
};

(async () => {
  let off = false;
  try { off = localStorage.getItem('wordle-analytics') === 'off'; } catch {}
  if (off || !firebaseConfig.apiKey || !firebaseConfig.measurementId) return;
  try {
    const [appMod, A] = await Promise.all([import(FB + 'firebase-app.js'), import(FB + 'firebase-analytics.js')]);
    if (!(await A.isSupported())) return;
    // A separate, named app so it never clashes with the game's own Firebase setup.
    const app = appMod.getApps().find((a) => a.name === 'wordle-analytics') || appMod.initializeApp(firebaseConfig, 'wordle-analytics');
    ready = { inst: A.getAnalytics(app), logEvent: A.logEvent };
    queue.splice(0).forEach(([n, p]) => A.logEvent(ready.inst, n, p));
  } catch {}
})();
