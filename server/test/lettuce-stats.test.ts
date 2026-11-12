import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { room, sleep } from './helpers';

const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(`lettuce-party:${code}`));
type Inner = { game: { room: { word: string; round: number; status: string } } };
const inner = <T>(code: string, f: (r: Inner['game']['room']) => T) => runInDurableObject(stub(code), (i) => f((i as unknown as Inner).game.room));

async function myStats(token: string): Promise<Record<string, number>> {
  const res = await SELF.fetch('https://play.test/api/me/stats?game=lettuce-party', { headers: { 'X-Guest': token } });
  return ((await res.json()) as { stats: Record<string, number> }).stats;
}

describe('Lettuce Party win streak and favourite opener', () => {
  it('counts wins in a row per player, resets on a loss, keeps the best, and tallies first guesses', async () => {
    const { code, clients } = await room('lettuce-party', ['Ann', 'Bob']);
    const [ann, bob] = clients;
    const tokens = await Promise.all(clients.map(async (c) => (await c.next((m) => m.t === 'guest')).token as string));
    ann.send({ t: 'start' });
    const roundOf = async (winner: 'ann' | 'bob', opener: string, n: number) => {
      await ann.state((s) => s.status === 'playing' && s.round === n);
      const word = await inner(code, (r) => r.word);
      const w = winner === 'ann' ? ann : bob;
      w.send({ t: 'guess', word: opener });
      w.send({ t: 'guess', word });
      await w.next((m) => m.t === 'result' && m.pattern === 'hhhhh');
      ann.send({ t: 'endRound' });
      await ann.state((s) => s.status === 'ended');
    };
    await roundOf('ann', 'crane', 1);
    ann.send({ t: 'next' });
    await roundOf('ann', 'crane', 2);
    ann.send({ t: 'next' });
    await roundOf('bob', 'slate', 3);
    let a = await myStats(tokens[0]);
    for (let i = 0; i < 20 && a.rounds !== 3; i++) { await sleep(50); a = await myStats(tokens[0]); }
    const b = await myStats(tokens[1]);
    expect(a).toMatchObject({ rounds: 3, wins: 2, streak: 0, bestStreak: 2, 'opener:crane': 2 });
    expect(b).toMatchObject({ rounds: 3, wins: 1, streak: 1, bestStreak: 1, 'opener:slate': 1 });
  });
});
