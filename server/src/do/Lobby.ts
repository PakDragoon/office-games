import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import type { Listing } from '../core/game';

interface Entry extends Listing {
  code: string;
  at: number;
  /** When this room started waiting for players (reset when it goes back to its lobby). */
  since: number;
}

/** Who is asking for a room, when the game has ratings. */
export interface Seeker {
  rating: number;
  rd: number;
}

/** Quick Play for rated games: how far apart ratings may be at first, and how fast that widens. */
export const MATCH = { base: 100, perRd: 0.5, perSecond: 8 };

/** Rating gap that still counts as "close" for a room that has waited `waitedMs`. */
export const matchWindow = (seeker: Seeker, waitedMs: number): number =>
  MATCH.base + seeker.rd * MATCH.perRd + (Math.max(0, waitedMs) / 1000) * MATCH.perSecond;

/**
 * The best open room for someone: rooms whose players are within their window are tied for
 * best (then the fullest wins, as before, then the closest); when no room is close enough the
 * one that misses by least is taken, so nobody is ever sent away empty-handed.
 */
export function pickRoom(open: Entry[], seeker: Seeker | null, now: number): Entry | undefined {
  const score = (e: Entry) => {
    const gap = seeker && typeof e.rating === 'number' ? Math.abs(e.rating - seeker.rating) : 0;
    const window = seeker ? matchWindow(seeker, now - (e.since ?? e.at)) : Infinity;
    return { gap, excess: Math.max(0, gap - window) };
  };
  return [...open].sort((a, b) => {
    const x = score(a);
    const y = score(b);
    return x.excess - y.excess || b.players - a.players || x.gap - y.gap || b.at - a.at;
  })[0];
}

const STALE_MS = 15 * 60 * 1000;

/**
 * One per game: the list of public rooms, kept up to date by the rooms themselves.
 * Quick Play picks the fullest public room that is still in its lobby and has a free seat; for rated
 * games it prefers rooms whose players have a similar rating (see pickRoom).
 */
export class Lobby extends DurableObject<Env> {
  private rooms = new Map<string, Entry>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Entry[]>('rooms');
      for (const e of saved || []) this.rooms.set(e.code, e);
    });
  }

  async update(code: string, l: Listing | null): Promise<void> {
    const had = this.rooms.has(code);
    if (!l || !l.public) {
      if (!had) return;
      this.rooms.delete(code);
    } else {
      const now = Date.now();
      const prev = this.rooms.get(code);
      const since = prev && prev.status === 'lobby' && l.status === 'lobby' ? prev.since ?? now : now;
      this.rooms.set(code, { ...l, code, at: now, since });
    }
    await this.save();
  }

  /** Open public rooms, newest activity first. */
  async list(): Promise<Entry[]> {
    this.prune();
    return [...this.rooms.values()].sort((a, b) => b.at - a.at).slice(0, 50);
  }

  /** A public room waiting for players, or null when a new one should be opened. */
  async quickPlay(seeker: Seeker | null = null): Promise<string | null> {
    this.prune();
    const open = [...this.rooms.values()].filter((e) => e.status === 'lobby' && e.players > 0 && e.players < e.max);
    return pickRoom(open, seeker, Date.now())?.code ?? null;
  }

  private prune(): void {
    const now = Date.now();
    for (const [code, e] of this.rooms) if (now - e.at > STALE_MS) this.rooms.delete(code);
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put('rooms', [...this.rooms.values()]);
  }
}
