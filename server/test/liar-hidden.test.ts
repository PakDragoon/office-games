import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { room, type Msg } from './helpers';

const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(`the-liar:${code}`));
type Inside = { game: { room: { liar: string; word: string; decoy: string; order: string[]; turn: number; turnStart: number; time: { target: number; decoy?: number } | null } } };
const inside = <T>(code: string, fn: (r: Inside['game']['room']) => T) =>
  runInDurableObject(stub(code), (i) => fn((i as unknown as Inside).game.room));

describe('the liar: the liar doesn\'t know', () => {
  it('gives the liar a close word on a card shaped like everyone else\'s', async () => {
    const { clients, ids, code } = await room('the-liar', ['Ann', 'Bob', 'Cat', 'Dan']);
    clients[0].send({ t: 'begin', settings: { play: 'words', liarKnows: false } });
    const secrets = await Promise.all(clients.map((c) => c.next((m) => m.t === 'secret')));
    const { liar, word, decoy } = await inside(code, (r) => ({ liar: r.liar, word: r.word, decoy: r.decoy }));
    expect(decoy).toBeTruthy();
    expect(decoy).not.toBe(word);
    // Nobody is told they're the liar, and every card has the same fields
    for (const s of secrets) {
      expect(s.liar).toBe(false);
      expect(Object.keys(s).sort()).toEqual(['category', 'game', 'liar', 't', 'word']);
    }
    secrets.forEach((s, i) => expect(s.word).toBe(ids[i] === liar ? decoy : word));
    const state = await clients[1].state((s) => s.status === 'role');
    expect(state.settings).toMatchObject({ liarKnows: false });
    const text = JSON.stringify(state);
    expect(text).not.toContain(`"${word}"`);
    expect(text).not.toContain(`"${decoy}"`);
    expect(state.liar).toBeNull();
    expect(state.decoy).toBe('');
  });

  it('checks the liar\'s words against their own word, and the guess leaves it out', async () => {
    const { clients, ids, code } = await room('the-liar', ['Ann', 'Bob', 'Cat']);
    clients[0].send({ t: 'begin', settings: { play: 'words', liarKnows: false } });
    await Promise.all(clients.map((c) => c.next((m) => m.t === 'secret')));
    for (const c of clients) c.send({ t: 'ready' });
    await clients[0].state((s) => s.status === 'draw');
    // Make it the liar's turn now, with the hand-off over
    const { liar, word, decoy } = await inside(code, (r) => {
      r.order = [r.liar, ...r.order.filter((x) => x !== r.liar)];
      r.turn = 0;
      r.turnStart = 0;
      return { liar: r.liar, word: r.word, decoy: r.decoy };
    });
    const liarClient = clients[ids.indexOf(liar)];
    liarClient.send({ t: 'clue', text: decoy });
    const nope = await liarClient.next((m) => m.t === 'nope');
    expect(nope.reason).toBe('That gives the word away');
    // Any other word goes through. (Not the real word itself: when one contains the other, like chai and
    // karak chai, it would give the liar's own word away too.)
    liarClient.send({ t: 'clue', text: 'zebroid' });
    const after = await clients[0].state((s) => Array.isArray(s.clues) && (s.clues as Msg[]).length === 1);
    expect((after.clues as Msg[])[0]).toMatchObject({ pid: liar, text: expect.any(String) });

    // Caught: the guess shows the real word but never the decoy, and the result reveals both
    for (const c of clients) c.send({ t: 'votenow', on: true });
    await clients[0].state((s) => s.status === 'vote');
    clients.forEach((c, i) => c.send({ t: 'vote', target: ids[i] === liar ? ids.find((x) => x !== liar) : liar }));
    const g = await liarClient.state((s) => s.status === 'guess');
    expect(g.liar).toBe(liar);
    expect(g.options).toContain(word);
    expect(g.options).not.toContain(decoy);
    liarClient.send({ t: 'guess', word });
    const r = await clients[0].state((s) => s.status === 'result');
    expect(r).toMatchObject({ result: 'stolen', word, decoy, liar });
  });

  it('Time: the liar gets their own time 1.5 to 3 s away, no range', async () => {
    const { clients, ids, code } = await room('the-liar', ['Ann', 'Bob', 'Cat']);
    clients[0].send({ t: 'begin', settings: { play: 'time', liarKnows: false } });
    const secrets = await Promise.all(clients.map((c) => c.next((m) => m.t === 'secret')));
    const { liar, time } = await inside(code, (r) => ({ liar: r.liar, time: r.time! }));
    expect(typeof time.decoy).toBe('number');
    const gap = Math.abs((time.decoy as number) - time.target);
    expect(gap).toBeGreaterThanOrEqual(1.5 - 1e-9);
    expect(gap).toBeLessThanOrEqual(3 + 1e-9);
    for (const s of secrets) {
      expect(s.liar).toBe(false);
      expect(s.range).toBeUndefined();
      expect(Object.keys(s).sort()).toEqual(['category', 'game', 'liar', 't', 'time']);
    }
    secrets.forEach((s, i) => expect(s.time).toBe(ids[i] === liar ? time.decoy : time.target));
    // Nothing about the times before the result
    for (const c of clients) c.send({ t: 'ready' });
    const s = await clients[0].state((v) => v.status === 'time');
    expect(s.time).toBeNull();
  });

  it('the liar still knows by default', async () => {
    const { clients, code } = await room('the-liar', ['Ann', 'Bob', 'Cat']);
    clients[0].send({ t: 'begin', settings: { play: 'draw' } });
    const secrets = await Promise.all(clients.map((c) => c.next((m) => m.t === 'secret')));
    expect(secrets.filter((s) => s.liar === true)).toHaveLength(1);
    expect(await inside(code, (r) => r.decoy)).toBe('');
    const s = await clients[0].state((v) => v.status === 'role');
    expect(s.settings).toMatchObject({ liarKnows: true });
  });
});
