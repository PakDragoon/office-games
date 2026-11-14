import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as FE from '../../web/flipchip/js/engine.js';
import * as TE from '../../web/thulla/js/engine.js';
import * as RE from '../../web/rotten/js/engine.js';
import { flipchip } from '../src/games/flipchip';
import { playersOf, sleep, TestClient, type Msg } from './helpers';

const BASE = 'https://play.test';

async function newGuest() {
  const res = await SELF.fetch(`${BASE}/api/guest`, { method: 'POST' });
  const { token } = (await res.json()) as { token: string };
  return { token, key: `g:${token.slice(0, token.lastIndexOf('.'))}` };
}
type Guest = Awaited<ReturnType<typeof newGuest>>;

async function seat(game: string, name: string, g: Guest, query: string) {
  const c = await TestClient.open(`/${game}/ws?${query}`);
  c.join(name, { guest: g.token });
  const w = await c.next((m) => m.t === 'welcome');
  return { c, id: w.id as string, code: w.code as string };
}

const stub = (game: string, code: string) => env.ROOMS.get(env.ROOMS.idFromName(`${game}:${code}`));
type AnyRoom = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const inside = <T>(game: string, code: string, fn: (i: AnyRoom, room: AnyRoom) => T): Promise<T> =>
  runInDurableObject(stub(game, code), (i) => fn(i as AnyRoom, (i as AnyRoom).game.room ?? (i as AnyRoom).game.H));
/** Make the planned bot move due now and run the room's alarm. */
async function fireBot(game: string, code: string): Promise<void> {
  await inside(game, code, (i) => { i.timers.bot = Date.now(); });
  await runDurableObjectAlarm(stub(game, code));
}

const rows = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all<Record<string, unknown>>()).results;
async function noBotRows() {
  expect(await rows("SELECT * FROM players WHERE id LIKE 'b%' OR name LIKE '%🤖%'")).toEqual([]);
  expect(await rows("SELECT * FROM crew_stats WHERE player LIKE '%🤖%'")).toEqual([]);
  expect(await rows("SELECT * FROM matches WHERE players LIKE '%🤖%'")).toEqual([]);
  expect(await rows("SELECT * FROM player_stats WHERE player_id NOT LIKE 'g:%' AND player_id NOT LIKE 'u:%'")).toEqual([]);
}

/* ---------- Flipchip ---------- */

const botsOf = (s: Msg) => playersOf(s).filter((p) => p.isBot);

async function flipHost(g: Guest, query = 'create=1') {
  const h = await seat('flipchip', 'Hana', g, query);
  await h.c.state();
  return h;
}

describe('Flipchip bots', () => {
  it('the host adds a bot into a free seat; it is marked, never host, can change level and be removed', async () => {
    const h = await flipHost(await newGuest());
    h.c.send({ t: 'addBot', level: 'easy' });
    const s = await h.c.state((x) => botsOf(x).length === 1);
    const bot = botsOf(s)[0];
    expect(String(bot.name)).toMatch(/^🤖 /);
    expect(bot).toMatchObject({ isHost: false, isBot: true, botLevel: 'easy', connected: true, rating: null });
    expect((s.seats as Record<number, string>)[2]).toBe(bot.id);
    h.c.send({ t: 'botLevel', id: bot.id, level: 'normal' });
    expect(botsOf(await h.c.state((x) => botsOf(x)[0]?.botLevel === 'normal'))).toHaveLength(1);
    // a second bot has no seat
    h.c.send({ t: 'addBot' });
    await h.c.next((m) => m.t === 'toast');
    h.c.send({ t: 'removeBot', id: bot.id });
    const gone = await h.c.state((x) => botsOf(x).length === 0);
    expect((gone.seats as Record<number, string | null>)[2]).toBeNull();
  });

  it('only the host can add or remove bots, and nobody can pass as one by name', async () => {
    const h = await flipHost(await newGuest());
    const g = await seat('flipchip', '🤖 Fake', await newGuest(), `code=${h.code}`);
    const s = await h.c.state((x) => playersOf(x).length === 2);
    expect(playersOf(s)[1].name).toBe('Fake');
    g.c.send({ t: 'addBot' });
    await sleep(100);
    h.c.send({ t: 'addBot' });
    await h.c.next((m) => m.t === 'toast');   // both seats are taken by people
    expect(botsOf(await h.c.state())).toHaveLength(0);
  });

  it('a person who joins a lobby with no free seat takes the bot’s place', async () => {
    const h = await flipHost(await newGuest());
    h.c.send({ t: 'addBot' });
    await h.c.state((x) => botsOf(x).length === 1);
    const g = await seat('flipchip', 'Ali', await newGuest(), `code=${h.code}`);
    const s = await h.c.state((x) => playersOf(x).some((p) => p.name === 'Ali'));
    expect(botsOf(s)).toHaveLength(0);
    expect((s.seats as Record<number, string>)[2]).toBe(g.id);
  });

  it('plays a whole game against the host: every bot move is legal, nothing about the bot is saved or rated', async () => {
    const guest = await newGuest();
    const h = await flipHost(guest);
    h.c.send({ t: 'crew', name: 'Bot Crew' });
    h.c.send({ t: 'addBot', level: 'normal' });
    await h.c.state((x) => botsOf(x).length === 1);
    h.c.send({ t: 'start', settings: { size: 6 } });
    let s = await h.c.state((x) => x.status === 'play');
    const botId = botsOf(s)[0].id as string;
    for (let i = 0; i < 80 && s.status !== 'over'; i++) {
      const seatId = (s.seats as Record<number, string>)[s.turn as number];
      const want = (s.moveSeq as number) + 1;
      if (seatId === botId) await fireBot('flipchip', h.code);
      else {
        h.c.send({ t: 'move', i: FE.chooseMove(s.board as number[], s.size as number, s.turn as number, 'random'), seq: s.moveSeq });
      }
      s = await h.c.state((x) => x.moveSeq === want || x.status === 'over');
    }
    expect(s.status).toBe('over');
    await h.c.state((x) => String(x.crewStatus).startsWith('Saved to'));
    expect((await rows('SELECT * FROM ratings')).filter((r) => String(r.player_id).startsWith('g:'))).toEqual([]);
    expect((await rows('SELECT value FROM player_stats WHERE player_id = ?1 AND stat = ?2', guest.key, 'games'))[0]?.value).toBe(1);
    await noBotRows();
    expect(await rows("SELECT * FROM crew_stats WHERE player = 'Hana' AND stat = 'games'")).toHaveLength(1);
  });

  it('survives a restart in the middle of the bot’s turn', async () => {
    const h = await flipHost(await newGuest());
    h.c.send({ t: 'addBot' });
    await h.c.state((x) => botsOf(x).length === 1);
    // swap so the bot (Light) is not first; the host (Dark) moves, then it is the bot's turn
    h.c.send({ t: 'start', settings: { size: 6 } });
    let s = await h.c.state((x) => x.status === 'play');
    h.c.send({ t: 'move', i: FE.legalMoves(s.board as number[], 6, 1)[0], seq: 0 });
    s = await h.c.state((x) => x.moveSeq === 1);
    const saved = await runInDurableObject(stub('flipchip', h.code), (_i, state) => state.storage.get<{ timers: Record<string, number>; snap: AnyRoom }>('room'));
    expect(saved?.timers.bot).toBeGreaterThan(0);
    expect(saved?.snap.botKey).toBe('1:1');
    // the room is rebuilt from what storage holds (what a restart does) and the bot still moves
    const snap = JSON.parse(JSON.stringify(saved?.snap));
    const planned: string[] = [];
    const ctx = {
      code: h.code, now: () => Date.now(), random: Math.random, send() {}, close() {}, lastSeen: () => 0,
      identity: () => ({ uid: null, guest: null, photo: '' }), setTimer: (n: string) => { planned.push(n); }, clearTimer() {}, dirty() {},
      listing() {}, later() {}, track() {},
    };
    void planned;
    const inst = flipchip.restore(ctx as never, snap) as unknown as { timer(n: string): void; snapshot(): AnyRoom };
    inst.timer('bot');
    expect(inst.snapshot().moveSeq).toBe(2);
    expect(inst.snapshot().turn).toBe(1);
  });

  it('a room with only bots left is cleaned up and no longer offered', async () => {
    const h = await flipHost(await newGuest(), 'create=1&public=1');
    h.c.send({ t: 'addBot' });
    await h.c.state((x) => botsOf(x).length === 1);
    await sleep(100);
    let list = (await (await SELF.fetch(`${BASE}/api/flipchip/rooms`)).json()) as { rooms: Array<{ code: string; players: number }> };
    // Quick Play counts only people in seats: a person who joins takes the bot's seat
    expect(list.rooms.find((r) => r.code === h.code)?.players).toBe(1);
    h.c.send({ t: 'start', settings: { size: 6 } });
    await h.c.state((x) => x.status === 'play');
    h.c.close();
    await sleep(200);
    expect(await inside('flipchip', h.code, (i) => i.game.occupied())).toBe(false);
    list = (await (await SELF.fetch(`${BASE}/api/flipchip/rooms`)).json()) as typeof list;
    expect(list.rooms.find((r) => r.code === h.code)).toBeUndefined();
    // the bot never plays on with nobody there: no bot timer gets planned
    const timers = await inside('flipchip', h.code, (i) => Object.keys(i.timers));
    expect(timers).toContain('__cleanup');
  });

  it('the host who leaves hands the room to a person, never to a bot', async () => {
    const h = await flipHost(await newGuest());
    const g = await seat('flipchip', 'Ali', await newGuest(), `code=${h.code}`);
    h.c.send({ t: 'addBot' });   // no seat: refused, so remove Ali's seat first
    h.c.close();
    const s = await g.c.state((x) => playersOf(x).length === 1);
    expect(playersOf(s)[0]).toMatchObject({ name: 'Ali', isHost: true });
  });
});

/* ---------- Thulla ---------- */

type TView = { phase: string; players: Array<Record<string, any>>; round: Record<string, any> | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
const tview = (c: TestClient): TView | null => {
  for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].t === 'state') return c.msgs[i].v as TView;
  return null;
};
async function waitView(c: TestClient, pred: (v: TView) => boolean, ms = 3000): Promise<TView> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = tview(c);
    if (v && pred(v)) return v;
    await sleep(15);
  }
  throw new Error(`timed out; phase ${tview(c)?.phase}`);
}

describe('Thulla bots', () => {
  it('adds, levels and removes bots in the lobby; they never host', async () => {
    const guest = await newGuest();
    const h = await seat('thulla', 'Hana', guest, 'create=1');
    h.c.send({ t: 'addBot', level: 'easy' });
    h.c.send({ t: 'addBot' });
    let v = await waitView(h.c, (x) => x.players.length === 3);
    const bots = v.players.filter((p) => p.bot);
    expect(bots).toHaveLength(2);
    expect(bots.every((b) => String(b.name).startsWith('🤖 ') && !b.isHost && b.online)).toBe(true);
    expect(bots[0].botLevel).toBe('easy');
    h.c.send({ t: 'botLevel', id: bots[0].id, level: 'normal' });
    h.c.send({ t: 'removeBot', id: bots[1].id });
    v = await waitView(h.c, (x) => x.players.length === 2);
    expect(v.players.find((p) => p.id === bots[0].id)?.botLevel).toBe('normal');
    // a person can't pass as a bot, and a human can't be removed with removeBot
    h.c.send({ t: 'removeBot', id: v.players.find((p) => !p.bot)?.id });
    await sleep(50);
    expect((tview(h.c) as TView).players.filter((p) => !p.bot)).toHaveLength(1);
  });

  it('plays a full round with the host and two bots: bots decide through the timer, nothing of them is saved or rated', async () => {
    const guest = await newGuest();
    const h = await seat('thulla', 'Hana', guest, 'create=1');
    h.c.send({ t: 'crew', name: 'Thulla Bots' });
    h.c.send({ t: 'addBot', level: 'normal' });
    h.c.send({ t: 'addBot', level: 'easy' });
    await waitView(h.c, (x) => x.players.length === 3);
    h.c.send({ t: 'start' });
    let v = await waitView(h.c, (x) => x.phase === 'playing');
    const botIds = new Set(v.players.filter((p) => p.bot).map((p) => p.id));
    for (let i = 0; i < 400 && v.phase === 'playing'; i++) {
      const r = v.round as Record<string, any>;
      if (r.resolving) { await inside('thulla', h.code, (x) => { x.timers.resolve = Date.now(); }); await runDurableObjectAlarm(stub('thulla', h.code)); }
      else if (botIds.has(r.turn)) await fireBot('thulla', h.code);
      else if (r.myTurn) h.c.send({ t: 'play', card: r.legal[0] });
      await sleep(8);
      v = tview(h.c) as TView;
    }
    expect(v.phase).not.toBe('playing');
    await waitView(h.c, (x) => x.phase !== 'playing');
    await sleep(150);
    expect((await rows('SELECT * FROM ratings')).filter((r) => String(r.player_id) === guest.key)).toEqual([]);
    expect((await rows('SELECT value FROM player_stats WHERE player_id = ?1 AND stat = ?2', guest.key, 'rounds'))[0]?.value).toBe(1);
    await noBotRows();
  });

  it('a bot answers a request for its cards through the same rules', async () => {
    const h = await seat('thulla', 'Hana', await newGuest(), 'create=1');
    h.c.send({ t: 'addBot' });
    h.c.send({ t: 'addBot' });
    await waitView(h.c, (x) => x.players.length === 3);
    h.c.send({ t: 'settings', patch: { allowTake: true } });
    h.c.send({ t: 'start' });
    await waitView(h.c, (x) => x.phase === 'playing');
    // Rig it: the host leads and asks the next player
    await inside('thulla', h.code, (_i, H) => {
      const r = H.round;
      const hostId = H.players.find((p: AnyRoom) => !p.bot).id;
      r.turn = hostId;
      r.turnNo += 5;
      r.trick = [];
      r.ledSuit = null;
      r.first = false;
      r.trickSeats = r.seats.slice();
    });
    h.c.send({ t: 'take' });
    const v = await waitView(h.c, (x) => Boolean(x.round?.take));
    const to = (v.round as Record<string, any>).take.to as string;
    await fireBot('thulla', h.code);
    const after = await waitView(h.c, (x) => !x.round?.take);
    expect((after.round as Record<string, any>).seats).toContain(to);
    expect(after.players.find((p) => p.id === to)?.safe).toBeGreaterThan(0);
  });
});

describe('Thulla bot engine', () => {
  const rnd = RE.mulberry32(11);
  it('only ever plays legal cards, in thousands of random rounds', () => {
    for (let g = 0; g < 400; g++) {
      const n = 2 + (g % 7);
      const seats = Array.from({ length: n }, (_, i) => `p${i}`);
      const st = TE.createRound({ seats, dealer: g % n, rnd, deck: undefined });
      let steps = 0;
      while (!st.over && steps++ < 5000) {
        const level = st.turn.endsWith('0') ? 'easy' : 'normal';
        const card = TE.botCard(st, st.turn, level, rnd);
        expect(TE.legalCards(st, st.turn)).toContain(card);
        expect(TE.play(st, st.turn, card).ok).toBe(true);
      }
      expect(st.over).toBe(true);
    }
  });
  it('normal beats easy over many rounds (fewer losses)', () => {
    const losses: Record<string, number> = { easy: 0, normal: 0 };
    for (let g = 0; g < 600; g++) {
      const seats = ['p0', 'p1', 'p2', 'p3'];
      const st = TE.createRound({ seats, dealer: g % 4, rnd, deck: undefined });
      const level = (id: string) => (Number(id[1]) % 2 ? 'normal' : 'easy');
      let steps = 0;
      while (!st.over && steps++ < 5000) TE.play(st, st.turn, TE.botCard(st, st.turn, level(st.turn), rnd));
      losses[level(String(st.loser))]++;
    }
    expect(losses.normal).toBeLessThan(losses.easy);
  });
});

/* ---------- Rotten ---------- */

describe('Rotten bots', () => {
  it('adds a bot that is marked, never host, and a bot holder answers with a valid everyday word', async () => {
    const g = await newGuest();
    const h = await seat('rotten', 'Hana', g, 'create=1');
    h.c.send({ t: 'addBot', level: 'normal' });
    let s = await h.c.state((x) => playersOf(x).length === 2);
    const bot = playersOf(s)[1];
    expect(bot).toMatchObject({ bot: true, isHost: false, botLevel: 'normal', connected: true });
    expect(String(bot.name)).toMatch(/^🤖 /);
    h.c.send({ t: 'start', settings: { lives: 3 } });
    s = await h.c.state((x) => x.status === 'play');
    // make the bot the holder, past the countdown, with a far-off fuse
    await inside('rotten', h.code, (_i, room) => {
      room.holder = bot.id;
      room.startAt = Date.now() - 1;
      room.fuseEnd = Date.now() + 120000;
      room.botKey = '';
    });
    let played = false;
    for (let i = 0; i < 12 && !played; i++) {
      await inside('rotten', h.code, (i2, room) => { room.holder = bot.id; room.botKey = ''; i2.game.broadcast(); });
      await fireBot('rotten', h.code);
      played = (await inside('rotten', h.code, (_i, room) => room.log.length)) > 0;
    }
    expect(played).toBe(true);
    const log = await inside('rotten', h.code, (_i, room) => room.log[0]);
    expect(log.word).toContain(log.prompt);
    expect(log.word.length).toBeGreaterThanOrEqual(4);
  });

  it('a bot never repeats a word and it can run out of luck: a full game to the end, nothing saved for it', async () => {
    const g = await newGuest();
    const h = await seat('rotten', 'Hana', g, 'create=1');
    h.c.send({ t: 'crew', name: 'Rotten Bots' });
    h.c.send({ t: 'addBot', level: 'easy' });
    h.c.send({ t: 'addBot', level: 'normal' });
    await h.c.state((x) => playersOf(x).length === 3);
    h.c.send({ t: 'start', settings: { lives: 1 } });
    let s = await h.c.state((x) => x.status === 'play');
    const bots = new Set(playersOf(s).filter((p) => p.bot).map((p) => p.id));
    h.c.drain();
    for (let i = 0; i < 60 && s.status === 'play'; i++) {
      await inside('rotten', h.code, (_i, room) => { room.startAt = Date.now() - 1; room.pausedUntil = 0; room.fuseEnd = Date.now() + 100000; });
      const holder = s.holder as string;
      if (bots.has(holder)) await fireBot('rotten', h.code);
      // the banana goes off (a bot that failed, or the host who never answers)
      await inside('rotten', h.code, (i2, room) => { room.fuseEnd = Date.now(); i2.timers.fuse = Date.now(); });
      await runDurableObjectAlarm(stub('rotten', h.code));
      await sleep(20);
      s = [...h.c.msgs].reverse().find((m) => m.t === 'state') as Msg;
    }
    expect(s.status).toBe('over');
    const words = (s.log as Array<{ word: string }>).map((w) => RE.stemKey(w.word));
    expect(new Set(words).size).toBe(words.length);
    await h.c.state((x) => String(x.crewStatus).startsWith('Saved to'));
    expect((await rows('SELECT value FROM player_stats WHERE player_id = ?1 AND stat = ?2', g.key, 'games'))[0]?.value).toBe(1);
    await noBotRows();
  });

});

/* ---------- CPU budget (free plan: 10 ms per event) ---------- */

describe('bot CPU', () => {
  it('a Flipchip bot move on 10x10, a Rotten answer and a Thulla card each stay far under 10 ms', async () => {
    const rnd = RE.mulberry32(9);
    const BOT_TEXT = (await import('../../web/rotten/words/bot.txt')).default as string;
    const t0 = performance.now();
    let worst = 0;
    // 10x10 mid-game boards: random play to move 30, then the bot picks
    for (let g = 0; g < 20; g++) {
      let b = FE.newBoard(10), who = 1;
      for (let i = 0; i < 30; i++) {
        const mv = FE.legalMoves(b, 10, who);
        if (!mv.length) { who = 3 - who; continue; }
        b = FE.play(b, 10, mv[Math.floor(rnd() * mv.length)], who)?.board as number[];
        who = 3 - who;
      }
      const t = performance.now();
      FE.chooseMove(b, 10, who, 'normal', { rnd, maxRoot: 3 });
      worst = Math.max(worst, performance.now() - t);
    }
    const words = Array.from({ length: 200 }, (_, i) => RE.botCandidates(BOT_TEXT, ['ing', 'ab', 'tion', 'zz', 'qui'][i % 5].slice(0, 3)));
    const rotten = (performance.now() - t0) / 200;
    console.log(`bot CPU: flipchip 10x10 normal worst ${worst.toFixed(2)} ms; all work/event ${rotten.toFixed(2)} ms; answers ${words[0].length}`);
    expect(worst).toBeLessThan(10);
  });
});
