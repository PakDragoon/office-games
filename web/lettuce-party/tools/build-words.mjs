// Builds the word files the game loads. Run from the repo root: node tools/build-words.mjs
//
//   words/answers.txt  5-letter words that can be the secret word (SCOWL sizes 10, 20 and 35)
//   words/valid.txt    every 5-letter word accepted as a guess (an-array-of-english-words + the above)
//
// SCOWL (wordlist-english) is split by how common a word is and keeps proper nouns in separate
// lists, so answers are real, reasonably well-known words. Plurals, -ed/-ing forms and
// comparatives whose base word exists are left out of the answers (they still count as guesses).
// Offensive words (the LDNOOBW list) are never answers.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const SCOWL = (n) => `https://cdn.jsdelivr.net/npm/wordlist-english@1.2.1/english-words-${n}.json`;
const SOURCES = {
  s10: SCOWL(10),
  s20: SCOWL(20),
  s35: SCOWL(35),
  en: 'https://cdn.jsdelivr.net/npm/an-array-of-english-words@2.0.0/index.json',
  bad: 'https://cdn.jsdelivr.net/gh/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words@master/en',
};

async function get(name) {
  const file = `tools/.cache/${name}`;
  if (!existsSync(file)) {
    mkdirSync('tools/.cache', { recursive: true });
    const res = await fetch(SOURCES[name]);
    if (!res.ok) throw new Error(`Download failed: ${SOURCES[name]}`);
    writeFileSync(file, await res.text());
  }
  return readFileSync(file, 'utf8');
}

const words = async (name) => JSON.parse(await get(name)).map((w) => String(w).toLowerCase()).filter((w) => /^[a-z]+$/.test(w));
const five = (list) => list.filter((w) => w.length === 5);

const blocked = new Set((await get('bad')).split('\n').map((s) => s.trim().toLowerCase()).filter((w) => /^[a-z]{2,20}$/.test(w)));
// Words containing a blocked word of 4+ letters are out too (but "class" isn't out for "ass")
const blockedLong = [...blocked].filter((b) => b.length >= 4);
const clean = (w) => !blocked.has(w) && !blockedLong.some((b) => w.includes(b));

const en = await words('en');
const s10 = await words('s10');
const s20 = await words('s20');
const s35 = await words('s35');
const known = new Set([...en, ...s10, ...s20, ...s35]);

// A word is a form of another when dropping its ending leaves a known word
function isForm(w) {
  const has = (b) => b.length >= 2 && known.has(b);
  if (w.endsWith('ies') && has(w.slice(0, -3) + 'y')) return true;
  if (w.endsWith('es') && has(w.slice(0, -2))) return true;
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && has(w.slice(0, -1))) return true;
  if (w.endsWith('ed') && (has(w.slice(0, -2)) || has(w.slice(0, -1)) || (w.endsWith('ied') && has(w.slice(0, -3) + 'y')))) return true;
  if (w.endsWith('ing') && (has(w.slice(0, -3)) || has(w.slice(0, -3) + 'e'))) return true;
  if (w.endsWith('er') && (has(w.slice(0, -2)) || has(w.slice(0, -1)))) return true;
  if (w.endsWith('est') && (has(w.slice(0, -3)) || has(w.slice(0, -2)))) return true;
  return false;
}
// Common words that look like forms but are words in their own right
const KEEP = new Set(['water', 'paper', 'never', 'under', 'other', 'after', 'offer', 'enter', 'power', 'tower', 'river', 'cover', 'fever', 'lever', 'liver', 'lover', 'timer', 'tiger', 'super', 'upper', 'lower', 'outer', 'inner', 'later', 'layer', 'major', 'minor', 'cider', 'cyber', 'dryer', 'voter', 'baker', 'maker', 'owner', 'rider', 'ruler', 'tuner', 'joker', 'diner', 'boxer', 'poker', 'racer', 'mover', 'refer', 'eager', 'cedar', 'sugar', 'bless', 'bonus', 'focus', 'virus', 'basis', 'oasis', 'axis', 'crisis', 'bring', 'thing', 'swing', 'sling', 'sting', 'cling', 'king', 'speed', 'breed', 'bleed', 'greed', 'steed', 'tweed', 'seed', 'naked', 'wicked', 'sacred', 'rugged', 'jagged', 'crooked', 'beloved', 'forest', 'honest', 'chest', 'quest', 'guest', 'crest', 'arrest']);

const answers = [...new Set(five([...s10, ...s20, ...s35]))].filter(clean).filter((w) => KEEP.has(w) || !isForm(w)).sort();
const valid = [...new Set(five([...en, ...s10, ...s20, ...s35]))].sort();

mkdirSync('words', { recursive: true });
writeFileSync('words/answers.txt', answers.join('\n') + '\n');
writeFileSync('words/valid.txt', valid.join('\n') + '\n');
console.log(`answers ${answers.length}`);
console.log(`valid   ${valid.length}`);
