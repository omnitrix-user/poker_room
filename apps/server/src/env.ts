import { existsSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { readFileSync } from "node:fs";

/**
 * Loads `.env.local` and `.env` (for local development, e.g. the DATABASE_URL pulled by
 * `neon env pull`) from the current folder or the nearest parent that has them. Real
 * environment variables always win, and hosting platforms simply don't have these files.
 * Set RIVERROOM_NO_ENV_FILE=1 to skip this (the browser tests do, to use their own database).
 */
export function loadLocalEnv(env: NodeJS.ProcessEnv = process.env, start = process.cwd()): string[] {
  if (env.RIVERROOM_NO_ENV_FILE === "1") return [];
  const loaded: string[] = [];
  let dir = start;
  for (let depth = 0; depth < 4; depth++) {
    for (const name of [".env.local", ".env"]) {
      const file = path.join(dir, name);
      if (!existsSync(file)) continue;
      const values = parseEnv(readFileSync(file, "utf8"));
      for (const [key, value] of Object.entries(values)) if (env[key] === undefined) env[key] = value;
      loaded.push(file);
    }
    if (loaded.length) return loaded;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return loaded;
}
