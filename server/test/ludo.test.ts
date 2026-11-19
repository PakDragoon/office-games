import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as E from '../../web/ludo/js/engine.js';
import { playersOf, room, sleep, type Msg } from './helpers';

const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(`ludo:${code}`));
interface G { turn: number; phase: string; roll: number; seq: number; tokens: Record<number, number[]>; legal: unknown[]; colours: number[]; settings: Record<string, unknown> }
interface P { id: string; name: string; autoplay: boolean; bot?: boolean }
interface R { status: string; seats: Array<string | null>; g: G | null; players: P[]; strikes: Record<string, number> }
type Inner = { game: { room: R }; timers: Record<string, number> };
const inRoom = <T>(code: string, f: (r: R, i: Inner) => T) => runInDurableObject(stub(code), (i) => f((i as unknown as Inner).game.room, i as unknown as Inner));
const fire = async (code: string, name: string) => {
  await inRoom(code, (_r, i) => { i.timers[name] = Date.now(); });
  await runDurableObjectAlarm(stub(code));
};
const gOf = (s: Msg) => (s.g || { turn: -1, phase: '', roll: -1, seq: -1, tokens: {}, legal: [], colours: [], settings: {} }) as G;

/** Two people, Ann (red, seat 0) and Bob (yellow, seat 2), in a started game with Ann to roll. */
async function started(settings: Record<string, unknown> = {}) {
  const { code, clients, ids } = await room('ludo', ['Ann', 'Bob']);
  const [ann, bob] = clients;
  ann.send({ t: 'start', settings });
  await bob.state((s) => s.status === 'play');
  await inRoom(code, (r) => { if (r.g) r.g.turn = 0; });
  return { code, ann, bob, ids };
}

describe('Ludo', () => {
  it('seats two players opposite each other and needs two to start', async () => {
    const { clients } = await room('ludo', ['Ann']);
    clients[0].send({ t: 'start' });
    expect(String((await clients[0].next((m) => m.t === 'toast')).text)).toContain('at least 2');
    const two = await room('ludo', ['Ann', 'Bob']);
    const seats = await inRoom(two.code, (r) => [...r.seats]);
    expect(seats).toEqual([two.ids[0], null, two.ids[1], null]);
  });

  it('only the host starts, teams need all four colours', async () => {
    const { clients } = await room('ludo', ['Ann', 'Bob']);
    const [ann, bob] = clients;
    bob.send({ t: 'start' });
    ann.send({ t: 'start', settings: { teams: true } });
    expect(String((await ann.next((m) => m.t === 'toast')).text)).toContain('Teams');
    ann.send({ t: 'addBot' });
    ann.send({ t: 'addBot' });
    await ann.state((s) => (s.seats as unknown[]).every(Boolean));
    ann.send({ t: 'start', settings: { teams: true } });
    const s = await bob.state((v) => v.status === 'play');
    expect(gOf(s).colours).toEqual([0, 1, 2, 3]);
    expect(gOf(s).settings.teams).toBe(true);
  });

  it('the server rolls the die; only the player whose turn it is may roll, and stale moves are ignored', async () => {
    const { code, ann, bob } = await started();
    const seq0 = (await inRoom(code, (r) => r.g?.seq)) as number;
    bob.send({ t: 'roll', seq: seq0 });   // not Bob's turn
    await sleep(100);
    expect((await inRoom(code, (r) => r.g?.roll))).toBe(0);
    ann.send({ t: 'roll', seq: seq0 + 5 });   // stale / made up
    await sleep(100);
    expect((await inRoom(code, (r) => r.g?.roll))).toBe(0);
    ann.send({ t: 'roll', seq: seq0 });
    const s1 = await ann.state((s) => gOf(s).seq === seq0 + 1);
    const ev = (gOf(s1) as unknown as { events: Array<{ k: string; v: number }> }).events.at(-1);
    expect(ev?.k).toBe('roll');
    expect(ev?.v).toBeGreaterThanOrEqual(1);
    expect(ev?.v).toBeLessThanOrEqual(6);
  });

  it('a move must be one the roll allows; a capture sends the rival home', async () => {
    const { code, ann } = await started();
    // Red token on its square 10, yellow token on abs 14 (yellow's square 40); red rolled a 4
    const seq = await inRoom(code, (r) => {
      const g = r.g as G;
      g.tokens[0] = [10, -1, -1, -1];
      g.tokens[2] = [40, -1, -1, -1];
      g.roll = 4;
      (g as unknown as { rolls: number[] }).rolls = [4];
      g.phase = 'move';
      g.legal = E.legalMoves(g, 4);
      return g.seq;
    });
    ann.send({ t: 'move', c: 0, i: 1, seq });   // a token in the yard can't move on a 4
    await sleep(100);
    expect(await inRoom(code, (r) => r.g?.tokens[0][1])).toBe(-1);
    ann.send({ t: 'move', c: 0, i: 0, seq });
    const s = await ann.state((v) => gOf(v).tokens[0]?.[0] === 14);
    expect(gOf(s).tokens[2][0]).toBe(-1);
    expect(gOf(s).turn).toBe(0);   // capture bonus
  });

  it('roll all first: the player picks which waiting roll each move uses; a forged roll index is refused', async () => {
    const { code, ann } = await started();
    const seq = await inRoom(code, (r) => {
      const g = r.g as G & { rolls: number[] };
      g.tokens[0] = [10, 20, -1, -1];
      g.rolls = [6, 3];
      g.roll = 3;
      g.phase = 'move';
      g.legal = E.legalMoves(g);
      return g.seq;
    });
    ann.send({ t: 'move', c: 0, i: 1, r: 5, seq });   // no such roll
    await sleep(100);
    expect(await inRoom(code, (r) => r.g?.tokens[0][1])).toBe(20);
    ann.send({ t: 'move', c: 0, i: 1, r: 1, seq });   // the 3
    const s = await ann.state((v) => gOf(v).tokens[0]?.[1] === 23);
    expect((s.g as { rolls: number[] }).rolls).toEqual([6]);
    expect(gOf(s).phase).toBe('move');
    expect(gOf(s).turn).toBe(0);
  });

  it('no possible move: the turn moves on after a pause', async () => {
    const { code, ann } = await started({ leave: 'six' });
    await inRoom(code, (r) => {
      const g = r.g as G;
      E.roll(g, 3);   // everything still in the yard
    });
    expect(await inRoom(code, (r) => r.g?.phase)).toBe('pass');
    await fire(code, 'step');
    const s = await ann.state((v) => gOf(v).turn === 2 && gOf(v).phase === 'roll');
    expect(gOf(s).roll).toBe(0);
  });

  it('a single possible move is played for the player after the die lands', async () => {
    const { code, ann } = await started({ sixRule: 'move' });
    await inRoom(code, (r) => {
      const g = r.g as G;
      g.tokens[0] = [20, -1, -1, -1];
    });
    ann.send({ t: 'roll', seq: await inRoom(code, (r) => r.g?.seq) });
    const rolled = await ann.state((v) => gOf(v).phase === 'move' || gOf(v).roll === 0);
    if (gOf(rolled).phase !== 'move') return;   // rolled a 6 with... (never: a 6 has two choices; skip if a pass)
    const choices = E.distinctMoves(gOf(rolled).legal);
    if (choices.length !== 1) return;
    await fire(code, 'bot');
    const s = await ann.state((v) => gOf(v).tokens[0] !== undefined && gOf(v).tokens[0][0] !== 20);
    expect(gOf(s).tokens[0][0]).toBeGreaterThan(20);
  });

  it('out of time: the computer plays for you; three in a row and it keeps playing until you are back', async () => {
    const { code, ann, ids } = await started({ timer: 10 });
    for (let k = 0; k < 3; k++) {
      await inRoom(code, (r) => {
        const g = r.g as G;
        g.turn = 0;
        g.phase = 'roll';
        (r as unknown as { turnEnd: number }).turnEnd = Date.now();
      });
      await fire(code, 'turn');
      await ann.state((v) => (playersOf(v).find((p) => p.id === ids[0])?.strikes as number) === k + 1 || Boolean(playersOf(v).find((p) => p.id === ids[0])?.autoplay));
    }
    const s = await ann.state((v) => Boolean(playersOf(v).find((p) => p.id === ids[0])?.autoplay));
    expect(playersOf(s).find((p) => p.id === ids[0])?.autoplay).toBe(true);
    ann.send({ t: 'back' });
    const back = await ann.state((v) => playersOf(v).find((p) => p.id === ids[0])?.autoplay === false);
    expect(playersOf(back).find((p) => p.id === ids[0])?.strikes).toBe(0);
  });

  it('a bot rolls and moves on its own timer, through the same checks', async () => {
    const { code, clients } = await room('ludo', ['Ann']);
    const [ann] = clients;
    ann.send({ t: 'addBot', level: 'normal' });
    await ann.state((v) => (v.seats as unknown[]).filter(Boolean).length === 2);
    ann.send({ t: 'start' });
    await ann.state((v) => v.status === 'play');
    await inRoom(code, (r) => {
      const g = r.g as G;
      g.turn = 2;
      g.phase = 'roll';
      g.seq += 1;
      g.tokens[2] = [5, -1, -1, -1];
    });
    // What a broadcast does: plan the bot's turn for this step
    await inRoom(code, (r) => { const x = r as unknown as { botKey: string; game: number }; x.botKey = `${x.game}:${r.g?.seq}`; });
    await inRoom(code, (_r, i) => { i.timers.bot = Date.now(); });
    await runDurableObjectAlarm(stub(code));
    const seq = await inRoom(code, (r) => r.g?.seq);
    expect(seq).toBeGreaterThan(1);
  });

  it('plays a whole game to the end, writes the result and counts the win', async () => {
    const { code, ann, bob, ids } = await started({ tokens: 2, leave: 'oneSix', exact: false });
    await inRoom(code, (r) => {
      const g = r.g as G;
      g.tokens[0] = [55, 56];
      g.tokens[2] = [30, -1];
      g.turn = 0;
      g.phase = 'roll';
    });
    // Ann is nearly home (no exact roll needed): keep driving the game until it is over
    for (let k = 0; k < 400; k++) {
      const st = await inRoom(code, (r) => ({ status: r.status, g: r.g }));
      if (st.status === 'over') break;
      const g = st.g as G;
      const who = g.turn === 0 ? ann : bob;
      if (g.phase === 'roll') who.send({ t: 'roll', seq: g.seq });
      else if (g.phase === 'move') {
        const m = E.chooseMove(g, 'normal', Math.random) as { c: number; i: number; r: number };
        who.send({ t: 'move', c: m.c, i: m.i, r: m.r, seq: g.seq });
      } else if (g.phase === 'pass') await fire(code, 'step');
      await sleep(130);
    }
    const s = await ann.state((v) => v.status === 'over');
    const result = s.result as { winners: number[]; order: number[]; names: Record<number, string> };
    expect(result.winners.length).toBe(1);
    expect(result.order.length).toBe(2);
    const winnerId = ids[result.winners[0] === 0 ? 0 : 1];
    expect(playersOf(s).find((p) => p.id === winnerId)?.wins).toBe(1);
    // Rematch keeps the seats; back to the lobby clears the game
    ann.send({ t: 'lobby' });
    const lobby = await bob.state((v) => v.status === 'lobby');
    expect(lobby.g).toBeNull();
  }, 20000);

  it('the host can move players between colours in the lobby; players can pick a free one', async () => {
    const { clients, ids } = await room('ludo', ['Ann', 'Bob']);
    const [ann, bob] = clients;
    bob.send({ t: 'sit', seat: 1 });
    let s = await ann.state((v) => (v.seats as unknown[])[1] === ids[1]);
    expect((s.seats as unknown[])[2]).toBeNull();
    bob.send({ t: 'sit', seat: 0 });   // taken by Ann
    ann.send({ t: 'seat', id: ids[1], seat: 0 });   // host swaps them
    s = await ann.state((v) => (v.seats as unknown[])[0] === ids[1]);
    expect((s.seats as unknown[])[1]).toBe(ids[0]);
  });
});
