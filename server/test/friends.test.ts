import { SELF, env } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeTicket, newGuest, verifyTicket } from '../src/auth';
import type { GameReport } from '../src/core/game';
import { LIMITS, ONLINE_MS, normalizeCode, requestFriend } from '../src/db/friends';
import { deletePlayer, mergePlayer, recordGame } from '../src/db/stats';
import { TestClient, sleep, type Msg } from './helpers';

/* Signed-in players without Google: real Firebase-shaped tokens signed with our own key (same trick as account.test.ts). */
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let privateKey: CryptoKey;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url === JWKS_URL) return Promise.resolve(new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } }));
    return realFetch(input as RequestInfo, init);
  });
});
afterAll(() => vi.restoreAllMocks());

const idToken = (uid: string, name = 'Sam') =>
  new SignJWT({ name })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(uid)
    .setIssuer(`https://securetoken.google.com/${env.FIREBASE_PROJECT}`)
    .setAudience(env.FIREBASE_PROJECT)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);

interface Person {
  uid: string;
  id: string;
  name: string;
  token: string;
}
let n = 0;
const person = async (name: string): Promise<Person> => {
  const uid = `fr${++n}x${Math.random().toString(36).slice(2, 8)}`;
  return { uid, id: `u:${uid}`, name, token: await idToken(uid, name) };
};
const guest = async () => {
  const g = await newGuest('test-secret');
  return { id: `g:${g.id}`, token: g.token };
};

const api = async (p: Person | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
  const headers: Record<string, string> = { ...extra };
  if (p) headers.Authorization = `Bearer ${p.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await SELF.fetch(`https://play.test/api/friends${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as Record<string, any> };
};
const list = async (p: Person) => (await api(p, 'GET', '')).data as {
  me: { code: string; name: string };
  friends: Array<{ code: string; name: string; online: boolean; game: string; room: string }>;
  incoming: Array<{ code: string; name: string }>;
  outgoing: Array<{ code: string; name: string }>;
  blocked: Array<{ code: string; name: string }>;
};
const codeOf = async (p: Person) => (await list(p)).me.code;

/** a and b become friends. */
const befriend = async (a: Person, b: Person) => {
  const code = await codeOf(b);
  await api(a, 'POST', '/request', { code });
  await api(b, 'POST', '/accept', { code: await codeOf(a) });
};

const count = async (table: string, col: string, id: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?1`).bind(id).first<{ n: number }>())?.n ?? 0;

describe('friend codes and the list', () => {
  it('gives a Google account a stable code and its Google name', async () => {
    const a = await person('Ana');
    const first = await list(a);
    expect(first.me.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(first.me.name).toBe('Ana');
    expect((await list(a)).me.code).toBe(first.me.code);
    expect(first).toMatchObject({ friends: [], incoming: [], outgoing: [], blocked: [] });
  });

  it('is for Google accounts only: a guest gets 401, a forged guest too', async () => {
    const g = await guest();
    for (const path of ['', '/ticket', '/request', '/accept', '/block']) {
      const method = path === '' ? 'GET' : 'POST';
      const res = await api(null, method, path, method === 'GET' ? undefined : {}, { 'X-Guest': g.token });
      expect(res.status, path).toBe(401);
      expect(res.data.code).toBe('account-required');
    }
    expect((await api(null, 'GET', '/recent', undefined, { 'X-Guest': 'g_forged.AAAA' })).status).toBe(401);
    expect((await api(null, 'GET', '/recent')).status).toBe(401);
  });

  it('cleans the name (HTML stripped, rude names become Player)', async () => {
    const a = await person('<b>Cleo</b>');
    expect((await list(a)).me.name).toBe('bCleo/b');
    const rude = await person('fuck face');
    expect((await list(rude)).me.name).toBe('Player');
  });

  it('normalizes typed codes', () => {
    expect(normalizeCode('k7qx-92md')).toBe('K7QX92MD');
    expect(normalizeCode(' K7QX 92MD ')).toBe('K7QX92MD');
    expect(normalizeCode('K7QX92M')).toBe('');
    expect(normalizeCode('K7QX92M0')).toBe(''); // 0 is not in the alphabet
    expect(normalizeCode(null)).toBe('');
  });
});

describe('requests, accept, decline, cancel, remove', () => {
  it('request -> incoming for them, outgoing for me -> accept -> friends both ways', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    const res = await api(a, 'POST', '/request', { code: await codeOf(b) });
    expect(res.data).toMatchObject({ ok: true, result: 'sent', name: 'Ben' });
    expect((await list(a)).outgoing.map((r) => r.name)).toEqual(['Ben']);
    expect((await list(b)).incoming.map((r) => r.name)).toEqual(['Ana']);
    expect((await list(a)).friends).toEqual([]);
    // only the person asked can accept
    expect((await api(a, 'POST', '/accept', { code: await codeOf(b) })).status).toBe(400);
    expect((await api(b, 'POST', '/accept', { code: await codeOf(a) })).status).toBe(200);
    expect((await list(a)).friends.map((f) => f.name)).toEqual(['Ben']);
    expect((await list(b)).friends.map((f) => f.name)).toEqual(['Ana']);
    expect((await list(b)).incoming).toEqual([]);
    expect((await list(a)).outgoing).toEqual([]);
  });

  it('never shows a player id, only names and codes', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await befriend(a, b);
    const text = JSON.stringify(await list(a));
    expect(text).not.toContain(b.uid);
    expect(text).not.toContain('u:');
  });

  it('two people asking each other at once end up as friends', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await api(a, 'POST', '/request', { code: await codeOf(b) });
    const res = await api(b, 'POST', '/request', { code: await codeOf(a) });
    expect(res.data.result).toBe('accepted');
    expect((await list(a)).friends).toHaveLength(1);
    expect((await list(b)).friends).toHaveLength(1);
  });

  it('asking twice, or someone already a friend, changes nothing', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    const code = await codeOf(b);
    await api(a, 'POST', '/request', { code });
    expect((await api(a, 'POST', '/request', { code })).data.result).toBe('already');
    expect((await list(b)).incoming).toHaveLength(1);
    await api(b, 'POST', '/accept', { code: await codeOf(a) });
    expect((await api(a, 'POST', '/request', { code })).data.result).toBe('already');
  });

  it('rejects your own code, an unknown code and rubbish', async () => {
    const a = await person('Ana');
    expect((await api(a, 'POST', '/request', { code: await codeOf(a) })).data.code).toBe('self');
    expect((await api(a, 'POST', '/request', { code: 'AAAAAAAA' })).data.code).toBe('no-code');
    expect((await api(a, 'POST', '/request', { code: 'hello' })).status).toBe(400);
    expect((await api(a, 'POST', '/request', {})).status).toBe(400);
  });

  it('decline, cancel and remove clean up both sides', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    const c = await person('Cy');
    await api(a, 'POST', '/request', { code: await codeOf(b) });
    expect((await api(b, 'POST', '/decline', { code: await codeOf(a) })).status).toBe(200);
    expect((await list(a)).outgoing).toEqual([]);
    expect((await list(b)).incoming).toEqual([]);
    await api(a, 'POST', '/request', { code: await codeOf(c) });
    expect((await api(a, 'POST', '/cancel', { code: await codeOf(c) })).status).toBe(200);
    expect((await list(c)).incoming).toEqual([]);
    await befriend(a, b);
    // you can't "cancel" or "decline" a friendship, only remove it
    expect((await api(a, 'POST', '/cancel', { code: await codeOf(b) })).status).toBe(400);
    expect((await api(a, 'POST', '/remove', { code: await codeOf(b) })).status).toBe(200);
    expect((await list(a)).friends).toEqual([]);
    expect((await list(b)).friends).toEqual([]);
    expect((await api(a, 'POST', '/remove', { code: await codeOf(b) })).status).toBe(400);
  });
});

describe('blocking', () => {
  it('block ends the friendship, the blocked person can still "send" a request but it goes nowhere', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await befriend(a, b);
    expect((await api(a, 'POST', '/block', { code: await codeOf(b) })).status).toBe(200);
    expect((await list(a)).friends).toEqual([]);
    expect((await list(a)).blocked.map((x) => x.name)).toEqual(['Ben']);
    expect((await list(b)).friends).toEqual([]);
    // Ben asks Ana: looks fine to Ben, but Ana never sees it and Ben has no pending row
    const res = await api(b, 'POST', '/request', { code: await codeOf(a) });
    expect(res.data).toMatchObject({ ok: true, result: 'sent' });
    expect((await list(a)).incoming).toEqual([]);
    expect((await list(b)).outgoing).toEqual([]);
    // the blocker has to unblock before asking
    expect((await api(a, 'POST', '/request', { code: await codeOf(b) })).data.code).toBe('you-blocked');
    expect((await api(a, 'POST', '/unblock', { code: await codeOf(b) })).status).toBe(200);
    expect((await list(a)).blocked).toEqual([]);
    expect((await api(a, 'POST', '/request', { code: await codeOf(b) })).data.result).toBe('sent');
  });

  it('blocking someone who already blocked you does not unblock them', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await api(a, 'POST', '/request', { code: await codeOf(b) }); // makes both profiles + rows
    await api(a, 'POST', '/block', { code: await codeOf(b) });
    await api(b, 'POST', '/block', { code: await codeOf(a) });
    expect((await list(a)).blocked).toHaveLength(1);
    expect((await list(b)).blocked).toHaveLength(1);
  });

  it('blocks a pending request too', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await api(a, 'POST', '/request', { code: await codeOf(b) });
    await api(b, 'POST', '/block', { code: await codeOf(a) });
    expect((await list(b)).incoming).toEqual([]);
    expect((await list(a)).outgoing).toEqual([]);
  });
});

describe('limits', () => {
  it('stops at the daily request limit (a wrong code counts too)', async () => {
    const a = await person('Ana');
    await list(a);
    let last = 0;
    for (let i = 0; i < LIMITS.perDay + 1; i++) last = (await api(a, 'POST', '/request', { code: 'AAAAAAAA' })).status;
    expect(last).toBe(429);
  });

  it('allows only so many requests waiting at once', async () => {
    const a = await person('Ana');
    await list(a);
    for (let i = 0; i < LIMITS.outgoing; i++) {
      const p = await person(`P${i}`);
      expect((await api(a, 'POST', '/request', { code: await codeOf(p) })).status).toBe(200);
    }
    const one = await person('One too many');
    const res = await api(a, 'POST', '/request', { code: await codeOf(one) });
    expect(res.data.code).toBe('pending');
  });

  it('a full inbox looks like success but stores nothing', async () => {
    const target = await person('Busy');
    await list(target);
    const rows = Array.from({ length: LIMITS.incoming }, (_, i) =>
      env.DB.prepare("INSERT INTO friends (player_id, other_id, state, at) VALUES (?1, ?2, 'in', 1)").bind(target.id, `u:filler${n}-${i}`));
    await env.DB.batch(rows);
    const a = await person('Ana');
    expect((await api(a, 'POST', '/request', { code: await codeOf(target) })).data.result).toBe('sent');
    expect((await list(a)).outgoing).toEqual([]);
  });

  it('refuses a new friend past the friend cap, both when asking and when accepting', async () => {
    const a = await person('Ana');
    await list(a);
    const rows = Array.from({ length: LIMITS.friends }, (_, i) =>
      env.DB.prepare("INSERT INTO friends (player_id, other_id, state, at) VALUES (?1, ?2, 'friend', 1)").bind(a.id, `u:cap${n}-${i}`));
    await env.DB.batch(rows);
    const b = await person('Ben');
    expect((await api(a, 'POST', '/request', { code: await codeOf(b) })).data.code).toBe('full');
    await api(b, 'POST', '/request', { code: await codeOf(a) });
    expect((await api(a, 'POST', '/accept', { code: await codeOf(b) })).status).toBe(400);
  });

  it('requestFriend is bounded by an atomic daily counter', async () => {
    const a = await person('Ana');
    await list(a);
    const results = await Promise.all(Array.from({ length: LIMITS.perDay + 10 }, () => requestFriend(env.DB, a.id, { code: 'AAAAAAAA' })));
    expect(results.filter((r) => !r.ok && r.code === 'limit')).toHaveLength(10);
  });
});

describe('tickets', () => {
  it('only a fresh, genuine ticket for a Google account opens the hub', async () => {
    const t = await makeTicket('test-secret', 'u:abc');
    expect(await verifyTicket('test-secret', t)).toBe('u:abc');
    expect(await verifyTicket('other-secret', t)).toBeNull();
    expect(await verifyTicket('test-secret', t, Date.now() + 61_000)).toBeNull(); // expired
    expect(await verifyTicket('test-secret', t.replace('u:abc', 'u:abd'))).toBeNull(); // someone else's id
    expect(await verifyTicket('test-secret', await makeTicket('test-secret', 'g:abc'))).toBeNull(); // guests have no hub
    expect(await verifyTicket('test-secret', 'x.y.u:abc')).toBeNull();
    const res = await SELF.fetch('https://play.test/api/friends/ws?t=nope', { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(401);
    expect((await SELF.fetch('https://play.test/api/friends/ws?t=nope')).status).toBe(426);
  });

  it('POST /ticket hands one to a signed-in player', async () => {
    const a = await person('Ana');
    const res = await api(a, 'POST', '/ticket');
    expect(await verifyTicket('test-secret', res.data.ticket)).toBe(a.id);
  });
});

/** Open a player's hub the way the browser does. */
const openHub = async (p: Person): Promise<TestClient> => {
  const { data } = await api(p, 'POST', '/ticket');
  const c = await TestClient.open(`/api/friends/ws?t=${encodeURIComponent(data.ticket)}`);
  await c.next((m) => m.t === 'hello');
  return c;
};
const presence = async (id: string) =>
  env.DB.prepare('SELECT game, room, seen FROM presence WHERE player_id = ?1').bind(id).first<{ game: string; room: string; seen: number }>();

describe('online status', () => {
  it('the hub says hello with the pending requests and friends online', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await api(b, 'POST', '/request', { code: await codeOf(a) });
    const hub = await openHub(a);
    hub.close();
    const hub2 = await TestClient.open(`/api/friends/ws?t=${encodeURIComponent((await api(a, 'POST', '/ticket')).data.ticket)}`);
    expect(await hub2.next((m) => m.t === 'hello')).toMatchObject({ requests: 1, online: 0 });
    hub2.close();
  });

  it('shows a friend as online with their room, and offline again when the last tab closes', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await befriend(a, b);
    expect((await list(a)).friends[0]).toMatchObject({ online: false, game: '', room: '' });
    const tab1 = await openHub(b);
    expect((await list(a)).friends[0]).toMatchObject({ online: true, game: '', room: '' });
    tab1.send({ t: 'where', game: 'rotten', room: 'abcd' });
    await sleep(100);
    expect((await list(a)).friends[0]).toMatchObject({ online: true, game: 'rotten', room: 'ABCD' });
    // a second tab of Ben's keeps him online after the first one closes
    const tab2 = await openHub(b);
    tab1.close();
    await sleep(150);
    expect((await list(a)).friends[0].online).toBe(true);
    tab2.close();
    await sleep(150);
    expect((await list(a)).friends[0]).toMatchObject({ online: false, game: '', room: '' });
    expect((await presence(b.id))?.seen).toBe(0);
  });

  it('leaving the room clears where they are; junk "where" values are ignored', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await befriend(a, b);
    const tab = await openHub(b);
    tab.send({ t: 'where', game: 'rotten', room: 'ABCD' });
    await sleep(80);
    tab.send({ t: 'where', game: 'nope', room: 'ABCD' });
    await sleep(80);
    expect((await list(a)).friends[0]).toMatchObject({ online: true, game: '', room: '' });
    tab.send({ t: 'where', game: 'thulla', room: 'WXYZ' });
    await sleep(80);
    tab.send({ t: 'where', game: null, room: null });
    await sleep(80);
    expect((await list(a)).friends[0].room).toBe('');
    tab.close();
  });

  it('a presence row that stopped being refreshed counts as offline', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await befriend(a, b);
    await env.DB.prepare('INSERT OR REPLACE INTO presence (player_id, game, room, seen) VALUES (?1, \'rotten\', \'ABCD\', ?2)').bind(b.id, Date.now() - ONLINE_MS - 1000).run();
    expect((await list(a)).friends[0]).toMatchObject({ online: false, room: '' });
    await env.DB.prepare('UPDATE presence SET seen = ?2 WHERE player_id = ?1').bind(b.id, Date.now() - 1000).run();
    expect((await list(a)).friends[0]).toMatchObject({ online: true, room: 'ABCD' });
  });

  it('only friends can see it: a stranger, a pending request and a blocked friend see nothing', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    const stranger = await person('Stranger');
    const pending = await person('Pending');
    await befriend(a, b);
    await api(pending, 'POST', '/request', { code: await codeOf(a) });
    const tab = await openHub(a);
    tab.send({ t: 'where', game: 'rotten', room: 'ABCD' });
    await sleep(80);
    expect((await list(b)).friends[0]).toMatchObject({ online: true, room: 'ABCD' });
    for (const p of [stranger, pending]) expect(JSON.stringify(await list(p))).not.toContain('ABCD');
    // once blocked, Ben's list has no Ana at all
    await api(b, 'POST', '/block', { code: await codeOf(a) });
    expect((await list(b)).friends).toEqual([]);
    tab.close();
  });

  it('the beat refreshes "seen" but is ignored when it comes too fast', async () => {
    const a = await person('Ana');
    const tab = await openHub(a);
    await env.DB.prepare('UPDATE presence SET seen = 5 WHERE player_id = ?1').bind(a.id).run();
    tab.send({ t: 'beat' }); // right after connecting: too soon, ignored
    await sleep(100);
    expect((await presence(a.id))?.seen).toBe(5);
    tab.close();
  });

  it('survives junk: big, malformed and unknown messages are ignored', async () => {
    const a = await person('Ana');
    const tab = await openHub(a);
    tab.send('not json');
    tab.send('{"t":"where","pad":"' + 'x'.repeat(400) + '"}');
    tab.send({ t: 'whatever' });
    tab.send('[1,2]');
    tab.send('ping');
    await tab.next((m) => m.t === 'pong');
    expect(tab.closed).toBeNull();
    tab.close();
  });
});

describe('invites', () => {
  /** A real room with `p` seated in it (signed in), so the hub's "are you really in it" check can pass. */
  const seat = async (p: Person, game = 'rotten') => {
    const host = await TestClient.open(`/${game}/ws?create=1`);
    host.join(p.name, { token: p.token });
    const w = await host.next((m) => m.t === 'welcome');
    return { host, code: w.code as string };
  };
  const inviteResult = async (tab: TestClient, code: string) => (await tab.next((m) => m.t === 'invite-result' && m.code === code)) as Msg;

  it('delivers to every open tab of the friend, from a friend who is really in the room', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await befriend(a, b);
    const { host, code: room } = await seat(a);
    const aTab = await openHub(a);
    const b1 = await openHub(b);
    const b2 = await openHub(b);
    aTab.send({ t: 'invite', code: await codeOf(b), game: 'rotten', room });
    expect((await inviteResult(aTab, await codeOf(b))).ok).toBe(true);
    for (const t of [b1, b2]) {
      expect(await t.next((m) => m.t === 'invite')).toMatchObject({ from: { name: 'Ana', code: await codeOf(a) }, game: 'rotten', room });
    }
    [aTab, b1, b2, host].forEach((c) => c.close());
  });

  it('refuses when the sender is not in that room, or the room does not exist', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    const x = await person('Xavier');
    await befriend(a, b);
    const { host, code: xRoom } = await seat(x);
    const aTab = await openHub(a);
    const bTab = await openHub(b);
    const bCode = await codeOf(b);
    aTab.send({ t: 'invite', code: bCode, game: 'rotten', room: xRoom });
    expect((await inviteResult(aTab, bCode)).reason).toBe('not-in-room');
    await sleep(20);
    aTab.send({ t: 'invite', code: bCode, game: 'rotten', room: 'QQQQ' });
    expect((await inviteResult(aTab, bCode)).reason).toBe('not-in-room');
    // the right code but the wrong game
    aTab.send({ t: 'invite', code: bCode, game: 'thulla', room: xRoom });
    expect((await inviteResult(aTab, bCode)).reason).toBe('not-in-room');
    expect(bTab.msgs.filter((m) => m.t === 'invite')).toEqual([]);
    [aTab, bTab, host].forEach((c) => c.close());
  });

  it('refuses non-friends, strangers\' codes and rubbish', async () => {
    const a = await person('Ana');
    const stranger = await person('Stranger');
    const pending = await person('Pending');
    await api(a, 'POST', '/request', { code: await codeOf(pending) });
    const { host, code: room } = await seat(a);
    const aTab = await openHub(a);
    const sTab = await openHub(stranger);
    for (const target of [await codeOf(stranger), await codeOf(pending)]) {
      aTab.send({ t: 'invite', code: target, game: 'rotten', room });
      expect((await inviteResult(aTab, target)).reason).toBe('not-friends');
    }
    aTab.send({ t: 'invite', code: 'AAAAAAAA', game: 'rotten', room });
    expect((await inviteResult(aTab, 'AAAAAAAA')).reason).toBe('not-friends');
    aTab.send({ t: 'invite', code: 'bad', game: 'rotten', room });
    expect((await aTab.next((m) => m.t === 'invite-result')).reason).toBe('invalid');
    aTab.send({ t: 'invite', code: await codeOf(stranger), game: 'monopoly', room });
    expect((await aTab.next((m) => m.t === 'invite-result')).reason).toBe('invalid');
    expect(sTab.msgs.filter((m) => m.t === 'invite')).toEqual([]);
    [aTab, sTab, host].forEach((c) => c.close());
  });

  it('says so when the friend is offline, and a removed friend can no longer be invited', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await befriend(a, b);
    const { host, code: room } = await seat(a);
    const aTab = await openHub(a);
    const bCode = await codeOf(b);
    aTab.send({ t: 'invite', code: bCode, game: 'rotten', room });
    expect((await inviteResult(aTab, bCode)).reason).toBe('offline');
    const bTab = await openHub(b);
    await api(b, 'POST', '/remove', { code: await codeOf(a) });
    aTab.send({ t: 'invite', code: bCode, game: 'rotten', room });
    expect((await inviteResult(aTab, bCode)).reason).toBe('not-friends');
    [aTab, bTab, host].forEach((c) => c.close());
  });

  it('rate-limits: the same friend only once in a while, and a burst gets "slow down"', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await befriend(a, b);
    const { host, code: room } = await seat(a);
    const aTab = await openHub(a);
    const bTab = await openHub(b);
    const bCode = await codeOf(b);
    const go = () => aTab.send({ t: 'invite', code: bCode, game: 'rotten', room });
    go();
    expect((await inviteResult(aTab, bCode)).ok).toBe(true);
    go();
    expect((await inviteResult(aTab, bCode)).reason).toBe('busy'); // same sender, within 20 s
    for (let i = 0; i < 6; i++) go();
    const reasons: string[] = [];
    for (let i = 0; i < 6; i++) reasons.push(((await inviteResult(aTab, bCode)) as Msg).reason as string);
    expect(reasons).toContain('slow-down');
    expect(bTab.msgs.filter((m) => m.t === 'invite')).toHaveLength(1);
    [aTab, bTab, host].forEach((c) => c.close());
  });

  it('pushes list changes to the other person\'s tabs', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    const bTab = await openHub(b);
    await api(a, 'POST', '/request', { code: await codeOf(b) });
    expect(await bTab.next((m) => m.t === 'friends')).toMatchObject({ why: 'request', name: 'Ana' });
    const aTab = await openHub(a);
    await api(b, 'POST', '/accept', { code: await codeOf(a) });
    expect(await aTab.next((m) => m.t === 'friends')).toMatchObject({ why: 'accepted', name: 'Ben' });
    [aTab, bTab].forEach((c) => c.close());
  });
});

type Row = GameReport['players'][number];
const seatRow = (name: string, who: { uid?: string; guest?: string }): Row => ({ name, uid: who.uid ?? null, guest: who.guest ?? null, place: 1, won: false, stats: { games: 1 } });
const finish = (players: Row[], game = 'rotten') => recordGame(env.DB, { game, room: 'ABCD', crew: null, winner: null, players });
const recent = async (p: Person | null, g?: { token: string }) =>
  (await api(p, 'GET', '/recent', undefined, g ? { 'X-Guest': g.token } : {})).data as {
    canAdd: boolean;
    recent: Array<{ ref: string; name: string; game: string; status: string }>;
  };

describe('recent players', () => {
  it('records everyone you finished a room game with, for both signed-in players and guests', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    const g = await guest();
    await finish([seatRow('Ana', { uid: a.uid }), seatRow('Ben', { uid: b.uid }), seatRow('Gus', { guest: g.id.slice(2) })]);
    expect((await recent(a)).recent.map((r) => r.name).sort()).toEqual(['Ben', 'Gus']);
    expect((await recent(b)).recent.map((r) => r.name).sort()).toEqual(['Ana', 'Gus']);
    const forGuest = await recent(null, g);
    expect(forGuest.canAdd).toBe(false);
    expect(forGuest.recent.map((r) => r.name).sort()).toEqual(['Ana', 'Ben']);
    expect((await recent(a)).canAdd).toBe(true);
  });

  it('shows nobody when you played alone, and never yourself', async () => {
    const a = await person('Ana');
    await finish([seatRow('Ana', { uid: a.uid })]);
    await finish([seatRow('Ana', { uid: a.uid }), seatRow('Ana 2', { uid: a.uid })]); // two tabs of one account
    expect((await recent(a)).recent).toEqual([]);
  });

  it('keeps the newest sighting (new name, new game), at most one row per person', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await finish([seatRow('Ana', { uid: a.uid }), seatRow('Ben', { uid: b.uid })], 'rotten');
    await sleep(5);
    await finish([seatRow('Ana', { uid: a.uid }), seatRow('Benny', { uid: b.uid })], 'thulla');
    const r = (await recent(a)).recent;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'Benny', game: 'thulla' });
  });

  it('is capped per player, dropping the oldest', async () => {
    const a = await person('Ana');
    for (let i = 0; i < LIMITS.recents + 5; i++) {
      const o = await guest();
      await finish([seatRow('Ana', { uid: a.uid }), seatRow(`Opp${i}`, { guest: o.id.slice(2) })]);
      await sleep(2);
    }
    const r = (await recent(a)).recent;
    expect(r).toHaveLength(LIMITS.recents);
    expect(r[0].name).toBe(`Opp${LIMITS.recents + 4}`);
    expect(r.map((x) => x.name)).not.toContain('Opp0');
  });

  it('never exposes an id: only a ref, and a guest or someone else\'s ref is useless', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    const g = await guest();
    await finish([seatRow('Ana', { uid: a.uid }), seatRow('Ben', { uid: b.uid }), seatRow('Gus', { guest: g.id.slice(2) })]);
    const mine = await recent(a);
    expect(JSON.stringify(mine)).not.toContain(b.uid);
    expect(JSON.stringify(mine)).not.toContain(g.id);
    const gusRef = mine.recent.find((r) => r.name === 'Gus')!.ref;
    expect(mine.recent.find((r) => r.name === 'Gus')!.status).toBe('guest');
    const guestAdd = await api(a, 'POST', '/request', { ref: gusRef });
    expect(guestAdd.data.code).toBe('guest');
    // Ben cannot use Ana's ref
    const benRef = mine.recent.find((r) => r.name === 'Ben')!.ref;
    const stolen = await api(await person('Mallory'), 'POST', '/request', { ref: benRef });
    expect(stolen.status).toBe(400);
  });

  it('"Add" from recent players sends a request; they see Requested; accepting removes them from the list', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await finish([seatRow('Ana', { uid: a.uid }), seatRow('Ben', { uid: b.uid })]);
    const ref = (await recent(a)).recent[0].ref;
    expect((await api(a, 'POST', '/request', { ref })).data.result).toBe('sent');
    expect((await recent(a)).recent[0].status).toBe('out');
    expect((await recent(b)).recent[0].status).toBe('in');
    // Ben taps Add on Ana: that accepts
    expect((await api(b, 'POST', '/request', { ref: (await recent(b)).recent[0].ref })).data.result).toBe('accepted');
    expect((await recent(a)).recent).toEqual([]);
    expect((await list(a)).friends.map((f) => f.name)).toEqual(['Ben']);
  });

  it('blocking from recent players hides them both ways', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    await finish([seatRow('Ana', { uid: a.uid }), seatRow('Ben', { uid: b.uid })]);
    await api(a, 'POST', '/block', { ref: (await recent(a)).recent[0].ref });
    expect((await recent(a)).recent).toEqual([]);
    expect((await recent(b)).recent).toEqual([]); // Ben no longer sees Ana either
    await finish([seatRow('Ana', { uid: a.uid }), seatRow('Ben', { uid: b.uid })]);
    expect((await recent(a)).recent).toEqual([]);
  });

  it('a guest can be blocked from the list too (just hides them)', async () => {
    const a = await person('Ana');
    const g = await guest();
    await finish([seatRow('Ana', { uid: a.uid }), seatRow('Gus', { guest: g.id.slice(2) })]);
    expect((await api(a, 'POST', '/block', { ref: (await recent(a)).recent[0].ref })).status).toBe(200);
    expect((await recent(a)).recent).toEqual([]);
  });
});

describe('guest -> Google merge and Delete my data cover the friends tables', () => {
  it('merge moves the guest\'s recent players to the account and re-points other people\'s lists', async () => {
    const g = await guest();
    const u = await person('Ana');
    const b = await person('Ben');
    const c = await person('Cy');
    await finish([seatRow('Gus', { guest: g.id.slice(2) }), seatRow('Ben', { uid: b.uid })]);
    await finish([seatRow('Ana', { uid: u.uid }), seatRow('Ben', { uid: b.uid }), seatRow('Cy', { uid: c.uid })]);
    await finish([seatRow('Gus', { guest: g.id.slice(2) }), seatRow('Cy', { uid: c.uid })]);
    await finish([seatRow('Gus', { guest: g.id.slice(2) }), seatRow('Ana', { uid: u.uid })]); // guest and account met: no self row
    await mergePlayer(env.DB, g.id, u.id);
    expect((await recent(u)).recent.map((r) => r.name).sort()).toEqual(['Ben', 'Cy']);
    // Ben saw "Gus" and "Ana": now one entry, the account
    expect((await recent(b)).recent.map((r) => r.name).sort()).toEqual(['Ana', 'Cy']);
    expect((await recent(c)).recent.map((r) => r.name).sort()).toEqual(['Ana', 'Ben']);
    expect(await count('recent_players', 'owner', g.id)).toBe(0);
    expect(await count('recent_players', 'other', g.id)).toBe(0);
    const self = await env.DB.prepare('SELECT COUNT(*) AS n FROM recent_players WHERE owner = other').first<{ n: number }>();
    expect(self?.n).toBe(0);
    // a merged recent player is still addable (the ref survived)
    const ben = (await recent(u)).recent.find((r) => r.name === 'Ben')!;
    expect((await api(u, 'POST', '/request', { ref: ben.ref })).data.result).toBe('sent');
    // merging twice changes nothing
    await mergePlayer(env.DB, g.id, u.id);
    expect((await recent(u)).recent).toHaveLength(2);
  });

  it('merge keeps the account\'s own newer entry when both lists know the same person', async () => {
    const g = await guest();
    const u = await person('Ana');
    const b = await person('Ben');
    await finish([seatRow('Gus', { guest: g.id.slice(2) }), seatRow('Old Ben', { uid: b.uid })], 'rotten');
    await sleep(5);
    await finish([seatRow('Ana', { uid: u.uid }), seatRow('New Ben', { uid: b.uid })], 'thulla');
    await mergePlayer(env.DB, g.id, u.id);
    const r = (await recent(u)).recent;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'New Ben', game: 'thulla' });
  });

  it('Delete my data removes the profile, both directions of every friendship, presence and every recent list that names them', async () => {
    const a = await person('Ana');
    const b = await person('Ben');
    const c = await person('Cy');
    await befriend(a, b);
    await api(c, 'POST', '/request', { code: await codeOf(a) });
    await api(a, 'POST', '/block', { code: await codeOf(c) });
    await api(b, 'POST', '/block', { code: await codeOf(c) });
    await finish([seatRow('Ana', { uid: a.uid }), seatRow('Ben', { uid: b.uid })]);
    const tab = await openHub(a);
    tab.send({ t: 'where', game: 'rotten', room: 'ABCD' });
    await sleep(80);
    const rows = async (id: string) =>
      (await count('friend_profiles', 'player_id', id)) + (await count('friends', 'player_id', id)) + (await count('friends', 'other_id', id)) +
      (await count('presence', 'player_id', id)) + (await count('recent_players', 'owner', id)) + (await count('recent_players', 'other', id));
    expect(await rows(a.id)).toBeGreaterThan(5);
    const res = await SELF.fetch('https://play.test/api/me', { method: 'DELETE', headers: { Authorization: `Bearer ${a.token}` } });
    expect(res.status).toBe(200);
    expect(await rows(a.id)).toBe(0);
    // the hub's open tab is closed and does not write presence back
    await tab.next(() => false, 300).catch(() => undefined);
    expect(tab.closed?.code).toBe(4010);
    await sleep(100);
    expect(await count('presence', 'player_id', a.id)).toBe(0);
    // other people lose only what mentioned Ana
    expect((await list(b)).friends).toEqual([]);
    expect(await count('friend_profiles', 'player_id', b.id)).toBe(1);
    expect((await list(b)).blocked.map((x) => x.name)).toEqual(['Cy']);
    expect((await recent(b)).recent).toEqual([]);
  });

  it('deletePlayer on a guest clears their recent lists too', async () => {
    const g = await guest();
    const a = await person('Ana');
    await finish([seatRow('Gus', { guest: g.id.slice(2) }), seatRow('Ana', { uid: a.uid })]);
    await deletePlayer(env.DB, [g.id]);
    expect((await recent(a)).recent).toEqual([]);
    expect(await count('recent_players', 'owner', g.id)).toBe(0);
  });
});
