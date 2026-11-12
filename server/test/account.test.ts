import { SELF, env } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newGuest } from '../src/auth';
import { DAILIES } from '../src/daily';
import { BEST_STATS, deletePlayer, mergePlayer } from '../src/db/stats';

/*
 * Signed-in paths without Google: we sign real Firebase-shaped ID tokens with our own key and answer the request
 * for Google's public keys with our key. The Worker's real verifyFirebase runs unchanged, so there is no
 * test-only switch in the production code.
 */
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

const idToken = (uid: string, opts: { project?: string; expired?: boolean } = {}) =>
  new SignJWT({ name: 'Sam' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(uid)
    .setIssuer(`https://securetoken.google.com/${opts.project ?? env.FIREBASE_PROJECT}`)
    .setAudience(opts.project ?? env.FIREBASE_PROJECT)
    .setIssuedAt()
    .setExpirationTime(opts.expired ? Math.floor(Date.now() / 1000) - 60 : '1h')
    .sign(privateKey);

let n = 0;
const fresh = async () => {
  const id = ++n;
  const guest = await newGuest('test-secret');
  return { guest, gId: `g:${guest.id}`, uId: `u:user${id}-${Math.random().toString(36).slice(2, 8)}` };
};
const uidOf = (uId: string) => uId.slice(2);

const call = (method: string, path: string, headers: Record<string, string>) => SELF.fetch(`https://play.test${path}`, { method, headers });

const setStat = (id: string, game: string, stat: string, value: number) =>
  env.DB.prepare('INSERT INTO player_stats (player_id, game, stat, value) VALUES (?1, ?2, ?3, ?4)').bind(id, game, stat, value).run();
const stats = async (id: string) => {
  const { results } = await env.DB.prepare('SELECT game, stat, value FROM player_stats WHERE player_id = ?1').bind(id).all<{ game: string; stat: string; value: number }>();
  return Object.fromEntries(results.map((r) => [`${r.game}:${r.stat}`, r.value]));
};
const addPlayer = (id: string, name: string) =>
  env.DB.prepare('INSERT INTO players (id, name, photo, created_at, updated_at) VALUES (?1, ?2, \'\', 1, 1)').bind(id, name).run();
const addResult = (id: string, game: string, day: string, score: number) =>
  env.DB.prepare('INSERT INTO daily_results (game, day, player_id, name, score, detail, at) VALUES (?1, ?2, ?3, \'N\', ?4, \'\', 1)').bind(game, day, id, score).run();
const addSession = (id: string, game: string, day: string, state: string) =>
  env.DB.prepare('INSERT INTO daily_sessions (game, day, player_id, state, updated_at) VALUES (?1, ?2, ?3, ?4, 1)').bind(game, day, id, state).run();
const results = async (id: string) => {
  const { results: rows } = await env.DB.prepare('SELECT game, day, score FROM daily_results WHERE player_id = ?1 ORDER BY game, day').bind(id).all<{ game: string; day: string; score: number }>();
  return rows.map((r) => `${r.game} ${r.day} ${r.score}`);
};
const sessions = async (id: string) => {
  const { results: rows } = await env.DB.prepare('SELECT game, day, state FROM daily_sessions WHERE player_id = ?1 ORDER BY game, day').bind(id).all<{ game: string; day: string; state: string }>();
  return rows.map((r) => `${r.game} ${r.day} ${r.state}`);
};
const count = async (table: string, col: string, id: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?1`).bind(id).first<{ n: number }>())?.n ?? 0;

describe('BEST_STATS', () => {
  it('agrees with every daily: bestDaily is MIN for a time score, MAX for points', () => {
    for (const d of Object.values(DAILIES)) expect(BEST_STATS[`${d.id}:bestDaily`], d.id).toBe(d.order === 'asc' ? 'min' : 'max');
  });
  it('lists only game:stat keys', () => {
    for (const k of Object.keys(BEST_STATS)) expect(k).toMatch(/^[a-z-]+:[A-Za-z]+$/);
  });
});

describe('POST /api/me/merge', () => {
  it('needs a Google token', async () => {
    const { guest } = await fresh();
    expect((await call('POST', '/api/me/merge', { 'X-Guest': guest.token })).status).toBe(401);
    const bad = await call('POST', '/api/me/merge', { 'X-Guest': guest.token, Authorization: 'Bearer nope.nope.nope' });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { code: string }).code).toBe('bad-user');
    const wrongProject = await call('POST', '/api/me/merge', { 'X-Guest': guest.token, Authorization: `Bearer ${await idToken('x', { project: 'someone-else' })}` });
    expect(wrongProject.status).toBe(401);
    const expired = await call('POST', '/api/me/merge', { 'X-Guest': guest.token, Authorization: `Bearer ${await idToken('x', { expired: true })}` });
    expect(expired.status).toBe(401);
  });

  it('needs a guest token the server signed, so nobody can claim another guest’s stats', async () => {
    const { gId, uId, guest } = await fresh();
    await setStat(gId, 'rotten', 'games', 5);
    const auth = { Authorization: `Bearer ${await idToken(uidOf(uId))}` };
    // none
    const none = await call('POST', '/api/me/merge', auth);
    expect(none.status).toBe(401);
    expect(((await none.json()) as { code: string }).code).toBe('bad-guest');
    // forged id with a made-up signature
    expect((await call('POST', '/api/me/merge', { ...auth, 'X-Guest': `${guest.id}.AAAA` })).status).toBe(401);
    // a known guest id signed with the wrong secret
    const other = await newGuest('another-secret');
    expect((await call('POST', '/api/me/merge', { ...auth, 'X-Guest': other.token })).status).toBe(401);
    // nothing moved
    expect(await stats(gId)).toEqual({ 'rotten:games': 5 });
    expect(await stats(uId)).toEqual({});
  });

  it('adds counters, keeps the better best-of values (MAX and MIN) and deletes the guest', async () => {
    const { gId, uId, guest } = await fresh();
    await addPlayer(gId, 'Guesty');
    await setStat(gId, 'rotten', 'games', 3);
    await setStat(gId, 'rotten', 'words', 40);
    await setStat(gId, 'rotten', 'only-guest', 7);
    await setStat(uId, 'rotten', 'games', 2);
    await setStat(uId, 'rotten', 'words', 10);
    // MAX stats
    await setStat(gId, 'rotten', 'longest', 9);
    await setStat(uId, 'rotten', 'longest', 6);
    await setStat(gId, 'fast-fingers', 'bestWpm', 50);
    await setStat(uId, 'fast-fingers', 'bestWpm', 80);
    await setStat(gId, 'lettuce-party', 'fastestNeg', -9000); // 9.0 s
    await setStat(uId, 'lettuce-party', 'fastestNeg', -12000); // 12 s: the guest was faster
    await setStat(gId, 'guesstimate', 'bestDaily', 900);
    await setStat(uId, 'guesstimate', 'bestDaily', 700);
    // MIN stat (a time: lower is better)
    await setStat(gId, 'rotten', 'bestDaily', 61);
    await setStat(uId, 'rotten', 'bestDaily', 75);
    // a best-of the account doesn't have yet
    await setStat(gId, 'fast-fingers', 'chars', 100);

    const res = await call('POST', '/api/me/merge', { Authorization: `Bearer ${await idToken(uidOf(uId))}`, 'X-Guest': guest.token });
    expect(res.status).toBe(200);
    expect(await stats(uId)).toEqual({
      'rotten:games': 5,
      'rotten:words': 50,
      'rotten:only-guest': 7,
      'rotten:longest': 9,
      'fast-fingers:bestWpm': 80,
      'lettuce-party:fastestNeg': -9000,
      'guesstimate:bestDaily': 900,
      'rotten:bestDaily': 61,
      'fast-fingers:chars': 100,
    });
    expect(await count('player_stats', 'player_id', gId)).toBe(0);
    expect(await count('players', 'id', gId)).toBe(0);
    // the account got the guest's name because it had no player row of its own
    const row = await env.DB.prepare('SELECT name FROM players WHERE id = ?1').bind(uId).first<{ name: string }>();
    expect(row?.name).toBe('Guesty');
  });

  it('keeps the guest’s best when the account has none, and the account’s when the guest has none', async () => {
    const { gId, uId } = await fresh();
    await setStat(gId, 'rotten', 'bestDaily', 90);
    await setStat(uId, 'fast-fingers', 'bestWpm', 70);
    await mergePlayer(env.DB, gId, uId);
    expect(await stats(uId)).toEqual({ 'rotten:bestDaily': 90, 'fast-fingers:bestWpm': 70 });
  });

  it('is safe to call twice', async () => {
    const { gId, uId, guest } = await fresh();
    await setStat(gId, 'thulla', 'rounds', 4);
    await setStat(gId, 'rotten', 'bestDaily', 50);
    await addResult(gId, 'rotten', '2026-01-01', 50);
    const headers = { Authorization: `Bearer ${await idToken(uidOf(uId))}`, 'X-Guest': guest.token };
    expect((await call('POST', '/api/me/merge', headers)).status).toBe(200);
    const once = { stats: await stats(uId), results: await results(uId) };
    expect((await call('POST', '/api/me/merge', headers)).status).toBe(200);
    expect({ stats: await stats(uId), results: await results(uId) }).toEqual(once);
    expect(once.stats['thulla:rounds']).toBe(4);
  });

  it('with nothing to merge, changes nothing', async () => {
    const { gId, uId, guest } = await fresh();
    await setStat(uId, 'thulla', 'rounds', 9);
    const res = await call('POST', '/api/me/merge', { Authorization: `Bearer ${await idToken(uidOf(uId))}`, 'X-Guest': guest.token });
    expect(res.status).toBe(200);
    expect(await stats(uId)).toEqual({ 'thulla:rounds': 9 });
    void gId;
  });

  it('moves a daily result only when the account has none for that game and day', async () => {
    const { gId, uId } = await fresh();
    await addResult(gId, 'rotten', '2026-02-01', 40); // account has none: moves
    await addResult(gId, 'rotten', '2026-02-02', 30); // account has one: account keeps its own
    await addResult(uId, 'rotten', '2026-02-02', 99);
    await addResult(gId, 'guesstimate', '2026-02-02', 700); // other game, same day: moves
    await setStat(gId, 'rotten', 'dailies', 2);
    await setStat(uId, 'rotten', 'dailies', 1);
    await setStat(gId, 'guesstimate', 'dailies', 1);
    await mergePlayer(env.DB, gId, uId);
    expect(await results(uId)).toEqual(['guesstimate 2026-02-02 700', 'rotten 2026-02-01 40', 'rotten 2026-02-02 99']);
    expect(await results(gId)).toEqual([]);
    // 1 + 2 = 3 added, minus the one day played both ways = 2 days
    expect((await stats(uId))['rotten:dailies']).toBe(2);
    expect((await stats(uId))['guesstimate:dailies']).toBe(1);
  });

  it('moves daily sessions likewise, and a finished guest day replaces the account’s unfinished session', async () => {
    const { gId, uId } = await fresh();
    await addSession(gId, 'rotten', '2026-03-01', 'guest-only'); // moves
    await addSession(gId, 'rotten', '2026-03-02', 'guest-old'); // account has a session AND a result: account wins
    await addSession(uId, 'rotten', '2026-03-02', 'user-kept');
    await addResult(uId, 'rotten', '2026-03-02', 10);
    await addSession(gId, 'rotten', '2026-03-03', 'guest-done'); // guest finished it, account only started it
    await addResult(gId, 'rotten', '2026-03-03', 20);
    await addSession(uId, 'rotten', '2026-03-03', 'user-unfinished');
    await addSession(gId, 'rotten', '2026-03-04', 'guest-mid'); // both unfinished: account keeps its own
    await addSession(uId, 'rotten', '2026-03-04', 'user-mid');
    await mergePlayer(env.DB, gId, uId);
    expect(await sessions(uId)).toEqual([
      'rotten 2026-03-01 guest-only',
      'rotten 2026-03-02 user-kept',
      'rotten 2026-03-03 guest-done',
      'rotten 2026-03-04 user-mid',
    ]);
    expect(await sessions(gId)).toEqual([]);
    expect(await results(uId)).toEqual(['rotten 2026-03-02 10', 'rotten 2026-03-03 20']);
  });

  it('merging a guest into an account never touches another player', async () => {
    const { gId, uId } = await fresh();
    const bystander = await fresh();
    await setStat(bystander.gId, 'rotten', 'games', 8);
    await setStat(gId, 'rotten', 'games', 1);
    await mergePlayer(env.DB, gId, uId);
    expect(await stats(bystander.gId)).toEqual({ 'rotten:games': 8 });
  });
});

describe('DELETE /api/me', () => {
  const seed = async (id: string) => {
    await addPlayer(id, 'Someone');
    await setStat(id, 'rotten', 'games', 2);
    await setStat(id, 'thulla', 'rounds', 3);
    await addResult(id, 'rotten', '2026-04-01', 12);
    await addSession(id, 'rotten', '2026-04-01', '{}');
  };
  const rowsFor = async (id: string) =>
    (await count('players', 'id', id)) + (await count('player_stats', 'player_id', id)) + (await count('daily_results', 'player_id', id)) + (await count('daily_sessions', 'player_id', id));

  it('needs a Google token or a guest token', async () => {
    expect((await call('DELETE', '/api/me', {})).status).toBe(401);
    expect((await call('DELETE', '/api/me', { 'X-Guest': 'g_forged.AAAA' })).status).toBe(401);
    expect((await call('DELETE', '/api/me', { Authorization: 'Bearer nope.nope.nope' })).status).toBe(401);
  });

  it('deletes a guest’s rows in every table, and only theirs', async () => {
    const a = await fresh();
    const b = await fresh();
    await seed(a.gId);
    await seed(b.gId);
    expect(await rowsFor(a.gId)).toBe(5);
    const res = await call('DELETE', '/api/me', { 'X-Guest': a.guest.token });
    expect(res.status).toBe(200);
    expect(await rowsFor(a.gId)).toBe(0);
    expect(await rowsFor(b.gId)).toBe(5);
  });

  it('deletes a signed-in player’s rows', async () => {
    const a = await fresh();
    await seed(a.uId);
    const res = await call('DELETE', '/api/me', { Authorization: `Bearer ${await idToken(uidOf(a.uId))}` });
    expect(res.status).toBe(200);
    expect(await rowsFor(a.uId)).toBe(0);
  });

  it('deletes both identities when both are sent', async () => {
    const a = await fresh();
    await seed(a.uId);
    await seed(a.gId);
    const res = await call('DELETE', '/api/me', { Authorization: `Bearer ${await idToken(uidOf(a.uId))}`, 'X-Guest': a.guest.token });
    expect(res.status).toBe(200);
    expect(await rowsFor(a.uId)).toBe(0);
    expect(await rowsFor(a.gId)).toBe(0);
  });

  it('a stale guest token does not stop a signed-in player deleting their account', async () => {
    const a = await fresh();
    await seed(a.uId);
    const res = await call('DELETE', '/api/me', { Authorization: `Bearer ${await idToken(uidOf(a.uId))}`, 'X-Guest': 'g_old.AAAA' });
    expect(res.status).toBe(200);
    expect(await rowsFor(a.uId)).toBe(0);
  });

  it('refuses a bad Google token even when the guest token is fine, and deletes nothing', async () => {
    const a = await fresh();
    await seed(a.gId);
    const res = await call('DELETE', '/api/me', { Authorization: 'Bearer nope.nope.nope', 'X-Guest': a.guest.token });
    expect(res.status).toBe(401);
    expect(await rowsFor(a.gId)).toBe(5);
  });

  it('is safe to call twice and leaves crew tables alone', async () => {
    const a = await fresh();
    await seed(a.gId);
    await env.DB.prepare("INSERT OR REPLACE INTO crews (id, game, name, games, created_at, updated_at) VALUES ('rotten:delcrew', 'rotten', 'Delcrew', 1, 1, 1)").run();
    await env.DB.prepare("INSERT OR REPLACE INTO crew_stats (crew_id, player, stat, value) VALUES ('rotten:delcrew', 'Someone', 'games', 1)").run();
    expect((await call('DELETE', '/api/me', { 'X-Guest': a.guest.token })).status).toBe(200);
    expect((await call('DELETE', '/api/me', { 'X-Guest': a.guest.token })).status).toBe(200);
    expect(await count('crew_stats', 'crew_id', 'rotten:delcrew')).toBe(1);
  });

  it('deletePlayer reports how many rows went and ignores an empty list', async () => {
    const a = await fresh();
    await seed(a.gId);
    expect(await deletePlayer(env.DB, [])).toBe(0);
    expect(await deletePlayer(env.DB, [a.gId])).toBe(5);
  });
});
