import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4173);
// Point at an already-running deployment (e.g. the Docker container) instead of starting one.
const external = process.env.E2E_BASE_URL;
// Each run starts from an empty embedded database.
const dataDir = `.data/e2e-${Date.now()}`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 150_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: external ?? `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    // Optional: reuse an already-installed Chromium instead of `npx playwright install chromium`.
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: external
    ? undefined
    : {
    // Runs the production build: `npm run build` first.
    command: "node apps/server/dist/server.js",
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    env: {
      PORT: String(port),
      WEB_DIST: "apps/web/dist",
      DATA_DIR: `${dataDir}/pglite`,
      RECONNECT_GRACE_SECONDS: "20",
      HAND_PAUSE_MS: "800",
      SHOWDOWN_PAUSE_MS: "500",
      FINAL_VOTE_SECONDS: "20",
      LOG_LEVEL: "silent",
      // Use the throwaway embedded database, never the one in .env.local.
      RIVERROOM_NO_ENV_FILE: "1",
    },
  },
});
