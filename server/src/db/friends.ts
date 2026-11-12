// Friends, online status and recent players (tables from migrations/0004_friends.sql).
//
// Who can have friends: Google accounts only ('u:<uid>'). A guest id lives in one browser and is thrown away with it,
// so a friendship on it would silently vanish. Guests DO get a recent-players list (and it moves to the account when
// they sign in), and anyone can be added from it as long as they are a Google account.
//
// Friendship is mutual: a request has to be accepted. Online status and invites only ever flow between accepted
// friends. Nothing in here hands a player id to a browser: people are named by their friend code, or (recent players)
// by a random per-row `ref`.
import type { GameReport } from '../core/game';
import { randomId } from '../core/util';

export const LIMITS = {
  /** Most friends one person can have. Keeps every list (and the one presence query behind it) bounded. */
  friends: 100,
  /** Requests waiting for me / waiting for someone else. */
  incoming: 50,
  outgoing: 20,
  /** Friend requests a person may send per day (UTC), counting codes that don't exist. */
  perDay: 30,
  blocked: 100,
  recents: 30,
};

/** Someone is online while their presence row is newer than this. The browser beats every ~100 s. */
export const ONLINE_MS = 250_000;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const FRIEND_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

/** "k7qx-92md" -> "K7QX92MD" (spaces and dashes allowed), or '' when it can't be a code. */
export function normalizeCode(raw: unknown): string {
  const s = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '');
  return FRIEND_CODE_RE.test(s) ? s : '';
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let c = '';
  for (const b of bytes) c += CODE_CHARS[b % CODE_CHARS.length];
  return c;
}

export interface Profile {
  code: string;
  name: string;
}

/** My profile (created on first use). `name` refreshes it when it changed. */
export async function ensureProfile(db: D1Database, id: string, name: string): Promise<Profile> {
  const found = await db.prepare('SELECT code, name FROM friend_profiles WHERE player_id = ?1').bind(id).first<Profile>();
  if (found) {
    if (name && name !== found.name) {
      await db.prepare('UPDATE friend_profiles SET name = ?2 WHERE player_id = ?1').bind(id, name).run();
      return { code: found.code, name };
    }
    return found;
  }
  for (let i = 0; i < 6; i++) {
    const code = newCode();
    const res = await db
      .prepare('INSERT OR IGNORE INTO friend_profiles (player_id, code, name, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(id, code, name || 'Player', Date.now())
      .run();
    if (res.meta.changes > 0) return { code, name: name || 'Player' };
    // Either the code was taken or another request just made this profile
    const again = await db.prepare('SELECT code, name FROM friend_profiles WHERE player_id = ?1').bind(id).first<Profile>();
    if (again) return again;
  }
  throw new Error('could not make a friend code');
}

export type FriendState = 'friend' | 'in' | 'out' | 'blocked';

export interface FriendRow {
  code: string;
  name: string;
}
export interface FriendEntry extends FriendRow {
  online: boolean;
  game: string;
  room: string;
}
export interface FriendList {
  me: Profile;
  friends: FriendEntry[];
  incoming: FriendRow[];
  outgoing: FriendRow[];
  blocked: FriendRow[];
  limits: { friends: number };
}

/** Everything the panel shows, in ONE read: my relationships joined to their profile and presence. */
export async function friendList(db: D1Database, me: string, profile: Profile, now = Date.now()): Promise<FriendList> {
  const { results } = await db
    .prepare(
      `SELECT f.state, p.code, p.name, pr.game, pr.room, pr.seen
       FROM friends f
       JOIN friend_profiles p ON p.player_id = f.other_id
       LEFT JOIN presence pr ON pr.player_id = f.other_id
       WHERE f.player_id = ?1
       ORDER BY p.name COLLATE NOCASE LIMIT 300`,
    )
    .bind(me)
    .all<{ state: FriendState; code: string; name: string; game: string | null; room: string | null; seen: number | null }>();
  const out: FriendList = { me: profile, friends: [], incoming: [], outgoing: [], blocked: [], limits: { friends: LIMITS.friends } };
  for (const r of results) {
    if (r.state === 'friend') {
      const online = (r.seen ?? 0) > now - ONLINE_MS;
      out.friends.push({ code: r.code, name: r.name, online, game: online ? r.game || '' : '', room: online ? r.room || '' : '' });
    } else if (r.state === 'in') out.incoming.push({ code: r.code, name: r.name });
    else if (r.state === 'out') out.outgoing.push({ code: r.code, name: r.name });
    else if (r.state === 'blocked') out.blocked.push({ code: r.code, name: r.name });
  }
  // Online friends first
  out.friends.sort((a, b) => Number(b.online) - Number(a.online));
  return out;
}

/** What the chip shows right after connecting: requests waiting and friends online. */
export async function summary(db: D1Database, me: string, now = Date.now()): Promise<{ requests: number; online: number }> {
  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN f.state = 'in' THEN 1 ELSE 0 END) AS requests,
              SUM(CASE WHEN f.state = 'friend' AND pr.seen > ?2 THEN 1 ELSE 0 END) AS online
       FROM friends f LEFT JOIN presence pr ON pr.player_id = f.other_id WHERE f.player_id = ?1`,
    )
    .bind(me, now - ONLINE_MS)
    .first<{ requests: number | null; online: number | null }>();
  return { requests: row?.requests ?? 0, online: row?.online ?? 0 };
}

interface Target {
  id: string;
  profile: Profile;
}

/** Who a code or a recent-players ref points at. null: nobody (or a guest, who can't have friends). */
async function resolve(db: D1Database, me: string, by: { code?: string; ref?: string }): Promise<Target | null> {
  if (by.code) {
    const row = await db.prepare('SELECT player_id, code, name FROM friend_profiles WHERE code = ?1').bind(by.code).first<{ player_id: string; code: string; name: string }>();
    return row ? { id: row.player_id, profile: { code: row.code, name: row.name } } : null;
  }
  if (by.ref && /^[A-Za-z0-9_-]{4,16}$/.test(by.ref)) {
    const row = await db.prepare('SELECT other, name FROM recent_players WHERE owner = ?1 AND ref = ?2').bind(me, by.ref).first<{ other: string; name: string }>();
    if (!row || !row.other.startsWith('u:')) return null;
    return { id: row.other, profile: await ensureProfile(db, row.other, row.name) };
  }
  return null;
}

const stateOf = async (db: D1Database, a: string, b: string): Promise<FriendState | null> =>
  (await db.prepare('SELECT state FROM friends WHERE player_id = ?1 AND other_id = ?2').bind(a, b).first<{ state: FriendState }>())?.state ?? null;

const countOf = async (db: D1Database, id: string, state: FriendState): Promise<number> =>
  (await db.prepare('SELECT COUNT(*) AS n FROM friends WHERE player_id = ?1 AND state = ?2').bind(id, state).first<{ n: number }>())?.n ?? 0;

const link = (db: D1Database, a: string, b: string, stateA: FriendState, stateB: FriendState, at: number) => [
  db.prepare('INSERT OR REPLACE INTO friends (player_id, other_id, state, at) VALUES (?1, ?2, ?3, ?4)').bind(a, b, stateA, at),
  db.prepare('INSERT OR REPLACE INTO friends (player_id, other_id, state, at) VALUES (?1, ?2, ?3, ?4)').bind(b, a, stateB, at),
];

export type Outcome =
  | { ok: true; result: 'sent' | 'accepted' | 'already'; other: string; otherName: string }
  | { ok: false; error: string; code: 'no-code' | 'self' | 'limit' | 'full' | 'you-blocked' | 'pending' | 'not-found' | 'guest' };

/** One more request today, or false when today's limit is used up. */
async function spendRequest(db: D1Database, me: string, now: number): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  const res = await db
    .prepare(
      `UPDATE friend_profiles SET req_day = ?2, req_count = CASE WHEN req_day = ?2 THEN req_count + 1 ELSE 1 END
       WHERE player_id = ?1 AND (req_day != ?2 OR req_count < ?3)`,
    )
    .bind(me, day, LIMITS.perDay)
    .run();
  return res.meta.changes > 0;
}

/**
 * Ask someone to be friends. If they already asked me, this accepts. A person who blocked me gets nothing and I'm
 * told "sent" anyway, so a block can't be detected. Needs my profile to exist.
 */
export async function requestFriend(db: D1Database, me: string, by: { code?: string; ref?: string }, now = Date.now()): Promise<Outcome> {
  if (!(await spendRequest(db, me, now))) return { ok: false, code: 'limit', error: 'You’ve sent a lot of requests today. Try again tomorrow.' };
  if (by.ref && !by.code) {
    // A recent player who is a guest can't be added: say so plainly
    const row = await db.prepare('SELECT other FROM recent_players WHERE owner = ?1 AND ref = ?2').bind(me, by.ref).first<{ other: string }>();
    if (row && !row.other.startsWith('u:')) return { ok: false, code: 'guest', error: 'That player isn’t signed in with Google, so they can’t be added as a friend.' };
  }
  const target = await resolve(db, me, by);
  if (!target) return { ok: false, code: by.ref ? 'not-found' : 'no-code', error: by.ref ? 'That player isn’t in your recent list any more.' : 'No one has that friend code. Check it and try again.' };
  if (target.id === me) return { ok: false, code: 'self', error: 'That’s your own code.' };
  const sent = (result: 'sent' | 'accepted' | 'already'): Outcome => ({ ok: true, result, other: target.id, otherName: target.profile.name });
  const [mine, theirs] = await Promise.all([stateOf(db, me, target.id), stateOf(db, target.id, me)]);
  if (mine === 'friend') return sent('already');
  if (mine === 'blocked') return { ok: false, code: 'you-blocked', error: 'You blocked this person. Unblock them first.' };
  if (theirs === 'blocked') return sent('sent'); // silently dropped
  if (mine === 'out') return sent('already');
  if (theirs === 'out') {
    // They already asked me: that is a yes
    if ((await countOf(db, me, 'friend')) >= LIMITS.friends) return { ok: false, code: 'full', error: `You already have ${LIMITS.friends} friends.` };
    if ((await countOf(db, target.id, 'friend')) >= LIMITS.friends) return sent('sent');
    await db.batch(link(db, me, target.id, 'friend', 'friend', now));
    return sent('accepted');
  }
  if ((await countOf(db, me, 'friend')) >= LIMITS.friends) return { ok: false, code: 'full', error: `You already have ${LIMITS.friends} friends.` };
  if ((await countOf(db, me, 'out')) >= LIMITS.outgoing) return { ok: false, code: 'pending', error: `You already have ${LIMITS.outgoing} requests waiting. Cancel one first.` };
  // Their inbox is full: look like it worked rather than reveal anything about them
  if ((await countOf(db, target.id, 'in')) >= LIMITS.incoming) return sent('sent');
  await db.batch(link(db, me, target.id, 'out', 'in', now));
  return sent('sent');
}

type Simple = { ok: true; other: string; otherName: string } | { ok: false; error: string };

/** Accept a request someone sent me. */
export async function acceptFriend(db: D1Database, me: string, code: string, now = Date.now()): Promise<Simple> {
  const target = await resolve(db, me, { code });
  if (!target || (await stateOf(db, me, target.id)) !== 'in') return { ok: false, error: 'That request isn’t there any more.' };
  if ((await countOf(db, me, 'friend')) >= LIMITS.friends) return { ok: false, error: `You already have ${LIMITS.friends} friends.` };
  if ((await countOf(db, target.id, 'friend')) >= LIMITS.friends) return { ok: false, error: 'They have reached the friend limit.' };
  await db.batch(link(db, me, target.id, 'friend', 'friend', now));
  return { ok: true, other: target.id, otherName: target.profile.name };
}

/** Delete both rows when mine is in one of `states` (decline an 'in', cancel an 'out', remove a 'friend'). */
export async function dropLink(db: D1Database, me: string, code: string, states: FriendState[]): Promise<Simple> {
  const target = await resolve(db, me, { code });
  const mine = target ? await stateOf(db, me, target.id) : null;
  if (!target || !mine || !states.includes(mine)) return { ok: false, error: 'That isn’t in your list any more.' };
  await db.batch([
    db.prepare('DELETE FROM friends WHERE player_id = ?1 AND other_id = ?2').bind(me, target.id),
    // never touch their row when it is a block of me
    db.prepare(`DELETE FROM friends WHERE player_id = ?2 AND other_id = ?1 AND state != 'blocked'`).bind(me, target.id),
  ]);
  return { ok: true, other: target.id, otherName: target.profile.name };
}

/** Block someone (by friend code, or by a recent-players ref): they vanish from my lists and can't reach me. */
export async function blockPlayer(db: D1Database, me: string, by: { code?: string; ref?: string }, now = Date.now()): Promise<Simple> {
  let target = await resolve(db, me, by);
  if (!target && by.ref) {
    // A guest in my recent list can be blocked too: it just hides them
    const row = await db.prepare('SELECT other FROM recent_players WHERE owner = ?1 AND ref = ?2').bind(me, by.ref).first<{ other: string }>();
    if (row) target = { id: row.other, profile: { code: '', name: '' } };
  }
  if (!target) return { ok: false, error: 'That player isn’t in your list any more.' };
  if (target.id === me) return { ok: false, error: 'You can’t block yourself.' };
  if ((await stateOf(db, me, target.id)) !== 'blocked' && (await countOf(db, me, 'blocked')) >= LIMITS.blocked)
    return { ok: false, error: `You can block up to ${LIMITS.blocked} people.` };
  await db.batch([
    db.prepare(`DELETE FROM friends WHERE player_id = ?2 AND other_id = ?1 AND state != 'blocked'`).bind(me, target.id),
    db.prepare('INSERT OR REPLACE INTO friends (player_id, other_id, state, at) VALUES (?1, ?2, \'blocked\', ?3)').bind(me, target.id, now),
    db.prepare('DELETE FROM recent_players WHERE owner = ?1 AND other = ?2').bind(me, target.id),
  ]);
  return { ok: true, other: target.id, otherName: target.profile.name };
}

export async function unblockPlayer(db: D1Database, me: string, code: string): Promise<Simple> {
  const target = await resolve(db, me, { code });
  if (!target || (await stateOf(db, me, target.id)) !== 'blocked') return { ok: false, error: 'That person isn’t blocked.' };
  await db.prepare(`DELETE FROM friends WHERE player_id = ?1 AND other_id = ?2 AND state = 'blocked'`).bind(me, target.id).run();
  return { ok: true, other: target.id, otherName: target.profile.name };
}

// ---------- Presence ----------

/** Mark a player online (seen = now) with where they are, or offline (seen = 0). */
export async function setPresence(db: D1Database, id: string, where: { game: string; room: string } | null, seen: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO presence (player_id, game, room, seen) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (player_id) DO UPDATE SET game = excluded.game, room = excluded.room, seen = excluded.seen`,
    )
    .bind(id, where?.game ?? '', where?.room ?? '', seen)
    .run();
}

/** Just refresh "seen" (the periodic beat). */
export async function touchPresence(db: D1Database, id: string, seen: number): Promise<void> {
  await db.prepare('UPDATE presence SET seen = ?2 WHERE player_id = ?1 AND seen != 0').bind(id, seen).run();
}

export interface InviteTarget {
  id: string;
  name: string;
  online: boolean;
}

/** Can `me` invite the friend with this code? Both rows must say 'friend'. Also says whether they look online. */
export async function inviteTarget(db: D1Database, me: string, code: string, now = Date.now()): Promise<InviteTarget | null> {
  const row = await db
    .prepare(
      `SELECT t.player_id AS id, t.name AS name, pr.seen AS seen
       FROM friend_profiles t
       JOIN friends mine ON mine.player_id = ?1 AND mine.other_id = t.player_id AND mine.state = 'friend'
       JOIN friends theirs ON theirs.player_id = t.player_id AND theirs.other_id = ?1 AND theirs.state = 'friend'
       LEFT JOIN presence pr ON pr.player_id = t.player_id
       WHERE t.code = ?2`,
    )
    .bind(me, code)
    .first<{ id: string; name: string; seen: number | null }>();
  return row ? { id: row.id, name: row.name, online: (row.seen ?? 0) > now - ONLINE_MS } : null;
}

export const profileOf = (db: D1Database, id: string) =>
  db.prepare('SELECT code, name FROM friend_profiles WHERE player_id = ?1').bind(id).first<Profile>();

// ---------- Recent players ----------

/**
 * Statements that remember, for everyone in a finished room game, everyone else who was in it (guests included).
 * Called from recordGame, so it happens once, on the server, at the end of the game. Capped per player.
 */
export function recentStatements(db: D1Database, r: GameReport, now: number): D1PreparedStatement[] {
  const seen = new Map<string, string>();
  for (const p of r.players) {
    const id = p.uid ? `u:${p.uid}` : p.guest ? `g:${p.guest}` : null;
    if (id && !seen.has(id)) seen.set(id, p.name);
  }
  if (seen.size < 2) return [];
  const upsert = db.prepare(
    `INSERT INTO recent_players (owner, other, name, game, at, ref) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (owner, other) DO UPDATE SET name = excluded.name, game = excluded.game, at = excluded.at`,
  );
  const prune = db.prepare(
    `DELETE FROM recent_players WHERE owner = ?1 AND other NOT IN
       (SELECT other FROM recent_players WHERE owner = ?1 ORDER BY at DESC, other LIMIT ?2)`,
  );
  const out: D1PreparedStatement[] = [];
  for (const [owner] of seen) {
    for (const [other, name] of seen) if (other !== owner) out.push(upsert.bind(owner, other, name, r.game, now, randomId()));
    out.push(prune.bind(owner, LIMITS.recents));
  }
  return out;
}

export interface Recent {
  ref: string;
  name: string;
  game: string;
  at: number;
  /** none: can be added; out: I already asked; guest: not a Google account. */
  status: 'none' | 'out' | 'in' | 'guest';
}

/**
 * My recent players, newest first. Friends and people I blocked (or who blocked me) are left out. Someone who
 * already asked me shows as 'in', so one tap accepts.
 */
export async function recentList(db: D1Database, me: string): Promise<Recent[]> {
  const { results } = await db
    .prepare(
      `SELECT r.ref, r.name, r.game, r.at, r.other, mine.state AS mine
       FROM recent_players r
       LEFT JOIN friends mine ON mine.player_id = r.owner AND mine.other_id = r.other
       WHERE r.owner = ?1
         AND COALESCE(mine.state, '') NOT IN ('friend', 'blocked')
         AND NOT EXISTS (SELECT 1 FROM friends theirs WHERE theirs.player_id = r.other AND theirs.other_id = r.owner AND theirs.state = 'blocked')
       ORDER BY r.at DESC, r.other LIMIT ?2`,
    )
    .bind(me, LIMITS.recents)
    .all<{ ref: string; name: string; game: string; at: number; other: string; mine: string | null }>();
  return results.map((r) => ({
    ref: r.ref,
    name: r.name,
    game: r.game,
    at: r.at,
    status: !r.other.startsWith('u:') ? 'guest' : r.mine === 'out' ? 'out' : r.mine === 'in' ? 'in' : 'none',
  }));
}
