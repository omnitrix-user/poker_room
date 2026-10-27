import { createRiverRoom } from "./app.ts";
import { loadConfig } from "./config.ts";
import { errInfo, log } from "./log.ts";

const config = loadConfig();
const server = await createRiverRoom(config);
server.http.listen(config.port, () => {
  log.info("RiverRoom server listening", {
    port: config.port,
    database: config.databaseUrl ? "postgres" : `embedded (${config.dataDir ?? "memory"})`,
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
