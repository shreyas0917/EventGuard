import { createApp } from "./app.js";
import { config, validateConfig } from "./config/index.js";
import { enforceEnvironmentValidation } from "./config/validateEnv.js";
import { connectDatabase, closeDatabase } from "./lib/database.js";
import { connectRedis, closeRedis } from "./lib/redis.js";
import { connectKafka, closeKafka } from "./lib/kafka.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { startOutboxWorker, stopOutboxWorker } from "./workers/outboxWorker.js";
import { startRetryWorker, stopRetryWorker } from "./workers/retryWorker.js";
import { startReconciliationWorker } from "./workers/reconciliationWorker.js";
import { registerStateGauges } from "./lib/metrics.js";
import { stateProbes } from "./services/metricsProbes.js";
import { initializeProducer, disconnectProducer } from "./kafka/producer.js";
import { ensureTopicExists } from "./kafka/topicSetup.js";
import { initializeRazorpay, isRazorpayConfigured } from "./lib/razorpay.js";
import { setupGracefulShutdown } from "./lib/gracefulShutdown.js";

async function startup() {
  try {
    logger.info("🚀 EventGuard API Starting...");

    // Phase 10: Validate environment variables
    enforceEnvironmentValidation();
    validateConfig();
    logger.info("✓ Configuration validated");

    const dbConnected = await connectDatabase();
    if (!dbConnected) {
      throw new Error("Failed to connect to database");
    }

    // Test Prisma connection
    await prisma.$queryRaw`SELECT NOW()`;
    logger.info("✓ PostgreSQL connected");

    const redisConnected = await connectRedis();
    if (!redisConnected) {
      throw new Error("Failed to connect to Redis");
    }
    logger.info("✓ Redis connected");

    const kafkaConnected = await connectKafka();
    if (!kafkaConnected) {
      throw new Error("Failed to connect to Kafka");
    }
    logger.info("✓ Kafka connected");

    // Ensure Kafka topic exists
    await ensureTopicExists();

    // Initialize Kafka producer for outbox publishing
    await initializeProducer();
    logger.info("✓ Kafka producer initialized");

    // Initialize Razorpay
    initializeRazorpay();
    if (isRazorpayConfigured()) {
      logger.info("✓ Razorpay initialized (TEST MODE)");
    } else {
      logger.info("ℹ Razorpay not configured (webhook integration disabled)");
    }

    const app = createApp();

    // Start outbox worker (enabled now that Kafka producer is ready)
    startOutboxWorker({
      intervalMs: parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || "500", 10),
      batchSize: parseInt(process.env.OUTBOX_BATCH_SIZE || "50", 10),
      enabled: true,
    });
    logger.info("✓ Outbox worker started");

    // Start retry worker for Phase 7
    startRetryWorker(config.retry_poll_interval_ms);
    logger.info("✓ Retry worker started");

    startReconciliationWorker(config.reconciliation_interval_ms);

    // Backlog, DLQ, consumer lag and reconciliation gauges are reported by the API only
    registerStateGauges(stateProbes);

    const server = app.listen(config.backend_port, () => {
      logger.info(
        `✅ EventGuard API running on http://localhost:${config.backend_port}`
      );
      logger.info(`📊 Health check: http://localhost:${config.backend_port}/health`);
      logger.info(`📋 Readiness check: http://localhost:${config.backend_port}/health/ready`);
    });

    // Phase 10: Setup graceful shutdown
    setupGracefulShutdown(server);
  } catch (error) {
    logger.error("❌ Startup failed", error);
    process.exit(1);
  }
}

startup();
