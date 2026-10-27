import { loadLocalEnv } from "./env.ts";
import { createRiverRoom } from "./app.ts";
import { loadConfig } from "./config.ts";
import path from "node:path";
import { errInfo, log } from "./log.ts";

const envFiles = loadLocalEnv();
const config = loadConfig();
const server = await createRiverRoom(config);
server.http.listen(config.port, () => {
  log.info("RiverRoom server listening", {
    port: config.port,
    database: config.databaseUrl ? `postgres (${new URL(config.databaseUrl).hostname})` : `embedded (${config.dataDir ?? "memory"})`,
    envFiles: envFiles.map((f) => path.basename(f)),
    restoredRooms: server.restored,
  });
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  try {
    await server.close();
  } catch (err) {
    log.error("shutdown error", errInfo(err));
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
