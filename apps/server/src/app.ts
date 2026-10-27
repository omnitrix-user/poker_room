import { createServer } from "node:http";
import type { Config } from "./config.ts";
import { embeddedDb, migrate, postgresDb, type Db } from "./db.ts";
import { createHttpApp } from "./http.ts";
import { RoomManager } from "./rooms.ts";
import { attachSockets } from "./socket.ts";
import { Store } from "./store.ts";

export async function createRiverRoom(config: Config, db?: Db) {
  const database = db ?? (config.databaseUrl ? postgresDb(config.databaseUrl) : await embeddedDb(config.dataDir));
  if (!db && config.databaseUrl && config.migrationUrl && config.migrationUrl !== config.databaseUrl) {
    // Schema changes go over the direct connection; the game uses the pooled one.
    const direct = postgresDb(config.migrationUrl, 1);
    try {
      await migrate(direct);
    } finally {
      await direct.close();
    }
  } else {
    await migrate(database);
  }
  const store = new Store(database, config.secretKey);
  const rooms = new RoomManager(store, config);
  const restored = await rooms.restoreAll();
  const app = createHttpApp(config, store, rooms);
  const http = createServer(app);
  const io = attachSockets(http, store, rooms, config.allowedOrigins, config.sessionRecheckMs);

  return {
    http,
    io,
    rooms,
    store,
    restored,
    async close() {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await rooms.shutdown();
      if (!db) await database.close();
    },
  };
}
