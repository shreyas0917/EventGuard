import Redis from "ioredis";
import { config } from "../config/index.js";
import { logger } from "./logger.js";

let redisInstance: Redis | null = null;

function waitForReady(client: Redis, timeoutMs: number = 10000): Promise<void> {
  if (client.status === "ready") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis ready timeout after ${timeoutMs}ms (status=${client.status})`));
    }, timeoutMs);

    const onReady = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      // Ignore transient connection errors while waiting for ready;
      // ioredis will keep retrying via retryStrategy.
      logger.debug("[Redis] Connection error while waiting for ready", error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
    };

    client.once("ready", onReady);
    client.on("error", onError);
  });
}

export async function connectRedis() {
  try {
    redisInstance = new Redis({
      host: config.redis_host,
      port: config.redis_port,
      db: config.redis_db,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      // Fail commands immediately when disconnected so lock acquisition can
      // distinguish Redis outage from normal lock contention (do not queue forever).
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });

    await waitForReady(redisInstance);
    await redisInstance.ping();
    logger.info("Redis connected successfully");
    return true;
  } catch (error) {
    logger.error("Redis connection failed", error);
    return false;
  }
}

export function getRedis() {
  if (!redisInstance) {
    throw new Error("Redis not connected");
  }
  return redisInstance;
}

// Export the redis instance for direct use
export function redis() {
  return getRedis();
}

export async function closeRedis() {
  if (redisInstance) {
    await redisInstance.quit();
    logger.info("Redis connection closed");
  }
}
