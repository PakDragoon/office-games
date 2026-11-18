import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as E from '../../web/lettuce-party/js/engine.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function guest(): Promise<{ token: string; id: string }> {
  const res = await SELF.fetch('https://play.test/api/guest', { method: 'POST' });
  const { token } = (await res.json()) as { token: string };
  return { token, id: `g:${token.slice(0, token.lastIndexOf('.'))}` };
}

const call = (token: string, mode: string, action: string, body: Json = {}) =>
  SELF.fetch(`https://play.test/api/lettuce-party/daily/${action}?mode=${mode}`, {
    method: 'POST',
    headers: { 'X-Guest': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Leafy', ...body }),
  }).then((r) => r.json() as Promise<Json>);

const board = (token: string, mode: string) =>
  SELF.fetch(`https://play.test/api/lettuce-party/daily/board?mode=${mode}`, { headers: { 'X-Guest': token } }).then((r) => r.json() as Promise<Json>);

const today = () => new Date().toISOString().slice(0, 10);

/** The secret word the server holds (the test peeks; the API must not show it before the end). */
async function session(id: string, mode: string): Promise<Json> {
  const row = await env.DB.prepare('SELECT state FROM daily_sessions WHERE game = ?1 AND day = ?2 AND player_id = ?3')
    .bind(`lettuce-party:${mode}`, today(), id)
    .first<{ state: string }>();
  return JSON.parse(row!.state);
}

async function secret(id: string, mode: string): Promise<string> {
  const row = await env.DB.prepare('SELECT state FROM daily_sessions WHERE game = ?1 AND day = ?2 AND player_id = ?3')
    .bind(`lettuce-party:${mode}`, today(), id)
    .first<{ state: string }>();
  return JSON.parse(row!.state).word;
}

const OTHER = ['crane', 'pious', 'lofty', 'nymph', 'skirt', 'gumbo', 'beach', 'ditch'];
const wrongWords = (word: string) => OTHER.filter((w) => w !== word);

describe('lettuce party dailies on the server', () => {
  it('has a daily per mode and refuses a mode it does not have', async () => {
    const { token } = await guest();
    expect((await call(token, 'classic', 'state')).attempts).toBe(6);
    expect((await call(token, 'counts', 'state')).attempts).toBe(8);
    const res = await SELF.fetch('https://play.test/api/lettuce-party/daily/state?mode=bogus', { method: 'POST', headers: { 'X-Guest': token } });
    expect(res.status).toBe(404);
  });

  it('Classic: colours each guess, keeps the word secret until solved, ranks by guesses then time', async () => {
    const { token, id } = await guest();
    expect((await call(token, 'classic', 'guess', { word: 'crane' })).error).toBe('not started');
    await call(token, 'classic', 'next');
    const word = await secret(id, 'classic');
    expect((await call(token, 'classic', 'guess', { word: 'zzzzz' })).error).toBe('Not in word list');
    expect((await call(token, 'classic', 'guess', { word: 'abc' })).error).toBe('Not enough letters');
    const first = wrongWords(word)[0];
    const d = await call(token, 'classic', 'guess', { word: first });
    expect(d.last).toEqual({ word: first, pattern: E.score(first, word) });
    expect(d.word).toBeNull();
    expect(JSON.stringify(d)).not.toContain(`"${word}"`);
    const won = await call(token, 'classic', 'guess', { word });
    expect(won.done).toBe(true);
    expect(won.solved).toBe(true);
    expect(won.word).toBe(word);
    const b = await board(token, 'classic');
    const mine = b.top.find((r: Json) => r.me);
    expect(E.dailyParts(mine.score).n).toBe(2);
    expect(mine.detail).toMatch(/^2\/6 · \d+:\d\d$/);
    // One try: nothing more is accepted
    expect((await call(token, 'classic', 'guess', { word: first })).guesses).toHaveLength(2);
    const stats = (await (await SELF.fetch('https://play.test/api/me/stats?game=lettuce-party', { headers: { 'X-Guest': token } })).json()) as Json;
    expect(stats.stats.dailyClassicPlays).toBe(1);
    expect(E.dailyParts(stats.stats.dailyClassicBest).n).toBe(2);
    // Classic's own room stats are untouched
    expect(stats.stats.wins ?? 0).toBe(0);
  });

  it('Counts: only the three numbers until the end, 8 guesses, a miss ranks below every solve', async () => {
    const a = await guest();
    await call(a.token, 'counts', 'next');
    const word = await secret(a.id, 'counts');
    let d: Json = {};
    for (const w of wrongWords(word).slice(0, 8)) {
      d = await call(a.token, 'counts', 'guess', { word: w });
      if (!d.done) {
        expect(d.last.pattern).toBeUndefined();
        expect(d.last.counts).toEqual(E.countsFor(w, word));
        expect(d.patterns).toBeNull();
      }
    }
    expect(d.done).toBe(true);
    expect(d.solved).toBe(false);
    expect(d.word).toBe(word);
    expect(d.patterns).toHaveLength(8);
    const b = await guest();
    await call(b.token, 'counts', 'next');
    for (const w of wrongWords(word).slice(0, 7)) await call(b.token, 'counts', 'guess', { word: w });
    await call(b.token, 'counts', 'guess', { word });
    const top = (await board(b.token, 'counts')).top;
    const ia = top.findIndex((r: Json) => r.detail.startsWith('X/8'));
    const ib = top.findIndex((r: Json) => r.me);
    expect(ib).toBeLessThan(ia);
  });

  it('gives each mode its own word', async () => {
    const { token, id } = await guest();
    await call(token, 'classic', 'next');
    await call(token, 'counts', 'next');
    const words = [await secret(id, 'classic'), await secret(id, 'counts')];
    // Same seed source, different salts: they can only match by a rare coincidence
    expect(words[0]).toMatch(/^[a-z]{5}$/);
    expect(words[1]).toMatch(/^[a-z]{5}$/);
  });

  it('Word ladder: public start and target, every step checked, the shortest path only at the end', async () => {
    const { token, id } = await guest();
    const d = await call(token, 'ladder', 'state');
    expect(d.ladder).toBeNull();   // nothing before you start
    const s = await call(token, 'ladder', 'next');
    expect(s.ladder.start).toMatch(/^[a-z]{5}$/);
    expect(s.ladder.path).toBeNull();
    const path: string[] = (await session(id, 'ladder')).ladder.path;
    expect(path[0]).toBe(s.ladder.start);
    expect((await call(token, 'ladder', 'guess', { word: 'zzzzz' })).error).toBeTruthy();
    // Two letters at once is refused
    const two = path[2];
    if (two && E.diffCount(s.ladder.start, two) === 2) expect((await call(token, 'ladder', 'guess', { word: two })).error).toBe('Change exactly one letter');
    let r: Json = {};
    for (const w of path.slice(1)) r = await call(token, 'ladder', 'guess', { word: w });
    expect(r.done).toBe(true);
    expect(r.solved).toBe(true);
    expect(r.ladder.path).toEqual(path);
    const mine = (await board(token, 'ladder')).top.find((x: Json) => x.me);
    expect(E.dailyParts(mine.score).n).toBe(path.length - 1);
    expect(mine.detail).toContain(`par ${s.ladder.par}`);
  });

  it('Word ladder: giving up ends it below every finish, and only the ladder can be given up', async () => {
    const a = await guest();
    await call(a.token, 'ladder', 'next');
    const g = await call(a.token, 'ladder', 'giveup');
    expect(g.done).toBe(true);
    expect(g.solved).toBe(false);
    expect(g.gaveUp).toBe(true);
    expect(g.ladder.path.length).toBeGreaterThan(2);
    const top = (await board(a.token, 'ladder')).top;
    expect(top.find((x: Json) => x.me).detail).toBe('didn’t reach it');
    const b = await guest();
    await call(b.token, 'classic', 'next');
    expect((await call(b.token, 'classic', 'giveup')).error).toBe('unknown action');
  });

  it('Hot & Cold: ranks every word, keeps the word and its neighbours secret until found', async () => {
    const { token, id } = await guest();
    await call(token, 'hotcold', 'next');
    const word = await secret(id, 'hotcold');
    expect((await call(token, 'hotcold', 'guess', { word: 'qzxv' })).error).toBe('I don’t know that word');
    const probe = word === 'water' ? 'house' : 'water';
    const d = await call(token, 'hotcold', 'guess', { word: probe });
    expect(d.last.word).toBe(probe);
    expect(d.last.rank).toBeGreaterThan(1);
    expect(d.best).toBe(d.last.rank);
    expect(d.word).toBeNull();
    expect(d.nearest).toBeNull();
    expect(JSON.stringify(d)).not.toContain(`"${word}"`);
    expect((await call(token, 'hotcold', 'guess', { word: probe })).error).toBe('Already guessed');
    const won = await call(token, 'hotcold', 'guess', { word });
    expect(won.solved).toBe(true);
    expect(won.word).toBe(word);
    expect(won.nearest).toHaveLength(10);
    const mine = (await board(token, 'hotcold')).top.find((x: Json) => x.me);
    expect(E.dailyParts(mine.score).n).toBe(2);
    expect(mine.detail).toMatch(/^2 words · /);
  });

  it('Hot & Cold: a hint counts as 5 words; giving up ranks by the closest word, below every find', async () => {
    const a = await guest();
    await call(a.token, 'hotcold', 'next');
    const word = await secret(a.id, 'hotcold');
    const h = await call(a.token, 'hotcold', 'hint');
    expect(h.last.hint).toBe(true);
    expect(h.last.rank).toBeGreaterThan(1);
    await call(a.token, 'hotcold', 'guess', { word });
    const found = (await board(a.token, 'hotcold')).top.find((x: Json) => x.me);
    expect(E.dailyParts(found.score).n).toBe(1 + E.DAILY_HINT_COST);
    expect(found.detail).toContain('1 hint');
    const b = await guest();
    await call(b.token, 'hotcold', 'next');
    const g = await call(b.token, 'hotcold', 'guess', { word: word === 'water' ? 'house' : 'water' });
    const gave = await call(b.token, 'hotcold', 'giveup');
    expect(gave.done).toBe(true);
    expect(gave.word).toBe(word);
    const top = (await board(b.token, 'hotcold')).top;
    const ib = top.findIndex((x: Json) => x.me), ia = top.findIndex((x: Json) => x.score === found.score);
    expect(ib).toBeGreaterThan(ia);
    expect(top[ib].detail).toBe(`closest #${g.best.toLocaleString('en-US')}`);
  });
});
