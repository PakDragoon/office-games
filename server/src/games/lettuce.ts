// Lettuce Party on the server: the host code from web/lettuce-party/js/app.js, moved here. The
// server picks the word, checks every guess and sends everyone colour patterns only; each player
// gets their own letters back, nobody else's.
import { BLOCKED_ANSWERS } from '../../../web/lettuce-party/js/words.js';
import ANSWERS_TEXT from '../../../web/lettuce-party/words/answers.txt';
import VALID_TEXT from '../../../web/lettuce-party/words/valid.txt';
import type { GameModule, Msg, RoomCtx } from '../core/game';
import { type BaseRoom, reportPlayer, restoreSeats, type Seat, SeatRoom } from '../core/seats';
import { cleanName } from '../core/util';
import { SortedWords } from '../core/words';

const GAME = 'lettuce-party';
const MAX_PLAYERS = 5;
const ROWS = 6;
const COLS = 5;

let WORDS: { answers: string[]; valid: { has(w: string): boolean } } | null = null;
function words() {
  if (!WORDS) {
    const blocked = new Set<string>(BLOCKED_ANSWERS);
    const answers = ANSWERS_TEXT.split('\n').map((w) => w.trim()).filter((w) => /^[a-z]{5}$/.test(w) && !blocked.has(w));
    const lists = [new SortedWords(VALID_TEXT), new SortedWords(ANSWERS_TEXT)];
    WORDS = { answers, valid: { has: (w: string) => lists.some((l) => l.has(w)) } };
  }
  return WORDS;
}

export function score(guess: string, answer: string): string {
  const out = Array(COLS).fill('m');
  const left: Record<string, number> = {};
  for (let i = 0; i < COLS; i++) {
    if (guess[i] === answer[i]) out[i] = 'h';
    else left[answer[i]] = (left[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < COLS; i++) {
    if (out[i] !== 'h' && left[guess[i]] > 0) {
      out[i] = 'n';
      left[guess[i]]--;
    }
  }
  return out.join('');
}

// Hard mode: every green stays in place, every revealed letter is used again.
function hardModeProblem(previous: Array<{ word: string; pattern: string }>, word: string): string | null {
  const nth = ['1st', '2nd', '3rd', '4th', '5th'];
  for (const g of previous) {
    for (let i = 0; i < COLS; i++) {
      if (g.pattern[i] === 'h' && word[i] !== g.word[i]) return `${nth[i]} letter must be ${g.word[i].toUpperCase()}`;
    }
    const need: Record<string, number> = {};
    for (let i = 0; i < COLS; i++) if (g.pattern[i] !== 'm') need[g.word[i]] = (need[g.word[i]] || 0) + 1;
    for (const [ch, n] of Object.entries(need)) {
      if ([...word].filter((c) => c === ch).length < n) return `Guess must contain ${ch.toUpperCase()}`;
    }
  }
  return null;
}

interface Player extends Seat {
  guesses: Array<{ word: string; pattern: string }>;
  solved: boolean;
  done: boolean;
  finishMs: number | null;
  timedOut: boolean;
  stopped: boolean;
}

interface Stat { name: string; color: number; played: number; wins: number; solved: number; guessSum: number; bestMs: number | null }

interface Room extends BaseRoom<Player> {
  round: number;
  strict: boolean;
  word: string | null;
  lastWord: string | null;
  startedAt: number;
  winRule: 'first' | 'fewest';
  maxRounds: number;
  timer: number;
  hard: boolean;
  matchRound: number;
  used: string[];
  stats: Record<string, Stat>;
  history: Array<{ round: number; word: string | null; winner: string | null }>;
}

class LettuceRoom extends SeatRoom<Player, Room> {
  protected readonly gameId = GAME;
  protected readonly maxPlayers = MAX_PLAYERS;

  protected newSeat(base: Seat): Player {
    return { ...base, guesses: [], solved: false, done: false, finishMs: null, timedOut: false, stopped: false };
  }

  // Lettuce Party keeps 'playing' between the statuses lobby / playing / ended / over
  protected watching(): boolean {
    return this.room.status === 'playing';
  }

  /** A round in progress takes back its own players only; newcomers wait for the next round. */
  join(connId: string, msg: Msg): void {
    const room = this.room;
    if (room.status === 'playing') {
      const name = (cleanName(msg.name) || 'Player').toLowerCase();
      const ident = this.ctx.identity(connId);
      const clientId = typeof msg.client === 'string' ? msg.client.slice(0, 40) : '';
      const mine = room.players.some((p) => p.name.toLowerCase() === name
        && ((clientId && p.clientId === clientId) || (ident.uid && p.uid === ident.uid) || !p.connected));
      if (!mine) return this.reject(connId, 'This round has already started. Join again when it ends.');
    }
    super.join(connId, msg);
  }

  // Coming back after a disconnect: their earlier guesses, so the board can be redrawn
  protected seated(p: Player, rejoin: boolean): void {
    if (rejoin && this.room.status !== 'lobby') this.tell(p.id, { t: 'board', round: this.room.round, guesses: p.guesses });
  }

  protected afterPresence(): void {
    this.checkEnd();
  }

  protected playerMessage(p: Player, msg: Msg): void {
    if (msg.t === 'guess') this.guess(p, msg.word);
  }

  protected hostMessage(_p: Player, msg: Msg): boolean {
    const room = this.room;
    switch (msg.t) {
      case 'settings': {
        const raw = (msg.patch && typeof msg.patch === 'object' ? msg.patch : {}) as Record<string, unknown>;
        if (typeof raw.strict === 'boolean') room.strict = raw.strict;
        if (raw.winRule === 'first' || raw.winRule === 'fewest') room.winRule = raw.winRule;
        if (typeof raw.hard === 'boolean') room.hard = raw.hard;
        if ([0, 3, 5, 10].includes(raw.maxRounds as number)) room.maxRounds = raw.maxRounds as number;
        if ([0, 60, 120, 180, 300].includes(raw.timer as number)) room.timer = raw.timer as number;
        this.broadcast();
        return true;
      }
      case 'start':
        if (typeof msg.crew === 'string' && msg.crew.trim() !== (room.crew ? room.crew.name : '')) this.setCrew(msg.crew);
        Object.assign(room, { stats: {}, history: [], matchRound: 0 });
        this.startRound();
        return true;
      case 'next':
        if (room.status === 'ended') this.startRound();
        return true;
      case 'endGame':
        if (room.status === 'ended') {
          room.status = 'over';
          this.broadcast();
        }
        return true;
      case 'endRound':
        this.endRound('host');
        return true;
      case 'lobby':
        this.ctx.clearTimer('round');
        room.status = 'lobby';
        room.players = room.players.filter((p) => p.connected);
        this.broadcast();
        return true;
      default:
        return false;
    }
  }

  protected gameTimer(name: string): void {
    if (name === 'round') this.endRound('time');
  }

  private startRound(): void {
    const room = this.room;
    this.ctx.clearTimer('round');
    room.players = room.players.filter((p) => p.connected);
    // No repeats within a room until every possible answer has been played.
    const all = words().answers;
    const used = new Set(room.used);
    let pool = all.filter((w) => !used.has(w));
    if (!pool.length) {
      room.used = [];
      pool = all.filter((w) => w !== room.lastWord);
    }
    const word = pool[Math.floor(this.ctx.random() * pool.length)];
    room.used.push(word);
    Object.assign(room, { word, lastWord: word, round: room.round + 1, matchRound: room.matchRound + 1, status: 'playing', startedAt: this.ctx.now(), game: room.game + 1 });
    for (const p of room.players) Object.assign(p, { guesses: [], solved: false, done: false, finishMs: null, timedOut: false, stopped: false, inGame: true });
    if (room.timer > 0) this.ctx.setTimer('round', room.startedAt + room.timer * 1000);
    this.ctx.track('game_started', { players: room.players.length });
    this.broadcast();
  }

  private endRound(reason: string): void {
    const room = this.room;
    if (room.status !== 'playing') return;
    this.ctx.clearTimer('round');
    for (const p of room.players) {
      if (!p.done) Object.assign(p, { done: true, finishMs: null, timedOut: reason === 'time', stopped: reason !== 'time' });
    }
    this.checkEnd();
    this.broadcast();
  }

  private guess(p: Player, rawWord: unknown): void {
    const room = this.room;
    const reply = (m: Msg) => this.tell(p.id, m);
    const word = String(rawWord ?? '').toLowerCase();
    if (room.status !== 'playing' || p.done || !room.word) return reply({ t: 'invalid', reason: 'This round is over' });
    if (!/^[a-z]{5}$/.test(word)) return reply({ t: 'invalid', reason: 'Not enough letters' });
    if (room.strict && !words().valid.has(word)) return reply({ t: 'invalid', reason: 'Not in word list' });
    if (room.hard) {
      const problem = hardModeProblem(p.guesses, word);
      if (problem) return reply({ t: 'invalid', reason: problem });
    }
    const pattern = score(word, room.word);
    p.guesses.push({ word, pattern });
    if (pattern === 'hhhhh') Object.assign(p, { solved: true, done: true, finishMs: this.ctx.now() - room.startedAt });
    else if (p.guesses.length >= ROWS) Object.assign(p, { done: true, finishMs: this.ctx.now() - room.startedAt });
    reply({ t: 'result', round: room.round, word, pattern });
    this.checkEnd();
    this.broadcast();
  }

  private checkEnd(): void {
    const room = this.room;
    if (room.status === 'playing' && room.players.every((p) => p.done || !p.connected)) {
      this.ctx.clearTimer('round');
      this.recordRound();
      room.status = room.maxRounds && room.matchRound >= room.maxRounds ? 'over' : 'ended';
    }
  }

  private ranked(): Player[] {
    const room = this.room;
    const solved = room.players.filter((p) => p.solved);
    if (room.winRule === 'fewest') return solved.sort((a, b) => a.guesses.length - b.guesses.length || (a.finishMs ?? 0) - (b.finishMs ?? 0));
    return solved.sort((a, b) => (a.finishMs ?? 0) - (b.finishMs ?? 0));
  }

  // Add the finished round to the room's running scores (keyed by name, so they survive a rejoin)
  private recordRound(): void {
    const room = this.room;
    const winner = this.ranked()[0] || null;
    for (const p of room.players) {
      const key = p.name.toLowerCase();
      const st = (room.stats[key] ||= { name: p.name, color: p.color, played: 0, wins: 0, solved: 0, guessSum: 0, bestMs: null });
      Object.assign(st, { name: p.name, color: p.color });
      st.played += 1;
      if (p.solved) {
        st.solved += 1;
        st.guessSum += p.guesses.length;
        if (st.bestMs == null || (p.finishMs ?? Infinity) < st.bestMs) st.bestMs = p.finishMs;
      }
      if (winner && p.id === winner.id) st.wins += 1;
    }
    room.history.push({ round: room.round, word: room.word, winner: winner ? winner.name : null });
    this.saveGame(room.players.map((p, i) => reportPlayer(p, i + 1, Boolean(winner && p.id === winner.id), {
      rounds: 1, solved: p.solved ? 1 : 0, guessSum: p.solved ? p.guesses.length : 0,
      // How many guesses it took, for the stats sheet's distribution
      ...(p.solved ? { [`dist${p.guesses.length}`]: 1 } : {}),
    }, p.solved && p.finishMs != null ? { fastestNeg: -p.finishMs } : undefined, {
      // Win streak: a round only counts as won for the winner; everyone else's streak resets
      streaks: { streak: Boolean(winner && p.id === winner.id) },
      // Favourite opener: the first word they guessed
      ...(p.guesses.length ? { tally: { opener: p.guesses[0].word.toLowerCase() } } : {}),
    })), winner ? winner.name : null);
  }

  protected view(): Msg {
    const room = this.room;
    return {
      t: 'state',
      code: room.code, status: room.status, round: room.round, strict: room.strict, winRule: room.winRule, public: room.public,
      maxRounds: room.maxRounds, timer: room.timer, hard: room.hard, matchRound: room.matchRound,
      elapsed: room.startedAt ? this.ctx.now() - room.startedAt : 0,
      // Only colour patterns go out. Letters stay on the server.
      players: room.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost, connected: p.connected,
        patterns: p.guesses.map((g) => g.pattern), solved: p.solved, done: p.done, finishMs: p.finishMs,
        photo: p.photo || '', timedOut: p.timedOut, stopped: p.stopped,
      })),
      word: room.status === 'ended' || room.status === 'over' ? room.word : null,
      stats: Object.values(room.stats),
      crew: room.crew ? room.crew.name : null,
      crewStatus: room.crewStatus,
      allTime: null,
      history: room.history.slice(-10),
    };
  }
}

export const lettuce: GameModule = {
  id: GAME,
  maxMsgBytes: 512,
  rate: { perSec: 6, burst: 20 },
  create(ctx: RoomCtx, opts) {
    return new LettuceRoom(ctx, {
      code: ctx.code, public: opts.public, status: 'lobby', game: 0, players: [], crew: null, crewStatus: '',
      round: 0, strict: true, word: null, lastWord: null, startedAt: 0, winRule: 'first', maxRounds: 0, timer: 0,
      hard: false, matchRound: 0, used: [], stats: {}, history: [],
    });
  },
  restore(ctx, snap) {
    const room = snap as Room;
    restoreSeats(ctx, room);
    return new LettuceRoom(ctx, room);
  },
};
