import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as E from '../../web/lettuce-party/js/engine.js';
import { playersOf, room, TestClient, type Msg } from './helpers';

const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(`lettuce-party:${code}`));
interface RoomShape { word: string | null; hotTarget: number | null; status: string; players: Array<{ name: string; guesses: Array<{ word: string; rank?: number; hint?: boolean }> }> }
type Inner = { game: { room: RoomShape; hot: unknown }; timers: Record<string, number> };
const inRoom = <T>(code: string, f: (r: RoomShape, i: Inner) => T) => runInDurableObject(stub(code), (i) => f((i as unknown as Inner).game.room, i as unknown as Inner));

function record(c: TestClient): string[] {
  const log: string[] = [];
  c.ws.addEventListener('message', (e) => { if (typeof e.data === 'string') log.push(e.data); });
  return log;
}
const me = (s: Msg, name: string) => (playersOf(s).find((p) => p.name === name) ?? {}) as Record<string, unknown>;

async function startHot(names: string[], settings: Record<string, unknown> = {}) {
  const { code, clients } = await room('lettuce-party', names);
  const logs = clients.map(record);
  const [host] = clients;
  const patch = { mode: 'hotcold', ...settings };
  host.send({ t: 'settings', patch });
  await host.state((s) => Object.entries(patch).every(([k, v]) => s[k] === v));
  host.send({ t: 'start' });
  for (const c of clients) await c.state((s) => s.status === 'playing');
  const secret = await inRoom(code, (r) => r.word as string);
  return { code, clients, logs, host, secret };
}
const reply = (c: TestClient) => c.next((m) => m.t === 'result' || m.t === 'invalid');

describe('Lettuce Party: Hot & Cold', () => {
  it('ranks any word by meaning, refuses unknown words and repeats, and keeps words private', async () => {
    const { clients, logs, secret } = await startHot(['Ann', 'Bob']);
    const [ann, bob] = clients;
    expect(secret).toMatch(/^[a-z]+$/);

    ann.send({ t: 'guess', word: 'qzxv' });
    expect((await reply(ann)).reason).toBe('I don’t know that word');
    ann.send({ t: 'guess', word: 'two words' });
    expect((await reply(ann)).reason).toBe('Type one word, letters only');

    // A word that isn't the secret one: some rank above 1
    const word = secret === 'democracy' ? 'banana' : 'democracy';
    ann.send({ t: 'guess', word });
    const r = await reply(ann);
    expect(r.t).toBe('result');
    expect(r.rank as number).toBeGreaterThan(1);
    ann.send({ t: 'guess', word: word.toUpperCase() });
    expect((await reply(ann)).reason).toBe('Already guessed');

    // Bob sees Ann's best rank and her count, never the word
    const s = await bob.state((v) => me(v, 'Ann').best === r.rank);
    expect(me(s, 'Ann').used).toBe(1);
    expect(logs[1].some((l) => l.includes(`"${word}"`))).toBe(false);
    expect(logs[1].some((l) => l.includes(`"${secret}"`))).toBe(false);

    // The secret word itself is rank 1 and finishes Ann's round
    ann.send({ t: 'guess', word: secret });
    expect((await reply(ann)).rank).toBe(1);
    const done = await bob.state((v) => me(v, 'Ann').solved === true);
    expect(me(done, 'Ann').best).toBe(1);
  });

  it('a closer word ranks better (pizza: burger beats democracy)', async () => {
    const { clients, code } = await startHot(['Ann', 'Bob']);
    const [ann] = clients;
    // Pin the secret word to pizza: find its number in the secret list, then point the room at it
    const t = await runInDurableObject(stub(code), async () => {
      const H = await import('../../web/lettuce-party/js/hotcold.js');
      const WORDS = (await import('../src/data/hotcold-words.txt')).default;
      const TARGETS = (await import('../src/data/hotcold-targets.bin')).default;
      for (let k = 0; k < H.targetCount(TARGETS); k++) if (H.wordAt(WORDS, H.readTarget(TARGETS, k).index) === 'pizza') return k;
      return -1;
    });
    expect(t).toBeGreaterThanOrEqual(0);
    await inRoom(code, (r) => { r.hotTarget = t; r.word = 'pizza'; });
    ann.send({ t: 'guess', word: 'burger' });
    const burger = (await reply(ann)).rank as number;
    ann.send({ t: 'guess', word: 'democracy' });
    const democracy = (await reply(ann)).rank as number;
    expect(burger).toBeLessThan(20);
    expect(democracy).toBeGreaterThan(1000);
  });

  it('hints point the way, never count as your best, and run out after three', async () => {
    const { clients, secret } = await startHot(['Ann', 'Bob']);
    const [ann, bob] = clients;
    ann.send({ t: 'hint' });
    const h1 = await reply(ann);
    expect(h1).toMatchObject({ t: 'result', hint: true });
    expect(h1.word).not.toBe(secret);
    expect(Math.abs((h1.rank as number) - 1000)).toBeLessThan(400);   // before any guess it aims at rank 1000
    let s = await bob.state((v) => me(v, 'Ann').hints === 1);
    expect(me(s, 'Ann').best).toBeNull();
    expect(me(s, 'Ann').used).toBe(0);
    // A real guess, then a hint aims halfway from it
    const word = secret === 'democracy' ? 'banana' : 'democracy';
    ann.send({ t: 'guess', word });
    const g = (await reply(ann)).rank as number;
    ann.send({ t: 'hint' });
    const h2 = await reply(ann);
    expect(h2.rank as number).toBeLessThan(g);
    // Typing a hint's word doesn't make it count
    ann.send({ t: 'guess', word: h2.word });
    expect((await reply(ann)).reason).toBe('Already guessed');
    ann.send({ t: 'hint' });
    expect((await reply(ann)).t).toBe('result');
    ann.send({ t: 'hint' });
    expect((await reply(ann)).reason).toBe('No hints left');
    s = await bob.state((v) => me(v, 'Ann').hints === 3);
    expect(me(s, 'Ann').best).toBe(g);
  });

  it('with hints off, asking only gets a reason back', async () => {
    const { clients, code } = await startHot(['Ann', 'Bob'], { hotHints: false });
    clients[0].send({ t: 'hint' });
    expect((await reply(clients[0])).reason).toBe('Hints are off in this room');
    const hints = await inRoom(code, (r) => r.players[0].guesses.filter((x) => x.hint).length);
    expect(hints).toBe(0);
  });

  it('when time runs out the closest guess wins, and the round shows the words and the closest ones', async () => {
    const { clients, code, secret } = await startHot(['Ann', 'Bob'], { hotTime: 120 });
    const [ann, bob] = clients;
    const far = secret === 'democracy' ? 'banana' : 'democracy';
    ann.send({ t: 'guess', word: far });
    const a = (await reply(ann)).rank as number;
    // Bob's guess is the closest word on the precomputed list: rank 2
    const near = await runInDurableObject(stub(code), async (inst) => {
      const H = await import('../../web/lettuce-party/js/hotcold.js');
      const WORDS = (await import('../src/data/hotcold-words.txt')).default;
      const TARGETS = (await import('../src/data/hotcold-targets.bin')).default;
      const t = (inst as unknown as Inner).game.room.hotTarget as number;
      return H.wordAt(WORDS, H.readTarget(TARGETS, t).near[0]);
    });
    bob.send({ t: 'guess', word: near });
    expect((await reply(bob)).rank).toBe(2);
    expect(a).toBeGreaterThan(2);
    // A restart loses the in-memory data: the next guess rebuilds it
    await inRoom(code, (_r, i) => { (i.game as { hot: unknown }).hot = null; });
    bob.send({ t: 'guess', word: 'house' === secret ? 'garden' : 'house' });
    expect((await reply(bob)).t).toBe('result');

    await inRoom(code, (_r, i) => { i.timers.round = Date.now(); });
    await runDurableObjectAlarm(stub(code));
    const end = await ann.state((v) => v.status === 'ended' || v.status === 'over');
    expect(end.word).toBe(secret);
    expect((end.history as Array<{ winner: string }>).at(-1)!.winner).toBe('Bob');
    expect(end.nearest as string[]).toHaveLength(10);
    expect((end.nearest as string[])[0]).toBe(near);
    const rows = me(end, 'Bob').rows as Array<{ word: string; rank: number }>;
    expect(rows[0]).toEqual({ word: near, rank: 2, hint: false });
  });

  it('settings: Hot & Cold has its own time limit and hint switch', () => {
    const s = E.cleanSettings({ mode: 'hotcold', hotTime: 300, hotHints: false }, null);
    expect(s).toMatchObject({ mode: 'hotcold', hotTime: 300, hotHints: false, hard: false });
    expect(E.effectiveTimer(s)).toBe(300);
    expect(E.cleanSettings({ hotTime: 999 }, null).hotTime).toBe(180);
  });
});
