// Builds words/ladders.txt, the start/target pairs for Word ladder. Run from the repo root:
//   node web/lettuce-party/tools/build-ladders.mjs
//
// The Worker has 10 ms of CPU per request, so it never searches for a path. This tool does the searching once:
// a breadth-first search over every word in valid.txt + answers.txt (neighbours differ in one letter), from each
// answer to every other answer. A pair is kept when both ends are answers (common words), the shortest path
// between them is 3 to 6 steps, AND a path of that same length exists using only answers (so the par can be reached
// with everyday words, and the path shown at the end has no obscure ones). Words in BLOCKED_ANSWERS are left out of
// the graph, so no shown path uses one.
//
// One line per pair, sorted: `start target par step step ...` where par is the fewest steps and the rest of the
// line is one shortest path (shown to everyone when the round ends). Deterministic: same inputs, same file.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BLOCKED_ANSWERS } from '../js/words.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, 'words', f), 'utf8').split('\n').map((w) => w.trim()).filter((w) => /^[a-z]{5}$/.test(w));

const PER_PAR = { 3: 600, 4: 700, 5: 500, 6: 300 };   // pairs kept per shortest-path length
const MAX_USES = 8;                                     // times one word may appear as an end, so starts and targets vary

const blocked = new Set(BLOCKED_ANSWERS);
const answers = read('answers.txt').filter((w) => !blocked.has(w));
const words = [...new Set([...read('valid.txt'), ...answers])].filter((w) => !blocked.has(w)).sort();
const index = new Map(words.map((w, i) => [w, i]));

// Words that match with one letter blanked out are the neighbours of each other
const buckets = new Map();
for (const w of words) {
  for (let i = 0; i < 5; i++) {
    const key = `${w.slice(0, i)}_${w.slice(i + 1)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(index.get(w));
  }
}
const next = words.map((w, wi) => {
  const out = new Set();
  for (let i = 0; i < 5; i++) for (const n of buckets.get(`${w.slice(0, i)}_${w.slice(i + 1)}`)) if (n !== wi) out.add(n);
  return [...out];
});

const isAnswer = new Set(answers.map((w) => index.get(w)));
const nextCommon = next.map((list, wi) => (isAnswer.has(wi) ? list.filter((n) => isAnswer.has(n)) : []));

function bfs(from, graph = next) {
  const dist = new Int16Array(words.length).fill(-1);
  const parent = new Int32Array(words.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let q = 0; q < queue.length; q++) {
    const at = queue[q];
    for (const n of graph[at]) {
      if (dist[n] >= 0) continue;
      dist[n] = dist[at] + 1;
      parent[n] = at;
      queue.push(n);
    }
  }
  return { dist, parent };
}

// A small seeded random generator so the file is the same every time
let seed = 0x1e77ce;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const candidates = { 3: [], 4: [], 5: [], 6: [] };
const trees = new Map();
for (const a of answers) {
  const ai = index.get(a);
  const tree = bfs(ai);
  const common = bfs(ai, nextCommon);
  trees.set(ai, common);
  for (const b of answers) {
    const bi = index.get(b);
    if (bi <= ai) continue;
    const d = tree.dist[bi];
    if (d >= 3 && d <= 6 && common.dist[bi] === d) candidates[d].push([ai, bi]);
  }
}

const uses = new Map();
const lines = [];
for (const [par, list] of Object.entries(candidates).reverse()) {   // the rarer long ones pick first
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  let kept = 0;
  for (const [ai, bi] of list) {
    if (kept >= PER_PAR[par]) break;
    if ((uses.get(ai) || 0) >= MAX_USES || (uses.get(bi) || 0) >= MAX_USES) continue;
    uses.set(ai, (uses.get(ai) || 0) + 1);
    uses.set(bi, (uses.get(bi) || 0) + 1);
    const { parent } = trees.get(ai);
    const path = [];
    for (let at = bi; at !== -1; at = parent[at]) path.push(words[at]);
    path.reverse();
    lines.push(`${path[0]} ${path[path.length - 1]} ${path.length - 1} ${path.slice(1, -1).join(' ')}`);
    kept++;
  }
  console.log(`par ${par}: ${list.length} possible pairs, kept ${kept}`);
}

lines.sort();
writeFileSync(join(root, 'words', 'ladders.txt'), `${lines.join('\n')}\n`);
console.log(`${lines.length} pairs written to words/ladders.txt`);
