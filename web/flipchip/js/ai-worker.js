// The computer thinks here, off the page's thread, so chips keep flipping smoothly while it does.
import { chooseMove, mulberry32 } from './engine.js';

self.onmessage = (e) => {
  const { id, board, n, who, level, seed, ms } = e.data;
  let move = -1;
  try { move = chooseMove(board, n, who, level, { rnd: mulberry32(seed), ms }); } catch (err) { console.warn(err); }
  self.postMessage({ id, move });
};
