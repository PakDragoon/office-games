// Guesstimate on the server: the host code from web/guesstimate/js/app.js, moved here. Every
// browser builds the same puzzles from the game seed; the server checks and scores the guesses
// and keeps them hidden until the reveal.
import * as R from '../../../web/guesstimate/js/rounds.js';
import type { GameModule, Msg, RoomCtx } from '../core/game';
import { type BaseRoom, reportPlayer, restoreSeats, type Seat, SeatRoom } from '../core/seats';

const GAME = 'guesstimate';
const MAX_PLAYERS = 8;
const COUNTDOWN_MS = 3000;

interface Settings { difficulty: string; kinds: string[]; laps: number; timer: number }
interface Player extends Seat {
  guesses: Record<number, unknown>;
  points: Record<number, number>;
}
interface Room extends BaseRoom<Player> {
  settings: Settings;
  gameSeed: number;
  index: number;
  total: number;
  startAt: number;
  deadline: number;
}

function cleanSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kinds = Array.isArray(r.kinds) ? R.KINDS.filter((k: string) => (r.kinds as unknown[]).includes(k)) : [...R.KINDS];
  return {
    difficulty: R.DIFFICULTIES.includes(r.difficulty as string) ? (r.difficulty as string) : 'normal',
    kinds: kinds.length ? kinds : [...R.KINDS],
    laps: [1, 2, 3].includes(r.laps as number) ? (r.laps as number) : 1,
    timer: [0, 20, 30, 45].includes(r.timer as number) ? (r.timer as number) : 30,
  };
}

const sum = (arr: number[]) => arr.reduce((n, x) => n + (x || 0), 0);
const sets = new Map<string, Array<Record<string, unknown>>>();
function roundsFor(seed: number, st: Settings) {
  const key = `${seed}:${st.difficulty}:${st.kinds.join(',')}:${st.laps}`;
  let set = sets.get(key);
  if (!set) {
    set = R.makeSet(seed, st.kinds, st.laps, st.difficulty) as Array<Record<string, unknown>>;
    if (sets.size > 200) sets.clear();
    sets.set(key, set);
  }
  return set;
}

class GuessRoom extends SeatRoom<Player, Room> {
  protected readonly gameId = GAME;
  protected readonly maxPlayers = MAX_PLAYERS;

  protected newSeat(base: Seat): Player {
    return { ...base, guesses: {}, points: {} };
  }

  protected afterPresence(): void {
    this.checkRound();
  }

  private rounds = () => roundsFor(this.room.gameSeed, this.room.settings);

  protected playerMessage(p: Player, msg: Msg): void {
    if (msg.t === 'guess') this.guess(p, msg.index, msg.guess);
  }

  protected hostMessage(_p: Player, msg: Msg): boolean {
    const room = this.room;
    switch (msg.t) {
      case 'settings':
        if (room.status === 'lobby') {
          room.settings = cleanSettings(msg.settings);
          this.broadcast();
        }
        return true;
      case 'start':
        if (typeof msg.crew === 'string' && msg.crew.trim() !== (room.crew ? room.crew.name : '')) this.setCrew(msg.crew);
        this.startGame(msg.settings);
        return true;
      case 'next':
        this.next();
        return true;
      case 'reveal':
        this.reveal();
        return true;
      case 'lobby':
        this.ctx.clearTimer('deadline');
        room.status = 'lobby';
        room.players = room.players.filter((p) => p.connected);
        this.broadcast();
        return true;
      default:
        return false;
    }
  }

  protected gameTimer(name: string): void {
    if (name === 'deadline') this.reveal();
  }

  private startGame(settings: unknown): void {
    const room = this.room;
    if (settings) room.settings = cleanSettings(settings);
    room.gameSeed = R.randomSeed();
    room.total = room.settings.kinds.length * room.settings.laps;
    room.index = 0;
    room.game++;
    room.players = room.players.filter((p) => p.connected);
    for (const p of room.players) Object.assign(p, { guesses: {}, points: {}, inGame: true });
    this.ctx.track('game_started', { players: room.players.length, rounds: room.total, difficulty: room.settings.difficulty });
    this.startRound();
  }

  private startRound(): void {
    const room = this.room;
    this.ctx.clearTimer('deadline');
    room.status = 'playing';
    room.startAt = this.ctx.now() + COUNTDOWN_MS;
    // Timing rounds get extra room so a long target can still be counted out
    const limit = R.answerSeconds(this.rounds()[room.index], room.settings.timer);
    room.deadline = limit ? room.startAt + limit * 1000 : 0;
    if (room.deadline) this.ctx.setTimer('deadline', room.deadline + 900);
    this.broadcast();
  }

  private guess(p: Player, index: unknown, guess: unknown): void {
    const room = this.room;
    if (room.status !== 'playing' || index !== room.index || p.guesses[room.index] !== undefined) return;
    if (!R.validGuess(this.rounds()[room.index], guess)) return;
    p.guesses[room.index] = guess;
    this.checkRound();
    this.broadcast();
  }

  // The round ends as soon as every connected player has locked in.
  private checkRound(): void {
    const room = this.room;
    if (room.status !== 'playing') return;
    const waiting = room.players.filter((p) => p.connected && !p.away && p.guesses[room.index] === undefined);
    if (!waiting.length) this.reveal();
  }

  private reveal(): void {
    const room = this.room;
    if (room.status !== 'playing') return;
    this.ctx.clearTimer('deadline');
    const pz = this.rounds()[room.index];
    for (const p of room.players) p.points[room.index] = R.score(pz, p.guesses[room.index] ?? null);
    room.status = 'reveal';
    this.broadcast();
  }

  private next(): void {
    const room = this.room;
    if (room.status !== 'reveal') return;
    if (room.index < room.total - 1) {
      room.index++;
      this.startRound();
    } else {
      this.finish();
    }
  }

  private finish(): void {
    const room = this.room;
    room.status = 'over';
    const view = this.view();
    const order = [...(view.players as Array<{ id: string; total: number; points: number[] }>)]
      .sort((a, b) => b.total - a.total || Math.max(...b.points, 0) - Math.max(...a.points, 0));
    const winnerId = order[0] && (order.length === 1 || order[0].total > order[1].total) ? order[0].id : null;
    this.ctx.track('game_finished', { rounds: room.total, players: order.length });
    this.saveGame(order.map((row, i) => {
      const p = this.byId(row.id) as Player;
      // Per test as well, so the stats can show how good you are at each one
      const perKind: Record<string, number> = {};
      this.rounds().forEach((pz, idx) => {
        const kind = String(pz.kind);
        perKind[`${kind}Points`] = (perKind[`${kind}Points`] || 0) + (p.points[idx] ?? 0);
        perKind[`${kind}Rounds`] = (perKind[`${kind}Rounds`] || 0) + 1;
      });
      return reportPlayer(p, i + 1, row.id === winnerId, { points: row.total, rounds: room.total, ...perKind });
    }), winnerId ? (this.byId(winnerId)?.name ?? null) : null);
    this.broadcast();
  }

  // What every player is allowed to see. Guesses stay hidden until the reveal.
  protected view(): Msg {
    const room = this.room;
    const now = this.ctx.now();
    const shown = room.status === 'lobby' ? 0 : room.status === 'playing' ? room.index : room.index + 1;
    const players = room.players.map((p) => {
      const points = Array.from({ length: shown }, (_, i) => p.points[i] ?? 0);
      return {
        id: p.id, name: p.name, color: p.color, isHost: p.isHost, photo: p.photo, connected: p.connected,
        away: p.away,
        locked: p.guesses[room.index] !== undefined,
        guess: room.status === 'reveal' || room.status === 'over' ? p.guesses[room.index] ?? null : undefined,
        points,
        total: sum(points),
      };
    });
    return {
      t: 'state',
      code: room.code, status: room.status, settings: room.settings, public: room.public,
      gameSeed: room.gameSeed, index: room.index, total: room.total,
      startsIn: room.status === 'playing' ? room.startAt - now : 0,
      endsIn: room.status === 'playing' && room.deadline ? room.deadline - now : 0,
      players,
      crewName: room.crew ? room.crew.name : '',
      crewStatus: room.crewStatus,
    };
  }
}

export const guesstimate: GameModule = {
  id: GAME,
  maxMsgBytes: 2048,
  rate: { perSec: 10, burst: 30 },
  create(ctx: RoomCtx, opts) {
    return new GuessRoom(ctx, {
      code: ctx.code, public: opts.public, status: 'lobby', game: 0, players: [], crew: null, crewStatus: '',
      settings: cleanSettings({}), gameSeed: 0, index: 0, total: 0, startAt: 0, deadline: 0,
    });
  },
  restore(ctx, snap) {
    const room = snap as Room;
    restoreSeats(ctx, room);
    return new GuessRoom(ctx, room);
  },
};
