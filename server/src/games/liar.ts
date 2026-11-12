// The Liar on the server: the host code from web/the-liar/js/app.js, moved here. The word, the liar,
// the secret time and every stop stay on the server; each player only ever receives their own card.
import * as E from '../../../web/the-liar/js/engine.js';
import type { GameModule, Msg, RoomCtx } from '../core/game';
import { type BaseRoom, reportPlayer, restoreSeats, type Seat, SeatRoom } from '../core/seats';

const GAME = 'the-liar';
const MAX_STROKES_PER_TURN = 200;

interface Settings {
  play: 'draw' | 'words' | 'time';
  mode: 'stroke' | 'free';
  seconds: number;
  wordSeconds: number;
  discussSeconds: number;
  categories: string[];
}

interface Player extends Seat {
  ready: boolean;
  voteNow: boolean;
  score: number;
}

interface Stroke { sid: string; pid: string; color: number; pts: number[] }
interface Clue { pid: string; color: number; round: number; turn: number; text: string; passed?: boolean }

interface Room extends BaseRoom<Player> {
  settings: Settings;
  used: string[];
  liar: string | null;
  lastLiar: string | null;
  word: string;
  category: string;
  order: string[];
  round: number;
  turn: number;
  turnStart: number;
  deadline: number;
  strokeSid: string | null;
  turnStrokes: number;
  strokes: Stroke[];
  clues: Clue[];
  time: { target: number; lo: number; hi: number } | null;
  stops: Record<string, number>;
  started: Record<string, boolean>;
  votes: Record<string, string>;
  options: string[];
  accused: string | null;
  guess: string | null;
  result: string | null;
  delta: Record<string, number>;
}

function cleanSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = <T>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
  return {
    play: pick(r.play, ['draw', 'words', 'time'] as const, 'draw'),
    mode: pick(r.mode, ['stroke', 'free'] as const, 'stroke'),
    seconds: pick(r.seconds, E.FREE_SECONDS, 8),
    wordSeconds: pick(r.wordSeconds, E.WORD_SECONDS, 30),
    discussSeconds: pick(r.discussSeconds, E.DISCUSS_SECONDS, 60),
    categories: Array.isArray(r.categories) ? r.categories.filter((c): c is string => typeof c === 'string').slice(0, 40) : [],
  };
}

const wordsGame = (st: Settings) => st.play === 'words';
const timeGame = (st: Settings) => st.play === 'time';

/** A drawing that is too big to keep is thinned (every other point, ends kept) until it fits. */
function thinStrokes(strokes: Array<{ p: number | null; pts: number[] }>) {
  let out = strokes;
  for (let pass = 0; pass < 4 && JSON.stringify(out).length > 100 * 1024; pass++) {
    out = out.map((s) => {
      const keep: number[] = [];
      const n = s.pts.length / 2;
      for (let i = 0; i < n; i++) if (i % 2 === 0 || i === n - 1) keep.push(s.pts[i * 2], s.pts[i * 2 + 1]);
      return { p: s.p, pts: keep };
    });
  }
  return out;
}

class LiarRoom extends SeatRoom<Player, Room> {
  protected readonly gameId = GAME;
  protected readonly maxPlayers = E.MAX_PLAYERS;
  private rnd = () => this.ctx.random();

  protected newSeat(base: Seat): Player {
    return { ...base, ready: false, voteNow: false, score: 0 };
  }

  protected remap(oldId: string, newId: string): void {
    const room = this.room;
    room.order = room.order.map((x) => (x === oldId ? newId : x));
    if (room.liar === oldId) room.liar = newId;
    if (room.lastLiar === oldId) room.lastLiar = newId;
    for (const s of room.strokes) if (s.pid === oldId) s.pid = newId;
    for (const c of room.clues) if (c.pid === oldId) c.pid = newId;
    if (oldId in room.stops) { room.stops[newId] = room.stops[oldId]; delete room.stops[oldId]; }
    if (oldId in room.started) { room.started[newId] = true; delete room.started[oldId]; }
    if (room.votes[oldId]) { room.votes[newId] = room.votes[oldId]; delete room.votes[oldId]; }
    for (const [v, t] of Object.entries(room.votes)) if (t === oldId) room.votes[v] = newId;
    if (room.accused === oldId) room.accused = newId;
    if (oldId in room.delta) { room.delta[newId] = room.delta[oldId]; delete room.delta[oldId]; }
  }

  protected seated(p: Player): void {
    if (this.room.status === 'lobby') return;
    this.tell(p.id, this.secretFor(p));
    this.sendDrawing(p.id);
  }

  // Someone left or went quiet: don't let them hold the game up
  protected afterPresence(p: Player): void {
    const room = this.room;
    if (room.status === 'role') this.checkReady();
    if (room.status === 'draw') {
      if (room.order[room.turn] === p.id && !this.active(p)) this.endTurn();
      else this.checkVoteNow();
    }
    if (room.status === 'time') this.checkStops();
    if (room.status === 'discuss') this.checkVoteNow();
    if (room.status === 'vote') this.checkVotes();
  }

  protected playerMessage(p: Player, msg: Msg): void {
    switch (msg.t) {
      case 'ink': return this.ink(p.id, msg.sid, msg.pts, msg.end === true);
      case 'ready': return this.ready(p);
      case 'votenow': return this.voteNow(p, msg.on === true);
      case 'done': return this.done(p.id);
      case 'clue': return this.clue(p.id, msg.text);
      case 'start': return this.timeStart(p);
      case 'stop': return this.stop(p, msg.secs);
      case 'vote': return this.vote(p, msg.target);
      case 'guess': return this.guess(p.id, msg.word);
      case 'sync': return this.sendDrawing(p.id);
      default:
    }
  }

  protected hostMessage(_p: Player, msg: Msg): boolean {
    const room = this.room;
    switch (msg.t) {
      case 'settings':
        if (room.status !== 'lobby') return true;
        room.settings = cleanSettings(msg.settings);
        this.broadcast();
        return true;
      case 'begin':
        this.startGame(msg);
        return true;
      case 'lobby':
        this.backToLobby();
        return true;
      default:
        return false;
    }
  }

  protected gameTimer(name: string): void {
    const room = this.room;
    if (name === 'turn') return this.endTurn();
    if (name !== 'phase') return;
    switch (room.status) {
      case 'role': return this.startDrawing();
      case 'time': return this.startDiscuss();
      case 'discuss': return this.startVote();
      case 'vote': return this.closeVote();
      case 'guess': return this.finish(null);
      default:
    }
  }

  /* ---------- A game ---------- */

  private secretFor(p: Player): Msg {
    const room = this.room;
    if (!p.inGame) return { t: 'secret', game: room.game, spectator: true, category: room.category };
    if (room.time) {
      if (p.id === room.liar) return { t: 'secret', game: room.game, liar: true, category: room.category, range: [room.time.lo, room.time.hi] };
      return { t: 'secret', game: room.game, liar: false, time: room.time.target, category: room.category };
    }
    if (p.id === room.liar) return { t: 'secret', game: room.game, liar: true, category: room.category };
    return { t: 'secret', game: room.game, liar: false, word: room.word, category: room.category };
  }

  private sendDrawing(id: string): void {
    const room = this.room;
    this.tell(id, { t: 'drawing', game: room.game, strokes: room.strokes.map(({ sid, pid, color, pts }) => ({ sid, pid, color, pts })) });
  }

  private clearTimers(): void {
    this.ctx.clearTimer('phase');
    this.ctx.clearTimer('turn');
  }

  private phaseIn(ms: number): void {
    this.ctx.setTimer('phase', this.ctx.now() + ms + 300);
  }

  private startGame(msg: Msg): void {
    const room = this.room;
    const players = room.players.filter((p) => p.connected);
    if (players.length < E.MIN_PLAYERS) {
      this.toHost({ t: 'toast', text: `You need at least ${E.MIN_PLAYERS} players` });
      return;
    }
    if (typeof msg.crew === 'string') {
      const typed = msg.crew.replace(/\s+/g, ' ').trim();
      if (typed !== (room.crew ? room.crew.name : '')) this.setCrew(typed);
    }
    this.clearTimers();
    if (msg.settings) room.settings = cleanSettings(msg.settings);
    room.players = players;
    for (const p of room.players) Object.assign(p, { inGame: true, ready: false, voteNow: false });
    const ids = room.players.map((p) => p.id);
    room.liar = E.pickLiar(ids, room.lastLiar, this.rnd);
    room.lastLiar = room.liar;
    if (timeGame(room.settings)) {
      Object.assign(room, { word: '', category: 'Time', time: E.pickTime(this.rnd) });
    } else {
      const used = new Set(room.used);
      const pick = E.pickWord(room.settings.categories, used, this.rnd);
      Object.assign(room, { word: pick.word, category: pick.category, time: null });
      used.add(E.wordKey(pick.category, pick.word));
      room.used = [...used].slice(-700);
    }
    room.order = E.turnOrder(ids, room.liar, this.rnd);
    Object.assign(room, {
      game: room.game + 1, status: 'role', round: 0, turn: 0, strokes: [], clues: [], stops: {}, started: {}, strokeSid: null, turnStrokes: 0,
      votes: {}, options: [], accused: null, guess: null, result: null, delta: {}, replayId: null,
      deadline: this.ctx.now() + E.TIMES.roleMs,
    });
    this.phaseIn(E.TIMES.roleMs - 300);
    this.ctx.track('game_started', { mode: timeGame(room.settings) ? 'time' : wordsGame(room.settings) ? 'words' : room.settings.mode, players: ids.length });
    for (const p of room.players) this.tell(p.id, this.secretFor(p));
    this.broadcast();
  }

  private ready(p: Player): void {
    if (this.room.status !== 'role' || !p.inGame) return;
    p.ready = true;
    this.checkReady();
    this.broadcast();
  }

  private checkReady(): void {
    if (this.room.status !== 'role') return;
    if (this.inGame().filter(this.active).every((p) => p.ready)) this.startDrawing();
  }

  private startDrawing(): void {
    const room = this.room;
    if (room.status !== 'role') return;
    this.clearTimers();
    if (room.time) return this.startTiming();
    room.status = 'draw';
    room.round = 0;
    room.turn = 0;
    this.beginTurn();
  }

  private beginTurn(): void {
    const room = this.room;
    const drawer = this.byId(room.order[room.turn]);
    if (!drawer || !this.active(drawer)) return this.advance();   // skip anyone who's gone
    const now = this.ctx.now();
    room.turnStart = now + E.TIMES.handoffMs;
    room.deadline = room.turnStart + (wordsGame(room.settings) ? room.settings.wordSeconds * 1000
      : room.settings.mode === 'stroke' ? E.STROKE.startMs : room.settings.seconds * 1000);
    room.strokeSid = null;
    room.turnStrokes = 0;
    this.ctx.setTimer('turn', room.deadline + 350);
    this.broadcast();
  }

  private ink(pid: string, rawSid: unknown, pts: unknown, end: boolean): void {
    const room = this.room;
    if (room.status !== 'draw' || wordsGame(room.settings) || room.order[room.turn] !== pid || typeof rawSid !== 'string') return;
    const now = this.ctx.now();
    if (now < room.turnStart - 300) return;
    const sid = rawSid.slice(0, 60);
    let stroke = room.strokes.find((s) => s.sid === sid);
    let changed = false;
    if (!stroke) {
      if (room.settings.mode === 'stroke' && room.strokeSid) return;   // one line per turn
      if (room.turnStrokes >= MAX_STROKES_PER_TURN) return;
      const p = this.byId(pid);
      stroke = { sid, pid, color: p ? p.color : 0, pts: [] };
      room.strokes.push(stroke);
      room.turnStrokes++;
      if (room.settings.mode === 'stroke') {
        // The line has started: it may last up to STROKE.maxMs
        room.strokeSid = sid;
        room.deadline = now + E.STROKE.maxMs + 400;
        this.ctx.setTimer('turn', room.deadline + 350);
        changed = true;
      }
    }
    const clean = E.cleanInk(pts, E.MAX_INK - stroke.pts.length);
    stroke.pts.push(...clean);
    this.tellAll({ t: 'ink', pid, sid, color: stroke.color, pts: clean, end }, pid);
    if (end && room.settings.mode === 'stroke') return this.endTurn();
    // Ink is saved with the next broadcast; a restart loses at most the line being drawn
    if (changed) this.broadcast();
  }

  // Free draw: the drawer finished early and pressed Done
  private done(pid: string): void {
    const room = this.room;
    if (room.status !== 'draw' || room.order[room.turn] !== pid || room.settings.mode !== 'free') return;
    if (this.ctx.now() < room.turnStart - 300) return;
    this.endTurn();
  }

  private turnClue = () => this.room.clues.find((c) => c.round === this.room.round && c.turn === this.room.turn);

  private clue(pid: string, raw: unknown): void {
    const room = this.room;
    if (room.status !== 'draw' || !wordsGame(room.settings) || room.order[room.turn] !== pid) return;
    if (this.ctx.now() < room.turnStart - 300 || this.turnClue()) return;
    // Only players who know the word are checked against it, so a refusal tells the liar nothing
    const problem = E.clueProblem(raw, { word: pid === room.liar ? '' : room.word, said: room.clues.filter((c) => !c.passed).map((c) => c.text) });
    if (problem) {
      this.tell(pid, { t: 'nope', reason: problem });
      return;
    }
    const p = this.byId(pid);
    room.clues.push({ pid, color: p ? p.color : 0, round: room.round, turn: room.turn, text: E.cleanClue(raw) });
    this.endTurn();
  }

  private endTurn(): void {
    const room = this.room;
    if (room.status !== 'draw') return;
    this.ctx.clearTimer('turn');
    room.strokeSid = null;
    // Words game: no word in time (or they left) and the turn is passed, for everyone to see
    if (wordsGame(room.settings) && !this.turnClue() && room.order[room.turn]) {
      const p = this.byId(room.order[room.turn]);
      room.clues.push({ pid: room.order[room.turn], color: p ? p.color : 0, round: room.round, turn: room.turn, text: '', passed: true });
    }
    this.advance();
  }

  private advance(): void {
    const room = this.room;
    room.turn++;
    if (room.turn >= room.order.length) {
      room.turn = 0;
      room.round++;
    }
    if (room.round >= E.ROUNDS) return this.startVote();
    this.beginTurn();
  }

  /* ---------- Time game ---------- */

  private startTiming(): void {
    const room = this.room;
    const limit = E.timeLimitMs(room.time ? room.time.hi : 12);
    Object.assign(room, { status: 'time', stops: {}, started: {}, deadline: this.ctx.now() + limit });
    this.phaseIn(limit);
    this.broadcast();
  }

  private timeStart(p: Player): void {
    const room = this.room;
    if (room.status !== 'time' || !p.inGame || room.started[p.id] || p.id in room.stops) return;
    room.started[p.id] = true;
    this.broadcast();
  }

  private stop(p: Player, secs: unknown): void {
    const room = this.room;
    const clean = E.cleanStop(secs);
    if (room.status !== 'time' || !p.inGame || p.id in room.stops || clean === null) return;
    room.stops[p.id] = clean;
    if (!this.checkStops()) this.broadcast();
  }

  private checkStops(): boolean {
    const room = this.room;
    if (room.status !== 'time') return false;
    const timers = this.inGame().filter(this.active);
    if (timers.length && timers.every((p) => p.id in room.stops)) {
      this.startDiscuss();
      return true;
    }
    return false;
  }

  private startDiscuss(): void {
    const room = this.room;
    if (room.status !== 'time') return;
    this.clearTimers();
    const ms = room.settings.discussSeconds * 1000;
    for (const p of room.players) p.voteNow = false;
    Object.assign(room, { status: 'discuss', deadline: this.ctx.now() + ms });
    this.phaseIn(ms);
    this.broadcast();
  }

  /* ---------- Voting ---------- */

  private voteNow(p: Player, on: boolean): void {
    const room = this.room;
    if ((room.status !== 'draw' && room.status !== 'discuss') || !p.inGame) return;
    p.voteNow = on;
    if (!this.checkVoteNow()) this.broadcast();
  }

  private voteNowCounts() {
    const voters = this.inGame().filter(this.active);
    return { have: voters.filter((p) => p.voteNow).length, need: E.voteNeeded(voters.length) };
  }

  private checkVoteNow(): boolean {
    const room = this.room;
    if (room.status !== 'draw' && room.status !== 'discuss') return false;
    const { have, need } = this.voteNowCounts();
    if (have >= need && have > 0) {
      this.startVote();
      return true;
    }
    return false;
  }

  private startVote(): void {
    const room = this.room;
    this.clearTimers();
    Object.assign(room, { status: 'vote', votes: {}, strokeSid: null, deadline: this.ctx.now() + E.TIMES.voteMs });
    this.phaseIn(E.TIMES.voteMs);
    this.broadcast();
  }

  private vote(p: Player, target: unknown): void {
    const room = this.room;
    const t = this.byId(typeof target === 'string' ? target : null);
    if (room.status !== 'vote' || !p.inGame || !t || !t.inGame || p.id === t.id) return;
    room.votes[p.id] = t.id;
    if (!this.checkVotes()) this.broadcast();
  }

  private checkVotes(): boolean {
    const room = this.room;
    if (room.status !== 'vote') return false;
    const voters = this.inGame().filter(this.active);
    if (voters.length && voters.every((p) => room.votes[p.id])) {
      this.closeVote();
      return true;
    }
    return false;
  }

  private closeVote(): void {
    const room = this.room;
    if (room.status !== 'vote') return;
    this.clearTimers();
    room.accused = E.tally(room.votes).accused;
    // Time game: the times already show roughly where the target is, so no last chance
    if (room.accused && room.accused === room.liar && !room.time) {
      room.status = 'guess';
      room.options = E.liarOptions(room.category, room.word, this.rnd);
      room.deadline = this.ctx.now() + E.TIMES.guessMs;
      this.phaseIn(E.TIMES.guessMs);
      this.broadcast();
    } else {
      this.finish(null);
    }
  }

  private guess(pid: string, word: unknown): void {
    const room = this.room;
    if (room.status !== 'guess' || pid !== room.liar || typeof word !== 'string' || !room.options.includes(word)) return;
    this.finish(word);
  }

  private finish(guess: string | null): void {
    const room = this.room;
    if (room.status !== 'vote' && room.status !== 'guess') return;
    this.clearTimers();
    room.guess = guess;
    room.result = E.outcome({ liar: room.liar, accused: room.accused, guess, word: room.word });
    const ids = this.inGame().map((p) => p.id);
    room.delta = E.points({ result: room.result, liar: room.liar, votes: room.votes, players: ids });
    for (const p of this.inGame()) p.score += room.delta[p.id] || 0;
    room.status = 'result';
    room.deadline = 0;
    this.ctx.track('game_finished', { result: String(room.result), players: ids.length });
    const liarWon = room.result !== 'caught';
    this.saveGame(this.inGame().map((p) => {
      const isLiar = p.id === room.liar;
      const won = isLiar ? liarWon : !liarWon;
      return reportPlayer(p, 0, won, {
        points: room.delta[p.id] || 0,
        liarGames: isLiar ? 1 : 0,
        liarWins: isLiar && liarWon ? 1 : 0,
        correctVotes: !isLiar && room.votes[p.id] === room.liar ? 1 : 0,
        catches: !isLiar && room.result === 'caught' && room.votes[p.id] === room.liar ? 1 : 0,
      });
    }), this.byId(room.liar)?.name ?? null);
    if (!room.time) this.saveReplay(this.replayPayload(), this.inGame());
    this.broadcast();
  }

  // What a shared replay shows: the drawing (Draw) or the words board (Words), who was who and how it ended.
  // Names and colours only; no player ids. The Time game has nothing worth replaying, so it saves nothing.
  private replayPayload() {
    const room = this.room;
    const players = this.inGame();
    const idx = (id: string | null) => { const i = players.findIndex((p) => p.id === id); return i < 0 ? null : i; };
    const words = wordsGame(room.settings);
    return {
      v: 1,
      mode: words ? 'words' : 'draw',
      word: room.word, category: room.category,
      liar: idx(room.liar), accused: idx(room.accused), guess: room.guess, result: room.result,
      rounds: E.ROUNDS,
      players: players.map((p) => ({ name: p.name, color: p.color, vote: idx(room.votes[p.id] ?? null), points: room.delta[p.id] || 0 })),
      strokes: words ? [] : thinStrokes(room.strokes.map((s) => ({ p: idx(s.pid), pts: s.pts }))),
      clues: words ? room.clues.map((c) => ({ p: idx(c.pid), round: c.round, text: c.text, passed: c.passed === true })) : [],
    };
  }

  private backToLobby(): void {
    const room = this.room;
    this.clearTimers();
    room.status = 'lobby';
    room.players = room.players.filter((p) => p.connected);
    for (const p of room.players) Object.assign(p, { inGame: false, ready: false, voteNow: false });
    this.broadcast();
  }

  // What everyone may see. The word, the liar and the votes stay hidden until the result.
  protected view(): Msg {
    const room = this.room;
    const now = this.ctx.now();
    const reveal = room.status === 'result';
    const { have, need } = room.status === 'draw' || room.status === 'discuss' ? this.voteNowCounts() : { have: 0, need: 0 };
    const timesOut = ['discuss', 'vote', 'result'].includes(room.status);
    return {
      t: 'state',
      code: room.code, status: room.status, settings: room.settings, game: room.game, public: room.public,
      category: room.status === 'lobby' ? '' : room.category,
      order: room.order, round: room.round, turn: room.turn,
      drawer: room.status === 'draw' ? room.order[room.turn] : null,
      turnStartsIn: room.status === 'draw' ? room.turnStart - now : 0,
      endsIn: room.deadline ? room.deadline - now : 0,
      strokeLive: Boolean(room.strokeSid),
      strokeCount: room.strokes.length,
      clues: room.status === 'lobby' ? [] : room.clues,
      stops: timesOut ? room.stops : {},
      time: reveal && room.time ? room.time : null,
      voteNowHave: have, voteNowNeed: need,
      players: room.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost, photo: p.photo,
        connected: p.connected, away: p.away, inGame: p.inGame, ready: p.ready, voteNow: p.voteNow,
        voted: Boolean(room.votes[p.id]), started: Boolean(room.started[p.id]) || p.id in room.stops, stopped: p.id in room.stops, score: p.score,
      })),
      accused: room.status === 'guess' || reveal ? room.accused : null,
      options: room.status === 'guess' || reveal ? room.options : [],
      liar: reveal ? room.liar : room.status === 'guess' ? room.accused : null,
      replayId: reveal ? room.replayId ?? null : null,
      word: reveal ? room.word : '',
      votes: reveal ? room.votes : {},
      guess: reveal ? room.guess : null,
      result: reveal ? room.result : null,
      delta: reveal ? room.delta : {},
      crewName: room.crew ? room.crew.name : '',
      crewStatus: room.crewStatus,
    };
  }
}

export const liar: GameModule = {
  id: GAME,
  // Ink arrives in batches (up to ~300 numbers each)
  maxMsgBytes: 16384,
  rate: { perSec: 20, burst: 60 },
  create(ctx: RoomCtx, opts) {
    return new LiarRoom(ctx, {
      code: ctx.code, public: opts.public, status: 'lobby', game: 0, players: [], crew: null, crewStatus: '',
      settings: cleanSettings({}), used: [], liar: null, lastLiar: null, word: '', category: '', order: [], round: 0, turn: 0,
      turnStart: 0, deadline: 0, strokeSid: null, turnStrokes: 0, strokes: [], clues: [], time: null, stops: {}, started: {},
      votes: {}, options: [], accused: null, guess: null, result: null, delta: {}, replayId: null,
    });
  },
  restore(ctx, snap) {
    const room = snap as Room;
    restoreSeats(ctx, room);
    return new LiarRoom(ctx, room);
  },
};
