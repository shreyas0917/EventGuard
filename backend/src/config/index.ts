import dotenv from "dotenv";

dotenv.config();

export const config = {
  node_env: process.env.NODE_ENV || "development",
  backend_port: parseInt(process.env.BACKEND_PORT || "3001", 10),

  database_url: process.env.DATABASE_URL || "",

  redis_host: process.env.REDIS_HOST || "localhost",
  redis_port: parseInt(process.env.REDIS_PORT || "6379", 10),
  redis_db: parseInt(process.env.REDIS_DB || "0", 10),

  kafka_brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
  kafka_topic: process.env.KAFKA_TOPIC || "eventguard.events",
  kafka_consumer_group: process.env.KAFKA_CONSUMER_GROUP || "eventguard-workers",

  // Phase 5: Idempotency and Redis configuration
  redis_lock_ttl_seconds: parseInt(process.env.REDIS_LOCK_TTL_SECONDS || "30", 10),
  redis_completed_ttl_seconds: parseInt(
    process.env.REDIS_COMPLETED_TTL_SECONDS || "86400",
    10
  ),
  processing_delay_ms: parseInt(process.env.PROCESSING_DELAY_MS || "0", 10),
  // How long a PROCESSING claim is honoured before another worker may take it over.
  // Must comfortably exceed the time one event takes to process.
  event_lease_seconds: parseInt(process.env.EVENT_LEASE_SECONDS || "60", 10),

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
  webhook_rate_limit_max_requests: parseInt(process.env.WEBHOOK_RATE_LIMIT_MAX_REQUESTS || "600", 10),

  // Phase 10: CORS
  cors_origin: process.env.CORS_ORIGIN || "http://localhost:5173",

  // Authentication: HS256 JWT bearer tokens with a "user" or "admin" role
  jwt_secret: process.env.JWT_SECRET || "",
  jwt_issuer: process.env.JWT_ISSUER || "eventguard",
  jwt_audience: process.env.JWT_AUDIENCE || "eventguard-api",
  jwt_ttl_seconds: parseInt(process.env.JWT_TTL_SECONDS || "3600", 10),
  // Demo login issues tokens without a user store; on by default only outside production
  auth_demo_login_enabled:
    (process.env.AUTH_DEMO_LOGIN ??
      (process.env.NODE_ENV === "production" ? "false" : "true")) === "true",
  // Shared secret that demo login requires before it will issue an admin token
  admin_api_key: process.env.ADMIN_API_KEY || "",
};

/** Publicly known secrets (docker-compose dev default, .env.example placeholder); rejected in production. */
export const KNOWN_JWT_SECRETS = [
  "dev-only-insecure-jwt-secret-change-me-0000",
  "replace-with-at-least-32-random-characters",
];

export function validateConfig() {
  if (!config.database_url) {
    throw new Error("DATABASE_URL environment variable is required");
  }
}
