import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as FC from '../../web/flipchip/js/engine.js';
import { REPLAY_KEEP_DAYS, REPLAY_MAX_STORED, pruneReplays, replayStore } from '../src/db/replays';
import { room, sleep, type Msg, type TestClient } from './helpers';

const store = () => replayStore(env.DB);
const getApi = (game: string, id: string) => SELF.fetch(`https://play.test/api/${game}/replay/${id}`);

type Internals = { game: { room: Record<string, any> } };   // eslint-disable-line @typescript-eslint/no-explicit-any
const inRoom = <T>(game: string, code: string, fn: (r: Internals['game']['room']) => T) =>
  runInDurableObject(env.ROOMS.get(env.ROOMS.idFromName(`${game}:${code}`)), (i) => fn((i as unknown as Internals).game.room));

/** Wait for the room to tell everyone where the saved replay is. */
async function replayIdOf(c: TestClient): Promise<string> {
  const s = await c.state((m) => typeof m.replayId === 'string');
  return s.replayId as string;
}

describe('replay storage', () => {
  it('keeps and returns a payload, compressed', async () => {
    const payload = { v: 1, strokes: [{ p: 0, pts: Array.from({ length: 4000 }, (_, i) => (i * 7) % 800) }] };
    const id = await store().put('the-liar', payload, ['g:a', 'u:b', 'g:a']);
    expect(id).toMatch(/^[A-Za-z0-9]{12}$/);
    const back = await store().get('the-liar', id!);
    expect(back?.payload).toEqual(payload);
    const row = await env.DB.prepare('SELECT size, length(data) AS len FROM replays WHERE id = ?1').bind(id).first<{ size: number; len: number }>();
    expect(row!.size).toBe(row!.len);
    expect(row!.size).toBeLessThan(JSON.stringify(payload).length);
    const who = await env.DB.prepare('SELECT player_id FROM replay_players WHERE replay_id = ?1 ORDER BY player_id').bind(id).all<{ player_id: string }>();
    expect(who.results.map((r) => r.player_id)).toEqual(['g:a', 'u:b']);
  });

  it('ids are unique and unguessable-looking; unknown, malformed and other-game ids find nothing', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 30; i++) ids.add((await store().put('flipchip', { n: i }, []))!);
    expect(ids.size).toBe(30);
    const id = [...ids][0];
    expect(await store().get('flipchip', id)).not.toBeNull();
    expect(await store().get('the-liar', id)).toBeNull();           // another game's replay
    expect(await store().get('flipchip', 'AAAAAAAAAAAA')).toBeNull();
    expect(await store().get('flipchip', "x' OR 1=1 --")).toBeNull();
  });

  it('refuses a payload that is too big, before or after compressing', async () => {
    expect(await store().put('flipchip', { blob: 'x'.repeat(200 * 1024) }, [])).toBeNull();
    // Random-looking data does not shrink: over the stored cap once compressed
    const noisy = Array.from({ length: 3 }, () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(30 * 1024))))).join('').slice(0, 120 * 1024);
    expect(noisy.length).toBeLessThan(128 * 1024);
    expect(await store().put('flipchip', { noisy }, [])).toBeNull();
    expect(REPLAY_MAX_STORED).toBe(64 * 1024);
  });

  it('delete removes one replay and its players', async () => {
    const id = (await store().put('flipchip', { a: 1 }, ['g:z']))!;
    await store().delete(id);
    expect(await store().get('flipchip', id)).toBeNull();
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM replay_players WHERE replay_id = ?1').bind(id).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it('the nightly clean-up deletes replays older than 90 days and keeps newer ones', async () => {
    const old = (await store().put('flipchip', { old: 1 }, ['g:old']))!;
    const fresh = (await store().put('flipchip', { fresh: 1 }, ['g:old']))!;
    const day = 86400000;
    await env.DB.prepare('UPDATE replays SET created_at = ?1 WHERE id = ?2').bind(Date.now() - (REPLAY_KEEP_DAYS + 1) * day, old).run();
    await env.DB.prepare('UPDATE replays SET created_at = ?1 WHERE id = ?2').bind(Date.now() - (REPLAY_KEEP_DAYS - 1) * day, fresh).run();
    expect(await pruneReplays(env.DB)).toBeGreaterThanOrEqual(1);
    expect(await store().get('flipchip', old)).toBeNull();
    expect(await store().get('flipchip', fresh)).not.toBeNull();
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM replay_players WHERE replay_id = ?1').bind(old).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it('"delete my data" removes every replay a player took part in', async () => {
    const a = (await store().put('flipchip', { a: 1 }, ['u:me', 'g:other']))!;
    const b = (await store().put('the-liar', { b: 1 }, ['u:me']))!;
    const c = (await store().put('the-liar', { c: 1 }, ['g:other']))!;
    expect(await store().deleteForPlayer('u:me')).toBe(2);
    expect(await store().get('flipchip', a)).toBeNull();
    expect(await store().get('the-liar', b)).toBeNull();
    expect(await store().get('the-liar', c)).not.toBeNull();
  });
});

describe('replay API', () => {
  it('GET returns the replay; unknown, malformed and other-game ids are 404', async () => {
    const id = (await store().put('flipchip', { hello: 'world' }, []))!;
    const ok = await getApi('flipchip', id);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { replay: unknown; createdAt: number };
    expect(body.replay).toEqual({ hello: 'world' });
    expect(body.createdAt).toBeGreaterThan(0);
    expect((await getApi('flipchip', 'ZZZZZZZZZZZZ')).status).toBe(404);
    expect((await getApi('flipchip', 'short')).status).toBe(404);
    expect((await getApi('the-liar', id)).status).toBe(404);
    expect((await getApi('nope', id)).status).toBe(404);
    expect((await SELF.fetch(`https://play.test/api/flipchip/replay/${id}`, { method: 'POST' })).status).toBe(404);
  });
});

describe('The Liar saves a replay at the end of the game', () => {
  async function playToResult(settings: Record<string, unknown>, afterRole?: (code: string, ids: string[]) => Promise<void>) {
    const { clients, ids, code } = await room('the-liar', ['Ann', 'Bob', 'Cat']);
    clients[0].send({ t: 'begin', settings });
    const secrets = await Promise.all(clients.map((c) => c.next((m) => m.t === 'secret')));
    const liarIdx = secrets.findIndex((s) => s.liar === true);
    for (const c of clients) c.send({ t: 'ready' });
    await clients[0].state((s) => s.status === 'draw');
    if (afterRole) await afterRole(code, ids);
    for (const c of clients) c.send({ t: 'votenow', on: true });
    await clients[0].state((s) => s.status === 'vote');
    // Everyone votes for someone who is not the liar, so the liar gets away (no guess step)
    const wrong = ids.find((_, i) => i !== liarIdx)!;
    clients.forEach((c, i) => c.send({ t: 'vote', target: i === ids.indexOf(wrong) ? ids[liarIdx] : wrong }));
    return { clients, ids, code, liarIdx, secrets };
  }

  it('Draw: saves the strokes, names, colours, word and outcome (and no ids)', async () => {
    const { clients, ids, code, liarIdx } = await playToResult({ play: 'draw' }, async (c, i) => {
      await inRoom('the-liar', c, (r) => {
        r.strokes.push({ sid: 's1', pid: i[0], color: 0, pts: [10, 10, 50, 60, 90, 20] }, { sid: 's2', pid: i[1], color: 1, pts: [200, 200, 300, 300] });
      });
    });
    // The vote may need the liar's last guess if the liar was accused; the wrong votes avoid that
    const result = await clients[0].state((s) => s.status === 'result');
    expect(result.result).not.toBe('caught');
    const id = await replayIdOf(clients[1]);
    expect(id).toMatch(/^[A-Za-z0-9]{12}$/);
    const res = await getApi('the-liar', id);
    const { replay } = (await res.json()) as { replay: Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(replay.mode).toBe('draw');
    expect(replay.players.map((p: { name: string }) => p.name).sort()).toEqual(['Ann', 'Bob', 'Cat']);
    expect(replay.liar).toBe(replay.players.findIndex((p: { name: string }) => p.name === ['Ann', 'Bob', 'Cat'][liarIdx]));
    expect(replay.strokes).toHaveLength(2);
    expect(replay.strokes[0].pts).toEqual([10, 10, 50, 60, 90, 20]);
    expect(replay.word).toBe(result.word);
    expect(replay.result).toBe(result.result);
    const text = JSON.stringify(replay);
    for (const pid of ids) expect(text).not.toContain(pid);
    // The players taking part are recorded for "delete my data"
    const who = await env.DB.prepare('SELECT COUNT(*) AS n FROM replay_players WHERE replay_id = ?1').bind(id).first<{ n: number }>();
    expect(who!.n).toBe(3);
  });

  it('Words: saves the words board', async () => {
    const { clients } = await playToResult({ play: 'words' }, async () => {});
    await clients[0].state((s) => s.status === 'result');
    const id = await replayIdOf(clients[2]);
    const { replay } = (await (await getApi('the-liar', id)).json()) as { replay: Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(replay.mode).toBe('words');
    expect(replay.strokes).toEqual([]);
    expect(Array.isArray(replay.clues)).toBe(true);
  });

  it('Time: saves nothing', async () => {
    const { clients, code } = await room('the-liar', ['Ann', 'Bob', 'Cat']);
    clients[0].send({ t: 'begin', settings: { play: 'time' } });
    await Promise.all(clients.map((c) => c.next((m) => m.t === 'secret')));
    for (const c of clients) c.send({ t: 'ready' });
    await clients[0].state((s) => s.status === 'time');
    for (const c of clients) c.send({ t: 'stop', secs: 5 });
    await clients[0].state((s) => s.status === 'discuss');
    for (const c of clients) c.send({ t: 'votenow', on: true });
    await clients[0].state((s) => s.status === 'vote');
    const ids = await inRoom('the-liar', code, (r) => r.players.map((p: { id: string }) => p.id) as string[]);
    clients.forEach((c, i) => c.send({ t: 'vote', target: ids[(i + 1) % 3] }));
    const done = await clients[0].state((s) => s.status === 'result');
    await sleep(150);
    expect(done.replayId ?? null).toBeNull();
    const n = await inRoom('the-liar', code, (r) => r.replayId ?? null);
    expect(n).toBeNull();
  });

  it('does not show a replay link before the result, and a new game clears it', async () => {
    const { clients, code } = await playToResult({ play: 'words' });
    await clients[0].state((s) => s.status === 'result');
    await replayIdOf(clients[0]);
    clients[0].send({ t: 'begin', settings: { play: 'words' } });
    const next = await clients[0].state((s) => s.status === 'role');
    expect(next.replayId).toBeNull();
    expect(await inRoom('the-liar', code, (r) => r.replayId)).toBeNull();
  });
});

describe('Flipchip saves a replay at the end of the game', () => {
  it('saves size, players, moves and result; passes included', async () => {
    const { clients } = await room('flipchip', ['Dana', 'Eli']);
    const [dana, eli] = clients;
    dana.send({ t: 'start', settings: { size: 6 } });
    const s0 = await dana.state((s) => s.status === 'play');
    const board = s0.board as number[];
    const first = (FC.legalMoves(board, 6, FC.DARK) as number[])[0];
    dana.send({ t: 'move', i: first, seq: 0 });
    const s1 = await eli.state((s) => s.moveSeq === 1);
    const second = (FC.legalMoves(s1.board as number[], 6, FC.LIGHT) as number[])[0];
    eli.send({ t: 'move', i: second, seq: 1 });
    await dana.state((s) => s.moveSeq === 2);
    eli.send({ t: 'resign' });
    await dana.state((s) => s.status === 'over');
    const id = await replayIdOf(dana);
    const { replay } = (await (await getApi('flipchip', id)).json()) as { replay: Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(replay).toMatchObject({ v: 1, size: 6, reason: 'resign', winner: FC.DARK, players: { dark: 'Dana', light: 'Eli' } });
    expect(replay.moves).toEqual([{ side: FC.DARK, i: first }, { side: FC.LIGHT, i: second }]);
    // spectators and the other player see the same link; it is gone from the next game's view
    expect((await eli.state((s) => s.replayId === id)).replayId).toBe(id);
    dana.send({ t: 'start' });
    const again: Msg = await dana.state((s) => s.status === 'play');
    expect(again.replayId).toBeNull();
  });
});
