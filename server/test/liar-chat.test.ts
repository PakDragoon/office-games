import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { room, sleep, TestClient, type Msg } from './helpers';

const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(`the-liar:${code}`));
type Inside = { game: { room: { liar: string; word: string; decoy: string } } };
const inside = <T>(code: string, fn: (r: Inside['game']['room']) => T) =>
  runInDurableObject(stub(code), (i) => fn((i as unknown as Inside).game.room));

describe('the liar: room chat', () => {
  it('delivers lobby messages to everyone and sends the history to someone who joins', async () => {
    const { clients, code } = await room('the-liar', ['Ann', 'Bob', 'Cat']);
    clients[0].send({ t: 'chat', text: '  hello   room ' });
    const got = await Promise.all(clients.map((c) => c.next((m) => m.t === 'chat')));
    for (const m of got) expect(m.entry).toMatchObject({ name: 'Ann', text: 'hello room', color: expect.any(Number) });
    const late = await TestClient.open(`/the-liar/ws?code=${code}`);
    late.join('Dan');
    const history = await late.next((m) => m.t === 'chat-history');
    expect((history.entries as Msg[]).map((e) => e.text)).toEqual(['hello room']);
  });

  it('is closed while people read their card, and refuses a second message within a second', async () => {
    const { clients } = await room('the-liar', ['Ann', 'Bob', 'Cat']);
    clients[1].send({ t: 'chat', text: 'one' });
    await clients[1].next((m) => m.t === 'chat');
    clients[1].send({ t: 'chat', text: 'two' });
    expect((await clients[1].next((m) => m.t === 'chat-error')).reason).toMatch(/moment/);
    clients[0].send({ t: 'begin', settings: { play: 'words' } });
    await clients[2].state((s) => s.status === 'role');
    clients[2].send({ t: 'chat', text: 'can I talk?' });
    expect((await clients[2].next((m) => m.t === 'chat-error')).reason).toMatch(/opens again/);
  });

  it('mid-game, refuses your own word (the decoy for a liar who doesn\'t know) and allows other talk', async () => {
    const { clients, ids, code } = await room('the-liar', ['Ann', 'Bob', 'Cat']);
    clients[0].send({ t: 'begin', settings: { play: 'words', liarKnows: false } });
    for (const c of clients) c.send({ t: 'ready' });
    await clients[0].state((s) => s.status === 'draw');
    const { liar, word, decoy } = await inside(code, (r) => ({ liar: r.liar, word: r.word, decoy: r.decoy }));
    const honest = clients[ids.findIndex((id) => id !== liar)];
    const liarClient = clients[ids.indexOf(liar)];
    honest.send({ t: 'chat', text: `it is ${word} obviously` });
    expect((await honest.next((m) => m.t === 'chat-error')).reason).toBe('That gives your word away.');
    liarClient.send({ t: 'chat', text: `I think ${decoy}` });
    expect((await liarClient.next((m) => m.t === 'chat-error')).reason).toBe('That gives your word away.');
    await sleep(1050);
    honest.send({ t: 'chat', text: 'someone is sus' });
    const m = await liarClient.next((x) => x.t === 'chat');
    expect((m.entry as Msg).text).toBe('someone is sus');
  });
});
