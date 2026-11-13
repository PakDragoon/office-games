import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as FE from '../../web/flipchip/js/engine.js';
import { rateGame } from '../src/db/ratings';
import { pickRoom, matchWindow } from '../src/do/Lobby';
import { playersOf, sleep, TestClient, type Msg } from './helpers';

const BASE = 'https://play.test';

/** A guest identity the way the browser gets one: a signed token, and the D1 key it maps to. */
async function newGuest() {
  const res = await SELF.fetch(`${BASE}/api/guest`, { method: 'POST' });
  const { token } = (await res.json()) as { token: string };
  return { token, key: `g:${token.slice(0, token.lastIndexOf('.'))}` };
}
type Guest = Awaited<ReturnType<typeof newGuest>>;

async function seat(game: string, name: string, g: Guest, query: string): Promise<{ c: TestClient; id: string; code: string }> {
  const c = await TestClient.open(`/${game}/ws?${query}`);
  c.join(name, { guest: g.token });
  const w = await c.next((m) => m.t === 'welcome');
  return { c, id: w.id as string, code: w.code as string };
}

const ratingRow = (key: string, game: string) =>
  env.DB.prepare('SELECT rating, rd, volatility, games FROM ratings WHERE player_id = ?1 AND game = ?2').bind(key, game)
    .first<{ rating: number; rd: number; volatility: number; games: number }>();

const setRating = (key: string, game: string, rating: number, rd: number, games = 20) =>
  env.DB.prepare('INSERT OR REPLACE INTO ratings (player_id, game, rating, rd, volatility, games, updated_at) VALUES (?1, ?2, ?3, ?4, 0.06, ?5, ?6)')
    .bind(key, game, rating, rd, games, Date.now()).run();

/* ---------- Flipchip ---------- */

async function flipRoom(a: Guest, b: Guest, query = 'create=1') {
  const host = await seat('flipchip', 'Hana', a, query);
  const guest = await seat('flipchip', 'Ali', b, `code=${host.code}`);
  await host.c.state((s) => playersOf(s).length === 2);
  return { host: host.c, guest: guest.c, code: host.code, ids: { [host.id]: host.c, [guest.id]: guest.c } as Record<string, TestClient> };
}

/** Play random legal moves until `until` says stop (whoever holds the seat on turn moves). Returns the last state. */
async function playMoves(host: TestClient, guest: TestClient, until: (s: Msg) => boolean, ids?: Record<string, TestClient>): Promise<Msg> {
  let s = await host.state((x) => x.status === 'play');
  for (let i = 0; i < 120 && !until(s) && s.status !== 'over'; i++) {
    const turn = s.turn as number;
    const m = FE.chooseMove(s.board as number[], s.size as number, turn, 'random', { rnd: Math.random });
    const mover = ids ? ids[(s.seats as Record<number, string>)[turn]] : turn === 1 ? host : guest;
    mover.send({ t: 'move', i: m, seq: s.moveSeq });
    const want = (s.moveSeq as number) + 1;
    s = await host.state((x) => x.moveSeq === want || x.status === 'over');
  }
  return s;
}

/** Game over and both seated players' rating changes have arrived. */
const decided = (host: TestClient) => host.state((x) => x.status === 'over'
  && [1, 2].every((side) => playersOf(x).find((p) => p.id === (x.seats as Record<number, string>)[side])?.ratingDelta !== null));

describe('Flipchip ratings', () => {
  it('rates a full room game: winner up, loser down, saved in D1, shown in the view and the stats API', async () => {
    const [a, b] = [await newGuest(), await newGuest()];
    const { host, guest } = await flipRoom(a, b);
    host.send({ t: 'start', settings: { size: 6 } });
    await playMoves(host, guest, () => false);
    const s = await decided(host);
    const [hana, ali] = playersOf(s);
    const winner = (s.result as { winner: number }).winner;
    const deltas = [hana.ratingDelta as number, ali.ratingDelta as number];
    if (winner === 0) expect(Math.abs(deltas[0])).toBeLessThanOrEqual(1);
    else {
      const w = winner === 1 ? 0 : 1;
      expect(deltas[w]).toBeGreaterThan(0);
      expect(deltas[1 - w]).toBeLessThan(0);
    }
    expect(hana.rating).toBe(1500 + deltas[0]);
    expect(hana.ratingProv).toBe(true);
    const row = await ratingRow(a.key, 'flipchip');
    expect(row?.games).toBe(1);
    expect(Math.round(row?.rating as number)).toBe(1500 + deltas[0]);
    expect((row?.rd as number)).toBeLessThan(350);
    // The stats API shows it (guests identify with X-Guest)
    const me = await (await SELF.fetch(`${BASE}/api/me/stats?game=flipchip`, { headers: { 'X-Guest': a.token } })).json() as { rating: { rating: number; games: number; provisional: boolean } };
    expect(me.rating).toMatchObject({ rating: 1500 + deltas[0], games: 1, provisional: true });
    // And the other game has no rating yet
    const other = await (await SELF.fetch(`${BASE}/api/me/stats?game=thulla`, { headers: { 'X-Guest': a.token } })).json() as { rating: { games: number } };
    expect(other.rating.games).toBe(0);
  });

  it('a rematch carries the new rating in, and rates again', async () => {
    const [a, b] = [await newGuest(), await newGuest()];
    const { host, guest, ids } = await flipRoom(a, b);
    host.send({ t: 'start', settings: { size: 6 } });
    await playMoves(host, guest, () => false, ids);
    await decided(host);
    await sleep(2500);   // a real player isn't this quick: let the per-connection rate limit refill
    host.drain();
    host.send({ t: 'start' });
    const fresh = await host.state((x) => x.status === 'play');
    host.msgs.unshift(fresh);
    expect(playersOf(fresh).every((p) => p.ratingDelta === null)).toBe(true);
    await playMoves(host, guest, () => false, ids);
    await decided(host);
    expect((await ratingRow(a.key, 'flipchip'))?.games).toBe(2);
  });

  it('a resignation counts once each side has made two moves, and the quitter loses', async () => {
    const [a, b] = [await newGuest(), await newGuest()];
    const { host, guest } = await flipRoom(a, b);
    host.send({ t: 'start', settings: { size: 6 } });
    await playMoves(host, guest, (s) => (s.moveSeq as number) >= 4);
    host.send({ t: 'resign' });   // Hana resigns
    const s = await decided(host);
    expect(s.result).toMatchObject({ reason: 'resign', winner: 2 });
    expect(playersOf(s)[0].ratingDelta as number).toBeLessThan(0);
    expect(playersOf(s)[1].ratingDelta as number).toBeGreaterThan(0);
    expect((await ratingRow(b.key, 'flipchip'))?.games).toBe(1);
  });

  it('an instant resignation is not rated', async () => {
    const [a, b] = [await newGuest(), await newGuest()];
    const { host, guest } = await flipRoom(a, b);
    host.send({ t: 'start', settings: { size: 6 } });
    await playMoves(host, guest, (s) => (s.moveSeq as number) >= 1);
    guest.send({ t: 'resign' });
    await host.state((x) => x.status === 'over');
    await sleep(150);
    expect(await ratingRow(a.key, 'flipchip')).toBeNull();
    expect(await ratingRow(b.key, 'flipchip')).toBeNull();
  });

  it('the host ending the game for everyone is not rated', async () => {
    const [a, b] = [await newGuest(), await newGuest()];
    const { host, guest } = await flipRoom(a, b);
    host.send({ t: 'start', settings: { size: 6 } });
    await playMoves(host, guest, (s) => (s.moveSeq as number) >= 6);
    host.send({ t: 'lobby' });
    await host.state((x) => x.status === 'lobby');
    await sleep(150);
    expect(await ratingRow(a.key, 'flipchip')).toBeNull();
  });

  it('a claimed win (opponent gone) is rated for both', async () => {
    const [a, b] = [await newGuest(), await newGuest()];
    const { host, guest, code } = await flipRoom(a, b);
    host.send({ t: 'start', settings: { size: 6 } });
    await playMoves(host, guest, (s) => (s.moveSeq as number) >= 4);
    guest.close();
    await host.state((x) => playersOf(x).some((p) => p.connected === false));
    await runInDurableObject(env.ROOMS.get(env.ROOMS.idFromName(`flipchip:${code}`)), (i) => {
      const room = (i as unknown as { game: { room: { players: Array<{ offlineAt: number; connected: boolean }> } } }).game.room;
      for (const p of room.players) if (!p.connected) p.offlineAt = Date.now() - 60000;
    });
    host.send({ t: 'claim' });
    const s = await host.state((x) => x.status === 'over' && playersOf(x)[0].ratingDelta !== null);
    expect(s.result).toMatchObject({ reason: 'forfeit', winner: 1 });
    expect(playersOf(s)[0].ratingDelta as number).toBeGreaterThan(0);
    expect((await ratingRow(b.key, 'flipchip'))?.rating as number).toBeLessThan(1500);
  });

  it('spectators are never rated', async () => {
    const [a, b, c] = [await newGuest(), await newGuest(), await newGuest()];
    const { host, guest, code } = await flipRoom(a, b);
    host.send({ t: 'start', settings: { size: 6 } });
    const watcher = await seat('flipchip', 'Wendy', c, `code=${code}`);
    await playMoves(host, guest, () => false);
    await decided(host);
    expect(await ratingRow(c.key, 'flipchip')).toBeNull();
    watcher.c.close();
  });

  it('an unbalanced game moves the underdog more', async () => {
    const [a, b] = [await newGuest(), await newGuest()];
    await setRating(a.key, 'flipchip', 1900, 60);
    await setRating(b.key, 'flipchip', 1300, 60);
    const res = await rateGame(env.DB, 'flipchip', [
      { uid: null, guest: a.key.slice(2), place: 2 },   // the strong player loses
      { uid: null, guest: b.key.slice(2), place: 1 },
    ]);
    expect(res[0]?.delta as number).toBeLessThan(-1);
    expect(res[1]?.delta as number).toBeGreaterThan(1);
  });
});

describe('what is never rated', () => {
  const entry = (g: Guest, place: number, extra: Record<string, unknown> = {}) => ({ uid: null, guest: g.key.slice(2), place, ...extra });

  it('games against a bot, with one rated person, against yourself, or in unrated games', async () => {
    const [a, b] = [await newGuest(), await newGuest()];
    expect(await rateGame(env.DB, 'flipchip', [entry(a, 1), entry(b, 2, { bot: true })])).toEqual([null, null]);
    expect(await rateGame(env.DB, 'flipchip', [entry(a, 1), { uid: null, guest: null, place: 2 }])).toEqual([null, null]);
    expect(await rateGame(env.DB, 'flipchip', [entry(a, 1), entry(a, 2)])).toEqual([null, null]);
    expect(await rateGame(env.DB, 'rotten', [entry(a, 1), entry(b, 2)])).toEqual([null, null]);
    expect(await ratingRow(a.key, 'flipchip')).toBeNull();
    expect(await ratingRow(a.key, 'rotten')).toBeNull();
  });

  it('two games at the same moment both land (the second retries instead of overwriting)', async () => {
    const [a, b, c] = [await newGuest(), await newGuest(), await newGuest()];
    await Promise.all([
      rateGame(env.DB, 'flipchip', [entry(a, 1), entry(b, 2)]),
      rateGame(env.DB, 'flipchip', [entry(a, 1), entry(c, 2)]),
    ]);
    expect((await ratingRow(a.key, 'flipchip'))?.games).toBe(2);
    expect((await ratingRow(b.key, 'flipchip'))?.games).toBe(1);
  });
});

/* ---------- Thulla ---------- */

type ThullaView = { phase: string; players: Array<Record<string, unknown>>; round: Record<string, unknown> | null; result: { results: Array<Record<string, unknown>> } | null; final: Array<Record<string, unknown>> | null; standings: Array<Record<string, unknown>> };
const view = (c: TestClient): ThullaView | null => {
  for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].t === 'state') return c.msgs[i].v as ThullaView;
  return null;
};

describe('Thulla ratings', () => {
  it('rates a whole round for every player from the finishing order', async () => {
    const guests = [await newGuest(), await newGuest(), await newGuest()];
    const names = ['Hana', 'Ali', 'Sara'];
    const host = await seat('thulla', names[0], guests[0], 'create=1');
    const rest = [await seat('thulla', names[1], guests[1], `code=${host.code}`), await seat('thulla', names[2], guests[2], `code=${host.code}`)];
    const all = [host, ...rest];
    await sleep(100);
    host.c.send({ t: 'settings', patch: { rounds: 1 } });
    host.c.send({ t: 'start' });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(`thulla:${host.code}`));
    for (let i = 0; i < 400; i++) {
      const v = view(host.c);
      if (v?.phase === 'between') break;
      let acted = false;
      for (const p of all) {
        const pv = view(p.c);
        if (pv?.round && !pv.round.resolving && pv.round.myTurn && (pv.round.legal as string[]).length) {
          if (p.c.closed) throw new Error(`${p.c.closed.code} ${p.c.closed.reason}`);
          p.c.send({ t: 'play', card: (pv.round.legal as string[])[0] });
          acted = true;
          // stay under the per-connection rate limit (8 a second) even when the machine is slow to answer
          await sleep(130);
          break;
        }
      }
      if (!acted && v?.round?.resolving) {
        await runInDurableObject(stub, async (inst, state) => {
          (inst as unknown as { timers: Record<string, number> }).timers.resolve = Date.now();
          await state.storage.setAlarm(Date.now());
        });
        await runDurableObjectAlarm(stub);
      }
      await sleep(8);
    }
    // Wait for the rating to arrive in the final table
    let v = view(host.c);
    for (let i = 0; i < 100 && !(v?.phase === 'between' && v.result?.results.every((r) => r.rating)); i++) {
      await sleep(20);
      v = view(host.c);
    }
    expect(v?.phase).toBe('between');
    const rows = v?.result?.results as Array<{ id: string; pos: number; lost: boolean; rating: { delta: number; now: number } }>;
    expect(rows).toHaveLength(3);
    const winner = rows.find((r) => r.pos === 1);
    const loser = rows.find((r) => r.lost);
    expect((winner?.rating.delta as number)).toBeGreaterThan(0);
    expect((loser?.rating.delta as number)).toBeLessThan(0);
    expect(rows.reduce((n, r) => n + r.rating.delta, 0)).toBeLessThanOrEqual(1);
    for (const r of rows) {
      const g = guests[Number(r.id.slice(1)) - 1];
      const row = await ratingRow(g.key, 'thulla');
      expect(row?.games).toBe(1);
      expect(Math.round(row?.rating as number)).toBe(r.rating.now);
    }
    // The final table carries the session's total change; the players list carries the rating
    host.c.send({ t: 'endGame' });
    for (let i = 0; i < 50 && view(host.c)?.phase !== 'over'; i++) await sleep(20);
    v = view(host.c);
    expect((v?.final as Array<{ ratingDelta: number }>).every((x) => typeof x.ratingDelta === 'number')).toBe(true);
    expect(v?.players.every((p) => typeof p.rating === 'number')).toBe(true);
  }, 30000);

  it('a round with a bot in it is not rated', async () => {
    const [a, b, c] = [await newGuest(), await newGuest(), await newGuest()];
    const r = await rateGame(env.DB, 'thulla', [
      { uid: null, guest: a.key.slice(2), place: 1 }, { uid: null, guest: b.key.slice(2), place: 2 }, { uid: null, guest: c.key.slice(2), place: 3, bot: true },
    ]);
    expect(r).toEqual([null, null, null]);
  });
});

/* ---------- Quick Play matching ---------- */

describe('Quick Play matching', () => {
  type E = Parameters<typeof pickRoom>[0][number];
  const room = (code: string, rating: number | null, players: number, waitedS = 0, now = 1_000_000): E => ({
    code, public: true, status: 'lobby', players, max: 2, host: 'h', rating, at: now, since: now - waitedS * 1000,
  });
  const NOW = 1_000_000;
  const me = { rating: 1500, rd: 50 };

  it('prefers the close room even when another has more players', () => {
    const rooms = [room('FAR', 1900, 3), room('NEAR', 1540, 1)];
    expect(pickRoom(rooms, me, NOW)?.code).toBe('NEAR');
  });

  it('among close rooms keeps the old rule: the fullest', () => {
    expect(pickRoom([room('ONE', 1510, 1), room('TWO', 1480, 2)], me, NOW)?.code).toBe('TWO');
  });

  it('falls back to the least-bad room instead of nothing', () => {
    expect(pickRoom([room('A', 2400, 1), room('B', 700, 1)], me, NOW)?.code).toBe('B');
    expect(pickRoom([], me, NOW)).toBeUndefined();
  });

  it('a room that has waited a while opens up to anyone', () => {
    const rooms = [room('OLD', 1900, 1, 60), room('NEW', 1650, 1, 0)];
    expect(matchWindow(me, 0)).toBeLessThan(150);
    expect(matchWindow(me, 60_000)).toBeGreaterThan(400);
    expect(pickRoom(rooms, me, NOW)?.code).toBe('OLD');
    expect(pickRoom([room('OLD', 1900, 1, 5), room('NEW', 1650, 1, 0)], me, NOW)?.code).toBe('NEW');
  });

  it('a newcomer with an unsettled rating is matched more loosely', () => {
    expect(matchWindow({ rating: 1500, rd: 350 }, 0)).toBeGreaterThan(matchWindow(me, 0));
  });

  it('no identity, or a room with no ratings: the old behaviour', () => {
    expect(pickRoom([room('A', 1900, 1), room('B', 1500, 2)], null, NOW)?.code).toBe('B');
    expect(pickRoom([room('A', null, 1), room('B', null, 2)], me, NOW)?.code).toBe('B');
  });

  it('through the real API: a known player is sent to the room with a similar rating', async () => {
    const [strong, weak, seeker] = [await newGuest(), await newGuest(), await newGuest()];
    await setRating(strong.key, 'flipchip', 2000, 60);
    await setRating(weak.key, 'flipchip', 1210, 60);
    await setRating(seeker.key, 'flipchip', 1250, 60);
    const r1 = await seat('flipchip', 'Strong', strong, 'create=1&public=1');
    const r2 = await seat('flipchip', 'Weak', weak, 'create=1&public=1');
    await r1.c.state((s) => playersOf(s).length === 1);
    // The rooms report their listing to the lobby after the player's rating is looked up
    let code = '';
    for (let i = 0; i < 40; i++) {
      const res = await SELF.fetch(`${BASE}/api/flipchip/quick`, { method: 'POST', headers: { 'X-Guest': seeker.token } });
      code = ((await res.json()) as { code?: string }).code || '';
      if (code === r2.code) break;
      await sleep(25);
    }
    expect(code).toBe(r2.code);
    // Someone with no identity still gets a room (any room), as before
    const anon = await (await SELF.fetch(`${BASE}/api/flipchip/quick`, { method: 'POST' })).json() as { code?: string; create?: boolean };
    expect(anon.code || anon.create).toBeTruthy();
    r1.c.close();
    r2.c.close();
  });

  it('other games are untouched: Quick Play ignores ratings', async () => {
    const g = await newGuest();
    await setRating(g.key, 'rotten', 1800, 60);
    const res = await (await SELF.fetch(`${BASE}/api/rotten/quick`, { method: 'POST', headers: { 'X-Guest': g.token } })).json() as Record<string, unknown>;
    expect(res.code || res.create).toBeTruthy();
  });
});
