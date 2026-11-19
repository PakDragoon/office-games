// Ludo rooms on the server. Four coloured seats (people or bots); everyone else watches. The server rolls
// every die, checks every move with the rules in web/ludo/js/engine.js, runs the turn timer and plays for
// anyone who has gone quiet, so a game never stalls.
import * as E from '../../../web/ludo/js/engine.js';
import { botDelay } from '../core/bots';
import type { GameModule, Msg, RoomCtx } from '../core/game';
import { type BaseRoom, reportPlayer, restoreSeats, type Seat, SeatRoom } from '../core/seats';

const GAME = 'ludo';
const REACTIONS = ['👏', '😮', '😂', '😬', '🔥', '🤝'];

type Settings = ReturnType<typeof E.cleanSettings>;
interface Move { c: number; i: number; r: number; v: number; from: number; to: number; path: number[]; cap: Array<{ c: number; i: number }>; home: boolean }
interface ColourStats { rolls: number; sixes: number; captures: number; captured: number; home: number }
/** The game itself (see newGame in the rules file); saved in the room snapshot as it is. */
interface Game {
  settings: Settings;
  colours: number[];
  tokens: Record<number, number[]>;
  stats: Record<number, ColourStats>;
  turn: number;
  phase: 'roll' | 'move' | 'pass' | 'over';
  roll: number;
  rolls: number[];
  extra: boolean;
  sixes: number;
  passWhy: string;
  legal: Move[];
  killed: Record<number, boolean>;
  done: number[];
  seq: number;
  events: unknown[];
  result: { order: number[]; winners: number[]; places: Record<number, number> } | null;
}

interface Player extends Seat {
  games: number;
  wins: number;
  /** The computer plays this person's turns (they went quiet too often, or left) until they act again. */
  autoplay: boolean;
  reactAt: number;
}

interface Room extends BaseRoom<Player> {
  settings: Settings;
  /** Who sits at each colour (0 … 3), by player id. */
  seats: Array<string | null>;
  g: Game | null;
  /** Deadline of the room's turn timer for the current roll or move (0: none). */
  turnEnd: number;
  /** No turn timer: when a person who does nothing is played for (0: none). */
  idleEnd: number;
  /** Turns played for each person in a row (player id -> count); acting themselves clears it. */
  strikes: Record<string, number>;
  result: { order: number[]; winners: number[]; places: Record<number, number>; names: Record<number, string>; ids: Array<string | null> } | null;
  /** The computer's next action (a bot, or someone it plays for) is planned for this time, for this game and step. */
  botAt: number;
  botKey: string;
}

class LudoRoom extends SeatRoom<Player, Room> {
  protected readonly gameId = GAME;
  protected readonly maxPlayers = E.MAX_PLAYERS;
  protected botSupport = true;
  private rnd = () => this.ctx.random();

  protected newSeat(base: Seat): Player {
    return { ...base, games: 0, wins: 0, autoplay: false, reactAt: 0 };
  }

  protected remap(from: string, to: string): void {
    const room = this.room;
    room.seats = room.seats.map((s) => (s === from ? to : s));
    if (room.strikes[from] !== undefined) { room.strikes[to] = room.strikes[from]; delete room.strikes[from]; }
    if (room.result) room.result.ids = room.result.ids.map((s) => (s === from ? to : s));
  }

  private seatOf = (id: string): number => this.room.seats.indexOf(id);
  private freeSeat(): number {
    return E.SEAT_ORDER.find((s: number) => !this.room.seats[s] || !this.byId(this.room.seats[s])) ?? -1;
  }

  // In the lobby a newcomer takes a free colour (two players end up opposite each other); mid-game they watch
  protected seated(p: Player, rejoin: boolean): void {
    const room = this.room;
    if (rejoin || room.status !== 'lobby' || this.seatOf(p.id) >= 0) return;
    const free = this.freeSeat();
    if (free >= 0) {
      room.seats[free] = p.id;
      return;
    }
    // Every colour taken: a bot gives its seat to the person who just came in
    const s = [...E.SEAT_ORDER].reverse().find((k: number) => this.byId(room.seats[k])?.bot);
    if (s === undefined) return;
    const bot = this.byId(room.seats[s]) as Player;
    room.seats[s] = p.id;
    this.dropBot(bot);
  }

  protected seatBot(p: Player): boolean {
    const free = this.freeSeat();
    if (free < 0) return false;
    this.room.seats[free] = p.id;
    return true;
  }

  protected afterPresence(): void {
    const room = this.room;
    if (room.status !== 'lobby') return;
    room.seats = room.seats.map((s) => (s && this.byId(s) ? s : null));
  }

  protected offlineOutMs(): number {
    return E.TIMES.offlineOutMs;
  }

  /** Gone for good mid-game: the computer plays their colour from now on (they can come back and take over). */
  protected goneForGood(p: Player): void {
    p.autoplay = true;
  }

  // Quick Play counts the four colours: watchers don't fill the room and a bot's seat is free for a person
  protected listingSeats(): { players: number; max: number } {
    const people = this.room.seats.filter((id) => {
      const p = this.byId(id);
      return p && p.connected && !p.bot;
    }).length;
    return { players: people, max: E.SEATS };
  }

  protected playerMessage(p: Player, msg: Msg): void {
    const room = this.room;
    switch (msg.t) {
      case 'roll': return this.roll(p.id, msg.seq);
      case 'move': return this.move(p.id, Number(msg.c), Number(msg.i), msg.seq, false, typeof msg.r === 'number' ? msg.r : undefined);
      case 'back':
        // "I'm back": the computer stops playing for me
        if (p.autoplay || room.strikes[p.id]) {
          p.autoplay = false;
          delete room.strikes[p.id];
          this.afterTurn();
        }
        return;
      case 'sit': {
        const seat = Number(msg.seat);
        if (room.status !== 'lobby' || !(seat >= 0 && seat < E.SEATS)) return;
        const holder = this.byId(room.seats[seat]);
        if (holder && holder.id !== p.id) return;
        room.seats = room.seats.map((s) => (s === p.id ? null : s));
        room.seats[seat] = p.id;
        return this.broadcast();
      }
      case 'stand':
        if (room.status !== 'lobby') return;
        room.seats = room.seats.map((s) => (s === p.id ? null : s));
        return this.broadcast();
      case 'react': {
        if (!REACTIONS.includes(msg.e as string)) return;
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
      case 'seat': {
        // The host moves anyone (a bot too) to a free colour
        const who = this.byId(typeof msg.id === 'string' ? msg.id : null);
        const seat = Number(msg.seat);
        if (room.status !== 'lobby' || !who || !(seat >= 0 && seat < E.SEATS)) return true;
        const holder = this.byId(room.seats[seat]);
        const from = this.seatOf(who.id);
        if (holder && holder.id !== who.id) {
          // Swap the two
          if (from < 0) return true;
          room.seats[from] = holder.id;
        } else if (from >= 0) room.seats[from] = null;
        room.seats[seat] = who.id;
        this.broadcast();
        return true;
      }
      case 'start':
        this.startGame(p, msg);
        return true;
      case 'lobby':
        this.ctx.clearTimer('turn');
        this.ctx.clearTimer('step');
        this.ctx.clearTimer('bot');
        Object.assign(room, { status: 'lobby', g: null, turnEnd: 0, idleEnd: 0, botAt: 0, botKey: '', result: null });
        room.players = room.players.filter((x) => x.connected);
        for (const x of room.players) { x.autoplay = false; x.inGame = false; }
        room.strikes = {};
        this.afterPresence();
        this.broadcast();
        return true;
      default:
        return false;
    }
  }

  protected gameTimer(name: string): void {
    if (name === 'turn') this.timeUp();
    else if (name === 'step') this.step();
    else if (name === 'bot') this.botAct();
  }

  /** The seats that can play: someone (a person here, or a bot) sits there. */
  private ready(): number[] {
    return [0, 1, 2, 3].filter((s) => {
      const p = this.byId(this.room.seats[s]);
      return Boolean(p && (p.bot || p.connected));
    });
  }

  private startGame(by: Player, msg: Msg): void {
    const room = this.room;
    if (room.status === 'play') return;
    if (room.status === 'lobby') {
      if (msg.settings) room.settings = E.cleanSettings(msg.settings);
      if (typeof msg.crew === 'string' && msg.crew.trim() !== (room.crew ? room.crew.name : '')) this.setCrew(msg.crew);
    }
    const colours = this.ready();
    if (colours.length < E.MIN_PLAYERS) {
      this.tell(by.id, { t: 'toast', text: room.status === 'lobby' ? 'Ludo needs at least 2 players (add a bot?)' : 'Players have left. Change settings to pick who plays.' });
      return;
    }
    if (room.settings.teams && colours.length !== 4) {
      this.tell(by.id, { t: 'toast', text: 'Teams need all four colours filled' });
      return;
    }
    // Seats nobody can play any more (left after the last game) are cleared
    room.seats = room.seats.map((s, k) => (colours.includes(k) ? s : null));
    for (const p of room.players) {
      p.inGame = this.seatOf(p.id) >= 0;
      p.autoplay = false;
    }
    const first = colours[Math.floor(this.rnd() * colours.length)];
    Object.assign(room, {
      status: 'play', g: E.newGame(room.settings, colours, first) as Game, result: null, game: room.game + 1, strikes: {}, botAt: 0, botKey: '',
    });
    this.ctx.track('game_started', { players: colours.length, teams: room.settings.teams ? 1 : 0 });
    this.afterTurn();
  }

  /** The person or bot at the colour whose turn it is. */
  private controller(): Player | undefined {
    const g = this.room.g;
    return g ? this.byId(this.room.seats[g.turn]) : undefined;
  }

  /** Played by the computer right now: a bot, someone it plays for, someone Away, or gone a few seconds. */
  private robotic(p: Player | undefined): boolean {
    if (!p) return true;
    return Boolean(p.bot || p.autoplay || p.away || (!p.connected && this.ctx.now() - p.offlineAt > 6000));
  }

  // After every roll and move (and at the start): the turn timer or idle deadline for a person, the pause
  // after "no move", then everyone gets the new state (afterBroadcast plans the computer's next action).
  private afterTurn(): void {
    const room = this.room;
    const g = room.g;
    this.ctx.clearTimer('turn');
    room.turnEnd = 0;
    room.idleEnd = 0;
    if (room.status === 'play' && g) {
      const now = this.ctx.now();
      if (g.phase === 'pass') this.ctx.setTimer('step', now + E.TIMES.passMs);
      else {
        const p = this.controller();
        if (p && !p.bot && !p.autoplay) {
          const ms = E.timerMs(room.settings);
          if (ms) room.turnEnd = now + ms + (g.phase === 'move' ? 700 : 0);   // a moment for the die to land
          else room.idleEnd = now + E.TIMES.idleMs;
          this.ctx.setTimer('turn', (room.turnEnd || room.idleEnd) + 60);
        }
      }
    }
    this.broadcast();
  }

  protected afterBroadcast(): void {
    const room = this.room;
    const g = room.g;
    if (room.status !== 'play' || !g || (g.phase !== 'roll' && g.phase !== 'move')) return;
    if (!room.players.some((p) => p.connected && !p.bot)) return;   // nobody here to watch: wait
    const p = this.controller();
    const robot = this.robotic(p);
    // A person with only one possible move: it is played for them a moment after the die lands
    const single = !robot && g.phase === 'move' && E.distinctMoves(g.legal).length === 1;
    const offlineSoon = p && !p.connected && !p.bot && !robot;
    if (!robot && !single && !offlineSoon) return;
    const key = `${room.game}:${g.seq}`;
    const stale = room.botAt && this.ctx.now() > room.botAt + 4000;   // the timer got lost
    if (room.botKey === key && !stale) return;
    const now = this.ctx.now();
    let at: number;
    if (offlineSoon) at = (p as Player).offlineAt + 6100;   // a refresh gets a few seconds to come back
    else if (single) at = now + E.TIMES.autoMoveMs;
    else if (p?.bot) at = now + botDelay(p.botLevel || 'normal', this.rnd, g.phase === 'roll' ? 650 : 900, g.phase === 'roll' ? 1300 : 1600);
    else at = now + 900;
    room.botKey = key;
    room.botAt = Math.max(at, now + 200);
    this.ctx.setTimer('bot', room.botAt);
  }

  private botAct(): void {
    const room = this.room;
    const g = room.g;
    room.botAt = 0;
    if (room.status !== 'play' || !g || room.botKey !== `${room.game}:${g.seq}`) return;
    const p = this.controller();
    if (!p) return;
    if (!this.robotic(p)) {
      // Only the single possible move is played for a person who is here
      if (g.phase === 'move' && E.distinctMoves(g.legal).length === 1) this.move(p.id, g.legal[0].c, g.legal[0].i, g.seq, true, g.legal[0].r);
      else if (!p.connected) this.afterBroadcast();   // still offline: plan again
      return;
    }
    this.autoAct(p);
  }

  /** The computer takes this player's roll or move (through the same roll() / move() as a person). */
  private autoAct(p: Player): void {
    const g = this.room.g;
    if (!g) return;
    if (g.phase === 'roll') return this.roll(p.id, g.seq, true);
    if (g.phase !== 'move') return;
    const level = p.bot ? p.botLevel || 'normal' : 'normal';
    const m = E.chooseMove(g, level, this.rnd) as Move | null;
    if (m) this.move(p.id, m.c, m.i, g.seq, true, m.r);
  }

  /** A person ran out of time: the computer plays this step for them; enough in a row and it keeps playing for them. */
  private timeUp(): void {
    const room = this.room;
    const g = room.g;
    if (room.status !== 'play' || !g || !(room.turnEnd || room.idleEnd)) return;
    const p = this.controller();
    if (!p) return;
    if (!p.bot) {
      const n = (room.strikes[p.id] || 0) + 1;
      room.strikes[p.id] = n;
      if (n >= E.TIMES.idleStrikes) p.autoplay = true;
    }
    this.autoAct(p);
  }

  private step(): void {
    const g = this.room.g;
    if (this.room.status !== 'play' || !g || g.phase !== 'pass') return;
    E.pass(g);
    this.afterTurn();
  }

  private mayAct(pid: string, seq: unknown): boolean {
    const room = this.room;
    const g = room.g;
    if (room.status !== 'play' || !g || room.seats[g.turn] !== pid) return false;
    return seq === undefined || seq === g.seq;   // a stale click from before the last roll or move
  }

  private acted(pid: string, auto: boolean): void {
    if (auto) return;
    const p = this.byId(pid);
    delete this.room.strikes[pid];   // they played themselves: the count starts over
    if (p) p.autoplay = false;
  }

  private roll(pid: string, seq: unknown, auto = false): void {
    const g = this.room.g;
    if (!g || !this.mayAct(pid, seq) || g.phase !== 'roll') return;
    this.acted(pid, auto);
    E.roll(g, E.die(this.rnd()));
    this.afterTurn();
  }

  private move(pid: string, c: number, i: number, seq: unknown, auto = false, r?: number): void {
    const g = this.room.g;
    if (!g || !this.mayAct(pid, seq) || g.phase !== 'move') return;
    if (!E.move(g, c, i, r)) return;
    this.acted(pid, auto);
    if ((g.phase as string) === 'over') return this.gameOver();
    this.afterTurn();
  }

  private gameOver(): void {
    const room = this.room;
    const g = room.g;
    if (!g || !g.result) return;
    this.ctx.clearTimer('turn');
    this.ctx.clearTimer('bot');
    room.status = 'over';
    room.turnEnd = room.idleEnd = 0;
    const { order, winners, places } = g.result;
    const names: Record<number, string> = {};
    const seated: Array<{ p: Player; c: number }> = [];
    for (const c of g.colours) {
      const p = this.byId(room.seats[c]);
      names[c] = p ? p.name : E.COLOUR_NAMES[c];
      if (!p) continue;
      seated.push({ p, c });
      p.games++;
      if (winners.includes(c)) p.wins++;
    }
    room.result = { order, winners, places, names, ids: [...room.seats] };
    this.ctx.track('game_finished', { players: g.colours.length, teams: g.settings.teams ? 1 : 0 });
    const winnerName = winners.map((c: number) => names[c]).join(' & ') || null;
    this.saveGame(seated.map(({ p, c }) => {
      const st = g.stats[c];
      return reportPlayer(p, places[c], winners.includes(c), {
        captures: st.captures, captured: st.captured, home: st.home, sixes: st.sixes, rolls: st.rolls,
      });
    }), winnerName);
    this.broadcast();
  }

  // Nothing in Ludo is secret: everyone gets the same view
  protected view(): Msg {
    const room = this.room;
    const now = this.ctx.now();
    const g = room.g;
    return {
      t: 'state',
      code: room.code, status: room.status, settings: room.settings, game: room.game, public: room.public,
      players: room.players.map((p) => ({
        id: p.id, name: p.name, isHost: p.isHost, bot: Boolean(p.bot), botLevel: p.bot ? p.botLevel || 'normal' : null, photo: p.photo,
        connected: p.connected, away: p.away, games: p.games, wins: p.wins, autoplay: p.autoplay, inGame: p.inGame,
        seat: this.seatOf(p.id), strikes: room.strikes[p.id] || 0,
      })),
      seats: [...room.seats],
      g: g ? {
        settings: g.settings, colours: g.colours, tokens: g.tokens, turn: g.turn, phase: g.phase, roll: g.roll, rolls: g.rolls, sixes: g.sixes,
        passWhy: g.passWhy, legal: g.legal, killed: g.killed, done: g.done, seq: g.seq, events: g.events, stats: g.stats,
      } : null,
      turnLeft: room.turnEnd ? room.turnEnd - now : null,
      turnMs: E.timerMs(room.settings),
      idleLeft: room.idleEnd ? room.idleEnd - now : null,
      maxStrikes: E.TIMES.idleStrikes,
      result: room.status === 'over' ? room.result : null,
      crewName: room.crew ? room.crew.name : '',
      crewStatus: room.crewStatus,
    };
  }
}

export const ludo: GameModule = {
  id: GAME,
  maxMsgBytes: 512,
  rate: { perSec: 8, burst: 20 },
  create(ctx: RoomCtx, opts) {
    return new LudoRoom(ctx, {
      code: ctx.code, public: opts.public, status: 'lobby', game: 0, players: [], crew: null, crewStatus: '',
      settings: E.cleanSettings({}), seats: [null, null, null, null], g: null, turnEnd: 0, idleEnd: 0, strikes: {},
      result: null, botAt: 0, botKey: '', replayId: null,
    });
  },
  restore(ctx, snap) {
    const room = snap as Room;
    restoreSeats(ctx, room);
    if (room.status === 'lobby') room.seats = room.seats.map((s) => (s && room.players.some((p) => p.id === s) ? s : null));
    return new LudoRoom(ctx, room);
  },
};
