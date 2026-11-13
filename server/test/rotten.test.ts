import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { PROTOCOL } from '../src/core/game';
import { describe, expect, it } from 'vitest';
import { hostRoom, playersOf, sleep, TestClient, type Msg } from './helpers';

const roomStub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(`rotten:${code}`));

/** Reach into the live room (tests only): the game's in-memory state. */
type Internals = { game: { room: Record<string, unknown> & { players: Array<Record<string, unknown>> } } };
async function withRoom<T>(code: string, fn: (room: Internals['game']['room']) => T): Promise<T> {
  return runInDurableObject(roomStub(code), (instance) => fn((instance as unknown as Internals).game.room));
}

async function twoPlayers() {
  const { host, code, id: hostId } = await hostRoom('Hana');
  const guest = await TestClient.open(`/rotten/ws?code=${code}`);
  guest.join('Ali');
  const welcome = await guest.next((m) => m.t === 'welcome');
  await host.state((s) => playersOf(s).length === 2);
  return { host, guest, code, hostId, guestId: welcome.id as string };
}

describe('rooms', () => {
  it('opens a room and makes the creator the host, with a signed guest id', async () => {
    const { host, code } = await hostRoom();
    expect(code).toMatch(/^[A-HJ-NP-Z]{4}$/);
    const guest = await host.next((m) => m.t === 'guest');
    expect(String(guest.token)).toMatch(/^g_.+\..+$/);
    const s = await host.state();
    expect(playersOf(s)).toHaveLength(1);
    expect(playersOf(s)[0]).toMatchObject({ name: 'Hana', isHost: true, connected: true });
  });

  it('lets a second player join by code', async () => {
    const { guest } = await twoPlayers();
    const s = await guest.state();
    expect(playersOf(s).map((p) => p.name)).toEqual(['Hana', 'Ali']);
    expect(playersOf(s)[1].isHost).toBe(false);
  });

  it('refuses a room that does not exist', async () => {
    const c = await TestClient.open('/rotten/ws?code=ZZZZ');
    const m = await c.next((x) => x.t === 'reject');
    expect(m.gone).toBe(true);
  });

  it('asks an old tab to reload when the protocol changed', async () => {
    const { code } = await hostRoom();
    const c = await TestClient.open(`/rotten/ws?code=${code}`);
    c.send({ t: 'join', v: 0, name: 'Old' });
    await c.next((m) => m.t === 'update');
  });

  it('gives a second "Sara" from another tab her own seat, but a refresh takes the seat back', async () => {
    const { host, code } = await hostRoom('Sara');
    const other = await TestClient.open(`/rotten/ws?code=${code}`);
    other.send({ t: 'join', v: PROTOCOL, name: 'Sara', client: 'tab-other' });
    let s = await host.state((x) => playersOf(x).length === 2);
    expect(playersOf(s).map((p) => p.name)).toEqual(['Sara', 'Sara 2']);
    // Refresh: the host's tab comes back with the same client id
    const again = await TestClient.open(`/rotten/ws?code=${code}`);
    again.join('Sara');
    await again.next((m) => m.t === 'welcome');
    s = await again.state();
    expect(playersOf(s)).toHaveLength(2);
    expect(playersOf(s)[0]).toMatchObject({ name: 'Sara', isHost: true });
  });

  it('ignores host-only messages from other players', async () => {
    const { guest, host } = await twoPlayers();
    guest.send({ t: 'start' });
    guest.send({ t: 'settings', settings: { lives: 1 } });
    await sleep(100);
    host.drain();
    host.send({ t: 'settings', settings: { lives: 5 } });
    const s = await host.state();
    expect(s.status).toBe('lobby');
    expect((s.settings as Record<string, unknown>).lives).toBe(5);
  });

  it('hands the host role on when the host leaves, and the room carries on', async () => {
    const { host, guest } = await twoPlayers();
    host.close();
    const s = await guest.state((x) => playersOf(x).length === 1);
    expect(playersOf(s)[0]).toMatchObject({ name: 'Ali', isHost: true });
  });

  it('answers keep-alive pings without the game', async () => {
    const { host } = await hostRoom();
    host.send('ping');
    await host.next((m) => m.t === 'pong');
  });

  it('drops a connection that floods the room', async () => {
    const { host } = await hostRoom();
    for (let i = 0; i < 200; i++) host.send({ t: 'type', text: 'a' });
    // Wait for the drop rather than a fixed time: a busy machine can take longer than 300 ms
    for (let waited = 0; !host.closed && waited < 5000; waited += 50) await sleep(50);
    expect(host.closed?.code).toBe(4008);
  });
});

describe('a game', () => {
  it('starts with a countdown, keeps the splat time secret, and checks words on the server', async () => {
    const { host, guest, code, hostId, guestId } = await twoPlayers();
    host.send({ t: 'start', settings: { lives: 1, minTurn: 'off' } });
    let s = await guest.state((x) => x.status === 'play');
    expect(s.prompt).toBe('');            // not until the countdown ends
    expect(s.fuseLeft).toBeNull();        // hidden timer by default
    expect(JSON.stringify(s)).not.toContain('fuseEnd');
    // Skip the countdown
    await withRoom(code, (room) => { room.startAt = Date.now() - 1; });
    const holder = await withRoom(code, (room) => room.holder as string);
    const holderClient = holder === hostId ? host : guest;
    const prompt = await withRoom(code, (room) => room.prompt as string);
    holderClient.send({ t: 'word', word: 'zzzzzzzz' });
    const nope = await holderClient.next((m) => m.t === 'nope');
    expect(['prompt', 'unknown']).toContain(nope.reason);
    // A real word containing the prompt
    const word = await runInDurableObject(roomStub(code), async () => {
      const { lexicon } = await import('../src/games/rotten');
      const lex = lexicon() as unknown as { en: { words(): Generator<string> } };
      for (const w of lex.en.words()) if (w.length >= 4 && w.includes(prompt) && !/(s|ed|ing)$/.test(w)) return w;
      return '';
    });
    expect(word).not.toBe('');
    holderClient.drain();
    holderClient.send({ t: 'word', word });
    s = await holderClient.state((x) => x.wordSeq === 1);
    expect(s.holder).toBe(holder === hostId ? guestId : hostId);
    expect((s.log as Msg[])[0]).toMatchObject({ word });
  });

  it('splats the holder when the fuse runs out (Alarm), ends the game and saves the stats', async () => {
    const { host, guest, code } = await twoPlayers();
    host.send({ t: 'crew', name: 'Test Crew' });
    await host.state((x) => x.crewName === 'Test Crew');
    host.send({ t: 'start', settings: { lives: 1, minTurn: 'off' } });
    await guest.state((x) => x.status === 'play');
    await withRoom(code, (room) => {
      room.startAt = Date.now() - 1000;
      room.fuseEnd = Date.now() - 10;
    });
    // The fuse timer is the room's alarm: make it due now (it may fire on its own before we run it)
    await runInDurableObject(roomStub(code), async (instance, state) => {
      (instance as unknown as { timers: Record<string, number> }).timers.fuse = Date.now();
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(roomStub(code));
    const s = await guest.state((x) => x.status === 'over');
    expect(s.winner).toBeTruthy();
    expect(s.lastSplat).toMatchObject({ out: true });
    // Saved to D1 (the save runs just after the game ends)
    let row: { games: number } | null = null;
    for (let i = 0; i < 20 && !row; i++) {
      row = await env.DB.prepare("SELECT games FROM crews WHERE id = 'rotten:testcrew'").first<{ games: number }>();
      if (!row) await sleep(50);
    }
    expect(row?.games).toBe(1);
    const stats = await env.DB.prepare("SELECT COUNT(*) AS n FROM player_stats WHERE game = 'rotten' AND stat = 'games'").first<{ n: number }>();
    expect(stats?.n).toBeGreaterThanOrEqual(2);
    const crewLine = await host.state((x) => String(x.crewStatus).startsWith('Saved to Test Crew'));
    expect(crewLine.crewStatus).toContain('1 game played');
  });

  it('survives a restart: the snapshot comes back from storage', async () => {
    const { host, code } = await twoPlayers();
    host.send({ t: 'start', settings: { lives: 3 } });
    await host.state((x) => x.status === 'play');
    const saved = await runInDurableObject(roomStub(code), (_i, state) => state.storage.get<Record<string, unknown>>('room'));
    expect(saved?.gameId).toBe('rotten');
    const snap = saved?.snap as Record<string, unknown>;
    expect(snap.status).toBe('play');
    expect(Array.isArray(snap.used)).toBe(true);
    expect(Object.keys(saved?.timers as object)).toEqual(expect.arrayContaining(['fuse', 'phase', 'presence']));
  });
});

describe('quick play and public rooms', () => {
  it('lists a public room and sends Quick Play to it', async () => {
    const { code } = await hostRoom('Pub', 'create=1&public=1');
    await sleep(100);
    const list = await (await import('cloudflare:test')).SELF.fetch('https://play.test/api/rotten/rooms');
    const { rooms } = (await list.json()) as { rooms: Array<{ code: string; public: boolean }> };
    expect(rooms.map((r) => r.code)).toContain(code);
    const quick = await (await import('cloudflare:test')).SELF.fetch('https://play.test/api/rotten/quick', { method: 'POST' });
    expect(await quick.json()).toEqual({ code });
  });

  it('keeps private rooms off the list', async () => {
    const { code } = await hostRoom('Priv');
    await sleep(100);
    const list = await (await import('cloudflare:test')).SELF.fetch('https://play.test/api/rotten/rooms');
    const { rooms } = (await list.json()) as { rooms: Array<{ code: string }> };
    expect(rooms.map((r) => r.code)).not.toContain(code);
  });
});
