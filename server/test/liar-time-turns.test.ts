import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { room, type Msg } from './helpers';

const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(`the-liar:${code}`));
type Inside = { timers: Record<string, number>; game: { room: { turnStart: number } } };
// Skip the hand-off banner so the player whose turn it is may press Start straight away
const skipHandoff = (code: string) => runInDurableObject(stub(code), (i) => { (i as unknown as Inside).game.room.turnStart = 0; });

describe('the liar: Time game turn by turn', () => {
  it('times one player at a time, shows each stop at once, and the liar is never first', async () => {
    const { clients, ids, code } = await room('the-liar', ['Ann', 'Bob', 'Cat']);
    clients[0].send({ t: 'begin', settings: { play: 'time', timeTurns: 'turns' } });
    const secrets = await Promise.all(clients.map((c) => c.next((m) => m.t === 'secret')));
    const liarId = ids[secrets.findIndex((s) => s.liar === true)];
    for (const c of clients) c.send({ t: 'ready' });
    const s0 = await clients[0].state((s) => s.status === 'time');
    const order = s0.order as string[];
    expect(order[0]).not.toBe(liarId);
    expect(s0.timer).toBe(order[0]);
    expect(s0.settings).toMatchObject({ timeTurns: 'turns' });
    const by = (id: string) => clients[ids.indexOf(id)];

    // Someone out of turn: ignored
    await skipHandoff(code);
    by(order[1]).send({ t: 'start' });
    by(order[1]).send({ t: 'stop', secs: 4.2 });
    // The first player times; their stop goes up for everyone while the game is still timing
    by(order[0]).send({ t: 'start' });
    by(order[0]).send({ t: 'stop', secs: 6.5 });
    const s1 = await clients[2].state((s) => s.timer === order[1]);
    expect(s1.status).toBe('time');
    expect(s1.stops).toEqual({ [order[0]]: 6.5 });

    // The second player never presses Stop: their turn runs out and they get no stop
    await runInDurableObject(stub(code), (i) => { (i as unknown as Inside).timers.turn = Date.now(); });
    await runDurableObjectAlarm(stub(code));
    const s2 = await clients[0].state((s) => s.timer === order[2]);
    expect(Object.keys(s2.stops as object)).toEqual([order[0]]);

    // The last stop opens the discussion
    await skipHandoff(code);
    by(order[2]).send({ t: 'stop', secs: 7.1 });
    const d: Msg = await clients[1].state((s) => s.status === 'discuss');
    expect(d.stops).toEqual({ [order[0]]: 6.5, [order[2]]: 7.1 });
    expect(d.timer).toBeNull();
  });

  it('a player who leaves on their turn is skipped', async () => {
    const { clients, ids } = await room('the-liar', ['Ann', 'Bob', 'Cat', 'Dan']);
    clients[0].send({ t: 'begin', settings: { play: 'time', timeTurns: 'turns' } });
    for (const c of clients) c.send({ t: 'ready' });
    const s0 = await clients[0].state((s) => s.status === 'time');
    const order = s0.order as string[];
    clients[ids.indexOf(order[0])].close();
    const watcher = clients[ids.indexOf(order[1])];
    const s = await watcher.state((v) => v.timer === order[1]);
    expect(s.status).toBe('time');
    expect(s.stops).toEqual({});
  });

  it('all at once is still the default', async () => {
    const { clients } = await room('the-liar', ['Ann', 'Bob', 'Cat']);
    clients[0].send({ t: 'begin', settings: { play: 'time' } });
    for (const c of clients) c.send({ t: 'ready' });
    const s = await clients[0].state((v) => v.status === 'time');
    expect(s.timer).toBeNull();
    expect(s.settings).toMatchObject({ timeTurns: 'all' });
  });
});
