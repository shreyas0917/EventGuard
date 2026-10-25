import { Server } from "http";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { closeDatabase } from "../lib/database.js";
import { getRedis, closeRedis } from "../lib/redis.js";
import { disconnectProducer } from "../kafka/producer.js";
import { stopRetryWorker } from "../workers/retryWorker.js";
import { stopOutboxWorker } from "../workers/outboxWorker.js";

/**
 * Graceful shutdown handler
 * Ensures clean termination of resources on SIGTERM/SIGINT
 */
export function setupGracefulShutdown(server: Server): void {
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      logger.warn(`[Shutdown] Already shutting down, ignoring ${signal}`);
      return;
    }

    isShuttingDown = true;
    logger.info(`[Shutdown] Received ${signal}, starting graceful shutdown...`);

    // Safety timeout: force exit after 10s if connections fail to drain
    const forceTimeout = setTimeout(() => {
      logger.error("[Shutdown] Force exit after 10s timeout");
      process.exit(1);
    }, 10000);
    forceTimeout.unref();

    // Step 1: Stop accepting new requests and wait for pending requests to finish
    logger.info("[Shutdown] Stopping new request acceptance...");
    await new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) {
          logger.error("[Shutdown] Error closing HTTP server", err);
        } else {
          logger.info("[Shutdown] HTTP server closed");
        }
        resolve();
      });
    });

    // Step 2: Stop workers
    logger.info("[Shutdown] Stopping workers...");
    try {
      await stopRetryWorker();
      logger.info("[Shutdown] Retry worker stopped");
    } catch (error) {
      logger.error("[Shutdown] Error stopping retry worker", error);
    }

    try {
      await stopOutboxWorker();
      logger.info("[Shutdown] Outbox worker stopped");
    } catch (error) {
      logger.error("[Shutdown] Error stopping outbox worker", error);
    }

    // Step 3: Disconnect Kafka Producer
    logger.info("[Shutdown] Disconnecting Kafka producer...");
    try {
      await disconnectProducer();
      logger.info("[Shutdown] Kafka producer disconnected");
    } catch (error) {
      logger.error("[Shutdown] Error disconnecting Kafka producer", error);
    }

    // Step 4: Close Redis
    logger.info("[Shutdown] Closing Redis connection...");
    try {
      await closeRedis();
      logger.info("[Shutdown] Redis connection closed");
    } catch (error) {
      logger.error("[Shutdown] Error closing Redis", error);
    }

    // Step 5: Close PostgreSQL connections (Prisma and pg Pool)
    logger.info("[Shutdown] Closing PostgreSQL connections...");
    try {
      await prisma.$disconnect();
      logger.info("[Shutdown] Prisma disconnected");
    } catch (error) {
      logger.error("[Shutdown] Error closing Prisma", error);
    }

    try {
      await closeDatabase();
      logger.info("[Shutdown] PostgreSQL pool closed");
    } catch (error) {
      logger.error("[Shutdown] Error closing PostgreSQL pool", error);
    }

    logger.info("[Shutdown] Graceful shutdown complete");
    process.exit(0);
  };

  // Handle signals
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    logger.error("[Fatal] Uncaught exception", error);
    shutdown("uncaughtException").catch(() => process.exit(1));
  });

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason, promise) => {
    logger.error("[Fatal] Unhandled rejection", { reason, promise });
    shutdown("unhandledRejection").catch(() => process.exit(1));
  });
}