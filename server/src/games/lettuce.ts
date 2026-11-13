// Lettuce Party on the server: the host code from web/lettuce-party/js/app.js, moved here. The
// server picks the word, checks every guess and sends everyone colour patterns only; each player
// gets their own letters back, nobody else's.
import { BLOCKED_ANSWERS } from '../../../web/lettuce-party/js/words.js';
import ANSWERS_TEXT from '../../../web/lettuce-party/words/answers.txt';
import LADDERS_TEXT from '../../../web/lettuce-party/words/ladders.txt';
import VALID_TEXT from '../../../web/lettuce-party/words/valid.txt';
import * as E from '../../../web/lettuce-party/js/engine.js';
import type { GameModule, Msg, RoomCtx } from '../core/game';
import { type BaseRoom, reportPlayer, restoreSeats, type Seat, SeatRoom } from '../core/seats';
import { cleanName } from '../core/util';
import { SortedWords } from '../core/words';

const GAME = 'lettuce-party';
const MAX_PLAYERS = 5;
const MAX_LADDER_STEPS = 60;
const COLS = E.COLS;
type Settings = ReturnType<typeof E.cleanSettings>;
interface Guess { word: string; pattern: string }
interface Ladder { start: string; target: string; par: number; path: string[] }

let WORDS: { answers: string[]; valid: { has(w: string): boolean }; blocked: Set<string> } | null = null;
function words() {
  if (!WORDS) {
    const blocked = new Set<string>(BLOCKED_ANSWERS);
    const answers = ANSWERS_TEXT.split('\n').map((w) => w.trim()).filter((w) => /^[a-z]{5}$/.test(w) && !blocked.has(w));
    const lists = [new SortedWords(VALID_TEXT), new SortedWords(ANSWERS_TEXT)];
    WORDS = { answers, valid: { has: (w: string) => lists.some((l) => l.has(w)) }, blocked };
  }
  return WORDS;
}

/** A word a ladder step may use: any valid word except the blocked ones, which the pairs' par was worked out without. */
const ladderWord = (w: string) => words().valid.has(w) && !words().blocked.has(w);

export const score: (guess: string, answer: string) => string = E.score;

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
  guesses: Guess[];
  solved: boolean;
  done: boolean;
  finishMs: number | null;
  timedOut: boolean;
  stopped: boolean;
}

interface Stat { name: string; color: number; played: number; wins: number; solved: number; guessSum: number; bestMs: number | null }

interface Room extends BaseRoom<Player>, Settings {
  round: number;
  word: string | null;
  lastWord: string | null;
  startedAt: number;
  /** Word ladder: this round's start, target and one shortest path (the path only goes out when the round is over). */
  ladder: Ladder | null;
  matchRound: number;
  used: string[];
  /** Ladder lines already played in this room, so a pair doesn't come round twice. */
  usedPairs: string[];
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

  // Coming back after a disconnect: their own earlier guesses, so the board can be redrawn.
  // Counts mode never sends the tile colours, only the three numbers.
  protected seated(p: Player, rejoin: boolean): void {
    if (rejoin && this.room.status !== 'lobby') {
      this.tell(p.id, {
        t: 'board', round: this.room.round, mode: this.room.mode, attempts: this.room.attempts,
        guesses: p.guesses.map((g) => this.ownRow(g)),
      });
    }
  }

  /** What a player is told about one of their own guesses. */
  private ownRow(g: Guess): Msg {
    if (this.room.mode === 'counts') return { word: g.word, counts: E.countsFor(g.word, this.room.word || '') };
    if (this.room.mode === 'ladder') return { word: g.word };
    return { word: g.word, pattern: g.pattern };
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
        // Settings can only change in the lobby, never under a round that is running
        if (room.status !== 'lobby') return true;
        Object.assign(room, E.cleanSettings(msg.patch, room));
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
    if (room.mode === 'ladder') {
      // A pair precomputed by tools/build-ladders.mjs; nothing is searched here
      const pair = E.pickPair(LADDERS_TEXT, () => this.ctx.random(), (key: string) => room.usedPairs.includes(key))
        ?? E.parsePair('crane glaze 3 craze graze') as Ladder;
      const line = `${pair.start} ${pair.target}`;
      room.usedPairs = [...room.usedPairs.filter((l) => l !== line), line].slice(-300);
      room.ladder = pair as Ladder;
      room.word = null;
    } else {
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
      room.ladder = null;
      room.word = word;
      room.lastWord = word;
    }
    Object.assign(room, { round: room.round + 1, matchRound: room.matchRound + 1, status: 'playing', startedAt: this.ctx.now(), game: room.game + 1 });
    for (const p of room.players) Object.assign(p, { guesses: [], solved: false, done: false, finishMs: null, timedOut: false, stopped: false, inGame: true });
    const limit = E.effectiveTimer(room);
    if (limit > 0) this.ctx.setTimer('round', room.startedAt + limit * 1000);
    this.ctx.track('game_started', { players: room.players.length, mode: room.mode });
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
    const ladder = room.mode === 'ladder';
    if (room.status !== 'playing' || p.done || !(ladder ? room.ladder : room.word)) return reply({ t: 'invalid', reason: 'This round is over' });
    if (!/^[a-z]{5}$/.test(word)) return reply({ t: 'invalid', reason: 'Not enough letters' });

    if (ladder && room.ladder) {
      const problem = E.ladderStepProblem([room.ladder.start, ...p.guesses.map((g) => g.word)], word, (w: string) => ladderWord(w), room.ladderReuse);
      if (problem) return reply({ t: 'invalid', reason: problem });
      // No attempt limit in a ladder, but a cap keeps the room's snapshot small against a step-spamming client
      if (p.guesses.length >= MAX_LADDER_STEPS) return reply({ t: 'invalid', reason: 'Too many steps' });
      p.guesses.push({ word, pattern: '' });
      if (word === room.ladder.target) Object.assign(p, { solved: true, done: true, finishMs: this.ctx.now() - room.startedAt });
      reply({ t: 'result', round: room.round, word });
      this.checkEnd();
      this.broadcast();
      return;
    }

    if (!room.word) return;
    if (p.guesses.length >= room.attempts) return reply({ t: 'invalid', reason: 'Out of guesses' });
    if (room.strict && !words().valid.has(word)) return reply({ t: 'invalid', reason: 'Not in word list' });
    if (room.hard && room.mode === 'classic') {
      const problem = hardModeProblem(p.guesses, word);
      if (problem) return reply({ t: 'invalid', reason: problem });
    }
    const pattern = score(word, room.word);
    p.guesses.push({ word, pattern });
    if (pattern === 'hhhhh') Object.assign(p, { solved: true, done: true, finishMs: this.ctx.now() - room.startedAt });
    else if (p.guesses.length >= room.attempts) Object.assign(p, { done: true, finishMs: this.ctx.now() - room.startedAt });
    // Counts mode: the guesser gets the three numbers only, never the tile colours
    reply(room.mode === 'counts'
      ? { t: 'result', round: room.round, word, counts: E.counts(pattern) }
      : { t: 'result', round: room.round, word, pattern });
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
    const label = room.mode === 'ladder' && room.ladder ? `${room.ladder.start} to ${room.ladder.target}` : room.word;
    room.history.push({ round: room.round, word: label, winner: winner ? winner.name : null });
    this.saveGame(room.players.map((p, i) => this.reportFor(p, i + 1, Boolean(winner && p.id === winner.id))), winner ? winner.name : null);
  }

  /**
   * One player's stats for the finished round. Classic keeps the names it always had. Counts and Ladder write their
   * own (`counts:...`, `ladder:...`) and never touch Classic's win count, streak, openers or guess distribution.
   * (reportPlayer's output goes through recordGame, which drops bot seats.)
   */
  private reportFor(p: Player, place: number, won: boolean): ReturnType<typeof reportPlayer> {
    const room = this.room;
    const n = p.guesses.length;
    const fast = p.solved && p.finishMs != null ? -p.finishMs : null;
    if (room.mode === 'classic') {
      return reportPlayer(p, place, won, {
        rounds: 1, solved: p.solved ? 1 : 0, guessSum: p.solved ? n : 0,
        // How many guesses it took, for the stats sheet's distribution (1 to 10 now that the host picks the attempts)
        ...(p.solved ? { [`dist${n}`]: 1 } : {}),
      }, fast != null ? { fastestNeg: fast } : undefined, {
        // Win streak: a round only counts as won for the winner; everyone else's streak resets
        streaks: { streak: won },
        // Favourite opener: the first word they guessed
        ...(n ? { tally: { opener: p.guesses[0].word.toLowerCase() } } : {}),
      });
    }
    const m = room.mode;
    // `wins: 0` stops reportPlayer's default from adding to Classic's own win count
    const stats: Record<string, number> = { wins: 0, [`${m}:plays`]: 1, [`${m}:wins`]: won ? 1 : 0, [`${m}:solved`]: p.solved ? 1 : 0 };
    const max: Record<string, number> = {};
    if (fast != null) max[`${m}FastestNeg`] = fast;
    if (m === 'counts') stats['counts:guessSum'] = p.solved ? n : 0;
    if (m === 'ladder' && room.ladder && p.solved) {
      const over = Math.max(0, n - room.ladder.par);
      stats['ladder:steps'] = n;
      stats['ladder:overPar'] = over;
      max.ladderBestOverNeg = -over;   // stored negated so that MAX = closest to par
    }
    return reportPlayer(p, place, won, stats, max);
  }

  protected view(): Msg {
    const room = this.room;
    const over = room.status === 'ended' || room.status === 'over';
    const ladder = room.ladder;
    return {
      t: 'state',
      code: room.code, status: room.status, round: room.round, strict: room.strict, winRule: room.winRule, public: room.public,
      maxRounds: room.maxRounds, timer: room.timer, hard: room.hard, matchRound: room.matchRound,
      mode: room.mode, attempts: room.attempts, ladderTime: room.ladderTime, ladderReuse: room.ladderReuse,
      elapsed: room.startedAt ? this.ctx.now() - room.startedAt : 0,
      // Start and target are public (it's a puzzle). The shortest path is the answer key: only once the round is over.
      ladder: ladder && room.status !== 'lobby' ? { start: ladder.start, target: ladder.target, par: ladder.par, path: over ? ladder.path : null } : null,
      // Only colour patterns (classic) or the three numbers (counts) or step counts (ladder) go out. Letters stay on
      // the server until the round is over; then counts and ladder boards are revealed in full.
      players: room.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost, connected: p.connected,
        used: p.guesses.length,
        patterns: room.mode === 'classic' ? p.guesses.map((g) => g.pattern) : [],
        counts: room.mode === 'counts' && room.word ? p.guesses.map((g) => E.countsFor(g.word, room.word as string)) : [],
        match: room.mode === 'ladder' && ladder && p.guesses.length ? E.matchCount(p.guesses[p.guesses.length - 1].word, ladder.target) : null,
        rows: over && room.mode !== 'classic' ? p.guesses.map((g) => ({ word: g.word, ...(room.mode === 'counts' && room.word ? { pattern: score(g.word, room.word) } : {}) })) : null,
        solved: p.solved, done: p.done, finishMs: p.finishMs,
        photo: p.photo || '', timedOut: p.timedOut, stopped: p.stopped,
      })),
      word: over ? room.word : null,
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
      round: 0, word: null, lastWord: null, startedAt: 0, ladder: null, usedPairs: [],
      matchRound: 0, used: [], stats: {}, history: [],
      ...E.cleanSettings(null),
    });
  },
  restore(ctx, snap) {
    const room = snap as Room;
    restoreSeats(ctx, room);
    // A room saved before modes existed has none of the new settings: it is a classic room with six rows
    Object.assign(room, E.cleanSettings(null, room));
    room.ladder ??= null;
    room.usedPairs ??= [];
    return new LettuceRoom(ctx, room);
  },
};
