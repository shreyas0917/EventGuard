import { getRedis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { randomUUID } from "crypto";

const LOCK_PREFIX = "eventguard:lock:";
const DEFAULT_LOCK_TTL_SECONDS = 30;

interface LockOptions {
  ttlSeconds?: number;
}

export interface LockHandle {
  key: string;
  value: string;
  acquired: boolean;
}

/**
 * Infrastructure failure talking to Redis (as opposed to normal lock contention).
 * Callers must NOT treat this like "another worker holds the lock".
 */
export class RedisLockError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RedisLockError";
    this.cause = cause;
  }
}

export async function acquireLock(
  eventId: string,
  options: LockOptions = {}
): Promise<LockHandle> {
  const ttl = options.ttlSeconds || DEFAULT_LOCK_TTL_SECONDS;
  const lockKey = `${LOCK_PREFIX}${eventId}`;
  const lockValue = randomUUID();

  try {
    const redisClient = getRedis();

    // Fail fast if the client is not usable (end/wait/reconnecting/etc.)
    if (redisClient.status !== "ready") {
      throw new RedisLockError(
        `Redis not ready for lock acquisition (status=${redisClient.status}) for ${eventId}`
      );
    }

    const result = await redisClient.set(
      lockKey,
      lockValue,
      "EX",
      ttl,
      "NX"
    );

    if (result === "OK") {
      logger.info(`[Redis] Lock acquired for ${eventId}`);
      return {
        key: lockKey,
        value: lockValue,
        acquired: true,
      };
    }

    // SET NX returned null → key already held (normal contention)
    logger.debug(`[Redis] Lock unavailable for ${eventId}`);
    return {
      key: lockKey,
      value: lockValue,
      acquired: false,
    };
  } catch (error) {
    logger.error(
      `[Redis] Infrastructure error acquiring lock for ${eventId} — not treating as contention`,
      error
    );
    throw new RedisLockError(
      `Redis lock acquisition failed for ${eventId}`,
      error
    );
  }
}

export async function releaseLock(handle: LockHandle): Promise<boolean> {
  if (!handle.acquired) {
    return false;
  }

  try {
    const redisClient = getRedis();
    // Only delete if the value still matches (safety check)
    const currentValue = await redisClient.get(handle.key);

    if (currentValue === handle.value) {
      await redisClient.del(handle.key);
      logger.debug(`[Redis] Lock released for ${handle.key}`);
      return true;
    }

    logger.warn(`[Redis] Lock value mismatch, may have expired: ${handle.key}`);
    return false;
  } catch (error) {
    logger.warn(`[Redis] Error releasing lock: ${handle.key}`, error);
    return false;
  }
}

export async function isLockHeld(eventId: string): Promise<boolean> {
  try {
    const redisClient = getRedis();
    const lockKey = `${LOCK_PREFIX}${eventId}`;
    const exists = await redisClient.exists(lockKey);
    return exists > 0;
  } catch (error) {
    logger.warn(`[Redis] Error checking lock for ${eventId}`, error);
    return false;
  }
}
