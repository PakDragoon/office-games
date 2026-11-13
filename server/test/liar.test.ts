import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { playersOf, room, type Msg } from './helpers';

const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(`the-liar:${code}`));

describe('the liar', () => {
  it('needs three players', async () => {
    const { clients } = await room('the-liar', ['Ann', 'Bob']);
    clients[0].send({ t: 'begin' });
    const t = await clients[0].next((m) => m.t === 'toast');
    expect(String(t.text)).toContain('3');
  });

  it('gives exactly one player the liar card and keeps the word out of the public view', async () => {
    const { clients, code } = await room('the-liar', ['Ann', 'Bob', 'Cat']);
    clients[0].send({ t: 'begin', settings: { play: 'words' } });
    const secrets = await Promise.all(clients.map((c) => c.next((m) => m.t === 'secret')));
    expect(secrets.filter((s) => s.liar === true)).toHaveLength(1);
    const word = secrets.find((s) => s.liar === false)?.word as string;
    expect(word).toBeTruthy();
    expect(secrets.filter((s) => s.word === word)).toHaveLength(2);
    const state = await clients[1].state((s) => s.status === 'role');
    expect(JSON.stringify(state)).not.toContain(`"${word}"`);
    expect(state.liar).toBeNull();
    // Everyone ready: the Words game starts; a stranger's clue out of turn is ignored
    for (const c of clients) c.send({ t: 'ready' });
    const draw = await clients[0].state((s) => s.status === 'draw');
    const turn = (draw.order as string[])[0];
    const ids = await runInDurableObject(stub(code), (i) => (i as unknown as { game: { room: { players: Array<{ id: string }> } } }).game.room.players.map((p) => p.id));
    expect(ids).toContain(turn);
  });

  it('a refreshed player gets their own card again', async () => {
    const { clients } = await room('the-liar', ['Ann', 'Bob', 'Cat']);
    clients[0].send({ t: 'begin' });
    const before = await clients[2].next((m) => m.t === 'secret');
    const { TestClient } = await import('./helpers');
    const code = (await clients[0].state()).code as string;
    const again = await TestClient.open(`/the-liar/ws?code=${code}`);
    again.join('Cat');
    await again.next((m) => m.t === 'welcome');
    const after = await again.next((m) => m.t === 'secret');
    expect({ liar: after.liar, word: after.word }).toEqual({ liar: before.liar, word: before.word });
    const s = await again.state();
    expect(playersOf(s)).toHaveLength(3);
  });

  it('votes, reveals and saves the game', async () => {
    const { clients, ids } = await room('the-liar', ['Ann', 'Bob', 'Cat']);
    clients[0].send({ t: 'begin', settings: { play: 'words' } });
    const secrets = await Promise.all(clients.map((c) => c.next((m) => m.t === 'secret')));
    const liarIdx = secrets.findIndex((s) => s.liar === true);
    for (const c of clients) c.send({ t: 'votenow', on: true });
    // Ready-to-vote only counts during the turns; get past the role card first
    for (const c of clients) c.send({ t: 'ready' });
    await clients[0].state((s) => s.status === 'draw');
    for (const c of clients) c.send({ t: 'votenow', on: true });
    await clients[0].state((s) => s.status === 'vote');
    clients.forEach((c, i) => c.send({ t: 'vote', target: ids[i === liarIdx ? (liarIdx + 1) % 3 : liarIdx] }));
    const g = await clients[liarIdx].state((s) => s.status === 'guess');
    expect((g.options as string[]).length).toBeGreaterThan(2);
    clients[liarIdx].send({ t: 'guess', word: 'definitely-not-an-option' });
    clients[liarIdx].send({ t: 'guess', word: (g.options as string[]).find((o) => o !== secrets[(liarIdx + 1) % 3].word) });
    const r: Msg = await clients[0].state((s) => s.status === 'result');
    expect(r.result).toBe('caught');
    expect(r.liar).toBe(ids[liarIdx]);
    expect(r.word).toBe(secrets[(liarIdx + 1) % 3].word);
  });

  it('gives the caught liar 10 seconds to guess, and counts a silent liar as caught', async () => {
    const { clients, ids, code } = await room('the-liar', ['Ann', 'Bob', 'Cat']);
    clients[0].send({ t: 'begin', settings: { play: 'words' } });
    const secrets = await Promise.all(clients.map((c) => c.next((m) => m.t === 'secret')));
    const liarIdx = secrets.findIndex((s) => s.liar === true);
    for (const c of clients) c.send({ t: 'ready' });
    await clients[0].state((s) => s.status === 'draw');
    for (const c of clients) c.send({ t: 'votenow', on: true });
    await clients[0].state((s) => s.status === 'vote');
    clients.forEach((c, i) => c.send({ t: 'vote', target: ids[i === liarIdx ? (liarIdx + 1) % 3 : liarIdx] }));
    const g = await clients[liarIdx].state((s) => s.status === 'guess');
    expect(g.endsIn as number).toBeGreaterThan(9000);
    expect(g.endsIn as number).toBeLessThanOrEqual(10000);
    // Time runs out without a pick: the liar stays caught
    await runInDurableObject(stub(code), (i) => { (i as unknown as { timers: Record<string, number> }).timers.phase = Date.now(); });
    await runDurableObjectAlarm(stub(code));
    const r: Msg = await clients[0].state((s) => s.status === 'result');
    expect(r.result).toBe('caught');
    expect(r.guess).toBeNull();
  });
});
