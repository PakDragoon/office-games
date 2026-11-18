import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as E from '../../web/fast-fingers/js/engine.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function guest(): Promise<{ token: string; id: string }> {
  const res = await SELF.fetch('https://play.test/api/guest', { method: 'POST' });
  const { token } = (await res.json()) as { token: string };
  return { token, id: `g:${token.slice(0, token.lastIndexOf('.'))}` };
}

const call = (token: string, action: string, body: Json = {}) =>
  SELF.fetch(`https://play.test/api/fast-fingers/daily/${action}`, {
    method: 'POST',
    headers: { 'X-Guest': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Typist', ...body }),
  }).then((r) => r.json() as Promise<Json>);

const today = () => new Date().toISOString().slice(0, 10);

async function session(id: string): Promise<Json> {
  const row = await env.DB.prepare('SELECT state FROM daily_sessions WHERE game = ?1 AND day = ?2 AND player_id = ?3')
    .bind('fast-fingers', today(), id)
    .first<{ state: string }>();
  return JSON.parse(row!.state);
}

/** Pretend the race began `ms` ago (the test moves the server's clock back instead of waiting). */
async function startedAgo(id: string, ms: number): Promise<void> {
  const s = await session(id);
  s.startedAt = Date.now() - ms;
  await env.DB.prepare('UPDATE daily_sessions SET state = ?1 WHERE game = ?2 AND day = ?3 AND player_id = ?4')
    .bind(JSON.stringify(s), 'fast-fingers', today(), id)
    .run();
}

describe('fast fingers daily on the server', () => {
  it('keeps the paragraph secret until you start, then counts down before the clock runs', async () => {
    const { token } = await guest();
    const d = await call(token, 'state');
    expect(d.started).toBe(false);
    expect(d.text).toBe('');
    expect(d.words).toBeGreaterThanOrEqual(40);
    const s = await call(token, 'next');
    expect(s.started).toBe(true);
    expect(s.text.length).toBeGreaterThan(150);
    expect(s.elapsed).toBeLessThan(0);   // still in the 3-2-1
    // Nothing can be finished during the countdown
    const early = await call(token, 'finish', { pos: s.text.length, err: 0, ms: 100 });
    expect(early.error).toBe('not started');
    // A second start doesn't restart the clock
    const again = await call(token, 'next');
    expect(again.elapsed).toBeGreaterThanOrEqual(s.elapsed);
  });

  it('times a finished run, takes the page clock only when it agrees, and ranks by speed', async () => {
    const { token, id } = await guest();
    const { text } = await call(token, 'next');
    await startedAgo(id, 20000);
    const d = await call(token, 'finish', { pos: text.length, err: 3, ms: 19600 });
    expect(d.done).toBe(true);
    expect(d.finished).toBe(true);
    expect(d.ms).toBe(19600);
    expect(d.wpm).toBe(E.wpm(text.length, 19600));
    // Done is done: a second finish changes nothing
    const again = await call(token, 'finish', { pos: text.length, err: 0, ms: 5000 });
    expect(again.ms).toBe(19600);
    const board = (await (await SELF.fetch('https://play.test/api/fast-fingers/daily/board', { headers: { 'X-Guest': token } })).json()) as Json;
    const mine = board.top.find((r: Json) => r.me);
    expect(mine.score).toBe(E.dailyScore(text.length, text.length, 19600, true));
    expect(mine.detail).toContain('wpm');
    const stats = (await (await SELF.fetch('https://play.test/api/me/stats?game=fast-fingers', { headers: { 'X-Guest': token } })).json()) as Json;
    expect(stats.stats).toMatchObject({ dailies: 1, streak: 1, bestStreak: 1 });
  });

  it('uses its own clock when the page claims a faster time, and refuses an impossible finish', async () => {
    const a = await guest();
    const { text } = await call(a.token, 'next');
    await startedAgo(a.id, 30000);
    const d = await call(a.token, 'finish', { pos: text.length, err: 0, ms: 12000 });
    expect(d.ms).toBeGreaterThanOrEqual(29900);
    const b = await guest();
    await call(b.token, 'next');
    await startedAgo(b.id, 1000);
    const fake = await call(b.token, 'finish', { pos: text.length, err: 0, ms: 900 });
    expect(fake.error).toBe('invalid');
    expect(fake.done).toBeFalsy();
  });

  it('only takes an unfinished run once time is up, and ranks it below every finish', async () => {
    const { token, id } = await guest();
    const { text, limit } = await call(token, 'next');
    await startedAgo(id, 10000);
    const early = await call(token, 'finish', { pos: 40, err: 1 });
    expect(early.error).toBe('not finished');
    await startedAgo(id, limit + 500);
    const d = await call(token, 'finish', { pos: Math.floor(text.length / 2), err: 1 });
    expect(d.done).toBe(true);
    expect(d.finished).toBe(false);
    const board = (await (await SELF.fetch('https://play.test/api/fast-fingers/daily/board', { headers: { 'X-Guest': token } })).json()) as Json;
    const mine = board.top.find((r: Json) => r.me);
    expect(mine.score).toBeLessThan(1);
    expect(mine.detail).toContain('ran out of time');
  });

  it('refuses nonsense', async () => {
    const { token, id } = await guest();
    const { text } = await call(token, 'next');
    await startedAgo(id, 30000);
    for (const body of [{ pos: -1, err: 0 }, { pos: text.length + 1, err: 0 }, { pos: 'x', err: 0 }, { pos: text.length, err: -2 }]) {
      expect((await call(token, 'finish', body)).error).toBe('invalid');
    }
    expect((await call(token, 'jump')).error).toBe('unknown action');
  });
});
