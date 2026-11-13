import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import ANIMALS_TEXT from '../../web/forehead/words/animals.txt';
import FAMOUS_TEXT from '../../web/forehead/words/famous.txt';
import * as E from '../../web/forehead/js/engine.js';
import { GAMES } from '../src/games';
import { mergePlayer, playerStats, writeStats } from '../src/db/stats';
import { sleep, TestClient, type Msg } from './helpers';

// Rooms drop a connection that sends more than ~8 messages a second for long, so helpers that play whole
// turns pace themselves a little (waiting for the view is still what decides when a step is done).
vi.setConfig({ testTimeout: 40000 });
const pace = () => sleep(80);

const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(`forehead:${code}`));
const famous = E.makeDeck('famous', FAMOUS_TEXT);
const animals = E.makeDeck('animals', ANIMALS_TEXT);
const numbers = E.makeDeck('numbers');

/* ---------- A tiny harness: players that keep every raw message, and "wait for the view I expect" ---------- */

interface P {
  name: string;
  c: TestClient;
  /** Every raw message this socket received, as sent by the server. */
  raw: string[];
  id: string;
}
interface Game {
  code: string;
  p: P[];
}
interface PView {
  status: string;
  phase: string;
  asker: string | null;
  game: number;
  endsIn: number;
  roundEndsIn: number;
  note: string;
  answered: number;
  need: number;
  myAnswer: string | null;
  tally: Record<string, number> | null;
  top: string[];
  question: { n: number; q: string | null } | null;
  first: string | null;
  public: boolean;
  settings: { deck: string; minutes: number };
  log: Array<{ n: number; pid: string; q: string | null; tally: Record<string, number> | null; top: string[]; outcome: string | null; guess: string | null }>;
  players: Array<{
    id: string; name: string; isHost: boolean; connected: boolean; away: boolean; inGame: boolean; score: number;
    done: string | null; asked: number; pts: number; hasCard: boolean; card: string | null;
  }>;
}

async function seat(code: string | null, name: string): Promise<P> {
  const c = await TestClient.open(code ? `/forehead/ws?code=${code}` : '/forehead/ws?create=1');
  const raw: string[] = [];
  c.ws.addEventListener('message', (e) => { raw.push(String(e.data)); });
  c.join(name);
  const w = await c.next((m) => m.t === 'welcome');
  return { name, c, raw, id: w.id as string };
}

const latest = (p: P): PView | undefined => {
  for (let i = p.c.msgs.length - 1; i >= 0; i--) if (p.c.msgs[i].t === 'state') return p.c.msgs[i] as unknown as PView;
  return undefined;
};

/** Wait until this player's latest view satisfies pred (polls the view, never sleeps a fixed time). */
async function waitFor(p: P, pred: (v: PView) => boolean, label = 'view', ms = 4000): Promise<PView> {
  const end = Date.now() + ms;
  for (;;) {
    const v = latest(p);
    if (v && pred(v)) return v;
    if (Date.now() > end) throw new Error(`${p.name}: timed out waiting for ${label}; have ${JSON.stringify(v && { status: v.status, phase: v.phase, asker: v.asker })}`);
    await sleep(5);
  }
}
const all = (g: Game, pred: (v: PView) => boolean, label?: string) => Promise.all(g.p.map((p) => waitFor(p, pred, label)));

async function newGame(names: string[], settings: Record<string, unknown> = { deck: 'famous', minutes: 0 }): Promise<Game> {
  const host = await seat(null, names[0]);
  const code = (await host.c.state()).code as string;
  const p = [host];
  for (const n of names.slice(1)) p.push(await seat(code, n));
  await waitFor(host, (v) => v.players.length === names.length, 'everyone seated');
  host.c.send({ t: 'begin', settings });
  const g = { code, p };
  await all(g, (v) => v.status === 'play' && v.asker !== null, 'round started');
  return g;
}

const asker = (g: Game): P => {
  const id = latest(g.p[0])!.asker;
  const found = g.p.find((x) => x.id === id);
  if (!found) throw new Error('no asker');
  return found;
};
/** What the others see on this player's forehead. */
const cardOf = (g: Game, p: P): string => {
  const other = g.p.find((x) => x !== p)!;
  return latest(other)!.players.find((x) => x.id === p.id)!.card as string;
};

async function ask(g: Game, text = 'Is it someone who is alive?'): Promise<P> {
  await pace();
  const a = asker(g);
  a.c.send({ t: 'ask', q: text });
  await all(g, (v) => v.phase === 'answer', 'answer phase');
  return a;
}
async function answerAll(g: Game, key: string): Promise<void> {
  await pace();
  const a = asker(g);
  for (const p of g.p) if (p !== a) p.c.send({ t: 'answer', a: key });
  await all(g, (v) => v.phase === 'decide', 'decide phase');
}
/** The asker passes; resolves when the next turn has begun. */
async function pass(g: Game): Promise<void> {
  await pace();
  const a = asker(g);
  const before = latest(a)!;
  a.c.send({ t: 'pass' });
  await all(g, (v) => v.phase === 'ask' && v.asker !== before.asker || v.status === 'result', 'next turn');
}
async function wrong(g: Game, text = 'Nobody Nowhere'): Promise<void> {
  await pace();
  const a = asker(g);
  const before = latest(a)!;
  a.c.send({ t: 'guess', text });
  await all(g, (v) => (v.phase === 'ask' && v.asker !== before.asker) || v.status === 'result', 'next turn');
}
async function fire(code: string, timer: string): Promise<void> {
  await runInDurableObject(stub(code), (i) => { (i as unknown as { timers: Record<string, number> }).timers[timer] = Date.now(); });
  await runDurableObjectAlarm(stub(code));
}
async function goAway(code: string, id: string): Promise<void> {
  await runInDurableObject(stub(code), (i) => {
    const o = i as unknown as { lastMsg: Map<string, number>; timers: Record<string, number> };
    o.lastMsg.set(id, Date.now() - 60000);
    o.timers.presence = Date.now();
  });
  await runDurableObjectAlarm(stub(code));
}
type RoomPeek = { cards: Record<string, number>; used: number[]; order: string[]; players: Array<{ id: string; guest: string | null; uid: string | null }> };
const peek = <T>(code: string, fn: (r: RoomPeek) => T): Promise<T> =>
  runInDurableObject(stub(code), (i) => fn((i as unknown as { game: { room: RoomPeek } }).game.room));
const closeAll = (g: Game) => g.p.forEach((p) => p.c.close());

/** Every string (keys and values) in a raw JSON message. */
function strings(raw: string): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (typeof x === 'string') out.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.push(k); walk(v); }
  };
  try { walk(JSON.parse(raw)); } catch { out.push(raw); }
  return out;
}
/** Does any of these raw messages carry this card (its name, or any of its aliases)? */
function leaks(raw: string[], entry: { name: string; aliases: string[]; toks: string[] }): string | null {
  for (const r of raw) {
    const low = r.toLowerCase();
    if (low.includes(entry.name.toLowerCase())) return r;
    for (const s of strings(r)) if (E.mentionsCard(E.tokens(s), entry)) return r;
  }
  return null;
}
const entryOf = (name: string) => famous.entries.find((e: { name: string }) => e.name === name)!;

describe('forehead: secrecy', () => {
  it('nobody ever receives their own card before it is revealed, the host and a refreshed player included', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia', 'Quinn']);
    const cards = g.p.map((p) => entryOf(cardOf(g, p)));
    const scan = (p: P, i: number, label: string) => expect(leaks(p.raw, cards[i]), `${p.name} (${cards[i].name}) ${label}`).toBeNull();

    // a few full turns: wrong guesses and passes
    await ask(g); await answerAll(g, 'yes'); await wrong(g);
    await ask(g, 'Is it a woman?'); await answerAll(g, 'no'); await pass(g);
    await ask(g, 'Did this person ever play a sport?'); await answerAll(g, 'sort'); await wrong(g, 'Somebody Else');
    await ask(g, 'Are they famous in Asia?'); await answerAll(g, 'dunno'); await pass(g);
    g.p.forEach((p, i) => scan(p, i, 'after four turns'));
    // the others' cards ARE visible to a player (the secrecy is only about their own)
    for (const p of g.p) {
      const v = latest(p)!;
      for (const x of v.players) expect(x.card === null, `${p.name} sees ${x.name}`).toBe(x.id === p.id);
    }

    // a player refreshes: the same seat on a new socket; their whole stream is clean too
    const old = g.p[2];
    const again = await seat(g.code, old.name);
    expect(again.id).not.toBe(old.id);
    g.p[2] = again;
    await waitFor(again, (v) => v.status === 'play' && v.players.length === 4, 'rejoined view');
    scan(again, 2, 'after a rejoin');
    scan(old, 2, 'on the old socket');
    expect(latest(again)!.players.find((x) => x.name === 'Pia')!.hasCard).toBe(true);
    expect(latest(again)!.players.find((x) => x.name === 'Pia')!.card).toBeNull();

    // one player guesses right and sees their card; the others stay hidden until the round ends
    const winner = asker(g);
    const wi = g.p.indexOf(winner);
    const before = g.p.map((p) => p.raw.length);
    await ask(g, 'Is it a singer?'); await answerAll(g, 'no');
    winner.c.send({ t: 'guess', text: cards[wi].name });
    await all(g, (v) => v.players.find((x) => x.id === winner.id)!.done === 'guessed', 'a right guess');
    expect(latest(winner)!.players.find((x) => x.id === winner.id)!.card).toBe(cards[wi].name);
    g.p.forEach((p, i) => { if (i !== wi) scan(p, i, 'after someone else guessed'); });
    // before the guess, the guesser's stream was clean as well
    expect(leaks(winner.raw.slice(0, before[wi]), cards[wi])).toBeNull();

    // a player gives up: their card comes to them, nobody else's does
    const quitter = g.p.find((p, i) => i !== wi && latest(p)!.players.find((x) => x.id === p.id)!.done === null)!;
    const qi = g.p.indexOf(quitter);
    quitter.c.send({ t: 'giveup' });
    await all(g, (v) => v.players.find((x) => x.id === quitter.id)!.done === 'gaveup', 'a give-up');
    expect(latest(quitter)!.players.find((x) => x.id === quitter.id)!.card).toBe(cards[qi].name);
    g.p.forEach((p, i) => { if (i !== wi && i !== qi) scan(p, i, 'after a give-up'); });

    // the end of the round shows everyone everything
    g.p[0].c.send({ t: 'endround' });
    await all(g, (v) => v.status === 'result', 'result');
    for (const v of g.p.map((p) => latest(p)!)) for (const x of v.players) expect(x.card).not.toBeNull();
    closeAll(g);
  });

  it('text that names a player\'s card is hidden from that player only (questions and wrong guesses)', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia']);
    const a = asker(g);
    const victim = g.p.find((p) => p !== a)!;
    const bystander = g.p.find((p) => p !== a && p !== victim)!;
    const secret = cardOf(g, victim);
    // the asker can see the victim's card and (carelessly) types it into a question
    await ask(g, `Am I the same as ${secret}?`);
    const seenByVictim = latest(victim)!;
    expect(seenByVictim.question!.q).toBeNull();
    expect(latest(bystander)!.question!.q).toBe(`Am I the same as ${secret}?`);
    expect(latest(a)!.question!.q).toBe(`Am I the same as ${secret}?`);
    await answerAll(g, 'no');
    // ...and then guesses it, which can never be right (cards are unique) but would be shown as "Not it: <card>"
    await wrong(g, secret);
    const v = latest(victim)!;
    expect(v.log[0].q).toBeNull();
    expect(v.log[0].guess).toBeNull();
    expect(v.log[0].outcome).toBe('wrong');
    const b = latest(bystander)!;
    expect(b.log[0].q).toContain(secret);
    expect(b.log[0].guess).toBe(secret);
    expect(leaks(victim.raw, entryOf(secret))).toBeNull();
    // an ordinary question is shown to everyone, the victim included
    await ask(g, 'Is it a woman?');
    expect(latest(victim)!.question!.q).toBe('Is it a woman?');
    closeAll(g);
  });

  it('a spectator who joins mid-round sees every card; a player\'s own card is null even in their rejoin welcome', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia']);
    const spec = await seat(g.code, 'Watcher');
    const v = await waitFor(spec, (x) => x.status === 'play' && x.players.length === 4, 'spectator view');
    expect(v.players.filter((x) => x.inGame)).toHaveLength(3);
    for (const x of v.players.filter((y) => y.inGame)) expect(x.card).toBeTruthy();
    expect(v.players.find((x) => x.name === 'Watcher')!.inGame).toBe(false);
    expect(v.players.find((x) => x.name === 'Watcher')!.hasCard).toBe(false);
    g.p.push(spec);
    closeAll(g);
  });
});

describe('forehead: dealing', () => {
  it('deals every player a different card, never repeating within the room, across rounds', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia', 'Quinn', 'Rex']);
    const seen = new Set<string>();
    for (let round = 0; round < 4; round++) {
      const names = g.p.map((p) => cardOf(g, p));
      expect(new Set(names).size).toBe(5);
      for (const n of names) {
        expect(seen.has(n), `${n} was dealt again in round ${round + 1}`).toBe(false);
        seen.add(n);
      }
      const idx = await peek(g.code, (r) => Object.values(r.cards));
      expect(new Set(idx).size).toBe(5);
      g.p[0].c.send({ t: 'endround' });
      await all(g, (v) => v.status === 'result', 'result');
      g.p[0].c.send({ t: 'begin' });
      await all(g, (v) => v.status === 'play' && v.game === round + 2, 'next round');
    }
    closeAll(g);
  });

  it('starts a new pass when the deck is used up, with no repeat inside one deal', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia']);
    // pretend the room has dealt all but two cards of the deck
    await runInDurableObject(stub(g.code), (i) => {
      const room = (i as unknown as { game: { room: RoomPeek } }).game.room;
      room.used = [...Array(famous.entries.length).keys()].slice(2);
    });
    g.p[0].c.send({ t: 'endround' });
    await all(g, (v) => v.status === 'result', 'result');
    g.p[0].c.send({ t: 'begin' });
    await all(g, (v) => v.status === 'play' && v.game === 2, 'round 2');
    const idx = await peek(g.code, (r) => Object.values(r.cards));
    expect(new Set(idx).size).toBe(3);
    expect(idx).toContain(0);
    expect(idx).toContain(1);
    closeAll(g);
  });
});

describe('forehead: turns', () => {
  it('goes round in seat order: ask, answer, tally, then pass; each step only from the right player', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia']);
    const order = await peek(g.code, (r) => r.order);
    const idOf = (p: P) => p.id;
    expect(latest(g.p[0])!.asker).toBe(order[0]);
    expect(latest(g.p[0])!.phase).toBe('ask');
    const first = asker(g);
    const others = g.p.filter((p) => p !== first);
    expect(latest(first)!.endsIn).toBeGreaterThan(44000);
    expect(latest(first)!.endsIn).toBeLessThanOrEqual(45000);

    // not the asker: ignored
    others[0].c.send({ t: 'ask', q: 'Can I ask?' });
    // the asker: empty and non-text questions are refused with a hint, nothing starts
    first.c.send({ t: 'ask', q: '   ' });
    first.c.send({ t: 'ask', q: 12345 });
    await first.c.next((m) => m.t === 'nope');
    expect(latest(first)!.phase).toBe('ask');
    // pass / guess / answer before there is a question: ignored
    first.c.send({ t: 'pass' });
    first.c.send({ t: 'guess', text: 'x' });
    others[0].c.send({ t: 'answer', a: 'yes' });
    expect(latest(first)!.phase).toBe('ask');

    // a long question with markup is cleaned and cut at 100 characters
    first.c.send({ t: 'ask', q: `<b>Is it</b> ${'very '.repeat(40)}big?` });
    const v = await waitFor(others[0], (x) => x.phase === 'answer', 'answer phase');
    expect(v.question!.q!.length).toBeLessThanOrEqual(100);
    expect(v.question!.q).not.toMatch(/[<>]/);
    expect(v.endsIn).toBeGreaterThan(19000);
    expect(v.endsIn).toBeLessThanOrEqual(20000);
    expect(v.need).toBe(2);
    expect(v.answered).toBe(0);

    // the asker can't answer their own question; nobody can send an answer that isn't on the menu
    first.c.send({ t: 'answer', a: 'yes' });
    others[0].c.send({ t: 'answer', a: 'higher' });
    others[0].c.send({ t: 'answer', a: 'constructor' });
    others[0].c.send({ t: 'answer', a: { yes: 1 } });
    others[0].c.send({ t: 'answer', a: 'yes' });
    const mid = await waitFor(first, (x) => x.answered === 1, 'one answer');
    expect(mid.phase).toBe('answer');
    expect(mid.tally).toBeNull();                                    // the tally stays hidden until the question closes
    expect(latest(others[0])!.myAnswer).toBe('yes');
    expect(latest(others[1])!.myAnswer).toBeNull();
    // an answer can be changed until the question closes
    others[0].c.send({ t: 'answer', a: 'no' });
    await waitFor(others[0], (x) => x.myAnswer === 'no', 'changed answer');
    others[1].c.send({ t: 'answer', a: 'no' });
    const decide = await waitFor(first, (x) => x.phase === 'decide', 'decide');
    expect(decide.tally).toEqual({ yes: 0, no: 2, sort: 0, dunno: 0 });
    expect(decide.top).toEqual(['no']);
    // everyone sees the same tally, and nobody receives who said what
    for (const p of g.p) {
      const w = await waitFor(p, (x) => x.phase === 'decide', 'decide for all');
      expect(w.tally).toEqual(decide.tally);
      expect(Object.keys(w)).not.toContain('answers');
      expect(JSON.stringify(w)).not.toContain(others[0].id + '":"');
    }
    expect(decide.endsIn).toBeGreaterThan(29000);
    expect(decide.log[0]).toMatchObject({ pid: idOf(first), tally: { no: 2 }, top: ['no'] });

    // an empty guess is refused with a hint and the asker keeps their turn
    first.c.msgs = first.c.msgs.filter((m) => m.t !== 'nope');
    first.c.send({ t: 'guess', text: '   ' });
    await first.c.next((m) => m.t === 'nope');
    expect(latest(first)!.phase).toBe('decide');
    // only the asker passes
    others[0].c.send({ t: 'pass' });
    first.c.send({ t: 'pass' });
    const next = await waitFor(first, (x) => x.phase === 'ask' && x.asker !== first.id, 'next asker');
    expect(next.asker).toBe(order[1]);
    expect(next.players.find((x) => x.id === first.id)!.asked).toBe(1);
    // a full circle brings the first player back
    await ask(g); await answerAll(g, 'yes'); await pass(g);
    await ask(g); await answerAll(g, 'yes'); await pass(g);
    expect(latest(g.p[0])!.asker).toBe(order[0]);
    expect(latest(g.p[0])!.log).toHaveLength(3);
    closeAll(g);
  });

  it('a tie highlights both answers; an empty tally highlights nothing', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia', 'Quinn']);
    const a = await ask(g);
    const others = g.p.filter((p) => p !== a);
    others[0].c.send({ t: 'answer', a: 'yes' });
    others[1].c.send({ t: 'answer', a: 'yes' });
    others[2].c.send({ t: 'answer', a: 'no' });
    const v = await waitFor(a, (x) => x.phase === 'decide', 'decide');
    expect(v.tally).toEqual({ yes: 2, no: 1, sort: 0, dunno: 0 });
    expect(v.top).toEqual(['yes']);
    await pass(g);
    const b = await ask(g);
    const rest = g.p.filter((p) => p !== b);
    rest[0].c.send({ t: 'answer', a: 'yes' });
    rest[1].c.send({ t: 'answer', a: 'no' });
    rest[2].c.send({ t: 'answer', a: 'sort' });
    const t = await waitFor(b, (x) => x.phase === 'decide', 'decide 2');
    expect(t.top).toEqual(['yes', 'no', 'sort']);
    closeAll(g);
  });

  it('the Numbers deck answers Yes / No / Higher / Lower, and guesses must be exact', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia'], { deck: 'numbers', minutes: 0 });
    const a = asker(g);
    const others = g.p.filter((p) => p !== a);
    expect(latest(a)!.settings.deck).toBe('numbers');
    a.c.send({ t: 'ask', q: 'Is it 50?' });
    await all(g, (v) => v.phase === 'answer', 'answer');
    others[0].c.send({ t: 'answer', a: 'sort' });      // not on the Numbers menu
    others[0].c.send({ t: 'answer', a: 'dunno' });
    others[0].c.send({ t: 'answer', a: 'higher' });             // the first valid one: the two above were ignored
    await waitFor(a, (x) => x.answered === 1 && x.myAnswer === null, 'one valid answer');
    expect(latest(others[0])!.myAnswer).toBe('higher');
    others[1].c.send({ t: 'answer', a: 'higher' });
    const v = await waitFor(a, (x) => x.phase === 'decide', 'decide');
    expect(v.tally).toEqual({ yes: 0, no: 0, higher: 2, lower: 0 });
    expect(v.top).toEqual(['higher']);
    // the real number: one off is wrong, the number in words is right
    const real = Number(cardOf(g, a));
    expect(real).toBeGreaterThanOrEqual(1);
    expect(real).toBeLessThanOrEqual(100);
    const off = real === 100 ? 99 : real + 1;
    a.c.send({ t: 'guess', text: String(off) });
    await all(g, (x) => x.phase === 'ask' && x.asker !== a.id, 'wrong number');
    expect(latest(a)!.players.find((x) => x.id === a.id)!.done).toBeNull();
    // cycle back to a: ask, answer, guess it in words
    for (let i = 0; i < 2; i++) { await ask(g); await answerAll(g, 'yes'); await pass(g); }
    expect(asker(g)).toBe(a);
    await ask(g); await answerAll(g, 'lower');
    a.c.send({ t: 'guess', text: E.numberWords(real) });
    await all(g, (x) => x.players.find((y) => y.id === a.id)!.done === 'guessed', 'right number');
    closeAll(g);
  });
});

describe('forehead: timers', () => {
  it('the answer timer closes the question with whatever was answered', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia', 'Quinn']);
    const a = await ask(g);
    const others = g.p.filter((p) => p !== a);
    others[0].c.send({ t: 'answer', a: 'sort' });
    await waitFor(a, (x) => x.answered === 1, 'one answer in');
    expect(latest(a)!.phase).toBe('answer');
    await fire(g.code, 'turn');
    const v = await waitFor(a, (x) => x.phase === 'decide', 'decide after the timer');
    expect(v.tally).toEqual({ yes: 0, no: 0, sort: 1, dunno: 0 });
    expect(v.top).toEqual(['sort']);
    expect(v.endsIn).toBeGreaterThan(29000);
    // a late answer is ignored
    others[1].c.send({ t: 'answer', a: 'yes' });
    await sleep(30);
    expect(latest(a)!.tally).toEqual({ yes: 0, no: 0, sort: 1, dunno: 0 });
    closeAll(g);
  });

  it('nobody answers: the question closes with an empty tally and highlights nothing', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia']);
    const a = await ask(g);
    await fire(g.code, 'turn');
    const v = await waitFor(a, (x) => x.phase === 'decide', 'decide');
    expect(v.tally).toEqual({ yes: 0, no: 0, sort: 0, dunno: 0 });
    expect(v.top).toEqual([]);
    closeAll(g);
  });

  it('skips a turn when the asker takes too long, without counting a question', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia']);
    const order = await peek(g.code, (r) => r.order);
    const slow = asker(g);
    await fire(g.code, 'turn');
    const v = await waitFor(g.p[0], (x) => x.asker !== null && x.asker !== slow.id, 'next asker');
    expect(v.asker).toBe(order[1]);
    expect(v.phase).toBe('ask');
    expect(v.note).toContain(`${slow.name} ran out of time`);
    expect(v.players.find((x) => x.id === slow.id)!.asked).toBe(0);
    expect(v.log).toHaveLength(0);
    expect(v.endsIn).toBeGreaterThan(44000);
    // the note goes away once someone asks
    await ask(g);
    expect(latest(g.p[0])!.note).toBe('');
    closeAll(g);
  });

  it('passes for an asker who does not guess or pass in time', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia']);
    const a = await ask(g);
    await answerAll(g, 'yes');
    await fire(g.code, 'turn');
    const v = await waitFor(g.p[0], (x) => x.phase === 'ask' && x.asker !== a.id, 'next asker');
    expect(v.log[0].outcome).toBe('pass');
    expect(v.players.find((x) => x.id === a.id)!.done).toBeNull();
    closeAll(g);
  });

  it('the round timer ends the round (with a question still open); no timer means none', async () => {
    const off = await newGame(['Hana', 'Zed'], { deck: 'animals', minutes: 0 });
    expect(latest(off.p[0])!.roundEndsIn).toBe(0);
    closeAll(off);

    const g = await newGame(['Hana', 'Zed', 'Pia'], { deck: 'animals', minutes: 5 });
    expect(latest(g.p[0])!.roundEndsIn).toBeGreaterThan(299000);
    const a = await ask(g);
    g.p.find((p) => p !== a)!.c.send({ t: 'answer', a: 'yes' });
    await fire(g.code, 'round');
    const v = await waitFor(g.p[0], (x) => x.status === 'result', 'result');
    expect(v.log[0].tally).toMatchObject({ yes: 1 });
    expect(v.log[0].outcome).toBe('ended');
    expect(v.roundEndsIn).toBe(0);
    expect(v.endsIn).toBe(0);
    for (const x of v.players) expect(x.card).toBeTruthy();
    closeAll(g);
  });
});

describe('forehead: away and left players', () => {
  it('skips an Away player when their turn comes, and never waits for them to answer', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia', 'Quinn']);
    const order = await peek(g.code, (r) => r.order);
    const second = g.p.find((p) => p.id === order[1])!;
    await goAway(g.code, second.id);
    await waitFor(g.p[0], (v) => v.players.find((x) => x.id === second.id)!.away, 'away flag');
    const a = await ask(g);                                       // the first player asks; the away player is not expected to answer
    expect(latest(a)!.need).toBe(2);
    for (const p of g.p) if (p !== a && p !== second) p.c.send({ t: 'answer', a: 'yes' });
    await waitFor(a, (v) => v.phase === 'decide', 'decide without the away player');
    a.c.send({ t: 'pass' });
    const v = await waitFor(g.p[0], (x) => x.phase === 'ask' && x.asker !== a.id, 'next asker');
    expect(v.asker).toBe(order[2]);                               // skipped order[1]
    expect(v.players.find((x) => x.id === second.id)!.asked).toBe(0);
    closeAll(g);
  });

  it('skips the asker at once if they go Away or leave during their turn', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia', 'Quinn']);
    const order = await peek(g.code, (r) => r.order);
    await goAway(g.code, order[0]);
    const v = await waitFor(g.p[1], (x) => x.asker !== null && x.asker !== order[0], 'asker skipped');
    expect(v.asker).toBe(order[1]);
    // the next asker's socket closes: skipped too
    const leaving = g.p.find((p) => p.id === order[1])!;
    leaving.c.close();
    const w = await waitFor(g.p.find((p) => p.id === order[2])!, (x) => x.asker !== null && x.asker !== order[1], 'left asker skipped');
    expect(w.asker).toBe(order[2]);
    expect(w.players.find((x) => x.id === order[1])!.connected).toBe(false);
    closeAll(g);
  });

  it('an Away asker during the answers is skipped as soon as the question closes', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia']);
    const a = await ask(g);
    await goAway(g.code, a.id);
    const others = g.p.filter((p) => p !== a);
    for (const p of others) p.c.send({ t: 'answer', a: 'no' });
    const v = await waitFor(others[0], (x) => x.phase === 'ask' && x.asker !== a.id, 'moved on');
    expect(v.log[0].tally).toMatchObject({ no: 2 });
    expect(v.log[0].outcome).toBe('skip');
    closeAll(g);
  });

  it('waits (without a timer) when every player still guessing is away, and carries on when one comes back', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia']);
    const [h, z, p3] = g.p;
    // Hana and Zed finish; Pia (the only one left) goes away
    h.c.send({ t: 'giveup' });
    z.c.send({ t: 'giveup' });
    await all(g, (v) => v.players.filter((x) => x.done).length === 2, 'two given up');
    await goAway(g.code, p3.id);
    const v = await waitFor(h, (x) => x.phase === 'wait', 'waiting');
    expect(v.status).toBe('play');
    expect(v.asker).toBeNull();
    expect(v.endsIn).toBe(0);
    // Pia sends anything: she is back and gets the turn
    p3.c.send({ t: 'nope' });
    const back = await waitFor(h, (x) => x.phase === 'ask', 'asker again');
    expect(back.asker).toBe(p3.id);
    closeAll(g);
  });

  it('a player gone for a minute counts as having given up, so the round can finish', async () => {
    const g = await newGame(['Hana', 'Zed']);
    const [h, z] = g.p;
    z.c.close();
    await waitFor(h, (v) => !v.players.find((x) => x.id === z.id)!.connected, 'left');
    await runInDurableObject(stub(g.code), (i) => {
      const room = (i as unknown as { game: { room: { players: Array<{ id: string; offlineAt: number }> } } }).game.room;
      room.players.find((p) => p.id === z.id)!.offlineAt = Date.now() - 120000;
    });
    await fire(g.code, 'presence');
    const v = await waitFor(h, (x) => x.players.find((y) => y.id === z.id)!.done === 'gaveup', 'gave up for good');
    expect(v.players.find((y) => y.id === h.id)!.done).toBeNull();
    h.c.close();
  });
});

describe('forehead: guesses and scoring', () => {
  it('a right guess scores 12 minus the questions asked, plus 2 for the first; "Not it" ends the turn only', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia', 'Quinn']);
    const p1 = asker(g);
    // turn 1: p1 asks and guesses wrong
    await ask(g); await answerAll(g, 'no'); await wrong(g, 'Totally Wrong');
    let v = latest(p1)!;
    expect(v.log[0]).toMatchObject({ outcome: 'wrong', guess: 'Totally Wrong' });
    expect(v.players.find((x) => x.id === p1.id)!.done).toBeNull();
    expect(v.players.find((x) => x.id === p1.id)!.score).toBe(0);
    // turn 2: the next player guesses right on their first question: 11 + 2 = 13, shown with their card
    const second = asker(g);
    await ask(g, 'Is it a footballer?'); await answerAll(g, 'yes');
    second.c.send({ t: 'guess', text: `  ${cardOf(g, second).toUpperCase()} ` });
    v = await waitFor(g.p[0], (x) => x.players.find((y) => y.id === second.id)!.done === 'guessed', 'right guess');
    const me = v.players.find((y) => y.id === second.id)!;
    expect(me).toMatchObject({ done: 'guessed', score: 13, pts: 13, asked: 1 });
    expect(v.first).toBe(second.id);
    expect(v.log[1]).toMatchObject({ outcome: 'right', guess: cardOf(g, second) });
    // the turn moved on, and the finished player is no longer asked to ask
    const after = await waitFor(g.p[0], (x) => x.phase === 'ask' && x.asker !== second.id, 'next');
    expect(after.asker).not.toBe(second.id);
    // p1 has asked once already; they ask more questions (passing) and then guess right: 12 - 4 = 8, no bonus
    let q = 1;
    for (let i = 0; i < 40 && q < 4; i++) {
      const cur = asker(g);
      await ask(g); await answerAll(g, 'no');
      if (cur === p1) {
        q++;
        if (q === 4) break;
      }
      await pass(g);
    }
    expect(asker(g)).toBe(p1);
    expect(latest(p1)!.players.find((x) => x.id === p1.id)!.asked).toBe(4);
    p1.c.send({ t: 'guess', text: cardOf(g, p1) });
    v = await waitFor(g.p[0], (x) => x.players.find((y) => y.id === p1.id)!.done === 'guessed', 'p1 right');
    expect(v.players.find((y) => y.id === p1.id)).toMatchObject({ score: 8, pts: 8 });
    expect(v.first).toBe(second.id);
    closeAll(g);
  });

  it('accepts aliases, accents and a typo; refuses a near miss on another card and a number in a word deck', async () => {
    /** A fresh room in which the first asker's card is `cardName`; they guess `text`. True when it was accepted. */
    const tryGuess = async (cardName: string, text: string): Promise<boolean> => {
      const g = await newGame(['Hana', 'Zed'], { deck: 'animals', minutes: 0 });
      const a = asker(g);
      const idx = animals.entries.findIndex((e: { name: string }) => e.name === cardName);
      expect(idx, cardName).toBeGreaterThanOrEqual(0);
      await runInDurableObject(stub(g.code), (i) => { (i as unknown as { game: { room: RoomPeek } }).game.room.cards[a.id] = idx; });
      await ask(g, 'Is it alive?');
      await answerAll(g, 'yes');
      a.c.send({ t: 'guess', text });
      const v = await waitFor(g.p[0], (x) => x.log.length > 0 && x.log[0].outcome !== null, 'outcome');
      const right = v.log[0].outcome === 'right';
      closeAll(g);
      return right;
    };
    expect(await tryGuess('Elephant', 'ELEPHANT')).toBe(true);
    expect(await tryGuess('Elephant', 'elephent')).toBe(true);                // 8 letters: 1 edit
    expect(await tryGuess('Elephant', 'elefant')).toBe(false);                // 2 edits
    expect(await tryGuess('Chimpanzee', 'chimp')).toBe(true);                 // alias
    expect(await tryGuess('Cat', 'Kitty')).toBe(true);                        // alias
    expect(await tryGuess('Cat', 'cot')).toBe(false);                         // short words must be exact
    expect(await tryGuess('Guinea Pig', 'guinea-pig')).toBe(true);            // spaces and punctuation
    expect(await tryGuess('Moose', 'mouse')).toBe(false);                     // a different card of the deck
    expect(await tryGuess('Tiger', '42')).toBe(false);
  });

  it('give up reveals the card for 0 points, any time and from anyone', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia']);
    const a = asker(g);
    const idle = g.p.find((p) => p !== a)!;
    // not their turn: still allowed
    idle.c.send({ t: 'giveup' });
    let v = await waitFor(idle, (x) => x.players.find((y) => y.id === idle.id)!.done === 'gaveup', 'idle gave up');
    expect(v.players.find((y) => y.id === idle.id)).toMatchObject({ score: 0, pts: 0, card: cardOf(g, idle) });
    expect(latest(a)!.players.find((y) => y.id === idle.id)!.card).toBe(cardOf(g, idle));
    // a second give-up changes nothing
    idle.c.send({ t: 'giveup' });
    // the asker gives up in the middle of their own question: the turn moves on
    await ask(g);
    a.c.send({ t: 'giveup' });
    v = await waitFor(g.p[0], (x) => x.players.find((y) => y.id === a.id)!.done === 'gaveup' && x.phase === 'ask' && x.asker !== a.id, 'moved on');
    // a given-up player still answers others' questions but is never asked to ask
    const last = g.p.find((p) => p !== a && p !== idle)!;
    expect(v.asker).toBe(last.id);
    last.c.send({ t: 'ask', q: 'Is it big?' });
    const w = await waitFor(last, (x) => x.phase === 'answer', 'answering');
    expect(w.need).toBe(2);
    idle.c.send({ t: 'answer', a: 'yes' });
    a.c.send({ t: 'answer', a: 'yes' });
    await waitFor(last, (x) => x.phase === 'decide', 'decide');
    last.c.send({ t: 'pass' });
    const again = await waitFor(last, (x) => x.phase === 'ask', 'asks again');
    expect(again.asker).toBe(last.id);                           // the only one still guessing keeps the turn
    closeAll(g);
  });

  it('ends the round when everyone has guessed or given up, then keeps the scores across rounds', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia']);
    // round 1: first guesser scores 11 + 2; the other two give up
    const a = await ask(g); await answerAll(g, 'yes');
    a.c.send({ t: 'guess', text: cardOf(g, a) });
    await waitFor(g.p[0], (x) => x.players.find((y) => y.id === a.id)!.done === 'guessed', 'guessed');
    for (const p of g.p.filter((x) => x !== a)) p.c.send({ t: 'giveup' });
    const r1 = await waitFor(g.p[0], (x) => x.status === 'result', 'result');
    const mine = r1.players.find((y) => y.id === a.id)!;
    expect(mine.score).toBe(13);
    expect(r1.players.filter((y) => y.id !== a.id).every((y) => y.score === 0 && y.done === 'gaveup')).toBe(true);
    expect(r1.asker).toBeNull();
    // nothing can be asked once the round is over
    a.c.send({ t: 'ask', q: 'Still going?' });
    // round 2 starts from the result screen; scores carry over, the round's points start from zero
    g.p[0].c.send({ t: 'begin' });
    const r2 = await waitFor(g.p[0], (x) => x.status === 'play' && x.game === 2, 'round 2');
    expect(r2.players.find((y) => y.id === a.id)).toMatchObject({ score: 13, pts: 0, asked: 0, done: null });
    expect(r2.log).toHaveLength(0);
    expect(r2.first).toBeNull();
    const second = await ask(g); await answerAll(g, 'yes');
    second.c.send({ t: 'guess', text: cardOf(g, second) });
    const w = await waitFor(g.p[0], (x) => x.players.find((y) => y.id === second.id)!.done === 'guessed', 'guessed again');
    expect(w.players.find((y) => y.id === second.id)!.score).toBe(second === a ? 26 : 13);
    expect(w.players.find((y) => y.id === second.id)!.pts).toBe(13);
    closeAll(g);
  });
});

describe('forehead: settings and the lobby', () => {
  it('needs two players to start', async () => {
    const host = await seat(null, 'Hana');
    host.c.send({ t: 'begin' });
    const t = await host.c.next((m) => m.t === 'toast');
    expect(String(t.text)).toContain('2');
    host.c.close();
  });

  it('only the host can change settings, and they are cleaned on the server', async () => {
    const host = await seat(null, 'Hana');
    const code = (await host.c.state()).code as string;
    const guest = await seat(code, 'Zed');
    await waitFor(host, (v) => v.players.length === 2);
    expect(latest(host)!.settings).toEqual({ deck: 'animals', minutes: 8 });
    guest.c.send({ t: 'settings', settings: { deck: 'famous', minutes: 12 } });
    guest.c.send({ t: 'begin', settings: { deck: 'food', minutes: 5 } });
    guest.c.send({ t: 'public', on: true });
    guest.c.send({ t: 'crew', name: 'Sneaky crew' });
    // the host's own change goes in after the guest's attempts, so seeing it means the attempts were already handled
    host.c.send({ t: 'settings', settings: { deck: 'jobs', minutes: 12 } });
    const seen = await waitFor(guest, (v) => v.settings.deck === 'jobs' && v.settings.minutes === 12, 'jobs / 12');
    expect(seen.status).toBe('lobby');
    expect(seen.public).toBe(false);
    expect((latest(host) as unknown as { crewName: string }).crewName).toBe('');
    // the host's settings are cleaned
    host.c.send({ t: 'settings', settings: { deck: '../../etc', minutes: 99, extra: true } });
    await waitFor(guest, (v) => v.settings.deck === 'animals' && v.settings.minutes === 8, 'cleaned back to defaults');
    host.c.send({ t: 'settings', settings: 'nonsense' });
    host.c.send({ t: 'settings' });
    host.c.send({ t: 'settings', settings: { deck: 'numbers', minutes: 0 } });
    await waitFor(guest, (v) => v.settings.deck === 'numbers' && v.settings.minutes === 0, 'numbers / off');
    host.c.close();
    guest.c.close();
  });

  it('settings and the Quick Play toggle are frozen during a round and on the result screen', async () => {
    const g = await newGame(['Hana', 'Zed'], { deck: 'famous', minutes: 12 });
    const [h, z] = g.p;
    h.c.send({ t: 'settings', settings: { deck: 'numbers', minutes: 5 } });
    h.c.send({ t: 'public', on: true });
    h.c.send({ t: 'begin', settings: { deck: 'food', minutes: 0 } });   // a second begin mid-round does nothing
    await ask(g);                                                       // the next valid step: the three above were handled before it
    let v = latest(z)!;
    expect(v.settings).toEqual({ deck: 'famous', minutes: 12 });
    expect(v.public).toBe(false);
    expect(v.game).toBe(1);
    h.c.send({ t: 'endround' });
    await waitFor(z, (x) => x.status === 'result', 'result');
    h.c.send({ t: 'settings', settings: { deck: 'numbers', minutes: 5 } });
    h.c.send({ t: 'public', on: true });
    await sleep(40);
    v = latest(z)!;
    expect(v.settings).toEqual({ deck: 'famous', minutes: 12 });
    expect(v.public).toBe(false);
    // back in the lobby they work again, and the new deck is used for the next round
    h.c.send({ t: 'lobby' });
    await waitFor(z, (x) => x.status === 'lobby', 'lobby');
    h.c.send({ t: 'settings', settings: { deck: 'numbers', minutes: 5 } });
    await waitFor(z, (x) => x.settings.deck === 'numbers' && x.settings.minutes === 5, 'new settings');
    h.c.send({ t: 'begin' });
    const r = await waitFor(z, (x) => x.status === 'play', 'round 2');
    expect(r.game).toBe(2);
    expect(Number(latest(h)!.players.find((x) => x.id === z.id)!.card)).toBeGreaterThan(0);
    closeAll(g);
  });

  it('only the host can end a round or go back to the lobby', async () => {
    const g = await newGame(['Hana', 'Zed']);
    g.p[1].c.send({ t: 'endround' });
    await sleep(40);
    expect(latest(g.p[0])!.status).toBe('play');
    g.p[0].c.send({ t: 'endround' });
    await all(g, (v) => v.status === 'result', 'result');
    g.p[1].c.send({ t: 'begin' });
    g.p[1].c.send({ t: 'lobby' });
    await sleep(40);
    expect(latest(g.p[0])!.status).toBe('result');
    g.p[0].c.send({ t: 'lobby' });
    await all(g, (v) => v.status === 'lobby', 'lobby');
    for (const v of g.p.map((p) => latest(p)!)) for (const x of v.players) expect(x.card).toBeNull();
    closeAll(g);
  });

  it('the host can open the room to Quick Play in the lobby, and it shows up there', async () => {
    const host = await seat(null, 'Hana');
    const code = (await host.c.state()).code as string;
    const guest = await seat(code, 'Zed');
    await waitFor(host, (v) => v.players.length === 2);
    const quick = async (want: string | null) => {
      for (let i = 0; i < 40; i++) {
        const res = await SELF.fetch('https://play.test/api/forehead/quick', { method: 'POST' });
        const got = ((await res.json()) as { code?: string }).code ?? null;
        if (got === want) return got;
        await sleep(25);
      }
      return 'never';
    };
    expect(await quick(null)).toBeNull();
    host.c.send({ t: 'public', on: true });
    await waitFor(guest, (v) => v.public, 'public');
    expect(await quick(code)).toBe(code);
    host.c.send({ t: 'public', on: 'yes' });          // not a real boolean: ignored
    host.c.send({ t: 'public', on: false });
    await waitFor(guest, (v) => !v.public, 'private again');
    expect(await quick(null)).toBeNull();
    host.c.close();
    guest.c.close();
  });

  it('seats eight players and turns the ninth away; the rate limit and size cap are set', async () => {
    const host = await seat(null, 'Hana');
    const code = (await host.c.state()).code as string;
    const rest: P[] = [];
    for (let i = 1; i < 8; i++) rest.push(await seat(code, `Player${i}`));
    const ninth = await TestClient.open(`/forehead/ws?code=${code}`);
    ninth.join('Late');
    const r = await ninth.next((m) => m.t === 'reject');
    expect(String(r.reason)).toContain('full');
    expect(GAMES.forehead.maxMsgBytes).toBeLessThanOrEqual(2048);
    expect(GAMES.forehead.rate.perSec).toBeLessThanOrEqual(10);
    host.c.close();
    rest.forEach((p) => p.c.close());
  });

  it('a message over the size cap is ignored', async () => {
    const g = await newGame(['Hana', 'Zed']);
    const a = asker(g);
    a.c.send(JSON.stringify({ t: 'ask', q: 'x'.repeat(3000) }));
    await sleep(40);
    expect(latest(a)!.phase).toBe('ask');
    closeAll(g);
  });
});

describe('forehead: a refreshed player keeps their place', () => {
  it('gets the same seat, state and a hidden card back, and the host can leave mid-round', async () => {
    const g = await newGame(['Hana', 'Zed', 'Pia']);
    const a = asker(g);
    await ask(g); await answerAll(g, 'yes');
    const quitter = g.p.find((p) => p !== a)!;
    quitter.c.send({ t: 'giveup' });
    await waitFor(a, (v) => v.players.find((x) => x.id === quitter.id)!.done === 'gaveup', 'gave up');
    // the quitter refreshes
    const again = await seat(g.code, quitter.name);
    const v = await waitFor(again, (x) => x.players.length === 3 && x.status === 'play', 'rejoined');
    const mine = v.players.find((x) => x.name === quitter.name)!;
    expect(mine).toMatchObject({ done: 'gaveup', connected: true });
    expect(mine.card).toBeTruthy();                       // given up: their own card is revealed to them
    // the asker refreshes while deciding: still the asker, still in "decide" with the tally
    const idx = g.p.indexOf(a);
    const back = await seat(g.code, a.name);
    const w = await waitFor(back, (x) => x.phase === 'decide', 'asker rejoined');
    expect(w.asker).toBe(back.id);
    expect(w.tally).toMatchObject({ yes: 2 });
    expect(w.players.find((x) => x.id === back.id)!.card).toBeNull();
    back.c.send({ t: 'pass' });
    await waitFor(back, (x) => x.phase === 'ask' && x.asker !== back.id, 'moved on');
    g.p[idx] = back;
    // the host leaves: host passes on, the round goes on
    const host = g.p[0];
    host.c.close();
    const z = await waitFor(g.p.find((p) => p !== host && p !== quitter)!, (x) => x.players.some((y) => y.isHost && y.id !== host.id), 'new host');
    expect(z.status).toBe('play');
    closeAll(g);
    again.c.close();
  });
});

describe('forehead: saved stats', () => {
  it('writes games, wins, guessed, questions and the lowest fewestQ; skips rounds where nothing was asked', async () => {
    const g = await newGame(['Hana', 'Zed']);
    const keys = await peek(g.code, (r) => r.players.map((p) => `g:${p.guest}`));
    expect(keys.every((x) => x !== 'g:null')).toBe(true);
    // an empty round: ended at once, nothing is saved
    g.p[0].c.send({ t: 'endround' });
    await all(g, (v) => v.status === 'result', 'empty result');
    await sleep(80);
    expect(await playerStats(env.DB, keys[0], 'forehead')).toEqual({});
    expect(await playerStats(env.DB, keys[1], 'forehead')).toEqual({});

    const want = keys.map(() => ({ games: 0, wins: 0, guessed: 0, questions: 0, points: 0, fewestQ: Infinity }));
    const saved = async (i: number, games: number) => {
      for (let n = 0; n < 80; n++) {
        const st = await playerStats(env.DB, keys[i], 'forehead');
        if ((st.games || 0) >= games) return st;
        await sleep(25);
      }
      return playerStats(env.DB, keys[i], 'forehead');
    };
    let rounds = 0;
    /** The player who asks first guesses right on their n-th question; the other asks n-1 times and gives up. */
    const playRound = async (n: number): Promise<void> => {
      g.p[0].c.send({ t: 'begin' });
      await all(g, (v) => v.status === 'play' && v.asker !== null, 'round');
      const first = asker(g);
      const other = g.p.find((p) => p !== first)!;
      for (let q = 1; q <= n; q++) {
        await ask(g); await answerAll(g, 'no');
        if (q < n) { await pass(g); await ask(g); await answerAll(g, 'no'); await pass(g); }
      }
      expect(asker(g)).toBe(first);
      first.c.send({ t: 'guess', text: cardOf(g, first) });
      await waitFor(g.p[0], (v) => v.players.find((x) => x.id === first.id)!.done === 'guessed', 'guessed');
      other.c.send({ t: 'giveup' });
      await all(g, (v) => v.status === 'result', 'result');
      rounds++;
      const f = g.p.indexOf(first);
      const o = 1 - f;
      const pts = E.points(n, true);
      Object.assign(want[f], { games: want[f].games + 1, wins: want[f].wins + 1, guessed: want[f].guessed + 1, questions: want[f].questions + n, points: want[f].points + pts, fewestQ: Math.min(want[f].fewestQ, n) });
      Object.assign(want[o], { games: want[o].games + 1, questions: want[o].questions + (n - 1) });
      for (const i of [0, 1]) {
        const st = await saved(i, rounds);
        const w = want[i];
        // a counter that is still 0 has no row at all
        expect({ games: st.games || 0, plays: st.plays || 0, wins: st.wins || 0, guessed: st.guessed || 0, questions: st.questions || 0, points: st.points || 0 },
          `player ${i} after round ${rounds}`).toEqual({ games: w.games, plays: w.games, wins: w.wins, guessed: w.guessed, questions: w.questions, points: w.points });
        if (w.fewestQ !== Infinity) expect(st.fewestQ, `player ${i} fewestQ`).toBe(w.fewestQ);
        if (w.fewestQ === Infinity) expect(st.fewestQ).toBeUndefined();
      }
    };
    await playRound(3);     // first asker: fewestQ 3
    await playRound(4);     // the other player now asks first: fewestQ 4
    await playRound(5);     // back to the first player: a worse round must NOT raise their 3
    await playRound(2);     // the other player: 2 lowers their 4
    expect(want[0].fewestQ).not.toBe(want[1].fewestQ);
    const final = await Promise.all([saved(0, 4), saved(1, 4)]);
    expect(final.map((x) => x.fewestQ).sort()).toEqual([2, 3]);
    closeAll(g);
  });

  it('fewestQ is a MIN best-of: writing and merging an account keep the lower value', async () => {
    await writeStats(env.DB, 'g:fh-guest', 'forehead', { stats: { games: 2, guessed: 1 }, min: { fewestQ: 4 } });
    await writeStats(env.DB, 'u:fh-user', 'forehead', { stats: { games: 3, guessed: 3 }, min: { fewestQ: 6 } });
    // a worse value never replaces the best; a better one does
    await writeStats(env.DB, 'u:fh-user', 'forehead', { min: { fewestQ: 9 } });
    expect((await playerStats(env.DB, 'u:fh-user', 'forehead')).fewestQ).toBe(6);
    await writeStats(env.DB, 'u:fh-user', 'forehead', { min: { fewestQ: 5 } });
    expect((await playerStats(env.DB, 'u:fh-user', 'forehead')).fewestQ).toBe(5);
    await mergePlayer(env.DB, 'g:fh-guest', 'u:fh-user');
    expect(await playerStats(env.DB, 'u:fh-user', 'forehead')).toMatchObject({ games: 5, guessed: 4, fewestQ: 4 });
    expect(await playerStats(env.DB, 'g:fh-guest', 'forehead')).toEqual({});
    // and the other way round: the account already has the better value
    await writeStats(env.DB, 'g:fh-guest2', 'forehead', { min: { fewestQ: 8 } });
    await mergePlayer(env.DB, 'g:fh-guest2', 'u:fh-user');
    expect((await playerStats(env.DB, 'u:fh-user', 'forehead')).fewestQ).toBe(4);
  });
});

describe('forehead: the deck data', () => {
  it('card names in the Numbers deck are numbers; word decks are not empty', () => {
    expect(numbers.entries).toHaveLength(100);
    expect(animals.entries.length).toBeGreaterThan(130);
    expect(famous.entries.length).toBeGreaterThan(130);
  });
});
