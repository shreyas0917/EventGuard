import { config, validateConfig } from "./config/index.js";
import { enforceEnvironmentValidation } from "./config/validateEnv.js";
import { connectDatabase } from "./lib/database.js";
import { connectRedis } from "./lib/redis.js";
import { connectKafka } from "./lib/kafka.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { startEventConsumer, stopEventConsumer, isEventConsumerRunning } from "./workers/eventConsumerWorker.js";
import { registry } from "./lib/metrics.js";
import { ensureTopicExists } from "./kafka/topicSetup.js";
import http from "http";

/** Minimal HTTP server so the consumer process can be scraped and health-checked. */
function startMetricsServer(port: number): http.Server {
  return http
    .createServer(async (req, res) => {
      if (req.url === "/metrics") {
        res.writeHead(200, { "Content-Type": registry.contentType });
        res.end(await registry.metrics());
      } else if (req.url === "/health") {
        const running = isEventConsumerRunning();
        res.writeHead(running ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: running ? "ok" : "stopped", service: "eventguard-consumer" }));
      } else {
        res.writeHead(404).end();
      }
    })
    .listen(port, () => logger.info(`[Consumer] Metrics and health on :${port}`));
}

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

    // The API process creates the topic too, but both processes start at once: without
    // this the consumer can subscribe first and crash with "This server does not host
    // this topic". Creating it is idempotent.
    await ensureTopicExists();

    // Start event consumer
    await startEventConsumer();
    const metricsServer = startMetricsServer(config.consumer_metrics_port);

    const gracefulShutdown = async () => {
      logger.info("[Consumer] Graceful shutdown initiated");
      await stopEventConsumer();
      metricsServer.close();
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
