import type { Env } from './env';
import { GAMES } from './games';
import { CODE_RE, randomCode } from './core/util';
import { newGuest, verifyFirebase, verifyGuest } from './auth';
import { crewTable, deletePlayer, mergePlayer, playerKey, playerStats } from './db/stats';
import { RATED_GAMES, ratingFor } from './db/ratings';
import { handleDaily, rollDaily } from './daily';
import { isReplayId, pruneReplays, replayStore } from './db/replays';
import { PRACTICE, practiceAllowed, recordPractice } from './practice';

export { GameRoom } from './do/GameRoom';
export { Lobby } from './do/Lobby';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** Open a new room: try random codes until one is free. */
async function createRoom(env: Env, game: string, isPublic: boolean): Promise<string | null> {
  for (let i = 0; i < 8; i++) {
    const code = randomCode();
    const stub = env.ROOMS.get(env.ROOMS.idFromName(`${game}:${code}`));
    if (await stub.claim(game, code, isPublic)) return code;
  }
  return null;
}

async function roomSocket(request: Request, env: Env, game: string): Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
  const url = new URL(request.url);
  let code = (url.searchParams.get('code') || '').toUpperCase();
  if (url.searchParams.get('create') === '1') {
    const made = await createRoom(env, game, url.searchParams.get('public') === '1');
    if (!made) return new Response('Could not open a room', { status: 503 });
    code = made;
  }
  if (!CODE_RE.test(code)) return new Response('Bad room code', { status: 400 });
  const stub = env.ROOMS.get(env.ROOMS.idFromName(`${game}:${code}`));
  const headers = new Headers(request.headers);
  headers.set('X-Room-Code', code);
  return stub.fetch(new Request(request.url, { headers, method: 'GET' }));
}

/** The player behind a request: a Firebase ID token (Authorization: Bearer) or a guest token (X-Guest). */
async function requestPlayer(request: Request, env: Env): Promise<string | null> {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const user = await verifyFirebase(auth.slice(7), env.FIREBASE_PROJECT);
    if (user) return playerKey(user.uid, null);
  }
  const guest = await verifyGuest(request.headers.get('X-Guest'), env.SERVER_SECRET || 'dev-only-secret-change-me');
  return guest ? playerKey(null, guest) : null;
}

/**
 * Both identities a request may carry. `user` / `guest` are player ids ("u:..." / "g:..."), or null when that
 * credential is missing or doesn't check out. `badUser` / `badGuest` say a credential WAS sent but is no good.
 */
async function requestIdentities(request: Request, env: Env) {
  const auth = request.headers.get('Authorization') || '';
  const guestToken = request.headers.get('X-Guest');
  const firebase = auth.startsWith('Bearer ') ? await verifyFirebase(auth.slice(7), env.FIREBASE_PROJECT) : null;
  const guestId = guestToken ? await verifyGuest(guestToken, env.SERVER_SECRET || 'dev-only-secret-change-me') : null;
  return {
    user: firebase ? playerKey(firebase.uid, null) : null,
    guest: guestId ? playerKey(null, guestId) : null,
    badUser: auth.startsWith('Bearer ') && !firebase,
    badGuest: Boolean(guestToken) && !guestId,
  };
}

async function api(request: Request, env: Env, parts: string[]): Promise<Response> {
  const [, area, a, b] = parts;   // ["api", area, ...]
  if (area === 'guest' && request.method === 'POST') {
    // A signed guest id for someone who hasn't joined a room yet (daily puzzles, stats)
    const { token } = await newGuest(env.SERVER_SECRET || 'dev-only-secret-change-me');
    return json({ token });
  }
  if (area === 'me' && a === 'stats' && request.method === 'GET') {
    const game = new URL(request.url).searchParams.get('game') || '';
    if (!GAMES[game]) return json({ error: 'unknown game' }, 404);
    const player = await requestPlayer(request, env);
    if (!player) return json({ error: 'not signed in' }, 401);
    const [stats, rating] = await Promise.all([playerStats(env.DB, player, game), ratingFor(env.DB, game, player)]);
    return json({ stats, rating });
  }
  if (area === 'me' && a === 'merge' && request.method === 'POST') {
    // A guest signed in with Google: move the guest's stats to the account. Needs BOTH proofs: a Firebase token for the
    // account and a guest token (only this server can sign one, so nobody can claim someone else's guest stats).
    const who = await requestIdentities(request, env);
    if (!who.user) return json({ error: 'not signed in', code: 'bad-user' }, 401);
    if (!who.guest) return json({ error: 'no valid guest to merge', code: 'bad-guest' }, 401);
    await mergePlayer(env.DB, who.guest, who.user);
    return json({ ok: true });
  }
  if (area === 'me' && !a && request.method === 'DELETE') {
    // Delete my data: the account and/or the guest this request proves. Both are deleted when both are sent.
    // A Google token that doesn't check out is refused (not ignored), so nobody thinks the account went when it didn't.
    const who = await requestIdentities(request, env);
    if (who.badUser) return json({ error: 'not signed in', code: 'bad-user' }, 401);
    const ids = [who.user, who.guest].filter((id): id is string => Boolean(id));
    if (!ids.length) return json({ error: 'not signed in', code: 'bad-guest' }, 401);
    await deletePlayer(env.DB, ids);
    return json({ ok: true });
  }
  const game = area;
  if (!GAMES[game]) return json({ error: 'unknown game' }, 404);
  const lobby = () => env.LOBBY.get(env.LOBBY.idFromName(game));
  if (a === 'rooms' && request.method === 'GET') return json({ rooms: await lobby().list() });
  if (a === 'quick' && request.method === 'POST') {
    // Rated games match by rating when the browser says who it is (no identity: the fullest room, as before)
    let seeker: { rating: number; rd: number } | null = null;
    if (RATED_GAMES.has(game)) {
      const me = await ratingFor(env.DB, game, await requestPlayer(request, env));
      if (me) seeker = { rating: me.rating, rd: me.rd };
    }
    const code = await lobby().quickPlay(seeker);
    return json(code ? { code } : { create: true });
  }
  if (a === 'crew' && request.method === 'GET') {
    const name = new URL(request.url).searchParams.get('name') || '';
    const table = await crewTable(env.DB, game, name);
    return table ? json(table) : json({ error: 'no such crew' }, 404);
  }
  if (a === 'replay' && request.method === 'GET') {
    const found = b && isReplayId(b) ? await replayStore(env.DB).get(game, b) : null;
    if (!found) return json({ error: 'no such replay' }, 404);
    // The link is the secret; the content never changes, so browsers may keep it for a while
    return new Response(JSON.stringify({ replay: found.payload, createdAt: found.createdAt }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    });
  }
  if (a === 'practice' && request.method === 'POST') {
    if (!PRACTICE[game]) return json({ error: 'no practice stats for this game' }, 404);
    const player = await requestPlayer(request, env);
    if (!player) return json({ error: 'not signed in' }, 401);
    if (Number(request.headers.get('Content-Length') || 0) > 512) return json({ error: 'too big' }, 413);
    if (!practiceAllowed(player)) return json({ error: 'too fast' }, 429);
    const text = await request.text();
    let body: unknown = null;
    try { body = text.length <= 512 ? JSON.parse(text) : null; } catch { /* invalid */ }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid' }, 400);
    return (await recordPractice(env.DB, player, game, body as Record<string, unknown>)) === 'ok' ? json({ ok: true }) : json({ error: 'invalid' }, 400);
  }
  if (a === 'daily') return handleDaily(request, env, game, b, requestPlayer);
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 2 && parts[1] === 'ws' && GAMES[parts[0]]) return roomSocket(request, env, parts[0]);
    if (parts[0] === 'api') {
      try {
        return await api(request, env, parts);
      } catch (err) {
        console.error('api error', url.pathname, err);
        return json({ error: 'server error' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env): Promise<void> {
    try {
      await rollDaily(env);
    } finally {
      await pruneReplays(env.DB);
    }
  },
} satisfies ExportedHandler<Env>;
