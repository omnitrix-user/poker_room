// Runs the game server (port API_PORT, default 3001) and the Vite dev server
// (port PORT, default 5173) together. Ctrl+C stops both.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = process.env.API_PORT ?? "3001";
const webPort = process.env.PORT ?? "5173";

const procs = [
  {
    name: "server",
    args: ["run", "dev", "-w", "@riverroom/server"],
    env: { ...process.env, PORT: apiPort, DATA_DIR: process.env.DATA_DIR ?? path.join(root, ".data/pglite") },
  },
  {
    name: "web",
    args: ["run", "dev", "-w", "@riverroom/web", "--", "--port", webPort, "--strictPort"],
    env: { ...process.env, API_ORIGIN: `http://localhost:${apiPort}` },
  },
].map(({ name, args, env }) => {
  const p = spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"], env, cwd: root });
  const tag = name === "server" ? "\x1b[33mserver\x1b[0m" : "\x1b[36m   web\x1b[0m";
  const pipe = (stream, out) =>
    stream.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => out.write(`${tag} │ ${l}\n`)));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on("exit", (code) => {
    console.log(`${name} exited (${code})`);
    shutdown();
  });
  return p;
});

let done = false;
function shutdown() {
  if (done) return;
  done = true;
  for (const p of procs) p.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
