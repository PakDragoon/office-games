import type { GameRoom } from './do/GameRoom';
import type { Lobby } from './do/Lobby';
import type { Hub } from './do/Hub';

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<GameRoom>;
  LOBBY: DurableObjectNamespace<Lobby>;
  /** One per signed-in player: their open tabs, online status and invites (server/src/do/Hub.ts). */
  HUB: DurableObjectNamespace<Hub>;
  DB: D1Database;
  EVENTS?: AnalyticsEngineDataset;
  /** Firebase project whose ID tokens we accept. */
  FIREBASE_PROJECT: string;
  /** HMAC key for guest ids and daily seeds (wrangler secret). */
  SERVER_SECRET?: string;
}
