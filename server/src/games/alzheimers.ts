// Alzheimer's on the server. 1 vs 1: each player writes 12 things for the other, the server flashes the
// other player's words one at a time while you draw, then tests where you drew each one. A word goes to the
// player drawing it only while it is on screen; the test never shows it next to its box; every tap is scored here.
import * as E from '../../../web/alzheimers/js/engine.js';
import type { GameModule, Msg, RoomCtx } from '../core/game';
import { type BaseRoom, reportPlayer, restoreSeats, type Seat, SeatRoom } from '../core/seats';

const GAME = 'alzheimers';

interface Settings { pace: number; flash: number }
interface Stroke { b: number; pts: number[] }
interface Answer { i: number; b: number; ms: number }

interface Player extends Seat {
  /** Rounds won in this room. */
  score: number;
  /** What this player wrote for the other one (their draft until the round starts). */
  words: string[];
  ready: boolean;
  strokes: Stroke[];
  ink: number;
  /** Test: the order the words come back in, and the taps so far. */
  order: number[];
  answers: Answer[];
  askedAt: number;
  points: number;
  ms: number;
}

interface Room extends BaseRoom<Player> {
  settings: Settings;
  /** lobby → write → draw → test → result */
  phaseEnd: number;
  /** When the first word appears (after the 3-2-1). */
  drawStart: number;
  testStart: number;
  winner: string | null;
}

const cleanSettings = (raw: unknown): Settings => E.cleanSettings(raw) as Settings;
const fresh = { words: [] as string[], ready: false, strokes: [] as Stroke[], ink: 0, order: [] as number[], answers: [] as Answer[], askedAt: 0, points: 0, ms: 0 };

class AlzheimersRoom extends SeatRoom<Player, Room> {
  protected readonly gameId = GAME;
  protected readonly maxPlayers = E.PLAYERS;
  protected perPlayerView = true;
  private rnd = () => this.ctx.random();

  protected newSeat(base: Seat): Player {
    return { ...base, score: 0, ...structuredClone(fresh) };
  }

  /** The other player: the one who wrote my words. */
  private other(p: Player): Player | undefined {
    return this.inGame().find((x) => x.id !== p.id);
  }

  /** The 12 words this player draws (written by the other one). */
  private wordsFor(p: Player): string[] {
    return this.other(p)?.words ?? [];
  }

  // Coming back mid-game: your own drawing; at the result, both
  protected seated(p: Player, rejoin: boolean): void {
    const room = this.room;
    if (!rejoin) return;
    if (room.status === 'draw' || room.status === 'test') this.tell(p.id, { t: 'drawing', game: room.game, mine: p.strokes });
    if (room.status === 'result') this.sendDrawings(p.id);
  }

  protected afterPresence(): void {
    const room = this.room;
    if (room.status === 'write') this.checkWritten();
    if (room.status === 'test') this.checkTested();
  }

  protected playerMessage(p: Player, msg: Msg): void {
    switch (msg.t) {
      case 'words': return this.setWords(p, msg.list, msg.ready === true);
      case 'stroke': return this.stroke(p, msg.b, msg.pts);
      case 'undo': return this.undo(p);
      case 'pick': return this.pick(p, msg.q, msg.b);
      default:
    }
  }

  protected hostMessage(_p: Player, msg: Msg): boolean {
    const room = this.room;
    switch (msg.t) {
      case 'settings':
        if (room.status !== 'lobby') return true;
        room.settings = cleanSettings(msg.settings);
        this.broadcast();
        return true;
      case 'begin':
        this.begin(msg);
        return true;
      case 'lobby':
        if (room.status !== 'result') return true;
        this.clearTimers();
        room.status = 'lobby';
        room.players = room.players.filter((p) => p.connected);
        for (const p of room.players) Object.assign(p, { inGame: false }, structuredClone(fresh));
        this.broadcast();
        return true;
      default:
        return false;
    }
  }

  protected gameTimer(name: string): void {
    const room = this.room;
    if (name === 'word' && room.status === 'draw') return this.nextWord();
    if (name !== 'phase') return;
    if (room.status === 'write') return this.startDrawing();
    if (room.status === 'draw') return this.startTest();
    if (room.status === 'test') return this.finish();
  }

  private clearTimers(): void {
    this.ctx.clearTimer('phase');
    this.ctx.clearTimer('word');
  }

  /* ---------- Writing the words ---------- */

  private begin(msg: Msg): void {
    const room = this.room;
    if (room.status !== 'lobby' && room.status !== 'result') return;
    const players = room.players.filter((p) => p.connected);
    if (players.length !== E.PLAYERS) {
      this.toHost({ t: 'toast', text: 'Alzheimer’s is for 2 players' });
      return;
    }
    if (typeof msg.crew === 'string') {
      const typed = msg.crew.replace(/\s+/g, ' ').trim();
      if (typed !== (room.crew ? room.crew.name : '')) this.setCrew(typed);
    }
    if (room.status === 'lobby' && msg.settings) room.settings = cleanSettings(msg.settings);
    this.clearTimers();
    room.players = players;
    for (const p of players) Object.assign(p, { inGame: true }, structuredClone(fresh));
    Object.assign(room, { game: room.game + 1, status: 'write', phaseEnd: this.ctx.now() + E.TIMES.writeMs, drawStart: 0, testStart: 0, winner: null });
    this.ctx.setTimer('phase', room.phaseEnd);
    this.ctx.track('game_started', { pace: room.settings.pace, flash: room.settings.flash });
    this.broadcast();
  }

  /** A draft (saved as you type) or a finished list (ready). Only a full list of 12 different things can be ready. */
  private setWords(p: Player, list: unknown, ready: boolean): void {
    if (this.room.status !== 'write' || !p.inGame) return;
    const raw = Array.isArray(list) ? list.slice(0, E.BOXES) : [];
    p.words = raw.map((w) => E.cleanWord(w));
    if (ready) {
      const problem = E.wordsProblem(p.words);
      if (problem) return this.tell(p.id, { t: 'nope', reason: problem });
    }
    p.ready = ready;
    if (!this.checkWritten()) this.broadcast();
  }

  private checkWritten(): boolean {
    const players = this.inGame();
    if (players.length && players.filter((p) => this.active(p)).every((p) => p.ready)) {
      this.startDrawing();
      return true;
    }
    return false;
  }

  /* ---------- Drawing: the other player's words, one at a time ---------- */

  private startDrawing(): void {
    const room = this.room;
    if (room.status !== 'write') return;
    // Whatever wasn't written in time (or by someone who left) is filled with things that are easy to draw
    for (const p of this.inGame()) p.words = E.fillWords(p.words, this.rnd);
    const now = this.ctx.now();
    Object.assign(room, { status: 'draw', drawStart: now + E.TIMES.countdownMs });
    room.phaseEnd = room.drawStart + E.drawLength(room.settings.pace);
    this.ctx.setTimer('phase', room.phaseEnd);
    this.ctx.setTimer('word', room.drawStart);
    this.broadcast();
  }

  // Each word's moment: everyone gets their own view with their word in it, then the next word is booked
  private nextWord(): void {
    const room = this.room;
    const i = E.wordIndex(this.ctx.now() - room.drawStart + 50, room.settings.pace);
    if (i + 1 < E.BOXES) this.ctx.setTimer('word', room.drawStart + E.revealAt(i + 1, room.settings.pace));
    this.broadcast();
  }

  private stroke(p: Player, b: unknown, pts: unknown): void {
    const room = this.room;
    // A little grace for a line finished just as drawing ended
    if (room.status !== 'draw' || !p.inGame || this.ctx.now() > room.phaseEnd + 1000 || this.ctx.now() < room.drawStart - 500) return;
    const clean = E.cleanStroke(b, pts, E.INK.perPlayer - p.ink);
    if (clean.length < 2) return;
    p.strokes.push({ b: b as number, pts: clean });
    p.ink += clean.length;
    // Saved with the next broadcast; the other player never sees it until the result
    this.ctx.dirty();
  }

  private undo(p: Player): void {
    if (this.room.status !== 'draw' || !p.inGame) return;
    const s = p.strokes.pop();
    if (s) p.ink -= s.pts.length;
    this.ctx.dirty();
  }

  /* ---------- The memory test ---------- */

  private startTest(): void {
    const room = this.room;
    if (room.status !== 'draw') return;
    this.clearTimers();
    const now = this.ctx.now();
    for (const p of this.inGame()) Object.assign(p, { order: E.shuffle([...Array(E.BOXES).keys()], this.rnd), answers: [], askedAt: now });
    Object.assign(room, { status: 'test', testStart: now, phaseEnd: now + E.TIMES.testMs });
    this.ctx.setTimer('phase', room.phaseEnd);
    this.broadcast();
  }

  /** Tap for question q: the box where you think you drew that word. */
  private pick(p: Player, q: unknown, b: unknown): void {
    const room = this.room;
    if (room.status !== 'test' || !p.inGame || q !== p.answers.length || q >= E.BOXES) return;
    if (!Number.isInteger(b) || (b as number) < 0 || (b as number) >= E.BOXES) return;
    const now = this.ctx.now();
    const i = p.order[q as number];
    p.answers.push({ i, b: b as number, ms: now - p.askedAt });
    p.askedAt = now;
    this.tell(p.id, { t: 'picked', q, right: i === b, box: i, word: this.wordsFor(p)[i] });
    if (!this.checkTested()) this.broadcast();
  }

  private checkTested(): boolean {
    const players = this.inGame();
    if (players.length && players.filter((p) => this.active(p)).every((p) => p.answers.length >= E.BOXES)) {
      this.finish();
      return true;
    }
    return false;
  }

  private finish(): void {
    const room = this.room;
    if (room.status !== 'test') return;
    this.clearTimers();
    const players = this.inGame();
    for (const p of players) {
      p.points = E.points(p.answers);
      // Unanswered words count as wrong; anyone who didn't finish took the whole test time
      p.ms = p.answers.length >= E.BOXES ? p.answers.reduce((n, a) => n + a.ms, 0) : E.TIMES.testMs;
    }
    const { winner } = E.standings(players.map((p) => ({ id: p.id, points: p.points, ms: p.ms })));
    room.winner = winner;
    const champ = this.byId(winner);
    if (champ) champ.score += 1;
    room.status = 'result';
    room.phaseEnd = 0;
    this.ctx.track('game_finished', { points: players.map((p) => p.points).join('-') });
    if (players.some((p) => p.answers.length)) {
      this.saveGame(players.map((p) => reportPlayer(p, p.id === winner ? 1 : 2, p.id === winner, {
        points: p.points, perfect: p.points === E.BOXES ? 1 : 0, drawn: p.strokes.length ? 1 : 0,
      }, { best: p.points })), champ ? champ.name : null);
    }
    this.broadcast();
    for (const p of room.players) if (p.connected) this.sendDrawings(p.id);
  }

  /** At the result: both drawings, with the words that went in each box. */
  private sendDrawings(id: string): void {
    this.tell(id, {
      t: 'drawings', game: this.room.game,
      boards: this.inGame().map((p) => ({ id: p.id, strokes: p.strokes, words: this.wordsFor(p) })),
    });
  }

  /* ---------- What each player may see ---------- */

  protected view(forId: string | null): Msg {
    const room = this.room;
    const now = this.ctx.now();
    const me = this.byId(forId);
    const mine = me && me.inGame ? me : undefined;
    const sinceStart = now - room.drawStart;
    const index = room.status === 'draw' ? E.wordIndex(sinceStart, room.settings.pace) : -1;
    // A word goes out only to the player drawing it, and only while it is on screen
    const word = room.status === 'draw' && mine && E.showing(index, sinceStart, room.settings.pace, room.settings.flash)
      ? this.wordsFor(mine)[index] ?? null : null;
    const q = room.status === 'test' && mine ? mine.answers.length : 0;
    const reveal = room.status === 'result';
    return {
      t: 'state',
      code: room.code, status: room.status, settings: room.settings, game: room.game, public: room.public,
      endsIn: room.phaseEnd ? room.phaseEnd - now : 0,
      drawStartsIn: room.status === 'draw' ? room.drawStart - now : 0,
      index, word,
      shownFor: word ? room.drawStart + E.revealAt(index, room.settings.pace) + room.settings.flash - now : 0,
      // Writing: your own draft (for a refresh). Test: the word you're asked about now, and your taps so far.
      myWords: room.status === 'write' && mine ? mine.words : [],
      question: room.status === 'test' && mine && q < E.BOXES ? { q, word: this.wordsFor(mine)[mine.order[q]] } : null,
      myAnswers: mine && (room.status === 'test' || reveal) ? mine.answers.map((a) => ({ b: a.b, right: a.i === a.b, box: a.i })) : [],
      winner: reveal ? room.winner : null,
      players: room.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost, photo: p.photo,
        connected: p.connected, away: p.away, inGame: p.inGame, score: p.score,
        written: room.status === 'write' ? p.words.filter(Boolean).length : 0,
        ready: room.status === 'write' && p.ready,
        answered: room.status === 'test' || reveal ? p.answers.length : 0,
        points: reveal ? p.points : null,
        ms: reveal ? p.ms : null,
        answers: reveal ? p.answers.map((a) => ({ i: a.i, b: a.b })) : null,
      })),
      crewName: room.crew ? room.crew.name : '',
      crewStatus: room.crewStatus,
    };
  }
}

export const alzheimers: GameModule = {
  id: GAME,
  // A stroke is at most 800 numbers of up to 3 digits
  maxMsgBytes: 6144,
  rate: { perSec: 12, burst: 40 },
  create(ctx: RoomCtx, opts) {
    return new AlzheimersRoom(ctx, {
      code: ctx.code, public: opts.public, status: 'lobby', game: 0, players: [], crew: null, crewStatus: '',
      settings: cleanSettings({}), phaseEnd: 0, drawStart: 0, testStart: 0, winner: null, replayId: null,
    });
  },
  restore(ctx, snap) {
    const room = snap as Room;
    restoreSeats(ctx, room);
    return new AlzheimersRoom(ctx, room);
  },
};
