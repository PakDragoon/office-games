import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { Bucket, CODE_RE } from '../core/util';
import { GAMES } from '../games';
import { inviteTarget, normalizeCode, profileOf, setPresence, summary, touchPresence } from '../db/friends';

/**
 * One Hub per signed-in (Google) player. Every open game tab of that player holds one WebSocket to it.
 *  - Online status: the Hub writes the player's presence row (D1) when the first tab connects, when the room they are
 *    in changes, on the tab's ~100 s beat, and when the last tab closes. Friends read that one table, so a friends
 *    list is ONE query and never wakes anyone's Hub.
 *  - Invites: a tab says "invite <friend code> to my room"; the Hub checks the room really has this player in it, that
 *    the two are friends, that the friend looks online, and hands it to the friend's Hub, which shows it in every
 *    one of their tabs.
 *  - Pushes to the tab: a summary on connect, friend-list changes ("someone asked to be your friend"), invites.
 * Costs: the keep-alive 'ping' is answered by the runtime without waking the Hub (hibernation), so an idle Hub is
 * free; a real message is 1/20 of a request. Nothing is sent per friend.
 */

interface Attachment {
  id: string;
  at: number;
  game: string;
  room: string;
  /** When game/room were last set (the newest tab's room wins). */
  whereAt: number;
  lastBeat: number;
}

export interface Invite {
  fromCode: string;
  fromName: string;
  game: string;
  room: string;
}

const MAX_TABS = 8;
const MAX_MSG = 300;
const BEAT_GAP_MS = 30_000;
/** One invite from the same friend per this long. */
const SAME_SENDER_MS = 20_000;

export class Hub extends DurableObject<Env> {
  // In memory on purpose: a Hub that has been evicted was idle for a while, and these only damp bursts.
  private bucket = new Bucket(1, 8);
  private strikes = 0;
  /** Set by kick(): the player deleted their data, so closing their tabs must not write presence back. */
  private removed = false;
  private inviteBucket = new Bucket(1 / 3, 4);
  private lastFrom = new Map<string, number>();
  private inbox = new Bucket(10 / 60, 5);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const id = request.headers.get('X-Player') || '';
    if (request.headers.get('Upgrade') !== 'websocket' || !id.startsWith('u:')) return new Response('Expected a WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const now = Date.now();
    // Too many tabs: the oldest is let go (it reconnects if it is still wanted)
    const open = this.ctx.getWebSockets();
    if (open.length >= MAX_TABS) {
      const oldest = [...open].sort((a, b) => ((a.deserializeAttachment() as Attachment | null)?.at ?? 0) - ((b.deserializeAttachment() as Attachment | null)?.at ?? 0))[0];
      try { oldest.close(4009, 'too many tabs'); } catch { /* already closed */ }
    }
    this.removed = false;
    this.ctx.acceptWebSocket(server);
    const att: Attachment = { id, at: now, game: '', room: '', whereAt: 0, lastBeat: now };
    server.serializeAttachment(att);
    try {
      await this.publish(id, null);
      const s = await summary(this.env.DB, id);
      server.send(JSON.stringify({ t: 'hello', requests: s.requests, online: s.online }));
    } catch (err) {
      console.error('hub connect failed', err);
      server.send(JSON.stringify({ t: 'hello', requests: 0, online: 0 }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    if (typeof data !== 'string' || data.length > MAX_MSG || !this.bucket.take()) {
      if (++this.strikes >= 50) ws.close(4008, 'too many messages');
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    try {
      if (msg.t === 'where') await this.where(ws, att, msg);
      else if (msg.t === 'beat') await this.beat(ws, att);
      else if (msg.t === 'invite') await this.invite(ws, att, msg);
    } catch (err) {
      console.error('hub message failed', err);
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.gone(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.gone(ws);
  }

  private async gone(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || this.removed) return;
    try {
      await this.publish(att.id, ws);
    } catch (err) {
      console.error('hub presence failed', err);
    }
  }

  /** Write the player's presence from their open tabs (leaving out `closing`): offline when none are left. */
  private async publish(id: string, closing: WebSocket | null): Promise<void> {
    let best: Attachment | null = null;
    let live = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) continue;
      live++;
      if (a.room && (!best || a.whereAt > best.whereAt)) best = a;
    }
    if (!live) return setPresence(this.env.DB, id, null, 0);
    await setPresence(this.env.DB, id, best ? { game: best.game, room: best.room } : null, Date.now());
  }

  private async where(ws: WebSocket, att: Attachment, msg: Record<string, unknown>): Promise<void> {
    const game = typeof msg.game === 'string' ? msg.game : '';
    const room = typeof msg.room === 'string' ? msg.room.toUpperCase() : '';
    const valid = Boolean(GAMES[game]) && CODE_RE.test(room);
    const next = valid ? { game, room } : { game: '', room: '' };
    if (att.game === next.game && att.room === next.room) return;
    Object.assign(att, next, { whereAt: Date.now() });
    ws.serializeAttachment(att);
    await this.publish(att.id, null);
  }

  /** The browser's periodic "still here": keeps the player online for friends. Ignored if it comes too often. */
  private async beat(ws: WebSocket, att: Attachment): Promise<void> {
    const now = Date.now();
    if (now - att.lastBeat < BEAT_GAP_MS) return;
    att.lastBeat = now;
    ws.serializeAttachment(att);
    await touchPresence(this.env.DB, att.id, now);
  }

  private async invite(ws: WebSocket, att: Attachment, msg: Record<string, unknown>): Promise<void> {
    const code = normalizeCode(msg.code);
    const game = typeof msg.game === 'string' ? msg.game : '';
    const room = typeof msg.room === 'string' ? msg.room.toUpperCase() : '';
    const reply = (ok: boolean, reason = '') => ws.send(JSON.stringify({ t: 'invite-result', code, ok, reason }));
    if (!code || !GAMES[game] || !CODE_RE.test(room)) return reply(false, 'invalid');
    if (!this.inviteBucket.take()) return reply(false, 'slow-down');
    // The sender really is in that room (nobody can invite friends into a room they only claim to be in)
    const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(`${game}:${room}`));
    if (!(await stub.seated(att.id.slice(2)))) return reply(false, 'not-in-room');
    const target = await inviteTarget(this.env.DB, att.id, code);
    if (!target) return reply(false, 'not-friends');
    if (!target.online) return reply(false, 'offline');
    const me = await profileOf(this.env.DB, att.id);
    if (!me) return reply(false, 'invalid');
    const got = await this.env.HUB.get(this.env.HUB.idFromName(target.id)).deliver({ fromCode: me.code, fromName: me.name, game, room });
    return reply(got === 'ok', got === 'ok' ? '' : got);
  }

  /** (RPC) Show an invite in every open tab of this player. */
  deliver(inv: Invite): 'ok' | 'offline' | 'busy' {
    const tabs = this.ctx.getWebSockets();
    if (!tabs.length) return 'offline';
    const now = Date.now();
    const prev = this.lastFrom.get(inv.fromCode);
    if ((prev !== undefined && now - prev < SAME_SENDER_MS) || !this.inbox.take()) return 'busy';
    if (this.lastFrom.size > 100) this.lastFrom.clear();
    this.lastFrom.set(inv.fromCode, now);
    const text = JSON.stringify({ t: 'invite', from: { code: inv.fromCode, name: inv.fromName }, game: inv.game, room: inv.room, at: now });
    for (const ws of tabs) {
      try { ws.send(text); } catch { /* closing */ }
    }
    return 'ok';
  }

  /** (RPC) Tell every open tab the friends list changed (a request arrived, was accepted, someone left). */
  notify(why: 'request' | 'accepted' | 'removed', name: string): void {
    const text = JSON.stringify({ t: 'friends', why, name });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(text); } catch { /* closing */ }
    }
  }

  /** (RPC) Close every tab's connection (the player deleted their data). */
  kick(): void {
    this.removed = true;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(4010, 'removed'); } catch { /* already closed */ }
    }
  }
}
