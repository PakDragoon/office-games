// Flipchip rooms on the server: the host code from web/flipchip/js/app.js, moved here (games
// against the computer still run that code in the browser). Two seats, Dark and Light; everyone
// else watches. The server checks every move, runs the move timer and keeps the score.
import * as E from '../../../web/flipchip/js/engine.js';
import { botDelay } from '../core/bots';
import type { GameModule, Msg, RatingInfo, RoomCtx } from '../core/game';
import { type BaseRoom, reportPlayer, restoreSeats, type Seat, SeatRoom } from '../core/seats';

const GAME = 'flipchip';
const DARK = E.DARK;
const LIGHT = E.LIGHT;
type Side = 1 | 2;

type Settings = ReturnType<typeof E.cleanSettings>;

interface Player extends Seat {
  /** A computer player (same as `bot`; the browser's own solo mode uses this name too). Never rated. */
  isBot: boolean;
  games: number;
  wins: number;
  draws: number;
  matchWins: number;
  reactAt: number;
  /** Skill rating for the lobby and the table (null: no id yet, or not looked up yet). */
  rating?: RatingInfo | null;
  /** What the last finished game did to the rating (null until it is known). */
  ratingDelta?: number | null;
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
  /** A computer player's move is planned for this time (0: none), for this game and move. */
  botAt?: number;
  botKey?: string;
}

/** How many moves a room's computer player weighs up (the CPU budget is tiny on a big board). */
const ROOT_CAP: Record<number, number> = { 6: 5, 8: 4, 10: 3 };

type LogEntry = { side: number; i?: number; pass?: boolean };

class FlipRoom extends SeatRoom<Player, Room> {
  protected readonly gameId = GAME;
  protected readonly maxPlayers = E.MAX_PLAYERS;
  protected botSupport = true;
  private rnd = () => this.ctx.random();

  protected newSeat(base: Seat): Player {
    return { ...base, isBot: Boolean(base.bot), games: 0, wins: 0, draws: 0, matchWins: 0, reactAt: 0 };
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
    this.loadRating(p);
    if (rejoin || room.status !== 'lobby' || this.seatOf(p.id)) return;
    if (!room.seats[DARK]) room.seats[DARK] = p.id;
    else if (!room.seats[LIGHT]) room.seats[LIGHT] = p.id;
    else {
      // Both seats taken: a computer player gives up its seat to a person who just came in
      const side = ([DARK, LIGHT] as Side[]).find((s) => this.byId(room.seats[s])?.bot);
      if (!side) return;
      const bot = this.byId(room.seats[side]) as Player;
      room.seats[side] = p.id;
      this.dropBot(bot);
    }
  }

  /** A bot takes a free seat (never someone's seat); with both taken it can't be added. */
  protected seatBot(p: Player): boolean {
    const room = this.room;
    const side = ([DARK, LIGHT] as Side[]).find((s) => !room.seats[s] || !this.byId(room.seats[s]));
    if (!side) return false;
    room.seats[side] = p.id;
    return true;
  }

  protected afterPresence(): void {
    const room = this.room;
    if (room.status !== 'lobby') return;
    for (const s of [DARK, LIGHT] as Side[]) if (room.seats[s] && !this.byId(room.seats[s])) room.seats[s] = null;
  }

  /** Look up the rating of someone who just sat down or came back, and show it once it arrives. */
  private loadRating(p: Player): void {
    if (!p.uid && !p.guest) return;
    this.ctx.later(async () => {
      const [info] = await this.ctx.ratings(GAME, [{ uid: p.uid, guest: p.guest }]);
      if (!info) return;
      p.rating = info;
      this.broadcast();
    });
  }

  protected listingRating(): number | null {
    const rated = this.room.players.filter((p) => p.connected && this.seatOf(p.id) && p.rating);
    return rated.length ? Math.round(rated.reduce((n, p) => n + (p.rating as RatingInfo).rating, 0) / rated.length) : null;
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
    else if (name === 'bot') this.botMove();
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
    for (const p of room.players) {
      p.inGame = Boolean(this.seatOf(p.id));
      p.ratingDelta = null;
    }
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

  /* ---------- Computer players ---------- */

  protected afterBroadcast(): void {
    const room = this.room;
    if (room.status !== 'play' || !room.board) return;
    const bot = this.byId(room.seats[room.turn as Side]);
    const key = `${room.game}:${room.moveSeq}`;
    if (!bot || !bot.bot) return;
    if (!room.players.some((p) => p.connected && !p.bot)) return;   // nobody here to play against: wait
    const stale = room.botAt && this.ctx.now() > room.botAt + 4000;   // the timer got lost
    if (room.botKey === key && !stale) return;
    const level = bot.botLevel || 'normal';
    room.botKey = key;
    room.botAt = this.ctx.now() + botDelay(level, this.rnd, 900, 2400);
    this.ctx.setTimer('bot', room.botAt);
  }

  private botMove(): void {
    const room = this.room;
    room.botAt = 0;
    if (room.status !== 'play' || !room.board) return;
    const bot = this.byId(room.seats[room.turn as Side]);
    if (!bot || !bot.bot || room.botKey !== `${room.game}:${room.moveSeq}`) return;
    const level = bot.botLevel || 'normal';
    const m = E.chooseMove(room.board, room.size, room.turn, level, { rnd: this.rnd, maxRoot: ROOT_CAP[room.size] || 3 });
    // The same move() a person goes through: it checks the seat, the turn and that the move is legal
    if (m >= 0) this.move(bot.id, m, room.moveSeq);
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
    this.rateGame(seated, winner, reason);
    this.broadcast();
  }

  /**
   * Skill ratings. A game counts when it was played out (even if it ended by resignation or a
   * claimed win, so leaving a lost game never saves your rating), as long as each side made at
   * least two moves, so an accidental start or an instant resign can't be used to feed points.
   * Games ended by the host ("End game for everyone") never reach this point. Seats that are
   * computer players (isBot) make the whole game unrated.
   */
  private rateGame(seated: Player[], winner: number, reason: string): void {
    const room = this.room;
    const moves = room.log.filter((l) => !(l as { pass?: boolean }).pass).length;
    if (seated.length !== 2 || (reason !== 'count' && moves < 4)) return;
    const game = room.game;
    const entries = seated.map((p) => ({ uid: p.uid, guest: p.guest, bot: p.isBot, place: !winner || winner === this.seatOf(p.id) ? 1 : 2 }));
    this.ctx.later(async () => {
      const changes = await this.ctx.rate(GAME, entries);
      seated.forEach((p, i) => {
        const c = changes[i];
        if (!c) return;
        p.rating = c;
        if (room.game === game) p.ratingDelta = c.delta;
      });
      this.broadcast();
    });
  }

  // What everyone may see (in this game nothing is secret)
  protected view(): Msg {
    const room = this.room;
    const now = this.ctx.now();
    return {
      t: 'state',
      code: room.code, solo: false, level: null, status: room.status, settings: room.settings, game: room.game, public: room.public,
      players: room.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost, isBot: Boolean(p.bot), botLevel: p.bot ? p.botLevel || 'normal' : null, photo: p.photo,
        connected: p.connected, away: p.away, games: p.games, wins: p.wins, draws: p.draws, matchWins: p.matchWins,
        rating: p.rating ? p.rating.rating : null, ratingProv: Boolean(p.rating?.provisional), ratingDelta: p.ratingDelta ?? null,
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
