import { defineConfig } from "vitest/config";

/**
 * Concurrency suites run against real PostgreSQL, Redis and Kafka from
 * docker-compose.test.yml: a separate, disposable Compose project, so they never
 * touch development data. Files run one at a time because they share that stack.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/concurrency/**/*.test.ts"],
    setupFiles: ["tests/setup/integration-env.ts"],
    globalSetup: ["tests/setup/integration-global.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    restoreMocks: true,
  },
});
