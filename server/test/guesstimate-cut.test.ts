import { describe, expect, it } from 'vitest';
import * as R from '../../web/guesstimate/js/rounds.js';
import { room } from './helpers';

// A perfect cut as a browser would send it: two points 200 apart on the line, not its far ends
function shortPerfect(pz: Record<string, unknown>, deg: number): number[] {
  const [x1, y1, x2, y2] = R.perfectCut(pz, deg) as number[];
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, len = Math.hypot(x2 - x1, y2 - y1);
  const dx = ((x2 - x1) / len) * 100, dy = ((y2 - y1) / len) * 100;
  return [mx - dx, my - dy, mx + dx, my + dy].map((v) => Math.round(v * 10) / 10);
}

describe('guesstimate: Cut', () => {
  it('takes a line as the guess, refuses anything else, and scores the halves on the server', async () => {
    const { clients } = await room('guesstimate', ['Ann', 'Bob']);
    const [ann, bob] = clients;
    ann.send({ t: 'start', settings: { difficulty: 'hard', kinds: ['cut'], laps: 1, timer: 0 } });
    const s = await ann.state((v) => v.status === 'playing');
    const pz = R.makeSet(s.gameSeed as number, ['cut'], 1, 'hard')[0];
    expect(pz.kind).toBe('cut');

    // Not a line, a line too short to point anywhere, a line far off the board: ignored
    for (const bad of [0.5, [10, 10, 12, 12], [0, 0, 900, 900], 'cut']) ann.send({ t: 'guess', index: 0, guess: bad });
    ann.send({ t: 'guess', index: 0, guess: shortPerfect(pz, 30) });
    const locked = await bob.state((v) => (v.players as Array<{ locked: boolean }>).some((p) => p.locked));
    expect((locked.players as Array<{ name: string; locked: boolean }>).find((p) => p.name === 'Ann')!.locked).toBe(true);
    // The guess stays hidden until the reveal
    expect(JSON.stringify(locked)).not.toContain(String(shortPerfect(pz, 30)[0]));

    // A line that misses the shape leaves it all on one side: 0
    bob.send({ t: 'guess', index: 0, guess: [3, 0, 3, R.BOX.h] });
    const r = await ann.state((v) => v.status === 'reveal');
    const byName = Object.fromEntries((r.players as Array<{ name: string; points: number[]; guess: unknown }>).map((p) => [p.name, p]));
    expect(byName.Ann.points[0]).toBe(100);
    expect(byName.Bob.points[0]).toBe(0);
    expect(byName.Ann.guess).toEqual(shortPerfect(pz, 30));
  });
});
