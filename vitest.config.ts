import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/server/test/**/*.test.ts"],
    // Generous limits: the fuzzer and the embedded-database startup are CPU-bound, and the
    // suite should pass on a slow or busy machine too. Assertions are unaffected.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
