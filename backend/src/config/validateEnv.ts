import { config } from "./index.js";
import { logger } from "../lib/logger.js";

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate required environment variables on startup
 */
export function validateEnvironment(): ValidationResult {
  const errors: string[] = [];

  // Core infrastructure
  if (!config.database_url) {
    errors.push("DATABASE_URL is required");
  }

  if (!config.redis_host) {
    errors.push("REDIS_HOST is required");
  }

  if (!config.kafka_brokers || config.kafka_brokers.length === 0) {
    errors.push("KAFKA_BROKERS is required");
  }

  // Razorpay credentials (only validate if webhook secret is set, indicating intent to use)
  const razorpayEnabled =
    config.razorpay_key_id ||
    config.razorpay_key_secret ||
    config.razorpay_webhook_secret;

  if (razorpayEnabled) {
    if (!config.razorpay_key_id) {
      errors.push("RAZORPAY_KEY_ID is required when Razorpay is enabled");
    }
    if (!config.razorpay_key_secret) {
      errors.push("RAZORPAY_KEY_SECRET is required when Razorpay is enabled");
    }
    if (!config.razorpay_webhook_secret) {
      errors.push("RAZORPAY_WEBHOOK_SECRET is required when Razorpay is enabled");
    }
  }

  // Validate port numbers
  if (isNaN(config.backend_port) || config.backend_port < 1 || config.backend_port > 65535) {
    errors.push("BACKEND_PORT must be a valid port number (1-65535)");
  }

  if (isNaN(config.redis_port) || config.redis_port < 1 || config.redis_port > 65535) {
    errors.push("REDIS_PORT must be a valid port number (1-65535)");
  }

  // Validate retry configuration
  if (config.max_event_attempts < 1) {
    errors.push("MAX_EVENT_ATTEMPTS must be at least 1");
  }

  if (config.retry_base_delay_ms < 100) {
    errors.push("RETRY_BASE_DELAY_MS must be at least 100ms");
  }

  if (config.max_retry_delay_ms < config.retry_base_delay_ms) {
    errors.push("MAX_RETRY_DELAY_MS must be >= RETRY_BASE_DELAY_MS");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Log validation errors and exit if invalid
 */
export function enforceEnvironmentValidation(): void {
  const result = validateEnvironment();

  if (!result.valid) {
    logger.error("❌ Environment validation failed:");
    result.errors.forEach((error) => {
      logger.error(`  - ${error}`);
    });
    logger.error("\nPlease check your .env file and ensure all required variables are set.");
    process.exit(1);
  }

  logger.info("✓ Environment validation passed");
}