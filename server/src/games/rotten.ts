// Rotten on the server: the host code that used to run in the host's browser (web/rotten/js/app.js),
// moved here almost line for line. The rules themselves stay in web/rotten/js/engine.js, shared with
// the browser's practice mode.
import * as E from '../../../web/rotten/js/engine.js';
import EN_TEXT from '../../../web/rotten/words/en.txt';
import UR_TEXT from '../../../web/rotten/words/ur.txt';
import BOT_TEXT from '../../../web/rotten/words/bot.txt';
import { botDelay, botId, botName, type BotLevel, humanName, isBotLevel } from '../core/bots';
import type { GameInstance, GameModule, Msg, RoomCtx } from '../core/game';
import { cleanName, cleanPhoto } from '../core/util';
import { SortedWords } from '../core/words';

const GAME = 'rotten';
const AWAY_MS = 9000;
const PRESENCE_MS = 3000;

type Settings = ReturnType<typeof E.cleanSettings>;

interface Player {
  id: string;
  name: string;
  isHost: boolean;
  color: number;
  uid: string | null;
  guest: string | null;
  photo: string;
  clientId: string;
  connected: boolean;
  away: boolean;
  offlineAt: number;
  inGame: boolean;
  alive: boolean;
  lives: number;
  letters: string;
  words: number;
  splats: number;
  longest: string;
  place: number;
  wins: number;
  matchWins: number;
  /** A computer player: no connection, never host, never saved (see core/bots.ts). */
  bot?: boolean;
  botLevel?: BotLevel;
}

interface LogEntry {
  pid: string;
  word: string;
  prompt: string;
  bonus: boolean;
  full: boolean;
}

interface Room {
  code: string;
  public: boolean;
  status: 'lobby' | 'play' | 'over';
  settings: Settings;
  game: number;
  players: Player[];
  order: string[];
  holder: string | null;
  prompt: string;
  promptSplats: number;
  recent: string[];
  startAt: number;
  fuseStart: number;
  fuseEnd: number;
  pausedUntil: number;
  wordsPlayed: number;
  used: Set<string>;
  roomUsed: Set<string>;
  log: LogEntry[];
  wordSeq: number;
  lastSplat: { pid: string; out: boolean; seq: number; lives: number } | null;
  splatSeq: number;
  winner: string | null;
  matchWinner: string | null;
  crew: { name: string } | null;
  crewStatus: string;
  /** A computer player's turn is planned for this time (0: none), for this exact turn. */
  botAt?: number;
  botKey?: string;
}

type Snap = Omit<Room, 'used' | 'roomUsed'> & { used: string[]; roomUsed: string[]; usedIsRoom: boolean };

// Loaded once per isolate, shared by every room in it
let LEX: ReturnType<typeof E.makeLexicon> | null = null;
export function lexicon(): ReturnType<typeof E.makeLexicon> {
  if (!LEX) {
    const ur = UR_TEXT.split('\n').filter(Boolean);
    const lex = E.makeLexicon([], ur);
    // Swap the English Set for the binary-searched list (same `has` interface)
    (lex as unknown as { en: { has(w: string): boolean } }).en = new SortedWords(EN_TEXT);
    LEX = lex;
  }
  return LEX;
}

class RottenRoom implements GameInstance {
  constructor(private ctx: RoomCtx, private room: Room) {}

  /* ---------- Who's here ---------- */

  private byId = (id: string | null) => this.room.players.find((p) => p.id === id);
  private active = (p: Player) => p.connected && !p.away;
  private canHold = (id: string) => {
    const p = this.byId(id);
    return Boolean(p && p.inGame && p.alive && this.active(p));
  };

  private newPlayer(id: string, name: string, color: number): Player {
    const ident = this.ctx.identity(id);
    return {
      id, name, isHost: false, color, uid: ident.uid, guest: ident.guest, photo: '', clientId: '',
      connected: true, away: false, offlineAt: 0, inGame: false, alive: false, lives: 0, letters: '',
      words: 0, splats: 0, longest: '', place: 0, wins: 0, matchWins: 0,
    };
  }

  private freeColor(): number {
    const used = new Set(this.room.players.map((p) => p.color));
    for (let c = 0; c < E.MAX_PLAYERS; c++) if (!used.has(c)) return c;
    return 0;
  }

  /** The room always has a host while anyone is here: if the host goes, the longest-seated player takes over. */
  private ensureHost(): void {
    const room = this.room;
    const host = room.players.find((p) => p.isHost);
    if (host && host.connected) return;
    const next = room.players.find((p) => p.connected && !p.bot);
    if (!next) return;
    if (host) host.isHost = false;
    next.isHost = true;
  }

  join(connId: string, msg: Msg): void {
    const room = this.room;
    const name = humanName(cleanName(msg.name)) || 'Player';
    const ident = this.ctx.identity(connId);
    const clientId = typeof msg.client === 'string' ? msg.client.slice(0, 40) : '';
    const photo = ident.uid ? cleanPhoto(msg.photo) || cleanPhoto(ident.photo) : '';
    // Same tab (refresh), same account, or an offline seat with this name: take the seat back.
    const old = room.players.find((p) => !p.bot && p.name.toLowerCase() === name.toLowerCase()
      && ((clientId && p.clientId === clientId) || (ident.uid && p.uid === ident.uid) || !p.connected));
    if (old) {
      const oldId = old.id;
      if (oldId !== connId) this.ctx.close(oldId, 'replaced');
      room.order = room.order.map((x) => (x === oldId ? connId : x));
      if (room.holder === oldId) room.holder = connId;
      if (room.winner === oldId) room.winner = connId;
      if (room.matchWinner === oldId) room.matchWinner = connId;
      for (const w of room.log) if (w.pid === oldId) w.pid = connId;
      if (room.lastSplat && room.lastSplat.pid === oldId) room.lastSplat.pid = connId;
      Object.assign(old, {
        id: connId, connected: true, away: false, offlineAt: 0, clientId: clientId || old.clientId,
        uid: ident.uid || old.uid, guest: ident.guest || old.guest, photo: photo || old.photo,
      });
      this.ensureHost();
      this.ctx.send(connId, { t: 'welcome', id: connId, code: room.code });
      this.broadcast();
      return;
    }
    if (room.players.length >= E.MAX_PLAYERS) room.players = room.players.filter((p) => p.connected);
    // People come before computer players: in the lobby a newcomer takes the place of the latest bot
    if (room.players.length >= E.MAX_PLAYERS && room.status === 'lobby') {
      const bot = [...room.players].reverse().find((p) => p.bot);
      if (bot) room.players = room.players.filter((p) => p !== bot);
    }
    if (room.players.length >= E.MAX_PLAYERS) return this.reject(connId, `This room is full (${E.MAX_PLAYERS} players).`);
    let finalName = name;
    for (let n = 2; room.players.some((p) => p.name.toLowerCase() === finalName.toLowerCase()); n++) finalName = `${name} ${n}`;
    const seat = this.newPlayer(connId, finalName, this.freeColor());
    seat.clientId = clientId;
    seat.photo = photo;
    room.players.push(seat);   // joined mid-game: watches until the next game
    this.ensureHost();
    this.ctx.send(connId, { t: 'welcome', id: connId, code: room.code });
    this.ctx.track('room_joined');
    this.broadcast();
  }

  private reject(connId: string, reason: string): void {
    this.ctx.send(connId, { t: 'reject', reason });
    this.ctx.close(connId, 'rejected');
  }

  message(connId: string, msg: Msg): void {
    const room = this.room;
    const p = this.byId(connId);
    if (!p) return;
    if (p.away) {
      p.away = false;
      this.broadcast();
    }
    switch (msg.t) {
      case 'word': return this.word(connId, msg.word);
      case 'type': return this.type(connId, msg.text);
      default:
    }
    if (!p.isHost) return;
    switch (msg.t) {
      case 'settings':
        if (room.status !== 'lobby') return;
        room.settings = E.cleanSettings(msg.settings);
        this.broadcast();
        return;
      case 'start': return this.startGame(connId, msg);
      case 'lobby': return this.backToLobby();
      case 'crew': return this.setCrew(msg.name);
      case 'addBot': return this.addBot(connId, msg.level);
      case 'removeBot': return this.removeBot(msg.id);
      case 'botLevel': return this.setBotLevel(msg.id, msg.level);
      case 'public':
        // Open to Quick Play or private: the host can flip it in the lobby only
        if (room.status === 'lobby' && typeof msg.on === 'boolean' && msg.on !== room.public) {
          room.public = msg.on;
          this.broadcast();
        }
        return;
      default:
    }
  }

  close(connId: string): void {
    const room = this.room;
    const p = this.byId(connId);
    if (!p) return;
    if (room.status === 'lobby') room.players = room.players.filter((x) => x !== p);
    else Object.assign(p, { connected: false, offlineAt: this.ctx.now() });
    this.ensureHost();
    this.afterPresence(p);
    this.broadcast();
  }

  /** A room with only computer players left has nobody in it: it is cleaned up like an empty one. */
  occupied(): boolean {
    return this.room.players.some((p) => p.connected && !p.bot);
  }

  /* ---------- Computer players ---------- */

  private addBot(hostId: string, level: unknown): void {
    const room = this.room;
    if (room.status !== 'lobby') return;
    if (room.players.length >= E.MAX_PLAYERS) {
      this.ctx.send(hostId, { t: 'toast', text: 'The room is full' });
      return;
    }
    const rnd = () => this.ctx.random();
    const bot = this.newPlayer(botId(rnd), botName(room.players.map((p) => p.name), rnd), this.freeColor());
    Object.assign(bot, { uid: null, guest: null, bot: true, botLevel: isBotLevel(level) ? level : 'normal' });
    room.players.push(bot);
    this.ctx.track('bot_added');
    this.broadcast();
  }

  private botById(id: unknown): Player | undefined {
    const p = typeof id === 'string' ? this.byId(id) : undefined;
    return p && p.bot ? p : undefined;
  }

  private removeBot(id: unknown): void {
    const bot = this.botById(id);
    if (!bot || this.room.status !== 'lobby') return;
    this.room.players = this.room.players.filter((p) => p !== bot);
    this.broadcast();
  }

  private setBotLevel(id: unknown, level: unknown): void {
    const bot = this.botById(id);
    if (!bot || this.room.status !== 'lobby' || !isBotLevel(level)) return;
    bot.botLevel = level;
    this.broadcast();
  }

  /** After every update: when a computer player holds the banana, plan its answer (once per turn). */
  private botCheck(): void {
    const room = this.room;
    if (room.status !== 'play') return;
    const bot = this.botById(room.holder);
    if (!bot || !bot.alive || !this.active(bot)) return;
    if (!room.players.some((p) => p.connected && !p.bot)) return;   // nobody here to play with: wait
    const key = `${room.game}:${room.wordSeq}:${room.splatSeq}:${bot.id}`;
    const stale = Boolean(room.botAt) && this.ctx.now() > (room.botAt as number) + 4000;   // the timer got lost
    if (room.botKey === key && !stale) return;
    room.botKey = key;
    // Thinking time starts when the banana can actually be answered (after the countdown or a splat)
    const from = Math.max(this.ctx.now(), room.startAt, room.pausedUntil);
    room.botAt = from + botDelay(bot.botLevel || 'normal', this.ctx.random, 2500, 8000);
    this.ctx.setTimer('bot', room.botAt);
  }

  private botAnswer(): void {
    const room = this.room;
    room.botAt = 0;
    if (room.status !== 'play') return;
    const bot = this.botById(room.holder);
    if (!bot || !bot.alive || room.botKey !== `${room.game}:${room.wordSeq}:${room.splatSeq}:${bot.id}`) return;
    const level = bot.botLevel || 'normal';
    // Sometimes it just can't think of anything and the banana splats on it
    if (this.ctx.random() < (level === 'easy' ? 0.3 : 0.1)) return;
    const st = room.settings;
    let pool: string[] = [];
    if (st.words !== 'ur') pool = E.botCandidates(BOT_TEXT, room.prompt);
    if (!pool.length && st.words !== 'en') pool = (lexicon() as { urWords: string[] }).urWords.filter((w) => w.includes(room.prompt));
    pool = pool.filter((w) => w.length >= st.minLen);
    if (level === 'easy') pool = pool.slice(0, 8);   // an easy bot only knows the commonest words
    // Same rules as a person: it only plays a word the room would accept (not used, long enough, in the list)
    const lex = lexicon();
    for (let tries = 0; tries < 12 && pool.length; tries++) {
      const w = pool.splice(Math.floor(this.ctx.random() * pool.length), 1)[0];
      if (E.checkWord(w, { prompt: room.prompt, minLen: st.minLen, list: st.words, forms: st.forms, used: room.used, lex }).ok) {
        this.word(bot.id, w);
        return;
      }
    }
  }

  timer(name: string): void {
    switch (name) {
      case 'fuse': return this.splat();
      case 'bot': return this.botAnswer();
      case 'phase': return this.broadcast();
      case 'presence': return this.presence();
      default:
    }
  }

  // Someone left or went quiet: if they're holding the banana, it moves on (no life lost)
  private afterPresence(p: Player): void {
    const room = this.room;
    if (room.status !== 'play' || room.holder !== p.id || this.active(p)) return;
    const next = E.nextHolder(room.order, p.id, this.canHold);
    if (next && next !== p.id) {
      room.holder = next;
      this.minTurn();
    }
  }

  /** Replaces the host's 2-second heartbeat: runs every few seconds while a game is on. */
  private presence(): void {
    const room = this.room;
    if (room.status !== 'play') return;
    const now = this.ctx.now();
    let changed = false;
    for (const p of room.players) {
      if (p.bot) continue;
      if (p.connected) {
        const seen = this.ctx.lastSeen(p.id);
        if (!seen) {
          // The socket is gone without a close event (the room restarted): treat as left
          Object.assign(p, { connected: false, offlineAt: now });
          changed = true;
          this.ensureHost();
          this.afterPresence(p);
          continue;
        }
        const away = now - seen > AWAY_MS;
        if (away !== p.away) {
          p.away = away;
          changed = true;
          this.afterPresence(p);
        }
      } else if (p.inGame && p.alive && p.offlineAt && now - p.offlineAt > E.TIMES.offlineOutMs) {
        // Gone for good: out of this game, so the others can finish
        this.eliminate(p);
        changed = true;
        if (this.checkWinner()) return;
        this.afterPresence(p);
      }
    }
    this.ctx.setTimer('presence', now + PRESENCE_MS);
    if (changed) this.broadcast();
  }

  /* ---------- A game ---------- */

  private clearTimers(): void {
    this.ctx.clearTimer('fuse');
    this.ctx.clearTimer('phase');
    this.ctx.clearTimer('presence');
  }

  private newPrompt(): void {
    const room = this.room;
    const band = E.bandFor(room.settings.difficulty, room.wordsPlayed);
    room.prompt = E.pickPrompt(E.promptBands(room.settings.words, lexicon()), band, room.settings.promptLen, this.ctx.random, room.recent);
    room.recent = [room.prompt, ...room.recent].slice(0, 40);
    room.promptSplats = 0;
  }

  private scheduleFuse(): void {
    this.ctx.setTimer('fuse', this.room.fuseEnd + 30);
  }

  // Everyone's screen changes when a countdown or splat pause ends, so tell them
  private wakeAt(at: number): void {
    if (at > this.ctx.now()) this.ctx.setTimer('phase', at + 20);
    else this.ctx.clearTimer('phase');
  }

  // Whoever just got the banana has at least a moment to answer
  private minTurn(): void {
    const room = this.room;
    const min = E.minTurnMs(room.settings);
    if (!min) return;
    const now = Math.max(this.ctx.now(), room.pausedUntil, room.startAt);
    if (room.fuseEnd - now < min) {
      room.fuseEnd = now + min;
      this.scheduleFuse();
    }
  }

  private startGame(connId: string, msg: Msg): void {
    const room = this.room;
    const players = room.players.filter((p) => p.connected);
    if (players.length < E.MIN_PLAYERS) {
      this.ctx.send(connId, { t: 'toast', text: `You need at least ${E.MIN_PLAYERS} players` });
      return;
    }
    const typedCrew = String(msg.crew ?? '').replace(/\s+/g, ' ').trim();
    if (room.status === 'lobby' && typeof msg.crew === 'string' && typedCrew !== (room.crew ? room.crew.name : '')) this.setCrew(typedCrew);
    this.clearTimers();
    const st = msg.settings ? E.cleanSettings(msg.settings) : room.settings;
    if (room.matchWinner || st.match !== room.settings.match) {
      for (const p of room.players) p.matchWins = 0;
      room.matchWinner = null;
    }
    room.settings = st;
    room.players = players;
    for (const p of room.players) {
      Object.assign(p, { inGame: true, alive: true, lives: st.lives, letters: '', words: 0, splats: 0, longest: '', place: 0, offlineAt: 0 });
    }
    const ids = room.players.map((p) => p.id);
    room.order = E.shuffle(ids, this.ctx.random);
    room.holder = room.order[Math.floor(this.ctx.random() * room.order.length)];
    room.used = st.noRepeat === 'room' ? room.roomUsed : new Set();
    Object.assign(room, { log: [], wordsPlayed: 0, recent: [], lastSplat: null, winner: null, pausedUntil: 0 });
    this.newPrompt();
    const now = this.ctx.now();
    room.status = 'play';
    room.game++;
    room.startAt = now + E.TIMES.countdownMs;
    room.fuseStart = room.startAt;
    room.fuseEnd = room.startAt + E.fuseMs(st, this.ctx.random);
    this.scheduleFuse();
    this.wakeAt(room.startAt);
    this.ctx.setTimer('presence', now + PRESENCE_MS);
    this.ctx.track('game_started', { words: st.words, difficulty: st.difficulty, fuse: st.fuse, players: ids.length });
    this.broadcast();
  }

  private type(pid: string, text: unknown): void {
    const room = this.room;
    if (room.status !== 'play' || room.holder !== pid) return;
    const msg = { t: 'type', pid, text: E.cleanWord(text) };
    for (const p of room.players) if (p.connected && !p.bot && p.id !== pid) this.ctx.send(p.id, msg);
  }

  private word(pid: string, raw: unknown): void {
    const room = this.room;
    const now = this.ctx.now();
    if (room.status !== 'play' || room.holder !== pid || now < room.startAt || now < room.pausedUntil) return;
    const p = this.byId(pid);
    if (!p || !p.alive) return;
    const st = room.settings;
    const res = E.checkWord(raw, { prompt: room.prompt, minLen: st.minLen, list: st.words, forms: st.forms, used: room.used, lex: lexicon() });
    if (!res.ok) {
      const msg = { t: 'nope', pid, reason: res.reason, word: res.word || '' };
      for (const q of room.players) if (q.connected && !q.bot) this.ctx.send(q.id, msg);
      return;
    }
    room.used.add(res.key as string);
    p.words++;
    const word = res.word as string;
    if (word.length > p.longest.length) p.longest = word;
    const got = E.addLetters(p.letters, word, st.bonus);
    p.letters = got.letters;
    const bonus = got.complete && p.lives < E.maxLivesFor(st);
    if (bonus) p.lives++;
    room.log = [{ pid, word, prompt: room.prompt, bonus, full: got.complete && !bonus }, ...room.log].slice(0, 40);
    room.wordsPlayed++;
    room.wordSeq++;
    room.holder = E.nextHolder(room.order, pid, this.canHold) || pid;
    this.newPrompt();
    this.minTurn();
    this.broadcast();
  }

  private eliminate(p: Player): void {
    p.lives = 0;
    p.alive = false;
    p.place = this.room.players.filter((x) => x.inGame && x.alive).length + 1;
  }

  // The game ends when one player (or nobody) is left
  private checkWinner(): boolean {
    const alive = this.room.players.filter((p) => p.inGame && p.alive);
    if (alive.length > 1) return false;
    this.gameOver(alive[0] || null);
    return true;
  }

  private splat(): void {
    const room = this.room;
    if (room.status !== 'play') return;
    const now = this.ctx.now();
    if (now < room.fuseEnd - 5) {   // the fuse was extended
      this.scheduleFuse();
      return;
    }
    const p = this.byId(room.holder);
    if (!p) return;
    p.lives--;
    p.splats++;
    room.promptSplats++;
    const out = p.lives <= 0;
    if (out) this.eliminate(p);
    room.splatSeq++;
    room.lastSplat = { pid: p.id, out, seq: room.splatSeq, lives: p.lives };
    if (this.checkWinner()) return;
    // Next holder: the next player who's here; if everyone else is away, the next one alive
    room.holder = E.nextHolder(room.order, p.id, this.canHold)
      || E.nextHolder(room.order, p.id, (id: string) => { const q = this.byId(id); return Boolean(q && q.inGame && q.alive); });
    if (room.settings.afterSplat === 'new' || room.promptSplats >= E.PROMPT_MAX_SPLATS) this.newPrompt();
    room.pausedUntil = now + E.TIMES.splatMs;
    room.fuseStart = room.pausedUntil;
    room.fuseEnd = room.pausedUntil + E.fuseMs(room.settings, this.ctx.random);
    this.scheduleFuse();
    this.wakeAt(room.pausedUntil);
    this.broadcast();
  }

  private gameOver(winner: Player | null): void {
    const room = this.room;
    this.clearTimers();
    room.status = 'over';
    room.winner = winner ? winner.id : null;
    if (winner) {
      winner.place = 1;
      winner.wins++;
      winner.matchWins++;
      const target = E.matchTarget(room.settings);
      if (target && winner.matchWins >= target) room.matchWinner = winner.id;
    }
    this.ctx.track('game_finished', { words: room.wordsPlayed, players: room.players.filter((p) => p.inGame).length });
    this.saveGame();
    this.broadcast();
  }

  private backToLobby(): void {
    const room = this.room;
    this.clearTimers();
    room.status = 'lobby';
    room.players = room.players.filter((p) => p.connected);
    for (const p of room.players) Object.assign(p, { inGame: false, alive: false });
    this.broadcast();
  }

  /** Every finished game is saved: each player's stats, and the crew's totals when the room has a crew. */
  private saveGame(): void {
    const room = this.room;
    const game = room.game;
    const winner = room.winner ? this.byId(room.winner) : null;
    const inGame = room.players.filter((p) => p.inGame);
    if (room.crew) room.crewStatus = 'Saving this game…';
    const report = {
      game: GAME,
      room: room.code,
      crew: room.crew ? room.crew.name : null,
      winner: winner ? winner.name : null,
      players: inGame.map((p) => ({
        name: p.name, uid: p.uid, guest: p.guest, ...(p.bot ? { bot: true } : {}), place: p.place, won: p.id === room.winner,
        stats: { games: 1, plays: 1, wins: p.id === room.winner ? 1 : 0, words: p.words, splats: p.splats },
        max: { longest: p.longest.length },
      })),
    };
    this.ctx.later(async () => {
      try {
        const status = await this.ctx.report(report);
        if (room.game !== game || !room.crew) return;
        room.crewStatus = status;
      } catch (err) {
        console.error('saving rotten game failed', err);
        if (room.game !== game || !room.crew) return;
        room.crewStatus = 'This game wasn’t saved. Try again next game.';
      }
      this.ctx.dirty();
      this.broadcast();
    });
  }

  private setCrew(rawName: unknown): void {
    const room = this.room;
    const name = String(rawName ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) {
      Object.assign(room, { crew: null, crewStatus: '' });
      this.broadcast();
      return;
    }
    if (name.toLowerCase().replace(/[^a-z0-9]/g, '').length < 3) {
      const host = room.players.find((p) => p.isHost);
      if (host) this.ctx.send(host.id, { t: 'toast', text: 'Crew names need at least 3 letters or numbers' });
      return;
    }
    room.crew = { name };
    room.crewStatus = 'Connecting to saved scores…';
    this.broadcast();
    this.ctx.later(async () => {
      let status: string;
      try {
        const data = await this.ctx.crewInfo(GAME, name);
        status = data && data.games ? `${data.games} game${data.games === 1 ? '' : 's'} played as this crew so far.` : 'New crew. Scores save after the first game.';
      } catch {
        status = 'Couldn’t reach saved scores right now.';
      }
      if (room.crew?.name !== name) return;
      room.crewStatus = status;
      this.ctx.dirty();
      this.broadcast();
    });
  }

  /* ---------- What everyone sees ---------- */

  // The moment the banana splats stays hidden unless the room shows the timer.
  private publicView(): Msg {
    const room = this.room;
    const now = this.ctx.now();
    const playing = room.status === 'play';
    const st = room.settings;
    return {
      t: 'state',
      code: room.code, status: room.status, settings: st, game: room.game, public: room.public,
      players: room.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost, photo: p.photo,
        bot: Boolean(p.bot), botLevel: p.bot ? p.botLevel || 'normal' : null,
        connected: p.connected, away: p.away, inGame: p.inGame, alive: p.alive, lives: p.lives,
        letters: p.letters, words: p.words, longest: p.longest, splats: p.splats, place: p.place,
        wins: p.wins, matchWins: p.matchWins,
      })),
      order: room.order,
      holder: playing ? room.holder : null,
      prompt: playing && now >= room.startAt ? room.prompt : '',
      startsIn: playing ? room.startAt - now : 0,
      pausedFor: playing ? Math.max(0, room.pausedUntil - now) : 0,
      fuseAge: playing ? now - room.fuseStart : 0,
      fuseLeft: playing && st.showTimer === 'shown' ? room.fuseEnd - now : null,
      log: room.log.slice(0, 14),
      wordsPlayed: room.wordsPlayed, wordSeq: room.wordSeq,
      lastSplat: room.lastSplat,
      used: playing && st.hints === 'on' ? [...room.used] : null,
      winner: room.winner, matchWinner: room.matchWinner,
      crewName: room.crew ? room.crew.name : '',
      crewStatus: room.crewStatus,
    };
  }

  private broadcast(): void {
    const room = this.room;
    const view = this.publicView();
    for (const p of room.players) if (p.connected && !p.bot) this.ctx.send(p.id, view);
    const host = room.players.find((p) => p.isHost);
    // Bots take seats but are not people: with nobody real here the room is not offered at all
    this.ctx.listing(room.players.some((p) => p.connected && !p.bot) ? {
      public: room.public,
      status: room.status,
      players: room.players.filter((p) => p.connected).length,
      max: E.MAX_PLAYERS,
      host: host ? host.name : '',
    } : null);
    this.botCheck();
    this.ctx.dirty();
  }

  snapshot(): Snap {
    const room = this.room;
    return { ...room, used: [...room.used], roomUsed: [...room.roomUsed], usedIsRoom: room.used === room.roomUsed };
  }
}

export const rotten: GameModule = {
  id: GAME,
  maxMsgBytes: 2048,
  rate: { perSec: 15, burst: 40 },
  create(ctx, opts) {
    const room: Room = {
      code: ctx.code, public: opts.public, status: 'lobby', settings: E.cleanSettings({}), game: 0,
      players: [], order: [], holder: null, prompt: '', promptSplats: 0, recent: [],
      startAt: 0, fuseStart: 0, fuseEnd: 0, pausedUntil: 0,
      wordsPlayed: 0, used: new Set(), roomUsed: new Set(), log: [], wordSeq: 0,
      lastSplat: null, splatSeq: 0, winner: null, matchWinner: null, crew: null, crewStatus: '',
    };
    return new RottenRoom(ctx, room);
  },
  restore(ctx, raw) {
    const snap = raw as Snap;
    const roomUsed = new Set(snap.roomUsed);
    const { usedIsRoom, ...rest } = snap;
    const room: Room = { ...rest, roomUsed, used: usedIsRoom ? roomUsed : new Set(snap.used) };
    // Seats whose socket didn't survive the restart are offline now
    const now = ctx.now();
    for (const p of room.players) if (!p.bot && p.connected && !ctx.lastSeen(p.id)) Object.assign(p, { connected: false, offlineAt: now });
    if (room.status === 'lobby') room.players = room.players.filter((p) => p.connected);
    return new RottenRoom(ctx, room);
  },
};
