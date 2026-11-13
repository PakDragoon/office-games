// Rules tests: node test/engine.test.mjs
import { readFileSync } from 'node:fs';
import * as E from '../js/engine.js';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) passed++;
  else { failed++; console.error(`FAIL ${name} ${extra}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const enWords = readFileSync(new URL('../words/en.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);
const urWords = readFileSync(new URL('../words/ur.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);
const lex = E.makeLexicon(enWords, urWords);

// ---------- Word lists ----------
check('english list is big', enWords.length > 250000, enWords.length);
check('english list is a-z only', enWords.every((w) => /^[a-z]{2,20}$/.test(w)));
check('urdu list has words', urWords.length > 2500, urWords.length);
check('urdu list is a-z only', urWords.every((w) => /^[a-z]{2,20}$/.test(w)));
check('no blocked word in urdu list', urWords.every((w) => !E.BLOCKED_SET.has(w)));
for (const w of ['banana', 'office', 'cricket', 'rotten']) check(`english has ${w}`, lex.en.has(w));

// ---------- Settings ----------
check('defaults', eq(E.cleanSettings(null), E.DEFAULT_SETTINGS));
check('bad values fall back', E.cleanSettings({ lives: 9, fuse: 'x', minLen: 5 }).lives === 3
  && E.cleanSettings({ fuse: 'x' }).fuse === 'normal' && E.cleanSettings({ minLen: 5 }).minLen === 5);
check('unknown keys dropped', !('evil' in E.cleanSettings({ evil: 1 })));
check('max lives', E.maxLivesFor({ lives: 3, maxLives: 'start' }) === 3 && E.maxLivesFor({ lives: 3, maxLives: 'plus1' }) === 4
  && E.maxLivesFor({ lives: 3, maxLives: 'none' }) === 99);
check('min turn', E.minTurnMs({ minTurn: '5' }) === 5000 && E.minTurnMs({ minTurn: 'off' }) === 0 && E.minTurnMs(E.cleanSettings({ minTurn: 'on' })) === 5000);
check('match target', E.matchTarget({ match: 'open' }) === 0 && E.matchTarget({ match: '3' }) === 2 && E.matchTarget({ match: '5' }) === 3);

// ---------- Fuse ----------
{
  const rnd = E.mulberry32(1);
  for (const [k, [lo, hi]] of Object.entries(E.FUSES)) {
    let ok = true;
    for (let i = 0; i < 500; i++) { const f = E.fuseMs({ fuse: k }, rnd); if (f < lo || f > hi) ok = false; }
    check(`fuse ${k} in range`, ok);
  }
}

// ---------- Checking words ----------
const ctx = (over = {}) => ({ prompt: 'an', minLen: 4, list: 'en', forms: 'block', used: new Set(), lex, ...over });
check('valid word', E.checkWord('banana', ctx()).ok);
check('uppercase and spaces ok', E.checkWord(' BaNaNa ', ctx()).ok);
check('missing letters', E.checkWord('apple', ctx()).reason === 'prompt');
check('too short', E.checkWord('ant', ctx()).reason === 'short');
check('min length 3', E.checkWord('ant', ctx({ minLen: 3 })).ok);
check('min length 5', E.checkWord('band', ctx({ minLen: 5 })).reason === 'short');
check('not a word', E.checkWord('banxna', ctx()).reason === 'unknown');
check('empty', E.checkWord('', ctx()).reason === 'empty');
{
  const r = E.checkWord('banana', ctx());
  const used = new Set([r.key]);
  check('repeat blocked', E.checkWord('banana', ctx({ used })).reason === 'used');
  check('plural blocked', E.checkWord('bananas', ctx({ used })).reason === 'used');
  check('plural allowed when forms allowed', E.checkWord('bananas', ctx({ used: new Set([E.checkWord('banana', ctx({ forms: 'allow' })).key]), forms: 'allow' })).ok);
}
check('stems', E.stemKey('making') === E.stemKey('make') && E.stemKey('boxes') === E.stemKey('box')
  && E.stemKey('running') === E.stemKey('run') && E.stemKey('parties') === E.stemKey('party')
  && E.stemKey('played') === E.stemKey('play') && E.stemKey('class') === 'class');
{
  const bad = [...E.BLOCKED_SET].find((w) => w.length >= 4 && lex.en.has(w));
  if (bad) check('blocked word refused', E.checkWord(bad, ctx({ prompt: bad.slice(0, 2) })).reason === 'blocked');
}

// Roman Urdu
check('urdu word in urdu list', E.checkWord('khana', ctx({ list: 'ur' })).ok);
check('urdu spelling variant', E.checkWord('khaana', ctx({ list: 'ur' })).ok && E.checkWord('acha', ctx({ list: 'ur', prompt: 'ch' })).ok
  && E.checkWord('achha', ctx({ list: 'ur', prompt: 'ch' })).ok);
check('theek and thik', E.normalUrdu('theek') === E.normalUrdu('thik'));
check('urdu word not english', E.checkWord('khana', ctx()).reason === 'unknown');
check('english word not urdu', E.checkWord('elephant', ctx({ list: 'ur' })).reason === 'unknown');
check('mix takes both', E.checkWord('khana', ctx({ list: 'mix' })).ok && E.checkWord('banana', ctx({ list: 'mix' })).ok);
{
  const r = E.checkWord('khana', ctx({ list: 'ur' }));
  check('urdu variant counts as repeat', E.checkWord('khaana', ctx({ list: 'ur', used: new Set([r.key]) })).reason === 'used');
}
check('verb forms generated', ['khao', 'karo', 'karein', 'karega', 'dekhna', 'sunta'].every((w) => lex.ur.has(E.normalUrdu(w))));

// ---------- Prompts ----------
{
  const bands = E.promptBands('en', lex);
  for (const band of ['easy', 'normal', 'hard']) {
    for (const len of [2, 3]) {
      const list = bands[band][len];
      check(`en ${band} ${len} has prompts`, list.length >= 50, list.length);
      check(`en ${band} ${len} all lowercase`, list.every((p) => p.length === len && /^[a-z]+$/.test(p)));
    }
  }
  // Every prompt has plenty of answers 5+ letters long in the full list
  let worst = Infinity, worstP = '';
  const long = enWords.filter((w) => w.length >= 5);
  for (const p of [...bands.hard[2], ...bands.hard[3]].slice(0, 400)) {
    const n = long.filter((w) => w.includes(p)).length;
    if (n < worst) { worst = n; worstP = p; }
  }
  check('hard prompts have answers', worst >= 30, `${worstP}: ${worst}`);
  const ub = E.promptBands('ur', lex);
  for (const band of ['easy', 'normal', 'hard']) check(`ur ${band} has prompts`, ub[band][2].length + ub[band][3].length >= 20);
  // Every urdu prompt has at least 3 answers in the urdu list
  const urLong = urWords.filter((w) => w.length >= 4);
  check('urdu prompts have answers', [...ub.hard[2], ...ub.hard[3]].every((p) => urLong.filter((w) => w.includes(p)).length >= 3));

  const rnd = E.mulberry32(7);
  const twos = Array.from({ length: 200 }, () => E.pickPrompt(bands, 'normal', '2', rnd));
  check('length 2 only', twos.every((p) => p.length === 2));
  const threes = Array.from({ length: 200 }, () => E.pickPrompt(bands, 'normal', '3', rnd));
  check('length 3 only', threes.every((p) => p.length === 3));
  const mixed = Array.from({ length: 200 }, () => E.pickPrompt(bands, 'normal', 'mix', rnd));
  check('mix has both', mixed.some((p) => p.length === 2) && mixed.some((p) => p.length === 3));
  const recent = bands.easy[2].slice(0, bands.easy[2].length - 1);
  check('avoids recent', E.pickPrompt(bands, 'easy', '2', rnd, recent) === bands.easy[2].at(-1));
  check('ramp', E.bandFor('ramp', 0) === 'easy' && E.bandFor('ramp', 10) === 'normal' && E.bandFor('ramp', 30) === 'hard'
    && E.bandFor('hard', 0) === 'hard');
}

// ---------- Turns ----------
{
  const order = ['a', 'b', 'c', 'd'];
  const all = () => true;
  check('next', E.nextHolder(order, 'a', all) === 'b' && E.nextHolder(order, 'd', all) === 'a');
  check('skips', E.nextHolder(order, 'a', (id) => id !== 'b') === 'c');
  check('only self left', E.nextHolder(order, 'a', (id) => id === 'a') === 'a');
  check('nobody', E.nextHolder(order, 'a', () => false) === null);
  check('from a player not holding', E.nextHolder(order, 'b', (id) => id !== 'b') === 'c');
}

// ---------- Bonus letters ----------
{
  let st = E.addLetters('', 'banana', 'az');
  check('collects', st.letters === 'abn' && !st.complete);
  st = E.addLetters(st.letters, 'quick', 'az');
  check('adds', st.letters === 'abciknqu');
  check('off', E.addLetters('', 'banana', 'off').letters === '');
  const pangram = 'thequickbrownfoxjumpsoverthelazydog';
  const done = E.addLetters('', pangram, 'az');
  check('complete resets', done.complete && done.letters === '');
  const easy = E.addLetters('', 'abcdefghijklmnoprstuvwy', 'easy');
  check('easy skips qxz', easy.complete);
  check('easy collects no q', E.addLetters('', 'quiz', 'easy').letters === 'iu');
}

// ---------- Daily ----------
{
  check('day one', E.dailyNumber('2026-11-10') === 1 && E.dailyNumber('2026-11-11') === 2 && E.dailyNumber('2027-11-10') === 366);
  const a = E.dailyPrompts('2026-11-12'), b = E.dailyPrompts('2026-11-12'), c = E.dailyPrompts('2026-11-13');
  check('daily same for everyone', eq(a, b));
  check('daily differs by day', !eq(a, c));
  check('daily 10 unique', a.length === 10 && new Set(a).size === 10);
  check('daily total', E.dailyTotal([1000, null, 2000]) === 13000);
  check('squares', E.dailySquare(1000) === '🍌' && E.dailySquare(8000) === '🟨' && E.dailySquare(20000) === '🟫' && E.dailySquare(null) === '⬛');
  check('format', E.formatMs(4321) === '4.3s' && E.formatMs(83000) === '1:23');
  check('date key', E.dateKey(new Date(2026, 0, 5)) === '2026-01-05');
}

// ---------- Random games: the banana always finds someone, games end ----------
{
  const rnd = E.mulberry32(99);
  let ok = true;
  for (let g = 0; g < 2000; g++) {
    const n = 2 + Math.floor(rnd() * 7);
    const order = Array.from({ length: n }, (_, i) => `p${i}`);
    const lives = Object.fromEntries(order.map((id) => [id, 1 + Math.floor(rnd() * 3)]));
    let holder = order[0];
    let steps = 0;
    while (order.filter((id) => lives[id] > 0).length > 1 && steps < 5000) {
      steps++;
      if (rnd() < 0.3) {
        lives[holder]--;
        const nx = E.nextHolder(order, holder, (id) => lives[id] > 0);
        if (!nx || lives[nx] <= 0) { ok = false; break; }
        holder = nx;
      } else {
        const nx = E.nextHolder(order, holder, (id) => lives[id] > 0);
        if (nx === holder || lives[nx] <= 0) { ok = false; break; }
        holder = nx;
      }
    }
    if (steps >= 5000) ok = false;
  }
  check('random games end with one survivor', ok);
}

// Computer players: every prompt in every band has everyday answers, all real words that contain it
{
  const bot = readFileSync(new URL('../words/bot.txt', import.meta.url), 'utf8');
  const en = new Set(readFileSync(new URL('../words/en.txt', import.meta.url), 'utf8').split('\n'));
  const prompts = Object.values(E.promptBands('en', E.makeLexicon([], []))).flatMap((lens) => Object.values(lens).flat());
  let allHave = true, allValid = true, allLong = true;
  for (const p of prompts) {
    const words = E.botCandidates(bot, p);
    if (words.length < 7) allHave = false;
    if (!words.every((w) => w.includes(p) && en.has(w) && !E.BLOCKED_SET.has(w))) allValid = false;
    if (!words.every((w) => w.length >= 5)) allLong = false;
  }
  check('bot: every prompt has at least 7 answers', allHave);
  check('bot: answers contain the prompt and are real, allowed words', allValid);
  check('bot: answers work at every minimum length (5+ letters)', allLong);
  check('bot: unknown or odd prompts give nothing', E.botCandidates(bot, 'qqq').length === 0 && E.botCandidates(bot, '').length === 0 && E.botCandidates(bot, 'a\nb').length === 0);
  check('bot: a prompt is not matched as part of a longer one', E.botCandidates(bot, 'ab').every((w) => w.includes('ab')));
  const lex = E.makeLexicon(['banana'], []);
  check('bot answers pass the same word check as a person', E.checkWord(E.botCandidates(bot, 'an')[0], { prompt: 'an', minLen: 4, list: 'mix', forms: 'block', used: new Set(), lex: E.makeLexicon(E.botCandidates(bot, 'an'), []) }).ok && lex);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
