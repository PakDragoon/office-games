import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { PROTOCOL, type GameInstance, type GameModule, type GameReport, type Identity, type Listing, type Msg, type RoomCtx } from '../core/game';
import { Bucket, randomId, Rng } from '../core/util';
import { GAMES } from '../games';
import { newGuest, verifyFirebase, verifyGuest } from '../auth';
import { crewInfo, recordGame } from '../db/stats';
import { replayStore } from '../db/replays';

/** Kept with each socket, so it survives the room hibernating. */
interface Attachment {
  connId: string;
  at: number;
  joined: boolean;
  uid: string | null;
  guest: string | null;
  photo: string;
}

interface Saved {
  gameId: string;
  code: string;
  public: boolean;
  createdAt: number;
  rng: number;
  timers: Record<string, number>;
  snap: unknown;
}

const CLEANUP_TIMER = '__cleanup';
const EMPTY_ROOM_MS = 10 * 60 * 1000;
const UNCLAIMED_MS = 3 * 60 * 1000;
const DEV_SECRET = 'dev-only-secret-change-me';

/**
 * One room of one game. Holds the game state in memory, saves a snapshot to its own storage
 * after every meaningful change, runs the game's timers with a single Alarm, and lets the
 * runtime answer keep-alive pings so an idle room can hibernate.
 */
export class GameRoom extends DurableObject<Env> {
  private gameId = '';
  private code = '';
  private isPublic = false;
  private createdAt = 0;
  private module: GameModule | null = null;
  private game: GameInstance | null = null;
  private rng = Rng.seeded();
  private timers: Record<string, number> = {};
  private isDirty = false;
  private lastMsg = new Map<string, number>();
  private buckets = new Map<string, Bucket>();
  private strikes = new Map<string, number>();
  private lastListing = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Saved>('room');
      if (saved) this.load(saved);
    });
  }

  /* ---------- Opening a room ---------- */

  /** Reserve this room for a new game. False if the code is already in use. */
  async claim(gameId: string, code: string, isPublic: boolean): Promise<boolean> {
    if (this.game) return false;
    const module = GAMES[gameId];
    if (!module) return false;
    Object.assign(this, { gameId, code, isPublic, createdAt: Date.now(), module, timers: {}, rng: Rng.seeded() });
    this.game = module.create(this.roomCtx(), { public: isPublic });
    this.timers[CLEANUP_TIMER] = Date.now() + UNCLAIMED_MS;
    this.isDirty = true;
    await this.afterEvent();
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const connId = randomId('c_');
    this.ctx.acceptWebSocket(server, [connId]);
    const att: Attachment = { connId, at: Date.now(), joined: false, uid: null, guest: null, photo: '' };
    server.serializeAttachment(att);
    this.lastMsg.set(connId, Date.now());
    if (!this.game) {
      const code = request.headers.get('X-Room-Code') || '';
      server.send(JSON.stringify({ t: 'reject', reason: `There’s no room ${code} right now. Check the code, or host a new room.`, gone: true }));
      server.close(4004, 'no room');
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------- Socket events ---------- */

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || !this.game || !this.module) return;
    const { connId } = att;
    if (typeof data !== 'string' || data.length > this.module.maxMsgBytes) return this.strike(ws, connId);
    let bucket = this.buckets.get(connId);
    if (!bucket) {
      bucket = new Bucket(this.module.rate.perSec, this.module.rate.burst);
      this.buckets.set(connId, bucket);
    }
    if (!bucket.take()) return this.strike(ws, connId);
    let msg: Msg;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      msg = parsed as Msg;
    } catch {
      return;
    }
    this.lastMsg.set(connId, Date.now());
    try {
      if (!att.joined) {
        if (msg.t !== 'join') return;
        if (msg.v !== PROTOCOL) {
          ws.send(JSON.stringify({ t: 'update' }));
          ws.close(4426, 'update');
          return;
        }
        await this.identify(ws, att, msg);
        // The socket may have closed while we checked the token
        if (!this.ctx.getWebSockets(connId).length || !this.game) return;
        this.game.join(connId, msg);
      } else {
        this.game.message(connId, msg);
      }
    } catch (err) {
      console.error('game error', this.gameId, this.code, err);
    }
    await this.afterEvent();
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.socketGone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye');
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.socketGone(ws);
  }

  private async socketGone(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    this.lastMsg.delete(att.connId);
    this.buckets.delete(att.connId);
    if (!this.game || !att.joined) return;
    try {
      this.game.close(att.connId);
    } catch (err) {
      console.error('game close error', this.gameId, this.code, err);
    }
    await this.afterEvent();
  }

  async alarm(): Promise<void> {
    if (!this.game) return;
    const now = Date.now();
    const due = Object.entries(this.timers)
      .filter(([, at]) => at <= now + 5)
      .sort((a, b) => a[1] - b[1]);
    for (const [name] of due) delete this.timers[name];
    this.isDirty = true;
    for (const [name] of due) {
      if (name === CLEANUP_TIMER) {
        if (!this.game.occupied()) return this.destroy();
        continue;
      }
      try {
        this.game.timer(name);
      } catch (err) {
        console.error('game timer error', this.gameId, this.code, name, err);
      }
      if (!this.game) return;
    }
    await this.afterEvent();
  }

  /* ---------- Helpers ---------- */

  private async identify(ws: WebSocket, att: Attachment, msg: Msg): Promise<void> {
    const secret = this.env.SERVER_SECRET || DEV_SECRET;
    const user = msg.token ? await verifyFirebase(msg.token, this.env.FIREBASE_PROJECT) : null;
    let guest = user ? null : await verifyGuest(msg.guest, secret);
    if (!user && !guest) {
      const fresh = await newGuest(secret);
      guest = fresh.id;
      ws.send(JSON.stringify({ t: 'guest', token: fresh.token }));
    }
    Object.assign(att, { joined: true, uid: user ? user.uid : null, guest, photo: user ? user.photo : '' });
    ws.serializeAttachment(att);
  }

  /** Too big, too fast or not text: ignore it, and after repeated abuse drop the connection. */
  private strike(ws: WebSocket, connId: string): void {
    const n = (this.strikes.get(connId) || 0) + 1;
    this.strikes.set(connId, n);
    if (n >= 50) {
      this.strikes.delete(connId);
      ws.close(4008, 'too many messages');
    }
  }

  private socketFor(connId: string): WebSocket | null {
    return this.ctx.getWebSockets(connId)[0] || null;
  }

  private attachment(connId: string): Attachment | null {
    const ws = this.socketFor(connId);
    return ws ? (ws.deserializeAttachment() as Attachment | null) : null;
  }

  private roomCtx(): RoomCtx {
    const self = this;
    return {
      get code() {
        return self.code;
      },
      now: () => Date.now(),
      send(connId, msg) {
        const ws = self.socketFor(connId);
        if (!ws) return;
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          /* socket is closing */
        }
      },
      close(connId, reason = 'closed') {
        const ws = self.socketFor(connId);
        if (!ws) return;
        try {
          ws.close(4000, reason.slice(0, 100));
        } catch {
          /* already closed */
        }
      },
      lastSeen(connId) {
        const ws = self.socketFor(connId);
        if (!ws) return 0;
        const auto = self.ctx.getWebSocketAutoResponseTimestamp(ws);
        const att = ws.deserializeAttachment() as Attachment | null;
        return Math.max(self.lastMsg.get(connId) || att?.at || 0, auto ? auto.getTime() : 0);
      },
      identity(connId): Identity {
        const att = self.attachment(connId);
        return { uid: att?.uid ?? null, guest: att?.guest ?? null, photo: att?.photo ?? '' };
      },
      setTimer(name, at) {
        self.timers[name] = at;
        self.isDirty = true;
      },
      clearTimer(name) {
        if (name in self.timers) {
          delete self.timers[name];
          self.isDirty = true;
        }
      },
      dirty() {
        self.isDirty = true;
      },
      random: () => self.rng.next(),
      report: (r: GameReport) => recordGame(self.env.DB, r),
      saveReplay: (game, payload, playerIds) => replayStore(self.env.DB).put(game, payload, playerIds),
      crewInfo: (game, name) => crewInfo(self.env.DB, game, name),
      track(event, data = {}) {
        try {
          self.env.EVENTS?.writeDataPoint({
            indexes: [self.gameId],
            blobs: [self.gameId, event, ...Object.values(data).filter((v) => typeof v === 'string').map(String)],
            doubles: Object.values(data).filter((v): v is number => typeof v === 'number'),
          });
        } catch {
          /* analytics are best effort */
        }
      },
      later(work) {
        self.ctx.waitUntil(
          work()
            .catch((err: unknown) => console.error('room task failed', self.gameId, self.code, err))
            .then(() => self.afterEvent()),
        );
      },
      listing(l: Listing | null) {
        const key = JSON.stringify(l);
        if (key === self.lastListing) return;
        self.lastListing = key;
        const lobby = self.env.LOBBY.get(self.env.LOBBY.idFromName(self.gameId));
        self.ctx.waitUntil(lobby.update(self.code, l).catch((err: unknown) => console.error('lobby update failed', err)));
      },
    };
  }

  private load(saved: Saved): void {
    const module = GAMES[saved.gameId];
    if (!module) return;
    Object.assign(this, {
      gameId: saved.gameId,
      code: saved.code,
      isPublic: saved.public,
      createdAt: saved.createdAt,
      module,
      timers: saved.timers || {},
      rng: new Rng(saved.rng),
    });
    this.game = module.restore(this.roomCtx(), saved.snap);
  }

  /** Save the snapshot if anything changed, keep the alarm on the earliest timer, plan the room's cleanup. */
  private async afterEvent(): Promise<void> {
    if (!this.game) return;
    const occupied = this.game.occupied();
    if (occupied && this.timers[CLEANUP_TIMER]) {
      delete this.timers[CLEANUP_TIMER];
      this.isDirty = true;
    } else if (!occupied && !this.timers[CLEANUP_TIMER]) {
      this.timers[CLEANUP_TIMER] = Date.now() + EMPTY_ROOM_MS;
      this.isDirty = true;
    }
    if (!this.isDirty) return;
    this.isDirty = false;
    const saved: Saved = {
      gameId: this.gameId,
      code: this.code,
      public: this.isPublic,
      createdAt: this.createdAt,
      rng: this.rng.state,
      timers: this.timers,
      snap: this.game.snapshot(),
    };
    await this.ctx.storage.put('room', saved);
    const next = Math.min(...Object.values(this.timers));
    if (Number.isFinite(next)) {
      const current = await this.ctx.storage.getAlarm();
      if (current !== next) await this.ctx.storage.setAlarm(next);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /** Nobody has been here for a while: forget the room so its code can be used again. */
  private async destroy(): Promise<void> {
    const gameId = this.gameId;
    const code = this.code;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4004, 'room closed');
      } catch {
        /* already closed */
      }
    }
    this.game = null;
    this.module = null;
    this.timers = {};
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    if (gameId) {
      const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName(gameId));
      await lobby.update(code, null).catch(() => undefined);
    }
  }
}
