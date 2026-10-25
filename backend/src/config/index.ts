import dotenv from "dotenv";

dotenv.config();

export const config = {
  node_env: process.env.NODE_ENV || "development",
  backend_port: parseInt(process.env.BACKEND_PORT || "3001", 10),

  database_url: process.env.DATABASE_URL || "",

  redis_host: process.env.REDIS_HOST || "localhost",
  redis_port: parseInt(process.env.REDIS_PORT || "6379", 10),

  kafka_brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),

  // Phase 5: Idempotency and Redis configuration
  redis_lock_ttl_seconds: parseInt(process.env.REDIS_LOCK_TTL_SECONDS || "30", 10),
  redis_completed_ttl_seconds: parseInt(
    process.env.REDIS_COMPLETED_TTL_SECONDS || "86400",
    10
  ),
  processing_delay_ms: parseInt(process.env.PROCESSING_DELAY_MS || "0", 10),

  // Phase 6: Razorpay configuration
  razorpay_key_id: process.env.RAZORPAY_KEY_ID || "",
  razorpay_key_secret: process.env.RAZORPAY_KEY_SECRET || "",
  razorpay_webhook_secret: process.env.RAZORPAY_WEBHOOK_SECRET || "",

  // Phase 7: Retry configuration
  max_event_attempts: parseInt(process.env.MAX_EVENT_ATTEMPTS || "3", 10),
  retry_base_delay_ms: parseInt(process.env.RETRY_BASE_DELAY_MS || "1000", 10),
  max_retry_delay_ms: parseInt(process.env.MAX_RETRY_DELAY_MS || "30000", 10),
  retry_poll_interval_ms: parseInt(process.env.RETRY_POLL_INTERVAL_MS || "2000", 10),

  // Phase 7: Test configuration
  fail_processing_for_event_id: process.env.FAIL_PROCESSING_FOR_EVENT_ID || "",

  // Phase 10: Rate limiting
  rate_limit_window_ms: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10),
  rate_limit_max_requests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100", 10),

  // Phase 10: CORS
  cors_origin: process.env.CORS_ORIGIN || "http://localhost:5173",
};

export function validateConfig() {
  if (!config.database_url) {
    throw new Error("DATABASE_URL environment variable is required");
  }
}
