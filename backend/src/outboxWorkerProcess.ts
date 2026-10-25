import { config, validateConfig } from "./config/index.js";
import { enforceEnvironmentValidation } from "./config/validateEnv.js";
import { connectDatabase } from "./lib/database.js";
import { connectRedis } from "./lib/redis.js";
import { connectKafka } from "./lib/kafka.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { startOutboxWorker, stopOutboxWorker } from "./workers/outboxWorker.js";
import { initializeProducer, disconnectProducer } from "./kafka/producer.js";
import { ensureTopicExists } from "./kafka/topicSetup.js";

async function startup() {
  try {
    enforceEnvironmentValidation();
    validateConfig();
    logger.info("[Outbox Worker] Configuration validated");

    const dbConnected = await connectDatabase();
    if (!dbConnected) {
      throw new Error("Failed to connect to database");
    }

    // Test Prisma connection
    await prisma.$queryRaw`SELECT NOW()`;
    logger.info("[Outbox Worker] Database connected");

    const redisConnected = await connectRedis();
    if (!redisConnected) {
      throw new Error("Failed to connect to Redis");
    }

    const kafkaConnected = await connectKafka();
    if (!kafkaConnected) {
      throw new Error("Failed to connect to Kafka");
    }

    // Ensure Kafka topic exists
    await ensureTopicExists();

    // Initialize Kafka producer
    await initializeProducer();
    logger.info("[Outbox Worker] Kafka producer initialized");

    // Start outbox worker
    startOutboxWorker({
      intervalMs: parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || "2000", 10),
      batchSize: parseInt(process.env.OUTBOX_BATCH_SIZE || "10", 10),
      enabled: true,
    });

    const gracefulShutdown = async () => {
      logger.info("[Outbox Worker] Graceful shutdown initiated");
      stopOutboxWorker();
      await disconnectProducer();
      await prisma.$disconnect();
      process.exit(0);
    };

    process.on("SIGINT", gracefulShutdown);
    process.on("SIGTERM", gracefulShutdown);
  } catch (error) {
    logger.error("[Outbox Worker] Startup failed", error);
    process.exit(1);
  }
}

startup();
