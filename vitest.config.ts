import { defineConfig } from "vitest/config";

// Server tests run in Node against a real Postgres database (TEND247_TEST_DB_OWNER_URL /
// TEND247_TEST_DB_APP_URL). The app is built from plain modules with injected dependencies,
// so the same code runs in the Worker and here.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/setup/global-setup.ts"],
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
