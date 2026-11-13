// Thulla on the server: the host code from web/thulla/js/app.js, moved here. The server deals,
// holds every hand, checks every move and decides tricks; each player only receives their own
// cards plus public information. Seats have stable ids (p1, p2...) and a current connection.
import * as Engine from '../../../web/thulla/js/engine.js';
import type { GameInstance, GameModule, Msg, RatingInfo, RoomCtx } from '../core/game';
import { botDelay, botName, type BotLevel, humanName, isBotLevel } from '../core/bots';
import { cleanName, cleanPhoto } from '../core/util';
import { reportPlayer } from '../core/seats';

const GAME = 'thulla';
const MAX_PLAYERS = 8;
const RESOLVE_MS = 1700;   // how long a finished trick stays on the table
const TAKE_MS = 15000;     // time to answer a take-cards request
const STUCK_MS = 30000;    // offline player's turn (no timer): the host can play for them after this
const PRESENCE_MS = 3000;
const LOST_MS = 15000;     // a connection silent this long is treated as offline
const CHAT_PHRASES = 8;

type Ev = Record<string, unknown>;
interface Round {
  seats: string[];
  hands: Record<string, string[]>;
  out: string[];
  loser: string | null;
  over: boolean;
  first: boolean;
  trick: unknown[];
  ledSuit: string | null;
  turn: string;
  turnNo: number;
  lastTrick: Ev | null;
  stats: Record<string, { given: number; received: number }>;
  tricks: number;
  gaveUp?: boolean;
}
/** The parts of web/thulla/js/engine.js the server uses, typed. */
interface ThullaEngine {
  createRound(o: { seats: string[]; dealer: number; allowTake: boolean; earlyPlay: boolean; rnd: () => number }): Round;
  play(r: Round, id: string, card: string): { ok: boolean; error?: string; events: Ev[] };
  earlyCards(r: Round, id: string): string[];
  autoCard(r: Round, id: string): string | null;
  legalCards(r: Round, id: string): string[];
  takeTarget(r: Round, id: string): { target: string | null; reason: string };
  markTakeAsked(r: Round): void;
  applyTake(r: Round, from: string, to: string): Ev[];
  botCard(r: Round, id: string, level: string, rnd: () => number): string | null;
  canGiveUp(r: Round, id: string): boolean;
  giveUp(r: Round, id: string): { ok: boolean; error?: string };
  positions(r: Round): Record<string, number>;
}
const E = Engine as unknown as ThullaEngine;

interface Player {
  id: string;
  name: string;
  cid: string;
  conn: string | null;
  online: boolean;
  left: boolean;
  isHost: boolean;
  color: number;
  uid: string | null;
  guest: string | null;
  photo: string;
  lastChat: number;
  /** Skill rating for the lobby and the scores (null: not looked up yet). */
  rating?: RatingInfo | null;
  /** A computer player. Any round with one in it is never rated. */
  bot?: boolean;
  botLevel?: BotLevel;
}

interface Score { rounds: number; losses: number; posSum: number; given: number; received: number; ratingDelta?: number }

interface State {
  code: string;
  public: boolean;
  players: Player[];
  nextId: number;
  settings: { rounds: number; timer: number; allowTake: boolean; earlyPlay: boolean; crew: string };
  phase: 'lobby' | 'playing' | 'between' | 'over';
  roundNo: number;
  dealer: number;
  round: Round | null;
  resolving: (Record<string, unknown> & { seq: number }) | null;
  take: { from: string; to: string; until: number } | null;
  stuck: { turnNo: number; since: number } | null;
  scores: Record<string, Score>;
  history: unknown[];
  lastResult: unknown;
  final: unknown;
  turnDeadline: number;
  turnTimerNo: number;
  allTime: { name: string; rounds: number; players: Record<string, Record<string, number>> } | null;
  crewNote: string;
  seq: number;
  /** A computer player's move (or answer) is planned for this time (0: none), for this turn. */
  botAt?: number;
  botKey?: string;
}

class ThullaRoom implements GameInstance {
  constructor(private ctx: RoomCtx, private H: State) {}

  private byId = (id: string | null | undefined) => this.H.players.find((p) => p.id === id);
  private byConn = (conn: string) => this.H.players.find((p) => p.conn === conn);
  private nameOf = (id: string | null | undefined) => this.byId(id)?.name || '?';
  private hostId = () => this.H.players.find((p) => p.isHost)?.id;

  private freeColor(): number {
    const used = new Set(this.H.players.filter((p) => !p.left).map((p) => p.color));
    for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
    return 0;
  }

  private ensureHost(): void {
    const host = this.H.players.find((p) => p.isHost);
    if (host && host.online && !host.left) return;
    const next = this.H.players.find((p) => p.online && !p.left && !p.bot);
    if (!next) return;
    if (host) host.isHost = false;
    next.isHost = true;
  }

  private clearAllTimers(): void {
    for (const t of ['resolve', 'turn', 'take', 'stuck']) this.ctx.clearTimer(t);
  }

  /* ---------- Connections ---------- */

  join(connId: string, msg: Msg): void {
    const H = this.H;
    const name = humanName(cleanName(msg.name));
    const cid = typeof msg.client === 'string' ? msg.client.slice(0, 40) : '';
    const reply = (m: Msg) => this.ctx.send(connId, m);
    const fail = (text: string) => {
      reply({ t: 'reject', reason: text });
      this.ctx.close(connId, 'rejected');
    };
    if (!name) return fail('Type your name first.');
    const ident = this.ctx.identity(connId);
    let p = H.players.find((x) => !x.bot && x.name.toLowerCase() === name.toLowerCase());
    if (p) {
      const sameTab = cid && p.cid === cid;
      const sameAccount = ident.uid && p.uid === ident.uid;
      if (p.online && !sameTab && !sameAccount && p.conn && this.ctx.lastSeen(p.conn)) {
        return fail(`Someone called ${name} is already in this room. Pick another name.`);
      }
      if (p.left) {
        if (H.players.filter((x) => !x.left).length >= MAX_PLAYERS) return fail(`This room is full (${MAX_PLAYERS} players).`);
        if (H.players.some((x) => x !== p && !x.left && x.color === p?.color)) p.color = this.freeColor();
      }
      if (p.conn && p.conn !== connId) this.ctx.close(p.conn, 'replaced');
      Object.assign(p, { conn: connId, online: true, left: false, cid: cid || p.cid });
    } else {
      // People come before computer players: in the lobby a newcomer takes the place of the latest bot
      if (H.phase === 'lobby' && H.players.filter((x) => !x.left).length >= MAX_PLAYERS) {
        const bot = [...H.players].reverse().find((x) => x.bot);
        if (bot) H.players = H.players.filter((x) => x !== bot);
      }
      if (H.players.filter((x) => !x.left).length >= MAX_PLAYERS) return fail(`This room is full (${MAX_PLAYERS} players).`);
      p = {
        id: `p${H.nextId++}`, name, cid, conn: connId, online: true, left: false, isHost: false,
        color: this.freeColor(), uid: null, guest: null, photo: '', lastChat: 0,
      };
      H.players.push(p);
    }
    p.uid = ident.uid || p.uid;
    p.guest = ident.guest || p.guest;
    p.photo = ident.uid ? cleanPhoto(msg.photo) || cleanPhoto(ident.photo) : '';
    this.ensureHost();
    reply({ t: 'welcome', id: p.id, code: H.code });
    const inRound = Boolean(H.round && H.phase === 'playing' && H.round.seats.includes(p.id));
    if (H.phase === 'playing' && !inRound) reply({ t: 'note', msg: 'A round is in progress. You’ll be dealt in next round.' });
    this.fxAll({ kind: 'joined', name: p.name, back: inRound }, p.id);
    this.loadRating(p);
    this.ctx.track('room_joined');
    this.refreshStuck();
    this.broadcast();
  }

  /** Look up the rating of someone who just joined or came back, and show it once it arrives. */
  private loadRating(p: Player): void {
    if (!p.uid && !p.guest) return;
    this.ctx.later(async () => {
      const [info] = await this.ctx.ratings(GAME, [{ uid: p.uid, guest: p.guest }]);
      if (!info) return;
      p.rating = info;
      this.broadcast();
    });
  }

  /** Average rating of the people in the room, for Quick Play matching. */
  private listingRating(): number | null {
    const rated = this.H.players.filter((p) => p.online && !p.left && p.rating);
    return rated.length ? Math.round(rated.reduce((n, p) => n + (p.rating as RatingInfo).rating, 0) / rated.length) : null;
  }

  message(connId: string, msg: Msg): void {
    const p = this.byConn(connId);
    if (!p) return;
    switch (msg.t) {
      case 'play': return this.play(p, String(msg.card || ''));
      case 'take': return this.takeAsk(p);
      case 'chat': return this.chat(p, msg.i);
      case 'giveup': return this.giveUp(p);
      case 'takeReply': return this.takeReply(p, Boolean(msg.accept));
      case 'leave': return this.leave(p);
      default:
    }
    if (!p.isHost) return;
    switch (msg.t) {
      case 'settings': return this.setSettings(msg.patch);
      case 'crew': return this.useCrew(msg.name);
      case 'start': return this.startRound(p);
      case 'endRound': return this.endRoundEarly();
      case 'endGame': return this.endGame();
      case 'rematch': this.resetGame(); return this.startRound(p);
      case 'changeSettings':
        this.resetGame();
        this.H.phase = 'lobby';
        return this.broadcast();
      case 'playFor': return this.playFor();
      case 'addBot': return this.addBot(p, msg.level);
      case 'removeBot': return this.removeBot(msg.id);
      case 'botLevel': return this.setBotLevel(msg.id, msg.level);
      case 'public':
        // Open to Quick Play or private: the host can flip it in the lobby only
        if (this.H.phase === 'lobby' && typeof msg.on === 'boolean' && msg.on !== this.H.public) {
          this.H.public = msg.on;
          this.broadcast();
        }
        return;
      default:
    }
  }

  close(connId: string): void {
    const H = this.H;
    const p = this.byConn(connId);
    if (!p) return;
    p.conn = null;
    p.online = false;
    if (H.phase === 'lobby') {
      H.players = H.players.filter((x) => x !== p);
    } else {
      this.fxAll({ kind: 'offline', name: p.name });
      if (H.take && (H.take.to === p.id || H.take.from === p.id)) this.takeResolve(false, 'offline');
    }
    this.ensureHost();
    this.refreshStuck();
    this.broadcast();
  }

  private leave(p: Player): void {
    const H = this.H;
    if (p.conn) this.ctx.close(p.conn, 'left');
    Object.assign(p, { conn: null, online: false, left: true });
    if (H.phase === 'lobby') H.players = H.players.filter((x) => x !== p);
    else {
      this.fxAll({ kind: 'left', name: p.name });
      if (H.take && (H.take.to === p.id || H.take.from === p.id)) this.takeResolve(false, 'offline');
    }
    this.ensureHost();
    this.refreshStuck();
    this.broadcast();
  }

  /** A room with only computer players left has nobody in it: it is cleaned up like an empty one. */
  occupied(): boolean {
    return this.H.players.some((p) => p.online && !p.bot);
  }

  /* ---------- Computer players ---------- */

  private addBot(host: Player, level: unknown): void {
    const H = this.H;
    if (H.phase !== 'lobby') return;
    if (H.players.filter((x) => !x.left).length >= MAX_PLAYERS) {
      if (host.conn) this.ctx.send(host.conn, { t: 'error', msg: 'The room is full.' });
      return;
    }
    const rnd = () => this.ctx.random();
    H.players.push({
      id: `p${H.nextId++}`, name: botName(H.players.map((x) => x.name), rnd), cid: '', conn: null, online: true, left: false,
      isHost: false, color: this.freeColor(), uid: null, guest: null, photo: '', lastChat: 0,
      bot: true, botLevel: isBotLevel(level) ? level : 'normal',
    });
    this.ctx.track('bot_added');
    this.broadcast();
  }

  private botById(id: unknown): Player | undefined {
    const p = typeof id === 'string' ? this.byId(id) : undefined;
    return p && p.bot ? p : undefined;
  }

  private removeBot(id: unknown): void {
    const bot = this.botById(id);
    if (!bot || this.H.phase !== 'lobby') return;
    this.H.players = this.H.players.filter((x) => x !== bot);
    this.broadcast();
  }

  private setBotLevel(id: unknown, level: unknown): void {
    const bot = this.botById(id);
    if (!bot || this.H.phase !== 'lobby' || !isBotLevel(level)) return;
    bot.botLevel = level;
    this.broadcast();
  }

  /** After every update: plan the next computer move (or answer to a card request), once per turn. */
  private botCheck(): void {
    const H = this.H;
    const r = H.round;
    if (H.phase !== 'playing' || !r || r.over || H.resolving) return;
    if (!H.players.some((p) => p.online && !p.bot)) return;   // nobody here to play with: wait
    let key = '';
    let who: Player | undefined;
    if (H.take) {
      who = this.botById(H.take.to);
      key = `take:${H.roundNo}:${H.take.until}`;
    } else {
      who = this.botById(r.turn);
      key = `t:${H.roundNo}:${r.turnNo}`;
    }
    if (!who) return;
    const stale = H.botAt && this.ctx.now() > H.botAt + 4000;   // the timer got lost
    if (H.botKey === key && !stale) return;
    H.botKey = key;
    H.botAt = this.ctx.now() + botDelay(who.botLevel || 'normal', () => this.ctx.random(), 700, 2200);
    this.ctx.setTimer('bot', H.botAt);
  }

  private botAct(): void {
    const H = this.H;
    H.botAt = 0;
    const r = H.round;
    if (H.phase !== 'playing' || !r || r.over || H.resolving) return;
    if (H.take) {
      const to = this.botById(H.take.to);
      // A computer player takes the offer: handing over its hand gets it out of the round
      if (to && H.botKey === `take:${H.roundNo}:${H.take.until}`) this.takeReply(to, true);
      return;
    }
    const bot = this.botById(r.turn);
    if (!bot || H.botKey !== `t:${H.roundNo}:${r.turnNo}`) return;
    const card = E.botCard(r, bot.id, bot.botLevel || 'normal', () => this.ctx.random());
    // The same play() a person goes through: it checks the turn and that the card is legal
    if (card) this.play(bot, card);
  }

  timer(name: string): void {
    const H = this.H;
    switch (name) {
      case 'resolve': {
        const r = H.round;
        H.resolving = null;
        if (r && r.over) this.finishRound();
        else { this.startTurnClock(); this.broadcast(); }
        return;
      }
      case 'turn': return this.autoPlay(H.turnTimerNo);
      case 'take': return this.takeResolve(false, 'timeout');
      case 'stuck': return this.broadcast();
      case 'bot': return this.botAct();
      case 'presence': return this.presence();
      default:
    }
  }

  /** A dropped network doesn't always close the socket: a silent connection counts as offline. */
  private presence(): void {
    const H = this.H;
    if (H.phase === 'lobby') return;
    const now = this.ctx.now();
    let changed = false;
    for (const p of H.players) {
      if (!p.online || !p.conn) continue;
      const seen = this.ctx.lastSeen(p.conn);
      if (!seen || now - seen > LOST_MS) {
        this.ctx.close(p.conn, 'lost');
        p.conn = null;
        p.online = false;
        changed = true;
        if (H.take && (H.take.to === p.id || H.take.from === p.id)) this.takeResolve(false, 'offline');
      }
    }
    if (changed) {
      this.ensureHost();
      this.refreshStuck();
      this.broadcast();
    }
    this.ctx.setTimer('presence', now + PRESENCE_MS);
  }

  /* ---------- Settings and flow ---------- */

  private setSettings(patch: unknown): void {
    const H = this.H;
    if (H.phase !== 'lobby' || !patch || typeof patch !== 'object') return;
    const raw = patch as Record<string, unknown>;
    if ([0, 3, 5, 10].includes(raw.rounds as number)) H.settings.rounds = raw.rounds as number;
    if ([0, 15, 30, 60].includes(raw.timer as number)) H.settings.timer = raw.timer as number;
    if (typeof raw.allowTake === 'boolean') H.settings.allowTake = raw.allowTake;
    if (typeof raw.earlyPlay === 'boolean') H.settings.earlyPlay = raw.earlyPlay;
    this.broadcast();
  }

  private useCrew(raw: unknown): void {
    const H = this.H;
    const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) {
      Object.assign(H, { allTime: null, crewNote: '' });
      H.settings.crew = '';
      return this.broadcast();
    }
    if (name.toLowerCase().replace(/[^a-z0-9]/g, '').length < 3) {
      H.crewNote = 'Use at least 3 letters or numbers.';
      return this.broadcast();
    }
    H.settings.crew = name;
    H.crewNote = 'Loading crew scores…';
    this.broadcast();
    this.ctx.later(async () => {
      try {
        const table = await this.ctx.crewInfo(GAME, name);
        if (H.settings.crew !== name) return;
        H.crewNote = table && table.games ? `Saving to “${name}”. ${table.games} rounds saved so far.` : `Saving to new crew “${name}”.`;
      } catch {
        H.crewNote = 'Couldn’t load that crew. Try again.';
      }
      this.ctx.dirty();
      this.broadcast();
    });
  }

  private startRound(by: Player): void {
    const H = this.H;
    const seats = H.players.filter((p) => !p.left && p.online).map((p) => p.id);
    if (seats.length < 2) {
      if (by.conn) this.ctx.send(by.conn, { t: 'error', msg: 'You need at least 2 players to start.' });
      return;
    }
    this.clearAllTimers();
    H.dealer = (H.dealer + 1) % seats.length;
    H.round = E.createRound({ seats, dealer: H.dealer, allowTake: H.settings.allowTake, earlyPlay: H.settings.earlyPlay, rnd: () => this.ctx.random() });
    for (const id of seats) H.scores[id] ||= { rounds: 0, losses: 0, posSum: 0, given: 0, received: 0 };
    H.roundNo++;
    if (H.roundNo === 1) this.ctx.track('game_started', { players: seats.length, timer: H.settings.timer });
    H.phase = 'playing';
    Object.assign(H, { resolving: null, take: null, stuck: null, lastResult: null, final: null });
    this.fxAll({ kind: 'roundStart', no: H.roundNo, leader: this.nameOf(H.round.turn) });
    this.startTurnClock();
    this.ctx.setTimer('presence', this.ctx.now() + PRESENCE_MS);
    this.broadcast();
  }

  private endRoundEarly(): void {
    const H = this.H;
    if (H.phase !== 'playing') return;
    this.clearAllTimers();
    H.history.unshift({ no: H.roundNo, ended: true });
    H.lastResult = { no: H.roundNo, ended: true, results: [] };
    Object.assign(H, { round: null, resolving: null, take: null, stuck: null });
    H.phase = H.settings.rounds && H.roundNo >= H.settings.rounds ? 'over' : 'between';
    if (H.phase === 'over') H.final = this.standings();
    this.broadcast();
  }

  private endGame(): void {
    const H = this.H;
    this.ctx.track('game_finished', { rounds: H.roundNo, players: Object.keys(H.scores).length });
    this.clearAllTimers();
    Object.assign(H, { round: null, resolving: null, take: null, phase: 'over' });
    H.final = this.standings();
    this.broadcast();
  }

  private resetGame(): void {
    const H = this.H;
    Object.assign(H, { scores: {}, history: [], roundNo: 0, lastResult: null, final: null, round: null });
    // Forget players who left; keep everyone else in their seats.
    H.players = H.players.filter((p) => !p.left && p.online);
  }

  /* ---------- Playing ---------- */

  private canAct(pid: string): boolean {
    const H = this.H;
    const r = H.round;
    return Boolean(H.phase === 'playing' && r && !r.over && !H.resolving && !H.take && r.turn === pid);
  }

  private canEarly(pid: string): boolean {
    const H = this.H;
    const r = H.round;
    return Boolean(H.phase === 'playing' && r && !r.over && !H.resolving && !H.take && E.earlyCards(r, pid).length > 0);
  }

  private sendTo(p: Player, msg: Msg): void {
    if (p.conn && p.online) this.ctx.send(p.conn, msg);
  }

  private play(p: Player, card: string): void {
    const H = this.H;
    const r = H.round;
    if (!r || (!this.canAct(p.id) && !this.canEarly(p.id))) {
      this.sendTo(p, { t: 'error', msg: H.take ? 'Wait for the answer to the card request.' : 'Wait for your turn.' });
      this.broadcast();
      return;
    }
    const res = E.play(r, p.id, card);
    if (!res.ok) {
      this.sendTo(p, { t: 'error', msg: res.error });
      this.broadcast();
      return;
    }
    if (res.events.length === 1 && res.events[0].early) return this.broadcast();   // turn and timer carry on
    this.afterEvents(res.events);
  }

  private afterEvents(events: Array<Record<string, unknown>>): void {
    const H = this.H;
    const r = H.round;
    for (const e of events) {
      if (e.type === 'thulla') this.fxAll({ kind: 'thulla', giver: this.nameOf(e.giver as string), receiver: this.nameOf(e.receiver as string), receiverId: e.receiver, count: e.count, jumped: e.jumped });
      if (e.type === 'finish' && !e.cancelled) this.fxAll({ kind: 'finish', id: e.id, name: this.nameOf(e.id as string), pos: e.pos });
      if (e.type === 'take') this.fxAll({ kind: 'take', from: this.nameOf(e.from as string), to: this.nameOf(e.to as string), count: e.count });
    }
    this.ctx.clearTimer('turn');
    if (r && events.some((e) => e.type === 'discard' || e.type === 'thulla')) {
      H.resolving = { seq: ++H.seq, ...(r.lastTrick || {}) };
      H.stuck = null;
      this.ctx.setTimer('resolve', this.ctx.now() + RESOLVE_MS);
      this.broadcast();
      return;
    }
    this.startTurnClock();
    this.broadcast();
  }

  private startTurnClock(): void {
    const H = this.H;
    this.ctx.clearTimer('turn');
    const r = H.round;
    H.turnDeadline = 0;
    if (!r || r.over || H.resolving || H.take || H.phase !== 'playing') return this.refreshStuck();
    if (H.settings.timer) {
      const ms = H.settings.timer * 1000;
      H.turnDeadline = this.ctx.now() + ms;
      H.turnTimerNo = r.turnNo;
      this.ctx.setTimer('turn', H.turnDeadline + 150);
    }
    this.refreshStuck();
  }

  private autoPlay(turnNo: number): void {
    const H = this.H;
    const r = H.round;
    if (!r || r.over || r.turnNo !== turnNo || H.resolving || H.take) return;
    const id = r.turn;
    const card = E.autoCard(r, id);
    if (!card) return;
    const res = E.play(r, id, card);
    if (!res.ok) return;
    this.fxAll({ kind: 'auto', id, name: this.nameOf(id), card });
    this.afterEvents(res.events);
  }

  private refreshStuck(): void {
    const H = this.H;
    this.ctx.clearTimer('stuck');
    const r = H.round;
    if (!r || r.over || H.phase !== 'playing' || H.settings.timer || H.resolving || H.take) {
      H.stuck = null;
      return;
    }
    const p = this.byId(r.turn);
    if (p && !p.online) {
      if (!H.stuck || H.stuck.turnNo !== r.turnNo) H.stuck = { turnNo: r.turnNo, since: this.ctx.now() };
      const at = H.stuck.since + STUCK_MS;
      if (at > this.ctx.now()) this.ctx.setTimer('stuck', at + 50);
    } else {
      H.stuck = null;
    }
  }

  private playFor(): void {
    const H = this.H;
    const r = H.round;
    if (!r || !H.stuck || r.turnNo !== H.stuck.turnNo || this.ctx.now() - H.stuck.since < STUCK_MS) return;
    this.autoPlay(r.turnNo);
  }

  private giveUp(p: Player): void {
    const H = this.H;
    const r = H.round;
    if (H.phase !== 'playing' || !r || r.over || H.resolving || !E.canGiveUp(r, p.id)) {
      this.sendTo(p, { t: 'error', msg: 'You can only give up when two players are left.' });
      return;
    }
    H.take = null;
    this.clearAllTimers();
    const res = E.giveUp(r, p.id);
    if (!res.ok) return this.sendTo(p, { t: 'error', msg: res.error });
    this.ctx.track('give_up');
    this.fxAll({ kind: 'gaveUp', id: p.id, name: p.name });
    this.finishRound();
  }

  private chat(p: Player, i: unknown): void {
    if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= CHAT_PHRASES) return;
    const now = this.ctx.now();
    if (now - (p.lastChat || 0) < 1500) return;   // no spamming
    p.lastChat = now;
    this.fxAll({ kind: 'chat', id: p.id, i });
  }

  private takeAsk(p: Player): void {
    const H = this.H;
    const r = H.round;
    if (!r || !this.canAct(p.id)) return this.sendTo(p, { t: 'error', msg: 'You can only ask on your turn, before you lead.' });
    const { target, reason } = E.takeTarget(r, p.id);
    if (!target) return this.sendTo(p, { t: 'error', msg: reason });
    const t = this.byId(target);
    if (!t || !t.online) return this.sendTo(p, { t: 'error', msg: `${this.nameOf(target)} is offline right now.` });
    E.markTakeAsked(r);
    this.ctx.clearTimer('turn');
    H.turnDeadline = 0;
    H.take = { from: p.id, to: target, until: this.ctx.now() + TAKE_MS };
    this.ctx.setTimer('take', H.take.until);
    this.fxAll({ kind: 'takeAsk', from: p.name, to: t.name, toId: t.id });
    this.refreshStuck();
    this.broadcast();
  }

  private takeReply(p: Player, accept: boolean): void {
    if (!this.H.take || this.H.take.to !== p.id) return;
    this.takeResolve(accept, 'answer');
  }

  private takeResolve(accept: boolean, why: string): void {
    const H = this.H;
    const tk = H.take;
    if (!tk) return;
    this.ctx.clearTimer('take');
    H.take = null;
    const r = H.round;
    if (accept && r && !r.over && r.turn === tk.from) return this.afterEvents(E.applyTake(r, tk.from, tk.to));
    this.fxAll({ kind: 'takeNo', from: this.nameOf(tk.from), to: this.nameOf(tk.to), why });
    this.startTurnClock();
    this.broadcast();
  }

  /* ---------- Round end and scores ---------- */

  private finishRound(): void {
    const H = this.H;
    const r = H.round;
    if (!r) return;
    this.clearAllTimers();
    const pos = E.positions(r);
    const results = r.seats.map((id) => ({
      id, name: this.nameOf(id), pos: pos[id], lost: id === r.loser,
      given: r.stats[id].given, received: r.stats[id].received,
    })).sort((a, b) => a.pos - b.pos);
    for (const x of results) {
      const s = H.scores[x.id];
      s.rounds++; s.losses += x.lost ? 1 : 0; s.posSum += x.pos; s.given += x.given; s.received += x.received;
    }
    H.history.unshift({ no: H.roundNo, loser: this.nameOf(r.loser), players: r.seats.length, gaveUp: Boolean(r.gaveUp) });
    H.lastResult = { no: H.roundNo, ended: false, loser: r.loser, results, gaveUp: Boolean(r.gaveUp) };
    const gameOver = Boolean(H.settings.rounds && H.roundNo >= H.settings.rounds);
    this.ctx.track('round_finished', { players: results.length, round: H.roundNo });
    H.phase = gameOver ? 'over' : 'between';
    H.round = null;
    if (gameOver) H.final = this.standings();
    this.fxAll({ kind: 'roundOver', loser: this.nameOf(r.loser), loserId: r.loser });
    this.saveRound(results);
    this.rateRound(results);
    this.broadcast();
  }

  /**
   * Skill ratings, one update per finished round (rounds are what Thulla saves, and an
   * unlimited game never "ends"). The finishing order of the round is the result: every pair of
   * players is one game won by whoever got out first, the loser being last (see core/glicko2.ts).
   * Everyone dealt into the round counts, even someone who left or went offline during it, so
   * walking away never saves you from a loss. Rounds the host ended early have no result and
   * aren't rated; a round with a computer player (bot) in it is never rated.
   */
  private rateRound(results: Array<{ id: string; pos: number }>): void {
    const H = this.H;
    const roundNo = H.roundNo;
    const players = results.map((x) => this.byId(x.id) as Player);
    const entries = results.map((x, i) => ({ uid: players[i].uid, guest: players[i].guest, bot: players[i].bot, place: x.pos }));
    this.ctx.later(async () => {
      const changes = await this.ctx.rate(GAME, entries);
      const res = H.lastResult as { no: number; results: Array<{ id: string; rating?: { delta: number; now: number; prov: boolean } }> } | null;
      results.forEach((x, i) => {
        const c = changes[i];
        if (!c) return;
        players[i].rating = c;
        const s = H.scores[x.id];
        if (s) s.ratingDelta = (s.ratingDelta ?? 0) + c.delta;
        const row = res && res.no === roundNo ? res.results.find((r) => r.id === x.id) : undefined;
        if (row) row.rating = { delta: c.delta, now: c.rating, prov: c.provisional };
      });
      if (H.phase === 'over' && H.final) H.final = this.standings();   // the final table shows the session's rating change
      this.broadcast();
    });
  }

  /** Each round is saved: every player's stats, and the crew's totals when there is a crew. */
  private saveRound(results: Array<{ id: string; pos: number; lost: boolean; given: number; received: number }>): void {
    const H = this.H;
    const crew = H.settings.crew || null;
    const players = results.map((x) => {
      const p = this.byId(x.id) as Player;
      return reportPlayer({ ...p, inGame: true, away: false, offlineAt: 0, clientId: p.cid, connected: p.online, id: p.id }, x.pos, !x.lost, {
        rounds: 1, losses: x.lost ? 1 : 0, posSum: x.pos, given: x.given, received: x.received,
      });
    });
    const roundNo = H.roundNo;
    this.ctx.later(async () => {
      try {
        const status = await this.ctx.report({ game: GAME, room: H.code, crew, winner: null, players });
        if (crew && H.settings.crew === crew && H.roundNo === roundNo) H.crewNote = status ? status.replace(/game/g, 'round') : `Saved to “${crew}”.`;
      } catch {
        if (crew) H.crewNote = 'Couldn’t save this round to the crew.';
      }
      this.ctx.dirty();
      this.broadcast();
    });
  }

  private standings() {
    const H = this.H;
    const rows = Object.entries(H.scores).map(([id, s]) => {
      const p = this.byId(id);
      return {
        id, name: p ? p.name : '?', color: p ? p.color : 0, gone: !p || p.left || !p.online,
        rounds: s.rounds, losses: s.losses, avg: s.rounds ? s.posSum / s.rounds : 0,
        given: s.given, received: s.received, ratingDelta: s.ratingDelta ?? null,
      };
    });
    const avgKey = (x: { rounds: number; avg: number }) => (x.rounds ? x.avg : Infinity);
    rows.sort((a, b) => a.losses - b.losses || avgKey(a) - avgKey(b) || b.rounds - a.rounds || a.name.localeCompare(b.name));
    return rows;
  }

  /* ---------- Views (what each player is allowed to see) ---------- */

  private buildView(pid: string): Msg {
    const H = this.H;
    const r = H.round;
    const now = this.ctx.now();
    const inGame = (p: Player) => (r && r.seats.includes(p.id)) || H.scores[p.id];
    const players = H.players.filter((p) => !p.left || inGame(p)).map((p) => ({
      id: p.id, name: p.name, color: p.color, online: p.online, left: p.left, isHost: p.isHost, photo: p.photo,
      bot: Boolean(p.bot), botLevel: p.bot ? p.botLevel || 'normal' : null,
      rating: p.rating ? p.rating.rating : null, ratingProv: Boolean(p.rating?.provisional),
      inRound: Boolean(r && r.seats.includes(p.id)),
      count: r && r.hands[p.id] ? r.hands[p.id].length : null,
      safe: r ? r.out.indexOf(p.id) + 1 : 0,
    }));
    let round: Msg | null = null;
    if (r && H.phase === 'playing') {
      const take = E.takeTarget(r, pid);
      const stuckReady = Boolean(H.stuck && now - H.stuck.since >= STUCK_MS);
      const res = H.resolving;
      round = {
        seats: r.seats,
        turn: r.turn,
        first: r.first,
        ledSuit: res ? null : r.ledSuit,
        trick: res ? res.cards : r.trick,
        resolving: res ? { seq: res.seq, kind: res.kind, winner: res.winner, giver: res.giver } : null,
        discarded: r.tricks > 0,
        hand: r.hands[pid] ? r.hands[pid].slice() : null,
        legal: this.canAct(pid) ? E.legalCards(r, pid) : [],
        early: this.canEarly(pid) ? E.earlyCards(r, pid) : [],
        myTurn: this.canAct(pid),
        timer: H.settings.timer,
        turnMs: H.turnDeadline ? Math.max(0, H.turnDeadline - now) : 0,
        take: H.take ? { from: H.take.from, to: H.take.to, ms: Math.max(0, H.take.until - now) } : null,
        canTake: this.canAct(pid) && Boolean(take.target),
        canGiveUp: !res && E.canGiveUp(r, pid),
        takeTarget: take.target,
        playFor: pid === this.hostId() && stuckReady ? r.turn : null,
        stuck: H.stuck ? r.turn : null,
      };
    }
    return {
      code: H.code,
      public: H.public,
      phase: H.phase,
      you: pid,
      hostId: this.hostId(),
      settings: { ...H.settings },
      roundNo: H.roundNo,
      players,
      round,
      standings: this.standings(),
      history: H.history.slice(0, 15),
      result: H.lastResult,
      final: H.final,
      allTime: null,
      crewNote: pid === this.hostId() ? H.crewNote : '',
    };
  }

  private broadcast(): void {
    const H = this.H;
    for (const p of H.players) if (p.online && p.conn) this.ctx.send(p.conn, { t: 'state', v: this.buildView(p.id) });
    const host = H.players.find((p) => p.isHost);
    // Bots take seats but are not people: with nobody real here the room is not offered at all
    this.ctx.listing(H.players.some((p) => p.online && !p.bot) ? {
      public: H.public,
      status: H.phase === 'lobby' ? 'lobby' : 'play',
      players: H.players.filter((p) => p.online).length,
      max: MAX_PLAYERS,
      host: host ? host.name : '',
      rating: this.listingRating(),
    } : null);
    this.botCheck();
    this.ctx.dirty();
  }

  private fxAll(fx: Msg, exceptId?: string): void {
    for (const p of this.H.players) if (p.id !== exceptId && p.online) this.sendTo(p, { t: 'fx', fx });
  }

  snapshot(): unknown {
    return this.H;
  }
}

export const thulla: GameModule = {
  id: GAME,
  maxMsgBytes: 1024,
  rate: { perSec: 10, burst: 30 },
  create(ctx: RoomCtx, opts) {
    return new ThullaRoom(ctx, {
      code: ctx.code, public: opts.public, players: [], nextId: 1,
      settings: { rounds: 0, timer: 0, allowTake: false, earlyPlay: false, crew: '' },
      phase: 'lobby', roundNo: 0, dealer: -1, round: null, resolving: null, take: null, stuck: null,
      scores: {}, history: [], lastResult: null, final: null, turnDeadline: 0, turnTimerNo: 0,
      allTime: null, crewNote: '', seq: 0,
    });
  },
  restore(ctx, snap) {
    const H = snap as State;
    for (const p of H.players) if (!p.bot && p.online && (!p.conn || !ctx.lastSeen(p.conn))) Object.assign(p, { online: false, conn: null });
    if (H.phase === 'lobby') H.players = H.players.filter((p) => p.online);
    return new ThullaRoom(ctx, H);
  },
};
