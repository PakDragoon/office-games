import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { hostRoom, sleep, TestClient } from './helpers';

/** The Lobby is told by waitUntil, so poll until Quick Play gives the answer we expect. */
async function quick(want: string | null): Promise<string | null> {
  let got: string | null = null;
  for (let i = 0; i < 40; i++) {
    const res = await SELF.fetch('https://play.test/api/flipchip/quick', { method: 'POST' });
    got = ((await res.json()) as { code?: string }).code ?? null;
    if (got === want) return got;
    await sleep(25);
  }
  return got;
}

async function join(code: string, name: string): Promise<TestClient> {
  const c = await TestClient.open(`/flipchip/ws?code=${code}`);
  c.join(name);
  await c.next((m) => m.t === 'welcome');
  return c;
}

describe('flipchip Quick Play counts only the two seats', () => {
  it('offers a room with one seat free, and stops once both seats are taken even with room for watchers', async () => {
    const { host, code } = await hostRoom('Hana', 'create=1', 'flipchip');
    host.send({ t: 'public', on: true });
    expect(await quick(code)).toBe(code);

    const ali = await join(code, 'Ali');
    await host.state((s) => (s.seats as Record<string, string | null>)[2] !== null);
    expect(await quick(null)).toBeNull();

    // a watcher standing by changes nothing
    const sara = await join(code, 'Sara');
    await host.state((s) => (s.players as unknown[]).length === 3);
    expect(await quick(null)).toBeNull();

    // a player stands up: the free seat is offered again
    ali.send({ t: 'stand' });
    await host.state((s) => (s.seats as Record<string, string | null>)[2] === null);
    expect(await quick(code)).toBe(code);
    for (const c of [host, ali, sara]) c.close();
  });

  it("treats a bot's seat as free, since a person who joins takes it", async () => {
    const { host, code } = await hostRoom('Hana', 'create=1', 'flipchip');
    host.send({ t: 'public', on: true });
    host.send({ t: 'addBot' });
    await host.state((s) => (s.players as unknown[]).length === 2);
    expect(await quick(code)).toBe(code);
    host.close();
  });
});
