import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import type { Listing } from '../core/game';

interface Entry extends Listing {
  code: string;
  at: number;
}

const STALE_MS = 15 * 60 * 1000;

/**
 * One per game: the list of public rooms, kept up to date by the rooms themselves.
 * Quick Play picks the fullest public room that is still in its lobby and has a free seat.
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
      this.rooms.set(code, { ...l, code, at: Date.now() });
    }
    await this.save();
  }

  /** Open public rooms, newest activity first. */
  async list(): Promise<Entry[]> {
    this.prune();
    return [...this.rooms.values()].sort((a, b) => b.at - a.at).slice(0, 50);
  }

  /** A public room waiting for players, or null when a new one should be opened. */
  async quickPlay(): Promise<string | null> {
    this.prune();
    const open = [...this.rooms.values()].filter((e) => e.status === 'lobby' && e.players > 0 && e.players < e.max);
    open.sort((a, b) => b.players - a.players || b.at - a.at);
    return open[0]?.code ?? null;
  }

  private prune(): void {
    const now = Date.now();
    for (const [code, e] of this.rooms) if (now - e.at > STALE_MS) this.rooms.delete(code);
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put('rooms', [...this.rooms.values()]);
  }
}
