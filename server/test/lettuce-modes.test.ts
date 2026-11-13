import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as E from '../../web/lettuce-party/js/engine.js';
import type { RoomCtx } from '../src/core/game';
import { lettuce } from '../src/games/lettuce';
import { playersOf, room, sleep, TestClient, type Msg } from './helpers';

const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(`lettuce-party:${code}`));
interface RoomShape {
  word: string | null;
  ladder: { start: string; target: string; par: number; path: string[] } | null;
  status: string;
  mode: string;
  hard: boolean;
  attempts: number;
  ladderTime: number;
  ladderReuse: boolean;
  players: Array<{ guesses: Array<{ word: string; pattern: string }> }>;
  timer: number;
  history: Array<{ word: string | null; winner: string | null }>;
}
type Inner = { game: { room: RoomShape }; timers: Record<string, number> };
const inRoom = <T>(code: string, f: (r: RoomShape, i: Inner) => T) => runInDurableObject(stub(code), (i) => f((i as unknown as Inner).game.room, i as unknown as Inner));

/** Every raw message a client receives, so tests can search what a player was ever told. */
function record(c: TestClient): string[] {
  const log: string[] = [];
  c.ws.addEventListener('message', (e) => { if (typeof e.data === 'string') log.push(e.data); });
  return log;
}

/** The newest state a client was sent, read back from its recorded log. */
const lastState = (log: string[]): Msg => [...log].reverse().map((l) => JSON.parse(l) as Msg).find((m) => m.t === 'state') as Msg;

type Setup = Record<string, unknown>;
const view = (m: Msg) => m as Msg & { players: Array<Record<string, unknown>> };
const me = (s: Msg, name: string) => (playersOf(s).find((p) => p.name === name) ?? {}) as Record<string, unknown>;

/** A lobby with the settings applied; the host then starts it. Returns once everyone sees the round running. */
async function startRound(names: string[], settings: Setup) {
  const { code, clients } = await room('lettuce-party', names);
  const logs = clients.map(record);
  const [host] = clients;
  host.send({ t: 'settings', patch: settings });
  await host.state((s) => Object.entries(settings).every(([k, v]) => s[k] === v));
  host.send({ t: 'start' });
  for (const c of clients) await c.state((s) => s.status === 'playing');
  return { code, clients, logs, host };
}

async function counts(code: string, word: string) {
  await inRoom(code, (r) => { r.word = word; });
}
async function ladder(code: string, start: string, target: string, par = 2) {
  await inRoom(code, (r) => { r.ladder = { start, target, par, path: [start, 'crate', target] }; });
}
const guess = (c: TestClient, word: string) => c.send({ t: 'guess', word });
const lastView = async (c: TestClient, pred: (s: Msg) => boolean) => c.state(pred);

describe('Lettuce Party settings', () => {
  it('starts as a classic room with six guesses and the ladder time at three minutes', async () => {
    const { code, clients } = await room('lettuce-party', ['Ann']);
    clients[0].send({ t: 'settings', patch: {} });
    const s = await clients[0].state();
    expect(s).toMatchObject({ mode: 'classic', attempts: 6, ladderTime: 180, hard: false });
    expect(await inRoom(code, (r) => r.mode)).toBe('classic');
  });

  it('host settings are cleaned on the server: bad mode, attempts and times are thrown away', async () => {
    const { clients: [host] } = await room('lettuce-party', ['Ann']);
    host.send({ t: 'settings', patch: { mode: 'counts', attempts: 9, ladderTime: 300 } });
    await host.state((s) => s.mode === 'counts' && s.attempts === 9 && s.ladderTime === 300);
    host.send({ t: 'settings', patch: { mode: 'speed', attempts: 99, ladderTime: 7, timer: 61 } });
    host.send({ t: 'settings', patch: { attempts: '4', mode: ['ladder'], hard: 'yes' } });
    host.send({ t: 'settings', patch: { maxRounds: 3 } });
    const s = await host.state((x) => x.maxRounds === 3);
    expect(s).toMatchObject({ mode: 'counts', attempts: 9, ladderTime: 300, timer: 0, hard: false });
  });

  it('a player who is not the host cannot change the settings', async () => {
    const { clients: [host, bob] } = await room('lettuce-party', ['Ann', 'Bob']);
    bob.send({ t: 'settings', patch: { mode: 'ladder', attempts: 4 } });
    host.send({ t: 'settings', patch: { maxRounds: 5 } });   // a later message from the host proves the first was processed (or dropped)
    const s = await host.state((x) => x.maxRounds === 5);
    expect(s).toMatchObject({ mode: 'classic', attempts: 6 });
  });

  it('hard mode only works in Classic: the toggle is dropped in Counts and Ladder, and the server ignores it there', async () => {
    const { clients: [host], code } = await room('lettuce-party', ['Ann']);
    host.send({ t: 'settings', patch: { hard: true } });
    await host.state((s) => s.hard === true);
    host.send({ t: 'settings', patch: { mode: 'counts' } });
    expect((await host.state((s) => s.mode === 'counts')).hard).toBe(false);
    host.send({ t: 'settings', patch: { hard: true } });
    host.send({ t: 'settings', patch: { maxRounds: 3 } });
    expect((await host.state((s) => s.maxRounds === 3)).hard).toBe(false);
    host.send({ t: 'settings', patch: { mode: 'ladder', hard: true } });
    expect((await host.state((s) => s.mode === 'ladder')).hard).toBe(false);
    // even if the flag somehow sat on the room, a Counts guess is not held to the hard-mode rules
    host.send({ t: 'settings', patch: { mode: 'counts' } });
    await host.state((s) => s.mode === 'counts');
    host.send({ t: 'start' });
    await host.state((s) => s.status === 'playing');
    await counts(code, 'level');
    await inRoom(code, (r) => { r.hard = true; });
    guess(host, 'crane');                       // E is in the word but misplaced: Classic hard mode would insist on E next
    await host.next((m) => m.t === 'result' && m.word === 'crane');
    guess(host, 'ghost');
    expect(await host.next((m) => m.t === 'result' || m.t === 'invalid')).toMatchObject({ t: 'result', word: 'ghost' });
  });
  it('settings are frozen while a round is running', async () => {
    const { clients: [host], code } = await startRound(['Ann', 'Bob'], { mode: 'counts', attempts: 5 });
    host.send({ t: 'settings', patch: { mode: 'ladder', attempts: 10, timer: 60, maxRounds: 3, hard: true, strict: false } });
    host.send({ t: 'endRound' });
    const s = await host.state((x) => x.status === 'ended');
    expect(s).toMatchObject({ mode: 'counts', attempts: 5, timer: 0, maxRounds: 0, strict: true });
    // ... and between rounds, until the host goes back to the lobby
    host.send({ t: 'settings', patch: { mode: 'classic' } });
    host.send({ t: 'lobby' });
    await host.state((x) => x.status === 'lobby');
    host.send({ t: 'settings', patch: { mode: 'classic' } });
    expect((await host.state((x) => x.mode === 'classic')).mode).toBe('classic');
    expect(await inRoom(code, (r) => r.mode)).toBe('classic');
  });

  it('a room saved before modes existed comes back as a classic room with six guesses', () => {
    const snap = { code: 'ABCD', status: 'lobby', game: 0, players: [], strict: true, hard: true, winRule: 'fewest', maxRounds: 3, timer: 120, round: 2, matchRound: 1, stats: {}, history: [], used: [], word: null, lastWord: null, startedAt: 0 };
    const ctx = { now: () => 1, lastSeen: () => 0 } as unknown as RoomCtx;
    lettuce.restore(ctx, snap);
    expect(snap).toMatchObject({ mode: 'classic', attempts: 6, ladderTime: 180, hard: true, winRule: 'fewest', timer: 120, ladder: null, usedPairs: [] });
  });
});

describe('Lettuce Party attempts', () => {
  it('Classic: the host-chosen number of guesses is enforced and an extra guess is refused', async () => {
    const { clients: [host], code } = await startRound(['Ann'], { attempts: 4 });
    await counts(code, 'level');
    for (const w of ['crane', 'slate', 'ghost', 'pound']) {
      guess(host, w);
      await host.next((m) => m.t === 'result' && m.word === w);
    }
    const s = await host.state((x) => x.status === 'ended');
    expect(me(s, 'Ann')).toMatchObject({ used: 4, done: true, solved: false });
    guess(host, 'brick');
    expect((await host.next((m) => m.t === 'invalid')).reason).toBe('This round is over');
    expect(await inRoom(code, (r) => r.status)).toBe('ended');
  });

  it('Classic with 10 guesses allows ten and refuses the eleventh', async () => {
    const { clients: [host, bob], code } = await startRound(['Ann', 'Bob'], { attempts: 10 });
    await counts(code, 'level');
    const words = ['crane', 'slate', 'ghost', 'pound', 'brick', 'plumb', 'fjord', 'whack', 'jumpy', 'vixen'];
    for (const [i, w] of words.entries()) {
      guess(host, w);
      await host.next((m) => m.t === 'result' && m.word === w);
      if (i % 3 === 2) await sleep(600);
    }
    const s = await bob.state((x) => me(x, 'Ann').used === 10);
    expect(me(s, 'Ann')).toMatchObject({ done: true });
    guess(host, 'crane');
    expect((await host.next((m) => m.t === 'invalid')).reason).toBe('This round is over');
  });

  it('Classic hard mode still holds', async () => {
    const { clients: [host], code } = await startRound(['Ann'], { hard: true });
    await counts(code, 'level');
    guess(host, 'crane');
    await host.next((m) => m.t === 'result');
    guess(host, 'ghost');
    expect((await host.next((m) => m.t === 'invalid')).reason).toBe('Guess must contain E');
  });

  it('Counts also stops at the chosen number of guesses', async () => {
    const { clients: [host], code } = await startRound(['Ann', 'Bob'], { mode: 'counts', attempts: 4 });
    await counts(code, 'level');
    for (const w of ['crane', 'slate', 'ghost', 'pound']) {
      guess(host, w);
      await host.next((m) => m.t === 'result' && m.word === w);
    }
    const s = await host.state((x) => me(x, 'Ann').done === true);
    expect(me(s, 'Ann').used).toBe(4);
    guess(host, 'brick');
    await host.next((m) => m.t === 'invalid');
  });
});

describe('Lettuce Party Counts', () => {
  it('guessers get only the three numbers, and nobody is ever sent tile colours or the word before the end', async () => {
    const { code, clients: [ann, bob], logs: [annLog, bobLog] } = await startRound(['Ann', 'Bob'], { mode: 'counts' });
    await counts(code, 'level');
    guess(ann, 'eerie');
    const result = await ann.next((m) => m.t === 'result');
    expect(result).toMatchObject({ word: 'eerie', counts: [1, 1, 3] });
    expect(result).not.toHaveProperty('pattern');
    // Bob (and Ann) see the numbers per row, no letters and no colours
    const s = await bob.state((x) => me(x, 'Ann').used === 1);
    expect(me(s, 'Ann')).toMatchObject({ counts: [[1, 1, 3]], patterns: [], rows: null, match: null });
    expect(JSON.stringify(s)).not.toContain('eerie');
    expect(s.word).toBeNull();
    // Search everything either player was ever sent during the round
    for (const log of [annLog, bobLog]) {
      const joined = log.join('\n');
      expect(joined).not.toContain('level');
      expect(joined).not.toMatch(/"pattern"/);
      expect(joined).not.toMatch(/"patterns":\[[^\]]/);   // Classic patterns are always empty here
    }
    expect(bobLog.join('\n')).not.toContain('eerie');
  });

  it('the host gets no more than anyone else', async () => {
    const { code, clients: [host, bob], logs: [hostLog] } = await startRound(['Ann', 'Bob'], { mode: 'counts' });
    await counts(code, 'level');
    guess(bob, 'slate');
    await host.state((s) => me(s, 'Bob').used === 1);
    expect(hostLog.join('\n')).not.toContain('level');
    expect(hostLog.join('\n')).not.toContain('slate');
    expect(hostLog.join('\n')).not.toMatch(/"pattern"/);
  });

  it('reveals the word and everyone\'s rows with colours when the round is over', async () => {
    const { code, clients: [ann, bob] } = await startRound(['Ann', 'Bob'], { mode: 'counts' });
    await counts(code, 'level');
    guess(ann, 'eerie');
    guess(bob, 'level');
    const s = await ann.state((x) => x.status === 'playing' && me(x, 'Bob').solved === true);
    expect(s.word).toBeNull();
    expect(me(s, 'Bob').rows).toBeNull();
    ann.send({ t: 'endRound' });
    const end = await ann.state((x) => x.status === 'ended');
    expect(end.word).toBe('level');
    expect(me(end, 'Ann').rows).toEqual([{ word: 'eerie', pattern: 'nhmmm' }]);
    expect(me(end, 'Bob').rows).toEqual([{ word: 'level', pattern: 'hhhhh' }]);
    expect(end.history).toMatchObject([{ word: 'level', winner: 'Bob' }]);
  });

  it('refresh mid-round gives your rows back as numbers (no colours)', async () => {
    const { code, clients: [ann, bob] } = await startRound(['Ann', 'Bob'], { mode: 'counts', attempts: 7 });
    await counts(code, 'level');
    guess(bob, 'eerie');
    await bob.next((m) => m.t === 'result');
    bob.close();
    await ann.state((s) => me(s, 'Bob').connected === false);
    const again = await TestClient.open(`/lettuce-party/ws?code=${code}`);
    const log = record(again);
    again.join('Bob');
    const board = await again.next((m) => m.t === 'board');
    expect(board).toMatchObject({ mode: 'counts', attempts: 7, guesses: [{ word: 'eerie', counts: [1, 1, 3] }] });
    expect(JSON.stringify(board)).not.toContain('pattern');
    expect(log.join('\n')).not.toContain('level');
  });
});

describe('Lettuce Party Word ladder', () => {
  it('picks a start and target from the pairs file, shows them to everyone, and keeps the path secret', async () => {
    const { clients: [ann], logs: [, bobLog] } = await startRound(['Ann', 'Bob'], { mode: 'ladder' });
    const s = lastState(bobLog);
    const lad = s.ladder as { start: string; target: string; par: number; path: string[] | null };
    expect(lad.start).toMatch(/^[a-z]{5}$/);
    expect(lad.target).toMatch(/^[a-z]{5}$/);
    expect(lad.par).toBeGreaterThanOrEqual(3);
    expect(lad.path).toBeNull();
    expect(s.word).toBeNull();
    expect(s.timer).toBe(0);
    expect(s.ladderTime).toBe(180);
    ann.close();
  });

  it('rejects steps that are not words, change more than one letter, or repeat a word (reuse turned off)', async () => {
    const { code, clients: [ann] } = await startRound(['Ann', 'Bob'], { mode: 'ladder', ladderReuse: false });
    await ladder(code, 'crane', 'irate');
    const reason = async (w: string) => { guess(ann, w); return (await ann.next((m) => m.t === 'invalid')).reason; };
    expect(await reason('crane')).toBe('Change exactly one letter');   // the start word again
    expect(await reason('slate')).toBe('Change exactly one letter');
    expect(await reason('qrane')).toBe('Not a word');
    expect(await reason('cra')).toBe('Not enough letters');
    guess(ann, 'crate');
    expect(await ann.next((m) => m.t === 'result')).toMatchObject({ word: 'crate' });
    expect(await reason('crane')).toBe('Already used');
    expect(await reason('crate')).toBe('Change exactly one letter');
    const s = await ann.state((x) => me(x, 'Ann').used === 1);
    expect(me(s, 'Ann')).toMatchObject({ used: 1, solved: false });   // rejected steps never count
  });

  it('Reuse words is on by default: going back to the start word or a middle word is a new step, and finishing still ends the round', async () => {
    const { code, clients: [ann, bob] } = await startRound(['Ann', 'Bob'], { mode: 'ladder' });
    expect((await ann.state()).ladderReuse).toBe(true);
    await ladder(code, 'crane', 'irate');
    const step = async (w: string) => { guess(ann, w); return ann.next((m) => m.t === 'result' || m.t === 'invalid'); };
    expect(await step('crate')).toMatchObject({ t: 'result', word: 'crate' });
    expect(await step('crane')).toMatchObject({ t: 'result', word: 'crane' });   // back to the start word
    expect(await step('crate')).toMatchObject({ t: 'result', word: 'crate' });   // and forward again
    expect(await step('grate')).toMatchObject({ t: 'result', word: 'grate' });
    expect(await step('crate')).toMatchObject({ t: 'result', word: 'crate' });   // back to a middle word
    expect(await step('crate')).toMatchObject({ t: 'invalid', reason: 'Change exactly one letter' });   // still one letter from where you are
    expect(await step('qrate')).toMatchObject({ t: 'invalid', reason: 'Not a word' });                  // still a real word
    expect(await step('irate')).toMatchObject({ t: 'result', word: 'irate' });
    const s = await bob.state((x) => me(x, 'Ann').solved === true);
    expect(me(s, 'Ann')).toMatchObject({ used: 6, done: true });                  // every step typed counts
    ann.send({ t: 'endRound' });
    await ann.state((x) => x.status === 'ended');
    expect(await inRoom(code, (r) => r.players[0].guesses.map((g) => g.word))).toEqual(['crate', 'crane', 'crate', 'grate', 'crate', 'irate']);
  });

  it('the host can turn Reuse words off; a non-host cannot; it is frozen mid-round', async () => {
    const { clients: [host, bob] } = await room('lettuce-party', ['Ann', 'Bob']);
    bob.send({ t: 'settings', patch: { ladderReuse: false } });
    host.send({ t: 'settings', patch: { maxRounds: 3 } });
    expect((await host.state((x) => x.maxRounds === 3)).ladderReuse).toBe(true);
    host.send({ t: 'settings', patch: { mode: 'ladder', ladderReuse: 'no' } });          // a bad value is ignored
    host.send({ t: 'settings', patch: { maxRounds: 5 } });
    expect((await host.state((x) => x.maxRounds === 5)).ladderReuse).toBe(true);
    host.send({ t: 'settings', patch: { ladderReuse: false } });
    await host.state((x) => x.ladderReuse === false);
    host.send({ t: 'start' });
    await host.state((x) => x.status === 'playing');
    host.send({ t: 'settings', patch: { ladderReuse: true } });                          // mid-round: ignored
    host.send({ t: 'endRound' });
    expect((await host.state((x) => x.status === 'ended')).ladderReuse).toBe(false);
  });

  it('with reuse on the 60-step cap still applies', async () => {
    const { code, clients: [ann] } = await startRound(['Ann', 'Bob'], { mode: 'ladder' });
    await ladder(code, 'crane', 'irate');
    await inRoom(code, (r) => { r.players[0].guesses = Array.from({ length: 60 }, (_, i) => ({ word: i % 2 ? 'crane' : 'crate', pattern: '' })); });
    guess(ann, 'crane');                       // last step was crane (index 59), so go to crate
    expect((await ann.next((m) => m.t === 'invalid')).reason).toBe('Change exactly one letter');
    guess(ann, 'crate');
    expect((await ann.next((m) => m.t === 'invalid')).reason).toBe('Too many steps');
  });

  it('a room saved before Reuse words existed gets it switched on', () => {
    const snap = { code: 'ABCD', status: 'lobby', game: 0, players: [], mode: 'ladder', strict: true, hard: false, winRule: 'first', maxRounds: 0, timer: 0, ladderTime: 120, round: 0, matchRound: 0, stats: {}, history: [], used: [], word: null, lastWord: null, startedAt: 0 };
    lettuce.restore({ now: () => 1, lastSeen: () => 0 } as unknown as RoomCtx, snap);
    expect(snap).toMatchObject({ mode: 'ladder', ladderTime: 120, ladderReuse: true });
  });

  it('blocked words are not allowed as steps, because the par was worked out without them', async () => {
    const { code, clients: [ann] } = await startRound(['Ann', 'Bob'], { mode: 'ladder' });
    await ladder(code, 'shire', 'suite');
    guess(ann, 'shite');                    // one letter from SHIRE and in valid.txt, but a blocked word
    expect((await ann.next((m) => m.t === 'invalid')).reason).toBe('Not a word');
    guess(ann, 'share');
    expect(await ann.next((m) => m.t === 'result')).toMatchObject({ word: 'share' });
  });

  it('reaching the target wins the round; others\' words stay hidden until the results', async () => {
    const { code, clients: [ann, bob], logs: [annLog, bobLog] } = await startRound(['Ann', 'Bob'], { mode: 'ladder' });
    await ladder(code, 'crane', 'irate');
    guess(ann, 'crate');
    await ann.next((m) => m.t === 'result');
    const mid = await bob.state((x) => me(x, 'Ann').used === 1);
    expect(me(mid, 'Ann')).toMatchObject({ used: 1, match: 4, patterns: [], counts: [], rows: null, solved: false });
    expect((mid.ladder as { path: unknown }).path).toBeNull();
    expect(bobLog.join('\n')).not.toContain('crate');
    guess(ann, 'irate');
    await ann.next((m) => m.t === 'result' && m.word === 'irate');
    const s = await bob.state((x) => me(x, 'Ann').solved === true);
    expect(me(s, 'Ann')).toMatchObject({ used: 2, match: 5, done: true });
    expect(bobLog.join('\n')).not.toContain('crate');      // still nothing about Ann's words while Bob plays
    guess(bob, 'grane');                                    // Bob wanders off
    await bob.next((m) => m.t === 'invalid');               // (not a word)
    bob.send({ t: 'endRound' });                            // not host: ignored
    ann.send({ t: 'endRound' });
    const end = await bob.state((x) => x.status === 'ended');
    expect(me(end, 'Ann').rows).toEqual([{ word: 'crate' }, { word: 'irate' }]);
    expect((end.ladder as { path: string[] }).path).toEqual(['crane', 'crate', 'irate']);
    expect(end.history).toMatchObject([{ word: 'crane to irate', winner: 'Ann' }]);
    expect(annLog.join('\n')).toContain('crane');
  });

  it('Fewest steps: the shorter ladder beats the one that finished first; Nobody finishing means no winner', async () => {
    const { code, clients: [ann, bob], host } = await startRound(['Ann', 'Bob'], { mode: 'ladder', winRule: 'fewest' });
    await ladder(code, 'crane', 'irate');
    for (const w of ['crate', 'grate', 'irate']) { guess(ann, w); await ann.next((m) => m.t === 'result' && m.word === w); }
    await sleep(40);
    guess(bob, 'crate');
    await bob.next((m) => m.t === 'result');
    guess(bob, 'irate');
    await bob.next((m) => m.t === 'result' && m.word === 'irate');
    const end = await host.state((x) => x.status === 'ended');
    expect(end.history).toMatchObject([{ winner: 'Bob' }]);
    expect(me(end, 'Ann')).toMatchObject({ used: 3, solved: true });
  });

  it('the time limit ends the round with no winner when nobody reached the target', async () => {
    const { code, clients: [ann, bob] } = await startRound(['Ann', 'Bob'], { mode: 'ladder', ladderTime: 60 });
    await ladder(code, 'crane', 'irate');
    guess(ann, 'crate');
    await ann.next((m) => m.t === 'result');
    // The round has a 60 s timer: make it due and let the alarm run
    expect(await inRoom(code, (_r, i) => (i.timers.round ?? 0) > Date.now() + 50_000)).toBe(true);
    await inRoom(code, (_r, i) => { i.timers.round = Date.now(); });
    await runDurableObjectAlarm(stub(code));
    const end = await bob.state((x) => x.status === 'ended');
    expect(end.history).toMatchObject([{ word: 'crane to irate', winner: null }]);
    expect(me(end, 'Ann')).toMatchObject({ solved: false, timedOut: true, used: 1, match: 4 });
    expect(me(end, 'Bob')).toMatchObject({ solved: false, timedOut: true, used: 0 });
    expect((end.ladder as { path: string[] }).path).toHaveLength(3);
  });

  it('the ladder time limit (not the Classic timer) applies, and it is always on', async () => {
    const { code } = await startRound(['Ann'], { mode: 'ladder', ladderTime: 120, timer: 60 });
    expect(await inRoom(code, (_r, i) => i.timers.round > Date.now() + 100_000 && i.timers.round < Date.now() + 121_000)).toBe(true);
  });

  it('refresh mid-round gives your ladder back', async () => {
    const { code, clients: [ann, bob] } = await startRound(['Ann', 'Bob'], { mode: 'ladder', ladderReuse: false });
    await ladder(code, 'crane', 'irate');
    guess(bob, 'crate');
    await bob.next((m) => m.t === 'result');
    bob.close();
    await ann.state((s) => me(s, 'Bob').connected === false);
    const again = await TestClient.open(`/lettuce-party/ws?code=${code}`);
    again.join('Bob');
    const board = await again.next((m) => m.t === 'board');
    expect(board).toMatchObject({ mode: 'ladder', guesses: [{ word: 'crate' }] });
    // and the next step continues from the restored ladder
    guess(again, 'crane');
    expect((await again.next((m) => m.t === 'invalid')).reason).toBe('Already used');
    guess(again, 'irate');
    expect(await again.next((m) => m.t === 'result')).toMatchObject({ word: 'irate' });
  });

  it('never repeats a pair within a room while there are others', async () => {
    const { code, clients: [host] } = await startRound(['Ann'], { mode: 'ladder' });
    const seen = new Set<string>();
    for (let n = 0; n < 6; n++) {
      const pair = await inRoom(code, (r) => `${r.ladder?.start} ${r.ladder?.target}`);
      expect(seen.has(pair)).toBe(false);
      seen.add(pair);
      host.send({ t: 'endRound' });
      await host.state((s) => s.status === 'ended');
      host.send({ t: 'next' });
      await host.state((s) => s.status === 'playing' && s.matchRound === n + 2);
      if (n % 2) await sleep(700);
    }
  });
});

describe('Lettuce Party stats by mode', () => {
  async function stats(token: string): Promise<Record<string, number>> {
    const res = await SELF.fetch('https://play.test/api/me/stats?game=lettuce-party', { headers: { 'X-Guest': token } });
    return ((await res.json()) as { stats: Record<string, number> }).stats;
  }
  async function until(token: string, ok: (s: Record<string, number>) => boolean) {
    let s = await stats(token);
    for (let i = 0; i < 40 && !ok(s); i++) { await sleep(50); s = await stats(token); }
    return s;
  }

  it('Counts and Ladder write their own stats and leave Classic\'s win count, streak and openers alone', async () => {
    const { code, clients: [ann, bob] } = await startRound(['Ann', 'Bob'], { mode: 'counts' });
    const tokens = await Promise.all([ann, bob].map(async (c) => (await c.next((m) => m.t === 'guest')).token as string));
    await counts(code, 'level');
    guess(ann, 'eerie');
    guess(ann, 'level');
    await ann.next((m) => m.t === 'result' && m.word === 'level');
    ann.send({ t: 'endRound' });
    await ann.state((s) => s.status === 'ended');
    const a = await until(tokens[0], (s) => s['counts:plays'] === 1);
    expect(a).toMatchObject({ 'counts:plays': 1, 'counts:wins': 1, 'counts:solved': 1, 'counts:guessSum': 2 });
    expect(a.countsFastestNeg).toBeLessThan(0);
    for (const k of ['wins', 'rounds', 'solved', 'guessSum', 'streak', 'bestStreak', 'fastestNeg', 'dist2', 'opener:eerie']) expect(a[k], k).toBeUndefined();
    const b = await until(tokens[1], (s) => s['counts:plays'] === 1);
    expect(b['counts:plays']).toBe(1);
    expect(b['counts:solved']).toBeUndefined();
    expect(b['counts:wins']).toBeUndefined();

    // a Ladder round in the same room, back in the lobby first
    ann.send({ t: 'lobby' });
    await ann.state((s) => s.status === 'lobby');
    ann.send({ t: 'settings', patch: { mode: 'ladder' } });
    await ann.state((s) => s.mode === 'ladder');
    ann.send({ t: 'start' });
    await ann.state((s) => s.status === 'playing');
    await ladder(code, 'crane', 'irate');
    for (const w of ['crate', 'grate', 'irate']) { guess(ann, w); await ann.next((m) => m.t === 'result' && m.word === w); }
    ann.send({ t: 'endRound' });
    await ann.state((s) => s.status === 'ended');
    const l = await until(tokens[0], (s) => s['ladder:plays'] === 1);
    // 3 steps against a par of 2: one over par
    expect(l).toMatchObject({ 'ladder:plays': 1, 'ladder:wins': 1, 'ladder:solved': 1, 'ladder:steps': 3, 'ladder:overPar': 1, ladderBestOverNeg: -1 });
    expect(l.ladderFastestNeg).toBeLessThan(0);
    expect(l['counts:plays']).toBe(1);
    expect(l.wins).toBeUndefined();
    const lb = await until(tokens[1], (s) => s['ladder:plays'] === 1);
    expect(lb['ladder:solved']).toBeUndefined();
    expect(lb.ladderBestOverNeg).toBeUndefined();
  });

  it('Classic keeps its stats exactly, and a guess count above six lands in its own distribution bucket', async () => {
    const { code, clients: [ann] } = await startRound(['Ann'], { attempts: 8 });
    const token = (await ann.next((m) => m.t === 'guest')).token as string;
    await counts(code, 'level');
    const words = ['crane', 'slate', 'ghost', 'pound', 'brick', 'plumb', 'fjord'];
    for (const [i, w] of words.entries()) {
      guess(ann, w);
      await ann.next((m) => m.t === 'result' && m.word === w);
      if (i % 3 === 2) await sleep(600);
    }
    guess(ann, 'level');
    await ann.next((m) => m.t === 'result' && m.word === 'level');
    await ann.state((s) => s.status === 'ended');
    const s = await until(token, (x) => x.rounds === 1);
    expect(s).toMatchObject({ rounds: 1, wins: 1, solved: 1, guessSum: 8, streak: 1, dist8: 1, 'opener:crane': 1 });
    expect(s['counts:plays']).toBeUndefined();
    expect(s['ladder:plays']).toBeUndefined();
  });
});

describe('Lettuce Party engine and server agree', () => {
  it('the server\'s numbers are the engine\'s', () => {
    expect(E.countsFor('eerie', 'level')).toEqual([1, 1, 3]);
  });
});
