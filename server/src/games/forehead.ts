// Forehead on the server. Every player has a secret card that everyone else can see; the server deals the
// cards, checks every guess and sends each player their OWN view. A player's own card is never put in any
// message to that player until it has been revealed (they guessed it, gave up, or the round is over).
import * as E from '../../../web/forehead/js/engine.js';
import ANIMALS_TEXT from '../../../web/forehead/words/animals.txt';
import FAMOUS_TEXT from '../../../web/forehead/words/famous.txt';
import FOOD_TEXT from '../../../web/forehead/words/food.txt';
import JOBS_TEXT from '../../../web/forehead/words/jobs.txt';
import OBJECTS_TEXT from '../../../web/forehead/words/objects.txt';
import type { GameModule, Msg, RoomCtx } from '../core/game';
import { type BaseRoom, reportPlayer, restoreSeats, type Seat, SeatRoom } from '../core/seats';

const GAME = 'forehead';
const MAX_LOG = 200;
/** Someone gone this long during a round is out for good: they count as having given up. */
const GONE_MS = 60000;

interface Settings {
  deck: string;
  minutes: number;
}

type Done = 'guessed' | 'gaveup' | null;
type Phase = 'ask' | 'answer' | 'tally' | 'wait';
// 'pass' and 'skip' only appear in logs saved before turns became "ask OR guess"
type Outcome = 'pass' | 'wrong' | 'right' | 'skip' | 'ended';

interface Player extends Seat {
  score: number;
  done: Done;
  /** Questions this player has asked in this round. */
  asked: number;
}

interface LogEntry {
  n: number;
  pid: string;
  q: string;
  /** The question as plain tokens, for hiding it from a player it would spoil. */
  nq: string;
  tally?: Record<string, number>;
  top?: string[];
  outcome?: Outcome;
  guess?: string;
  gtok?: string;
  /** A turn spent guessing instead of asking (no question, never counted as one). */
  guessTurn?: boolean;
}

interface Room extends BaseRoom<Player> {
  settings: Settings;
  /** Card indexes this room has dealt in the current pass through the deck (so nobody repeats). */
  used: number[];
  usedDeck: string;
  /** Player id -> index of their card in the deck. Never sent to its owner until revealed. */
  cards: Record<string, number>;
  order: string[];
  turn: number;
  phase: Phase;
  /** When the current step's timer ends (0: none). */
  deadline: number;
  /** When the round ends (0: no round timer). */
  roundEnd: number;
  answers: Record<string, string>;
  log: LogEntry[];
  seq: number;
  first: string | null;
  note: string;
  /** Points each player earned in this round. */
  delta: Record<string, number>;
}

// ---------- Decks ----------

const TEXTS: Record<string, string> = {
  animals: ANIMALS_TEXT, food: FOOD_TEXT, objects: OBJECTS_TEXT, jobs: JOBS_TEXT, famous: FAMOUS_TEXT, numbers: '',
};
type Deck = ReturnType<typeof E.makeDeck>;
const decks = new Map<string, Deck>();
function deckOf(id: string): Deck {
  let d = decks.get(id);
  if (!d) {
    d = E.makeDeck(id, TEXTS[id] ?? '');
    decks.set(id, d);
  }
  return d;
}

const cleanSettings = (raw: unknown): Settings => E.cleanSettings(raw) as Settings;

class ForeheadRoom extends SeatRoom<Player, Room> {
  protected readonly gameId = GAME;
  protected readonly maxPlayers = E.MAX_PLAYERS;
  protected perPlayerView = true;
  private rnd = () => this.ctx.random();

  protected newSeat(base: Seat): Player {
    return { ...base, score: 0, done: null, asked: 0 };
  }

  protected remap(oldId: string, newId: string): void {
    const room = this.room;
    room.order = room.order.map((x) => (x === oldId ? newId : x));
    if (oldId in room.cards) { room.cards[newId] = room.cards[oldId]; delete room.cards[oldId]; }
    if (oldId in room.answers) { room.answers[newId] = room.answers[oldId]; delete room.answers[oldId]; }
    if (oldId in room.delta) { room.delta[newId] = room.delta[oldId]; delete room.delta[oldId]; }
    if (room.first === oldId) room.first = newId;
    for (const e of room.log) if (e.pid === oldId) e.pid = newId;
  }

  // Someone left, went quiet or came back: the round never waits for them
  protected afterPresence(p: Player): void {
    const room = this.room;
    if (room.status !== 'play') return;
    if (room.phase === 'wait') return this.nextTurn();
    if (room.phase === 'answer') return void this.checkAnswers();
    // The asker went: skip their turn (a tally on show just runs out by itself)
    if (room.phase === 'ask' && room.order[room.turn] === p.id && !this.active(p)) this.endTurn();
  }

  protected offlineOutMs(): number {
    return GONE_MS;
  }

  protected goneForGood(p: Player): void {
    this.giveUp(p);
  }

  protected playerMessage(p: Player, msg: Msg): void {
    switch (msg.t) {
      case 'ask': return this.ask(p, msg.q);
      case 'answer': return this.answer(p, msg.a);
      case 'guess': return this.guess(p, msg.text);
      case 'giveup': return this.giveUp(p);
      default:
    }
  }

  protected hostMessage(_p: Player, msg: Msg): boolean {
    const room = this.room;
    switch (msg.t) {
      case 'settings':
        // Settings are the lobby's: they never change under a round that is running or being looked at
        if (room.status !== 'lobby') return true;
        room.settings = cleanSettings(msg.settings);
        this.broadcast();
        return true;
      case 'begin':
        this.startRound(msg);
        return true;
      case 'endround':
        this.finishRound();
        return true;
      case 'lobby':
        this.backToLobby();
        return true;
      default:
        return false;
    }
  }

  protected gameTimer(name: string): void {
    const room = this.room;
    if (room.status !== 'play') return;
    if (name === 'round') return this.finishRound();
    if (name !== 'turn') return;
    switch (room.phase) {
      case 'ask': {
        const asker = this.byId(room.order[room.turn]);
        room.note = `${asker ? asker.name : 'Someone'} ran out of time`;
        return this.nextTurn();
      }
      case 'answer': return void this.closeAnswers();
      case 'tally': return this.endTurn();
      default:
    }
  }

  /* ---------- A round ---------- */

  private startRound(msg: Msg): void {
    const room = this.room;
    if (room.status !== 'lobby' && room.status !== 'result') return;
    const players = room.players.filter((p) => p.connected);
    if (players.length < E.MIN_PLAYERS) {
      this.toHost({ t: 'toast', text: `You need at least ${E.MIN_PLAYERS} players` });
      return;
    }
    if (typeof msg.crew === 'string') {
      const typed = msg.crew.replace(/\s+/g, ' ').trim();
      if (typed !== (room.crew ? room.crew.name : '')) this.setCrew(typed);
    }
    if (room.status === 'lobby' && msg.settings) room.settings = cleanSettings(msg.settings);
    const deck = deckOf(room.settings.deck);
    room.players = players;
    for (const p of room.players) Object.assign(p, { inGame: true, done: null, asked: 0 });
    const ids = room.players.map((p) => p.id);
    if (room.usedDeck !== deck.id) Object.assign(room, { used: [], usedDeck: deck.id });
    const dealt = E.deal(deck.entries.length, ids.length, room.used, this.rnd);
    room.used = dealt.used;
    room.cards = Object.fromEntries(ids.map((id, i) => [id, dealt.picks[i]]));
    // The player who goes first changes every round
    const shift = room.game % ids.length;
    room.order = [...ids.slice(shift), ...ids.slice(0, shift)];
    const now = this.ctx.now();
    Object.assign(room, {
      game: room.game + 1, status: 'play', turn: -1, phase: 'wait', deadline: 0, answers: {}, log: [], seq: 0, first: null, note: '',
      delta: Object.fromEntries(ids.map((id) => [id, 0])), replayId: null,
      roundEnd: room.settings.minutes ? now + room.settings.minutes * 60000 : 0,
    });
    this.ctx.clearTimer('turn');
    if (room.roundEnd) this.ctx.setTimer('round', room.roundEnd);
    else this.ctx.clearTimer('round');
    this.ctx.track('game_started', { deck: deck.id, players: ids.length, minutes: room.settings.minutes });
    this.nextTurn();
  }

  private allDone(): boolean {
    const players = this.inGame();
    return players.length > 0 && players.every((p) => p.done);
  }

  /** The next player in seat order who is still guessing and here. Nobody here: wait for someone to come back. */
  private nextTurn(): void {
    const room = this.room;
    if (room.status !== 'play') return;
    if (this.allDone()) return this.finishRound();
    const n = room.order.length;
    for (let i = 1; i <= n; i++) {
      const idx = (room.turn + i + n) % n;
      const p = this.byId(room.order[idx]);
      if (p && p.inGame && !p.done && this.active(p)) {
        room.turn = idx;
        room.phase = 'ask';
        room.answers = {};
        room.deadline = this.ctx.now() + E.TIMES.askMs;
        this.ctx.setTimer('turn', room.deadline);
        this.broadcast();
        return;
      }
    }
    room.phase = 'wait';
    room.deadline = 0;
    this.ctx.clearTimer('turn');
    this.broadcast();
  }

  private endTurn(): void {
    this.ctx.clearTimer('turn');
    this.nextTurn();
  }

  private current(): LogEntry | undefined {
    return this.room.log[this.room.log.length - 1];
  }

  private setOutcome(o: Outcome): void {
    const e = this.current();
    if (e && !e.outcome) e.outcome = o;
  }

  /* ---------- Asking and answering ---------- */

  private ask(p: Player, raw: unknown): void {
    const room = this.room;
    if (room.status !== 'play' || room.phase !== 'ask' || room.order[room.turn] !== p.id) return;
    const q = E.cleanQuestion(raw);
    if (!q) return this.tell(p.id, { t: 'nope', reason: 'Type a question first.' });
    p.asked++;
    room.log.push({ n: ++room.seq, pid: p.id, q, nq: E.tokens(q) });
    if (room.log.length > MAX_LOG) room.log.shift();
    room.phase = 'answer';
    room.answers = {};
    room.note = '';
    room.deadline = this.ctx.now() + E.TIMES.answerMs;
    this.ctx.setTimer('turn', room.deadline);
    if (!this.checkAnswers()) this.broadcast();
  }

  /** Who is expected to answer: everyone playing or watching their own card but the asker, if they are here. */
  private answerers(): Player[] {
    const asker = this.room.order[this.room.turn];
    return this.inGame().filter((p) => p.id !== asker && this.active(p));
  }

  private answer(p: Player, raw: unknown): void {
    const room = this.room;
    if (room.status !== 'play' || room.phase !== 'answer' || !p.inGame || p.id === room.order[room.turn]) return;
    if (typeof raw !== 'string' || !E.answerKeys(room.settings.deck).includes(raw)) return;
    room.answers[p.id] = raw;
    if (!this.checkAnswers()) this.broadcast();
  }

  /** Everyone who can answer has: close the question early. */
  private checkAnswers(): boolean {
    const room = this.room;
    if (room.status !== 'play' || room.phase !== 'answer') return false;
    if (this.answerers().every((p) => p.id in room.answers)) {
      this.closeAnswers();
      return true;
    }
    return false;
  }

  /** Count the answers and show the tally to everyone for a moment; then the next turn starts by itself. */
  private closeAnswers(): void {
    const room = this.room;
    if (room.status !== 'play' || room.phase !== 'answer') return;
    const keys = E.answerKeys(room.settings.deck);
    const entry = this.current();
    if (entry) {
      entry.tally = E.tallyAnswers(room.answers, keys);
      entry.top = E.majority(entry.tally, keys);
    }
    room.phase = 'tally';
    room.deadline = this.ctx.now() + E.TIMES.tallyMs;
    this.ctx.setTimer('turn', room.deadline);
    this.broadcast();
  }

  /* ---------- Guessing and giving up ---------- */

  /** A guess is a turn of its own, instead of asking: right (done, points) or "Not it"; either way the turn ends. */
  private guess(p: Player, raw: unknown): void {
    const room = this.room;
    if (room.status !== 'play' || room.phase !== 'ask' || room.order[room.turn] !== p.id) return;
    const text = E.cleanGuess(raw);
    if (!text) return this.tell(p.id, { t: 'nope', reason: 'Type your guess first.' });
    const deck = deckOf(room.settings.deck);
    const entry: LogEntry = { n: ++room.seq, pid: p.id, q: '', nq: '', guessTurn: true };
    room.log.push(entry);
    if (room.log.length > MAX_LOG) room.log.shift();
    room.note = '';
    if (E.guessMatches(text, deck, room.cards[p.id])) {
      Object.assign(entry, { outcome: 'right', guess: deck.entries[room.cards[p.id]].name });
      const pts = E.points(p.asked, room.first === null);
      if (room.first === null) room.first = p.id;
      room.delta[p.id] = (room.delta[p.id] || 0) + pts;
      p.score += pts;
      p.done = 'guessed';
    } else {
      Object.assign(entry, { outcome: 'wrong', guess: text, gtok: E.tokens(text) });
    }
    this.endTurn();
  }

  /** Reveal your card for no points. Allowed at any time in a round. */
  private giveUp(p: Player): void {
    const room = this.room;
    if (room.status !== 'play' || !p.inGame || p.done) return;
    p.done = 'gaveup';
    // Giving up on your own turn ends it, an open question included (a tally on show just runs out)
    const wasTurn = room.order[room.turn] === p.id && (room.phase === 'ask' || room.phase === 'answer');
    if (wasTurn && room.phase === 'answer') this.setOutcome('skip');
    if (this.allDone()) return this.finishRound();
    if (wasTurn) return this.endTurn();
    if (!this.checkAnswers()) this.broadcast();
  }

  /* ---------- The end of a round ---------- */

  private finishRound(): void {
    const room = this.room;
    if (room.status !== 'play') return;
    // A question still open is closed with what has been answered so far
    if (room.phase === 'answer') {
      const keys = E.answerKeys(room.settings.deck);
      const entry = this.current();
      if (entry) {
        entry.tally = E.tallyAnswers(room.answers, keys);
        entry.top = E.majority(entry.tally, keys);
      }
    }
    // Only a question still waiting for answers is cut short by the end of the round
    if (room.phase === 'answer') this.setOutcome('ended');
    this.ctx.clearTimer('turn');
    this.ctx.clearTimer('round');
    Object.assign(room, { status: 'result', deadline: 0, roundEnd: 0, phase: 'wait' });
    const players = this.inGame().filter((p) => !p.bot);
    const best = Math.max(0, ...players.map((p) => room.delta[p.id] || 0));
    const questions = players.reduce((sum, p) => sum + p.asked, 0);
    this.ctx.track('game_finished', { players: players.length, questions });
    // A round where nobody asked anything isn't worth a record
    if (questions > 0) {
      const winner = best > 0 ? players.find((p) => (room.delta[p.id] || 0) === best) : undefined;
      this.saveGame(players.map((p) => {
        const pts = room.delta[p.id] || 0;
        const guessed = p.done === 'guessed';
        const place = 1 + players.filter((q) => (room.delta[q.id] || 0) > pts).length;
        return {
          ...reportPlayer(p, place, best > 0 && pts === best, { points: pts, guessed: guessed ? 1 : 0, questions: p.asked }),
          // Fewest questions to a right guess: a best-of that keeps the LOWEST value
          ...(guessed ? { min: { fewestQ: p.asked } } : {}),
        };
      }), winner ? winner.name : null);
    }
    this.broadcast();
  }

  private backToLobby(): void {
    const room = this.room;
    if (room.status !== 'result') return;
    this.ctx.clearTimer('turn');
    this.ctx.clearTimer('round');
    room.status = 'lobby';
    room.players = room.players.filter((p) => p.connected);
    for (const p of room.players) Object.assign(p, { inGame: false, done: null, asked: 0 });
    Object.assign(room, { cards: {}, answers: {}, log: [], order: [], first: null, note: '', delta: {}, phase: 'wait' });
    this.broadcast();
  }

  /* ---------- What each player may see ---------- */

  /**
   * One player's view. Everyone's card is shown except the viewer's own, until it is revealed. Text that names
   * the viewer's own card (someone typing it into a question or a guess) is hidden from that viewer only.
   */
  protected view(forId: string | null): Msg {
    const room = this.room;
    const now = this.ctx.now();
    const me = this.byId(forId);
    const live = room.status !== 'lobby';
    const deck = deckOf(room.settings.deck);
    const reveal = room.status === 'result';
    // The card whose name must not reach this viewer through other people's text
    const spoil = live && !reveal && me && me.inGame && !me.done && room.cards[me.id] !== undefined ? deck.entries[room.cards[me.id]] : null;
    const spoils = (toks: string | undefined) => Boolean(spoil && toks && E.mentionsCard(toks, spoil));
    const cardOf = (p: Player): string | null => {
      const idx = room.cards[p.id];
      if (!live || idx === undefined) return null;
      if (p.id === forId && !reveal && !p.done) return null;
      return deck.entries[idx].name;
    };
    const asker = room.status === 'play' && room.phase !== 'wait' ? room.order[room.turn] : null;
    const cur = room.status === 'play' && (room.phase === 'answer' || room.phase === 'tally') ? this.current() : undefined;
    const need = room.status === 'play' && room.phase === 'answer' ? this.answerers().length : 0;
    const answered = room.status === 'play' && room.phase === 'answer' ? this.answerers().filter((p) => p.id in room.answers).length : 0;
    return {
      t: 'state',
      code: room.code, status: room.status, settings: room.settings, game: room.game, public: room.public,
      phase: room.status === 'play' ? room.phase : '',
      asker,
      endsIn: room.deadline ? room.deadline - now : 0,
      roundEndsIn: room.roundEnd ? room.roundEnd - now : 0,
      question: cur ? { n: cur.n, q: spoils(cur.nq) ? null : cur.q } : null,
      answered, need,
      myAnswer: room.phase === 'answer' && forId ? room.answers[forId] ?? null : null,
      tally: cur && room.phase === 'tally' ? cur.tally ?? null : null,
      top: cur && room.phase === 'tally' ? cur.top ?? [] : [],
      note: room.status === 'play' ? room.note : '',
      first: live ? room.first : null,
      log: live ? room.log.map((e) => ({
        n: e.n, pid: e.pid, q: spoils(e.nq) ? null : e.q, tally: e.tally ?? null, top: e.top ?? [], outcome: e.outcome ?? null,
        guessTurn: Boolean(e.guessTurn),
        guess: e.guess === undefined ? null : e.outcome === 'wrong' && spoils(e.gtok) ? null : e.guess,
      })) : [],
      players: room.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost, photo: p.photo,
        connected: p.connected, away: p.away, inGame: p.inGame, score: p.score,
        done: live ? p.done : null, asked: live ? p.asked : 0, pts: live ? room.delta[p.id] || 0 : 0,
        hasCard: live && room.cards[p.id] !== undefined, card: cardOf(p),
      })),
      crewName: room.crew ? room.crew.name : '',
      crewStatus: room.crewStatus,
    };
  }
}

export const forehead: GameModule = {
  id: GAME,
  // Questions are at most 100 characters; nothing is sent while typing
  maxMsgBytes: 1024,
  rate: { perSec: 8, burst: 24 },
  create(ctx: RoomCtx, opts) {
    return new ForeheadRoom(ctx, {
      code: ctx.code, public: opts.public, status: 'lobby', game: 0, players: [], crew: null, crewStatus: '',
      settings: cleanSettings({}), used: [], usedDeck: '', cards: {}, order: [], turn: -1, phase: 'wait', deadline: 0, roundEnd: 0,
      answers: {}, log: [], seq: 0, first: null, note: '', delta: {}, replayId: null,
    });
  },
  restore(ctx, snap) {
    const room = snap as Room;
    restoreSeats(ctx, room);
    // Saved before turns became "ask OR guess": the old guess-or-pass step shows its tally until its saved
    // 'turn' timer fires, then the next turn starts
    if ((room.phase as string) === 'decide') room.phase = 'tally';
    return new ForeheadRoom(ctx, room);
  },
};
