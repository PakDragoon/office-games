// Builds the word lists the server checks answers against: web/a-to-zap/words/<category>.txt.
// Run from the repo root: node web/a-to-zap/tools/build-lists.mjs
//
// Each category's source is tools/src/<category>.txt (comma or line separated, written by hand, # lines are
// comments). Every entry goes through the game's own normalize() (js/engine.js), so a list entry and a typed
// answer always meet in the same form, then the file is de-duplicated and sorted in plain code-unit order
// (the same as `LC_ALL=C sort`), which is what the server's SortedWords binary search needs.
//
// "Thing" is also built from data: every word that is in Google's 15,000 most common words AND whose commonest
// WordNet sense is an artifact (a made object: chair, kettle, ladder) and is not on LDNOOBW's blocked list, minus
// tools/things-skip.txt (names, acronyms and abstract words the rule lets through), plus tools/things-extra.txt
// (hand-picked things, including natural objects, for the letters the rule is thin on).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { CATEGORY_IDS, normalize } from '../js/engine.js';

const DIR = 'web/a-to-zap';
const CACHE = `${DIR}/tools/.cache`;
const SOURCES = {
  index: 'https://cdn.jsdelivr.net/npm/wordnet-db@3.1.14/dict/index.noun',
  data: 'https://cdn.jsdelivr.net/npm/wordnet-db@3.1.14/dict/data.noun',
  common: 'https://raw.githubusercontent.com/first20hours/google-10000-english/master/20k.txt',
  bad: 'https://cdn.jsdelivr.net/gh/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words@master/en',
};
async function get(name) {
  const file = `${CACHE}/${name}`;
  if (!existsSync(file)) {
    mkdirSync(CACHE, { recursive: true });
    const res = await fetch(SOURCES[name]);
    if (!res.ok) throw new Error(`Download failed: ${SOURCES[name]}`);
    writeFileSync(file, await res.text());
  }
  return readFileSync(file, 'utf8');
}

const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const entries = (text) => text.split('\n').filter((l) => !l.trim().startsWith('#')).join(',').split(',').map((s) => normalize(s)).filter(Boolean);

async function thingsFromData() {
  const THING_FILES = new Set(['06']);   // WordNet lexicographer file 06 = noun.artifact
  const lexOf = new Map();
  for (const line of (await get('data')).split('\n')) if (/^\d{8} /.test(line)) lexOf.set(line.slice(0, 8), line.slice(9, 11));
  const common = new Set((await get('common')).split('\n').slice(0, 15000).map((s) => s.trim()).filter((w) => /^[a-z]{3,14}$/.test(w)));
  const blocked = new Set((await get('bad')).split('\n').map((s) => s.trim().toLowerCase()));
  const out = [];
  for (const line of (await get('index')).split('\n')) {
    if (!/^[a-z]+ n /.test(line)) continue;   // one plain word (no underscores, hyphens, digits)
    const parts = line.split(' ');
    const word = parts[0];
    if (!common.has(word) || blocked.has(word)) continue;
    const senseCount = Number(parts[2]);
    const ptrCount = Number(parts[3]);
    const offsets = parts.slice(4 + ptrCount + 2, 4 + ptrCount + 2 + senseCount);
    if (THING_FILES.has(lexOf.get(offsets[0]))) out.push(word);
  }
  return out;
}

for (const id of CATEGORY_IDS) {
  let words = entries(read(`${DIR}/tools/src/${id}.txt`));
  if (id === 'thing') {
    const skip = new Set(entries(read(`${DIR}/tools/things-skip.txt`)));
    words = [...(await thingsFromData()).filter((w) => !skip.has(w)), ...entries(read(`${DIR}/tools/things-extra.txt`))];
  }
  const list = [...new Set(words)].sort();   // default sort is by code unit, the same as LC_ALL=C
  writeFileSync(`${DIR}/words/${id}.txt`, `${list.join('\n')}\n`);
  console.log(`${id}.txt: ${list.length}`);
}
