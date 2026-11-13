// Friends for every game: one panel (friend code, requests, friends online and where, invites, recent players),
// a connection to the player's hub on the server for online status and live invites, and the toasts.
//
// It adds itself to every game page: a "Friends" chip next to "All games" on the home screen and in the lobby, and
// invite toasts anywhere. The only thing a game does for it is that shared/net.js tells it which room the tab is in
// (roomJoined / roomLeft). Styles: friends.css (loaded from here, uses each game's own colour tokens).
//
// Friends are Google accounts only (a guest id lives in one browser). Guests can still open the panel and see their
// recent players. Online status and invites go over ONE WebSocket per tab (/api/friends/ws): the keep-alive 'ping'
// is free on the server, a 'beat' every ~100 s keeps you online, and nothing is ever sent per friend. The friends
// list itself is one HTTP request, fetched when the panel opens (and every 45 s while it stays open).
import { api, errorText, getUser, onUser, signIn } from './cloud.js';

const GAME = location.pathname.split('/').filter(Boolean)[0] || '';
const GAME_NAMES = {
  'fast-fingers': 'Fast Fingers', melonburst: 'Melon Burst', flipchip: 'Flipchip', rotten: 'Rotten', 'the-liar': 'The Liar',
  guesstimate: 'Guesstimate', thulla: 'Thulla', 'lettuce-party': 'Lettuce Party',
  forehead: 'Forehead',
  'a-to-zap': 'A to Zap',
};
const gameName = (id) => GAME_NAMES[id] || id;

const PING_MS = 30000;      // keep-alive; the server answers without waking the hub
const SILENT_MS = 75000;    // nothing heard (not even a pong) for this long: reconnect
const BEAT_MS = 100000;     // "still here"; friends see you online for ~4 minutes after the last one
const IDLE_STOP_MS = 10 * 60 * 1000;   // a tab hidden this long stops saying "still here" (and shows offline)
const RETRY_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const REFRESH_MS = 45000;   // friends list refresh while the panel is open
const INVITE_SHOW_MS = 30000;

const S = {
  user: null,          // signed-in Google account, or null
  room: null,          // { game, code } while this tab is in a room
  data: null,          // GET /api/friends
  recent: null,        // GET /api/friends/recent
  summary: { requests: 0, online: 0 },
  open: false,
  pendingCode: '',     // a friend code from a shared link, waiting to be sent
  msg: '',             // the panel's status line
  msgKind: '',
};
const hub = { ws: null, connecting: false, retries: 0, retryTimer: 0, heard: 0, pingTimer: 0, beatTimer: 0, hiddenAt: 0, stopped: false };
const pendingInvites = new Map();   // friend code -> callback(result) for the button that sent it
const chips = new Set();
let panel = null;
let refreshTimer = 0;
let lastFocus = null;
let bc = null;
try { bc = new BroadcastChannel('og-friends'); } catch { /* no cross-tab dismissing */ }

const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};

const fmtCode = (c) => (c && c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c || '');
const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

/* ============================================================ Hub connection ============================================================ */

function hubSend(msg) {
  if (hub.ws && hub.ws.readyState === WebSocket.OPEN) { hub.ws.send(JSON.stringify(msg)); return true; }
  return false;
}

function sendWhere() {
  hubSend({ t: 'where', game: S.room ? S.room.game : null, room: S.room ? S.room.code : null });
}

function stopTimers() {
  clearInterval(hub.pingTimer);
  clearInterval(hub.beatTimer);
  hub.pingTimer = hub.beatTimer = 0;
}

function hubClosed(code) {
  stopTimers();
  hub.ws = null;
  hub.connecting = false;
  for (const cb of pendingInvites.values()) cb({ ok: false, reason: 'offline-hub' });
  pendingInvites.clear();
  if (!S.user || code === 4010) return;
  if (code === 4009) { hub.stopped = true; return; }   // too many tabs: this one waits until it is looked at again
  scheduleRetry();
}

function scheduleRetry() {
  if (hub.retryTimer || !S.user) return;
  const wait = RETRY_MS[Math.min(hub.retries, RETRY_MS.length - 1)];
  hub.retries++;
  hub.retryTimer = setTimeout(() => { hub.retryTimer = 0; connectHub(); }, wait);
}

async function connectHub() {
  if (!S.user || hub.ws || hub.connecting) return;
  if (document.hidden && Date.now() - hub.hiddenAt > IDLE_STOP_MS) { hub.stopped = true; return; }
  hub.connecting = true;
  hub.stopped = false;
  const uid = S.user.uid;
  let ticket;
  try {
    ticket = (await api('/api/friends/ticket', { method: 'POST' })).ticket;
  } catch {
    hub.connecting = false;
    if (S.user && S.user.uid === uid) scheduleRetry();
    return;
  }
  if (!S.user || S.user.uid !== uid) { hub.connecting = false; return; }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/friends/ws?t=${encodeURIComponent(ticket)}`);
  hub.ws = ws;
  ws.addEventListener('open', () => {
    if (hub.ws !== ws) return;
    hub.connecting = false;
    hub.heard = Date.now();
    hub.retries = 0;
    sendWhere();
    hub.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send('ping');
      if (Date.now() - hub.heard > SILENT_MS) { try { ws.close(4000, 'silent'); } catch { /* closed */ } }
    }, PING_MS);
    hub.beatTimer = setInterval(() => {
      if (!document.hidden || Date.now() - hub.hiddenAt < IDLE_STOP_MS) hubSend({ t: 'beat' });
    }, BEAT_MS);
  });
  ws.addEventListener('message', (e) => {
    if (hub.ws !== ws) return;
    hub.heard = Date.now();
    if (e.data === 'pong') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg && typeof msg === 'object') onHubMessage(msg);
  });
  ws.addEventListener('close', (e) => { if (hub.ws === ws) hubClosed(e.code); });
  ws.addEventListener('error', () => { /* close follows */ });
}

function closeHub() {
  clearTimeout(hub.retryTimer);
  hub.retryTimer = 0;
  hub.retries = 0;
  stopTimers();
  const ws = hub.ws;
  hub.ws = null;
  hub.connecting = false;
  if (ws) { try { ws.close(1000, 'bye'); } catch { /* closed */ } }
}

function onHubMessage(msg) {
  if (msg.t === 'hello') {
    S.summary = { requests: Number(msg.requests) || 0, online: Number(msg.online) || 0 };
    paintChips();
  } else if (msg.t === 'invite') {
    showInvite(msg);
  } else if (msg.t === 'friends') {
    if (msg.why === 'request') { S.summary.requests++; toast(`${msg.name || 'Someone'} sent you a friend request`, { action: ['View', () => openPanel()] }); }
    else if (msg.why === 'accepted') toast(`${msg.name || 'Someone'} is now your friend`);
    status('');
    paintChips();
    if (S.open) loadAll();
  } else if (msg.t === 'invite-result') {
    const cb = pendingInvites.get(msg.code);
    if (cb) { pendingInvites.delete(msg.code); cb(msg); }
  }
}

/* ============================================================ What the games tell us ============================================================ */

/** shared/net.js: this tab is now in a room. */
export function roomJoined(game, code) {
  S.room = { game, code };
  sendWhere();
  paintChips();
  if (S.open) renderLists();
}

/** shared/net.js: this tab left the room (or lost it for good). */
export function roomLeft() {
  if (!S.room) return;
  S.room = null;
  sendWhere();
  paintChips();
  if (S.open) renderLists();
}

/* ============================================================ Toasts ============================================================ */

let toastBox = null;
function box() {
  if (!toastBox || !toastBox.isConnected) {
    toastBox = h('div', { class: 'fr-toasts', role: 'region', 'aria-label': 'Friend notifications', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  return toastBox;
}

function toast(text, { action, ms = 6000, key = '' } = {}) {
  const b = box();
  if (key) b.querySelectorAll(`[data-key="${key}"]`).forEach((el) => el.remove());
  const close = h('button', { class: 'fr-x', type: 'button', 'aria-label': 'Dismiss' }, '×');
  const el = h('div', { class: 'fr-toast', 'data-key': key || false }, h('span', { class: 'fr-toast-text', text }));
  if (action) el.append(h('button', { class: 'fr-btn primary small', type: 'button', onclick: () => { el.remove(); action[1](); } }, action[0]));
  el.append(close);
  const gone = () => { clearTimeout(timer); el.remove(); };
  close.addEventListener('click', gone);
  const timer = setTimeout(gone, ms);
  b.append(el);
  while (b.children.length > 4) b.firstChild.remove();
  return gone;
}

/** Someone invited me: "Sara invites you to Rotten · Join". Shown in every tab; joining in one dismisses the rest. */
function showInvite(msg) {
  const from = msg.from && typeof msg.from.name === 'string' ? msg.from.name : 'A friend';
  const game = typeof msg.game === 'string' ? msg.game : '';
  const room = typeof msg.room === 'string' ? msg.room : '';
  if (!GAME_NAMES[game] || !/^[A-Z]{4}$/.test(room)) return;
  // Already in that very room: nothing to join
  if (S.room && S.room.game === game && S.room.code === room) return;
  const key = `invite-${game}-${room}`;
  const inRoom = Boolean(S.room);
  const el = h('div', { class: 'fr-toast invite', 'data-key': key, role: 'alert' },
    h('span', { class: 'fr-toast-text' }, h('b', { text: from }), ` invites you to ${gameName(game)}`));
  const dismiss = () => { clearTimeout(timer); el.remove(); };
  const joinBtn = h('button', { class: 'fr-btn primary small', type: 'button' }, inRoom ? 'Leave & join' : 'Join');
  let sure = false;
  joinBtn.addEventListener('click', () => {
    // Joining from inside a room leaves it: ask once so a stray tap in the middle of a game does nothing
    if (inRoom && !sure) { sure = true; joinBtn.textContent = 'Tap again to leave'; setTimeout(() => { sure = false; joinBtn.textContent = 'Leave & join'; }, 4000); return; }
    if (bc) bc.postMessage({ t: 'dismiss', key });
    goToRoom(game, room);
  });
  el.append(joinBtn, h('button', { class: 'fr-x', type: 'button', 'aria-label': 'Dismiss', onclick: dismiss }, '×'));
  const b = box();
  b.querySelectorAll(`[data-key="${key}"]`).forEach((x) => x.remove());
  b.append(el);
  const timer = setTimeout(dismiss, INVITE_SHOW_MS);
}

if (bc) bc.addEventListener('message', (e) => {
  if (e.data && e.data.t === 'dismiss' && typeof e.data.key === 'string') box().querySelectorAll('[data-key]').forEach((el) => { if (el.dataset.key === e.data.key) el.remove(); });
});

function goToRoom(game, room) {
  try { sessionStorage.setItem('og.autojoin', `${game}:${room}`); } catch { /* the code is prefilled anyway */ }
  location.assign(`/${game}/?room=${room}`);
}

/* ============================================================ Panel ============================================================ */

function status(text, kind = '') {
  S.msg = text;
  S.msgKind = kind;
  const el = panel && panel.querySelector('.fr-status');
  if (el) { el.textContent = text; el.dataset.kind = kind; }
}

async function loadAll() {
  const signedIn = Boolean(S.user);
  const [friends, recent] = await Promise.allSettled([
    signedIn ? api('/api/friends') : Promise.resolve(null),
    api('/api/friends/recent'),
  ]);
  if (friends.status === 'fulfilled') {
    S.data = friends.value;
    if (S.data) S.summary = { requests: S.data.incoming.length, online: S.data.friends.filter((f) => f.online).length };
    paintChips();
  } else if (S.open) status(errorText(friends.reason), 'bad');
  if (recent.status === 'fulfilled') S.recent = recent.value;
  else if (recent.status === 'rejected' && recent.reason && recent.reason.status === 401) S.recent = { recent: [], canAdd: false };
  if (S.open) renderBody(false);
}

function copy(text, done) {
  const fallback = () => {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); done(true); } catch { done(false); }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done(true), fallback);
  else fallback();
}

/** A button that needs a second tap within 4 s (remove, block). */
function sureButton(label, then, cls = 'fr-btn small ghost') {
  let armed = false;
  let t = 0;
  const b = h('button', { class: cls, type: 'button' }, label);
  b.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      b.textContent = 'Tap again';
      b.classList.add('sure');
      t = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('sure'); }, 4000);
      return;
    }
    clearTimeout(t);
    b.disabled = true;
    then();
  });
  return b;
}

async function act(path, body, ok) {
  try {
    const r = await api(path, { method: 'POST', body });
    if (ok) status(typeof ok === 'function' ? ok(r) : ok, 'good');
  } catch (err) {
    status(err.status === 401 && err.code === 'account-required' ? 'Sign in with Google to use friends.' : errorText(err), 'bad');
  }
  await loadAll();
}

const requestMsg = (r) =>
  r.result === 'accepted' ? `You and ${r.name} are friends now.` : r.result === 'already' ? `You already have ${r.name} (or a request is waiting).` : `Request sent to ${r.name}. You’re friends once they accept.`;

function friendRow(f) {
  const where = f.online ? (f.game ? `In ${gameName(f.game)}${f.room ? ` · room ${f.room}` : ''}` : 'Online') : 'Offline';
  const row = h('li', { class: `fr-row${f.online ? ' online' : ''}` },
    h('span', { class: 'fr-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'fr-who' }, h('b', { class: 'fr-name', text: f.name }), h('span', { class: 'fr-sub', text: where })));
  const actions = h('span', { class: 'fr-actions' });
  if (f.online && f.game && f.room && !(S.room && S.room.game === f.game && S.room.code === f.room)) {
    actions.append(h('button', { class: 'fr-btn small primary', type: 'button', onclick: () => goToRoom(f.game, f.room) }, 'Join'));
  }
  if (S.room && f.online) {
    const inv = h('button', { class: 'fr-btn small', type: 'button' }, 'Invite');
    inv.addEventListener('click', () => {
      inv.disabled = true;
      inv.textContent = 'Sending…';
      const done = (res) => {
        const reason = { offline: `${f.name} isn’t online right now.`, busy: `${f.name} was just invited.`, 'slow-down': 'Slow down a little, then try again.', 'not-in-room': 'Open or join a room first.', 'not-friends': `${f.name} isn’t your friend any more.`, 'offline-hub': 'Not connected right now. Try again in a moment.' }[res.reason];
        inv.textContent = res.ok ? 'Invited ✓' : 'Invite';
        if (!res.ok) status(reason || 'Couldn’t send the invite.', 'bad'); else status(`Invite sent to ${f.name}.`, 'good');
        setTimeout(() => { inv.disabled = false; if (res.ok) inv.textContent = 'Invite'; }, res.ok ? 5000 : 800);
      };
      pendingInvites.set(f.code, done);
      setTimeout(() => { if (pendingInvites.get(f.code) === done) { pendingInvites.delete(f.code); done({ ok: false, reason: 'offline-hub' }); } }, 6000);
      if (!hubSend({ t: 'invite', code: f.code, game: S.room.game, room: S.room.code })) { pendingInvites.delete(f.code); done({ ok: false, reason: 'offline-hub' }); }
    });
    actions.append(inv);
  }
  actions.append(
    sureButton('Remove', () => act('/api/friends/remove', { code: f.code }, `${f.name} was removed.`)),
    sureButton('Block', () => act('/api/friends/block', { code: f.code }, `${f.name} was blocked.`)),
  );
  row.append(actions);
  return row;
}

function section(title, ...kids) {
  return h('section', { class: 'fr-section' }, h('h3', { text: title }), ...kids);
}

function renderLists() {
  const wrap = panel && panel.querySelector('.fr-lists');
  if (!wrap) return;
  // A button the person just pressed is about to be replaced: keep keyboard focus inside the panel
  const lost = !panel.contains(document.activeElement) || wrap.contains(document.activeElement);
  wrap.textContent = '';
  if (lost) setTimeout(() => { if (panel && !panel.contains(document.activeElement)) panel.querySelector('.fr-sheet').focus(); }, 0);
  const d = S.data;
  if (S.user && d) {
    if (d.incoming.length || d.outgoing.length) {
      const ul = h('ul', { class: 'fr-list' });
      for (const r of d.incoming) {
        ul.append(h('li', { class: 'fr-row' },
          h('span', { class: 'fr-who' }, h('b', { class: 'fr-name', text: r.name }), h('span', { class: 'fr-sub', text: 'Wants to be your friend' })),
          h('span', { class: 'fr-actions' },
            h('button', { class: 'fr-btn small primary', type: 'button', onclick: () => act('/api/friends/accept', { code: r.code }, `You and ${r.name} are friends now.`) }, 'Accept'),
            h('button', { class: 'fr-btn small ghost', type: 'button', onclick: () => act('/api/friends/decline', { code: r.code }) }, 'Decline'),
            sureButton('Block', () => act('/api/friends/block', { code: r.code }, `${r.name} was blocked.`)))));
      }
      for (const r of d.outgoing) {
        ul.append(h('li', { class: 'fr-row' },
          h('span', { class: 'fr-who' }, h('b', { class: 'fr-name', text: r.name }), h('span', { class: 'fr-sub', text: 'Request sent, waiting for them' })),
          h('span', { class: 'fr-actions' }, h('button', { class: 'fr-btn small ghost', type: 'button', onclick: () => act('/api/friends/cancel', { code: r.code }) }, 'Cancel'))));
      }
      wrap.append(section('Requests', ul));
    }
    const online = d.friends.filter((f) => f.online).length;
    const list = d.friends.length
      ? h('ul', { class: 'fr-list' }, d.friends.map(friendRow))
      : h('p', { class: 'fr-empty', text: 'No friends yet. Share your code above, or add people from Recent players below.' });
    wrap.append(section(`Friends${d.friends.length ? ` · ${online} online` : ''}`, S.room && online ? h('p', { class: 'fr-hint', text: `You’re in room ${S.room.code}. Tap Invite to ask a friend in.` }) : null, list));
  }
  const rec = S.recent;
  if (rec) {
    const ul = h('ul', { class: 'fr-list' });
    for (const r of rec.recent) {
      const sub = `${gameName(r.game)} · ${ago(r.at)}`;
      const actions = h('span', { class: 'fr-actions' });
      if (S.user) {
        if (r.status === 'none') actions.append(h('button', { class: 'fr-btn small', type: 'button', onclick: () => act('/api/friends/request', { ref: r.ref }, requestMsg) }, 'Add'));
        else if (r.status === 'in') actions.append(h('button', { class: 'fr-btn small primary', type: 'button', onclick: () => act('/api/friends/request', { ref: r.ref }, requestMsg) }, 'Accept'));
        else if (r.status === 'out') actions.append(h('span', { class: 'fr-tag', text: 'Requested' }));
        else actions.append(h('span', { class: 'fr-tag', text: 'Guest' }));
        actions.append(sureButton('Block', () => act('/api/friends/block', { ref: r.ref }, `${r.name} was hidden and blocked.`)));
      } else if (r.status === 'guest') actions.append(h('span', { class: 'fr-tag', text: 'Guest' }));
      ul.append(h('li', { class: 'fr-row' }, h('span', { class: 'fr-who' }, h('b', { class: 'fr-name', text: r.name }), h('span', { class: 'fr-sub', text: sub })), actions));
    }
    wrap.append(section('Recent players', rec.recent.length ? ul : h('p', { class: 'fr-empty', text: 'People you finish a room game with show up here.' }),
      !S.user && rec.recent.length ? h('p', { class: 'fr-hint', text: 'Sign in with Google to add them as friends.' }) : null));
  }
  if (S.user && S.data && S.data.blocked.length) {
    const ul = h('ul', { class: 'fr-list' }, S.data.blocked.map((b) => h('li', { class: 'fr-row' },
      h('span', { class: 'fr-who' }, h('b', { class: 'fr-name', text: b.name })),
      h('span', { class: 'fr-actions' }, h('button', { class: 'fr-btn small ghost', type: 'button', onclick: () => act('/api/friends/unblock', { code: b.code }, `${b.name} was unblocked.`) }, 'Unblock')))));
    wrap.append(h('details', { class: 'fr-section fr-blocked' }, h('summary', { text: `Blocked (${S.data.blocked.length})` }), ul));
  }
}

function accountBlock() {
  if (!S.user) {
    return h('section', { class: 'fr-section fr-account' },
      h('h3', { text: 'Friends need a Google account' }),
      h('p', { class: 'fr-hint', text: 'Sign in once and your friends, their online status and invites follow you into every Office Games game. Guests keep playing as before.' }),
      S.pendingCode ? h('p', { class: 'fr-hint', text: `After you sign in you can send a friend request to the code ${fmtCode(S.pendingCode)}.` }) : null,
      h('button', { class: 'fr-btn primary', type: 'button', onclick: () => signIn().catch((err) => status(errorText(err), 'bad')) }, 'Sign in with Google'));
  }
  const me = S.data && S.data.me;
  const input = h('input', { class: 'fr-input', type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '80', placeholder: 'Enter a friend code', 'aria-label': 'Friend code' });
  const send = async () => {
    // Paste a whole invite link too
    const raw = input.value.trim();
    const m = raw.match(/[?&]friend=([A-Za-z0-9-]+)/);
    const code = (m ? m[1] : raw).toUpperCase().replace(/[\s-]/g, '');
    if (!code) return;
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) { status('A friend code is 8 letters and numbers, like K7QX-92MD.', 'bad'); return; }
    await act('/api/friends/request', { code }, requestMsg);
    if (S.msgKind === 'good') input.value = '';
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  const shareUrl = me ? `${location.origin}${location.pathname}?friend=${me.code}` : '';
  const copyBtn = (label, text) => {
    const b = h('button', { class: 'fr-btn small', type: 'button' }, label);
    b.addEventListener('click', () => copy(text, (ok) => { b.textContent = ok ? 'Copied ✓' : 'Copy failed'; setTimeout(() => { b.textContent = label; }, 1800); }));
    return b;
  };
  const pending = S.pendingCode && me
    ? h('div', { class: 'fr-pending' },
      h('p', { text: `Add the friend code ${fmtCode(S.pendingCode)} from the link you opened?` }),
      h('span', { class: 'fr-actions' },
        h('button', { class: 'fr-btn small primary', type: 'button', onclick: async () => { const c = S.pendingCode; S.pendingCode = ''; await act('/api/friends/request', { code: c }, requestMsg); } }, 'Send request'),
        h('button', { class: 'fr-btn small ghost', type: 'button', onclick: () => { S.pendingCode = ''; renderBody(false); } }, 'No thanks')))
    : null;
  return h('section', { class: 'fr-section fr-account' },
    pending,
    h('h3', { text: 'Your friend code' }),
    h('div', { class: 'fr-code-row' },
      h('b', { class: 'fr-code', text: me ? fmtCode(me.code) : '········' }),
      me ? h('span', { class: 'fr-actions' }, copyBtn('Copy code', fmtCode(me.code)), copyBtn('Copy link', shareUrl)) : null),
    h('h3', { class: 'fr-add-title', text: 'Add a friend' }),
    h('div', { class: 'fr-add' }, input, h('button', { class: 'fr-btn primary', type: 'button', onclick: send }, 'Send request')));
}

function renderBody(rebuildAccount = true) {
  if (!panel) return;
  const body = panel.querySelector('.fr-body');
  if (rebuildAccount || !body.querySelector('.fr-account') || body.dataset.signed !== String(Boolean(S.user)) || S.pendingCode !== (body.dataset.pending || '')) {
    const typed = body.querySelector('.fr-input') ? body.querySelector('.fr-input').value : '';
    body.textContent = '';
    body.dataset.signed = String(Boolean(S.user));
    body.dataset.pending = S.pendingCode;
    body.append(accountBlock(), h('p', { class: 'fr-status', role: 'status', 'data-kind': S.msgKind, text: S.msg }), h('div', { class: 'fr-lists' }));
    const input = body.querySelector('.fr-input');
    if (input && typed) input.value = typed;
  }
  // the code appears once /api/friends has answered
  const code = body.querySelector('.fr-code');
  if (code && S.data && S.data.me) {
    const shown = fmtCode(S.data.me.code);
    if (code.textContent !== shown) { body.textContent = ''; renderBody(true); return; }
  }
  renderLists();
}

function buildPanel() {
  const title = h('h2', { id: 'fr-title', text: 'Friends' });
  const closeBtn = h('button', { class: 'fr-x big', type: 'button', 'aria-label': 'Close friends', onclick: closePanel }, '×');
  const sheet = h('div', { class: 'fr-sheet', role: 'dialog', tabindex: '-1', 'aria-modal': 'true', 'aria-labelledby': 'fr-title' },
    h('header', { class: 'fr-head' }, title, closeBtn), h('div', { class: 'fr-body' }));
  const back = h('div', { class: 'fr-back', onclick: (e) => { if (e.target === back) closePanel(); } }, sheet);
  back.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closePanel(); return; }
    if (e.key !== 'Tab') return;
    const f = [...sheet.querySelectorAll('button:not([disabled]), input, summary')].filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
  return back;
}

export function openPanel() {
  if (S.open) return;
  S.open = true;
  lastFocus = document.activeElement;
  panel = buildPanel();
  document.body.append(panel);
  document.body.classList.add('fr-lock');
  renderBody(true);
  panel.querySelector('.fr-x').focus();
  loadAll();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (!document.hidden && S.user) loadAll(); }, REFRESH_MS);
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.open) closePanel(); });

export function closePanel() {
  if (!S.open) return;
  S.open = false;
  clearInterval(refreshTimer);
  if (panel) panel.remove();
  panel = null;
  document.body.classList.remove('fr-lock');
  if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch { /* gone */ } }
}

/* ============================================================ Chips ============================================================ */

const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c.4-3.2 2.7-5 6-5s5.6 1.8 6 5"/><circle cx="17" cy="9.5" r="2.4"/><path d="M16.5 14.2c2.6 0 4.2 1.4 4.5 4"/></svg>';

function paintChips() {
  for (const chip of chips) {
    const lobby = chip.classList.contains('in-lobby');
    const label = chip.querySelector('.fr-chip-label');
    label.textContent = lobby ? 'Invite friends' : 'Friends';
    const badge = chip.querySelector('.fr-badge');
    const n = S.summary.requests > 0 ? S.summary.requests : S.summary.online;
    badge.hidden = !(S.user && n > 0);
    badge.textContent = String(n);
    badge.classList.toggle('req', S.summary.requests > 0);
    chip.setAttribute('aria-label', `Friends${S.user && S.summary.requests ? `, ${S.summary.requests} request${S.summary.requests === 1 ? '' : 's'}` : S.user && S.summary.online ? `, ${S.summary.online} online` : ''}`);
  }
}

function makeChip(lobby) {
  const chip = h('button', { class: `friends-chip${lobby ? ' in-lobby' : ''}`, type: 'button', onclick: () => openPanel() });
  chip.innerHTML = `${ICON}<span class="fr-chip-label"></span><span class="fr-badge" hidden></span>`;
  chips.add(chip);
  return chip;
}

function placeNextTo(allGames, chip) {
  const put = () => {
    if (!allGames.isConnected) return;
    const w = allGames.offsetWidth;
    if (!w) return;   // its screen is hidden right now
    chip.style.left = `${allGames.offsetLeft + w + 8}px`;
    chip.style.top = getComputedStyle(allGames).top;
  };
  put();
  if ('ResizeObserver' in window) new ResizeObserver(put).observe(allGames);
  window.addEventListener('resize', put);
  document.fonts?.ready.then(put);
}

function inject() {
  if (document.querySelector('.friends-chip')) return;
  const css = h('link', { rel: 'stylesheet', href: new URL('./friends.css', import.meta.url).href });
  document.head.append(css);
  for (const ag of document.querySelectorAll('.all-games')) {
    const chip = makeChip(false);
    ag.after(chip);
    placeNextTo(ag, chip);
  }
  for (const lobby of document.querySelectorAll('.screen.lobby')) lobby.prepend(makeChip(true));
  paintChips();
}

/* ============================================================ Start ============================================================ */

/** An invite's Join (or a friend's Join) lands on /<game>/?room=CODE: join for them when their name is already set. */
function autoJoin() {
  let want = '';
  try { want = sessionStorage.getItem('og.autojoin') || ''; sessionStorage.removeItem('og.autojoin'); } catch { /* */ }
  const room = new URLSearchParams(location.search).get('room') || '';
  if (!want || want !== `${GAME}:${room.toUpperCase()}`) return;
  const name = document.getElementById('name-input');
  const join = document.getElementById('join-btn');
  if (name && join && name.value.trim()) setTimeout(() => join.click(), 50);
}

function readFriendLink() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('friend') || '').toUpperCase().replace(/[\s-]/g, '');
  if (!params.has('friend')) return;
  if (/^[A-HJ-NP-Z2-9]{8}$/.test(code)) S.pendingCode = code;
  params.delete('friend');
  const qs = params.toString();
  try { history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`); } catch { /* */ }
}

readFriendLink();

onUser((u) => {
  const was = S.user ? S.user.uid : null;
  S.user = u;
  if ((u ? u.uid : null) === was) return;
  S.data = null;
  S.summary = { requests: 0, online: 0 };
  closeHub();
  if (u) connectHub();
  paintChips();
  if (S.open) { loadAll(); renderBody(true); }
  if (u && S.pendingCode && !S.open) openPanel();
});
S.user = getUser();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hub.hiddenAt = Date.now(); return; }
  if (!S.user) return;
  if (!hub.ws && !hub.connecting) { clearTimeout(hub.retryTimer); hub.retryTimer = 0; hub.retries = 0; connectHub(); }
  else hubSend({ t: 'beat' });
});
window.addEventListener('pagehide', closeHub);
// Back/forward cache: the page comes back alive but the connection was closed on the way out
window.addEventListener('pageshow', (e) => { if (e.persisted && S.user && !hub.ws) connectHub(); });

function start() {
  inject();
  // The game fills in the saved name when its own script runs, which is after this one: wait for the page to finish loading
  if (document.readyState === 'complete') autoJoin(); else window.addEventListener('load', autoJoin);
  // A shared friend link: open the panel so the person can confirm (they sign in first if they need to)
  if (S.pendingCode) setTimeout(() => openPanel(), 300);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
