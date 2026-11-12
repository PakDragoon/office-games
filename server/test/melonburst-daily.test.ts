import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as E from '../../web/melonburst/js/engine.js';
import { melonburstDaily } from '../src/daily/melonburst';
import { lexicon } from '../src/games/melonburst';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function guest(): Promise<{ token: string; id: string }> {
  const res = await SELF.fetch('https://play.test/api/guest', { method: 'POST' });
  const { token } = (await res.json()) as { token: string };
  return { token, id: `g:${token.slice(0, token.lastIndexOf('.'))}` };
}

const call = (token: string, action: string, body: Json = {}) =>
  SELF.fetch(`https://play.test/api/melonburst/daily/${action}`, {
    method: 'POST',
    headers: { 'X-Guest': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<Json>);

const today = () => new Date().toISOString().slice(0, 10);

/** What the server really holds for a player (the test peeks; the API must never show this). */
async function session(id: string): Promise<Json> {
  const row = await env.DB.prepare('SELECT state FROM daily_sessions WHERE game = ?1 AND day = ?2 AND player_id = ?3')
    .bind('melonburst', today(), id)
    .first<{ state: string }>();
  return JSON.parse(row!.state);
}

/** Every string anywhere in a response. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

const WRONG = [...'zxqjkvwyfb'];

/** Letters of the word, in order of first appearance. */
const rightLetters = (word: string) => [...new Set(word.split(''))];
const wrongLetters = (word: string, n: number) => WRONG.filter((c) => !word.includes(c)).slice(0, n);

async function play(token: string, id: string, plan: { wrong: number; solve: boolean }): Promise<Json> {
  await call(token, 'next');
  const word = (await session(id)).word as string;
  let d: Json = {};
  for (const ch of wrongLetters(word, plan.wrong)) d = await call(token, 'guess', { ch, name: 'P' });
  if (plan.solve) for (const ch of rightLetters(word)) d = await call(token, 'guess', { ch, name: 'P' });
  return d;
}

describe('melon burst daily on the server', () => {
  it('needs a player', async () => {
    const res = await SELF.fetch('https://play.test/api/melonburst/daily/state', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('shows nothing about the word before the start and never sends it while playing', async () => {
    const g = await guest();
    let d = await call(g.token, 'state');
    expect(d.number).toBe(E.dayNumber(today()));
    expect(d).toMatchObject({ started: false, len: null, mask: '', word: null, bands: 6, wrong: 0, done: false });
    const word = (await session(g.id)).word as string;
    expect(word).toMatch(/^[a-z]{5,9}$/);
    const seen: Json[] = [d];
    d = await call(g.token, 'next');
    seen.push(d);
    expect(d).toMatchObject({ started: true, len: word.length, mask: '_'.repeat(word.length), word: null });
    // a few right and wrong letters, then check every reply and a fresh state
    for (const ch of [word[0], ...wrongLetters(word, 3)]) seen.push(await call(g.token, 'guess', { ch }));
    seen.push(await call(g.token, 'state'));
    expect(seen.at(-1)!.done).toBe(false);
    for (const r of seen) {
      expect(r.word).toBeNull();
      for (const s of strings(r)) expect(s === word || s.includes(word), `leaked in ${JSON.stringify(r)}`).toBe(false);
    }
    // the mask only shows letters that were guessed
    const last = seen.at(-1)!;
    for (let i = 0; i < word.length; i++) expect(last.mask[i] === '_' || last.guessed.includes(last.mask[i])).toBe(true);
  });

  it('gives everyone the same everyday word, from the secret key and not the date', async () => {
    const a = await guest(), b = await guest();
    await call(a.token, 'state');
    await call(b.token, 'state');
    const wa = (await session(a.id)).word, wb = (await session(b.id)).word;
    expect(wa).toBe(wb);
    expect(lexicon().common).toContain(wa);
    expect(wa.length).toBeGreaterThanOrEqual(5);
    expect(wa.length).toBeLessThanOrEqual(9);
    // the secret decides: another key, another word; and the plain-date word is not it
    expect(melonburstDaily.start(today(), 'key-a').word).toBe(melonburstDaily.start(today(), 'key-a').word);
    const words = new Set(['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].map((k) => melonburstDaily.start(today(), k).word));
    expect(words.size).toBeGreaterThan(3);
    expect(E.dailyWord(lexicon(), today())).not.toBe(wa);
  });

  it('validates letters and does not punish repeats', async () => {
    const g = await guest();
    let d = await call(g.token, 'guess', { ch: 'a' });
    expect(d.error).toBe('not started');
    expect(d.guessed).toEqual([]);
    await call(g.token, 'next');
    const word = (await session(g.id)).word as string;
    for (const ch of ['', 'ab', '1', ' ', 'é', '-', null, 5, { x: 1 }, ['a'], undefined]) {
      d = await call(g.token, 'guess', { ch });
      expect(d.error, JSON.stringify(ch)).toBe('invalid');
      expect(d.guessed).toEqual([]);
      expect(d.wrong).toBe(0);
    }
    const bad = wrongLetters(word, 1)[0];
    d = await call(g.token, 'guess', { ch: bad.toUpperCase() });      // capitals count as the same letter
    expect(d).toMatchObject({ wrong: 1, guessed: [bad], hit: false });
    d = await call(g.token, 'guess', { ch: bad });
    expect(d.error).toBe('repeat');
    expect(d.wrong).toBe(1);
    expect(d.guessed).toEqual([bad]);
    d = await call(g.token, 'bogus');
    expect(d.error).toBe('unknown action');
  });

  it('counts right and wrong letters and solves', async () => {
    const g = await guest();
    await call(g.token, 'next');
    const word = (await session(g.id)).word as string;
    const [w1, w2] = wrongLetters(word, 2);
    let d = await call(g.token, 'guess', { ch: w1 });
    expect(d).toMatchObject({ wrong: 1, hit: false, solved: false, done: false, mask: '_'.repeat(word.length) });
    d = await call(g.token, 'guess', { ch: word[0], name: 'Solver' });
    expect(d.hit).toBe(true);
    expect(d.wrong).toBe(1);
    expect(d.mask[0]).toBe(word[0]);
    for (let i = 0; i < word.length; i++) expect(d.mask[i] === word[0] ? word[i] === word[0] : d.mask[i] === '_' || word[i] === d.mask[i]).toBe(true);
    d = await call(g.token, 'guess', { ch: w2 });
    expect(d.wrong).toBe(2);
    for (const ch of rightLetters(word)) d = await call(g.token, 'guess', { ch, name: 'Solver' });
    expect(d).toMatchObject({ done: true, solved: true, burst: false, word, wrong: 2, mask: word });
    expect(d.points).toBe(10 + 6 - 2);
    const stats = (await (await SELF.fetch('https://play.test/api/me/stats?game=melonburst', { headers: { 'X-Guest': g.token } })).json()) as Json;
    expect(stats.stats.dailies).toBe(1);
    expect(E.dailyParts(stats.stats.bestDaily)).toMatchObject({ solved: true, wrong: 2 });
  });

  it('bursts on the seventh wrong letter and then reveals the word', async () => {
    const g = await guest();
    await call(g.token, 'next');
    const word = (await session(g.id)).word as string;
    const wrong = wrongLetters(word, 7);
    let d: Json = {};
    for (const [i, ch] of wrong.entries()) {
      d = await call(g.token, 'guess', { ch, name: 'Boom' });
      expect(d.done).toBe(i === 6);
    }
    expect(d).toMatchObject({ burst: true, solved: false, wrong: 7, word, points: 0 });
  });

  it('allows one try a day: nothing counts once it is over, and a refresh just shows the result', async () => {
    const g = await guest();
    const first = await play(g.token, g.id, { wrong: 1, solve: true });
    expect(first.done).toBe(true);
    const frozen = await session(g.id);
    // more letters, a restart and a new "next" change nothing
    const more = await call(g.token, 'guess', { ch: wrongLetters(frozen.word, 1)[0] });
    expect(more).toMatchObject({ done: true, wrong: 1, solved: true });
    expect(more.error).toBeUndefined();
    await call(g.token, 'next');
    expect(await session(g.id)).toEqual(frozen);
    const again = await call(g.token, 'state');
    expect(again).toMatchObject({ done: true, solved: true, word: frozen.word, wrong: 1, ms: first.ms });
    // still one result and one count in the stats
    const board = (await (await SELF.fetch('https://play.test/api/melonburst/daily/board', { headers: { 'X-Guest': g.token } })).json()) as Json;
    expect(board.top.filter((r: Json) => r.me)).toHaveLength(1);
    const stats = (await (await SELF.fetch('https://play.test/api/me/stats?game=melonburst', { headers: { 'X-Guest': g.token } })).json()) as Json;
    expect(stats.stats.dailies).toBe(1);
  });

  it('resumes mid-game with the same letters and a clock that kept running', async () => {
    const g = await guest();
    await call(g.token, 'next');
    const word = (await session(g.id)).word as string;
    await call(g.token, 'guess', { ch: word[0] });
    const bad = wrongLetters(word, 1)[0];
    await call(g.token, 'guess', { ch: bad });
    // pretend the tab was away for two minutes
    const s = await session(g.id);
    await env.DB.prepare('UPDATE daily_sessions SET state = ?1 WHERE game = ?2 AND player_id = ?3 AND day = ?4')
      .bind(JSON.stringify({ ...s, startedAt: s.startedAt - 120000 }), 'melonburst', g.id, today()).run();
    const back = await call(g.token, 'state');
    expect(back).toMatchObject({ started: true, done: false, wrong: 1, guessed: [word[0], bad], len: word.length, word: null });
    expect(back.ms).toBeGreaterThanOrEqual(120000);
    expect(back.mask[0]).toBe(word[0]);
    // and "next" after a refresh does not restart the clock
    const again = await call(g.token, 'next');
    expect(again.ms).toBeGreaterThanOrEqual(120000);
  });

  it('ranks solved before burst, then fewer wrong letters, then faster', async () => {
    const players = await Promise.all(Array.from({ length: 5 }, () => guest()));
    const [clean, slow, twoWrong, burstA, burstB] = players;
    const names = ['Clean', 'Slow', 'Two', 'BurstA', 'BurstB'];
    const run = async (p: { token: string; id: string }, name: string, plan: { wrong: number; solve: boolean }, startedAgo = 0) => {
      await call(p.token, 'next');
      const s = await session(p.id);
      if (startedAgo) {
        await env.DB.prepare('UPDATE daily_sessions SET state = ?1 WHERE game = ?2 AND player_id = ?3 AND day = ?4')
          .bind(JSON.stringify({ ...s, startedAt: s.startedAt - startedAgo }), 'melonburst', p.id, today()).run();
      }
      for (const ch of wrongLetters(s.word, plan.wrong)) await call(p.token, 'guess', { ch, name });
      if (plan.solve) for (const ch of rightLetters(s.word)) await call(p.token, 'guess', { ch, name });
      else await call(p.token, 'guess', { ch: s.word[0], name }); // burst order test needs plan.wrong = 7 (done by then)
    };
    // Finish the burst ones first: BurstB found a letter before bursting, BurstA found none
    await run(burstA, names[3], { wrong: 7, solve: false });
    {
      await call(burstB.token, 'next');
      const s = await session(burstB.id);
      await call(burstB.token, 'guess', { ch: s.word[0], name: names[4] });
      for (const ch of wrongLetters(s.word, 7)) await call(burstB.token, 'guess', { ch, name: names[4] });
    }
    await run(twoWrong, names[2], { wrong: 2, solve: true });
    await run(slow, names[1], { wrong: 0, solve: true }, 90000);
    await run(clean, names[0], { wrong: 0, solve: true });
    const board = (await (await SELF.fetch('https://play.test/api/melonburst/daily/board', { headers: { 'X-Guest': clean.token } })).json()) as Json;
    const order = board.top.map((r: Json) => r.name).filter((n: string) => names.includes(n));
    expect(order).toEqual(['Clean', 'Slow', 'Two', 'BurstB', 'BurstA']);
    expect(board.number).toBe(E.dayNumber(today()));
    const mine = board.top.find((r: Json) => r.me);
    expect(mine.name).toBe('Clean');
    expect(board.me.rank).toBe(mine.rank);
    expect(board.players).toBeGreaterThanOrEqual(5);
    // the board never carries the word, nor which letters were right or wrong
    for (const r of board.top) expect(Object.keys(r).sort()).toEqual(['detail', 'me', 'name', 'rank', 'score']);
    expect(board.top.find((r: Json) => r.name === 'BurstB').detail).toBe('burst');
    expect(board.top.find((r: Json) => r.name === 'Two').detail).toBe('2 wrong');
    // scores read back
    expect(E.dailyParts(board.top.find((r: Json) => r.name === 'Slow').score)).toMatchObject({ solved: true, wrong: 0 });
    expect(E.dailyParts(board.top.find((r: Json) => r.name === 'Slow').score).ms).toBeGreaterThanOrEqual(90000);
    const hiddenOf = (n: string) => E.dailyParts(board.top.find((r: Json) => r.name === n).score).hidden;
    expect(hiddenOf('BurstB')).toBeLessThan(hiddenOf('BurstA'));
  });

  it('keeps one letter at a time: parallel guesses cannot all be applied', async () => {
    const g = await guest();
    await call(g.token, 'next');
    const word = (await session(g.id)).word as string;
    const letters = [...E.LETTERS].filter((c) => !word.includes(c)).slice(0, 8);
    const replies = await Promise.all(letters.map((ch) => call(g.token, 'guess', { ch })));
    const applied = replies.filter((r) => !r.error);
    const busy = replies.filter((r) => r.error === 'busy');
    expect(applied.length + busy.length).toBe(letters.length);
    // exactly the letters that were accepted are in the saved session: nothing was learnt for free
    expect((await session(g.id)).guessed.length).toBe(applied.length);
    expect(applied.length).toBeGreaterThanOrEqual(1);
    for (const r of busy) expect(r.word === null || r.done).toBe(true);
  });
});
