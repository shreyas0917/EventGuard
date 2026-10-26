import { vi } from "vitest";

// Hermetic configuration for in-process tests. Set before src/config is imported;
// dotenv never overrides keys that already exist, so a local backend/.env is ignored.
Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
  REDIS_HOST: "127.0.0.1",
  KAFKA_BROKERS: "127.0.0.1:1",
  JWT_SECRET: "vitest-only-jwt-secret-0123456789abcdef",
  ADMIN_API_KEY: "vitest-admin-key-0123456789",
  AUTH_DEMO_LOGIN: "true",
  RATE_LIMIT_MAX_REQUESTS: "100000",
  RAZORPAY_KEY_ID: "",
  RAZORPAY_KEY_SECRET: "",
  RAZORPAY_WEBHOOK_SECRET: "",
});

// Keep test output readable; assertions are made on HTTP responses, not log lines.
// The real module stays (log context helpers); only the output is silenced.
vi.mock("../../src/lib/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/logger.js")>()),
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
