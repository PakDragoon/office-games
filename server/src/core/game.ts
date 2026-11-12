// The contract between a room (the Durable Object) and a game's rules.
// Nothing in here knows about Cloudflare: a game module only talks to RoomCtx.

/** Bump when the browser and server message formats stop matching; old tabs are asked to reload. */
export const PROTOCOL = 1;

export type Msg = Record<string, unknown> & { t?: unknown };

/** Who a connection is, as far as the server could verify. */
export interface Identity {
  /** Firebase uid when the player signed in with Google and the token checked out. */
  uid: string | null;
  /** Server-signed guest id when not signed in. */
  guest: string | null;
  photo: string;
}

/** Results a game hands back at the end of a game, written to D1 by the room. */
export interface GameReport {
  game: string;
  room: string;
  crew: string | null;
  winner: string | null;
  players: Array<{
    name: string;
    uid: string | null;
    guest: string | null;
    place: number;
    won: boolean;
    /** Game-specific numbers to add to the player's stats (words, splats, points...). */
    stats: Record<string, number>;
    /** Numbers where the stat keeps the highest value seen (longest word...). */
    max?: Record<string, number>;
  }>;
}

/** A rating as shown to players (the exact numbers stay on the server). */
export interface RatingInfo {
  rating: number;
  rd: number;
  /** Rated games so far. */
  games: number;
  /** Still settling: the number is a rough guess, shown with a question mark. */
  provisional: boolean;
}

/** What one finished game did to one player's rating. */
export interface RatingChange extends RatingInfo {
  before: number;
  delta: number;
}

/** One seat of a finished game, for rating. Seats with `bot: true` make the whole game unrated. */
export interface RatedEntry {
  uid: string | null;
  guest: string | null;
  /** Finishing place, 1 = best; equal places are a tie. */
  place: number;
  bot?: boolean;
}

export interface RoomCtx {
  readonly code: string;
  now(): number;
  send(connId: string, msg: Msg): void;
  /** Close one connection (after any message already sent to it). */
  close(connId: string, reason?: string): void;
  /** Last moment this connection was heard from: any message or keep-alive ping. 0 if gone. */
  lastSeen(connId: string): number;
  identity(connId: string): Identity;
  setTimer(name: string, at: number): void;
  clearTimer(name: string): void;
  /** Persist the room's snapshot after this event. Call it for every change worth surviving a restart. */
  dirty(): void;
  random(): number;
  /** Save a finished game's results; returns a status line for the room (crew totals etc.). */
  report(r: GameReport): Promise<string>;
  /** Look up how many games a crew has played (for the lobby's crew line). */
  crewInfo(game: string, name: string): Promise<{ games: number } | null>;
  track(event: string, data?: Record<string, string | number>): void;
  /** Run async work (saving results, looking up a crew) and save the room again when it finishes. */
  later(work: () => Promise<void>): void;
  /** Current ratings for these people, same order (null: no id, or the game isn't rated). */
  ratings(game: string, who: Array<{ uid: string | null; guest: string | null }>): Promise<Array<RatingInfo | null>>;
  /** Rate a finished game; same order as `entries`, null for anyone not rated (see db/ratings.ts for the rules). */
  rate(game: string, entries: RatedEntry[]): Promise<Array<RatingChange | null>>;
  /** Tell the game's lobby (Quick Play / public list) how this room looks now. */
  listing(l: Listing | null): void;
}

export interface Listing {
  public: boolean;
  status: string;
  players: number;
  max: number;
  host: string;
  /** Average rating of the people seated (for rated games), for Quick Play matching. */
  rating?: number | null;
}

export interface GameInstance {
  /** A connection said who it is. Must answer with welcome or reject. */
  join(connId: string, msg: Msg): void;
  message(connId: string, msg: Msg): void;
  /** The connection closed (tab closed, network gone, replaced by a rejoin). */
  close(connId: string): void;
  timer(name: string): void;
  /** True while the room holds players worth keeping (the room is deleted some time after this goes false). */
  occupied(): boolean;
  snapshot(): unknown;
}

export interface GameModule {
  id: string;
  /** Largest message a player may send, in bytes. */
  maxMsgBytes: number;
  /** Sustained messages per second per connection, and the burst allowed on top. */
  rate: { perSec: number; burst: number };
  create(ctx: RoomCtx, opts: { public: boolean }): GameInstance;
  restore(ctx: RoomCtx, snap: unknown): GameInstance;
}
