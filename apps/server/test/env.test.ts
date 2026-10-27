import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadLocalEnv } from "../src/env.ts";

describe("local env files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rr-env-"));
  writeFileSync(path.join(root, ".env.local"), 'DATABASE_URL="postgres://file/db"\nAPP_SECRET=from-file\n');
  const nested = path.join(root, "apps", "server");
  mkdirSync(nested, { recursive: true });

  it("loads .env.local from a parent folder without overriding real variables", () => {
    const env: NodeJS.ProcessEnv = { APP_SECRET: "from-environment" };
    expect(loadLocalEnv(env, nested)).toEqual([path.join(root, ".env.local")]);
    expect(env.DATABASE_URL).toBe("postgres://file/db");
    expect(env.APP_SECRET).toBe("from-environment");
  });

  it("can be switched off", () => {
    const env: NodeJS.ProcessEnv = { RIVERROOM_NO_ENV_FILE: "1" };
    expect(loadLocalEnv(env, nested)).toEqual([]);
    expect(env.DATABASE_URL).toBeUndefined();
  });
});

describe("development secret", () => {
  it("is the same across restarts even when using an online database", async () => {
    const { loadConfig } = await import("../src/config.ts");
    const dir = mkdtempSync(path.join(tmpdir(), "rr-secret-"));
    const env = { DATABASE_URL: "postgres://example/db", DATA_DIR: path.join(dir, "pglite") };
    const first = loadConfig({ ...env }).secretKey.toString("hex");
    const second = loadConfig({ ...env }).secretKey.toString("hex");
    expect(second).toBe(first);
    expect(() => loadConfig({ ...env, NODE_ENV: "production" })).toThrow(/APP_SECRET/);
  });
});
