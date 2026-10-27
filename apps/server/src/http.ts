import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { DEFAULT_SETTINGS, displayNameSchema, roomSettingsSchema } from "@riverroom/protocol";
import { playerFromCookie, sessionCookie, tokenFromCookieHeader } from "./auth.ts";
import type { Config } from "./config.ts";
import { errInfo, log } from "./log.ts";
import { RateLimiter } from "./ratelimit.ts";
import type { RoomManager } from "./rooms.ts";
import type { Store } from "./store.ts";

type Authed = Request & { player: { id: string; name: string } };

export function createHttpApp(config: Config, store: Store, rooms: RoomManager) {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);
  app.use(express.json({ limit: "16kb" }));

  // State-changing requests must come from this site (defence in depth on top of SameSite
  // cookies and JSON-only bodies): blocks login-CSRF against /api/session and /api/session/claim.
  app.use("/api", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const origin = req.headers.origin;
    if (!origin || config.allowedOrigins.includes(origin)) return next();
    try {
      if (new URL(origin).host === req.headers.host) return next();
    } catch {
      /* fall through */
    }
    res.status(403).json({ error: "Cross-site request refused." });
  });

  const sessionLimiter = new RateLimiter(20, 10 * 60_000);
  const createLimiter = new RateLimiter(10, 10 * 60_000);
  const linkLimiter = new RateLimiter(10, 10 * 60_000);

  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  const authed = (fn: (req: Authed, res: Response) => Promise<unknown>) =>
    wrap(async (req, res) => {
      const player = await playerFromCookie(store, req.headers.cookie);
      if (!player) return res.status(401).json({ error: "Your session has expired. Choose a name to continue." });
      (req as Authed).player = player;
      return fn(req as Authed, res);
    });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.get(
    "/api/me",
    wrap(async (req, res) => {
      const player = await playerFromCookie(store, req.headers.cookie);
      res.json({ player });
    }),
  );

  app.post(
    "/api/session",
    wrap(async (req, res) => {
      if (!sessionLimiter.allow(req.ip ?? "unknown")) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
      const parsed = z.object({ name: displayNameSchema }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid name." });
      const { name } = parsed.data;
      const existing = await playerFromCookie(store, req.headers.cookie);
      if (existing) {
        await store.renamePlayer(existing.id, name);
        return res.json({ player: { id: existing.id, name } });
      }
      const { playerId, token } = await store.createGuest(name);
      res.setHeader("Set-Cookie", sessionCookie(token, config.isProd));
      log.info("guest session created", { playerId });
      res.json({ player: { id: playerId, name } });
    }),
  );

  // Continue the same identity on another device: a single-use link valid for 15 minutes.
  app.post(
    "/api/session/link",
    authed(async (req, res) => {
      if (!linkLimiter.allow(req.player.id)) return res.status(429).json({ error: "Too many links. Try again in a few minutes." });
      res.json({ token: await store.createLoginLink(req.player.id) });
    }),
  );

  app.post(
    "/api/session/claim",
    wrap(async (req, res) => {
      if (!sessionLimiter.allow(req.ip ?? "unknown")) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
      const parsed = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "That link isn't valid." });
      const claimed = await store.claimLoginLink(parsed.data.token);
      if (!claimed) return res.status(410).json({ error: "That link has expired or was already used. Make a new one on your other device." });
      res.setHeader("Set-Cookie", sessionCookie(claimed.token, config.isProd));
      log.info("identity linked to new device", { playerId: claimed.player.id });
      res.json({ player: claimed.player });
    }),
  );

  app.post(
    "/api/rooms",
    authed(async (req, res) => {
      if (!createLimiter.allow(req.player.id)) return res.status(429).json({ error: "You're creating rooms too quickly. Try again shortly." });
      const parsed = z.object({ settings: roomSettingsSchema.optional() }).safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid settings." });
      const room = await rooms.create(req.player.id, parsed.data.settings ?? DEFAULT_SETTINGS);
      log.info("room created", { roomId: room.id, hostId: req.player.id });
      res.json({ code: room.data.code });
    }),
  );

  app.get(
    "/api/history",
    authed(async (req, res) => res.json({ sessions: await store.sessionsFor(req.player.id) })),
  );

  app.get(
    "/api/history/:roomId",
    authed(async (req, res) => {
      const roomId = String(req.params.roomId);
      if (!(await store.isMember(roomId, req.player.id))) return res.status(404).json({ error: "Session not found." });
      const session = (await store.sessionsFor(req.player.id)).find((s) => s.roomId === roomId);
      res.json({ session, hands: await store.handsFor(roomId) });
    }),
  );

  app.get(
    "/api/history/:roomId/hands/:handNo",
    authed(async (req, res) => {
      const roomId = String(req.params.roomId);
      const handNo = Number(req.params.handNo);
      if (!Number.isInteger(handNo) || handNo < 1) return res.status(400).json({ error: "Invalid hand number." });
      if (!(await store.isMember(roomId, req.player.id))) return res.status(404).json({ error: "Hand not found." });
      const hand = await store.handDetail(roomId, handNo, req.player.id);
      if (!hand) return res.status(404).json({ error: "Hand not found." });
      res.json(hand);
    }),
  );

  app.get(
    "/api/stats",
    authed(async (req, res) => res.json(await store.statsFor(req.player.id))),
  );

  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

  if (config.webDist) {
    const dist = config.webDist;
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    log.error("http request failed", { path: req.path, hasSession: Boolean(tokenFromCookieHeader(req.headers.cookie)), ...errInfo(err) });
    if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  return app;
}
