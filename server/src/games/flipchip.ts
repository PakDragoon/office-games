// Flipchip rooms on the server: the host code from web/flipchip/js/app.js, moved here (games
// against the computer still run that code in the browser). Two seats, Dark and Light; everyone
// else watches. The server checks every move, runs the move timer and keeps the score.
import * as E from '../../../web/flipchip/js/engine.js';
import type { GameModule, Msg, RoomCtx } from '../core/game';
import { type BaseRoom, reportPlayer, restoreSeats, type Seat, SeatRoom } from '../core/seats';

const GAME = 'flipchip';
const DARK = E.DARK;
const LIGHT = E.LIGHT;
type Side = 1 | 2;

type Settings = ReturnType<typeof E.cleanSettings>;

interface Player extends Seat {
  isBot: boolean;
  games: number;
  wins: number;
  draws: number;
  matchWins: number;
  reactAt: number;
}

interface Room extends BaseRoom<Player> {
  settings: Settings;
  seats: Record<Side, string | null>;
  board: number[] | null;
  size: number;
  turn: number;
  moveSeq: number;
  last: unknown;
  pass: unknown;
  log: unknown[];
  turnEnd: number;
  result: { reason: string; winner: number; counts: unknown; ids: Record<Side, string | null> } | null;
  matchWinner: string | null;
}

type LogEntry = { side: number; i?: number; pass?: boolean };

class FlipRoom extends SeatRoom<Player, Room> {
  protected readonly gameId = GAME;
  protected readonly maxPlayers = E.MAX_PLAYERS;
  private rnd = () => this.ctx.random();

  protected newSeat(base: Seat): Player {
    return { ...base, isBot: false, games: 0, wins: 0, draws: 0, matchWins: 0, reactAt: 0 };
  }

  protected remap(from: string, to: string): void {
    const room = this.room;
    for (const s of [DARK, LIGHT] as Side[]) if (room.seats[s] === from) room.seats[s] = to;
    if (room.result?.ids) for (const s of [DARK, LIGHT] as Side[]) if (room.result.ids[s] === from) room.result.ids[s] = to;
    if (room.matchWinner === from) room.matchWinner = to;
  }

  // In the lobby a newcomer takes an empty seat; mid-game they watch
  protected seated(p: Player, rejoin: boolean): void {
    const room = this.room;
    if (rejoin || room.status !== 'lobby' || this.seatOf(p.id)) return;
    if (!room.seats[DARK]) room.seats[DARK] = p.id;
    else if (!room.seats[LIGHT]) room.seats[LIGHT] = p.id;
  }

  protected afterPresence(): void {
    const room = this.room;
    if (room.status !== 'lobby') return;
    for (const s of [DARK, LIGHT] as Side[]) if (room.seats[s] && !this.byId(room.seats[s])) room.seats[s] = null;
  }

  private seatOf = (id: string): Side | 0 => (this.room.seats[DARK] === id ? DARK : this.room.seats[LIGHT] === id ? LIGHT : 0);

  protected playerMessage(p: Player, msg: Msg): void {
    const room = this.room;
    switch (msg.t) {
      case 'move': return this.move(p.id, Number(msg.i), msg.seq as number | undefined);
      case 'sit': {
        const side = Number(msg.side) as Side;
        if (room.status !== 'lobby' || ![DARK, LIGHT].includes(side)) return;
        const holder = room.seats[side] ? this.byId(room.seats[side]) : undefined;
        if (holder && holder.id !== p.id && holder.connected) return;
        for (const s of [DARK, LIGHT] as Side[]) if (room.seats[s] === p.id) room.seats[s] = null;
        room.seats[side] = p.id;
        return this.broadcast();
      }
      case 'stand':
        if (room.status !== 'lobby') return;
        for (const s of [DARK, LIGHT] as Side[]) if (room.seats[s] === p.id) room.seats[s] = null;
        return this.broadcast();
      case 'resign': {
        const side = this.seatOf(p.id);
        if (room.status === 'play' && side) this.gameOver('resign', E.other(side));
        return;
      }
      case 'claim': {
        const side = this.seatOf(p.id);
        if (room.status !== 'play' || !side) return;
        const opp = this.byId(room.seats[E.other(side) as Side]);
        if (!opp || opp.connected || this.ctx.now() - opp.offlineAt < E.TIMES.offlineClaimMs) return;
        return this.gameOver('forfeit', side);
      }
      case 'react': {
        if (!E.REACTIONS.includes(msg.e as string)) return;
        const now = this.ctx.now();
        if (now - (p.reactAt || 0) < 900) return;
        p.reactAt = now;
        return this.tellAll({ t: 'react', pid: p.id, e: msg.e });
      }
      default:
    }
  }

  protected hostMessage(p: Player, msg: Msg): boolean {
    const room = this.room;
    switch (msg.t) {
      case 'settings':
        if (room.status === 'lobby') {
          room.settings = E.cleanSettings(msg.settings);
          this.broadcast();
        }
        return true;
      case 'swap':
        if (room.status === 'lobby') {
          [room.seats[DARK], room.seats[LIGHT]] = [room.seats[LIGHT], room.seats[DARK]];
          this.broadcast();
        }
        return true;
      case 'start':
        this.startGame(p, msg);
        return true;
      case 'lobby':
        this.ctx.clearTimer('turn');
        room.status = 'lobby';
        room.players = room.players.filter((x) => x.connected);
        this.afterPresence();
        this.broadcast();
        return true;
      default:
        return false;
    }
  }

  protected gameTimer(name: string): void {
    if (name === 'turn') this.timeUp();
  }

  private seatsReady(): boolean {
    return ([DARK, LIGHT] as Side[]).every((s) => {
      const p = this.room.seats[s] ? this.byId(this.room.seats[s]) : undefined;
      return Boolean(p && p.connected);
    });
  }

  private startGame(by: Player, msg: Msg): void {
    const room = this.room;
    if (room.status === 'lobby') {
      if (msg.settings) room.settings = E.cleanSettings(msg.settings);
      if (typeof msg.crew === 'string' && msg.crew.trim() !== (room.crew ? room.crew.name : '')) this.setCrew(msg.crew);
    }
    if (!this.seatsReady()) {
      this.tell(by.id, { t: 'toast', text: room.status === 'lobby' ? 'Both seats need a player' : 'A player has left. Change settings to pick who plays.' });
      return;
    }
    // A rematch: colours swap (or not) as the room chose
    if (room.status === 'over') {
      const c = room.settings.colours;
      if (c === 'swap' || (c === 'random' && this.rnd() < 0.5)) [room.seats[DARK], room.seats[LIGHT]] = [room.seats[LIGHT], room.seats[DARK]];
    }
    if (room.matchWinner) {
      for (const p of room.players) p.matchWins = 0;
      room.matchWinner = null;
    }
    room.size = room.settings.size;
    for (const p of room.players) p.inGame = Boolean(this.seatOf(p.id));
    Object.assign(room, {
      status: 'play', board: E.newBoard(room.size), turn: DARK, moveSeq: 0, last: null, pass: null,
      log: [], result: null, replayId: null, game: room.game + 1,
    });
    this.ctx.track('game_started', { size: room.size });
    this.afterTurn();
  }

  // After every move (or at the start): the move timer
  private afterTurn(): void {
    const room = this.room;
    this.ctx.clearTimer('turn');
    room.turnEnd = 0;
    if (room.status === 'play') {
      const ms = E.timerMs(room.settings);
      if (ms) {
        room.turnEnd = this.ctx.now() + ms;
        this.ctx.setTimer('turn', room.turnEnd + 60);
      }
    }
    this.broadcast();
  }

  // Out of time: a random legal move is played for them
  private timeUp(): void {
    const room = this.room;
    if (room.status !== 'play' || !room.turnEnd || !room.board) return;
    const m = E.chooseMove(room.board, room.size, room.turn, 'random', { rnd: this.rnd });
    const id = room.seats[room.turn as Side];
    if (id) this.move(id, m, room.moveSeq, true);
  }

  private move(pid: string, i: number, seq: number | undefined, auto = false): void {
    const room = this.room;
    if (room.status !== 'play' || !room.board || room.seats[room.turn as Side] !== pid) return;
    if (seq !== undefined && seq !== room.moveSeq) return;   // a stale click from before the last move
    const side = room.turn;
    const r = E.play(room.board, room.size, i, side);
    if (!r) return;
    room.board = r.board;
    room.moveSeq++;
    room.last = { i, side, flips: r.flips, auto };
    room.log.push({ side, i });
    const next = E.nextTurn(room.board, room.size, side);
    if (!next) return this.gameOver('count');
    if (next === side) {
      room.pass = { side: E.other(side), seq: room.moveSeq };
      room.log.push({ side: E.other(side), pass: true });
    } else room.pass = null;
    room.turn = next;
    this.afterTurn();
  }

  private gameOver(reason: string, winnerSide = 0): void {
    const room = this.room;
    if (!room.board) return;
    this.ctx.clearTimer('turn');
    const winner = reason === 'count' ? E.winnerOf(room.board) : winnerSide;
    const counts = E.counts(room.board) as Record<number, number>;
    room.status = 'over';
    room.turn = 0;
    room.turnEnd = 0;
    room.result = { reason, winner, counts, ids: { 1: room.seats[DARK], 2: room.seats[LIGHT] } };
    const seated: Player[] = [];
    for (const s of [DARK, LIGHT] as Side[]) {
      const p = this.byId(room.seats[s]);
      if (!p) continue;
      seated.push(p);
      p.games++;
      if (!winner) p.draws++;
      else if (winner === s) { p.wins++; p.matchWins++; }
    }
    const target = E.matchTarget(room.settings);
    const w = winner ? this.byId(room.seats[winner as Side]) : undefined;
    if (target && w && w.matchWins >= target) room.matchWinner = w.id;
    this.ctx.track('game_finished', { reason, size: room.size });
    // A shareable replay: who played which colour, every move (passes included) and how it ended
    this.saveReplay({
      v: 1, size: room.size, reason, winner,
      counts: { dark: counts[DARK] || 0, light: counts[LIGHT] || 0 },
      players: { dark: this.byId(room.seats[DARK])?.name ?? 'Dark', light: this.byId(room.seats[LIGHT])?.name ?? 'Light' },
      moves: (room.log as LogEntry[]).map((m) => (m.pass ? { side: m.side, pass: true } : { side: m.side, i: m.i })),
    }, seated);
    this.saveGame(seated.map((p) => {
      const side = this.seatOf(p.id);
      return reportPlayer(p, !winner ? 1 : winner === side ? 1 : 2, Boolean(winner) && winner === side, {
        draws: winner ? 0 : 1, chips: side ? counts[side] || 0 : 0,
      });
    }), w ? w.name : null);
    this.broadcast();
  }

  // What everyone may see (in this game nothing is secret)
  protected view(): Msg {
    const room = this.room;
    const now = this.ctx.now();
    return {
      t: 'state',
      code: room.code, solo: false, level: null, status: room.status, settings: room.settings, game: room.game, public: room.public,
      players: room.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost, isBot: false, photo: p.photo,
        connected: p.connected, away: p.away, games: p.games, wins: p.wins, draws: p.draws, matchWins: p.matchWins,
        offlineFor: p.connected ? 0 : now - p.offlineAt,
      })),
      seats: { ...room.seats },
      size: room.size, board: room.board, turn: room.turn, moveSeq: room.moveSeq,
      last: room.last, pass: room.pass, log: room.log,
      turnLeft: room.turnEnd ? room.turnEnd - now : null,
      turnMs: E.timerMs(room.settings),
      result: room.result, matchWinner: room.matchWinner, replayId: room.status === 'over' ? room.replayId ?? null : null,
      canUndo: false,
      crewName: room.crew ? room.crew.name : '',
      crewStatus: room.crewStatus,
    };
  }
}

export const flipchip: GameModule = {
  id: GAME,
  maxMsgBytes: 512,
  rate: { perSec: 8, burst: 20 },
  create(ctx: RoomCtx, opts) {
    const settings = E.cleanSettings({});
    return new FlipRoom(ctx, {
      code: ctx.code, public: opts.public, status: 'lobby', game: 0, players: [], crew: null, crewStatus: '',
      settings, seats: { 1: null, 2: null }, board: null, size: settings.size, turn: 0, moveSeq: 0,
      last: null, pass: null, log: [], turnEnd: 0, result: null, matchWinner: null, replayId: null,
    });
  },
  restore(ctx, snap) {
    const room = snap as Room;
    restoreSeats(ctx, room);
    return new FlipRoom(ctx, room);
  },
};
