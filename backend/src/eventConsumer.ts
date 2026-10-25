import { config, validateConfig } from "./config/index.js";
import { enforceEnvironmentValidation } from "./config/validateEnv.js";
import { connectDatabase } from "./lib/database.js";
import { connectRedis } from "./lib/redis.js";
import { connectKafka } from "./lib/kafka.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { startEventConsumer, stopEventConsumer } from "./workers/eventConsumerWorker.js";

async function startup() {
  try {
    enforceEnvironmentValidation();
    validateConfig();
    logger.info("[Consumer] Configuration validated");

    const dbConnected = await connectDatabase();
    if (!dbConnected) {
      throw new Error("Failed to connect to database");
    }

    // Test Prisma connection
    await prisma.$queryRaw`SELECT NOW()`;
    logger.info("[Consumer] Database connected");

    const redisConnected = await connectRedis();
    if (!redisConnected) {
      throw new Error("Failed to connect to Redis");
    }

    const kafkaConnected = await connectKafka();
    if (!kafkaConnected) {
      throw new Error("Failed to connect to Kafka");
    }

    logger.info("[Consumer] All connections established");

    // Start event consumer
    await startEventConsumer();

    const gracefulShutdown = async () => {
      logger.info("[Consumer] Graceful shutdown initiated");
      await stopEventConsumer();
      await prisma.$disconnect();
      process.exit(0);
    };

    process.on("SIGINT", gracefulShutdown);
    process.on("SIGTERM", gracefulShutdown);
  } catch (error) {
    logger.error("[Consumer] Startup failed", error);
    process.exit(1);
  }
}

startup();
