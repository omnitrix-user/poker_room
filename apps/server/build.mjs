// Bundles the server and the workspace packages it imports into one ESM file.
// Third-party dependencies stay external and are installed with `npm ci --omit=dev`.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith("@riverroom/"));

await build({
  entryPoints: [fileURLToPath(new URL("./src/main.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./dist/server.js", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external,
  logLevel: "info",
});
