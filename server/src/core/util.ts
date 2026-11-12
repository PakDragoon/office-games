export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_RE = /^[A-HJ-NP-Z]{4}$/;

export function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let c = '';
  for (const b of bytes) c += CODE_CHARS[b % CODE_CHARS.length];
  return c;
}

export function randomId(prefix = ''): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return prefix + btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => (c === '+' ? '-' : c === '/' ? '_' : ''));
}

/** A small, fast, seedable random generator whose state can be saved and restored. */
export class Rng {
  constructor(public state: number) {}
  static seeded(): Rng {
    return new Rng(crypto.getRandomValues(new Uint32Array(1))[0]);
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// Words nobody should see as a player name on a public game. English and romanised Urdu.
// Matched on the name squashed to letters, so "b a d" and "b.a.d" are caught too.
const BAD = [
  'fuck', 'shit', 'cunt', 'bitch', 'nigger', 'nigga', 'faggot', 'whore', 'slut', 'rape', 'dick', 'pussy', 'asshole',
  'bastard', 'porn', 'nazi', 'hitler',
  'chutiya', 'chutia', 'choot', 'bhenchod', 'behenchod', 'benchod', 'madarchod', 'maderchod', 'mc bc', 'gandu', 'gaandu',
  'harami', 'haramzada', 'haramzadi', 'kanjar', 'kanjri', 'randi', 'lund', 'lun', 'phudi', 'phuddi', 'bhosdi', 'bhosda',
  'kutta', 'kuttay', 'kutti', 'khotey', 'gashti', 'dalla', 'dallay',
].map((w) => w.replace(/[^a-z]/g, ''));
// Short words that only count when they are the whole name, to avoid catching real names
const BAD_EXACT = new Set(['mc', 'bc', 'lun', 'lund', 'sex']);

export function isRudeName(name: string): boolean {
  const squashed = name.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/[^a-z]/g, '');
  if (BAD_EXACT.has(squashed)) return true;
  return BAD.some((w) => w.length >= 4 && squashed.includes(w));
}

/** Same rules as the games' own cleanName, plus the rude-name check (rude names become "Player"). */
export function cleanName(raw: unknown, max = 16): string {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  if (!name || isRudeName(name)) return '';
  return name;
}

export function cleanPhoto(url: unknown): string {
  const s = String(url ?? '');
  return /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(s) ? s.slice(0, 500) : '';
}

/** Token bucket: true if the message may go through. */
export class Bucket {
  private tokens: number;
  private at: number;
  constructor(private perSec: number, private burst: number) {
    this.tokens = burst;
    this.at = Date.now();
  }
  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.perSec);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
