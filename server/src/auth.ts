import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomId } from './core/util';

// Google's public keys for Firebase ID tokens. jose caches them across requests in this isolate.
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

export interface FirebaseUser {
  uid: string;
  name: string;
  photo: string;
}

/** The signed-in user behind a Firebase ID token, or null if it doesn't check out. */
export async function verifyFirebase(token: unknown, project: string): Promise<FirebaseUser | null> {
  if (typeof token !== 'string' || token.length > 4096 || token.split('.').length !== 3) return null;
  try {
    const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${project}`,
      audience: project,
      algorithms: ['RS256'],
    });
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    return {
      uid: payload.sub.slice(0, 128),
      name: typeof payload.name === 'string' ? payload.name : '',
      photo: typeof payload.picture === 'string' ? payload.picture : '',
    };
  } catch {
    return null;
  }
}

const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keys.set(secret, k);
  }
  return k;
}

export async function hmac(secret: string, text: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => (c === '+' ? '-' : c === '/' ? '_' : ''));
}

/** A guest token is "g_<id>.<signature>": only the server can make one, so stats can't be claimed for someone else. */
export async function newGuest(secret: string): Promise<{ id: string; token: string }> {
  const id = randomId('g_');
  return { id, token: `${id}.${await hmac(secret, id)}` };
}

export async function verifyGuest(token: unknown, secret: string): Promise<string | null> {
  if (typeof token !== 'string' || token.length > 100) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 3) return null;
  const id = token.slice(0, dot);
  if (!id.startsWith('g_')) return null;
  return (await hmac(secret, id)) === token.slice(dot + 1) ? id : null;
}

// ---------- Hub tickets ----------
// A browser can't put an Authorization header on a WebSocket, and a Firebase token must not sit in a URL. So the
// browser first asks (POST /api/friends/ticket, normal auth) for a ticket that is good for one minute and names
// the player, then opens the socket with it. Only this server can sign one.

const TICKET_MS = 60_000;
const TICKET_PLAYER = /^u:[A-Za-z0-9_-]{1,128}$/;

export async function makeTicket(secret: string, player: string, now = Date.now()): Promise<string> {
  const exp = now + TICKET_MS;
  return `${exp}.${await hmac(secret, `hub|${exp}|${player}`)}.${player}`;
}

/** The player id a fresh, genuine ticket was made for, else null. */
export async function verifyTicket(secret: string, ticket: unknown, now = Date.now()): Promise<string | null> {
  if (typeof ticket !== 'string' || ticket.length > 300) return null;
  const a = ticket.indexOf('.');
  const b = ticket.indexOf('.', a + 1);
  if (a < 1 || b < 0) return null;
  const exp = Number(ticket.slice(0, a));
  const player = ticket.slice(b + 1);
  if (!Number.isFinite(exp) || exp < now || exp > now + TICKET_MS + 5000 || !TICKET_PLAYER.test(player)) return null;
  return (await hmac(secret, `hub|${exp}|${player}`)) === ticket.slice(a + 1, b) ? player : null;
}
