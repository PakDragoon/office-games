# Analytics for Wordle Party

1. Put `js/analytics.js` into the Wordle repo's `js/` folder.
2. In Wordle's `index.html`, add this line just before `</head>`:
   ```html
   <script type="module" src="js/analytics.js"></script>
   ```
3. Open `js/analytics.js` and paste the same `firebaseConfig` as Wordle's `js/cloud.js`, including the new `measurementId` (see Thulla's README → Analytics for turning it on in Firebase).
4. Upload both files.

That tracks visits, users, countries, devices and time on site. To track game events as well, call `window.trackEvent('event_name', { ... })` from the game code.
