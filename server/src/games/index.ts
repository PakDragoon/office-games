import type { GameModule } from '../core/game';
import { atozap } from './atozap';
import { fastFingers } from './fastfingers';
import { flipchip } from './flipchip';
import { guesstimate } from './guesstimate';
import { lettuce } from './lettuce';
import { liar } from './liar';
import { melonburst } from './melonburst';
import { rotten } from './rotten';
import { thulla } from './thulla';

/** Games that run on the server, by URL path. */
export const GAMES: Record<string, GameModule> = {
  rotten,
  'the-liar': liar,
  thulla,
  guesstimate,
  melonburst,
  flipchip,
  'fast-fingers': fastFingers,
  'lettuce-party': lettuce,
  'a-to-zap': atozap,
};
