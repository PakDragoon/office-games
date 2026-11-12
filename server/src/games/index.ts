import type { GameModule } from '../core/game';
import { rotten } from './rotten';

/** Games that run on the server, by URL path. */
export const GAMES: Record<string, GameModule> = {
  rotten,
};
