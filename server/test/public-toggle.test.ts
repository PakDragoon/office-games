import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { hostRoom, sleep, TestClient, type Msg } from './helpers';

const GAMES = ['fast-fingers', 'melonburst', 'flipchip', 'rotten', 'the-liar', 'guesstimate', 'thulla', 'lettuce-party'];

/** The Lobby is told by waitUntil, so give it a moment: poll until Quick Play gives the answer we expect. */
async function quick(game: string, want: string | null): Promise<string | null> {
  let got: string | null = null;
  for (let i = 0; i < 40; i++) {
    const res = await SELF.fetch(`https://play.test/api/${game}/quick`, { method: 'POST' });
    const data = (await res.json()) as { code?: string };
    got = data.code ?? null;
    if (got === want) return got;
    await sleep(25);
  }
  return got;
}

async function listed(game: string): Promise<Array<{ code: string; public: boolean }>> {
  const res = await SELF.fetch(`https://play.test/api/${game}/rooms`);
  return ((await res.json()) as { rooms: Array<{ code: string; public: boolean }> }).rooms;
}

/** Thulla wraps its view as { t: 'state', v }; every other game sends the view itself. */
const viewOf = (m: Msg): Msg => (m.v && typeof m.v === 'object' ? (m.v as Msg) : m);
const states = (c: TestClient) => c.msgs.filter((m) => m.t === 'state').map(viewOf);
const isPublic = async (c: TestClient) => viewOf(await c.state()).public;

async function room(game: string, names: string[]): Promise<{ code: string; clients: TestClient[] }> {
  const { host, code } = await hostRoom(names[0], 'create=1', game);
  const clients = [host];
  for (const n of names.slice(1)) {
    const c = await TestClient.open(`/${game}/ws?code=${code}`);
    c.join(n);
    await c.next((m) => m.t === 'welcome');
    clients.push(c);
  }
  await host.state((m) => (viewOf(m).players as unknown[]).length === names.length);
  // Flipchip has two seats and Quick Play only offers a free one: the guest watches instead
  if (game === 'flipchip' && clients[1]) {
    clients[1].send({ t: 'stand' });
    await host.state((m) => (viewOf(m).seats as Record<string, string | null>)[2] === null);
  }
  return { code, clients };
}

describe.each(GAMES)('public toggle: %s', (game) => {
  it('is private by default, host can open it to Quick Play and close it again', async () => {
    const { code, clients } = await room(game, ['Hana', 'Ali']);
    const [host, guest] = clients;
    expect(await isPublic(guest)).toBe(false);
    expect(await quick(game, null)).toBeNull();

    host.drain();
    guest.drain();
    host.send({ t: 'public', on: true });
    expect(await isPublic(host)).toBe(true);
    expect(await isPublic(guest)).toBe(true);
    expect(await quick(game, code)).toBe(code);
    expect((await listed(game)).map((r) => r.code)).toContain(code);

    host.send({ t: 'public', on: false });
    expect(await isPublic(guest)).toBe(false);
    expect(await quick(game, null)).toBeNull();
    expect((await listed(game)).map((r) => r.code)).not.toContain(code);
    host.close();
    guest.close();
  });

  it('ignores the toggle from anyone but the host, and anything that is not true/false', async () => {
    const { code, clients } = await room(game, ['Hana', 'Ali']);
    const [host, guest] = clients;
    host.drain();
    guest.drain();
    guest.send({ t: 'public', on: true });
    host.send({ t: 'public', on: 'yes' });
    host.send({ t: 'public' });
    await sleep(150);
    expect(await quick(game, null)).toBeNull();
    // a state may or may not have been sent, but it never says public
    expect(states(host).every((m) => m.public === false)).toBe(true);

    host.send({ t: 'public', on: true });
    expect(await quick(game, code)).toBe(code);
    guest.drain();
    guest.send({ t: 'public', on: false });
    await sleep(150);
    expect(await quick(game, code)).toBe(code);
    host.close();
    guest.close();
  });

  it('a room opened as public (Quick Play) says so, and the host can make it private', async () => {
    const { host, code } = await hostRoom('Hana', 'create=1&public=1', game);
    expect(await isPublic(host)).toBe(true);
    expect(await quick(game, code)).toBe(code);
    host.send({ t: 'public', on: false });
    // Wait for the view that carries the change: rated games send an extra view once ratings load
    expect(viewOf(await host.state((s) => viewOf(s).public === false)).public).toBe(false);
    expect(await quick(game, null)).toBeNull();
    host.close();
  });
});

describe('public toggle only works in the lobby', () => {
  it('fast-fingers: ignored once the race has started', async () => {
    const { code, clients } = await room('fast-fingers', ['Hana', 'Ali']);
    const [host, guest] = clients;
    host.send({ t: 'public', on: true });
    expect(await quick('fast-fingers', code)).toBe(code);
    host.send({ t: 'start' });
    await host.state((s) => viewOf(s).status === 'play');
    // a room that is playing is not offered to Quick Play, and its flag is frozen
    host.send({ t: 'public', on: false });
    await sleep(200);
    const entry = (await listed('fast-fingers')).find((r) => r.code === code);
    expect(entry).toMatchObject({ public: true, status: 'play' });
    expect(await quick('fast-fingers', null)).toBeNull();
    host.close();
    guest.close();
  });
});
