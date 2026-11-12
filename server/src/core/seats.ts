// What every room game shares: seats, taking a seat back after a refresh, the host role
// passing on when the host leaves, Away detection, crews, and sending everyone the view.
// A game extends SeatRoom and supplies its own rules, view and messages.
import type { GameInstance, GameReport, Msg, RoomCtx } from './game';
import { cleanName, cleanPhoto } from './util';

export const AWAY_MS = 9000;
export const PRESENCE_MS = 3000;

export interface Seat {
  id: string;
  name: string;
  isHost: boolean;
  color: number;
  uid: string | null;
  guest: string | null;
  photo: string;
  clientId: string;
  connected: boolean;
  away: boolean;
  offlineAt: number;
  inGame: boolean;
}

export interface BaseRoom<P extends Seat> {
  code: string;
  public: boolean;
  status: string;
  game: number;
  players: P[];
  crew: { name: string } | null;
  crewStatus: string;
}

export const baseSeat = (ctx: RoomCtx, id: string, name: string, color: number): Seat => {
  const ident = ctx.identity(id);
  return {
    id, name, isHost: false, color, uid: ident.uid, guest: ident.guest, photo: '', clientId: '',
    connected: true, away: false, offlineAt: 0, inGame: false,
  };
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export abstract class SeatRoom<P extends Seat, R extends BaseRoom<P>> implements GameInstance {
  constructor(protected ctx: RoomCtx, protected room: R) {}

  protected abstract readonly gameId: string;
  protected abstract readonly maxPlayers: number;
  /** A new seat with the game's own fields added. */
  protected abstract newSeat(base: Seat): P;
  /** The public view everyone gets (or the view for one player when the game hides things per player). */
  protected abstract view(forId: string | null): Msg;
  /** A message from a seated player (host or not). Host-only messages arrive in hostMessage instead. */
  protected abstract playerMessage(p: P, msg: Msg): void;
  /** A message only the host may send. Return false if it isn't one. */
  protected abstract hostMessage(p: P, msg: Msg): boolean;
  /** Point the game's own references from a seat's old id to its new id (rejoin). */
  protected remap(_oldId: string, _newId: string): void {}
  /** Someone sat down or came back: send them anything private (their card, the drawing...). */
  protected seated(_p: P, _rejoin: boolean): void {}
  /** Someone left, went quiet or came back: don't let the game wait for them. */
  protected afterPresence(_p: P): void {}
  /** A player gone this long during a game is out for good (0: never). */
  protected offlineOutMs(): number {
    return 0;
  }
  protected goneForGood(_p: P): void {}
  /** Whether each player gets their own view (secrets in the view itself). */
  protected perPlayerView = false;
  /** Statuses in which presence is checked every few seconds. */
  protected watching(): boolean {
    return this.room.status !== 'lobby';
  }

  protected byId = (id: string | null | undefined): P | undefined => this.room.players.find((p) => p.id === id);
  protected active = (p: P) => p.connected && !p.away;
  protected inGame = () => this.room.players.filter((p) => p.inGame);

  protected freeColor(): number {
    const used = new Set(this.room.players.map((p) => p.color));
    for (let c = 0; c < this.maxPlayers; c++) if (!used.has(c)) return c;
    return 0;
  }

  protected ensureHost(): void {
    const host = this.room.players.find((p) => p.isHost);
    if (host && host.connected) return;
    const next = this.room.players.find((p) => p.connected);
    if (!next) return;
    if (host) host.isHost = false;
    next.isHost = true;
  }

  /* ---------- GameInstance ---------- */

  join(connId: string, msg: Msg): void {
    const room = this.room;
    const name = cleanName(msg.name) || 'Player';
    const ident = this.ctx.identity(connId);
    const clientId = typeof msg.client === 'string' ? msg.client.slice(0, 40) : '';
    const photo = ident.uid ? cleanPhoto(msg.photo) || cleanPhoto(ident.photo) : '';
    // Same tab (refresh), same account, or an offline seat with this name: take the seat back.
    const old = room.players.find((p) => p.name.toLowerCase() === name.toLowerCase()
      && ((clientId && p.clientId === clientId) || (ident.uid && p.uid === ident.uid) || !p.connected));
    if (old) {
      const oldId = old.id;
      if (oldId !== connId) {
        this.ctx.close(oldId, 'replaced');
        this.remap(oldId, connId);
      }
      Object.assign(old, {
        id: connId, connected: true, away: false, offlineAt: 0, clientId: clientId || old.clientId,
        uid: ident.uid || old.uid, guest: ident.guest || old.guest, photo: photo || old.photo,
      });
      this.ensureHost();
      this.ctx.send(connId, { t: 'welcome', id: connId, code: room.code });
      this.seated(old, true);
      this.afterPresence(old);
      this.broadcast();
      return;
    }
    if (room.players.length >= this.maxPlayers) room.players = room.players.filter((p) => p.connected);
    if (room.players.length >= this.maxPlayers) return this.reject(connId, `This room is full (${this.maxPlayers} players).`);
    let finalName = name;
    for (let n = 2; room.players.some((p) => p.name.toLowerCase() === finalName.toLowerCase()); n++) finalName = `${name} ${n}`;
    const seat = this.newSeat({ ...baseSeat(this.ctx, connId, finalName, this.freeColor()), clientId, photo });
    room.players.push(seat);   // joined mid-game: watches until the next game
    this.ensureHost();
    this.ctx.send(connId, { t: 'welcome', id: connId, code: room.code });
    this.ctx.track('room_joined');
    this.seated(seat, false);
    this.broadcast();
  }

  protected reject(connId: string, reason: string): void {
    this.ctx.send(connId, { t: 'reject', reason });
    this.ctx.close(connId, 'rejected');
  }

  message(connId: string, msg: Msg): void {
    const p = this.byId(connId);
    if (!p) return;
    if (p.away) {
      p.away = false;
      this.afterPresence(p);
      this.broadcast();
    }
    if (p.isHost) {
      if (msg.t === 'crew') return this.setCrew(msg.name);
      if (msg.t === 'public') {
        // Open to Quick Play or private: the host can flip it in the lobby only
        if (this.room.status === 'lobby' && typeof msg.on === 'boolean' && msg.on !== this.room.public) {
          this.room.public = msg.on;
          this.broadcast();
        }
        return;
      }
      if (this.hostMessage(p, msg)) return;
    }
    this.playerMessage(p, msg);
  }

  close(connId: string): void {
    const room = this.room;
    const p = this.byId(connId);
    if (!p) return;
    if (room.status === 'lobby') room.players = room.players.filter((x) => x !== p);
    else Object.assign(p, { connected: false, offlineAt: this.ctx.now() });
    this.ensureHost();
    this.afterPresence(p);
    this.broadcast();
  }

  occupied(): boolean {
    return this.room.players.some((p) => p.connected);
  }

  timer(name: string): void {
    if (name === 'presence') return this.presence();
    this.gameTimer(name);
  }

  protected abstract gameTimer(name: string): void;

  /** Start (or keep) the few-second presence check while a game is on. */
  protected watchPresence(): void {
    if (this.watching()) this.ctx.setTimer('presence', this.ctx.now() + PRESENCE_MS);
    else this.ctx.clearTimer('presence');
  }

  private presence(): void {
    if (!this.watching()) return;
    const now = this.ctx.now();
    let changed = false;
    const outMs = this.offlineOutMs();
    for (const p of this.room.players) {
      if (p.connected) {
        const seen = this.ctx.lastSeen(p.id);
        if (!seen) {
          // The socket is gone without a close event (the room restarted): treat as left
          Object.assign(p, { connected: false, offlineAt: now });
          changed = true;
          this.ensureHost();
          this.afterPresence(p);
          continue;
        }
        const away = now - seen > AWAY_MS;
        if (away !== p.away) {
          p.away = away;
          changed = true;
          this.afterPresence(p);
        }
      } else if (outMs && p.inGame && p.offlineAt && now - p.offlineAt > outMs) {
        this.goneForGood(p);
        changed = true;
      }
    }
    this.watchPresence();
    if (changed) this.broadcast();
  }

  /* ---------- Sending ---------- */

  protected tell(id: string, msg: Msg): void {
    this.ctx.send(id, msg);
  }

  protected tellAll(msg: Msg, except?: string): void {
    for (const p of this.room.players) if (p.connected && p.id !== except) this.ctx.send(p.id, msg);
  }

  protected toHost(msg: Msg): void {
    const host = this.room.players.find((p) => p.isHost);
    if (host) this.ctx.send(host.id, msg);
  }

  protected broadcast(): void {
    const room = this.room;
    if (this.perPlayerView) {
      for (const p of room.players) if (p.connected) this.ctx.send(p.id, this.view(p.id));
    } else {
      const v = this.view(null);
      for (const p of room.players) if (p.connected) this.ctx.send(p.id, v);
    }
    const host = room.players.find((p) => p.isHost);
    this.ctx.listing({
      public: room.public,
      status: room.status,
      players: room.players.filter((p) => p.connected).length,
      max: this.maxPlayers,
      host: host ? host.name : '',
    });
    this.watchPresence();
    this.ctx.dirty();
  }

  /* ---------- Crews and saving ---------- */

  protected setCrew(rawName: unknown): void {
    const room = this.room;
    const name = String(rawName ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) {
      Object.assign(room, { crew: null, crewStatus: '' });
      this.broadcast();
      return;
    }
    if (name.toLowerCase().replace(/[^a-z0-9]/g, '').length < 3) {
      this.toHost({ t: 'toast', text: 'Crew names need at least 3 letters or numbers' });
      return;
    }
    room.crew = { name };
    room.crewStatus = 'Connecting to saved scores…';
    this.broadcast();
    this.ctx.later(async () => {
      let status: string;
      try {
        const data = await this.ctx.crewInfo(this.gameId, name);
        status = data && data.games ? `${plural(data.games, 'game')} played as this crew so far.` : 'New crew. Scores save after the first game.';
      } catch {
        status = 'Couldn’t reach saved scores right now.';
      }
      if (room.crew?.name !== name) return;
      room.crewStatus = status;
      this.ctx.dirty();
      this.broadcast();
    });
  }

  /** Save a finished game (every player's stats; the crew's totals when there is a crew). */
  protected saveGame(players: GameReport['players'], winner: string | null): void {
    const room = this.room;
    const game = room.game;
    if (room.crew) room.crewStatus = 'Saving this game…';
    const report: GameReport = { game: this.gameId, room: room.code, crew: room.crew ? room.crew.name : null, winner, players };
    this.ctx.later(async () => {
      try {
        const status = await this.ctx.report(report);
        if (room.game !== game || !room.crew) return;
        room.crewStatus = status;
      } catch (err) {
        console.error(`saving ${this.gameId} game failed`, err);
        if (room.game !== game || !room.crew) return;
        room.crewStatus = 'This game wasn’t saved. Try again next game.';
      }
      this.ctx.dirty();
      this.broadcast();
    });
  }

  snapshot(): unknown {
    return this.room;
  }
}

/** Seats whose socket didn't survive a restart are offline now; in the lobby they're gone. */
export function restoreSeats<P extends Seat>(ctx: RoomCtx, room: BaseRoom<P>): void {
  const now = ctx.now();
  for (const p of room.players) if (p.connected && !ctx.lastSeen(p.id)) Object.assign(p, { connected: false, offlineAt: now });
  if (room.status === 'lobby') room.players = room.players.filter((p) => p.connected);
}

export const reportPlayer = (p: Seat, place: number, won: boolean, stats: Record<string, number>, max?: Record<string, number>) => ({
  name: p.name, uid: p.uid, guest: p.guest, place, won, stats: { games: 1, plays: 1, wins: won ? 1 : 0, ...stats }, ...(max ? { max } : {}),
});
