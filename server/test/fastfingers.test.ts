import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { hostRoom, sleep, TestClient, type Msg } from './helpers';

const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(`fast-fingers:${code}`));
type Internals = { game: { room: { raceStart: number; phaseEnd: number; text: string } } };
const withRoom = <T>(code: string, fn: (r: Internals['game']['room']) => T) =>
  runInDurableObject(stub(code), (i) => fn((i as unknown as Internals).game.room));

async function join(code: string, name: string): Promise<TestClient> {
  const c = await TestClient.open(`/fast-fingers/ws?code=${code}`);
  c.join(name);
  await c.next((m) => m.t === 'welcome');
  return c;
}
const lane = (s: Msg, name: string) => (s.players as Array<{ name: string; g: { pos: number; err: number; done: boolean; ms: number } | null }>).find((p) => p.name === name)?.g;

describe('fast-fingers race checks', () => {
  it('refuses made-up progress, ignores backwards moves, uses the server clock when a finish time is forged, ranks by finish then distance', async () => {
    const { host, code } = await hostRoom('Hana', 'create=1', 'fast-fingers');
    const ali = await join(code, 'Ali');
    const bob = await join(code, 'Bob');
    await host.state((s) => (s.players as unknown[]).length === 3);

    // only the host can start
    ali.drain();
    ali.send({ t: 'start' });
    await sleep(150);
    expect(ali.msgs.some((m) => m.t === 'state' && m.status !== 'lobby')).toBe(false);
    host.send({ t: 'start' });
    const racing = await ali.next((m) => m.t === 'state' && m.phase === 'race', 6000);
    const len = String(racing.text).length;
    expect(len).toBeGreaterThan(100);

    // a latecomer watches: no lane, and their progress is ignored
    const cy = await join(code, 'Cy');
    cy.send({ t: 'prog', pos: 10, err: 0, ms: 500 });

    // the whole paragraph a moment after the start is impossible
    ali.send({ t: 'prog', pos: len, err: 0, ms: 300 });
    // honest progress, then a step back (ignored)
    ali.send({ t: 'prog', pos: 10, err: 1, ms: 900 });
    ali.send({ t: 'prog', pos: 5, err: 0, ms: 950 });
    const s1 = await host.state((s) => lane(s, 'Ali')?.pos === 10);
    expect(lane(s1, 'Ali')).toMatchObject({ pos: 10, err: 1, done: false });
    expect(lane(s1, 'Cy')).toBeNull();

    // a non-host cannot end the race
    bob.send({ t: 'endRace' });
    await sleep(100);

    // pretend 20 s have passed so that finishing is possible
    await withRoom(code, (r) => { r.raceStart -= 20000; r.phaseEnd -= 20000; });
    ali.send({ t: 'prog', pos: len, err: 3, ms: 19000 });          // honest clock
    bob.send({ t: 'prog', pos: len, err: 0, ms: 50 });             // forged clock: server time is used
    const s2 = await host.state((s) => lane(s, 'Ali')?.done === true && lane(s, 'Bob')?.done === true);
    expect(lane(s2, 'Ali')?.ms).toBe(19000);
    expect(lane(s2, 'Bob')?.ms).toBeGreaterThanOrEqual(19700);
    expect(s2.status).toBe('play');

    host.send({ t: 'prog', pos: 30, err: 0, ms: 1000 });
    host.send({ t: 'endRace' });
    const over = await host.state((s) => s.status === 'over');
    const rows = over.results as Array<{ id: string; done: boolean; pos: number }>;
    const names = (over.players as Array<{ id: string; name: string }>);
    expect(rows.map((r) => names.find((p) => p.id === r.id)?.name)).toEqual(['Ali', 'Bob', 'Hana']);
    expect(over.winners).toEqual([rows[0].id]);
    expect(rows.some((r) => names.find((p) => p.id === r.id)?.name === 'Cy')).toBe(false);
    for (const c of [host, ali, bob, cy]) c.close();
  });
});
