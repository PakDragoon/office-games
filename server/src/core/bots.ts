// Computer players in a room (Flipchip, Rotten, Thulla). A bot is just a seat the room itself plays for:
// it has no connection, no Google/guest id, never becomes host, never counts as a person for Quick Play or
// for keeping the room alive, and is never written to the database. Its moves go through the very same
// checks as a person's, and its "thinking" time is an ordinary room timer, so it survives a restart.

export const BOT_MARK = '🤖';
export type BotLevel = 'easy' | 'normal';
export const BOT_LEVELS: BotLevel[] = ['easy', 'normal'];
export const isBotLevel = (v: unknown): v is BotLevel => v === 'easy' || v === 'normal';

const NAMES = [
  'Sara', 'Omar', 'Ayesha', 'Bilal', 'Hina', 'Zain', 'Mina', 'Kabir', 'Noor', 'Farah', 'Tariq', 'Lena', 'Ravi', 'Dina',
  'Sami', 'Yusuf', 'Nadia', 'Ali', 'Zara', 'Imran',
];

/** A fresh bot name ("🤖 Sara") that nobody in the room has. */
export function botName(taken: string[], rnd: () => number): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  const free = NAMES.filter((n) => !used.has(`${BOT_MARK} ${n}`.toLowerCase()));
  if (free.length) return `${BOT_MARK} ${free[Math.floor(rnd() * free.length)]}`;
  for (let i = 2; ; i++) {
    const n = `${BOT_MARK} ${NAMES[Math.floor(rnd() * NAMES.length)]} ${i}`;
    if (!used.has(n.toLowerCase())) return n;
  }
}

/** Seat ids for bots can never equal a connection id (those start with "c_"). */
export const botId = (rnd: () => number): string => `b_${Math.floor(rnd() * 36 ** 6).toString(36).padStart(6, '0')}`;

/** A person's typed name can't pretend to be a bot: the marker is stripped from the front. */
export const humanName = (name: string): string => name.replace(new RegExp(`^(?:${BOT_MARK}\\s*)+`, 'u'), '').trim();

/** A human-like pause: between lo and hi ms (an easy bot is slower). */
export function botDelay(level: BotLevel, rnd: () => number, lo: number, hi: number): number {
  const slow = level === 'easy' ? 1.5 : 1;
  return Math.round((lo + (hi - lo) * rnd()) * slow);
}
