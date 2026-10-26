import { vi } from "vitest";
import {
  TEST_DATABASE_URL,
  TEST_KAFKA_BROKERS,
  TEST_REDIS_DB,
  TEST_REDIS_HOST,
  TEST_REDIS_PORT,
} from "./integration-config.js";

// Point the application at isolated test infrastructure before src/config is imported.
Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_HOST: TEST_REDIS_HOST,
  REDIS_PORT: TEST_REDIS_PORT,
  REDIS_DB: TEST_REDIS_DB,
  KAFKA_BROKERS: TEST_KAFKA_BROKERS,
  JWT_SECRET: "vitest-only-jwt-secret-0123456789abcdef",
  ADMIN_API_KEY: "vitest-admin-key-0123456789",
  AUTH_DEMO_LOGIN: "true",
  RATE_LIMIT_MAX_REQUESTS: "100000",
  WEBHOOK_RATE_LIMIT_MAX_REQUESTS: "100000",
  RAZORPAY_KEY_ID: "",
  RAZORPAY_KEY_SECRET: "",
  RAZORPAY_WEBHOOK_SECRET: "",
  EVENT_LEASE_SECONDS: "60",
});

// Keep the real module (log context helpers); silence only the output
vi.mock("../../src/lib/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/logger.js")>()),
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
