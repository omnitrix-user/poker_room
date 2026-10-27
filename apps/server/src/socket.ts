import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { clientEvents, type Ack, type ClientEventName, type ServerToClient } from "@riverroom/protocol";
import { playerFromCookie } from "./auth.ts";
import { errInfo, log } from "./log.ts";
import { RateLimiter } from "./ratelimit.ts";
import type { Client, Room } from "./room.ts";
import type { RoomManager } from "./rooms.ts";
import type { Store } from "./store.ts";

interface SocketData {
  playerId: string;
  roomId: string | null;
}

type ClientToServer = { [K in ClientEventName]: (raw: unknown, ack?: (a: Ack) => void) => void };
type RRSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

/**
 * Browsers always send Origin on WebSocket and cross-origin requests. Accept only the
 * server's own origin (plus any explicitly allowed ones) as defence in depth on top of
 * the SameSite session cookie.
 */
function originAllowed(origin: string | undefined, host: string | undefined, allowed: string[]): boolean {
  if (!origin) return true; // non-browser clients
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function attachSockets(http: HttpServer, store: Store, rooms: RoomManager, allowedOrigins: string[] = []) {
  const io = new Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>(http, {
    serveClient: false,
    // Same-origin only: the web app is served by this server (or proxied in development).
    cors: undefined,
    pingInterval: 10_000,
    pingTimeout: 8_000,
    allowRequest: (req, cb) => cb(null, originAllowed(req.headers.origin, req.headers.host, allowedOrigins)),
  });

  const eventLimiter = new RateLimiter(60, 10_000);
  const joinLimiter = new RateLimiter(20, 60_000);
  const chatLimiter = new RateLimiter(6, 10_000);

  // Identity comes from the HttpOnly session cookie, never from the payload.
  io.use(async (socket, next) => {
    try {
      const player = await playerFromCookie(store, socket.handshake.headers.cookie);
      if (!player) return next(new Error("unauthenticated"));
      socket.data.playerId = player.id;
      socket.data.roomId = null;
      next();
    } catch (err) {
      log.error("socket auth failed", errInfo(err));
      next(new Error("unavailable"));
    }
  });

  io.on("connection", (socket: RRSocket) => {
    const client = {
      id: socket.id,
      send: ((event: string, ...args: unknown[]) => (socket.emit as (e: string, ...a: unknown[]) => void)(event, ...args)) as Client["send"],
    };

    const currentRoom = (): Room | null => (socket.data.roomId ? (rooms.get(socket.data.roomId) ?? null) : null);

    function on<E extends ClientEventName>(event: E, handler: (payload: import("zod").infer<(typeof clientEvents)[E]>) => Promise<Ack>) {
      const listener = async (raw: unknown, ack?: (a: Ack) => void) => {
        const reply = typeof ack === "function" ? ack : () => {};
        if (!eventLimiter.allow(socket.data.playerId)) return reply({ ok: false, code: "rate_limited", message: "Slow down a little." });
        const parsed = clientEvents[event].safeParse(raw ?? {});
        if (!parsed.success) return reply({ ok: false, code: "bad_request", message: parsed.error.issues[0]?.message ?? "Invalid request." });
        try {
          reply(await handler(parsed.data as never));
        } catch (err) {
          log.error("socket handler failed", { event, playerId: socket.data.playerId, ...errInfo(err) });
          reply({ ok: false, code: "internal", message: "Something went wrong. Please try again." });
        }
      };
      (socket.on as (e: string, l: typeof listener) => void)(event, listener);
    }

    const inRoom = (fn: (room: Room) => Promise<Ack>) => async (): Promise<Ack> => {
      const room = currentRoom();
      if (!room) return { ok: false, code: "not_member", message: "Join a room first." };
      // A tab that was superseded by a newer one for the same player can no longer act.
      if (!room.isCurrentClient(socket.data.playerId, socket.id))
        return { ok: false, code: "not_member", message: "This table is open in another tab." };
      return fn(room);
    };

    on("room:join", async ({ code }) => {
      if (!joinLimiter.allow(socket.data.playerId)) return { ok: false, code: "rate_limited", message: "Too many join attempts. Wait a minute." };
      // Re-validate the session on join so a revoked session can't keep playing.
      const player = await playerFromCookie(store, socket.handshake.headers.cookie);
      if (!player) return { ok: false, code: "unauthenticated", message: "Your session has expired." };
      const room = await rooms.byCode(code);
      if (!room) return { ok: false, code: "room_not_found", message: "No open room with that code." };
      if (room === "finished") return { ok: false, code: "room_finished", message: "This session has ended. You can review it in History." };
      const previous = currentRoom();
      if (previous && previous !== room) previous.detach(socket.data.playerId, socket.id);
      const ack = await room.join(player, client);
      if (ack.ok) socket.data.roomId = room.id;
      return ack;
    });

    on("room:leave", async () => {
      const room = currentRoom();
      if (!room) return { ok: true };
      const ack = await room.leave(socket.data.playerId);
      if (ack.ok) socket.data.roomId = null;
      return ack;
    });

    on("room:sit", (p) => inRoom((room) => room.sit(socket.data.playerId, p))());
    on("room:ready", (p) => inRoom((room) => room.setReady(socket.data.playerId, p))());
    on("room:settings", (p) => inRoom((room) => room.updateSettings(socket.data.playerId, p))());
    on("room:end", () => inRoom((room) => room.requestEnd(socket.data.playerId))());
    on("game:start", () => inRoom((room) => room.start(socket.data.playerId))());
    on("game:action", (p) => inRoom((room) => room.act(socket.data.playerId, p))());
    on("game:show", (p) => inRoom((room) => room.show(socket.data.playerId, p))());
    on("room:vote-start", (p) => inRoom((room) => room.startVote(socket.data.playerId, p))());
    on("room:vote", (p) => inRoom((room) => room.castVote(socket.data.playerId, p))());
    on("room:rebuy", () => inRoom((room) => room.rebuy(socket.data.playerId))());
    on("room:sitout", (p) => inRoom((room) => room.setSitOut(socket.data.playerId, p))());
    on("room:chat", (p) =>
      inRoom(async (room) =>
        chatLimiter.allow(socket.data.playerId) ? room.chat(socket.data.playerId, p.text) : { ok: false, code: "rate_limited", message: "You're chatting too fast." },
      )(),
    );

    socket.on("disconnect", () => {
      currentRoom()?.detach(socket.data.playerId, socket.id);
    });
  });

  return io;
}
