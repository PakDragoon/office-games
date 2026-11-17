// Builds Hot & Cold's word data. Run from web/lettuce-party: node tools/build-hotcold.mjs
//
//   server/src/data/hotcold-targets.txt  the secret words, hand-picked (input, edit by hand)
//   server/src/data/hotcold-words.txt    the words you can guess (sorted, padded: see js/hotcold.js)
//   server/src/data/hotcold.bin          one small vector per word, in the same order
//   server/src/data/hotcold-targets.bin  per secret word: its closest words and a rank table
//
// Source: GloVe (Wikipedia + Gigaword, 100 numbers per word; public domain, PDDL) via gensim-data.
// Words close in meaning have vectors pointing the same way. GloVe learned from news and Wikipedia,
// so everyday words (kitten, giraffe) sit low in its frequency order: we keep the TOP_FREQ most
// frequent dictionary words (an-array-of-english-words) plus every everyday word from SCOWL sizes
// 10-35, in frequency order, until COUNT; nothing on the LDNOOBW list. Each vector is centred, scaled
// to length 1, squeezed to DIMS numbers with PCA (the directions that matter most) and stored in
// 4 bits per number. Measured against the full vectors, 64 numbers × 4 bits keep more of each word's
// 20 closest words (about 72%) than 48 × 8 bits, in less space. The files live under server/, never
// under web/: with them in the browser you could work the secret word out from your ranks.
//
// File layouts and the closeness and rank maths are in js/hotcold.js, which the server uses too,
// so the precomputed ranks here and the server's agree exactly.
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import * as H from '../js/hotcold.js';

const COUNT = 22000;
const TOP_FREQ = 8000;
const DIMS = 64;
const LEVELS = 7;
if (COUNT > 65535) throw new Error('Closest-word lists are 16-bit');
const OUT = '../../server/src/data';
// The secret words (hand-picked, in the same folder) are always guessable, even when rare or not in the dictionary
const TARGETS = new Set(readFileSync(`${OUT}/hotcold-targets.txt`, 'utf8').split('\n').map((w) => w.trim()).filter(Boolean));
const SOURCES = {
  glove: 'https://github.com/RaRe-Technologies/gensim-data/releases/download/glove-wiki-gigaword-100/glove-wiki-gigaword-100.gz',
  en: 'https://cdn.jsdelivr.net/npm/an-array-of-english-words@2.0.0/index.json',
  bad: 'https://cdn.jsdelivr.net/gh/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words@master/en',
  s10: 'https://cdn.jsdelivr.net/npm/wordlist-english@1.2.1/english-words-10.json',
  s20: 'https://cdn.jsdelivr.net/npm/wordlist-english@1.2.1/english-words-20.json',
  s35: 'https://cdn.jsdelivr.net/npm/wordlist-english@1.2.1/english-words-35.json',
};

async function cached(name, binary = false) {
  const file = `tools/.cache/${name}`;
  if (!existsSync(file)) {
    mkdirSync('tools/.cache', { recursive: true });
    const res = await fetch(SOURCES[name]);
    if (!res.ok) throw new Error(`Download failed: ${SOURCES[name]}`);
    if (binary) await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
    else writeFileSync(file, await res.text());
  }
  return file;
}

const dictionary = new Set(JSON.parse(readFileSync(await cached('en'), 'utf8')));
const everyday = new Set();
for (const n of ['s10', 's20', 's35']) for (const w of JSON.parse(readFileSync(await cached(n), 'utf8'))) everyday.add(w);
const blocked = new Set(readFileSync(await cached('bad'), 'utf8').split('\n').map((w) => w.trim().toLowerCase()).filter(Boolean));

// 1. Real, inoffensive, plain lower-case words: the most frequent, then everyday ones further down
const words = [];
const vecs = [];
let seen = 0;
const lines = createInterface({ input: createReadStream(await cached('glove', true)).pipe(createGunzip()) });
let header = true;
let targetsLeft = TARGETS.size;
for await (const line of lines) {
  if (header) { header = false; continue; }
  const sp = line.indexOf(' ');
  const w = line.slice(0, sp);
  const target = TARGETS.has(w);
  if (!target && (!/^[a-z]{3,14}$/.test(w) || !dictionary.has(w) || blocked.has(w))) continue;
  seen++;
  // Ordinary words stop early enough to leave room for the secret words still to come
  if (!target && (words.length >= COUNT - targetsLeft || (seen > TOP_FREQ && !everyday.has(w)))) continue;
  if (target) targetsLeft--;
  words.push(w);
  vecs.push(Float64Array.from(line.slice(sp + 1).split(' '), Number));
  if (words.length === COUNT) break;
}
lines.close();
const lost = [...TARGETS].filter((t) => !words.includes(t));
if (lost.length) throw new Error(`Secret words GloVe doesn't know: ${lost.join(' ')}`);
const D0 = vecs[0].length;

// 2. PCA: the mean, the covariance and its strongest directions (Jacobi eigenvalue method)
const mean = new Float64Array(D0);
for (const v of vecs) for (let d = 0; d < D0; d++) mean[d] += v[d] / vecs.length;
const unit = vecs.map((v) => {
  const c = v.map((x, d) => x - mean[d]);
  const len = Math.hypot(...c);
  return c.map((x) => x / len);
});
const cov = Array.from({ length: D0 }, () => new Float64Array(D0));
for (const v of unit) {
  for (let i = 0; i < D0; i++) {
    for (let j = i; j < D0; j++) cov[i][j] += v[i] * v[j];
  }
}
for (let i = 0; i < D0; i++) for (let j = i; j < D0; j++) cov[j][i] = cov[i][j];

function jacobi(a) {
  const n = a.length;
  const v = Array.from({ length: n }, (_, i) => Float64Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
}
const { values, vectors } = jacobi(cov);
const order = values.map((x, i) => [x, i]).sort((x, y) => y[0] - x[0]).slice(0, DIMS).map(([, i]) => i);
const kept = order.reduce((n, i) => n + values[i], 0) / values.reduce((n, x) => n + x, 0);

// 3. Project, scale to length 1, then 4 bits per number with a scale per dimension
const proj = unit.map((v) => {
  const p = order.map((col) => { let s = 0; for (let d = 0; d < D0; d++) s += v[d] * vectors[d][col]; return s; });
  const len = Math.hypot(...p);
  return p.map((x) => x / len);
});
// Sorted in plain code-unit order, so the server can binary-search the padded list
const sorted = words.map((w, i) => [w, i]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
const scale = Array.from({ length: DIMS }, (_, d) => Math.max(...proj.map((p) => Math.abs(p[d]))) / LEVELS);
const head = 8 + DIMS * 4;
const buf = Buffer.alloc(head + (words.length * DIMS) / 2);
buf.writeUInt32LE(words.length, 0);
buf.writeUInt32LE(DIMS, 4);
scale.forEach((s, d) => buf.writeFloatLE(s, 8 + d * 4));
sorted.forEach(([, from], i) => {
  const p = proj[from];
  for (let d = 0; d < DIMS; d += 2) {
    const lo = Math.round(p[d] / scale[d]) + 8, hi = Math.round(p[d + 1] / scale[d + 1]) + 8;
    buf[head + (i * DIMS + d) / 2] = lo | (hi << 4);
  }
});
const text = sorted.map(([w]) => w.padEnd(H.WIDTH - 1, ' ')).join('\n') + '\n';

// 4. Per secret word, with the same maths the server uses: its TOP closest words and a rank table
const vec = H.readVectors(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
const secret = [...TARGETS].sort();
const points = H.RANK_POINTS.length + 1;
const size = 4 + H.TOP * 2 + points * 8;
const tbuf = Buffer.alloc(12 + secret.length * size);
tbuf.writeUInt32LE(secret.length, 0);
tbuf.writeUInt32LE(H.TOP, 4);
tbuf.writeUInt32LE(points, 8);
secret.forEach((w, t) => {
  const index = H.indexOfWord(text, w);
  const pr = H.probe(vec, index);
  const close = Array.from({ length: vec.count }, (_, i) => [i, H.closeness(vec, i, pr)]).filter(([i]) => i !== index)
    .sort((x, y) => y[1] - x[1]);
  const at = 12 + t * size;
  tbuf.writeUInt32LE(index, at);
  for (let k = 0; k < H.TOP; k++) tbuf.writeUInt16LE(close[k][0], at + 4 + k * 2);
  // Rank r is close[r - 2] (rank 1 is the word itself); the last point is the farthest word
  [...H.RANK_POINTS.map((r) => close[r - 2][1]), close[close.length - 1][1]]
    .forEach((x, k) => tbuf.writeDoubleLE(x, at + 4 + H.TOP * 2 + k * 8));
});

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/hotcold-words.txt`, text);
writeFileSync(`${OUT}/hotcold.bin`, buf);
writeFileSync(`${OUT}/hotcold-targets.bin`, tbuf);
console.log(`${words.length} words, ${D0} → ${DIMS} numbers (${(kept * 100).toFixed(1)}% of the variance kept), ${(buf.length / 1024).toFixed(0)} KB`);
console.log(`${secret.length} secret words, ${(tbuf.length / 1024).toFixed(0)} KB; last word kept: ${words[words.length - 1]}`);
