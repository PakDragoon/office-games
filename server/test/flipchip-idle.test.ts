import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as FE from '../../web/flipchip/js/engine.js';
import { flipchip } from '../src/games/flipchip';
import { playersOf, TestClient, type Msg } from './helpers';

// The Flipchip turn inactivity timer: after E.TIMES.idleMs on a person's turn the computer plays an
// Easy move for them; the 3rd time in a row they forfeit and lose their seat.

const BASE = 'https://play.test';
const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(`flipchip:${code}`));
type AnyRoom = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const inside = <T>(code: string, fn: (i: AnyRoom, room: AnyRoom) => T): Promise<T> =>
  runInDurableObject(stub(code), (i) => fn(i as AnyRoom, (i as AnyRoom).game.room));
const rows = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all<Record<string, unknown>>()).results;

async function newGuest() {
  const res = await SELF.fetch(`${BASE}/api/guest`, { method: 'POST' });
  const { token } = (await res.json()) as { token: string };
  return { token, key: `g:${token.slice(0, token.lastIndexOf('.'))}` };
}
async function seat(name: string, query: string) {
  const g = await newGuest();
  const c = await TestClient.open(`/flipchip/ws?${query}`);
  c.join(name, { guest: g.token });
  const w = await c.next((m) => m.t === 'welcome');
  await c.state();
  return { c, id: w.id as string, code: w.code as string, g };
}

/** A started 6x6 room: Hana (Dark, host) vs Omar (Light), plus a watcher when asked. */
async function started(settings: Record<string, unknown> = {}, watcher = false) {
  const h = await seat('Hana', 'create=1');
  const o = await seat('Omar', `code=${h.code}`);
  const w = watcher ? await seat('Wes', `code=${h.code}`) : null;
  h.c.send({ t: 'start', settings: { size: 6, ...settings } });
  const s = await h.c.state((x) => x.status === 'play');
  return { h, o, w, s };
}

/** Make the room's 'turn' timer due now and run the alarm, as the clock running out would. */
async function timeout(code: string): Promise<void> {
  await inside(code, (i) => { i.timers.turn = Date.now(); });
  await runDurableObjectAlarm(stub(code));
}
const seatsOf = (s: Msg) => s.seats as Record<number, string | null>;
const legal = (s: Msg) => FE.legalMoves(s.board as number[], s.size as number, s.turn as number)[0];

describe('Flipchip turn inactivity timer', () => {
  it('starts on a person’s turn with a deadline in the view and a room timer', async () => {
    const { h, s } = await started();
    expect(s.idleLeft).toBeGreaterThan(FE.TIMES.idleMs - 5000);
    expect(s.idleLeft).toBeLessThanOrEqual(FE.TIMES.idleMs);
    expect(s.idleMs).toBe(FE.TIMES.idleMs);
    expect(s.strikes).toEqual({});
    expect(await inside(h.code, (i) => Object.keys(i.timers))).toContain('turn');
  });

  it('a timeout plays a legal Easy move for them, counts it, and gives the next player a fresh deadline', async () => {
    const { h, s } = await started();
    const darkId = seatsOf(s)[1] as string;
    await timeout(h.code);
    const s2 = await h.c.state((x) => x.moveSeq === 1);
    expect(s2.turn).toBe(2);
    expect(s2.last).toMatchObject({ side: 1, auto: true });
    // the move was a legal Dark opening move and the board shows its flips
    const first = (s2.last as { i: number }).i;
    expect(FE.legalMoves(s.board as number[], 6, 1)).toContain(first);
    expect(FE.play(s.board as number[], 6, first, 1)?.board).toEqual(s2.board);
    expect(s2.strikes).toEqual({ [darkId]: 1 });
    expect(s2.idleLeft).toBeGreaterThan(FE.TIMES.idleMs - 5000);
  });

  it('a move of their own resets the count; the auto-move itself does not', async () => {
    const { h, o, s } = await started();
    const darkId = seatsOf(s)[1] as string;
    await timeout(h.code);
    let v = await o.c.state((x) => x.moveSeq === 1);
    o.c.send({ t: 'move', i: legal(v), seq: 1 });
    v = await h.c.state((x) => x.moveSeq === 2);
    expect(v.strikes).toEqual({ [darkId]: 1 });
    h.c.send({ t: 'move', i: legal(v), seq: 2 });
    v = await h.c.state((x) => x.moveSeq === 3);
    expect(v.strikes).toEqual({});
    expect((v.last as { auto: boolean }).auto).toBe(false);
  });

  it('the third timeout in a row forfeits: other side wins, the game is saved, the seat is freed, spectators stay', async () => {
    const { h, o, w, s } = await started({}, true);
    const darkId = seatsOf(s)[1] as string;
    const lightId = seatsOf(s)[2] as string;
    let v = s;
    for (let n = 1; n <= 2; n++) {
      await timeout(h.code);
      v = await o.c.state((x) => x.moveSeq === 2 * n - 1);
      o.c.send({ t: 'move', i: legal(v), seq: v.moveSeq });
      v = await o.c.state((x) => x.moveSeq === 2 * n);
      expect(v.strikes).toEqual({ [darkId]: n });
    }
    await timeout(h.code);
    v = await o.c.state((x) => x.status === 'over');
    const r = v.result as { reason: string; winner: number; loserName: string; ids: Record<number, string> };
    expect(r).toMatchObject({ reason: 'idle', winner: 2, loserName: 'Hana' });
    expect(r.ids).toEqual({ 1: darkId, 2: lightId });
    expect(v.moveSeq).toBe(4);   // no fifth move was played
    expect(seatsOf(v)[1]).toBeNull();
    expect(seatsOf(v)[2]).toBe(lightId);
    expect(v.idleLeft).toBeNull();
    // everyone is still in the room, the spectator included
    expect(playersOf(v).filter((p) => p.connected).map((p) => p.name).sort()).toEqual(['Hana', 'Omar', 'Wes']);
    expect(w).not.toBeNull();
    // saved like any finished game: both games counted, the winner has the win
    await o.c.state((x) => playersOf(x).some((p) => p.name === 'Omar' && p.ratingDelta != null));
    const stat = async (g: { key: string }, name: string) => (await rows('SELECT value FROM player_stats WHERE player_id = ?1 AND stat = ?2', g.key, name))[0]?.value;
    expect(await stat(h.g, 'games')).toBe(1);
    expect(await stat(o.g, 'games')).toBe(1);
    expect(await stat(o.g, 'wins')).toBe(1);
    expect(await stat(h.g, 'wins') ?? 0).toBe(0);
    expect(await inside(h.code, (i) => Object.keys(i.timers))).not.toContain('turn');
    // rated like a resign (enough moves were played): the idle player's rating drops
    const me = playersOf(v).find((p) => p.name === 'Hana');
    const hana = await h.c.state((x) => playersOf(x).some((p) => p.name === 'Hana' && p.ratingDelta != null));
    expect(Number(playersOf(hana).find((p) => p.name === 'Hana')?.ratingDelta)).toBeLessThan(0);
    void me;
  });

  it('a computer seat never gets the timer; the person across from it does', async () => {
    const h = await seat('Hana', 'create=1');
    h.c.send({ t: 'addBot', level: 'easy' });
    await h.c.state((x) => playersOf(x).some((p) => p.isBot));
    h.c.send({ t: 'start', settings: { size: 6 } });
    let v = await h.c.state((x) => x.status === 'play');
    expect(v.idleLeft).not.toBeNull();
    h.c.send({ t: 'move', i: legal(v), seq: 0 });
    v = await h.c.state((x) => x.moveSeq === 1);
    expect(v.turn).toBe(2);   // the computer's turn
    expect(v.idleLeft).toBeNull();
    const timers = await inside(h.code, (i) => Object.keys(i.timers));
    expect(timers).not.toContain('turn');
    expect(timers).toContain('bot');
    // and a forced 'turn' alarm can't count a strike against it
    await timeout(h.code);
    expect(await inside(h.code, (_i, room) => room.strikes)).toEqual({});
  });

  it('the move timer and the idle limit share one timer: a timed room uses its own deadline and counts the strikes too', async () => {
    const { h, s } = await started({ timer: '15' });
    expect(s.turnMs).toBe(15000);
    expect(s.idleMs).toBe(15000);
    expect(s.idleLeft).toBeLessThanOrEqual(15000);
    await timeout(h.code);
    const v = await h.c.state((x) => x.moveSeq === 1);
    expect(Object.values(v.strikes as Record<string, number>)).toEqual([1]);
  });

  it('spectators can neither move nor stop the clock; a stale timer after the game ends does nothing', async () => {
    const { h, w, s } = await started({}, true);
    w?.c.send({ t: 'move', i: legal(s), seq: 0 });
    h.c.send({ t: 'resign' });
    const over = await h.c.state((x) => x.status === 'over');
    expect(over.moveSeq).toBe(0);
    expect(over.idleLeft).toBeNull();
    await timeout(h.code);   // no 'turn' timer exists, and forcing one must be harmless
    expect(await inside(h.code, (_i, room) => [room.status, room.moveSeq, room.strikes])).toEqual(['over', 0, {}]);
  });

  it('there is no timer in the lobby, and leaving for the lobby cancels it', async () => {
    const h = await seat('Hana', 'create=1');
    const o = await seat('Omar', `code=${h.code}`);
    const lobby = await h.c.state();
    expect(lobby.idleLeft ?? null).toBeNull();
    expect(await inside(h.code, (i) => Object.keys(i.timers))).not.toContain('turn');
    h.c.send({ t: 'start', settings: { size: 6 } });
    await h.c.state((x) => x.status === 'play');
    h.c.send({ t: 'lobby' });
    const back = await o.c.state((x) => x.status === 'lobby');
    expect(back.idleLeft).toBeNull();
    expect(await inside(h.code, (i) => Object.keys(i.timers))).not.toContain('turn');
    await timeout(h.code);
    expect((await inside(h.code, (_i, room) => room.status))).toBe('lobby');
  });

  it('a rebuilt room keeps the deadline and the count (a restart or deploy neither resets nor doubles them)', async () => {
    const { h, o, s } = await started();
    const darkId = seatsOf(s)[1] as string;
    await timeout(h.code);
    const v = await o.c.state((x) => x.moveSeq === 1);
    const saved = await runInDurableObject(stub(h.code), (_i, state) => state.storage.get<{ timers: Record<string, number>; snap: AnyRoom }>('room'));
    expect(saved?.timers.turn).toBeGreaterThan(Date.now() + FE.TIMES.idleMs - 5000);
    expect(saved?.snap.strikes).toEqual({ [darkId]: 1 });
    expect(saved?.snap.idleEnd).toBeGreaterThan(Date.now());
    const snap = JSON.parse(JSON.stringify(saved?.snap)) as AnyRoom;
    const timers: Record<string, number> = {};
    const ctx = {
      code: h.code, now: () => Date.now(), random: Math.random, send() {}, close() {}, lastSeen: () => 0,
      identity: () => ({ uid: null, guest: null, photo: '' }), setTimer: (n: string, at: number) => { timers[n] = at; }, clearTimer() {}, dirty() {},
      listing() {}, later() {}, track() {},
    };
    const inst = flipchip.restore(ctx as never, snap) as unknown as { snapshot(): AnyRoom; timer(n: string): void };
    // the restored room still has the same deadline and count, and it is Light's turn
    expect(inst.snapshot().strikes).toEqual({ [darkId]: 1 });
    expect(inst.snapshot().idleEnd).toBe(snap.idleEnd);
    expect(inst.snapshot().turn).toBe(2);
    // a snapshot from before this feature restores with an empty count
    const old = JSON.parse(JSON.stringify(snap)) as AnyRoom;
    delete old.strikes;
    delete old.idleEnd;
    const legacy = flipchip.restore(ctx as never, old) as unknown as { snapshot(): AnyRoom };
    expect(legacy.snapshot().strikes).toEqual({});
    expect(v.idleLeft).toBeGreaterThan(0);
  });

  it('a person who reconnects keeps their count (their id changes on rejoin)', async () => {
    const { h, o, s } = await started();
    const darkId = seatsOf(s)[1] as string;
    await timeout(h.code);
    await o.c.state((x) => x.moveSeq === 1);
    h.c.close();
    await o.c.state((x) => playersOf(x).some((p) => p.name === 'Hana' && !p.connected));
    const again = await TestClient.open(`/flipchip/ws?code=${h.code}`);
    again.join('Hana', { guest: h.g.token });
    const w = await again.next((m) => m.t === 'welcome');
    const v = await again.state((x) => playersOf(x).some((p) => p.id === w.id));
    const strikes = v.strikes as Record<string, number>;
    expect(strikes[w.id as string] ?? strikes[darkId]).toBe(1);
    expect(Object.keys(strikes)).toEqual([seatsOf(v)[1]]);
  });
});
