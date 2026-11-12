import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { GameReport } from '../src/core/game';
import { dailyStreakWrites, playerStats, recordGame, TALLY_MAX, writeStats } from '../src/db/stats';

type Row = GameReport['players'][number];
const row = (guest: string, extra: Partial<Row> = {}): Row => ({
  name: 'Sam', uid: null, guest, place: 1, won: false, stats: { games: 1 }, ...extra,
});
const play = (r: Row) => recordGame(env.DB, { game: 'g', room: 'ABCD', crew: null, winner: null, players: [r] });
const stats = (guest: string, game = 'g') => playerStats(env.DB, `g:${guest}`, game);

describe('streaks', () => {
  it('adds 1 on a hit, resets to 0 on a miss, and keeps the best', async () => {
    const id = 'streak1';
    for (const hit of [true, true, true, false, true]) await play(row(id, { streaks: { streak: hit } }));
    expect(await stats(id)).toMatchObject({ streak: 1, bestStreak: 3, games: 5 });
    await play(row(id, { streaks: { streak: true } }));
    await play(row(id, { streaks: { streak: true } }));
    expect(await stats(id)).toMatchObject({ streak: 3, bestStreak: 3 });
    await play(row(id, { streaks: { streak: true } }));
    expect(await stats(id)).toMatchObject({ streak: 4, bestStreak: 4 });
  });

  it('starts at 0 / best 0 for a first-ever loss, and keeps streaks independent', async () => {
    const id = 'streak2';
    await play(row(id, { streaks: { streak: false, combo: true } }));
    expect(await stats(id)).toMatchObject({ streak: 0, bestStreak: 0, combo: 1, bestCombo: 1 });
  });

  it('keeps each game and each player apart', async () => {
    await play(row('streak3a', { streaks: { streak: true } }));
    await recordGame(env.DB, { game: 'h', room: 'ABCD', crew: null, winner: null, players: [row('streak3a', { streaks: { streak: false } })] });
    await play(row('streak3b', { streaks: { streak: true } }));
    expect(await stats('streak3a')).toMatchObject({ streak: 1, bestStreak: 1 });
    expect(await stats('streak3a', 'h')).toMatchObject({ streak: 0 });
    expect(await stats('streak3b')).toMatchObject({ streak: 1 });
  });

  it('ignores a streak name that is not a plain word', async () => {
    await play(row('streak4', { streaks: { 'x y;drop': true } }));
    expect(Object.keys(await stats('streak4'))).toEqual(['games']);
  });
});

describe('set', () => {
  it('overwrites the value', async () => {
    await writeStats(env.DB, 'g:set1', 'g', { set: { lastDay: 5 } });
    await writeStats(env.DB, 'g:set1', 'g', { set: { lastDay: 3 } });
    expect(await stats('set1')).toEqual({ lastDay: 3 });
  });
});

describe('tally', () => {
  it('counts per choice and bounds the number of different choices', async () => {
    const id = 'tally1';
    for (const w of ['crane', 'crane', 'slate']) await play(row(id, { tally: { opener: w } }));
    expect(await stats(id)).toMatchObject({ 'opener:crane': 2, 'opener:slate': 1 });
    for (let i = 0; i < TALLY_MAX + 10; i++) await play(row(id, { tally: { opener: `w${i}` } }));
    let openers = Object.keys(await stats(id)).filter((k) => k.startsWith('opener:'));
    expect(openers.length).toBe(TALLY_MAX);
    // A choice already kept still counts after the cap is reached; new ones are dropped
    await play(row(id, { tally: { opener: 'crane' } }));
    await play(row(id, { tally: { opener: 'brandnew' } }));
    const s = await stats(id);
    openers = Object.keys(s).filter((k) => k.startsWith('opener:'));
    expect(s['opener:crane']).toBe(3);
    expect(s['opener:brandnew']).toBeUndefined();
    expect(openers.length).toBe(TALLY_MAX);
  });

  it('other counters do not count towards a group, and groups do not touch each other', async () => {
    const id = 'tally2';
    for (let i = 0; i < TALLY_MAX; i++) await play(row(id, { tally: { opener: `w${i}` } }));
    await play(row(id, { tally: { finisher: 'abc' } }));
    expect((await stats(id))['finisher:abc']).toBe(1);
  });

  it('refuses keys that are not lower-case letters and numbers', async () => {
    await play(row('tally3', { tally: { opener: 'Crane!' } }));
    await play(row('tally3', { tally: { opener: '' } }));
    expect(Object.keys(await stats('tally3'))).toEqual(['games']);
  });
});

describe('day streak', () => {
  const day = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);
  const run = async (id: string, d: number) => {
    const stmts = await dailyStreakWrites(env.DB, `g:${id}`, 'dg', day(d));
    if (stmts.length) await env.DB.batch(stmts);
  };
  it('counts days in a row, restarts after a gap, keeps the best, ignores the same day twice', async () => {
    const id = 'day1';
    await run(id, 20000);
    await run(id, 20001);
    await run(id, 20002);
    expect(await stats(id, 'dg')).toMatchObject({ streak: 3, bestStreak: 3, lastDay: 20002 });
    await run(id, 20002);
    expect((await stats(id, 'dg')).streak).toBe(3);
    await run(id, 20004);
    expect(await stats(id, 'dg')).toMatchObject({ streak: 1, bestStreak: 3, lastDay: 20004 });
    await run(id, 20005);
    expect(await stats(id, 'dg')).toMatchObject({ streak: 2, bestStreak: 3 });
  });
});

describe('max', () => {
  it('never lowers a best', async () => {
    await writeStats(env.DB, 'g:max1', 'g', { max: { practiceBest: 12 } });
    await writeStats(env.DB, 'g:max1', 'g', { max: { practiceBest: 7 } });
    expect(await stats('max1')).toEqual({ practiceBest: 12 });
  });
});

describe('POST /api/<game>/practice', () => {
  async function guest(): Promise<string> {
    return ((await (await SELF.fetch('https://play.test/api/guest', { method: 'POST' })).json()) as { token: string }).token;
  }
  const post = (game: string, token: string | null, body: unknown, raw?: string) =>
    SELF.fetch(`https://play.test/api/${game}/practice`, {
      method: 'POST',
      headers: { ...(token ? { 'X-Guest': token } : {}), 'Content-Type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    });
  const mine = async (token: string, game: string) =>
    ((await (await SELF.fetch(`https://play.test/api/me/stats?game=${game}`, { headers: { 'X-Guest': token } })).json()) as { stats: Record<string, number> }).stats;

  // The per-player limit is one report every few seconds, so each check gets its own player
  it('Rotten: records the best streak ', async () => {
    const t = await guest();
    expect((await post('rotten', t, { streak: 12, ms: 60000 })).status).toBe(200);
    expect((await mine(t, 'rotten')).practiceBest).toBe(12);
  });

  it('Rotten: refuses silly numbers', async () => {
    const bad: unknown[] = [
      { streak: 0, ms: 1000 }, { streak: 501, ms: 9e6 }, { streak: -3, ms: 1000 }, { streak: 1.5, ms: 5000 },
      { streak: '9', ms: 90000 }, { streak: 50, ms: 1000 }, { streak: 10, ms: -1 }, { streak: 10 }, { ms: 1000 },
      { streak: 10, ms: 4 * 3600 * 1000 }, { streak: null, ms: null }, { streak: 1e999, ms: 1000 },
    ];
    for (const b of bad) {
      const t = await guest();
      const res = await post('rotten', t, b);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect((await mine(t, 'rotten')).practiceBest).toBeUndefined();
    }
  });

  it('Fast Fingers: adds a run, works out the speed itself, refuses impossible typing', async () => {
    const t = await guest();
    expect((await post('fast-fingers', t, { chars: 300, ms: 60000, wpm: 999 })).status).toBe(200);
    expect(await mine(t, 'fast-fingers')).toEqual({ solos: 1, plays: 1, chars: 300, bestWpm: 60 });
    const bad: unknown[] = [
      { chars: 1500, ms: 5000 },            // 300 chars a second
      { chars: 300, ms: 999 }, { chars: 19, ms: 20000 }, { chars: 1501, ms: 900000 }, { chars: 300.5, ms: 60000 },
      { chars: '300', ms: 60000 }, { chars: 300 }, {}, { chars: 300, ms: 31 * 60 * 1000 },
    ];
    for (const b of bad) {
      const u = await guest();
      expect((await post('fast-fingers', u, b)).status, JSON.stringify(b)).toBe(400);
      expect(await mine(u, 'fast-fingers')).toEqual({});
    }
  });

  it('limits how often one player can report, and needs a player', async () => {
    const t = await guest();
    expect((await post('fast-fingers', t, { chars: 300, ms: 60000 })).status).toBe(200);
    expect((await post('fast-fingers', t, { chars: 300, ms: 60000 })).status).toBe(429);
    expect((await mine(t, 'fast-fingers')).solos).toBe(1);
    expect((await post('fast-fingers', null, { chars: 300, ms: 60000 })).status).toBe(401);
    expect((await post('fast-fingers', 'forged.token', { chars: 300, ms: 60000 })).status).toBe(401);
  });

  it('rejects bodies that are not a small JSON object, and games with no practice stats', async () => {
    for (const raw of ['nope', '[1]', 'null', '"x"']) {
      const t = await guest();
      expect((await post('fast-fingers', t, null, raw)).status, raw).toBe(400);
    }
    const big = await guest();
    expect((await post('fast-fingers', big, { chars: 300, ms: 60000, pad: 'x'.repeat(600) })).status).toBe(413);
    expect((await mine(big, 'fast-fingers'))).toEqual({});
    const t = await guest();
    expect((await post('liar', t, { streak: 3 })).status).toBe(404);
    expect((await post('nosuchgame', t, {})).status).toBe(404);
  });
});

describe('Guesstimate daily day streak', () => {
  it('a finished daily starts a day streak of 1 and does not count twice; Rotten dailies get none', async () => {
    const R = await import('../../web/guesstimate/js/rounds.js');
    const token = ((await (await SELF.fetch('https://play.test/api/guest', { method: 'POST' })).json()) as { token: string }).token;
    const call = (action: string, body: Record<string, unknown> = {}) =>
      SELF.fetch(`https://play.test/api/guesstimate/daily/${action}`, {
        method: 'POST', headers: { 'X-Guest': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<Record<string, any>>);   // eslint-disable-line @typescript-eslint/no-explicit-any
    let s = await call('state');
    const set = R.makeSet(s.seed, s.kinds, R.DAILY.laps, R.DAILY.difficulty);
    for (let i = 0; i < s.count; i++) s = await call('answer', { index: i, guess: set[i].answer, name: 'Daily' });
    expect(s.done).toBe(true);
    const mine = ((await (await SELF.fetch('https://play.test/api/me/stats?game=guesstimate', { headers: { 'X-Guest': token } })).json()) as { stats: Record<string, number> }).stats;
    expect(mine).toMatchObject({ dailies: 1, streak: 1, bestStreak: 1 });
    expect(mine.lastDay).toBe(Math.floor(Date.now() / 86400000));
    await call('answer', { index: 0, guess: 1 });   // finished already: ignored
    const again = ((await (await SELF.fetch('https://play.test/api/me/stats?game=guesstimate', { headers: { 'X-Guest': token } })).json()) as { stats: Record<string, number> }).stats;
    expect(again).toMatchObject({ dailies: 1, streak: 1 });
  });
});
