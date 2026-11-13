// A to Zap on the server. Each round one player picks a letter and everyone fills in categories with words that
// start with it. The server is the clock and the judge: it takes the letter pick, the answers (batched), the Zap!,
// checks answers against the word lists, runs the room's vote on the ones it doesn't know and adds up the points.
// The rules themselves are in web/a-to-zap/js/engine.js.
import * as E from '../../../web/a-to-zap/js/engine.js';
import BODY_TEXT from '../../../web/a-to-zap/words/body.txt';
import ANIMAL_TEXT from '../../../web/a-to-zap/words/animal.txt';
import COLOUR_TEXT from '../../../web/a-to-zap/words/colour.txt';
import FOOD_TEXT from '../../../web/a-to-zap/words/food.txt';
import JOB_TEXT from '../../../web/a-to-zap/words/job.txt';
import NAME_TEXT from '../../../web/a-to-zap/words/name.txt';
import PLACE_TEXT from '../../../web/a-to-zap/words/place.txt';
import PRODUCE_TEXT from '../../../web/a-to-zap/words/produce.txt';
import SPORT_TEXT from '../../../web/a-to-zap/words/sport.txt';
import THING_TEXT from '../../../web/a-to-zap/words/thing.txt';
import type { GameModule, Msg, RoomCtx } from '../core/game';
import { type BaseRoom, reportPlayer, restoreSeats, type Seat, SeatRoom } from '../core/seats';
import { randomId } from '../core/util';
import { SortedWords } from '../core/words';

const GAME = 'a-to-zap';
const MAX_PLAYERS = 8;

type Settings = ReturnType<typeof E.cleanSettings>;
type Status = 'lobby' | 'pick' | 'play' | 'review' | 'results' | 'over';
type Cells = Record<string, { raw: string; norm: string; status: string }>;

/** The word lists, searched in place (never turned into Sets: that costs more CPU than a message may use). */
let LISTS: Record<string, SortedWords> | null = null;
const TEXTS: Record<string, string> = {
  name: NAME_TEXT, place: PLACE_TEXT, animal: ANIMAL_TEXT, produce: PRODUCE_TEXT, thing: THING_TEXT,
  food: FOOD_TEXT, job: JOB_TEXT, colour: COLOUR_TEXT, sport: SPORT_TEXT, body: BODY_TEXT,
};
function lists(): Record<string, SortedWords> {
  if (!LISTS) LISTS = Object.fromEntries(Object.entries(TEXTS).map(([id, text]) => [id, new SortedWords(text)]));
  return LISTS;
}
/** Is this normalized answer on the word list for the category? */
export const onList = (cat: string, norm: string): boolean => Boolean(lists()[cat]?.has(norm));

interface Player extends Seat {
  /** Stays the same across a refresh (the seat id changes), so votes and results can point at a person. */
  key: string;
  score: number;
  unique: number;
  /** Highest points in one round. */
  best: number;
  /** Rounds this player has been in this game. */
  rounds: number;
  answers: Record<string, string>;
  submitted: boolean;
}

interface ReviewItem { cat: string; norm: string; shown: string; owners: string[]; up: string[]; down: string[] }
interface ResultCell { raw: string; pts: number; st: string; shared: boolean }
interface Results {
  round: number;
  letter: string;
  last: boolean;
  categories: string[];
  rows: Array<{ key: string; name: string; total: number; unique: number; cells: Record<string, ResultCell> }>;
  items: Array<{ cat: string; shown: string; owners: string[]; up: number; down: number; ok: boolean }>;
}

interface Room extends BaseRoom<Player> {
  settings: Settings;
  status: Status;
  /** The round in progress (or just finished), counted from 1, and how many this game has. */
  round: number;
  totalRounds: number;
  /** Rounds finished in this game (the stats are saved only if at least one was). */
  done: number;
  used: string[];
  letter: string | null;
  pickerKey: string | null;
  /** Deadlines (ms since the epoch, from the room's clock). */
  pickEnd: number;
  lockAt: number;
  voteEnd: number;
  nextAt: number;
  zapBy: string | null;
  /** This round's answers, judged, waiting for the room's vote and the scoring. */
  rows: Array<{ id: string; name: string; cells: Cells }>;
  review: ReviewItem[];
  results: Results | null;
  /** Games won in this room, by lower-cased name (the name is kept as typed for showing). */
  wins: Record<string, { name: string; n: number }>;
}

class ZapRoom extends SeatRoom<Player, Room> {
  protected readonly gameId = GAME;
  protected readonly maxPlayers = MAX_PLAYERS;
  protected perPlayerView = true;
  private lastBroadcast = 0;

  protected newSeat(base: Seat): Player {
    return { ...base, key: randomId('k'), score: 0, unique: 0, best: 0, rounds: 0, answers: {}, submitted: false };
  }

  /** Same as everyone: connected and not Away. They are the ones a round waits for. */
  private waitsFor = (p: Player) => p.inGame && p.connected && !p.away;
  private byKey = (key: string | null | undefined) => this.room.players.find((p) => p.key === key);

  protected broadcast(): void {
    this.lastBroadcast = this.ctx.now();
    super.broadcast();
  }

  /* ---------- Messages ---------- */

  protected hostMessage(_p: Player, msg: Msg): boolean {
    const room = this.room;
    switch (msg.t) {
      case 'settings':
        // Settings change only in the lobby, never under a game that is running
        if (room.status === 'lobby') {
          room.settings = E.cleanSettings(msg.patch, room.settings);
          this.broadcast();
        }
        return true;
      case 'start':
        if (room.status === 'lobby' || room.status === 'over') this.startGame(msg.crew);
        return true;
      case 'next':
        if (room.status === 'results') this.afterResults();
        return true;
      case 'endGame':
        if (room.status !== 'lobby' && room.status !== 'over') this.finishGame();
        return true;
      case 'lobby':
        this.backToLobby();
        return true;
      default:
        return false;
    }
  }

  protected playerMessage(p: Player, msg: Msg): void {
    switch (msg.t) {
      case 'pick':
        return this.pick(p, msg.letter);
      case 'answers':
        return this.takeAnswers(p, msg.a, false);
      case 'submit':
        return this.takeAnswers(p, msg.a, true);
      case 'zap':
        return this.zap(p, msg.a);
      case 'vote':
        return this.vote(p, msg.item, msg.v);
      default:
    }
  }

  protected afterPresence(): void {
    const room = this.room;
    // (A picker who has left or refreshed is not replaced at once: their 10 seconds still run, and they can come back)
    if (room.status === 'play') this.checkAllIn();
    else if (room.status === 'review') this.checkReviewDone();
  }

  protected gameTimer(name: string): void {
    const room = this.room;
    switch (name) {
      case 'pick':
        if (room.status === 'pick') this.autoPick();
        break;
      case 'round':
        if (room.status === 'play') this.lock();
        break;
      case 'vote':
        if (room.status === 'review') this.finishReview();
        break;
      case 'next':
        if (room.status === 'results') this.afterResults();
        break;
      case 'soft':
        if (room.status === 'play') this.broadcast();
        break;
      default:
    }
  }

  /* ---------- A game ---------- */

  private startGame(crew: unknown): void {
    const room = this.room;
    room.players = room.players.filter((p) => p.connected);
    if (room.players.length < 2) return this.toHost({ t: 'toast', text: 'You need at least 2 players to start' });
    if (typeof crew === 'string' && crew.trim() !== (room.crew ? room.crew.name : '')) this.setCrew(crew);
    for (const p of room.players) {
      Object.assign(p, { inGame: true, score: 0, unique: 0, best: 0, rounds: 0, answers: {}, submitted: false });
    }
    Object.assign(room, {
      game: room.game + 1, round: 0, done: 0, used: [], letter: null, pickerKey: null, zapBy: null, rows: [], review: [],
      results: null, totalRounds: E.roundsFor(room.settings), replayId: null,
    });
    this.ctx.track('game_started', { players: room.players.length, rounds: room.totalRounds, categories: room.settings.categories.length });
    this.nextRound();
  }

  /** Who picks next: the next player in seat order after the last picker who is here (an Away player is skipped). */
  private nextPicker(): Player | null {
    const room = this.room;
    const order = room.players.filter((p) => p.inGame);
    if (!order.length) return null;
    const last = order.findIndex((p) => p.key === room.pickerKey);
    const rotated = order.map((_, i) => order[(last + 1 + i) % order.length]);
    return rotated.find((p) => this.waitsFor(p)) ?? rotated[0];
  }

  private nextRound(): void {
    const room = this.room;
    const picker = this.nextPicker();
    if (!picker || room.round >= room.totalRounds || !E.availableLetters(room.used, room.settings.hard).length) return this.finishGame();
    room.round += 1;
    for (const p of room.players) Object.assign(p, { answers: {}, submitted: false });
    Object.assign(room, { status: 'pick', letter: null, pickerKey: picker.key, zapBy: null, rows: [], review: [], results: null });
    room.pickEnd = this.ctx.now() + E.PICK_MS;
    this.ctx.setTimer('pick', room.pickEnd);
    this.ctx.clearTimer('round');
    this.ctx.clearTimer('vote');
    this.ctx.clearTimer('next');
    this.broadcast();
  }

  private pick(p: Player, letter: unknown): void {
    const room = this.room;
    if (room.status !== 'pick' || p.key !== room.pickerKey) return;
    if (!E.letterAllowed(letter, room.used, room.settings.hard)) return;
    this.startPlay(letter as string);
  }

  /** The 10 seconds ran out (or the picker left): the server picks a letter at random. */
  private autoPick(): void {
    const room = this.room;
    if (room.status !== 'pick') return;
    const letter = E.pickLetter(room.used, room.settings.hard, () => this.ctx.random());
    if (!letter) return this.finishGame();
    this.startPlay(letter);
  }

  private startPlay(letter: string): void {
    const room = this.room;
    const now = this.ctx.now();
    this.ctx.clearTimer('pick');
    room.used.push(letter);
    Object.assign(room, { status: 'play', letter, zapBy: null });
    room.lockAt = now + room.settings.time * 1000;
    this.ctx.setTimer('round', room.lockAt);
    this.broadcast();
  }

  /* ---------- The round ---------- */

  /** Keep what the player typed (only this game's categories, cleaned). False when it isn't accepted any more. */
  private store(p: Player, raw: unknown): boolean {
    const room = this.room;
    if (room.status !== 'play' || !p.inGame || p.submitted || this.ctx.now() >= room.lockAt) return false;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const cat of room.settings.categories) {
        const v = (raw as Record<string, unknown>)[cat];
        if (typeof v === 'string') p.answers[cat] = E.cleanAnswer(v);
      }
    }
    return true;
  }

  private takeAnswers(p: Player, raw: unknown, final: boolean): void {
    const room = this.room;
    const before = E.filledCount(room.settings.categories, p.answers);
    if (!this.store(p, raw)) return;
    if (final) {
      p.submitted = true;
      this.broadcast();
      this.checkAllIn();
      return;
    }
    // Typing goes to everyone as a count only, and no more than about once a second
    if (E.filledCount(room.settings.categories, p.answers) !== before) this.softBroadcast();
    else this.ctx.dirty();
  }

  private softBroadcast(): void {
    if (this.ctx.now() - this.lastBroadcast >= 1000) this.broadcast();
    else this.ctx.setTimer('soft', this.lastBroadcast + 1000);
  }

  /** The first player to fill every category presses Zap!: everyone else has exactly 10 seconds left. */
  private zap(p: Player, raw: unknown): void {
    const room = this.room;
    if (room.status !== 'play' || room.zapBy || !p.inGame || p.submitted) return;
    if (!this.store(p, raw)) return;
    if (!E.allFilled(room.settings.categories, p.answers)) {
      this.tell(p.id, { t: 'toast', text: 'Fill in every category before you press Zap!' });
      return;
    }
    p.submitted = true;
    room.zapBy = p.key;
    room.lockAt = this.ctx.now() + E.ZAP_MS;
    this.ctx.setTimer('round', room.lockAt);
    this.broadcast();
    this.checkAllIn();
  }

  /** Everyone who is still here has handed in: no need to wait for the clock. */
  private checkAllIn(): void {
    const room = this.room;
    if (room.status !== 'play') return;
    const waiting = room.players.filter((p) => this.waitsFor(p));
    if (waiting.length && waiting.every((p) => p.submitted)) this.lock();
  }

  /** Time is up (or all are in): late answers are ignored from here on. Judge them, vote on the unknown ones, score. */
  private lock(): void {
    const room = this.room;
    if (room.status !== 'play' || !room.letter) return;
    const letter = room.letter;
    const cats = room.settings.categories;
    this.ctx.clearTimer('round');
    this.ctx.clearTimer('soft');
    room.rows = room.players.filter((p) => p.inGame).map((p) => {
      const cells: Cells = {};
      for (const cat of cats) {
        const raw = p.answers[cat] || '';
        const j = E.judge(letter, cat, raw, onList);
        cells[cat] = { raw: E.normalize(raw) ? raw : '', norm: j.norm, status: j.status };
      }
      return { id: p.key, name: p.name, cells };
    });
    const items = E.pendingVotes(cats, room.rows) as Array<{ cat: string; norm: string; shown: string; owners: string[] }>;
    room.review = items.map((i) => ({ ...i, up: [], down: [] }));
    if (!room.review.length) return this.finishRound();
    room.status = 'review';
    room.voteEnd = this.ctx.now() + E.VOTE_MS;
    this.ctx.setTimer('vote', room.voteEnd);
    this.broadcast();
    this.checkReviewDone();
  }

  /** Who may vote on an item: players in the game who are here, other than the people who wrote the answer. */
  private voters(item: ReviewItem): Player[] {
    return this.room.players.filter((p) => this.waitsFor(p) && !item.owners.includes(p.key));
  }

  private vote(p: Player, index: unknown, v: unknown): void {
    const room = this.room;
    if (room.status !== 'review' || !p.inGame || typeof index !== 'number') return;
    const item = room.review[index];
    if (!item || item.owners.includes(p.key)) return;
    if (v !== 1 && v !== -1 && v !== 0) return;
    item.up = item.up.filter((k) => k !== p.key);
    item.down = item.down.filter((k) => k !== p.key);
    if (v === 1) item.up.push(p.key);
    if (v === -1) item.down.push(p.key);
    this.broadcast();
    this.checkReviewDone();
  }

  /** Everyone who may vote has voted on everything they may vote on (Away players are not waited for). */
  private reviewWaiting(): number {
    const room = this.room;
    return room.players.filter((p) => this.waitsFor(p) && room.review.some(
      (i) => !i.owners.includes(p.key) && !i.up.includes(p.key) && !i.down.includes(p.key),
    )).length;
  }

  private checkReviewDone(): void {
    if (this.room.status === 'review' && this.reviewWaiting() === 0) this.finishReview();
  }

  private finishReview(): void {
    if (this.room.status !== 'review') return;
    this.ctx.clearTimer('vote');
    this.finishRound();
  }

  /** Score the round: the room's votes decide the unknown answers (a majority of thumbs-up or a tie accepts). */
  private finishRound(): void {
    const room = this.room;
    const cats = room.settings.categories;
    const verdict = new Map<string, { up: number; down: number; ok: boolean }>();
    for (const i of room.review) verdict.set(`${i.cat}\n${i.norm}`, { up: i.up.length, down: i.down.length, ok: E.voteAccepted(i.up.length, i.down.length) });
    const scored = E.scoreRound(cats, room.rows, (cat: string, norm: string) => verdict.get(`${cat}\n${norm}`)?.ok ?? false) as Record<string, {
      total: number; unique: number; cells: Record<string, { raw: string; status: string; ok: boolean; pts: number; shared: boolean }>;
    }>;
    const rows: Results['rows'] = [];
    for (const row of room.rows) {
      const s = scored[row.id];
      const p = this.byKey(row.id);
      if (p) {
        p.score += s.total;
        p.unique += s.unique;
        p.best = Math.max(p.best, s.total);
        p.rounds += 1;
      }
      const cells: Record<string, ResultCell> = {};
      for (const cat of cats) {
        const c = s.cells[cat];
        // How the answer was accepted or why not: shown colour-coded in the results table
        const st = c.status === 'unknown' ? (c.ok ? 'voted' : 'rejected') : c.status;
        cells[cat] = { raw: c.raw, pts: c.pts, st, shared: c.shared };
      }
      rows.push({ key: row.id, name: row.name, total: s.total, unique: s.unique, cells });
    }
    rows.sort((a, b) => b.total - a.total);
    const names = (keys: string[]) => keys.map((k) => this.byKey(k)?.name ?? 'Someone');
    room.done += 1;
    room.results = {
      round: room.round, letter: room.letter ?? '', categories: cats, rows,
      last: room.round >= room.totalRounds || !E.availableLetters(room.used, room.settings.hard).length,
      items: room.review.map((i) => {
        const v = verdict.get(`${i.cat}\n${i.norm}`);
        return { cat: i.cat, shown: i.shown, owners: names(i.owners), up: i.up.length, down: i.down.length, ok: Boolean(v?.ok) };
      }),
    };
    room.status = 'results';
    room.nextAt = this.ctx.now() + E.RESULTS_MS;
    this.ctx.setTimer('next', room.nextAt);
    this.broadcast();
  }

  private afterResults(): void {
    const room = this.room;
    if (room.status !== 'results') return;
    this.ctx.clearTimer('next');
    if (room.results?.last) this.finishGame();
    else this.nextRound();
  }

  /* ---------- The end ---------- */

  private finishGame(): void {
    const room = this.room;
    for (const t of ['pick', 'round', 'vote', 'next', 'soft']) this.ctx.clearTimer(t);
    room.status = 'over';
    room.review = [];
    const played = room.players.filter((p) => p.inGame);
    const ranked = E.rank(played.map((p) => ({ key: p.key, score: p.score, unique: p.unique })));
    const placeOf = new Map<string, number>(ranked.map((r: { key: string; place: number }) => [r.key, r.place]));
    // A game with no finished round counts for nothing (the host ended it at once)
    if (room.done > 0) {
      for (const p of played) {
        if (placeOf.get(p.key) !== 1) continue;
        const w = (room.wins[p.name.toLowerCase()] ||= { name: p.name, n: 0 });
        w.name = p.name;
        w.n += 1;
      }
      const first = ranked[0] ? this.byKey(ranked[0].key) : undefined;
      this.saveGame(
        played.map((p) => reportPlayer(
          p, placeOf.get(p.key) ?? played.length, placeOf.get(p.key) === 1,
          { rounds: p.rounds, points: p.score, unique: p.unique }, { bestRound: p.best },
        )),
        first ? first.name : null,
      );
    }
    this.broadcast();
  }

  private backToLobby(): void {
    const room = this.room;
    for (const t of ['pick', 'round', 'vote', 'next', 'soft']) this.ctx.clearTimer(t);
    room.players = room.players.filter((p) => p.connected);
    for (const p of room.players) Object.assign(p, { inGame: false, score: 0, unique: 0, best: 0, rounds: 0, answers: {}, submitted: false });
    Object.assign(room, { status: 'lobby', letter: null, pickerKey: null, zapBy: null, rows: [], review: [], results: null, round: 0, done: 0, used: [] });
    this.broadcast();
  }

  /* ---------- What each player is sent ---------- */

  protected view(forId: string | null): Msg {
    const room = this.room;
    const now = this.ctx.now();
    const me = this.byId(forId);
    const left = (at: number) => Math.max(0, at - now);
    const playing = room.status === 'play';
    const zapper = this.byKey(room.zapBy);
    const picker = this.byKey(room.pickerKey);
    const ranked = room.status === 'over'
      ? E.rank(room.players.filter((p) => p.inGame).map((p) => ({ key: p.key, score: p.score, unique: p.unique })))
      : [];
    return {
      t: 'state',
      code: room.code, status: room.status, public: room.public, game: room.game,
      round: room.round, totalRounds: room.totalRounds, settings: room.settings,
      letter: room.letter, used: room.used,
      pickerId: picker ? picker.id : null, pickerName: picker ? picker.name : '',
      pickLeft: room.status === 'pick' ? left(room.pickEnd) : 0,
      playLeft: playing ? left(room.lockAt) : 0,
      zap: zapper ? { by: zapper.name, mine: zapper === me } : null,
      voteLeft: room.status === 'review' ? left(room.voteEnd) : 0,
      nextLeft: room.status === 'results' ? left(room.nextAt) : 0,
      // Everyone sees how many answers each player has filled in, never what they are
      players: room.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost, connected: p.connected, away: p.away, photo: p.photo || '',
        inGame: p.inGame, score: p.score, unique: p.unique, best: p.best,
        filled: playing && p.inGame ? E.filledCount(room.settings.categories, p.answers) : 0,
        submitted: playing && p.inGame ? p.submitted : false,
      })),
      // Your own answers, so a refresh in the middle of a round puts them back
      mine: me && me.inGame && playing ? { answers: me.answers, submitted: me.submitted } : null,
      review: room.status === 'review' ? this.reviewView(me) : null,
      results: room.status === 'results' || room.status === 'over' ? room.results : null,
      standings: ranked.map((r: { key: string; place: number }) => {
        const p = this.byKey(r.key) as Player;
        return { name: p.name, id: p.id, photo: p.photo || '', score: p.score, unique: p.unique, best: p.best, place: r.place, connected: p.connected };
      }),
      wins: Object.values(room.wins),
      crew: room.crew ? room.crew.name : null,
      crewStatus: room.crewStatus,
    };
  }

  private reviewView(me: Player | undefined): Msg {
    const room = this.room;
    return {
      waiting: this.reviewWaiting(),
      items: room.review.map((i, n) => {
        const mine = Boolean(me && i.owners.includes(me.key));
        return {
          i: n, cat: i.cat, text: i.shown, owners: i.owners.map((k) => this.byKey(k)?.name ?? 'Someone'), mine,
          // Only your own vote: the tallies stay hidden until the round's results
          vote: me && i.up.includes(me.key) ? 1 : me && i.down.includes(me.key) ? -1 : 0,
          canVote: Boolean(me && me.inGame && !mine),
        };
      }),
    };
  }
}

const blank = (ctx: RoomCtx, opts: { public: boolean }): Room => ({
  code: ctx.code, public: opts.public, status: 'lobby', game: 0, players: [], crew: null, crewStatus: '',
  settings: E.cleanSettings(null), round: 0, totalRounds: 0, done: 0, used: [], letter: null, pickerKey: null,
  pickEnd: 0, lockAt: 0, voteEnd: 0, nextAt: 0, zapBy: null, rows: [], review: [], results: null, wins: {},
});

export const atozap: GameModule = {
  id: GAME,
  maxMsgBytes: 2048,
  rate: { perSec: 6, burst: 20 },
  create(ctx: RoomCtx, opts) {
    return new ZapRoom(ctx, blank(ctx, opts));
  },
  restore(ctx, snap) {
    const room = snap as Room;
    restoreSeats(ctx, room);
    room.settings = E.cleanSettings(room.settings);
    return new ZapRoom(ctx, room);
  },
};
