import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as E from '../../web/a-to-zap/js/engine.js';
import { BEST_STATS } from '../src/db/stats';
import type { RoomCtx } from '../src/core/game';
import { atozap, onList } from '../src/games/atozap';
import { room, sleep, TestClient, type Msg } from './helpers';

const GAME = 'a-to-zap';
const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(`${GAME}:${code}`));

interface RoomShape {
  status: string;
  letter: string | null;
  used: string[];
  round: number;
  totalRounds: number;
  lockAt: number;
  pickerKey: string | null;
  zapBy: string | null;
  settings: { categories: string[]; time: number; rounds: number; hard: boolean };
  players: Array<{ id: string; key: string; name: string; away: boolean; connected: boolean; answers: Record<string, string>; submitted: boolean; score: number; inGame: boolean }>;
  review: Array<{ cat: string; norm: string; owners: string[]; up: string[]; down: string[] }>;
}
type Inner = { game: { room: RoomShape }; timers: Record<string, number> };
const inRoom = <T>(code: string, f: (r: RoomShape, i: Inner) => T) => runInDurableObject(stub(code), (i) => f((i as unknown as Inner).game.room, i as unknown as Inner));

/** Run a game timer now (the room's Alarm does the rest), the way §16 describes. */
async function fire(code: string, timer: string): Promise<void> {
  await inRoom(code, (_r, i) => { i.timers[timer] = Date.now(); });
  await runDurableObjectAlarm(stub(code));
}

/** Wait for the newest view that matches; older views are dropped (each player is sent a view after every change). */
/** Let typed answers reach the room, then run the round clock out (answers with blanks can't be handed in). */
async function lockRound(code: string): Promise<void> {
  await sleep(80);
  await fire(code, 'round');
}
async function seen(c: TestClient, pred: (s: Msg) => boolean, ms = 4000): Promise<Msg> {
  const end = Date.now() + ms;
  for (;;) {
    const idx = c.msgs.map((m, i) => (m.t === 'state' && pred(m) ? i : -1)).filter((i) => i >= 0).pop();
    if (idx !== undefined) {
      const hit = c.msgs[idx];
      c.msgs = c.msgs.filter((m, i) => i > idx || m.t !== 'state');
      return hit;
    }
    if (Date.now() > end) {
      const last = [...c.msgs].reverse().find((m) => m.t === 'state');
      throw new Error(`timed out waiting for a view; last status ${String(last?.status)}`);
    }
    await sleep(10);
  }
}

type P = { id: string; name: string; filled: number; submitted: boolean; score: number; inGame: boolean };
const players = (s: Msg) => s.players as P[];
const cells = (s: Msg, name: string) => ((s.results as { rows: Array<{ name: string; cells: Record<string, { raw: string; pts: number; st: string; shared: boolean }> }> }).rows.find((r) => r.name === name) as { cells: Record<string, { raw: string; pts: number; st: string; shared: boolean }> }).cells;
const total = (s: Msg, name: string) => (s.results as { rows: Array<{ name: string; total: number }> }).rows.find((r) => r.name === name)?.total;

async function lobby(names: string[], settings: Record<string, unknown> = {}) {
  const r = await room(GAME, names);
  const host = r.clients[0];
  if (Object.keys(settings).length) {
    host.send({ t: 'settings', patch: settings });
    await seen(host, (s) => Object.entries(settings).every(([k, v]) => JSON.stringify((s.settings as Record<string, unknown>)[k]) === JSON.stringify(v)));
  }
  return { ...r, host };
}

/** Start the game and wait until everyone is on the letter pick. */
async function start(g: { clients: TestClient[]; host: TestClient }) {
  g.host.send({ t: 'start' });
  const views: Msg[] = [];
  for (const c of g.clients) views.push(await seen(c, (s) => s.status === 'pick'));
  return views;
}

/** Everyone sees the round running with this letter. */
async function pickLetter(g: { clients: TestClient[]; ids: string[] }, picker: number, letter: string) {
  g.clients[picker].send({ t: 'pick', letter });
  const views: Msg[] = [];
  for (const c of g.clients) views.push(await seen(c, (s) => s.status === 'play' && s.letter === letter));
  return views;
}

const ALL = ['name', 'place', 'animal', 'produce', 'thing'];
const full = (a: Record<string, string>) => ({ name: 'Ali', place: 'Athens', animal: 'ant', produce: 'apple', thing: 'axe', ...a });

describe('A to Zap: lobby and settings', () => {
  it('starts with the default settings and needs at least two players', async () => {
    const { clients: [host], code } = await room(GAME, ['Ann']);
    host.send({ t: 'settings', patch: {} });
    const s = await seen(host, () => true);
    expect(s.settings).toEqual({ categories: ALL, time: 90, rounds: 10, hard: false });
    host.send({ t: 'start' });
    await host.next((m) => m.t === 'toast');
    expect(await inRoom(code, (r) => r.status)).toBe('lobby');
  });

  it('the host picks 4 to 8 categories, the time, the rounds and hard letters, and the server cleans them', async () => {
    const { host } = await lobby(['Ann', 'Bob']);
    host.send({ t: 'settings', patch: { categories: ['food', 'job', 'colour', 'sport', 'body'], time: 60, rounds: 5, hard: true } });
    let s = await seen(host, (v) => (v.settings as { time: number }).time === 60);
    expect(s.settings).toEqual({ categories: ['food', 'job', 'colour', 'sport', 'body'], time: 60, rounds: 5, hard: true });
    // forged or illegal values are thrown away one by one, never half-applied
    host.send({ t: 'settings', patch: { categories: ['name'], time: 61, rounds: 7, hard: 'yes', extra: 1 } });
    host.send({ t: 'settings', patch: { categories: ['name', 'place', 'animal', 'produce', 'thing', 'food', 'job', 'colour', 'sport'] } });
    host.send({ t: 'settings', patch: { time: 120 } });
    s = await seen(host, (v) => (v.settings as { time: number }).time === 120);
    expect(s.settings).toEqual({ categories: ['food', 'job', 'colour', 'sport', 'body'], time: 120, rounds: 5, hard: true });
  });

  it('settings from a player who is not the host are ignored', async () => {
    const { clients: [host, bob], code } = await lobby(['Ann', 'Bob']);
    bob.send({ t: 'settings', patch: { time: 60, hard: true } });
    bob.send({ t: 'start' });
    bob.send({ t: 'public', on: true });
    host.send({ t: 'settings', patch: { rounds: 5 } });
    await seen(host, (s) => (s.settings as { rounds: number }).rounds === 5);
    const r = await inRoom(code, (x) => ({ settings: x.settings, status: x.status }));
    expect(r).toEqual({ status: 'lobby', settings: { categories: ALL, time: 90, rounds: 5, hard: false } });
  });

  it('settings are frozen while a game is running', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    g.host.send({ t: 'settings', patch: { time: 60, rounds: 5, hard: true, categories: ['food', 'job', 'colour', 'sport'] } });
    g.host.send({ t: 'public', on: true });
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'settings', patch: { time: 120 } });
    await sleep(60);
    expect(await inRoom(g.code, (r) => ({ settings: r.settings, status: r.status }))).toEqual({ settings: { categories: ALL, time: 90, rounds: 10, hard: false }, status: 'play' });
    g.host.send({ t: 'answers', a: { name: 'Ali' } });          // a view is sent again, with the settings and public flag it still has
    const s = await seen(g.clients[1], (v) => (v.players as Array<{ filled: number }>)[0].filled === 1);
    expect(s.settings).toEqual({ categories: ALL, time: 90, rounds: 10, hard: false });
    expect(s.public).toBe(false);
  });

  it('Open to Quick Play works only from the host, in the lobby', async () => {
    const { clients: [host, bob] } = await lobby(['Ann', 'Bob']);
    bob.send({ t: 'public', on: true });
    host.send({ t: 'public', on: 'yes' });
    host.send({ t: 'public', on: true });
    expect((await seen(host, (s) => s.public === true)).public).toBe(true);
    host.send({ t: 'public', on: false });
    expect((await seen(host, (s) => s.public === false)).public).toBe(false);
  });
});

describe('A to Zap: picking the letter', () => {
  it('players take turns as the picker in seat order', async () => {
    const g = await lobby(['Ann', 'Bob', 'Cy'], { rounds: 5 });
    const names = ['Ann', 'Bob', 'Cy', 'Ann'];
    let views = await start(g);
    for (let round = 0; round < 4; round++) {
      const picker = round % 3;
      for (const v of views) {
        expect(v.pickerName).toBe(names[round]);
        expect(v.round).toBe(round + 1);
      }
      expect(views[picker].pickerId).toBe(g.ids[picker]);
      await pickLetter(g, picker, 'ABCD'[round]);
      await fire(g.code, 'round');
      for (const c of g.clients) await seen(c, (s) => s.status === 'results');
      g.host.send({ t: 'next' });
      views = [];
      for (const c of g.clients) views.push(await seen(c, (s) => s.status === 'pick' && s.round === round + 2));
    }
  });

  it('the picker has 10 seconds, then the server picks a letter at random', async () => {
    const g = await lobby(['Ann', 'Bob']);
    const [v] = await start(g);
    expect(v.pickLeft).toBeGreaterThan(9000);
    expect(v.pickLeft).toBeLessThanOrEqual(E.PICK_MS);
    expect(await inRoom(g.code, (_r, i) => i.timers.pick - Date.now())).toBeLessThanOrEqual(E.PICK_MS);
    await fire(g.code, 'pick');
    const s = await seen(g.host, (x) => x.status === 'play');
    expect(typeof s.letter).toBe('string');
    expect(E.LETTERS).toContain(s.letter as string);
    expect(s.used).toEqual([s.letter]);
  });

  it('an automatic pick never repeats a letter and never chooses Q, X or Z unless hard letters are on', async () => {
    const g = await lobby(['Ann', 'Bob'], { rounds: 5 });
    await start(g);
    const letters: string[] = [];
    for (let round = 1; round <= 5; round++) {
      await fire(g.code, 'pick');
      const s = await seen(g.host, (x) => x.status === 'play' && x.round === round);
      letters.push(s.letter as string);
      await fire(g.code, 'round');
      await seen(g.host, (x) => x.status === 'results');
      g.host.send({ t: 'next' });
      if (round < 5) await seen(g.host, (x) => x.status === 'pick' && x.round === round + 1);
    }
    expect(new Set(letters).size).toBe(5);
    expect(letters.some((l) => 'QXZ'.includes(l))).toBe(false);
    await seen(g.host, (x) => x.status === 'over');
  });

  it('only the picker can pick, and only an unused letter that is allowed', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    g.clients[1].send({ t: 'pick', letter: 'B' });     // not the picker
    g.host.send({ t: 'pick', letter: 'Q' });            // hard letter, off
    g.host.send({ t: 'pick', letter: 'a' });            // not a capital
    g.host.send({ t: 'pick', letter: 'AB' });
    g.host.send({ t: 'pick', letter: 7 });
    g.host.send({ t: 'pick', letter: 'C' });
    const s = await seen(g.host, (x) => x.status === 'play');
    expect(s.letter).toBe('C');
    // picking again in the middle of a round does nothing
    g.host.send({ t: 'pick', letter: 'D' });
    await sleep(50);
    expect(await inRoom(g.code, (r) => r.letter)).toBe('C');
  });

  it('with hard letters on, Z can be picked; a used letter greys out and cannot come back', async () => {
    const g = await lobby(['Ann', 'Bob'], { hard: true });
    await start(g);
    await pickLetter(g, 0, 'Z');
    await fire(g.code, 'round');
    await seen(g.host, (x) => x.status === 'results');
    g.host.send({ t: 'next' });
    const v = await seen(g.clients[1], (x) => x.status === 'pick' && x.round === 2);
    expect(v.used).toEqual(['Z']);
    g.clients[1].send({ t: 'pick', letter: 'Z' });
    await sleep(50);
    expect(await inRoom(g.code, (r) => r.status)).toBe('pick');
    g.clients[1].send({ t: 'pick', letter: 'Y' });
    await seen(g.host, (x) => x.status === 'play' && x.letter === 'Y');
  });

  it('a picker who has left does not stop the game: after their 10 seconds the server picks', async () => {
    const g = await lobby(['Ann', 'Bob', 'Cy']);
    await start(g);
    g.host.close();                                      // Ann is the picker
    await seen(g.clients[1], (x) => x.status === 'pick' && (x.players as Array<{ name: string; connected: boolean }>).find((p) => p.name === 'Ann')?.connected === false);
    await fire(g.code, 'pick');
    const s = await seen(g.clients[1], (x) => x.status === 'play');
    expect(s.letter).toBeTruthy();
  });

  it('the picker is skipped if Away at the start of the next round', async () => {
    const g = await lobby(['Ann', 'Bob', 'Cy']);
    await start(g);
    await pickLetter(g, 0, 'A');
    await fire(g.code, 'round');
    await seen(g.host, (x) => x.status === 'results');
    await inRoom(g.code, (r) => { r.players[1].away = true; });   // Bob, next in turn, is Away
    g.host.send({ t: 'next' });
    const v = await seen(g.host, (x) => x.status === 'pick' && x.round === 2);
    expect(v.pickerName).toBe('Cy');
  });
});

describe('A to Zap: answers and the clock', () => {
  it('shows others only how many answers you have filled in, never what they are', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'answers', a: { name: 'Ali', place: 'Athens' } });
    const s = await seen(g.clients[1], (x) => players(x).find((p) => p.name === 'Ann')?.filled === 2);
    expect(JSON.stringify(s)).not.toContain('Ali');
    expect(JSON.stringify(s)).not.toContain('Athens');
    expect(s.mine).toEqual({ answers: {}, submitted: false });
  });

  it('answers sent after the lock are ignored', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'answers', a: { animal: 'ant' } });
    await seen(g.host, (x) => players(x).find((p) => p.name === 'Ann')?.filled === 1);
    await fire(g.code, 'round');
    const r = await seen(g.host, (x) => x.status === 'results');
    g.host.send({ t: 'answers', a: { animal: 'alpaca', name: 'Ali' } });
    g.host.send({ t: 'answers', a: { animal: 'alpaca' } });
    await lockRound(g.code);   // with blanks nobody can hand in: the clock locks the round
    g.host.send({ t: 'zap', a: full({}) });
    await sleep(60);
    expect(await inRoom(g.code, (x) => ({ status: x.status, a: x.players[0].answers }))).toEqual({ status: 'results', a: { animal: 'ant' } });
    expect(cells(r, 'Ann').animal).toMatchObject({ raw: 'ant', pts: 10 });
    expect(cells(r, 'Ann').name.pts).toBe(0);
  });

  it('the server is the clock: an answer arriving after the deadline is ignored even before the timer fires', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'A');
    await inRoom(g.code, (r) => { r.lockAt = Date.now() - 1; });
    g.host.send({ t: 'answers', a: { animal: 'ant' } });
    g.host.send({ t: 'answers', a: { animal: 'ant' } });
    await lockRound(g.code);   // with blanks nobody can hand in: the clock locks the round
    await sleep(50);
    expect(await inRoom(g.code, (r) => ({ a: r.players[0].answers, s: r.players[0].submitted }))).toEqual({ a: {}, s: false });
  });

  it('the round lasts the host\'s time limit (60, 90 or 120 seconds)', async () => {
    for (const time of [60, 120]) {
      const g = await lobby(['Ann', 'Bob'], { time });
      await start(g);
      const [s] = await pickLetter(g, 0, 'A');
      expect(s.playLeft).toBeGreaterThan(time * 1000 - 1500);
      expect(s.playLeft).toBeLessThanOrEqual(time * 1000);
    }
  });

  it('answers are cleaned: only this game\'s categories, plain text, at most 40 characters', async () => {
    const g = await lobby(['Ann', 'Bob'], { categories: ['name', 'place', 'animal', 'produce'] });
    await start(g);
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'answers', a: { name: '<b>Ali</b>', thing: 'axe', place: 'A'.repeat(200), animal: 5, __proto__: { x: 1 }, constructor: 'x' } });
    await seen(g.host, (x) => players(x).find((p) => p.name === 'Ann')?.filled === 2);
    const a = await inRoom(g.code, (r) => r.players[0].answers);
    expect(a).toEqual({ name: 'bAli/b', place: 'A'.repeat(40) });
  });

  it('a round ends early when everyone who is here has submitted', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'submit', a: full({}) });
    await seen(g.clients[1], (x) => players(x).find((p) => p.name === 'Ann')?.submitted === true);
    expect(await inRoom(g.code, (r) => r.status)).toBe('play');
    g.clients[1].send({ t: 'submit', a: full({ name: 'Anna' }) });
    const r = await seen(g.host, (x) => x.status === 'results');
    expect(total(r, 'Ann')).toBe(30);   // name Ali 10 (Bob wrote Anna), the other four are the same as Bob's: 5 each
  });

  it('"I\'m done" needs every box filled: with blanks the hand-in is refused and the player keeps typing', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'submit', a: { name: 'Ali', place: 'Athens' } });
    await g.host.next((m) => m.t === 'toast');
    expect(await inRoom(g.code, (r) => ({ s: r.status, sub: r.players[0].submitted, a: r.players[0].answers })))
      .toEqual({ s: 'play', sub: false, a: { name: 'Ali', place: 'Athens' } });
    // filled in: now it's accepted
    g.host.send({ t: 'submit', a: full({}) });
    await seen(g.clients[1], (x) => players(x).find((p) => p.name === 'Ann')?.submitted === true);
  });

  it('a player who joins in the middle watches: their answers do not count and do not hold the round', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'A');
    const dan = await TestClient.open(`/${GAME}/ws?code=${g.code}`);
    dan.join('Dan');
    await dan.next((m) => m.t === 'welcome');
    const v = await seen(dan, (x) => players(x).length === 3);
    expect(v.mine).toBeNull();
    dan.send({ t: 'answers', a: { name: 'Ali' } });
    dan.send({ t: 'submit', a: full({}) });
    g.host.send({ t: 'submit', a: full({}) });
    g.clients[1].send({ t: 'submit', a: full({ name: 'Anna' }) });
    const r = await seen(g.host, (x) => x.status === 'results');
    expect((r.results as { rows: unknown[] }).rows).toHaveLength(2);
  });
});

describe('A to Zap: Zap!', () => {
  it('gives everyone else exactly 10 more seconds, then the round locks', async () => {
    const g = await lobby(['Ann', 'Bob'], { time: 120 });
    await start(g);
    await pickLetter(g, 0, 'A');
    const before = Date.now();
    g.host.send({ t: 'zap', a: full({}) });
    const s = await seen(g.clients[1], (x) => (x.zap as { by: string } | null)?.by === 'Ann');
    const after = Date.now();
    const { lockAt, timer } = await inRoom(g.code, (r, i) => ({ lockAt: r.lockAt, timer: i.timers.round }));
    expect(lockAt).toBeGreaterThanOrEqual(before + E.ZAP_MS);
    expect(lockAt).toBeLessThanOrEqual(after + E.ZAP_MS);
    expect(timer).toBe(lockAt);
    expect(E.ZAP_MS).toBe(10000);
    expect(s.playLeft).toBeGreaterThan(9000);
    expect(s.playLeft).toBeLessThanOrEqual(10000);
    // Bob can still answer inside the 10 seconds, and then the round locks
    g.clients[1].send({ t: 'answers', a: full({ name: 'Bilal' }) });
    await seen(g.clients[1], (x) => players(x).find((p) => p.name === 'Bob')?.filled === 5);
    await fire(g.code, 'round');
    const r = await seen(g.host, (x) => x.status === 'results');
    expect(cells(r, 'Bob').name.pts).toBe(0);   // Bilal does not start with A
  });

  it('Zap! cannot be pressed before every category is filled, and only the first press counts', async () => {
    const g = await lobby(['Ann', 'Bob', 'Cy']);
    await start(g);
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'zap', a: { name: 'Ali', place: 'Athens' } });
    await g.host.next((m) => m.t === 'toast');
    expect(await inRoom(g.code, (r) => r.zapBy)).toBeNull();
    g.host.send({ t: 'zap', a: { name: 'Ali', place: 'Athens', animal: '  ', produce: 'apple', thing: 'axe' } });
    await g.host.next((m) => m.t === 'toast');
    expect(await inRoom(g.code, (r) => r.zapBy)).toBeNull();
    g.clients[1].send({ t: 'zap', a: full({ name: 'Anna' }) });
    await seen(g.host, (x) => (x.zap as { by: string } | null)?.by === 'Bob');
    const first = await inRoom(g.code, (r) => r.lockAt);
    await sleep(30);
    g.clients[2].send({ t: 'zap', a: full({ name: 'Abe' }) });
    g.host.send({ t: 'zap', a: full({}) });
    await sleep(60);
    const now = await inRoom(g.code, (r) => ({ lock: r.lockAt, by: r.zapBy, c: r.players[2].submitted }));
    expect(now.lock).toBe(first);
    expect(now.c).toBe(false);
    expect(await inRoom(g.code, (r) => r.players.find((p) => p.key === r.zapBy)?.name)).toBe('Bob');
  });

  it('when everyone is in after a Zap!, the round locks without waiting the 10 seconds', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'zap', a: full({}) });
    await seen(g.clients[1], (x) => x.zap !== null);
    g.clients[1].send({ t: 'submit', a: full({ name: 'Anna', place: 'Accra' }) });
    await seen(g.host, (x) => x.status === 'results');
  });
});

describe('A to Zap: checking answers', () => {
  it('answers on the server list are accepted at once; wrong letters and blanks score nothing', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'answers', a: { name: 'ali', place: 'ATHENS', animal: 'Aardvark', produce: 'Banana', thing: '' } });
    g.clients[1].send({ t: 'answers', a: { name: 'Ayesha', place: 'Accra', animal: 'Alpaca', produce: 'Avocado', thing: 'anchor' } });
    await lockRound(g.code);   // with blanks nobody can hand in: the clock locks the round
    const r = await seen(g.host, (x) => x.status === 'results');
    expect(cells(r, 'Ann')).toMatchObject({
      name: { st: 'list', pts: 10 }, place: { st: 'list', pts: 10 }, animal: { st: 'list', pts: 10 },
      produce: { st: 'letter', pts: 0 }, thing: { st: 'blank', pts: 0 },
    });
    expect(total(r, 'Ann')).toBe(30);
    expect(total(r, 'Bob')).toBe(50);
  });

  it('accents, spaces and plurals do not stop a list answer; a leading "the" is ignored', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'N');
    g.host.send({ t: 'answers', a: { name: ' Nadía ', place: 'the Netherlands', animal: 'newts', produce: 'Nectarines', thing: 'needle' } });
    g.clients[1].send({ t: 'answers', a: {} });
    await lockRound(g.code);   // with blanks nobody can hand in: the clock locks the round
    const r = await seen(g.host, (x) => x.status === 'results');
    expect(Object.values(cells(r, 'Ann')).map((c) => c.st)).toEqual(['list', 'list', 'list', 'list', 'list']);
  });

  it('duplicates score 5, unique answers 10, case and spaces ignored', async () => {
    const g = await lobby(['Ann', 'Bob', 'Cy']);
    await start(g);
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'answers', a: { name: 'Ali', place: 'Athens', animal: 'ant', produce: 'apple', thing: 'axe' } });
    g.clients[1].send({ t: 'answers', a: { name: '  ALI ', place: 'Accra', animal: 'Ant', produce: 'apricot', thing: 'anchor' } });
    g.clients[2].send({ t: 'answers', a: { name: 'Aziz', place: 'Athens', animal: 'ant', produce: '', thing: 'anchor' } });
    await lockRound(g.code);   // with blanks nobody can hand in: the clock locks the round
    const r = await seen(g.host, (x) => x.status === 'results');
    // name: Ali x2 shared, Aziz unique; place: Athens x2 shared, Accra unique; animal: ant x3 shared; produce: all different; thing: axe unique, anchor x2 shared
    expect(cells(r, 'Ann')).toMatchObject({ name: { pts: 5, shared: true }, place: { pts: 5 }, animal: { pts: 5 }, produce: { pts: 10, shared: false }, thing: { pts: 10 } });
    expect(cells(r, 'Bob')).toMatchObject({ name: { pts: 5 }, place: { pts: 10 }, animal: { pts: 5 }, produce: { pts: 10 }, thing: { pts: 5 } });
    expect(cells(r, 'Cy')).toMatchObject({ name: { pts: 10 }, place: { pts: 5 }, animal: { pts: 5 }, produce: { pts: 0, st: 'blank' }, thing: { pts: 5 } });
    expect([total(r, 'Ann'), total(r, 'Bob'), total(r, 'Cy')]).toEqual([35, 35, 25]);
  });

  it('scores carry over from round to round within a game', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'answers', a: { name: 'Ali' } });
    g.clients[1].send({ t: 'answers', a: {} });
    await lockRound(g.code);   // with blanks nobody can hand in: the clock locks the round
    await seen(g.host, (x) => x.status === 'results');
    g.host.send({ t: 'next' });
    await seen(g.host, (x) => x.status === 'pick' && x.round === 2);
    await pickLetter(g, 1, 'B');
    g.host.send({ t: 'answers', a: { name: 'Bilal', place: 'Berlin' } });
    g.clients[1].send({ t: 'answers', a: {} });
    await lockRound(g.code);   // with blanks nobody can hand in: the clock locks the round
    const r = await seen(g.host, (x) => x.status === 'results' && x.round === 2);
    expect(players(r).map((p) => [p.name, p.score])).toEqual([['Ann', 30], ['Bob', 0]]);
  });
});

describe('A to Zap: the vote on unknown answers', () => {
  async function toReview(names: string[], answers: Array<Record<string, string>>) {
    const g = await lobby(names);
    await start(g);
    await pickLetter(g, 0, 'A');
    g.clients.forEach((c, i) => c.send({ t: 'answers', a: answers[i] }));
    await lockRound(g.code);   // with blanks nobody can hand in: the clock locks the round
    const views: Msg[] = [];
    for (const c of g.clients) views.push(await seen(c, (x) => x.status === 'review'));
    return { ...g, views };
  }
  const items = (s: Msg) => (s.review as { waiting: number; items: Array<{ i: number; cat: string; text: string; owners: string[]; mine: boolean; vote: number; canVote: boolean }> }).items;

  it('unknown answers go to a vote for 20 seconds; nobody votes on their own; the tally stays hidden', async () => {
    const g = await toReview(['Ann', 'Bob', 'Cy'], [
      { name: 'Ali', place: 'Aaaville' },
      { name: 'Ali', place: 'aaaville' },
      { name: 'Ali', place: 'Athens', animal: 'Aquaflop' },
    ]);
    expect(g.views[0].voteLeft).toBeGreaterThan(19000);
    expect(g.views[0].voteLeft).toBeLessThanOrEqual(E.VOTE_MS);
    expect(await inRoom(g.code, (_r, i) => i.timers.vote - Date.now())).toBeLessThanOrEqual(E.VOTE_MS);
    // two items: place "Aaaville" (Ann + Bob) and animal "Aquaflop" (Cy)
    const [a, b, c] = g.views.map(items);
    expect(a.map((x) => [x.cat, x.owners, x.mine, x.canVote])).toEqual([['place', ['Ann', 'Bob'], true, false], ['animal', ['Cy'], false, true]]);
    expect(b[0].mine).toBe(true);
    expect(c.map((x) => [x.mine, x.canVote])).toEqual([[false, true], [true, false]]);
    // a vote on your own answer is ignored, even sent by hand
    g.host.send({ t: 'vote', item: 0, v: 1 });
    g.clients[1].send({ t: 'vote', item: 0, v: 1 });
    g.clients[2].send({ t: 'vote', item: 1, v: -1 });
    await sleep(60);
    expect(await inRoom(g.code, (r) => r.review.map((i) => [i.up.length, i.down.length]))).toEqual([[0, 0], [0, 0]]);
    expect(JSON.stringify(g.views[0])).not.toContain('"up"');
  });

  it('a majority of thumbs-up accepts, a majority of thumbs-down rejects, a tie accepts', async () => {
    const g = await toReview(['Ann', 'Bob', 'Cy', 'Dee'], [
      { place: 'Aaaville', animal: 'Aquaflop' },     // Ann
      { name: 'Ali' },
      { name: 'Ali' },
      { name: 'Ali' },
    ]);
    // Ann's two unknown answers: place "Aaaville" gets 2 up 1 down; animal "Aquaflop" gets 1 up 2 down
    // (Ann cannot vote on her own; Bob, Cy and Dee vote.)
    // a vote can be changed until the review ends
    g.clients[1].send({ t: 'vote', item: 0, v: -1 });
    g.clients[1].send({ t: 'vote', item: 0, v: 1 });
    g.clients[2].send({ t: 'vote', item: 0, v: 1 });
    g.clients[3].send({ t: 'vote', item: 0, v: -1 });
    g.clients[1].send({ t: 'vote', item: 1, v: -1 });
    g.clients[2].send({ t: 'vote', item: 1, v: -1 });
    g.clients[3].send({ t: 'vote', item: 1, v: 1 });
    const r = await seen(g.host, (x) => x.status === 'results');
    expect(cells(r, 'Ann').place).toMatchObject({ st: 'voted', pts: 10 });
    expect(cells(r, 'Ann').animal).toMatchObject({ st: 'rejected', pts: 0 });
    expect((r.results as { items: Array<{ up: number; down: number; ok: boolean }> }).items.map((x) => [x.up, x.down, x.ok])).toEqual([[2, 1, true], [1, 2, false]]);
  });

  it('a tie accepts the answer', async () => {
    const g = await toReview(['Ann', 'Bob', 'Cy'], [{ place: 'Aaaville' }, {}, {}]);
    g.clients[1].send({ t: 'vote', item: 0, v: 1 });
    g.clients[2].send({ t: 'vote', item: 0, v: -1 });
    const r = await seen(g.host, (x) => x.status === 'results');
    expect(cells(r, 'Ann').place).toMatchObject({ st: 'voted', pts: 10 });
  });

  it('nobody voting also accepts, when the 20 seconds run out', async () => {
    const g = await toReview(['Ann', 'Bob'], [{ place: 'Aaaville' }, { place: 'Aaaville' }]);
    // Both wrote it, so nobody may vote at all: the review does not wait
    expect((await seen(g.host, (x) => x.status === 'results')).results).toBeTruthy();
  });

  it('the review waits for the vote timer if someone who may vote has not voted, then accepts a tie', async () => {
    const g = await toReview(['Ann', 'Bob', 'Cy'], [{ place: 'Aaaville' }, {}, {}]);
    g.clients[1].send({ t: 'vote', item: 0, v: 1 });
    await seen(g.host, (x) => (x.review as { waiting: number }).waiting === 1);
    expect(await inRoom(g.code, (r) => r.status)).toBe('review');
    await fire(g.code, 'vote');
    const r = await seen(g.host, (x) => x.status === 'results');
    expect(cells(r, 'Ann').place.pts).toBe(10);
  });

  it('players who are away or gone do not block the review', async () => {
    const g = await toReview(['Ann', 'Bob', 'Cy', 'Dee'], [{ place: 'Aaaville' }, {}, {}, {}]);
    g.clients[3].close();                                          // Dee leaves
    await inRoom(g.code, (r) => { r.players[2].away = true; });   // Cy is Away
    g.clients[1].send({ t: 'vote', item: 0, v: -1 });
    const r = await seen(g.host, (x) => x.status === 'results');
    expect(cells(r, 'Ann').place).toMatchObject({ st: 'rejected', pts: 0 });
  });

  it('a player who is Away does not hold up the answering either', async () => {
    const g = await lobby(['Ann', 'Bob', 'Cy']);
    await start(g);
    await pickLetter(g, 0, 'A');
    await inRoom(g.code, (r) => { r.players[2].away = true; });
    g.host.send({ t: 'submit', a: full({}) });
    g.clients[1].send({ t: 'submit', a: full({ name: 'Anna' }) });
    await seen(g.host, (x) => x.status === 'results');
  });

  it('forged votes are ignored: bad item, bad value, wrong time, spectators', async () => {
    const g = await toReview(['Ann', 'Bob', 'Cy'], [{ place: 'Aaaville' }, {}, {}]);
    g.clients[1].send({ t: 'vote', item: 9, v: 1 });
    g.clients[1].send({ t: 'vote', item: -1, v: 1 });
    g.clients[1].send({ t: 'vote', item: '0', v: 1 });
    g.clients[1].send({ t: 'vote', item: 0, v: 5 });
    g.clients[1].send({ t: 'vote', item: 0, v: 'up' });
    await sleep(60);
    expect(await inRoom(g.code, (r) => r.review[0].up.length + r.review[0].down.length)).toBe(0);
    g.clients[1].send({ t: 'vote', item: 0, v: 0 });
    g.clients[1].send({ t: 'vote', item: 0, v: 1 });
    g.clients[2].send({ t: 'vote', item: 0, v: 1 });
    await seen(g.host, (x) => x.status === 'results');
    g.clients[2].send({ t: 'vote', item: 0, v: -1 });              // after the review: nothing happens
    await sleep(40);
    expect(await inRoom(g.code, (r) => r.status)).toBe('results');
  });
});

describe('A to Zap: refresh and presence', () => {
  it('a refresh in the middle of a round keeps your typed answers', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'A');
    g.clients[1].send({ t: 'answers', a: { name: 'Ali', animal: 'ant' } });
    await seen(g.host, (x) => players(x).find((p) => p.name === 'Bob')?.filled === 2);
    // the same tab comes back on a new connection
    const again = await TestClient.open(`/${GAME}/ws?code=${g.code}`);
    again.join('Bob');
    await again.next((m) => m.t === 'welcome');
    const v = await seen(again, (x) => x.status === 'play' && x.mine !== null);
    expect(v.mine).toEqual({ answers: { name: 'Ali', animal: 'ant' }, submitted: false });
    expect(players(v)).toHaveLength(2);
    expect(v.playLeft).toBeGreaterThan(80000);
    // and it can carry on typing and hand in once every box is filled
    again.send({ t: 'submit', a: full({ animal: 'ant', place: 'Accra' }) });
    await seen(g.host, (x) => players(x).find((p) => p.name === 'Bob')?.submitted === true);
  });

  it('a refresh keeps a submitted round submitted, and the picker stays the picker', async () => {
    const g = await lobby(['Ann', 'Bob']);
    const [v0] = await start(g);
    expect(v0.pickerName).toBe('Ann');
    g.host.close();
    const again = await TestClient.open(`/${GAME}/ws?code=${g.code}`);
    again.join('Ann');
    const w = await again.next((m) => m.t === 'welcome');
    const v = await seen(again, (x) => x.status === 'pick');
    expect(v.pickerId).toBe(w.id);
    again.send({ t: 'pick', letter: 'A' });
    await seen(again, (x) => x.status === 'play');
    again.send({ t: 'submit', a: full({}) });
    await seen(again, (x) => (x.mine as { submitted: boolean } | null)?.submitted === true);
    again.close();
    const third = await TestClient.open(`/${GAME}/ws?code=${g.code}`);
    third.join('Ann');
    await third.next((m) => m.t === 'welcome');
    const back = await seen(third, (x) => x.status === 'play' && x.mine !== null);
    expect(back.mine).toEqual({ answers: full({}), submitted: true });
  });

  it('a refresh during the vote keeps your own vote', async () => {
    const g = await lobby(['Ann', 'Bob', 'Cy']);
    await start(g);
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'answers', a: { place: 'Aaaville' } });
    g.clients[1].send({ t: 'answers', a: {} });
    g.clients[2].send({ t: 'answers', a: {} });
    await lockRound(g.code);   // with blanks nobody can hand in: the clock locks the round
    await seen(g.clients[1], (x) => x.status === 'review');
    g.clients[1].send({ t: 'vote', item: 0, v: -1 });
    await seen(g.clients[1], (x) => (x.review as { items: Array<{ vote: number }> }).items[0].vote === -1);
    g.clients[1].close();
    const again = await TestClient.open(`/${GAME}/ws?code=${g.code}`);
    again.join('Bob');
    await again.next((m) => m.t === 'welcome');
    const v = await seen(again, (x) => x.status === 'review');
    expect((v.review as { items: Array<{ vote: number }> }).items[0].vote).toBe(-1);
  });
});

describe('A to Zap: restarts', () => {
  it('a room saved in the middle of a round comes back with its answers, letter and deadline (players offline)', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'answers', a: { name: 'Ali', animal: 'ant' } });
    await seen(g.clients[1], (x) => players(x).find((p) => p.name === 'Ann')?.filled === 2);
    const snap = await runInDurableObject(stub(g.code), (i) => JSON.parse(JSON.stringify((i as unknown as { game: { snapshot(): unknown } }).game.snapshot())));
    // a new instance, as after a restart: no sockets any more
    const ctx = { now: () => Date.now(), lastSeen: () => 0, random: Math.random, code: 'TEST' } as unknown as RoomCtx;
    const back = atozap.restore(ctx, snap).snapshot() as { status: string; letter: string; lockAt: number; settings: { time: number }; players: Array<{ name: string; connected: boolean; answers: Record<string, string> }> };
    expect(back.status).toBe('play');
    expect(back.letter).toBe('A');
    expect(back.lockAt).toBeGreaterThan(Date.now());
    expect(back.players.map((p) => [p.name, p.connected])).toEqual([['Ann', false], ['Bob', false]]);
    expect(back.players[0].answers).toEqual({ name: 'Ali', animal: 'ant' });
  });
});

describe('A to Zap: the game', () => {
  it('results stay up, then the next round starts by itself', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'A');
    await fire(g.code, 'round');
    const r = await seen(g.host, (x) => x.status === 'results');
    expect(r.nextLeft).toBeGreaterThan(E.RESULTS_MS - 2000);
    await fire(g.code, 'next');
    await seen(g.clients[1], (x) => x.status === 'pick' && x.round === 2);
  });

  it('only the host can move on from the results', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'A');
    await fire(g.code, 'round');
    await seen(g.host, (x) => x.status === 'results');
    g.clients[1].send({ t: 'next' });
    await sleep(50);
    expect(await inRoom(g.code, (r) => r.status)).toBe('results');
  });

  it('ends after the chosen number of rounds with standings, and Play again starts a fresh game', async () => {
    const g = await lobby(['Ann', 'Bob'], { rounds: 5 });
    await start(g);
    for (let round = 1; round <= 5; round++) {
      await pickLetter(g, (round - 1) % 2, 'ABCDE'[round - 1]);
      g.host.send({ t: 'answers', a: { name: ['Ali', 'Bilal', 'Carla', 'Daniel', 'Eli'][round - 1] } });
      g.clients[1].send({ t: 'answers', a: {} });
      await lockRound(g.code);   // with blanks nobody can hand in: the clock locks the round
      const r = await seen(g.host, (x) => x.status === 'results' && x.round === round);
      expect((r.results as { last: boolean }).last).toBe(round === 5);
      g.host.send({ t: 'next' });
      if (round < 5) await seen(g.host, (x) => x.status === 'pick' && x.round === round + 1);
    }
    const over = await seen(g.clients[1], (x) => x.status === 'over');
    expect(over.standings).toMatchObject([{ name: 'Ann', score: 50, unique: 5, place: 1 }, { name: 'Bob', score: 0, place: 2 }]);
    expect(over.wins).toEqual([{ name: 'Ann', n: 1 }]);
    g.host.send({ t: 'start' });
    const again = await seen(g.host, (x) => x.status === 'pick' && x.round === 1);
    expect(players(again).map((p) => p.score)).toEqual([0, 0]);
    expect(again.used).toEqual([]);
  });

  it('"all letters" runs out after the 23 letters that may be picked (26 with hard letters)', async () => {
    const g = await lobby(['Ann', 'Bob'], { rounds: 26 });
    const [v] = await start(g);
    expect(v.totalRounds).toBe(23);
    g.host.send({ t: 'lobby' });
    await seen(g.host, (x) => x.status === 'lobby');
    g.host.send({ t: 'settings', patch: { hard: true } });
    await seen(g.host, (x) => (x.settings as { hard: boolean }).hard);
    g.host.send({ t: 'start' });
    expect((await seen(g.host, (x) => x.status === 'pick')).totalRounds).toBe(26);
  });

  it('the host can end the game early; a game with no finished round counts for nothing', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    g.clients[1].send({ t: 'endGame' });
    g.host.send({ t: 'endGame' });
    const over = await seen(g.host, (x) => x.status === 'over');
    expect(over.wins).toEqual([]);
    g.host.send({ t: 'lobby' });
    const lob = await seen(g.host, (x) => x.status === 'lobby');
    expect(players(lob).every((p) => p.score === 0 && !p.inGame)).toBe(true);
  });

  it('back to the lobby clears the game and lets the host change settings again', async () => {
    const g = await lobby(['Ann', 'Bob']);
    await start(g);
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'lobby' });
    await seen(g.host, (x) => x.status === 'lobby');
    g.host.send({ t: 'settings', patch: { time: 60 } });
    const s = await seen(g.host, (x) => (x.settings as { time: number }).time === 60);
    expect(s.letter).toBeNull();
    expect(await inRoom(g.code, (_r, i) => Object.keys(i.timers).filter((k) => ['pick', 'round', 'vote', 'next'].includes(k)))).toEqual([]);
  });
});

describe('A to Zap: stats', () => {
  async function myStats(token: string): Promise<Record<string, number>> {
    const res = await SELF.fetch(`https://play.test/api/me/stats?game=${GAME}`, { headers: { 'X-Guest': token } });
    return ((await res.json()) as { stats: Record<string, number> }).stats;
  }
  const zero = (s: Record<string, number>) => ({ wins: 0, points: 0, unique: 0, bestRound: 0, ...s });
  async function waitFor(token: string, pred: (s: Record<string, number>) => boolean) {
    let s = await myStats(token);
    for (let i = 0; i < 40 && !pred(s); i++) { await sleep(50); s = await myStats(token); }
    return s;
  }

  it('saves games, wins, rounds, points and unique answers, and keeps the best round as a maximum', async () => {
    const g = await lobby(['Ann', 'Bob'], { rounds: 5 });
    const tokens = await Promise.all(g.clients.map(async (c) => (await c.next((m) => m.t === 'guest')).token as string));
    // round 1: Ann has two unique answers (20); round 2: Bob picks, Ann 10 → best round 20, points 30
    g.host.send({ t: 'start' });
    await seen(g.host, (x) => x.status === 'pick' && x.round === 1);
    await pickLetter(g, 0, 'A');
    g.host.send({ t: 'answers', a: { name: 'Ali', animal: 'ant' } });
    g.clients[1].send({ t: 'answers', a: {} });
    await lockRound(g.code);   // with blanks nobody can hand in: the clock locks the round
    await seen(g.host, (x) => x.status === 'results' && x.round === 1);
    g.host.send({ t: 'next' });
    await seen(g.host, (x) => x.status === 'pick' && x.round === 2);
    await pickLetter(g, 1, 'B');
    g.host.send({ t: 'answers', a: { name: 'Bilal' } });
    g.clients[1].send({ t: 'answers', a: {} });
    await lockRound(g.code);   // with blanks nobody can hand in: the clock locks the round
    await seen(g.host, (x) => x.status === 'results' && x.round === 2);
    g.host.send({ t: 'endGame' });
    await seen(g.host, (x) => x.status === 'over');
    const a = await waitFor(tokens[0], (s) => s.games === 1);
    const b = await myStats(tokens[1]);
    expect(a).toMatchObject({ games: 1, wins: 1, rounds: 2, points: 30, unique: 3, bestRound: 20 });
    expect(zero(b)).toMatchObject({ games: 1, wins: 0, rounds: 2, points: 0, unique: 0, bestRound: 0 });
    // a second game: Ann scores less in her best round, the best stays at 20 while the counters add up
    g.host.send({ t: 'start' });
    await seen(g.host, (x) => x.status === 'pick' && x.round === 1);
    await pickLetter(g, 0, 'C');
    g.host.send({ t: 'answers', a: { name: 'Cara' } });
    g.clients[1].send({ t: 'answers', a: { name: 'Cara' } });
    await lockRound(g.code);   // with blanks nobody can hand in: the clock locks the round
    await seen(g.host, (x) => x.status === 'results' && x.round === 1);
    g.host.send({ t: 'endGame' });
    await seen(g.host, (x) => x.status === 'over');
    const a2 = await waitFor(tokens[0], (s) => s.games === 2);
    expect(a2).toMatchObject({ games: 2, wins: 2, rounds: 3, points: 35, unique: 3, bestRound: 20 });
    const b2 = await waitFor(tokens[1], (s) => s.games === 2);
    expect(b2).toMatchObject({ games: 2, wins: 1, rounds: 3, points: 5, bestRound: 5 });
  });

  it('is saved for everyone who played, including a player who left; nothing is saved for a game with no finished round', async () => {
    const g = await lobby(['Ann', 'Bob', 'Cy']);
    const tokens = await Promise.all(g.clients.map(async (c) => (await c.next((m) => m.t === 'guest')).token as string));
    g.host.send({ t: 'start' });
    await seen(g.host, (x) => x.status === 'pick');
    g.host.send({ t: 'endGame' });
    await seen(g.host, (x) => x.status === 'over');
    await sleep(150);
    expect(await myStats(tokens[0])).toEqual({});
    g.host.send({ t: 'start' });
    await seen(g.host, (x) => x.status === 'pick');
    await pickLetter(g, 0, 'A');
    g.clients[2].close();                                           // Cy leaves mid-game
    g.host.send({ t: 'answers', a: { name: 'Ali' } });
    g.clients[1].send({ t: 'answers', a: { name: 'Ayesha' } });
    await lockRound(g.code);   // with blanks nobody can hand in: the clock locks the round
    await seen(g.host, (x) => x.status === 'results');
    g.host.send({ t: 'endGame' });
    await seen(g.host, (x) => x.status === 'over');
    expect(zero(await waitFor(tokens[2], (s) => s.games === 1))).toMatchObject({ games: 1, wins: 0, rounds: 1, points: 0 });
    expect(await waitFor(tokens[0], (s) => s.games === 1)).toMatchObject({ games: 1, wins: 1, points: 10 });
  });

  it('bestRound is listed as a best-of (MAX) stat so a guest merge keeps the better value', () => {
    expect(BEST_STATS['a-to-zap:bestRound']).toBe('max');
  });
});

describe('A to Zap: cost', () => {
  it('judging and scoring 8 players x 8 categories stays far below the 10 ms CPU limit', () => {
    const cats = E.CATEGORY_IDS.slice(0, 8);
    const sample = ['alpaca', 'ali', 'athens', 'apple', 'axe', 'aardvark', 'zzzz', 'avocado', 'anchor', 'accra'];
    const t0 = performance.now();
    const rows = Array.from({ length: 8 }, (_, p) => ({
      id: `p${p}`,
      cells: Object.fromEntries(cats.map((c, i) => {
        const raw = sample[(p + i) % sample.length];
        const j = E.judge('A', c, raw, onList);
        return [c, { raw, norm: j.norm, status: j.status }];
      })),
    }));
    const items = E.pendingVotes(cats, rows);
    E.scoreRound(cats, rows, () => true);
    const ms = performance.now() - t0;
    expect(items.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(5);
  });
});
