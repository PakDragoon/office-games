// The friends API (/api/friends/...). Anything that changes who is friends with whom needs a Google account;
// "recent players" also works for guests.
import type { Env } from './env';
import { makeTicket, verifyFirebase, verifyGuest, verifyTicket } from './auth';
import { cleanName } from './core/util';
import {
  acceptFriend, blockPlayer, dropLink, ensureProfile, friendList, normalizeCode, recentList, requestFriend, unblockPlayer,
  type FriendState,
} from './db/friends';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const DEV_SECRET = 'dev-only-secret-change-me';

interface Who {
  /** The Google account behind the request, if the token checks out. */
  user: { id: string; name: string } | null;
  guest: string | null;
}

async function who(request: Request, env: Env): Promise<Who> {
  const auth = request.headers.get('Authorization') || '';
  const fb = auth.startsWith('Bearer ') ? await verifyFirebase(auth.slice(7), env.FIREBASE_PROJECT) : null;
  if (fb) return { user: { id: `u:${fb.uid}`, name: cleanName(fb.name, 20) || 'Player' }, guest: null };
  const g = await verifyGuest(request.headers.get('X-Guest'), env.SERVER_SECRET || DEV_SECRET);
  return { user: null, guest: g ? `g:${g}` : null };
}

const needAccount = () => json({ error: 'Sign in with Google to use friends.', code: 'account-required' }, 401);

async function body(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('Content-Length') || 0) > 512) return {};
  try {
    const text = await request.text();
    const parsed: unknown = text.length <= 512 ? JSON.parse(text) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Ask a player's Hub to tell their open tabs something changed. Best effort, never blocks the answer. */
function ping(env: Env, ctx: ExecutionContext, id: string, why: 'request' | 'accepted' | 'removed', name: string): void {
  ctx.waitUntil(
    env.HUB.get(env.HUB.idFromName(id)).notify(why, name).catch((err: unknown) => console.error('hub notify failed', err)),
  );
}

/** `rest` is what follows /api/friends/ (empty for the list itself). */
export async function friendsApi(request: Request, env: Env, ctx: ExecutionContext, rest: string): Promise<Response> {
  const me = await who(request, env);

  if (rest === 'recent' && request.method === 'GET') {
    const id = me.user?.id ?? me.guest;
    if (!id) return json({ error: 'not signed in' }, 401);
    return json({ recent: await recentList(env.DB, id), canAdd: Boolean(me.user) });
  }

  if (!me.user) return needAccount();
  const id = me.user.id;
  const myName = me.user.name;

  if (rest === '' && request.method === 'GET') {
    const profile = await ensureProfile(env.DB, id, me.user.name);
    return json(await friendList(env.DB, id, profile));
  }

  if (rest === 'ticket' && request.method === 'POST') {
    await ensureProfile(env.DB, id, me.user.name);
    return json({ ticket: await makeTicket(env.SERVER_SECRET || DEV_SECRET, id) });
  }

  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const b = await body(request);
  const code = normalizeCode(b.code);
  const ref = typeof b.ref === 'string' ? b.ref : '';

  if (rest === 'request') {
    await ensureProfile(env.DB, id, myName);
    if (!code && !ref) return json({ error: 'That doesn’t look like a friend code. It has 8 letters and numbers.', code: 'no-code' }, 400);
    const out = await requestFriend(env.DB, id, code ? { code } : { ref });
    if (!out.ok) return json({ error: out.error, code: out.code }, out.code === 'limit' ? 429 : 400);
    if (out.result === 'sent') ping(env, ctx, out.other, 'request', myName);
    if (out.result === 'accepted') ping(env, ctx, out.other, 'accepted', myName);
    return json({ ok: true, result: out.result, name: out.otherName });
  }

  const simple = async (
    run: () => Promise<{ ok: true; other: string; otherName: string } | { ok: false; error: string }>,
    tell?: 'accepted' | 'removed',
  ) => {
    const out = await run();
    if (!out.ok) return json({ error: out.error }, 400);
    if (tell) ping(env, ctx, out.other, tell, myName);
    return json({ ok: true, name: out.otherName });
  };
  const need = (states: FriendState[], tell?: 'removed') => {
    if (!code) return json({ error: 'Missing friend code.' }, 400);
    return simple(() => dropLink(env.DB, id, code, states), tell);
  };

  if (rest === 'accept') return code ? simple(() => acceptFriend(env.DB, id, code), 'accepted') : json({ error: 'Missing friend code.' }, 400);
  if (rest === 'decline') return need(['in']);
  if (rest === 'cancel') return need(['out']);
  if (rest === 'remove') return need(['friend'], 'removed');
  if (rest === 'block') return code || ref ? simple(() => blockPlayer(env.DB, id, code ? { code } : { ref }), 'removed') : json({ error: 'Missing friend code.' }, 400);
  if (rest === 'unblock') return code ? simple(() => unblockPlayer(env.DB, id, code)) : json({ error: 'Missing friend code.' }, 400);
  return json({ error: 'not found' }, 404);
}

/** GET /api/friends/ws?t=<ticket>: the player's Hub. */
export async function hubSocket(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
  const player = await verifyTicket(env.SERVER_SECRET || DEV_SECRET, new URL(request.url).searchParams.get('t'));
  if (!player) return new Response('Bad ticket', { status: 401 });
  const headers = new Headers(request.headers);
  headers.set('X-Player', player);
  return env.HUB.get(env.HUB.idFromName(player)).fetch(new Request(request.url, { headers, method: 'GET' }));
}
