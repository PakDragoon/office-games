import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as E from '../../web/alzheimers/js/engine.js';
import { playersOf, room, TestClient, type Msg } from './helpers';

const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(`alzheimers:${code}`));
interface P { id: string; name: string; words: string[]; strokes: Array<{ b: number; pts: number[] }>; order: number[] }
interface R { status: string; drawStart: number; phaseEnd: number; players: P[] }
type Inner = { game: { room: R }; timers: Record<string, number> };
const inRoom = <T>(code: string, f: (r: R, i: Inner) => T) => runInDurableObject(stub(code), (i) => f((i as unknown as Inner).game.room, i as unknown as Inner));
const fire = async (code: string, name: string) => {
  await inRoom(code, (_r, i) => { i.timers[name] = Date.now(); });
  await runDurableObjectAlarm(stub(code));
};
function record(c: TestClient): string[] {
  const log: string[] = [];
  c.ws.addEventListener('message', (e) => { if (typeof e.data === 'string') log.push(e.data); });
  return log;
}
const TWELVE = ['cat', 'tree', 'house', 'boat', 'apple', 'sun', 'car', 'fish', 'hat', 'chair', 'moon', 'shoe'];

async function toDrawing() {
  const { code, clients, ids } = await room('alzheimers', ['Ann', 'Bob']);
  const logs = clients.map(record);
  const [ann, bob] = clients;
  ann.send({ t: 'begin', settings: { pace: 5, flash: 1000 } });
  await bob.state((s) => s.status === 'write');
  ann.send({ t: 'words', list: TWELVE, ready: true });
  bob.send({ t: 'words', list: ['kite', 'drum', 'Kite'], ready: false });
  await ann.state((s) => playersOf(s).find((p) => p.name === 'Bob')?.written === 3);
  await fire(code, 'phase');   // time's up for writing: Bob's list is filled in
  const first = await ann.state((s) => s.status === 'draw');
  // Where each log stood when drawing began: earlier messages (Ann's own draft while writing) don't count
  const drawFrom = logs.map((l) => l.length);
  return { code, clients, ids, logs, ann, bob, first, drawFrom };
}

describe('Alzheimer’s', () => {
  it('needs exactly 2 players', async () => {
    const { clients } = await room('alzheimers', ['Ann']);
    clients[0].send({ t: 'begin' });
    expect(String((await clients[0].next((m) => m.t === 'toast')).text)).toContain('2 players');
  });

  it('only a full list of 12 different things can be ready', async () => {
    const { clients } = await room('alzheimers', ['Ann', 'Bob']);
    const [ann] = clients;
    ann.send({ t: 'begin' });
    await ann.state((s) => s.status === 'write');
    ann.send({ t: 'words', list: TWELVE.slice(0, 11), ready: true });
    expect((await ann.next((m) => m.t === 'nope')).reason).toBe('Write 12 things');
    ann.send({ t: 'words', list: [...TWELVE.slice(0, 11), 'CAT'], ready: true });
    expect((await ann.next((m) => m.t === 'nope')).reason).toBe('Each thing only once');
    ann.send({ t: 'words', list: TWELVE, ready: true });
    const s = await ann.state((v) => playersOf(v).find((p) => p.name === 'Ann')?.ready === true);
    expect(s.myWords).toEqual(TWELVE);
  });

  it('flashes each word only to the player drawing it, only while it is on screen', async () => {
    const { code, ann, bob, logs, first, drawFrom } = await toDrawing();
    const words = await inRoom(code, (r) => Object.fromEntries(r.players.map((p) => [p.name, p.words])));
    // Bob's three typed words, the repeat dropped, then filled up to 12
    expect(words.Bob).toHaveLength(12);
    expect(words.Bob.slice(0, 2)).toEqual(['kite', 'drum']);
    expect(new Set(words.Bob.map(E.wordKey)).size).toBe(12);
    // Nothing during the 3-2-1
    expect(first.word).toBeNull();
    expect(first.drawStartsIn as number).toBeGreaterThan(2000);
    // The first word's moment: Ann gets Bob's first word, Bob gets Ann's
    await inRoom(code, (r) => { r.drawStart = Date.now() - 100; });
    await fire(code, 'word');
    expect((await ann.state((s) => s.word !== null)).word).toBe('kite');
    expect((await bob.state((s) => s.word !== null)).word).toBe('cat');
    // Ann never received any of Bob's later words while drawing (skipping any that are also on her own list:
    // Bob's blanks were filled at random and may repeat one of hers)
    const sinceDraw = logs[0].slice(drawFrom[0]);
    for (const w of words.Bob.slice(1).filter((x) => !TWELVE.includes(x))) expect(sinceDraw.some((l) => l.includes(`"${w}"`))).toBe(false);
    // After the flash the word is gone from the view
    await inRoom(code, (r) => { r.drawStart = Date.now() - 1200; });
    ann.send({ t: 'undo' });
    bob.send({ t: 'words', list: [], ready: false });   // anything that makes the room send a fresh view
    await fire(code, 'word');
    expect((await ann.state((s) => s.index === 0 && s.word === null)).word).toBeNull();
  });

  it('keeps each stroke inside its own box and ignores ink for a box that does not exist', async () => {
    const { code, ann } = await toDrawing();
    await inRoom(code, (r) => { r.drawStart = Date.now() - 100; });
    ann.send({ t: 'stroke', b: 5, pts: [0, 0, 999, 999, 250, 260] });   // box 5: x 200..400, y 200..400
    ann.send({ t: 'stroke', b: 12, pts: [10, 10, 20, 20] });
    ann.send({ t: 'stroke', b: 2, pts: 'nonsense' });
    await new Promise((ok) => setTimeout(ok, 100));
    const strokes = await inRoom(code, (r) => r.players.find((p) => p.name === 'Ann')!.strokes);
    expect(strokes).toEqual([{ b: 5, pts: [202, 202, 398, 398, 250, 260] }]);
    ann.send({ t: 'undo' });
    await new Promise((ok) => setTimeout(ok, 100));
    expect(await inRoom(code, (r) => r.players.find((p) => p.name === 'Ann')!.strokes.length)).toBe(0);
  });

  it('lights up each box for its player to name, never sends the word first, scores leniently and shows both drawings', async () => {
    const { code, ann, bob, clients, logs } = await toDrawing();
    await inRoom(code, (r) => { r.drawStart = Date.now() - 100; });
    ann.send({ t: 'stroke', b: 0, pts: [20, 20, 80, 80] });
    await new Promise((ok) => setTimeout(ok, 100));
    await fire(code, 'phase');
    const words = await inRoom(code, (r) => Object.fromEntries(r.players.map((p) => [p.name, p.words])));
    const fromTest = logs[0].length;
    // Ann names every box, in capitals with an s on the end: still right. Bob types nonsense or skips.
    for (let q = 0; q < E.BOXES; q++) {
      const s = await ann.state((v) => v.status === 'test' && (v.question as { q: number } | null)?.q === q);
      const box = (s.question as { box: number }).box;
      expect(s.question).toEqual({ q, box });   // the box only, not its word
      // Nothing Ann has been sent in the test so far names the box she's asked about
      expect(logs[0].slice(fromTest).some((l) => l.includes(`"${words.Bob[box]}"`))).toBe(false);
      ann.send({ t: 'name', q, text: `${words.Bob[box].toUpperCase()}s` });
      const r = await ann.next((m) => m.t === 'named' && m.q === q);
      expect(r).toMatchObject({ right: true, box, word: words.Bob[box] });
    }
    // An answer for the wrong question is ignored
    bob.send({ t: 'name', q: 3, text: 'cat' });
    for (let q = 0; q < E.BOXES; q++) {
      await bob.state((v) => (v.question as { q: number } | null)?.q === q);
      bob.send({ t: 'name', q, text: q % 2 ? 'qqqq zzzz' : '' });
      expect((await bob.next((m) => m.t === 'named' && m.q === q)).right).toBe(false);
    }
    const end: Msg = await ann.state((v) => v.status === 'result');
    const pl = playersOf(end);
    expect(pl.find((p) => p.name === 'Ann')!.points).toBe(12);
    expect(pl.find((p) => p.name === 'Bob')!.points).toBe(0);
    expect(end.winner).toBe(pl.find((p) => p.name === 'Ann')!.id);
    expect(pl.find((p) => p.name === 'Ann')!.score).toBe(1);
    expect((end.myAnswers as Array<{ right: boolean }>).every((a) => a.right)).toBe(true);
    const boards = await clients[1].next((m) => m.t === 'drawings');
    const annBoard = (boards.boards as Array<{ id: string; strokes: unknown[]; words: string[] }>).find((b) => b.id === pl.find((p) => p.name === 'Ann')!.id)!;
    expect(annBoard.words).toEqual(words.Bob);
    expect(annBoard.strokes).toHaveLength(1);
  });

  it('naming one of your other words for a box does not count', async () => {
    const { code, bob } = await toDrawing();
    await fire(code, 'phase');
    // Bob draws Ann's words: cat, tree, house, boat, apple, sun, car, fish, hat, chair, moon, shoe
    const s = await bob.state((v) => v.status === 'test');
    const box = (s.question as { box: number }).box;
    const wrongButClose = TWELVE[(box + 1) % 12];
    bob.send({ t: 'name', q: 0, text: wrongButClose });
    expect((await bob.next((m) => m.t === 'named')).right).toBe(false);
  });
});
