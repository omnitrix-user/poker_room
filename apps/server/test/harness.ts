import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { io as connectClient, type Socket } from "socket.io-client";
import type { Ack, ClientEventName, RoomSettings, RoomView } from "@riverroom/protocol";
import { createRiverRoom } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import pg from "pg";
import { embeddedDb, postgresDb, type Db } from "../src/db.ts";

process.env.LOG_LEVEL ??= "silent";

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    isProd: false,
    databaseUrl: undefined,
    dataDir: undefined,
    secretKey: randomBytes(32),
    reconnectGraceMs: 400,
    handPauseMs: 60,
    runoutPauseMs: 60,
    showdownPauseMs: 60,
    finalVoteWindowMs: 400,
    voteMs: 500,
    webDist: undefined,
    trustProxy: false,
    allowedOrigins: [],
    ...over,
  };
}

export type Server = Awaited<ReturnType<typeof startServer>>;

/**
 * In-memory embedded Postgres by default. With TEST_DATABASE_URL set, each server gets a
 * brand-new database on that Postgres server, so the suite also runs against real Postgres.
 */
async function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return embeddedDb();
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const name = `rr_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(url);
  u.pathname = `/${name}`;
  return postgresDb(u.toString(), 5);
}

export async function startServer(opts: { db?: Db; config?: Config } = {}) {
  const ownsDb = !opts.db;
  const db = opts.db ?? (await freshDb());
  const config = opts.config ?? testConfig();
  const server = await createRiverRoom(config, db);
  await new Promise<void>((r) => server.http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
  const clients: Socket[] = [];
  return {
    ...server,
    db,
    config,
    url,
    clients,
    async stop() {
      for (const c of clients) c.disconnect();
      await server.close();
      await new Promise((r) => server.http.close(r));
      if (ownsDb) await db.close().catch(() => {});
    },
  };
}

export interface TestPlayer {
  id: string;
  name: string;
  cookie: string;
  socket: Socket;
  states: RoomView[];
  notices: string[];
  superseded: boolean;
  emit<E extends ClientEventName>(event: E, payload?: unknown): Promise<Ack>;
  state(): RoomView;
  waitFor(pred: (v: RoomView) => boolean, timeoutMs?: number): Promise<RoomView>;
  /** Raw JSON of every payload this client received (for leak checks). */
  raw: string[];
  api<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  reconnect(target?: Server): Promise<void>;
}

export async function guest(server: Server, name: string): Promise<{ id: string; cookie: string }> {
  const res = await fetch(`${server.url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json()) as { player: { id: string } };
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return { id: body.player.id, cookie };
}

export async function player(server: Server, name: string): Promise<TestPlayer> {
  const g = await guest(server, name);
  const p: TestPlayer = {
    id: g.id,
    name,
    cookie: g.cookie,
    socket: null as unknown as Socket,
    states: [],
    notices: [],
    raw: [],
    superseded: false,
    emit: (event, payload = {}) => p.socket.timeout(5000).emitWithAck(event, payload) as Promise<Ack>,
    state: () => {
      const s = p.states[p.states.length - 1];
      if (!s) throw new Error(`${name} has no state`);
      return s;
    },
    waitFor: (pred, timeoutMs = 4000) =>
      new Promise((resolve, reject) => {
        const last = p.states[p.states.length - 1];
        if (last && pred(last)) return resolve(last);
        const timer = setTimeout(() => {
          p.socket.off("room:state", check);
          reject(new Error(`${name}: timed out waiting for state`));
        }, timeoutMs);
        const check = (v: RoomView) => {
          if (pred(v)) {
            clearTimeout(timer);
            p.socket.off("room:state", check);
            resolve(v);
          }
        };
        p.socket.on("room:state", check);
      }),
    api: async (path, init) => {
      const res = await fetch(`${server.url}${path}`, {
        ...init,
        headers: { "content-type": "application/json", cookie: g.cookie, ...(init?.headers ?? {}) },
      });
      return { status: res.status, body: (await res.json()) as never };
    },
    reconnect: async (target = server) => {
      p.socket?.disconnect();
      p.socket = await openSocket(target, g.cookie);
      wire();
    },
  };
  const wire = () => {
    p.socket.on("room:state", (v: RoomView) => {
      p.states.push(v);
      p.raw.push(JSON.stringify(v));
    });
    p.socket.on("room:notice", (n: { text: string }) => p.notices.push(n.text));
    p.socket.on("room:superseded", () => (p.superseded = true));
  };
  p.socket = await openSocket(server, g.cookie);
  wire();
  return p;
}

export function openSocket(server: Server, cookie: string | null): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectClient(server.url, {
      transports: ["websocket"],
      extraHeaders: cookie ? { cookie } : {},
      reconnection: false,
      forceNew: true,
    });
    server.clients.push(socket);
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => reject(err));
  });
}

export async function createRoom(host: TestPlayer, settings?: Partial<RoomSettings>): Promise<string> {
  const full = settings
    ? { smallBlind: 10, bigBlind: 20, startingStack: 2000, maxSeats: 6, turnSeconds: 0, rebuys: false, rounds: 100, ...settings }
    : { smallBlind: 10, bigBlind: 20, startingStack: 2000, maxSeats: 6, turnSeconds: 0, rebuys: false, rounds: 100 };
  const res = await host.api<{ code: string }>("/api/rooms", { method: "POST", body: JSON.stringify({ settings: full }) });
  if (res.status !== 200) throw new Error(`create failed: ${JSON.stringify(res.body)}`);
  return res.body.code;
}

/** Creates a room, seats everyone, readies them, and starts the game. */
export async function startedTable(server: Server, names: string[], settings?: Partial<RoomSettings>) {
  const players: TestPlayer[] = [];
  for (const n of names) players.push(await player(server, n));
  const code = await createRoom(players[0]!, settings);
  for (const p of players) expectOk(await p.emit("room:join", { code }));
  for (const p of players.slice(1)) expectOk(await p.emit("room:ready", { ready: true }));
  expectOk(await players[0]!.emit("game:start"));
  for (const p of players) await p.waitFor((v) => v.game?.handNo === 1);
  return { code, players };
}

export function expectOk(ack: Ack): void {
  if (!ack.ok) throw new Error(`expected ok, got ${ack.code}: ${ack.message}`);
}

/** The player whose turn it is, according to the latest view. */
export function actor(players: TestPlayer[]): TestPlayer {
  const v = players[0]!.state();
  const seat = v.game?.toActSeat;
  const id = v.players.find((p) => p.seat === seat)?.playerId;
  const p = players.find((x) => x.id === id);
  if (!p) throw new Error("nobody to act");
  return p;
}

export function act(p: TestPlayer, action: unknown, over: { seq?: number; handNo?: number; actionId?: string } = {}) {
  const g = p.state().game!;
  return p.emit("game:action", {
    actionId: over.actionId ?? randomUUID(),
    handNo: over.handNo ?? g.handNo,
    seq: over.seq ?? g.seq,
    action,
  });
}

/** Waits until every player has seen the same game sequence number. */
export async function settle(players: TestPlayer[]) {
  const target = players[0]!.state();
  for (const p of players) await p.waitFor((v) => v.game?.handNo === target.game?.handNo && v.game?.seq === target.game?.seq);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
