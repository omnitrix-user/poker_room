/**
 * Exercises the `pg` driver path (used in production when DATABASE_URL is set) over the
 * real Postgres wire protocol, served by PGlite's socket server since no Postgres server
 * is available in CI/dev by default.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, postgresDb, type Db } from "../src/db.ts";
import { act, actor, expectOk, startedTable, startServer, testConfig } from "./harness.ts";

let pglite: PGlite;
let wire: PGLiteSocketServer;
let db: Db;
const port = 54000 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  pglite = await PGlite.create();
  wire = new PGLiteSocketServer({ db: pglite, port, host: "127.0.0.1" });
  await wire.start();
  db = postgresDb(`postgres://postgres@127.0.0.1:${port}/postgres`, 1);
});

afterAll(async () => {
  await db.close();
  await wire.stop();
  await pglite.close();
});

describe("pg driver", () => {
  it("migrates idempotently and rolls back failed transactions", async () => {
    await migrate(db);
    await migrate(db);
    await expect(
      db.tx(async (q) => {
        await q.query(`INSERT INTO players (id, display_name) VALUES ('x', 'X')`);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db.query(`SELECT id FROM players WHERE id = 'x'`)).toEqual([]);
  });

  it("runs a full hand against the pg driver and persists it", async () => {
    const server = await startServer({ db, config: testConfig({ databaseUrl: "postgres://via-test" }) });
    try {
      const { players } = await startedTable(server, ["P", "Q"]);
      expectOk(await act(actor(players), { type: "fold" }));
      const stats = await players[0]!.api<{ handsPlayed: number }>("/api/stats");
      expect(stats.body.handsPlayed).toBe(1);
      const rows = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM hand_events`);
      expect(rows[0]!.n).toBeGreaterThanOrEqual(3);
    } finally {
      await server.stop();
    }
  });
});
