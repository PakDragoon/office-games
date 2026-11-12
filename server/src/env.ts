import type { GameRoom } from './do/GameRoom';
import type { Lobby } from './do/Lobby';

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<GameRoom>;
  LOBBY: DurableObjectNamespace<Lobby>;
  DB: D1Database;
  EVENTS?: AnalyticsEngineDataset;
  /** Firebase project whose ID tokens we accept. */
  FIREBASE_PROJECT: string;
  /** HMAC key for guest ids and daily seeds (wrangler secret). */
  SERVER_SECRET?: string;
}
