import { SELF } from 'cloudflare:test';
import { PROTOCOL } from '../src/core/game';
import { describe, expect, it } from 'vitest';
import EN_TEXT from '../../web/rotten/words/en.txt';
import { SortedWords } from '../src/core/words';
import * as E from '../../web/rotten/js/engine.js';

describe('SortedWords', () => {
  const words = EN_TEXT.split('\n').filter(Boolean);
  const list = new SortedWords(EN_TEXT);

  it('finds every word a Set finds, at the edges and in between', () => {
    const picks = [words[0], words[1], words[words.length - 1], words[words.length - 2]];
    for (let i = 0; i < 3000; i++) picks.push(words[Math.floor(Math.random() * words.length)]);
    for (const w of picks) expect(list.has(w), w).toBe(true);
  });

  it('rejects words that are not there, including near misses', () => {
    const set = new Set(words);
    const probes = ['', 'a', 'zzzzzz', 'aaaaaaaaaa', 'banan', 'bananaz', 'xqj', 'a\nb'];
    for (let i = 0; i < 2000; i++) {
      const w = words[Math.floor(Math.random() * words.length)];
      probes.push(w + 'q', w.slice(0, -1) + 'z', 'q' + w);
    }
    for (const w of probes) expect(list.has(w), w).toBe(set.has(w));
  });

  it('costs well under a millisecond per lookup with no set-up (fits the free 10 ms CPU limit)', () => {
    const fresh = new SortedWords(EN_TEXT);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) fresh.has(words[(i * 7919) % words.length]);
    // performance.now() only advances on I/O inside workerd, so this mostly guards against
    // an accidental O(n) implementation sneaking in (which would hang far longer).
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

async function guestToken(): Promise<string> {
  // Any room hands out a guest token on join
  const res = await SELF.fetch('https://play.test/rotten/ws?create=1', { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const token = await new Promise<string>((resolve) => {
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as { t: string; token?: string };
      if (m.t === 'guest' && m.token) resolve(m.token);
    });
    ws.send(JSON.stringify({ t: 'join', v: PROTOCOL, name: 'Daily', client: 'tab-daily' }));
  });
  ws.close();
  return token;
}

const daily = (token: string, action: string, body: Record<string, unknown> = {}) =>
  SELF.fetch(`https://play.test/api/rotten/daily/${action}`, {
    method: 'POST',
    headers: { 'X-Guest': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<Record<string, unknown>>);

describe('rotten daily on the server', () => {
  it('needs a player', async () => {
    const res = await SELF.fetch('https://play.test/api/rotten/daily/state', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('reveals one prompt at a time, times answers itself, and ranks the finished daily', async () => {
    const token = await guestToken();
    let s = await daily(token, 'state');
    expect(s.idx).toBe(0);
    expect(s.prompt).toBeNull();                 // nothing shown before the countdown
    s = await daily(token, 'next');
    const first = s.prompt as string;
    expect(first).toMatch(/^[a-z]{2,3}$/);
    // A wrong word changes nothing
    s = await daily(token, 'answer', { word: 'zzzz' });
    expect(s.error).toBeTruthy();
    expect(s.idx).toBe(0);
    // Find a real word for each prompt from the same list the server uses
    const words = EN_TEXT.split('\n').filter(Boolean);
    const used = new Set<string>();
    for (let i = 0; i < E.DAILY_COUNT; i++) {
      const prompt = s.prompt as string;
      if (i === 3) {
        s = await daily(token, 'skip', { name: 'Daily' });
        expect(s.skipped).toBe(true);
        continue;
      }
      const w = words.find((x) => x.length >= 6 && x.includes(prompt) && !used.has(E.stemKey(x)) && /^[a-z]+$/.test(x) && !/(s|ed|ing|er)$/.test(x));
      expect(w, prompt).toBeTruthy();
      used.add(E.stemKey(w as string));
      s = await daily(token, 'answer', { word: w, name: 'Daily' });
      expect(s.error, `${prompt} ${w}`).toBeUndefined();
    }
    expect(s.done).toBe(true);
    expect((s.times as unknown[]).filter((t) => t === null)).toHaveLength(1);
    expect(s.total as number).toBeGreaterThanOrEqual(E.DAILY_SKIP_MS);
    // Further answers are ignored once done
    const after = await daily(token, 'answer', { word: 'anything' });
    expect(after.done).toBe(true);
    const board = (await (await SELF.fetch('https://play.test/api/rotten/daily/board', { headers: { 'X-Guest': token } })).json()) as Record<string, unknown>;
    expect(board.players).toBeGreaterThanOrEqual(1);
    expect((board.me as Record<string, unknown>).rank).toBe(1);
    expect((board.top as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 'Daily', me: true });
  });

  it('derives the prompts from the secret key, not the public date', async () => {
    const { rottenDaily } = await import('../src/daily/rotten');
    const today = new Date().toISOString().slice(0, 10);
    const a = rottenDaily.start(today, 'secret-a').prompts;
    expect(a).toEqual(rottenDaily.start(today, 'secret-a').prompts);   // same for everyone today
    expect(a).not.toEqual(rottenDaily.start(today, 'secret-b').prompts);
    expect(a).not.toEqual(E.dailyPrompts(today));
  });
});
