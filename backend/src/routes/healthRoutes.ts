import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { getRedis } from "../lib/redis.js";
import { getKafka } from "../lib/kafka.js";
import { logger } from "../lib/logger.js";

const router = Router();

/**
 * GET /health
 * Quick liveness check - is the API process alive?
 */
router.get("/", (req: Request, res: Response) => {
  res.json({
    success: true,
    status: "alive",
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /health/ready
 * Readiness check - are dependencies available?
 */
router.get("/ready", async (req: Request, res: Response) => {
  try {
    const checks: { [key: string]: boolean } = {
      api: true,
    };

    // Check PostgreSQL
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgresql = true;
    } catch (error) {
      logger.error("[Health] PostgreSQL check failed", error);
      checks.postgresql = false;
    }

    // Check Redis
    try {
      const redis = getRedis();
      await redis.ping();
      checks.redis = true;
    } catch (error) {
      logger.error("[Health] Redis check failed", error);
      checks.redis = false;
    }

    // Check Kafka
    try {
      const kafka = getKafka();
      const admin = kafka.admin();
      await admin.connect();
      await admin.listTopics();
      await admin.disconnect();
      checks.kafka = true;
    } catch (error) {
      logger.error("[Health] Kafka check failed", error);
      checks.kafka = false;
    }

    const allHealthy = Object.values(checks).every((v) => v === true);

    res.status(allHealthy ? 200 : 503).json({
      success: allHealthy,
      status: allHealthy ? "ready" : "not_ready",
      checks,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("[Health] Readiness check failed", error);
    res.status(503).json({
      success: false,
      status: "error",
      checks: { api: false, postgresql: false, redis: false, kafka: false },
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;