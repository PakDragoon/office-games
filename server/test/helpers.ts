import { SELF } from 'cloudflare:test';

export type Msg = Record<string, unknown> & { t?: string };

/** A test player: a WebSocket into the Worker that records everything it receives. */
export class TestClient {
  msgs: Msg[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];

  constructor(public ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      const data = typeof e.data === 'string' ? e.data : '';
      this.msgs.push(data === 'pong' ? { t: 'pong' } : (JSON.parse(data) as Msg));
      this.wake();
    });
    ws.addEventListener('close', (e) => {
      this.closed = { code: e.code, reason: e.reason };
      this.wake();
    });
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  static async open(path: string): Promise<TestClient> {
    const res = await SELF.fetch(`https://play.test${path}`, { headers: { Upgrade: 'websocket' } });
    const ws = res.webSocket;
    if (!ws) throw new Error(`no websocket (${res.status} ${await res.text()})`);
    ws.accept();
    return new TestClient(ws);
  }

  send(msg: Msg | string): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  join(name: string, extra: Msg = {}): void {
    this.send({ t: 'join', v: 1, name, client: `tab-${name}`, ...extra });
  }

  /** The next message (from `from` onwards) matching pred. */
  async next(pred: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.msgs.find(pred);
      if (found) {
        this.msgs.splice(this.msgs.indexOf(found), 1);
        return found;
      }
      if (this.closed) throw new Error(`closed (${this.closed.code} ${this.closed.reason}) while waiting`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; have: ${JSON.stringify(this.msgs.map((m) => m.t))}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** The newest state message received so far (waits for one if none yet). */
  async state(pred: (s: Msg) => boolean = () => true): Promise<Msg> {
    return this.next((m) => m.t === 'state' && pred(m));
  }

  drain(): void {
    this.msgs = [];
  }

  close(): void {
    this.ws.close(1000, 'bye');
  }
}

export const playersOf = (s: Msg) => s.players as Array<Record<string, unknown>>;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Host a new room (rotten unless another game is named) and return the host client plus the room code. */
export async function hostRoom(name = 'Hana', query = 'create=1', game = 'rotten'): Promise<{ host: TestClient; code: string; id: string }> {
  const host = await TestClient.open(`/${game}/ws?${query}`);
  host.join(name);
  const welcome = await host.next((m) => m.t === 'welcome');
  return { host, code: welcome.code as string, id: welcome.id as string };
}

/** Host a room of `game` and seat the given extra players. */
export async function room(game: string, names: string[]): Promise<{ code: string; clients: TestClient[]; ids: string[] }> {
  const { host, code, id } = await hostRoom(names[0], 'create=1', game);
  const clients = [host];
  const ids = [id];
  for (const n of names.slice(1)) {
    const c = await TestClient.open(`/${game}/ws?code=${code}`);
    c.join(n);
    const w = await c.next((m) => m.t === 'welcome');
    clients.push(c);
    ids.push(w.id as string);
  }
  await host.state((s) => playersOf(s).length === names.length);
  return { code, clients, ids };
}
