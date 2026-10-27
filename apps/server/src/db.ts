import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { log } from "./log.ts";
import { MIGRATIONS } from "./migrations.ts";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Runs `fn` in a single transaction; rolls back if it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres via `pg` when DATABASE_URL is set. */
/**
 * `sslmode=require` (what Neon and most hosts hand out) is treated by today's `pg` as full
 * certificate verification, but will mean "encrypt without verifying" in pg v9. Pin the
 * stronger behaviour explicitly so an upgrade can't silently weaken it.
 */
export function strictSsl(url: string): string {
  return url.replace(/([?&]sslmode=)(require|prefer|verify-ca)(?=&|$)/, "$1verify-full");
}

export function postgresDb(rawUrl: string, maxConnections = Number(process.env.PG_POOL_MAX ?? 10)): Db {
  const url = strictSsl(rawUrl);
  // TLS follows the connection string (`sslmode=require` verifies the server certificate;
  // use `sslmode=no-verify` for providers with self-signed certificates).
  const pool = new pg.Pool({
    connectionString: url,
    max: maxConnections,
    // Release idle connections before serverless Postgres (e.g. Neon) suspends and drops them.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
  });
  // An idle connection closed by the server (Neon scale-to-zero, a restart) must not crash the
  // process; the pool simply opens a fresh connection on the next query.
  pool.on("error", (err) => log.warn("idle database connection closed", { error: err.message }));
  // Return bigint/numeric aggregates as JS numbers; chip totals stay far below 2^53.
  pg.types.setTypeParser(20, (v) => Number(v));
  return {
    async query(sql, params) {
      return (await pool.query(sql, params as unknown[])).rows;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({ query: async (sql, params) => (await client.query(sql, params as unknown[])).rows });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Embedded Postgres (PGlite). `dataDir` undefined means in-memory. */
export async function embeddedDb(dataDir?: string): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const db = new PGlite(dataDir);
  await db.waitReady;
  // PGlite runs one statement at a time; serialize transactions explicitly so that
  // a query issued outside a transaction cannot interleave with one in progress.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  return {
    query: (sql, params) => exclusive(async () => (await db.query(sql, params)).rows as never),
    tx: (fn) =>
      exclusive(() => db.transaction((t) => fn({ query: async (sql, params) => (await t.query(sql, params)).rows as never }))),
    close: () => db.close(),
  };
}

export async function migrate(db: Db): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ id: number }>(`SELECT id FROM schema_migrations`)).map((r) => r.id));
  for (const [i, sql] of MIGRATIONS.entries()) {
    const id = i + 1;
    if (done.has(id)) continue;
    await db.tx(async (q) => {
      for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await q.query(stmt);
      await q.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [id]);
    });
  }
}
