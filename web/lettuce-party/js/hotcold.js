// Hot & Cold: how close in meaning a guess is to the secret word, as a rank (1 = the word itself).
// Pure functions shared by the server and tools/build-hotcold.mjs, so both get exactly the same
// numbers. The data files themselves live under server/src/data (never sent to browsers).
//
//   hotcold-words.txt    every guessable word, sorted (LC_ALL=C), each line padded to WIDTH - 1
//                        characters, so word i starts at i × WIDTH and a lookup is a binary search
//   hotcold.bin          u32 count, u32 dims, dims × f32 scale, then count × dims / 2 bytes:
//                        two 4-bit numbers per byte (low half first), each stored as q + 8
//   hotcold-targets.bin  u32 targets, u32 TOP, u32 points, then per secret word: u32 index,
//                        TOP × u16 (its closest words, rank 2 onwards), points × f64 (the closeness
//                        a word needs to reach each rank in RANK_POINTS, then the farthest word's)
//
// Ranking all 22,000 words for every round costs about twice the free plan's 10 ms of CPU, so the
// build does it once per secret word. A guess then costs one comparison: an exact rank when it is
// among the TOP closest words, otherwise read off the table (closer always means a better rank).

export const WIDTH = 15;
export const TOP = 100;
export const RANK_POINTS = [TOP + 1, 120, 150, 200, 250, 300, 400, 500, 650, 800, 1000, 1300, 1600, 2000, 2500,
  3000, 4000, 5000, 6500, 8000, 10000, 12500, 15000, 17500, 20000];

const LO = new Int8Array(256);
const HI = new Int8Array(256);
for (let b = 0; b < 256; b++) { LO[b] = (b & 15) - 8; HI[b] = (b >> 4) - 8; }

/** The vectors file, read in place (no copying). */
export function readVectors(buffer) {
  const dv = new DataView(buffer);
  const count = dv.getUint32(0, true);
  const dims = dv.getUint32(4, true);
  const scale = new Float64Array(dims);
  for (let d = 0; d < dims; d++) scale[d] = dv.getFloat32(8 + d * 4, true);
  return { count, dims, scale, packed: new Uint8Array(buffer, 8 + dims * 4, (count * dims) / 2) };
}

/** Word i's numbers, each multiplied by its scale twice: ready to be compared with any word by `closeness`. */
export function probe(vec, i) {
  const half = vec.dims >> 1;
  const out = new Float64Array(vec.dims);
  for (let k = 0; k < half; k++) {
    const b = vec.packed[i * half + k];
    out[2 * k] = LO[b] * vec.scale[2 * k] * vec.scale[2 * k];
    out[2 * k + 1] = HI[b] * vec.scale[2 * k + 1] * vec.scale[2 * k + 1];
  }
  return out;
}

/** How close word i is to the probed word: higher is closer (about 1 for the word itself). */
export function closeness(vec, i, pr) {
  const half = vec.dims >> 1;
  const o = i * half;
  let s = 0;
  for (let k = 0; k < half; k++) {
    const b = vec.packed[o + k];
    s += LO[b] * pr[2 * k] + HI[b] * pr[2 * k + 1];
  }
  return s;
}

/** How many secret words the targets file holds. */
export const targetCount = (buffer) => new DataView(buffer).getUint32(0, true);

/** Secret word number t: its index in the word list, its closest words and its rank table (read only when needed). */
export function readTarget(buffer, t) {
  const dv = new DataView(buffer);
  const top = dv.getUint32(4, true);
  const points = dv.getUint32(8, true);
  const at = 12 + t * (4 + top * 2 + points * 8);
  const near = new Uint16Array(top);
  for (let k = 0; k < top; k++) near[k] = dv.getUint16(at + 4 + k * 2, true);
  const table = new Float64Array(points);
  for (let k = 0; k < points; k++) table[k] = dv.getFloat64(at + 4 + top * 2 + k * 8, true);
  return { index: dv.getUint32(at, true), near, table };
}

/**
 * Word i's rank for this secret word (1 = the word itself). Among the TOP closest it is exact;
 * further away it is read off the table between its two nearest points, never better than TOP + 2.
 */
export function rankOf(vec, target, pr, i) {
  if (i === target.index) return 1;
  const exact = target.near.indexOf(i);
  if (exact >= 0) return exact + 2;
  const s = closeness(vec, i, pr);
  const tb = target.table;
  // The table's last point is the farthest word of all, so every word falls between two points
  const ranks = [...RANK_POINTS, vec.count];
  if (s >= tb[0]) return TOP + 2;
  for (let k = 1; k < tb.length; k++) {
    if (s >= tb[k]) {
      // Between the points k-1 (closer) and k: share out the ranks by closeness
      const f = (tb[k - 1] - s) / (tb[k - 1] - tb[k] || 1);
      return Math.max(TOP + 2, Math.round(ranks[k - 1] + f * (ranks[k] - ranks[k - 1])));
    }
  }
  return vec.count;
}

/** Word i of the padded, sorted word list. */
export const wordAt = (text, i) => text.slice(i * WIDTH, i * WIDTH + WIDTH - 1).trimEnd();

/** Where a word is in the padded, sorted word list, or -1: a binary search straight on the text. */
export function indexOfWord(text, word) {
  if (typeof word !== 'string' || !word || word.length >= WIDTH) return -1;
  let lo = 0;
  let hi = Math.floor(text.length / WIDTH) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const w = wordAt(text, mid);
    if (w === word) return mid;
    if (w < word) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
