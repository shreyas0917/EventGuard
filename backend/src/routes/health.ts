import { Router } from "express";
import { getDatabase } from "../lib/database.js";
import { getRedis } from "../lib/redis.js";
import { getKafka } from "../lib/kafka.js";

const router = Router();

router.get("/", async (req, res) => {
  res.json({
    status: "ok",
    service: "eventguard-api",
    timestamp: new Date().toISOString(),
  });
});

router.get("/database", async (req, res) => {
  try {
    const db = getDatabase();
    await db.query("SELECT NOW()");
    res.json({
      status: "ok",
      service: "database",
      message: "PostgreSQL is healthy",
    });
  } catch (error) {
    res.status(503).json({
      status: "error",
      service: "database",
      message:
        error instanceof Error ? error.message : "Database is unavailable",
    });
  }
});

router.get("/redis", async (req, res) => {
  try {
    const redis = getRedis();
    await redis.ping();
    res.json({
      status: "ok",
      service: "redis",
      message: "Redis is healthy",
    });
  } catch (error) {
    res.status(503).json({
      status: "error",
      service: "redis",
      message: error instanceof Error ? error.message : "Redis is unavailable",
    });
  }
});

router.get("/kafka", async (req, res) => {
  try {
    const kafka = getKafka();
    const admin = kafka.admin();
    await admin.connect();
    await admin.disconnect();
    res.json({
      status: "ok",
      service: "kafka",
      message: "Kafka is healthy",
    });
  } catch (error) {
    res.status(503).json({
      status: "error",
      service: "kafka",
      message: error instanceof Error ? error.message : "Kafka is unavailable",
    });
  }
});

export default router;
