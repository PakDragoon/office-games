// Melon Burst rooms on the server: the host code from web/melonburst/js/app.js, moved here (practice
// runs in the browser; the global daily word is server/src/daily/melonburst.ts). Each player is sent their own view, so
// nobody receives a word or letters they shouldn't see.
import * as E from '../../../web/melonburst/js/engine.js';
import COMMON_TEXT from '../../../web/melonburst/words/common.txt';
import MORE_TEXT from '../../../web/melonburst/words/more.txt';
import VALID_TEXT from '../../../web/melonburst/words/valid.txt';
import type { GameModule, Msg, RoomCtx } from '../core/game';
import { type BaseRoom, reportPlayer, restoreSeats, type Seat, SeatRoom } from '../core/seats';
import { SortedWords } from '../core/words';

const GAME = 'melonburst';
const SIDES = ['A', 'B'] as const;
type Side = (typeof SIDES)[number];
const otherSide = (t: Side): Side => (t === 'A' ? 'B' : 'A');

type Settings = ReturnType<typeof E.cleanSettings>;
type Guess = ReturnType<typeof E.newGuess> & { pts?: number; place?: number };

interface Player extends Seat {
  score: number;
  solved: number;
  ms: number;
  wins: number;
}

interface Room extends BaseRoom<Player> {
  settings: Settings;
  teams: Record<Side, Array<string | null>>;
  round: number;
  phase: string;
  phaseEnd: number;
  timerAction: string;
  guessStart: number;
  word: string;
  picks: Record<Side, string>;
  auto: Record<Side, boolean>;
  pickers: Record<Side, string | null>;
  guesses: Record<string, Guess>;
  solvedOrder: string[];
  used: string[];
  last: { round: number; word: string; picks: Record<Side, string>; auto: Record<Side, boolean>; pickers: Record<Side, string | null>; rows: Array<Record<string, unknown> & { id: string }> } | null;
  standings: unknown;
  winners: string[];
}

// The word lists, loaded once per isolate. The big dictionary is searched in place (no Set).
let LEX: { common: string[]; more: string[]; valid: { has(w: string): boolean } } | null = null;
export function lexicon() {
  if (!LEX) {
    const common = COMMON_TEXT.split('\n').filter(Boolean);
    const more = MORE_TEXT.split('\n').filter(Boolean);
    const lists = [new SortedWords(VALID_TEXT), new SortedWords(COMMON_TEXT), new SortedWords(MORE_TEXT)];
    LEX = { common, more, valid: { has: (w: string) => lists.some((l) => l.has(w)) } };
  }
  return LEX;
}

class MelonRoom extends SeatRoom<Player, Room> {
  protected readonly gameId = GAME;
  protected readonly maxPlayers = E.MAX_PLAYERS;
  protected perPlayerView = true;
  private rnd = () => this.ctx.random();

  protected newSeat(base: Seat): Player {
    return { ...base, score: 0, solved: 0, ms: 0, wins: 0 };
  }

  protected remap(from: string, to: string): void {
    const room = this.room;
    for (const t of SIDES) {
      room.teams[t] = room.teams[t].map((x) => (x === from ? to : x));
      if (room.pickers[t] === from) room.pickers[t] = to;
    }
    if (room.guesses[from]) { room.guesses[to] = room.guesses[from]; delete room.guesses[from]; }
    room.solvedOrder = room.solvedOrder.map((x) => (x === from ? to : x));
    if (room.last) for (const r of room.last.rows) if (r.id === from) r.id = to;
    room.winners = room.winners.map((x) => (x === from ? to : x));
  }

  protected seated(): void {
    if (this.room.status === 'lobby') this.autoSeat();
  }

  protected offlineOutMs(): number {
    return 0;
  }

  /* ---------- Seats ---------- */

  private perSide = () => E.seatsFor(this.room.settings);
  private sideOf = (id: string): Side | null => SIDES.find((t) => this.room.teams[t].slice(0, this.perSide()).includes(id)) || null;
  private isSeated = (id: string) => Boolean(this.sideOf(id));

  // Who is guessing this round
  private participants(): string[] {
    const room = this.room;
    if (room.settings.mode === 'pick') return SIDES.flatMap((t) => room.teams[t].slice(0, this.perSide())).filter((x): x is string => Boolean(x));
    return room.players.filter((p) => p.inGame).map((p) => p.id);
  }

  // Empty seats are filled by whoever isn't sitting yet, in the order they joined
  private autoSeat(): void {
    const room = this.room;
    if (room.status !== 'lobby') return;
    const n = this.perSide();
    for (const t of SIDES) for (let k = n; k < 2; k++) room.teams[t][k] = null;
    for (const t of SIDES) room.teams[t] = room.teams[t].map((x) => (x && this.byId(x) ? x : null));
    if (room.settings.mode !== 'pick') return;
    const order = ([['A', 0], ['B', 0], ['A', 1], ['B', 1]] as Array<[Side, number]>).filter(([, k]) => k < n);
    for (const p of room.players) {
      if (!p.connected || this.isSeated(p.id)) continue;
      const free = order.find(([t, k]) => !room.teams[t][k]);
      if (!free) break;
      room.teams[free[0]][free[1]] = p.id;
    }
  }

  // Someone left or went quiet: the round may not need to wait for them any more
  protected afterPresence(): void {
    const room = this.room;
    if (room.status === 'lobby') {
      this.autoSeat();
      return;
    }
    if (room.status !== 'play') return;
    if (room.phase === 'guess') this.checkRoundDone();
    if (room.phase === 'pick') {
      for (const t of SIDES) {
        const p = room.pickers[t] ? this.byId(room.pickers[t]) : undefined;
        if (!room.picks[t] && (!p || !p.connected)) this.autoPick(t);
      }
      this.checkPicks();
    }
  }

  protected playerMessage(p: Player, msg: Msg): void {
    const room = this.room;
    switch (msg.t) {
      case 'guess': return this.guess(p.id, msg.ch);
      case 'pick': return this.pick(p.id, msg.word);
      case 'sit': {
        const side = msg.side as Side;
        const slot = Number(msg.slot);
        if (room.status !== 'lobby' || room.settings.mode !== 'pick' || !SIDES.includes(side) || !(slot >= 0 && slot < this.perSide())) return;
        const holderId = room.teams[side][slot];
        const holder = holderId ? this.byId(holderId) : undefined;
        if (holder && holder.id !== p.id && holder.connected) return;
        for (const t of SIDES) room.teams[t] = room.teams[t].map((x) => (x === p.id ? null : x));
        room.teams[side][slot] = p.id;
        return this.broadcast();
      }
      case 'stand':
        if (room.status !== 'lobby') return;
        for (const t of SIDES) room.teams[t] = room.teams[t].map((x) => (x === p.id ? null : x));
        return this.broadcast();
      default:
    }
  }

  protected hostMessage(p: Player, msg: Msg): boolean {
    const room = this.room;
    switch (msg.t) {
      case 'settings':
        if (room.status === 'lobby') {
          room.settings = E.cleanSettings(msg.settings);
          this.autoSeat();
          this.broadcast();
        }
        return true;
      case 'swap':
        if (room.status === 'lobby') {
          [room.teams.A, room.teams.B] = [room.teams.B, room.teams.A];
          this.broadcast();
        }
        return true;
      case 'start':
        this.startGame(p, msg);
        return true;
      case 'next':
        this.nextRound();
        return true;
      case 'endRound':
        this.endRound();
        return true;
      case 'lobby':
        this.backToLobby();
        return true;
      default:
        return false;
    }
  }

  /* ---------- A game ---------- */

  private setTimer(ms: number, action: string): void {
    this.room.timerAction = action;
    this.ctx.setTimer('phase', this.ctx.now() + Math.max(0, ms));
  }

  private clearTimer(): void {
    this.room.timerAction = '';
    this.ctx.clearTimer('phase');
  }

  protected gameTimer(name: string): void {
    if (name !== 'phase') return;
    const action = this.room.timerAction;
    this.room.timerAction = '';
    switch (action) {
      case 'pickTimeout': return this.pickTimeout();
      case 'beginGuess': return this.beginGuess();
      case 'endRound': return this.endRound();
      case 'nextRound': return this.nextRound();
      default:
    }
  }

  private startProblem(): string {
    const room = this.room;
    const st = room.settings;
    if (st.mode === 'race') {
      if (room.players.filter((p) => p.connected).length < 2) return 'Needs at least 2 players. Copy the invite link and send it round.';
      return '';
    }
    for (const t of SIDES) for (let k = 0; k < this.perSide(); k++) {
      const id = room.teams[t][k];
      const p = id ? this.byId(id) : undefined;
      if (!p || !p.connected) {
        const need = this.perSide() * 2;
        return room.players.filter((x) => x.connected).length < need
          ? `Needs ${need} players for ${st.teams === '2v2' ? '2 vs 2' : '1 vs 1'}. Copy the invite link and send it round.`
          : 'Every seat needs a player.';
      }
    }
    return '';
  }

  private startGame(by: Player, msg: Msg): void {
    const room = this.room;
    if (room.status === 'lobby') {
      if (msg.settings) room.settings = E.cleanSettings(msg.settings);
      if (typeof msg.crew === 'string' && msg.crew.trim() !== (room.crew ? room.crew.name : '')) this.setCrew(msg.crew);
      this.autoSeat();
    }
    const problem = this.startProblem();
    if (problem) {
      this.tell(by.id, { t: 'toast', text: problem });
      return;
    }
    room.players = room.players.filter((p) => p.connected || this.isSeated(p.id));
    for (const p of room.players) {
      Object.assign(p, { score: 0, solved: 0, ms: 0, inGame: room.settings.mode === 'race' ? p.connected : this.isSeated(p.id) });
    }
    Object.assign(room, { status: 'play', game: room.game + 1, round: 0, last: null, standings: null, winners: [] });
    this.ctx.track('game_started', { mode: room.settings.mode, players: this.participants().length });
    this.startRound();
  }

  private startRound(): void {
    const room = this.room;
    const st = room.settings;
    Object.assign(room, { guesses: {}, solvedOrder: [], word: '', picks: { A: '', B: '' }, auto: { A: false, B: false } });
    // Latecomers join in from the next round
    if (st.mode === 'race') for (const p of room.players) if (p.connected && !p.inGame) p.inGame = true;
    if (st.mode === 'pick') {
      const k = E.pickerIndex(room.round, this.perSide());
      for (const t of SIDES) room.pickers[t] = room.teams[t][k] || room.teams[t][0];
      room.phase = 'pick';
      room.phaseEnd = this.ctx.now() + E.TIMES.pickMs;
      this.setTimer(E.TIMES.pickMs, 'pickTimeout');
      this.afterPresence();
      this.broadcast();
      return;
    }
    const used = new Set(room.used);
    room.word = E.pickWord(lexicon(), st, this.rnd, used);
    room.used.push(room.word);
    this.countdown();
  }

  private countdown(): void {
    const room = this.room;
    room.phase = 'countdown';
    room.phaseEnd = this.ctx.now() + E.TIMES.countdownMs;
    this.setTimer(E.TIMES.countdownMs, 'beginGuess');
    this.broadcast();
  }

  private targetWord(pid: string): string {
    const room = this.room;
    if (room.settings.mode === 'race') return room.word;
    const t = this.sideOf(pid);
    return t ? room.picks[otherSide(t)] : '';
  }

  private beginGuess(): void {
    const room = this.room;
    if (room.status !== 'play') return;
    room.phase = 'guess';
    room.guessStart = this.ctx.now();
    for (const pid of this.participants()) room.guesses[pid] = E.newGuess(this.targetWord(pid));
    const ms = E.timeMs(room.settings);
    room.phaseEnd = ms ? this.ctx.now() + ms : 0;
    if (ms) this.setTimer(ms, 'endRound');
    else this.clearTimer();
    this.broadcast();
    this.checkRoundDone();
  }

  private pick(pid: string, raw: unknown): void {
    const room = this.room;
    if (room.status !== 'play' || room.phase !== 'pick') return;
    const t = SIDES.find((s) => room.pickers[s] === pid);
    if (!t || room.picks[t]) return;
    const problem = E.pickProblem(raw, lexicon());
    if (problem) {
      this.tell(pid, { t: 'nope', reason: problem });
      return;
    }
    room.picks[t] = E.cleanWord(raw);
    room.used.push(room.picks[t]);
    this.checkPicks();
    this.broadcast();
  }

  private autoPick(t: Side): void {
    const room = this.room;
    if (room.picks[t]) return;
    room.picks[t] = E.pickWord(lexicon(), { length: 'any', words: 'common' }, this.rnd, new Set(room.used));
    room.auto[t] = true;
    room.used.push(room.picks[t]);
  }

  private pickTimeout(): void {
    const room = this.room;
    if (room.status !== 'play' || room.phase !== 'pick') return;
    for (const t of SIDES) this.autoPick(t);
    this.checkPicks();
    this.broadcast();
  }

  private checkPicks(): void {
    const room = this.room;
    if (room.phase === 'pick' && room.picks.A && room.picks.B) this.countdown();
  }

  private guess(pid: string, ch: unknown): void {
    const room = this.room;
    if (room.status !== 'play' || room.phase !== 'guess') return;
    const g = room.guesses[pid];
    if (!g) return;
    const r = E.guess(g, ch, room.settings.bands);
    if (!r) return;
    const next: Guess = r.g;
    if (E.isDone(next)) {
      next.ms = this.ctx.now() - room.guessStart;
      const p = this.byId(pid);
      if (next.solved) {
        const race = room.settings.mode === 'race';
        if (race) room.solvedOrder.push(pid);
        next.place = race ? room.solvedOrder.length : 0;
        next.pts = E.points(next, room.settings.bands, next.place);
        if (p) { p.score += next.pts; p.solved++; p.ms += next.ms; }
      } else next.pts = 0;
    }
    room.guesses[pid] = next;
    this.broadcast();
    this.checkRoundDone();
  }

  // The round ends when everyone still here has solved or burst (or time runs out)
  private checkRoundDone(): void {
    const room = this.room;
    if (room.phase !== 'guess') return;
    const parts = this.participants();
    const waiting = parts.filter((pid) => {
      const p = this.byId(pid);
      const g = room.guesses[pid];
      return g && !E.isDone(g) && p && this.active(p);
    });
    if (!waiting.length && parts.length) this.setTimer(1200, 'endRound');
  }

  private endRound(): void {
    const room = this.room;
    if (room.status !== 'play' || room.phase !== 'guess') return;
    const rows = this.participants().map((pid) => {
      const g = room.guesses[pid] || E.newGuess(this.targetWord(pid));
      return { id: pid, word: g.word, solved: g.solved, burst: g.burst, wrong: g.wrong, pts: g.pts || 0, ms: g.ms || 0, place: g.place || 0, side: this.sideOf(pid) };
    });
    room.last = { round: room.round, word: room.word, picks: { ...room.picks }, auto: { ...room.auto }, pickers: { ...room.pickers }, rows };
    if (room.round + 1 >= room.settings.rounds) return this.gameOver();
    room.phase = 'reveal';
    room.phaseEnd = this.ctx.now() + E.TIMES.revealMs;
    this.setTimer(E.TIMES.revealMs, 'nextRound');
    this.broadcast();
  }

  private nextRound(): void {
    const room = this.room;
    if (room.status !== 'play' || room.phase !== 'reveal') return;
    room.round++;
    this.startRound();
  }

  private gameOver(): void {
    const room = this.room;
    this.clearTimer();
    room.status = 'over';
    room.phase = '';
    const st = room.settings;
    if (st.mode === 'pick') {
      const teams = SIDES.map((t) => {
        const ids = room.teams[t].slice(0, this.perSide()).filter((x): x is string => Boolean(x));
        const members = ids.map((id) => this.byId(id)).filter((p): p is Player => Boolean(p));
        return { side: t, ids, score: members.reduce((s, p) => s + p.score, 0), solved: members.reduce((s, p) => s + p.solved, 0), ms: members.reduce((s, p) => s + p.ms, 0) };
      });
      const ranked = E.rank(teams);
      const tie = ranked[0].score === ranked[1].score && ranked[0].solved === ranked[1].solved;
      room.standings = { teams: ranked, tie };
      room.winners = tie ? [] : ranked[0].ids;
    } else {
      const ranked = E.rank(room.players.filter((p) => p.inGame).map((p) => ({ id: p.id, score: p.score, solved: p.solved, ms: p.ms })));
      room.standings = { players: ranked };
      const top = ranked[0];
      room.winners = top && top.score > 0 ? ranked.filter((r: { score: number; solved: number; ms: number }) => r.score === top.score && r.solved === top.solved && r.ms === top.ms).map((r: { id: string }) => r.id) : [];
    }
    for (const id of room.winners) { const p = this.byId(id); if (p) p.wins++; }
    this.ctx.track('game_finished', { mode: st.mode, players: this.participants().length });
    const players = this.participants().map((id) => this.byId(id)).filter((p): p is Player => Boolean(p));
    this.saveGame(players.map((p, i) => reportPlayer(p, i + 1, room.winners.includes(p.id), {
      points: p.score, solved: p.solved, rounds: room.settings.rounds,
    })), room.winners.length ? (this.byId(room.winners[0])?.name ?? null) : null);
    this.broadcast();
  }

  private backToLobby(): void {
    const room = this.room;
    this.clearTimer();
    room.status = 'lobby';
    room.phase = '';
    room.players = room.players.filter((p) => p.connected);
    for (const p of room.players) p.inGame = false;
    this.autoSeat();
    this.broadcast();
  }

  /* ---------- What each player may see ---------- */

  // Can `viewer` see the letters `target` has guessed (and the word they're on)?
  private canSeeDetail(viewer: string | null, target: string): string {
    const room = this.room;
    if (viewer === target) return 'own';
    if (room.phase === 'reveal' || room.status === 'over') return 'all';
    if (room.settings.mode === 'race') return '';
    const vs = viewer ? this.sideOf(viewer) : null;
    const ts = this.sideOf(target);
    if (!vs) return 'all';                       // watching a pick game: see everything
    if (vs !== ts) return 'all';                 // they're guessing your side's word
    return '';
  }

  private guessView(viewer: string | null, target: string) {
    const g = this.room.guesses[target];
    if (!g) return null;
    const out: Record<string, unknown> = { len: g.word.length, wrong: g.wrong, solved: g.solved, burst: g.burst, done: E.isDone(g), revealed: E.revealed(g), pts: g.pts || 0, place: g.place || 0, ms: g.ms || 0 };
    const see = this.canSeeDetail(viewer, target);
    if (see) {
      out.mask = E.mask(g.word, g.guessed);
      out.guessed = g.guessed;
      if (see === 'all' || out.done) out.word = g.word;
    }
    return out;
  }

  protected view(viewer: string | null): Msg {
    const room = this.room;
    const now = this.ctx.now();
    const mySide = viewer ? this.sideOf(viewer) : null;
    const pickMode = room.settings.mode === 'pick';
    const showWords = room.phase === 'reveal' || room.status === 'over';
    return {
      t: 'state',
      code: room.code, solo: null, status: room.status, settings: room.settings, game: room.game, public: room.public,
      round: room.round, rounds: room.settings.rounds, phase: room.phase,
      phaseLeft: room.phaseEnd ? room.phaseEnd - now : 0,
      players: room.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost, photo: p.photo, connected: p.connected, away: p.away,
        inGame: p.inGame, score: p.score, solved: p.solved, ms: p.ms, wins: p.wins, side: this.sideOf(p.id), g: this.guessView(viewer, p.id),
      })),
      teams: { A: room.teams.A.slice(0, this.perSide()), B: room.teams.B.slice(0, this.perSide()) },
      pickers: pickMode ? room.pickers : null,
      picked: pickMode ? { A: Boolean(room.picks.A), B: Boolean(room.picks.B) } : null,
      // Your side's own word (your teammates and people watching can see it), never the other side's
      sideWord: pickMode && room.status === 'play' ? (mySide ? room.picks[mySide] : null) : null,
      watchWords: pickMode && !mySide && room.status === 'play' ? { ...room.picks } : null,
      last: showWords ? room.last : null,
      standings: room.status === 'over' ? room.standings : null,
      winners: room.status === 'over' ? room.winners : [],
      streak: 0,
      day: '',
      startProblem: room.status === 'lobby' ? this.startProblem() : '',
      crewName: room.crew ? room.crew.name : '',
      crewStatus: room.crewStatus,
    };
  }
}

export const melonburst: GameModule = {
  id: GAME,
  maxMsgBytes: 1024,
  rate: { perSec: 12, burst: 30 },
  create(ctx: RoomCtx, opts) {
    return new MelonRoom(ctx, {
      code: ctx.code, public: opts.public, status: 'lobby', game: 0, players: [], crew: null, crewStatus: '',
      settings: E.cleanSettings({}), teams: { A: [null, null], B: [null, null] },
      round: 0, phase: '', phaseEnd: 0, timerAction: '', guessStart: 0,
      word: '', picks: { A: '', B: '' }, auto: { A: false, B: false }, pickers: { A: null, B: null },
      guesses: {}, solvedOrder: [], used: [], last: null, standings: null, winners: [],
    });
  },
  restore(ctx, snap) {
    const room = snap as Room;
    restoreSeats(ctx, room);
    return new MelonRoom(ctx, room);
  },
};
