import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Config {
  port: number;
  isProd: boolean;
  /** Postgres connection string. When unset, an embedded Postgres (PGlite) is used. */
  databaseUrl: string | undefined;
  /** Direct (non-pooled) connection for schema migrations, if the provider offers one. */
  migrationUrl: string | undefined;
  /** Directory for the embedded database; undefined = in-memory. */
  dataDir: string | undefined;
  /** 32-byte key used to encrypt live-room snapshots and stored hole cards. */
  secretKey: Buffer;
  reconnectGraceMs: number;
  handPauseMs: number;
  /** Extra pause after an all-in runout, so clients can reveal it street by street. */
  runoutPauseMs: number;
  /** Extra pause after a regular showdown. */
  showdownPauseMs: number;
  /** After the final round, how long players have to call an extension vote. */
  finalVoteWindowMs: number;
  /** How long an extension vote stays open. */
  voteMs: number;
  /** Where the built web app lives; served by the same process in production. */
  webDist: string | undefined;
  trustProxy: boolean;
  /** Extra origins allowed to open sockets (only needed if the web app is hosted elsewhere). */
  allowedOrigins: string[];
}

export function loadConfig(env = process.env): Config {
  const isProd = env.NODE_ENV === "production";
  const dataDir = env.DATABASE_URL ? undefined : path.resolve(env.DATA_DIR ?? ".data/pglite");
  return {
    port: Number(env.PORT ?? 3001),
    isProd,
    databaseUrl: env.DATABASE_URL || undefined,
    migrationUrl: env.DATABASE_URL_UNPOOLED || env.DATABASE_URL || undefined,
    dataDir,
    // Development keeps its key under DATA_DIR's parent (or ./.data), also when DATABASE_URL is
    // set, so saved games can still be decrypted after a restart.
    secretKey: resolveSecret(env.APP_SECRET, isProd, path.resolve(env.DATA_DIR ?? ".data/pglite")),
    reconnectGraceMs: Number(env.RECONNECT_GRACE_SECONDS ?? 30) * 1000,
    handPauseMs: Number(env.HAND_PAUSE_MS ?? 5000),
    runoutPauseMs: Number(env.RUNOUT_PAUSE_MS ?? 6000),
    showdownPauseMs: Number(env.SHOWDOWN_PAUSE_MS ?? 2500),
    finalVoteWindowMs: Number(env.FINAL_VOTE_SECONDS ?? 20) * 1000,
    voteMs: Number(env.VOTE_SECONDS ?? 45) * 1000,
    webDist: env.WEB_DIST ? path.resolve(env.WEB_DIST) : isProd ? path.resolve("apps/web/dist") : undefined,
    trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

function resolveSecret(value: string | undefined, isProd: boolean, dataDir: string): Buffer {
  if (value) {
    if (value.length < 32) throw new Error("APP_SECRET must be at least 32 characters");
    return createHash("sha256").update(value).digest();
  }
  if (isProd) throw new Error("APP_SECRET is required in production");
  // Development: persist a random key locally so restarts can decrypt snapshots.
  const file = path.join(path.dirname(dataDir), "dev-secret");
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
}
