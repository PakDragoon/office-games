// Fast Fingers rooms on the server: the host code from web/fast-fingers/js/app.js, moved here
// (practice still runs it in the browser). Each player's typing stays in their own page; the
// server checks every progress report (forward only, never faster than a person can type),
// times the race and ranks it.
import * as E from '../../../web/fast-fingers/js/engine.js';
import type { GameModule, Msg, RoomCtx } from '../core/game';
import { type BaseRoom, reportPlayer, restoreSeats, type Seat, SeatRoom } from '../core/seats';

const GAME = 'fast-fingers';
const BATCH_MS = 200;

type Settings = ReturnType<typeof E.cleanSettings>;
interface Run { pos: number; err: number; done: boolean; ms: number; place: number }
interface Result { id: string; pos: number; err: number; done: boolean; ms: number; wpm: number; acc: number; pct: number }

interface Player extends Seat {
  wins: number;
  best: number;
}

interface Room extends BaseRoom<Player> {
  settings: Settings;
  phase: string;
  phaseEnd: number;
  raceStart: number;
  passage: number;
  text: string;
  runs: Record<string, Run>;
  order: string[];
  used: number[];
  results: Result[] | null;
  winners: string[];
}

class FingersRoom extends SeatRoom<Player, Room> {
  protected readonly gameId = GAME;
  protected readonly maxPlayers = E.MAX_PLAYERS;

  protected newSeat(base: Seat): Player {
    return { ...base, wins: 0, best: 0 };
  }

  protected remap(from: string, to: string): void {
    const room = this.room;
    if (room.runs[from]) { room.runs[to] = room.runs[from]; delete room.runs[from]; }
    room.order = room.order.map((x) => (x === from ? to : x));
    room.winners = room.winners.map((x) => (x === from ? to : x));
    if (room.results) for (const r of room.results) if (r.id === from) r.id = to;
  }

  // Someone left or went quiet: the race may not need to wait for them any more
  protected afterPresence(): void {
    if (this.room.status === 'play' && this.room.phase === 'race') this.checkDone();
  }

  protected playerMessage(p: Player, msg: Msg): void {
    if (msg.t === 'prog') this.progress(p.id, msg);
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
      case 'start':
        if (room.status === 'lobby') {
          if (msg.settings) room.settings = E.cleanSettings(msg.settings);
          if (typeof msg.crew === 'string' && msg.crew.trim() !== (room.crew ? room.crew.name : '')) this.setCrew(msg.crew);
        }
        this.startGame(p, msg.same === true);
        return true;
      case 'endRace':
        this.endRace();
        return true;
      case 'lobby':
        this.ctx.clearTimer('phase');
        Object.assign(room, { status: 'lobby', phase: '' });
        room.players = room.players.filter((x) => x.connected);
        for (const x of room.players) x.inGame = false;
        this.broadcast();
        return true;
      default:
        return false;
    }
  }

  protected gameTimer(name: string): void {
    const room = this.room;
    if (name === 'soon') return this.broadcast();
    if (name !== 'phase') return;
    if (room.phase === 'countdown') this.go();
    else if (room.phase === 'race') this.endRace();
  }

  private startGame(_by: Player, samePassage: boolean): void {
    const room = this.room;
    if (room.status === 'play') return;
    const players = room.players.filter((p) => p.connected);
    if (players.length < 1) return;
    room.players = players;
    for (const p of room.players) p.inGame = true;
    const used = new Set(room.used);
    if (!samePassage || room.passage < 0) room.passage = E.pickPassage(() => this.ctx.random(), used);
    if (!used.has(room.passage)) room.used.push(room.passage);
    room.text = E.makeText(room.passage, room.settings);
    room.runs = {};
    room.order = [];
    for (const p of room.players) room.runs[p.id] = { pos: 0, err: 0, done: false, ms: 0, place: 0 };
    Object.assign(room, { status: 'play', game: room.game + 1, results: null, winners: [], phase: 'countdown' });
    room.phaseEnd = this.ctx.now() + E.TIMES.countdownMs;
    this.ctx.setTimer('phase', room.phaseEnd);
    this.ctx.track('game_started', { players: room.players.length, length: String(room.settings.length) });
    this.broadcast();
  }

  private go(): void {
    const room = this.room;
    if (room.status !== 'play' || room.phase !== 'countdown') return;
    room.phase = 'race';
    room.raceStart = this.ctx.now();
    room.phaseEnd = room.raceStart + E.limitMs(room.text);
    this.ctx.setTimer('phase', room.phaseEnd);
    this.broadcast();
    this.checkDone();
  }

  private progress(pid: string, msg: Msg): void {
    const room = this.room;
    if (room.status !== 'play' || room.phase !== 'race') return;
    const run = room.runs[pid];
    if (!run || run.done) return;
    const len = room.text.length;
    const now = this.ctx.now();
    const elapsed = now - room.raceStart;
    const pos = Math.min(len, Math.floor(Number(msg.pos)));
    const err = Math.floor(Number(msg.err));
    if (!(pos >= run.pos) || !(err >= 0)) return;
    if (!E.plausible(pos, elapsed)) return;      // nobody types that fast
    run.pos = pos;
    run.err = Math.min(9999, Math.max(run.err, err));
    if (pos >= len) {
      const mine = Number(msg.ms);
      // The player's own clock is used when it agrees with the server's (it's free of network delay)
      const agrees = Number.isFinite(mine) && mine > 0 && mine <= elapsed + 250 && mine >= elapsed - 2500;
      run.ms = Math.max(Math.round(agrees ? mine : elapsed), Math.ceil((len / E.MAX_CPS) * 1000));
      run.done = true;
      room.order.push(pid);
      run.place = room.order.length;
      if (run.place === 1) {
        // The first finish starts the clock on everyone else
        room.phaseEnd = Math.min(room.phaseEnd, now + E.graceMs(run.ms));
        this.ctx.setTimer('phase', room.phaseEnd);
      }
      this.ctx.clearTimer('soon');
      this.broadcast();
      this.checkDone();
      return;
    }
    // Progress arrives a couple of times a second from every player: send it on in batches
    this.ctx.dirty();
    this.ctx.setTimer('soon', now + BATCH_MS);
  }

  // The race ends when everyone still here has finished (or time runs out)
  private checkDone(): void {
    const room = this.room;
    if (room.status !== 'play' || room.phase !== 'race') return;
    const waiting = room.players.filter((p) => room.runs[p.id] && !room.runs[p.id].done && this.active(p));
    if (!waiting.length) {
      room.phaseEnd = this.ctx.now() + E.TIMES.endPauseMs;
      this.ctx.setTimer('phase', room.phaseEnd);
    }
  }

  private endRace(): void {
    const room = this.room;
    if (room.status !== 'play' || room.phase !== 'race') return;
    this.ctx.clearTimer('phase');
    this.ctx.clearTimer('soon');
    const elapsed = this.ctx.now() - room.raceStart;
    const len = room.text.length;
    const rows = room.players.filter((p) => room.runs[p.id]).map((p) => {
      const r = room.runs[p.id];
      const ms = r.done ? r.ms : elapsed;
      return { id: p.id, pos: r.pos, err: r.err, done: r.done, ms, wpm: E.wpm(r.pos, ms), acc: E.accuracy(r.pos, r.err), pct: Math.floor((r.pos / len) * 100) };
    });
    room.results = E.rank(rows) as Result[];
    const top = room.results[0];
    room.winners = top && top.pos > 0 ? [top.id] : [];
    for (const r of room.results) {
      const p = this.byId(r.id);
      if (!p) continue;
      if (room.winners.includes(p.id)) p.wins++;
      if (r.done) p.best = Math.max(p.best, r.wpm);
    }
    Object.assign(room, { status: 'over', phase: '', phaseEnd: 0 });
    this.ctx.track('game_finished', { players: rows.length });
    this.saveGame(room.results.map((r, i) => {
      const p = this.byId(r.id) as Player;
      return reportPlayer(p, i + 1, room.winners.includes(r.id), { finished: r.done ? 1 : 0, chars: r.pos }, r.done ? { bestWpm: r.wpm } : undefined);
    }), room.winners.length ? (this.byId(room.winners[0])?.name ?? null) : null);
    this.broadcast();
  }

  /* ---------- What everyone sees (there are no secrets in a typing race) ---------- */
  protected view(): Msg {
    const room = this.room;
    const now = this.ctx.now();
    const playing = room.status !== 'lobby';
    return {
      t: 'state',
      code: room.code, solo: null, status: room.status, settings: room.settings, game: room.game, phase: room.phase, public: room.public,
      phaseLeft: room.phaseEnd ? room.phaseEnd - now : 0,
      elapsed: room.phase === 'race' ? now - room.raceStart : 0,
      text: playing ? room.text : '',
      players: room.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost, photo: p.photo, connected: p.connected, away: p.away,
        inGame: p.inGame, wins: p.wins, best: p.best, g: playing && room.runs[p.id] ? room.runs[p.id] : null,
      })),
      results: room.status === 'over' ? room.results : null,
      winners: room.status === 'over' ? room.winners : [],
      crewName: room.crew ? room.crew.name : '',
      crewStatus: room.crewStatus,
    };
  }
}

export const fastFingers: GameModule = {
  id: GAME,
  maxMsgBytes: 512,
  rate: { perSec: 8, burst: 24 },
  create(ctx: RoomCtx, opts) {
    return new FingersRoom(ctx, {
      code: ctx.code, public: opts.public, status: 'lobby', game: 0, players: [], crew: null, crewStatus: '',
      settings: E.cleanSettings({}), phase: '', phaseEnd: 0, raceStart: 0, passage: -1, text: '', runs: {}, order: [],
      used: [], results: null, winners: [],
    });
  },
  restore(ctx, snap) {
    const room = snap as Room;
    restoreSeats(ctx, room);
    return new FingersRoom(ctx, room);
  },
};
