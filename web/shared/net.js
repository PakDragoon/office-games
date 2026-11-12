// The connection from a game page to its room on the server (a WebSocket).
// Handles keep-alive, noticing a dead connection, reconnecting with the same tab id,
// and the hello that tells the server who this is.
import { getGuest, setGuest, getIdToken, api } from './cloud.js';

export const PROTOCOL = 1;
const PING_MS = 3000;     // answered by the server runtime itself, so it never wakes the room
const LOST_MS = 12000;    // nothing heard for this long while the tab is visible: reconnect
const RETRY_MS = [500, 1000, 2000, 3000, 5000, 8000];

/** A private id for this tab: survives a refresh, different for every tab. */
export function tabId(game) {
  const fresh = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  try {
    let id = sessionStorage.getItem(`${game}.client`);
    if (!id) { id = fresh(); sessionStorage.setItem(`${game}.client`, id); }
    return id;
  } catch { return fresh(); }
}

/**
 * handlers:
 *   hello()        -> the join message fields for this game ({ name, photo, ... }); sent on every (re)connect
 *   message(msg)   -> every message from the room
 *   reconnecting() -> the connection dropped and we're trying again
 *   gone(reason)   -> the room no longer exists (or we gave up reconnecting)
 *   failed(text)   -> couldn't connect in the first place
 */
export function createRoomLink(game, handlers) {
  let ws = null;
  let code = '';
  let heard = 0;
  let joined = false;
  let leaving = false;
  let retries = 0;
  let retryTimer = 0;
  let everJoined = false;
  const latest = new Map();   // throttled message kinds: last message waiting to go out
  const latestTimers = new Map();

  function url(params) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/${game}/ws?${new URLSearchParams(params)}`;
  }

  function open(params) {
    clearTimeout(retryTimer);
    leaving = false;
    joined = false;
    const sock = new WebSocket(url(params));
    ws = sock;
    sock.addEventListener('open', async () => {
      if (ws !== sock) return;
      heard = Date.now();
      const token = await getIdToken();
      if (ws !== sock || sock.readyState !== WebSocket.OPEN) return;
      sock.send(JSON.stringify({ t: 'join', v: PROTOCOL, client: tabId(game), guest: getGuest() || undefined, token: token || undefined, ...handlers.hello() }));
    });
    sock.addEventListener('message', (e) => {
      if (ws !== sock) return;
      heard = Date.now();
      if (e.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'guest' && msg.token) { setGuest(msg.token); return; }
      if (msg.t === 'update') { location.reload(); return; }
      if (msg.t === 'welcome') {
        joined = true;
        everJoined = true;
        retries = 0;
        code = msg.code;
      }
      if (msg.t === 'reject') {
        leaving = true;
        if (msg.gone && everJoined) { handlers.gone(msg.reason); return; }
      }
      handlers.message(msg);
    });
    sock.addEventListener('close', (e) => {
      if (ws !== sock || leaving) return;
      ws = null;
      if (e.code === 4004) { handlers.gone('The room closed.'); return; }
      if (!everJoined) { handlers.failed('Couldn’t reach the game server. Check your internet and try again.'); return; }
      retry();
    });
  }

  function retry() {
    if (leaving || !code) return;
    if (retries >= RETRY_MS.length * 2) { handlers.gone('Lost the connection to the room.'); return; }
    if (retries === 0) handlers.reconnecting();
    const wait = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
    retries++;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => open({ code }), wait);
  }

  /** Throw away a connection that has gone quiet and open a fresh one. */
  function recycle() {
    if (!ws || leaving) return;
    const old = ws;
    ws = null;
    try { old.close(4000, 'stale'); } catch {}
    retry();
  }

  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send('ping');
    if (!document.hidden && Date.now() - heard > LOST_MS) recycle();
  }, PING_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ws && joined && Date.now() - heard > LOST_MS) recycle();
  });
  window.addEventListener('pagehide', () => close());

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN && joined) ws.send(JSON.stringify(msg));
  }

  /** Send at most one message of this kind every `ms`; the newest one wins. */
  function sendLatest(kind, msg, ms) {
    latest.set(kind, msg);
    if (latestTimers.has(kind)) return;
    const flush = () => {
      const m = latest.get(kind);
      latest.delete(kind);
      if (m) {
        send(m);
        latestTimers.set(kind, setTimeout(flush, ms));
      } else {
        latestTimers.delete(kind);
      }
    };
    flush();
  }

  function close() {
    leaving = true;
    clearTimeout(retryTimer);
    if (ws) { try { ws.close(1000, 'left'); } catch {} }
    ws = null;
    code = '';
    joined = false;
    everJoined = false;
  }

  return {
    host: (isPublic = false) => { close(); everJoined = false; retries = 0; open({ create: '1', ...(isPublic ? { public: '1' } : {}) }); },
    join: (roomCode) => { close(); everJoined = false; retries = 0; code = roomCode; open({ code: roomCode }); },
    send,
    sendLatest,
    close,
    get code() { return code; },
    get connected() { return Boolean(ws && joined); },
  };
}

/** Quick Play: the code of a public room waiting for players, or null to open a new one. */
const RATED = ['flipchip', 'thulla'];

export async function quickPlay(game) {
  // Games with skill ratings say who is asking, so the server can pick a room of similar players.
  // If that fails for any reason, Quick Play still works the old way.
  if (RATED.includes(game)) {
    try { return (await api(`/api/${game}/quick`, { method: 'POST' })).code || null; } catch { /* plain request below */ }
  }
  const res = await fetch(`/api/${game}/quick`, { method: 'POST' });
  if (!res.ok) throw new Error('Quick Play isn’t available right now.');
  const data = await res.json();
  return data.code || null;
}

export async function publicRooms(game) {
  const res = await fetch(`/api/${game}/rooms`);
  if (!res.ok) return [];
  return (await res.json()).rooms || [];
}
